# Switchyard Line Protocol — version 1

This is the complete contract between a switchyard server and its clients.
It is the reference for writing a client in any language, and its every
claim is enforced by the test suite in `internal/` — the tables there are
this document in executable form.

Conventions: sentences are normative. Numbers are bus-stable: renumbering
an op or an error code is a new protocol version, not a patch. The op
table grows by appending: a new op family gets fresh numbers and never
re-means an old one — the durable stream family (§2.8–§2.17) was the
first append, the KV family (§2.18–§2.23) the second, the console
family (§2.24–§2.27) the third, and the auth pair (§2.28–§2.29) the
fourth — and older clients keep working because their ops did not move
and unknown inbound ops have always been fatal.

With switchyard v1.0.0 this surface freezes, exactly as described:
families append, numbers never move or re-mean, error codes stay put,
and a client written against this file today wires up unchanged against
later 1.x yards tomorrow. Anything else would not be a patch to
protocol v1 — it would be v2, written down in a different document.

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

The transport may be wrapped in TLS: the same frames ride a `tls.Conn`
where a bare TCP socket would be. Same magic, same layouts, same
disciplines — nothing below knows, nothing above cares. How TLS happens
is engine configuration, not protocol: a yard that runs with a
certificate and key speaks TLS to every session it accepts (dial from
spur with `-tls`), and a yard's log line says which it is. Trust is the
client's own bar: a self-signed certificate verified against nothing is
a lab tool (`spur -tls -insecure`), never an operating mode. The
password rides inside the wrap or not at all: §2.28's token on an
unwrapped line is a password read aloud in a hallway.

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
|0x15 | KV_SET          | client→server | §2.18 |
|0x16 | KV_GET          | client→server | §2.19 |
|0x17 | KV_DELETE       | client→server | §2.20 |
|0x18 | KV_KEYS         | client→server | §2.21 |
|0x19 | KV_VALUE        | server→client | §2.22 |
|0x1A | KV_KEYLIST      | server→client | §2.23 |
|0x1B | YARD_INFO       | client→server | §2.24 |
|0x1C | YARD_STATE      | server→client | §2.25 |
|0x1D | LANE_INFO       | client→server | §2.26 |
|0x1E | LANE_STATE      | server→client | §2.27 |
|0x1F | AUTHENTICATE    | client→server | §2.28 |
|0x20 | AUTH_OK         | server→client | §2.29 |

Any other op code is fatal (`UNKNOWN_OP`). A client sending WELCOME, DELIVER,
STREAM_READY, STREAM_RECEIPT, CONSUMER_READY, STREAM_DELIVER, STREAM_GONE,
KV_VALUE, KV_KEYLIST, YARD_STATE, LANE_STATE, or AUTH_OK is fatal
(`MALFORMED`) —
those numbers are reserved
for server speech.

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
u16  labelLen  0..48    e.g. "switchyard/1.0.0"
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

### §2.18 KV_SET

```
u16  laneLen    1..64
u8   lane[laneLen]
u16  keyLen     1..128, §3.2
u8   key[keyLen]
u32  payloadLen 0..cap
u8   payload[payloadLen]
```

Writes one key-value record into a lane's journal and answers with the
same STREAM_RECEIPT a publish gets (§2.11). KV records ride the lane's
own sequence space — a set's seq continues after the last publish's —
and the same durability law: the write is fsynced before the receipt
is queued. Refusals: unknown lane `STREAM_UNKNOWN` (buckets are lanes;
a key store starts with `stream create` — the yard will not guess a
bucket into existence), bad key `BAD_KEY` (§3.2), no data dir
`STREAM_DISABLED`, storage fault `SERVER_FAULT`.

KV records are journal rows of their own kind (§9), never stream
messages: consumers attached to the lane see only stream publishes,
and a key's value is read back only with KV_GET/KV_KEYS. A set under
key K whose previous value came from an earlier set simply wins.

### §2.19 KV_GET

```
u16  laneLen    1..64
u8   lane[laneLen]
u16  keyLen     1..128
u8   key[keyLen]
```

Reads one key. The answer is KV_VALUE (§2.22); a key that was never
set — or whose last write was a tombstone — answers with the found
flag clear, which is an answer, not an error.

### §2.20 KV_DELETE

```
u16  laneLen    1..64
u8   lane[laneLen]
u16  keyLen     1..128
u8   key[keyLen]
```

Journals a tombstone for the key and answers with STREAM_RECEIPT whose
`seq` is the tombstone's own. Deleting a key that is not present is
still journaled and confirmed: the delete is idempotent, and a book
that replays from disk sees exactly the deletes that happened.
Afterward every KV_GET of that key answers not-found until the next
set.

### §2.21 KV_KEYS

```
u16  laneLen    1..64
u8   lane[laneLen]
```

Asks for a lane's live keys. The answer is KV_KEYLIST (§2.23).

### §2.22 KV_VALUE

```
u16  laneLen    1..64
u8   lane[laneLen]
u16  keyLen     1..128
u8   key[keyLen]
u64  seq                    the set that wrote this value (0 when not found)
u8   flags                  bit0 FOUND
[ u32  payloadLen
  u8   payload[payloadLen] ]  only when FOUND
```

The KV_GET answer. FOUND means the lane's index holds a live value for
the key, written at `seq`; a zero-length payload is a legal FOUND
(the flags bit, not the payload length, is the truth). Not-found
answers carry no payload section and `seq` 0. The empty payload rule
is why the flag exists.

### §2.23 KV_KEYLIST

```
u16  laneLen    1..64
u8   lane[laneLen]
u16  count      0..live keys
( u16  keyLen
  u8   key[keyLen] ) × count
```

The lane's live keys, ascending bytewise, in one frame. Tombstoned
keys are not listed. Empty `count` is a legal answer for an empty
bucket.

## The console family (§2.24–§2.27)

The yardmaster's view: read-only ops that speak the yard's state back
in one frame each. They ride the same frame machinery, the same
handshake, and the same refusal discipline as every other family — a
console is just another client, and an operator's legibility is worth
as much as a consumer's receipts. Every snapshot is honest about being
a snapshot: it is assembled under each lane's own lock, followed by the
hub's, so consecutive lanes may differ by the nanoseconds between
their reads. There is no global freeze; there is no lying either.

### §2.24 YARD_INFO

```
(empty body)
```

Asks the yard for its summary. The answer is YARD_STATE (§2.25). Read
only, allowed on any handshaked session, whether or not this yard
journals — a memory-only yard still answers with zero lanes. The
request's exactness is the shared rule: an empty body or nothing.

### §2.25 YARD_STATE

```
u16  versionLen   server's version string, e.g. 0.4.0
u8   version[versionLen]
u64  uptimeSec    whole seconds since boot
u32  sessions     open sessions at the snapshot (this one included)
u16  laneCount
( u16  laneLen    1..64, lanes ascending bytewise
  u8   lane[laneLen]
  u64  seq        last journaled sequence; 0 for a lane with no rows ) × laneCount
u16  quarantinedCount
( u16  laneLen
  u8   lane[laneLen] ) × quarantinedCount
```

The lane list is every lane the journals rely on, ascending — `seq`
includes KV rows, one sequence space per lane (§9). Quarantined lanes
are named in full: a lane whose writes have failed once is refused
further writes until restart (§7's durability story), and that state
is exactly what an operator must not have to guess at. Empty
`laneCount` is a legal answer on a memory-only yard.

### §2.26 LANE_INFO

```
u16  laneLen    1..64
u8   lane[laneLen]
```

Asks one lane for its detail. The answer is LANE_STATE (§2.27).
Refusals: unknown lane `STREAM_UNKNOWN` (the print says the drill-down
ought to be a `stream create` away), no data dir `STREAM_DISABLED`.
Read only; nothing here mutates, not even a tick of redelivery state.

### §2.27 LANE_STATE

```
u16  laneLen    1..64, echoed
u8   lane[laneLen]
u64  seq        last journaled sequence
u8   flags      bit0 QUARANTINED
u64  journalBytes  the journal file's size on disk
u32  keyCount   live keys (the KV index, tombstones subtracted)
u16  consumerCount
( u16  nameLen
  u8   name[nameLen]
  u64  floor      highest sequence fully acknowledged (durable position)
  u32  pending    delivered-but-not-acked rows right now
  u8   flags      bit0 ATTACHED ) × consumerCount, ascending by name
```

The drill-down a yardmaster reads before acting: how far the lane has
journaled, how much disk it claims, what its key store holds, and
where every durable consumer stands. `floor` is the consumer's
durable position — the number it will resume from — and `pending`
counts the rows it owes acks for; a detached consumer stays in the
list with ATTACHED clear, holding its floor, owed nothing.

## The auth pair (§2.28–§2.29)

One shared token, spoken before the handshake: the simplest lock that
makes a yard company-usable. Not a nickname for multi-tenant identity —
a yard has one gate, and the people behind it are trusted. The token is
compared in constant time (`crypto/subtle`): a wrong token's refusal is
no faster than a right token's welcome. TLS is §1's job; the token
rides inside the wrap when one is running, and a yard that demands a
token should demand a wrap to carry it through — one is configuration,
the other is protocol, and they compose without knowing each other.

### §2.28 AUTHENTICATE

```
u16  tokenLen   1..256
u8   token[tokenLen]
```

The gate's password. Legal only on a session that has not yet HELLO'd —
identity belongs to the door, not the hallway. The answer is AUTH_OK
(§2.29), or a fatal `NOT_ALLOWED`, or nothing at all:

- Yard tokened, token matches → `AUTH_OK`, the session may HELLO. A
  HELLO from a session that skipped it → fatal `NOT_ALLOWED`. PING and
  BYE stay open — they carry no state and answer no questions about the
  yard's content, and a load balancer deserves a liveness answer.
- Yard tokened, token does not match → fatal `NOT_ALLOWED`; the
  connection ends. There is no retry on the same socket: reconnect and
  try again, because a gate does not sit and listen to guesses.
- Yard tokenless → any well-formed token is answered with `AUTH_OK`.
  Nothing to protect, nothing to check. A tokenless yard's boot log
  says `auth=off`; an operator who believes otherwise has not read the
  log.
- Handshake already done → fatal `NOT_ALLOWED` — the door is behind
  the client now.

An empty or oversize token is a shape error and dies with `MALFORMED`
like every other exactness breach. Client-sent `AUTH_OK` is fatal
(`MALFORMED`): that number is the yard's speech.

### §2.29 AUTH_OK

```
(empty body)
```

The gate nods. No payload, no negotiation — the session is free to
HELLO. It says nothing about whether the yard wanted a token; that
fact is the yard's config and its log, not the wire's.

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

### §3.2 KV keys

A KV key is 1..128 bytes of `[A-Za-z0-9_.-/]`. Dots and slashes are
ordinary key bytes here — keys are never parsed as subjects (§3), and
they live inside journal record bodies, never as directory names — so
`cart.json`, `config/app/v2`, and `v1.2.3` are all legal, wildcard-free
keys. The charset is the §3.1 discipline grown by one, and like every
charter it is exact bytes: matching is case-sensitive, no folding.

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
`IDLE_TIMEOUT`, `NOT_ALLOWED`, and any client-sent reserved-server op
(§2).

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
| 0x13 | BAD_KEY             | no     | KV key off the §3.2 charter                |
| 0x14 | NOT_ALLOWED         | yes    | the gate said no: wrong token, no token, or auth after the door |

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
| KV key bytes   | 128                  |
| auth token     | 1..256 bytes         |
| deliver queue (per session) | 4096 messages |
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
`u32 bodyLen | body | u32 crc32(body)`, where body starts with
`u64 seq | u8 kind` and the rest depends on the kind:

```
kind 0x01 stream message: u16 subjLen|subj | flags[replyLen|reply]
                          | u32 payloadLen|payload
kind 0x02 KV set:         u16 keyLen|key | u32 payloadLen|payload
kind 0x03 KV tombstone:   u16 keyLen|key
```

No kind is ever re-meant, the same rule the wire op table lives by.
A record's CRC covers its
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
