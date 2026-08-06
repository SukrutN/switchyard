package server

// Lanes: the registry, the streams themselves, and the durable consumers.
//
// Shape decisions worth remembering:
//
//   - one stream == one directory == one append-only journal. In-memory
//     state (seq, consumer positions) rebuilds from it; nothing reconstructs
//     a deleted lane because its files are the lane.
//   - ONE lock (st.mu) serializes sequence assignment, journal write with
//     fsync, consumer bookkeeping, and replay. Deliveries are therefore
//     monotone in lane-seq per consumer by construction — the receipt an
//     operator reads and the order a consumer observes come from the same
//     critical section, not from luck.
//   - consumers are push-style: attach, replay from the durable floor +
//     pending set, deliver with the lane's seq, ack back, replay again on
//     re-attach or ackWait expiry. Exactly-one goroutine per attached
//     consumer owns its redelivery timer; detach closes it.
//   - a lane publishes twice, once to lanes' consumers and once to the hub
//     (the spurs), deliberately: the spur is "at most once, no promises",
//     the lane is "at least once, numbered". Lock order is st.mu → never
//     hub.mu, so publish cannot deadlock fan-out paths.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/SukrutN/switchyard/internal/subjects"
	"github.com/SukrutN/switchyard/internal/wire"
)

// validLaneName is the §3.1 charter in one place. [A-Za-z0-9_-] because the
// name becomes a directory; anything a filesystem would treat as a path is
// chartered out here, at every entry point, once and finally.
func validLaneName(name string) bool {
	if len(name) == 0 || len(name) > wire.MaxStreamName {
		return false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '-':
		default:
			return false
		}
	}
	return true
}

// laneRegistry owns every stream the yard journals. It is the only entry
// point sessions use to touch lanes; the map lock protects names, the st.mu
// inside each stream protects content.
type laneRegistry struct {
	mu       sync.Mutex
	byName   map[string]*stream
	root     string // <DataDir>/streams; "" disables lanes outright
	syncEach bool   // fsync per record; false only when the operator chose so
	log      *slog.Logger
}

func newLaneRegistry(dataDir string, syncEach bool, log *slog.Logger) *laneRegistry {
	if log == nil {
		log = slog.Default()
	}
	return &laneRegistry{
		byName:   make(map[string]*stream),
		root:     filepath.Join(dataDir, "streams"),
		syncEach: syncEach,
		log:      log,
	}
}

// enabled reports whether the registry may serve lanes at all.
func (r *laneRegistry) enabled() bool { return r.root != "" }

// load walks the data dir and re-opens every intact lane. Called once at
// server construction, before any accept. A lane that fails to recover is
// left on disk untouched and named in the log — the operator decides.
func (r *laneRegistry) load() int {
	entries, err := os.ReadDir(r.root)
	if err != nil {
		return 0 // no streams dir yet: nothing to restore
	}
	loaded := 0
	for _, e := range entries {
		if !e.IsDir() || !validLaneName(e.Name()) {
			continue
		}
		st, err := r.openLane(e.Name())
		if err != nil {
			r.log.Warn("lane recovery skipped", "lane", e.Name(), "err", err)
			continue
		}
		r.byName[e.Name()] = st
		loaded++
	}
	return loaded
}

// openLane rehydrates one lane: journal for the record log, one state file
// per consumer for positions.
func (r *laneRegistry) openLane(name string) (*stream, error) {
	dir := filepath.Join(r.root, name)
	j, err := openJournal(dir)
	if err != nil {
		return nil, err
	}
	st := &stream{
		name:    name,
		dir:     dir,
		j:       j,
		seq:     j.lastSeq,
		syncOne: r.syncEach,
		log:     r.log,
	}
	st.consumers = make(map[string]*consumer)
	cDir := filepath.Join(dir, "consumers")
	if cEntries, cerr := os.ReadDir(cDir); cerr == nil {
		for _, ce := range cEntries {
			cn := strings.TrimSuffix(ce.Name(), ".state")
			if !validLaneName(cn) {
				continue // not ours; leave the file alone
			}
			floor, pending, ok := readConsumerState(dir, cn)
			if !ok {
				r.log.Warn("consumer state unreadable; starting that consumer fresh", "lane", name, "consumer", cn)
				continue
			}
			st.consumers[cn] = &consumer{
				name:    cn,
				floor:   floor,
				pending: pendingSetOf(pending),
			}
		}
	}
	return st, nil
}

// create opens a fresh lane and returns the sequence the next publish gets.
// A name whose files survived a delete recovers here: create is recovery's
// second chance, which the journal header makes honest from byte one.
func (r *laneRegistry) create(name string) (uint64, byte, error) {
	if !r.enabled() {
		return 0, wire.CodeStreamDisabled, fmt.Errorf("this yard has no data dir; lanes stay off until one is configured")
	}
	if !validLaneName(name) {
		return 0, wire.CodeBadStreamName, fmt.Errorf("lane name %q is off the §3.1 charter", name)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.byName[name]; dup {
		return 0, wire.CodeStreamExists, fmt.Errorf("lane %q already journals subjects; nothing to create", name)
	}
	st, err := r.openLane(name)
	if err != nil {
		return 0, wire.CodeServerFault, fmt.Errorf("open lane %q: %w", name, err)
	}
	r.byName[name] = st
	return st.seq + 1, 0, nil
}

// resolve hands back the live lane or nothing.
func (r *laneRegistry) resolve(name string) *stream {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.byName[name]
}

// deleteLane tears one lane down: files removed, registry entry dropped.
// The stream is quarantined first so a publish that resolved a moment ago
// cannot write into a lane the operator no longer owns.
func (r *laneRegistry) deleteLane(name string) (bool, error) {
	if !validLaneName(name) {
		return false, fmt.Errorf("lane name %q is off the §3.1 charter", name)
	}
	r.mu.Lock()
	st := r.byName[name]
	if st != nil {
		st.mu.Lock()
		st.quarantined = true
		delete(r.byName, name)
		st.mu.Unlock()
	}
	r.mu.Unlock()
	if st == nil {
		return false, nil
	}
	err := st.j.close()
	if rerr := os.RemoveAll(st.dir); rerr != nil && err == nil {
		err = rerr
	}
	if err == nil {
		err = os.Remove(filepath.Join(r.root, name))
	}
	return true, err
}

// stream is one durable lane.
type stream struct {
	name string
	dir  string // <dataDir>/streams/<name>
	j    *journal

	mu          sync.Mutex
	seq         uint64 // highest seq the journal DOES have; next assignment is seq+1
	quarantined bool
	consumers   map[string]*consumer

	syncOne bool
	log     *slog.Logger
}

// nextSeq reports the number the lane would assign next.
func (st *stream) nextSeq() uint64 {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.seq + 1
}

// publishAndFanOut is the entire server half of STREAM_PUBLISH under one
// lock: seq assign, journal write (+fsync), consumer fan-out. The receipt
// goes back to the publishing session's writer after this returns, so the
// answer can only mean "the bytes are on disk".
func (st *stream) publishAndFanOut(sub subjects.Subject, payload []byte, reply string, hasReply bool) (uint64, byte, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.quarantined {
		return 0, wire.CodeServerFault, errors.New("this lane's writes already failed once; storing further messages would lie about durability")
	}
	seq := st.seq + 1
	rec := journalRecord{Subject: strings.Join(sub.Tokens, "."), Reply: reply, Payload: payload, HasReply: hasReply}
	if err := st.j.appendOne(rec, seq, st.syncOne); err != nil {
		st.quarantined = true // a lane whose bytes are not trusted stops pretending
		return 0, wire.CodeServerFault, fmt.Errorf("journal write for lane %q: %w", st.name, err)
	}
	st.seq = seq
	st.fanOutLocked(seq, sub, rec)
	return seq, 0, nil
}

// fanOutLocked hands seq to every attached consumer whose filter catches the
// subject. Delivery enqueue is non-blocking: a consumer's session queue is
// bounded by the same contract as spurs (§7), and overflow kills that
// session, not this lane.
func (st *stream) fanOutLocked(seq uint64, sub subjects.Subject, rec journalRecord) {
	for _, c := range st.consumers {
		if c.sess == nil || c.sess.dead() {
			continue
		}
		if c.filter != nil && !subjects.Match(*c.filter, sub) {
			continue
		}
		c.pending[seq] = time.Now()
		c.sess.deliverLane(c.sid, seq, rec.Subject, rec.Payload, rec.Reply, rec.HasReply)
	}
}

// attach makes the consumer live on this session and replays everything the
// consumer still owes: pending entries first (they were delivered to a
// session that did not live to ack them), then the unacked window. Returns
// the first sequence the client should expect — the CONSUMER_READY `next`.
// A consumer name unknown to the lane starts fresh at the lane's beginning.
func (st *stream) attach(s *session, sid uint32, cName string, filter *subjects.Subject, ackWait time.Duration) (uint64, byte, error) {
	if s.sidTaken(sid) {
		return 0, wire.CodeDupConsumer, fmt.Errorf("sid %d already holds a subscription; one sid, one thing", sid)
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	c := st.consumers[cName]
	if c == nil {
		c = &consumer{name: cName, filter: filter, ackWait: ackWait, pending: map[uint64]time.Time{}}
		st.consumers[cName] = c
	} else {
		if c.sess != nil {
			return 0, wire.CodeDupConsumer, fmt.Errorf("consumer %q is live on %s; detach or wait", cName, s.peerName)
		}
		if nameChangedFilter(c.filter, filter) {
			return 0, wire.CodeDupConsumer, fmt.Errorf("consumer %q keeps its original filter; attach with the pattern it was born with", cName)
		}
		c.ackWait = ackWait
	}
	c.sess = s
	c.sid = sid

	// Fresh consumer at zero obligations: the whole lane history is owed,
	// which is what durability is for. Everything else resumes.
	start := c.floor + 1
	if len(c.pending) > 0 {
		if mp := minPending(c.pending); mp < start {
			start = mp
		}
	}

	if err := st.j.forEachRecord(func(seqNo uint64, rec journalRecord) bool {
		if seqNo < start || seqNo > st.seq {
			return false // irrelevant window; keep scanning until start
		}
		if _, is := c.pending[seqNo]; is {
			c.pending[seqNo] = time.Now()
			s.deliverLane(c.sid, seqNo, rec.Subject, rec.Payload, rec.Reply, rec.HasReply)
			return false
		}
		if c.filter != nil {
			psub, perr := subjects.Parse(rec.Subject)
			if perr != nil || !subjects.Match(*c.filter, psub) {
				return false
			}
		}
		c.pending[seqNo] = time.Now()
		s.deliverLane(c.sid, seqNo, rec.Subject, rec.Payload, rec.Reply, rec.HasReply)
		return false
	}); err != nil {
		return 0, wire.CodeServerFault, fmt.Errorf("journal replay for consumer %q: %w", cName, err)
	}

	if err := st.persistConsumerLocked(c); err != nil {
		st.log.Warn("consumer state write failed", "lane", st.name, "consumer", cName, "err", err)
	}
	stop := make(chan struct{})
	c.sweeperStop = stop
	go st.runSweeper(c, stop)
	return start, 0, nil
}

// attach re-attach guard: filter mismatch with a harmless distance. A
// consumer's filter is durable state; changing it would make the resume
// window disagree with itself.
func nameChangedFilter(old, new *subjects.Subject) bool {
	if old == nil {
		return new != nil
	}
	if new == nil {
		return true
	}
	joinedOld := strings.Join(old.Tokens, ".")
	joinedNew := strings.Join(new.Tokens, ".")
	return joinedOld != joinedNew
}

func pendingSetOf(sorted []uint64) map[uint64]time.Time {
	m := make(map[uint64]time.Time, len(sorted))
	for _, seq := range sorted {
		m[seq] = time.Now()
	}
	return m
}

func minPending(m map[uint64]time.Time) uint64 {
	var min uint64
	first := true
	for seq := range m {
		if first || seq < min {
			min = seq
			first = false
		}
	}
	return min
}

// persistConsumerLocked writes the consumer's durable position; caller holds
// st.mu. Pending keys are recorded detached from the map because the state
// file is a whole-snapshot write.
func (st *stream) persistConsumerLocked(c *consumer) error {
	pending := make([]uint64, 0, len(c.pending))
	for seq := range c.pending {
		pending = append(pending, seq)
	}
	sort.Slice(pending, func(i, j int) bool { return pending[i] < pending[j] })
	return writeConsumerState(st.dir, c.name, c.floor, pending)
}

// detachConsumer parks the consumer: position stays, deliveries stop, and
// the sweeper's goroutine ends. The next attach picks everything back up.
func (st *stream) detachConsumer(cName string, s *session) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	c := st.consumers[cName]
	if c == nil || c.sess != s {
		return false
	}
	c.sess = nil
	if c.sweeperStop != nil {
		close(c.sweeperStop)
		c.sweeperStop = nil
	}
	return true
}

// ack advances a consumer. Delivered-and-acked sequences are removed from
// pending, and the floor climbs while the next sequence owes nothing —
// whether it was acked, filtered out, or never sent to anyone. A seq not in
// pending is a no-op by contract (§2.15), answered with silence.
func (st *stream) ack(cName string, s *session, seq uint64) (byte, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	c := st.consumers[cName]
	if c == nil || c.sess != s {
		return wire.CodeNoConsumer, fmt.Errorf("consumer %q is not attached by this session", cName)
	}
	if _, is := c.pending[seq]; !is {
		return 0, nil
	}
	delete(c.pending, seq)
	for c.floor+1 <= st.seq {
		if _, still := c.pending[c.floor+1]; still {
			break
		}
		c.floor++
	}
	if err := st.persistConsumerLocked(c); err != nil {
		st.log.Warn("consumer state write failed", "lane", st.name, "consumer", cName, "err", err)
	}
	return 0, nil
}

// runSweeper replays overdue entries for one attached consumer. It owns a
// private stop channel — the goroutine never reads consumer fields that
// attach/detach rewrite, so there is no data race on the handshake — and
// exits the moment detach closes it. The pending set persists regardless.
func (st *stream) runSweeper(c *consumer, stop chan struct{}) {
	interval := c.ackWait / 4
	if interval < 10*time.Millisecond {
		interval = 10 * time.Millisecond
	}
	if interval > time.Second {
		interval = time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			st.sweepOnce(c)
		}
	}
}

// sweepOnce re-delivers overdue entries: pending sequences older than the
// consumer's ackWait get their clock reset and are re-sent, lane order held.
// Fresh entries (delivered within ackWait) wait their turn; the sweep never
// delivers a sequence the consumer still has time to ack.
func (st *stream) sweepOnce(c *consumer) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if c.sess == nil || c.sess.dead() {
		return
	}
	cutoff := time.Now().Add(-c.ackWait)
	var overdue []uint64
	for seq, at := range c.pending {
		if at.Before(cutoff) {
			overdue = append(overdue, seq)
			c.pending[seq] = time.Now()
		}
	}
	if len(overdue) == 0 {
		return
	}
	replaySet := make(map[uint64]bool, len(overdue))
	for _, seq := range overdue {
		replaySet[seq] = true
	}
	s := c.sess
	st.j.forEachRecord(func(seqNo uint64, rec journalRecord) bool {
		if !replaySet[seqNo] {
			return false
		}
		s.deliverLane(c.sid, seqNo, rec.Subject, rec.Payload, rec.Reply, rec.HasReply)
		return false
	})
}

// laneConsumerTag is what a session remembers about one lane consumer so
// acks route back to the right stream without holding stream pointers.
type laneRef struct {
	lane     string
	consumer string
}

// consumer is one durable reader of one lane. Position (floor + pending) is
// the durable state; attachment (sess/sid) is the live one.
type consumer struct {
	name    string
	floor   uint64
	pending map[uint64]time.Time
	filter  *subjects.Subject
	ackWait time.Duration

	sess *session
	sid  uint32

	sweeperStop chan struct{}
}

// forEachRecord streams journal records in seq order. The lane's lock is the
// caller's job; the read is ReadAt so a concurrent append at EOF cannot
// smear a read in progress.
func (j *journal) forEachRecord(fn func(seq uint64, rec journalRecord) bool) error {
	stBytes, err := j.f.Stat()
	if err != nil {
		return err
	}
	size := stBytes.Size()
	if size <= journalHeaderLen {
		return nil
	}
	raw, err := os.ReadFile(j.f.Name())
	if err != nil {
		return err
	}
	off := int64(journalHeaderLen)
	for off+4 <= int64(size) {
		n := int(binary.BigEndian.Uint32(raw[off : off+4]))
		recEnd := off + 4 + int64(n) + 4
		if n <= 0 || recEnd > int64(size) {
			return nil // tail junk below the record line; recovery cut it instead
		}
		body := raw[off+4 : off+4+int64(n)]
		want := binary.BigEndian.Uint32(raw[off+4+int64(n) : recEnd])
		if crc32.ChecksumIEEE(body) != want {
			return nil // torn record prohibits everything after; recovery cut it
		}
		seq, rec, perr := parseRecordBody(body)
		if perr != nil {
			return nil
		}
		fn(seq, rec)
		off = recEnd
	}
	return nil
}

// notifyLaneGone tells every session holding a consumer on a deleted lane,
// and frees their sids. Called from the deleting session's dispatch with the
// registry already swept.
func notifyLaneGone(h *Hub, name string) {
	h.eachSession(func(s *session) {
		s.mu.Lock()
		for sid, ref := range s.lanes {
			if ref.lane == name {
				delete(s.lanes, sid)
			}
		}
		s.mu.Unlock()
		if !s.dead() {
			if body, err := wire.EncodeStreamGone(wire.StreamGone{Name: name}); err == nil {
				s.pushCtl(wire.OpStreamGone, body, false)
			}
		}
	})
}
