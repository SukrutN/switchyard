/* ============================================================
   batch — off-line order batching (v0.1).

   The construction the sheet prescribes:

   · seed: the unbatched order with the highest travel density —
     proxy tour seconds per pick line ("distance / capacity");
   · grow: add the order with the best result-density — savings
     (tour(now) + tour(candidate) − tour(union)) per candidate
     line — while the cart admits it;
   · never over: CART_LINES and CART_ORDERS are hard caps.

   Co-picking is free (the union shares aisles and faces), so
   every merge is scored honestly against the same proxy the
   baseline is scored with. Deterministic throughout: ties fall
   to arrival, then to order id.
   ============================================================ */

import { CART_LINES, CART_ORDERS } from "./constants.ts";
import {
  mergeStops,
  tourLedger,
  tourSecOf,
  zoneOfAisle,
} from "./travel.ts";
import type {
  Batch,
  BatchRun,
  DespatchOrder,
  PickPos,
  PickStop,
} from "./types.ts";

/** slotting: sku → its pick face. The catalog's promise to the engine. */
export type Slotting = Map<string, PickPos>;

export function buildSlotting(
  catalog: readonly { sku: string; aisle: number; bay: number }[],
): Slotting {
  const m = new Map<string, PickPos>();
  for (const c of catalog) m.set(c.sku, { aisle: c.aisle, bay: c.bay });
  return m;
}

/** expand one order's lines to its pick stops (qty per line, one
    stop per line entry — an order with 3× the same sku still
    scans three cartons... no: one face stop, qty 3. The picker
    lifts once. Merge at the source. */
export function stopsOfOrder(
  order: DespatchOrder,
  slotting: Slotting,
): PickStop[] {
  const bySku = new Map<string, PickStop>();
  for (const line of order.lines) {
    const pos = slotting.get(line.sku);
    if (!pos) throw new Error(`unknown sku in order slotting: ${line.sku}`);
    const prev = bySku.get(line.sku);
    if (prev) {
      bySku.set(line.sku, { ...prev, qty: prev.qty + line.qty });
    } else {
      bySku.set(line.sku, { sku: line.sku, pos, qty: line.qty });
    }
  }
  return [...bySku.values()].sort(
    (a, b) => a.pos.aisle - b.pos.aisle || a.pos.bay - b.pos.bay,
  );
}

const linesOf = (o: DespatchOrder): number =>
  o.lines.reduce((s, l) => s + l.qty, 0);

/** the plurality zone of a batch: pick faces decide, ties west. */
function zoneOfStops(stops: readonly PickStop[]): number {
  const count = new Map<number, number>();
  let best = 0;
  let bestN = -1;
  for (const s of stops) {
    const z = zoneOfAisle(s.pos.aisle);
    const n = (count.get(z) ?? 0) + s.qty;
    count.set(z, n);
    if (n > bestN) {
      bestN = n;
      best = z;
    }
  }
  return best;
}

function makeBatch(
  id: string,
  orders: readonly DespatchOrder[],
  slotting: Slotting,
): Batch {
  const stops = mergeStops(orders.map((o) => stopsOfOrder(o, slotting)));
  return {
    id,
    orders: orders.map((o) => o.id),
    lines: orders.reduce((s, o) => s + linesOf(o), 0),
    stops,
    ledger: tourLedger(stops),
    zone: zoneOfStops(stops),
  };
}

/** the naive release: one order, one cart, out as it lands. */
export function batchFcfs(
  orders: readonly DespatchOrder[],
  slotting: Slotting,
): Batch[] {
  const sorted = [...orders].sort(
    (a, b) => a.arrivalSec - b.arrivalSec || idCmp(a.id, b.id),
  );
  return sorted.map((o, i) =>
    makeBatch(`FC-${pad(i + 1)}`, [o], slotting),
  );
}

export function batchRunOf(
  batches: readonly Batch[],
  fcfs: readonly Batch[],
  seeds: readonly { batchId: string; orderId: string }[],
): BatchRun {
  const total = sumTour(batches);
  const fcfsTotal = sumTour(fcfs);
  return {
    batches,
    totalTourSec: total,
    fcfsTourSec: fcfsTotal,
    walksSaved: fcfsTotal > 0 ? (fcfsTotal - total) / fcfsTotal : 0,
    seeds,
  };
}

export function sumTour(batches: readonly Batch[]): number {
  return Math.round(
    batches.reduce((s, b) => s + b.ledger.tourSec, 0) * 1000,
  ) / 1000;
}

/**
 * Off-line batching. The whole visible day is treated as one
 * planning problem — the baseline v0.2 relaxes: batches form
 * inside freeze windows while orders still stream in.
 */
export function batchOffline(
  orders: readonly DespatchOrder[],
  slotting: Slotting,
): BatchRun {
  const fcfs = batchFcfs(orders, slotting);
  const pool = [...orders].sort(
    (a, b) => a.arrivalSec - b.arrivalSec || idCmp(a.id, b.id),
  );
  const unbatched = new Set(pool.map((o) => o.id));
  const byId = new Map(pool.map((o) => [o.id, o]));
  const batchTour = new Map<string, number>();
  for (const o of pool) {
    batchTour.set(o.id, tourSecOf(stopsOfOrder(o, slotting)));
  }

  const batches: Batch[] = [];
  const seeds: { batchId: string; orderId: string }[] = [];
  let seq = 0;

  while (unbatched.size > 0) {
    // ---- the seed: highest travel density (tour seconds per line)
    let seedId = "";
    let seedDensity = -1;
    for (const id of unbatched) {
      const o = byId.get(id)!;
      if (linesOf(o) > CART_LINES) {
        throw new Error(
          `order ${id} carries ${linesOf(o)} units; no cart tour can hold it`,
        );
      }
      const d = batchTour.get(id)! / Math.max(1, linesOf(o));
      if (d > seedDensity) {
        seedDensity = d;
        seedId = id;
      }
    }

    // ---- grow: best savings-per-line while the cart admits
    const members: DespatchOrder[] = [byId.get(seedId)!];
    let memberStops = stopsOfOrder(members[0], slotting);
    let memberLines = linesOf(members[0]);
    unbatched.delete(seedId);

    for (;;) {
      let bestId = "";
      let bestDensity = 0;
      let bestStops: PickStop[] | null = null;
      for (const id of [...unbatched].sort(idCmp)) {
        const c = byId.get(id)!;
        const cLines = linesOf(c);
        if (memberLines + cLines > CART_LINES) continue;
        if (members.length + 1 > CART_ORDERS) break; // sorted id order; no candidate helps
        const cStops = stopsOfOrder(c, slotting);
        const union = mergeStops([memberStops, cStops]);
        const savings =
          tourSecOf(memberStops) + tourSecOf(cStops) - tourSecOf(union);
        const density = savings / Math.max(1, cLines);
        if (density > bestDensity + 1e-9) {
          bestDensity = density;
          bestId = id;
          bestStops = union;
        }
      }
      if (!bestId || bestDensity <= 0) break;
      members.push(byId.get(bestId)!);
      memberStops = bestStops!;
      memberLines += linesOf(byId.get(bestId)!);
      unbatched.delete(bestId);
    }

    seq += 1;
    const id = `B-${pad(seq)}`;
    batches.push(makeBatch(id, members, slotting));
    seeds.push({ batchId: id, orderId: seedId });
  }

  // batch ids follow seed arrival: the board's own day order
  batches.sort(
    (a, b) => arrivalOf(a, byId) - arrivalOf(b, byId) || idCmp(a.id, b.id),
  );
  return batchRunOf(batches, fcfs, seeds);
}

function arrivalOf(
  b: Batch,
  byId: Map<string, DespatchOrder>,
): number {
  let min = Infinity;
  for (const id of b.orders) {
    const a = byId.get(id)?.arrivalSec ?? Infinity;
    if (a < min) min = a;
  }
  return min;
}

function idCmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function pad(n: number): string {
  return String(n).padStart(3, "0");
}

export { makeBatch, linesOf };
