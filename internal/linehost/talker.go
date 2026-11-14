package linehost

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/SukrutN/switchyard/internal/client"
	"github.com/SukrutN/switchyard/internal/wire"
)

// The host command block's wire addresses — fluxline-plc, docs/06. The
// numbers are the contract; the ST lives in the other repo.
const (
	RegHBHost    uint16 = 40 // heartbeat, host-written, change = alive
	RegCmdSeq    uint16 = 41 // command tag, edge-ingested, 0 idle
	RegCmdCode   uint16 = 42 // 1 release-override, 2 release-per-law
	RegCmdGate   uint16 = 43 // 1 L01, 2 L02, 3 L03, 4 RJ
	RegCmdClass  uint16 = 44 // claimed law class, 0 = any
	RegAckSeq    uint16 = 45 // ack block: seq, state, gate, class
	RegHostState uint16 = 49 // bit0 armed bit1 live bit2 fallback bit3 veto

	CodeOverride = 1
	CodePerLaw   = 2
)

var ackNames = map[uint16]string{
	0: "armed",
	1: "accepted",
	2: "vetoed",
	3: "refused",
	4: "expired",
}

// Work is one work item off the lane: "release the next piece toward gate
// G" (Law set: whatever gate the floor's law picks). Class is the host's
// claim about the payload — the floor checks it at the load cell.
type Work struct {
	ID    string `json:"id"`
	Gate  uint16 `json:"gate"`
	Class uint16 `json:"class"`
	Law   bool   `json:"law,omitempty"`
}

// Verdict is the receipt the talker journals back to the lane.
type Verdict struct {
	ID        string `json:"id"`
	Seq       uint16 `json:"seq"`
	State     string `json:"state"`
	Gate      uint16 `json:"gate"`
	Class     uint16 `json:"class"`
	LatencyMS int64  `json:"latency_ms"`
	At        string `json:"at"`
}

// Config tunes the talker. Zero values are workable.
type Config struct {
	LineAddr    string        // the line's register server (default 127.0.0.1:1502)
	Unit        byte          // Modbus unit id (default 1)
	Lane        string        // lane name (default "fluxline")
	Release     string        // subject work items ride (default "fluxline.release")
	Verdicts    string        // subject verdicts journal under (default "fluxline.verdict")
	Consumer    string        // durable consumer name (default "linehost")
	HBEvery     time.Duration // heartbeat cadence (default 500ms - the contract's 1-2 Hz)
	Patience    time.Duration // how long a pending command may go unacked (default 90s)
	LineTimeout time.Duration // per-request Modbus budget (default 2s)
	Log         *slog.Logger
}

func (c *Config) withDefaults() {
	if c.LineAddr == "" {
		c.LineAddr = "127.0.0.1:1502"
	}
	if c.Unit == 0 {
		c.Unit = 1
	}
	if c.Lane == "" {
		c.Lane = "fluxline"
	}
	if c.Release == "" {
		c.Release = c.Lane + ".release"
	}
	if c.Verdicts == "" {
		c.Verdicts = c.Lane + ".verdict"
	}
	if c.Consumer == "" {
		c.Consumer = "linehost"
	}
	if c.HBEvery <= 0 {
		c.HBEvery = 500 * time.Millisecond
	}
	if c.Patience <= 0 {
		c.Patience = 90 * time.Second
	}
	if c.LineTimeout <= 0 {
		c.LineTimeout = 2 * time.Second
	}
}

// Talker bridges one lane to one line. One work item in flight at a time —
// the floor refuses a second command while one is armed, so the talker
// queues and lets the lane hold the rest durably.
type Talker struct {
	cfg     Config
	yard    *client.Client
	line    *Line
	log     *slog.Logger
	sid     uint32
	pending *pending // the command on the wire, if any
	queue   []queued
	seen    map[uint64]struct{} // lane seqs already queued; sweeper redeliveries
	seq     uint16              // CMD_SEQ counter, incremented per command
	hb      uint16              // heartbeat word, incremented per cycle
	now     func() time.Time    // test seam
}

type queued struct {
	seq  uint64 // the lane position this item rode in on
	d    client.LaneDelivery
	work Work
}

// pending is one command on the wire, awaiting the floor's word.
type pending struct {
	work Work
	seq  uint16
	dseq uint64
	t0   time.Time
}

// New wires the talker to a live yard session. Dial the yard first; Run
// dials the line.
func New(cfg Config, yard *client.Client) *Talker {
	cfg.withDefaults()
	log := cfg.Log
	if log == nil {
		log = slog.Default()
	}
	return &Talker{
		cfg:  cfg,
		yard: yard,
		log:  log,
		sid:  7,
		seen: map[uint64]struct{}{},
		now:  time.Now,
	}
}

// Run serves until ctx ends: heartbeat, poll, arm, journal. Every error is
// logged and survived — a dark line or a dark yard must not kill the host.
func (t *Talker) Run(ctx context.Context) error {
	if err := t.ensureLane(ctx); err != nil {
		return err
	}
	next, _, err := t.yard.StreamAttach(ctx, t.cfg.Lane, t.cfg.Consumer, t.sid, 0, t.cfg.Release)
	if err != nil {
		return fmt.Errorf("attach consumer: %w", err)
	}
	t.log.Info("attached", "lane", t.cfg.Lane, "consumer", t.cfg.Consumer, "next", next)

	if t.line, err = DialLine(t.cfg.LineAddr, t.cfg.Unit, t.cfg.LineTimeout); err != nil {
		return err
	}
	defer t.line.Close()

	hb := time.NewTicker(t.cfg.HBEvery)
	defer hb.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case d := <-t.yard.LaneDeliveries():
			t.onDelivery(d)
		case <-hb.C:
			t.cycle(ctx)
		case e := <-t.yard.Errors():
			t.log.Warn("yard refusal", "code", e.Code, "message", e.Message)
		}
	}
}

// ensureLane creates the lane, tolerating the one refusal that means
// "already there" — a restart joins its own lane's journal.
func (t *Talker) ensureLane(ctx context.Context) error {
	err := t.yard.StreamCreate(ctx, t.cfg.Lane)
	if err == nil {
		t.log.Info("created lane", "lane", t.cfg.Lane)
		return nil
	}
	if ce, ok := err.(client.ClientError); ok && ce.Code == wire.CodeStreamExists {
		return nil
	}
	return fmt.Errorf("create lane %q: %w", t.cfg.Lane, err)
}

// onDelivery files one work item. Duplicates (sweeper redeliveries of
// unacked work) are recognized and dropped; the ack happens only when the
// item's verdict is journaled.
func (t *Talker) onDelivery(d client.LaneDelivery) {
	if _, dup := t.seen[d.Seq]; dup {
		return
	}
	var work Work
	if err := json.Unmarshal(d.Payload, &work); err != nil {
		t.log.Warn("unreadable work item", "seq", d.Seq, "error", err)
		t.ackLane(d.Seq)
		return
	}
	if work.ID == "" {
		work.ID = "seq-" + strconv.FormatUint(d.Seq, 10)
	}
	t.seen[d.Seq] = struct{}{}
	t.queue = append(t.queue, queued{seq: d.Seq, d: d, work: work})
	t.log.Info("queued", "id", work.ID, "lane_seq", d.Seq, "gate", work.Gate, "law", work.Law)
}

// cycle is one heartbeat: publish the heartbeat word, poll the ack block,
// journal anything that resolved, and arm the next item if the floor is
// free. A command frame carries the heartbeat in the same write, so an
// in-flight release never starves the watchdog.
func (t *Talker) cycle(ctx context.Context) {
	t.hb++
	if t.hb > 32000 {
		t.hb = 1
	}
	if t.line == nil {
		return
	}
	if t.pending != nil {
		t.pollPending(ctx)
	}
	if t.pending == nil && len(t.queue) > 0 && t.arm() {
		return // the command frame already carried this cycle's heartbeat
	}
	if err := t.line.WriteRegs(RegHBHost, t.hb); err != nil {
		t.log.Warn("heartbeat write failed", "error", err)
	}
}

// pollPending reads the ack block and journals the verdict, whatever it
// turned out to be - accepted, vetoed, refused, expired. The floor's word
// is the receipt; the host never argues with it.
func (t *Talker) pollPending(ctx context.Context) {
	p := t.pending
	acks, err := t.line.ReadRegs(RegAckSeq, 4)
	if err != nil {
		t.log.Warn("ack read failed", "error", err)
		if t.now().Sub(p.t0) > t.cfg.Patience {
			t.expire(ctx, p)
		}
		return
	}
	if acks[0] != p.seq || acks[1] == 0 {
		// still armed (or the block moved on without us)
		if acks[0] != p.seq && acks[0] != 0 {
			t.log.Warn("ack seq mismatch", "want", p.seq, "got", acks[0])
		}
		if t.now().Sub(p.t0) > t.cfg.Patience {
			t.expire(ctx, p)
		}
		return
	}
	v := Verdict{
		ID:        p.work.ID,
		Seq:       p.seq,
		State:     ackNames[acks[1]],
		Gate:      acks[2],
		Class:     acks[3],
		LatencyMS: t.now().Sub(p.t0).Milliseconds(),
		At:        t.now().UTC().Format(time.RFC3339),
	}
	t.journal(ctx, v, p)
}

// expire journals the honest version of giving up: the command never got
// its receipt, so the verdict says expired, not accepted.
func (t *Talker) expire(ctx context.Context, p *pending) {
	v := Verdict{
		ID:        p.work.ID,
		Seq:       p.seq,
		State:     "expired",
		LatencyMS: t.now().Sub(p.t0).Milliseconds(),
		At:        t.now().UTC().Format(time.RFC3339),
	}
	t.log.Warn("pending expired", "id", p.work.ID)
	t.journal(ctx, v, p)
}

// arm writes the next command block: one FC16 frame carrying heartbeat,
// seq, code, gate and class - the block lands whole or not at all.
// Reports whether the command went out (a failed write is retried on the
// next cycle by leaving the item queued).
func (t *Talker) arm() bool {
	q := t.queue[0]
	t.seq++
	if t.seq == 0 {
		t.seq = 1
	}
	code := uint16(CodeOverride)
	if q.work.Law {
		code = CodePerLaw
	}
	vals := []uint16{t.hb, t.seq, code, q.work.Gate, q.work.Class}
	if err := t.line.WriteRegs(RegHBHost, vals...); err != nil {
		t.log.Warn("command write failed", "id", q.work.ID, "error", err)
		t.seq--
		return false // the item stays queued; the next cycle tries again
	}
	t.queue = t.queue[1:]
	t.pending = &pending{work: q.work, seq: t.seq, dseq: q.seq, t0: t.now()}
	t.log.Info("armed", "id", q.work.ID, "seq", t.seq, "code", code,
		"gate", q.work.Gate, "class", q.work.Class)
	return true
}

// journal publishes the verdict receipt and only then acks the lane - a
// crash before the ack replays the work item; a crash after is a
// delivered receipt. At-least-once is the honest order.
func (t *Talker) journal(ctx context.Context, v Verdict, p *pending) {
	body, err := json.Marshal(v)
	if err != nil {
		t.log.Error("verdict marshal", "error", err)
		return
	}
	if _, err := t.yard.StreamPublish(ctx, t.cfg.Lane, t.cfg.Verdicts, body); err != nil {
		t.log.Error("verdict publish failed; work stays unacked for redelivery",
			"id", v.ID, "error", err)
		return
	}
	t.log.Info("verdict", "id", v.ID, "seq", v.Seq, "state", v.State,
		"gate", v.Gate, "class", v.Class, "latency_ms", v.LatencyMS)
	t.pending = nil
	t.ackLane(p.dseq)
	delete(t.seen, p.dseq)
}

func (t *Talker) ackLane(seq uint64) {
	if err := t.yard.LaneAck(t.sid, seq); err != nil {
		t.log.Warn("lane ack failed", "seq", seq, "error", err)
	}
}
