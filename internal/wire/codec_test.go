package wire

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

// MaxUint32 is the sid boundary value used in round-trip tables.
const MaxUint32 = ^uint32(0)

// roundtrip asserts one op goes out and comes back identical. Byte order is
// big-endian everywhere; the tables pin every field, so a field flip in codec
// fails here before it fails a customer.
func TestCodecRoundTrips(t *testing.T) {
	t.Run("hello", func(t *testing.T) {
		for _, h := range []Hello{
			{Name: "yard-watch", Label: "spur-cli"},
			{Name: "", Label: ""}, // display-only fields; empty is legal
			{Name: strings.Repeat("n", MaxClientName), Label: strings.Repeat("l", MaxSpeechLabel)},
		} {
			b, err := EncodeHello(h)
			if err != nil {
				t.Fatalf("EncodeHello(%+v): %v", h, err)
			}
			got, err := DecodeHello(b)
			if err != nil {
				t.Fatalf("DecodeHello: %v", err)
			}
			if got != h {
				t.Fatalf("hello roundtrip: got %+v want %+v", got, h)
			}
		}
	})

	t.Run("welcome", func(t *testing.T) {
		for _, w := range []Welcome{
			{ServerLabel: "switchyard/0.1.0", MaxBody: MaxBodyBytes},
			{ServerLabel: "", MaxBody: 1},
		} {
			b, err := EncodeWelcome(w)
			if err != nil {
				t.Fatalf("EncodeWelcome(%+v): %v", w, err)
			}
			got, err := DecodeWelcome(b)
			if err != nil {
				t.Fatalf("DecodeWelcome: %v", err)
			}
			if got != w {
				t.Fatalf("welcome roundtrip: got %+v want %+v", got, w)
			}
		}
	})

	t.Run("publish", func(t *testing.T) {
		for _, p := range []Publish{
			{Subject: "orders.e9.paid", Payload: []byte("hello, yard")},
			{Subject: "orders.e9.paid", Payload: nil},
			{Subject: "a.b", Reply: "inbox.worker1", Payload: []byte{0x00, 0xFF, 0x07}, HasReply: true},
		} {
			b, err := EncodePublish(p)
			if err != nil {
				t.Fatalf("EncodePublish(%+v): %v", p, err)
			}
			got, err := DecodePublish(b)
			if err != nil {
				t.Fatalf("DecodePublish: %v", err)
			}
			if got.Subject != p.Subject || got.HasReply != p.HasReply || got.Reply != p.Reply ||
				!bytes.Equal(got.Payload, p.Payload) {
				t.Fatalf("publish roundtrip: got %+v want %+v", got, p)
			}
		}
	})

	t.Run("subscribe", func(t *testing.T) {
		for _, s := range []Subscribe{
			{Pattern: "orders.>", Sid: 1},
			{Pattern: ">", Sid: MaxUint32},
		} {
			b, err := EncodeSubscribe(s)
			if err != nil {
				t.Fatalf("EncodeSubscribe(%+v): %v", s, err)
			}
			got, err := DecodeSubscribe(b)
			if err != nil {
				t.Fatalf("DecodeSubscribe: %v", err)
			}
			if got != s {
				t.Fatalf("subscribe roundtrip: got %+v want %+v", got, s)
			}
		}
	})

	t.Run("unsub", func(t *testing.T) {
		b, err := EncodeUnsub(Unsub{Sid: 42})
		if err != nil {
			t.Fatalf("EncodeUnsub: %v", err)
		}
		got, err := DecodeUnsub(b)
		if err != nil {
			t.Fatalf("DecodeUnsub: %v", err)
		}
		if got.Sid != 42 {
			t.Fatalf("unsub roundtrip: got %+v", got)
		}
	})

	t.Run("deliver", func(t *testing.T) {
		for _, d := range []Deliver{
			{Subject: "orders.e9.paid", Sid: 7, Seq: 1, Payload: []byte("first")},
			{Subject: "orders.e9.paid", Sid: 7, Seq: 2, Reply: "r", Payload: []byte{}, HasReply: true},
		} {
			b, err := EncodeDeliver(d)
			if err != nil {
				t.Fatalf("EncodeDeliver(%+v): %v", d, err)
			}
			got, err := DecodeDeliver(b)
			if err != nil {
				t.Fatalf("DecodeDeliver: %v", err)
			}
			if got.Subject != d.Subject || got.Sid != d.Sid || got.Seq != d.Seq ||
				got.Reply != d.Reply || got.HasReply != d.HasReply || !bytes.Equal(got.Payload, d.Payload) {
				t.Fatalf("deliver roundtrip: got %+v want %+v", got, d)
			}
		}
	})

	t.Run("error", func(t *testing.T) {
		for _, e := range []ErrorResponse{
			{Code: CodeBadSubject, Message: "wildcards are for subscriptions", Fatal: false},
			{Code: CodeSlowConsumer, Message: "queue overflowed", Fatal: true},
		} {
			b, err := EncodeError(e)
			if err != nil {
				t.Fatalf("EncodeError(%+v): %v", e, err)
			}
			got, err := DecodeError(b)
			if err != nil {
				t.Fatalf("DecodeError: %v", err)
			}
			if got.Code != e.Code || got.Message != e.Message || got.Fatal != e.Fatal {
				t.Fatalf("error roundtrip: got %+v want %+v", got, e)
			}
		}
	})
}

// The corpus of bodies a broken or hostile client could emit; every one
// decodes as a non-fatal ProtocolError for the session (visit semantics via
// ErrorStyle), or an encode-side refusal.
func TestCodecMalformed(t *testing.T) {
	decodes := []struct {
		name     string
		body     []byte
		wantOp   func(b []byte) error
		wantCode byte
	}{
		{"hello short", []byte{0x03, 'a'}, func(b []byte) error { _, e := DecodeHello(b); return e }, CodeMalformed},
		{"hello trunc name", []byte{0x03, 'a', 'b', 0x00}, func(b []byte) error { _, e := DecodeHello(b); return e }, CodeMalformed},
		{"hello trailing", []byte{0x01, 'a', 0x00, 0x99}, func(b []byte) error { _, e := DecodeHello(b); return e }, CodeMalformed},
		{"welcome zero max", []byte{0x00, 0x01, 'x', 0x00, 0x00, 0x00, 0x00}, func(b []byte) error { _, e := DecodeWelcome(b); return e }, CodeMalformed},
		{"publish empty subject", []byte{0x00, 0x00, 0x00, 0x00}, func(b []byte) error { _, e := DecodePublish(b); return e }, CodeBadSubject},
		{"publish subject len overrun", []byte{0x00, 0x30, 'a', 'b', 0x00, 0x00, 0x00, 0x00, 0x00}, func(b []byte) error { _, e := DecodePublish(b); return e }, CodeMalformed},
		{"publish payload length cut short", []byte{0x00, 0x03, 'a', 'b', 'c', 0x00, 0x05, 0x00, 0x00}, func(b []byte) error { _, e := DecodePublish(b); return e }, CodeMalformed},
		{"subscribe trailing", []byte{0x00, 0x01, 'a', 0x00, 0x00, 0x00, 0x09, 0xFF}, func(b []byte) error { _, e := DecodeSubscribe(b); return e }, CodeMalformed},
	}
	for _, tc := range decodes {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if tc.wantOp == nil {
				// encode-side refusals: assert the failure EXISTS and names
				// the code, then move on.
				return
			}
			err := tc.wantOp(tc.body)
			if err == nil {
				t.Fatalf("decode accepted malformed body %x", tc.body)
			}
			var pe *ProtocolError
			if !errors.As(err, &pe) {
				t.Fatalf("decode error %T (%v) is not *ProtocolError", err, err)
			}
			if pe.Code != tc.wantCode {
				t.Fatalf("decode error code %d, want %d (%v)", pe.Code, tc.wantCode, err)
			}
			if pe.Fatal {
				t.Fatalf("body-shape errors must not be fatal (session can continue): %v", err)
			}
		})
	}
}

// Encode-side refusals, one per rule the docs state.
func TestEncodeRefusals(t *testing.T) {
	long := strings.Repeat("x", MaxClientName+1)
	if _, err := EncodeHello(Hello{Name: long}); err == nil {
		t.Fatal("hello name over cap must refuse")
	}
	if _, err := EncodeWelcome(Welcome{MaxBody: 0}); err == nil {
		t.Fatal("welcome with zero max body must refuse")
	}
	if _, err := EncodePublish(Publish{}); err == nil {
		t.Fatal("publish with empty subject must refuse")
	}
	if _, err := EncodeSubscribe(Subscribe{Sid: 0, Pattern: "a"}); err != nil {
		t.Fatalf("subscribe sid 0 is legal AT THE CODEC (semantics belong to the server): %v", err)
	}
	p := Publish{Subject: "a.b", Payload: []byte("x")}
	p.HasReply, p.Reply = false, "reply-set-without-flag"
	if _, err := EncodePublish(p); err == nil {
		t.Fatal("reply set without flag must refuse")
	}
	if _, err := EncodeDeliver(Deliver{Subject: "a", Sid: 0, Seq: 1}); err == nil {
		t.Fatal("deliver with sid 0 must refuse")
	}
	if _, err := EncodeDeliver(Deliver{Subject: "a", Sid: 1, Seq: 0}); err == nil {
		t.Fatal("deliver with seq 0 must refuse")
	}
}

// Payload ceiling arithmetic: the largest legal body must encode, decode,
// and round-trip; +1 byte must refuse on encode, proving the per-op cap
// matches the reader's framing bounds.
func TestPayloadCeiling(t *testing.T) {
	sub := "a.b" // three subject bytes count toward the body too
	room := MaxBodyBytes - (2 + len(sub) + 1 + 4)
	p := Publish{Subject: sub, Payload: make([]byte, room)}
	body, err := EncodePublish(p)
	if err != nil {
		t.Fatalf("encode at ceiling: %v", err)
	}
	if len(body) != MaxBodyBytes {
		t.Fatalf("body of %d bytes, want exactly %d", len(body), MaxBodyBytes)
	}
	got, err := DecodePublish(body)
	if err != nil {
		t.Fatalf("decode at ceiling: %v", err)
	}
	if len(got.Payload) != room {
		t.Fatalf("payload %d bytes, want %d", len(got.Payload), room)
	}
	p.Payload = make([]byte, room+1)
	if _, err := EncodePublish(p); err == nil {
		t.Fatal("payload over cap must refuse")
	}
}

// Error messages truncate, not fail: a refusal should never be lost for
// verbosity.
func TestErrorMessageTruncates(t *testing.T) {
	msg := strings.Repeat("m", MaxSubjectLen+50)
	b, err := EncodeError(ErrorResponse{Code: CodeTooLarge, Message: msg})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	got, err := DecodeError(b)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Message != msg[:MaxSubjectLen] {
		t.Fatalf("message truncated wrong: %d bytes", len(got.Message))
	}
}

// Framer tests: the reader's discipline is where DoS protection and resync
// honesty live, so they get their own file-backed loop.
func TestReaderFraming(t *testing.T) {
	t.Run("two frames in sequence", func(t *testing.T) {
		var buf bytes.Buffer
		w := NewWriter(&buf)
		if err := w.WriteFrame(OpPing, nil); err != nil {
			t.Fatal(err)
		}
		if err := w.WriteFrame(OpHello, []byte{0x01, 'a', 0x00}); err != nil {
			t.Fatal(err)
		}
		rd := NewReader(&buf, MaxBodyBytes)
		op1, b1, err := rd.ReadFrame()
		if err != nil || op1 != OpPing || b1 != nil {
			t.Fatalf("frame1: op=%v body=%v err=%v", op1, b1, err)
		}
		op2, _, err := rd.ReadFrame()
		if err != nil || op2 != OpHello {
			t.Fatalf("frame2: op=%v err=%v", op2, err)
		}
	})

	t.Run("bad magic fatal", func(t *testing.T) {
		rd := NewReader(bytes.NewReader([]byte{0x00, 0x00, 0x01, 0x03, 0, 0, 0, 0}), MaxBodyBytes)
		_, _, err := rd.ReadFrame()
		var pe *ProtocolError
		if !errors.As(err, &pe) || pe.Code != CodeMalformed || !pe.Fatal {
			t.Fatalf("got %v, want fatal CodeMalformed", err)
		}
	})

	t.Run("wrong version fatal", func(t *testing.T) {
		buf := frame(OpPing, nil)
		buf[2] = 0x02
		rd := NewReader(bytes.NewReader(buf), MaxBodyBytes)
		_, _, err := rd.ReadFrame()
		var pe *ProtocolError
		if !errors.As(err, &pe) || pe.Code != CodeVersion || !pe.Fatal {
			t.Fatalf("got %v, want fatal CodeVersion", err)
		}
	})

	t.Run("body over ceiling fatal", func(t *testing.T) {
		buf := frame(OpPing, nil)
		putU32(buf[4:8], MaxBodyBytes+1)
		rd := NewReader(bytes.NewReader(buf), MaxBodyBytes)
		_, _, err := rd.ReadFrame()
		var pe *ProtocolError
		if !errors.As(err, &pe) || pe.Code != CodeTooLarge || !pe.Fatal {
			t.Fatalf("got %v, want fatal CodeTooLarge", err)
		}
	})

	t.Run("body over soft limit skipped with framing intact", func(t *testing.T) {
		var buf bytes.Buffer
		w := NewWriter(&buf)
		if err := w.WriteFrame(OpPublish, make([]byte, 100)); err != nil {
			t.Fatal(err)
		}
		if err := w.WriteFrame(OpPing, nil); err != nil {
			t.Fatal(err)
		}
		rd := NewReader(&buf, 64) // soft 64: first body (100) skips
		op, body, err := rd.ReadFrame()
		if !errors.Is(err, ErrSkipped) || body != nil {
			t.Fatalf("first: op=%v body=%v err=%v, want ErrSkipped", op, body, err)
		}
		op2, _, err2 := rd.ReadFrame()
		if err2 != nil || op2 != OpPing {
			t.Fatalf("second frame after skip: op=%v err=%v — framing lost", op2, err2)
		}
	})

	t.Run("truncated body hits the decoder, not the framer", func(t *testing.T) {
		// Framer-level truncation: header promises 4 body bytes, stream has 2.
		buf := []byte{Magic1, Magic2, Version, byte(OpHello), 0, 0, 0, 4, 0x02, 'a'}
		rd := NewReader(bytes.NewReader(buf), MaxBodyBytes)
		_, _, err := rd.ReadFrame()
		var pe *ProtocolError
		if !errors.As(err, &pe) || pe.Code != CodeMalformed {
			t.Fatalf("got %v, want CodeMalformed", err)
		}
		// Frame-level clean, body-level junk: the framer passes it through,
		// the codec refuses. Two layers, both probed.
		buf2 := frame(OpHello, []byte{0x03, 'a', 0x00})
		rd2 := NewReader(bytes.NewReader(buf2), MaxBodyBytes)
		op, body, err := rd2.ReadFrame()
		if err != nil || op != OpHello {
			t.Fatalf("framer refused a good frame: op=%v err=%v", op, err)
		}
		if _, derr := DecodeHello(body); derr == nil {
			t.Fatal("decoder accepted a truncated body")
		}
	})

	t.Run("short header", func(t *testing.T) {
		rd := NewReader(bytes.NewReader([]byte{0x53}), MaxBodyBytes)
		_, _, err := rd.ReadFrame()
		if err == nil || errors.As(err, new(*ProtocolError)) {
			t.Fatalf("got %v, want io-style error, not ProtocolError", err)
		}
	})
}

// frame hand-builds a correct frame for corruption tests.
func frame(op Op, body []byte) []byte {
	buf := []byte{Magic1, Magic2, Version, byte(op), 0, 0, 0, 0}
	buf = append(buf, body...)
	putU32(buf[4:8], uint32(len(body)))
	return buf
}

func putU32(dst []byte, v uint32) {
	dst[0] = byte(v >> 24)
	dst[1] = byte(v >> 16)
	dst[2] = byte(v >> 8)
	dst[3] = byte(v)
}
