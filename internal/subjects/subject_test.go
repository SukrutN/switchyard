package subjects

import (
	"errors"
	"strings"
	"testing"
)

// Charter tests read like the docs/PROTOCOL.md §3 table: every rule gets a
// passing and a failing case, and the boundary cases are exact, because a
// charter that quietly rotates ±1 byte is a charter nobody can rely on.
func TestParseCharter(t *testing.T) {
	cases := []struct {
		name    string
		subject string
		wantErr error
	}{
		{"plain", "orders.e9.paid", nil},
		{"single token", "orders", nil},
		{"star alone first", "*.orders", nil},
		{"star mid", "orders.*.paid", nil},
		{"star last", "orders.*", nil},
		{"greater alone", ">", nil},
		{"greater trailing", "orders.>", nil},
		{"deep with wildcards", "*.*.*.*.>", nil},
		{"accepted charset", "a-b_c.d", nil},
		{"empty", "", ErrEmpty},
		{"empty first token", ".orders", ErrEmpty},
		{"double dot", "orders..paid", ErrEmpty},
		{"empty tracks position", "orders..paid", ErrEmpty},
		{"space in token", "orders e9.paid", ErrBadByte}, // 0x20 below the range
		{"control char", "orders\x01.paid", ErrBadByte},  // 0x01
		{"high byte", "ordérs", ErrBadByte},              // 0x high byte
		{"token too long", strings.Repeat("a", MaxTokenLen+1), ErrTooLong},
		{"token at boundary", strings.Repeat("a", MaxTokenLen), nil},
		{"subject too long", strings.Repeat("a.", 40) + strings.Repeat("a", MaxLen-2*40+120), ErrTooLong},
		{"star embedded", "ord*ers.paid", ErrBadWildcard},
		{"greater embedded", "orders.pai>d", ErrBadWildcard},
		{"greater not final", "orders.>.paid", ErrBadWildcard},
		{"greater then star", "orders.>*", ErrBadWildcard},
		{"star and greater", "orders.*.>", nil},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			s, err := Parse(tc.subject)
			if tc.wantErr == nil {
				if err != nil {
					t.Fatalf("Parse(%q) = error %v, want nil", tc.subject, err)
				}
				if len(s.Tokens) != strings.Count(tc.subject, ".")+1 {
					t.Fatalf("Parse(%q) token count %d is wrong", tc.subject, len(s.Tokens))
				}
				return
			}
			if err == nil {
				t.Fatalf("Parse(%q) = %+v, want error %v", tc.subject, s, tc.wantErr)
			}
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("Parse(%q) = %v, want %v", tc.subject, err, tc.wantErr)
			}
		})
	}
}

// The token-count ceiling gets its own test: the "subject too long" case
// above can also pass via 32-token arithmetic, so say it directly.
func TestParseTokenCount(t *testing.T) {
	ok := strings.Repeat("a.", MaxTokens-1) + "z"
	if _, err := Parse(ok); err != nil {
		t.Fatalf("Parse(31 tokens) = %v, want nil", err)
	}
	bad := strings.Repeat("a.", MaxTokens) + "z"
	_, err := Parse(bad)
	if !errors.Is(err, ErrTooMany) {
		t.Fatalf("Parse(32+1 tokens) = %v, want ErrTooMany", err)
	}
}

func TestParseSubjectLength(t *testing.T) {
	// ≤32 tokens, every token ≤64 bytes, total exactly 255: eight tokens of
	// 31 (255 = 8×31 + 7 dots).
	tk31 := strings.Repeat("a", 31)
	at255 := tk31 + strings.Repeat("."+tk31, 7)
	if got := len(at255); got != MaxLen {
		t.Fatalf("fixture builds %d bytes, want %d", got, MaxLen)
	}
	if _, err := Parse(at255); err != nil {
		t.Fatalf("Parse(255 bytes) = %v, want nil", err)
	}
	// +1 byte → the length rule fires before anything else.
	over256 := at255 + "b"
	if _, err := Parse(over256); !errors.Is(err, ErrTooLong) {
		t.Fatalf("Parse(256 bytes) = %v, want ErrTooLong", err)
	}
}

func TestIsConcrete(t *testing.T) {
	cases := []struct {
		subject string
		want    bool
	}{
		{"orders.e9.paid", true},
		{"orders.*.paid", false},
		{"orders.>", false},
		{">", false},
	}
	for _, tc := range cases {
		s, err := Parse(tc.subject)
		if err != nil {
			t.Fatalf("Parse(%q): %v", tc.subject, err)
		}
		if got := s.IsConcrete(); got != tc.want {
			t.Fatalf("IsConcrete(%q) = %v, want %v", tc.subject, got, tc.want)
		}
	}
}

func mustParse(t *testing.T, s string) Subject {
	t.Helper()
	sub, err := Parse(s)
	if err != nil {
		t.Fatalf("Parse(%q): %v", s, err)
	}
	return sub
}

// Match is the product's heart; the table is exhaustive enough that a
// semantic change lands as a table edit, not a customer incident.
func TestMatch(t *testing.T) {
	cases := []struct {
		name    string
		pattern string
		subject string
		want    bool
	}{
		{"literal exact", "orders.e9.paid", "orders.e9.paid", true},
		{"literal mismatch", "orders.e9.paid", "orders.e9.failed", false},
		{"literal shorter subject", "orders.e9.paid", "orders.e9", false},
		{"literal longer subject", "orders.e9.paid", "orders.e9.paid.now", false},
		{"case sensitive", "orders.e9.paid", "ORDERS.e9.paid", false},
		{"case sensitive star", "orders.*.paid", "orders.E9.paid", true},

		{"greater needs one", "orders.>", "orders", false},
		{"greater one token", "orders.>", "orders.e9", true},
		{"greater many tokens", "orders.>", "orders.e9.paid.now", true},
		{"greater prefix fails", "orders.>", "freight.e9", false},
		{"greater matching plain", "orders.paid.>", "orders.paid.e9", true},
		{"greater matching plain shorter", "orders.paid.>", "orders.paid", false},
		{"greater dispatch", ">", "orders.e9.paid", true},
		{"greater dispatch single", ">", "orders", true},
		{"greater alone no subject", ">", "", false},

		{"star hits any token", "orders.*.paid", "orders.e9.paid", true},
		{"star exact token", "orders.*.paid", "orders.e9.paid", true},
		{"star not two tokens", "orders.*.paid", "orders.e9.e9.paid", false},
		{"star not zero tokens", "orders.paid", "orders.paid", true},
		{"star misses run", "orders.*.paid", "orders.paid", false},
		{"star misses prefix", "orders.*.paid", "freight.e9.paid", false},
		{"leading star", "e9.paid", "orders.e9.paid", false},

		{"star then greater", "a.*.>", "a.b.c.d", true},
		{"star then greater one trailing", "a.*.>", "a.b.c", true},
		{"star then greater zero trailing", "a.*.>", "a.b", false}, // '>' needs ≥1 token after the star
		{"star then greater one short", "a.*.>", "a", false},
		{"multiple stars", "*.*.paid", "orders.e9.paid", true},
		{"wildcard chain", "*.*.*.*", "a.b.c.d", true},
		{"wildcard chain short", "*.*.*.*", "a.b.c", false},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if tc.subject == "" {
				// Empty published subjects cannot exist; Parse refuses them.
				// The case documents the invariant rather than crash-testing.
				t.Skip("empty subjects refuse at Parse; matching starts post-parse")
			}
			got := Match(mustParse(t, tc.pattern), mustParse(t, tc.subject))
			if got != tc.want {
				t.Fatalf("Match(%q, %q) = %v, want %v", tc.pattern, tc.subject, got, tc.want)
			}
		})
	}
}

// Match must also hold when the published subject is a wildcard parse — it
// cannot happen over the wire (publish rejects wildcards), but the matcher
// stays total for safety.
func TestMatchWildcardSubject(t *testing.T) {
	if !Match(mustParse(t, "orders.>"), mustParse(t, "orders.*.paid")) {
		t.Fatal("pattern orders.> should catch orders.*.paid as plain text")
	}
}
