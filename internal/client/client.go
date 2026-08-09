// Package client is the reference Switchyard client: the same code the
// spur CLI and the test suite drive. It is deliberately small — dial,
// handshake, subscribe, publish, receive, plus the durable lane set
// (create, publish-with-receipt, attach, acknowledge) — so a third party
// can mirror it in another language from two files, and so the protocol
// never grows a feature only this client can exercise.
//
// Asynchrony contract: SUBSCRIBE, PUBLISH, and LANE ACK carry no ack inside
// the wire; refusals arrive as ERROR frames on the Errors() channel. The
// synchronous pairs — PING→PONG, and the stream family's READY/RECEIPT/GONE
// replies — are round-trips whose failures surface as Go errors.
package client

import (
	"context"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/SukrutN/switchyard/internal/wire"
)

// Delivery is one message handed to the consumer. Payload is a private copy;
// consumers may keep it forever.
type Delivery struct {
	Subject  string
	Sid      uint32
	Seq      uint32 // gapless per subscription, starting at 1
	Reply    string
	HasReply bool
	Payload  []byte
}

// ClientError carries a server ERROR frame to the application. fatal reports
// whether the yard ended the session with it.
type ClientError struct {
	Code    byte
	Message string
	Fatal   bool
}

func (e ClientError) Error() string {
	return fmt.Sprintf("server %s (code 0x%02X): %s", wire.NameFor(e.Code), e.Code, e.Message)
}

// Options tune dialing and buffering. Zero values are workable.
type Options struct {
	Name       string        // display name for the yard's logs (≤64 bytes)
	Label      string        // client family tag, e.g. "cli" (≤16 bytes)
	Timeout    time.Duration // dial + handshake budget (default 5s)
	DeliverBuf int           // delivery channel depth (default 256)
	LaneBuf    int           // lane delivery channel depth (default 256)
	Keepalive  time.Duration // silent-max minus; a probe PING follows (default 65s)
}

func (o *Options) withDefaults() {
	if o.Timeout <= 0 {
		o.Timeout = 5 * time.Second
	}
	if o.DeliverBuf <= 0 {
		o.DeliverBuf = 256
	}
	if o.LaneBuf <= 0 {
		o.LaneBuf = 256
	}
	if o.Keepalive <= 0 {
		o.Keepalive = 65 * time.Second
	}
}

// Client is a live session. Methods are goroutine-safe except where noted;
// the wire itself is single-connection, single-reader, single-writer.
type Client struct {
	conn net.Conn
	wr   *wire.Writer
	wmu  sync.Mutex // serializes writes: HELLO/PUBLISH/SUB/UNSUB/PING/PONG/BYE

	welcome wire.Welcome

	dead       atomic.Bool // set on BYE/fatal: reader stops after this frame
	deliveries chan Delivery
	errs       chan ClientError
	keepalive  time.Duration
	dropped    atomic.Uint64

	lanes        chan LaneDelivery
	laneDropped  atomic.Uint64
	notices      chan StreamNotice
	deletedLanes sync.Map // names of lanes this session is deleting; echo trap

	// Synchronous stream RPCs take turns (rpcMu): one round-trip in flight
	// at a time, so a refusal in the ERROR stream pairs with the RPC that
	// could have produced it, and a receipt with the publish that owns it.
	// Each RPC installs its reply slot before writing the request; late
	// replies after a timeout die with the slot, quietly.
	rpcMu      sync.Mutex
	rpcErr     atomic.Pointer[chan ClientError]
	readySet   atomic.Pointer[chan wire.StreamReady]
	receiptSet atomic.Pointer[chan wire.StreamReceipt]
	consSet    atomic.Pointer[chan wire.ConsumerReady]
	goneSet    atomic.Pointer[chan struct{}]

	// pingWait: the RPC slot for an in-flight PING. Close releases it.
	pingMu   sync.Mutex
	pingWait chan struct{}
	pwSet    atomic.Pointer[chan struct{}]

	doneOnce sync.Once
	done     chan struct{}
	closeErr error
}

// Dial connects, handshakes, and leaves the session live. The ctx deadline
// converts into a dial deadline; the handshake adds Options.Timeout.
func Dial(ctx context.Context, addr string, o Options) (*Client, error) {
	o.withDefaults()
	dialer := net.Dialer{Timeout: o.Timeout}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", addr, err)
	}
	c := &Client{
		conn:       conn,
		wr:         wire.NewWriter(conn),
		deliveries: make(chan Delivery, o.DeliverBuf),
		errs:       make(chan ClientError, 16),
		lanes:      make(chan LaneDelivery, o.LaneBuf),
		notices:    make(chan StreamNotice, 32),
		keepalive:  o.Keepalive,
		done:       make(chan struct{}),
	}
	_ = conn.SetDeadline(time.Now().Add(o.Timeout))
	if err := c.hello(o); err != nil {
		conn.Close()
		return nil, err
	}
	// Handshake done: no more deadline discipline on writes (Ping/Close own
	// their own), reads carry their own keepalive deadline.
	_ = conn.SetDeadline(time.Time{})
	go c.readLoop()
	return c, nil
}

func (c *Client) hello(o Options) error {
	body, err := wire.EncodeHello(wire.Hello{Name: o.Name, Label: o.Label})
	if err != nil {
		return fmt.Errorf("hello: %w", err)
	}
	if err := c.wr.WriteFrame(wire.OpHello, body); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}
	rd := wire.NewReader(c.conn, wire.MaxBodyBytes)
	op, body2, rerr := rd.ReadFrame()
	if rerr != nil {
		return fmt.Errorf("await welcome: %w", rerr)
	}
	if op != wire.OpWelcome {
		return fmt.Errorf("peer answered %s, WELCOME expected", op)
	}
	w, derr := wire.DecodeWelcome(body2)
	if derr != nil {
		return fmt.Errorf("welcome unreadable: %w", derr)
	}
	c.welcome = w
	// Reader for the rest of the session must respect the yard's body cap,
	// not the handshake's accidental value.
	return nil
}

// Welcome reports the yard's identity and advertised limits.
func (c *Client) Welcome() wire.Welcome { return c.welcome }

// Deliveries is the consumer side of the firehose. Sizing rule of thumb:
// depth ≥ burst rate × read latency; overflow drops increment Dropped().
func (c *Client) Deliveries() <-chan Delivery { return c.deliveries }

// Errors carries refusals and fatal teardown notices, in wire order.
func (c *Client) Errors() <-chan ClientError { return c.errs }

// Dropped counts deliveries discarded for a full buffer — the honest metric
// for consumers that size the channel below their burst.
func (c *Client) Dropped() uint64 { return c.dropped.Load() }

// Subscribe opens a subscription; sid is yours to assign (non-zero, unique
// per session, one sid one subscription). Refusal arrives async on Errors().
func (c *Client) Subscribe(sid uint32, pattern string) error {
	body, err := wire.EncodeSubscribe(wire.Subscribe{Pattern: pattern, Sid: sid})
	if err != nil {
		return err
	}
	return c.write(wire.OpSubscribe, body)
}

// Unsubscribe closes a sid.
func (c *Client) Unsubscribe(sid uint32) error {
	body, err := wire.EncodeUnsub(wire.Unsub{Sid: sid})
	if err != nil {
		return err
	}
	return c.write(wire.OpUnsub, body)
}

// Publish fires one message. No ack exists in v1 — the write to the socket
// is the contract; refusals land on Errors().
func (c *Client) Publish(subject string, payload []byte) error {
	return c.PublishReply(subject, "", payload)
}

// PublishReply fires a message with a reply subject for responders to use.
func (c *Client) PublishReply(subject, reply string, payload []byte) error {
	body, err := wire.EncodePublish(wire.Publish{Subject: subject, Reply: reply, HasReply: reply != "", Payload: payload})
	if err != nil {
		return err
	}
	return c.write(wire.OpPublish, body)
}

// Ping round-trips the yard. The elapsed time spans one PING→PONG pair.
func (c *Client) Ping(ctx context.Context) error {
	c.pingMu.Lock()
	defer c.pingMu.Unlock()
	if c.pwSet.Load() != nil {
		return fmt.Errorf("ping already in flight")
	}
	wait := make(chan struct{})
	c.pwSet.Store(&wait)
	defer func() {
		c.pwSet.Store(nil)
		select {
		case <-wait:
		default:
		}
	}()
	if err := c.write(wire.OpPing, nil); err != nil {
		return fmt.Errorf("send ping: %w", err)
	}
	select {
	case <-wait:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("ping: %w", ctx.Err())
	case <-c.done:
		return fmt.Errorf("ping: session closed")
	}
}

// write is the shared single-writer path for outbound ops.
func (c *Client) write(op wire.Op, body []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return c.wr.WriteFrame(op, body)
}

// readLoop owns inbound: deliveries, pongs, server pings (we PONG back),
// errors, BYE. Deadline discipline: the yard pings every Idle; two Idle
// windows of total silence mean the yard is gone.
func (c *Client) readLoop() {
	defer c.doneOnce.Do(func() { close(c.done) })
	rd := wire.NewReader(c.conn, c.welcome.MaxBody)
	for {
		// Keepalive deadline: the yard pings at its Idle (default 30s); the
		// default survives one full silent cycle plus jitter. Tests shorten
		// both sides together.
		_ = c.conn.SetReadDeadline(time.Now().Add(c.keepalive))
		op, body, err := rd.ReadFrame()
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				// Probe once; if the yard answers, keep living.
				if perr := c.reprobe(); perr != nil {
					c.closeErr = fmt.Errorf("keepalive: %w", perr)
					return
				}
				continue
			}
			if oe, ok := err.(*wire.ProtocolError); ok {
				c.pushErr(ClientError{Code: oe.Code, Message: oe.Msg, Fatal: true})
			}
			c.closeErr = err
			return
		}
		if err := c.handle(op, body); err != nil {
			c.closeErr = err
			return
		}
		if c.dead.Load() {
			return
		}
	}
}

// handle routes one clean frame. BYE is the only graceful exit.
func (c *Client) handle(op wire.Op, body []byte) error {
	switch op {
	case wire.OpDeliver:
		d, err := wire.DecodeDeliver(body)
		if err != nil {
			return fmt.Errorf("deliver unreadable: %w", err)
		}
		del := Delivery{
			Subject:  d.Subject,
			Sid:      d.Sid,
			Seq:      d.Seq,
			Reply:    d.Reply,
			HasReply: d.HasReply,
			Payload:  append([]byte(nil), d.Payload...), // consumer owns it
		}
		select {
		case c.deliveries <- del:
		default:
			c.dropped.Add(1)
		}
		return nil
	case wire.OpPong:
		c.releasePing()
		return nil
	case wire.OpStreamReady:
		r, err := wire.DecodeStreamReady(body)
		if err != nil {
			return fmt.Errorf("stream ready unreadable: %w", err)
		}
		if p := c.readySet.Load(); p != nil {
			select {
			case *p <- r:
			default:
			}
		}
		return nil
	case wire.OpStreamReceipt:
		r, err := wire.DecodeStreamReceipt(body)
		if err != nil {
			return fmt.Errorf("stream receipt unreadable: %w", err)
		}
		if p := c.receiptSet.Load(); p != nil {
			select {
			case *p <- r:
			default:
			}
		}
		return nil
	case wire.OpConsumerReady:
		r, err := wire.DecodeConsumerReady(body)
		if err != nil {
			return fmt.Errorf("consumer ready unreadable: %w", err)
		}
		if p := c.consSet.Load(); p != nil {
			select {
			case *p <- r:
			default:
			}
		}
		return nil
	case wire.OpStreamGone:
		g, err := wire.DecodeStreamGone(body)
		if err != nil {
			return fmt.Errorf("stream gone unreadable: %w", err)
		}
		if p := c.goneSet.Load(); p != nil {
			select {
			case *p <- struct{}{}:
			default:
			}
		}
		// A deleting session's own goodbye carries no notice: the deletion
		// trap (armed before the request left) covers its single confirm.
		// Other sessions, holding consumers, hear it here.
		if _, own := c.deletedLanes.Load(g.Name); !own {
			select {
			case c.notices <- StreamNotice{Stream: g.Name}:
			default:
			}
		}
		return nil
	case wire.OpStreamDeliver:
		d, err := wire.DecodeStreamDeliver(body)
		if err != nil {
			return fmt.Errorf("stream deliver unreadable: %w", err)
		}
		dl := LaneDelivery{
			Sid:      d.Sid,
			Seq:      d.Seq,
			Subject:  d.Subject,
			Reply:    d.Reply,
			HasReply: d.HasReply,
			Payload:  append([]byte(nil), d.Payload...), // consumer owns it
		}
		select {
		case c.lanes <- dl:
		default:
			c.laneDropped.Add(1)
		}
		return nil
	case wire.OpPing:
		// The yard is probing us: answer from the shared write path.
		return c.write(wire.OpPong, nil)
	case wire.OpError:
		if e, err := wire.DecodeError(body); err == nil {
			ce := ClientError{Code: e.Code, Message: e.Message, Fatal: e.Fatal}
			c.pushErr(ce)
			// An in-flight synchronous RPC takes the refusal as its return
			// value; Errors() keeps a copy for asynchronous listeners.
			if p := c.rpcErr.Load(); p != nil {
				select {
				case *p <- ce:
				default:
				}
			}
			if e.Fatal {
				c.dead.Store(true)
			}
		}
		return nil
	case wire.OpBye:
		c.dead.Store(true)
		return nil
	default:
		return fmt.Errorf("unexpected op %s from yard", op)
	}
}

// reprobe fires one PING and waits its match with a 10s budget.
func (c *Client) reprobe() error {
	c.pingMu.Lock()
	defer c.pingMu.Unlock()
	if c.pwSet.Load() != nil {
		return fmt.Errorf("previous ping unresolved")
	}
	wait := make(chan struct{})
	c.pwSet.Store(&wait)
	if err := c.write(wire.OpPing, nil); err != nil {
		c.pwSet.Store(nil)
		return fmt.Errorf("probe write: %w", err)
	}
	select {
	case <-wait:
		return nil
	case <-time.After(10 * time.Second):
		return fmt.Errorf("no PONG within 10s")
	}
}

func (c *Client) releasePing() {
	if slot := c.pwSet.Load(); slot != nil {
		select {
		case <-*slot:
		default:
			close(*slot)
		}
	}
}

func (c *Client) pushErr(e ClientError) {
	select {
	case c.errs <- e:
	default:
		// Errors overflow is dropped-but-counted? No — errors are few and
		// fatal ones are rare; a full 16-slot ring means the app vanished.
	}
}

// Close ends the session: BYE (best effort), then a hard close. Repeated
// calls are safe; the first-reported network error wins.
func (c *Client) Close() error {
	var werr error
	c.wmu.Lock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	werr = c.wr.WriteFrame(wire.OpBye, nil)
	c.wmu.Unlock()

	// Give the yard a beat to answer BYE, then hang up regardless.
	select {
	case <-c.done:
	case <-time.After(1 * time.Second):
	}
	err := c.conn.Close()
	if werr != nil && err == nil {
		err = werr
	}
	return err
}

// Done closes when the session is over, whatever ended it.
func (c *Client) Done() <-chan struct{} { return c.done }
