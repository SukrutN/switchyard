/* ============================================================
   inbound — a 940 walks in; canonical orders walk out.

   One door: `receive` routes by trading-partner id (ISA06),
   parses the metal, maps by profile data, and refuses with
   reason codes. The granularity law:

   · File-level crimes — the metal (X12Parse), the envelope,
     the routing table — refuse the whole file: one refusal row,
     nothing ships.
   · Order-level crimes — a required slot empty, an id that
     never matched, a ref that cannot ride the charter — refuse
     that order (MAP_MISS / REF_CHARS) and keep its healthy
     siblings from the same file.

   The adapter is pure: bytes in, orders + refusals out. Landing
   the results on lanes is the caller's (the dockhand's) job —
   see integration/run.ts and the journal test.
   ============================================================ */

import {
  CANON_V,
  dateSecOf,
  type Address,
  type CanonLine,
  type CanonOrder,
  type Party,
  type PartyRole,
  type Refusal,
  type RefusalCode,
} from "./canon.ts";
import { type InMap, firstSpan, lookIn, lookPath, parsePath, spansOf } from "./maps.ts";
import type { Profile } from "./partners.ts";
import { routeOfSender } from "./partners.ts";
import { X12Error, type Envelope, type TxSet, parseX12 } from "./x12.ts";

export interface InboundFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface InboundOutcome {
  readonly orders: CanonOrder[];
  readonly refusals: Refusal[];
}

function refusal(code: RefusalCode, docName: string, at: string, detail: string): Refusal {
  return { kind: "refusal", v: CANON_V, code, docName, at, detail };
}

function dieOrder(profile: Profile, docName: string, at: string, detail: string): Refusal {
  return { kind: "refusal", v: CANON_V, code: "MAP_MISS", docName, at, detail };
}

/** door one: route the file by its interchange sender. */
export function receive(file: InboundFile): InboundOutcome {
  let env: Envelope;
  try {
    env = parseX12(file.bytes);
  } catch (e) {
    if (e instanceof X12Error) {
      return { orders: [], refusals: [refusal(e.code, file.name, e.at, e.detail)] };
    }
    return { orders: [], refusals: [refusal("X12_PARSE", file.name, "<door>", String(e))] };
  }
  const sender = env.isa[5].trim(); // ISA06, unpadded
  const profile = routeOfSender(sender);
  if (profile === undefined) {
    return {
      orders: [],
      refusals: [
        refusal(
          "ROUTE_MISS",
          file.name,
          "ISA06",
          `trading partner ${JSON.stringify(sender)} is not in the routing table`,
        ),
      ],
    };
  }
  return receiveSet(file, env, profile);
}

/** door two: map a routed document set. */
export function receiveSet(file: InboundFile, env: Envelope, profile: Profile): InboundOutcome {
  const out = { orders: [] as CanonOrder[], refusals: [] as Refusal[] };
  const inmap = profile.in?.["940"];
  if (inmap === undefined) {
    out.refusals.push(
      refusal("ROUTE_MISS", file.name, "ST01", `${profile.key} receives no 940`),
    );
    return out;
  }
  for (const g of env.groups) {
    for (const tx of g.txs) {
      const set = tx.st[0] ?? "";
      if (set !== "940") {
        out.refusals.push(
          refusal(
            "ROUTE_MISS",
            file.name,
            "ST01",
            `${JSON.stringify(set)} is not in ${profile.key}'s doc set [${profile.docSet.join(", ")}]`,
          ),
        );
        continue;
      }
      const r = mapOrder(tx, inmap, profile, file.name);
      if (r.kind === "order") out.orders.push(r);
      else out.refusals.push(r);
    }
  }
  return out;
}

function mapOrder(
  tx: TxSet,
  inmap: InMap,
  profile: Profile,
  docName: string,
): CanonOrder | Refusal {
  const st02 = tx.st[1] ?? "?";
  // the unknown-hero law: segments outside the partner's set refuse
  for (const s of tx.body) {
    if (!inmap.knownTags.includes(s.tag)) {
      return {
        kind: "refusal",
        v: CANON_V,
        code: "UNKNOWN_SEG",
        docName,
        at: `${s.tag} in ${st02}`,
        detail: `segment not in ${profile.key}'s doc set for 940`,
      };
    }
  }

  /* ---------- header slots ---------- */
  const bag = new Map<string, string>();
  for (const r of inmap.header) {
    const v = lookPath(tx, r.from);
    if (v === undefined) {
      if (r.required) {
        return dieOrder(profile, docName, r.from, `${r.to} is required and absent`);
      }
      continue;
    }
    bag.set(r.to, v);
  }
  const ref = bag.get("ref");
  if (ref === undefined) {
    return dieOrder(profile, docName, "ref", "no warehouse order number on the document");
  }
  for (const c of ref) {
    const code = c.charCodeAt(0);
    if (code < 0x21 || code > 0x7e || c === ".") {
      return {
        kind: "refusal",
        v: CANON_V,
        code: "REF_CHARS",
        docName,
        at: "ref",
        detail: `ref ${JSON.stringify(ref)} cannot ride a subject (charter Â§3)`,
      };
    }
  }

  /* ---------- the date(s) ---------- */
  let dateSec: number;
  const dRaw = lookPath(tx, inmap.dateRule.date);
  if (dRaw === undefined) {
    return dieOrder(profile, docName, inmap.dateRule.date, "the order date is required and absent");
  }
  try {
    const tRaw =
      inmap.dateRule.time === undefined ? undefined : lookPath(tx, inmap.dateRule.time);
    dateSec = dateSecOf(dRaw, tRaw);
  } catch (e) {
    return dieOrder(profile, docName, inmap.dateRule.date, String(e instanceof Error ? e.message : e));
  }
  let shipDateSec: number | undefined;
  const sdRaw = lookPath(tx, inmap.shipDateFrom);
  if (sdRaw !== undefined) {
    try {
      shipDateSec = dateSecOf(sdRaw);
    } catch (e) {
      return dieOrder(profile, docName, inmap.shipDateFrom, String(e instanceof Error ? e.message : e));
    }
  }

  /* ---------- parties ---------- */
  const parties: Party[] = [];
  for (const pm of inmap.parties) {
    const span = firstSpan(tx, pm.from);
    if (span === undefined) {
      if (pm.required) {
        return dieOrder(profile, docName, pm.from, `${pm.role} party is required and absent`);
      }
      continue;
    }
    const pf = new Map<string, string>();
    for (const fr of pm.fields) {
      const v = lookIn(tx, span, fr.from);
      if (v !== undefined) pf.set(fr.to, v);
    }
    const hasAddress =
      pf.has("addr1") || pf.has("city") || pf.has("region") || pf.has("postal");
    // structural absence is structural: absent slots leave no key
    const party = { role: pm.role as PartyRole };
    if (pf.has("name")) (party as { name?: string }).name = pf.get("name");
    if (pf.has("id")) (party as { id?: string }).id = pf.get("id");
    if (pf.has("idQual")) (party as { idQual?: string }).idQual = pf.get("idQual");
    if (hasAddress) {
      (party as { address?: Address }).address = {
        line1: pf.get("addr1") ?? "",
        city: pf.get("city") ?? "",
        region: pf.get("region") ?? "",
        postal: pf.get("postal") ?? "",
        country: pf.get("country") ?? "",
        ...(pf.has("addr2") ? { line2: pf.get("addr2") } : {}),
      };
    }
    if (pf.has("phone")) (party as { phone?: string }).phone = pf.get("phone");
    parties.push(party as Party);
  }

  /* ---------- lines ---------- */
  const spans = spansOf(tx, inmap.entry);
  const lines: CanonLine[] = [];
  for (let li = 0; li < spans.length; li++) {
    const span = spans[li];
    const lf = new Map<string, string>();
    for (const fr of inmap.lineFields) {
      const v = lookIn(tx, span, fr.from);
      if (v === undefined) {
        if (fr.required) {
          return dieOrder(profile, docName, fr.from, `${fr.to} is required and absent on line ${li + 1}`);
        }
        continue;
      }
      lf.set(fr.to, v);
    }
    for (const id of inmap.lineIds) {
      const qual = id.qualFrom === undefined ? undefined : lookIn(tx, span, id.qualFrom);
      let v = lookIn(tx, span, id.from);
      if (qual !== undefined && qual !== id.qual) v = undefined; // this pair is not ours
      else if (qual !== undefined && qual === id.qual && v === undefined && id.required) {
        return dieOrder(profile, docName, id.from, `the ${id.qual} id pair is empty on line ${li + 1}`);
      }
      if (v !== undefined && !lf.has(id.to)) lf.set(id.to, v);
    }
    if (!lf.has("sku") && inmap.lineIds.some((id) => id.to === "sku" && id.required)) {
      return dieOrder(
        profile,
        docName,
        inmap.lineIds.find((id) => id.to === "sku")!.from,
        `no sku on line ${li + 1} (the id pair never matched)`,
      );
    }
    const qtyRaw = lf.get("qty");
    if (qtyRaw === undefined) {
      return dieOrder(profile, docName, "qty", `line ${li + 1} carries no quantity`);
    }
    const qty = Number(qtyRaw);
    if (!Number.isInteger(qty) || qty < 0) {
      return dieOrder(
        profile,
        docName,
        "qty",
        `line ${li + 1} quantity ${JSON.stringify(qtyRaw)} is not a count`,
      );
    }
    lines.push({
      lineRef: lf.get("lineRef") ?? String(li + 1),
      sku: lf.get("sku") ?? "",
      gtin: lf.get("gtin") ?? "",
      desc: lf.get("desc") ?? "",
      qty,
      uom: lf.get("uom") ?? "",
    });
  }

  /* ---------- total quantity ---------- */
  let totalQty = lines.reduce((a, l) => a + l.qty, 0);
  const tqRaw = bag.get("totalQty");
  if (tqRaw !== undefined) {
    const tq = Number(tqRaw);
    if (!Number.isInteger(tq) || tq < 0) {
      return dieOrder(profile, docName, "totalQty", `${JSON.stringify(tqRaw)} is not a count`);
    }
    totalQty = tq;
  }

  /* ---------- references pass through: header N9s not mapped
     above land in finn, qualifier and id, never lost. ---------- */
  const finn: { qual: string; id: string }[] = [];
  const poRule = inmap.header.find((r) => r.to === "po");
  let poSel: { tag: string; pos?: number; val?: string } | undefined;
  if (poRule !== undefined) {
    const p = parsePath(poRule.from);
    poSel = p.sels[0];
  }
  const entryMatch = spansOf(tx, inmap.entry);
  const loopStart = entryMatch.length > 0 ? entryMatch[0].start : tx.body.length;
  for (let i = 0; i < loopStart && i < tx.body.length; i++) {
    const s = tx.body[i];
    if (s.tag !== "N9") continue;
    if (poSel !== undefined && poSel.tag === "N9" && poSel.val !== undefined && s.elems[0] === poSel.val) {
      continue; // this is the mapped reference, already on refs.po
    }
    finn.push({ qual: s.elems[0] ?? "", id: s.elems[1] ?? "" });
  }

  return {
    kind: "order",
    v: CANON_V,
    ref,
    partner: profile.key,
    purpose: bag.get("purpose") ?? "",
    set: "940",
    dateSec,
    ...(shipDateSec !== undefined ? { shipDateSec } : {}),
    parties,
    refs: {
      po: bag.get("po") ?? "",
      batch: bag.get("batch") ?? "",
      finn,
    },
    lines,
    totalQty,
  };
}
