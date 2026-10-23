# SWITCHYARD

A Go message broker you can run from one binary and understand from one
file. Five op families on one wire, with a journal receipt behind every
durable claim.

What you publish is exactly what every subscriber receives, in the
order the broker accepted it. `internal/server` enforces that order
frame by frame.

Status: **v1.0.0**. Protocol v1 is frozen (families append, numbers
never move), the client library and spur speak the whole surface, and
yardstick measures all of it: pub/sub, durable streams ("lanes"), KV,
the Yardmaster lens, token auth with TLS sessions. The showcase site
lays it out end to end, including a live demo of the delivery rules:
https://sukrutn.github.io/switchyard/

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

That first yard is in memory only, with nothing on disk. Give the
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
- **yardstick** — the benchmark suite: ping latencies, sustained fan-out,
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
cmd/yardmaster         the yard's browser console: read-only companion
cmd/yardstick          the bench suite: ping, fan-out, journaled rows/keys
cmd/linehost           hosts a sorting line: lane work -> Modbus block -> verdicts
internal/wire          frame codec; the protocol's single source
internal/subjects      the charter + matcher; wall of tests
internal/server        accept loop, hub, sessions
internal/client        reference client library
internal/lensweb       the console's read-only bridge + embedded pages
internal/linehost      the linehost bridge: minimal Modbus TCP client + talker
docs/PROTOCOL.md       the whole wire contract
scripts/demo.ps1       reproducible bring-up
scripts/bench.ps1      reproducible numbers (throwaway yard, full teardown)
site/                  the showcase site (Next.js; Pages at /switchyard/)
```

## Design notes

- **Boring core.** No reflection in the codecs. One reader goroutine and
  one writer goroutine per session, and the writer is the only
  goroutine that writes to the socket. Per-subscription ordering comes
  from that construction, not from luck.
- **Bounded by default.** Frames carry capacity up to 4 MiB (1 MiB by
  default). Delivery queues sit 4,096 entries deep, and idle sessions
  close on a 30 s window with a 10 s grace. Every bound is a default,
  adjustable to the workload.
- **Slow-die bias.** A session that cannot keep up gets one fatal
  `SLOW_CONSUMER` instead of letting the broker's memory grow without
  bound. The queues absorb bursts; when the kill lands it names the
  reader that stalled, because the writer batch-drains and coalesces
  frames rather than blocking.

## The yard by the numbers

`yardstick` measures what an operator gets: round-trip probes, fan-out
through the delivery queues, and the journal's per-record fsync behavior.
A lane row or a KV set is not acknowledged until its bytes are on disk.
The pubsub scene publishes in waves that a counting reader gates, so a
dropped delivery stops the run instead of inflating the rate.

One command reproduces the whole table:

```
powershell -File scripts\bench.ps1        # throwaway yard; -Rows 2000 -Payload 128
```

Defaults, throwaway yard on 127.0.0.1, Windows 11, Go 1.25,
Intel(R) Core(TM) i7-8700 CPU @ 3.20 GHz, three consecutive runs
(2026-10-21). The spread across runs is machine noise:

| scenario | gauge                                  | three-run range            |
| -------- | -------------------------------------- | -------------------------- |
| ping     | probes/sec (PONG round trip, p95)      | 14.3–17.4 k/s; p95 ≈ 0.52 ms |
| pubsub   | deliveries/sec (2,000 msgs × 4 sids * 128 B) | 0.42–1.15 M/s        |
| lane     | rows/sec (2,000 rows * 128 B, receipt per row) | 228–273             |
| kv       | keys/sec (2,000 sets * 128 B, receipt per set) | 273–297             |

Read the table in two halves: ping and pubsub measure the wire itself
(loopback, no disk in the path); lane and KV measure the journal
(per-record fsync on a system SSD). On slower disks the journal numbers
fall with the hardware, by design: the receipt means the row is on disk.

Two safeguards keep the table honest: the counting reader refuses a run
with dropped deliveries, and the bench script tears its throwaway yard
down before it exits.

## The Yardmaster console

The yard speaks wire, not web pages, but an operator still needs to
see what it is doing. `yardmaster` is the yard's console: a second
binary that dials the running yard as an ordinary client (same gate,
same wrap, same dial vocabulary) and renders the yard's state in pages
that ride inside the binary itself:

```
bin\yardmaster.exe                   console on 127.0.0.1:8060, yard on 127.0.0.1:4780
bin\yardmaster.exe -addr YARD:4780 -tls -auth TOKEN -http OTHER:8060
```

The console owns no levers. Every panel is a read: the yard card
(version, uptime, sessions, quarantine), the lane table (sequence,
journal bytes, key count, consumers with their durable floors), and a
key-value browser that can look but never set. When the yard is
unreachable, the console prints the refusal it got instead of
pretending; quarantine is reported, never cleared. The page polls only
while its tab is visible.

A console is a client too: adding it touched no op, no family, and no
version, and the yardmaster cannot write a single byte to the yard.

## The linehost: hosting a line

A sorting line's supervisor is a switchyard client. `linehost` hosts the
fluxline line (see the [fluxline program](https://github.com/SukrutN/fluxline/tree/main/engine)):
it consumes release work from a durable lane, speaks it to the line's
Modbus TCP register surface (the host command block), and journals every
verdict the floor hands back to the same lane:

```
bin\linehost.exe                    yard 127.0.0.1:4780, line 127.0.0.1:1502
bin\linehost.exe -addr YARD:4780 -line LINE:1502 -lane fluxline -hb 500ms
```

Work items are JSON on the lane's release subject:

```
{"id":"box-42","gate":2,"class":0}    release-override toward gate 2
{"id":"box-43","law":true}            release-per-law, the floor picks
```

Verdicts are receipts on the verdict subject — accepted, vetoed, refused,
expired — carrying the gate the piece actually took and the class the
floor measured:

```
{"id":"box-43","seq":2,"state":"vetoed","gate":3,"class":3,"latency_ms":21430}
```

The rules it lives by: **one release in flight at a time** (the floor
refuses a second command while one is armed, so the rest wait in the
lane); a **heartbeat in every cycle**, carried inside the command frame
itself so an in-flight release never starves the watchdog; verdicts
journal **before** the lane ack, so a crash replays the work instead of
losing the receipt (at-least-once, with sweeper redeliveries recognized,
not re-run); and a command that never gets its receipt is journaled
`expired` once its patience runs out. The host can only request: the
floor has the last word.

`internal/linehost` carries the bridge: a dependency-free Modbus TCP
client (MBAP plus FC03/FC06/FC16 — nothing else the host needs) tested
byte-precise against a scripted slave, and a talker suite that runs
against a real yard.

## Contributing

PR-based flow, conventional commits, CI (fmt, vet, race tests, and
the site's typecheck and build) gates every merge — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
