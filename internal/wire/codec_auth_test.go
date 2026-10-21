package wire

import (
	"errors"
	"strings"
	"testing"
)

// The auth-pair codec tables: the token is a shape (1..256 bytes, exact
// end) and the nod is nothing at all. Whatever the token means, the codec
// had better stay silent about — that judgment is the yard's.

func TestAuthCodecRoundTrips(t *testing.T) {
	for _, tok := range []string{"shh", strings.Repeat("k", MaxAuthToken)} {
		b, err := EncodeAuthenticate(Authenticate{Token: tok})
		if err != nil {
			t.Fatalf("EncodeAuthenticate(%d bytes): %v", len(tok), err)
		}
		got, err := DecodeAuthenticate(b)
		if err != nil {
			t.Fatalf("DecodeAuthenticate: %v", err)
		}
		if got.Token != tok {
			t.Fatalf("token roundtrip: got %d bytes, want %d", len(got.Token), len(tok))
		}
	}

	b, err := EncodeAuthOK(AuthOK{})
	if err != nil {
		t.Fatalf("EncodeAuthOK: %v", err)
	}
	if len(b) != 0 {
		t.Fatalf("AUTH_OK body = %d bytes, want none", len(b))
	}
	if _, derr := DecodeAuthOK(b); derr != nil {
		t.Fatalf("DecodeAuthOK: %v", derr)
	}
	if _, derr := DecodeAuthOK([]byte{0x00}); derr == nil {
		t.Fatalf("AUTH_OK accepted a stray byte")
	}
}

func TestAuthCodecRefusals(t *testing.T) {
	for _, bad := range []string{"", strings.Repeat("t", MaxAuthToken+1)} {
		_, err := EncodeAuthenticate(Authenticate{Token: bad})
		if !isCode(err, CodeMalformed) {
			t.Fatalf("token %d bytes: got %v, want MALFORMED (shape only; meaning is the yard's)", len(bad), err)
		}
	}

	// Truncation and trailing bytes keep offsets exact.
	good, _ := EncodeAuthenticate(Authenticate{Token: "shh"})
	if _, err := DecodeAuthenticate(good[:len(good)-1]); err == nil {
		t.Fatalf("truncated token accepted")
	}
	if _, err := DecodeAuthenticate(append(good, 0x00)); err == nil {
		t.Fatalf("trailing byte after token accepted")
	}
}

func TestAuthCodecErrorUnwrapping(t *testing.T) {
	_, err := EncodeAuthenticate(Authenticate{Token: ""})
	var pe *ProtocolError
	if !errors.As(err, &pe) {
		t.Fatalf("errors.As did not unwrap %v to *ProtocolError", err)
	}
}
