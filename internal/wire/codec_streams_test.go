package wire

import (
	"bytes"
	"encoding/binary"
	"errors"
	"strings"
	"testing"
)

// The stream-family codec tables: round-trips pin every field, refusal tests
// pin the codes, and the exact-frame arithmetic is checked against the doc's
// numbers so a "harmless" field reorder dies here, not in a customer.

func TestStreamCodecRoundTrips(t *testing.T) {
	t.Run("create", func(t *testing.T) {
		for _, c := range []StreamCreate{
			{Name: "orders"},
			{Name: strings.Repeat("l", MaxStreamName)},
		} {
			b, err := EncodeStreamCreate(c)
			if err != nil {
				t.Fatalf("EncodeStreamCreate(%+v): %v", c, err)
			}
			got, err := DecodeStreamCreate(b)
			if err != nil {
				t.Fatalf("DecodeStreamCreate: %v", err)
			}
			if got != c {
				t.Fatalf("create roundtrip: got %+v want %+v", got, c)
			}
		}
	})

	t.Run("ready", func(t *testing.T) {
		r := StreamReady{Name: "orders", Seq: 1}
		b, err := EncodeStreamReady(r)
		if err != nil {
			t.Fatalf("EncodeStreamReady: %v", err)
		}
		got, err := DecodeStreamReady(b)
		if err != nil {
			t.Fatalf("DecodeStreamReady: %v", err)
		}
		if got != r {
			t.Fatalf("ready roundtrip: got %+v want %+v", got, r)
		}
		maxSeq := StreamReady{Name: "orders", Seq: ^uint64(0)}
		if _, err := EncodeStreamReady(maxSeq); err != nil {
			t.Fatalf("u64 seq boundary refused: %v", err)
		}
	})

	t.Run("publish", func(t *testing.T) {
		for _, p := range []StreamPublish{
			{Stream: "orders", Subject: "orders.e9.paid", Payload: []byte("durable")},
			{Stream: "orders", Subject: "orders", Payload: nil},
			{Stream: "orders", Subject: "orders.e9.paid", Reply: "inbox.w1", Payload: []byte{0x00, 0xFF}, HasReply: true},
		} {
			b, err := EncodeStreamPublish(p)
			if err != nil {
				t.Fatalf("EncodeStreamPublish(%+v): %v", p, err)
			}
			got, err := DecodeStreamPublish(b)
			if err != nil {
				t.Fatalf("DecodeStreamPublish: %v", err)
			}
			if got.Stream != p.Stream || got.Subject != p.Subject || got.HasReply != p.HasReply || got.Reply != p.Reply ||
				!bytes.Equal(got.Payload, p.Payload) {
				t.Fatalf("stream publish roundtrip: got %+v want %+v", got, p)
			}
		}
	})

	t.Run("receipt", func(t *testing.T) {
		r := StreamReceipt{Stream: "orders", Seq: 42}
		b, err := EncodeStreamReceipt(r)
		if err != nil {
			t.Fatalf("EncodeStreamReceipt: %v", err)
		}
		got, err := DecodeStreamReceipt(b)
		if err != nil {
			t.Fatalf("DecodeStreamReceipt: %v", err)
		}
		if got != r {
			t.Fatalf("receipt roundtrip: got %+v want %+v", got, r)
		}
	})

	t.Run("attach", func(t *testing.T) {
		for _, a := range []ConsumerAttach{
			{Stream: "orders", Consumer: "billing", Sid: 7, AckWaitMillis: 10_000},
			{Stream: "orders", Consumer: "billing", Sid: MaxUint32, Filter: "orders.*.paid", HasFilter: true, AckWaitMillis: 0},
		} {
			b, err := EncodeConsumerAttach(a)
			if err != nil {
				t.Fatalf("EncodeConsumerAttach(%+v): %v", a, err)
			}
			got, err := DecodeConsumerAttach(b)
			if err != nil {
				t.Fatalf("DecodeConsumerAttach: %v", err)
			}
			if got.Stream != a.Stream || got.Consumer != a.Consumer || got.Sid != a.Sid ||
				got.HasFilter != a.HasFilter || got.Filter != a.Filter || got.AckWaitMillis != a.AckWaitMillis {
				t.Fatalf("attach roundtrip: got %+v want %+v", got, a)
			}
		}
	})

	t.Run("consumer-ready", func(t *testing.T) {
		r := ConsumerReady{Stream: "orders", Consumer: "billing", Sid: 7, Next: 41, AckWaitMillis: 250}
		b, err := EncodeConsumerReady(r)
		if err != nil {
			t.Fatalf("EncodeConsumerReady: %v", err)
		}
		got, err := DecodeConsumerReady(b)
		if err != nil {
			t.Fatalf("DecodeConsumerReady: %v", err)
		}
		if got != r {
			t.Fatalf("consumer ready roundtrip: got %+v want %+v", got, r)
		}
	})

	t.Run("deliver", func(t *testing.T) {
		for _, d := range []StreamDeliver{
			{Subject: "orders.e9.paid", Sid: 7, Seq: 99, Payload: []byte("x")},
			{Subject: "orders.e9.paid", Sid: 7, Seq: ^uint64(0), Reply: "inbox.w1", Payload: []byte{0x01, 0x02}, HasReply: true},
		} {
			b, err := EncodeStreamDeliver(d)
			if err != nil {
				t.Fatalf("EncodeStreamDeliver(%+v): %v", d, err)
			}
			got, err := DecodeStreamDeliver(b)
			if err != nil {
				t.Fatalf("DecodeStreamDeliver: %v", err)
			}
			if got.Subject != d.Subject || got.Sid != d.Sid || got.Seq != d.Seq || got.HasReply != d.HasReply || got.Reply != d.Reply ||
				!bytes.Equal(got.Payload, d.Payload) {
				t.Fatalf("stream deliver roundtrip: got %+v want %+v", got, d)
			}
		}
	})

	t.Run("ack", func(t *testing.T) {
		a := Ack{Sid: 7, Seq: ^uint64(0)}
		b, err := EncodeAck(a)
		if err != nil {
			t.Fatalf("EncodeAck: %v", err)
		}
		got, err := DecodeAck(b)
		if err != nil {
			t.Fatalf("DecodeAck: %v", err)
		}
		if got != a {
			t.Fatalf("ack roundtrip: got %+v want %+v", got, a)
		}
	})

	t.Run("delete/gone", func(t *testing.T) {
		for _, c := range []StreamDelete{{Name: "orders"}, {Name: "x"}} {
			b, err := EncodeStreamDelete(c)
			if err != nil {
				t.Fatalf("EncodeStreamDelete(%+v): %v", c, err)
			}
			got, err := DecodeStreamDelete(b)
			if err != nil {
				t.Fatalf("DecodeStreamDelete: %v", err)
			}
			if got != c {
				t.Fatalf("delete roundtrip: got %+v want %+v", got, c)
			}
		}
		g := StreamGone{Name: "orders"}
		b, err := EncodeStreamGone(g)
		if err != nil {
			t.Fatalf("EncodeStreamGone: %v", err)
		}
		got, err := DecodeStreamGone(b)
		if err != nil {
			t.Fatalf("DecodeStreamGone: %v", err)
		}
		if got != g {
			t.Fatalf("gone roundtrip: got %+v want %+v", got, g)
		}
	})
}

func TestStreamCodecRefusals(t *testing.T) {
	t.Run("lane names off the length charter", func(t *testing.T) {
		for _, bad := range []string{"", strings.Repeat("x", MaxStreamName+1)} {
			if _, err := EncodeStreamCreate(StreamCreate{Name: bad}); !isCode(err, CodeBadStreamName) {
				t.Fatalf("create name %q: got %v, want code 0x%02X", bad, err, CodeBadStreamName)
			}
			if _, err := EncodeConsumerAttach(ConsumerAttach{Stream: bad, Consumer: "c", Sid: 1}); !isCode(err, CodeBadStreamName) {
				t.Fatalf("attach stream name %q: got %v, want code 0x%02X", bad, err, CodeBadStreamName)
			}
			if _, err := EncodeConsumerAttach(ConsumerAttach{Stream: "orders", Consumer: bad, Sid: 1}); !isCode(err, CodeBadStreamName) {
				t.Fatalf("attach consumer name %q: got %v, want code 0x%02X", bad, err, CodeBadStreamName)
			}
		}
	})

	t.Run("receipt and ready seq start at 1", func(t *testing.T) {
		if _, err := EncodeStreamReceipt(StreamReceipt{Stream: "orders", Seq: 0}); !isCode(err, CodeMalformed) {
			t.Fatalf("receipt seq 0: got %v", err)
		}
		if _, err := EncodeStreamReady(StreamReady{Name: "orders", Seq: 0}); !isCode(err, CodeMalformed) {
			t.Fatalf("ready seq 0: got %v", err)
		}
		if _, err := EncodeConsumerReady(ConsumerReady{Stream: "orders", Consumer: "c", Sid: 1, Next: 0, AckWaitMillis: 1}); !isCode(err, CodeMalformed) {
			t.Fatalf("consumer ready next 0: got %v", err)
		}
	})

	t.Run("filter flag must match payload", func(t *testing.T) {
		if _, err := EncodeConsumerAttach(ConsumerAttach{Stream: "orders", Consumer: "c", Sid: 1, Filter: "orders.>"}); !isCode(err, CodeMalformed) {
			t.Fatalf("filter without flag: got %v", err)
		}
		// A hostile frame can carry the flag with zero filter bytes — the
		// encoder cannot produce that shape, so the body is built by hand:
		// stream, consumer, flag present-an-empty, sid, ackWait.
		b := make([]byte, 0, 64)
		b = encStr16(b, "orders")
		b = encStr16(b, "c")
		b = append(b, FlagFilterPresent)
		b = append(b, 0x00, 0x00) // u16 filter length, claimed but empty
		b = binary.BigEndian.AppendUint32(b, 7)
		b = binary.BigEndian.AppendUint32(b, 10_000)
		if _, err := DecodeConsumerAttach(b); !isCode(err, CodeBadSubject) {
			t.Fatalf("empty filter present: got %v, want BAD_SUBJECT", err)
		}
	})

	t.Run("payload room math on stream publish", func(t *testing.T) {
		p := StreamPublish{Stream: "orders", Subject: "orders.e9.paid", Payload: make([]byte, MaxBodyBytes)}
		if _, err := EncodeStreamPublish(p); !isCode(err, CodeTooLarge) {
			t.Fatalf("oversize publish: got %v, want TOO_LARGE", err)
		}
		p.Payload = make([]byte, frameRoom(2+len(p.Stream)+2+len(p.Subject)+1+4)+1)
		if _, err := EncodeStreamPublish(p); !isCode(err, CodeTooLarge) {
			t.Fatalf("one-byte-over publish: got %v, want TOO_LARGE", err)
		}
		exact := StreamPublish{Stream: "orders", Subject: "orders.e9.paid", Payload: make([]byte, frameRoom(2+len(p.Stream)+2+len(p.Subject)+1+4))}
		if _, err := EncodeStreamPublish(exact); err != nil {
			t.Fatalf("exact-room publish refused: %v", err)
		}
	})

	t.Run("deliver room math mirrors deliver", func(t *testing.T) {
		d := StreamDeliver{Subject: "orders.e9.paid", Sid: 7, Seq: 1, Payload: make([]byte, MaxBodyBytes)}
		if _, err := EncodeStreamDeliver(d); !isCode(err, CodeTooLarge) {
			t.Fatalf("oversize deliver: got %v, want TOO_LARGE", err)
		}
	})

	t.Run("decode refusals keep offsets", func(t *testing.T) {
		b, err := EncodeStreamPublish(StreamPublish{Stream: "orders", Subject: "orders.a", Payload: []byte("x")})
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		if _, err := DecodeStreamPublish(b[:len(b)-1]); err == nil {
			t.Fatalf("truncated payload accepted")
		}
		if _, err := DecodeStreamPublish(append(b, 0x00)); err == nil {
			t.Fatalf("trailing byte accepted")
		}
		a, err := EncodeAck(Ack{Sid: 1, Seq: 1})
		if err != nil {
			t.Fatalf("encode ack: %v", err)
		}
		if _, err := DecodeAck(a[:3]); err == nil {
			t.Fatalf("short sid accepted")
		}
	})
}

// isCode unwraps a ProtocolError and compares the code; refusals name their
// code or they are untestable.
func isCode(err error, code byte) bool {
	var pe *ProtocolError
	if !errors.As(err, &pe) {
		return false
	}
	return pe.Code == code
}
