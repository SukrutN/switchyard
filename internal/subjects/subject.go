// Package subjects defines what a subject IS and how subscriptions match.
// Two rules the whole product leans on, so they get their own package and
// their own wall of tests:
//
//  1. charter — what text may appear in a subject
//  2. matching — which subscription patterns catch which published subjects
package subjects

import (
	"errors"
	"fmt"
	"strings"
)

// Charter, version 1 (docs/PROTOCOL.md §3):
//   - separator: '.'
//   - a subject/pattern is 1..32 dot-separated tokens
//   - a token is 1..64 bytes of printable ASCII (0x21..0x7E), excluding
//     '.', '*' and '>' (the two wildcards are charter-special)
//   - whole subject/pattern: 1..255 bytes
//
// Wildcard rules:
//   - '*' matches EXACTLY ONE token; may appear anywhere in the pattern
//   - '>' matches the published subject's REMAINING tokens (at least one)
//     and must be the final token of the pattern
//   - wildcards are legal in subscription patterns only; a PUBLISH subject
//     carrying one is a charter violation
//   - the wildcard symbols follow the convention the ecosystem already
//     carries; the matching semantics are ours and owned by Match alone.
const (
	MaxLen      = 255
	MaxTokens   = 32
	MaxTokenLen = 64
)

// Subject is a validated subject or pattern. Tokens are non-empty by
// construction — Parse is the only way to produce one, so Match relies on
// that invariant without re-checking it.
type Subject struct {
	Tokens []string
	Wild   bool // contains '*' or '>'
}

// Parse validates the charter and splits into tokens. Errors name the exact
// token position where the charter broke — that is the number you run the
// reproducer against.
func Parse(s string) (Subject, error) {
	if len(s) == 0 {
		return Subject{}, ErrEmpty
	}
	if len(s) > MaxLen {
		return Subject{}, fmt.Errorf("%w: %d bytes exceeds %d", ErrTooLong, len(s), MaxLen)
	}
	tokens := strings.Split(s, ".")
	if len(tokens) > MaxTokens {
		return Subject{}, fmt.Errorf("%w: %d tokens exceeds %d", ErrTooMany, len(tokens), MaxTokens)
	}
	sub := Subject{Tokens: tokens}
	for i, tok := range tokens {
		if tok == "" {
			// records WHICH token was empty — "token 2 is empty", not a shrug
			return Subject{}, fmt.Errorf("%w: token %d is empty", ErrEmpty, i)
		}
		if len(tok) > MaxTokenLen {
			return Subject{}, fmt.Errorf("%w: token %d is %d bytes, exceeds %d", ErrTooLong, i, len(tok), MaxTokenLen)
		}
		for j := 0; j < len(tok); j++ {
			c := tok[j]
			if c < 0x21 || c > 0x7E {
				return Subject{}, fmt.Errorf("%w: token %d holds byte 0x%02X, outside the printable range", ErrBadByte, i, c)
			}
			if (c == '*' || c == '>') && tok != "*" && tok != ">" {
				return Subject{}, fmt.Errorf("%w: token %d embeds a wildcard character in %q", ErrBadWildcard, i, tok)
			}
		}
		switch tok {
		case "*":
			sub.Wild = true
		case ">":
			if i != len(tokens)-1 {
				return Subject{}, fmt.Errorf("%w: '>' must be the final token", ErrBadWildcard)
			}
			sub.Wild = true
		}
	}
	return sub, nil
}

// IsConcrete reports whether a subject carries no wildcards — the gate a
// PUBLISH must pass but a SUBSCRIBE pattern may skip.
func (s Subject) IsConcrete() bool { return !s.Wild }

// Match reports whether the published subject falls under the pattern.
// Both sides must have come from Parse; wrong shape is a programming error,
// not a runtime condition, so it returns bool and nothing else.
//
// The loop is deliberately a flat walk rather than a trie: the routing table
// lives above this (server package) and holds far more subscriptions than a
// single pattern holds tokens.
func Match(pattern, pub Subject) bool {
	if !pattern.Wild {
		if len(pattern.Tokens) != len(pub.Tokens) {
			return false
		}
		for i := range pattern.Tokens {
			if pattern.Tokens[i] != pub.Tokens[i] {
				return false
			}
		}
		return true
	}
	for i, p := range pattern.Tokens {
		if i >= len(pub.Tokens) {
			// Pattern outran the subject. '>' would have matched here, but it
			// is the FINAL token by charter — if it were at i, the subject's
			// token i would exist, so reaching this branch means no match.
			return false
		}
		switch p {
		case "*":
			// consumes exactly one token, any value
		case ">":
			// ≥1 token guaranteed by the branch above: absorb the rest
			return true
		default:
			if p != pub.Tokens[i] {
				return false
			}
		}
	}
	// Pattern fully consumed; subject must be exactly consumed too — only a
	// '>' pattern may absorb a longer subject, and that case returned inside.
	return len(pattern.Tokens) == len(pub.Tokens)
}

// sentinel errors callers can type-check; positioned detail rides in the wrap
var (
	ErrEmpty       = errors.New("subjects: empty")
	ErrTooLong     = errors.New("subjects: subject too long")
	ErrTooMany     = errors.New("subjects: too many tokens")
	ErrBadByte     = errors.New("subjects: charter violation")
	ErrBadWildcard = errors.New("subjects: wildcard misuse")
)
