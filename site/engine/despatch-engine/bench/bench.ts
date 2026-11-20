/* ============================================================
   bench — despatch runtime vs order count.

   Sizes are synthetic days assembled from the trio's own
   orders (cycled, re-stamped, arrivals stretched) so the curve
   is honest about the input the family actually batches.
   Fixed-point work everywhere; floats only as wall clock.
   Determinism is re-checked per row: two full passes of the
   same day must serialize byte-identically.

   The tabu pass runs only on day-sized and ≤400-order inputs —
   its scan is quadratic in tours by design; beyond that the
   honest report is "—", not a fudged number.

   Run: npm run bench:despatch — writes bench/results.json,
   which the site reads as a static artifact. No timestamps in
   the data, only the lock date.
   ============================================================ */

import {
  batchOffline,
  batchOnline,
  buildJobList,
  releasePlan,
  SLA_BY_CLASS,
  tabuImprove,
  zoneCaps,
} from "../index.ts";
import type { DespatchOrder } from "../index.ts";
import { DAYS, SLOTTING, dayByKey } from "../fixtures/dc.ts";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TABU_UP_TO = 400;

/* ---------- synthetic days assembled from the trio's orders ---------- */

function syntheticDay(n: number): DespatchOrder[] {
  const base = DAYS[0].orders;
  const horizon = dayByKey("average-day").horizonSec;
  const out: DespatchOrder[] = [];
  for (let i = 0; i < n; i++) {
    const o = base[i % base.length];
    const wave = Math.floor(i / base.length);
    const arrival = o.arrivalSec + wave * horizon;
    out.push({
      id: `SY-${String(i + 1).padStart(4, "0")}`,
      arrivalSec: arrival,
      lines: o.lines,
      cls: o.cls,
      dueSec: arrival + SLA_BY_CLASS[o.cls],
    });
  }
  return out;
}

/* ---------- the timed functions ---------- */

function passes(orders: readonly DespatchOrder[], horizonSec: number) {
  const t0 = performance.now();
  const run = batchOffline(orders, SLOTTING);
  const t1 = performance.now();
  const online = batchOnline(orders, 90, SLOTTING);
  const t2 = performance.now();
  const jobs = buildJobList(online.publishedBatches, orders, online.batchPublish);
  const caps = zoneCaps(4, dayByKey("average-day").profile.pickersPerZone);
  const paced = releasePlan(jobs, caps, {
    startSec: 0,
    horizonSec,
    binSec: 60,
    paced: true,
  });
  const t3 = performance.now();
  return { run, online, paced, batchMs: t1 - t0, onlineMs: t2 - t1, releaseMs: t3 - t2 };
}

function stableOf(passesResult: {
  run: ReturnType<typeof batchOffline>;
  online: ReturnType<typeof batchOnline>;
  paced: ReturnType<typeof releasePlan>;
}): string {
  return JSON.stringify({
    ids: passesResult.run.batches.map((b) => b.id),
    tours: passesResult.run.totalTourSec,
    freezes: passesResult.online.freezes.map((f) => f.freezeSec),
    pub: passesResult.online.publishedBatches.map((b) => b.id),
    rel: passesResult.paced.decisions.map((d) => d.releaseSec),
  });
}

/*
 * table of the numbers the release ledger's own honesty needs:
 * nothing here is a promise about wall time — the artifact
 * records what this build cost, and the site quotes it as such.
 */
function median3(fn: () => number): number {
  const xs: number[] = [];
  fn(); // warm-up, untimed
  for (let i = 0; i < 3; i++) xs.push(fn());
  xs.sort((a, b) => a - b);
  return Math.round(xs[1] * 100) / 100;
}

const SIZES = [100, 200, 400, 800, 1600];
const rows: unknown[] = [];

for (const n of SIZES) {
  const orders = syntheticDay(n);
  const horizon = dayByKey("average-day").horizonSec;

  const batch = median3(() => {
    const t = performance.now();
    batchOffline(orders, SLOTTING);
    return performance.now() - t;
  });
  const online = median3(() => {
    const t = performance.now();
    batchOnline(orders, 90, SLOTTING);
    return performance.now() - t;
  });
  const release = median3(() => {
    const t = performance.now();
    const online = batchOnline(orders, 90, SLOTTING);
    const jobs = buildJobList(online.publishedBatches, orders, online.batchPublish);
    const caps = zoneCaps(4, dayByKey("average-day").profile.pickersPerZone);
    releasePlan(jobs, caps, { startSec: 0, horizonSec: horizon, binSec: 60, paced: true });
    return performance.now() - t;
  });

  const reference = passes(orders, horizon);
  const stable = stableOf(reference) === stableOf(passes(orders, horizon));

  let tabuMs: number | null = null;
  let tabuDelta = null as number | null;
  if (n <= TABU_UP_TO) {
    tabuMs = median3(() => {
      const t = performance.now();
      tabuImprove(reference.run, orders, SLOTTING);
      return performance.now() - t;
    });
    const tabu = tabuImprove(reference.run, orders, SLOTTING);
    tabuDelta = tabu.deltaSec;
  }

  rows.push({
    orders: n,
    lines: orders.reduce((s, o) => s + o.lines.reduce((t, l) => t + l.qty, 0), 0),
    carts: reference.run.batches.length,
    batchMs: Math.round(batch * 100) / 100,
    onlineMs: Math.round(online * 100) / 100,
    releaseMs: Math.round(release * 100) / 100,
    tabuMs,
    tabuDeltaSec: tabuDelta,
    deterministic: stable,
  });
}

/* ---------- the three worked days, timed once for the record ---------- */

const dayRows: unknown[] = [];
for (const d of DAYS) {
  const t0 = performance.now();
  const run = batchOffline(d.orders, SLOTTING);
  const t1 = performance.now();
  const tabu = tabuImprove(run, d.orders, SLOTTING);
  const t2 = performance.now();
  const online = batchOnline(d.orders, 90, SLOTTING);
  const t3 = performance.now();
  const jobs = buildJobList(online.publishedBatches, d.orders, online.batchPublish);
  const caps = zoneCaps(4, d.profile.pickersPerZone);
  releasePlan(jobs, caps, {
    startSec: 0,
    horizonSec: d.horizonSec,
    binSec: 60,
    paced: true,
  });
  const t4 = performance.now();
  dayRows.push({
    key: d.profile.key,
    orders: d.orders.length,
    lines: d.orders.reduce((s, o) => s + o.lines.reduce((t, l) => t + l.qty, 0), 0),
    carts: run.batches.length,
    batchMs: Math.round((t1 - t0) * 100) / 100,
    tabuMs: Math.round((t2 - t1) * 100) / 100,
    onlineMs: Math.round((t3 - t2) * 100) / 100,
    releaseMs: Math.round((t4 - t3) * 100) / 100,
    walksSaved: Math.round(run.walksSaved * 10000) / 10000,
  });
}

const artifact = {
  generated: "2026-10-24",
  note: "median of 3 after one warm-up; deterministic re-check per row; tabu only on day and ≤400-order inputs",
  dayRows,
  runs: rows,
};

const outPath = join(HERE, "results.json");
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

// the honest print: results.json's summary, for the terminal
for (const r of artifact.runs as Record<string, unknown>[]) {
  console.log(
    `${String(r.orders).padStart(5)} orders → carts ${String(r.carts).padStart(4)}, batch ${String(r.batchMs).padStart(8)}ms, online ${String(r.onlineMs).padStart(8)}ms, release ${String(r.releaseMs).padStart(7)}ms, tabu ${r.tabuMs === null ? "—" : `${r.tabuMs}ms`}, stable ${r.deterministic ? "✓" : "✗"}`,
  );
}
console.log(`written: ${outPath}`);
