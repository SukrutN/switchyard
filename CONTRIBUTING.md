# Contributing to switchyard

Short version: branches, conventional commits, CI green, merge commits.
The long version is this file.

## Ground rules

1. **Branches, not direct pushes.** All work lands through a pull request
   against `main`. Branch names follow the work:
   `feat/wire-protocol`, `fix/idle-timer`, `docs/subject-charter`.
2. **One unit of work per PR.** A PR is a milestone slice or a single
   fix — not a whole milestone crammed into one commit (and never a
   whole milestone as one commit).
3. **Conventional commit titles.** `type(scope): summary`.
   Types in use: `feat`, `fix`, `test`, `docs`, `chore`, `refactor`,
   `perf`. Scope is the package: `wire`, `subjects`, `server`, `client`,
   `cli`, `repo`.
4. **Commit when a change is complete.** A commit compiles, vets, and
   passes tests on its own. History should read like documentation.
5. **Merge commits, never squash.** A merged PR shows its commits.
   Branches are deleted after merge.
6. **CI gates every merge.** The pipeline runs gofmt check, go vet, and
   the full test suite with race detection on Linux. A red run blocks.

## Engineering expectations

- The protocol (`docs/PROTOCOL.md`) and the code (`internal/wire`) are
  two views of one contract. A change to one is a change to the other,
  tested both places. Renumbering ops or codes is a new protocol
  version, reviewed explicitly.
- The subject charter's semantics live ONLY in `internal/subjects` and
  its test tables. If a behavior differs between charter, matcher, or
  hub, all three are reviewed together.
- New concurrency must argue about goroutine lifetimes: who closes
  sockets, who wakes whom. The test suite's lifecycle tests exist to
  leak goroutines visibly.
- Boring over clever. If a fix needs several intertwined goroutines and
  an atomic flag, the design probably wants outdoor rethinking, not
  more flags.

## Building and testing

Requires Go 1.25.

```
go build ./...
go vet ./...
gofmt -l .        # expect no output
go test ./...     # or with race: CGO_ENABLED=1 on Linux: go test -race ./...
```

## Reporting bugs

Use the issue template. Reproducible = a script or exact commands, the
flag values, and the lines from the yard's log around the event — every
session close states its reason, so the log is often the whole story.
