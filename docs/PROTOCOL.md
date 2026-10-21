# Switchyard Line Protocol — version 1

This is the complete contract between a switchyard server and its clients.
It is the reference for writing a client in any language, and its every
claim is enforced by the test suite in `internal/` — the tables there are
this document in executable form.

Conventions: sentences are normative. Numbers are bus-stable: renumbering
an op or an error code is a new protocol version, not a patch.

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

Any other op code is fatal (`UNKNOWN_OP`). A client sending WELCOME or
DELIVER is fatal (`MALFORMED`) — those numbers are reserved.

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

## §5 Heartbeats and errors

The yard pings a session after `idle` of total silence (default 30s) —
ANY inbound frame counts as liveness, not just PONG. If the session stays
silent for `grace` more (default 10s), the yard sends a fatal
`IDLE_TIMEOUT` error and closes.

Non-fatal refusals (session keeps living): `BAD_SUBJECT`, `DUP_SUB`,
`NO_SUB`, `TOO_LARGE`, `NOT_HANDSHAKED`.

Fatal (the frame is the last thing on the wire, then the connection
ends): `MALFORMED`, `UNSUPPORTED_VERSION`, `SLOW_CONSUMER`, `UNKNOWN_OP`,
`IDLE_TIMEOUT`, and any client-sent WELCOME or DELIVER.

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
| deliver queue (per session) | 512 messages |

The skip rule: a frame that declares a body over the yard's own ceiling
but at or below the protocol ceiling gets its body discarded and its op
refused with `TOO_LARGE` non-fatal; the next frame arrives on a clean
offset because the skip consumed exact bytes. Above the protocol ceiling
the declared length is sabotage — fatal.

Slow consumers: each session has a bounded delivery queue. A server
writer that cannot keep up fills it; the yard then sends the fatal
`SLOW_CONSUMER` and closes rather than buffer without a bound. A client
that needs to catch up does so between reads; the queue depth is the
contract, not an accident.

## §8 Design rationale (condensed)

- Binary with a length prefix over text: payloads are bytes, not text,
  and length-prefix parsing is one read per frame — no escaping, no
  flanking surprises, and trivially portable to any language.
- Magic pair: live debugging means a hex dump you can navigate; it is not
  a resync anchor, which is a lie we chose not to tell.
- No ack on publish in v1: the ack comes in v2 as a storage receipt for
  the durable stream, when durability exists. An ack today would promise
  persistence we do not do yet.
- Client-assigned sids: one sid, one subscription, owned by the client —
  the numbers that make reconnection-resume semantics work in v2+
  (M2, "streams") already have their key space.
