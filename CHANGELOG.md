# Changelog

All notable changes to switchyard are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [SemVer](https://semver.org/).

## [1.0.0] — 2026-10-21

The yard ships. No new ops and no engine changes — this is the promise
release: the protocol surface is frozen (appends only, as the law has
said since the first family grew), the client library and spur speak
all of it, and the docs claim the whole feature list for the first
time: pub/sub, durable streams ("lanes"), KV, the Yardmaster lens,
token auth with TLS sessions, and the yardstick rod.

### Added
- README "What v1.0 has": the complete claim list, each feature tied to
  its spec section — replacing the v0.1-era inventory that had survived
  on courtesy long past its truth.
- `docs/PROTOCOL.md` states the v1.0 pledge: op numbers never move,
  families append, error codes stay put, a client written against the
  file wires up unchanged against later 1.x yards.

### Changed
- `switchyard` reports version **1.0.0** (the WELCOME label and the
  Yardmaster console).

## [0.6.0] — 2026-10-21

Milestone M4, second half — yardstick, the yard's measuring rod: a
counts-honest bench suite and the drain arithmetic it exposed. The
README grows "the yard by the numbers".

### Added
- `cmd/yardstick`: reproducible numbers against one live yard, in the
  yard's own words — `ping` (round-trip probes, min/p50/p95/max),
  `pubsub` (fan-out through the delivery queues, printing what the yard
  *sustains*), `journal` (lane rows and KV sets, receipt per row — the
  fsync story told honestly). The counting reader holds every delivery
  (sized buffer, `-n×-subs` guarded); a run that dropped or lost
  anything refuses to print instead of flattering itself. Verb-first
  dispatch like spur: `yardstick pubsub -n 500`.
- `scripts/bench.ps1`: a throwaway yard on a temp dir, all scenarios,
  full teardown — one command, one durable table for the README.

### Changed
- The bench exposed a pure-arithmetic lawbreaker: the hub enqueues
  fan-out at memory speed while the session writer spent three syscalls
  per frame and the reader two recvs. In that gap, a fire-and-forget
  burst filled the queue and reaped readers that were never slow. Now:
  one write per frame (header and body coalesced), the writer batch-
  drains the queue (≤256 frames or 256 KiB per flush, order riding
  dequeue order), sessions read through 32 KiB buffers on both ends,
  TCP_NODELAY is explicit everywhere, and the default deliver-queue dam
  widens 512 → 4096. The slow-consumer law is unchanged — when its
  verdict lands, it means the paused reader, not plumbing overhead.
- Fatal kills land their last words before the socket goes dark:
  flush, half-close, one short drain beat, close. A hard close right
  after the final send could reset the wire mid-frame on Windows; a
  killed session's message to its client must arrive.
- yardstick's pubsub publishes in waves gated by the counting reader
  (≤2048 deliveries per wave): the wire gives fire-and-forget no
  backpressure, so the scene restricts itself — the rate printed is the
  sustained one, not a queue-cap lottery.

## [0.4.0] — 2026-09-14

Milestone M3 — the Yardmaster console: the yard's state, spoken on the
wire and read from spur. Read-only ops; the console is a lens, not a
lever.

### Added
- Console wire family (§2.24–§2.27, ops 0x1B–0x1E): `YARD_INFO` answers
  `YARD_STATE` (§2.25) — the build's version, uptime in seconds, live
  sessions (the asking one included), every lane ascending with its last
  journaled seq (KV rows included: one sequence space per lane, §9), and
  every quarantined lane named in full — a lane whose writes have failed
  once is exactly what an operator must not have to guess at.
  `LANE_INFO` answers `LANE_STATE` (§2.27) — last journaled seq, the
  quarantine flag, the journal file's byte size on disk, live key count,
  and the consumer table: each durable consumer's floor (the sequence it
  resumes from), how many delivered rows still owe acks, and whether it
  is attached this second.
- Honesty clause (§2.25): these are snapshots assembled lane by lane
  under each lane's own lock, followed by the hub's — consecutive rows
  may differ by the moments between reads, and the doc says so. No
  global freeze, no lying either.
- `YARD_STATE` answers on any handshaked yard, memory-only included
  (zero lanes is a legal answer); `LANE_INFO` refuses a missing lane
  with `STREAM_UNKNOWN` and a disabled yard with `STREAM_DISABLED`. The
  summary body's exactness is the shared rule — a stray trailing byte
  is a fatal `MALFORMED` kill like anywhere else.
- Console snapshots in the engine: `consoleSeq` and `consoleState` on
  each lane under its own lock (an attached row is `sess != nil &&`
  not dead — the sweep's own definition), a registry scan for the
  yard's table, and the hub's session count plus boot time.
- The client library gains `YardInfo` and `LaneInfo` — one synchronous
  turn each under the shared RPC discipline, refusals surfacing as
  errors while `Errors()` keeps the copy. `spur yard` prints the
  summary; `spur yard lane LANE` drills down; quarantined lanes and
  parked consumers read plainly from a terminal.

## [0.5.0] — 2026-09-27

Milestone M4, first half — the gate and the wrap: one shared token at
the door (§2.28–§2.29) and TLS under every session (§1). The yard,
company-usable.

### Added
- The auth pair on the wire (§2.28, ops 0x1F/0x20): `AUTHENTICATE` is
  one 1..256-byte token spoken before HELLO; the yard answers `AUTH_OK`
  (an empty nod) or closes the connection with the new fatal code
  `NOT_ALLOWED` (0x14). The comparison runs in constant time
  (`crypto/subtle`) — a wrong token's refusal is no faster than a right
  token's welcome. Identity belongs to the door: a knock after the
  handshake is fatal; so is a HELLO reaching a tokened yard without a
  knock. PING and BYE stay open — they carry no state, and a load
  balancer deserves a liveness answer.
- Yard refusals say which: "the yard is tokened; send Authenticate
  first", "that token did not open the gate". No second guess on the
  same socket — reconnect and try again.
- A tokenless yard accepts any well-formed knock with `AUTH_OK`: nothing
  to protect, nothing to check, and the boot log says `auth=off`. A
  tokened yard on a plaintext line is a password read in a hallway —
  compose them.
- TLS transport (§1): a yard booted with both `-cert` and `-key` wraps
  every session in TLS 1.2-or-better on the same frames, same magic,
  same disciplines. One half of a keypair is refused at boot, not
  silently downgraded. The client wraps at dial (`Options.TLS`,
  `spur -tls`); `SkipVerify` / `spur -insecure` is the lab switch for
  self-signed certificates and is never an operating mode. Plaintext
  dials to a TLS listener die at the wrap's first read: the wrap is the
  whole session.
- Dial order is now protocol, not preference: TLS if asked, the knock if
  the yard demands one, HELLO last — and handshakes that die under the
  gate surface as `ClientError` with the yard's own words for both the
  Go client and `spur`.
- `spur` grows three every-verb flags: `-auth TOKEN`, `-tls`,
  `-insecure`; the yard grows `-auth`, `-cert`, `-key`, and its boot
  line now says `auth=on/off tls=on/off`.

### Notes
- Token length shape is the wire's business (1..256 bytes, killed as
  `MALFORMED` on violation); token choice, length, entropy, and
  rotation are the operator's: use long random tokens, and prefer TLS
  whenever the line is not yours alone.
- The auth pair is the protocol's fourth family append (§2 preamble);
  ops before it did not move, and an old client's HELLO at a tokened
  yard gets the gate's refusal printed plainly rather than a hang.

## [0.1.0] — 2026-07-18

Milestone M1 — pub/sub core.

### Added
- Wire protocol v1: 8-byte framed transport (magic `SY`, version, op,
  u32 body length), ten ops (`HELLO` … `BYE`), nine named error codes plus
  the idle-timeout code, and the exact body layouts in
  `docs/PROTOCOL.md`. The codec lives in `internal/wire` — one source of truth
  for both sides of every connection.
- Subject charter (dot tokens, `*` one-token, `>` trailing-capture,
  wildcards subscriptions-only) with a matching engine under
  `internal/subjects`, backed by a ~30-case table of charter and match
  semantics.
- The yard (`internal/server`, `cmd/switchyard`): TCP accept loop,
  per-session reader/writer goroutine pairs, bounded deliver queues with
  the fatal `SLOW_CONSUMER` contract, gapless per-subscription delivery
  sequences stamped by each session's writer, trie-based routing hub with
  node pruning on unsubscribe, idle-heartbeat machinery (`PING` then a
  grace window then fatal `IDLE_TIMEOUT`), and a skip rule that discards
  oversized-but-bounded bodies without breaking framing.
- `spur` (`cmd/spur`), the reference CLI: `ping`, `pub`, `sub`.
- Reference client library `internal/client`: dial/handshake, buffered
  deliveries with an honest dropped counter, async refusal surface,
  ping round-trips, symmetric BYE close.
- Integration suite over real TCP sockets: lifecycle, burst ordering
  (50 messages), reply-subject delivery, charter refusals, duplicate
  sid, reserved-op fatality, unknown-op fatality, idle timeout, silent
  keepalive holding, oversize-skip recovery, and slow-consumer reaping.
- Repo hygiene: Apache-2.0 license, CI gate (fmt, vet, tests with race
  detection on Linux runners), user-facing docs, issue template, and a
  reproducible `scripts/demo.ps1`.

## [0.3.0] — 2026-08-23

Milestone M2, second half — KV over the same journal: a bucket is a lane,
a set is a journaled record with a receipt, and a tombstone is as durable
as a set.

### Added
- KV wire family (§2.18–§2.23, ops 0x15–0x1A): `KV_SET` answers with the
  same fsynced `STREAM_RECEIPT` a publish gets, riding the lane's own
  sequence space; `KV_GET` answers `KV_VALUE`, whose found flag is the
  truth — an empty-but-present value is legal, so absent answers carry
  the flag clear and seq 0, never an error; `KV_DELETE` journals the
  tombstone and confirms it with its own seq (deleting a key that was
  never set is still a journaled fact); `KV_KEYS` lists a lane's live
  keys in one frame, ascending bytewise.
- Key charter §3.2: 1..128 bytes of `[A-Za-z0-9_.-/]` — dots and slashes
  are ordinary key bytes; keys are never parsed as subjects and never
  become directories. One new named refusal code: `BAD_KEY` (0x13),
  non-fatal like every lane refusal.
- Record kinds 0x02 (KV set) and 0x03 (KV tombstone) in the lane's
  append-only journal (§9) under the same length+CRC framing. Boot-time
  index rebuild is one scan: last set wins, tombstones erase. Live sets
  and deletes hold the index current under the lane's own lock.
- Journal recovery is envelope-first: a record whose length and CRC are
  intact but whose kind this version has never met stays on disk whole —
  a newer family arriving from a newer server cannot poison this boot.
- `spur kv set|get|del|keys`; the client library gains `KVSet`,
  `KVDelete` (receipt-paired, turn-taking like publishes), `KVGet`, and
  `KVKeys`.

### Notes
- KV rows never deliver to stream consumers: replay, sweep, and fresh
  delivery skip every non-stream record kind, and a consumer's floor
  crosses their sequences once the real rows are acked — one sequence
  space per lane, one kind of row per family, no double-reading.
- KV sets share lanes with streams deliberately: mixed `stream push` /
  `kv set` traffic is one fsync-per-record story with gapless seq, not
  two stores written at once.

## [0.2.0] — 2026-08-09

Milestone M2 — durable streams, the journal half of a yard.

### Added
- Lanes: a stream is one token, a lane is one journal. Ten wire ops
  under §2.8–§2.17 (0x0B–0x14): `STREAM_CREATE`, `STREAM_READY`,
  `STREAM_PUBLISH`, `STREAM_RECEIPT`, `CONSUMER_ATTACH`,
  `CONSUMER_READY`, `STREAM_DELIVER`, `ACK`, `STREAM_DELETE`, and
  `STREAM_GONE`, with lane-ordered, gapless sequences.
- Durable journaling (`internal/server/journal.go`): append-only
  `journal.log` with a 32-byte magic header, `u32 len | body | crc32`
  records, fsync per record before the receipt answers, torn tails
  truncated at boot, and per-consumer state files (`floor` + pending
  set) rewritten on every ack. Missing or torn consumer state means a
  fresh start, never a silent loss.
- Durable consumers: attach reserves a position and delivers
  `CONSUMER_READY` before any replayed byte (ordered on the delivery
  queue, not the control one); redelivery keeps lane order; a dead
  session's consumer resumes with `floor` + pending intact; fresh
  consumers replay the whole lane from seq 1; re-attach with a changed
  filter is refused rather than read as a moving target.
- Sweeper: one goroutine per attached consumer redelivers pending
  entries after `ackWait` (yard default 10s, wired to
  `switchyard -ack-wait`); the sequence is the dedupe key, so
  redelivery is copy-equality, never a different message.
- The reference client library grows the lane set:
  `StreamCreate`/`StreamPublish`(+`StreamPublishReply`)/`StreamDelete`/
  `StreamAttach`/`LaneAck`/`DetachLane` plus `LaneDeliveries()`,
  `StreamNotices()`, and `LaneDropped()`. Synchronous calls take turns
  on one mutex so refusals return as Go errors and receipts pair with
  the publish that owns them.
- `spur stream` CLI: `create`, `delete`, `push` (receipt prints the
  journal position), and `watch` (replay + follow, auto-ack optional,
  `-filter` to narrow). `switchyard` gains `-data-dir` to turn lanes
  on and `-ack-wait` to tune redelivery.
- Lane-ops refusals: eight new named codes 0x0B–0x12 — unknown lane,
  duplicate lane, bad lane name, first-token mismatch, duplicate
  consumer, no such consumer, `STREAM_DISABLED` (no data dir), storage
  fault. All non-fatal: a naming mistake keeps the session.
- Engine test suite: refusal table, gapless seq under 4×25 concurrent
  publishers, ack floor with persisted positions across restart,
  torn-tail recovery (the boot assigns the last intact seq), filter
  narrowness with floor skipping filtered seqs, delete clearing disk,
  and an end-to-end story through the client library.
