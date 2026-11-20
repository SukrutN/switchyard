/* ============================================================
   desk.test — DeskYard, the tabletop yard.

   Locks: every write earns its receipt and they share one
   gapless per-lane sequence (stream rows, KV sets, deletes);
   KV answers read back the value AND the seq of the set that
   wrote it; deletes are journaled too (even for keys that
   never existed); and a journal replayed onto a fresh yard
   reproduces the state byte for byte — the same law the real
   yard promises at bring-up.
   ============================================================ */

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { rowDigest } from "../src/canon.ts";
import { DeskYard } from "../src/desk.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("desk — the journal in process", () => {
  it("each write earns one seq, gaps none", async () => {
    const yard = new DeskYard();
    const s1 = await yard.publish("orders", "orders.a.paid", enc("payload-a"));
    const s2 = await yard.kvSet("waybill-pace", "cntrl.alderline.945", enc('{"isa":1,"group":1,"txn":1}'));
    const s3 = await yard.kvDelete("waybill-pace", "gone");
    strictEqual(s1, 1); // orders' own space
    strictEqual(s2, 1); // the pace lane's own space
    strictEqual(s3, 2); // pace again: gapless in the lane
    const rows = await yard.rows("orders");
    strictEqual(rows.length, 1);
    strictEqual(rows[0].kind, "stream");
    strictEqual(rows[0].subject, "orders.a.paid");
    const pace = await yard.rows("waybill-pace");
    strictEqual(pace.length, 2); // set + delete
    strictEqual(pace[0].kind, "kv");
    strictEqual(pace[1].kind, "kvdel");
  });

  it("lanes have separate sequence spaces", async () => {
    const yard = new DeskYard();
    await yard.publish("orders", "orders.a.paid", enc("x"));
    const paceSeq = await yard.kvSet("waybill-pace", "k", enc("v"));
    strictEqual(paceSeq, 1);
  });

  it("KV answers carry the value and the seq of the set", async () => {
    const yard = new DeskYard();
    const seq = await yard.kvSet("waybill-pace", "k", enc("v1"));
    await yard.kvSet("waybill-pace", "k", enc("v2"));
    const a = await yard.kvGet("waybill-pace", "k");
    strictEqual(a.found, true);
    strictEqual(new TextDecoder().decode(a.payload), "v2");
    strictEqual(a.seq, seq + 1);
  });

  it("a missing key answers found:false at seq 0", async () => {
    const yard = new DeskYard();
    const a = await yard.kvGet("waybill-pace", "nope");
    deepStrictEqual([a.found, a.seq, a.payload.length], [false, 0, 0]);
  });

  it("a delete hides the key but journals the fact", async () => {
    const yard = new DeskYard();
    await yard.kvSet("waybill-pace", "k", enc("v"));
    await yard.kvDelete("waybill-pace", "k");
    const a = await yard.kvGet("waybill-pace", "k");
    strictEqual(a.found, false);
    const rows = await yard.rows("waybill-pace");
    strictEqual(rows.length, 2);
  });

  it("deleting a key that never was is still a fact, journaled", async () => {
    const yard = new DeskYard();
    const seq = await yard.kvDelete("waybill-pace", "phantom");
    strictEqual(seq, 1);
    const rows = await yard.rows("waybill-pace");
    strictEqual(rows.length, 1);
  });

  it("keys lists what stands", async () => {
    const yard = new DeskYard();
    await yard.kvSet("waybill-pace", "b", enc("2"));
    await yard.kvSet("waybill-pace", "a", enc("1"));
    await yard.kvSet("waybill-pace", "dead", enc("3"));
    await yard.kvDelete("waybill-pace", "dead");
    deepStrictEqual([...(await yard.keys("waybill-pace"))], ["a", "b"]);
  });

  it("replaying the journal reproduces the state byte for byte", async () => {
    const yard = new DeskYard();
    await yard.publish("orders", "orders.a.paid", enc("payload-a"));
    await yard.kvSet("waybill-pace", "cntrl.alderline.945", enc('{"isa":1,"group":1,"txn":1}'));
    await yard.publish("orders", "orders.b.paid", enc("payload-b"));
    await yard.kvSet("waybill-pace", "cntrl.alderline.945", enc('{"isa":2,"group":2,"txn":2}'));
    await yard.kvDelete("waybill-pace", "cntrl.alderline.856");

    const replay = new DeskYard();
    for (const lane of ["orders", "waybill-pace"]) {
      for (const r of await yard.rows(lane)) {
        if (r.kind === "stream") await replay.publish(lane, r.subject, r.payload);
        else if (r.kind === "kv") await replay.kvSet(lane, r.key, r.payload);
        else await replay.kvDelete(lane, r.key);
      }
    }
    for (const lane of ["orders", "waybill-pace"]) {
      deepStrictEqual(
        (await replay.rows(lane)).map((r) => [r.seq, r.kind, r.subject + r.key, Array.from(r.payload)]),
        (await yard.rows(lane)).map((r) => [r.seq, r.kind, r.subject + r.key, Array.from(r.payload)]),
      );
    }
    const revived = await replay.kvGet("waybill-pace", "cntrl.alderline.945");
    strictEqual(new TextDecoder().decode(revived.payload), '{"isa":2,"group":2,"txn":2}');
    strictEqual((await replay.kvGet("waybill-pace", "cntrl.alderline.856")).found, false);
  });

  it("the row digest separates lanes and orders", async () => {
    const yard = new DeskYard();
    await yard.publish("orders", "orders.a.paid", enc("1"));
    const digestOrders = rowDigest((await yard.rows("orders")).map((r) => ({ subject: r.subject, payload: r.payload })));
    await yard.kvSet("waybill-pace", "k", enc("1"));
    const digestPace = rowDigest((await yard.rows("waybill-pace")).map((r) => ({ subject: r.key, payload: r.payload })));
    strictEqual(digestOrders !== digestPace, true);
  });
});
