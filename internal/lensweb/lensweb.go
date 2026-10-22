// Package lensweb is the yardmaster's browser console: a read-only
// companion that dials the yard as an ordinary client and mirrors what
// the console family (§2.24–§2.27) and the KV reads (§2.19–§2.21)
// answer. It serves no levers: nothing here writes, quarantine is
// reported, not cleared, and every snapshot is honest about being a
// snapshot — assembled lane by lane under each lane's own lock, with
// the fetch time carried so a reader can tell how fresh it is.
//
// The bridge is deliberately thin: the JSON shapes are the client
// types with snake_case names, one field each, no invention. The
// console opens a fresh session per request, reads, and closes —
// the same lifecycle spur gives every verb, so a half-dead yard
// cannot wedge a browser tab.
package lensweb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/SukrutN/switchyard/internal/client"
)

// Prober is the read-only slice of a session the console needs,
// satisfied by *client.Client — tests satisfy it with a fake.
type Prober interface {
	YardInfo(ctx context.Context) (client.YardState, error)
	LaneInfo(ctx context.Context, lane string) (client.LaneState, error)
	KVKeys(ctx context.Context, lane string) ([]string, error)
	KVGet(ctx context.Context, lane, key string) (client.KVValue, error)
	Close() error
}

// Opener hands the console one session per request. Failed dials are
// facts too: the handlers answer "the yard is dark" rather than spin.
type Opener func(ctx context.Context) (Prober, error)

// Meta is the console's own configuration as the browser should see
// it: the yard it watches and the gate it walks through.
type Meta struct {
	Target  string `json:"target"`          // host:port the console dials
	TLS     bool   `json:"tls"`             // the wrap is on
	SkipTLS bool   `json:"skip_tls_verify"` // -insecure, a lab switch
	Tokened bool   `json:"tokened"`         // the gate demands a token
}

// ConsumerView is one consumer row: durable floor (the position it
// resumes from), delivered rows still owing acks, and whether a
// session is attached right now.
type ConsumerView struct {
	Name     string `json:"name"`
	Floor    uint64 `json:"floor"`
	Pending  uint32 `json:"pending"`
	Attached bool   `json:"attached"`
}

// LaneView is one lane's drill-down, as LANE_STATE carried it. Reading
// one lane is independent of the others; a refusal is carried on the
// row rather than failing the snapshot, because absence is a fact an
// operator acts on.
type LaneView struct {
	Name         string         `json:"name"`
	Seq          uint64         `json:"seq"`
	Quarantined  bool           `json:"quarantined"`
	JournalBytes uint64         `json:"journal_bytes"`
	KeyCount     uint32         `json:"key_count"`
	Consumers    []ConsumerView `json:"consumers"`
	Error        string         `json:"error,omitempty"`
}

// YardView is the yard's summary as YARD_STATE carried it.
type YardView struct {
	Version     string     `json:"version"`
	UptimeSec   uint64     `json:"uptime_sec"`
	Sessions    uint32     `json:"sessions"`
	Quarantined []string   `json:"quarantined"`
	Lanes       []LaneView `json:"lanes"`
}

// Dark is the yard's absence, told the way the wire told it: a dial
// refusal has a plain reason; a wire refusal carries its protocol code.
type Dark struct {
	Reason string `json:"reason"`
	Code   string `json:"code,omitempty"`
}

// Snapshot is /api/state: the yard plus every lane it journals.
type Snapshot struct {
	FetchedAt  string    `json:"fetched_at"`  // RFC 3339
	DurationMS int64     `json:"duration_ms"` // what one honest snapshot cost
	Yard       *YardView `json:"yard,omitempty"`
	Dark       *Dark     `json:"dark,omitempty"`
	Meta       Meta      `json:"meta"`
}

// KeyList is /api/keys: one lane's live key names (tombstones already
// subtracted by the yard's index).
type KeyList struct {
	Lane string   `json:"lane"`
	Keys []string `json:"keys"`
	Dark *Dark    `json:"dark,omitempty"`
}

// ValueView is /api/value: one key's payload, byte length always,
// text preview when the payload is printable UTF-8. Absence is
// brave answer: found=false is a fact, not an error.
type ValueView struct {
	Lane  string `json:"lane"`
	Key   string `json:"key"`
	Found bool   `json:"found"`
	Seq   uint64 `json:"seq,omitempty"`
	Bytes int    `json:"bytes,omitempty"`
	Text  string `json:"text,omitempty"`
	Cut   bool   `json:"cut,omitempty"` // the preview was shortened
	Dark  *Dark  `json:"dark,omitempty"`
}

// Console serves the read-only views. It holds no session of its own;
// every request opens, reads, and closes.
type Console struct {
	opener  Opener
	meta    Meta
	timeout time.Duration
	log     *slog.Logger
}

// previewCap bounds the text preview so a giant payload cannot wedge
// a browser tab. The byte count is always the payload's true length.
const previewCap = 8192

// New builds the console's HTTP routes: /api/state, /api/keys,
// /api/value, and the embedded static console at /.
func New(opener Opener, meta Meta, timeout time.Duration, log *slog.Logger) http.Handler {
	con := &Console{opener: opener, meta: meta, timeout: timeout, log: log}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/state", con.state)
	mux.HandleFunc("GET /api/keys", con.keys)
	mux.HandleFunc("GET /api/value", con.value)
	mux.Handle("GET /", static())
	return conHeaders(mux)
}

// conHeaders marks every answer fresh: a console that caches is a
// console that lies.
func conHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

// darkCode rephrases a wire refusal in the JSON the console speaks:
// known client errors carry their protocol code and the yard's own
// words; anything else is a plain reason.
func darkCode(err error) *Dark {
	var ce *client.ClientError
	if errors.As(err, &ce) {
		return &Dark{Reason: ce.Message, Code: fmt.Sprintf("%c", ce.Code)}
	}
	return &Dark{Reason: err.Error()}
}

// state answers GET /api/state.
func (c *Console) state(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), c.timeout)
	defer cancel()

	p, err := c.opener(ctx)
	if err != nil {
		if c.log != nil {
			c.log.Warn("dial refused", "target", c.meta.Target, "err", err)
		}
		writeJSON(w, http.StatusBadGateway, Snapshot{
			Dark:      &Dark{Reason: err.Error()},
			Meta:      c.meta,
			FetchedAt: time.Now().UTC().Format(time.RFC3339),
		})
		return
	}
	defer p.Close()

	t0 := time.Now()
	ys, err := p.YardInfo(ctx)
	if err != nil {
		if c.log != nil {
			c.log.Warn("yard info refused", "err", err)
		}
		writeJSON(w, http.StatusBadGateway, Snapshot{
			Dark:      darkCode(err),
			Meta:      c.meta,
			FetchedAt: t0.UTC().Format(time.RFC3339),
		})
		return
	}
	y := &YardView{
		Version:     ys.Version,
		UptimeSec:   ys.UptimeSec,
		Sessions:    ys.Sessions,
		Quarantined: ys.Quarantined,
	}
	// arrays answer as []: a console that prints null as a number of
	// things is a console that hesitates
	if y.Quarantined == nil {
		y.Quarantined = []string{}
	}
	y.Lanes = make([]LaneView, 0, len(ys.Lanes))
	for _, row := range ys.Lanes {
		lv := LaneView{Name: row.Name}
		ls, err := p.LaneInfo(ctx, row.Name)
		if err != nil {
			// the row carries the refusal; the summary stays whole
			lv.Error = err.Error()
			var ce *client.ClientError
			if errors.As(err, &ce) {
				lv.Error = fmt.Sprintf("%c / %s", ce.Code, ce.Message)
			}
		} else {
			lv.Seq = ls.Seq
			lv.Quarantined = ls.Quarantined
			lv.JournalBytes = ls.JournalBytes
			lv.KeyCount = ls.KeyCount
			lv.Consumers = make([]ConsumerView, 0, len(ls.Consumers))
			for _, con := range ls.Consumers {
				lv.Consumers = append(lv.Consumers, ConsumerView{
					Name:     con.Name,
					Floor:    con.Floor,
					Pending:  con.Pending,
					Attached: con.Attached,
				})
			}
		}
		y.Lanes = append(y.Lanes, lv)
	}

	writeJSON(w, http.StatusOK, Snapshot{
		FetchedAt:  t0.UTC().Format(time.RFC3339),
		DurationMS: time.Since(t0).Milliseconds(),
		Yard:       y,
		Meta:       c.meta,
	})
}

// keys answers GET /api/keys?lane=L — the lane's live key names.
func (c *Console) keys(w http.ResponseWriter, r *http.Request) {
	lane := r.URL.Query().Get("lane")
	if lane == "" {
		writeJSON(w, http.StatusBadRequest, KeyList{Dark: &Dark{Reason: "which lane? ask with ?lane="}})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), c.timeout)
	defer cancel()

	p, err := c.opener(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, KeyList{Dark: &Dark{Reason: err.Error()}})
		return
	}
	defer p.Close()

	keys, err := p.KVKeys(ctx, lane)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, KeyList{Lane: lane, Keys: []string{}, Dark: darkCode(err)})
		return
	}
	if keys == nil {
		keys = []string{}
	}
	writeJSON(w, http.StatusOK, KeyList{Lane: lane, Keys: keys})
}

// value answers GET /api/value?lane=L&key=K — one key's payload.
func (c *Console) value(w http.ResponseWriter, r *http.Request) {
	lane := r.URL.Query().Get("lane")
	key := r.URL.Query().Get("key")
	if lane == "" || key == "" {
		writeJSON(w, http.StatusBadRequest, ValueView{Lane: lane, Key: key,
			Dark: &Dark{Reason: "ask with ?lane= and ?key="}})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), c.timeout)
	defer cancel()

	p, err := c.opener(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, ValueView{Lane: lane, Key: key,
			Dark: &Dark{Reason: err.Error()}})
		return
	}
	defer p.Close()

	v, err := p.KVGet(ctx, lane, key)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, ValueView{Lane: lane, Key: key, Dark: darkCode(err)})
		return
	}
	if !v.Found {
		// absence is a fact, not an error
		writeJSON(w, http.StatusOK, ValueView{Lane: lane, Key: key})
		return
	}
	view := ValueView{Lane: lane, Key: key, Found: true, Seq: v.Seq, Bytes: len(v.Payload)}
	if utf8.Valid(v.Payload) {
		cut := len(v.Payload) > previewCap
		text := string(v.Payload)
		if cut {
			text = trimTailRune(string(v.Payload[:previewCap]))
			view.Cut = true
		}
		view.Text = text
	}
	writeJSON(w, http.StatusOK, view)
}

// trimTailRune drops a partial rune that a byte slice may end with.
func trimTailRune(s string) string {
	for len(s) > 0 && !utf8.RuneStart(s[len(s)-1]) {
		s = s[:len(s)-1]
	}
	return s
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
