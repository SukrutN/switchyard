package server

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"

	"github.com/SukrutN/switchyard/internal/wire"
)

// Journals are the durability contract. The file format is deliberately
// boring and hand-paddled: one append-only file per lane, records framed with
// a length and a CRC so recovery can tell "complete record" from "power was
// pulled mid-write" without trusting any pattern it cannot verify.
//
// Layout (big-endian, §9 of docs/PROTOCOL.md):
//
//	file header: 32 bytes, "SYJLOG01" + u8 format version + reserved zeros
//	record:      u32 bodyLen | body | u32 crc32(body)
//	body:        u64 seq | u8 kind | u16 subjLen|subj | u8 flags
//	             [ u16 replyLen|reply ] | u32 payloadLen|payload
//
// kind byte 0x01 is a stream message. Later durable families (KV) get their
// own kinds; no kind is ever re-meant, the same rule the wire op table lives
// by. A record whose length, CRC, or layout says "torn" ends the lane log —
// recovery truncates back to the last intact record and nothing is guessed.

const journalHeaderLen = 32

var journalMagic = [8]byte{'S', 'Y', 'J', 'L', 'O', 'G', '0', '1'}

// Persisted record kinds (§9). 0x01 owns the stream family; 0x02 and 0x03
// are the KV family riding the same journals. New families append; no kind
// is ever re-meant, the same rule the wire op table lives by.
const (
	KindStreamMessage byte = 0x01
	KindKVSet         byte = 0x02
	KindKVDelete      byte = 0x03
)

type journalRecord struct {
	Seq      uint64
	Kind     byte
	Subject  string
	Reply    string
	Key      string
	Payload  []byte
	HasReply bool
}

// openJournal recovers (or creates) <dir>/journal.log and leaves it ready for
// appends. Torn tails are cut here, once, before any writer can touch them:
// afterwards the file is always record-aligned at its end.
func openJournal(dir string) (*journal, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("lane dir %s: %w", dir, err)
	}
	path := filepath.Join(dir, "journal.log")
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open journal %s: %w", path, err)
	}
	j := &journal{f: f}

	cut, lastSeq, count, err := j.recover()
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("recover journal %s: %w", path, err)
	}
	if st, serr := f.Stat(); serr == nil {
		if cut < st.Size() {
			if terr := f.Truncate(cut); terr != nil {
				f.Close()
				return nil, fmt.Errorf("truncate torn tail %s: %w", path, terr)
			}
		}
	} else {
		f.Close()
		return nil, fmt.Errorf("stat journal %s: %w", path, serr)
	}
	if count == 0 {
		// Fresh (or fully torn) journal: lay the header down first.
		hdr := buildJournalHeader()
		if _, werr := f.WriteAt(hdr, 0); werr != nil {
			f.Close()
			return nil, fmt.Errorf("journal header %s: %w", path, werr)
		}
	}
	// Append mode from here on; Len carries the recovered position.
	if _, serr := f.Seek(0, io.SeekEnd); serr != nil {
		f.Close()
		return nil, fmt.Errorf("seek journal %s: %w", path, serr)
	}
	j.recCount = count
	j.lastSeq = lastSeq
	return j, nil
}

type journal struct {
	f *os.File
	// lastSeq is the highest sequence confirmed intact at open time; the
	// lane inherits it. recCount is private bookkeeping for tests.
	lastSeq  uint64
	recCount int
}

func buildJournalHeader() []byte {
	h := make([]byte, journalHeaderLen)
	copy(h[:8], journalMagic[:])
	h[8] = journalFormatVersion // format revision of the journal family
	return h
}

// journalFormatVersion is the journal file's own revision, not the wire
// protocol's: they bump independently, header evidence is on disk where the
// wire's isn't.
const journalFormatVersion byte = 0x01

// recover walks the file: header first, then records until one fails its
// envelope. It returns (cut, lastSeq, records) where cut is the byte offset
// the file should truncate to — journalHeaderLen when nothing survived, the
// offset after the last good record otherwise — so a torn zeroth record also
// ends up cut instead of accumulating debris.
func (j *journal) recover() (cut int64, lastSeq uint64, records int, err error) {
	st, err := j.f.Stat()
	if err != nil {
		return journalHeaderLen, 0, 0, err
	}
	size := st.Size()
	if size < journalHeaderLen {
		return journalHeaderLen, 0, 0, nil // fresh or broken file; recovery starts a new one
	}
	hdr := make([]byte, journalHeaderLen)
	if _, err := j.f.ReadAt(hdr, 0); err != nil {
		return journalHeaderLen, 0, 0, err
	}
	if string(hdr[:8]) != string(journalMagic[:]) {
		return journalHeaderLen, 0, 0, fmt.Errorf("journal header magic mismatch")
	}

	var off int64 = journalHeaderLen
	body := make([]byte, 0, 4096)
	crcBuf := make([]byte, 4)
	for off < size {
		var lenBuf [4]byte
		if _, err := j.f.ReadAt(lenBuf[:], off); err != nil {
			break // torn length field
		}
		n := int(binary.BigEndian.Uint32(lenBuf[:]))
		// A length that claims a body that cannot physically be a framed
		// record is a torn write; the walk ends there.
		recEnd := off + 4 + int64(n) + 4
		if n <= 0 || n > wire.MaxBodyBytes*2 || recEnd > size {
			break
		}
		body = body[:0]
		if cap(body) < n {
			body = make([]byte, 0, n+256)
		}
		body = body[:n]
		if _, err := j.f.ReadAt(body, off+4); err != nil {
			break
		}
		if _, err := j.f.ReadAt(crcBuf, off+4+int64(n)); err != nil {
			break
		}
		want := binary.BigEndian.Uint32(crcBuf)
		if crc32.ChecksumIEEE(body) != want {
			break // torn or corrupted body: nothing after it is trustworthy
		}
		seq, _, err := parseRecordBody(body)
		if err != nil {
			break // structurally broken body: stop before it poisons anything
		}
		lastSeq = seq
		off = recEnd
		records++
	}
	return off, lastSeq, records, nil
}

// appendOne writes one record. The caller holds the lane lock, so file
// writes serialize with sequence assignment: the journal order IS the seq
// order it reports.
func (j *journal) appendOne(rec journalRecord, seq uint64, sync bool) error {
	body, err := encodeRecordBody(rec, seq)
	if err != nil {
		return err
	}
	buf := make([]byte, 0, 8+len(body))
	buf = binary.BigEndian.AppendUint32(buf, uint32(len(body)))
	buf = append(buf, body...)
	buf = binary.BigEndian.AppendUint32(buf, crc32.ChecksumIEEE(body))
	if _, err := j.f.Write(buf); err != nil {
		return fmt.Errorf("journal append: %w", err)
	}
	return j.maybeSync(sync)
}

func (j *journal) maybeSync(sync bool) error {
	if !sync {
		return nil
	}
	return j.f.Sync()
}

// syncNow lets callers fsync a successfully written record when the lane was
// configured to batch syncs (reserved for future retention policies; the M2
// default syncs each record inline).
func (j *journal) syncNow() error { return j.f.Sync() }

// close flushes bookkeeping and drops the handle; the OS owns what fsync
// already promised.
func (j *journal) close() error { return j.f.Close() }

// ---- record body ----

func encodeRecordBody(rec journalRecord, seq uint64) ([]byte, error) {
	switch rec.Kind {
	case KindKVSet:
		// seq | 0x02 | u16 keyLen|key | u32 payloadLen|payload
		b := make([]byte, 0, 8+1+2+len(rec.Key)+4+len(rec.Payload))
		b = binary.BigEndian.AppendUint64(b, seq)
		b = append(b, KindKVSet)
		b = binary.BigEndian.AppendUint16(b, uint16(len(rec.Key)))
		b = append(b, rec.Key...)
		b = binary.BigEndian.AppendUint32(b, uint32(len(rec.Payload)))
		b = append(b, rec.Payload...)
		return b, nil
	case KindKVDelete:
		// seq | 0x03 | u16 keyLen|key — a tombstone carries no payload.
		b := make([]byte, 0, 8+1+2+len(rec.Key))
		b = binary.BigEndian.AppendUint64(b, seq)
		b = append(b, KindKVDelete)
		b = binary.BigEndian.AppendUint16(b, uint16(len(rec.Key)))
		b = append(b, rec.Key...)
		return b, nil
	case KindStreamMessage:
		// seq | 0x01 | u16 subjLen|subj | flags | [u16 replyLen|reply]
		// | u32 payloadLen|payload
		b := make([]byte, 0, 8+1+2+len(rec.Subject)+1+2+len(rec.Reply)+4+len(rec.Payload))
		b = binary.BigEndian.AppendUint64(b, seq)
		b = append(b, KindStreamMessage)
		var l2 [2]byte
		binary.BigEndian.PutUint16(l2[:], uint16(len(rec.Subject)))
		b = append(b, l2[:]...)
		b = append(b, rec.Subject...)
		flag := byte(0)
		if rec.HasReply {
			flag |= wire.FlagReplyPresent
		}
		b = append(b, flag)
		if rec.HasReply {
			binary.BigEndian.PutUint16(l2[:], uint16(len(rec.Reply)))
			b = append(b, l2[:]...)
			b = append(b, rec.Reply...)
		}
		var l4 [4]byte
		binary.BigEndian.PutUint32(l4[:], uint32(len(rec.Payload)))
		b = append(b, l4[:]...)
		b = append(b, rec.Payload...)
		return b, nil
	default:
		return nil, fmt.Errorf("record kind 0x%02X has no encoder", rec.Kind)
	}
}

// parseRecordBody decodes one journal body with a hand-rolled cursor. The
// server package owns its own byte cursor here rather than borrowing the
// wire's private decoder — the file format is a server contract, and keeping
// one small reader local tells that story in code.
//
// A body whose envelope (length + CRC) is intact but whose kind this version
// does not know is yielded as an opaque record, not an error: a newer
// server's extra families are legible bytewise even when their layout is not
// parsed here, and recovery keeps whole records whole. Callers filter on
// Kind before touching any other field.
func parseRecordBody(b []byte) (seq uint64, rec journalRecord, err error) {
	c := recCursor{buf: b}
	var ok bool
	seq, ok = c.u64()
	if !ok || c.left() < 1 {
		return 0, journalRecord{}, errors.New("journal body too short for seq+kind")
	}
	kind, _ := c.u8()
	switch kind {
	case KindStreamMessage:
		subject, ok := c.strA(wire.MaxSubjectLen)
		if !ok {
			return 0, journalRecord{}, errCursor("journal.subject")
		}
		flags := byte(0)
		if c.left() > 0 {
			flags, _ = c.u8()
		}
		reply := ""
		if flags&wire.FlagReplyPresent != 0 {
			reply, ok = c.strA(wire.MaxReplyLen)
			if !ok {
				return 0, journalRecord{}, errCursor("journal.reply")
			}
		}
		payload, ok := c.bytes32()
		if !ok {
			return 0, journalRecord{}, errCursor("journal.payload")
		}
		return seq, journalRecord{Kind: kind, Subject: subject, Reply: reply, Payload: payload, HasReply: flags&wire.FlagReplyPresent != 0}, nil
	case KindKVSet:
		key, ok := c.strA(wire.MaxKeyLen)
		if !ok {
			return 0, journalRecord{}, errCursor("journal.key")
		}
		payload, ok := c.bytes32()
		if !ok {
			return 0, journalRecord{}, errCursor("journal.payload")
		}
		return seq, journalRecord{Kind: kind, Key: key, Payload: payload}, nil
	case KindKVDelete:
		key, ok := c.strA(wire.MaxKeyLen)
		if !ok {
			return 0, journalRecord{}, errCursor("journal.key")
		}
		return seq, journalRecord{Kind: kind, Key: key}, nil
	default:
		// A family this version has never met. Envelope is proven (CRC
		// above the parse), so the record stays on disk untouched.
		return seq, journalRecord{Kind: kind}, nil
	}
}

func errCursor(field string) error { return errors.New(field + " out of journal body bounds") }

// recCursor is the smallest byte cursor this package needs for its own files:
// reads are bounds-checked before slicing, and out-of-bounds fails the record.
type recCursor struct {
	buf []byte
	pos int
}

func (c *recCursor) left() int { return len(c.buf) - c.pos }

func (c *recCursor) u64() (uint64, bool) {
	if c.left() < 8 {
		return 0, false
	}
	v := binary.BigEndian.Uint64(c.buf[c.pos:])
	c.pos += 8
	return v, true
}

func (c *recCursor) u32() (uint32, bool) {
	if c.left() < 4 {
		return 0, false
	}
	v := binary.BigEndian.Uint32(c.buf[c.pos:])
	c.pos += 4
	return v, true
}

func (c *recCursor) u8() (byte, bool) {
	if c.left() < 1 {
		return 0, false
	}
	v := c.buf[c.pos]
	c.pos++
	return v, true
}

// strA reads a u16-length string, bounded by max.
func (c *recCursor) strA(max int) (string, bool) {
	if c.left() < 2 {
		return "", false
	}
	n := int(binary.BigEndian.Uint16(c.buf[c.pos:]))
	c.pos += 2
	if n > max || c.left() < n {
		return "", false
	}
	s := string(c.buf[c.pos : c.pos+n])
	c.pos += n
	return s, true
}

// bytes32 reads a u32-length payload, copied out so journal slack is not
// aliased into the payload a session is currently delivering.
func (c *recCursor) bytes32() ([]byte, bool) {
	v, ok := c.u32()
	if !ok {
		return nil, false
	}
	n := int(v)
	if c.left() < n {
		return nil, false
	}
	b := append([]byte(nil), c.buf[c.pos:c.pos+n]...)
	c.pos += n
	return b, true
}

// ---- consumer state files ----

// A consumer's durable position is one small file rewritten on every ack.
// Whole-file snapshot keeps the reasoning simple: the file on disk IS the
// consumer, whatever state it claims to be in. consumers/<name>.state holds:
//
//	u32 bodyLen | body | u32 crc32(body)
//	body: u16 nameLen|name | u64 floor | u32 pendingCount | pending u64s

const consumerStateMagic = "SYCONS01"

const consumerStateHeaderLen = 8

func consumerStatePath(dir, consumer string) string {
	return filepath.Join(dir, "consumers", consumer+".state")
}

// readConsumerState loads one durable consumer's position. A missing or torn
// file is a fresh consumer — that decision is deliberate: the only cost is
// re-delivery of a few messages (allowed, at-least-once), while guessing a
// position from broken bytes could skip one.
func readConsumerState(dir, consumer string) (floor uint64, pending []uint64, ok bool) {
	path := consumerStatePath(dir, consumer)
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil, true // fresh consumer, no position yet
		}
		return 0, nil, false
	}
	body, err := unwrapCRC(consumerStateMagic, raw)
	if err != nil {
		return 0, nil, true // torn snapshot: start over rather than guess
	}
	c := recCursor{buf: body}
	name, okName := c.strA(wire.MaxStreamName)
	if !okName {
		return 0, nil, true
	}
	if name != consumer {
		return 0, nil, false // someone else's file; refuse loudly upstream
	}
	floor, okF := c.u64()
	if !okF {
		return 0, nil, true
	}
	count, okC := c.u32()
	if !okC || int(count) > 1<<20 {
		return 0, nil, true // absurd pending: read as no position
	}
	pending = make([]uint64, 0, count)
	for range count {
		seq, okS := c.u64()
		if !okS {
			return 0, nil, true
		}
		pending = append(pending, seq)
	}
	return floor, pending, true
}

// writeConsumerState replaces the consumer's snapshot atomically-in-spirit:
// truncate + write + fsync. A crash mid-write leaves a torn file that
// recovery reads as missing — re-delivery, not data loss.
func writeConsumerState(dir, consumer string, floor uint64, pending []uint64) error {
	path := consumerStatePath(dir, consumer)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("consumer dir: %w", err)
	}
	body := make([]byte, 0, 2+len(consumer)+8+4+8*len(pending))
	var l2 [2]byte
	binary.BigEndian.PutUint16(l2[:], uint16(len(consumer)))
	body = append(body, l2[:]...)
	body = append(body, consumer...)
	body = binary.BigEndian.AppendUint64(body, floor)
	body = binary.BigEndian.AppendUint32(body, uint32(len(pending)))
	for _, seq := range pending {
		body = binary.BigEndian.AppendUint64(body, seq)
	}
	raw := make([]byte, 0, consumerStateHeaderLen+4+len(body)+4)
	raw = append(raw, consumerStateMagic...)
	raw = binary.BigEndian.AppendUint32(raw, uint32(len(body)))
	raw = append(raw, body...)
	raw = binary.BigEndian.AppendUint32(raw, crc32.ChecksumIEEE(body))
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("write consumer state %s: %w", path, err)
	}
	defer f.Close()
	if _, err := f.Write(raw); err != nil {
		return fmt.Errorf("write consumer state %s: %w", path, err)
	}
	return f.Sync()
}

// removeConsumerState drops the position file when a lane (and its
// consumers) go away entirely.
func removeConsumerState(dir, consumer string) error {
	err := os.Remove(consumerStatePath(dir, consumer))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// unwrapCRC validates the shared file envelope: magic | u32 len | body | crc.
func unwrapCRC(magic string, raw []byte) ([]byte, error) {
	if len(raw) < consumerStateHeaderLen+4+4 {
		return nil, errors.New("file too short")
	}
	if string(raw[:8]) != magic {
		return nil, errors.New("file magic mismatch")
	}
	n := int(binary.BigEndian.Uint32(raw[8:12]))
	if len(raw) < 12+n+4 {
		return nil, errors.New("torn file: length runs past EOF")
	}
	body := raw[12 : 12+n]
	want := binary.BigEndian.Uint32(raw[12+n : 16+n])
	if crc32.ChecksumIEEE(body) != want {
		return nil, errors.New("file body CRC mismatch")
	}
	return body, nil
}
