package wire

import "encoding/binary"

// Stream-family codecs (§2.8–§2.17): one encode/decode pair per op body, the
// same discipline as codec.go — shape validation here (bounds, ordering, no
// trailing bytes), semantic rules (lane charter, first-token match, consumer
// bookkeeping) with the server. Naming mistakes refuse non-fatally, so a
// second attempt lands on a clean session.

// laneName checks the length half of the §3.1 charter that belongs on the
// wire. The non-empty/length half fails closed here; the charset half is the
// server's (it owns the filesystem that motivated the rule).
func laneName(code byte, name, field string) error {
	if len(name) == 0 || len(name) > MaxStreamName {
		return newOpErr(code, false, "%s %d bytes out of range [1,%d]", field, len(name), MaxStreamName)
	}
	return nil
}

// EncodeStreamCreate serializes OpStreamCreate: u16 nameLen|name.
func EncodeStreamCreate(c StreamCreate) ([]byte, error) {
	if err := laneName(CodeBadStreamName, c.Name, "stream name"); err != nil {
		return nil, err
	}
	return encStr16(nil, c.Name), nil
}

// DecodeStreamCreate parses OpStreamCreate.
func DecodeStreamCreate(b []byte) (StreamCreate, error) {
	d := &decoder{buf: b}
	name, err := d.str16(MaxStreamName, "stream.name")
	if err != nil {
		return StreamCreate{}, err
	}
	if err := d.exactEnd(OpStreamCreate); err != nil {
		return StreamCreate{}, err
	}
	return StreamCreate{Name: name}, nil
}

// EncodeStreamReady serializes OpStreamReady: u16 nameLen|name, u64 seq.
// Seq counts from 1; zero would claim a lane assigns no numbers.
func EncodeStreamReady(r StreamReady) ([]byte, error) {
	if err := laneName(CodeBadStreamName, r.Name, "stream name"); err != nil {
		return nil, err
	}
	if r.Seq < 1 {
		return nil, newOpErr(CodeMalformed, false, "stream ready seq %d: lanes count from 1", r.Seq)
	}
	b := encStr16(nil, r.Name)
	return binary.BigEndian.AppendUint64(b, r.Seq), nil
}

// DecodeStreamReady parses OpStreamReady.
func DecodeStreamReady(b []byte) (StreamReady, error) {
	d := &decoder{buf: b}
	name, err := d.str16(MaxStreamName, "stream.name")
	if err != nil {
		return StreamReady{}, err
	}
	seq, err := d.u64()
	if err != nil {
		return StreamReady{}, err
	}
	if err := d.exactEnd(OpStreamReady); err != nil {
		return StreamReady{}, err
	}
	return StreamReady{Name: name, Seq: seq}, nil
}

// EncodeStreamPublish serializes OpStreamPublish:
// u16 streamLen|stream, u16 subjLen|subj, flag, [u16 replyLen|reply],
// u32 payloadLen|payload. Same carry-at-least costs as Publish plus the
// lane name, so the frame room math is publish's minus 2+name bytes.
func EncodeStreamPublish(p StreamPublish) ([]byte, error) {
	if err := laneName(CodeBadStreamName, p.Stream, "stream name"); err != nil {
		return nil, err
	}
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
	room := frameRoom(2 + len(p.Stream) + 2 + len(p.Subject) + 1 + 4)
	if p.HasReply {
		room = frameRoom(2 + len(p.Stream) + 2 + len(p.Subject) + 1 + 2 + len(p.Reply) + 4)
	}
	if len(p.Payload) > room {
		return nil, newOpErr(CodeTooLarge, false, "payload %d bytes, room is %d (%d-byte ceiling minus framing)", len(p.Payload), room, MaxBodyBytes)
	}
	b := make([]byte, 0, 2+len(p.Stream)+2+len(p.Subject)+1+len(p.Reply)+4+len(p.Payload))
	b = encStr16(b, p.Stream)
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

// DecodeStreamPublish parses OpStreamPublish.
func DecodeStreamPublish(b []byte) (StreamPublish, error) {
	d := &decoder{buf: b}
	stream, err := d.str16(MaxStreamName, "stream.name")
	if err != nil {
		return StreamPublish{}, err
	}
	subject, err := d.str16(MaxSubjectLen, "streampublish.subject")
	if err != nil {
		return StreamPublish{}, err
	}
	if subject == "" {
		return StreamPublish{}, newOpErr(CodeBadSubject, false, "publish subject is empty")
	}
	flags, err := d.u8()
	if err != nil {
		return StreamPublish{}, err
	}
	var reply string
	if flags&FlagReplyPresent != 0 {
		reply, err = d.str16(MaxReplyLen, "streampublish.reply")
		if err != nil {
			return StreamPublish{}, err
		}
	}
	payload, err := d.bytes32(decodeMax, "streampublish.payload")
	if err != nil {
		return StreamPublish{}, err
	}
	if err := d.exactEnd(OpStreamPublish); err != nil {
		return StreamPublish{}, err
	}
	return StreamPublish{Stream: stream, Subject: subject, Reply: reply, Payload: payload, HasReply: flags&FlagReplyPresent != 0}, nil
}

// EncodeStreamReceipt serializes OpStreamReceipt: u16 nameLen|name, u64 seq.
func EncodeStreamReceipt(r StreamReceipt) ([]byte, error) {
	if err := laneName(CodeBadStreamName, r.Stream, "stream name"); err != nil {
		return nil, err
	}
	if r.Seq < 1 {
		return nil, newOpErr(CodeMalformed, false, "receipt seq %d: lanes count from 1", r.Seq)
	}
	b := encStr16(nil, r.Stream)
	return binary.BigEndian.AppendUint64(b, r.Seq), nil
}

// DecodeStreamReceipt parses OpStreamReceipt.
func DecodeStreamReceipt(b []byte) (StreamReceipt, error) {
	d := &decoder{buf: b}
	stream, err := d.str16(MaxStreamName, "stream.name")
	if err != nil {
		return StreamReceipt{}, err
	}
	seq, err := d.u64()
	if err != nil {
		return StreamReceipt{}, err
	}
	if err := d.exactEnd(OpStreamReceipt); err != nil {
		return StreamReceipt{}, err
	}
	return StreamReceipt{Stream: stream, Seq: seq}, nil
}

// EncodeConsumerAttach serializes OpConsumerAttach:
// u16 streamLen|stream, u16 consumerLen|consumer, flag, [u16 filterLen|filter],
// u32 sid, u32 ackWaitMillis.
func EncodeConsumerAttach(a ConsumerAttach) ([]byte, error) {
	if err := laneName(CodeBadStreamName, a.Stream, "stream name"); err != nil {
		return nil, err
	}
	if err := laneName(CodeBadStreamName, a.Consumer, "consumer name"); err != nil {
		return nil, err
	}
	if !a.HasFilter && a.Filter != "" {
		return nil, newOpErr(CodeMalformed, false, "filter set but filter-present flag unset")
	}
	if len(a.Filter) > MaxSubjectLen {
		return nil, newOpErr(CodeBadSubject, false, "filter %d bytes exceeds %d", len(a.Filter), MaxSubjectLen)
	}
	b := make([]byte, 0, 2+len(a.Stream)+2+len(a.Consumer)+1+2+len(a.Filter)+4+4)
	b = encStr16(b, a.Stream)
	b = encStr16(b, a.Consumer)
	flag := byte(0)
	if a.HasFilter {
		flag |= FlagFilterPresent
	}
	b = append(b, flag)
	if a.HasFilter {
		b = encStr16(b, a.Filter)
	}
	b = binary.BigEndian.AppendUint32(b, a.Sid)
	b = binary.BigEndian.AppendUint32(b, a.AckWaitMillis)
	return b, nil
}

// DecodeConsumerAttach parses OpConsumerAttach.
func DecodeConsumerAttach(b []byte) (ConsumerAttach, error) {
	d := &decoder{buf: b}
	stream, err := d.str16(MaxStreamName, "stream.name")
	if err != nil {
		return ConsumerAttach{}, err
	}
	consumer, err := d.str16(MaxStreamName, "consumer.name")
	if err != nil {
		return ConsumerAttach{}, err
	}
	flags, err := d.u8()
	if err != nil {
		return ConsumerAttach{}, err
	}
	var filter string
	if flags&FlagFilterPresent != 0 {
		filter, err = d.str16(MaxSubjectLen, "consumer.filter")
		if err != nil {
			return ConsumerAttach{}, err
		}
	}
	sid, err := d.u32()
	if err != nil {
		return ConsumerAttach{}, err
	}
	ackWait, err := d.u32()
	if err != nil {
		return ConsumerAttach{}, err
	}
	if err := d.exactEnd(OpConsumerAttach); err != nil {
		return ConsumerAttach{}, err
	}
	if filter == "" {
		// An empty filter pattern is indistinguishable from "no filter": it
		// would match nothing, silently dropping every message. The flag and
		// the text must agree.
		if flags&FlagFilterPresent != 0 {
			return ConsumerAttach{}, newOpErr(CodeBadSubject, false, "empty filter patterns match nothing; drop the flag instead")
		}
		return ConsumerAttach{Stream: stream, Consumer: consumer, Sid: sid, AckWaitMillis: ackWait}, nil
	}
	return ConsumerAttach{Stream: stream, Consumer: consumer, Sid: sid, Filter: filter, HasFilter: true, AckWaitMillis: ackWait}, nil
}

// EncodeConsumerReady serializes OpConsumerReady: u16 stream|, u16 consumer|,
// u32 sid, u64 next, u32 ackWaitMillis. Next is a real sequence, so the
// window starts at 1.
func EncodeConsumerReady(r ConsumerReady) ([]byte, error) {
	if err := laneName(CodeBadStreamName, r.Stream, "stream name"); err != nil {
		return nil, err
	}
	if err := laneName(CodeBadStreamName, r.Consumer, "consumer name"); err != nil {
		return nil, err
	}
	if r.Next < 1 {
		return nil, newOpErr(CodeMalformed, false, "consumer ready next %d: sequences start at 1", r.Next)
	}
	b := make([]byte, 0, 2+len(r.Stream)+2+len(r.Consumer)+4+8+4)
	b = encStr16(b, r.Stream)
	b = encStr16(b, r.Consumer)
	b = binary.BigEndian.AppendUint32(b, r.Sid)
	b = binary.BigEndian.AppendUint64(b, r.Next)
	b = binary.BigEndian.AppendUint32(b, r.AckWaitMillis)
	return b, nil
}

// DecodeConsumerReady parses OpConsumerReady.
func DecodeConsumerReady(b []byte) (ConsumerReady, error) {
	d := &decoder{buf: b}
	stream, err := d.str16(MaxStreamName, "stream.name")
	if err != nil {
		return ConsumerReady{}, err
	}
	consumer, err := d.str16(MaxStreamName, "consumer.name")
	if err != nil {
		return ConsumerReady{}, err
	}
	sid, err := d.u32()
	if err != nil {
		return ConsumerReady{}, err
	}
	next, err := d.u64()
	if err != nil {
		return ConsumerReady{}, err
	}
	ackWait, err := d.u32()
	if err != nil {
		return ConsumerReady{}, err
	}
	if err := d.exactEnd(OpConsumerReady); err != nil {
		return ConsumerReady{}, err
	}
	return ConsumerReady{Stream: stream, Consumer: consumer, Sid: sid, Next: next, AckWaitMillis: ackWait}, nil
}

// EncodeStreamDeliver serializes OpStreamDeliver:
// u16 subjLen|subj, u32 sid, u64 seq, flag, [u16 replyLen|reply],
// u32 payloadLen|payload. Same subject-first field order as Deliver so both
// delivery frames read identically in a hex dump.
func EncodeStreamDeliver(del StreamDeliver) ([]byte, error) {
	if del.Sid == 0 {
		return nil, newOpErr(CodeMalformed, false, "deliver sid 0 is not a consumer")
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
	// Deliver's overhead plus four bytes for the u64 lane sequence.
	room := frameRoom(2 + len(del.Subject) + 4 + 8 + 1 + 4)
	if del.HasReply {
		room = frameRoom(2 + len(del.Subject) + 4 + 8 + 1 + 2 + len(del.Reply) + 4)
	}
	if len(del.Payload) > room {
		return nil, newOpErr(CodeTooLarge, false, "payload %d bytes, room is %d (%d-byte ceiling minus framing)", len(del.Payload), room, MaxBodyBytes)
	}
	b := make([]byte, 0, 2+len(del.Subject)+4+8+1+len(del.Reply)+4+len(del.Payload))
	b = encStr16(b, del.Subject)
	b = binary.BigEndian.AppendUint32(b, del.Sid)
	b = binary.BigEndian.AppendUint64(b, del.Seq)
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

// DecodeStreamDeliver parses OpStreamDeliver.
func DecodeStreamDeliver(b []byte) (StreamDeliver, error) {
	d := &decoder{buf: b}
	subject, err := d.str16(MaxSubjectLen, "streamdeliver.subject")
	if err != nil {
		return StreamDeliver{}, err
	}
	sid, err := d.u32()
	if err != nil {
		return StreamDeliver{}, err
	}
	seq, err := d.u64()
	if err != nil {
		return StreamDeliver{}, err
	}
	flags, err := d.u8()
	if err != nil {
		return StreamDeliver{}, err
	}
	var reply string
	if flags&FlagReplyPresent != 0 {
		reply, err = d.str16(MaxReplyLen, "streamdeliver.reply")
		if err != nil {
			return StreamDeliver{}, err
		}
	}
	payload, err := d.bytes32(decodeMax, "streamdeliver.payload")
	if err != nil {
		return StreamDeliver{}, err
	}
	if err := d.exactEnd(OpStreamDeliver); err != nil {
		return StreamDeliver{}, err
	}
	return StreamDeliver{Subject: subject, Sid: sid, Seq: seq, Reply: reply, Payload: payload, HasReply: flags&FlagReplyPresent != 0}, nil
}

// EncodeAck serializes OpAck: u32 sid, u64 seq.
func EncodeAck(a Ack) ([]byte, error) {
	b := binary.BigEndian.AppendUint32(nil, a.Sid)
	return binary.BigEndian.AppendUint64(b, a.Seq), nil
}

// DecodeAck parses OpAck. Zero fields mean "ack nothing", which the engine
// treats as a no-op; the codec passes bytes through so shape stays honest.
func DecodeAck(b []byte) (Ack, error) {
	d := &decoder{buf: b}
	sid, err := d.u32()
	if err != nil {
		return Ack{}, err
	}
	seq, err := d.u64()
	if err != nil {
		return Ack{}, err
	}
	if err := d.exactEnd(OpAck); err != nil {
		return Ack{}, err
	}
	return Ack{Sid: sid, Seq: seq}, nil
}

// EncodeStreamDelete serializes OpStreamDelete: u16 nameLen|name.
func EncodeStreamDelete(dlt StreamDelete) ([]byte, error) {
	if err := laneName(CodeBadStreamName, dlt.Name, "stream name"); err != nil {
		return nil, err
	}
	return encStr16(nil, dlt.Name), nil
}

// DecodeStreamDelete parses OpStreamDelete.
func DecodeStreamDelete(b []byte) (StreamDelete, error) {
	d := &decoder{buf: b}
	name, err := d.str16(MaxStreamName, "stream.name")
	if err != nil {
		return StreamDelete{}, err
	}
	if err := d.exactEnd(OpStreamDelete); err != nil {
		return StreamDelete{}, err
	}
	return StreamDelete{Name: name}, nil
}

// EncodeStreamGone serializes OpStreamGone: u16 nameLen|name.
func EncodeStreamGone(g StreamGone) ([]byte, error) {
	if err := laneName(CodeBadStreamName, g.Name, "stream name"); err != nil {
		return nil, err
	}
	return encStr16(nil, g.Name), nil
}

// DecodeStreamGone parses OpStreamGone.
func DecodeStreamGone(b []byte) (StreamGone, error) {
	d := &decoder{buf: b}
	name, err := d.str16(MaxStreamName, "stream.name")
	if err != nil {
		return StreamGone{}, err
	}
	if err := d.exactEnd(OpStreamGone); err != nil {
		return StreamGone{}, err
	}
	return StreamGone{Name: name}, nil
}
