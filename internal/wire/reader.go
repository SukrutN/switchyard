package wire

import (
	"encoding/binary"
	"errors"
	"io"
)

// Reader pulls frames off the line one at a time. It is strictly bounded:
// no read may exceed MaxBodyBytes+HeaderLen, so a hostile peer cannot make
// the server allocate its memory budget through one giant header.
//
// Callers are expected to back the underlying stream with a buffered reader
// (bufio ≥ 32 KiB) — unbuffered, each frame costs a header recv plus a body
// recv, and frame-at-a-time syscalls cap ingest well below what fan-out
// produces.
//
// The same instance is not goroutine-safe; the server owns it inside its
// per-connection reader goroutine and that is the only caller.
type Reader struct {
	r    io.Reader
	max  uint32
	hdr  [HeaderLen]byte
	body []byte // scratch, grown up to max once
}

// NewReader bounds frame bodies to softMax: frames declaring MORE than
// softMax bytes are still readable if they stay within the protocol ceiling
// — the reader discards the body and returns ErrSkipped so the session can
// answer with a too-large ERROR and keep living. A frame declaring more than
// MaxBodyBytes cannot be recovered (the byte offset is trustworthy only as
// far as the ceiling), so it is a fatal error.
func NewReader(r io.Reader, softMax uint32) *Reader {
	if softMax > MaxBodyBytes {
		softMax = MaxBodyBytes
	}
	return &Reader{r: r, max: softMax}
}

// ErrSkipped marks a frame whose body was over this reader's limit but within
// the protocol ceiling: the body bytes were discarded, framing is intact, and
// the session may continue. Callers answer with a too-large ERROR.
var ErrSkipped = errors.New("wire: oversized body skipped, framing intact")

// ReadFrame blocks for exactly one frame. The returned body aliases the
// reader's scratch buffer and is valid only until the next ReadFrame call —
// handlers must copy it if they keep it. Decision: aliasing keeps the hot
// path allocation-free; the guarantee not to copy has bitten nobody yet.
func (rd *Reader) ReadFrame() (Op, []byte, error) {
	if _, err := io.ReadFull(rd.r, rd.hdr[:]); err != nil {
		return 0, nil, err // clean EOF vs short read is upstream's call
	}
	if rd.hdr[0] != Magic1 || rd.hdr[1] != Magic2 {
		return 0, nil, newOpErr(CodeMalformed, true, "bad magic 0x%02X 0x%02X at frame start", rd.hdr[0], rd.hdr[1])
	}
	ver := rd.hdr[2]
	if ver != Version {
		return 0, nil, newOpErr(CodeVersion, true, "frame says version %d, mine is %d", ver, Version)
	}
	bodyLen := binary.BigEndian.Uint32(rd.hdr[4:8])
	if bodyLen > MaxBodyBytes {
		// Beyond the ceiling we could sit discarding gigabytes a hostile
		// peer invented; the offset is untrustworthy, so die instead.
		return 0, nil, newOpErr(CodeTooLarge, true, "frame declares %d-byte body, protocol ceiling is %d", bodyLen, MaxBodyBytes)
	}
	if bodyLen > rd.max {
		// Soft violation: discard exactly bodyLen bytes, keep framing.
		if _, err := io.CopyN(io.Discard, rd.r, int64(bodyLen)); err != nil {
			return 0, nil, newOpErr(CodeMalformed, true, "discarding oversized body of %d bytes failed: %v", bodyLen, err)
		}
		return Op(rd.hdr[3]), nil, ErrSkipped
	}
	if uint32(cap(rd.body)) < bodyLen {
		// Grow in frames-of-4KiB steps so small sessions never big-allocate.
		rd.body = make([]byte, 0, alignUp(bodyLen))
	}
	if bodyLen > 0 {
		b := rd.body[:bodyLen]
		if _, err := io.ReadFull(rd.r, b); err != nil {
			return 0, nil, newOpErr(CodeMalformed, true, "body truncated: expected %d bytes, got error %v", bodyLen, err)
		}
		return Op(rd.hdr[3]), b, nil
	}
	return Op(rd.hdr[3]), nil, nil
}

func alignUp(n uint32) uint32 {
	const step = 4096
	return (n + step - 1) / step * step
}

// Writer serializes frames. Like Reader it is single-owner, single-goroutine:
// the server serializes writers behind a session-owned mutex instead, which
// keeps this package free of locking concerns (and mirrors the reader side).
type Writer struct {
	w io.Writer
	// scratch is reused per frame (single-owner contract): header and body
	// coalesce into ONE socket write. Two sends per frame doubled the
	// syscall bill on every hop and turned arithmetic into "slow consumer"
	// verdicts when fan-out bursts met a fast-but-not-that-fast drain.
	scratch []byte
}

// NewWriter wraps the connection sink.
func NewWriter(w io.Writer) *Writer { return &Writer{w: w} }

// WriteFrame emits one frame. Body is assumed already encoded via codec.go.
func (wrt *Writer) WriteFrame(op Op, body []byte) error {
	if uint32(len(body)) > MaxBodyBytes {
		return newOpErr(CodeTooLarge, false, "refusing to write %d-byte body", len(body))
	}
	n := HeaderLen + len(body)
	if cap(wrt.scratch) < n {
		wrt.scratch = make([]byte, 0, alignUp(uint32(n)))
	}
	b := wrt.scratch[:n]
	b[0], b[1], b[2], b[3] = Magic1, Magic2, Version, byte(op)
	binary.BigEndian.PutUint32(b[4:8], uint32(len(body)))
	copy(b[HeaderLen:], body)
	_, err := wrt.w.Write(b)
	return err
}

// AppendFrame appends a complete frame to dst without touching the wire. The
// session writer folds whole batches of queued deliveries through this into
// one socket write; recipient-side Readers pull exact buffer sizes off the
// byte stream, so coalescing here changes pacing, never framing.
func AppendFrame(dst []byte, op Op, body []byte) []byte {
	dst = append(dst, Magic1, Magic2, Version, byte(op))
	dst = binary.BigEndian.AppendUint32(dst, uint32(len(body)))
	dst = append(dst, body...)
	return dst
}
