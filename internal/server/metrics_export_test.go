package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/SukrutN/switchyard/internal/client"
	"github.com/SukrutN/switchyard/internal/metrics"
)

// The exporter renders the yard's own state: a live session shows up as a
// gauge, and the accept counter counts what the accept loop accepted.
func TestTheMetricsExporterCountsARealSession(t *testing.T) {
	srv, err := NewServer(Config{Addr: "127.0.0.1:0", Log: logDiscard()})
	if err != nil {
		t.Fatalf("boot yard: %v", err)
	}
	go func() { _ = srv.Run() }()
	defer srv.Stop()

	c, err := client.Dial(context.Background(), srv.Addr(), client.Options{Name: "metrics-test"})
	if err != nil {
		t.Fatalf("dial yard: %v", err)
	}
	defer c.Close()

	handler := metrics.Handler(srv.Metrics(), srv.YardStats, "")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("metrics answered %d", recorder.Code)
	}
	body := recorder.Body.String()
	if !strings.Contains(body, "switchyard_connections_accepted_total 1") {
		t.Errorf("the accept counter did not count the dial: %s", body)
	}
	if !strings.Contains(body, "switchyard_sessions 1") {
		t.Errorf("the session gauge did not see the live session: %s", body)
	}
	if !strings.Contains(body, "switchyard_build_info{version=") {
		t.Errorf("the build info line is missing: %s", body)
	}

	// The connection leaving is a fact too; the gauge should settle back.
	_ = c.Close()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		recorder = httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))
		if strings.Contains(recorder.Body.String(), "switchyard_sessions 0") {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Errorf("the session gauge never settled back to zero: %s", recorder.Body.String())
}
