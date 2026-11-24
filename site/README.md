SWITCHYARD-SITE
===============

The showcase website for [switchyard](https://github.com/SukrutN/switchyard),
a Go message broker you can run from one binary and understand from one
file.

The site lives at `site/` in the
[switchyard](https://github.com/SukrutN/switchyard) repository. It shows
what the broker does, how to run it, and a demo of its delivery rules;
every figure on the page comes from the repository's own benchmark
tool.

Stack:

- **Next.js** (app router, TypeScript), static export to GitHub Pages,
  with CI as the gate.
- Hand-rolled CSS on design tokens, no UI kit.

The visual system follows the owner's two reference sites: blue ink on
white paper, hairline rules that carry the structure, and a monospace
voice for the operator. Their licensed typefaces (PP Neue Montreal,
GT America Mono, F37) are never downloaded, bundled, or hotlinked;
Inter Tight and JetBrains Mono carry the same roles here as free
substitutes. The palette comes from the same references: white paper,
blue ink, a cobalt signal, and deep navy console bands.

Flow: branch per change, PR per change, true merge commits (never
squash), conventional commits, CI gates merges.

License: Apache-2.0, matching the broker.
