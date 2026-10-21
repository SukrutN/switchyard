package server

import (
	"net"
	"testing"
	"time"

	"github.com/SukrutN/switchyard/internal/subjects"
)

// hub test sessions are real sessions over dead pipes: serve() never runs,
// so the only live machinery is the deliver() channel — which is exactly
// what the hub touches.
func testSession(t *testing.T, hub *Hub, name string) *session {
	t.Helper()
	conn, other := net.Pipe()
	t.Cleanup(func() { conn.Close(); other.Close() })
	cfg := &Config{OutBuf: 64, Idle: time.Minute, Grace: time.Minute, Log: logDiscard()}
	s := newSession(hub.nextID(), cfg, hub, logDiscard(), conn)
	hub.register(s)
	return s
}

func drain(t *testing.T, s *session) <-chan deliverTask {
	t.Helper()
	ch := make(chan deliverTask, 256)
	go func() {
		for task := range s.out {
			select {
			case ch <- task:
			default:
			}
		}
	}()
	return ch
}

func pub(t *testing.T, hub *Hub, subject string, payload []byte) int {
	t.Helper()
	s, err := subjects.Parse(subject)
	if err != nil {
		t.Fatalf("publish subject %q: %v", subject, err)
	}
	return hub.publish(s, payload, "", false)
}

func TestHubSubscribeCodes(t *testing.T) {
	hub := newHub()
	s := testSession(t, hub, "a")

	if code, err := hub.subscribe(s, 0, "orders.>"); err == nil || code == 0 {
		t.Fatalf("sid 0 must refuse, got code %d err %v", code, err)
	}
	if code, err := hub.subscribe(s, 7, "orders..paid"); code != 0x03 {
		t.Fatalf("charter violation must map CodeBadSubject(3), got %d err %v", code, err)
	}
	if _, err := hub.subscribe(s, 7, "orders.>"); err != nil {
		t.Fatalf("first sub: %v", err)
	}
	if code, err := hub.subscribe(s, 7, "other.>"); code != 0x04 {
		t.Fatalf("same sid reuse must map CodeDupSub(4), got %d err %v", code, err)
	}
	// Same pattern, different sid, same session: two subscriptions is legal.
	if code, err := hub.subscribe(s, 8, "orders.>"); code != 0 || err != nil {
		t.Fatalf("second sid on same pattern: code %d err %v", code, err)
	}
	// SAME sid on a DIFFERENT session: legal, independent.
	s2 := testSession(t, hub, "b")
	if code, err := hub.subscribe(s2, 7, "orders.>"); code != 0 || err != nil {
		t.Fatalf("sid reuse across sessions must be legal: code %d err %v", code, err)
	}
}

func TestHubPublishFanOut(t *testing.T) {
	hub := newHub()
	a := testSession(t, hub, "a") // greater
	b := testSession(t, hub, "b") // star mid
	c := testSession(t, hub, "c") // literal

	da := drain(t, a)
	db := drain(t, b)
	dc := drain(t, c)

	_, e1 := hub.subscribe(a, 1, "orders.>")
	_, e2 := hub.subscribe(b, 2, "orders.*.paid")
	_, e3 := hub.subscribe(c, 3, "orders.e9.paid")
	if e1 != nil || e2 != nil || e3 != nil {
		t.Fatalf("subscribe setup: %v %v %v", e1, e2, e3)
	}

	if n := pub(t, hub, "orders.e9.paid", []byte("hello")); n != 3 {
		t.Fatalf("deliveries = %d, want 3", n)
	}
	if got := (<-da).sid; got != 1 {
		t.Fatalf("a got sid %d", got)
	}
	if got := (<-db).sid; got != 2 {
		t.Fatalf("b got sid %d", got)
	}
	if got := (<-dc).sid; got != 3 {
		t.Fatalf("c got sid %d", got)
	}

	// "orders.e9" hits only the greater.
	if n := pub(t, hub, "orders.e9", []byte("x")); n != 1 {
		t.Fatalf("shorter subject deliveries = %d, want 1", n)
	}
	<-da
	// unrelated token fails all
	if n := pub(t, hub, "freight.e9.paid", []byte("x")); n != 0 {
		t.Fatalf("unrelated deliveries = %d, want 0", n)
	}
	select {
	case got := <-da:
		t.Fatalf("unmatched deliver leaked: %+v", got)
	case <-time.After(50 * time.Millisecond):
	}
}

// The charter's '>' needs ≥1 trailing token: explicit boundary coverage at
// hub level, because this is the case the trie walk got wrong first draft.
func TestHubGreaterNeedsOneToken(t *testing.T) {
	hub := newHub()
	a := testSession(t, hub, "a")
	da := drain(t, a)
	if _, err := hub.subscribe(a, 1, "orders.paid.>"); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	if n := pub(t, hub, "orders.paid", []byte("x")); n != 0 {
		t.Fatalf("bare prefix matched; deliveries %d want 0", n)
	}
	select {
	case got := <-da:
		t.Fatalf("bare prefix leaked: %+v", got)
	case <-time.After(50 * time.Millisecond):
	}

	if n := pub(t, hub, "orders.paid.e9", []byte("x")); n != 1 {
		t.Fatalf("one trailing token did not match; n=%d", n)
	}
}

func TestHubUnsubscribe(t *testing.T) {
	hub := newHub()
	a := testSession(t, hub, "a")
	if _, err := hub.subscribe(a, 5, "orders.>"); err != nil {
		t.Fatalf("sub: %v", err)
	}
	if code, err := hub.unsubscribe(a, 9); code != 0x05 || err == nil {
		t.Fatalf("unknown sid must map CodeNoSub(5), got %d %v", code, err)
	}
	if code, err := hub.unsubscribe(a, 5); code != 0 || err != nil {
		t.Fatalf("live unsub failed: %d %v", code, err)
	}
	if n := pub(t, hub, "orders.e9", nil); n != 0 {
		t.Fatalf("deliveries after unsub = %d, want 0", n)
	}
	// Resubscribe the freed sid works — the charter's resubscribe contract.
	if code, err := hub.subscribe(a, 5, "orders.>"); code != 0 || err != nil {
		t.Fatalf("resubscribe after unsub: %d %v", code, err)
	}
}

func TestHubSessionTeardown(t *testing.T) {
	hub := newHub()
	a := testSession(t, hub, "a")
	b := testSession(t, hub, "b")
	if _, err := hub.subscribe(a, 1, "orders.>"); err != nil {
		t.Fatal(err)
	}
	if _, err := hub.subscribe(a, 2, "orders.*.paid"); err != nil {
		t.Fatal(err)
	}
	if _, err := hub.subscribe(b, 3, "orders.>"); err != nil {
		t.Fatal(err)
	}

	hub.unregister(a.id)
	if n := pub(t, hub, "orders.e9.paid", nil); n != 1 {
		t.Fatalf("after teardown deliveries %d, want 1 (only b)", n)
	}
	if owner := a.sidOwner(1); owner != "" {
		t.Fatalf("session still remembers sid %d as %q", 1, owner)
	}
}

// Pruning is a memory-bound guarantee: removed subscriptions must not leave
// forests of dead nodes behind. Proof: re-walking the removed pattern (no
// create) must find nothing.
func TestHubPrunesDeadBranches(t *testing.T) {
	hub := newHub()
	a := testSession(t, hub, "a")
	if _, err := hub.subscribe(a, 1, "deep.path.to.nowhere.>"); err != nil {
		t.Fatal(err)
	}
	if code, err := hub.unsubscribe(a, 1); code != 0 {
		t.Fatalf("unsub: %d %v", code, err)
	}
	if leaf, _, _ := hub.walk([]string{"deep", "path", "to", "nowhere", ">"}, false); leaf != nil {
		t.Fatal("prune left a dead branch behind")
	}
	// Non-empty ancestors of LIVE branches stay — pruning must stop at them.
	if _, err := hub.subscribe(a, 2, "deep.path.live"); err != nil {
		t.Fatal(err)
	}
	if code, err := hub.unsubscribe(a, 2); code != 0 {
		t.Fatal(err)
	}
	if leaf, _, _ := hub.walk([]string{"deep"}, false); leaf != nil {
		t.Fatal("whole subtree should be pruned")
	}
}
