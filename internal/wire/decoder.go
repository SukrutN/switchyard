package wire

import "encoding/binary"

// decoder walks an op body byte-by-byte. Failed reads name the field and the
// offset, because "HELLO.body bad at +4" is the difference between a two-minute
// and a two-day bug hunt.
//
// All bounds are enforced before slicing: a malformed body never panics, it
// only errors. The struct is dumb on purpose — every op's codec drives it.
type decoder struct {
	buf []byte
	pos int
}

// left is how many bytes remain unread.
func (d *decoder) left() int { return len(d.buf) - d.pos }

// u8 reads one byte.
func (d *decoder) u8() (byte, error) {
	if d.left() < 1 {
		return 0, newOpErr(CodeMalformed, false, "expected u8 at offset %d, body has %d bytes left", d.pos, d.left())
	}
	v := d.buf[d.pos]
	d.pos++
	return v, nil
}

// u32 reads a big-endian uint32.
func (d *decoder) u32() (uint32, error) {
	if d.left() < 4 {
		return 0, newOpErr(CodeMalformed, false, "expected u32 at offset %d, body has %d bytes left", d.pos, d.left())
	}
	v := binary.BigEndian.Uint32(d.buf[d.pos : d.pos+4])
	d.pos += 4
	return v, nil
}

// u64 reads a big-endian uint64 (lane sequences are u64 on the wire).
func (d *decoder) u64() (uint64, error) {
	if d.left() < 8 {
		return 0, newOpErr(CodeMalformed, false, "expected u64 at offset %d, body has %d bytes left", d.pos, d.left())
	}
	v := binary.BigEndian.Uint64(d.buf[d.pos : d.pos+8])
	d.pos += 8
	return v, nil
}

// str8 reads u8-length string, capped at max.
func (d *decoder) str8(max int, field string) (string, error) {
	n, err := d.u8()
	if err != nil {
		return "", err
	}
	if int(n) > max {
		return "", newOpErr(CodeMalformed, false, "%s length %d exceeds cap %d at offset %d", field, n, max, d.pos-1)
	}
	if d.left() < int(n) {
		return "", newOpErr(CodeMalformed, false, "%s truncated at offset %d: want %d bytes, have %d", field, d.pos, n, d.left())
	}
	s := string(d.buf[d.pos : d.pos+int(n)])
	d.pos += int(n)
	return s, nil
}

// str16 reads u16-length string, capped at max.
func (d *decoder) str16(max int, field string) (string, error) {
	if d.left() < 2 {
		return "", newOpErr(CodeMalformed, false, "expected %s length at offset %d, body has %d bytes left", field, d.pos, d.left())
	}
	n := int(binary.BigEndian.Uint16(d.buf[d.pos : d.pos+2]))
	d.pos += 2
	if n > max {
		return "", newOpErr(CodeMalformed, false, "%s length %d exceeds cap %d", field, n, max)
	}
	if d.left() < n {
		return "", newOpErr(CodeMalformed, false, "%s truncated at offset %d: want %d bytes, have %d", field, d.pos, n, d.left())
	}
	s := string(d.buf[d.pos : d.pos+n])
	d.pos += n
	return s, nil
}

// bytes32 reads u32-length payload, capped at max. Payloads are copied out of
// the body so the caller owns the bytes and the aliasing rule of Reader stays
// simple: bodies are scratch, payloads are not.
func (d *decoder) bytes32(max int, field string) ([]byte, error) {
	if d.left() < 4 {
		return nil, newOpErr(CodeMalformed, false, "expected %s length at offset %d, body has %d bytes left", field, d.pos, d.left())
	}
	n := int(binary.BigEndian.Uint32(d.buf[d.pos : d.pos+4]))
	d.pos += 4
	if n > max {
		return nil, newOpErr(CodeMalformed, false, "%s length %d exceeds cap %d", field, n, max)
	}
	if d.left() < n {
		return nil, newOpErr(CodeMalformed, false, "%s truncated at offset %d: want %d bytes, have %d", field, d.pos, n, d.left())
	}
	b := append([]byte(nil), d.buf[d.pos:d.pos+n]...)
	d.pos += n
	return b, nil
}

// exactEnd rejects both truncation-style leftovers and extra trailing bytes.
// A codec that tolerates either shape invites silent drift between releases.
func (d *decoder) exactEnd(op Op) error {
	if d.left() != 0 {
		return newOpErr(CodeMalformed, false, "%s body has %d trailing bytes", op, d.left())
	}
	return nil
}
