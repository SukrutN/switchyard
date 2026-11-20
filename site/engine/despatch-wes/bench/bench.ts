/* ============================================================
   bench — the lane mode's cost vs order count.

   The orchestrator rides the MemoryYard: every order is a
   journaled lane row, every freeze a publish+ack+board cycle.
   Sizes are synthetic days assembled from the trio's own
   orders (cycled, re-stamped, arrivals stretched per wave) —
   the same input the engine's bench batches, so the two
   artifacts share an abscissa. Wall clock is the only float;
   everything journaled is fixed-point.

   Determinism is re-checked per row: two full passes of the
   same synthetic day must hash the lanes byte-identically.

   Run: npm run bench:wes — writes bench/results.json. No
   timestamps in the data, only the lock date.
   ============================================================ */

import { batchOnline } from "../../despatch-engine/index.ts";
import { SLA_BY_CLASS } from "../../despatch-engine/index.ts";
import { DAYS, SLOTTING, dayByKey } from "../../despatch-engine/fixtures/dc.ts";
import type { DespatchOrder } from "../../despatch-engine/index.ts";
import { decodeBoardRow, encodeOrderRow } from "../src/records.ts";
import { digestOf } from "../fixtures/daylane.ts";
import { MemoryYard } from "../src/modelyard.ts";
import { DespatchWes } from "../src/wes.ts";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/* ---------- synthetic days assembled from the trio's orders ---------- */

const BASE = dayByKey("average-day").orders;

function syntheticOrders(n: number): DespatchOrder[] {
  const horizon = dayByKey("average-day").horizonSec;
  const out: DespatchOrder[] = [];
  for (let i = 0; i < n; i++) {
    const o = BASE[i % BASE.length];
    const wave = Math.floor(i / BASE.length);
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

/** one full orchestrator pass over a fresh MemoryYard: boot, stage
    the rows onto the orders lane, finalize. Returns the yard for
    the determinism reader. */
async function lanePass(
  orders: readonly DespatchOrder[],
  pickersPerZone: number,
): Promise<{ yard: MemoryYard; ms: number }> {
  const yard = new MemoryYard();
  const wes = new DespatchWes(yard, SLOTTING, {
    windowSec: 90,
    zoneCount: 4,
    pickersPerZone,
    horizonSec: dayByKey("average-day").horizonSec,
  });
  const t0 = performance.now();
  await wes.boot();
  for (const o of orders) {
    await yard.publishRow("orders", `orders.${o.id}.paid`, encodeOf(o));
  }
  await wes.finalize();
  return { yard, ms: performance.now() - t0 };
}

/** the lane's canonical order row — the fixture's staging, inlined so
    the bench times the lane, not the fixture. */
function encodeOf(o: DespatchOrder): Uint8Array {
  return encodeOrderRow({
    kind: "order",
    ref: o.id,
    cls: o.cls,
    dueSec: o.dueSec,
    arrivalSec: o.arrivalSec,
    lines: o.lines,
  });
}

async function timed(fn: () => Promise<void>): Promise<number> {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

/** median of 3 after one warm-up (the engine bench's rule). */
async function median3(fn: () => Promise<void>): Promise<number> {
  await fn(); // warm-up, untimed
  const xs: number[] = [];
  for (let i = 0; i < 3; i++) xs.push(await timed(fn));
  xs.sort((a, b) => a - b);
  return Math.round(xs[1] * 100) / 100;
}

/* ---------- the size curve ---------- */

const SIZES = [100, 200, 400, 800, 1600];
const rows: unknown[] = [];

for (const n of SIZES) {
  const orders = syntheticOrders(n);

  const wesMs = await median3(async () => {
    await lanePass(orders, 1);
  });
  const onlineMs = await median3(async () => {
    batchOnline(orders, 90, SLOTTING);
  });

  const A = await lanePass(orders, 1);
  const B = await lanePass(orders, 1);
  const lanes = ["despatch-release", "work-z1", "work-z2", "work-z3", "work-z4"];
  const deterministic = lanes.every((l) => digestOf(A.yard, l) === digestOf(B.yard, l));

  const releasedRows = A.yard.msgRows("despatch-release").length;
  const freezes = (await boardRead(A.yard)).freezeSeq;

  rows.push({
    orders: n,
    wesMs: Math.round(wesMs * 100) / 100,
    onlineMs: Math.round(onlineMs * 100) / 100,
    perOrderUs: Math.round((wesMs / n) * 1000 * 100) / 100,
    freezes,
    releasedRows,
    deterministic,
  });
}

/* ---------- the three worked days, timed once for the record ---------- */

const dayRows: unknown[] = [];
for (const d of DAYS) {
  const t0 = performance.now();
  const { yard } = await lanePass(d.orders, d.profile.pickersPerZone);
  const ms = performance.now() - t0;
  dayRows.push({
    key: d.profile.key,
    orders: d.orders.length,
    wesMs: Math.round(ms * 100) / 100,
    freezes: (await boardRead(yard)).freezeSeq,
    quarantines: yard.msgRows("despatch-quarantine").length,
  });
}

async function boardRead(yard: MemoryYard): Promise<{ freezeSeq: number }> {
  const v = await yard.kvGet("despatch-pace", "board");
  return decodeBoardRow(v.payload);
}

const artifact = {
  generated: "2026-10-25",
  note: "median of 3 async passes after one warm-up; MemoryYard journaled writes; determinism re-checked per row; engine equivalent timed beside it",
  dayRows,
  runs: rows,
};

const outPath = join(HERE, "results.json");
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

// the honest print: results.json's summary, for the terminal
for (const r of artifact.runs as Record<string, unknown>[]) {
  console.log(
    `${String(r.orders).padStart(5)} orders → lane mode ${String(r.wesMs).padStart(9)}ms (${String(r.perOrderUs).padStart(7)}µs/order), engine loop ${String(r.onlineMs).padStart(8)}ms, stable ${r.deterministic ? "✓" : "✗"}`,
  );
}
for (const r of artifact.dayRows as Record<string, unknown>[]) {
  console.log(
    `  ${String(r.key).padEnd(15)} ${String(r.orders).padStart(5)} orders — ${r.wesMs}ms, ${r.freezes} freezes, ${r.quarantines} quarantines`,
  );
}
console.log(`written: ${outPath}`);
