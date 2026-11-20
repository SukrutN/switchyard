/* ============================================================
   batch — off-line batching (v0.1) unit grades.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CART_LINES,
  CART_ORDERS,
  atLeastFree,
  batchFcfs,
  batchOffline,
  mergeStops,
  tourLedger,
  tourSecOf,
} from "../index.ts";
import { mkOrder, resetSeq } from "./helpers.ts";
import { DAYS, SLOTTING } from "../fixtures/dc.ts";
import { SLOTTING_TEST } from "./helpers.ts";

test("savings stay honest: tour(A)+tour(B) ≥ tour(A∪B)", () => {
  resetSeq();
  const slot = SLOTTING_TEST;
  const sets = [
    [
      { sku: "TWN-JUTE", pos: slot.get("TWN-JUTE")!, qty: 2 },
      { sku: "TEA-LEAF", pos: slot.get("TEA-LEAF")!, qty: 1 },
    ],
    [
      { sku: "SOAP-BAR", pos: slot.get("SOAP-BAR")!, qty: 3 },
      { sku: "TEA-LEAF", pos: slot.get("TEA-LEAF")!, qty: 2 },
    ],
    [{ sku: "OAT-ROLO", pos: slot.get("OAT-ROLO")!, qty: 4 }],
  ];
  const tours = sets.map((s) => tourSecOf(s));
  const union = tourSecOf(mergeStops(sets));
  assert.ok(
    atLeastFree(tours, union),
    `union ${union} vs parts ${tours.join(" + ")}`,
  );
  // the shared face merges: tea appears once in the union, qty 3
  const tea = mergeStops(sets).filter((s) => s.sku === "TEA-LEAF");
  assert.equal(tea.length, 1);
  assert.equal(tea[0].qty, 3);
});

test("capacity is law: no batch exceeds cart lines or order count", () => {
  for (const day of DAYS) {
    const run = batchOffline(day.orders, SLOTTING);
    for (const b of run.batches) {
      assert.ok(b.lines <= CART_LINES, `${b.id} lines ${b.lines}`);
      assert.ok(b.orders.length <= CART_ORDERS, `${b.id} orders`);
    }
  }
});

test("every order rides exactly one cart", () => {
  for (const day of DAYS) {
    const run = batchOffline(day.orders, SLOTTING);
    const seen = new Set<string>();
    for (const b of run.batches) {
      for (const id of b.orders) {
        assert.ok(!seen.has(id), `order ${id} double-booked`);
        seen.add(id);
      }
    }
    assert.equal(seen.size, day.orders.length);
  }
});

test("batching beats first-come on every worked day", () => {
  for (const day of DAYS) {
    const run = batchOffline(day.orders, SLOTTING);
    assert.ok(
      run.walksSaved > 0.2,
      `${day.profile.key} saved only ${(run.walksSaved * 100).toFixed(1)}%`,
    );
  }
});

test("an order bigger than any cart is refused, loud", () => {
  resetSeq();
  const monster = mkOrder({
    id: "MONSTER",
    lines: Array.from({ length: 22 }, (_, i) => ({
      sku: ["TWN-JUTE", "TEA-LEAF", "JAM-STRA", "TISS-BOX"][i % 4],
      qty: 3,
    })),
  });
  assert.throws(
    () => batchOffline([monster], SLOTTING_TEST),
    /no cart tour can hold it/,
  );
});

test("the travel proxy's ledger adds up", () => {
  resetSeq();
  const stops = [
    { sku: "TWN-JUTE", pos: { aisle: 3, bay: 5 }, qty: 1 },
    { sku: "BUBL-NOEL", pos: { aisle: 6, bay: 10 }, qty: 1 },
  ];
  const l = tourLedger(stops);
  // horizontal: aisle 6 is farthest → 2 × (6−1) × 4.5 = 45
  assert.equal(l.horizontalSec, 45);
  // vertical: (2×5×1.6) + (2×10×1.6) = 16 + 32 = 48
  assert.equal(l.verticalSec, 48);
  // stops: 2 × 8 = 16
  assert.equal(l.stopsSec, 16);
  assert.equal(l.tourSec, 109);
  assert.equal(l.aislesVisited, 2);
  assert.equal(l.deepestBay, 10);
});

test("the seed rule takes the densest order first", () => {
  resetSeq();
  // far-flung many-line order: tour ~ big, lines low → highest density
  const dense = mkOrder({
    id: "DENSE",
    arrivalSec: 10,
    lines: [
      { sku: "BUBL-NOEL", qty: 2 },
      { sku: "QUILT-PAT", qty: 1 },
    ],
  });
  const easy = mkOrder({
    id: "EASY",
    arrivalSec: 20,
    lines: [{ sku: "TWN-JUTE", qty: 3 }],
  });
  const run = batchOffline([easy, dense], SLOTTING_TEST);
  // the first constructed batch must carry the dense seed
  const firstSeedOrder = run.seeds.length
    ? run.batches.find((b) => b.id === run.seeds[0].batchId)
    : undefined;
  assert.ok(firstSeedOrder, "seed ledger recorded");
  assert.ok(
    firstSeedOrder!.orders.includes("DENSE"),
    "dense far order seeds the first tour",
  );
});

test("fcfs is exactly one cart per order", () => {
  resetSeq();
  const orders = [
    mkOrder({ id: "A", lines: [{ sku: "TWN-JUTE", qty: 1 }] }), // arrives at 90
    mkOrder({ id: "B", arrivalSec: 5, lines: [{ sku: "OAT-ROLO", qty: 1 }] }),
  ];
  const fcfs = batchFcfs(orders, SLOTTING_TEST);
  assert.equal(fcfs.length, 2);
  assert.deepEqual(fcfs.map((b) => b.orders), [["B"], ["A"]]);
});

test("tour ledgers agree with themselves, day after day", () => {
  for (const day of DAYS) {
    const run = batchOffline(day.orders, SLOTTING);
    for (const b of run.batches) {
      const again = tourLedger(b.stops);
      // same stops, re-derived: the ledger must agree with itself
      assert.equal(again.tourSec, b.ledger.tourSec, `${b.id} ledger drift`);
    }
  }
});
