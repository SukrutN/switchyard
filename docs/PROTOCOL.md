# Switchyard Line Protocol — version 1

This is the complete contract between a switchyard server and its clients.
It is the reference for writing a client in any language, and its every
claim is enforced by the test suite in `internal/` — the tables there are
this document in executable form.

Conventions: sentences are normative. Numbers are bus-stable: renumbering
an op or an error code is a new protocol version, not a patch. The op
table grows by appending: a new op family gets fresh numbers and never
re-means an old one — the durable stream family (§2.8–§2.17) was the
first append, and older clients keep working because their ops did not
move and unknown inbound ops have always been fatal.

## §1 Frame layout

TCP. Big-endian everywhere. One logical transaction is one frame:

```
offset  size  field
0       2     magic, exactly 0x53 0x59 ("SY")
2       1     protocol version, exactly 0x01
3       1     op code, §2
4       4     body length, u32 (bytes after the header)
8       n     body, layout per op, empty allowed where noted
```

Rules:

- A reader that sees wrong magic stops trusting byte offsets and closes the
  connection fatal (code `MALFORMED`). There is no resync: after a desync
  the offset is unknowable by construction, and a heuristic that guesses
  would be lying about where the stream is.
- A reader that sees a wrong version replies `UNSUPPORTED_VERSION` —
  fatal, then closes (see §6 for codes).
- A declared body length above the negotiated ceiling maps to the skip
  behavior in §7. Above the protocol ceiling (4 MiB), the only safe answer
  is fatal close.
- Ops are independent units; server-initiated frames (PING, DELIVER) can
  interleave client→server traffic at any boundary between frames.

## §2 Ops

| op  | name      | direction        | body    |
|-----|-----------|------------------|---------|
|0x01 | HELLO     | client→server    | §2.1    |
|0x02 | WELCOME   | server→client    | §2.2    |
|0x03 | PING      | client→server    | empty   |
|0x04 | PONG      | server→client    | empty   |
|0x05 | PUBLISH   | client→server    | §2.3    |
|0x06 | SUBSCRIBE | client→server    | §2.4    |
|0x07 | UNSUB     | client→server    | §2.5    |
|0x08 | DELIVER   | server→client    | §2.6    |
|0x09 | ERROR     | server→client    | §2.7    |
|0x0A | BYE       | both             | empty   |
|0x0B | STREAM_CREATE | client→server | §2.8   |
|0x0C | STREAM_READY  | server→client | §2.9   |
|0x0D | STREAM_PUBLISH| client→server | §2.10  |
|0x0E | STREAM_RECEIPT| server→client | §2.11  |
|0x0F | CONSUMER_ATTACH | client→server | §2.12 |
|0x10 | CONSUMER_READY  | server→client | §2.13 |
|0x11 | STREAM_DELIVER  | server→client | §2.14 |
|0x12 | ACK             | client→server | §2.15 |
|0x13 | STREAM_DELETE   | client→server | §2.16 |
|0x14 | STREAM_GONE     | server→client | §2.17 |

Any other op code is fatal (`UNKNOWN_OP`). A client sending WELCOME, DELIVER,
STREAM_READY, STREAM_RECEIPT, CONSUMER_READY, STREAM_DELIVER, or STREAM_GONE
is fatal (`MALFORMED`) — those numbers are reserved for server speech.

### §2.1 HELLO

```
u8   nameLen   0..64    display-only; logs
u8   name[nameLen]
u8   labelLen  0..16    client family tag ("cli", "go-sdk"); logs
u8   label[labelLen]
```

Empty name or label is legal. Server answers WELCOME and the session is
live; ops before it (except HELLO itself) are refused `NOT_HANDSHAKED`,
non-fatal, except PING which answers PONG early (probe-the-yard use).

### §2.2 WELCOME

```
u16  labelLen  0..48    e.g. "switchyard/0.1.0"
u8   label[labelLen]
u32  maxBody            this yard's frame-body ceiling
```

`maxBody` is authoritative and can be lower than the protocol ceiling but
never higher. Clients that need a limit read it here.

### §2.3 PUBLISH

```
u16  subjLen   1..255
u8   subj[subjLen]
u8   flags                bit0 REPLY_PRESENT
[ u16 replyLen  1..255    only when REPLY_PRESENT
  u8  reply[replyLen] ]
u32  payloadLen  0..cap
u8   payload[payloadLen]
```

The subject must be concrete (§3): a publish carrying a wildcard is
refused `BAD_SUBJECT`, non-fatal. There is no ack in v1 — the write is
the contract, and refusals arrive as ERROR frames (§5).

### §2.4 SUBSCRIBE

```
u16  patternLen  1..255
u8   pattern[patternLen]
u32  sid                1..2^32-1, client-assigned, unique per session
```

One sid is exactly one live subscription. A repeated sid — same or
different pattern — is refused `DUP_SUB`, non-fatal, and clients that
want to change a pattern unsubscribe first (`UNSUB` costs nothing).

There is no subscribe ack in v1. The first publish that provably reaches
a fresh subscription is one sent after a delivery from it has already
returned. A publish fired from a different connection immediately after
subscribing can race ahead of the registration — that is a lost message
by construction, not a yard bug; ordering promises return with durable
streams (M2).

### §2.5 UNSUB

```
u32  sid
```

Unknown sid is an ERROR, code `NO_SUB`, non-fatal, and harmlessly
ignorable.

### §2.6 DELIVER

```
u16  subjLen   1..255
u8   subj[subjLen]
u32  sid       the subscription this is for
u32  seq       per-sid, starts at 1, gapless (§4)
u8   flags     bit0 REPLY_PRESENT
[ u16 replyLen
  u8  reply[replyLen] ]
u32  payloadLen
u8   payload[payloadLen]
```

The subject text here is byte-identical to what the publisher wrote —
tokens are never normalized, split, or translated (§4).

### §2.7 ERROR

```
u8   code      §6
u16  msgLen    0..255    operator-facing text; truncates, never fails
u8   msg[msgLen]
u8   flags     bit0 FATAL — server closes after sending
```

Messages are for humans; their wording may change between releases.
Codes are promises.

### §2.8 STREAM_CREATE

```
u16  nameLen   1..64
u8   name[nameLen]
```

Opens a durable lane. The name charter is §3.1 — these names become
directory names under the yard's data dir, so they are stricter than
subjects. The answer is STREAM_READY with the lane's first sequence
(`1` for a fresh lane). Creating the same name twice is refused
`STREAM_EXISTS`, non-fatal.

A lane catches every concrete subject whose first token equals its name:
stream `orders` journals `orders` itself and everything under `orders.>`,
such as `orders.e9.paid`. One token in, one lane; two lanes can never
share a prefix.

### §2.9 STREAM_READY

```
u16  nameLen   1..64
u8   name[nameLen]
u64  seq                    the next number the lane will assign
```

`seq` after a fresh create is 1. After recovery (§9) it continues past
the last journaled message, so a client that holds a receipt can always
tell what survived.

### §2.10 STREAM_PUBLISH

```
u16  streamLen  1..64
u8   stream[streamLen]
u16  subjLen    1..255
u8   subj[subjLen]
u8   flags                 bit0 REPLY_PRESENT
[ u16 replyLen  1..255
  u8  reply[replyLen] ]
u32  payloadLen  0..cap
u8   payload[payloadLen]
```

The subject rules of §3 apply (concrete, charter-clean), and its first
token must equal the stream name; anything else is refused
`STREAM_SUBJECT`, non-fatal. A publish to a lane that does not exist is
refused `STREAM_UNKNOWN`, non-fatal.

The yard journals the message first, then answers, then fans out. The
write is fsynced before the receipt is queued — the receipt means the
bytes are on disk, not "somewhere in RAM I lost my way in".

### §2.11 STREAM_RECEIPT

```
u16  streamLen  1..64
u8   stream[streamLen]
u64  seq                    the number the lane assigned, starts at 1
```

The durable publish ack. Within one session, receipts arrive in that
session's publish order (its publishes serialize on its reader goroutine
before receiving numbers), so a single-session publisher reads them as
"my k-th publish landed at seq s" without a correlation field.
Cross-session there is no relative order, and the lane's `seq` is the
only arbitration — receipt ordering across sessions is not a promise.
Only sequences confirmed by receipts are journaled: a publish whose
write hit an IO fault answers `SERVER_FAULT` and assigned no number.

### §2.12 CONSUMER_ATTACH

```
u16  streamLen  1..64
u8   stream[streamLen]
u16  consumerLen  1..64
u8   consumer[consumerLen]
u8   flags                 bit0 FILTER_PRESENT
[ u16 filterLen  1..255
  u8  filter[filterLen] ]
u32  sid                   1..2^32-1, one live consumer per sid per session
u32  ackWaitMillis         0 = yard default (§7)
```

Attaches a push consumer to a lane. The consumer answer is
CONSUMER_READY; deliveries then flow as STREAM_DELIVER. The filter is a
§3 pattern applied to the message subject — without it the consumer
catches the whole lane. Unknown lanes refuse `STREAM_UNKNOWN`.

Consumer names are durable across sessions. Attaching a name that is
already live on another session is refused `DUP_CONSUMER`, non-fatal;
reattaching the same name (the consumer's session died) is the resume
path — the yard replays from the consumer's persisted position. A client
ending its consumer detaches with UNSUB on its sid, which forgets
nothing; the consumer stays durable until the lane is deleted.

### §2.13 CONSUMER_READY

```
u16  streamLen
u16  consumerLen
u32  sid
u64  next                  first sequence this consumer will receive
u32  ackWaitMillis         the effective value in force (echo)
```

The settle frame for durable consumers — a fresh v1 subscription's
first provable delivery is a publish round trip; a durable consumer's is
this frame. `next` is what the client should expect first: the resume
floor after a session loss, the current lane tip+1 for a fresh consumer
that asked to start now. Delivery numbering follows §2.14.

### §2.14 STREAM_DELIVER

```
u16  subjLen   1..255
u8   subj[subjLen]
u32  sid       the sid this consumer attached with (§2.12)
u64  seq       the LANE's sequence: shared by every consumer of one lane
u8   flags     bit0 REPLY_PRESENT
[ u16 replyLen
  u8  reply[replyLen] ]
u32  payloadLen
u8   payload[payloadLen]
```

Subject and payload are byte-identical to the publisher's frames. The
sequence is the lane's journal sequence, not a per-session counter:
every consumer of one lane sees the same number for the same message,
which is exactly what ACK (§2.15) and replay logic are built on.

### §2.15 ACK

```
u32  sid
u64  seq
```

Consumer acknowledgment, one message at a time. The yard advances a
consumer's floor across contiguous acks; unacked messages replay after
`ackWait`, always in sequence order — delivery is at-least-once and the
duplicates carry the same `seq`. There is no reply frame for ACK; an
ack for a sequence the yard did not send (or already counted) is
ignored, not penalized.

### §2.16 STREAM_DELETE

```
u16  nameLen   1..64
u8   name[nameLen]
```

Deletes a lane: journal and consumer positions go with it. Attached
sessions stop receiving; the yard answers STREAM_GONE to each of them
— exactly once per session, the deleting session's own copy included
— and their sids are free immediately. Consumer names on a deleted
lane are gone — "reattach and resume" returns nothing. Messages
outside the lane's journal that were still pending delivery are gone
with it.

### §2.17 STREAM_GONE

```
u16  nameLen   1..64
u8   name[nameLen]
```

Confirm of §2.16, sent exactly once to every session that held a
consumer on the deleted lane or issued the deletion. Receipts,
deliveries, and consumer states of a lane
outside the journal discipline have exactly one owner: the operator
who deleted it.

## §3 Subject charter

A subject or pattern is dot-separated tokens under these rules:

| rule              | value                                      |
|-------------------|--------------------------------------------|
| separator         | '.'                                        |
| token count       | 1..32                                      |
| token bytes       | 1..64 each                                 |
| token charset     | printable ASCII, 0x21..0x7E                |
| total bytes       | 1..255                                     |
| forbidden inside a token | '.', and the wildcard symbols '*' '>' except as full tokens |

Wildcard rules on hand forever:

- `*` matches exactly ONE token, in any position: `orders.*.paid`
- `>` matches the remaining tokens of a published subject (at least one)
  and must be the final token: `orders.>` catches `orders.e9.paid` but
  NOT bare `orders`
- wildcards are patterns-only: a PUBLISH subject with one is refused

Matching is exact bytes: case-sensitive, no charset folding.

### §3.1 Lane names (streams and consumers)

A stream name or consumer name is 1..64 bytes of `[A-Za-z0-9_-]` — a
subject-charter token under a stricter charset, because those names
become directory names under the data dir. `..`, `/`, `\`, `:` and
friends are chartered subjects; they are not chartered lanes.

## §4 Delivery guarantees

- Per subscription (a session's sid), deliveries arrive in the order the
  yard accepted them, stamped with gapless `seq` starting at 1.
- Between two subscriptions the yard promises nothing about relative
  order; one sid is one ordered stream, several sids are several streams.
- The yard never renames, re-canonicalizes, or reorders subjects for
  deliverability. What the publisher sends, every subscriber receives —
  byte-identical subject, byte-identical payload.
- The yard does not invent messages, late receipts, or special
  deliverability translations. If nothing was published, nothing arrives.

Lane law (§2.8–§2.17) strengthens three of these for streams:

- Lane sequences are gapless from 1 and assigned in journal order, so
  every consumer of one lane sees one total order, and the same number
  for the same message, forever.
- Consumer delivery is at-least-once: a message replays until its ACK
  falls inside the consumer's contiguous floor, and replays keep lane
  order. Exactly-once is a cooperation problem between peers, not
  something a broker can promise alone — lanes promise "never lost",
  never "never repeated".
- A stream publish also fans out to live spurs (§2.3 subscribers). A
  client watching a subject both ways sees it twice — once from the
  spur, once from the lane; the lane's seq is the dedupe key.

## §5 Heartbeats and errors

The yard pings a session after `idle` of total silence (default 30s) —
ANY inbound frame counts as liveness, not just PONG. If the session stays
silent for `grace` more (default 10s), the yard sends a fatal
`IDLE_TIMEOUT` error and closes.

Non-fatal refusals (session keeps living): `BAD_SUBJECT`, `DUP_SUB`,
`NO_SUB`, `TOO_LARGE`, `NOT_HANDSHAKED`, plus every lane refusal of §6
— lanes refuse and keep going; killing a session over a naming mistake
serves nobody.

Fatal (the frame is the last thing on the wire, then the connection
ends): `MALFORMED`, `UNSUPPORTED_VERSION`, `SLOW_CONSUMER`, `UNKNOWN_OP`,
`IDLE_TIMEOUT`, and any client-sent reserved-server op (§2).

## §6 Error codes

| code | name                | fatal  | meaning                                    |
|------|---------------------|--------|--------------------------------------------|
| 0x01 | MALFORMED           | yes    | frame did not parse                        |
| 0x02 | UNSUPPORTED_VERSION | yes    | version byte does not match               |
| 0x03 | BAD_SUBJECT         | no     | charter refused (§3)                       |
| 0x04 | DUP_SUB             | no     | sid already subscribed in this session     |
| 0x05 | NO_SUB              | no     | sid unknown to this session                |
| 0x06 | TOO_LARGE           | no     | body over this yard's advertised ceiling   |
| 0x07 | SLOW_CONSUMER       | yes    | session stopped reading its deliveries     |
| 0x08 | NOT_HANDSHAKED      | no     | op sent before HELLO completed             |
| 0x09 | UNKNOWN_OP          | yes    | op code with no meaning in this version    |
| 0x0A | IDLE_TIMEOUT        | yes    | silent past idle + grace                   |
| 0x0B | STREAM_UNKNOWN      | no     | no lane by this name                       |
| 0x0C | STREAM_EXISTS       | no     | create refused: lane already exists        |
| 0x0D | BAD_STREAM_NAME     | no     | lane name off the §3.1 charter             |
| 0x0E | STREAM_SUBJECT      | no     | subject's first token is not this lane     |
| 0x0F | DUP_CONSUMER        | no     | consumer name live on another session      |
| 0x10 | NO_CONSUMER         | no     | consumer name unknown to this lane         |
| 0x11 | STREAM_DISABLED     | no     | this yard has no data dir; no lanes        |
| 0x12 | SERVER_FAULT        | no     | storage could not honor the op; retry |

## §7 Limits and the skip rule

| limit          | value                |
|----------------|----------------------|
| frame body cap (protocol) | 4 MiB     |
| frame body cap (yard default) | 1 MiB  |
| subject/pattern bytes | 255           |
| reply bytes    | 255                  |
| client name    | 64                   |
| client label   | 16                   |
| server label   | 48                   |
| stream / consumer name | 64           |
| deliver queue (per session) | 512 messages |
| control queue (per session) | 256 frames  |
| consumer ack-wait default | 10 seconds |

The skip rule: a frame that declares a body over the yard's own ceiling
but at or below the protocol ceiling gets its body discarded and its op
refused with `TOO_LARGE` non-fatal; the next frame arrives on a clean
offset because the skip consumed exact bytes. Above the protocol ceiling
the declared length is sabotage — fatal.

Slow consumers: each session has a bounded delivery queue. A server
writer that cannot keep up fills it; the yard then sends the fatal
`SLOW_CONSUMER` and closes rather than buffer without a bound. A client
that needs to catch up does so between reads; the queue depth is the
contract, not an accident. Lane redelivery keeps pending entries for
unacked sequences no matter what the consumer's queue is doing — a slow
consumer on a lane does not slow the lane; it just replays when it
catches up.

## §8 Design rationale (condensed)

- Binary with a length prefix over text: payloads are bytes, not text,
  and length-prefix parsing is one read per frame — no escaping, no
  flanking surprises, and trivially portable to any language.
- Magic pair: live debugging means a hex dump you can navigate; it is not
  a resync anchor, which is a lie we chose not to tell.
- Publish acks arrived with streams (§2.11), not before: an ack would
  have promised persistence the M1 yard did not do. The receipt is the
  honest version — it means the bytes are fsynced to the journal.
- At-least-once over exactly-once on lanes: a broker that acknowledges
  before fsync, or claims to dedupe across client bugs, is selling a
  guarantee the wires cannot keep. Duplicates are observable and cheap;
  silence is neither.
- On-disk per-record CRC instead of trust-the-OS-allocator: torn tails
  are a fact of power loss, and recovery stops at the last record whose
  CRC says it is whole (§9). A journal that extrapolates from a torn
  tail is lying about what survived.
- Client-assigned sids: one sid, one subscription, owned by the client —
  the numbers that make reconnection-resume semantics work in v2+
  ("streams"). Durable consumers reuse the sid space per session and
  layer durable identity (§2.12) on top.

## §9 On disk: journals, recovery, and durability

Layout is one directory per lane, names from §3.1:

```
<DataDir>/streams/<name>/journal.log    append-only, the lane's record
<DataDir>/streams/<name>/consumers/<name>.state   one per durable consumer
```

Journal record framing (big-endian, the same discipline as the wire):
32-byte file header, then records of
`u32 bodyLen | body | u32 crc32(body)`, where body is
`u64 seq | u8 kind | u16 subjLen|subj | flags[replyLen|reply] | u32 payloadLen|payload`.
`kind` byte 0x01 is a stream message; later families (KV) get their own
kinds and must not re-mean this byte space. A record's CRC covers its
body only; the length prefix plus CRC choose between "complete record"
and "torn tail".

Write order is the durability story: assign `seq` under the lane's lock,
fsync, then and only then answer the receipt (§2.11). A write or fsync
error quarantines the lane — it refuses further publishes with
`SERVER_FAULT` rather than pretending luck improved, until restart.

Recovery (on boot): read the header, read records until one fails its
length/CRC or the file ends, then truncate the file back to the last
intact record. Every record after a torn tail is debris — no record
gets guessed from fragments, no sequence gets inferred without its
bytes. Consumer states are read the same way; a torn consumer state
reads as the last intact snapshot, which redelivers a little (allowed,
at-least-once) rather than loses anything.

Durability levels in this release: message bytes fsync per publish;
consumer floors fsync per ack. Both are correct and slow — M4's
benchmark work is where throughput policy is measured, not snuck in.
