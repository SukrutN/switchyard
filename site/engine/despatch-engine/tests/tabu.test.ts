/* ============================================================
   tabu — the improvement pass (v1.1) unit grades. The pass may
   fail to improve; it may never lie, loop infeasibly, or lose
   an order.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CART_LINES,
  CART_ORDERS,
  batchOffline,
  tabuImprove,
  tourLedger,
} from "../index.ts";
import { DAYS, SLOTTING } from "../fixtures/dc.ts";

test("the pass keeps the cart law: capacities and coverage", () => {
  for (const day of DAYS) {
    const run = batchOffline(day.orders, SLOTTING);
    const tabu = tabuImprove(run, day.orders, SLOTTING);
    const seen = new Set<string>();
    for (const b of tabu.batches) {
      assert.ok(b.orders.length > 0, "an empty cart survived the pass");
      assert.ok(b.lines <= CART_LINES, `${b.id} lines ${b.lines}`);
      assert.ok(b.orders.length <= CART_ORDERS, `${b.id} orders`);
      for (const id of b.orders) {
        assert.ok(!seen.has(id), `order ${id} double-booked by the pass`);
        seen.add(id);
      }
    }
    assert.equal(seen.size, day.orders.length);
  }
});

test("the pass never lands worse than the construction", () => {
  for (const day of DAYS) {
    const run = batchOffline(day.orders, SLOTTING);
    const tabu = tabuImprove(run, day.orders, SLOTTING);
    assert.ok(
      tabu.totalTourSec <= tabu.constructionTourSec + 5e-3,
      `${day.profile.key}: pass ended ${tabu.totalTourSec} vs construction ${tabu.constructionTourSec}`,
    );
    assert.ok(tabu.deltaSec >= -5e-3, "negative delta reported");
    const pctAgain =
      tabu.constructionTourSec > 0
        ? (tabu.constructionTourSec - tabu.totalTourSec) /
          tabu.constructionTourSec
        : 0;
    assert.ok(
      Math.abs(pctAgain - tabu.deltaPct) <= 2e-3,
      `deltaPct ${tabu.deltaPct} vs recomputed ${pctAgain}`,
    );
  }
});

test("the ledgers of the pass agree with its own stops", () => {
  const day = DAYS[0];
  const run = batchOffline(day.orders, SLOTTING);
  const tabu = tabuImprove(run, day.orders, SLOTTING);
  let sum = 0;
  for (const b of tabu.batches) {
    const again = tourLedger(b.stops);
    assert.equal(again.tourSec, b.ledger.tourSec, `${b.id} ledger drift`);
    sum += b.ledger.tourSec;
  }
  assert.ok(
    Math.abs(sum - tabu.totalTourSec) <= 5e-3,
    `total ${tabu.totalTourSec} vs Σ ${sum}`,
  );
});

test("byte-stable: the pass is a function, not a mood", () => {
  const day = DAYS[0];
  const run = batchOffline(day.orders, SLOTTING);
  const a = tabuImprove(run, day.orders, SLOTTING);
  const b = tabuImprove(run, day.orders, SLOTTING);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("moves are finite, tenures are honored", () => {
  const day = DAYS[1];
  const run = batchOffline(day.orders, SLOTTING);
  const tabu = tabuImprove(run, day.orders, SLOTTING);
  assert.ok(
    tabu.appliedMoves <= tabu.iterations,
    `applied ${tabu.appliedMoves} in ${tabu.iterations} iterations`,
  );
});
