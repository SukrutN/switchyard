package main

import (
	"testing"
	"time"
)

// The rod's helpers are tiny; the test is about the speech they print,
// because a number with a wrong comma is a lie in a table.
func TestHelpersSpeak(t *testing.T) {
	for _, tc := range []struct {
		in   int
		want string
	}{
		// Comma speech goes up in scale.
		{0, "0"},
		{7, "7"},
		{999, "999"},
		{1000, "1,000"},
		{1234567, "1,234,567"},
		{-12, "-12"},
	} {
		if got := comma(tc.in); got != tc.want {
			t.Fatalf("comma(%d) = %q, want %q", tc.in, got, tc.want)
		}
	}

	// Millisecond speech keeps decimals under 10 and rounds the rest.
	if got := ms(300 * time.Microsecond); got != "0.300" {
		t.Fatalf("ms(300µs) = %q, want 0.300", got)
	}
	if got := ms(1534 * time.Millisecond); got != "1534.0" {
		t.Fatalf("ms(1.534s) = %q, want 1534.0", got)
	}

	// Percentiles come from sorted probes, not arrival order. Five probes:
	// the 95th is the fifth — a small rod reports its resolution honestly
	// instead of pretending there is a value between the extremes.
	p50, p95 := percentiles([]time.Duration{
		time.Second * 9, time.Second * 1, time.Second * 2,
		time.Second * 3, time.Second * 4,
	})
	if p50 != 3*time.Second {
		t.Fatalf("p50 = %v, want 3s", p50)
	}
	if p95 != 9*time.Second {
		t.Fatalf("p95 = %v, want 9s (nearest-rank of five)", p95)
	}

	pay := makePayload(30)
	if len(pay) != 30 {
		t.Fatalf("payload length %d, want 30", len(pay))
	}
	for i, b := range pay {
		if b != byte('a'+i%26) {
			t.Fatalf("payload byte %d = %q, want the cycling alphabet", i, b)
		}
	}
}
