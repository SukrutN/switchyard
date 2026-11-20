/* ============================================================
   lane.test — the seam's characterization.

   Locks: the subject charter is claimed at the origin (the
   open charter terms pass, the crimes throw CharterError);
   and despatchRowOf mirrors sheet 02's OrderRow v1 bytes
   exactly — kind/ref/cls/dueSec/arrivalSec/lines, canonical
   JSON in a fixed key order, no waybill version tag inside.
   ============================================================ */

import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CANON_V,
  type CanonOrder,
  dateSecOf,
  type RefusalCode,
} from "../src/canon.ts";
import {
  LANES,
  CharterError,
  type DespatchRow,
  checkSubject,
  deadSubject,
  decodeDespatchRow,
  despatchRowOf,
  orderSubject,
} from "../src/lane.ts";

const ORDER: CanonOrder = {
  kind: "order",
  v: CANON_V,
  ref: "AHL-00175",
  partner: "alderline",
  purpose: "N",
  set: "940",
  dateSec: dateSecOf("20260314", "0800"),
  parties: [],
  refs: { po: "4500987321", batch: "0001", finn: [] },
  lines: [
    { lineRef: "BK4036-24", sku: "BK4036-24", gtin: "", desc: "", qty: 6, uom: "EA" },
    { lineRef: "TK2014-99", sku: "TK2014-99", gtin: "", desc: "", qty: 2, uom: "CA" },
  ],
  totalQty: 8,
};

describe("lane — the charter at the origin", () => {
  it("an order rides orders.<ref>.paid", () => {
    strictEqual(orderSubject("AHL-00175"), "orders.AHL-00175.paid");
  });

  it("a refusal rides <lane>.<code>.<doc>, riding its lane (§2.10)", () => {
    const code: RefusalCode = "MAP_MISS";
    strictEqual(deadSubject(code, "AHL-940-0001"), "waybill-dead.MAP_MISS.AHL-940-0001");
    // the §2.10 law the real yard enforces at the wire
    strictEqual(deadSubject(code, "AHL-940-0001").startsWith(`${LANES.dead}.`), true);
  });

  it("the charter admits printable tokens without dots", () => {
    strictEqual(checkSubject("orders.AHL-00175.paid"), "orders.AHL-00175.paid");
    strictEqual(checkSubject("waybill-dead.X12_PARSE.940-a"), "waybill-dead.X12_PARSE.940-a");
  });

  it("a dotted ref yields legal tokens — the single-token ref law is the adapter's", () => {
    // the subject charter validates TOKENS; "AHL.00175" becomes two
    // clean tokens, so the subject stands. The law that a REF is one
    // token lives at the adapter door (REF_CHARS — see inbound.test).
    strictEqual(orderSubject("AHL.00175"), "orders.AHL.00175.paid");
  });

  it("a space is not a charter token", () => {
    throws(() => checkSubject("orders.AHL 00175.paid"), CharterError);
  });

  it("an empty token is not a token", () => {
    throws(() => checkSubject("orders..paid"), CharterError);
  });

  it("a token over 64 chars is a crime", () => {
    throws(() => checkSubject(`orders.${"A".repeat(65)}.paid`), CharterError);
  });

  it("the error names the subject and the token", () => {
    try {
      checkSubject("orders.AHL 00175.paid");
      throw new Error("should have thrown");
    } catch (e) {
      strictEqual(e instanceof CharterError, true);
      strictEqual((e as Error).message.includes("orders.AHL 00175.paid"), true);
      strictEqual((e as Error).message.includes("AHL 00175"), true);
    }
  });
});

describe("lane — the despatch target (sheet 02's bytes)", () => {
  const arrival = ORDER.dateSec;
  const due = arrival + 86_400;
  const row = despatchRowOf(ORDER, "standard", 86_400);
  const text = new TextDecoder().decode(row);

  it("the bytes are exactly sheet 02's OrderRow v1", () => {
    strictEqual(
      text,
      `{"kind":"order","ref":"AHL-00175","cls":"standard","dueSec":${due},"arrivalSec":${arrival},"lines":[{"sku":"BK4036-24","qty":6},{"sku":"TK2014-99","qty":2}]}`,
    );
  });

  it("the row carries no waybill version of its own", () => {
    strictEqual(text.includes('"v"'), false);
  });

  it("decodes back into the same facts", () => {
    const back: DespatchRow = decodeDespatchRow(row);
    strictEqual(back.kind, "order");
    strictEqual(back.ref, "AHL-00175");
    strictEqual(back.cls, "standard");
    strictEqual(back.dueSec, due);
    strictEqual(back.arrivalSec, arrival);
    deepStrictEqual(back.lines, [
      { sku: "BK4036-24", qty: 6 },
      { sku: "TK2014-99", qty: 2 },
    ]);
  });

  it("the class rides the profile, not the paper", () => {
    const expedite = new TextDecoder().decode(despatchRowOf(ORDER, "expedite", 21_600));
    strictEqual(expedite !== text, true);
    strictEqual(expedite.includes('"cls":"expedite"'), true);
  });

  it("a bad class refuses at the decode door", () => {
    throws(() => decodeDespatchRow(new TextEncoder().encode('{"cls":"urgent"}')));
    throws(() => decodeDespatchRow(new TextEncoder().encode('{"kind":"note"}')));
  });
});
