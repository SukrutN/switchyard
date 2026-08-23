package wire

import (
	"encoding/binary"
	"errors"
	"strings"
	"testing"
)

// The KV-family codec tables: round-trips pin every field; refusals pin the
// code a client can branch on; the found-flag law (flag is the truth) gets a
// hostile-frame test because an encoder cannot produce that shape by design.

func TestKVCodecRoundTrips(t *testing.T) {
	t.Run("set", func(t *testing.T) {
		for _, s := range []KVSet{
			{Lane: "orders", Key: "cart.json", Payload: []byte(`{"n":2}`)},
			{Lane: "orders", Key: "empty/value", Payload: nil},
			{Lane: "config", Key: strings.Repeat("k", MaxKeyLen), Payload: []byte{0x00, 0xFF}},
		} {
			b, err := EncodeKVSet(s)
			if err != nil {
				t.Fatalf("EncodeKVSet(%+v): %v", s, err)
			}
			got, err := DecodeKVSet(b)
			if err != nil {
				t.Fatalf("DecodeKVSet: %v", err)
			}
			if got.Lane != s.Lane || got.Key != s.Key || !bytesEqual(got.Payload, s.Payload) {
				t.Fatalf("set roundtrip: got %+v want %+v", got, s)
			}
		}
	})

	t.Run("get", func(t *testing.T) {
		g := KVGet{Lane: "orders", Key: "cart.json"}
		b, err := EncodeKVGet(g)
		if err != nil {
			t.Fatalf("EncodeKVGet: %v", err)
		}
		got, err := DecodeKVGet(b)
		if err != nil {
			t.Fatalf("DecodeKVGet: %v", err)
		}
		if got != g {
			t.Fatalf("get roundtrip: got %+v want %+v", got, g)
		}
	})

	t.Run("delete", func(t *testing.T) {
		d := KVDelete{Lane: "orders", Key: "cart.json"}
		b, err := EncodeKVDelete(d)
		if err != nil {
			t.Fatalf("EncodeKVDelete: %v", err)
		}
		got, err := DecodeKVDelete(b)
		if err != nil {
			t.Fatalf("DecodeKVDelete: %v", err)
		}
		if got != d {
			t.Fatalf("delete roundtrip: got %+v want %+v", got, d)
		}
	})

	t.Run("keys", func(t *testing.T) {
		k := KVKeys{Lane: "orders"}
		b, err := EncodeKVKeys(k)
		if err != nil {
			t.Fatalf("EncodeKVKeys: %v", err)
		}
		got, err := DecodeKVKeys(b)
		if err != nil {
			t.Fatalf("DecodeKVKeys: %v", err)
		}
		if got != k {
			t.Fatalf("keys roundtrip: got %+v want %+v", got, k)
		}
	})

	t.Run("value", func(t *testing.T) {
		for _, v := range []KVValue{
			{Lane: "orders", Key: "cart.json", Seq: 1, Found: true, Payload: []byte(`{"n":2}`)},
			{Lane: "orders", Key: "empty/value", Seq: 7, Found: true, Payload: []byte{}},
			{Lane: "orders", Key: "absent", Found: false},
			{Lane: "config", Key: strings.Repeat("k", MaxKeyLen), Seq: ^uint64(0), Found: true, Payload: []byte{0x01}},
		} {
			b, err := EncodeKVValue(v)
			if err != nil {
				t.Fatalf("EncodeKVValue(%+v): %v", v, err)
			}
			got, err := DecodeKVValue(b)
			if err != nil {
				t.Fatalf("DecodeKVValue: %v", err)
			}
			if got.Lane != v.Lane || got.Key != v.Key || got.Seq != v.Seq || got.Found != v.Found ||
				!bytesEqual(got.Payload, v.Payload) {
				t.Fatalf("value roundtrip: got %+v want %+v", got, v)
			}
		}
	})

	t.Run("keylist", func(t *testing.T) {
		for _, k := range []KVKeyList{
			{Lane: "orders", Keys: []string{"a", "cart.json", "zzz"}},
			{Lane: "orders"}, // empty bucket: count 0
		} {
			b, err := EncodeKVKeyList(k)
			if err != nil {
				t.Fatalf("EncodeKVKeyList(%+v): %v", k, err)
			}
			got, err := DecodeKVKeyList(b)
			if err != nil {
				t.Fatalf("DecodeKVKeyList: %v", err)
			}
			if got.Lane != k.Lane || got.Keys == nil && len(k.Keys) == 0 || len(got.Keys) != len(k.Keys) {
				t.Fatalf("keylist shape: got %+v want %+v", got, k)
			}
			for i := range k.Keys {
				if got.Keys[i] != k.Keys[i] {
					t.Fatalf("keylist[%d]: got %q want %q", i, got.Keys[i], k.Keys[i])
				}
			}
		}
	})
}

func TestKVCodecRefusals(t *testing.T) {
	t.Run("keys off the length charter", func(t *testing.T) {
		for _, bad := range []string{"", strings.Repeat("k", MaxKeyLen+1)} {
			if _, err := EncodeKVSet(KVSet{Lane: "orders", Key: bad}); !isCode(err, CodeBadKey) {
				t.Fatalf("set key %q: got %v, want 0x%02X", bad, err, CodeBadKey)
			}
			if _, err := EncodeKVGet(KVGet{Lane: "orders", Key: bad}); !isCode(err, CodeBadKey) {
				t.Fatalf("get key %q: got %v, want 0x%02X", bad, err, CodeBadKey)
			}
			if _, err := EncodeKVDelete(KVDelete{Lane: "orders", Key: bad}); !isCode(err, CodeBadKey) {
				t.Fatalf("delete key %q: got %v, want 0x%02X", bad, err, CodeBadKey)
			}
			if _, err := EncodeKVKeyList(KVKeyList{Lane: "orders", Keys: []string{"ok", bad}}); !isCode(err, CodeBadKey) {
				t.Fatalf("keylist key %q: got %v, want 0x%02X", bad, err, CodeBadKey)
			}
		}
	})

	t.Run("not-found answers carry seq 0 and no payload", func(t *testing.T) {
		if _, err := EncodeKVValue(KVValue{Lane: "o", Key: "k", Seq: 3}); !isCode(err, CodeMalformed) {
			t.Fatalf("not-found with seq: got %v", err)
		}
		if _, err := EncodeKVValue(KVValue{Lane: "o", Key: "k", Payload: []byte("x")}); !isCode(err, CodeMalformed) {
			t.Fatalf("not-found with payload: got %v", err)
		}
		// Hand-built: flag clear but payload section present. The decoder
		// reads the flag as the truth and treats the leftover bytes as the
		// corruption they are.
		b := make([]byte, 0, 64)
		b = encStr16(b, "orders")
		b = encStr16(b, "k")
		b = binary.BigEndian.AppendUint64(b, 0)
		b = append(b, 0x00) // no FOUND flag
		b = binary.BigEndian.AppendUint32(b, 1)
		b = append(b, 'x')
		if _, err := DecodeKVValue(b); !isCode(err, CodeMalformed) {
			t.Fatalf("flagless payload section: got %v, want MALFORMED", err)
		}
	})

	t.Run("set room math", func(t *testing.T) {
		s := KVSet{Lane: "orders", Key: "cart.json", Payload: make([]byte, MaxBodyBytes)}
		if _, err := EncodeKVSet(s); !isCode(err, CodeTooLarge) {
			t.Fatalf("oversize set: got %v, want TOO_LARGE", err)
		}
		room := frameRoom(2 + len(s.Lane) + 2 + len(s.Key) + 4)
		s.Payload = make([]byte, room)
		if _, err := EncodeKVSet(s); err != nil {
			t.Fatalf("exact-room set refused: %v", err)
		}
	})

	t.Run("decode refusals keep offsets", func(t *testing.T) {
		b, err := EncodeKVSet(KVSet{Lane: "orders", Key: "cart.json", Payload: []byte("x")})
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		if _, err := DecodeKVSet(b[:len(b)-1]); err == nil {
			t.Fatalf("truncated set payload accepted")
		}
		if _, err := DecodeKVSet(append(b, 0x00)); err == nil {
			t.Fatalf("trailing byte accepted")
		}
		l, err := EncodeKVKeyList(KVKeyList{Lane: "orders", Keys: []string{"a", "b"}})
		if err != nil {
			t.Fatalf("encode keylist: %v", err)
		}
		if _, err := DecodeKVKeyList(l[:len(l)-1]); err == nil {
			t.Fatalf("truncated keylist accepted")
		}
	})
}

// bytesEqual keeps the nil-vs-empty distinction from noise in these tables:
// an empty trip through the encoder is a legal value, not a mismatch.
func bytesEqual(a, b []byte) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	if (a == nil) != (b == nil) {
		return false
	}
	return string(a) == string(b)
}

// untested helper guard: the protocol error paths above rely on ProtocolError
// surfacing through errors.As; pin that here so a refactor of newOpErr cannot
// silently strip the code from every refusal table at once.
func TestKVCodecErrorUnwrapping(t *testing.T) {
	_, err := EncodeKVGet(KVGet{Lane: "orders", Key: ""})
	var pe *ProtocolError
	if !errors.As(err, &pe) {
		t.Fatalf("errors.As did not unwrap %v to *ProtocolError", err)
	}
}
