package wire

import "encoding/binary"

// KV-family codecs (§2.18–§2.23): keys ride the same lanes, so the field
// discipline and the receipt reuse follow the stream family's codecs. Shape
// validation here; the key charter's charset and the lane's existence are
// the server's calls — set, tombstone, and list all answer from one lane's
// journal, one kind at a time (§9).

// kvKey checks the length half of the §3.2 charter. An out-of-bounds key is
// BAD_KEY, the refusal for a key-store naming mistake: non-fatal, so a fixed
// key retries on the same session.
func kvKey(key string, field string) error {
	if len(key) == 0 || len(key) > MaxKeyLen {
		return newOpErr(CodeBadKey, false, "%s %d bytes out of range [1,%d]", field, len(key), MaxKeyLen)
	}
	return nil
}

// EncodeKVSet serializes OpKVSet: u16 laneLen|lane, u16 keyLen|key,
// u32 payloadLen|payload. Cache the receipt: same reply family as a publish.
func EncodeKVSet(s KVSet) ([]byte, error) {
	if err := laneName(CodeBadStreamName, s.Lane, "lane name"); err != nil {
		return nil, err
	}
	if err := kvKey(s.Key, "key"); err != nil {
		return nil, err
	}
	room := frameRoom(2 + len(s.Lane) + 2 + len(s.Key) + 4)
	if len(s.Payload) > room {
		return nil, newOpErr(CodeTooLarge, false, "payload %d bytes, room is %d (%d-byte ceiling minus framing)", len(s.Payload), room, MaxBodyBytes)
	}
	b := make([]byte, 0, 2+len(s.Lane)+2+len(s.Key)+4+len(s.Payload))
	b = encStr16(b, s.Lane)
	b = encStr16(b, s.Key)
	b = binary.BigEndian.AppendUint32(b, uint32(len(s.Payload)))
	b = append(b, s.Payload...)
	return b, nil
}

// DecodeKVSet parses OpKVSet.
func DecodeKVSet(b []byte) (KVSet, error) {
	d := &decoder{buf: b}
	lane, err := d.str16(MaxStreamName, "lane.name")
	if err != nil {
		return KVSet{}, err
	}
	key, err := d.str16(MaxKeyLen, "kvset.key")
	if err != nil {
		return KVSet{}, err
	}
	payload, err := d.bytes32(decodeMax, "kvset.payload")
	if err != nil {
		return KVSet{}, err
	}
	if err := d.exactEnd(OpKVSet); err != nil {
		return KVSet{}, err
	}
	return KVSet{Lane: lane, Key: key, Payload: payload}, nil
}

// EncodeKVGet serializes OpKVGet: u16 laneLen|lane, u16 keyLen|key.
func EncodeKVGet(g KVGet) ([]byte, error) {
	if err := laneName(CodeBadStreamName, g.Lane, "lane name"); err != nil {
		return nil, err
	}
	if err := kvKey(g.Key, "key"); err != nil {
		return nil, err
	}
	b := encStr16(nil, g.Lane)
	return encStr16(b, g.Key), nil
}

// DecodeKVGet parses OpKVGet.
func DecodeKVGet(b []byte) (KVGet, error) {
	d := &decoder{buf: b}
	lane, err := d.str16(MaxStreamName, "lane.name")
	if err != nil {
		return KVGet{}, err
	}
	key, err := d.str16(MaxKeyLen, "kvget.key")
	if err != nil {
		return KVGet{}, err
	}
	if err := d.exactEnd(OpKVGet); err != nil {
		return KVGet{}, err
	}
	return KVGet{Lane: lane, Key: key}, nil
}

// EncodeKVDelete serializes OpKVDelete: u16 laneLen|lane, u16 keyLen|key.
func EncodeKVDelete(dlt KVDelete) ([]byte, error) {
	if err := laneName(CodeBadStreamName, dlt.Lane, "lane name"); err != nil {
		return nil, err
	}
	if err := kvKey(dlt.Key, "key"); err != nil {
		return nil, err
	}
	b := encStr16(nil, dlt.Lane)
	return encStr16(b, dlt.Key), nil
}

// DecodeKVDelete parses OpKVDelete.
func DecodeKVDelete(b []byte) (KVDelete, error) {
	d := &decoder{buf: b}
	lane, err := d.str16(MaxStreamName, "lane.name")
	if err != nil {
		return KVDelete{}, err
	}
	key, err := d.str16(MaxKeyLen, "kvdelete.key")
	if err != nil {
		return KVDelete{}, err
	}
	if err := d.exactEnd(OpKVDelete); err != nil {
		return KVDelete{}, err
	}
	return KVDelete{Lane: lane, Key: key}, nil
}

// EncodeKVKeys serializes OpKVKeys: u16 laneLen|lane.
func EncodeKVKeys(k KVKeys) ([]byte, error) {
	if err := laneName(CodeBadStreamName, k.Lane, "lane name"); err != nil {
		return nil, err
	}
	return encStr16(nil, k.Lane), nil
}

// DecodeKVKeys parses OpKVKeys.
func DecodeKVKeys(b []byte) (KVKeys, error) {
	d := &decoder{buf: b}
	lane, err := d.str16(MaxStreamName, "lane.name")
	if err != nil {
		return KVKeys{}, err
	}
	if err := d.exactEnd(OpKVKeys); err != nil {
		return KVKeys{}, err
	}
	return KVKeys{Lane: lane}, nil
}

// EncodeKVValue serializes OpKVValue: u16 laneLen|lane, u16 keyLen|key,
// u64 seq, u8 flags, [u32 payloadLen|payload only when found]. The flag, not
// the payload length, is the truth — an empty value is a legal FOUND.
func EncodeKVValue(v KVValue) ([]byte, error) {
	if err := laneName(CodeBadStreamName, v.Lane, "lane name"); err != nil {
		return nil, err
	}
	if err := kvKey(v.Key, "key"); err != nil {
		return nil, err
	}
	if !v.Found {
		if v.Payload != nil {
			return nil, newOpErr(CodeMalformed, false, "payload set but found flag unset")
		}
		if v.Seq != 0 {
			return nil, newOpErr(CodeMalformed, false, "not-found answers carry seq 0, not %d", v.Seq)
		}
	}
	room := frameRoom(2 + len(v.Lane) + 2 + len(v.Key) + 8 + 1 + 4)
	if len(v.Payload) > room {
		return nil, newOpErr(CodeTooLarge, false, "payload %d bytes, room is %d (%d-byte ceiling minus framing)", len(v.Payload), room, MaxBodyBytes)
	}
	b := make([]byte, 0, 2+len(v.Lane)+2+len(v.Key)+8+1+4+len(v.Payload))
	b = encStr16(b, v.Lane)
	b = encStr16(b, v.Key)
	b = binary.BigEndian.AppendUint64(b, v.Seq)
	flag := byte(0)
	if v.Found {
		flag |= FlagKVFound
	}
	b = append(b, flag)
	if v.Found {
		b = binary.BigEndian.AppendUint32(b, uint32(len(v.Payload)))
		b = append(b, v.Payload...)
	}
	return b, nil
}

// DecodeKVValue parses OpKVValue.
func DecodeKVValue(b []byte) (KVValue, error) {
	d := &decoder{buf: b}
	lane, err := d.str16(MaxStreamName, "lane.name")
	if err != nil {
		return KVValue{}, err
	}
	key, err := d.str16(MaxKeyLen, "kvvalue.key")
	if err != nil {
		return KVValue{}, err
	}
	seq, err := d.u64()
	if err != nil {
		return KVValue{}, err
	}
	flags, err := d.u8()
	if err != nil {
		return KVValue{}, err
	}
	var payload []byte
	if flags&FlagKVFound != 0 {
		payload, err = d.bytes32(decodeMax, "kvvalue.payload")
		if err != nil {
			return KVValue{}, err
		}
	}
	if err := d.exactEnd(OpKVValue); err != nil {
		return KVValue{}, err
	}
	return KVValue{Lane: lane, Key: key, Seq: seq, Found: flags&FlagKVFound != 0, Payload: payload}, nil
}

// EncodeKVKeyList serializes OpKVKeyList: u16 laneLen|lane, u16 count,
// (u16 keyLen|key)×count. Keys arrive already sorted — ordering is the
// server's promise, the frame just carries it.
func EncodeKVKeyList(k KVKeyList) ([]byte, error) {
	if err := laneName(CodeBadStreamName, k.Lane, "lane name"); err != nil {
		return nil, err
	}
	if len(k.Keys) > 0xFFFF {
		return nil, newOpErr(CodeTooLarge, false, "%d keys do not fit a u16 count", len(k.Keys))
	}
	for _, key := range k.Keys {
		if err := kvKey(key, "keylist entry"); err != nil {
			return nil, err
		}
	}
	size := 2 + len(k.Lane) + 2
	for _, key := range k.Keys {
		size += 2 + len(key)
	}
	b := make([]byte, 0, size)
	b = encStr16(b, k.Lane)
	b = binary.BigEndian.AppendUint16(b, uint16(len(k.Keys)))
	for _, key := range k.Keys {
		b = encStr16(b, key)
	}
	return b, nil
}

// DecodeKVKeyList parses OpKVKeyList.
func DecodeKVKeyList(b []byte) (KVKeyList, error) {
	d := &decoder{buf: b}
	lane, err := d.str16(MaxStreamName, "lane.name")
	if err != nil {
		return KVKeyList{}, err
	}
	count, err := d.u16()
	if err != nil {
		return KVKeyList{}, err
	}
	keys := make([]string, 0, count)
	for i := 0; i < int(count); i++ {
		key, err := d.str16(MaxKeyLen, "kvkeylist.key")
		if err != nil {
			return KVKeyList{}, err
		}
		keys = append(keys, key)
	}
	if err := d.exactEnd(OpKVKeyList); err != nil {
		return KVKeyList{}, err
	}
	return KVKeyList{Lane: lane, Keys: keys}, nil
}
