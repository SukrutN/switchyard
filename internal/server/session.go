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
}

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

	// seq is writer-goroutine-private: sid → last stamped sequence.
	seq map[uint32]uint32

	handshaked bool
	peerName   string // HELLO name, display-only in lifecycle logs
	peerLabel  string // HELLO label, same contract
}

func newSession(id uint64, cfg *Config, hub *Hub, log *slog.Logger, conn net.Conn) *session {
	return &session{
		id:   id,
		cfg:  cfg,
		hub:  hub,
		log:  log,
		conn: conn,
		rd:   wire.NewReader(conn, cfg.MaxBody),
		wr:   wire.NewWriter(conn),
		out:  make(chan deliverTask, cfg.OutBuf),
		ctl:  make(chan ctlFrame, 8),
		quit: make(chan struct{}),
		subs: map[uint32]string{},
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
	if op == wire.OpWelcome || op == wire.OpDeliver {
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
		code, uerr := s.hub.unsubscribe(s, u.Sid)
		if uerr != nil {
			return s.pushErr("unsubscribe refused: "+uerr.Error(), code)
		}
		return nil

	default:
		return s.kill("unknown op "+op.String(), wire.CodeUnknownOp)
	}
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

// sidOwner returns the pattern living at sid, or "" when none does.
func (s *session) sidOwner(sid uint32) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.subs[sid]
}

// allSids snapshots live sids for hub teardown.
func (s *session) allSids() []uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]uint32, 0, len(s.subs))
	for sid := range s.subs {
		out = append(out, sid)
	}
	return out
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
	t := deliverTask{sid: sid, subject: subject, payload: payload, reply: reply, hasReply: hasReply}
	select {
	case s.out <- t:
		return true
	default:
		s.kill(fmt.Sprintf("deliver queue overflow (%d buffered)", s.cfg.OutBuf), wire.CodeSlowConsumer)
		return false
	}
}
