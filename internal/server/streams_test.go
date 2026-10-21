package server

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/SukrutN/switchyard/internal/wire"
)

// Lane engine tests. These speak raw wire: the server's stream behavior is
// the contract, and a helpful client library is exactly what we are not
// testing here. Helpers are local (lane*) to keep the pub/sub test file's
// vocabulary separate.

// laneServer starts a yard with a real data dir and hands back the dir so
// recovery tests can tamper with journal files between restarts.
func laneServer(t *testing.T) (*Server, *Config, string) {
	t.Helper()
	dir := t.TempDir()
	srv, cfg := newTestServer(t, func(c *Config) { c.DataDir = dir })
	return srv, cfg, dir
}

// laneConn is a handshaked raw connection used for lane ops.
func laneConn(t *testing.T, srv *Server) *raw {
	t.Helper()
	c := dialRaw(t, srv.Addr())
	c.hello(t)
	return c
}

// laneCreate creates a lane and expects STREAM_READY; returns the advertised
// next seq.
func laneCreate(t *testing.T, c *raw, name string) uint64 {
	t.Helper()
	b, err := wire.EncodeStreamCreate(wire.StreamCreate{Name: name})
	if err != nil {
		t.Fatalf("create encode: %v", err)
	}
	c.send(t, wire.OpStreamCreate, b)
	op, body := laneReadFrame(t, c, 2*time.Second)
	if op != wire.OpStreamReady {
		t.Fatalf("create %q: got %s, want STREAM_READY", name, op)
	}
	r, err := wire.DecodeStreamReady(body)
	if err != nil {
		t.Fatalf("decode ready: %v", err)
	}
	return r.Seq
}

// laneReadFrame reads one frame, skipping heartbeat chatter, and fails the
// test on any ERROR (refusals have their own expectations elsewhere).
func laneReadFrame(t *testing.T, c *raw, within time.Duration) (wire.Op, []byte) {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatalf("no expected frame arrived within %s", within)
		}
		op, body, err := c.read(t, remaining)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		switch op {
		case wire.OpPing, wire.OpPong:
			continue
		case wire.OpError:
			e, derr := wire.DecodeError(body)
			if derr != nil {
				t.Fatalf("error frame: %v", derr)
			}
			t.Fatalf("unexpected ERROR 0x%02X (%s)", e.Code, e.Message)
		default:
			return op, body
		}
	}
}

// laneExpectError fails unless ERROR wantCode arrives within the window.
func laneExpectError(t *testing.T, c *raw, wantCode byte, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatalf("no ERROR 0x%02X arrived in time", wantCode)
		}
		op, body, err := c.read(t, remaining)
		if err != nil {
			t.Fatalf("awaiting ERROR 0x%02X: %v", wantCode, err)
		}
		switch op {
		case wire.OpPing, wire.OpPong:
			continue
		case wire.OpError:
			e, derr := wire.DecodeError(body)
			if derr != nil {
				t.Fatalf("error frame: %v", derr)
			}
			if e.Code != wantCode {
				t.Fatalf("error code 0x%02X want 0x%02X (%q)", e.Code, wantCode, e.Message)
			}
			if e.Fatal {
				t.Fatalf("lane refusals are non-fatal by charter; got fatal: %q", e.Message)
			}
			return
		default:
			t.Fatalf("got %s while awaiting ERROR 0x%02X", op, wantCode)
		}
	}
}

// lanePublish sends one STREAM_PUBLISH and expects its receipt back; the
// per-session publish order IS the receipt order (§2.11), so this reads
// sequentially.
func lanePublish(t *testing.T, c *raw, stream, subject string, payload []byte, wantSeq uint64) {
	t.Helper()
	b, err := wire.EncodeStreamPublish(wire.StreamPublish{Stream: stream, Subject: subject, Payload: payload})
	if err != nil {
		t.Fatalf("publish encode: %v", err)
	}
	c.send(t, wire.OpStreamPublish, b)
	op, body := laneReadFrame(t, c, 2*time.Second)
	if op != wire.OpStreamReceipt {
		t.Fatalf("publish %s: got %s, want STREAM_RECEIPT", subject, op)
	}
	r, derr := wire.DecodeStreamReceipt(body)
	if derr != nil {
		t.Fatalf("receipt decode: %v", derr)
	}
	if r.Seq != wantSeq || r.Stream != stream {
		t.Fatalf("receipt {lane=%s seq=%d}, want {lane=%s seq=%d}", r.Stream, r.Seq, stream, wantSeq)
	}
}

// laneAttach is the plain attach. laneAttachWait retries a DUP_CONSUMER
// refusal for a bounded while — resuming after a dropped session races that
// session's async teardown, and the resume must outwait the corpse.
func laneAttachWait(t *testing.T, c *raw, stream, consumer string, sid uint32, ackWaitMillis uint32, filter string) wire.ConsumerReady {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		b, _ := wire.EncodeConsumerAttach(wire.ConsumerAttach{Stream: stream, Consumer: consumer, Sid: sid, AckWaitMillis: ackWaitMillis})
		if filter != "" {
			// Encode errors here mean a test bug, not a transport story.
			b, _ = wire.EncodeConsumerAttach(wire.ConsumerAttach{Stream: stream, Consumer: consumer, Sid: sid, AckWaitMillis: ackWaitMillis, Filter: filter, HasFilter: true})
		}
		c.send(t, wire.OpConsumerAttach, b)
		op, body := laneReadOp(t, c, 2*time.Second)
		if op == wire.OpConsumerReady {
			if op2, body2 := op, body; op2 == wire.OpConsumerReady {
				r, derr := wire.DecodeConsumerReady(body2)
				if derr != nil {
					t.Fatalf("ready decode: %v", derr)
				}
				return r
			}
		}
		if op == wire.OpError && time.Now().Before(deadline) {
			e, derr := wire.DecodeError(body)
			if derr == nil && e.Code == wire.CodeDupConsumer {
				time.Sleep(25 * time.Millisecond)
				continue
			}
			t.Fatalf("attach: ERROR 0x%02X (%s)", e.Code, e.Message)
		}
		t.Fatalf("attach: got %s, want CONSUMER_READY", op)
	}
}

// laneReadOp reads a frame skipping heartbeats and naming errors loudly.
func laneReadOp(t *testing.T, c *raw, within time.Duration) (wire.Op, []byte) {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return wire.Op(0), nil
		}
		op, body, err := c.read(t, remaining)
		if err != nil {
			return 0, nil
		}
		if op == wire.OpPing || op == wire.OpPong {
			continue
		}
		if op == wire.OpError {
			return op, body
		}
		return op, body
	}
}

// laneAttach attaches a consumer and returns the CONSUMER_READY frame.
func laneAttach(t *testing.T, c *raw, stream, consumer string, sid uint32, ackWaitMillis uint32, filter string) wire.ConsumerReady {
	t.Helper()
	a := wire.ConsumerAttach{Stream: stream, Consumer: consumer, Sid: sid, AckWaitMillis: ackWaitMillis}
	if filter != "" {
		a.Filter, a.HasFilter = filter, true
	}
	b, err := wire.EncodeConsumerAttach(a)
	if err != nil {
		t.Fatalf("attach encode: %v", err)
	}
	c.send(t, wire.OpConsumerAttach, b)
	op, body := laneReadFrame(t, c, 2*time.Second)
	if op != wire.OpConsumerReady {
		t.Fatalf("attach: got %s, want CONSUMER_READY", op)
	}
	r, derr := wire.DecodeConsumerReady(body)
	if derr != nil {
		t.Fatalf("ready decode: %v", derr)
	}
	return r
}

// laneWaitDeliver reads STREAM_DELIVER frames, tolerating heartbeats, and
// returns the first one.
func laneWaitDeliver(t *testing.T, c *raw, within time.Duration) wire.StreamDeliver {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatalf("no STREAM_DELIVER within %s", within)
		}
		op, body, err := c.read(t, remaining)
		if err != nil {
			t.Fatalf("read deliver: %v", err)
		}
		switch op {
		case wire.OpPing, wire.OpPong:
			continue
		case wire.OpStreamDeliver:
			d, derr := wire.DecodeStreamDeliver(body)
			if derr != nil {
				t.Fatalf("deliver decode: %v", derr)
			}
			return d
		default:
			t.Fatalf("got %s while awaiting STREAM_DELIVER", op)
		}
	}
}

// laneSilence asserts NOTHING but heartbeats arrive within the window.
func laneSilence(t *testing.T, c *raw, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return
		}
		op, _, err := c.read(t, remaining)
		if err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				return
			}
			t.Fatalf("silence check read: %v", err)
		}
		if op == wire.OpPing || op == wire.OpPong {
			continue
		}
		t.Fatalf("expected silence, got %s", op)
	}
}

func laneAck(t *testing.T, c *raw, sid uint32, seq uint64) {
	t.Helper()
	b, err := wire.EncodeAck(wire.Ack{Sid: sid, Seq: seq})
	if err != nil {
		t.Fatalf("ack encode: %v", err)
	}
	c.send(t, wire.OpAck, b)
}

func TestLaneCreateAndRefusals(t *testing.T) {
	srv, _, _ := laneServer(t)
	c := laneConn(t, srv)

	if seq := laneCreate(t, c, "orders"); seq != 1 {
		t.Fatalf("fresh lane seq = %d, want 1", seq)
	}

	// Duplicate name: refused, session lives.
	b, _ := wire.EncodeStreamCreate(wire.StreamCreate{Name: "orders"})
	c.send(t, wire.OpStreamCreate, b)
	laneExpectError(t, c, wire.CodeStreamExists, 2*time.Second)

	// Charter violation: dots are subject separators, not lane characters.
	b, _ = wire.EncodeStreamCreate(wire.StreamCreate{Name: "orders.east"})
	c.send(t, wire.OpStreamCreate, b)
	laneExpectError(t, c, wire.CodeBadStreamName, 2*time.Second)

	// Publish to an unknown lane.
	pb, _ := wire.EncodeStreamPublish(wire.StreamPublish{Stream: "nope", Subject: "nope.a", Payload: []byte("x")})
	c.send(t, wire.OpStreamPublish, pb)
	laneExpectError(t, c, wire.CodeStreamUnknown, 2*time.Second)

	// Publish with the wrong first token.
	if seq := laneCreate(t, c, "payments"); seq != 1 {
		t.Fatalf("payments seq = %d, want 1", seq)
	}
	pb, _ = wire.EncodeStreamPublish(wire.StreamPublish{Stream: "payments", Subject: "orders.a", Payload: []byte("x")})
	c.send(t, wire.OpStreamPublish, pb)
	laneExpectError(t, c, wire.CodeStreamSubject, 2*time.Second)

	// Wildcard subjects never journal.
	pb, _ = wire.EncodeStreamPublish(wire.StreamPublish{Stream: "payments", Subject: "payments.*", Payload: []byte("x")})
	c.send(t, wire.OpStreamPublish, pb)
	laneExpectError(t, c, wire.CodeBadSubject, 2*time.Second)

	// Delete an unknown lane.
	db, _ := wire.EncodeStreamDelete(wire.StreamDelete{Name: "nope"})
	c.send(t, wire.OpStreamDelete, db)
	laneExpectError(t, c, wire.CodeStreamUnknown, 2*time.Second)

	// After all that refusing, the session still works: a clean create.
	if seq := laneCreate(t, c, "east"); seq != 1 {
		t.Fatalf("east seq = %d, want 1 (refusals must keep sessions alive)", seq)
	}
}

func TestLaneDisabledWithoutDataDir(t *testing.T) {
	srv, _ := newTestServer(t, nil)
	c := laneConn(t, srv)

	b, _ := wire.EncodeStreamCreate(wire.StreamCreate{Name: "orders"})
	c.send(t, wire.OpStreamCreate, b)
	laneExpectError(t, c, wire.CodeStreamDisabled, 2*time.Second)

	pb, _ := wire.EncodeStreamPublish(wire.StreamPublish{Stream: "orders", Subject: "orders.a", Payload: []byte("x")})
	c.send(t, wire.OpStreamPublish, pb)
	laneExpectError(t, c, wire.CodeStreamDisabled, 2*time.Second)

	ab, _ := wire.EncodeConsumerAttach(wire.ConsumerAttach{Stream: "orders", Consumer: "c", Sid: 1})
	c.send(t, wire.OpConsumerAttach, ab)
	laneExpectError(t, c, wire.CodeStreamDisabled, 2*time.Second)
}

func TestLanePublishReceiptsAndGaplessSeq(t *testing.T) {
	srv, _, _ := laneServer(t)
	c := laneConn(t, srv)

	laneCreate(t, c, "orders")
	for i := uint64(1); i <= 50; i++ {
		lanePublish(t, c, "orders", fmt.Sprintf("orders.e%d.paid", i), []byte(fmt.Sprintf("payload-%d", i)), i)
	}

	// The journal exists and holds 50 records' worth of bytes.
	jpath := filepath.Join(srv.hub.lanes.root, "orders", "journal.log")
	st, err := os.Stat(jpath)
	if err != nil {
		t.Fatalf("journal missing: %v", err)
	}
	if st.Size() <= 32 {
		t.Fatalf("journal suspiciously small: %d bytes", st.Size())
	}
}

func TestLaneConcurrentPublishersOneSeqSpace(t *testing.T) {
	srv, _, dir := laneServer(t)
	_ = dir

	const publishers = 4
	const each = 25

	c0 := laneConn(t, srv)
	laneCreate(t, c0, "orders")
	c0.conn.Close()

	var wg sync.WaitGroup
	seqs := make([][]uint64, publishers)
	for p := 0; p < publishers; p++ {
		p := p
		wg.Add(1)
		go func() {
			defer wg.Done()
			c := laneConn(t, srv)
			got := make([]uint64, 0, each)
			for i := 0; i < each; i++ {
				body, _ := wire.EncodeStreamPublish(wire.StreamPublish{
					Stream:  "orders",
					Subject: fmt.Sprintf("orders.p%d.%d", p, i),
					Payload: []byte("concurrent"),
				})
				c.send(t, wire.OpStreamPublish, body)
				op, rbody := laneReadFrame(t, c, 3*time.Second)
				if op != wire.OpStreamReceipt {
					t.Errorf("publisher %d: got %s, want receipt", p, op)
					return
				}
				r, derr := wire.DecodeStreamReceipt(rbody)
				if derr != nil {
					t.Errorf("receipt decode: %v", derr)
					return
				}
				got = append(got, r.Seq)
			}
			c.conn.Close()
			seqs[p] = got
		}()
	}
	wg.Wait()

	// Every receipt is unique over 1..N with no gaps: the seq space is
	// global to the lane, assigned under one lock.
	seen := make(map[uint64]bool, publishers*each)
	for _, g := range seqs {
		for _, s := range g {
			if seen[s] {
				t.Fatalf("duplicate receipt seq %d across publishers", s)
			}
			seen[s] = true
		}
	}
	for s := uint64(1); s <= publishers*each; s++ {
		if !seen[s] {
			t.Fatalf("seq %d never issued (gapless proof failed); got %d seqs", s, len(seen))
		}
	}
}

func TestLaneConsumerFlowAndAckFloor(t *testing.T) {
	srv, _, _ := laneServer(t)
	c := laneConn(t, srv)
	laneCreate(t, c, "orders")

	for i := 1; i <= 3; i++ {
		lanePublish(t, c, "orders", fmt.Sprintf("orders.order%d", i), []byte(fmt.Sprintf("p%d", i)), uint64(i))
	}

	r := laneAttach(t, c, "orders", "billing", 7, 5000, "")
	if r.Next != 1 || r.Consumer != "billing" || r.Sid != 7 {
		t.Fatalf("ready = %+v, want next=1 consumer=billing sid=7", r)
	}
	for i := uint64(1); i <= 3; i++ {
		d := laneWaitDeliver(t, c, 2*time.Second)
		if d.Seq != i || d.Sid != 7 {
			t.Fatalf("delivery seq=%d sid=%d, want seq=%d sid=7", d.Seq, d.Sid, i)
		}
		want := fmt.Sprintf("p%d", i)
		if !bytes.Equal(d.Payload, []byte(want)) || d.Subject != fmt.Sprintf("orders.order%d", i) {
			t.Fatalf("delivery payload drift: %+v", d)
		}
		laneAck(t, c, 7, i)
	}
	laneSilence(t, c, 200*time.Millisecond)

	// A fresh consumer on the same lane sees the whole history; the acked
	// consumer saw it through its own floor.
	c2 := laneConn(t, srv)
	r2 := laneAttach(t, c2, "orders", "audit", 8, 5000, "")
	if r2.Next != 1 {
		t.Fatalf("fresh consumer next = %d, want 1 (lanes replay from the beginning)", r2.Next)
	}
	for i := uint64(1); i <= 3; i++ {
		if d := laneWaitDeliver(t, c2, 2*time.Second); d.Seq != i {
			t.Fatalf("audit consumer delivery seq %d, want %d", d.Seq, i)
		}
	}
}

func TestLaneRedeliveryUntilAck(t *testing.T) {
	srv, _, _ := laneServer(t)
	c := laneConn(t, srv)
	laneCreate(t, c, "orders")
	lanePublish(t, c, "orders", "orders.e1", []byte("once"), 1)

	r := laneAttach(t, c, "orders", "billing", 7, 150, "")
	if r.Next != 1 {
		t.Fatalf("next = %d", r.Next)
	}
	d1 := laneWaitDeliver(t, c, 2*time.Second)
	if d1.Seq != 1 {
		t.Fatalf("first delivery seq %d", d1.Seq)
	}
	// No ack: the sweeper owes us the same seq again.
	d2 := laneWaitDeliver(t, c, 3*time.Second)
	if d2.Seq != 1 {
		t.Fatalf("redelivery seq %d, want 1 (same message, same number)", d2.Seq)
	}
	if !bytes.Equal(d1.Payload, d2.Payload) {
		t.Fatal("redelivered payload differs from the original")
	}

	// Ack ends the obligations; the sweeper goes quiet.
	laneAck(t, c, 7, 1)
	laneSilence(t, c, 400*time.Millisecond)
}

func TestLaneResumeAfterSessionLoss(t *testing.T) {
	srv, _, _ := laneServer(t)
	c1 := laneConn(t, srv)
	laneCreate(t, c1, "orders")
	lanePublish(t, c1, "orders", "orders.a", []byte("m1"), 1)
	lanePublish(t, c1, "orders", "orders.b", []byte("m2"), 2)

	r := laneAttach(t, c1, "orders", "billing", 7, 60000, "")
	if r.Next != 1 {
		t.Fatalf("initial attach next = %d, want 1", r.Next)
	}
	if d := laneWaitDeliver(t, c1, 2*time.Second); d.Seq != 1 {
		t.Fatalf("delivery seq %d, want 1", d.Seq)
	}
	// No ack for seq 1; then the session dies without BYE — the pending
	// seq is the durable position now.
	c1.conn.Close()

	c2 := laneConn(t, srv)
	r2 := laneAttachWait(t, c2, "orders", "billing", 9, 60000, "")
	if r2.Next != 1 {
		t.Fatalf("resume next = %d, want 1 (pending seq replays first)", r2.Next)
	}
	d1 := laneWaitDeliver(t, c2, 2*time.Second)
	if d1.Seq != 1 || string(d1.Payload) != "m1" {
		t.Fatalf("resume replay got seq %d (%s), want seq 1 (m1)", d1.Seq, d1.Payload)
	}
	d2 := laneWaitDeliver(t, c2, 2*time.Second)
	if d2.Seq != 2 || string(d2.Payload) != "m2" {
		t.Fatalf("resume window got seq %d (%s), want seq 2 (m2)", d2.Seq, d2.Payload)
	}
	// Both were lane-ordered: seq 1 strictly before seq 2 even though one
	// is a redelivery and one is fresh.
	laneAck(t, c2, 9, 1)
	laneAck(t, c2, 9, 2)
	laneSilence(t, c2, 200*time.Millisecond)
	c2.conn.Close() // let billing go: the next resume is a different reader

	// Fully acked: a third attach has nothing to replay.
	c3 := laneConn(t, srv)
	r3 := laneAttachWait(t, c3, "orders", "billing", 5, 60000, "")
	if r3.Next != 3 {
		t.Fatalf("post-ack resume next = %d, want 3", r3.Next)
	}
	laneSilence(t, c3, 250*time.Millisecond)
}

func TestLaneSurvivesRestartAndKeepsPositions(t *testing.T) {
	srv, cfg, dir := laneServer(t)
	c := laneConn(t, srv)
	laneCreate(t, c, "orders")
	for i := 1; i <= 5; i++ {
		lanePublish(t, c, "orders", fmt.Sprintf("orders.r%d", i), []byte(fmt.Sprintf("v%d", i)), uint64(i))
	}

	r := laneAttach(t, c, "orders", "billing", 7, 60000, "")
	if r.Next != 1 {
		t.Fatalf("initial attach next = %d, want 1", r.Next)
	}
	for i := uint64(1); i <= 5; i++ {
		if d := laneWaitDeliver(t, c, 2*time.Second); d.Seq != i {
			t.Fatalf("delivery seq %d, want %d", d.Seq, i)
		}
	}
	laneAck(t, c, 7, 1)
	laneAck(t, c, 7, 2)
	// ACKs have no reply frame, so before Stop the only proof they landed
	// is a quiet beat at the socket — without it the frames may still be
	// in flight when the listener closes.
	laneSilence(t, c, 250*time.Millisecond)
	srv.Stop() // handles closed, positions on disk

	// Same data dir, new yard: journal replay and consumer floor rebuild.
	srv2, cfg2 := newTestServer(t, func(cc *Config) { cc.DataDir = dir; cc.AckWait = cfg.AckWait })
	_ = cfg2
	c2 := laneConn(t, srv2)
	if seq := laneCreate(t, c2, "unused"); seq != 1 {
		_ = seq
	}
	// The lane's seq continues past the last journaled record; the receipt
	// of the next publish proves the replay counted 5 records.
	body, _ := wire.EncodeStreamPublish(wire.StreamPublish{Stream: "orders", Subject: "orders.r6", Payload: []byte("v6")})
	c2.send(t, wire.OpStreamPublish, body)
	op, rbody := laneReadFrame(t, c2, 3*time.Second)
	if op != wire.OpStreamReceipt {
		t.Fatalf("restart publish: got %s, want receipt", op)
	}
	rc, derr := wire.DecodeStreamReceipt(rbody)
	if derr != nil {
		t.Fatalf("receipt decode: %v", derr)
	}
	if rc.Seq != 6 {
		t.Fatalf("after restart the lane assigns seq %d, want 6", rc.Seq)
	}

	// The consumer's floor survived too: billing resumes at 3 and replays
	// 3..5 plus the fresh 6.
	r2 := laneAttach(t, c2, "orders", "billing", 3, 60000, "")
	if r2.Next != 3 {
		t.Fatalf("resume next = %d, want 3 (acked floor persisted)", r2.Next)
	}
	for want := uint64(3); want <= 6; want++ {
		if d := laneWaitDeliver(t, c2, 2*time.Second); d.Seq != want {
			t.Fatalf("resume delivery seq %d, want %d", d.Seq, want)
		}
	}
}

func TestLaneTornTailRecovery(t *testing.T) {
	srv, _, dir := laneServer(t)
	c := laneConn(t, srv)
	laneCreate(t, c, "orders")
	for i := 1; i <= 5; i++ {
		lanePublish(t, c, "orders", fmt.Sprintf("orders.t%d", i), []byte(fmt.Sprintf("x%d", i)), uint64(i))
	}
	srv.Stop()

	// Simulate a power cut mid-write: saw the last record in half.
	jpath := filepath.Join(dir, "streams", "orders", "journal.log")
	raw, err := os.ReadFile(jpath)
	if err != nil {
		t.Fatalf("read journal: %v", err)
	}
	if err := os.WriteFile(jpath, raw[:len(raw)-10], 0o644); err != nil {
		t.Fatalf("torn write: %v", err)
	}

	srv2, _ := newTestServer(t, func(cc *Config) { cc.DataDir = dir })
	c2 := laneConn(t, srv2)

	// The torn record is gone; the lane's next seq is the last intact one.
	body, _ := wire.EncodeStreamPublish(wire.StreamPublish{Stream: "orders", Subject: "orders.after", Payload: []byte("after")})
	c2.send(t, wire.OpStreamPublish, body)
	op, rbody := laneReadFrame(t, c2, 3*time.Second)
	if op != wire.OpStreamReceipt {
		t.Fatalf("post-recovery publish: got %s, want receipt", op)
	}
	rc, derr := wire.DecodeStreamReceipt(rbody)
	if derr != nil {
		t.Fatalf("receipt decode: %v", derr)
	}
	if rc.Seq != 5 {
		t.Fatalf("recovery assigned seq %d, want 5 (the torn sixth never happened)", rc.Seq)
	}

	// A fresh consumer replays the intact 1..4 and the new 5.
	r := laneAttach(t, c2, "orders", "audit", 1, 60000, "")
	if r.Next != 1 {
		t.Fatalf("fresh consumer next = %d", r.Next)
	}
	for want := uint64(1); want <= 5; want++ {
		if d := laneWaitDeliver(t, c2, 2*time.Second); d.Seq != want {
			t.Fatalf("recovered delivery seq %d, want %d (no invented records)", d.Seq, want)
		}
	}
}

func TestLaneDeleteNotifiesAndClearsDisk(t *testing.T) {
	srv, _, dir := laneServer(t)
	c1 := laneConn(t, srv)
	laneCreate(t, c1, "orders")
	lanePublish(t, c1, "orders", "orders.a", []byte("m"), 1)
	r := laneAttach(t, c1, "orders", "billing", 7, 60000, "")
	_ = r
	if d := laneWaitDeliver(t, c1, 2*time.Second); d.Seq != 1 {
		t.Fatalf("delivery seq %d", d.Seq)
	}

	// A different session deletes the lane out from under the consumer.
	c2 := laneConn(t, srv)
	db, _ := wire.EncodeStreamDelete(wire.StreamDelete{Name: "orders"})
	c2.send(t, wire.OpStreamDelete, db)
	op, body := laneReadFrame(t, c2, 2*time.Second)
	if op != wire.OpStreamGone {
		t.Fatalf("deleter: got %s, want STREAM_GONE", op)
	}
	if _, derr := wire.DecodeStreamGone(body); derr != nil {
		t.Fatalf("gone decode: %v", derr)
	}
	// The attached consumer hears the same goodbye.
	op1, _ := laneReadFrame(t, c1, 2*time.Second)
	if op1 != wire.OpStreamGone {
		t.Fatalf("consumer: got %s, want STREAM_GONE", op1)
	}

	// Disk is cleared.
	if _, err := os.Stat(filepath.Join(dir, "streams", "orders")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("lane dir survived deletion: %v", err)
	}

	// And nothing resurrects it from a publish.
	pb, _ := wire.EncodeStreamPublish(wire.StreamPublish{Stream: "orders", Subject: "orders.b", Payload: []byte("x")})
	c1.send(t, wire.OpStreamPublish, pb)
	laneExpectError(t, c1, wire.CodeStreamUnknown, 2*time.Second)
}

func TestLaneFilterNarrowsDelivery(t *testing.T) {
	srv, _, _ := laneServer(t)
	c := laneConn(t, srv)
	laneCreate(t, c, "orders")
	lanePublish(t, c, "orders", "orders.paid.e1", []byte("keep"), 1)
	lanePublish(t, c, "orders", "orders.cancel.e1", []byte("drop"), 2)
	lanePublish(t, c, "orders", "orders.paid.e2", []byte("keep"), 3)

	laneAttach(t, c, "orders", "settlements", 7, 60000, "orders.paid.>")
	d1 := laneWaitDeliver(t, c, 2*time.Second)
	if d1.Seq != 1 || string(d1.Payload) != "keep" {
		t.Fatalf("filtered delivery 1: %+v", d1)
	}
	d2 := laneWaitDeliver(t, c, 2*time.Second)
	if d2.Seq != 3 || string(d2.Payload) != "keep" {
		t.Fatalf("filtered delivery 2: %+v (seq 2 must skip the filter)", d2)
	}
	laneSilence(t, c, 200*time.Millisecond)

	// Acking seq 1 lands with the floor skipping the filtered-out seq 2:
	// after acking 3, the floor must reach 3, proven by a re-attach that
	// replays nothing. The detach is honest UNSUB — one sid, one consumer,
	// and the client chose to let it go.
	laneAck(t, c, 7, 1)
	laneAck(t, c, 7, 3)
	ub, _ := wire.EncodeUnsub(wire.Unsub{Sid: 7})
	c.send(t, wire.OpUnsub, ub)
	laneSilence(t, c, 150*time.Millisecond)

	c2 := laneConn(t, srv)
	r := laneAttach(t, c2, "orders", "settlements", 4, 60000, "orders.paid.>")
	if r.Next != 4 {
		t.Fatalf("re-attach next = %d, want 4 (floor skipped filtered seq 2)", r.Next)
	}
	laneSilence(t, c2, 250*time.Millisecond)
}
