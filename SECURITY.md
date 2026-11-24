# Security notes — switchyard

What the broker and its console enforce, what they deliberately do not
carry, and how to place them. Read alongside the charter sections cited in
the README (§1 for TLS, §2.28 for the token gate).

## What this is

A durable message broker speaking its own wire protocol over TCP, a read-only
yardmaster console that dials it as an ordinary client, and a metrics port
beside the yard. It carries whatever an operator publishes — in the worked
examples, fictional order streams. The threat model is a lab network or a
closed plant segment.

## What is enforced

- **A shared-token gate on the wire** (`-auth`). A client that does not
  `AUTHENTICATE` with the token before `HELLO` is refused. The gate is the
  first thing the yard checks; nothing downstream answers an unauthenticated
  session.
- **Optional TLS** (`-cert` + `-key`). One half of a keypair is refused at
  boot rather than silently downgrading; wrapped sessions carry the same
  frames and the same disciplines.
- **Frame caps and liveness.** A 1 MiB body ceiling (configurable), idle
  heartbeats with a grace window, and a slow-consumer kill so a stuck peer
  cannot wedge the yard.
- **The console owns no levers.** The yardmaster dials as a client through
  the same gate, renders only what the console family answers, and escapes
  every string it draws — a hostile lane name cannot inject markup into the
  page. Its HTTP side binds loopback by default.
- **The metrics port carries its own optional bearer** (`-metrics-auth`).
  Unauthenticated scrapes are refused; bind the port to where the scraper
  lives.
- **Refusal by name.** The wire refuses unknown fields and bad subjects by
  name, and quarantine is reported, not cleared, from the console.

## What is deliberately not provided

- **No per-client identity.** One shared token for every client and the
  console alike; the yard cannot tell two publishers apart.
- **No payload confidentiality.** Off the TLS option, frames cross the wire
  as written. Journals persist whatever was published, unencrypted, in the
  data directory — protect the directory, not just the socket.
- **No management API.** Lanes are created and deleted over the wire by
  whoever holds the token; there is no admin plane with its own policy.
- **No rate limiting on the socket.** The wire's own caps (body size,
  heartbeats, slow consumers) are the protections; an abusive authenticated
  publisher is an operational problem, not one this broker can name.

## Deployment guidance

Run the yard inside the network segment that owns its publishers. If it must
cross segments: turn on TLS, set the auth token, and treat the data
directory as sensitive at rest. The metrics port stays on the loopback of
the scraper unless `-metrics-auth` is set. The Docker image and
`compose.yaml` wire the same knobs.

## Reporting

Open an issue in this repository. This is a portfolio project; these
notes describe what is enforced, not a certification.
