package server

import (
	"fmt"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/SukrutN/switchyard/internal/subjects"
	"github.com/SukrutN/switchyard/internal/wire"
)

// A session is one client conversation: one reader goroutine (parse + hub
// calls), one writer goroutine (the only goroutine that writes the socket),
// and one bounded queue between them.
//
// The queue IS the ordering mechanism, not an optimization: publish enqueues
// while holding the hub's read lock, so the order the writer observes is the
// order the yard accepted the message. Delivery seq is stamped per
// subscription by the writer alone, which makes sequences gapless and
// consistent with enqueue order, by construction.
//
// Backpressure contract: writer stalls → queue fills → the session dies with
// SLOW_CONSUMER rather than the yard absorbing memory without limit. A
// client that cannot keep up is a client bug; an unbounded queue is a
// server bug.

// deliverTask is one message for one subscription. Payload is shared,
// immutable after publish — copying happens exactly once per message, in the
// publish handler, whatever the fan-out.
type deliverTask struct {
	sid      uint32
	subject  string
	payload  []byte
	reply    string
	hasReply bool
	kind     uint8  // taskSpur (§2.6 delivery) or taskLane (§2.14 delivery)
	laneSeq  uint64 // the lane's sequence when kind == taskLane
}

// Delivery task kinds; the writer goroutine picks its frame op from these.
const (
	taskSpur uint8 = iota // ordinary pub/sub delivery, per-sid gapless seq
	taskLane              // durable lane delivery, lane's seq passes through
)

// ctlFrame is inline traffic the reader side wants the writer to emit, so
// every byte crossing the socket passes through the single writer goroutine.
// A fatal frame is the writer's cue for "send this, then close".
type ctlFrame struct {
	op    wire.Op
	body  []byte
	fatal bool
}

type session struct {
	id   uint64
	cfg  *Config
	hub  *Hub
	log  *slog.Logger
	conn net.Conn
	rd   *wire.Reader
	wr   *wire.Writer

	out chan deliverTask
	ctl chan ctlFrame
	// quit is closed when the read loop exits for any reason; the writer
	// watches it so no dead connection leaks a goroutine.
	quit   chan struct{}
	doomed atomic.Bool

	// Subscriptions, guarded by mu: hub teardown runs on server/reader
	// goroutines while dispatch mutates from the same reader goroutine as
	// the SUBSCRIBE op it just decoded.
	mu   sync.Mutex
	subs map[uint32]string // sid → pattern; one sid, exactly one subscription

	// lanes holds durable-consumer references: sid → where its acks go.
	// Same mu as subs; together they are the "one sid, one thing" registry.
	lanes map[uint32]laneRef

	// seq is writer-goroutine-private: sid → last stamped sequence.
	seq map[uint32]uint32

	handshaked bool
	peerName   string // HELLO name, display-only in lifecycle logs
	peerLabel  string // HELLO label, same contract
}

func newSession(id uint64, cfg *Config, hub *Hub, log *slog.Logger, conn net.Conn) *session {
	return &session{
		id:    id,
		cfg:   cfg,
		hub:   hub,
		log:   log,
		conn:  conn,
		rd:    wire.NewReader(conn, cfg.MaxBody),
		wr:    wire.NewWriter(conn),
		out:   make(chan deliverTask, cfg.OutBuf),
		ctl:   make(chan ctlFrame, cfg.CtlBuf),
		quit:  make(chan struct{}),
		subs:  map[uint32]string{},
		lanes: map[uint32]laneRef{},
	}
}

// serve runs the connection to completion and returns why it ended:
// nil means the client BYE'd gracefully; anything else means the yard or
// the wire tore the session down. Every exit path ends with the socket
// closed — either by the writer (fatal frame flushed first) or by the
// caller's conn.Close.
func (s *session) serve() error {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.writeLoop()
	}()

	err := s.readLoop()

	// Reader is done: wake the writer, then wait for it to flush whatever
	// fatal frame is queued before the socket goes away.
	close(s.quit)
	wg.Wait()
	return err
}

// ---- reader side ----

func (s *session) readLoop() error {
	pinged := false      // a PING is outstanding, PONG expected
	var pingAt time.Time // when that PING was sent; grace counts from it
	for {
		deadline := time.Now().Add(s.cfg.Idle)
		if pinged {
			deadline = pingAt.Add(s.cfg.Grace)
		}
		_ = s.conn.SetReadDeadline(deadline) // errors here hang up on their own at ReadFrame

		op, body, err := s.rd.ReadFrame()
		if isTimeout(err) {
			if !pinged {
				// First silence: probe once, grant one grace period.
				pinged = true
				pingAt = time.Now()
				s.pushCtl(wire.OpPing, nil, false)
				continue
			}
			idle := s.cfg.Idle + s.cfg.Grace
			return s.kill(fmt.Sprintf("idle: no frames for %s", idle), wire.CodeIdleTimeout)
		}
		if err == wire.ErrSkipped {
			// Body over this yard's limit but within the protocol ceiling:
			// framing is intact; refuse and keep the session.
			s.pushErr(fmt.Sprintf("frame body too large: this yard accepts up to %d bytes", s.cfg.MaxBody), wire.CodeTooLarge)
			continue
		}
		if err != nil {
			if oe, ok := err.(*wire.ProtocolError); ok {
				// Framing broke: say so, then close — a malformed frame means
				// byte offsets are untrustworthy, so this is always fatal.
				return s.kill(oe.Msg, oe.Code)
			}
			// Bare net error: the peer dropped us; nothing left to send.
			return err
		}

		// Any frame proves liveness, not just PONG — a client that talks is
		// a client that is alive.
		pinged = false

		if err := s.dispatch(op, body); err != nil {
			return err
		}
		if s.doomed.Load() {
			// deliver() may have killed us mid-dispatch (slow consumer);
			// the fatal frame is queued — leave now, writer flushes it.
			return fmt.Errorf("session closing")
		}
	}
}

func isTimeout(err error) bool {
	if ne, ok := err.(net.Error); ok {
		return ne.Timeout()
	}
	return false
}

func (s *session) dispatch(op wire.Op, body []byte) error {
	// Reserved server ops from a client mean the peer speaks a different
	// dialect; better to stop than to guess.
	switch op {
	case wire.OpWelcome, wire.OpDeliver, wire.OpStreamReady, wire.OpStreamReceipt,
		wire.OpConsumerReady, wire.OpStreamDeliver, wire.OpStreamGone:
		return s.kill("received reserved server op "+op.String(), wire.CodeMalformed)
	}

	switch op {
	case wire.OpHello:
		if s.handshaked {
			return s.pushErr("hello sent twice; session already live", wire.CodeNotHandshaked)
		}
		h, err := wire.DecodeHello(body)
		if err != nil {
			return s.kill("hello unreadable: "+err.Error(), wire.CodeMalformed)
		}
		s.handshaked = true
		s.peerName, s.peerLabel = h.Name, h.Label
		w, encErr := wire.EncodeWelcome(wire.Welcome{ServerLabel: ServerLabel(), MaxBody: s.cfg.MaxBody})
		if encErr != nil {
			return fmt.Errorf("encode welcome: %w", encErr)
		}
		s.pushCtl(wire.OpWelcome, w, false)
		s.log.Info("client in", "session", s.id, "name", h.Name, "label", h.Label)
		return nil

	case wire.OpPing:
		// Probes work pre-handshake too: checking liveness before HELLO is
		// exactly what the client lib does while connecting.
		s.pushCtl(wire.OpPong, nil, false)
		return nil

	case wire.OpPong:
		return nil // the deadline machinery already reset on liveness

	case wire.OpBye:
		return s.bye()

	case wire.OpPublish:
		if !s.handshaked {
			return s.pushErr("publish before hello", wire.CodeNotHandshaked)
		}
		p, err := wire.DecodePublish(body)
		if err != nil {
			if oe, ok := err.(*wire.ProtocolError); ok && oe.Code == wire.CodeBadSubject {
				return s.pushErr("publish refused: "+oe.Msg, wire.CodeBadSubject)
			}
			return s.kill("publish body unreadable: "+err.Error(), wire.CodeMalformed)
		}
		pub, err := subjects.Parse(p.Subject)
		if err != nil {
			return s.pushErr("publish refused: "+err.Error(), wire.CodeBadSubject)
		}
		if !pub.IsConcrete() {
			return s.pushErr("publish refused: wildcards are for subscriptions, not subjects", wire.CodeBadSubject)
		}
		payload := append([]byte(nil), p.Payload...) // one copy per message, shared downstream
		s.hub.publish(pub, payload, p.Reply, p.HasReply)
		return nil

	case wire.OpSubscribe:
		if !s.handshaked {
			return s.pushErr("subscribe before hello", wire.CodeNotHandshaked)
		}
		su, err := wire.DecodeSubscribe(body)
		if err != nil {
			return s.kill("subscribe body unreadable: "+err.Error(), wire.CodeMalformed)
		}
		code, uerr := s.hub.subscribe(s, su.Sid, su.Pattern)
		if uerr != nil {
			return s.pushErr("subscribe refused: "+uerr.Error(), code)
		}
		return nil

	case wire.OpUnsub:
		if !s.handshaked {
			return s.pushErr("unsubscribe before hello", wire.CodeNotHandshaked)
		}
		u, err := wire.DecodeUnsub(body)
		if err != nil {
			return s.kill("unsubscribe body unreadable: "+err.Error(), wire.CodeMalformed)
		}
		// Which sid space is this? A lane consumer detaches from its lane;
		// anything else went through the hub's trie.
		if ref, ok := s.laneRefFor(u.Sid); ok {
			st := s.hub.lanes.resolve(ref.lane)
			if st == nil {
				s.forgetLane(u.Sid)
				return s.pushErr("lane consumer's lane is gone; sid free", wire.CodeNoConsumer)
			}
			if !st.detachConsumer(ref.consumer, s) {
				return s.pushErr("consumer could not detach from its lane (this is a server bug)", wire.CodeNoConsumer)
			}
			s.forgetLane(u.Sid)
			return nil
		}
		code, uerr := s.hub.unsubscribe(s, u.Sid)
		if uerr != nil {
			return s.pushErr("unsubscribe refused: "+uerr.Error(), code)
		}
		return nil

	case wire.OpStreamCreate:
		if !s.handshaked {
			return s.pushErr("stream create before hello", wire.CodeNotHandshaked)
		}
		c, err := wire.DecodeStreamCreate(body)
		if err != nil {
			code, msg := streamRefusal(err, "stream create body unreadable: ")
			if code == wire.CodeMalformed {
				return s.kill(msg, code)
			}
			return s.pushErr(msg, code)
		}
		next, code, cerr := s.hub.lanes.create(c.Name)
		if cerr != nil {
			return s.pushErr("stream create refused: "+cerr.Error(), code)
		}
		if body, err := wire.EncodeStreamReady(wire.StreamReady{Name: c.Name, Seq: next}); err == nil {
			s.pushCtl(wire.OpStreamReady, body, false)
		} else {
			return fmt.Errorf("encode stream ready: %w", err)
		}
		s.log.Info("stream created", "session", s.id, "lane", c.Name, "nextSeq", next)
		return nil

	case wire.OpStreamPublish:
		if !s.handshaked {
			return s.pushErr("stream publish before hello", wire.CodeNotHandshaked)
		}
		p, err := wire.DecodeStreamPublish(body)
		if err != nil {
			code, msg := streamRefusal(err, "stream publish body unreadable: ")
			if code == wire.CodeMalformed {
				return s.kill(msg, code)
			}
			return s.pushErr(msg, code)
		}
		pub, err := subjects.Parse(p.Subject)
		if err != nil {
			return s.pushErr("stream publish refused: "+err.Error(), wire.CodeBadSubject)
		}
		if !pub.IsConcrete() {
			return s.pushErr("stream publish refused: wildcards are for subscriptions, not subjects", wire.CodeBadSubject)
		}
		if pub.Tokens[0] != p.Stream {
			return s.pushErr("stream publish refused: subject's first token "+pub.Tokens[0]+" is not the lane "+p.Stream, wire.CodeStreamSubject)
		}
		st := s.hub.lanes.resolve(p.Stream)
		if st == nil {
			return s.pushErr("stream publish refused: no lane named "+p.Stream, wire.CodeStreamUnknown)
		}
		payload := append([]byte(nil), p.Payload...) // one copy per message, shareholders may not mutate
		seq, code, perr := st.publishAndFanOut(pub, payload, p.Reply, p.HasReply)
		if perr != nil {
			return s.pushErr("stream publish refused: "+perr.Error(), code)
		}
		// THEN the spur fan-out, deliberately after the lane's own critical
		// section: hub work never takes st.mu, so there is no way back into
		// this lane's order from there.
		s.hub.publish(pub, payload, p.Reply, p.HasReply)
		rbody, rerr := wire.EncodeStreamReceipt(wire.StreamReceipt{Stream: p.Stream, Seq: seq})
		if rerr != nil {
			return fmt.Errorf("encode stream receipt: %w", rerr)
		}
		s.pushCtl(wire.OpStreamReceipt, rbody, false)
		return nil

	case wire.OpConsumerAttach:
		if !s.handshaked {
			return s.pushErr("consumer attach before hello", wire.CodeNotHandshaked)
		}
		a, err := wire.DecodeConsumerAttach(body)
		if err != nil {
			code, msg := streamRefusal(err, "consumer attach body unreadable: ")
			if code == wire.CodeMalformed {
				return s.kill(msg, code)
			}
			return s.pushErr(msg, code)
		}
		st := s.hub.lanes.resolve(a.Stream)
		if st == nil {
			return s.pushErr("consumer attach refused: no lane named "+a.Stream, wire.CodeStreamUnknown)
		}
		var filter *subjects.Subject
		if a.HasFilter {
			f, ferr := subjects.Parse(a.Filter)
			if ferr != nil {
				return s.pushErr("consumer attach refused: filter rejected: "+ferr.Error(), wire.CodeBadSubject)
			}
			filter = &f
		}
		ackWait := s.laneAckWait(a.AckWaitMillis)
		next, code, cerr := st.attach(s, a.Sid, a.Consumer, filter, ackWait)
		if cerr != nil {
			return s.pushErr("consumer attach refused: "+cerr.Error(), code)
		}
		s.rememberLane(a.Sid, laneRef{lane: a.Stream, consumer: a.Consumer})
		if body, err := wire.EncodeConsumerReady(wire.ConsumerReady{
			Stream: a.Stream, Consumer: a.Consumer, Sid: a.Sid, Next: next,
			AckWaitMillis: uint32(ackWait / time.Millisecond),
		}); err == nil {
			s.pushCtl(wire.OpConsumerReady, body, false)
		} else {
			return fmt.Errorf("encode consumer ready: %w", err)
		}
		s.log.Info("consumer attached", "session", s.id, "lane", a.Stream, "consumer", a.Consumer, "next", next)
		return nil

	case wire.OpAck:
		if !s.handshaked {
			return s.pushErr("ack before hello", wire.CodeNotHandshaked)
		}
		a, err := wire.DecodeAck(body)
		if err != nil {
			return s.kill("ack body unreadable: "+err.Error(), wire.CodeMalformed)
		}
		ref, ok := s.laneRefFor(a.Sid)
		if !ok {
			return s.pushErr("ack refused: no consumer for that sid", wire.CodeNoConsumer)
		}
		st := s.hub.lanes.resolve(ref.lane)
		if st == nil {
			// The lane died under an attached consumer; STREAM_GONE was the
			// goodbye and the sid is already free — the ack has no owner.
			s.forgetLane(a.Sid)
			return s.pushErr("ack refused: that lane is gone; sid free", wire.CodeNoConsumer)
		}
		code, cerr := st.ack(ref.consumer, s, a.Seq)
		if cerr != nil {
			return s.pushErr("ack refused: "+cerr.Error(), code)
		}
		return nil

	case wire.OpStreamDelete:
		if !s.handshaked {
			return s.pushErr("stream delete before hello", wire.CodeNotHandshaked)
		}
		dlt, err := wire.DecodeStreamDelete(body)
		if err != nil {
			code, msg := streamRefusal(err, "stream delete body unreadable: ")
			if code == wire.CodeMalformed {
				return s.kill(msg, code)
			}
			return s.pushErr(msg, code)
		}
		removed, derr := s.hub.lanes.deleteLane(dlt.Name)
		if derr != nil {
			return s.pushErr("stream delete refused: "+derr.Error(), wire.CodeServerFault)
		}
		if !removed {
			return s.pushErr("stream delete refused: no lane named "+dlt.Name, wire.CodeStreamUnknown)
		}
		notifyLaneGone(s.hub, dlt.Name)
		if body, err := wire.EncodeStreamGone(wire.StreamGone{Name: dlt.Name}); err == nil {
			s.pushCtl(wire.OpStreamGone, body, false)
		}
		s.log.Info("stream deleted", "session", s.id, "lane", dlt.Name)
		return nil

	default:
		return s.kill("unknown op "+op.String(), wire.CodeUnknownOp)
	}
}

// streamRefusal maps a stream-codec failure to its wire answer. Codec-level
// shape failures stay fatal (MALFORMED governance); charter-length and
// payload-room failures are refusals that keep the session.
func streamRefusal(err error, prefix string) (byte, string) {
	oe, ok := err.(*wire.ProtocolError)
	if !ok {
		return wire.CodeMalformed, prefix + err.Error()
	}
	switch oe.Code {
	case wire.CodeMalformed:
		return wire.CodeMalformed, "lane body unreadable: " + oe.Msg
	case wire.CodeBadSubject:
		return wire.CodeBadSubject, "lane body refused: " + oe.Msg
	case wire.CodeTooLarge:
		return wire.CodeTooLarge, "lane body refused: " + oe.Msg
	default:
		return wire.CodeBadStreamName, "lane name refused: " + oe.Msg
	}
}

// laneAckWait resolves the consumer's redelivery clock: what the client
// asked for in milliseconds, or the yard default (§7) when it asked for 0.
func (s *session) laneAckWait(millis uint32) time.Duration {
	if millis == 0 {
		return s.cfg.AckWait
	}
	return time.Duration(millis) * time.Millisecond
}

// bye handles the client's BYE: queue our own BYE as the terminal frame, so
// the client sees a symmetric close rather than a bare FIN.
func (s *session) bye() error {
	if s.doomed.Load() {
		return nil
	}
	s.doomed.Store(true)
	s.pushCtl(wire.OpBye, nil, true)
	return fmt.Errorf("bye from %s", s.peerName)
}

// kill marks the session for teardown: a fatal ERROR frame (unless code is
// 0) goes through the writer, which closes the socket after it lands.
func (s *session) kill(reason string, code byte) error {
	if s.doomed.Load() {
		return fmt.Errorf("already closing: %s", reason)
	}
	s.doomed.Store(true)
	if code == 0 {
		if reason != "" {
			return fmt.Errorf("%s", reason)
		}
		return nil
	}
	if body, err := wire.EncodeError(wire.ErrorResponse{Code: code, Message: reason, Fatal: true}); err == nil {
		s.pushCtl(wire.OpError, body, true)
	}
	return fmt.Errorf("%s (protocol %s)", reason, wire.NameFor(code))
}

// pushErr replies a non-fatal refusal and keeps the session.
func (s *session) pushErr(message string, code byte) error {
	if s.doomed.Load() {
		return nil // closing anyway; the frame would never flush
	}
	body, err := wire.EncodeError(wire.ErrorResponse{Code: code, Message: message})
	if err != nil {
		return fmt.Errorf("encode error frame: %w", err)
	}
	s.pushCtl(wire.OpError, body, false)
	return nil
}

// pushCtl queues a control frame for the writer. Non-blocking ALWAYS: the
// reader must never stall behind a stalled writer.
func (s *session) pushCtl(op wire.Op, body []byte, fatal bool) {
	if s.doomed.Load() && !fatal {
		return
	}
	select {
	case s.ctl <- ctlFrame{op: op, body: body, fatal: fatal}:
	default:
		// Overflow here means fatal-vs-fatal racing itself; the session is
		// going down either way.
	}
}

// ---- session bookkeeping (hub-facing) ----

func (s *session) remember(sid uint32, pattern string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.subs[sid] = pattern
}

func (s *session) forget(sid uint32) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.subs, sid)
}

// rememberLane registers a durable consumer under an sid. Same law as subs:
// one sid, one thing — the caller must have checked sidTaken first.
func (s *session) rememberLane(sid uint32, ref laneRef) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lanes[sid] = ref
}

func (s *session) forgetLane(sid uint32) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.lanes, sid)
}

// laneRefFor reports the lane consumer living at sid, or ok=false.
func (s *session) laneRefFor(sid uint32) (laneRef, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ref, ok := s.lanes[sid]
	return ref, ok
}

// sidOwner returns the spur pattern living at sid, or "" when none does.
// The lane version lives in laneRefFor; callers resolve which sid space they
// mean before asking.
func (s *session) sidOwner(sid uint32) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.subs[sid]
}

// allSids snapshots live spur sids for hub teardown.
func (s *session) allSids() []uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]uint32, 0, len(s.subs))
	for sid := range s.subs {
		out = append(out, sid)
	}
	return out
}

// sidTaken is the whole sid space's one-check: a spur subscription or a
// lane consumer, never both. Called under the hub lock for SUBSCRIBE and
// under the lane lock for ATTACH, so no two writers race past it.
func (s *session) sidTaken(sid uint32) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, is := s.subs[sid]; is {
		return true
	}
	_, is := s.lanes[sid]
	return is
}

// detachAllLanes runs at session teardown: every lane consumer this session
// held goes back to "not attached", position durable. Must be called before
// hub.unregister so a last-second ack still resolves.
func (s *session) detachAllLanes() {
	s.mu.Lock()
	refs := make([]laneRef, 0, len(s.lanes))
	for sid, ref := range s.lanes {
		refs = append(refs, ref)
		delete(s.lanes, sid)
	}
	s.mu.Unlock()
	for _, ref := range refs {
		if st := s.hub.lanes.resolve(ref.lane); st != nil {
			st.detachConsumer(ref.consumer, s)
		}
	}
}

// toView flattens live subscriptions for the operator dump.
func (s *session) toView() []SubView {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]SubView, 0, len(s.subs))
	for sid, pattern := range s.subs {
		out = append(out, SubView{Session: s.id, Sid: sid, Pattern: pattern})
	}
	return out
}

// dead is the hub's fast path: doomed sessions skip enqueue entirely.
func (s *session) dead() bool { return s.doomed.Load() }

// ---- writer side (sole socket writer) ----

func (s *session) writeLoop() {
	for {
		select {
		case <-s.quit:
			// Reader left. Flush exactly the terminal frame it queued, if
			// any (kill receives fatal frames here to dodge the select
			// race where quit and ctl are ready at once).
			for {
				select {
				case cf := <-s.ctl:
					if !cf.fatal {
						continue
					}
					_ = s.writeFrame(cf.op, cf.body)
					s.conn.Close()
					return
				default:
					return
				}
			}
		case cf := <-s.ctl:
			if s.doomed.Load() && !cf.fatal {
				continue // teardown: only the terminal frame matters now
			}
			if err := s.writeFrame(cf.op, cf.body); err != nil {
				s.conn.Close()
				return
			}
			if cf.fatal {
				s.conn.Close()
				return
			}
		case t := <-s.out:
			if s.doomed.Load() {
				continue // drain dead assignments; nothing further goes out
			}
			if t.kind == taskLane {
				// Lane delivery: the seq is the LANE's, assigned at journal
				// time and shared by every consumer; per-sid stamping does
				// not apply and must not pretend it does.
				body, err := wire.EncodeStreamDeliver(wire.StreamDeliver{
					Subject: t.subject, Sid: t.sid, Seq: t.laneSeq,
					Reply: t.reply, Payload: t.payload, HasReply: t.hasReply,
				})
				if err != nil {
					s.log.Error("lane deliver encode failed", "session", s.id, "sid", t.sid, "err", err)
					continue
				}
				if err := s.writeFrame(wire.OpStreamDeliver, body); err != nil {
					s.conn.Close()
					return
				}
				// Receipts told those consumers what to ack with; pongs and
				// other control frames continue underneath on their own loop.
				continue
			}
			if s.seq == nil {
				s.seq = make(map[uint32]uint32)
			}
			s.seq[t.sid] = s.seq[t.sid] + 1
			body, err := wire.EncodeDeliver(wire.Deliver{
				Subject: t.subject, Sid: t.sid, Seq: s.seq[t.sid],
				Reply: t.reply, Payload: t.payload, HasReply: t.hasReply,
			})
			if err != nil {
				// The hub only enqueues valid sids and subjects, so this
				// cannot happen; if it does, the writer is lying to itself.
				s.log.Error("deliver encode failed", "session", s.id, "sid", t.sid, "err", err)
				continue
			}
			if err := s.writeFrame(wire.OpDeliver, body); err != nil {
				s.conn.Close()
				return
			}
		}
	}
}

// writeFrame stamps the deadline, logs failures once, and reports.
func (s *session) writeFrame(op wire.Op, body []byte) error {
	_ = s.conn.SetWriteDeadline(time.Now().Add(s.cfg.WriteTimeout))
	err := s.wr.WriteFrame(op, body)
	if err != nil {
		s.log.Debug("write failed", "session", s.id, "op", op.String(), "err", err)
	}
	return err
}

// deliver is hub-only: enqueue one message for this session's writer.
// Called under the hub read lock; never blocks. True when queued.
func (s *session) deliver(sid uint32, subject string, payload []byte, reply string, hasReply bool) bool {
	if s.dead() {
		return false
	}
	t := deliverTask{sid: sid, subject: subject, payload: payload, reply: reply, hasReply: hasReply, kind: taskSpur}
	select {
	case s.out <- t:
		return true
	default:
		s.kill(fmt.Sprintf("deliver queue overflow (%d buffered)", s.cfg.OutBuf), wire.CodeSlowConsumer)
		return false
	}
}

// deliverLane is stream-only: one lane message for one consumer. Same queue,
// same bounds, same slow-consumer law — the only difference is who calls it
// (the lane, holding the lane lock, in strict agreement with lane seq).
func (s *session) deliverLane(sid uint32, laneSeq uint64, subject string, payload []byte, reply string, hasReply bool) bool {
	if s.dead() {
		return false
	}
	t := deliverTask{sid: sid, subject: subject, payload: payload, reply: reply, hasReply: hasReply, kind: taskLane, laneSeq: laneSeq}
	select {
	case s.out <- t:
		return true
	default:
		s.kill(fmt.Sprintf("deliver queue overflow (%d buffered)", s.cfg.OutBuf), wire.CodeSlowConsumer)
		return false
	}
}
