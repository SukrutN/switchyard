# foreman-engine

The labor planner of the switchyard family: given a **history file**
and the **standards** from `northspan` (sheet 05), it forecasts the
workload per zone, cases a labor plan by shift/skill band that covers
every forecast hour, and scores the plan against a fixed realization.
A release is a function: `(history + standards) → forecast → plan →
variance` — stateless, pure, deterministic; same bytes in, same plan
out, any machine, at build time or in a test run.

Hand-rolled TypeScript, zero runtime dependencies. Weeks are the axis:
week 1..52 is the ledger year of the fixture DC — **Bramble & Twine**,
Meadowfield, whose five runs ride the Kiln Annex standards (sheet 05) —
and the plan horizon is the spring surge, weeks 53–64.

---

## Quick view

```ts
import { forecast, workload, plan, realizeActuals, variance } from "./index.ts";
import { HISTORY, FORECAST_CONFIG } from "./fixtures/bramble.ts";
import { ZONE_STANDARDS } from "./fixtures/standards.ts";

const fc = forecast(HISTORY, FORECAST_CONFIG);      // weeks 53–64, per zone
const wl = workload(fc, ZONE_STANDARDS);            // hours, via northspan
const pl = plan(wl);                                // the casing
const realization = realizeActuals(fc, { seed: 20261106, amplitude: 0.055 });
const report = variance(realization, 20261106);     // MAPE by zone + waterfalls

// pl.compliance → { covered, floorsRespected, capsRespected, spilled }
```

## Vocabulary

- **Zones** — Bramble & Twine's five runs, keyed by the northspan
  standards' own codes (Cinder `CIN`, Loam `LOA`, Flint `FLI`, Reed
  `REE`, Cobalt `COB`), each with a velocity class (hot / flow / calm)
  and its own stock flavor.
- **Bands** — three speed factors from the standards export: veteran
  `1.0`, day `0.85`, night `0.7`. Covering one standard hour at band
  factor *f* costs `1/f` paid hours; a spill up the strength order is
  honest arithmetic, not a rounding.
- **Weeks** — a weekly axis, nothing day-part. Day/night is a split of
  each zone-week (0.72 / 0.28), not a series.

## The staged method (Labuskes' skeleton, one honest order)

1. **Calendar lift** — the family's own book goes on first: the known
   season (13 four-week blocks, normalized to mean 1, tallest at the
   spring surge) and the known events (the opener tent sale in week 12,
   the Spring trade and Anniversary weeks in the horizon). Smoothing an
   event into its neighbours would let it bleed onto the trend; a tent
   sale is not a trend.
2. **Smoothing** — exponential, α = 0.35, on the plain week's demand.
3. **Trend** — ordinary least squares over the smoothed level. This is
   the only thing fitted; the season shape and the calendar are fixture
   data, not inference.
4. **Calendar re-applied** — the horizon re-dresses each week in its own
   season index and events.
5. **Zone split** — by velocity share (the DC total fans out: CIN .34,
   LOA .17, FLI .18, REE .15, COB .16).

**Workload conversion** is a lookup, which is the whole point of sheet
05: hours = lines × `mplMinutes` (northspan's, verbatim) ⁄ 60 + one fixed
supplement hour per zone-week. The exactness test holds the conversion
to the standards table at 1e-9 — the foreman carries no coefficients of
its own, and the test pins the five MPL values hard-code so an edit of
the fixture (or the upstream export it mirrors) breaks loud.

## The casing

For each week, every zone's hours split into day and night tasks
(biggest zones first, day before night), then the casing fills each
task from the band its velocity runs best at — Cinder from veterans,
the flow runs from the day band, Cobalt from the night desk — spilling
up the strength order only when a pool runs dry. Floors point one way:
a zone's skill floor is the *weakest* band allowed on it.

If a task cannot be covered, the plan refuses (`covered: false`) — it
never quietly under-staffs a forecast. The fixture bench (2 veterans ×
40 h, 3 day-band × 40 h, 2 night × 24 h = 248 paid hours/week) is a
lock: `utilizationPeak 0.7528` in the 2026-11-05 run, compliance all
true, no spill all horizon. The synthetic-bench tests hold the spill
cascade and the refusal to exact arithmetic.

## Characterization (locked 2026-11-05)

| lock | value |
| --- | --- |
| ledger | 52 weeks, spot cells + Σ pinned |
| trend | base 12043.457 lines, +46.9473 lines/wk |
| horizon totals | 12 weeks pinned, peak week 62 (anniversary) at 22837.47 lines |
| workload | 1594.702 standard hours across the horizon, per-week pinned |
| plan | byBand arrays pinned; compliance `{covered, floorsRespected, capsRespected}` all true, no spill |
| anniversary | week 62 cased to 10 rows, hours + headcount pinned |
| realization | seed 20261106, amplitude ±5.5%,MULTIPLIED to line tickets |
| MAPE | CIN 2.91% · LOA 2.08% · FLI 2.61% · REE 2.65% · COB 3.02% |
| waterfall | noise is the only thing between forecast and actual hours; gap +5.058 h |

`fixtures/lock.ts` prints the JSON; the human pastes it into
`fixtures/expected.ts` (pure data, no imports). Run `npm run
lock:foreman` to refresh after a deliberate method change.

## Lineage — sources actually read, honestly credited

- **Labuskes 1998, Cornell** — *Brick Volume Prediction*, the staged
  method this forecaster descends from (history smoothing → trend →
  seasonality → calendar adjustments). Cornell eCommons carries the
  thesis; its stage list is the skeleton, and the one honest
  re-ordering (calendar lift before smoothing) is called out above.
- **Bartholdi & Hackman, *Warehouse & Distribution Science* 0.98.1** —
  free online at <https://www.warehouse-science.com/>. Chapter 30
  ("Labor planning") is where the standards → workload → coverage
  chain in this engine comes from; the book's answer to "how many
  pickers do I need" is exactly the conversion this engine prices.
- **northspan-engine (sheet 05)** — the standards' home. This family
  imports the counter-refill table verbatim
  (`fixtures/standards.ts`); nothing recomputes MPU/MPL. Foreman sheet
  06 exists because the standards exist — pointless without them,
  delightful with them.
- Vendor color on real-world labor-planning systems (Cognitops Takt,
  item.com) informed the vocabulary — pool caps, team floors,
  utilization reporting — but there is no code from them here.
