# SWITCHYARD

A Go message broker you can run from one binary and understand from one
file. Durable streams and storage come after the core stays boring.

**The yard never lies.** What lands on the wire is exactly what every
subscriber gets — in accepted order, with nothing invented between sender
and receiver. That sentence is a test suite, not a slogan: `internal/server`
enforces it frame by frame.

Status: **v0.1.0** — pub/sub core, wire protocol v1, reference CLI,
integration tests. Next: durable streams (M2), built-in web console
"Yardmaster" (M3), auth + TLS + benchmarks (M4).

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

Or, one command, fully scripted:

```
./scripts/demo.ps1        # PowerShell
```

## What v0.1 has

- **Wire protocol v1** — 8-byte framed, big-endian, length-prefixed, with
  named ops and stable error codes. Spec:
  [`docs/PROTOCOL.md`](docs/PROTOCOL.md); its only definition lives in `internal/wire`.
- **Subject charter** — dot-separated tokens, `*` matches exactly one
  token, `>` trails and captures the rest; wildcards are
  subscription-only. Spec §3; enforcement in `internal/subjects`.
- **The yard** — TCP accept loop, per-session reader/writer pairs,
  bounded delivery queues, gapless per-subscription sequencing,
  heartbeat machinery that closes idle sessions politely and tells you
  exactly why. `internal/server`.
- **spur** — `ping` / `pub` / `sub` reference CLI, `cmd/spur`.
- **Tests over a real TCP fixture** — `internal/server/server_test.go`
  and the client package run pub/sub lifecycles, oversized-body skips,
  slow-consumer kills, idle timeouts, duplicate sids, and heartbeat
  holds against genuine sockets.

The protocol rejects nonsense rather than guessing around it: frames that
declare oversized-but-bounded bodies are skipped and answered, not fatal;
frames that break framing end the connection but spell out why. Every
end-of-session reason is logged with the session id, peer name, and
protocol code.

## Layout

```
cmd/switchyard         the broker binary
cmd/spur               the reference client CLI
internal/wire          frame codec; the protocol's single source
internal/subjects      the charter + matcher; wall of tests
internal/server        accept loop, hub, sessions
internal/client        reference client library
docs/PROTOCOL.md       the whole wire contract
scripts/demo.ps1       reproducible bring-up
```

## Design notes

- **Boring core.** No reflection in codecs. One reader goroutine and one
  writer goroutine per session; the writer is the only thing touching
  the socket for writes, which is what makes per-subscription ordering a
  property of construction rather than of luck.
- **Bounded by default.** 1 MiB frames, 512-deep queues, 30s+10s
  heartbeat windows. Configure up; the protocol ceiling is 4 MiB.
- **Slow-die bias.** A session that cannot keep up gets one fatal
  `SLOW_CONSUMER` rather than letting the yard grow memory without
  bound. Catch up before you stall again.

## M2 preview: the yard law continues

Next milestone adds durable streams: a delivered-but-unstored message
does not exist. Ack semantics will land WITH storage, because an ack
before durability would be a claim the disk cannot honor — the same law
from the other side.

## Contributing

PR-based flow, conventional commits, CI (fmt, vet, test -race) gates
every merge — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
