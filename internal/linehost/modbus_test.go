package linehost

import (
	"encoding/binary"
	"io"
	"log/slog"
	"testing"
	"time"
)

func discard() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestReadRegsRoundTrip(t *testing.T) {
	fl := startFakeLine(t)
	fl.mu.Lock()
	fl.regs[45] = 7
	fl.regs[46] = 1
	fl.regs[47] = 2
	fl.regs[48] = 2
	fl.mu.Unlock()

	line, err := DialLine(fl.addr, 1, 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer line.Close()

	regs, err := line.ReadRegs(RegAckSeq, 4)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	want := []uint16{7, 1, 2, 2}
	for i, w := range want {
		if regs[i] != w {
			t.Fatalf("reg %d = %d, want %d", i, regs[i], w)
		}
	}

	// The request PDU must be exactly FC03 + address + count.
	fl.mu.Lock()
	pdu := fl.requests[len(fl.requests)-1]
	fl.mu.Unlock()
	if pdu[0] != 0x03 {
		t.Fatalf("request fc %#x, want 0x03", pdu[0])
	}
	if got := binary.BigEndian.Uint16(pdu[1:]); got != RegAckSeq {
		t.Fatalf("request addr %d, want %d", got, RegAckSeq)
	}
	if got := binary.BigEndian.Uint16(pdu[3:]); got != 4 {
		t.Fatalf("request count %d, want 4", got)
	}
}

func TestWriteRegsCarriesTheCommandBlock(t *testing.T) {
	fl := startFakeLine(t)
	line, err := DialLine(fl.addr, 1, 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer line.Close()

	// heartbeat, seq, code, gate, class — the whole block in one frame
	vals := []uint16{13, 7, CodeOverride, 2, 0}
	if err := line.WriteRegs(RegHBHost, vals...); err != nil {
		t.Fatalf("write: %v", err)
	}
	if fl.writeCount() != 1 {
		t.Fatalf("write count %d, want 1", fl.writeCount())
	}
	w := fl.writes[0]
	if w.addr != RegHBHost {
		t.Fatalf("write addr %d, want %d", w.addr, RegHBHost)
	}
	for i, v := range vals {
		if w.vals[i] != v {
			t.Fatalf("write word %d = %d, want %d", i, w.vals[i], v)
		}
	}
}

func TestExceptionSurfacesByName(t *testing.T) {
	fl := startFakeLine(t)
	fl.mu.Lock()
	fl.failReads = true
	fl.mu.Unlock()

	line, err := DialLine(fl.addr, 1, 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer line.Close()

	_, err = line.ReadRegs(RegAckSeq, 4)
	if err == nil {
		t.Fatal("expected an exception error")
	}
	if got := err.Error(); got != "line refused: illegal address" {
		t.Fatalf("error = %q, want the named exception", got)
	}
}

func TestTxIdsIncrement(t *testing.T) {
	fl := startFakeLine(t)
	line, err := DialLine(fl.addr, 1, 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer line.Close()

	for i := 0; i < 3; i++ {
		if _, err := line.ReadRegs(RegAckSeq, 1); err != nil {
			t.Fatalf("read %d: %v", i, err)
		}
	}
	fl.mu.Lock()
	txs := append([]uint16(nil), fl.txs...)
	fl.mu.Unlock()
	for i, tx := range txs {
		if tx != uint16(i+1) {
			t.Fatalf("tx %d = %d, want %d (one per request, in order)", i, tx, i+1)
		}
	}
}
