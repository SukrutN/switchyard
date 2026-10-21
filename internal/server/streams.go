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

// validKVKey is the §3.2 charter in one place: dots and slashes are ordinary
// key bytes (keys are never subjects and never directories), so the class is
// §3.1's grown by two signs and bounded by wire.MaxKeyLen.
func validKVKey(key string) bool {
	if len(key) == 0 || len(key) > wire.MaxKeyLen {
		return false
	}
	for i := 0; i < len(key); i++ {
		c := key[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '_', c == '-', c == '.', c == '/':
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
	r := &laneRegistry{
		byName:   make(map[string]*stream),
		syncEach: syncEach,
		log:      log,
	}
	if dataDir != "" {
		r.root = filepath.Join(dataDir, "streams")
	}
	return r
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
	st.kvi = make(map[string]kvEntry)
	// The KV index is a boot-time replay of the journal's KV rows: whatever
	// the last set said for each key, minus every tombstone after it, is the
	// bucket. Live writes under st.mu keep it current from here on.
	if err := j.forEachRecord(func(seq uint64, rec journalRecord) bool {
		switch rec.Kind {
		case KindKVSet:
			st.kvi[rec.Key] = kvEntry{seq: seq, val: rec.Payload}
		case KindKVDelete:
			delete(st.kvi, rec.Key)
		}
		return false
	}); err != nil {
		j.close()
		return nil, err
	}
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

// shutdown closes every journal handle at server Stop. Positions and bytes
// were fsynced at their write time; nothing more is owed to disk.
func (r *laneRegistry) shutdown() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, st := range r.byName {
		_ = st.j.close()
	}
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
	kvi         map[string]kvEntry // live keys; the journal's KV rows are the truth, this is the index

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
	rec := journalRecord{Kind: KindStreamMessage, Subject: strings.Join(sub.Tokens, "."), Reply: reply, Payload: payload, HasReply: hasReply}
	if err := st.j.appendOne(rec, seq, st.syncOne); err != nil {
		st.quarantined = true // a lane whose bytes are not trusted stops pretending
		return 0, wire.CodeServerFault, fmt.Errorf("journal write for lane %q: %w", st.name, err)
	}
	st.seq = seq
	st.fanOutLocked(seq, sub, rec)
	return seq, 0, nil
}

// kvEntry is one live key in the lane's in-memory index. val is a private
// copy: the session bytes die with their buffer, the key outlives them.
type kvEntry struct {
	seq uint64
	val []byte
}

// kvSet journals a key-value pair under the lane's own sequence law, then
// mirrors it into the index. Receipt discipline is the same as publish:
// fsync first, the answer can only mean "the bytes are on disk". No fan-out:
// KV rows are journal rows of their own kind, and consumers attached to the
// lane never see them (§2.18).
func (st *stream) kvSet(key string, payload []byte) (uint64, byte, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.quarantined {
		return 0, wire.CodeServerFault, errors.New("this lane's writes already failed once; storing further messages would lie about durability")
	}
	seq := st.seq + 1
	rec := journalRecord{Kind: KindKVSet, Key: key, Payload: payload}
	if err := st.j.appendOne(rec, seq, st.syncOne); err != nil {
		st.quarantined = true // a lane whose bytes are not trusted stops pretending
		return 0, wire.CodeServerFault, fmt.Errorf("journal write for lane %q: %w", st.name, err)
	}
	st.seq = seq
	st.kvi[key] = kvEntry{seq: seq, val: payload}
	return seq, 0, nil
}

// kvDelete journals the tombstone whether or not the key exists — deletes
// are facts worth journaling even when a key did not (§2.20) — and drops it
// from the index. The receipt names the tombstone's own sequence.
func (st *stream) kvDelete(key string) (uint64, byte, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.quarantined {
		return 0, wire.CodeServerFault, errors.New("this lane's writes already failed once; storing further messages would lie about durability")
	}
	seq := st.seq + 1
	rec := journalRecord{Kind: KindKVDelete, Key: key}
	if err := st.j.appendOne(rec, seq, st.syncOne); err != nil {
		st.quarantined = true
		return 0, wire.CodeServerFault, fmt.Errorf("journal write for lane %q: %w", st.name, err)
	}
	st.seq = seq
	delete(st.kvi, key)
	return seq, 0, nil
}

// kvGet reads one live key from the index. A miss — never set, or the tomb-
// stone won — answers found=false: an answer, not an error (§2.19).
func (st *stream) kvGet(key string) (uint64, []byte, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	e, ok := st.kvi[key]
	if !ok {
		return 0, nil, false
	}
	return e.seq, e.val, true
}

// kvKeys lists the index's live keys, ascending bytewise: one lane, one
// order, every caller (§2.23).
func (st *stream) kvKeys() []string {
	st.mu.Lock()
	defer st.mu.Unlock()
	keys := make([]string, 0, len(st.kvi))
	for key := range st.kvi {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
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
		if c.held {
			// Attach in progress: credit the ledger, deliver nothing yet.
			// The replay that follows the READY frame will send it.
			c.pending[seq] = time.Now()
			continue
		}
		c.pending[seq] = time.Now()
		c.sess.deliverLane(c.sid, seq, rec.Subject, rec.Payload, rec.Reply, rec.HasReply)
	}
}

// reserve opens (or resumes) the consumer's durable attachment and holds
// its deliveries. Phase one of attach: the READY frame must reach the wire
// before any replayed delivery, so reserve computes the position, persists
// it, and marks the consumer held — fan-out keeps crediting pending entries
// but sends nothing. beginReplay releases the hold and queues everything
// owed, in lane order, on the session's delivery queue behind the READY.
// A consumer name unknown to the lane starts fresh at the lane's beginning.
func (st *stream) reserve(s *session, sid uint32, cName string, filter *subjects.Subject, ackWait time.Duration) (uint64, *consumer, byte, error) {
	if sid == 0 {
		return 0, nil, wire.CodeBadSubject, fmt.Errorf("sid 0 is reserved")
	}
	if s.sidTaken(sid) {
		return 0, nil, wire.CodeDupConsumer, fmt.Errorf("sid %d already holds a subscription; one sid, one thing", sid)
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	c := st.consumers[cName]
	if c == nil {
		c = &consumer{name: cName, filter: filter, ackWait: ackWait, pending: map[uint64]time.Time{}}
		st.consumers[cName] = c
	} else {
		if c.sess != nil {
			if c.sess.dead() {
				// The session is a corpse that has not reached its own
				// detachAllLanes yet — consumer attachments never belong
				// to the dead. Reclaim the attachment and its sweeper.
				if c.sweeperStop != nil {
					close(c.sweeperStop)
					c.sweeperStop = nil
				}
				c.sess = nil
			} else if c.sess != s {
				return 0, nil, wire.CodeDupConsumer, fmt.Errorf("consumer %q is live on another session; detach first or wait for it to die", cName)
			} else {
				return 0, nil, wire.CodeDupConsumer, fmt.Errorf("consumer %q is already attached by another sid of this session", cName)
			}
		}
		if nameChangedFilter(c.filter, filter) {
			return 0, nil, wire.CodeDupConsumer, fmt.Errorf("consumer %q keeps its original filter; attach with the pattern it was born with", cName)
		}
		c.ackWait = ackWait
	}
	c.sess = s
	c.sid = sid
	c.held = true

	// Fresh consumer, zero obligations: the whole lane history is owed —
	// that is what durability is for. Every other case resumes. The
	// smallest pending entry can predate the floor only across a filter;
	// start there when one does.
	start := c.floor + 1
	if len(c.pending) > 0 {
		if mp := minPending(c.pending); mp < start {
			start = mp
		}
	}

	if err := st.persistConsumerLocked(c); err != nil {
		st.log.Warn("consumer state write failed", "lane", st.name, "consumer", cName, "err", err)
	}
	stop := make(chan struct{})
	c.sweeperStop = stop
	go st.runSweeper(c, stop, sweepInterval(ackWait))
	return start, c, 0, nil
}

// beginReplay flows everything the consumer is owed onto its session's
// delivery queue, ascending, and lifts the hold. Fresh window entries that
// match the filter get first delivery now — they might have arrived while
// no consumer was attached; the filter decides, the ledger no longer will.
// A lane deleted between the two phases answers with a refusal; the
// STREAM_GONE already queued will explain it.
func (st *stream) beginReplay(c *consumer) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.quarantined {
		c.held = false
		return fmt.Errorf("lane %q was deleted or quarantined mid-attach", st.name)
	}
	c.held = false
	return st.replayWindowLocked(c)
}

// replayWindowLocked is the shared heart of attach and post-hold fan-out:
// every owed sequence in lane order, redelivering pending rows and claiming
// fresh matches. Caller holds st.mu.
func (st *stream) replayWindowLocked(c *consumer) error {
	start := c.floor + 1
	if len(c.pending) > 0 {
		if mp := minPending(c.pending); mp < start {
			start = mp
		}
	}
	err := st.j.forEachRecord(func(seqNo uint64, rec journalRecord) bool {
		if seqNo < start || seqNo > st.seq {
			return false
		}
		if rec.Kind != KindStreamMessage {
			return false // KV rows and strangers journal here; they never deliver
		}
		if _, is := c.pending[seqNo]; !is {
			// Not owed before, not filtered out: only deliver it if the
			// consumer's filter catches it, then treat it as pending like
			// any first delivery.
			if c.filter != nil {
				psub, perr := subjects.Parse(rec.Subject)
				if perr != nil || !subjects.Match(*c.filter, psub) {
					return false
				}
			}
			c.pending[seqNo] = time.Now()
		} else {
			c.pending[seqNo] = time.Now() // redelivery resets the ack clock
		}
		s := c.sess
		if s == nil || s.dead() {
			return false
		}
		s.deliverLane(c.sid, seqNo, rec.Subject, rec.Payload, rec.Reply, rec.HasReply)
		return false
	})
	if err != nil {
		return fmt.Errorf("journal replay: %w", err)
	}
	return nil
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
	c.held = false
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
// private stop channel and a caller-computed interval — the goroutine never
// reads consumer fields that attach/detach rewrite, so there is no data
// race on the handshake — and exits the moment detach closes it. The
// pending set persists regardless.
func (st *stream) runSweeper(c *consumer, stop chan struct{}, interval time.Duration) {
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

// sweepInterval clusters the redelivery checks at a quarter of the wait,
// clamped to a range that is responsive without burning a core.
func sweepInterval(ackWait time.Duration) time.Duration {
	if ackWait <= 0 {
		return 100 * time.Millisecond
	}
	interval := ackWait / 4
	if interval < 10*time.Millisecond {
		interval = 10 * time.Millisecond
	}
	if interval > time.Second {
		interval = time.Second
	}
	return interval
}

// sweepOnce re-delivers overdue entries: pending sequences older than the
// consumer's ackWait get their clock reset and are re-sent, lane order held.
// Fresh entries (delivered within ackWait) wait their turn; the sweep never
// delivers a sequence the consumer still has time to ack.
func (st *stream) sweepOnce(c *consumer) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if c.held || c.sess == nil || c.sess.dead() {
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
		if rec.Kind != KindStreamMessage {
			return false // the ledger only ever held stream rows; keep it that way
		}
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
// the durable state; attachment (sess/sid) is the live one; held marks the
// window between reserve and READY-on-the-wire, during which fan-out may
// only credit the ledger, never deliver.
type consumer struct {
	name    string
	floor   uint64
	pending map[uint64]time.Time
	filter  *subjects.Subject
	ackWait time.Duration
	held    bool

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

// notifyLaneGone tells every session holding a consumer on a deleted lane —
// except the deleter, whose own confirm is already its goodbye — and frees
// their sids. Called from the deleting session's dispatch with the registry
// already swept.
func notifyLaneGone(h *Hub, skip *session, name string) {
	h.eachSession(func(s *session) {
		s.mu.Lock()
		heldOwn := false
		for sid, ref := range s.lanes {
			if ref.lane == name {
				delete(s.lanes, sid)
				heldOwn = true
			}
		}
		s.mu.Unlock()
		if s == skip {
			return // the deleting session's goodbye is its own confirm
		}
		if heldOwn && !s.dead() {
			if body, err := wire.EncodeStreamGone(wire.StreamGone{Name: name}); err == nil {
				s.pushCtl(wire.OpStreamGone, body, false)
			}
		}
	})
}
