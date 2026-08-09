package client

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/SukrutN/switchyard/internal/wire"
)

// The fake yard speaks the stream family byte-precisely. Every test here is
// a protocol contract in miniature: if the real yard drifts from these
// frames, the test suite ring alarms, not the field.

// ackSeen records LaneAck framing the client actually sent.
type ackSeen struct {
	mu  sync.Mutex
	seq []uint64
}

func ackAdd(a *ackSeen, seq uint64) {
	a.mu.Lock()
	a.seq = append(a.seq, seq)
	a.mu.Unlock()
}

func ackCount(a *ackSeen) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.seq)
}

func TestStreamCreateRoundTrip(t *testing.T) {
	seen := int32(0)
	y := newFakeYard(t, func(y *fakeYard, op wire.Op, body []byte) {
		switch op {
		case wire.OpStreamCreate:
			if atomic.AddInt32(&seen, 1) == 1 {
				r, _ := wire.DecodeStreamCreate(body)
				rb, _ := wire.EncodeStreamReady(wire.StreamReady{Name: r.Name, Seq: 1})
				_ = y.wr.WriteFrame(wire.OpStreamReady, rb)
				return
			}
			// The same lane twice: refused, session alive.
			eb, _ := wire.EncodeError(wire.ErrorResponse{Code: wire.CodeStreamExists, Message: "lane orders already exists"})
			_ = y.wr.WriteFrame(wire.OpError, eb)
		case wire.OpPing:
			_ = y.wr.WriteFrame(wire.OpPong, nil)
		}
	})
	c := dialFake(t, y, Options{})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.StreamCreate(ctx, "orders"); err != nil {
		t.Fatalf("first create: %v", err)
	}
	err := c.StreamCreate(ctx, "orders")
	if err == nil {
		t.Fatal("duplicate create must return the refusal")
	}
	if ce, ok := err.(ClientError); !ok || ce.Code != wire.CodeStreamExists || ce.Fatal {
		t.Fatalf("refusal = %v, want non-fatal ClientError CodeStreamExists", err)
	}
	// Refusals ride Errors() as a copy for async listeners too.
	select {
	case ce := <-c.Errors():
		if ce.Code != wire.CodeStreamExists {
			t.Fatalf("Errors() copy = 0x%02X", ce.Code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("refusal never reached Errors()")
	}
	// And the session is still fully usable.
	if err := c.Ping(ctx); err != nil {
		t.Fatalf("ping after refusals: %v", err)
	}
}

func TestStreamPublishReceiptPairsInOrder(t *testing.T) {
	y := newFakeYard(t, func(y *fakeYard, op wire.Op, body []byte) {
		switch op {
		case wire.OpStreamPublish:
			p, _ := wire.DecodeStreamPublish(body)
			if p.Stream == "nope" {
				eb, _ := wire.EncodeError(wire.ErrorResponse{Code: wire.CodeStreamUnknown, Message: "no lane named nope"})
				_ = y.wr.WriteFrame(wire.OpError, eb)
				return
			}
			// Receipts follow publish order, whatever the test thinks.
			switch p.Subject {
			case "orders.a":
				rb, _ := wire.EncodeStreamReceipt(wire.StreamReceipt{Stream: "orders", Seq: 7})
				_ = y.wr.WriteFrame(wire.OpStreamReceipt, rb)
			case "orders.b":
				rb, _ := wire.EncodeStreamReceipt(wire.StreamReceipt{Stream: "orders", Seq: 8})
				_ = y.wr.WriteFrame(wire.OpStreamReceipt, rb)
			default:
				eb, _ := wire.EncodeError(wire.ErrorResponse{Code: wire.CodeStreamSubject, Message: "wrong first token"})
				_ = y.wr.WriteFrame(wire.OpError, eb)
			}
		}
	})
	c := dialFake(t, y, Options{})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	seq, err := c.StreamPublish(ctx, "orders", "orders.a", []byte("one"))
	if err != nil || seq != 7 {
		t.Fatalf("publish a: seq %d err %v", seq, err)
	}
	seq, err = c.StreamPublishReply(ctx, "orders", "orders.b", "orders.replies", []byte("two"))
	if err != nil || seq != 8 {
		t.Fatalf("publish b: seq %d err %v", seq, err)
	}
	_, err = c.StreamPublish(ctx, "nope", "nope.x", []byte("r"))
	if err == nil {
		t.Fatal("publish to unknown lane must refuse synchronously")
	}
	if ce, ok := err.(ClientError); !ok || ce.Code != wire.CodeStreamUnknown {
		t.Fatalf("refusal = %v, want ClientError CodeStreamUnknown", err)
	}
}

func TestStreamPublishStaleReplyDiesWithSlot(t *testing.T) {
	answered := int32(0)
	y := newFakeYard(t, func(y *fakeYard, op wire.Op, body []byte) {
		if op == wire.OpStreamPublish && atomic.AddInt32(&answered, 1) > 1 {
			// The first publish gets silence; from the second on, the yard
			// answers on schedule.
			p, _ := wire.DecodeStreamPublish(body)
			rb, _ := wire.EncodeStreamReceipt(wire.StreamReceipt{Stream: p.Stream, Seq: 99})
			_ = y.wr.WriteFrame(wire.OpStreamReceipt, rb)
		}
	})
	c := dialFake(t, y, Options{})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	deadCtx, deadCancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer deadCancel()
	if _, err := c.StreamPublish(deadCtx, "orders", "orders.a", []byte("silent")); err == nil {
		t.Fatal("unanswered publish must fail by its own deadline")
	}
	seq, err := c.StreamPublish(ctx, "orders", "orders.a", []byte("answered"))
	if err != nil || seq != 99 {
		t.Fatalf("following publish: seq %d err %v (a stale receipt must not pair here)", seq, err)
	}
}

func TestStreamRPCTakeTurns(t *testing.T) {
	var mu sync.Mutex
	seq := uint64(0)
	y := newFakeYard(t, func(y *fakeYard, op wire.Op, body []byte) {
		switch op {
		case wire.OpStreamCreate:
			mu.Lock()
			seq++
			mu.Unlock()
			rb, _ := wire.EncodeStreamReady(wire.StreamReady{Name: "orders", Seq: 1})
			_ = y.wr.WriteFrame(wire.OpStreamReady, rb)
		case wire.OpStreamPublish:
			mu.Lock()
			seq++
			s := seq
			mu.Unlock()
			rb, _ := wire.EncodeStreamReceipt(wire.StreamReceipt{Stream: "orders", Seq: s})
			_ = y.wr.WriteFrame(wire.OpStreamReceipt, rb)
		}
	})
	c := dialFake(t, y, Options{})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	errs := make([]error, 2)
	wg.Add(2)
	go func() { defer wg.Done(); errs[0] = c.StreamCreate(ctx, "orders") }()
	go func() { defer wg.Done(); _, errs[1] = c.StreamPublish(ctx, "orders", "orders.a", []byte("m")) }()
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent round-trip %d failed: %v (the mutex must serialize them)", i, err)
		}
	}
}

func TestStreamAttachReplaysAndAcks(t *testing.T) {
	acks := &ackSeen{}
	var attached atomic.Int32
	y := newFakeYard(t, func(y *fakeYard, op wire.Op, body []byte) {
		switch op {
		case wire.OpConsumerAttach:
			a, _ := wire.DecodeConsumerAttach(body)
			if a.Sid == 0 {
				t.Error("attach carried the reserved sid")
				return
			}
			if attached.Add(1) > 1 {
				t.Errorf("test attached twice: %+v", a)
			}
			rb, _ := wire.EncodeConsumerReady(wire.ConsumerReady{Stream: "orders", Consumer: a.Consumer, Sid: a.Sid, Next: 4, AckWaitMillis: 1234})
			_ = y.wr.WriteFrame(wire.OpConsumerReady, rb)
			// The yard leans on the consumer immediately: two ranked-up
			// deliveries to prove lane order arrives lane-ordered. Another
			// follows, out of order, to prove a redelivery is not confused
			// with fresh work.
			db, _ := wire.EncodeStreamDeliver(wire.StreamDeliver{Subject: "orders.a", Sid: a.Sid, Seq: 4, Payload: []byte("fourth")})
			_ = y.wr.WriteFrame(wire.OpStreamDeliver, db)
			db, _ = wire.EncodeStreamDeliver(wire.StreamDeliver{Subject: "orders.b", Sid: a.Sid, Seq: 5, Payload: []byte("fifth")})
			_ = y.wr.WriteFrame(wire.OpStreamDeliver, db)
		case wire.OpAck:
			a, _ := wire.DecodeAck(body)
			ackAdd(acks, a.Seq)
		}
	})
	c := dialFake(t, y, Options{Name: "probe"})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	next, wait, err := c.StreamAttach(ctx, "orders", "billing", 7, 0, "")
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	if next != 4 || wait != 1234*time.Millisecond {
		t.Fatalf("ready (next=%d wait=%s), want next=4 wait=1.234s", next, wait)
	}
	for i, want := range []uint64{4, 5} {
		select {
		case d := <-c.LaneDeliveries():
			if d.Seq != want || d.Sid != 7 || d.Subject != wireSubject(want) || string(d.Payload) != wirePayload(want) {
				t.Fatalf("delivery %d = %+v", i, d)
			}
			if err := c.LaneAck(7, d.Seq); err != nil {
				t.Fatalf("lane ack: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("lane delivery %d never arrived", i)
		}
	}
	deadline := time.Now().Add(2 * time.Second)
	for ackCount(acks) < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("only %d acks framed; want 2", ackCount(acks))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func wireSubject(seq uint64) string {
	if seq == 4 {
		return "orders.a"
	}
	return "orders.b"
}

func wirePayload(seq uint64) string {
	if seq == 4 {
		return "fourth"
	}
	return "fifth"
}

func TestStreamLaneDroppedCounts(t *testing.T) {
	y := newFakeYard(t, func(y *fakeYard, op wire.Op, body []byte) {
		switch op {
		case wire.OpConsumerAttach:
			a, _ := wire.DecodeConsumerAttach(body)
			rb, _ := wire.EncodeConsumerReady(wire.ConsumerReady{Stream: "orders", Consumer: "billing", Sid: a.Sid, Next: 1, AckWaitMillis: 90})
			_ = y.wr.WriteFrame(wire.OpConsumerReady, rb)
			for i := uint64(1); i <= 4; i++ {
				db, _ := wire.EncodeStreamDeliver(wire.StreamDeliver{Subject: "o.a", Sid: a.Sid, Seq: i, Payload: []byte("x")})
				_ = y.wr.WriteFrame(wire.OpStreamDeliver, db)
			}
		}
	})
	// One slot in the lane channel: four deliveries arrive back to back,
	// the first takes the slot, the next three are counted honestly as
	// dropped. Nothing is consumed during the burst, so the arithmetic is
	// not scheduling-sensitive.
	c := dialFake(t, y, Options{LaneBuf: 1})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := c.StreamAttach(ctx, "orders", "billing", 7, 0, ""); err != nil {
		t.Fatalf("attach: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if d := c.LaneDropped(); d != 3 {
		t.Fatalf("dropped = %d, want 3 (four frames, one slot)", d)
	}
	d := <-c.LaneDeliveries()
	if d.Seq != 1 {
		t.Fatalf("the delivery that kept its slot is seq %d, want 1", d.Seq)
	}
	select {
	case extra := <-c.LaneDeliveries():
		t.Fatalf("four frames with one slot but a fifth arrived: %+v", extra)
	default:
	}
}

func TestStreamDeleteEchoTrapAndForeignNotices(t *testing.T) {
	y := newFakeYard(t, func(y *fakeYard, op wire.Op, body []byte) {
		switch op {
		case wire.OpStreamDelete:
			r, _ := wire.DecodeStreamDelete(body)
			// The confirm lands right away; one GONE per session is the
			// wire rule (§2.17), so this deletion ends with exactly one.
			gb, _ := wire.EncodeStreamGone(wire.StreamGone{Name: r.Name})
			_ = y.wr.WriteFrame(wire.OpStreamGone, gb)
			// And, a beat later, a lane this session never touched: the
			// async-consumer path.
			fb, _ := wire.EncodeStreamGone(wire.StreamGone{Name: "foreign"})
			_ = y.wr.WriteFrame(wire.OpStreamGone, fb)
		}
	})
	c := dialFake(t, y, Options{})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.StreamDelete(ctx, "mine"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	// Own deletion never surfaces on notices — the confirm fed the RPC.
	// The foreign lane's goodbye does: async consumers listen here.
	select {
	case n := <-c.StreamNotices():
		if n.Stream != "foreign" {
			t.Fatalf("first notice = %+v, want the foreign lane", n)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("foreign lane's goodbye never surfaced")
	}
	select {
	case n := <-c.StreamNotices():
		t.Fatalf("a second notice arrived: %+v", n)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestStreamAttachRefusalReturnsSynchronously(t *testing.T) {
	y := newFakeYard(t, func(y *fakeYard, op wire.Op, body []byte) {
		if op == wire.OpConsumerAttach {
			eb, _ := wire.EncodeError(wire.ErrorResponse{Code: wire.CodeDupConsumer, Message: "consumer billing is live elsewhere"})
			_ = y.wr.WriteFrame(wire.OpError, eb)
		}
	})
	c := dialFake(t, y, Options{})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _, err := c.StreamAttach(ctx, "orders", "billing", 3, 0, "")
	if ce, ok := err.(ClientError); !ok || ce.Code != wire.CodeDupConsumer {
		t.Fatalf("attach refusal = %v, want ClientError CodeDupConsumer", err)
	}
}
