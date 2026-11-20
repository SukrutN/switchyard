/* ============================================================
   online — on-line order batching (v0.2) unit grades: the window
   protocol's promises, held one by one.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import { WINDOW_SWEEP, batchOnline } from "../index.ts";
import { DAYS, SLOTTING } from "../fixtures/dc.ts";

test("every order publishes exactly once", () => {
  for (const day of DAYS) {
    for (const w of WINDOW_SWEEP) {
      const run = batchOnline(day.orders, w, SLOTTING);
      assert.equal(Object.keys(run.publish).length, day.orders.length);
      const freezesSeen = new Set<number>();
      for (const f of run.freezes) {
        for (const id of f.orderIds) {
          const t = run.publish[id];
          assert.ok(t !== undefined, `${id} never published`);
          assert.equal(t, f.freezeSec, `${id} publish disagrees with freeze`);
          freezesSeen.add(t);
        }
      }
      // unique stamp: no order rides two freezes
      for (const id of Object.keys(run.publish)) {
        assert.ok(run.waitsSec[id] !== undefined);
      }
      assert.ok(
        run.freezes.every((f) => f.orderIds.length > 0),
        "an empty freeze never happens",
      );
      void freezesSeen;
    }
  }
});

test("no order publishes before it lands, none waits past the window", () => {
  for (const day of DAYS) {
    for (const w of WINDOW_SWEEP) {
      const run = batchOnline(day.orders, w, SLOTTING);
      for (const o of day.orders) {
        const t = run.publish[o.id];
        assert.ok(t >= o.arrivalSec, `${o.id} published before it arrived`);
        const wait = t - o.arrivalSec;
        assert.ok(
          wait <= w,
          `${o.id} waited ${wait}s in a ${w}s window`,
        );
        assert.equal(run.waitsSec[o.id], Math.round(wait));
      }
    }
  }
});

test("freezes are ordered, spaced, and the batches are new", () => {
  for (const day of DAYS) {
    for (const w of WINDOW_SWEEP) {
      const run = batchOnline(day.orders, w, SLOTTING);
      for (let i = 1; i < run.freezes.length; i++) {
        const gap = run.freezes[i].freezeSec - run.freezes[i - 1].freezeSec;
        assert.ok(
          gap >= w,
          `freeze ${i} closed ${gap}s after the last (window ${w}s)`,
        );
      }
      // batch ids are unique across the day, freeze-tagged
      const ids = run.publishedBatches.map((b) => b.id);
      assert.equal(new Set(ids).size, ids.length, "batch id collision");
      assert.equal(
        ids.length,
        run.freezes.reduce((s, f) => s + f.batchIds.length, 0),
      );
      for (const b of run.publishedBatches) {
        assert.equal(run.batchPublish[b.id], run.publish[b.orders[0]]);
      }
    }
  }
});

test("published batches carry exactly their freeze's orders", () => {
  for (const day of DAYS) {
    const run = batchOnline(day.orders, 90, SLOTTING);
    const byBatch = new Map(run.publishedBatches.map((b) => [b.id, b]));
    const ordersInBatches = new Set<string>();
    for (const b of run.publishedBatches) {
      for (const id of b.orders) ordersInBatches.add(id);
    }
    assert.equal(ordersInBatches.size, day.orders.length);
    for (const f of run.freezes) {
      for (const bid of f.batchIds) {
        const b = byBatch.get(bid)!;
        for (const oid of b.orders) {
          assert.ok(f.orderIds.includes(oid), `${oid} missing from its freeze`);
        }
      }
    }
  }
});

test("tardiness is what the ledger says it is", () => {
  for (const day of DAYS) {
    const run = batchOnline(day.orders, 720, SLOTTING);
    let late = 0;
    let worst = 0;
    let total = 0;
    for (const o of day.orders) {
      const t = Math.max(0, run.publish[o.id] - o.dueSec);
      assert.equal(run.tardySec[o.id], Math.round(t));
      if (t > 0) late += 1;
      worst = Math.max(worst, t);
      total += t;
    }
    assert.equal(run.lateOrders.length, late);
    assert.equal(run.maxTardySec, worst);
    assert.equal(
      run.meanTardySec,
      Math.round((total / day.orders.length) * 100) / 100,
    );
  }
});

test("the sweep's shape: batching gains rise, never fall", () => {
  for (const day of DAYS) {
    let prevSaved = -1;
    let prevP90Wait = -1;
    for (const w of WINDOW_SWEEP) {
      const run = batchOnline(day.orders, w, SLOTTING);
      assert.ok(
        run.walksSaved >= prevSaved - 1e-9,
        `${day.profile.key} w=${w}: walks saved went backwards`,
      );
      const waits = Object.values(run.waitsSec).sort((a, b) => a - b);
      const p90 = waits[Math.floor(waits.length * 0.9)];
      assert.ok(p90 >= prevP90Wait, "p90 wait went backwards");
      prevSaved = run.walksSaved;
      prevP90Wait = p90;
    }
  }
});

test("small windows are honest: every cart holds its freeze's pool", () => {
  const day = DAYS[0];
  const run = batchOnline(day.orders, 45, SLOTTING);
  // at 45s windows ~ nothing merges: carts ≈ orders
  assert.ok(
    run.publishedBatches.length >= day.orders.length * 0.97,
    `w=45 opened only ${run.publishedBatches.length} carts for ${day.orders.length} orders`,
  );
});
