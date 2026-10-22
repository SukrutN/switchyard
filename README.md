# SWITCHYARD

A Go message broker you can run from one binary and understand from one
file. Four op families on one wire; a journal receipt behind every
durable claim.

**The yard never lies.** What lands on the wire is exactly what every
subscriber gets — in accepted order, with nothing invented between sender
and receiver. That sentence is a test suite, not a slogan: `internal/server`
enforces it frame by frame.

Status: **v1.0.0** — the yard ships. Protocol v1 is frozen (families
append, numbers never move), the client library and spur speak the
whole surface, and the bench rod prints honest numbers: pub/sub, durable
streams ("lanes"), KV, the Yardmaster lens, token auth with TLS sessions.
See it laid out end to end: https://sukrutn.github.io/switchyard-site/
— one page covering the laws, the numbers, the tour and the quickstart.

## Quickstart

Requires Go 1.25.

```
git clone https://github.com/SukrutN/switchyard
cd switchyard
go run ./cmd/switchyard              # the broker, on 127.0.0.1:4780
```

In another shell, same directory:

```
go run ./cmd/spur ping                          # is the yard alive?
go run ./cmd/spur sub 'orders.*.paid' &         # watch a pattern
go run ./cmd/spur pub 'orders.e9.paid' 'box 42 left the dock'
```

Quote subjects in your shell: `*` and `>` are glob characters to bash and
PowerShell. `spur` speaks the wire protocol through `internal/client` —
the same library the test suite drives, so the CLI exercises exactly the
lanes your products would.

That first yard is in-memory — pure gossip, nothing on disk. Give the
journal a home and the lane verbs light up; restart on the same
`-data-dir` and a durable consumer replays exactly the rows the last
session never acknowledged:

```
go run ./cmd/switchyard -data-dir ./data     # lanes stay off without a home
go run ./cmd/spur stream create orders
go run ./cmd/spur stream push orders orders.9001.paid 'box 42 left the dock'
go run ./cmd/spur kv set orders box-42 'box 42'
go run ./cmd/spur yard                       # the yardmaster's console view
```

A yard can also demand a token before HELLO (`-auth shh`) and wrap every
accepted session in TLS (`-cert cert.pem -key key.pem`); spur follows the
same vocabulary: `-auth`, `-tls`, and `-insecure` for lab certificates.

Or, one command, fully scripted:

```
./scripts/demo.ps1        # PowerShell
```

## What v1.0 has

- **Wire protocol v1, frozen** — 8-byte framed, big-endian, length-
  prefixed frames with named ops and stable error codes. Four families
  were appended onto the pub/sub core (§2.1–§2.7) in numbered order:
  durable streams (§2.8–§2.17), KV (§2.18–§2.23), the console lens
  (§2.24–§2.27), and the auth pair (§2.28–§2.29). Numbers never move, so
  a client written against §2 today keeps working against later yards.
  Spec: [`docs/PROTOCOL.md`](docs/PROTOCOL.md); its only definition
  lives in `internal/wire`.
- **Subject charter** — dot-separated tokens, `*` matches exactly one
  token, `>` trails and captures the rest; wildcards are
  subscription-only. Spec §3; enforcement in `internal/subjects`.
- **The yard** — TCP accept loop, per-session reader/writer pairs,
  bounded delivery queues, gapless per-subscription sequencing,
  heartbeat machinery that closes idle sessions politely and tells you
  exactly why. `internal/server`.
- **Durable streams ("lanes")** — journal-backed topics: a pushed row is
  not acknowledged until its bytes are on disk, consumers remember
  their position by name, and a fresh session gets exactly the rows the
  last one never acknowledged — no invention, no loss. Spec
  §2.8–§2.17; the service in `internal/server`.
- **Key–value state** — the same journal wearing a lookup: set, get,
  delete, keys, every write a receipt, every read from the same on-disk
  story as the lanes. Spec §2.18–§2.23.
- **The Yardmaster lens** — read-only console ops over the wire: the
  yard's version, uptime, and live sessions; a lane's seq, consumers,
  and consumer positions — all read from spur. Spec §2.24–§2.27.
- **The gate and the wrap** — a token demanded before HELLO, TLS
  wrapping every byte of every accepted session, and the rule that a
  password on an unwrapped wire is not an operating mode. Spec
  §2.28–§2.29 and §1.
- **spur** — the reference CLI, the full verb set — ping / pub / sub /
  stream / kv / yard — with one dial vocabulary (`-addr`, `-auth`,
  `-tls`, `-insecure`) on every verb. `cmd/spur`.
- **yardstick** — the measuring rod: ping latencies, sustained fan-out,
  journaled rows and keys, guarded by a counting reader that refuses to
  print dropped work. `cmd/yardstick`.
- **Tests over real TCP fixtures** — per-family wire codec suites in
  `internal/wire`; `internal/server` and `internal/client` suites run
  pub/sub lifecycles, stream create/push/attach/replay/ack, KV round
  trips, console reads, the auth gate, and TLS sessions riding the same
  frames — all against genuine sockets, plus slow-consumer kills, idle
  timeouts, oversized-body skips, duplicate sids, and heartbeat holds.

The protocol rejects nonsense rather than guessing around it: frames that
declare oversized-but-bounded bodies are skipped and answered, not fatal;
frames that break framing end the connection but spell out why. Every
end-of-session reason is logged with the session id, peer name, and
protocol code.

## Layout

```
cmd/switchyard         the broker binary
cmd/spur               the reference client CLI
cmd/yardstick          the bench suite: ping, fan-out, journaled rows/keys
internal/wire          frame codec; the protocol's single source
internal/subjects      the charter + matcher; wall of tests
internal/server        accept loop, hub, sessions
internal/client        reference client library
docs/PROTOCOL.md       the whole wire contract
scripts/demo.ps1       reproducible bring-up
scripts/bench.ps1      reproducible numbers (throwaway yard, full teardown)
```

## Design notes

- **Boring core.** No reflection in codecs. One reader goroutine and one
  writer goroutine per session; the writer is the only thing touching
  the socket for writes, which is what makes per-subscription ordering a
  property of construction rather than of luck.
- **Bounded by default.** 1 MiB frames, 4096-deep delivery queues (the
  burst-dam), 30s+10s heartbeat windows. Configure up; the protocol
  ceiling is 4 MiB.
- **Slow-die bias.** A session that cannot keep up gets one fatal
  `SLOW_CONSUMER` rather than letting the yard grow memory without
  bound. Catch up before you stall again. The queue dam is wide enough
  for honest bursty traffic — when the verdict lands, it means the
  paused *reader*, not arithmetic (the writer batch-drains and ships
  frames coalesced for exactly this reason).

## The yard by the numbers

`yardstick` measures what an operator gets: round-trip probes, fan-out
through the delivery queues, and the journal's per-record fsync story —
a `lane` row or a KV set is not acknowledged until its bytes are on
disk. Fire-and-forget has no backpressure on the wire, so the pubsub
scene publishes in waves the counting reader gates: nothing prints from
dropped work, and the rate is what the yard sustains, not an overflow
dice roll.

One command reproduces the whole table:

```
powershell -File scripts\bench.ps1        # throwaway yard; -Rows 2000 -Payload 128
```

Defaults, throwaway yard on 127.0.0.1, Windows 11, Go 1.25,
Intel(R) Core(TM) i7-8700 CPU @ 3.20 GHz. Three consecutive runs
(2026-10-21); the spread is machine noise, shown so the table cannot lie:

| scenario | gauge                                  | three-run range            |
| -------- | -------------------------------------- | -------------------------- |
| ping     | probes/sec (PONG round trip, p95)      | 14.3–17.4 k/s; p95 ≈ 0.52 ms |
| pubsub   | deliveries/sec (2,000 msgs × 4 sids * 128 B) | 0.42–1.15 M/s        |
| lane     | rows/sec (2,000 rows * 128 B, receipt per row) | 228–273             |
| kv       | keys/sec (2,000 sets * 128 B, receipt per set) | 273–297             |

Read it the yardmaster's way: the top half is the wire's clock (loopback
gossip rates); the bottom half is a lucky disk's clock — per-record
fsync on a system SSD. On slower disks the journal numbers fall with the
hardware, by design: the receipt is a promise, not a hope.

Numbers lie when their conditions are silent: the rod prints its yard
identity, the counting reader refuses runs with dropped deliveries, and
the bench script tears its throwaway yard down before it exits.

## Contributing

PR-based flow, conventional commits, CI (fmt, vet, test -race) gates
every merge — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
