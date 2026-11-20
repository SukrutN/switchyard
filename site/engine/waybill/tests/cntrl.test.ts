/* ============================================================
   cntrl.test — the control numbers' law.

   Locks: a reservation writes the KV BEFORE the numbers leave
   (the receipt is the fact); consecutive reservations never
   repeat within a partner+doc; the state is journaled rows, so
   a fresh yard hydrated by replay continues the count without
   duplicates; and the pad formats are the standard's own.
   ============================================================ */

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import type { ControlData } from "../src/cntrl.ts";
import { controlKey, decodeControls, encodeControls, isa13, reserve, txnCtl } from "../src/cntrl.ts";
import { DeskYard } from "../src/desk.ts";

describe("cntrl — counter state over journaled KV", () => {
  it("the first reservation is 1s; the next never repeats", async () => {
    const yard = new DeskYard();
    const a = await reserve(yard, "waybill-pace", "alderline", "945");
    const b = await reserve(yard, "waybill-pace", "alderline", "945");
    deepStrictEqual(a, { isa: 1, group: 1, txn: 1 });
    deepStrictEqual(b, { isa: 2, group: 2, txn: 2 });
  });

  it("partners and docs count separately", async () => {
    const yard = new DeskYard();
    deepStrictEqual(await reserve(yard, "waybill-pace", "alderline", "945"), { isa: 1, group: 1, txn: 1 });
    deepStrictEqual(await reserve(yard, "waybill-pace", "alderline", "856"), { isa: 1, group: 1, txn: 1 });
    deepStrictEqual(await reserve(yard, "waybill-pace", "kelrick", "945"), { isa: 1, group: 1, txn: 1 });
    const done = await Promise.allSettled([
      reserve(yard, "waybill-pace", "alderline", "945"),
      reserve(yard, "waybill-pace", "alderline", "945"),
    ]);
    deepStrictEqual(
      done.map((d) => (d.status === "fulfilled" ? d.value : null)),
      [{ isa: 2, group: 2, txn: 2 }, { isa: 3, group: 3, txn: 3 }],
    );
  });

  it("the reservation is a KV row, written before the numbers leave", async () => {
    const yard = new DeskYard();
    await reserve(yard, "waybill-pace", "alderline", "945");
    const rows = await yard.rows("waybill-pace");
    strictEqual(rows.length, 1);
    strictEqual(rows[0].kind, "kv");
    strictEqual(rows[0].key, controlKey("alderline", "945"));
    deepStrictEqual(decodeControls(rows[0].payload), { isa: 1, group: 1, txn: 1 });
  });

  it("state lives in the journal: a fresh yard hydrated from rows never dups", async () => {
    // mint a few times on yard one — its journal IS the counter's story
    const yard = new DeskYard();
    await reserve(yard, "waybill-pace", "alderline", "945");
    await reserve(yard, "waybill-pace", "alderline", "945");

    // "reboot": a fresh yard, hydrated by applying the journaled KV rows
    const revived = new DeskYard();
    for (const r of await yard.rows("waybill-pace")) {
      if (r.kind === "kv") await revived.kvSet("waybill-pace", r.key, r.payload);
      if (r.kind === "kvdel") await revived.kvDelete("waybill-pace", r.key);
    }

    // the count continues from history; 1 and 2 are gone forever
    const third = await reserve(revived, "waybill-pace", "alderline", "945");
    deepStrictEqual(third, { isa: 3, group: 3, txn: 3 });
  });

  it("the state's bytes are canonical and fixed-order", () => {
    const c: ControlData = { isa: 12, group: 34, txn: 56 };
    const text = new TextDecoder().decode(encodeControls(c));
    deepStrictEqual(text, '{"isa":12,"group":34,"txn":56}');
    deepStrictEqual(decodeControls(encodeControls(c)), c);
  });

  it("the pads are the standard's own", () => {
    deepStrictEqual(isa13(1), "000000001");
    deepStrictEqual(isa13(999_999_999), "999999999");
    deepStrictEqual(txnCtl(1), "0001");
    deepStrictEqual(txnCtl(9999), "9999");
  });

  it("the pads refuse out-of-range numbers loudly", async () => {
    for (const f of [0, -1, 1_000_000_000]) {
      let threw = false;
      try {
        isa13(f);
      } catch {
        threw = true;
      }
      deepStrictEqual(threw, true, `isa13(${f}) must throw`);
    }
    for (const f of [0, 10_000]) {
      let threw = false;
      try {
        txnCtl(f);
      } catch {
        threw = true;
      }
      deepStrictEqual(threw, true, `txnCtl(${f}) must throw`);
    }
  });
});
