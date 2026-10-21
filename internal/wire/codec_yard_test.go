package wire

import (
	"errors"
	"strings"
	"testing"
)

// The console-family codec tables: an empty request is an exact body, the
// states round-trip every row, and the refusal tables pin the codes — the
// console speaks the same discipline as every family before it.

func TestYardCodecRoundTrips(t *testing.T) {
	t.Run("info", func(t *testing.T) {
		b, err := EncodeYardInfo(YardInfo{})
		if err != nil {
			t.Fatalf("EncodeYardInfo: %v", err)
		}
		if len(b) != 0 {
			t.Fatalf("YARD_INFO body = %d bytes, want none", len(b))
		}
		if _, err := DecodeYardInfo(b); err != nil {
			t.Fatalf("DecodeYardInfo: %v", err)
		}
		if _, err := DecodeYardInfo([]byte{0x00}); err == nil {
			t.Fatalf("YARD_INFO accepted a stray byte")
		}
	})

	t.Run("state", func(t *testing.T) {
		for _, y := range []YardState{
			{Version: "0.4.0", UptimeSec: 125, Sessions: 3, Lanes: []YardLane{{Name: "orders", Seq: 7}}, Quarantined: []string{"store"}},
			{Version: "0.4.0"}, // memory-only yard: lanes 0, quarantined 0
		} {
			b, err := EncodeYardState(y)
			if err != nil {
				t.Fatalf("EncodeYardState(%+v): %v", y, err)
			}
			got, err := DecodeYardState(b)
			if err != nil {
				t.Fatalf("DecodeYardState: %v", err)
			}
			if got.Version != y.Version || got.UptimeSec != y.UptimeSec || got.Sessions != y.Sessions ||
				len(got.Lanes) != len(y.Lanes) || len(got.Quarantined) != len(y.Quarantined) {
				t.Fatalf("state shape: got %+v want %+v", got, y)
			}
			for i := range y.Lanes {
				if got.Lanes[i] != y.Lanes[i] {
					t.Fatalf("lanes[%d]: got %+v want %+v", i, got.Lanes[i], y.Lanes[i])
				}
			}
			for i := range y.Quarantined {
				if got.Quarantined[i] != y.Quarantined[i] {
					t.Fatalf("quarantined[%d]: got %q want %q", i, got.Quarantined[i], y.Quarantined[i])
				}
			}
		}
	})

	t.Run("lane info", func(t *testing.T) {
		l := LaneInfo{Lane: "orders"}
		b, err := EncodeLaneInfo(l)
		if err != nil {
			t.Fatalf("EncodeLaneInfo: %v", err)
		}
		got, err := DecodeLaneInfo(b)
		if err != nil {
			t.Fatalf("DecodeLaneInfo: %v", err)
		}
		if got != l {
			t.Fatalf("lane info roundtrip: got %+v want %+v", got, l)
		}
	})

	t.Run("lane state", func(t *testing.T) {
		for _, l := range []LaneState{
			{Lane: "orders", Seq: 7, JournalBytes: 512, KeyCount: 3, Consumers: []LaneConsumer{
				{Name: "audit", Floor: 5, Pending: 0, Attached: true},
				{Name: "billing", Floor: 3, Pending: 2, Attached: true},
				{Name: "cold", Floor: 0, Pending: 0, Attached: false},
			}},
			{Lane: "store", Seq: 0, Quarantined: true, JournalBytes: 1 << 20, KeyCount: 12},
			{Lane: "empty", Seq: 128, KeyCount: 0},
		} {
			b, err := EncodeLaneState(l)
			if err != nil {
				t.Fatalf("EncodeLaneState(%+v): %v", l, err)
			}
			got, err := DecodeLaneState(b)
			if err != nil {
				t.Fatalf("DecodeLaneState: %v", err)
			}
			if got.Lane != l.Lane || got.Seq != l.Seq || got.Quarantined != l.Quarantined ||
				got.JournalBytes != l.JournalBytes || got.KeyCount != l.KeyCount ||
				len(got.Consumers) != len(l.Consumers) {
				t.Fatalf("lane state shape: got %+v want %+v", got, l)
			}
			for i := range l.Consumers {
				if got.Consumers[i] != l.Consumers[i] {
					t.Fatalf("consumers[%d]: got %+v want %+v", i, got.Consumers[i], l.Consumers[i])
				}
			}
		}
	})
}

func TestYardCodecRefusals(t *testing.T) {
	t.Run("names outside the §3.1 charter", func(t *testing.T) {
		if _, err := EncodeYardState(YardState{Version: "0.4.0", Lanes: []YardLane{{Name: ""}}}); !isCode(err, CodeBadStreamName) {
			t.Fatalf("empty lane row: got %v, want BAD_STREAM_NAME", err)
		}
		if _, err := EncodeYardState(YardState{Version: "0.4.0", Quarantined: []string{strings.Repeat("q", MaxStreamName+1)}}); !isCode(err, CodeBadStreamName) {
			t.Fatalf("oversize quarantined name: got %v, want BAD_STREAM_NAME", err)
		}
		if _, err := EncodeLaneState(LaneState{Lane: "orders", Consumers: []LaneConsumer{{Name: ""}}}); !isCode(err, CodeBadStreamName) {
			t.Fatalf("empty consumer row name: got %v, want BAD_STREAM_NAME", err)
		}
		if _, err := EncodeLaneInfo(LaneInfo{Lane: ""}); !isCode(err, CodeBadStreamName) {
			t.Fatalf("empty lane info: got %v, want BAD_STREAM_NAME", err)
		}
	})

	t.Run("counts and truncations keep offsets", func(t *testing.T) {
		if _, err := EncodeYardState(YardState{Version: strings.Repeat("v", 33)}); !isCode(err, CodeMalformed) {
			t.Fatalf("oversize version: got %v, want MALFORMED", err)
		}
		b, err := EncodeYardState(YardState{Version: "0.4.0", Sessions: 1, Lanes: []YardLane{{Name: "orders", Seq: 9}}, Quarantined: []string{"store"}})
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		if _, err := DecodeYardState(b[:len(b)-1]); err == nil {
			t.Fatalf("truncated quarantined list accepted")
		}
		if _, err := DecodeYardState(append(b, 0x00)); err == nil {
			t.Fatalf("trailing byte accepted")
		}
		l, err := EncodeLaneState(LaneState{Lane: "orders", Seq: 2, Consumers: []LaneConsumer{{Name: "audit"}}})
		if err != nil {
			t.Fatalf("encode lane state: %v", err)
		}
		if _, err := DecodeLaneState(l[:len(l)-2]); err == nil {
			t.Fatalf("consumer row cut at its flag byte accepted")
		}
	})
}

// The console refuses ride the same errors.As surface as every family;
// pin it here so a refactor cannot strip the codes from this table at once.
func TestYardCodecErrorUnwrapping(t *testing.T) {
	_, err := EncodeLaneInfo(LaneInfo{Lane: ""})
	var pe *ProtocolError
	if !errors.As(err, &pe) {
		t.Fatalf("errors.As did not unwrap %v to *ProtocolError", err)
	}
}
