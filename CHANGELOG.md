# Changelog

All notable changes to switchyard are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [SemVer](https://semver.org/) once we reach 1.0.

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
