package server

import (
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/SukrutN/switchyard/internal/subjects"
	"github.com/SukrutN/switchyard/internal/wire"
)

// Hub is the routing center: which session's which subscription catches a
// published subject. Implementation shape:
//
//   - a token trie over subscriptions, one terminal node per distinct tail
//   - wildcard branches ('*', trailing '>') live inside nodes rather than in
//     a registry scan, so publishing walks only patterns sharing a prefix
//   - dispatch happens UNDER the hub's read lock, enqueueing (never blocking)
//     — that gives every sid one consistent total order, because concurrent
//     publishes serialize on the lock, either enqueue-then-release or wait
//
// Sid ownership: sid is client-assigned and unique per session (charter:
// one sid is exactly one live subscription; resubscribing is UNSUB first).
// Trie nodes therefore key entries by (session id, sid), because sid alone
// collides across sessions. Lane consumers share that sid space and the law
// extends: one sid holds at most one thing, spur or lane; session.go owns
// the combined check (sidTaken) so the hub cannot miss a lane conflict.
type Hub struct {
	mu       sync.RWMutex
	root     *node
	sessions map[uint64]*session
	next     uint64

	lanes *laneRegistry
}

type node struct {
	exact   map[string]*node // children by literal token; nil/empty = none
	star    *node            // the '*' branch, at most one per position
	greater *node            // the terminal '>' branch, at most one per position
	entries map[subKey]*entry
}

// subKey identifies one live subscription globally: client-assigned sids
// repeat across sessions, so the trie key includes the session id.
type subKey struct {
	sess uint64
	sid  uint32
}

// entry is one live subscription.
type entry struct {
	sid  uint32
	sess *session
}

func newHub(lanes *laneRegistry) *Hub {
	return &Hub{root: &node{}, sessions: make(map[uint64]*session), lanes: lanes}
}

// eachSession walks live sessions under the hub lock. Used by operator lanes
// (stream delete) that must reach every attached session exactly once.
func (h *Hub) eachSession(fn func(s *session)) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, s := range h.sessions {
		fn(s)
	}
}

// nextID mints a session id. Ids are only for identity (logs, registry keys).
func (h *Hub) nextID() uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.next++
	return h.next
}

// register logs a session into the routing registry.
func (h *Hub) register(s *session) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sessions[s.id] = s
}

// unregister drops a session and tears down everything it subscribed to.
func (h *Hub) unregister(id uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.sessions[id]
	if !ok {
		return
	}
	for _, sid := range s.allSids() {
		h.removeLocked(s, sid)
	}
	delete(h.sessions, id)
}

// closeAll slams every open connection — the fast path of server shutdown
// (readers block on deadlines; closing conns beats waiting them out).
func (h *Hub) closeAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, s := range h.sessions {
		s.conn.Close()
	}
}

// subscribe wires pattern under (session, sid). The byte result is the wire
// error CODE the session should answer with (0 on success). Violations are
// mapped here so dispatch stays a plain relay: the hub owns the meaning,
// the session owns the wire.
func (h *Hub) subscribe(s *session, sid uint32, pattern string) (byte, error) {
	if sid == 0 {
		return wire.CodeBadSubject, fmt.Errorf("sid 0 is reserved")
	}
	pat, err := subjects.Parse(pattern)
	if err != nil {
		return wire.CodeBadSubject, fmt.Errorf("pattern rejected: %w", err)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if s.sidTaken(sid) {
		// One sid, one subscription — whatever the pattern, a second claim is
		// a client bug we refuse to paper over: silent double-delivery is
		// worse than an error the client can act on.
		return wire.CodeDupSub, fmt.Errorf("sid %d already holds a subscription; unsubscribe first", sid)
	}
	leaf, _, _ := h.walk(pat.Tokens, true)
	if leaf.entries == nil {
		leaf.entries = map[subKey]*entry{}
	}
	key := subKey{sess: s.id, sid: sid}
	if _, dup := leaf.entries[key]; dup {
		return wire.CodeDupSub, fmt.Errorf("sid %d already subscribed to %s", sid, pattern)
	}
	leaf.entries[key] = &entry{sid: sid, sess: s}
	s.remember(sid, pattern)
	return 0, nil
}

// unsubscribe removes (session, sid). Code mirrors subscribe's contract.
func (h *Hub) unsubscribe(s *session, sid uint32) (byte, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.removeLocked(s, sid)
}

// removeLocked is the unlocked core; callers hold h.mu.
func (h *Hub) removeLocked(s *session, sid uint32) (byte, error) {
	pattern := s.sidOwner(sid)
	if pattern == "" {
		return wire.CodeNoSub, fmt.Errorf("no subscription for sid %d", sid)
	}
	pat, err := subjects.Parse(pattern)
	if err != nil {
		// The pattern parsed when subscribed; failing now means repo drift.
		return wire.CodeMalformed, fmt.Errorf("stored pattern no longer parses (this is a server bug): %w", err)
	}
	leaf, steps, _ := h.walk(pat.Tokens, false)
	if leaf == nil {
		return wire.CodeMalformed, fmt.Errorf("subscription tree lost sid %d (this is a server bug)", sid)
	}
	delete(leaf.entries, subKey{sess: s.id, sid: sid})
	s.forget(sid)
	h.prune(leaf, steps)
	return 0, nil
}

// walkStep records how the walk descended, so pruning can climb back up and
// detach the exact same edges.
type walkStep struct {
	parent *node
	via    string // the token text for exact edges
	branch byte   // 'x' exact, 's' star, 'g' greater
}

// walk descends the trie along tokens, creating missing exact/branch nodes
// (create differs from lookup only in the missing-child branch, which tracks
// whether the walk landed short). Returns the leaf (nil if the walk landed
// short — only possible without creation), the edge record for pruning, and
// how many edges were created during this walk.
func (h *Hub) walk(tokens []string, create bool) (*node, []walkStep, int) {
	cur := h.root
	steps := make([]walkStep, 0, len(tokens))
	created := 0
	for _, tok := range tokens {
		var child *node
		branch := byte('x')
		switch tok {
		case "*":
			child, branch = cur.star, 's'
		case ">":
			child, branch = cur.greater, 'g'
		default:
			child = cur.exact[tok]
		}
		if child == nil {
			if !create {
				return nil, steps, created
			}
			child = &node{}
			created++
			switch branch {
			case 's':
				cur.star = child
			case 'g':
				cur.greater = child
			default:
				if cur.exact == nil {
					cur.exact = map[string]*node{}
				}
				cur.exact[tok] = child
			}
		}
		steps = append(steps, walkStep{parent: cur, via: tok, branch: branch})
		cur = child
	}
	return cur, steps, created
}

// prune climbs from the leaf upward removing empty nodes, keeping the trie
// bounded under subscription churn. Root is never detached (it is outside
// the step list by construction).
func (h *Hub) prune(leaf *node, steps []walkStep) {
	cur := leaf
	for i := len(steps) - 1; i >= 0; i-- {
		if !nodeEmpty(cur) {
			return
		}
		st := steps[i]
		switch st.branch {
		case 's':
			st.parent.star = nil
		case 'g':
			st.parent.greater = nil
		default:
			delete(st.parent.exact, st.via)
		}
		cur = st.parent
	}
}

func nodeEmpty(nd *node) bool {
	return nd.star == nil && nd.greater == nil && len(nd.exact) == 0 && len(nd.entries) == 0
}

// publish fans one concrete subject out. Payload is shared, immutable after
// the caller's single copy; participants must not mutate it. The subject
// string is joined once — every DELIVER carries the exact text the
// publisher sent, tokens rejoined the only way the charter allows.
// Return: how many subscriptions accepted the message.
func (h *Hub) publish(pub subjects.Subject, payload []byte, reply string, hasReply bool) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var targets []*entry
	collect(h.root, pub.Tokens, 0, &targets)
	subject := strings.Join(pub.Tokens, ".")
	n := 0
	for _, e := range targets {
		if e.sess.deliver(e.sid, subject, payload, reply, hasReply) {
			n++
		}
	}
	return n
}

// collect gathers every terminal entry matching tokens[i:]. Border case the
// tests pin down: a '>' node matches only when at least one token remains to
// consume (pattern "a.>" does NOT catch published "a").
func collect(nd *node, tokens []string, i int, out *[]*entry) {
	if i < len(tokens) && nd.greater != nil {
		for _, e := range nd.greater.entries {
			*out = append(*out, e)
		}
	}
	if i == len(tokens) {
		for _, e := range nd.entries {
			*out = append(*out, e)
		}
		return
	}
	if child, ok := nd.exact[tokens[i]]; ok {
		collect(child, tokens, i+1, out)
	}
	if nd.star != nil {
		collect(nd.star, tokens, i+1, out)
	}
}

// SubView is one row of the operator-facing subscription dump.
type SubView struct {
	Session uint64
	Sid     uint32
	Pattern string
}

// view snapshots every live subscription, deterministic by (session, sid).
// Console and tests read it; hot paths never do (it allocates).
func (h *Hub) view() []SubView {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var out []SubView
	for _, s := range h.sessions {
		out = append(out, s.toView()...)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Session != out[j].Session {
			return out[i].Session < out[j].Session
		}
		return out[i].Sid < out[j].Sid
	})
	return out
}
