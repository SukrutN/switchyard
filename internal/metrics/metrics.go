// Package metrics is the yard's Prometheus text exporter: the same facts
// the console protocol answers, rendered for a scraper. Zero dependencies,
// one lock, snapshot at render time. The exporter never invents a number:
// every gauge comes from the yard's own state assembly, and the one counter
// (connections accepted) is counted where the accept happens.
package metrics

import (
	"fmt"
	"net/http"
	"sync/atomic"
	"time"
)

// Stats is one honest moment of the yard, the same assembly the console
// protocol answers. The server satisfies it; tests satisfy it with fakes.
type Stats struct {
	Version     string
	UptimeSec   uint64
	Sessions    uint32
	Quarantined []string
	Lanes       []LaneStat
}

// LaneStat is one lane's row, as LANE_STATE carried it.
type LaneStat struct {
	Name         string
	Seq          uint64
	JournalBytes uint64
	KeyCount     uint32
	Quarantined  bool
}

// Registry holds the process counters that only the accept loop can see.
// The gauges live in the yard; the counters live here.
type Registry struct {
	accepted atomic.Int64
	started  time.Time
}

// NewRegistry starts the clock at construction.
func NewRegistry() *Registry {
	return &Registry{started: time.Now()}
}

// ConnAccepted counts one accepted connection.
func (r *Registry) ConnAccepted() {
	if r == nil {
		return
	}
	r.accepted.Add(1)
}

// Handler serves /metrics and /health on the yard's metrics port. The token
// is optional: empty means the page is open, which is right for a port bound
// to localhost; set it when the port is wider than that.
func Handler(reg *Registry, stats func() Stats, token string) http.Handler {
	mux := http.NewServeMux()
	gate := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if token != "" {
				if r.Header.Get("authorization") != "Bearer "+token {
					w.Header().Set("content-type", "application/json")
					w.WriteHeader(http.StatusUnauthorized)
					fmt.Fprintf(w, `{"title":"A token is required","detail":"Send the yard's metrics token as a Bearer authorization header."}`+"\n")
					return
				}
			}
			next(w, r)
		}
	}
	mux.HandleFunc("GET /metrics", gate(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/plain; version=0.0.4; charset=utf-8")
		snap := stats()
		out := ""
		out += "# HELP switchyard_build_info The yard's version, as a labeled constant.\n"
		out += "# TYPE switchyard_build_info gauge\n"
		out += fmt.Sprintf("switchyard_build_info{version=%q} 1\n", label(snap.Version))
		out += "# HELP switchyard_connections_accepted_total Connections the yard has accepted since boot.\n"
		out += "# TYPE switchyard_connections_accepted_total counter\n"
		accepted := int64(0)
		if reg != nil {
			accepted = reg.accepted.Load()
		}
		out += fmt.Sprintf("switchyard_connections_accepted_total %d\n", accepted)
		out += "# HELP switchyard_uptime_seconds Seconds the yard has been serving.\n"
		out += "# TYPE switchyard_uptime_seconds gauge\n"
		out += fmt.Sprintf("switchyard_uptime_seconds %d\n", snap.UptimeSec)
		out += "# HELP switchyard_sessions Sessions attached right now.\n"
		out += "# TYPE switchyard_sessions gauge\n"
		out += fmt.Sprintf("switchyard_sessions %d\n", snap.Sessions)
		out += "# HELP switchyard_lanes Lanes the yard journals.\n"
		out += "# TYPE switchyard_lanes gauge\n"
		out += fmt.Sprintf("switchyard_lanes %d\n", len(snap.Lanes))
		out += "# HELP switchyard_quarantined_lanes Lanes refusing writes until restart.\n"
		out += "# TYPE switchyard_quarantined_lanes gauge\n"
		out += fmt.Sprintf("switchyard_quarantined_lanes %d\n", len(snap.Quarantined))
		if len(snap.Lanes) > 0 {
			out += "# HELP switchyard_lane_seq The last sequence number each lane stored.\n"
			out += "# TYPE switchyard_lane_seq gauge\n"
			for _, lane := range snap.Lanes {
				out += fmt.Sprintf("switchyard_lane_seq{lane=%q} %d\n", label(lane.Name), lane.Seq)
			}
			out += "# HELP switchyard_lane_journal_bytes Bytes each lane's journal holds.\n"
			out += "# TYPE switchyard_lane_journal_bytes gauge\n"
			for _, lane := range snap.Lanes {
				out += fmt.Sprintf("switchyard_lane_journal_bytes{lane=%q} %d\n", label(lane.Name), lane.JournalBytes)
			}
			out += "# HELP switchyard_lane_keys Live keys each lane's index carries.\n"
			out += "# TYPE switchyard_lane_keys gauge\n"
			for _, lane := range snap.Lanes {
				out += fmt.Sprintf("switchyard_lane_keys{lane=%q} %d\n", label(lane.Name), lane.KeyCount)
			}
		}
		_, _ = w.Write([]byte(out))
	}))
	mux.HandleFunc("GET /health", gate(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		fmt.Fprintln(w, `{"status":"up"}`)
	}))
	return mux
}

func label(value string) string {
	out := make([]byte, 0, len(value))
	for _, c := range value {
		switch c {
		case '\\':
			out = append(out, '\\', '\\')
		case '"':
			out = append(out, '\\', '"')
		case '\n':
			out = append(out, '\\', 'n')
		default:
			out = append(out, byte(c))
		}
	}
	return string(out)
}
