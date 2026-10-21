package wire

import "encoding/binary"

// Console-family codecs (§2.24–§2.27): the yardmaster's answers are the
// only bodies here that the yard SPEAKS LONGER than it listens — two
// summary frames whose rows ride the same str16/u64 discipline as every
// other family. Shape rules here; the state itself is the engine's, and
// every row is a snapshot taken under the lane it describes.

// EncodeYardInfo serializes opYardInfo: an empty body.
func EncodeYardInfo(YardInfo) ([]byte, error) {
	return []byte{}, nil
}

// DecodeYardInfo parses opYardInfo: nothing, exactly.
func DecodeYardInfo(b []byte) (YardInfo, error) {
	d := &decoder{buf: b}
	if err := d.exactEnd(OpYardInfo); err != nil {
		return YardInfo{}, err
	}
	return YardInfo{}, nil
}

// EncodeYardState serializes opYardState: version, uptime, sessions, the
// lane table (ascending), and the quarantined names in full (§2.25).
func EncodeYardState(y YardState) ([]byte, error) {
	if len(y.Version) == 0 || len(y.Version) > 32 {
		return nil, newOpErr(CodeMalformed, false, "version %d bytes, want 1..32", len(y.Version))
	}
	if len(y.Lanes) > 0xFFFF {
		return nil, newOpErr(CodeTooLarge, false, "%d lanes do not fit a u16 count", len(y.Lanes))
	}
	if len(y.Quarantined) > 0xFFFF {
		return nil, newOpErr(CodeTooLarge, false, "%d quarantined lanes do not fit a u16 count", len(y.Quarantined))
	}
	size := 2 + len(y.Version) + 8 + 4 + 2
	for _, row := range y.Lanes {
		if err := laneName(CodeBadStreamName, row.Name, "yard lane"); err != nil {
			return nil, err
		}
		size += 2 + len(row.Name) + 8
	}
	for _, name := range y.Quarantined {
		if err := laneName(CodeBadStreamName, name, "quarantined lane"); err != nil {
			return nil, err
		}
		size += 2 + len(name)
	}
	b := make([]byte, 0, size)
	b = encStr16(b, y.Version)
	b = binary.BigEndian.AppendUint64(b, y.UptimeSec)
	b = binary.BigEndian.AppendUint32(b, y.Sessions)
	b = binary.BigEndian.AppendUint16(b, uint16(len(y.Lanes)))
	for _, row := range y.Lanes {
		b = encStr16(b, row.Name)
		b = binary.BigEndian.AppendUint64(b, row.Seq)
	}
	b = binary.BigEndian.AppendUint16(b, uint16(len(y.Quarantined)))
	for _, name := range y.Quarantined {
		b = encStr16(b, name)
	}
	return b, nil
}

// DecodeYardState parses opYardState.
func DecodeYardState(b []byte) (YardState, error) {
	d := &decoder{buf: b}
	version, err := d.str16(32, "yard.version")
	if err != nil {
		return YardState{}, err
	}
	uptime, err := d.u64()
	if err != nil {
		return YardState{}, err
	}
	sessions, err := d.u32()
	if err != nil {
		return YardState{}, err
	}
	y := YardState{Version: version, UptimeSec: uptime, Sessions: sessions}
	laneCount, err := d.u16()
	if err != nil {
		return YardState{}, err
	}
	for i := 0; i < int(laneCount); i++ {
		name, err := d.str16(MaxStreamName, "yard.name")
		if err != nil {
			return YardState{}, err
		}
		seq, err := d.u64()
		if err != nil {
			return YardState{}, err
		}
		y.Lanes = append(y.Lanes, YardLane{Name: name, Seq: seq})
	}
	qCount, err := d.u16()
	if err != nil {
		return YardState{}, err
	}
	for i := 0; i < int(qCount); i++ {
		name, err := d.str16(MaxStreamName, "yard.quarantined")
		if err != nil {
			return YardState{}, err
		}
		y.Quarantined = append(y.Quarantined, name)
	}
	if err := d.exactEnd(OpYardState); err != nil {
		return YardState{}, err
	}
	return y, nil
}

// EncodeLaneInfo serializes opLaneInfo: u16 laneLen|lane.
func EncodeLaneInfo(l LaneInfo) ([]byte, error) {
	if err := laneName(CodeBadStreamName, l.Lane, "lane name"); err != nil {
		return nil, err
	}
	return encStr16(nil, l.Lane), nil
}

// DecodeLaneInfo parses opLaneInfo.
func DecodeLaneInfo(b []byte) (LaneInfo, error) {
	d := &decoder{buf: b}
	lane, err := d.str16(MaxStreamName, "lane.name")
	if err != nil {
		return LaneInfo{}, err
	}
	if err := d.exactEnd(OpLaneInfo); err != nil {
		return LaneInfo{}, err
	}
	return LaneInfo{Lane: lane}, nil
}

// EncodeLaneState serializes opLaneState (§2.27). Consumers arrive already
// ascending — ordering is the engine's promise, the frame carries it.
func EncodeLaneState(l LaneState) ([]byte, error) {
	if err := laneName(CodeBadStreamName, l.Lane, "lane name"); err != nil {
		return nil, err
	}
	if len(l.Consumers) > 0xFFFF {
		return nil, newOpErr(CodeTooLarge, false, "%d consumers do not fit a u16 count", len(l.Consumers))
	}
	size := 2 + len(l.Lane) + 8 + 1 + 8 + 4 + 2
	for _, c := range l.Consumers {
		if err := laneName(CodeBadStreamName, c.Name, "consumer name"); err != nil {
			return nil, err
		}
		size += 2 + len(c.Name) + 8 + 4 + 1
	}
	b := make([]byte, 0, size)
	b = encStr16(b, l.Lane)
	b = binary.BigEndian.AppendUint64(b, l.Seq)
	flag := byte(0)
	if l.Quarantined {
		flag |= FlagLaneQuarantined
	}
	b = append(b, flag)
	b = binary.BigEndian.AppendUint64(b, l.JournalBytes)
	b = binary.BigEndian.AppendUint32(b, l.KeyCount)
	b = binary.BigEndian.AppendUint16(b, uint16(len(l.Consumers)))
	for _, c := range l.Consumers {
		b = encStr16(b, c.Name)
		b = binary.BigEndian.AppendUint64(b, c.Floor)
		b = binary.BigEndian.AppendUint32(b, c.Pending)
		cFlag := byte(0)
		if c.Attached {
			cFlag |= FlagConsumerAttached
		}
		b = append(b, cFlag)
	}
	return b, nil
}

// DecodeLaneState parses opLaneState.
func DecodeLaneState(b []byte) (LaneState, error) {
	d := &decoder{buf: b}
	lane, err := d.str16(MaxStreamName, "lane.name")
	if err != nil {
		return LaneState{}, err
	}
	seq, err := d.u64()
	if err != nil {
		return LaneState{}, err
	}
	flags, err := d.u8()
	if err != nil {
		return LaneState{}, err
	}
	jb, err := d.u64()
	if err != nil {
		return LaneState{}, err
	}
	keys, err := d.u32()
	if err != nil {
		return LaneState{}, err
	}
	l := LaneState{Lane: lane, Seq: seq, Quarantined: flags&FlagLaneQuarantined != 0, JournalBytes: jb, KeyCount: keys}
	count, err := d.u16()
	if err != nil {
		return LaneState{}, err
	}
	for i := 0; i < int(count); i++ {
		name, err := d.str16(MaxStreamName, "lane.consumer")
		if err != nil {
			return LaneState{}, err
		}
		floor, err := d.u64()
		if err != nil {
			return LaneState{}, err
		}
		pending, err := d.u32()
		if err != nil {
			return LaneState{}, err
		}
		cFlags, err := d.u8()
		if err != nil {
			return LaneState{}, err
		}
		l.Consumers = append(l.Consumers, LaneConsumer{
			Name:     name,
			Floor:    floor,
			Pending:  pending,
			Attached: cFlags&FlagConsumerAttached != 0,
		})
	}
	if err := d.exactEnd(OpLaneState); err != nil {
		return LaneState{}, err
	}
	return l, nil
}
