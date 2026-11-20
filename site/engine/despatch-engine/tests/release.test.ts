/* ============================================================
   release — waveless release pacing (v0.3) unit grades.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import {
  batchOnline,
  buildJobList,
  releasePlan,
  zoneCaps,
} from "../index.ts";
import type { ReleaseDecision } from "../index.ts";
import { DAYS, SLOTTING } from "../fixtures/dc.ts";

const BIN = 60;

function plansFor(dayIx: number) {
  const day = DAYS[dayIx];
  const online = batchOnline(day.orders, 90, SLOTTING);
  const jobs = buildJobList(online.publishedBatches, day.orders, online.batchPublish);
  const caps = zoneCaps(4, day.profile.pickersPerZone);
  const opts = { startSec: 0, horizonSec: day.horizonSec, binSec: BIN };
  return {
    day,
    jobs,
    caps,
    unpaced: releasePlan(jobs, caps, { ...opts, paced: false }),
    paced: releasePlan(jobs, caps, { ...opts, paced: true }),
  };
}

test("unpaced is the counterfactual: release at publish, exactly", () => {
  for (let i = 0; i < DAYS.length; i++) {
    const { jobs, unpaced } = plansFor(i);
    assert.equal(unpaced.decisions.length, jobs.length);
    const byId = new Map(jobs.map((j) => [j.batch.id, j]));
    for (const d of unpaced.decisions) {
      assert.equal(d.releaseSec, byId.get(d.batchId)!.publishSec);
    }
  }
});

test("paced never releases before publish, and honors the minute grid", () => {
  for (let i = 0; i < DAYS.length; i++) {
    const { jobs, paced } = plansFor(i);
    const byId = new Map(jobs.map((j) => [j.batch.id, j]));
    for (const d of paced.decisions) {
      const j = byId.get(d.batchId)!;
      assert.ok(d.releaseSec >= j.publishSec, `${d.batchId} left early`);
      // waiting happens in whole bin steps on top of publish
      const waited = d.releaseSec - Math.ceil(j.publishSec);
      assert.equal(waited % BIN, 0, `${d.batchId} off-grid by ${waited % BIN}s`);
    }
  }
});

test("the cap is law: no zone is promised craft it cannot afford", () => {
  for (let i = 0; i < DAYS.length; i++) {
    const { day, paced } = plansFor(i);
    const pickers = day.profile.pickersPerZone;
    // cumulative craft-seconds promised to a zone, point by point
    for (let z = 0; z < 4; z++) {
      const events = paced.decisions
        .filter((d) => d.zone === z)
        .sort((a, b) => a.releaseSec - b.releaseSec);
      let cum = 0;
      for (const d of events) {
        cum += d.craftSec;
        const affordable = pickers * (d.releaseSec - 0);
        assert.ok(
          cum <= affordable + 1e-6,
          `zone ${z} over-promised by ${cum - affordable}s at t=${d.releaseSec}`,
        );
      }
    }
  }
});

test("the queue series is the honest FIFO count, recomputed", () => {
  for (let i = 0; i < DAYS.length; i++) {
    const { paced } = plansFor(i);
    for (const z of paced.zones) {
      const mine = paced.decisions
      .filter((d) => d.zone === z.zone)
      .sort(
        (a, b) => a.releaseSec - b.releaseSec || cmpStr(a.batchId, b.batchId),
      );
      let finish = 0;
      const served: { rel: number; fin: number }[] = [];
      for (const d of mine) {
        const start = Math.max(d.releaseSec, finish);
        finish = start + d.craftSec;
        served.push({ rel: d.releaseSec, fin: finish });
      }
      let peak = 0;
      for (const r of z.readings) {
        const q = served.filter((c) => c.rel <= r.t && c.fin > r.t).length;
        assert.equal(r.carts, q, `zone ${z.zone} bin t=${r.t}`);
        peak = Math.max(peak, q);
      }
      assert.equal(z.peakCarts, peak);
    }
  }
});

test("breaches are counted, not hidden", () => {
  for (let i = 0; i < DAYS.length; i++) {
    const { paced, unpaced } = plansFor(i);
    const count = (plan: { decisions: readonly ReleaseDecision[] }) =>
      plan.decisions.filter((d) => d.releaseSec > d.dueSec + 1e-9).length;
    assert.equal(paced.breaches.length, count(paced));
    assert.equal(unpaced.breaches.length, count(unpaced));
    // pacing is a trade: it may delay, it never releases earlier than must
    assert.ok(
      paced.lastReleaseSec >= unpaced.lastReleaseSec - 1e-9,
      "pacing cannot finish before the unhindered plan",
    );
  }
});

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

test("zone-series bins start at zero and never dip negative", () => {
  for (let i = 0; i < DAYS.length; i++) {
    const { paced, unpaced } = plansFor(i);
    for (const plan of [paced, unpaced]) {
      for (const z of plan.zones) {
        for (const r of z.readings) {
          assert.ok(r.carts >= 0, `negative queue at t=${r.t}`);
          assert.ok(Number.isInteger(r.carts));
        }
      }
    }
  }
});

test("caps read the labor context: pickers × the engineered rate", () => {
  const caps = zoneCaps(4, 2);
  assert.deepEqual(
    caps.map((c) => c.linesPerHour),
    [84, 84, 84, 84],
  );
  const spans = caps.map((c) => c.aisles[1] - c.aisles[0] + 1);
  assert.deepEqual(spans, [3, 3, 3, 3]);
});
