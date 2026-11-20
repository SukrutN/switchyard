/* ============================================================
   canon — the canonical message model.

   waybill's spine: exactly one shape for an order, a shipment,
   a refusal. Every adapter's job is to ride THIS spine; a
   partner profile is data, the spine is law. "Canonical" twice
   over: the model is one shape regardless of how the document
   called it, and the journaled bytes are canonical JSON in a
   fixed key order per type — same row in, same bytes out, byte
   for byte, across runs, across replays.

   The version is the contract: every row carries `v`, checked at
   the decode door — a reader that meets a v it does not know
   refuses, it does not guess.

   Absence conventions, written ONCE: scalar optionals that read
   as data (po, batch, gtin, desc, bol) are always present and
   carry "" / [] when they are empty; structural optionals
   (shipDateSec, carrier, party fields) omit their key when
   absent, and the decoder matches. Money and weight ride
   fixed-point integers (cents and grams); quantities are counts.

   The canonical writer is sheet 02's law, mirrored: no Date,
   no Math.random, no locale — nothing that can disagree
   between two runs.
   ============================================================ */

export const CANON_V = 1;

/* ---------- the canonical writer (sheet 02's records.ts law) ---------- */

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
  if (!Number.isFinite(v)) throw new Error(`canon: non-finite number ${v}`);
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1000) / 1000);
}

export const nat = (n: unknown): number => {
  if (typeof n !== "number" || !Number.isInteger(n) || !Number.isFinite(n) || n < 0) {
    throw new Error(`canon: expected a non-negative integer, got ${JSON.stringify(n)}`);
  }
  return n;
}

/** values in an encoder arrive PRE-SHAPED: plain numbers and
    strings go through the scalar writers, arrays/objects are built
    from the same helpers recursively. */
export type Canon =
  | string
  | number
  | readonly Canon[]
  | CanonObj;

interface CanonObj {
  readonly kind: "obj";
  readonly fields: readonly (readonly [string, Canon])[];
}

export const obj = (fields: readonly (readonly [string, Canon])[]): CanonObj => ({
  kind: "obj",
  fields,
});
function render(v: Canon): string {
  if (typeof v === "string") return escString(v);
  if (typeof v === "number") return jnum(v);
  if ("kind" in v) {
    let s = "{";
    let first = true;
    for (const [k, val] of v.fields) {
      if (!first) s += ",";
      first = false;
      s += escString(k) + ":" + render(val);
    }
    return s + "}";
  }
  let s = "[";
  for (let i = 0; i < v.length; i++) {
    if (i > 0) s += ",";
    s += render(v[i]);
  }
  return s + "]";
}

function encodeStr(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

const bytes = (v: Canon): Uint8Array => encodeStr(render(v));

/** the writer, exported for OTHER families' fixed-order canonical
    bytes — the despatch OrderRow v1 target in lane.ts carries no
    `v` of its own; its shape is sheet 02's law, not waybill's. */
export function canonRow(fields: readonly (readonly [string, Canon])[]): Uint8Array {
  return bytes(obj(fields));
}

/* ---------- fnv1a64 — the replay tests' digest ---------- */

const FNV_OFFSET = 0xcbf2_9ce4_8422_2325n;
const FNV_PRIME = 0x0000_0100_0000_01b3n;
const U64_MASK = 0xffff_ffff_ffff_ffffn;

export function fnv1a64(data: Uint8Array): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < data.length; i++) {
    hash ^= BigInt(data[i]);
    hash = (hash * FNV_PRIME) & U64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/** hash a journal's (subject, payload) sequence so "a b"+"c" can
    never alias "a"+"b c": fixed separator bytes between rows. */
export function rowDigest(
  rows: readonly { subject: string; payload: Uint8Array }[],
): string {
  let hash = FNV_OFFSET;
  const feed = (b: number): void => {
    hash ^= BigInt(b);
    hash = (hash * FNV_PRIME) & U64_MASK;
  };
  for (const r of rows) {
    for (let i = 0; i < r.subject.length; i++) feed(r.subject.charCodeAt(i));
    feed(0);
    feed(0);
    for (let i = 0; i < r.payload.length; i++) feed(r.payload[i]);
    feed(0x0f);
  }
  return hash.toString(16).padStart(16, "0");
}

/* ============================================================
   civil ↔ epoch: EDI speaks calendars, the spine keeps seconds.
   The mapping law: a document date is civil UTC — CCYYMMDD +
   HHMM decode straight into epoch; date-only values land at
   00:00. Same seconds in, same calendar out.
   ============================================================ */

export function dateSecOf(date: string, time?: string): number {
  if (!/^[0-9]{8}$/.test(date)) {
    throw new Error(`canon: document date "${date}" is not CCYYMMDD`);
  }
  let h = 0;
  let mi = 0;
  if (time !== undefined && time.length > 0) {
    if (!/^[0-9]{4}$/.test(time)) {
      throw new Error(`canon: document time "${time}" is not HHMM`);
    }
    h = Number(time.slice(0, 2));
    mi = Number(time.slice(2, 4));
  }
  const y = Number(date.slice(0, 4));
  const mo = Number(date.slice(4, 6));
  const d = Number(date.slice(6, 8));
  if (mo < 1 || mo > 12) {
    throw new Error(`canon: document date "${date}" has no month ${mo}`);
  }
  if (d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) {
    throw new Error(`canon: document date "${date}" has no day ${d}`);
  }
  if (h > 23 || mi > 59) {
    throw new Error(`canon: document time "${time}" is not an HHMM on the clock`);
  }
  return Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 1000);
}

export function civilDate(sec: number): string {
  const t = new Date(sec * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}`;
}

export function civilTime(sec: number): string {
  const t = new Date(sec * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(t.getUTCHours())}${p(t.getUTCMinutes())}`;
}

/* ============================================================
   the model
   ============================================================ */

export interface Address {
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly region: string;
  readonly postal: string;
  readonly country: string;
}

export type PartyRole = "shipFrom" | "shipTo" | "billTo" | "vendor";

export interface Party {
  readonly role: PartyRole;
  readonly name?: string;
  /** the partner's id and the qualifier it rode in on (N103/N104) */
  readonly id?: string;
  readonly idQual?: string;
  readonly address?: Address;
  readonly phone?: string;
}

export interface CanonLine {
  readonly lineRef: string;
  readonly sku: string;
  readonly gtin: string;
  readonly desc: string;
  readonly qty: number;
  readonly uom: string;
}

export interface CanonRefs {
  readonly po: string;
  readonly batch: string;
  readonly finn: readonly { readonly qual: string; readonly id: string }[];
}

/** the canonical order — sheet 02's WES listens for a subset of this. */
export interface CanonOrder {
  readonly kind: "order";
  readonly v: typeof CANON_V;
  readonly ref: string; // the warehouse order number (W06-02)
  readonly partner: string; // the profile that mapped it
  readonly purpose: string; // W05-01: N / C / D
  readonly set: "940";
  readonly dateSec: number; // BGN date/time, civil UTC
  readonly shipDateSec?: number; // G62 requested ship date
  readonly parties: readonly Party[];
  readonly refs: CanonRefs;
  readonly lines: readonly CanonLine[];
  readonly totalQty: number; // W76-01 when present, else the line sum
}

export interface ShipmentItem {
  readonly orderRef: string;
  readonly lineRef: string;
  readonly sku: string;
  readonly origQty: number;
  readonly shipQty: number;
  readonly uom: string;
}

export interface CanonShipment {
  readonly kind: "shipment";
  readonly v: typeof CANON_V;
  readonly ref: string; // the shipment id (W06-02 outbound)
  readonly partner: string;
  readonly account: string; // W06-01: the deposit account
  readonly dateSec: number;
  readonly carrier?: { readonly scac: string; readonly mode: string };
  readonly bol: string; // bill of lading reference, "" when none
  readonly packages: readonly { readonly sscc: string }[];
  readonly items: readonly ShipmentItem[];
  readonly totalUnits: number; // Σ shipQty
  readonly weightG: number; // grams, fixed-point
}

/** the quarantine row: everything waybill refuses, with why.
    The code is the promise; detail is for humans. */
export type RefusalCode =
  | "X12_PARSE"
  | "ENVELOPE"
  | "COUNTS"
  | "ROUTE_MISS"
  | "UNKNOWN_SEG"
  | "MAP_MISS"
  | "REF_CHARS";

export interface Refusal {
  readonly kind: "refusal";
  readonly v: typeof CANON_V;
  readonly code: RefusalCode;
  readonly docName: string; // the file it came from (or "<inline>")
  readonly at: string; // where: segment tag is the contract here
  readonly detail: string;
}

export type CanonMsg = CanonOrder | CanonShipment | Refusal;

/* ============================================================
   the decode door
   ============================================================ */

class DecodeError extends Error {
  constructor(m: string) {
    super(m);
    this.name = "DecodeError";
  }
}

const asStr = (v: unknown, what: string): string => {
  if (typeof v !== "string") {
    throw new DecodeError(`${what}: expected string, got ${JSON.stringify(v)}`);
  }
  return v;
};

const asNat = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new DecodeError(`${what}: expected non-negative integer, got ${JSON.stringify(v)}`);
  }
  return v;
};

const asArr = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new DecodeError(`${what}: expected array`);
  return v;
};

const asObj = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new DecodeError(`${what}: expected object`);
  }
  return v as Record<string, unknown>;
};

function asVersion(v: unknown): void {
  if (v !== CANON_V) {
    throw new DecodeError(
      `row says v=${JSON.stringify(v)}; this reader speaks v=${CANON_V} only`,
    );
  }
}

function asAddress(v: unknown): Address {
  const o = asObj(v, "address");
  const a = {
    line1: asStr(o.line1, "address.line1"),
    city: asStr(o.city, "address.city"),
    region: asStr(o.region, "address.region"),
    postal: asStr(o.postal, "address.postal"),
    country: asStr(o.country, "address.country"),
  };
  return o.line2 === undefined ? a : { ...a, line2: asStr(o.line2, "address.line2") };
}

function asParty(v: unknown): Party {
  const o = asObj(v, "party");
  // structural absence is structural: absent keys stay absent
  const p = { role: asStr(o.role, "party.role") as PartyRole };
  if (o.name !== undefined) (p as { name?: string }).name = asStr(o.name, "party.name");
  if (o.id !== undefined) (p as { id?: string }).id = asStr(o.id, "party.id");
  if (o.idQual !== undefined) (p as { idQual?: string }).idQual = asStr(o.idQual, "party.idQual");
  if (o.address !== undefined) (p as { address?: Address }).address = asAddress(o.address);
  if (o.phone !== undefined) (p as { phone?: string }).phone = asStr(o.phone, "party.phone");
  return p as Party;
}

function asLine(v: unknown): CanonLine {
  const o = asObj(v, "line");
  return {
    lineRef: asStr(o.lineRef, "line.lineRef"),
    sku: asStr(o.sku, "line.sku"),
    gtin: asStr(o.gtin ?? "", "line.gtin"),
    desc: asStr(o.desc ?? "", "line.desc"),
    qty: asNat(o.qty, "line.qty"),
    uom: asStr(o.uom, "line.uom"),
  };
}

function asOrder(o: Record<string, unknown>): CanonOrder {
  const up: CanonOrder = {
    kind: "order",
    v: asNat(o.v, "order.v") as typeof CANON_V,
    ref: asStr(o.ref, "order.ref"),
    partner: asStr(o.partner, "order.partner"),
    purpose: asStr(o.purpose, "order.purpose"),
    set: asStr(o.set, "order.set") as "940",
    dateSec: asNat(o.dateSec, "order.dateSec"),
    parties: asArr(o.parties, "order.parties").map(asParty),
    refs: (() => {
      const r = asObj(o.refs, "order.refs");
      return {
        po: asStr(r.po ?? "", "refs.po"),
        batch: asStr(r.batch ?? "", "refs.batch"),
        finn: asArr(r.finn ?? [], "refs.finn").map((x) => {
          const f = asObj(x, "refs.finn[]");
          return { qual: asStr(f.qual, "finn.qual"), id: asStr(f.id, "finn.id") };
        }),
      };
    })(),
    lines: asArr(o.lines, "order.lines").map(asLine),
    totalQty: asNat(o.totalQty, "order.totalQty"),
  };
  // structural absence is structural: no shipDateSec key when absent
  return o.shipDateSec === undefined
    ? up
    : { ...up, shipDateSec: asNat(o.shipDateSec, "order.shipDateSec") };
}

function asShipment(o: Record<string, unknown>): CanonShipment {
  const up: CanonShipment = {
    kind: "shipment",
    v: asNat(o.v, "shipment.v") as typeof CANON_V,
    ref: asStr(o.ref, "shipment.ref"),
    partner: asStr(o.partner, "shipment.partner"),
    account: asStr(o.account, "shipment.account"),
    dateSec: asNat(o.dateSec, "shipment.dateSec"),
    bol: asStr(o.bol ?? "", "shipment.bol"),
    packages: asArr(o.packages ?? [], "shipment.packages").map((x) => {
      const p = asObj(x, "package");
      return { sscc: asStr(p.sscc, "package.sscc") };
    }),
    items: asArr(o.items, "shipment.items").map((x) => {
      const s = asObj(x, "shipment item");
      return {
        orderRef: asStr(s.orderRef, "item.orderRef"),
        lineRef: asStr(s.lineRef, "item.lineRef"),
        sku: asStr(s.sku, "item.sku"),
        origQty: asNat(s.origQty, "item.origQty"),
        shipQty: asNat(s.shipQty, "item.shipQty"),
        uom: asStr(s.uom, "item.uom"),
      };
    }),
    totalUnits: asNat(o.totalUnits, "shipment.totalUnits"),
    weightG: asNat(o.weightG, "shipment.weightG"),
  };
  // structural absence is structural: no carrier key when absent
  if (o.carrier === undefined) return up;
  const c = asObj(o.carrier, "shipment.carrier");
  return {
    ...up,
    carrier: {
      scac: asStr(c.scac, "carrier.scac"),
      mode: asStr(c.mode, "carrier.mode"),
    },
  };
}

function asRefusal(o: Record<string, unknown>): Refusal {
  return {
    kind: "refusal",
    v: asNat(o.v, "refusal.v") as typeof CANON_V,
    code: asStr(o.code, "refusal.code") as RefusalCode,
    docName: asStr(o.docName, "refusal.docName"),
    at: asStr(o.at, "refusal.at"),
    detail: asStr(o.detail, "refusal.detail"),
  };
}

export function decodeCanon(b: Uint8Array): CanonMsg {
  const text = new TextDecoder().decode(b);
  const v = JSON.parse(text) as Record<string, unknown>;
  asVersion(v.v);
  switch (v.kind) {
    case "order":
      return asOrder(v);
    case "shipment":
      return asShipment(v);
    case "refusal":
      return asRefusal(v);
    default:
      throw new DecodeError(`unknown canonical kind ${JSON.stringify(v.kind)}`);
  }
}

/* ============================================================
   the encode door — fixed key order per record type
   ============================================================ */

function partyCanon(p: Party): Canon {
  const f: (readonly [string, Canon])[] = [["role", p.role]];
  if (p.name !== undefined) f.push(["name", p.name]);
  if (p.id !== undefined) f.push(["id", p.id]);
  if (p.idQual !== undefined) f.push(["idQual", p.idQual]);
  if (p.address !== undefined) {
    const a = p.address;
    const af: (readonly [string, Canon])[] = [
      ["line1", a.line1],
      ["city", a.city],
      ["region", a.region],
      ["postal", a.postal],
      ["country", a.country],
    ];
    if (a.line2 !== undefined) af.splice(1, 0, ["line2", a.line2]);
    f.push(["address", obj(af)]);
  }
  if (p.phone !== undefined) f.push(["phone", p.phone]);
  return obj(f);
}

function lineCanon(l: CanonLine): Canon {
  return obj([
    ["lineRef", l.lineRef],
    ["sku", l.sku],
    ["gtin", l.gtin],
    ["desc", l.desc],
    ["qty", nat(l.qty)],
    ["uom", l.uom],
  ]);
}

export function encodeCanon(msg: CanonMsg): Uint8Array {
  const v = nat(CANON_V);
  if (msg.kind === "order") {
    const m = msg;
    const f: (readonly [string, Canon])[] = [
      ["kind", m.kind],
      ["v", v],
      ["ref", m.ref],
      ["partner", m.partner],
      ["purpose", m.purpose],
      ["set", m.set],
      ["dateSec", nat(m.dateSec)],
    ];
    if (m.shipDateSec !== undefined) f.push(["shipDateSec", nat(m.shipDateSec)]);
    f.push(
      ["parties", m.parties.map(partyCanon)],
      [
        "refs",
        obj([
          ["po", m.refs.po],
          ["batch", m.refs.batch],
          [
            "finn",
            m.refs.finn.map((x) => obj([["qual", x.qual], ["id", x.id]])),
          ],
        ]),
      ],
      ["lines", m.lines.map(lineCanon)],
      ["totalQty", nat(m.totalQty)],
    );
    return bytes(obj(f));
  }
  if (msg.kind === "shipment") {
    const m = msg;
    const f: (readonly [string, Canon])[] = [
      ["kind", m.kind],
      ["v", v],
      ["ref", m.ref],
      ["partner", m.partner],
      ["account", m.account],
      ["dateSec", nat(m.dateSec)],
    ];
    if (m.carrier !== undefined) {
      f.push([
        "carrier",
        obj([["scac", m.carrier.scac], ["mode", m.carrier.mode]]),
      ]);
    }
    f.push(
      ["bol", m.bol],
      ["packages", m.packages.map((p) => obj([["sscc", p.sscc]]))],
      [
        "items",
        m.items.map((i) =>
          obj([
            ["orderRef", i.orderRef],
            ["lineRef", i.lineRef],
            ["sku", i.sku],
            ["origQty", nat(i.origQty)],
            ["shipQty", nat(i.shipQty)],
            ["uom", i.uom],
          ]),
        ),
      ],
      ["totalUnits", nat(m.totalUnits)],
      ["weightG", nat(m.weightG)],
    );
    return bytes(obj(f));
  }
  const m = msg;
  return bytes(
    obj([
      ["kind", m.kind],
      ["v", v],
      ["code", m.code],
      ["docName", m.docName],
      ["at", m.at],
      ["detail", m.detail],
    ]),
  );
}
