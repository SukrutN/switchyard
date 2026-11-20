/* ============================================================
   characterization — the locked trio of worked days (see
   fixtures/expected.ts). Locked 2026-10-24 by the engine itself.
   Tolerances: seconds ±0.5, ratios ±0.002, counts exact — float
   noise and cosmetic re-hash swim underneath, but any behavioural
   drift fails loud. The last test holds byte-determinism: two
   full pipeline passes over the same day serialize identically.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import {
  WINDOW_SWEEP,
  batchOffline,
  batchOnline,
  buildJobList,
  releasePlan,
  tabuImprove,
  zoneCaps,
} from "../index.ts";
import { DAYS, dayByKey } from "../fixtures/dc.ts";
import { SLOTTING } from "../fixtures/dc.ts";
import {
  LOCKED_DAYS,
  type LockedDay,
  type LockedRelease,
  type LockedWindow,
} from "../fixtures/expected.ts";

const KEYS = ["average-day", "rush-morning", "seasonal-spike"] as const;
const W_SEC = 90;

function closeSec(got: number, want: number, what: string): void {
  assert.ok(
    Math.abs(got - want) <= 0.5,
    `${what}: got ${got}, locked ${want}`,
  );
}

function closeRatio(got: number, want: number, what: string): void {
  assert.ok(
    Math.abs(got - want) <= 0.002,
    `${what}: got ${got}, locked ${want}`,
  );
}

function lockDay(key: (typeof KEYS)[number]): void {
  const day = dayByKey(key);
  const run = batchOffline(day.orders, SLOTTING);
  const want: LockedDay = LOCKED_DAYS[key].day;

  assert.equal(day.orders.length, want.orders, `${key} order count`);
  assert.equal(
    day.orders.reduce((s, o) => s + o.lines.reduce((t, l) => t + l.qty, 0), 0),
    want.lines,
    `${key} line count`,
  );
  assert.equal(run.batches.length, want.batches, `${key} cart count`);
  closeSec(run.fcfsTourSec, want.fcfsTourSec, `${key} fcfs walks`);
  closeSec(run.totalTourSec, want.totalTourSec, `${key} batched walks`);
  closeRatio(run.walksSaved, want.walksSaved, `${key} walks saved`);
}

function lockWindows(key: (typeof KEYS)[number]): void {
  const day = dayByKey(key);
  for (const w of WINDOW_SWEEP) {
    const want: LockedWindow = LOCKED_DAYS[key].windows[String(w)];
    const run = batchOnline(day.orders, w, SLOTTING);
    assert.equal(
      run.freezes.length,
      want.freezes,
      `${key} w=${w} freeze count`,
    );
    closeRatio(run.walksSaved, want.walksSaved, `${key} w=${w} walks saved`);
    const waits = Object.values(run.waitsSec);
    const meanWait = waits.reduce((s, x) => s + x, 0) / waits.length;
    closeSec(meanWait, want.meanWaitSec, `${key} w=${w} mean wait`);
    assert.equal(
      run.meanTardySec,
      want.meanTardySec,
      `${key} w=${w} mean tardy`,
    );
    assert.equal(
      run.p90TardySec,
      want.p90TardySec,
      `${key} w=${w} p90 tardy`,
    );
    assert.equal(run.lateOrders.length, want.lateOrders, `${key} w=${w} late`);
  }
}

function lockRelease(key: (typeof KEYS)[number]): void {
  const day = dayByKey(key);
  const online = batchOnline(day.orders, W_SEC, SLOTTING);
  const jobs = buildJobList(online.publishedBatches, day.orders, online.batchPublish);
  const caps = zoneCaps(4, day.profile.pickersPerZone);
  const opts = { startSec: 0, horizonSec: day.horizonSec, binSec: 60 };
  const unpaced = releasePlan(jobs, caps, { ...opts, paced: false });
  const paced = releasePlan(jobs, caps, { ...opts, paced: true });
  const want: LockedRelease = LOCKED_DAYS[key].release;

  assert.equal(unpaced.peakQueueCarts, want.peakUnpacedCarts, `${key} unpaced peak`);
  assert.equal(paced.peakQueueCarts, want.peakPacedCarts, `${key} paced peak`);
  assert.equal(
    paced.breaches.length,
    want.breachedPaced,
    `${key} paced breaches`,
  );
  closeSec(paced.lastReleaseSec, want.lastPacedSec, `${key} last release`);
  assert.deepEqual(
    paced.zones.map((z) => z.peakCarts),
    want.zonePeaksPaced,
    `${key} zone peaks`,
  );
}

function lockTabu(key: (typeof KEYS)[number]): void {
  const day = dayByKey(key);
  const run = batchOffline(day.orders, SLOTTING);
  const tabu = tabuImprove(run, day.orders, SLOTTING);
  const want = LOCKED_DAYS[key].day;
  closeSec(tabu.deltaSec, want.tabuDeltaSec, `${key} tabu delta`);
  closeRatio(tabu.deltaPct, want.tabuDeltaPct, `${key} tabu delta pct`);
  assert.equal(tabu.appliedMoves, want.tabuApplied, `${key} applied moves`);
}

test("average-day locks: batching, windows, release, tabu", () => {
  lockDay("average-day");
  lockWindows("average-day");
  lockRelease("average-day");
  lockTabu("average-day");
});

test("rush-morning locks: batching, windows, release, tabu", () => {
  lockDay("rush-morning");
  lockWindows("rush-morning");
  lockRelease("rush-morning");
  lockTabu("rush-morning");
});

test("seasonal-spike locks: batching, windows, release, tabu", () => {
  lockDay("seasonal-spike");
  lockWindows("seasonal-spike");
  lockRelease("seasonal-spike");
  lockTabu("seasonal-spike");
});

test("the whole pipeline is byte-stable across passes", () => {
  for (const key of KEYS) {
    const day = dayByKey(key);
    const once = () => {
      const run = batchOffline(day.orders, SLOTTING);
      const tabu = tabuImprove(run, day.orders, SLOTTING);
      const online = batchOnline(day.orders, W_SEC, SLOTTING);
      const jobs = buildJobList(online.publishedBatches, day.orders, online.batchPublish);
      const caps = zoneCaps(4, day.profile.pickersPerZone);
      const opts = { startSec: 0, horizonSec: day.horizonSec, binSec: 60 };
      return JSON.stringify({
        run: run.batches.map((b) => b.id),
        tours: run.totalTourSec,
        tabu: tabu.batches.map((b) => b.id),
        tabuDelta: tabu.deltaSec,
        freezes: online.freezes.map((f) => f.freezeSec),
        releases: releasePlan(jobs, caps, { ...opts, paced: true }).decisions.map(
          (d) => d.releaseSec,
        ),
      });
    };
    assert.equal(once(), once(), `${key} not byte-stable`);
  }
});

test("the days are the days: seeded generators never drift", () => {
  // DAYS are module-level: a second build of the same key must
  // produce the identical order stream
  for (const key of KEYS) {
    const day = dayByKey(key);
    assert.equal(day, DAYS.find((d) => d.profile.key === key));
    for (const o of day.orders) {
      assert.ok(o.dueSec > o.arrivalSec, `${o.id} due before arrival`);
      assert.ok(
        o.lines.reduce((s, l) => s + l.qty, 0) > 0,
        `${o.id} empty order`,
      );
    }
  }
});
