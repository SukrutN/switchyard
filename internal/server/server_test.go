package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/SukrutN/switchyard/internal/client"
	"github.com/SukrutN/switchyard/internal/wire"
)

// newTestServer starts a real yard on an ephemeral port with fast heartbeats
// so lifecycle tests stay out of the "takes a minute" category.
func newTestServer(t *testing.T, mutate func(*Config)) (*Server, *Config) {
	t.Helper()
	cfg := &Config{
		Idle:         500 * time.Millisecond,
		Grace:        300 * time.Millisecond,
		WriteTimeout: 5 * time.Second,
	}
	if mutate != nil {
		mutate(cfg)
	}
	cfg.Log = logDiscard()
	srv, err := NewServer(*cfg)
	if err != nil {
		t.Fatalf("server: %v", err)
	}
	t.Cleanup(srv.Stop)
	go srv.Run()
	return srv, cfg
}

func logDiscard() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func dialClient(t *testing.T, addr string) *client.Client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c, err := client.Dial(ctx, addr, client.Options{
		DeliverBuf: 128,
		Keepalive:  30 * time.Second,
	})
	if err != nil {
		t.Fatalf("client dial: %v", err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

// ---- raw wire probes ----

// raw speaks the protocol without the client lib: it exists to exercise the
// server at the byte level, where a client lib is too helpful to trust.
type raw struct {
	conn net.Conn
	r    *wire.Reader
	w    *wire.Writer
}

func dialRaw(t *testing.T, addr string) *raw {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("raw dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return &raw{
		conn: conn,
		r:    wire.NewReader(conn, wire.MaxBodyBytes),
		w:    wire.NewWriter(conn),
	}
}

func (rw *raw) hello(t *testing.T) wire.Welcome {
	t.Helper()
	hb, err := wire.EncodeHello(wire.Hello{Name: "probe", Label: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if err := rw.w.WriteFrame(wire.OpHello, hb); err != nil {
		t.Fatalf("send hello: %v", err)
	}
	op, body, err := rw.read(t, 3*time.Second)
	if err != nil || op != wire.OpWelcome {
		t.Fatalf("handshake: op %v err %v — WELCOME expected", op, err)
	}
	w, err := wire.DecodeWelcome(body)
	if err != nil {
		t.Fatalf("welcome: %v", err)
	}
	return w
}

func (rw *raw) send(t *testing.T, op wire.Op, body []byte) {
	t.Helper()
	_ = rw.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	if err := rw.w.WriteFrame(op, body); err != nil {
		t.Fatalf("send %s: %v", op, err)
	}
}

func (rw *raw) read(t *testing.T, within time.Duration) (wire.Op, []byte, error) {
	t.Helper()
	_ = rw.conn.SetReadDeadline(time.Now().Add(within))
	return rw.r.ReadFrame()
}

func (rw *raw) expectError(t *testing.T, wantCode byte, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatalf("no ERROR 0x%02X arrived in time", wantCode)
		}
		op, body, err := rw.read(t, remaining)
		if err != nil {
			t.Fatalf("awaiting ERROR 0x%02X: %v", wantCode, err)
		}
		switch op {
		case wire.OpError:
			e, err := wire.DecodeError(body)
			if err != nil {
				t.Fatalf("error frame: %v", err)
			}
			if e.Code != wantCode {
				t.Fatalf("error code 0x%02X want 0x%02X (%q)", e.Code, wantCode, e.Message)
			}
			if !e.Fatal {
				t.Fatalf("refusal of this class must be fatal: %q", e.Message)
			}
			return
		case wire.OpPing:
			// Probes from the idle machinery may race the fatal frame; raw
			// probes keep silent so the timer stays honest.
			continue
		default:
			t.Fatalf("got %s while awaiting ERROR", op)
		}
	}
}

// ---- ----

// settle proves a subscription registered before cross-session traffic:
// v1 has no SUBSCRIBE ack, so a publish from a DIFFERENT connection can
// legally beat a fresh subscribe under heavy scheduling. Publishing a
// probe subject the subscription must catch, until it returns, removes
// that window; drainQuiet then empties any rest-of-loop residue.
func settle(t *testing.T, publisher *client.Client, subject string, subscriber *client.Client, wantSid uint32) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if time.Now().After(deadline) {
			t.Fatalf("subscription never settled on %s", subject)
		}
		_ = publisher.Publish(subject, []byte("settle"))
		select {
		case d := <-subscriber.Deliveries():
			if d.Sid == wantSid {
				return
			}
			t.Fatalf("settle probe hit sid %d (%s), want %d", d.Sid, d.Subject, wantSid)
		case e := <-subscriber.Errors():
			t.Fatalf("refusal while settling: %v", e)
		case <-time.After(150 * time.Millisecond):
		}
	}
}

func drainQuiet(t *testing.T, c *client.Client, quiet time.Duration) {
	t.Helper()
	for {
		select {
		case d := <-c.Deliveries():
			_ = d
		case e := <-c.Errors():
			t.Fatalf("unexpected error while draining: %v", e)
		case <-time.After(quiet):
			return
		}
	}
}

func mustDelivery(t *testing.T, c *client.Client, within time.Duration) client.Delivery {
	t.Helper()
	select {
	case d := <-c.Deliveries():
		return d
	case e := <-c.Errors():
		t.Fatalf("unexpected error: %v", e)
	case <-time.After(within):
		t.Fatal("no delivery in time")
	}
	return client.Delivery{}
}

func mustError(t *testing.T, c *client.Client, within time.Duration) client.ClientError {
	t.Helper()
	select {
	case e := <-c.Errors():
		return e
	case <-time.After(within):
		t.Fatal("no error arrived")
	}
	return client.ClientError{}
}

func TestPubSubLifecycle(t *testing.T) {
	srv, cfg := newTestServer(t, nil)

	subs := dialClient(t, srv.Addr())
	w := subs.Welcome()
	if w.ServerLabel != ServerLabel() {
		t.Fatalf("label %q want %q", w.ServerLabel, ServerLabel())
	}
	if w.MaxBody != DefaultMaxBody {
		t.Fatalf("maxbody %d want %d", w.MaxBody, DefaultMaxBody)
	}

	watch := []string{"orders.>", "kasten.*.paid"} // two sids, one connection
	for i, pat := range watch {
		if err := subs.Subscribe(uint32(i+1), pat); err != nil {
			t.Fatalf("subscribe %q: %v", pat, err)
		}
	}

	pub := dialClient(t, srv.Addr())

	// Settle both subscriptions through the one ordering guarantee v1 has:
	// a publish whose delivery returns proves everything enqueued to the
	// hub before it is live. sid1's pattern matches the beat subject; once
	// that returns, sid2 (sent first, same session) is registered too.
	settle(t, pub, "orders.beat", subs, 1)
	drainQuiet(t, subs, 150*time.Millisecond)

	// Burst ordering + gapless seq on a FRESH sid (sid2) so its counter
	// starts at 1 — per-subscription wording of the charter.
	const burst = 50
	for i := 0; i < burst; i++ {
		if err := pub.Publish("kasten.e9.paid", []byte{byte(i)}); err != nil {
			t.Fatalf("publish %d: %v", i, err)
		}
	}
	start := time.Now()
	for i := 0; i < burst; i++ {
		d := mustDelivery(t, subs, 5*time.Second)
		if d.Sid != 2 || d.Subject != "kasten.e9.paid" {
			t.Fatalf("got sid %d on %s", d.Sid, d.Subject)
		}
		if d.Seq != uint32(i+1) {
			t.Fatalf("seq gap: message %d carries seq %d", i, d.Seq)
		}
		if d.Payload[0] != byte(i) {
			t.Fatalf("burst order violated at %d: payload[0]=%d", i, d.Payload[0])
		}
	}
	t.Logf("burst of %d delivered in %s", burst, time.Since(start).Round(time.Millisecond))

	// Reply subject arrives intact — still on sid2's stream.
	if err := pub.PublishReply("kasten.c3.paid", "inbox.reporter", []byte("with reply")); err != nil {
		t.Fatal(err)
	}
	d := mustDelivery(t, subs, 3*time.Second)
	if d.Sid != 2 || !d.HasReply || d.Reply != "inbox.reporter" {
		t.Fatalf("reply delivery wrong: %+v", d)
	}

	// Unsubscribe stops the tap silently and for real. The idle window is
	// crossed via the client lib answering yard pings, NOT by dying.
	if err := subs.Unsubscribe(1); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2*(cfg.Idle+cfg.Grace) + 100*time.Millisecond)
	if err := pub.Publish("orders.e9.paid", []byte("after-unsub")); err != nil {
		t.Fatal(err)
	}
	select {
	case d := <-subs.Deliveries():
		t.Fatalf("delivery after unsubscribe: %+v", d)
	case <-time.After(400 * time.Millisecond):
	}

	// Both clients BYE cleanly; the yard closes them without complaints.
	subErr := subs.Close()
	pubErr := pub.Close()
	for _, err := range []error{subErr, pubErr} {
		if err != nil {
			t.Fatalf("bye: %v", err)
		}
	}
}

func TestCharterRefusalsReachClients(t *testing.T) {
	srv, _ := newTestServer(t, nil)
	c := dialClient(t, srv.Addr())

	if err := c.Publish("orders.*.paid", []byte("wildcards are subscriptions-only")); err != nil {
		t.Fatal(err)
	}
	if err := c.Subscribe(1, "orders.>.paid"); err != nil {
		t.Fatal(err)
	}
	if e := mustError(t, c, 3*time.Second); e.Code != wire.CodeBadSubject {
		t.Fatalf("first refusal code 0x%02X (%q)", e.Code, e.Message)
	}
	// two refusals were queued; drain the second
	if err := c.Publish("bad..subject", []byte("x")); err != nil {
		t.Fatal(err)
	}
	if e := mustError(t, c, 3*time.Second); e.Code != wire.CodeBadSubject {
		t.Fatalf("second refusal code 0x%02X (%q)", e.Code, e.Message)
	}

	// Session alive underneath all that: publish to a partner closes the loop.
	c2 := dialClient(t, srv.Addr())
	defer c2.Close()
	if err := c2.Subscribe(1, "probe.>"); err != nil {
		t.Fatal(err)
	}
	settle(t, c, "probe.settle", c2, 1)
	if err := c.Publish("probe.now", []byte("still-breathing")); err != nil {
		t.Fatal(err)
	}
	d := mustDelivery(t, c2, 2*time.Second)
	if d.Subject != "probe.now" {
		t.Fatalf("loop closed on %q", d.Subject)
	}
}

func TestDuplicateSid(t *testing.T) {
	srv, _ := newTestServer(t, nil)
	c := dialClient(t, srv.Addr())
	if err := c.Subscribe(4, "orders.>"); err != nil {
		t.Fatal(err)
	}
	if err := c.Subscribe(4, "kasten.>"); err != nil {
		t.Fatal(err)
	}
	e := mustError(t, c, 3*time.Second)
	if e.Code != wire.CodeDupSub {
		t.Fatalf("code 0x%02X want DUP_SUB: %q", e.Code, e.Message)
	}
}

// A reserved server op from a client is dialect drift; the yard stops rather
// than guesses.
func TestReservedOpsAreFatal(t *testing.T) {
	srv, _ := newTestServer(t, nil)
	rw := dialRaw(t, srv.Addr())
	_ = rw.hello(t)
	if err := rw.w.WriteFrame(wire.OpWelcome, nil); err != nil {
		t.Fatal(err)
	}
	rw.expectError(t, wire.CodeMalformed, 3*time.Second)
}

func TestUnknownOpFatal(t *testing.T) {
	srv, _ := newTestServer(t, nil)
	rw := dialRaw(t, srv.Addr())
	_ = rw.hello(t)
	rw.send(t, wire.Op(0x7F), nil)
	rw.expectError(t, wire.CodeUnknownOp, 3*time.Second)
}

// Idle contract: silence → PING → more silence → fatal IDLE_TIMEOUT.
func TestIdleTimeout(t *testing.T) {
	srv, _ := newTestServer(t, func(c *Config) {
		c.Idle = 150 * time.Millisecond
		c.Grace = 150 * time.Millisecond
	})
	rw := dialRaw(t, srv.Addr())
	_ = rw.hello(t)
	start := time.Now()
	rw.expectError(t, wire.CodeIdleTimeout, 5*time.Second)
	if elapsed := time.Since(start); elapsed < 200*time.Millisecond {
		t.Fatalf("idle kill arrived suspiciously early (%s)", elapsed)
	}
}

// A session that answers the yard's PINGs stays alive forever without
// publishing — the heartbeat pair works both directions.
func TestHeartbeatHolds(t *testing.T) {
	srv, cfg := newTestServer(t, func(c *Config) {
		c.Idle = 120 * time.Millisecond
		c.Grace = 120 * time.Millisecond
	})
	c := dialClient(t, srv.Addr())
	done := time.After(3 * (cfg.Idle + cfg.Grace))
	for {
		select {
		case <-done:
			if err := c.Ping(context.Background()); err != nil {
				t.Fatalf("session died under heartbeats: %v", err)
			}
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// Oversize-skip path: a body over this yard's cap but inside the protocol
// ceiling is refused non-fatally, and the NEXT message on the same session
// lands — framing survived the discard.
func TestOversizeBodySkips(t *testing.T) {
	srv, _ := newTestServer(t, func(c *Config) {
		c.MaxBody = 256
	})
	watcher := dialClient(t, srv.Addr())
	if err := watcher.Subscribe(1, "cap.>"); err != nil {
		t.Fatal(err)
	}
	pub := dialClient(t, srv.Addr())

	// Cross-session publish needs the subscription settled first (no-ack).
	settle(t, pub, "cap.settle", watcher, 1)
	drainQuiet(t, watcher, 150*time.Millisecond)

	if err := pub.Publish("cap.big", make([]byte, 4000)); err != nil {
		t.Fatalf("publish 4000B: %v", err)
	}
	if e := mustError(t, pub, 3*time.Second); e.Code != wire.CodeTooLarge {
		t.Fatalf("code 0x%02X want TOO_LARGE: %q", e.Code, e.Message)
	}

	if err := pub.Publish("cap.small", []byte("fits")); err != nil {
		t.Fatalf("follow-up publish on the SAME session: %v", err)
	}
	d := mustDelivery(t, watcher, 3*time.Second)
	if d.Subject != "cap.small" || string(d.Payload) != "fits" {
		t.Fatalf("post-skip delivery wrong: %+v", d)
	}
}

// Backpressure contract: a session that stops reading gets killed with
// SLOW_CONSUMER instead of the yard growing memory forever. What the test
// observes is the end of that connection — the fatal frame when the wire
// accepts it, the hard close otherwise. Either proves the contract.
func TestSlowConsumerKilled(t *testing.T) {
	srv, _ := newTestServer(t, func(c *Config) {
		c.OutBuf = 4
		c.Idle = 30 * time.Second // no heartbeat interference
		c.Grace = 5 * time.Second
	})
	rw := dialRaw(t, srv.Addr())
	_ = rw.hello(t)
	sb, _ := wire.EncodeSubscribe(wire.Subscribe{Pattern: "burst.>", Sid: 1})
	rw.send(t, wire.OpSubscribe, sb)

	pub := dialClient(t, srv.Addr())

	// Settle the raw subscription: a small probe must come back as DELIVER
	// before the burst starts. A publish from a different session can
	// legally beat a fresh subscribe (v1 has no ack), so retry until the
	// probe returns instead of assuming ordering.
	settled := false
	settleDeadline := time.Now().Add(3 * time.Second)
	for !settled {
		if time.Now().After(settleDeadline) {
			t.Fatal("raw subscription never settled")
		}
		_ = pub.Publish("burst.settle", []byte("settle"))
		op, body, err := rw.read(t, 1500*time.Millisecond)
		if err != nil {
			continue
		}
		if op != wire.OpDeliver {
			t.Fatalf("settle probe: got %s", op)
		}
		d, derr := wire.DecodeDeliver(body)
		if derr != nil || d.Sid != 1 || d.Subject != "burst.settle" {
			t.Fatalf("settle probe wrong: op=%v deliver=%+v err=%v", op, d, derr)
		}
		settled = true
	}

	var publishWG sync.WaitGroup
	publishWG.Add(1)
	go func() {
		defer publishWG.Done()
		for i := 0; i < 1024; i++ { // 16 MB into a socket nobody drains
			if err := pub.Publish("burst.e9", make([]byte, 16*1024)); err != nil {
				return
			}
		}
	}()
	publishWG.Wait()

	deadline := time.Now().Add(15 * time.Second)
	for {
		op, body, err := rw.read(t, time.Until(deadline))
		if err != nil {
			if eofish(err) {
				t.Log("peer closed hard — stalled reader reaped")
				return
			}
			t.Fatalf("slow consumer session did not die: %v", err)
		}
		if op == wire.OpError {
			e, derr := wire.DecodeError(body)
			if derr != nil {
				t.Fatalf("error frame: %v", derr)
			}
			if e.Code != wire.CodeSlowConsumer {
				t.Fatalf("expected SLOW_CONSUMER, got 0x%02X (%q)", e.Code, e.Message)
			}
			return
		}
	}
}

func eofish(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, net.ErrClosed) {
		return true
	}
	return err.Error() == "EOF" || err.Error() == "unexpected EOF"
}
