# despatch-engine

The despatch half of the switchyard family: given an **order
stream** (arrivals, pick lines, due dates), it batches orders onto
cart tours inside freeze windows, paces the batch release against
zone labor, and improves the batching with a tabu pass. Output:
cart tours with merged pick stops and honest travel ledgers, an
on-line publication schedule with the tardiness its windows buy,
a release plan per zone — and the deltas, never promises.

Hand-rolled TypeScript, zero runtime dependencies, one travel
proxy everywhere. Runs in Node, at build time in Next.js, and in
the browser — stateless: same orders in, same batches out.

---

## Quick view

```ts
import {
  batchOffline,      // off-line batching (v0.1)
  batchOnline,       // window-frozen on-line batching (v0.2)
  releasePlan, buildJobList, zoneCaps,  // waveless release (v0.3)
  tabuImprove,       // the improvement pass (v1.1)
} from "./index.ts";
import { DAYS, SLOTTING } from "./fixtures/dc.ts";

const day = DAYS[0];                                  // Bramble & Twine, average day
const run = batchOffline(day.orders, SLOTTING);       // BatchRun — carts, tours, saved %
const online = batchOnline(day.orders, 90, SLOTTING); // OnlineRun — freezes, waits, tardiness
const jobs = buildJobList(online.publishedBatches, day.orders, online.batchPublish);
const caps = zoneCaps(4, day.profile.pickersPerZone);  // the labor context
const paced = releasePlan(jobs, caps, { paced: true, startSec: 0, horizonSec: 18000, binSec: 60 });
const tabu = tabuImprove(run, day.orders, SLOTTING);  // delta, never promised
```

Everything is plain serializable data: `Batch`, `OnlineRun`,
`ReleasePlan`, `TabuRun` — the site renders them directly.

---

## The travel proxy

No TSP and no routing engine lives here — batching decides
**before** routes are planned (that's `northspan`'s job, a walk
time by walk time). The proxy is the classic traversal model,
already in seconds:

| constant | value | meaning |
| --- | --- | --- |
| `SEC_PER_AISLE` | 4.5 s | the front cross-aisle sweep, one aisle pitch |
| `SEC_PER_BAY` | 1.6 s | in-and-out per bay of an aisle's depth |
| `SEC_PER_STOP` | 8 s | scan + lift at a pick face |

A tour is the sweep out to the farthest visited aisle and back,
every visited aisle walked to its deepest pick and back out, and
one stop per pick face. Co-picking is *free* by construction:
the union shares aisles (deepest wins) and merges stop faces
(one face, one stop, qty added) — so `tour(A) + tour(B) ≥
tour(A∪B)` always, and the batching's savings are exactly what
the proxy says they are. The engine asserts this property
(`atLeastFree`) and the tests hold it.

Carts: `CART_LINES = 20` units a tour may carry, `CART_ORDERS = 6`
orders a tour may serve. Both are hard caps everywhere —
construction, windows, and the tabu pass.

## The batching law

**Off-line (v0.1).** Seed each batch with the unbatched order of
highest travel density (`tour seconds per unit`), then grow it:
add the order with the best savings-per-unit —
`savings = tour(batch) + tour(candidate) − tour(union)` — while
the cart admits. Deterministic throughout: ties fall to
arrival, then to order id. The baseline it must beat is FCFS:
one order, one cart, out as it lands.

**On-line (v0.2, the real project).** The interval protocol:
the window `w` re-arms whenever the previous freeze closes; at a
freeze, everything already *landed* is batched off-line and
published; anything landing inside a window waits for the next
one. One parameter — and the sweep over it is the family's
signature figure: walks saved climbs with `w`, fresh lateness
creeps in at the tail. The demand's dues are the promise:
`SLA_BY_CLASS = { critical: 600, expedite: 1800, standard: 5400 }`
seconds after arrival.

## The release law

**Waveless pacing (v0.3).** After the window publishes a batch,
the floor must absorb it. The release key is due-date slack —
the tightest order due rides first (EDD, ties by batch id). A
zone may give away exactly the picker-seconds its crew affords:
`pickersPerZone × elapsed`, accrued from shift start. A cart
costs its zone one craft: the tour seconds **plus**
`CRAFT_OVERHEAD_SEC = 240` of marshal, stage, and hand-off —
counted the moment the cart is released, never released before
it was published, and never released against a zone already
spent. An honesty pass re-reads every zone's ledger in *release*
order (EDD's gate counts in processing order; the floor feels in
release order) and pushes any collision a minute forward.

The unpaced plan is the counterfactual — everything leaves at
its publication instant — read by the *same* FIFO one-craft
service sim, so the queue curves compare fairly. The trade is
reported, not hidden: pacing's peak cuts, and the batches it
made late breach their due and say so.

## The improvement law

**Tabu (v1.1).** Henn & Wäscher's neighborhoods, plainly:
`RELOCATE` one order to another cart tour (its own new tour only
when that strictly helps) and `SWAP` two orders between tours.
Recently moved orders sit frozen for `TABU_TENURE = 6`
iterations; an aspiration rule lets a frozen move through when
it beats the best so far. The walk still takes the best allowed
neighbor even when it costs a little — that is tabu search, not
hill climbing — and the best state ever seen is what gets
reported. Tours are re-derived from the stop cache after every
applied move: no rounding drift can accumulate to fool the
score. The pass is **reported as a delta** against the
construction run — construction may already sit at the local
floor, and the engine says so when it is.

---

## The worked days

`fixtures/dc.ts` invents **Bramble & Twine**, a dry-goods brand
at a fictional Meadowfield DC: twelve single-deep aisles, depot
at the west end of the front cross-aisle, 24 slotting-mapped
SKUs from `TWN-JUTE` (aisle 1, bay 2) to `WREATH-IVY` (aisle 12,
bay 20). Slotting put the fast movers low and shallow, the
seasonal tail deep — exactly the geometry the travel proxy pays
in.

| day | stream | labor |
| --- | --- | --- |
| average-day | 40 orders/hr × 5 h, routine dues | 1 picker/zone |
| rush-morning | 68 orders/hr × 4 h, tighter dues | 1 picker/zone |
| seasonal-spike | 84 orders/hr × 5 h, bigger baskets | 2 pickers/zone |

Orders are generated deterministically from a seed (mulberry32):
the same seed is the same day, byte for byte, on the site, in
the tests, and in the bench. No scraping, no "real" brand — that
is the house rule.

`fixtures/expected.ts` locks the characterization values, printed
by the engine they describe (locked 2026-10-24). A sample of the
trio, batched off-line vs first-come-one-cart:

| day | orders | lines | carts | fcfs walks | batched walks | saved | tabu |
| --- | --- | --- | --- | --- | --- | --- | --- |
| average-day | 204 | 1477 | 83 | 33,385 s | 17,283 s | 48.2% | −854.8 s |
| rush-morning | 268 | 1008 | 60 | 31,191 s | 10,349 s | 66.8% | −953.2 s |
| seasonal-spike | 426 | 2992 | 165 | 69,144 s | 33,712 s | 51.2% | −1037.4 s |

At `w = 90 s` the windows make the despatch board: 172 freezes
on the average day, 4.8% more walking saved on top of nothing
held back — and at `w = 720 s` the release board pays its first
tardiness (2 late orders, 22 s max, on the same day). The
release ledger on the average day: 14 carts of unpaced peak
queue, 8 paced — 17 batches released late, on the record.

---

## Running it

```sh
npm run lock:despatch    # the lock sheet: the numbers above, live
npm run bench:despatch   # runtime vs order count → bench/results.json
npm test                 # every engine's characterization suite
```

Characterization locks: seconds ±0.5, ratios ±0.002, counts and
ledgers exact; the pipeline is byte-stable across passes. The
README and the site quote the same fixtures/expected.ts the
tests hold — no number here is transcribed by hand.

## What it is not

Fences, deliberately:

- **No robot windows.** AMR/AGV gating is hearthline's sheet 08;
  this engine's release gate is labor, not robots.
- **No putaway or replenishment.** Quay owns the inbound half;
  the catalog's slotting is treated as the slotter's word.
- **No PLC divert logic.** Conveyor control is sheet 09; the
  release plan ends at the cart, not the divert.
- **No lane transport.** Truck loading/ferrying is sheet 02;
  due dates are the only thing from the outbound side.

## Lineage

The engine is small and hand-rolled, but it is not ignorant.
The law it runs is the literature's, cited:

- Ratliff, H.D., Rosenthal, A.S. (1983). *Order-picking in a
  rectangular warehouse: a solvable case of the traveling
  salesman problem.* Operations Research 31(3), 507–521.
  doi:10.1287/opre.31.3.507 — the solvable case the travel
  proxy respects.
- Gademann, N., van de Velde, S. (2005). *Order batching to
  minimize total travel time in a parallel-aisle warehouse.*
  IIE Transactions 37(1), 63–75 — batching is NP-hard; the
  savings-based construction is the standing heuristic family.
- de Koster, R., Le-Duc, T., Roodbergen, K.J. (2007). *Design
  and control of warehouse order picking: A literature review.*
  European Journal of Operational Research 182(2), 481–501 —
  the traversal proxy, the batching rule families, the review.
- Henn, S. (2012). *Algorithms for on-line order batching in an
  order picking warehouse.* Computers & Operations Research
  39(11), 2549–2563. doi:10.1016/j.cor.2011.12.019 — the
  window-frozen on-line protocol v0.2 implements.
- Henn, S., Wäscher, G. (2012). *Tabu search heuristics for the
  order batching problem in manual order picking systems.*
  Production Planning & Control 23(2–3) — the RELOCATE/SWAP
  neighborhoods, the tabu tenure, and the aspiration rule.
- Henn, S., Koch, K., Wäscher, G. (2012). *Order batching in
  order picking warehouses: a survey of solution approaches.*
  In: Warehousing in the Global Supply Chain, Springer — the
  map of what else exists.
- Bartholdi, J.J., Hackman, S.T. *Warehouse & Distribution
  Science* (free textbook, warehouse-science.com) — batch to
  savings, release to labor; a warehouse is a queueing system
  wearing a nice hat.
