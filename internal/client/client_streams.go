package client

import (
	"context"
	"fmt"
	"time"

	"github.com/SukrutN/switchyard/internal/wire"
)

// The durable lane API (§2.8–§2.17). Same shape as the pub/sub set, with one
// difference worth spelling out: the four synchronous calls here — create,
// publish, delete, attach — WAIT for the yard's reply frame, because each
// reply names a durable fact (a receipt seq, a resumed position). They take
// turns on one mutex, so a refusal in the ERROR frame stream pairs with the
// round-trip that could have caused it and comes back as the Go error,
// while Errors() keeps a copy for asynchronous listeners.

// LaneDelivery is one durable message handed to a lane consumer. Seq is the
// LANE's number — gapless across the whole lane, stable across redelivery,
// and the only dedupe key a consumer needs. The lane's name does not ride
// the deliver frame; the sid you attached with is the identity, and acks
// name that same pair (sid, seq).
type LaneDelivery struct {
	Sid      uint32
	Seq      uint64
	Subject  string
	Reply    string
	HasReply bool
	Payload  []byte // private copy; keep it or mangle it freely
}

// StreamNotice reports that a lane was deleted out from under this session:
// consumers attached to it hear the goodbye here. Deleting sessions learn
// the same fact from StreamDelete's return value and should not need this
// channel for their own lanes.
type StreamNotice struct {
	Stream string
}

// LaneDeliveries is the durable consumer side of the firehose: replays,
// fresh publishes, and sweeper redeliveries arrive here in lane order per
// consumer. Size the channel for burst × (ack latency + redelivery
// overshoot); overflow increments LaneDropped().
func (c *Client) LaneDeliveries() <-chan LaneDelivery { return c.lanes }

// LaneDropped counts lane deliveries discarded for a full channel. Unlike
// pub/sub, dropped durable work is not lost forever — it goes pending and
// the sweeper redelivers it until it is acked.
func (c *Client) LaneDropped() uint64 { return c.laneDropped.Load() }

// StreamNotices carries lane deletion goodbyes (see StreamNotice).
func (c *Client) StreamNotices() <-chan StreamNotice { return c.notices }

// StreamCreate makes a lane. It returns once the yard answers STREAM_READY —
// or the refusal that explains itself. Creating an existing lane is a
// refusal, not a reset: journal bytes do not roll back for a typo.
func (c *Client) StreamCreate(ctx context.Context, name string) error {
	c.rpcMu.Lock()
	defer c.rpcMu.Unlock()

	ready := make(chan wire.StreamReady, 1)
	c.readySet.Store(&ready)
	defer func() {
		c.readySet.Store(nil)
		select {
		case <-ready:
		default:
		}
	}()
	errSlot := c.installRPCErr()
	defer c.clearRPCErr()

	body, err := wire.EncodeStreamCreate(wire.StreamCreate{Name: name})
	if err != nil {
		return err
	}
	if err := c.write(wire.OpStreamCreate, body); err != nil {
		return fmt.Errorf("send stream create: %w", err)
	}
	select {
	case <-ready:
		return nil
	case e := <-errSlot:
		return e
	case <-ctx.Done():
		return fmt.Errorf("stream create %q: %w", name, ctx.Err())
	case <-c.done:
		return fmt.Errorf("stream create %q: session closed", name)
	}
}

// StreamPublish stores one message in a lane and waits for the receipt: the
// returned seq is the message's lane position, the number every consumer
// will replay it under — until it is acked past. The wait is bounded by ctx,
// not a fire-and-forget: without the receipt the durable claim is unknown.
func (c *Client) StreamPublish(ctx context.Context, stream, subject string, payload []byte) (uint64, error) {
	return c.streamPublish(ctx, wire.StreamPublish{Stream: stream, Subject: subject, Payload: payload})
}

// StreamPublishReply is StreamPublish with a reply subject offered to
// future responders, exactly as PublishReply is for pub/sub.
func (c *Client) StreamPublishReply(ctx context.Context, stream, subject, reply string, payload []byte) (uint64, error) {
	return c.streamPublish(ctx, wire.StreamPublish{Stream: stream, Subject: subject, Reply: reply, HasReply: reply != "", Payload: payload})
}

func (c *Client) streamPublish(ctx context.Context, p wire.StreamPublish) (uint64, error) {
	c.rpcMu.Lock()
	defer c.rpcMu.Unlock()

	receipt := make(chan wire.StreamReceipt, 1)
	c.receiptSet.Store(&receipt)
	defer func() {
		c.receiptSet.Store(nil)
		select {
		case <-receipt:
		default:
		}
	}()
	errSlot := c.installRPCErr()
	defer c.clearRPCErr()

	body, err := wire.EncodeStreamPublish(p)
	if err != nil {
		return 0, err
	}
	if err := c.write(wire.OpStreamPublish, body); err != nil {
		return 0, fmt.Errorf("send stream publish: %w", err)
	}
	select {
	case r := <-receipt:
		return r.Seq, nil
	case e := <-errSlot:
		return 0, e
	case <-ctx.Done():
		return 0, fmt.Errorf("stream publish %q.%q: %w", p.Stream, p.Subject, ctx.Err())
	case <-c.done:
		return 0, fmt.Errorf("stream publish %q.%q: session closed", p.Stream, p.Subject)
	}
}

// StreamDelete removes a lane — journal, consumer states, everything — and
// returns once the yard's STREAM_GONE is in hand. Consumers attached from
// other sessions hear their goodbye on StreamNotices; this session's own
// echo is trapped, so nobody double-counts a lane they removed themselves.
func (c *Client) StreamDelete(ctx context.Context, name string) error {
	c.rpcMu.Lock()
	defer c.rpcMu.Unlock()

	gone := make(chan struct{}, 1)
	c.goneSet.Store(&gone)
	defer c.goneSet.Store(nil)
	errSlot := c.installRPCErr()
	defer c.clearRPCErr()
	// The trap arm goes up before the request leaves: either goodbye frame
	// (confirm, then echo) is already contained when it lands.
	c.deletedLanes.Store(name, struct{}{})
	defer c.deletedLanes.Delete(name)

	body, err := wire.EncodeStreamDelete(wire.StreamDelete{Name: name})
	if err != nil {
		return err
	}
	if err := c.write(wire.OpStreamDelete, body); err != nil {
		return fmt.Errorf("send stream delete: %w", err)
	}
	select {
	case <-gone:
		return nil
	case e := <-errSlot:
		return e
	case <-ctx.Done():
		return fmt.Errorf("stream delete %q: %w", name, ctx.Err())
	case <-c.done:
		return fmt.Errorf("stream delete %q: session closed", name)
	}
}

// StreamAttach opens (or resumes) a durable consumer. It returns once the
// yard's CONSUMER_READY is on the wire, with the first seq the consumer is
// owed (next) and the effective ack wait; everything owed — replayed
// pending, then fresh matches — starts arriving on LaneDeliveries from
// there, lane-ordered. Settle what arrives with LaneAck(sid, seq).
//
// ackWait of zero keeps the yard's default and comes back as that default.
// A re-attached consumer keeps the filter it was born with; re-attach with
// the same one or the yard refuses rather than reading a moving target.
func (c *Client) StreamAttach(ctx context.Context, stream, consumer string, sid uint32, ackWait time.Duration, filter string) (uint64, time.Duration, error) {
	if sid == 0 {
		return 0, 0, fmt.Errorf("sid 0 is reserved")
	}
	c.rpcMu.Lock()
	defer c.rpcMu.Unlock()

	ready := make(chan wire.ConsumerReady, 1)
	c.consSet.Store(&ready)
	defer func() {
		c.consSet.Store(nil)
		select {
		case <-ready:
		default:
		}
	}()
	errSlot := c.installRPCErr()
	defer c.clearRPCErr()

	a := wire.ConsumerAttach{Stream: stream, Consumer: consumer, Sid: sid, AckWaitMillis: uint32(max64(0, int64(ackWait/time.Millisecond)))}
	if filter != "" {
		a.Filter, a.HasFilter = filter, true
	}
	body, err := wire.EncodeConsumerAttach(a)
	if err != nil {
		return 0, 0, err
	}
	if err := c.write(wire.OpConsumerAttach, body); err != nil {
		return 0, 0, fmt.Errorf("send consumer attach: %w", err)
	}
	select {
	case r := <-ready:
		return r.Next, time.Duration(r.AckWaitMillis) * time.Millisecond, nil
	case e := <-errSlot:
		return 0, 0, e
	case <-ctx.Done():
		return 0, 0, fmt.Errorf("attach %q/%q: %w", stream, consumer, ctx.Err())
	case <-c.done:
		return 0, 0, fmt.Errorf("attach %q/%q: session closed", stream, consumer)
	}
}

// LaneAck settles one lane delivery (sid, seq — the same pair the delivery
// carried). Fire-and-forget, like PUB/SUB writes: the write landing is the
// contract, and an ack for a sequence no longer pending is a no-op — the
// ledger already moved past it.
func (c *Client) LaneAck(sid uint32, seq uint64) error {
	body, err := wire.EncodeAck(wire.Ack{Sid: sid, Seq: seq})
	if err != nil {
		return err
	}
	return c.write(wire.OpAck, body)
}

// DetachLane releases an attached consumer: same UNSUB the pub/sub set
// uses, one sid, one thing. The lane and the consumer's position survive —
// nothing durable was waiting on this connection.
func (c *Client) DetachLane(sid uint32) error {
	return c.Unsubscribe(sid)
}

// ---- shared plumbing for the round-trips ----

// installRPCErr adds the refusal route for the in-flight RPC. rpcMu makes
// the CAS a formality, but the formality keeps honesty if that ever changes.
func (c *Client) installRPCErr() <-chan ClientError {
	slot := make(chan ClientError, 1)
	c.rpcErr.CompareAndSwap(nil, &slot)
	return slot
}

// clearRPCErr removes the route and drops whatever landed after timeout —
// the refusal will have been on Errors() regardless.
func (c *Client) clearRPCErr() {
	if p := c.rpcErr.Swap(nil); p != nil {
		select {
		case <-*p:
		default:
		}
	}
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
