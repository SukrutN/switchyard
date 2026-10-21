# Changelog

All notable changes to switchyard are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [SemVer](https://semver.org/) once we reach 1.0.

## [0.1.0] — 2026-10-21

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

## [0.3.0] — 2026-10-21

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

## [0.2.0] — 2026-10-21

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
