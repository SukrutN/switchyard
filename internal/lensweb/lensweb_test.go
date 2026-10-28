package lensweb

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/SukrutN/switchyard/internal/client"
)

// fakeProber answers with a small honest yard.
type fakeProber struct {
	yard  client.YardState
	lanes map[string]client.LaneState
	keys  map[string][]string
	value map[string]client.KVValue
}

func (f *fakeProber) YardInfo(context.Context) (client.YardState, error) {
	return f.yard, nil
}

func (f *fakeProber) LaneInfo(_ context.Context, lane string) (client.LaneState, error) {
	ls, ok := f.lanes[lane]
	if !ok {
		return client.LaneState{}, &client.ClientError{Code: 'S', Message: "no such stream: " + lane}
	}
	return ls, nil
}

func (f *fakeProber) KVKeys(_ context.Context, lane string) ([]string, error) {
	ks, ok := f.keys[lane]
	if !ok {
		return nil, &client.ClientError{Code: 'S', Message: "no such stream: " + lane}
	}
	return ks, nil
}

func (f *fakeProber) KVGet(_ context.Context, _, key string) (client.KVValue, error) {
	v, ok := f.value[key]
	if !ok {
		return client.KVValue{Found: false}, nil
	}
	return v, nil
}

func (f *fakeProber) Close() error { return nil }

// fakeOpener hands the same fake every time.
func fakeOpener(f *fakeProber) Opener {
	return func(context.Context) (Prober, error) { return f, nil }
}

// darkOpener refuses every dial: the yard is dark.
func darkOpener(err error) Opener {
	return func(context.Context) (Prober, error) { return nil, err }
}

const testBudget = 500 * time.Millisecond

func consoleFor(t *testing.T, opener Opener) *httptest.Server {
	t.Helper()
	return httptest.NewServer(New(opener, Meta{
		Target: "127.0.0.1:4780", TLS: true,
	}, testBudget, nil))
}

func get(t *testing.T, srv *httptest.Server, path string) (int, string) {
	t.Helper()
	res, err := srv.Client().Get(srv.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("GET %s: read: %v", path, err)
	}
	return res.StatusCode, string(raw)
}

func smallYard() *fakeProber {
	return &fakeProber{
		yard: client.YardState{
			Version:     "1.0.0",
			UptimeSec:   4371,
			Sessions:    3,
			Lanes:       []client.LaneSeq{{Name: "orders", Seq: 9001}, {Name: "quiet", Seq: 0}},
			Quarantined: []string{"bitten"},
		},
		lanes: map[string]client.LaneState{
			"orders": {
				Lane: "orders", Seq: 9001, JournalBytes: 2048, KeyCount: 2,
				Consumers: []client.ConsumerState{
					{Name: "sid1", Floor: 9001, Pending: 0, Attached: true},
					{Name: "sid2", Floor: 8990, Pending: 5, Attached: false},
				},
			},
			"quiet": {Lane: "quiet", Seq: 0},
		},
		keys: map[string][]string{"orders": {"box-42", "box-7"}},
		value: map[string]client.KVValue{
			"box-42": {Seq: 12, Found: true, Payload: []byte("box 42 left the dock")},
		},
	}
}

func TestStateSnapshotHonestShapes(t *testing.T) {
	srv := consoleFor(t, fakeOpener(smallYard()))
	defer srv.Close()

	status, body := get(t, srv, "/api/state")
	if status != 200 {
		t.Fatalf("state: status %d", status)
	}
	var snap Snapshot
	if err := json.Unmarshal([]byte(body), &snap); err != nil {
		t.Fatalf("state json: %v (%s)", err, body)
	}
	if snap.Yard == nil {
		t.Fatal("state: yard view missing")
	}
	if snap.Yard.Version != "1.0.0" || snap.Yard.Sessions != 3 {
		t.Fatalf("state: summary wrong: %+v", snap.Yard)
	}
	if len(snap.Yard.Lanes) != 2 {
		t.Fatalf("state: want 2 lanes, got %d", len(snap.Yard.Lanes))
	}
	orders := snap.Yard.Lanes[0]
	if orders.Name != "orders" || orders.Seq != 9001 || orders.JournalBytes != 2048 {
		t.Fatalf("state: orders row wrong: %+v", orders)
	}
	if len(orders.Consumers) != 2 || orders.Consumers[1].Floor != 8990 {
		t.Fatalf("state: consumers wrong: %+v", orders.Consumers)
	}
	if orders.Consumers[1].Attached {
		t.Fatal("state: sid2 should be detached")
	}
	if snap.FetchedAt == "" || snap.DurationMS < 0 {
		t.Fatal("state: snapshot clock missing")
	}
	if !strings.Contains(body, `"fetched_at"`) {
		t.Fatal("state: json keys must be snake_case")
	}
}

func TestStateRowCarriesRefusal(t *testing.T) {
	f := smallYard()
	// the summary lists a lane the drill-down refuses: the row carries
	// the refusal, the summary stays whole
	delete(f.lanes, "quiet")
	srv := consoleFor(t, fakeOpener(f))
	defer srv.Close()

	_, body := get(t, srv, "/api/state")
	var snap Snapshot
	if err := json.Unmarshal([]byte(body), &snap); err != nil {
		t.Fatalf("json: %v", err)
	}
	found := false
	for _, ln := range snap.Yard.Lanes {
		if ln.Name == "quiet" {
			found = true
		}
	}
	if !found {
		t.Fatal("state: quiet lane row missing")
	}
	if !strings.Contains(body, "no such stream") {
		t.Fatalf("state: the row should carry the refusal's words: %s", body)
	}
}

func TestStateDarkWhenDialRefused(t *testing.T) {
	srv := consoleFor(t, darkOpener(errors.New("connection refused")))
	defer srv.Close()

	status, body := get(t, srv, "/api/state")
	if status != 502 {
		t.Fatalf("dark state: status %d, want 502", status)
	}
	if !strings.Contains(body, `"dark"`) ||
		!strings.Contains(body, "connection refused") {
		t.Fatalf("dark state: body lacks the refusal: %s", body)
	}
}

func TestKeysAndValue(t *testing.T) {
	srv := consoleFor(t, fakeOpener(smallYard()))
	defer srv.Close()

	status, body := get(t, srv, "/api/keys?lane=orders")
	if status != 200 {
		t.Fatalf("keys: status %d", status)
	}
	if !strings.Contains(body, `"box-42"`) {
		t.Fatalf("keys: missing key: %s", body)
	}

	status, body = get(t, srv, "/api/value?lane=orders&key=box-42")
	if status != 200 {
		t.Fatalf("value: status %d", status)
	}
	if !strings.Contains(body, `"box 42 left the dock"`) {
		t.Fatalf("value: payload wrong: %s", body)
	}

	// absence is a fact, not an error
	status, body = get(t, srv, "/api/value?lane=orders&key=no-such")
	if status != 200 {
		t.Fatalf("absent value: status %d", status)
	}
	if !strings.Contains(body, `"found":false`) {
		t.Fatalf("absent value should say found=false: %s", body)
	}

	// an unknown lane is the wire's refusal, with its code
	status, body = get(t, srv, "/api/keys?lane=nope")
	if status != 502 {
		t.Fatalf("keys refusal: status %d", status)
	}
	if !strings.Contains(body, `"code":"S"`) {
		t.Fatalf("keys refusal should carry the protocol code: %s", body)
	}
}

func TestValueAsksForItsArguments(t *testing.T) {
	srv := consoleFor(t, fakeOpener(smallYard()))
	defer srv.Close()
	status, body := get(t, srv, "/api/keys")
	if status != 400 {
		t.Fatalf("keys without lane: status %d", status)
	}
	if !strings.Contains(body, "lane") {
		t.Fatalf("keys without lane should say so: %s", body)
	}
}

func TestPreviewCutsWholeRunes(t *testing.T) {
	f := smallYard()
	// a payload larger than the preview, multi-byte runes common
	big := strings.Repeat("é", 6000) // 2 bytes each = 12000 bytes
	f.value["big"] = client.KVValue{Seq: 1, Found: true, Payload: []byte(big)}
	srv := consoleFor(t, fakeOpener(f))
	defer srv.Close()

	_, body := get(t, srv, "/api/value?lane=orders&key=big")
	var vv ValueView
	if err := json.Unmarshal([]byte(body), &vv); err != nil {
		t.Fatalf("big value: %v", err)
	}
	if !vv.Cut {
		t.Fatal("big value should say the preview was cut")
	}
	if vv.Bytes != 12000 {
		t.Fatalf("byte count must be the payload's truth: %d", vv.Bytes)
	}
	if !utf8.ValidString(vv.Text) {
		t.Fatal("preview must not split a rune")
	}
}

func TestStaticConsoleServes(t *testing.T) {
	srv := consoleFor(t, fakeOpener(smallYard()))
	defer srv.Close()
	status, body := get(t, srv, "/")
	if status != 200 {
		t.Fatalf("console page: status %d", status)
	}
	if !strings.Contains(body, "yardmaster") {
		t.Fatal("console page: the brand line is missing")
	}
	if !strings.Contains(body, "read-only") {
		t.Fatal("console page: the read-only claim is missing")
	}
}
