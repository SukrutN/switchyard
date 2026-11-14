package linehost

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/SukrutN/switchyard/internal/client"
	"github.com/SukrutN/switchyard/internal/server"
	"github.com/SukrutN/switchyard/internal/wire"
)

// The talker is exercised against a real yard (durable lanes, receipts,
// the whole wire) and the fake line — the part under test is the bridge,
// not the broker's internals or the floor's law, which live elsewhere.

func yardServer(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	cfg := &server.Config{
		Addr:    "127.0.0.1:0",
		DataDir: dir,
		Idle:    500 * time.Millisecond,
		Grace:   300 * time.Millisecond,
		Log:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	srv, err := server.NewServer(*cfg)
	if err != nil {
		t.Fatalf("yard: %v", err)
	}
	t.Cleanup(srv.Stop)
	go srv.Run()
	return srv.Addr()
}

func dialYard(t *testing.T, ctx context.Context, addr, name string) *client.Client {
	t.Helper()
	c, err := client.Dial(ctx, addr, client.Options{Name: name, Label: "test"})
	if err != nil {
		t.Fatalf("dial %s: %v", name, err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// startTalker runs a talker against a yard and a fake line until ctx ends.
func startTalker(t *testing.T, ctx context.Context, yardAddr, lineAddr string, mutate func(*Config)) *Talker {
	t.Helper()
	cfg := Config{
		LineAddr: lineAddr,
		HBEvery:  20 * time.Millisecond,
		Patience: 5 * time.Second,
		Log:      discard(),
	}
	if mutate != nil {
		mutate(&cfg)
	}
	tk := New(cfg, dialYard(t, ctx, yardAddr, "talker"))
	go func() { _ = tk.Run(ctx) }()
	return tk
}

// publishWork pushes one work item on the lane, creating it first — the
// same order an upstream scheduler would.
func publishWork(t *testing.T, ctx context.Context, yard *client.Client, lane, subject string, payload []byte) uint64 {
	t.Helper()
	if err := yard.StreamCreate(ctx, lane); err != nil {
		if ce, ok := err.(client.ClientError); !ok || ce.Code != wire.CodeStreamExists {
			t.Fatalf("create lane: %v", err)
		}
	}
	seq, err := yard.StreamPublish(ctx, lane, subject, payload)
	if err != nil {
		t.Fatalf("publish work: %v", err)
	}
	return seq
}

// watchVerdicts attaches a durable consumer filtered to the verdict
// subject and hands back everything it replays or receives.
func watchVerdicts(t *testing.T, ctx context.Context, yardAddr, lane, filter string) chan Verdict {
	t.Helper()
	c := dialYard(t, ctx, yardAddr, "watcher")
	out := make(chan Verdict, 16)
	sid := uint32(9)
	if _, _, err := c.StreamAttach(ctx, lane, "watcher", sid, 0, filter); err != nil {
		t.Fatalf("watcher attach: %v", err)
	}
	go func() {
		for d := range c.LaneDeliveries() {
			var v Verdict
			if err := json.Unmarshal(d.Payload, &v); err == nil {
				out <- v
			}
		}
	}()
	return out
}

func waitVerdict(t *testing.T, ch chan Verdict, within time.Duration, want string) Verdict {
	t.Helper()
	select {
	case v := <-ch:
		if v.State != want {
			t.Fatalf("verdict state %q, want %q (full: %+v)", v.State, want, v)
		}
		return v
	case <-time.After(within):
		t.Fatalf("no %q verdict within %s", want, within)
		return Verdict{}
	}
}

// waitForFloor polls the lane until the linehost consumer has settled
// everything: the ack is fire-and-forget on the wire, so the floor moves
// a beat behind the receipt.
func waitForFloor(t *testing.T, ctx context.Context, pub *client.Client, lane string, floor uint64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		st, err := pub.LaneInfo(ctx, lane)
		if err == nil {
			for _, c := range st.Consumers {
				if c.Name == "linehost" {
					if c.Floor >= floor && c.Pending == 0 {
						return
					}
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	st, err := pub.LaneInfo(ctx, lane)
	if err != nil {
		t.Fatalf("lane info: %v", err)
	}
	for _, c := range st.Consumers {
		if c.Name == "linehost" {
			t.Fatalf("linehost consumer floor %d pending %d, want floor >= %d and pending 0", c.Floor, c.Pending, floor)
		}
	}
	t.Fatalf("linehost consumer not attached")
}

func TestWorkBecomesCommandBecomesReceipt(t *testing.T) {
	yardAddr := yardServer(t)
	fl := startFakeLine(t)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	pub := dialYard(t, ctx, yardAddr, "pub")
	// The work item exists BEFORE the talker starts: attach must replay it.
	work := Work{ID: "box-42", Gate: 2, Class: 0}
	body, _ := json.Marshal(work)
	publishWork(t, ctx, pub, "fluxline", "fluxline.release", body)

	startTalker(t, ctx, yardAddr, fl.addr, nil)
	verdicts := watchVerdicts(t, ctx, yardAddr, "fluxline", "fluxline.verdict")

	// The floor is asked exactly what the work item said, in one frame.
	w := fl.waitForCommand(t, 5*time.Second, 1)
	if w.addr != RegHBHost {
		t.Fatalf("command at addr %d, want %d", w.addr, RegHBHost)
	}
	hb, code, gate, class := w.vals[0], w.vals[2], w.vals[3], w.vals[4]
	if hb == 0 {
		t.Fatalf("hb=%d, want a fresh heartbeat in the command frame", hb)
	}
	if code != CodeOverride || gate != 2 || class != 0 {
		t.Fatalf("code=%d gate=%d class=%d, want 1/2/0", code, gate, class)
	}

	// The floor says yes: accepted, gate 2, class 2.
	fl.setAck(1, 1, 2, 2)
	v := waitVerdict(t, verdicts, 5*time.Second, "accepted")
	if v.ID != "box-42" || v.Seq != 1 || v.Gate != 2 || v.Class != 2 {
		t.Fatalf("receipt = %+v, want the accepted release", v)
	}
	if v.LatencyMS < 0 {
		t.Fatalf("latency %d, want >= 0", v.LatencyMS)
	}

	// And the work item is settled on the lane (the ack is fire-and-forget,
	// so poll the floor rather than race it).
	waitForFloor(t, ctx, pub, "fluxline", 2)

	// A second item, live this time. The floor vetoes: the piece the law
	// measures is class 3, the host asked for gate 1.
	work2 := Work{ID: "box-43", Gate: 1, Class: 0}
	body2, _ := json.Marshal(work2)
	publishWork(t, ctx, pub, "fluxline", "fluxline.release", body2)
	w2 := fl.waitForCommand(t, 5*time.Second, 2)
	if w2.vals[2] != CodeOverride || w2.vals[3] != 1 {
		t.Fatalf("second command = %v, want code 1 gate 1", w2.vals)
	}
	fl.setAck(2, 2, 3, 3)
	v2 := waitVerdict(t, verdicts, 5*time.Second, "vetoed")
	if v2.ID != "box-43" || v2.Gate != 3 || v2.Class != 3 {
		t.Fatalf("receipt = %+v, want the veto with the law's gate", v2)
	}
}

func TestPendingExpiresWithoutAnAck(t *testing.T) {
	yardAddr := yardServer(t)
	fl := startFakeLine(t)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	pub := dialYard(t, ctx, yardAddr, "pub")
	body, _ := json.Marshal(Work{ID: "box-44", Law: true})
	publishWork(t, ctx, pub, "fluxline", "fluxline.release", body)

	startTalker(t, ctx, yardAddr, fl.addr, func(c *Config) { c.Patience = 300 * time.Millisecond })
	verdicts := watchVerdicts(t, ctx, yardAddr, "fluxline", "fluxline.verdict")

	// The floor never answers. The host says so honestly: expired.
	w := fl.waitForCommand(t, 5*time.Second, 1)
	if w.vals[2] != CodePerLaw {
		t.Fatalf("code %d, want release-per-law", w.vals[2])
	}
	v := waitVerdict(t, verdicts, 5*time.Second, "expired")
	if v.ID != "box-44" || v.Gate != 0 || v.Class != 0 {
		t.Fatalf("receipt = %+v, want an expired receipt with no gate", v)
	}
}

func TestGarbageIsAckedAndSurvived(t *testing.T) {
	yardAddr := yardServer(t)
	fl := startFakeLine(t)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	pub := dialYard(t, ctx, yardAddr, "pub")
	publishWork(t, ctx, pub, "fluxline", "fluxline.release", []byte("not json at all"))

	startTalker(t, ctx, yardAddr, fl.addr, nil)
	verdicts := watchVerdicts(t, ctx, yardAddr, "fluxline", "fluxline.verdict")

	// The unreadable item is acked, not queued; the host lives on and the
	// next honest item still reaches the floor.
	body, _ := json.Marshal(Work{ID: "box-45", Gate: 4, Class: 0})
	publishWork(t, ctx, pub, "fluxline", "fluxline.release", body)
	w := fl.waitForCommand(t, 5*time.Second, 1)
	if w.vals[3] != 4 {
		t.Fatalf("gate %d, want 4", w.vals[3])
	}
	fl.setAck(1, 3, 0, 0) // refused at the floor - a verdict all the same
	v := waitVerdict(t, verdicts, 5*time.Second, "refused")
	if v.ID != "box-45" {
		t.Fatalf("receipt = %+v, want the refused release", v)
	}

	// Both lane rows are settled: floor past the garbage row too.
	waitForFloor(t, ctx, pub, "fluxline", 3)
}

func TestRedeliveryIsNotRequeued(t *testing.T) {
	tk := New(Config{Log: discard()}, nil)
	d := client.LaneDelivery{Sid: 7, Seq: 4, Payload: []byte(`{"id":"a","gate":2}`)}
	tk.onDelivery(d)
	tk.onDelivery(d) // the sweeper's replay of unacked work
	if len(tk.queue) != 1 {
		t.Fatalf("queue = %d items, want 1 (redelivery recognized)", len(tk.queue))
	}
	if len(tk.seen) != 1 {
		t.Fatalf("seen = %d, want 1", len(tk.seen))
	}
}
