/* ============================================================
   lock — the once-per-engine run (the despatch-engine's bench
   convention): stage all three worked days through the WES,
   take the lane digests, the board, and the clean-day latency
   curve, and PRINT the JSON. The human pastes it into
   `expected.ts`, which stays pure data (no imports) — the
   characterization tests then read it as the bench law.

   Run: `node engine/despatch-wes/fixtures/lock.ts`
   ============================================================ */

import { boardOf, digestOf, runShift } from "./daylane.ts";

const KEYS = ["average-day", "rush-morning", "seasonal-spike"] as const;

interface DayLock {
  orders: number;
  freezes: number;
  batches: number;
  releaseRows: number;
  workZ1: number;
  workZ2: number;
  workZ3: number;
  workZ4: number;
  digests: {
    release: string;
    quarantine: string;
    control: string;
    workZ1: string;
    workZ2: string;
    workZ3: string;
    workZ4: string;
  };
  board: {
    releasedThrough: number;
    freezeSeq: number;
    nextFreeze: number;
    given: number[];
  };
}

const days: Record<string, DayLock> = {};
let latency = { orders: 0, p50: 0, p90: 0, p99: 0, max: 0, mean: 0 };

for (const key of KEYS) {
  const A = await runShift(key);
  const freezs = A.stats.freezes;
  days[key] = {
    orders: A.stats.ordersIn,
    freezes: freezs.length,
    batches: A.stats.batches,
    releaseRows: A.stats.receipts.filter((r) => r.status === "released").length,
    workZ1: A.yard.msgRows("work-z1").length,
    workZ2: A.yard.msgRows("work-z2").length,
    workZ3: A.yard.msgRows("work-z3").length,
    workZ4: A.yard.msgRows("work-z4").length,
    digests: {
      release: digestOf(A.yard, "despatch-release"),
      quarantine: digestOf(A.yard, "despatch-quarantine"),
      control: digestOf(A.yard, "despatch-control"),
      workZ1: digestOf(A.yard, "work-z1"),
      workZ2: digestOf(A.yard, "work-z2"),
      workZ3: digestOf(A.yard, "work-z3"),
      workZ4: digestOf(A.yard, "work-z4"),
    },
    board: {
      releasedThrough: (await boardOf(A.yard)).releasedThrough,
      freezeSeq: (await boardOf(A.yard)).freezeSeq,
      nextFreeze: (await boardOf(A.yard)).nextFreeze,
      given: [...(await boardOf(A.yard)).given],
    },
  };

  if (key === "average-day") {
    const arrivals = new Map(A.day.orders.map((o) => [o.id, o.arrivalSec]));
    const lats: number[] = [];
    for (const r of A.stats.receipts) {
      if (r.status !== "released") continue;
      for (const ref of r.orders) lats.push(r.effectiveSec - arrivals.get(ref)!);
    }
    const sorted = [...lats].sort((a, b) => a - b);
    const pick = (p: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    latency = {
      orders: sorted.length,
      p50: pick(0.5),
      p90: pick(0.9),
      p99: pick(0.99),
      max: sorted[sorted.length - 1],
      mean: Math.round((sorted.reduce((s, x) => s + x, 0) / sorted.length) * 100) / 100,
    };
  }
}

const WES_LOCK = {
  averageDay: days["average-day"],
  rushMorning: days["rush-morning"],
  seasonalSpike: days["seasonal-spike"],
  latency,
};

console.log(JSON.stringify(WES_LOCK, null, 2));
