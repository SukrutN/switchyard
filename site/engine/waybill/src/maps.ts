/* ============================================================
   maps — the mapping rules are DATA; this file only runs them.

   A partner profile names where each canonical field comes from
   with a path, and the engine here walks the transaction set to
   answer. Same profile bytes in, same canonical out — and a
   second partner is a second profile, never a second engine.

   The path grammar (per-profile data, checked at profile load):
     SEG              the first segment with this tag
     SEG{n=V}         the first segment whose element n equals V
     A{...}.B         B inside A's loop — a loop runs until the
                      trigger's tag appears again
     ...SEG.N         element N (1-based) of the matched segment
   Examples: `W06.2`, `N1{1=ST}.N4.3`, `PER{3=TE}.4`.

   The slot vocabulary is the kernel the engine and the inbound
   assembler agree on ("purpose", "ref", "po", "addr1", "sku",
   "qty", …). The profile only ever points at kernel slots —
   adding a field is a new kernel slot plus data, not code.
   ============================================================ */

import type { TxSet } from "./x12.ts";

/* ---------- the data shapes a profile carries ---------- */

/** from a path to a canonical kernel slot. */
export interface Rule {
  readonly from: string;
  readonly to: string;
  /** no value at `from` → the order is quarantined (MAP_MISS) */
  readonly required?: boolean;
}

/** an item's identity: a qualified pair (qualifier element + value
    element) so the SAME document can hand each partner the id the
    partner's companion guide says is the part number. */
export interface IdRule {
  readonly to: "sku" | "gtin";
  readonly from: string; // value element, e.g. "W01.5"
  /** when set: `qualFrom` element must equal `qual` for `from` to count */
  readonly qual?: string;
  readonly qualFrom?: string;
  readonly required?: boolean;
}

export type PartyRole = "shipFrom" | "shipTo" | "billTo" | "vendor";

export interface PartyMap {
  readonly role: PartyRole;
  /** the loop selector, e.g. "N1{1=ST}" */
  readonly from: string;
  readonly required?: boolean;
  /** kernel slots: name | id | idQual | addr1 | addr2 | city |
      region | postal | country | phone */
  readonly fields: readonly Rule[];
}

export interface InMap {
  /** segments this partner may send; anything else is refused per
      document (the unknown-hero law) */
  readonly knownTags: readonly string[];
  /** the order's own date/time — usually BGN */
  readonly dateRule: { readonly date: string; readonly time?: string };
  /** G62-style requested ship date (civil D8) */
  readonly shipDateFrom: string;
  /** header slots: purpose | ref | batch | po | totalQty */
  readonly header: readonly Rule[];
  readonly parties: readonly PartyMap[];
  /** the line-item loop entry, e.g. "LX" */
  readonly entry: string;
  /** per-line slots: lineRef | qty | uom | desc */
  readonly lineFields: readonly Rule[];
  readonly lineIds: readonly IdRule[];
}

/* ---------- the path engine ---------- */

interface Sel {
  readonly tag: string;
  readonly pos?: number;
  readonly val?: string;
}

interface ParsedPath {
  readonly path: string;
  readonly sels: readonly Sel[];
  readonly elem?: number;
}

const SEL_RE = /^([A-Z][A-Z0-9]{1,2})(?:\{([1-9][0-9]*)=([^}]*)\})?$/;

export function parsePath(path: string): ParsedPath {
  const sels: Sel[] = [];
  let elem: number | undefined;
  for (const t of path.split(".")) {
    if (/^[0-9]+$/.test(t)) {
      if (elem !== undefined) {
        throw new Error(`maps: ${path} carries a second element pick`);
      }
      elem = Number(t);
      continue;
    }
    const m = SEL_RE.exec(t);
    if (m === null) {
      throw new Error(`maps: ${JSON.stringify(t)} in ${path} is not a selector`);
    }
    sels.push({
      tag: m[1],
      pos: m[2] !== undefined ? Number(m[2]) : undefined,
      val: m[3],
    });
  }
  if (sels.length === 0) {
    throw new Error(`maps: ${path} has no segment selector`);
  }
  return { path, sels, elem };
}

/** check every path a profile carries — bad profile data dies at
    load, not on some neighbor's publish. Returns the map back. */
export function checkMap(m: InMap): InMap {
  parsePath(m.dateRule.date);
  if (m.dateRule.time !== undefined) parsePath(m.dateRule.time);
  parsePath(m.shipDateFrom);
  parsePath(m.entry);
  for (const r of [...m.header, ...m.parties.flatMap((p) => p.fields)]) {
    parsePath(r.from);
  }
  for (const id of m.lineIds) {
    parsePath(id.from);
    if (id.qualFrom !== undefined) parsePath(id.qualFrom);
  }
  for (const tag of m.knownTags) {
    if (!/^[A-Z][A-Z0-9]{1,2}$/.test(tag)) {
      throw new Error(`maps: knownTag ${JSON.stringify(tag)} is not a tag`);
    }
  }
  return m;
}

/** walk a parsed path. `window` limits the whole search; the
    per-selector loop law scopes each hop to the previous match's
    span (until the trigger's tag appears again). */
function walk(tx: TxSet, p: ParsedPath, window: { from: number; to: number }): string | undefined {
  const body = tx.body;
  let searchFrom = window.from;
  let searchTo = window.to;
  let hit = -1;
  for (let si = 0; si < p.sels.length; si++) {
    const sel = p.sels[si];
    hit = -1;
    for (let i = searchFrom; i < searchTo; i++) {
      if (matchSel(body[i], sel)) {
        hit = i;
        break;
      }
    }
    if (hit < 0) return undefined;
    if (si + 1 < p.sels.length) {
      // the next selector searches inside this match's loop
      searchFrom = hit + 1;
      searchTo = spanEnd(body, hit, sel.tag);
    }
  }
  if (p.elem === undefined) return undefined;
  const value = body[hit].elems[p.elem - 1];
  return value === undefined || value === "" ? undefined : value;
}

const matchSel = (s: { tag: string; elems: readonly string[] }, sel: Sel): boolean => {
  if (s.tag !== sel.tag) return false;
  if (sel.pos !== undefined) {
    if (s.elems[sel.pos - 1] !== sel.val) return false;
  }
  return true;
};

/** a loop runs until its trigger's tag appears again (house law). */
function spanEnd(body: readonly { tag: string }[], ix: number, tag: string): number {
  for (let j = ix + 1; j < body.length; j++) {
    if (body[j].tag === tag) return j;
  }
  return body.length;
}

/** the first value on a path, whole transaction set. */
export function lookPath(tx: TxSet, path: string): string | undefined {
  return walk(tx, parsePath(path), { from: 0, to: tx.body.length });
}

/** half-open spans of every match of a loop entry selector. */
export function spansOf(tx: TxSet, selector: string): { start: number; end: number }[] {
  const p = parsePath(selector);
  if (p.sels.length !== 1 || p.elem !== undefined) {
    throw new Error(`maps: entry ${selector} must be a single selector`);
  }
  const sel = p.sels[0];
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < tx.body.length; i++) {
    if (matchSel(tx.body[i], sel)) {
      out.push({ start: i, end: spanEnd(tx.body, i, sel.tag) });
    }
  }
  return out;
}

/** the first value on a path, inside one span (per-line rules). */
export function lookIn(
  tx: TxSet,
  span: { start: number; end: number },
  path: string,
): string | undefined {
  return walk(tx, parsePath(path), { from: span.start, to: span.end });
}

/** span of the first match of a loop selector — the parties' scope. */
export function firstSpan(
  tx: TxSet,
  selector: string,
): { start: number; end: number } | undefined {
  const p = parsePath(selector);
  if (p.sels.length !== 1 || p.elem !== undefined) {
    throw new Error(`maps: loop selector ${selector} must be a single selector`);
  }
  for (let i = 0; i < tx.body.length; i++) {
    if (matchSel(tx.body[i], p.sels[0])) {
      return { start: i, end: spanEnd(tx.body, i, p.sels[0].tag) };
    }
  }
  return undefined;
}
