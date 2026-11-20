SWITCHYARD-SITE
===============

The showcase website for [switchyard](https://github.com/SukrutN/switchyard) —
a Go message broker you can run from one binary and understand from one file.

This repo speaks in the yard's own voice — the operator's voice. The yard
never lies, so the site can't either: every number on it is one the yardstick
rod printed first, every claim traces to the README or the wire spec.

Stack, chosen honestly:

- **Next.js** (app router, TypeScript) — per the owner's pick.
- Static export → **GitHub Pages** with CI as the gate.
- Hand-rolled CSS on design tokens. No UI kit: the yard's law —
  one reader, one writer, no magic in the middle — is a law about
  websites too.

Flow of the house (same as the yard repo): branch per unit, PR per unit,
true merge commits (never squash), conventional commits, CI gates merges.

The family is growing: unit 04 — `boxcar-engine`, the cartonization
and pack-out solver — lives at `engine/boxcar-engine` with its own
README, fixtures, characterization tests and bench, and its own page
at [`/boxcar`](https://sukrutn.github.io/switchyard-site/boxcar/).
Same law as the rest of the site: every figure the page shows is
printed by the engine, at build, never hand-typed.

License: Apache-2.0, matching the broker.
