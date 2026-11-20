/* ============================================================
   x12.test — the metal's characterization.

   Locks: the ISA is 106 bytes on every fixture; parse → re-emit
   = identical bytes; the malformed carriers die with the code
   the sheet promises (ENVELOPE for the width crime, COUNTS for
   the SE lie); separators that collide refuse; and the element
   law (trailing empties ride, interior empties keep arity)
   round-trips.
   ============================================================ */

import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALDERLINE_940,
  ALDERLINE_940_SE,
  ALDERLINE_940_WIDTH,
  KELRICK_940,
  UNKNOWN_940,
  encodeText,
} from "../fixtures/documents.ts";
import {
  ISA_TOTAL,
  type Envelope,
  buildTx,
  encodeX12,
  parseX12,
  seg,
} from "../src/x12.ts";

const bytesOf = (s: string): Uint8Array => encodeText(s);

describe("x12 — the metal", () => {
  for (const [name, doc] of [
    ["alderline", ALDERLINE_940],
    ["kelrick", KELRICK_940],
    ["unknown", UNKNOWN_940],
    ["se-lie", ALDERLINE_940_SE],
  ] as const) {
    it(`the ISA of ${name} spans exactly ${ISA_TOTAL} bytes with its terminator`, () => {
      const b = bytesOf(doc);
      // the raw text of the ISA: 3 tag chars + 16 elements + separators,
      // closing terminator — byte 105 (0-based) IS the terminator
      strictEqual(doc[105], "~");
      strictEqual(doc.slice(3, 4), "*");
      strictEqual(b.length > ISA_TOTAL, true);
    });
  }

  it("round-trips alderline byte for byte", () => {
    const b = bytesOf(ALDERLINE_940);
    const env = parseX12(b);
    const out = encodeX12(env);
    deepStrictEqual(Array.from(out), Array.from(b));
  });

  it("round-trips kelrick byte for byte", () => {
    const b = bytesOf(KELRICK_940);
    const env = parseX12(b);
    const out = encodeX12(env);
    deepStrictEqual(Array.from(out), Array.from(b));
  });

  it("round-trips unknown byte for byte", () => {
    const b = bytesOf(UNKNOWN_940);
    const env = parseX12(b);
    const out = encodeX12(env);
    deepStrictEqual(Array.from(out), Array.from(b));
  });

  it("keeps trailing empty elements exactly as it read them", () => {
    // the writer's join law: arity is data
    const doc =
      "ISA*00*          *00*          *ZZ*AHL-PROVIS     *ZZ*BRAMBLE WMS    *260314*0800*U*00401*000000103*0*P*:~" +
      "GS*OW*AHL-PROVIS*BRAMBLE-3PL*20260314*0800*7*X*004010~" +
      "ST*940*0001~" +
      "W66*PP*ZZ********CALL~" +
      "LX*1~" +
      "W01*6*EA~" +
      "SE*5*0001~" +
      "GE*1*7~" +
      "IEA*1*000000103~";
    const env = parseX12(bytesOf(doc));
    deepStrictEqual(env.groups[0].txs[0].body[0].elems.length, 10);    deepStrictEqual(Array.from(encodeX12(env)), Array.from(bytesOf(doc)));
  });

  it("the ISA width crime dies with ENVELOPE, at the field", () => {
    try {
      parseX12(bytesOf(ALDERLINE_940_WIDTH));
      throw new Error("should not have parsed");
    } catch (e) {
      strictEqual((e as { code?: string; at?: string }).code, "ENVELOPE");
      strictEqual((e as { at?: string }).at, "ISA06");
    }
  });

  it("the SE lie dies with COUNTS", () => {
    try {
      parseX12(bytesOf(ALDERLINE_940_SE));
      throw new Error("should not have parsed");
    } catch (e) {
      strictEqual((e as { code?: string; at?: string }).code, "COUNTS");
      strictEqual((e as { at?: string }).at, "SE");
    }
  });

  it("colliding separators refuse up front", () => {
    // the segment terminator reused as the component separator (ISA16)
    const doc =
      "ISA*00*          *00*          *ZZ*AHL-PROVIS     *ZZ*BRAMBLE WMS    *260314*0800*U*00401*000000103*0*P*~~" +
      "GS*OW*AHL-PROVIS*BRAMBLE-3PL*20260314*0800*7*X*004010~" +
      "ST*940*0001~" +
      "W05*N*0001~" +
      "W06*AHL-DEPOT-1*AHL-00175~" +
      "SE*5*0001~" +
      "GE*1*7~" +
      "IEA*1*000000103~";
    throws(() => parseX12(bytesOf(doc)), /collide/);
  });

  it("counts SE itself and its ST (SE01 = body + 2)", () => {
    const body = [seg("BGN", "00", "20260314", "0800", "AHL-00175"), seg("W76", "8")];
    const tx = buildTx("940", body, "0001");
    strictEqual(tx.se[0], "4"); // ST + 2 + SE
    const rebuilt = encodeX12({
      isa: [
        "00", "          ", "00", "          ", "ZZ", "AHL-PROVIS     ",
        "ZZ", "BRAMBLE WMS    ", "260314", "0800", "U", "00401", "000000001",
        "0", "P", ":",
      ],
      groups: [{ gs: ["OW", "AHL-PROVIS", "BRAMBLE-3PL", "20260314", "0800", "1", "X", "004010"], txs: [tx], ge: ["1", "1"] }],
      iea: ["1", "000000001"],
      delims: { elem: "*", comp: ":", segTerm: "~" },
      trailingTerminator: true,
    } satisfies Envelope);
    const text = new TextDecoder().decode(rebuilt);
    strictEqual(
      text,
      "ISA*00*          *00*          *ZZ*AHL-PROVIS     *ZZ*BRAMBLE WMS    *260314*0800*U*00401*000000001*0*P*:~" +
        "GS*OW*AHL-PROVIS*BRAMBLE-3PL*20260314*0800*1*X*004010~" +
        "ST*940*0001~" +
        "BGN*00*20260314*0800*AHL-00175~" +
        "W76*8~" +
        "SE*4*0001~" +
        "GE*1*1~" +
        "IEA*1*000000001~",
    );
  });

  it("a document may end without its terminator", () => {
    const doc =
      "ISA*00*          *00*          *ZZ*AHL-PROVIS     *ZZ*BRAMBLE WMS    *260314*0800*U*00401*000000103*0*P*:~" +
      "GS*OW*AHL-PROVIS*BRAMBLE-3PL*20260314*0800*7*X*004010~" +
      "ST*940*0001~" +
      "W05*N*0001~" +
      "W06*AHL-DEPOT-1*AHL-00175~" +
      "SE*4*0001~" +
      "GE*1*7~" +
      "IEA*1*000000103"; // no trailing ~
    const env = parseX12(bytesOf(doc));
    strictEqual(env.trailingTerminator, false);
    deepStrictEqual(Array.from(encodeX12(env)), Array.from(bytesOf(doc)));
  });

  it("renumbering the interchange changes only the metal", () => {
    const env = parseX12(bytesOf(ALDERLINE_940));
    const renumbered: Envelope = {
      ...env,
      isa: env.isa.map((v, i) => (i === 12 ? "000000999" : v)),
    };
    const out = new TextDecoder().decode(encodeX12(renumbered));
    strictEqual(out.includes("*000000999*"), true);
    strictEqual(out.slice(0, 170).includes("AHL-PROVIS"), true);
  });
});
