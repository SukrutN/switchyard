/* ============================================================
   orders-scale — the batching engine facing a day of real size,
   not the worked demonstrations.

   Orders are generated deterministically (no RNG: a fixed stride
   pattern over the catalog and the clock), the on-line batching
   runs at the worked freeze window, and every promise the small
   tests lock must hold at size: every order publishes exactly
   once, the freeze sequence is gapless, and the budget is a wall
   against rot, not a tightrope.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import { WINDOW_SWEEP, batchOnline } from "../index.ts";
import { CATALOG, SLOTTING } from "../fixtures/dc.ts";
import type { DespatchOrder, OrderClass } from "../index.ts";

const CLASSES = ["standard", "expedite", "critical"] as const;

/** One big day, deterministic: orders land on a fixed cadence, lines
 *  cycle the catalog, classes rotate, dues follow the class law. */
function bigDay(count: number, spacingSec: number): DespatchOrder[] {
  const orders: DespatchOrder[] = [];
  for (let i = 0; i < count; i++) {
    const cls: OrderClass = CLASSES[i % CLASSES.length === 0 ? (i % 9 === 0 ? 2 : i % 4 === 0 ? 1 : 0) : 0]!;
    const arrivalSec = Math.floor((i * spacingSec) / 10) * 10;
    const lines = [0, 1, 2].map((line) => {
      const entry = CATALOG[(i * 7 + line * 23) % CATALOG.length]!;
      return { sku: entry.sku, qty: 1 + ((i + line) % 3) };
    });
    const due = { standard: 5400, expedite: 1800, critical: 600 }[cls]!;
    orders.push({
      id: `SO-${String(i).padStart(5, "0")}`,
      arrivalSec,
      lines,
      cls,
      dueSec: arrivalSec + due,
    });
  }
  return orders;
}

test("a 2,500-order day batches inside the budget with every order published once", () => {
  const orders = bigDay(2_500, 14); // ~10 hours of stream
  const t0 = performance.now();
  const run = batchOnline(orders, 90, SLOTTING);
  const ms = performance.now() - t0;
  console.log(`scale: 2,500 orders on-lined in ${Math.round(ms)} ms, `
    + `${run.publishedBatches.length} batches, ${(run.walksSaved * 100).toFixed(1)}% walks saved`);

  assert.ok(ms < 30_000, `2,500 orders took ${Math.round(ms)} ms; the budget is 30,000 ms`);

  // every order publishes exactly once, at a freeze second it really froze
  assert.equal(Object.keys(run.publish).length, orders.length);
  const frozenAt = new Set<string>();
  for (const freeze of run.freezes) {
    for (const id of freeze.orderIds) {
      const t = run.publish[id];
      assert.ok(t !== undefined, `${id} never published`);
      assert.equal(t, freeze.freezeSec, `${id} publish disagrees with its freeze`);
      assert.ok(!frozenAt.has(id), `${id} rides two freezes`);
      frozenAt.add(id);
    }
  }

  // the freeze sequence is gapless: no order sits outside a freeze
  const frozenOrders = run.freezes.reduce((sum, freeze) => sum + freeze.orderIds.length, 0);
  assert.equal(frozenOrders, orders.length);
});

test("the whole window sweep holds at day size", () => {
  const orders = bigDay(1_200, 14);
  const t0 = performance.now();
  for (const w of WINDOW_SWEEP) {
    const run = batchOnline(orders, w, SLOTTING);
    assert.equal(Object.keys(run.publish).length, orders.length,
      `window ${w}s lost orders at size`);
  }
  const ms = performance.now() - t0;
  console.log(`scale: the six-window sweep over 1,200 orders took ${Math.round(ms)} ms`);
  assert.ok(ms < 60_000, `the sweep took ${Math.round(ms)} ms; the budget is 60,000 ms`);
});
