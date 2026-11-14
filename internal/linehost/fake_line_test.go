package linehost

import (
	"encoding/binary"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

// The fake line is a scripted Modbus slave with exactly one job: hold the
// wire's registers, answer FC03/FC06/FC16, and let tests both watch what
// the host wrote and decide what the floor says back. Byte-precise here
// is contract work, not pedantry.
type fakeWrite struct {
	addr uint16
	vals []uint16
}

type fakeLine struct {
	addr string
	ln   net.Listener

	mu        sync.Mutex
	regs      map[uint16]uint16
	writes    []fakeWrite
	requests  [][]byte // every request PDU that arrived
	txs       []uint16 // every request's MBAP transaction id
	failReads bool     // when set, reads answer with exception 0x02
}

func startFakeLine(t *testing.T) *fakeLine {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("fake line listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	fl := &fakeLine{addr: ln.Addr().String(), ln: ln, regs: map[uint16]uint16{}}
	go fl.serve()
	return fl
}

func (f *fakeLine) serve() {
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			return
		}
		go f.handle(conn)
	}
}

func (f *fakeLine) handle(conn net.Conn) {
	defer conn.Close()
	for {
		head := make([]byte, 7)
		if _, err := io.ReadFull(conn, head); err != nil {
			return
		}
		length := binary.BigEndian.Uint16(head[4:])
		if length < 2 || length > 261 {
			return
		}
		pdu := make([]byte, length-1)
		if _, err := io.ReadFull(conn, pdu); err != nil {
			return
		}

		f.mu.Lock()
		f.requests = append(f.requests, append([]byte(nil), pdu...))
		f.txs = append(f.txs, binary.BigEndian.Uint16(head[0:]))
		resp := f.dispatchLocked(pdu)
		f.mu.Unlock()

		mbap := make([]byte, 7)
		copy(mbap[0:2], head[0:2]) // echo the transaction id
		binary.BigEndian.PutUint16(mbap[4:], uint16(len(resp)+1))
		mbap[6] = head[6]
		if _, err := conn.Write(append(mbap, resp...)); err != nil {
			return
		}
	}
}

func (f *fakeLine) dispatchLocked(pdu []byte) []byte {
	if len(pdu) < 1 {
		return []byte{0x80, 0x01}
	}
	switch pdu[0] {
	case 0x03: // read holding registers
		if f.failReads {
			return []byte{0x83, 0x02}
		}
		if len(pdu) < 5 {
			return []byte{0x83, 0x02}
		}
		addr := binary.BigEndian.Uint16(pdu[1:])
		n := binary.BigEndian.Uint16(pdu[3:])
		out := []byte{0x03, byte(2 * n)}
		for i := uint16(0); i < n; i++ {
			v := f.regs[addr+i]
			out = append(out, byte(v>>8), byte(v))
		}
		return out
	case 0x06: // write single register
		if len(pdu) < 5 {
			return []byte{0x86, 0x03}
		}
		addr := binary.BigEndian.Uint16(pdu[1:])
		v := binary.BigEndian.Uint16(pdu[3:])
		f.regs[addr] = v
		return append([]byte(nil), pdu...)
	case 0x10: // write multiple registers
		if len(pdu) < 6 {
			return []byte{0x90, 0x03}
		}
		addr := binary.BigEndian.Uint16(pdu[1:])
		qty := binary.BigEndian.Uint16(pdu[3:])
		if int(pdu[5]) != 2*int(qty) || len(pdu) < 6+2*int(qty) {
			return []byte{0x90, 0x03}
		}
		vals := make([]uint16, qty)
		for i := 0; i < int(qty); i++ {
			vals[i] = binary.BigEndian.Uint16(pdu[6+i*2:])
		}
		f.writes = append(f.writes, fakeWrite{addr: addr, vals: vals})
		for i, v := range vals {
			f.regs[addr+uint16(i)] = v
		}
		return []byte{0x10, byte(addr >> 8), byte(addr), byte(qty >> 8), byte(qty)}
	}
	return []byte{pdu[0] | 0x80, 0x01}
}

// setAck is the floor's word: the program wrote the ack block.
func (f *fakeLine) setAck(seq, state, gate, class uint16) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.regs[RegAckSeq] = seq
	f.regs[RegAckSeq+1] = state
	f.regs[RegAckSeq+2] = gate
	f.regs[RegAckSeq+3] = class
}

// waitForCommand waits for the command block (five words) carrying a
// specific CMD_SEQ - the block is unique per release, so two callers
// waiting on different seqs never hand back the same frame.
func (f *fakeLine) waitForCommand(t *testing.T, within time.Duration, seq uint16) fakeWrite {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		for _, w := range f.writes {
			if len(w.vals) == 5 && w.vals[1] == seq {
				f.mu.Unlock()
				return w
			}
		}
		f.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no command with seq %d within %s", seq, within)
	return fakeWrite{}
}

// writeCount reports how many multi-register writes have landed.
func (f *fakeLine) writeCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.writes)
}
