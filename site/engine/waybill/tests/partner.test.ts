/* ============================================================
   partner.test — the artifact's own characterization.

   The sheet's thesis, executable: mapping is data, not code.
   Locks (1) the SAME 940 bytes through BOTH profiles yield two
   distinct canonical orders (different partner, refs, sku, cls,
   SLA), (2) the profiles round-trip through JSON — structs only,
   no closures, no classes, (3) routing is one place with the
   trimming law, and (4) a bad path dies at load, not at publish.
   ============================================================ */

import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALDERLINE_940,
  encodeText,
  ALDERLINE_SHIPMENT,
} from "../fixtures/documents.ts";
import { despatchRowOf } from "../src/lane.ts";
import { checkMap } from "../src/maps.ts";
import type { InboundOutcome } from "../src/inbound.ts";
import { receiveSet } from "../src/inbound.ts";
import type { Profile } from "../src/partners.ts";
import {
  ALDERLINE,
  KELRICK,
  PROFILES,
  routeOfSender,
} from "../src/partners.ts";
import type { Envelope } from "../src/x12.ts";
import { parseX12 } from "../src/x12.ts";

const file = (name: string, doc: string) => ({ name, bytes: encodeText(doc) });

describe("partner — one file, two maps, two orders", () => {
  const env = parseX12(encodeText(ALDERLINE_940));

  it("Alderline's own map: VN part numbers, N9 as the PO", () => {
    const [a] = receiveThrough(env, ALDERLINE).orders;
    strictEqual(a.partner, "alderline");
    strictEqual(a.refs.po, "4500987321");
    strictEqual(a.refs.batch, "0001");
    deepStrictEqual(a.refs.finn, []);
    deepStrictEqual(a.lines.map((l) => [l.sku, l.lineRef]), [
      ["BK4036-24", "BK4036-24"],
      ["TK2014-99", "TK2014-99"],
    ]);
  });

  it("Kelrick's map over the same bytes: W05-2 the PO, the IN pair the part", () => {
    const [k] = receiveThrough(env, KELRICK).orders;
    strictEqual(k.partner, "kelrick");
    strictEqual(k.ref, "AHL-00175"); // the same warehouse order number
    strictEqual(k.refs.po, "0001");
    strictEqual(k.refs.batch, "AHL-DEPOT-1");
    deepStrictEqual(k.refs.finn, [{ qual: "PO", id: "4500987321" }]);
    deepStrictEqual(k.lines.map((l) => [l.sku, l.lineRef]), [
      ["BK-01386", "1"],
      ["TK-08099", "2"],
    ]);
  });

  it("the two canonicals are distinct where the profiles say so", () => {
    const [a] = receiveThrough(env, ALDERLINE).orders;
    const [k] = receiveThrough(env, KELRICK).orders;
    strictEqual(a.partner !== k.partner, true);
    strictEqual(a.refs.po !== k.refs.po, true);
    strictEqual(a.lines[0].sku !== k.lines[0].sku, true);
    // and the ship voice differs: standard/next-day vs expedite/6-hour
    strictEqual(ALDERLINE.despatch.cls !== KELRICK.despatch.cls, true);
    strictEqual(ALDERLINE.despatch.slaSec !== KELRICK.despatch.slaSec, true);
  });

  it("the despatch rows from the two maps would pace differently", () => {
    const [a] = receiveThrough(env, ALDERLINE).orders;
    const [k] = receiveThrough(env, KELRICK).orders;
    const ra = new TextDecoder().decode(despatchRowOf(a, ALDERLINE.despatch.cls, ALDERLINE.despatch.slaSec));
    const rk = new TextDecoder().decode(despatchRowOf(k, KELRICK.despatch.cls, KELRICK.despatch.slaSec));
    strictEqual(ra !== rk, true);
    strictEqual(ra.includes('"cls":"standard"'), true);
    strictEqual(rk.includes('"cls":"expedite"'), true);
    strictEqual(ra.includes('"sku":"BK4036-24"'), true);
    strictEqual(rk.includes('"sku":"BK-01386"'), true);
  });
});

describe("partner — the profiles are ONLY data", () => {
  it("both profiles round-trip through JSON untouched", () => {
    for (const p of PROFILES) {
      deepStrictEqual(JSON.parse(JSON.stringify(p)), p);
    }
  });

  it("routing: the trading partner id lands one profile, trimmed of its padding", () => {
    strictEqual(routeOfSender("AHL-PROVIS")?.key, "alderline");
    strictEqual(routeOfSender("  AHL-PROVIS ")?.key, "alderline"); // ISA06 rides padded
    strictEqual(routeOfSender("KELRICK-OF")?.key, "kelrick");
    strictEqual(routeOfSender("NOBODY"), undefined);
  });

  it("a path that is not a path dies at checkMap, loudly", () => {
    throws(
      () =>
        checkMap({
          knownTags: ["ST"],
          dateRule: { date: "BGN.2" },
          shipDateFrom: "G62{1=10}.2",
          header: [{ from: "W09.lower.2", to: "ref" }],
          parties: [],
          entry: "LX",
          lineFields: [],
          lineIds: [],
        }),
      /not a selector/,
    );
    throws(
      () =>
        checkMap({
          knownTags: ["S T"], // a space is not a tag
          dateRule: { date: "BGN.2" },
          shipDateFrom: "G62{1=10}.2",
          header: [],
          parties: [],
          entry: "LX",
          lineFields: [],
          lineIds: [],
        }),
      /not a tag/,
    );
  });

  it("the loaded profiles ARE checked — every path is well-formed", () => {
    for (const p of PROFILES) {
      const m = p.in?.["940"];
      if (m === undefined) throw new Error(`${p.key} trades 940s with no map`);
      checkMap(m); // throws on any broken path/tag — it does not
    }
  });

  it("a third partner is data: the shape admits it", () => {
    // a third profile built in-test loads and maps the same way
    const third = checkMap({
      knownTags: ["BGN", "W05", "W06"],
      dateRule: { date: "BGN.2" },
      shipDateFrom: "G62{1=10}.2",
      header: [{ from: "W06.2", to: "ref", required: true }],
      parties: [],
      entry: "LX",
      lineFields: [],
      lineIds: [],
    });
    strictEqual(third.header.length, 1);
  });

  it("the fixtures' canonical shipment cites real Alderline facts", () => {
    deepStrictEqual(ALDERLINE_SHIPMENT.partner, "alderline");
    deepStrictEqual(ALDERLINE_SHIPMENT.items.map((i) => i.sku), ["BK4036-24", "TK2014-99"]);
    deepStrictEqual(ALDERLINE_SHIPMENT.totalUnits, 8);
  });
});

/* receive-ish helper: route the parsed env through an explicit profile */
function receiveThrough(env: Envelope, profile: Profile): InboundOutcome {
  // the adapter's door two — used here to force the mapping, not the routing
  return receiveSet(file("AHL-940-0001", ALDERLINE_940), env, profile);
}
