// Package linehost hosts a sorting line: it consumes work items from a
// switchyard lane and speaks them to the line's Modbus register surface
// (fluxline-plc's host command block, docs/06-host-block.md in that repo).
// The Modbus client here is deliberately minimal — MBAP plus two function
// codes, no dependencies — because the interesting part is the arbitration
// the floor does, not the plumbing.
package linehost

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

// Function codes the host needs. Everything else on the line's surface
// belongs to the HMI.
const (
	fcReadHolding   = 0x03
	fcWriteSingle   = 0x06
	fcWriteMultiple = 0x10
)

// Modbus exception codes we surface by name; the rest print raw.
var exceptionText = map[byte]string{
	0x01: "illegal function",
	0x02: "illegal address",
	0x03: "illegal value",
	0x04: "server failure",
	0x05: "acknowledge",
	0x06: "busy",
}

// Line is one Modbus TCP session against the line's register server.
// One connection, one request in flight — the host's cadence (a heartbeat
// every few hundred milliseconds) has no use for pipelining.
type Line struct {
	conn net.Conn
	unit byte
	tx   uint16
	mu   sync.Mutex
}

// DialLine opens the session. The unit id is 1 on the fluxline twin.
func DialLine(addr string, unit byte, timeout time.Duration) (*Line, error) {
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return nil, fmt.Errorf("dial line %s: %w", addr, err)
	}
	return &Line{conn: conn, unit: unit}, nil
}

// Close ends the session.
func (l *Line) Close() error { return l.conn.Close() }

// ReadRegs reads holding registers (FC03).
func (l *Line) ReadRegs(addr uint16, n uint16) ([]uint16, error) {
	if n == 0 || n > 125 {
		return nil, fmt.Errorf("read %d registers: count out of range", n)
	}
	req := make([]byte, 5)
	req[0] = fcReadHolding
	binary.BigEndian.PutUint16(req[1:], addr)
	binary.BigEndian.PutUint16(req[3:], n)
	resp, err := l.roundTrip(req)
	if err != nil {
		return nil, err
	}
	if len(resp) < 1 || resp[0] != fcReadHolding {
		return nil, fmt.Errorf("read response %#x, want %#x", firstByte(resp), fcReadHolding)
	}
	if len(resp) < 2 || len(resp) != 2+int(resp[1]) {
		return nil, fmt.Errorf("read response claims %d bytes, carries %d", firstByteN(resp, 1), len(resp)-2)
	}
	body := resp[2:]
	if len(body) != int(n)*2 {
		return nil, fmt.Errorf("read %d registers, got %d", n, len(body)/2)
	}
	regs := make([]uint16, n)
	for i := range regs {
		regs[i] = binary.BigEndian.Uint16(body[i*2:])
	}
	return regs, nil
}

// WriteRegs writes holding registers (FC16). One write, one atomic frame —
// a command block lands whole or not at all.
func (l *Line) WriteRegs(addr uint16, vals ...uint16) error {
	if len(vals) == 0 || len(vals) > 123 {
		return fmt.Errorf("write %d registers: count out of range", len(vals))
	}
	req := make([]byte, 6+2*len(vals))
	req[0] = fcWriteMultiple
	binary.BigEndian.PutUint16(req[1:], addr)
	binary.BigEndian.PutUint16(req[3:], uint16(len(vals)))
	req[5] = byte(2 * len(vals))
	for i, v := range vals {
		binary.BigEndian.PutUint16(req[6+i*2:], v)
	}
	resp, err := l.roundTrip(req)
	if err != nil {
		return err
	}
	if len(resp) < 5 || resp[0] != fcWriteMultiple {
		return fmt.Errorf("write response %#x, want %#x", firstByte(resp), fcWriteMultiple)
	}
	gotAddr := binary.BigEndian.Uint16(resp[1:])
	gotQty := binary.BigEndian.Uint16(resp[3:])
	if gotAddr != addr || gotQty != uint16(len(vals)) {
		return fmt.Errorf("write echoed %d/%d, want %d/%d", gotAddr, gotQty, addr, len(vals))
	}
	return nil
}

// roundTrip sends one request and awaits its response under one lock, so
// the single-connection session never interleaves a reply.
func (l *Line) roundTrip(req []byte) ([]byte, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.tx++
	tx := l.tx
	mbap := make([]byte, 7)
	binary.BigEndian.PutUint16(mbap[0:], tx)
	binary.BigEndian.PutUint16(mbap[2:], 0) // protocol id
	binary.BigEndian.PutUint16(mbap[4:], uint16(len(req)+1))
	mbap[6] = l.unit

	if err := l.writeAll(append(mbap, req...)); err != nil {
		return nil, fmt.Errorf("send: %w", err)
	}
	head := make([]byte, 7)
	if _, err := io.ReadFull(l.conn, head); err != nil {
		return nil, fmt.Errorf("receive: %w", err)
	}
	gotTx := binary.BigEndian.Uint16(head[0:])
	proto := binary.BigEndian.Uint16(head[2:])
	length := binary.BigEndian.Uint16(head[4:])
	if gotTx != tx {
		return nil, fmt.Errorf("reply tx %d, want %d", gotTx, tx)
	}
	if proto != 0 {
		return nil, fmt.Errorf("reply protocol id %d, want 0", proto)
	}
	if length < 1 || length > 260 {
		return nil, fmt.Errorf("reply length %d out of range", length)
	}
	pdu := make([]byte, length-1) // minus the unit id already in head
	if _, err := io.ReadFull(l.conn, pdu); err != nil {
		return nil, fmt.Errorf("receive body: %w", err)
	}
	if len(pdu) < 1 {
		return nil, fmt.Errorf("empty reply")
	}
	if pdu[0]&0x80 != 0 {
		code := firstByteN(pdu, 1)
		name, ok := exceptionText[code]
		if !ok {
			name = fmt.Sprintf("exception 0x%02X", code)
		}
		return nil, fmt.Errorf("line refused: %s", name)
	}
	return pdu, nil
}

func (l *Line) writeAll(b []byte) error {
	_, err := l.conn.Write(b)
	return err
}

func firstByte(b []byte) byte {
	if len(b) == 0 {
		return 0
	}
	return b[0]
}

func firstByteN(b []byte, i int) byte {
	if len(b) <= i {
		return 0
	}
	return b[i]
}
