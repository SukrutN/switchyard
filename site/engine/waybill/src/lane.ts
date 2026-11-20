/* ============================================================
   lane — the dock's seam.

   What an adapter needs from a yard: publish with a receipt,
   KV that is itself journaled, and a journal to replay. Two
   implementations ride this seam: `desk.ts` (DeskYard — in
   process, deterministic, the tests' yard) and `spur.ts` over
   the real Go yard for the live bring-up.

   Lanes are routes as data: a partner profile's `targets` names
   them, and LANES carries the defaults. The subject charter
   (switchyard §3) is claimed HERE, at the origin — a ref that
   would not fit `orders.<ref>.paid` never leaves the adapter;
   it is refused with a reason code instead (the yard's refusal
   would be the same law, heard later).

   The despatch target deserves its own notice: sheet 02's
   orders lane speaks OrderRow v1 — canonical JSON in a fixed
   key order, no version of waybill's inside. `despatchRowOf`
   mirrors those bytes exactly, so an order waybill mapped from
   a 940 lands readable by despatch-wes untouched.
   ============================================================ */

import { type Canon, nat, obj as canonObj2, canonRow } from "./canon.ts";
import type { CanonOrder, RefusalCode } from "./canon.ts";

export interface LaneRow {
  readonly seq: number;
  readonly kind: "stream" | "kv" | "kvdel";
  readonly subject: string; // stream rows only
  readonly key: string; // kv rows only
  readonly payload: Uint8Array;
}

export interface KVAnswer {
  readonly found: boolean;
  readonly payload: Uint8Array;
  readonly seq: number; // the set that wrote it; 0 when not found
}

/** the seam every adapter codes against and every yard promises. */
export interface WaybillLane {
  /** the journaled write: the receipt is the fsynced-before-copy
      fact; seq is one lane number per write (§2.10/§2.11). */
  publish(lane: string, subject: string, payload: Uint8Array): Promise<number>;
  ensure(lane: string): Promise<void>;
  /** KV rides the lane's own sequence space (§2.18); the receipt is ours. */
  kvSet(lane: string, key: string, payload: Uint8Array): Promise<number>;
  kvGet(lane: string, key: string): Promise<KVAnswer>;
  kvDelete(lane: string, key: string): Promise<number>;
  keys(lane: string): Promise<readonly string[]>;
  /** the journal, in write order — replay's window */
  rows(lane: string): Promise<readonly LaneRow[]>;
}

export const LANES = {
  /** despatch-wes's order lane — sheet 02's consumer rides here */
  orders: "orders",
  /** waybill's own DLQ: refused documents land here as refusal rows */
  dead: "waybill-dead",
  /** waybill's KV: control-number state and whatever else is paced */
  pace: "waybill-pace",
} as const;

/* ============================================================
   the charter's token law (§3), claimed at the origin
   ============================================================ */

export class CharterError extends Error {
  constructor(subject: string, detail: string) {
    super(`charter: subject "${subject}" ${detail}`);
    this.name = "CharterError";
  }
}

function tokenOk(token: string): boolean {
  if (token.length < 1 || token.length > 64) return false;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    // printable ASCII, no dot — the dot is the separator's own
    if (c < 0x21 || c > 0x7e || c === 0x2e) return false;
  }
  return true;
}

export function checkSubject(subject: string): string {
  for (const t of subject.split(".")) {
    if (!tokenOk(t)) {
      throw new CharterError(subject, `carries ${JSON.stringify(t)} — not a charter token`);
    }
  }
  return subject;
}

/** subject of an order row: first token must equal the lane (§2.10). */
export function orderSubject(ref: string): string {
  return checkSubject(`orders.${ref}.paid`);
}

/** subject of a refusal row on the DLQ — the lane's own name is
    the first token (§2.10: the subject rides its lane; the real
    yard refuses anything else at the wire with STREAM_SUBJECT). */
export function deadSubject(code: RefusalCode, docName: string): string {
  return checkSubject(`${LANES.dead}.${code}.${docName}`);
}

/* ============================================================
   the despatch target — OrderRow v1 (sheet 02's records.ts bytes)
   ============================================================ */

export type DespatchClass = "standard" | "expedite" | "critical";

export interface DespatchRow {
  readonly kind: "order";
  readonly ref: string;
  readonly cls: DespatchClass;
  readonly dueSec: number;
  readonly arrivalSec: number;
  readonly lines: readonly { readonly sku: string; readonly qty: number }[];
}

/** the canonical order becomes exactly the bytes despatch-wes's
    records.ts writes — kind/ref/cls/dueSec/arrivalSec/lines, same
    key order, same number law. The class and the SLA are profile
    data (the 940 carries no class; the companion guide does). */
export function despatchRowOf(
  order: CanonOrder,
  cls: DespatchClass,
  slaSec: number,
): Uint8Array {
  const lines: Canon[] = order.lines.map((l) =>
    canonObj2([["sku", l.sku], ["qty", nat(l.qty)]]),
  );
  return canonRow([
    ["kind", "order"],
    ["ref", order.ref],
    ["cls", cls],
    ["dueSec", nat(order.dateSec + slaSec)],
    ["arrivalSec", nat(order.dateSec)],
    ["lines", lines],
  ]);
}

/** decode door for the target's own bytes — the replay test walks
    the journal through this and meets the order again. */
export function decodeDespatchRow(b: Uint8Array): DespatchRow {
  const o = JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>;
  expect(o.kind === "order", `kind ${JSON.stringify(o.kind)} is not "order"`);
  const clsRaw = o.cls as unknown;
  let cls: DespatchClass;
  if (clsRaw === "standard" || clsRaw === "expedite" || clsRaw === "critical") {
    cls = clsRaw;
  } else {
    throw new Error(`despatch row: cls ${JSON.stringify(clsRaw)} is not a class`);
  }
  expect(typeof o.ref === "string", "ref is not a string");
  return {
    kind: "order",
    ref: o.ref as string,
    cls,
    dueSec: natOf(o.dueSec, "dueSec"),
    arrivalSec: natOf(o.arrivalSec, "arrivalSec"),
    lines: (Array.isArray(o.lines) ? o.lines : bad("lines not an array")).map(
      (l: unknown) => {
        const r = l as Record<string, unknown>;
        expect(typeof r.sku === "string", "line.sku is not a string");
        return { sku: r.sku as string, qty: natOf(r.qty, "line.qty") };
      },
    ),
  };
}

function expect(ok: boolean, why: string): void {
  if (!ok) throw new Error(`despatch row: ${why}`);
}

function bad(why: string): never {
  throw new Error(`despatch row: ${why}`);
}

function natOf(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new Error(`despatch row: ${what} ${JSON.stringify(v)} is not a count`);
  }
  return v;
}
