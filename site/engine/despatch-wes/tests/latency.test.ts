/* ============================================================
   latency.test — the sheet's fourth characterization: the order→
   work-item latency on a clean average day, no consumers (so no
   holds — the curve is pure freeze+pace), locked in
   fixtures/expected.ts. The receipt window must be exactly the
   engine's publish second per order (batchOnline's map).
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import { batchOnline } from "../../despatch-engine/index.ts";
import { SLOTTING } from "../../despatch-engine/fixtures/dc.ts";
import { runShift } from "../fixtures/daylane.ts";
import { WES_LOCK } from "../fixtures/expected.ts";

test("latency: the locked release curve of a clean day", async () => {
  const A = await runShift("average-day");
  const arrivals = new Map(A.day.orders.map((o) => [o.id, o.arrivalSec]));
  const lats: number[] = [];
  for (const r of A.stats.receipts) {
    if (r.status !== "released") continue;
    for (const ref of r.orders) {
      const a = arrivals.get(ref);
      assert.ok(a !== undefined, `unknown ref ${ref}`);
      lats.push(r.effectiveSec - a);
    }
  }
  const sorted = [...lats].sort((a, b) => a - b);
  const pick = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const mean = Math.round((sorted.reduce((s, x) => s + x, 0) / sorted.length) * 100) / 100;

  const lock = WES_LOCK.latency;
  assert.equal(sorted.length, lock.orders);
  const checks: readonly [number, number, string][] = [
    [pick(0.5), lock.p50, "p50"],
    [pick(0.9), lock.p90, "p90"],
    [pick(0.99), lock.p99, "p99"],
    [sorted[sorted.length - 1], lock.max, "max"],
    [mean, lock.mean, "mean"],
  ];
  for (const [mine, want, name] of checks) {
    assert.ok(Math.abs(mine - want) <= 0.5, `${name}: ${mine} vs lock ${want}`);
  }
});

test("latency: every receipt window is batchOnline's publish second", async () => {
  const A = await runShift("average-day");
  const engine = batchOnline(A.day.orders, 90, SLOTTING);
  for (const r of A.stats.receipts) {
    if (r.status !== "released") continue;
    for (const ref of r.orders) {
      assert.equal(r.window, engine.publish[ref], ref);
    }
  }
});
