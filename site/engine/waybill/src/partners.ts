/* ============================================================
   partners — the profiles. THIS IS THE ARTIFACT.

   No partner logic lives in code: a partner is a record. Same
   shapes across profiles — swap the data, swap the partner. A
   third Alderline costs nothing; a third branch would cost a
   code review. The maps below are checked at load (checkMap —
   bad path data dies at import, not on some publish), and the
   JSON round-trip test holds the law down: these structs are
   ONLY data, no closures, no classes.

   ← the docs this leans on (public references, cited in the
     README): the Babelway 940 walkthrough (W05/W01/LX/G69/W76
     in 4010 shape), PartnerLinQ's 945 explainer (W06/G62/MAN/
     W12/W03), and the standard X12 id-qualifier habit (N103+
     N104 pairs, product/service id pairs on W01). The standard
     itself is paid ANSI; waybill validates envelope metal and
     counts, and the segment semantics are the companion-guide
     subset the fixtures lock.
   ============================================================ */

import type { DespatchClass } from "./lane.ts";
import { checkMap, type IdRule, type InMap } from "./maps.ts";

/** the kernel slots a party map points at (maps.ts explains). */
const PARTY_FIELDS = [
  { to: "name", from: "N1.2" },
  { to: "idQual", from: "N1.3" },
  { to: "id", from: "N1.4" },
  { to: "addr1", from: "N3.1" },
  { to: "addr2", from: "N3.2" },
  { to: "city", from: "N4.1" },
  { to: "region", from: "N4.2" },
  { to: "postal", from: "N4.3" },
  { to: "country", from: "N4.4" },
  { to: "phone", from: "PER{3=TE}.4" },
];

/** one per-known-tag allowlist — the partner's segment set. */
const TAGS_940 = [
  "BGN", "N1", "N3", "N4", "PER", "REF", "W05", "W06", "N9",
  "G62", "LX", "L11", "W01", "G69", "W76",
];

/* ============================================================
   Alderline Provisions — provisions distributor; VN part
   numbers, PO on N9, release number on W05-2. Class spelling:
   their orders ship standard, next-day-by-clock.
   ============================================================ */

const SKU_BY_VN: IdRule = {
  to: "sku",
  from: "W01.5",
  qualFrom: "W01.4",
  qual: "VN",
  required: true,
};

const ALDERLINE_940: InMap = checkMap({
  knownTags: TAGS_940,
  dateRule: { date: "BGN.2", time: "BGN.3" },
  shipDateFrom: "G62{1=10}.2",
  header: [
    { from: "W05.1", to: "purpose", required: true },
    { from: "W06.2", to: "ref", required: true },
    { from: "W05.2", to: "batch" },
    { from: "N9{1=PO}.2", to: "po" },
    { from: "W76.1", to: "totalQty" },
  ],
  parties: [
    { role: "shipFrom", from: "N1{1=SF}", required: true, fields: PARTY_FIELDS },
    { role: "shipTo", from: "N1{1=ST}", required: true, fields: PARTY_FIELDS },
    { role: "billTo", from: "N1{1=BT}", required: false, fields: PARTY_FIELDS },
  ],
  entry: "LX",
  lineFields: [
    { from: "L11.1", to: "lineRef" },
    { from: "W01.1", to: "qty", required: true },
    { from: "W01.2", to: "uom", required: true },
    { from: "G69.1", to: "desc" },
  ],
  lineIds: [
    SKU_BY_VN,
    { to: "gtin", from: "W01.3" }, // the retail UPC slot, unqualified
  ],
});

/* ============================================================
   Kelrick Outfitters — outfitter; THEY call the release number
   on W05-2 their PO, and read the buyer item number (IN pair)
   as the part. Their orders ride expedite in despatch terms.
   ============================================================ */

const KELRICK_940: InMap = checkMap({
  knownTags: TAGS_940,
  dateRule: { date: "BGN.2", time: "BGN.3" },
  shipDateFrom: "G62{1=10}.2",
  header: [
    { from: "W05.1", to: "purpose", required: true },
    { from: "W06.2", to: "ref", required: true },
    { from: "W05.2", to: "po", required: true },
    { from: "W06.1", to: "batch", required: true },
  ],
  parties: [
    { role: "shipFrom", from: "N1{1=SF}", required: false, fields: PARTY_FIELDS },
    { role: "shipTo", from: "N1{1=ST}", required: true, fields: PARTY_FIELDS },
    { role: "billTo", from: "N1{1=BT}", required: true, fields: PARTY_FIELDS },
  ],
  entry: "LX",
  lineFields: [
    { from: "LX.1", to: "lineRef" },
    { from: "W01.1", to: "qty", required: true },
    { from: "W01.2", to: "uom", required: true },
    { from: "G69.1", to: "desc" },
  ],
  lineIds: [
    {
      to: "sku",
      from: "W01.7", // the second id pair: W01-06 qualifier, W01-07 value
      qualFrom: "W01.6",
      qual: "IN",
      required: true,
    },
    { to: "gtin", from: "W01.3" },
  ],
});

export interface OutMap {
  /** GS01 functional codes, per doc — the partner's guide says */
  readonly gsfn: { readonly "945": string; readonly "856": string };
  /** the 945 ship-to N1 qualifier */
  readonly n1ShipTo: string;
  /** the W12-04 id qualifier on outbound lines */
  readonly lineIdQual: string;
}

export interface Profile {
  readonly key: string;
  readonly tradeName: string;
  /** how the partner appears on the interchange they send */
  readonly isa: { readonly qual: string; readonly id: string };
  /** the docs this profile trades — receiving anything else stops cold */
  readonly docSet: readonly ("940" | "945" | "856")[];
  readonly in?: { readonly "940"?: InMap };
  readonly out?: OutMap;
  /** lane targets — routes as data */
  readonly targets: {
    readonly ordersLane: string;
    readonly refusalLane: string;
    readonly paceLane: string;
  };
  readonly ack: "none";
  /** the despatch orders-lane target's speaking voice */
  readonly despatch: {
    readonly cls: DespatchClass;
    readonly slaSec: number;
  };
}

export const ALDERLINE: Profile = {
  key: "alderline",
  tradeName: "Alderline Provisions",
  isa: { qual: "ZZ", id: "AHL-PROVIS" },
  docSet: ["940", "945", "856"],
  in: { "940": ALDERLINE_940 },
  out: { gsfn: { "945": "PW", "856": "SH" }, n1ShipTo: "ST", lineIdQual: "VN" },
  targets: { ordersLane: "orders", refusalLane: "waybill-dead", paceLane: "waybill-pace" },
  ack: "none",
  despatch: { cls: "standard", slaSec: 86_400 },
};

export const KELRICK: Profile = {
  key: "kelrick",
  tradeName: "Kelrick Outfitters",
  isa: { qual: "ZZ", id: "KELRICK-OF" },
  docSet: ["940", "945"],
  in: { "940": KELRICK_940 },
  out: { gsfn: { "945": "PW", "856": "SH" }, n1ShipTo: "ST", lineIdQual: "IN" },
  targets: { ordersLane: "orders", refusalLane: "waybill-dead", paceLane: "waybill-pace" },
  ack: "none",
  despatch: { cls: "expedite", slaSec: 21_600 },
};

/** the warehouser's own voice on the interchange. */
export const OURS = {
  isaQual: "ZZ",
  isaId: "BRAMBLE WMS",
  gsApp: "BRAMBLE-3PL",
  whName: "Bramble & Twine DC 7",
} as const;

export const PROFILES: readonly Profile[] = [ALDERLINE, KELRICK];

/** routing: trading-partner id (ISA06, trimmed) → profile. One
    place, one law; an unknown partner refuses with ROUTE_MISS. */
export function routeOfSender(isaSender: string): Profile | undefined {
  const id = isaSender.trim();
  return PROFILES.find((p) => p.isa.id === id);
}

export function profileOf(key: string): Profile | undefined {
  return PROFILES.find((p) => p.key === key);
}

/* ---------- load-time sanity: ids unique, maps coherent ---------- */

const seenIds = new Map<string, string>();
for (const p of PROFILES) {
  if (seenIds.has(p.isa.id)) {
    throw new Error(`partners: ${seenIds.get(p.isa.id)} and ${p.key} share id ${p.isa.id}`);
  }
  seenIds.set(p.isa.id, p.key);
  if (p.docSet.includes("940") && p.in?.["940"] === undefined) {
    throw new Error(`partners: ${p.key} trades 940 with no map`);
  }
  if (p.out !== undefined && p.docSet.every((d) => d !== "945" && d !== "856")) {
    throw new Error(`partners: ${p.key} ships out to a partner that takes nothing`);
  }
}
