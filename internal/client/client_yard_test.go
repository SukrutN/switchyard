package client

import (
	"context"
	"testing"
	"time"

	"github.com/SukrutN/switchyard/internal/wire"
)

// The fake yard speaks the console family byte-precisely. The tests below
// are the print's contract in miniature: summary reads lane rows ascending,
// drill-downs carry every row the yard has, and refusals surface as Go
// errors under the same turn-taking discipline as every other RPC.

func TestYardConsoleRoundTrips(t *testing.T) {
	y := newFakeYard(t, func(y *fakeYard, op wire.Op, body []byte) {
		switch op {
		case wire.OpYardInfo:
			st, _ := wire.EncodeYardState(wire.YardState{
				Version:   "0.4.0",
				UptimeSec: 77,
				Sessions:  2,
				Lanes: []wire.YardLane{
					{Name: "orders", Seq: 7},
					{Name: "store", Seq: 0},
				},
				Quarantined: []string{"broken"},
			})
			_ = y.wr.WriteFrame(wire.OpYardState, st)
		case wire.OpLaneInfo:
			lb, _ := wire.EncodeLaneState(wire.LaneState{
				Lane:         "orders",
				Seq:          7,
				JournalBytes: 4096,
				KeyCount:     3,
				Consumers: []wire.LaneConsumer{
					{Name: "audit", Floor: 5, Pending: 0, Attached: true},
					{Name: "cold", Floor: 0, Pending: 0, Attached: false},
				},
			})
			_ = y.wr.WriteFrame(wire.OpLaneState, lb)
		}
	})
	c := dialFake(t, y, Options{})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	got, err := c.YardInfo(ctx)
	if err != nil {
		t.Fatalf("yard info: %v", err)
	}
	if got.Version != "0.4.0" || got.UptimeSec != 77 || got.Sessions != 2 || len(got.Lanes) != 2 || got.Quarantined == nil {
		t.Fatalf("yard summary = %+v, want the fake's speech verbatim", got)
	}
	if got.Lanes[0].Name != "orders" || got.Lanes[0].Seq != 7 || got.Lanes[1].Name != "store" || got.Lanes[1].Seq != 0 {
		t.Fatalf("lane table %+v, want [orders 7, store 0]", got.Lanes)
	}
	if got.Quarantined[0] != "broken" {
		t.Fatalf("quarantined %q, want the failing lane named in full", got.Quarantined)
	}

	l, err := c.LaneInfo(ctx, "orders")
	if err != nil {
		t.Fatalf("lane info: %v", err)
	}
	if l.Lane != "orders" || l.Seq != 7 || l.Quarantined || l.JournalBytes != 4096 || l.KeyCount != 3 {
		t.Fatalf("lane detail = %+v, want the fake's row verbatim", l)
	}
	if len(l.Consumers) != 2 {
		t.Fatalf("consumers %+v, want both rows", l.Consumers)
	}
	first := l.Consumers[0]
	if first.Name != "audit" || first.Floor != 5 || first.Pending != 0 || !first.Attached {
		t.Fatalf("attached row %+v, want audit floor 5 attached", first)
	}
	second := l.Consumers[1]
	if second.Name != "cold" || second.Attached {
		t.Fatalf("parked row %+v, want cold detached", second)
	}
}

func TestYardConsoleRefusalsReturnSynchronously(t *testing.T) {
	y := newFakeYard(t, func(y *fakeYard, op wire.Op, body []byte) {
		if op == wire.OpLaneInfo {
			eb, _ := wire.EncodeError(wire.ErrorResponse{Code: wire.CodeStreamUnknown, Message: "no lane named nosuch"})
			_ = y.wr.WriteFrame(wire.OpError, eb)
		}
	})
	c := dialFake(t, y, Options{})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := c.LaneInfo(ctx, "nosuch")
	if ce, ok := err.(ClientError); !ok || ce.Code != wire.CodeStreamUnknown {
		t.Fatalf("lane info refusal = %v, want ClientError CodeStreamUnknown", err)
	}
}
