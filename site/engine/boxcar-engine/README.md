# boxcar-engine

The pack-out solver of the switchyard family: given an **order**
(item dims, weights, quantities, fragility) and a **carton library**,
it chooses cartons per shipment and packs 3D placements inside them.
Output: carton composition, placement coordinates, cube utilization,
weight margin — and a validation report where the *no-floating* check
is a test, not a feature.

Hand-rolled TypeScript, zero runtime dependencies, fixed-point
arithmetic (0.01 cm ticks, integer grams). Runs in Node, at build
time in Next.js, and in the browser — stateless: same order bytes
in, same solution bytes out.

---

## Quick view

```ts
import { pack, validateSolution } from "./index.ts";
import { PROFILES } from "./fixtures/orders.ts";
import { CARTON_LIBRARY } from "./fixtures/cartons.ts";

const sol = pack(PROFILES[0].order, CARTON_LIBRARY);   // ShipSolution
const report = validateSolution(sol);                  // 7 report lines
// sol.cartons[0].boxes[0] → { pos: {x,y,z}, dims, supports, unit }
```

Coordinate system: ticks (`0.01 cm`), origin at the carton's inner
corner, `z` up. `supports` names what a box's bottom actually touches
(floor or specific boxes with their contact share) — the carried-weight
ledger is exact because shares renormalize to `1`.

## The algorithm (practical skeleton)

1. **Sequence** — order lines expand to units, sorted bigger-first
   (volume, then weight, then line order). Deterministic, no shuffle.
2. **Placement engine** — free-space *anchor point* list (starts at the
   floor corner, grows three new anchors per placement). For each unit:
   candidate points sorted `(z, x, y)`, orientations ordered
   flatten-first, and the first admission that passes
   **bounds → gravity → collision → stability → load**
   wins. Nothing else gets five checks this cheap.
3. **Carton selection** — every library template (sorted by inner
   volume) gets a *saturated run* (repeat passes in canonical order
   until nothing converts). Runs are scored
   `util + 0.3 × weightMargin − 0.12`, and — the fix the naive version
   lacks — a run that **orphans** a unit no template could ever carry
   loses to any run that completes the order. Open the best; recurse
   on what's left.
4. **Merge rules** — fragility families (`standard` / `fragile` /
   `hazard`) co-pack only when both rows of the compat table agree.
   Hazard rides alone; the table is the one truth the packer, the
   merge gate, and the report all read.
5. **Validation report** — BOUNDS / OVERLAP / FLOATING / LOAD /
   WEIGHT / STABILITY / MERGE (+ UNFILLED when a line honestly cannot
   ship). Every failure names its reason. An unplaceable SKU is
   *reported*, never faked into a carton.

### The fixes that matter (why the naive versions fail)

- **Gravity / floating** — placements drop to the top of the support
  stack actually beneath them before admission. The base py3dbp
  results can contain boxes floating in mid-air; none of this
  engine's solutions can, and the FLOATING report line proves it per box.
- **Load-bearing** — weight flows down the support chain by contact
  share; a unit may never carry more than its rated load. The rated
  exceedance case splits to an extra carton instead of violating.
- **Stability** — a placement needs a minimum real contact ratio
  (0.55 of its own footprint, `STABILITY_RATIO` in `src/constants.ts`)
  or it is refused. A lid off the edge of a ridge is refused.

## The characterization trio (locked 2026-10-24)

| profile | cartons | templates | cube util. | worst weight margin |
| --- | --- | --- | --- | --- |
| featherweight outlet restock | 2 | MD-4025, LG-5035 | **76.1%** | 81% |
| pantry dense-cubes run | 5 | SC-3020 ×3, MX-2015 ×2 | **80.5%** | 15% |
| mixed awkward wave | 2 | LG-5035, MD-4025 | **55.3%** | 81% |

`fixtures/expected.ts` pins these; `tests/characterization.test.ts`
holds them to ±0.006. Mixed-awkward deliberately includes fragile
bottles, upright rods (rotate "no"), soft pillows, and one hazard
aerosol — the aerosol insists on its own carton, and the packer pays
the 5.6% utility honestly rather than bending the merge rule.

## Bench (node, median of 3, in-process)

| lines | cartons | pack ms | validate ms |
| --- | --- | --- | --- |
| 5 | 1 | 0.66 | 0.06 |
| 10 | 2 | 1.13 | 0.08 |
| 20 | 4 | 3.44 | 0.08 |
| 40 | 5 | 6.05 | 0.14 |
| 80 | 10 | 20.35 | 0.27 |
| 160 | 13 | 66.85 | 0.54 |

≈0.42 ms/line at 160 lines, linear-to-quadratic growth, and every row
re-checks byte-level determinism. Artifact: `bench/results.json`
(committed; the site reads it). Harness: `npm run bench`.

## Lineage — sources actually read, honestly credited

- **enzoruiz/3dbinpacking** (`py3dbp`, MIT) — <https://github.com/enzoruiz/3dbinpacking>
  The reference implementation this generator's API shape nods to. It
  ships the base thesis PDF (*erick_dube_507-034.pdf*) inside; read it
  for the anchor-point loop this engine descends from. Its plain
  results include floating-in-air placements — the bug class this
  family was built to eliminate. MIT applies to that lineage.
- **jerry800416/3D-bin-packing** (MIT) — <https://github.com/jerry800416/3D-bin-packing>
  The improved fork the three fixes directly descend from: `fix_point`
  gravity re-settlement, `loadbear`, `check_stable` +
  `support_surface_ratio`. Its `example0/1/5.py` are the test cases
  our fixtures re-stage: with/without fix point, cylinder+cube mixes,
  stability thresholds.
- **skjolber/3d-bin-container-packing** (Apache-2.0) — <http://skjolber.github.io/3d-bin-container-packing/>
  The serious-engineering reference: LAFF variant, brute force, JMH
  benches, result boxes carrying **validation reasons**, and a
  visualizer. The report-with-reasons culture of this repo's
  validation bench is that behaviour contract, retold in TypeScript.
- **Wadaboa/3d-bpp** — <https://github.com/Wadaboa/3d-bpp>
  A compact academic artifact (UNIBO class project) showing heuristic
  vs. math-programming formulations side by side. Background reading,
  not a dependency.
- **Martello, Pisinger, Vigo (2000), *The three-dimensional bin
  packing problem*, Operations Research 48(2)** — the exact algorithm
  lineage a serious heuristic nods to. Cited for the "why not
  optimum?" question; the benchmark suite (OR-Library bin-packing,
  BS/PORT instances) is where a future exact-grade evaluation
  belongs.
- **Google OR-Tools** — <https://developers.google.com/optimization>
  The step-up path: the exact frontier (CP-SAT / MIP) lives there,
  not here. When the business needs a provable optimum on hard
  instances, port the fixture model to OR-Tools and keep the
  validation report as the judge.

## Scope fences (per the family sheet)

- **No label printing** — `waybill` carries label payloads; boxcar's
  decision travels to it via the ship solution JSON.
- **No rate shopping / carriers.**
- **Heuristic only** — no exact MIP here; see the OR-Tools pointer
  above for where the exact frontier works.

## Running the suite

```bash
npm test        # 36 tests, node --test, TS run directly (no build step)
npm run lock    # prints the characterization lock sheet
npm run bench   # re-writes bench/results.json
```

Node ≥ 22.18 (type stripping) or ≥ 23. No dependencies at runtime;
TypeScript is the only devDependency the engine costs.

## Fixtures

- `fixtures/cartons.ts` — one library, five sizes, 2dp cm/kg:
  MX-2015 mailer 20×15×10 · 4 kg, SC-3020 30×20×15 · 8 kg,
  MD-4025 40×25×25 · 15 kg, LG-5035 50×35×30 · 25 kg,
  XL-6050 60×50×40 · 30 kg (all inner dims; payload excludes tare).
- `fixtures/orders.ts` — three profiles: featherweight, dense-cubes,
  mixed-awkward (fragility classes included deliberately).
- `fixtures/expected.ts` — the locked utilization/margin figures.

Dims stay in original units, decimals fixed at 2, and convert to
integer ticks exactly once at the edge (`toTick`), which is why
floats never drift inside the solver.
