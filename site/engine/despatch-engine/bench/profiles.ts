/* ============================================================
   profiles — one summarizer for the three worked days.

   Tests lock against it, the site's server components call the
   same helpers at build time, and running it with node prints
   the lock sheet for the site's figures.
   ============================================================ */

import {
  WINDOW_SWEEP,
  ZONE_GROUP,
  batchOffline,
  batchOnline,
  buildJobList,
  releasePlan,
  tabuImprove,
  zoneCaps,
} from "../index.ts";
import type {
  BatchRun,
  OnlineRun,
  ReleasePlan,
  TabuRun,
} from "../index.ts";
import { BRAMBLE_MAP, DAY_PROFILES, type DayPlan, dayByKey } from "../fixtures/dc.ts";
import { SLOTTING } from "../fixtures/dc.ts";

export interface DaySummary {
  readonly key: string;
  readonly orders: number;
  readonly lines: number;
  readonly batches: number;
  readonly fcfsTourSec: number;
  readonly totalTourSec: number;
  readonly walksSaved: number;
  readonly tabuDeltaSec: number;
  readonly tabuDeltaPct: number;
  readonly tabuApplied: number;
  readonly run: BatchRun;
  readonly tabu: TabuRun;
}

export function summarizeDay(day: DayPlan): DaySummary {
  const run = batchOffline(day.orders, SLOTTING);
  const tabu = tabuImprove(run, day.orders, SLOTTING);
  const lines = day.orders.reduce(
    (s, o) => s + o.lines.reduce((t, l) => t + l.qty, 0),
    0,
  );
  return {
    key: day.profile.key,
    orders: day.orders.length,
    lines,
    batches: run.batches.length,
    fcfsTourSec: run.fcfsTourSec,
    totalTourSec: run.totalTourSec,
    walksSaved: run.walksSaved,
    tabuDeltaSec: tabu.deltaSec,
    tabuDeltaPct: tabu.deltaPct,
    tabuApplied: tabu.appliedMoves,
    run,
    tabu,
  };
}

export interface WindowSummary {
  readonly windowSec: number;
  readonly freezes: number;
  readonly batchCount: number;
  readonly totalTourSec: number;
  readonly walksSaved: number;
  readonly meanWaitSec: number;
  readonly p90WaitSec: number;
  readonly meanTardySec: number;
  readonly p90TardySec: number;
  readonly maxTardySec: number;
  readonly lateOrders: number;
  readonly run: OnlineRun;
}

/** the one-parameter sweep: walks saved climbs, the window's price shows */
export function onlineSweep(day: DayPlan): WindowSummary[] {
  return WINDOW_SWEEP.map((w) => {
    const run = batchOnline(day.orders, w, SLOTTING);
    const waits = Object.values(run.waitsSec).sort((a, b) => a - b);
    return {
      windowSec: w,
      freezes: run.freezes.length,
      batchCount: run.freezes.reduce((s, f) => s + f.batchIds.length, 0),
      totalTourSec: run.totalTourSec,
      walksSaved: run.walksSaved,
      meanWaitSec:
        Math.round(
          (waits.reduce((s, x) => s + x, 0) / Math.max(1, waits.length)) * 10,
        ) / 10,
      p90WaitSec: waits[Math.floor(waits.length * 0.9)] ?? 0,
      meanTardySec: run.meanTardySec,
      p90TardySec: run.p90TardySec,
      maxTardySec: run.maxTardySec,
      lateOrders: run.lateOrders.length,
      run,
    };
  });
}

export interface Histogram {
  readonly bucket: string; // "0" | "1" | … overdue seconds, log-ish steps
  readonly count: number;
}

/** the tardiness distribution for one day at one window: buckets
    in seconds, only the last bucket open-ended */
export function tardyHistogram(run: OnlineRun): Histogram[] {
  const t = Object.values(run.tardySec);
  const buckets = [30, 60, 120, 300, 600, 1200, Infinity];
  const hist = buckets.map((b, i) => {
    const lo = i === 0 ? 1 : buckets[i - 1] + 1; // >0 begins at 1
    const hi = b;
    const count = t.filter((x) => x >= lo && x !== 0 && x <= (hi === Infinity ? Infinity : hi)).length;
    return { bucket: b === Infinity ? "1200+" : `${b}`, count };
  });
  return hist;
}

export interface ReleaseSummary {
  readonly unpaced: ReleasePlan;
  readonly paced: ReleasePlan;
  readonly peakUnpacedCarts: number;
  readonly peakPacedCarts: number;
  readonly avgUnpacedCarts: number;
  readonly avgPacedCarts: number;
  readonly lastUnpacedSec: number;
  readonly lastPacedSec: number;
  readonly breachedUnpaced: number;
  readonly breachedPaced: number;
  readonly zonePeaksPaced: readonly number[];
}

/** pacing over the online-published batches at the board's chosen window */
export function releaseSummary(day: DayPlan, windowSec = 90): ReleaseSummary {
  const online = batchOnline(day.orders, windowSec, SLOTTING);
  const jobList = buildJobList(
    online.publishedBatches,
    day.orders,
    online.batchPublish,
  );
  const caps = zoneCaps(Math.ceil(BRAMBLE_MAP.aisles / ZONE_GROUP), day.profile.pickersPerZone);
  const opts = {
    startSec: 0,
    horizonSec: day.horizonSec,
    binSec: 60,
  };
  const unpaced = releasePlan(jobList, caps, { ...opts, paced: false });
  const paced = releasePlan(jobList, caps, { ...opts, paced: true });
  return {
    unpaced,
    paced,
    peakUnpacedCarts: unpaced.peakQueueCarts,
    peakPacedCarts: paced.peakQueueCarts,
    avgUnpacedCarts: unpaced.avgQueueCarts,
    avgPacedCarts: paced.avgQueueCarts,
    lastUnpacedSec: unpaced.lastReleaseSec,
    lastPacedSec: paced.lastReleaseSec,
    breachedUnpaced: unpaced.breaches.length,
    breachedPaced: paced.breaches.length,
    zonePeaksPaced: paced.zones.map((z) => z.peakCarts),
  };
}

/** plain-text lock sheet for the fixtures: the numbers the tests hold */
export function lockSheet(): string[] {
  const out: string[] = [];
  for (const p of DAY_PROFILES) {
    const day = dayByKey(p.key);
    const s = summarizeDay(day);
    out.push(
      `${p.key} — ${s.orders} orders, ${s.lines} lines, ${s.batches} carts, fcfs ${s.fcfsTourSec.toFixed(0)}s, batched ${s.totalTourSec.toFixed(0)}s, saved ${(s.walksSaved * 100).toFixed(1)}%`,
    );
    out.push(
      `  tabu: delta ${s.tabuDeltaSec.toFixed(0)}s (${(s.tabuDeltaPct * 100).toFixed(2)}%), moves ${s.tabuApplied}`,
    );
    for (const w of onlineSweep(day)) {
      out.push(
        `  w=${String(w.windowSec).padStart(3)}s: ${w.freezes} freezes, saved ${(w.walksSaved * 100).toFixed(1)}%, mean wait ${w.meanWaitSec.toFixed(0)}s, p90 wait ${w.p90WaitSec}s, mean tardy ${w.meanTardySec.toFixed(1)}s, p90 tardy ${w.p90TardySec}s, late ${w.lateOrders}`,
      );
    }
    const rel = releaseSummary(day);
    out.push(
      `  release: unpaced peak ${rel.peakUnpacedCarts} carts, paced peak ${rel.peakPacedCarts} carts, breaches ${rel.breachedUnpaced} → ${rel.breachedPaced}, last ${rel.lastUnpacedSec}s → ${rel.lastPacedSec}s`,
    );
    out.push(`  zone peaks (paced): ${rel.zonePeaksPaced.map((x) => x.toFixed(0)).join(" / ")}`);
  }
  return out;
}
