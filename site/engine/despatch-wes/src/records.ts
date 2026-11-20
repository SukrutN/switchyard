/* ============================================================
   records — the canonical bytes the WES journals.

   Every journal row and KV record this family writes carries a
   payload built HERE: same record in, same bytes out, byte for
   byte. That is the determinism story's keystone — replay a day
   and compare lanes or hashes, knowing the bytes are a pure
   function of the records.

   Shape: canonical JSON, fixed key order per record type. No
   Date, no Math.random, no locale — nothing that can disagree
   between two runs. Non-integer seconds round to three decimals
   before they can encode, so the travel proxy's float noise
   dies at the door, not downstream.

   One fnv1a64 digest helper travels with it: the replay test
   hashes whole Consumer-visible lanes with it.
   ============================================================ */

/* ---------- the canonical writer ---------- */

function escString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += s[i];
  }
  return out + '"';
}

/** integers stay integers; floats round to 3 decimals at the door. */
function jnum(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`records: non-finite number ${v}`);
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1000) / 1000);
}

function nat(n: unknown): number {
  if (typeof n !== "number" || !Number.isInteger(n) || !Number.isFinite(n) || n < 0) {
    throw new Error(
      `records: expected a non-negative integer, got ${JSON.stringify(n)}`,
    );
  }
  return n;
}

/** values in a record encoder arrive PRE-SHAPED: plain numbers and
    strings go through the scalar writers, arrays/objects are built
    from the same helpers recursively. */
type Canon =
  | string
  | number
  | readonly Canon[]
  | CanonRecord;

interface CanonRecord {
  readonly kind: "obj";
  readonly fields: readonly (readonly [string, Canon])[];
}

const o = (fields: readonly (readonly [string, Canon])[]): CanonRecord => ({
  kind: "obj",
  fields,
});

function canon(v: Canon): string {
  if (typeof v === "string") return escString(v);
  if (typeof v === "number") return jnum(v);
  if ("kind" in v) {
    let s = "{";
    let first = true;
    for (const [k, val] of v.fields) {
      if (!first) s += ",";
      first = false;
      s += escString(k) + ":" + canon(val);
    }
    return s + "}";
  }
  let s = "[";
  for (let i = 0; i < v.length; i++) {
    if (i > 0) s += ",";
    s += canon(v[i]);
  }
  return s + "]";
}

function encodeStr(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

const bytes = (v: Canon): Uint8Array => encodeStr(canon(v));

/* ============================================================
   fnv1a64 — the digest the replay test hashes lanes with.
   Deterministic, cheap, honest about its inputs (bytes only).
   ============================================================ */

const FNV_OFFSET = 0xcbf2_9ce4_8422_2325n;
const FNV_PRIME = 0x0000_0100_0000_01b3n;
const U64_MASK = 0xffff_ffff_ffff_ffffn;

export function fnv1a64(bytesIn: Uint8Array): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < bytesIn.length; i++) {
    hash ^= BigInt(bytesIn[i]);
    hash = (hash * FNV_PRIME) & U64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

export function rowDigest(
  rows: readonly { subject: string; payload: Uint8Array }[],
): string {
  // feed rows one at a time: \0 subject \0 payload \x0F — a fixed
  // separator frame so "a b" + "c" can never alias "a" + "b c".
  let hash = FNV_OFFSET;
  const step = (b: Uint8Array): void => {
    for (let i = 0; i < b.length; i++) {
      hash = ((hash ^ BigInt(b[i])) * FNV_PRIME) & U64_MASK;
    }
  };
  for (const r of rows) {
    step(new Uint8Array([0]));
    step(encodeStr(r.subject));
    step(new Uint8Array([0]));
    step(r.payload);
    step(new Uint8Array([0x0f]));
  }
  return hash.toString(16).padStart(16, "0");
}

/* ============================================================
   the record types + their encoders
   ============================================================ */

/* ---------- orders lane (inbound freight) ---------- */

export type OrderClass = "standard" | "expedite" | "critical";

export interface OrderLine {
  readonly sku: string;
  readonly qty: number;
}

export interface OrderRow {
  readonly kind: "order";
  readonly ref: string; // BT-0001 style id
  readonly cls: OrderClass;
  readonly dueSec: number;
  readonly arrivalSec: number;
  readonly lines: readonly OrderLine[];
}

/** subject of an order row: first token must equal the lane (§2.10). */
export function orderSubject(ref: string): string {
  return `orders.${ref}.paid`;
}

const line = (l: OrderLine): Canon => o([["sku", l.sku], ["qty", nat(l.qty)]]);

export function encodeOrderRow(row: OrderRow): Uint8Array {
  return bytes(
    o([
      ["kind", row.kind],
      ["ref", row.ref],
      ["cls", row.cls],
      ["dueSec", nat(row.dueSec)],
      ["arrivalSec", nat(row.arrivalSec)],
      ["lines", row.lines.map(line)],
    ]),
  );
}

export function decodeOrderRow(b: Uint8Array): OrderRow {
  const v = parse(b);
  expect(v.kind, "order");
  return {
    kind: "order",
    ref: str(v.ref),
    cls: v.cls as OrderClass,
    dueSec: nat(v.dueSec),
    arrivalSec: nat(v.arrivalSec),
    lines: (v.lines as Record<string, unknown>[]).map((l) => ({
      sku: str(l.sku),
      qty: nat(l.qty),
    })),
  };
}

/* ---------- work lanes (per zone) ---------- */

export interface WorkStop {
  readonly sku: string;
  readonly aisle: number;
  readonly bay: number;
  readonly qty: number;
}

export interface WorkRow {
  readonly kind: "work";
  readonly batch: string; // freeze-tagged batch id, e.g. B-003/W002
  readonly window: number; // the freeze second that published it
  readonly zone: number; // 0-based
  readonly releaseSec: number; // planned (paced) release
  readonly effectiveSec: number; // after backpressure honesty
  readonly lines: number;
  readonly orders: readonly string[];
  readonly stops: readonly WorkStop[];
}

const stop = (s: WorkStop): Canon =>
  o([["sku", s.sku], ["a", nat(s.aisle)], ["b", nat(s.bay)], ["q", nat(s.qty)]]);

export function encodeWorkRow(row: WorkRow): Uint8Array {
  return bytes(
    o([
      ["kind", row.kind],
      ["batch", row.batch],
      ["window", nat(row.window)],
      ["zone", nat(row.zone)],
      ["releaseSec", nat(row.releaseSec)],
      ["effectiveSec", nat(row.effectiveSec)],
      ["lines", nat(row.lines)],
      ["orders", row.orders.map((x) => x)],
      ["stops", row.stops.map(stop)],
    ]),
  );
}

export function decodeWorkRow(b: Uint8Array): WorkRow {
  const v = parse(b);
  expect(v.kind, "work");
  return {
    kind: "work",
    batch: str(v.batch),
    window: nat(v.window),
    zone: nat(v.zone),
    releaseSec: nat(v.releaseSec),
    effectiveSec: nat(v.effectiveSec),
    lines: nat(v.lines),
    orders: v.orders as string[],
    stops: (v.stops as Record<string, unknown>[]).map((s) => ({
      sku: str(s.sku),
      aisle: nat(s.a),
      bay: nat(s.b),
      qty: nat(s.q),
    })),
  };
}

/* ---------- release lane (the decision ledger) ---------- */

export interface ReceiptRow {
  readonly kind: "receipt";
  readonly batch: string;
  readonly window: number; // the freeze that published it
  readonly zone: number;
  readonly releaseSec: number; // planned release (the pace law)
  readonly effectiveSec: number; // when the work row hit the zone lane
  readonly status: "released" | "held";
  readonly orders: readonly string[];
  readonly lines: number;
  readonly tourSec: number;
  readonly craftSec: number;
  readonly dueSec: number; // tightest order due riding it
}

export function encodeReceiptRow(r: ReceiptRow): Uint8Array {
  return bytes(
    o([
      ["kind", r.kind],
      ["batch", r.batch],
      ["window", nat(r.window)],
      ["zone", nat(r.zone)],
      ["releaseSec", nat(r.releaseSec)],
      ["effectiveSec", nat(r.effectiveSec)],
      ["status", r.status],
      ["orders", r.orders.map((x) => x)],
      ["lines", nat(r.lines)],
      ["tourSec", Math.round(r.tourSec * 1000) / 1000],
      ["craftSec", nat(r.craftSec)],
      ["dueSec", nat(r.dueSec)],
    ]),
  );
}

export function decodeReceiptRow(b: Uint8Array): ReceiptRow {
  const v = parse(b);
  expect(v.kind, "receipt");
  return {
    kind: "receipt",
    batch: str(v.batch),
    window: nat(v.window),
    zone: nat(v.zone),
    releaseSec: nat(v.releaseSec),
    effectiveSec: nat(v.effectiveSec),
    status: v.status as "released" | "held",
    orders: v.orders as string[],
    lines: nat(v.lines),
    tourSec: Math.round(Number(v.tourSec) * 1000) / 1000,
    craftSec: nat(v.craftSec),
    dueSec: nat(v.dueSec),
  };
}

export function releaseSubject(batch: string): string {
  return `despatch-release.${batch}`;
}

/* ---------- quarantine lane (the DLQ with reason codes) ---------- */

export type ReasonCode = "UNMAPPED_SKU" | "OVERSIZED";

export interface QuarantineRow {
  readonly kind: "quarantine";
  readonly reason: ReasonCode;
  readonly ref: string; // the order that triggered it
  readonly sku: string; // the offending line's sku ("" for OVERSIZED)
  readonly status: "open" | "resolved";
  readonly via: string; // "reassign" when resolved by the control lane
}

export function encodeQuarantineRow(q: QuarantineRow): Uint8Array {
  return bytes(
    o([
      ["kind", q.kind],
      ["reason", q.reason],
      ["ref", q.ref],
      ["sku", q.sku],
      ["status", q.status],
      ["via", q.via],
    ]),
  );
}

export function decodeQuarantineRow(b: Uint8Array): QuarantineRow {
  const v = parse(b);
  expect(v.kind, "quarantine");
  return {
    kind: "quarantine",
    reason: v.reason as ReasonCode,
    ref: str(v.ref),
    sku: str(v.sku),
    status: v.status as "open" | "resolved",
    via: str(v.via),
  };
}

/** subject: lane name first (§2.10), then the reason, then the ref. */
export function quarantineSubject(reason: ReasonCode, ref: string): string {
  return `despatch-quarantine.${reason}.${ref}`;
}

/* ---------- control lane (operator intents) ---------- */

export interface ReassignRow {
  readonly kind: "reassign";
  readonly ref: string; // the order being pulled back in
  readonly sku: string; // the SKU the mapping fix covers
  readonly aisle: number; // the new pick face (the zone derives by law)
  readonly bay: number;
  /** the order itself, re-declared: the operator's terminal carried it
      once on the wire, and this row is its second, durable telling —
      the WES re-mails the full order into the pool on apply, so a
      reassign works whether the order is still parked or long acked. */
  readonly cls: OrderClass;
  readonly arrivalSec: number;
  readonly dueSec: number;
  readonly lines: readonly OrderLine[];
}

export function encodeReassignRow(r: ReassignRow): Uint8Array {
  return bytes(
    o([
      ["kind", r.kind],
      ["ref", r.ref],
      ["sku", r.sku],
      ["aisle", nat(r.aisle)],
      ["bay", nat(r.bay)],
      ["cls", r.cls],
      ["arrivalSec", nat(r.arrivalSec)],
      ["dueSec", nat(r.dueSec)],
      ["lines", r.lines.map(line)],
    ]),
  );
}

export function decodeReassignRow(b: Uint8Array): ReassignRow {
  const v = parse(b);
  expect(v.kind, "reassign");
  return {
    kind: "reassign",
    ref: str(v.ref),
    sku: str(v.sku),
    aisle: nat(v.aisle),
    bay: nat(v.bay),
    cls: v.cls as OrderClass,
    arrivalSec: nat(v.arrivalSec),
    dueSec: nat(v.dueSec),
    lines: (v.lines as Record<string, unknown>[]).map((l) => ({
      sku: str(l.sku),
      qty: nat(l.qty),
    })),
  };
}

export function controlSubject(ref: string): string {
  return `despatch-control.${ref}.reassign`;
}

/* ---------- pace-lane KV payloads ---------- */

export interface BoardRow {
  readonly kind: "board";
  /** orders-lane watermark: deliveries ≤ this are already durable */
  readonly releasedThrough: number;
  /** freeze counter, global across the day (batch ids carry /W{n}) */
  readonly freezeSeq: number;
  /** the armed freeze second (0 = disarmed) */
  readonly nextFreeze: number;
  /** per-zone cumulative craft seconds promised so far, zone 0..n */
  readonly given: readonly number[];
}

export function encodeBoardRow(b: BoardRow): Uint8Array {
  return bytes(
    o([
      ["kind", b.kind],
      ["releasedThrough", nat(b.releasedThrough)],
      ["freezeSeq", nat(b.freezeSeq)],
      ["nextFreeze", nat(b.nextFreeze)],
      ["given", b.given.map((g) => Math.round(g * 1000) / 1000)],
    ]),
  );
}

export function decodeBoardRow(b: Uint8Array): BoardRow {
  const v = parse(b);
  expect(v.kind, "board");
  return {
    kind: "board",
    releasedThrough: nat(v.releasedThrough),
    freezeSeq: nat(v.freezeSeq),
    nextFreeze: nat(v.nextFreeze),
    given: (v.given as number[]).map((g) => Math.round(Number(g) * 1000) / 1000),
  };
}

export interface HoldRow {
  readonly kind: "hold";
  readonly batch: string;
  readonly window: number;
  readonly zone: number; // 0-based
  readonly plannedSec: number; // the pace law's release sec
  /** the whole work content — the crash envelope's guarantee that a
      resumed orchestrator re-publishes the SAME bytes, not a guess. */
  readonly work: {
    readonly lines: number;
    readonly orders: readonly string[];
    readonly stops: readonly { readonly sku: string; readonly aisle: number; readonly bay: number; readonly qty: number }[];
    readonly tourSec: number;
    readonly craftSec: number;
    readonly dueSec: number;
  };
}

export function encodeHoldRow(h: HoldRow): Uint8Array {
  return bytes(
    o([
      ["kind", h.kind],
      ["batch", h.batch],
      ["window", nat(h.window)],
      ["zone", nat(h.zone)],
      ["plannedSec", nat(h.plannedSec)],
      [
        "work",
        o([
          ["lines", nat(h.work.lines)],
          ["orders", h.work.orders.map((x) => x)],
          ["stops", h.work.stops.map((s) => o([["sku", s.sku], ["a", nat(s.aisle)], ["b", nat(s.bay)], ["q", nat(s.qty)]]))],
          ["tourSec", Math.round(h.work.tourSec * 1000) / 1000],
          ["craftSec", nat(h.work.craftSec)],
          ["dueSec", nat(h.work.dueSec)],
        ]),
      ],
    ]),
  );
}

export function decodeHoldRow(b: Uint8Array): HoldRow {
  const v = parse(b);
  expect(v.kind, "hold");
  const w = v.work as Record<string, unknown>;
  return {
    kind: "hold",
    batch: str(v.batch),
    window: nat(v.window),
    zone: nat(v.zone),
    plannedSec: nat(v.plannedSec),
    work: {
      lines: nat(w.lines),
      orders: w.orders as string[],
      stops: (w.stops as Record<string, unknown>[]).map((s) => ({
        sku: str(s.sku),
        aisle: nat(s.a),
        bay: nat(s.b),
        qty: nat(s.q),
      })),
      tourSec: Math.round(Number(w.tourSec) * 1000) / 1000,
      craftSec: nat(w.craftSec),
      dueSec: nat(w.dueSec),
    },
  };
}

/** key of a hold in the pace lane's KV space. '/' is charter-legal (§3.2);
    batch ids carry '/' and keys are never subjects (§3.2). */
export function holdKey(batch: string): string {
  return `hold.${batch.replace(/\//g, "-")}`;
}

/** the operator's sku fixes, re-readable after any crash: the pace
    lane's KV holds face and bay, so a resumed orchestrator rebuilds
    the exact slotting overlay without guessing. */
export interface SkuMapRow {
  readonly kind: "sku-map";
  readonly fixes: readonly {
    readonly sku: string;
    readonly aisle: number;
    readonly bay: number;
  }[];
}

export function encodeSkuMapRow(m: SkuMapRow): Uint8Array {
  const rows = [...m.fixes].sort((a, b) =>
    a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0,
  );
  return bytes(
    o([
      ["kind", m.kind],
      [
        "fixes",
        rows.map((f) =>
          o([
            ["sku", f.sku],
            ["aisle", nat(f.aisle)],
            ["bay", nat(f.bay)],
          ]),
        ),
      ],
    ]),
  );
}

export function decodeSkuMapRow(b: Uint8Array): SkuMapRow {
  const v = parse(b);
  expect(v.kind, "sku-map");
  return {
    kind: "sku-map",
    fixes: (v.fixes as Record<string, unknown>[]).map((f) => ({
      sku: str(f.sku),
      aisle: nat(f.aisle),
      bay: nat(f.bay),
    })),
  };
}

/* ---------- tiny decode helpers ---------- */

const decoder = new TextDecoder();

function parse(b: Uint8Array): Record<string, unknown> {
  return JSON.parse(decoder.decode(b)) as Record<string, unknown>;
}

function expect(k: unknown, want: string): void {
  if (k !== want) throw new Error(`records: expected kind "${want}", got "${String(k)}"`);
}

function str(v: unknown): string {
  if (typeof v !== "string") throw new Error(`records: expected string, got ${JSON.stringify(v)}`);
  return v;
}
