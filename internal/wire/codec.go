package wire

import "encoding/binary"

// Codec: one encode/decode pair per op body, hand-sized because the wire
// format is the contract. Codec validates SHAPE only (bounds, ordering,
// no trailing bytes); SEMANTIC rules (sid uniqueness, subject charter,
// handshake order) live with the server so tests can target them separately.
//
// Every decode failure reports the byte offset it gave up at, which turns a
// bad frame from archaeology into lookup.

// frameRoom evens the ceiling math out per op: MaxBodyBytes minus the exact
// byte cost of everything else the body carries. A payload above it cannot
// be framed at all, so encode refuses it where it originates instead of
// letting it die inside a peer's reader.
func frameRoom(overhead int) int {
	return MaxBodyBytes - overhead
}

// decodeMax is the decode-side cap for u32-length payloads: the body ceiling
// itself, because Reader has already bounded the whole frame.
const decodeMax = 1 << 20 * 4

// EncodeHello serializes OpHello: u8 nameLen|name, u8 labelLen|label.
// Name and label are both display-only, so empty is legal for each.
func EncodeHello(h Hello) ([]byte, error) {
	if len(h.Name) > MaxClientName {
		return nil, newOpErr(CodeMalformed, false, "hello name %d bytes exceeds %d", len(h.Name), MaxClientName)
	}
	if len(h.Label) > MaxSpeechLabel {
		return nil, newOpErr(CodeMalformed, false, "hello label %d bytes exceeds %d", len(h.Label), MaxSpeechLabel)
	}
	b := make([]byte, 0, 2+1+len(h.Name)+1+len(h.Label))
	b = encStr8(b, h.Name)
	b = encStr8(b, h.Label)
	return b, nil
}

// DecodeHello parses OpHello.
func DecodeHello(b []byte) (Hello, error) {
	d := &decoder{buf: b}
	name, err := d.str8(MaxClientName, "hello.name")
	if err != nil {
		return Hello{}, err
	}
	label, err := d.str8(MaxSpeechLabel, "hello.label")
	if err != nil {
		return Hello{}, err
	}
	if err := d.exactEnd(OpHello); err != nil {
		return Hello{}, err
	}
	return Hello{Name: name, Label: label}, nil
}

// EncodeWelcome serializes OpWelcome: u16 labelLen|label, u32 maxBody.
func EncodeWelcome(w Welcome) ([]byte, error) {
	if len(w.ServerLabel) > MaxServerLabel {
		return nil, newOpErr(CodeMalformed, false, "welcome label %d bytes exceeds %d", len(w.ServerLabel), MaxServerLabel)
	}
	if w.MaxBody == 0 {
		return nil, newOpErr(CodeMalformed, false, "welcome must advertise a non-zero max body")
	}
	b := make([]byte, 0, 2+len(w.ServerLabel)+4)
	b = encStr16(b, w.ServerLabel)
	b = binary.BigEndian.AppendUint32(b, w.MaxBody)
	return b, nil
}

// DecodeWelcome parses OpWelcome.
func DecodeWelcome(b []byte) (Welcome, error) {
	d := &decoder{buf: b}
	label, err := d.str16(MaxServerLabel, "welcome.label")
	if err != nil {
		return Welcome{}, err
	}
	maxBody, err := d.u32()
	if err != nil {
		return Welcome{}, err
	}
	if err := d.exactEnd(OpWelcome); err != nil {
		return Welcome{}, err
	}
	if maxBody == 0 {
		return Welcome{}, newOpErr(CodeMalformed, false, "welcome advertises zero max body")
	}
	return Welcome{ServerLabel: label, MaxBody: maxBody}, nil
}

// EncodePublish serializes OpPublish:
// u16 subjLen|subj, flag, [u16 replyLen|reply], u32 payloadLen|payload.
// The subject must be non-empty and within the byte cap; token-charter rules
// are the subjects package's business, not this codec's.
func EncodePublish(p Publish) ([]byte, error) {
	if len(p.Subject) == 0 {
		return nil, newOpErr(CodeBadSubject, false, "publish subject is empty")
	}
	if len(p.Subject) > MaxSubjectLen {
		return nil, newOpErr(CodeBadSubject, false, "publish subject %d bytes exceeds %d", len(p.Subject), MaxSubjectLen)
	}
	if !p.HasReply && p.Reply != "" {
		return nil, newOpErr(CodeMalformed, false, "reply set but reply-present flag unset")
	}
	if len(p.Reply) > MaxReplyLen {
		return nil, newOpErr(CodeBadSubject, false, "publish reply %d bytes exceeds %d", len(p.Reply), MaxReplyLen)
	}
	// Exact frame arithmetic, per op: u16 subjectLen + subject bytes + flag +
	// u32 payloadLen (+ optional reply field). Overhead differs between ops,
	// so each encode computes its own room.
	room := frameRoom(2 + len(p.Subject) + 1 + 4)
	if p.HasReply {
		room = frameRoom(2 + len(p.Subject) + 1 + 2 + len(p.Reply) + 4)
	}
	if len(p.Payload) > room {
		return nil, newOpErr(CodeTooLarge, false, "payload %d bytes, room is %d (%d-byte ceiling minus framing)", len(p.Payload), room, MaxBodyBytes)
	}
	b := make([]byte, 0, 2+len(p.Subject)+1+len(p.Reply)+4+len(p.Payload))
	b = encStr16(b, p.Subject)
	flag := byte(0)
	if p.HasReply {
		flag |= FlagReplyPresent
	}
	b = append(b, flag)
	if p.HasReply {
		b = encStr16(b, p.Reply)
	}
	b = binary.BigEndian.AppendUint32(b, uint32(len(p.Payload)))
	b = append(b, p.Payload...)
	return b, nil
}

// DecodePublish parses OpPublish.
func DecodePublish(b []byte) (Publish, error) {
	d := &decoder{buf: b}
	subject, err := d.str16(MaxSubjectLen, "publish.subject")
	if err != nil {
		return Publish{}, err
	}
	if subject == "" {
		return Publish{}, newOpErr(CodeBadSubject, false, "publish subject is empty")
	}
	flags, err := d.u8()
	if err != nil {
		return Publish{}, err
	}
	var reply string
	if flags&FlagReplyPresent != 0 {
		reply, err = d.str16(MaxReplyLen, "publish.reply")
		if err != nil {
			return Publish{}, err
		}
	}
	payload, err := d.bytes32(decodeMax, "publish.payload")
	if err != nil {
		return Publish{}, err
	}
	if err := d.exactEnd(OpPublish); err != nil {
		return Publish{}, err
	}
	return Publish{Subject: subject, Reply: reply, Payload: payload, HasReply: flags&FlagReplyPresent != 0}, nil
}

// EncodeSubscribe serializes OpSubscribe: u16 patternLen|pattern, u32 sid.
func EncodeSubscribe(s Subscribe) ([]byte, error) {
	if len(s.Pattern) == 0 || len(s.Pattern) > MaxSubjectLen {
		return nil, newOpErr(CodeBadSubject, false, "pattern length %d out of range [1,%d]", len(s.Pattern), MaxSubjectLen)
	}
	b := make([]byte, 0, 2+len(s.Pattern)+4)
	b = encStr16(b, s.Pattern)
	b = binary.BigEndian.AppendUint32(b, s.Sid)
	return b, nil
}

// DecodeSubscribe parses OpSubscribe.
func DecodeSubscribe(b []byte) (Subscribe, error) {
	d := &decoder{buf: b}
	pattern, err := d.str16(MaxSubjectLen, "subscribe.pattern")
	if err != nil {
		return Subscribe{}, err
	}
	sid, err := d.u32()
	if err != nil {
		return Subscribe{}, err
	}
	if err := d.exactEnd(OpSubscribe); err != nil {
		return Subscribe{}, err
	}
	return Subscribe{Pattern: pattern, Sid: sid}, nil
}

// EncodeUnsub serializes OpUnsub: u32 sid.
func EncodeUnsub(u Unsub) ([]byte, error) {
	return binary.BigEndian.AppendUint32(nil, u.Sid), nil
}

// DecodeUnsub parses OpUnsub.
func DecodeUnsub(b []byte) (Unsub, error) {
	d := &decoder{buf: b}
	sid, err := d.u32()
	if err != nil {
		return Unsub{}, err
	}
	if err := d.exactEnd(OpUnsub); err != nil {
		return Unsub{}, err
	}
	return Unsub{Sid: sid}, nil
}

// EncodeDeliver serializes OpDeliver:
// u16 subjLen|subj, u32 sid, u32 seq, flag, [u16 replyLen|reply], u32 payloadLen|payload.
func EncodeDeliver(del Deliver) ([]byte, error) {
	if del.Sid == 0 {
		return nil, newOpErr(CodeMalformed, false, "deliver sid 0 is not a subscription")
	}
	if del.Seq == 0 {
		return nil, newOpErr(CodeMalformed, false, "deliver seq values start at 1")
	}
	if !del.HasReply && del.Reply != "" {
		return nil, newOpErr(CodeMalformed, false, "reply set but reply-present flag unset")
	}
	if len(del.Reply) > MaxReplyLen {
		return nil, newOpErr(CodeBadSubject, false, "deliver reply %d bytes exceeds %d", len(del.Reply), MaxReplyLen)
	}
	// Deliver carries sid+seq on top of the publish overhead.
	room := frameRoom(2 + len(del.Subject) + 8 + 1 + 4)
	if del.HasReply {
		room = frameRoom(2 + len(del.Subject) + 8 + 1 + 2 + len(del.Reply) + 4)
	}
	if len(del.Payload) > room {
		return nil, newOpErr(CodeTooLarge, false, "payload %d bytes, room is %d (%d-byte ceiling minus framing)", len(del.Payload), room, MaxBodyBytes)
	}
	b := make([]byte, 0, 2+len(del.Subject)+8+1+len(del.Reply)+4+len(del.Payload))
	b = encStr16(b, del.Subject)
	b = binary.BigEndian.AppendUint32(b, del.Sid)
	b = binary.BigEndian.AppendUint32(b, del.Seq)
	flag := byte(0)
	if del.HasReply {
		flag |= FlagReplyPresent
	}
	b = append(b, flag)
	if del.HasReply {
		b = encStr16(b, del.Reply)
	}
	b = binary.BigEndian.AppendUint32(b, uint32(len(del.Payload)))
	b = append(b, del.Payload...)
	return b, nil
}

// DecodeDeliver parses OpDeliver.
func DecodeDeliver(b []byte) (Deliver, error) {
	d := &decoder{buf: b}
	subject, err := d.str16(MaxSubjectLen, "deliver.subject")
	if err != nil {
		return Deliver{}, err
	}
	sid, err := d.u32()
	if err != nil {
		return Deliver{}, err
	}
	seq, err := d.u32()
	if err != nil {
		return Deliver{}, err
	}
	flags, err := d.u8()
	if err != nil {
		return Deliver{}, err
	}
	var reply string
	if flags&FlagReplyPresent != 0 {
		reply, err = d.str16(MaxReplyLen, "deliver.reply")
		if err != nil {
			return Deliver{}, err
		}
	}
	payload, err := d.bytes32(decodeMax, "deliver.payload")
	if err != nil {
		return Deliver{}, err
	}
	if err := d.exactEnd(OpDeliver); err != nil {
		return Deliver{}, err
	}
	return Deliver{Subject: subject, Sid: sid, Seq: seq, Reply: reply, Payload: payload, HasReply: flags&FlagReplyPresent != 0}, nil
}

// EncodeError serializes OpError: u8 code, u16 msgLen|msg, flag.
// Messages longer than MaxSubjectLen are truncated rather than errored:
// losing the tail of an operator-facing complaint beats failing the failure.
func EncodeError(e ErrorResponse) ([]byte, error) {
	msg := e.Message
	if len(msg) > MaxSubjectLen {
		msg = msg[:MaxSubjectLen]
	}
	flag := byte(0)
	if e.Fatal {
		flag |= FlagFatal
	}
	b := make([]byte, 0, 3+len(msg)+1)
	b = append(b, e.Code)
	b = encStr16(b, msg)
	b = append(b, flag)
	return b, nil
}

// DecodeError parses OpError.
func DecodeError(b []byte) (ErrorResponse, error) {
	d := &decoder{buf: b}
	code, err := d.u8()
	if err != nil {
		return ErrorResponse{}, err
	}
	msg, err := d.str16(MaxSubjectLen, "error.message")
	if err != nil {
		return ErrorResponse{}, err
	}
	flag, err := d.u8()
	if err != nil {
		return ErrorResponse{}, err
	}
	if err := d.exactEnd(OpError); err != nil {
		return ErrorResponse{}, err
	}
	return ErrorResponse{Code: code, Message: msg, Fatal: flag&FlagFatal != 0}, nil
}

// ---- small serialization helpers ----

// encStr8 writes u8-length string.
func encStr8(b []byte, s string) []byte {
	b = append(b, byte(len(s)))
	return append(b, s...)
}

// encStr16 writes u16-length string for pre-validated s.
func encStr16(b []byte, s string) []byte {
	b = binary.BigEndian.AppendUint16(b, uint16(len(s)))
	return append(b, s...)
}
