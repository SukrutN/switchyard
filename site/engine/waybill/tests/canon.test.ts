/* ============================================================
   canon.test — the spine's characterization.

   Locks: encode → decode returns the same message; the bytes
   are canonical JSON in a fixed key order (the refusal row is
   short enough to hold whole); the version door refuses what
   it does not speak; and the digests separate everything they
   must.
   ============================================================ */

import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CANON_V,
  type CanonOrder,
  type Refusal,
  dateSecOf,
  decodeCanon,
  encodeCanon,
  fnv1a64,
  rowDigest,
} from "../src/canon.ts";

const ORDER: CanonOrder = {
  kind: "order",
  v: CANON_V,
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
      address: {
        line1: "412 Dock Row",
        city: "Gustavus",
        region: "OH",
        postal: "43085",
        country: "US",
      },
      phone: "555-0170",
    },
    {
      role: "shipTo",
      name: "Bramble & Twine DC 2",
      id: "BTDC02",
      idQual: "92",
      address: {
        line1: "18 Brambling Way",
        city: "Lodyra",
        region: "OH",
        postal: "43046",
        country: "US",
      },
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

const REFUSAL: Refusal = {
  kind: "refusal",
  v: CANON_V,
  code: "MAP_MISS",
  docName: "AHL-940-0001",
  at: "W06.2",
  detail: "ref is required and absent",
};

describe("canon — the spine", () => {
  it("encode → decode is the same message, field for field", () => {
    deepStrictEqual(decodeCanon(encodeCanon(ORDER)), ORDER);
  });

  it("the refusal row's bytes are the fixed-order law, whole", () => {
    const text = new TextDecoder().decode(encodeCanon(REFUSAL));
    strictEqual(
      text,
      '{"kind":"refusal","v":1,"code":"MAP_MISS","docName":"AHL-940-0001","at":"W06.2","detail":"ref is required and absent"}',
    );
  });

  it("an order's bytes open on the fixed key order", () => {
    const text = new TextDecoder().decode(encodeCanon(ORDER));
    strictEqual(
      text.startsWith(
        '{"kind":"order","v":1,"ref":"AHL-00175","partner":"alderline","purpose":"N","set":"940","dateSec":',
      ),
      true,
      text.slice(0, 110),
    );
  });

  it("the same message encodes to the same bytes, twice", () => {
    const a = encodeCanon(ORDER);
    const b = encodeCanon(decodeCanon(a));
    deepStrictEqual(Array.from(b), Array.from(a));
  });

  it("structural absence omits the key; the decoder matches", () => {
    const { shipDateSec: _absent, ...noShip } = ORDER;
    const text = new TextDecoder().decode(encodeCanon(noShip));
    strictEqual(text.includes('"shipDateSec"'), false);
    deepStrictEqual(decodeCanon(encodeCanon(noShip)), noShip);
  });

  it("the version door refuses what it does not speak", () => {
    const rogue = JSON.parse(new TextDecoder().decode(encodeCanon(ORDER)));
    rogue.v = 2;
    throws(() => decodeCanon(new TextEncoder().encode(JSON.stringify(rogue))), /v=2/);
  });

  it("an unknown kind refuses at the door", () => {
    throws(() => decodeCanon(new TextEncoder().encode('{"kind":"tote","v":1}')), /unknown canonical kind/);
  });

  it("fnv1a64: the empty input is the offset basis", () => {
    strictEqual(fnv1a64(new Uint8Array(0)), "cbf29ce484222325");
  });

  it("fnv1a64 is deterministic and input-sensitive", () => {
    strictEqual(fnv1a64(new TextEncoder().encode("a")), fnv1a64(new TextEncoder().encode("a")));
    strictEqual(
      fnv1a64(new TextEncoder().encode("a")) !== fnv1a64(new TextEncoder().encode("b")),
      true,
    );
  });

  it("rowDigest cannot alias two rows into one", () => {
    const enc = new TextEncoder();
    const rowsA = [{ subject: "a b", payload: enc.encode("c") }];
    const rowsB = [{ subject: "a", payload: enc.encode("b c") }];
    strictEqual(rowDigest(rowsA) !== rowDigest(rowsB), true);
    strictEqual(rowDigest(rowsA), rowDigest([...rowsA]));
  });

  it("rowDigest sees row order", () => {
    const enc = new TextEncoder();
    const rows = [
      { subject: "orders.a.paid", payload: enc.encode("1") },
      { subject: "orders.b.paid", payload: enc.encode("2") },
    ];
    strictEqual(rowDigest(rows) !== rowDigest([...rows].reverse()), true);
  });
});
