/* ============================================================
   inbound.test — the 940 adapter's characterization.

   Locks the whole canonical translation of the two partner
   fixtures field for field (the mapping IS the artifact: these
   assertions are the profile's contract in executable form),
   plus the refusal zoo — file-level crimes refuse everything,
   order-level crimes refuse one order and spare its siblings.
   ============================================================ */

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import type { CanonOrder } from "../src/canon.ts";
import { dateSecOf } from "../src/canon.ts";
import {
  ALDERLINE_940,
  ALDERLINE_940_SE,
  ALDERLINE_940_WIDTH,
  KELRICK_940,
  UNKNOWN_940,
  encodeText,
} from "../fixtures/documents.ts";
import { receive } from "../src/inbound.ts";

const file = (name: string, doc: string) => ({ name, bytes: encodeText(doc) });

/** the Alderline 940's whole translation — sheet III of the contract. */
const ALDERLINE_ORDER: CanonOrder = {
  kind: "order",
  v: 1,
  ref: "AHL-00175",
  partner: "alderline",
  purpose: "N",
  set: "940",
  dateSec: dateSecOf("20260314", "0800"),
  shipDateSec: dateSecOf("20260316"),
  parties: [
    {
      role: "shipFrom",
      name: "Alderline Provisions",
      id: "AHL002",
      idQual: "91",
      address: { line1: "412 Dock Row", city: "Gustavus", region: "OH", postal: "43085", country: "US" },
      phone: "555-0170",
    },
    {
      role: "shipTo",
      name: "Bramble & Twine DC 2",
      id: "BTDC02",
      idQual: "92",
      address: { line1: "18 Brambling Way", city: "Lodyra", region: "OH", postal: "43046", country: "US" },
    },
    { role: "billTo", name: "Alderline Billing Office", id: "AHLBILL", idQual: "91" },
  ],
  refs: { po: "4500987321", batch: "0001", finn: [] },
  lines: [
    {
      lineRef: "BK4036-24",
      sku: "BK4036-24",
      gtin: "0684000000591",
      desc: "Bramble jute twine, six-pack",
      qty: 6,
      uom: "EA",
    },
    {
      lineRef: "TK2014-99",
      sku: "TK2014-99",
      gtin: "0684000000607",
      desc: "Trowel steel blade, cast handle",
      qty: 2,
      uom: "CA",
    },
  ],
  totalQty: 8,
};

const KELRICK_ORDER: CanonOrder = {
  kind: "order",
  v: 1,
  ref: "KLK-30981",
  partner: "kelrick",
  purpose: "N",
  set: "940",
  dateSec: dateSecOf("20260319", "1030"),
  shipDateSec: dateSecOf("20260323"),
  parties: [
    {
      role: "shipFrom",
      name: "Kelrick Outfitters",
      id: "KLK001",
      idQual: "91",
      address: { line1: "77 Alder Way", city: "Kelso", region: "WA", postal: "98626", country: "US" },
    },
    {
      role: "shipTo",
      name: "Bramble & Twine DC 2",
      id: "BTDC02",
      idQual: "92",
      address: { line1: "18 Brambling Way", city: "Lodyra", region: "OH", postal: "43046", country: "US" },
    },
    { role: "billTo", name: "Kelrick Accounts Office", id: "KLKBILL", idQual: "91" },
  ],
  refs: { po: "PO-77120", batch: "KLK-DEPOT", finn: [{ qual: "PO", id: "4500990217" }] },
  lines: [
    { lineRef: "1", sku: "FE-44102", gtin: "0684000000614", desc: "Fenwick fly rod blank, 9ft", qty: 10, uom: "EA" },
    { lineRef: "2", sku: "LM-71206", gtin: "0684000000621", desc: "Lamp module carbide tip", qty: 4, uom: "EA" },
  ],
  totalQty: 14,
};

const crime = (doc: string): { code: string; docName: string; at: string; detail: string } => {
  const r = receive(file("probe", doc));
  if (r.refusals.length !== 1) throw new Error(`expected one refusal, got ${JSON.stringify(r)}`);
  return r.refusals[0] as unknown as { code: string; docName: string; at: string; detail: string };
};

describe("inbound — the 940 door", () => {
  it("the Alderline 940 maps to exactly this canonical order", () => {
    const out = receive(file("AHL-940-0001", ALDERLINE_940));
    strictEqual(out.refusals.length, 0);
    deepStrictEqual(out.orders, [ALDERLINE_ORDER]);
  });

  it("the Kelrick 940 maps to exactly this canonical order — names on lines are LX loop numbers, per their map", () => {
    const out = receive(file("KLK-940-0001", KELRICK_940));
    strictEqual(out.refusals.length, 0);
    deepStrictEqual(out.orders, [KELRICK_ORDER]);
  });

  it("an ISA width crime refuses the whole file at the metal", () => {
    const r = crime(ALDERLINE_940_WIDTH);
    strictEqual(r.code, "ENVELOPE");
    strictEqual(r.docName, "probe");
    strictEqual(r.at, "ISA06");
  });

  it("a lying SE01 refuses the whole file with COUNTS", () => {
    const r = crime(ALDERLINE_940_SE);
    strictEqual(r.code, "COUNTS");
    strictEqual(r.at, "SE");
  });

  it("an unknown partner refuses at the routing table with ROUTE_MISS", () => {
    const r = crime(UNKNOWN_940);
    strictEqual(r.code, "ROUTE_MISS");
    strictEqual(r.at, "ISA06");
    strictEqual(r.detail.includes("UNKNOWNCO"), true);
  });

  it("a segment outside the partner's set refuses the order (UNKNOWN_SEG)", () => {
    const doc = ALDERLINE_940.replace(
      "G62*10*20260316~",
      "MSG*please ignore~",
    );
    const r = crime(doc);
    strictEqual(r.code, "UNKNOWN_SEG");
    strictEqual(r.at, "MSG in 0001");
  });

  it("a missing required slot refuses the order with MAP_MISS", () => {
    const doc = ALDERLINE_940.replace("W06*AHL-DEPOT-1*AHL-00175~", "").replace("SE*24", "SE*23");
    const r = crime(doc);
    strictEqual(r.code, "MAP_MISS");
    strictEqual(r.at, "W06.2");
    strictEqual(r.detail.includes("ref"), true);
  });

  it("a ref that cannot ride the charter refuses with REF_CHARS", () => {
    const doc = ALDERLINE_940.replace(
      "W06*AHL-DEPOT-1*AHL-00175~",
      "W06*AHL-DEPOT-1*AHL 00175~",
    );
    const r = crime(doc);
    strictEqual(r.code, "REF_CHARS");
    strictEqual(r.at, "ref");
  });

  it("an empty id pair on a line refuses with MAP_MISS", () => {
    const doc = ALDERLINE_940.replace(
      "W01*6*EA*0684000000591*VN*BK4036-24*IN*BK-01386~",
      "W01*6*EA*0684000000591*VN**IN*BK-01386~",
    );
    const r = crime(doc);
    strictEqual(r.code, "MAP_MISS");
    strictEqual(r.at, "W01.5");
    strictEqual(r.detail.includes("VN"), true);
  });

  it("a junk quantity refuses with MAP_MISS", () => {
    const doc = ALDERLINE_940.replace(
      "W01*6*EA*0684000000591*VN*BK4036-24*IN*BK-01386~",
      "W01*lots*EA*0684000000591*VN*BK4036-24*IN*BK-01386~",
    );
    const r = crime(doc);
    strictEqual(r.code, "MAP_MISS");
    strictEqual(r.detail.includes("not a count"), true);
  });

  it("a sick sibling refuses alone; the healthy one still ships", () => {
    // two transaction sets, one group: the second carries no BGN
    const doc = [
      "ISA*00*          *00*          *ZZ*AHL-PROVIS     *ZZ*BRAMBLE WMS    *260314*0800*U*00401*000000103*0*P*:~",
      "GS*OW*AHL-PROVIS*BRAMBLE-3PL*20260314*0800*7*X*004010~",
      "ST*940*0001~",
      "BGN*00*20260314*0800*AHL-00175~",
      "N1*SF*Alderline Provisions*91*AHL002~",
      "N1*ST*Bramble & Twine DC 2*92*BTDC02~",
      "W05*N*0001~",
      "W06*AHL-DEPOT-1*AHL-00175~",
      "LX*1~",
      "W01*6*EA*0684000000591*VN*BK4036-24*IN*BK-01386~",
      "W76*6~",
      "SE*10*0001~",
      "ST*940*0002~",
      "N1*SF*Alderline Provisions*91*AHL002~",
      "N1*ST*Bramble & Twine DC 2*92*BTDC02~",
      "W05*N*0001~",
      "W06*AHL-DEPOT-1*AHL-00176~",
      "LX*1~",
      "W01*4*EA*0684000000591*VN*BK4036-24*IN*BK-01386~",
      "W76*4~",
      "SE*9*0002~", // counts true, but the order date never arrives
      "GE*2*7~",
      "IEA*1*000000103~",
    ].join("");
    const out = receive(file("pair-940", doc));
    deepStrictEqual(
      { orders: out.orders.length, refusals: out.refusals.map((x) => [x.code, x.at]) },
      { orders: 1, refusals: [["MAP_MISS", "BGN.2"]] },
    );
    strictEqual(out.orders[0].ref, "AHL-00175");
  });

  it("the refusals carry the document's name into the quarantine", () => {
    const out = receive(file("AHL-940-0001", ALDERLINE_940_WIDTH));
    strictEqual(out.refusals[0].docName, "AHL-940-0001");
  });

  it("receive never throws — even on garbage bytes", () => {
    const out = receive({ name: "junk", bytes: encodeText("\u0000 truncated") });
    strictEqual(out.orders.length, 0);
    strictEqual(out.refusals.length > 0, true);
  });

  it("receive parses only what it speaks", () => {
    // a doc whose dates overflow the calendar's shape dies as mapping, not panic
    const doc = ALDERLINE_940.replace("BGN*00*20260314*0800*", "BGN*00*20261314*0800*");
    const r = crime(doc);
    strictEqual(r.code, "MAP_MISS");
    strictEqual(r.at, "BGN.2");
  });
});

describe("inbound — lint on the carriers themselves", () => {
  it("documents carry no control bytes — a newline would die at parse", () => {
    for (const doc of [ALDERLINE_940, KELRICK_940, UNKNOWN_940]) {
      strictEqual(/[\n\r\u0000]/.test(doc), false);
    }
  });

  it("the joined documents still end in their terminator", () => {
    for (const doc of [ALDERLINE_940, KELRICK_940, UNKNOWN_940]) {
      strictEqual(doc.endsWith("~"), true);
    }
  });
});
