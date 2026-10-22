package client

import (
	"context"
	"fmt"

	"github.com/SukrutN/switchyard/internal/wire"
)

// The console API (§2.24–§2.27): the two read-only round-trips an operator
// drives from spur. Same turn-taking as every synchronous call here — one
// mutex, one reply slot, refusals surface as Go errors while Errors() keeps
// a copy for listeners. Nothing here mutates the yard; the console is a
// lens, not a lever.

// LaneSeq is one row of the yard summary: a lane and its last journaled
// sequence (0 for a lane with no rows).
type LaneSeq struct {
	Name string
	Seq  uint64
}

// YardState is the yard's summary as YARD_STATE carried it: build, uptime,
// live sessions, the lane table ascending, and the lanes whose writes have
// failed (quarantined until restart) named in full.
type YardState struct {
	Version     string
	UptimeSec   uint64
	Sessions    uint32
	Lanes       []LaneSeq
	Quarantined []string
}

// ConsumerState is one row of the lane drill-down: durable floor (the
// number the consumer resumes from), delivered rows still owing acks, and
// whether a session is attached right now.
type ConsumerState struct {
	Name     string
	Floor    uint64
	Pending  uint32
	Attached bool
}

// LaneState is one lane's detail: journaled seq, quarantine flag, the
// journal's byte size, live key count, and the consumer table ascending.
type LaneState struct {
	Lane         string
	Seq          uint64
	Quarantined  bool
	JournalBytes uint64
	KeyCount     uint32
	Consumers    []ConsumerState
}

// YardInfo reads the yard's summary. It works on any handshaked yard,
// memory-only included — a summary with zero lanes is still an answer.
func (c *Client) YardInfo(ctx context.Context) (YardState, error) {
	c.rpcMu.Lock()
	defer c.rpcMu.Unlock()

	state := make(chan wire.YardState, 1)
	c.yardSet.Store(&state)
	defer func() {
		c.yardSet.Store(nil)
		select {
		case <-state:
		default:
		}
	}()
	errSlot := c.installRPCErr()
	defer c.clearRPCErr()

	body, err := wire.EncodeYardInfo(wire.YardInfo{})
	if err != nil {
		return YardState{}, err
	}
	if err := c.write(wire.OpYardInfo, body); err != nil {
		return YardState{}, fmt.Errorf("send yard info: %w", err)
	}
	select {
	case y := <-state:
		out := YardState{
			Version:     y.Version,
			UptimeSec:   y.UptimeSec,
			Sessions:    y.Sessions,
			Quarantined: append([]string(nil), y.Quarantined...),
		}
		for _, row := range y.Lanes {
			out.Lanes = append(out.Lanes, LaneSeq{Name: row.Name, Seq: row.Seq})
		}
		return out, nil
	case e := <-errSlot:
		return YardState{}, e
	case <-ctx.Done():
		return YardState{}, fmt.Errorf("yard info: %w", ctx.Err())
	case <-c.done:
		return YardState{}, fmt.Errorf("yard info: session closed")
	}
}

// LaneInfo reads one lane's drill-down. Unknown lanes are refusals, not
// empty answers — absence is a fact an operator acts on.
func (c *Client) LaneInfo(ctx context.Context, lane string) (LaneState, error) {
	c.rpcMu.Lock()
	defer c.rpcMu.Unlock()

	state := make(chan wire.LaneState, 1)
	c.laneSet.Store(&state)
	defer func() {
		c.laneSet.Store(nil)
		select {
		case <-state:
		default:
		}
	}()
	errSlot := c.installRPCErr()
	defer c.clearRPCErr()

	body, err := wire.EncodeLaneInfo(wire.LaneInfo{Lane: lane})
	if err != nil {
		return LaneState{}, err
	}
	if err := c.write(wire.OpLaneInfo, body); err != nil {
		return LaneState{}, fmt.Errorf("send lane info: %w", err)
	}
	select {
	case l := <-state:
		out := LaneState{
			Lane:         l.Lane,
			Seq:          l.Seq,
			Quarantined:  l.Quarantined,
			JournalBytes: l.JournalBytes,
			KeyCount:     l.KeyCount,
		}
		for _, row := range l.Consumers {
			out.Consumers = append(out.Consumers, ConsumerState{
				Name:     row.Name,
				Floor:    row.Floor,
				Pending:  row.Pending,
				Attached: row.Attached,
			})
		}
		return out, nil
	case e := <-errSlot:
		return LaneState{}, e
	case <-ctx.Done():
		return LaneState{}, fmt.Errorf("lane info %s: %w", lane, ctx.Err())
	case <-c.done:
		return LaneState{}, fmt.Errorf("lane info %s: session closed", lane)
	}
}
