package client

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/SukrutN/switchyard/internal/wire"
)

// The fake yard is a scripted peer with exactly one job: exercise the
// client against byte-precise behavior the real server may someday drift
// away from. Test edits here are protocol contract edits.
type fakeYard struct {
	t    *testing.T
	addr string
	wr   *wire.Writer
}

// newFakeYard runs a loopback listener; onOp runs per frame after the
// HELLO/WELCOME handshake completes.
func newFakeYard(t *testing.T, onOp func(y *fakeYard, op wire.Op, body []byte)) *fakeYard {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("fake yard: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	y := &fakeYard{t: t, addr: ln.Addr().String()}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go y.serve(conn, onOp)
		}
	}()
	return y
}

func (y *fakeYard) serve(conn net.Conn, onOp func(y *fakeYard, op wire.Op, body []byte)) {
	defer conn.Close()
	y.wr = wire.NewWriter(conn)
	rd := wire.NewReader(conn, wire.MaxBodyBytes)

	_ = conn.SetDeadline(time.Now().Add(5 * time.Second)) // handshake budget
	op, _, err := rd.ReadFrame()
	if err != nil || op != wire.OpHello {
		return
	}
	wb, _ := wire.EncodeWelcome(wire.Welcome{ServerLabel: "fake/1", MaxBody: 4096})
	if err := y.wr.WriteFrame(wire.OpWelcome, wb); err != nil {
		return
	}
	if onOp == nil {
		return
	}
	for {
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		op, body, err := rd.ReadFrame()
		if err != nil {
			return
		}
		onOp(y, op, body)
	}
}

func dialFake(t *testing.T, y *fakeYard, o Options) *Client {
	t.Helper()
	c, err := Dial(context.Background(), y.addr, o)
	if err != nil {
		t.Fatalf("dial fake: %v", err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func TestHandshake(t *testing.T) {
	y := newFakeYard(t, nil)
	c := dialFake(t, y, Options{Name: "probe", Label: "test"})
	w := c.Welcome()
	if w.ServerLabel != "fake/1" || w.MaxBody != 4096 {
		t.Fatalf("welcome mismatch: %+v", w)
	}
}

func TestPingRoundTrip(t *testing.T) {
	y := newFakeYard(t, func(y *fakeYard, op wire.Op, body []byte) {
		if op == wire.OpPing {
			_ = y.wr.WriteFrame(wire.OpPong, nil)
		}
	})
	c := dialFake(t, y, Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	start := time.Now()
	if err := c.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("ping took %s", time.Since(start))
	}
}

func TestDeliverFlowOrdered(t *testing.T) {
	y := newFakeYard(t, func(y *fakeYard, op wire.Op, body []byte) {
		if op != wire.OpSubscribe {
			return
		}
		s, err := wire.DecodeSubscribe(body)
		if err != nil {
			t.Fatal(err)
		}
		for i := 1; i <= 3; i++ {
			db, err := wire.EncodeDeliver(wire.Deliver{
				Subject: "fake.e", Sid: s.Sid, Seq: uint32(i), Payload: []byte("n"),
			})
			if err != nil {
				t.Fatal(err)
			}
			_ = y.wr.WriteFrame(wire.OpDeliver, db)
		}
	})
	c := dialFake(t, y, Options{DeliverBuf: 8})
	if err := c.Subscribe(7, "fake.>"); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 3; i++ {
		select {
		case d := <-c.Deliveries():
			if d.Sid != 7 || d.Seq != uint32(i) {
				t.Fatalf("delivery %d wrong: %+v", i, d)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("delivery %d missed", i)
		}
	}
}

func TestByeIsSymmetric(t *testing.T) {
	byeSeen := make(chan struct{}, 1)
	y := newFakeYard(t, func(y *fakeYard, op wire.Op, body []byte) {
		if op == wire.OpBye {
			select {
			case byeSeen <- struct{}{}:
			default:
			}
			_ = y.wr.WriteFrame(wire.OpBye, nil)
		}
	})
	c := dialFake(t, y, Options{})
	select {
	case <-c.Done():
		t.Fatal("client ended before BYE was sent")
	case <-time.After(50 * time.Millisecond):
	}
	if err := c.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	select {
	case <-byeSeen:
	case <-time.After(2 * time.Second):
		t.Fatal("BYE never reached the fake yard")
	}
	select {
	case <-c.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("client should be done after the BYE exchange")
	}
}

func TestFatalErrorEndsSession(t *testing.T) {
	y := newFakeYard(t, func(y *fakeYard, op wire.Op, body []byte) {
		if op == wire.OpSubscribe {
			eb, _ := wire.EncodeError(wire.ErrorResponse{
				Code: wire.CodeSlowConsumer, Message: "fake slowdown", Fatal: true,
			})
			_ = y.wr.WriteFrame(wire.OpError, eb)
		}
	})
	c := dialFake(t, y, Options{})
	if err := c.Subscribe(1, "a.>"); err != nil {
		t.Fatal(err)
	}
	select {
	case e := <-c.Errors():
		if !e.Fatal || e.Code != wire.CodeSlowConsumer {
			t.Fatalf("error misreported: %+v", e)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no fatal error surfaced")
	}
	select {
	case <-c.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("session did not end on fatal error")
	}
}
