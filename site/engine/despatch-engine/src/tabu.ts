/* ============================================================
   tabu — the improvement pass (v1.1).

   Henn & Wäscher's neighborhoods, plainly:

   · RELOCATE — one order to another cart tour (or, only when that
     strictly helps, to its own new tour);
   · SWAP — two orders trade tours.

   The tabu list (recently moved orders frozen for TABU_TENURE
   iterations) keeps the walk from chasing its tail; an aspiration
   rule lets a frozen move through when it beats the best result
   so far. The walk still takes the best allowed neighbor even
   when it costs a little — that is what makes it tabu search and
   not hill climbing — and the best state ever seen is what gets
   reported. Tours are re-derived from the stop cache after every
   applied move, so no rounding drift can accumulate to fool the
   score.

   The pass is *reported as a delta* against the construction run.
   No promise: construction may already sit at the local floor.
   Deterministic throughout — canonical scan order, no shuffling.
   ============================================================ */

import { CART_LINES, CART_ORDERS, TABU_ITERATIONS, TABU_TENURE } from "./constants.ts";
import { linesOf, stopsOfOrder } from "./batch.ts";
import type { Slotting } from "./batch.ts";
import { mergeStops, tourLedger, tourSecOf, zoneOfAisle } from "./travel.ts";
import type {
  Batch,
  BatchRun,
  DespatchOrder,
  PickStop,
  TabuRun,
} from "./types.ts";

interface WorkBatch {
  readonly key: number; // stable internal handle
  orders: string[];
  lines: number;
  tour: number;
}

const EPS = 1e-9;

function totalOf(state: readonly WorkBatch[]): number {
  return Math.round(state.reduce((s, b) => s + b.tour, 0) * 1000) / 1000;
}

/** the honest Batch objects for whatever the search settled on */
function toBatches(
  state: readonly WorkBatch[],
  orders: readonly DespatchOrder[],
  slotting: Slotting,
): Batch[] {
  const byId = new Map(orders.map((o) => [o.id, o]));
  const live = state
    .filter((b) => b.orders.length > 0)
    .sort(
      (a, b) =>
        firstArrival(a, byId) - firstArrival(b, byId) ||
        cmpStr(a.orders[0], b.orders[0]),
    );
  return live.map((b, i) => {
    const stops = mergeStops(
      b.orders.map((id) => stopsOfOrder(byId.get(id)!, slotting)),
    );
    return {
      id: `TI-${String(i + 1).padStart(3, "0")}`,
      orders: [...b.orders].sort(cmpStr),
      lines: b.orders.reduce((s, id) => s + linesOf(byId.get(id)!), 0),
      stops,
      ledger: tourLedger(stops),
      zone: zoneOfStops(stops),
    };
  });
}

function firstArrival(
  b: WorkBatch,
  byId: Map<string, DespatchOrder>,
): number {
  let min = Infinity;
  for (const id of b.orders) {
    const a = byId.get(id)?.arrivalSec ?? Infinity;
    if (a < min) min = a;
  }
  return min;
}

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

/* ---------- move vocabulary ---------- */

type Move =
  | { readonly kind: "relocate"; oid: string; toKey: number; delta: number }
  | { readonly kind: "swap"; o1: string; o2: string; delta: number };

function isAllowed(
  m: Move,
  curTotal: number,
  bestTotal: number,
  tabu: ReadonlyMap<string, number>,
  iter: number,
): boolean {
  const oids = m.kind === "relocate" ? [m.oid] : [m.o1, m.o2];
  const frozen = oids.some((id) => (tabu.get(id) ?? -1) > iter);
  if (!frozen) return true;
  // aspiration: a frozen move passes if it beats the best so far
  return curTotal + m.delta < bestTotal - EPS;
}

function kindRank(m: Move): number {
  return m.kind === "relocate" ? 0 : 1;
}

function cloneState(state: readonly WorkBatch[]): WorkBatch[] {
  return state.map((b) => ({ ...b, orders: [...b.orders] }));
}

/* ---------- the pass ---------- */

export function tabuImprove(
  run: BatchRun,
  orders: readonly DespatchOrder[],
  slotting: Slotting,
): TabuRun {
  const stopCache = new Map<string, PickStop[]>();
  for (const o of orders) stopCache.set(o.id, stopsOfOrder(o, slotting));
  const linesCache = new Map<string, number>();
  for (const o of orders) linesCache.set(o.id, linesOf(o));

  const state: WorkBatch[] = run.batches.map((b, i) => ({
    key: i,
    orders: [...b.orders],
    lines: b.lines,
    tour: b.ledger.tourSec,
  }));
  let curTotal = totalOf(state);
  let bestTotal = curTotal;
  let bestState = cloneState(state);
  const tabu = new Map<string, number>();
  let applied = 0;

  for (let iter = 0; iter < TABU_ITERATIONS; iter++) {
    // canonical preference: relocate candidates first, then swaps;
    // best delta wins, earlier scan order wins ties.
    const candidates = [
      ...scanRelocate(state, stopCache, linesCache),
      ...scanSwap(state, stopCache, linesCache),
    ].sort((a, b) => a.delta - b.delta || kindRank(a) - kindRank(b));
    const move = candidates.find((m) =>
      isAllowed(m, curTotal, bestTotal, tabu, iter),
    );
    if (!move) break;

    if (move.kind === "relocate") {
      applyRelocate(state, move, linesCache);
      tabu.set(move.oid, iter + TABU_TENURE);
    } else {
      applySwap(state, move);
      tabu.set(move.o1, iter + TABU_TENURE);
      tabu.set(move.o2, iter + TABU_TENURE);
    }
    applied += 1;
    resyncTours(state, stopCache, linesCache);
    curTotal = totalOf(state);
    if (curTotal < bestTotal - EPS) {
      bestTotal = curTotal;
      bestState = cloneState(state);
    }
  }

  const construction = run.totalTourSec;
  return {
    batches: toBatches(bestState, orders, slotting),
    totalTourSec: bestTotal,
    constructionTourSec: construction,
    deltaSec: Math.round((construction - bestTotal) * 100) / 100,
    deltaPct:
      construction > 0
        ? Math.round(((construction - bestTotal) / construction) * 10000) /
          10000
        : 0,
    iterations: TABU_ITERATIONS,
    appliedMoves: applied,
  };
}

/* ---------- neighbor scans ---------- */

function scanRelocate(
  state: readonly WorkBatch[],
  stopCache: Map<string, PickStop[]>,
  linesCache: Map<string, number>,
): Move[] {
  const out: Move[] = [];
  for (let fi = 0; fi < state.length; fi++) {
    const from = state[fi];
    for (const oid of from.orders) {
      const remainingStops = mergeStops(
        from.orders.filter((id) => id !== oid).map((id) => stopCache.get(id)!),
      );
      const tourFrom = tourSecOf(remainingStops);
      const orderStops = stopCache.get(oid)!;
      const l1 = linesCache.get(oid)!;

      for (let ti = -1; ti < state.length; ti++) {
        if (ti === fi) continue;
        if (ti >= 0) {
          const to = state[ti];
          if (to.lines + l1 > CART_LINES) continue;
          if (to.orders.length + 1 > CART_ORDERS) continue;
          const tourTo = tourSecOf(
            mergeStops(
              to.orders.map((id) => stopCache.get(id)!).concat([orderStops]),
            ),
          );
          out.push({
            kind: "relocate",
            oid,
            toKey: to.key,
            delta:
              Math.round((tourTo + tourFrom - (to.tour + from.tour)) * 1000) /
              1000,
          });
        } else {
          // opening a fresh tour is only a candidate when it strictly helps
          const delta =
            Math.round(
              (tourSecOf(orderStops) + tourFrom - from.tour) * 1000,
            ) / 1000;
          if (delta < -EPS) {
            out.push({ kind: "relocate", oid, toKey: -1, delta });
          }
        }
      }
    }
  }
  return out;
}

function scanSwap(
  state: readonly WorkBatch[],
  stopCache: Map<string, PickStop[]>,
  linesCache: Map<string, number>,
): Move[] {
  const out: Move[] = [];
  for (let bi = 0; bi < state.length; bi++) {
    const b1 = state[bi];
    for (let bj = bi + 1; bj < state.length; bj++) {
      const b2 = state[bj];
      for (const o1 of b1.orders) {
        const l1 = linesCache.get(o1)!;
        const s1 = stopCache.get(o1)!;
        for (const o2 of b2.orders) {
          const l2 = linesCache.get(o2)!;
          const s2 = stopCache.get(o2)!;
          // the trade must fit both carts
          if (b1.lines - l1 + l2 > CART_LINES) continue;
          if (b2.lines - l2 + l1 > CART_LINES) continue;
          const tour1After = tourSecOf(
            mergeStops(
              b1.orders
                .filter((id) => id !== o1)
                .map((id) => stopCache.get(id)!)
                .concat([s2]),
            ),
          );
          const tour2After = tourSecOf(
            mergeStops(
              b2.orders
                .filter((id) => id !== o2)
                .map((id) => stopCache.get(id)!)
                .concat([s1]),
            ),
          );
          out.push({
            kind: "swap",
            o1,
            o2,
            delta:
              Math.round((tour1After + tour2After - (b1.tour + b2.tour)) * 1000) /
              1000,
          });
        }
      }
    }
  }
  return out;
}

/* ---------- application ---------- */

/** order lists only — the resync below re-derives tours and lines */
function applyRelocate(
  state: WorkBatch[],
  move: Extract<Move, { kind: "relocate" }>,
  linesCache: Map<string, number>,
): void {
  void linesCache;
  const fromIdx = state.findIndex((b) => b.orders.includes(move.oid));
  if (fromIdx < 0) throw new Error(`tabu: order ${move.oid} went missing`);
  const from = state[fromIdx];
  from.orders = from.orders.filter((id) => id !== move.oid);
  if (from.orders.length === 0) {
    state.splice(fromIdx, 1);
  }
  if (move.toKey >= 0) {
    const to = state.find((b) => b.key === move.toKey);
    if (!to) throw new Error(`tabu: target tour ${move.toKey} went missing`);
    to.orders = [...to.orders, move.oid];
  } else {
    const nextKey = state.reduce((m, b) => Math.max(m, b.key), -1) + 1;
    state.push({ key: nextKey, orders: [move.oid], lines: 0, tour: 0 });
  }
}

function applySwap(
  state: WorkBatch[],
  move: Extract<Move, { kind: "swap" }>,
): void {
  for (const b of state) {
    if (!b.orders.includes(move.o1) && !b.orders.includes(move.o2)) continue;
    b.orders = b.orders.map((id) =>
      id === move.o1 ? move.o2 : id === move.o2 ? move.o1 : id,
    );
  }
}

/** the pass's own honesty check: tours come from the cache, never
    from accumulated deltas */
function resyncTours(
  state: WorkBatch[],
  stopCache: Map<string, PickStop[]>,
  linesCache: Map<string, number>,
): void {
  for (const b of state) {
    b.tour = tourSecOf(mergeStops(b.orders.map((id) => stopCache.get(id)!)));
    b.lines = b.orders.reduce((s, id) => s + linesCache.get(id)!, 0);
  }
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
