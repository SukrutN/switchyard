/* ============================================================
   daylane — a despatch-engine day, staged onto the `orders` lane.

   The fixture publisher's half of the story: an engine day
   (fixtures/dc.ts, the seeded orders) becomes lane rows, one
   per order, published in the generator's order (arrival
   ascending; ties fall where the generator put them — the WES
   re-sorts its inbox, so the lane's order is honest freight).
   Payloads are the canonical order records (records.ts);
   subjects are `orders.<ref>.paid` — the §2.10 law (lane name
   first token) holds by construction.

   Also the shared-shift helpers the tests and the bench reuse:
   `runShift` (stage + boot + finalize), slice staging for the
   resume test, and small readers over the journals and the
   board for assertions.
   ============================================================ */

import type { DespatchOrder } from "../../despatch-engine/index.ts";
import { dayByKey, SLOTTING, type DayPlan } from "../../despatch-engine/fixtures/dc.ts";
import {
  decodeBoardRow,
  decodeQuarantineRow,
  decodeReceiptRow,
  decodeWorkRow,
  encodeOrderRow,
  orderSubject,
  rowDigest,
} from "../src/records.ts";
import type { BoardRow, QuarantineRow, ReceiptRow, WorkRow } from "../src/records.ts";
import { MemoryYard } from "../src/modelyard.ts";
import { DespatchWes, type WesOptions, type WesStats } from "../src/wes.ts";

/** publish one order row (the orders lane, `orders.<ref>.paid`). */
export function stageOrder(yard: MemoryYard, o: DespatchOrder): Promise<number> {
  return yard.publishRow(
    "orders",
    orderSubject(o.id),
    encodeOrderRow({
      kind: "order",
      ref: o.id,
      cls: o.cls,
      dueSec: o.dueSec,
      arrivalSec: o.arrivalSec,
      lines: o.lines,
    }),
  );
}

/** an order slice, staged in array order — the resume test's way to
    crash mid-day between stage calls. */
export async function stageOrders(
  yard: MemoryYard,
  orders: readonly DespatchOrder[],
): Promise<void> {
  for (const o of orders) await stageOrder(yard, o);
}

/** the whole day (or its head), staged in the generator's order —
    the inbound freight of one fictional shift. */
export async function stageDay(
  yard: MemoryYard,
  day: DayPlan,
  count = day.orders.length,
): Promise<void> {
  await stageOrders(yard, day.orders.slice(0, count));
}

export interface Shift {
  readonly yard: MemoryYard;
  readonly wes: DespatchWes;
  readonly stats: WesStats;
  readonly day: DayPlan;
}

/** stage + boot + finalize — the whole one-pass shift: a fresh
    MemoryYard, the day's SLOTTING, the sheet's window (90s). */
export async function runShift(
  key: string,
  overrides: Partial<WesOptions> = {},
  count?: number,
): Promise<Shift> {
  const day = dayByKey(key);
  const yard = new MemoryYard();
  const wes = new DespatchWes(yard, SLOTTING, {
    windowSec: 90,
    zoneCount: 4,
    pickersPerZone: day.profile.pickersPerZone,
    horizonSec: day.horizonSec,
    ...overrides,
  });
  await wes.boot();
  await stageDay(yard, day, count);
  const stats = await wes.finalize(day.horizonSec);
  return { yard, wes, stats, day };
}

/* ============================================================
   tiny readers the tests assert with
   ============================================================ */

export function receiptsOf(yard: MemoryYard): ReceiptRow[] {
  return yard
    .msgRows("despatch-release")
    .map((r) => decodeReceiptRow(r.payload));
}

export function quarantinesOf(yard: MemoryYard): QuarantineRow[] {
  return yard
    .msgRows("despatch-quarantine")
    .map((r) => decodeQuarantineRow(r.payload));
}

export function workRowsOf(yard: MemoryYard, lane: string): WorkRow[] {
  return yard.msgRows(lane).map((r) => decodeWorkRow(r.payload));
}

/** the board as the resumed orchestrator reads it (pace lane KV). */
export async function boardOf(yard: MemoryYard): Promise<BoardRow> {
  const v = await yard.kvGet("despatch-pace", "board");
  if (!v.found) throw new Error("daylane: no board on the pace lane");
  return decodeBoardRow(v.payload);
}

/** the consumer-visible journal digest of one lane — the replay
    test's equality unit (records.ts rowDigest over msg rows). */
export function digestOf(yard: MemoryYard, lane: string): string {
  return rowDigest(
    yard.msgRows(lane).map((r) => ({ subject: r.subject, payload: r.payload })),
  );
}

/** msg rows as byte-viewable pairs — the resume test slices and
    compares these directly. */
export function rowsBytes(
  yard: MemoryYard,
  lane: string,
): { subject: string; hexPayload: string }[] {
  return yard.msgRows(lane).map((r) => ({
    subject: r.subject,
    hexPayload: hex(r.payload),
  }));
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** ref → the freeze second that consumed it, from the release
    receipt ledger (the engine's `publish` map, lane-side). */
export function windowsOf(yard: MemoryYard): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of receiptsOf(yard)) {
    if (r.status !== "released") continue;
    for (const ref of r.orders) m.set(ref, r.window);
  }
  return m;
}

/** the work-lane names in zone order, work-z1..z4. */
export function zoneLanes(zoneCount = 4): string[] {
  const out: string[] = [];
  for (let z = 0; z < zoneCount; z++) out.push(`work-z${z + 1}`);
  return out;
}
