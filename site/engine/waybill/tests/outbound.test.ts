/* ============================================================
   outbound.test — the paperwork's characterization.

   Locks the Alderline 945 and 856 as literal goldens (segment
   by segment, byte for byte, including the pads and the SE
   counts), the re-parse closure (what we mint, the parser
   agrees with), and the progression law of the control numbers
   across two mints.
   ============================================================ */

import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import { ALDERLINE_SHIPMENT } from "../fixtures/documents.ts";
import type { CanonOrder } from "../src/canon.ts";
import { dateSecOf } from "../src/canon.ts";
import type { ControlData } from "../src/cntrl.ts";
import { produceAdvice, produceNotice } from "../src/outbound.ts";
import { ALDERLINE, type Profile } from "../src/partners.ts";
import { encodeX12, parseX12 } from "../src/x12.ts";

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
    { lineRef: "BK4036-24", sku: "BK4036-24", gtin: "0684000000591", desc: "Bramble jute twine, six-pack", qty: 6, uom: "EA" },
    { lineRef: "TK2014-99", sku: "TK2014-99", gtin: "0684000000607", desc: "Trowel steel blade, cast handle", qty: 2, uom: "CA" },
  ],
  totalQty: 8,
};

const FIRST: ControlData = { isa: 1, group: 1, txn: 1 };
const SECOND: ControlData = { isa: 2, group: 2, txn: 2 };

/* the 945 golden, fresh state — the companion-guide subset, locked */
const GOLDEN_945 = [
  "ISA*00*          *00*          *ZZ*BRAMBLE WMS    *ZZ*AHL-PROVIS     *260316*1430*U*00401*000000001*0*P*:~",
  "GS*PW*BRAMBLE-3PL*AHL-PROVIS*20260316*1430*1*X*004010~",
  "ST*945*0001~",
  "BGN*00*20260316*1430*SHP-20444~",
  "W06*AHL-DEPOT-1*SHP-20444~",
  "N1*ST*Bramble & Twine DC 2*92*BTDC02~",
  "N3*18 Brambling Way~",
  "N4*Lodyra*OH*43046*US~",
  "G62*11*20260316~",
  "MAN*GM*000012345678901234~",
  "N9*BM*BOL-88213~",
  "LX*1~",
  "W12*6*6*EA*VN*BK4036-24~",
  "LX*2~",
  "W12*2*2*CA*VN*TK2014-99~",
  "W03*8*KG*24000~",
  "SE*15*0001~",
  "GE*1*1~",
  "IEA*1*000000001~",
].join("");

/* the 856 golden, second state — the ship notice answers */
const GOLDEN_856 = [
  "ISA*00*          *00*          *ZZ*BRAMBLE WMS    *ZZ*AHL-PROVIS     *260316*1430*U*00401*000000002*0*P*:~",
  "GS*SH*BRAMBLE-3PL*AHL-PROVIS*20260316*1430*2*X*004010~",
  "ST*856*0002~",
  "BSN*00*SHP-20444*20260316*1430~",
  "DTM*011*20260316~",
  "HL*1**S*1~",
  "REF*BM*BOL-88213~",
  "HL*2*1*O*1~",
  "PRF*4500987321~",
  "HL*3*2*I*0~",
  "LIN**VN*BK4036-24~",
  "SN1*6*EA~",
  "HL*4*2*I*0~",
  "LIN**VN*TK2014-99~",
  "SN1*2*CA~",
  "SE*14*0002~",
  "GE*1*2~",
  "IEA*1*000000002~",
].join("");

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

describe("outbound — the 945 (warehouse shipping advice)", () => {
  const doc = produceAdvice(ALDERLINE_SHIPMENT, [ALDERLINE_ORDER], ALDERLINE, FIRST);

  it("mints the golden byte for byte", () => {
    deepStrictEqual(text(doc.bytes), GOLDEN_945);
  });

  it("what we mint, the parser agrees with (closure)", () => {
    const env = parseX12(doc.bytes);
    deepStrictEqual(text(encodeX12(env)), GOLDEN_945);
    strictEqual(env.groups[0].txs[0].se[0], "15");
    strictEqual(env.groups[0].ge[0], "1");
  });

  it("the envelope carries OURS asks the partner's ids", () => {
    strictEqual(doc.envelope.isa[5].trim(), "BRAMBLE WMS");
    strictEqual(doc.envelope.isa[7].trim(), "AHL-PROVIS");
    strictEqual(doc.envelope.groups[0].gs[0], "PW");
  });
});

describe("outbound — the 856 (ship notice)", () => {
  const doc = produceNotice(ALDERLINE_SHIPMENT, [ALDERLINE_ORDER], ALDERLINE, SECOND);

  it("mints the golden byte for byte", () => {
    deepStrictEqual(text(doc.bytes), GOLDEN_856);
  });

  it("what we mint, the parser agrees with (closure)", () => {
    const env = parseX12(doc.bytes);
    deepStrictEqual(text(encodeX12(env)), GOLDEN_856);
    strictEqual(env.groups[0].txs[0].se[0], "14");
  });

  it("the second reservation advanced every counter", () => {
    strictEqual(doc.envelope.isa[12], "000000002");
    strictEqual(doc.envelope.groups[0].gs[5], "2");
    strictEqual(doc.envelope.groups[0].txs[0].st[1], "0002");
  });

  it("the HL hierarchy is S/O/I with PRF riding the order's PO", () => {
    const t = text(doc.bytes);
    strictEqual(t.includes("HL*1**S*1~"), true);
    strictEqual(t.includes("HL*2*1*O*1~PRF*4500987321~"), true);
    strictEqual(t.includes("HL*3*2*I*0~"), true);
  });
});

describe("outbound — the edges refuse loudly", () => {
  it("a profile with no out map ships nothing", () => {
    const bare = { ...ALDERLINE, out: undefined } as Profile;
    throws(
      () => produceAdvice(ALDERLINE_SHIPMENT, [ALDERLINE_ORDER], bare, FIRST),
      /ships nothing/,
    );
  });

  it("an empty shipment ships nothing", () => {
    throws(
      () =>
        produceAdvice(
          { ...ALDERLINE_SHIPMENT, items: [] },
          [ALDERLINE_ORDER],
          ALDERLINE,
          FIRST,
        ),
      /no items/,
    );
  });

  it("an item citing an unknown order refuses at mint", () => {
    throws(
      () =>
        produceAdvice(
          { ...ALDERLINE_SHIPMENT, items: [{ ...ALDERLINE_SHIPMENT.items[0], orderRef: "GHOST-1" }] },
          [ALDERLINE_ORDER],
          ALDERLINE,
          FIRST,
        ),
      /no canonical order carries/,
    );
  });

  it("an unweighed shipment leaves the weight element out, not empty", () => {
    const doc = produceAdvice(
      { ...ALDERLINE_SHIPMENT, weightG: 0 },
      [ALDERLINE_ORDER],
      ALDERLINE,
      FIRST,
    );
    const t = text(doc.bytes);
    strictEqual(t.includes("W03*8~"), true);
    strictEqual(t.includes("KG"), false);
  });
});
