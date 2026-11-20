# despatch-wes

The WES half of the switchyard family — sheet 02's orchestrator,
riding the lanes the way a spur client does. Sheet 01's
`despatch-engine` batches and paces in memory; this module is the
**cooperant**: an order lane in, per-zone work lanes out, a release
journal, a quarantine DLQ with reason codes, and a KV "pace" lane
whose board is the crash envelope. The engine's freeze law runs
here *streaming* — the window ladder driven by journaled arrivals
instead of a day array — and every effect it commits is journaled
bytes first.

Hand-rolled TypeScript, zero runtime dependencies. Two yards ride
one seam: `modelyard.ts` (MemoryYard — in-process, deterministic,
no broker) for tests and the bench, and `liveyard.ts` (LiveYard —
a real spur session) for the Go yard in `integration/run.ts`.

---

## Quick view

```ts
import { DespatchWes } from "./src/wes.ts";
import { MemoryYard } from "./src/modelyard.ts";   // or LiveYard over a spur session
import { SLOTTING, dayByKey } from "../../despatch-engine/fixtures/dc.ts";

const day = dayByKey("average-day");
const yard = new MemoryYard();
const wes = new DespatchWes(yard, SLOTTING, {
  windowSec: 90, zoneCount: 4,
  pickersPerZone: day.profile.pickersPerZone,
  horizonSec: day.horizonSec,
});
await wes.boot();                        // lanes, board, sku map, holds, consumers
// ... the order lane fills (`orders.<ref>.paid` rows) ...
const stats = await wes.finalize();      // steps, drains, resolves holds
```

The orchestrator is a consumer, not a callee: it attaches to
`orders` (filter `orders.>`), reacts to deliveries, and publishes
its effects onto other lanes. Same orders in, same journals out —
byte for byte, across runs, across crashes.

## The lanes

| lane | kind | the traffic |
| --- | --- | --- |
| `orders` | stream in | one canonical order row per order, subject `orders.<ref>.paid`, the WES acks by watermark |
| `work-z1..z4` | stream out | one work row per batch on its zone's lane, subject `work-z{n}.batch.<id>` |
| `despatch-release` | journal out | the receipt ledger: one row per batch (`held` first if it holds, `released` when it leaves) |
| `despatch-quarantine` | DLQ out | one row per refusal with a reason code; a `resolved` row pairs it |
| `despatch-control` | stream in | the operator: reassign rows (face + bay + the full order) |
| `despatch-pace` | KV | the board, the operator's sku map, hold manifests, quarantine markers — all journaled rows of their own kind |

## The freeze law, streaming

The engine's on-line law, driven by lane deliveries instead of a
day array: the window re-arms as the previous freeze closes, a
freeze batches everything already *landed* (a dry window re-arms
from the next arrival, without consuming a freeze number), and the
current freeze is `/W{n}`-tagged exactly as `batchOnline` tags it.
The characterization suite holds the parity field by field —
freeze seconds, batch ids, order rosters, line counts — against
`batchOnline` on all three worked days, and every order's receipt
`window` equals the engine's `publish` map entry.

Batching and release ride the engine's import: `batchOffline` per
freeze, EDD-pacing with the honesty pass, incremental. The crew's
`given` ledger accrues across freezes *and across crashes* — the
board carries it.

## The hold law

A zone crew that stops acking saturates its lane. When the lane's
delivered-unacked depth outruns `pendingCap`, the batch **holds**:
a `held` receipt (effectiveSec 0) journals the parking, the work
content waits in the pace lane's KV, and nothing is dropped. Each
pass releases at most the cap's worth (a released row parks
pending until the crew acks it), so recovery is a walk — ack,
probe, again — until the manifest is complete. Held-then-released
batches publish the curve stretched, never compressed:
`effectiveSec ≥ releaseSec` on every released row.

## The quarantine law

A poisoned order (an unmapped SKU, or a cart that cannot fit one
tour — `over 20 units` refuses with `OVERSIZED`, sku `""`) never
reaches a work lane. It journals an `open` DLQ row with the
offending sku, parks a durable marker `q.<ref>.<reason>` in the
pace lane's KV, and its ack lands with the window's freeze — the
bad row can neither stall nor block a healthy lane.

The operator's reassign arrives on the control lane: the mapping
fix lands as KV (`sku-map`, face **and** bay — a resumed
orchestrator's chapter two), a `resolved` row pairs the `open`
one, and the order re-pools once — from the parked entry when one
exists (its ack keeps the seq), from the row's content when it is
long acked (seq 0, no orders-lane ack). A reassign for a healthy
order fixes the mapping and invents no fiction; a reassigned cart
must still pass the poison test.

## The resume law

Boot is chaptered recovery from journaled bytes: the board
(watermark, freeze numbering, the crew's `given`, the armed
window), the operator's sku map, the hold manifests, then the
consumers — re-attaching a durable consumer whose session died IS
the resume path (§2.12: the yard replays from the persisted
floor). Three crashes are locked by tests:

- **clean** — abandon mid-day with an undrained inbox: the resumed
  session replays and journals lanes byte-identical to a single
  pass;
- **dirty** — die between the work-row publications and the board
  commit: the same batch ids re-land from the resumed run (twice on
  the wire, once in effect — the dup rows carry the same tag and
  byte content), and the board, floors and freeze tags converge to
  the single-pass ledger;
- **held** — a run that parked holds boots its hold ledger from KV
  and releases with the identical work content, tombstones last.

## The wire

`src/wire.ts` mirrors `switchyard/docs/PROTOCOL.md` byte for byte:
the §1 frame header, every §2 op body, the §3 subject charter, the
§6 error table, the §7 skip rule. Every `encode*X` helper returns a
BODY; the socket edge assembles the header (`encodeFrame`) — spur's
`rpcRound` passes op and body separately. The golden tests lock the
hex against hand-derived tables, not against the module. `spur.ts`
is the client half: one session, RPC round-trips, deliveries on
 durable-lane consumers, keepalive probes mirrored from the Go
client.

## The worked days

The same trio `despatch-engine` works — Bramble & Twine's average
day, rush morning, seasonal spike — staged onto the orders lane and
run through the WES. `fixtures/expected.ts` locks the
characterization values, printed by the lock sheet
(`npm run lock:wes`, locked 2026-10-25). A sample:

| day | orders | freezes | batches | work z1/z2/z3/z4 | released through |
| --- | --- | --- | --- | --- | --- |
| average-day | 204 | 172 | 180 | 49 / 49 / 51 / 31 | 204 |
| rush-morning | 268 | 160 | 169 | 53 / 42 / 46 / 28 | 268 |
| seasonal-spike | 426 | 200 | 246 | 93 / 61 / 45 / 47 | 426 |

A clean day quarantines nothing (the empty-lane digest is the FNV
offset `cbf29ce484222325`) and holds nothing. The order→work-item
latency on the average day (no consumers ⇒ no holds — pure freeze
plus pace): p50 1149 s, p90 4530 s, p99 5250 s, max 5361 s, mean
1722.43 s.

The bench writes `bench/results.json` (2026-10-25): the lane mode
over the MemoryYard runs at 184 µs/order at 100 orders to
1.93 ms/order at 1600 on the same synthetic days the engine's bench
shapes (`npm run bench:wes`). The engine's bare loop stays two
orders of magnitude faster — journaling every freeze, acking every
row and binding the board is the price, and this artifact records
it rather than promising anything.

## Running it

```sh
npm run lock:wes         # the lock sheet: the numbers above, live
npm run bench:wes        # lane-mode cost vs order count → bench/results.json
npm run run:wes          # the Go yard bring-up (needs the sibling switchyard repo)
npm test                 # every engine's characterization suite
```

Characterization locks: seconds ±0.5, counts exact, digests
byte-exact (fnv1a64 over consumers-visible lane bytes). `modelyard`
is fsync-free but order-faithful — the write order is the
contract.

## What it is not

Fences, deliberately:

- **No broker in here.** The WES is a client over lanes; the yard
  is switchyard's job. MemoryYard is the tabletop, not the product.
- **No driver and no screen.** The board is journal bytes; the
  console is the Go yard's.
- **No transport plan.** The release ends at the cart on the zone
  lane; loading and ferrying are sheets further out.
- **No slotting opinions.** The catalog is the slotter's word; the
  orchestrator only overlays the operator's reassigns.

## Lineage

- Henn, S. (2012). *Algorithms for on-line order batching in an
  order picking warehouse.* Computers & Operations Research
  39(11), 2549–2563 — the window-frozen protocol, in its streaming
  form here.
- de Koster, R., Le-Duc, T., Roodbergen, K.J. (2007). *Design and
  control of warehouse order picking: A literature review.*
  European Journal of Operational Research 182(2), 481–501 — the
  batching families the engine's law cites, the WES drives them.
- Helland, P. (1991). *What about the database? / at-least-once is
  a protocol property; idempotence is yours.* The quarantine and
  duplicate law in prose: the wire promises redelivery, the
  cooperant promises the ledger pushes back.
- `switchyard/docs/PROTOCOL.md` — the yard's own law: the frame
  layouts, the charter, the error table, the skip rule; this
  module mirrors it byte for byte.
- Bartholdi, J.J., Hackman, S.T. *Warehouse & Distribution
  Science* (free textbook, warehouse-science.com) — release to
  labor; a WES is the floor's queueing rules wearing a jacket.
