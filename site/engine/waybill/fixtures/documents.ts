/* ============================================================
   documents — the fixed carriers for every characterization.

   Hand-built 4010-shape documents for two fictional trading
   partners (Alderline Provisions and Kelrick Outfitters), in
   the flavor public references show for real 940s (ISA/GS/ST,
   N1 party loops, W05/W06, N9 refs, G62 dates, the LX line
   loop with W01 item detail + G69 description, W76 totals —
   Babelway's walkthrough is the README's citation). The SE
   counts are hand-counted; the round-trip test audits them
   against the parser's own arithmetic.

   The ONE 940 that both profiles read: Alderline's file
   carries BOTH id pairs on W01 (VN = the vendor part, IN =
   the buyer item), so mapping the same bytes through the two
   profiles yields two distinct canonical orders — the "mapping
   is data" proof, locked in tests/partner.test.ts.

   Malformed carriers: one with an ISA width violation
   (ENVELOPE), one with a lying SE01 (COUNTS), one from an
   unknown partner (ROUTE_MISS). Documents carry no newlines:
   X12 data has no room for control bytes, and the writer
   would refuse them.
   ============================================================ */

import { CANON_V, dateSecOf, type CanonShipment } from "../src/canon.ts";

/** UTF-8-in-ASCII bytes for the documents (the writer's own law). */
export function encodeText(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

/* ---------- Alderline Provisions — 940, two lines, both id pairs ----------
   SE01 = 24: ST, BGN, SF(N1,N3,N4,PER), ST(N1,N3,N4), BT, W05, W06, N9,
   G62, 2 × (LX,L11,W01,G69), W76 → ST + 21 body segments + SE. */

export const ALDERLINE_940 = [
  "ISA*00*          *00*          *ZZ*AHL-PROVIS     *ZZ*BRAMBLE WMS    *260314*0800*U*00401*000000103*0*P*:~",
  "GS*OW*AHL-PROVIS*BRAMBLE-3PL*20260314*0800*7*X*004010~",
  "ST*940*0001~",
  "BGN*00*20260314*0800*AHL-00175~",
  "N1*SF*Alderline Provisions*91*AHL002~",
  "N3*412 Dock Row~",
  "N4*Gustavus*OH*43085*US~",
  "PER*IC*AHL EDI DESK*TE*555-0170~",
  "N1*ST*Bramble & Twine DC 2*92*BTDC02~",
  "N3*18 Brambling Way~",
  "N4*Lodyra*OH*43046*US~",
  "N1*BT*Alderline Billing Office*91*AHLBILL~",
  "W05*N*0001~",
  "W06*AHL-DEPOT-1*AHL-00175~",
  "N9*PO*4500987321~",
  "G62*10*20260316~",
  "LX*1~",
  "L11*BK4036-24*SK~",
  "W01*6*EA*0684000000591*VN*BK4036-24*IN*BK-01386~",
  "G69*Bramble jute twine, six-pack~",
  "LX*2~",
  "L11*TK2014-99*SK~",
  "W01*2*CA*0684000000607*VN*TK2014-99*IN*TK-08099~",
  "G69*Trowel steel blade, cast handle~",
  "W76*8~",
  "SE*24*0001~",
  "GE*1*7~",
  "IEA*1*000000103~",
].join("");

/* ---------- Kelrick Outfitters — their own 940, same loop shape ---------- */

export const KELRICK_940 = [
  "ISA*00*          *00*          *ZZ*KELRICK-OF     *ZZ*BRAMBLE WMS    *260319*1030*U*00401*000000104*0*P*:~",
  "GS*OW*KELRICK OUTFITTERS*BRAMBLE-3PL*20260319*1030*8*X*004010~",
  "ST*940*0001~",
  "BGN*00*20260319*1030*KLK-30981~",
  "N1*SF*Kelrick Outfitters*91*KLK001~",
  "N3*77 Alder Way~",
  "N4*Kelso*WA*98626*US~",
  "N1*ST*Bramble & Twine DC 2*92*BTDC02~",
  "N3*18 Brambling Way~",
  "N4*Lodyra*OH*43046*US~",
  "N1*BT*Kelrick Accounts Office*91*KLKBILL~",
  "W05*N*PO-77120~",
  "W06*KLK-DEPOT*KLK-30981~",
  "N9*PO*4500990217~",
  "G62*10*20260323~",
  "LX*1~",
  "L11*FE9917-33*SK~",
  "W01*10*EA*0684000000614*VN*FE9917-33*IN*FE-44102~",
  "G69*Fenwick fly rod blank, 9ft~",
  "LX*2~",
  "L11*LM1206-01*SK~",
  "W01*4*EA*0684000000621*VN*LM1206-01*IN*LM-71206~",
  "G69*Lamp module carbide tip~",
  "W76*14~",
  "SE*23*0001~",
  "GE*1*8~",
  "IEA*1*000000104~",
].join("");

/* ---------- the malformed carriers ---------- */

/** ISA06 fixed width broken: a space went missing mid-interchange.
    The parser dies at the ISA width law (ENVELOPE). */
export const ALDERLINE_940_WIDTH = [
  "ISA*00*          *00*          *ZZ*AHL-PROVIS   *ZZ*BRAMBLE WMS    *260314*0800*U*00401*000000103*0*P*:~",
  "GS*OW*AHL-PROVIS*BRAMBLE-3PL*20260314*0800*7*X*004010~",
  "ST*940*0001~",
  "BGN*00*20260314*0800*AHL-00175~",
  "W05*N*0001~",
  "W06*AHL-DEPOT-1*AHL-00175~",
  "LX*1~",
  "W01*6*EA*0684000000591*VN*BK4036-24*IN*BK-01386~",
  "W76*6~",
  "SE*11*0001~",
  "GE*1*7~",
  "IEA*1*000000103~",
].join("");

/** SE01 lies: says 11, holds 8 (ST, BGN, W05, W06, LX, W01, W76, SE —
    hand-count: 8 — so 11 is a lie; the parser counts anyway). */
export const ALDERLINE_940_SE = [
  "ISA*00*          *00*          *ZZ*AHL-PROVIS     *ZZ*BRAMBLE WMS    *260314*0800*U*00401*000000103*0*P*:~",
  "GS*OW*AHL-PROVIS*BRAMBLE-3PL*20260314*0800*7*X*004010~",
  "ST*940*0001~",
  "BGN*00*20260314*0800*AHL-00175~",
  "W05*N*0001~",
  "W06*AHL-DEPOT-1*AHL-00175~",
  "LX*1~",
  "W01*6*EA*0684000000591*VN*BK4036-24*IN*BK-01386~",
  "W76*6~",
  "SE*11*0001~",
  "GE*1*7~",
  "IEA*1*000000103~",
].join("");

/** an unknown partner — the routing table has no such sender. */
export const UNKNOWN_940 = [
  "ISA*00*          *00*          *ZZ*UNKNOWNCO      *ZZ*BRAMBLE WMS    *260314*0800*U*00401*000000777*0*P*:~",
  "GS*OW*UNKNOWNCO*BRAMBLE-3PL*20260314*0800*9*X*004010~",
  "ST*940*0001~",
  "BGN*00*20260314*0800*UNK-1~",
  "W05*N*0001~",
  "W06*UNK-DEPOT*UNK-1~",
  "SE*5*0001~",
  "GE*1*9~",
  "IEA*1*000000777~",
].join("");

/* ---------- the canonical shipment the partners' paperwork answers ---------- */

/** Alderline's advice for AHL-00175: fully shipped, one pallet,
    a BOL, and a weighed-out 24 kg — the out fixtures' subject. */
export const ALDERLINE_SHIPMENT: CanonShipment = {
  kind: "shipment",
  v: CANON_V,
  ref: "SHP-20444",
  partner: "alderline",
  account: "AHL-DEPOT-1",
  dateSec: dateSecOf("20260316", "1430"),
  carrier: { scac: "BRML", mode: "PU" },
  bol: "BOL-88213",
  packages: [{ sscc: "000012345678901234" }],
  items: [
    {
      orderRef: "AHL-00175",
      lineRef: "BK4036-24",
      sku: "BK4036-24",
      origQty: 6,
      shipQty: 6,
      uom: "EA",
    },
    {
      orderRef: "AHL-00175",
      lineRef: "TK2014-99",
      sku: "TK2014-99",
      origQty: 2,
      shipQty: 2,
      uom: "CA",
    },
  ],
  totalUnits: 8,
  weightG: 24_000,
};
