package metrics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTheExporterRendersTheYardsOwnFacts(t *testing.T) {
	reg := NewRegistry()
	reg.ConnAccepted()
	reg.ConnAccepted()

	handler := Handler(reg, func() Stats {
		return Stats{
			Version:     "1.0.0",
			UptimeSec:   12,
			Sessions:    2,
			Quarantined: []string{"bad-lane"},
			Lanes: []LaneStat{
				{Name: "orders", Seq: 5, JournalBytes: 9282, KeyCount: 2},
				{Name: "bad-lane", Seq: 3, JournalBytes: 100, KeyCount: 0, Quarantined: true},
			},
		}
	}, "")

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("metrics answered %d", recorder.Code)
	}
	body := recorder.Body.String()
	for _, want := range []string{
		"# TYPE switchyard_connections_accepted_total counter",
		"switchyard_connections_accepted_total 2",
		"switchyard_build_info{version=\"1.0.0\"} 1",
		"switchyard_sessions 2",
		"switchyard_lanes 2",
		"switchyard_quarantined_lanes 1",
		"switchyard_lane_seq{lane=\"orders\"} 5",
		"switchyard_lane_journal_bytes{lane=\"orders\"} 9282",
		"switchyard_lane_keys{lane=\"orders\"} 2",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("metrics page is missing %q", want)
		}
	}
}

func TestTheHealthPageIsUp(t *testing.T) {
	handler := Handler(NewRegistry(), func() Stats { return Stats{} }, "")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/health", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("health answered %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), `"up"`) {
		t.Errorf("health body was %q", recorder.Body.String())
	}
}

func TestATokenLocksTheMetricsPort(t *testing.T) {
	handler := Handler(NewRegistry(), func() Stats { return Stats{} }, "sesame")

	bare := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, bare)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("a bare scrape answered %d, not 401", recorder.Code)
	}

	allowed := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	allowed.Header.Set("authorization", "Bearer sesame")
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, allowed)
	if recorder.Code != http.StatusOK {
		t.Fatalf("an authorized scrape answered %d", recorder.Code)
	}
}

func TestALabelIsEscapedHonestly(t *testing.T) {
	if got := label(`a"b\c` + "\n"); got != `a\"b\\c\n` {
		t.Errorf("label escaped to %q", got)
	}
}
