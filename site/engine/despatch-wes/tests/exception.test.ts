/* ============================================================
   exception.test — the quarantine path as DLQ-with-reason-codes:

   · a poisoned order (unmapped SKU) refuses with UNMAPPED_SKU,
     parks, and its marker lands in the pace lane's KV — the
     reassign row from the control lane applies the mapping fix
     (KV carries face AND bay), journals a resolved row, and the
     order RIDES the next window to a completed work row;
   · an operator row about a healthy order fixes the mapping and
     never fictions a quarantine;
   · a cart that cannot fit one tour refuses OVERSIZED (sku ""
     — no single culprit) and never completes;
   · a park that never acked is pulled back by content, once.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import type { DespatchOrder } from "../../despatch-engine/index.ts";
import { dayByKey } from "../../despatch-engine/fixtures/dc.ts";
import { SLOTTING } from "../../despatch-engine/fixtures/dc.ts";
import {
  quarantinesOf,
  receiptsOf,
  stageDay,
  stageOrder,
  workRowsOf,
  zoneLanes,
} from "../fixtures/daylane.ts";
import {
  controlSubject,
  decodeSkuMapRow,
  encodeReassignRow,
} from "../src/records.ts";
import { MemoryYard } from "../src/modelyard.ts";
import { DespatchWes } from "../src/wes.ts";

const POISON: DespatchOrder = {
  id: "BT-POISON",
  arrivalSec: 30,
  dueSec: 7230,
  cls: "standard",
  lines: [{ sku: "QX-NOPE", qty: 2 }, { sku: "VASE-CLAY", qty: 3 }],
};

test("quarantine → reason code → reassign → completed", async () => {
  const day = dayByKey("average-day");
  const yard = new MemoryYard();
  const wes = new DespatchWes(yard, SLOTTING, {
    windowSec: 90,
    zoneCount: 4,
    pickersPerZone: day.profile.pickersPerZone,
    horizonSec: day.horizonSec,
  });
  await wes.boot();
  await stageDay(yard, day, 24);
  await stageOrder(yard, POISON);
  await wes.step();

  // refused with a code, parked on a durable marker
  const pre = wes.stats();
  assert.equal(pre.quarantined.filter((q) => q.status === "open").length, 1);
  assert.equal((await yard.kvGet("despatch-pace", "q.BT-POISON.UNMAPPED_SKU")).found, true);

  // the operator repairs the mapping from the control lane
  await yard.publishRow(
    "despatch-control",
    controlSubject("BT-POISON"),
    encodeReassignRow({
      kind: "reassign",
      ref: "BT-POISON",
      sku: "QX-NOPE",
      aisle: 5,
      bay: 3,
      cls: POISON.cls,
      arrivalSec: POISON.arrivalSec,
      dueSec: POISON.dueSec,
      lines: POISON.lines,
    }),
  );
  const final = await wes.finalize(day.horizonSec);
  assert.equal(final.controls, 1);

  // the ledger: one open row, resolved by the reassign
  const q = quarantinesOf(yard);
  assert.equal(q.length, 2);
  assert.equal(q[0].status, "open");
  assert.equal(q[0].reason, "UNMAPPED_SKU");
  assert.equal(q[0].sku, "QX-NOPE");
  assert.equal(q[0].ref, "BT-POISON");
  assert.equal(q[1].status, "resolved");
  assert.equal(q[1].via, "reassign");
  assert.equal(q[1].ref, "BT-POISON");
  assert.equal(q[1].sku, "QX-NOPE");

  // the fix KV: face AND bay, re-readable by any resumed orchestrator
  const km = decodeSkuMapRow((await yard.kvGet("despatch-pace", "sku-map")).payload);
  assert.deepEqual([...km.fixes], [{ sku: "QX-NOPE", aisle: 5, bay: 3 }]);

  // the order completed: exactly one released receipt carries it, and
  // its work row rides the same batch on the zone's lane
  const rel = final.receipts.filter(
    (r) => r.status === "released" && r.orders.includes("BT-POISON"),
  );
  assert.equal(rel.length, 1);
  assert.ok(rel[0].effectiveSec >= rel[0].releaseSec, "effective is honest");
  const batchId = rel[0].batch;
  let found: { lane: string; batch: string } | null = null;
  for (const lane of zoneLanes()) {
    for (const row of workRowsOf(yard, lane)) {
      if (row.batch === batchId) {
        assert.equal(found, null, "one work row per batch");
        assert.ok(row.orders.includes("BT-POISON"));
        found = { lane, batch: row.batch };
      }
    }
  }
  assert.ok(found !== null, "the work row landed");
  assert.equal(found.lane, `work-z${rel[0].zone + 1}`);

  // the freeze ledger carries the reassigned ref
  assert.ok(final.freezes.some((f) => f.orderIds.includes("BT-POISON")));

  // every row on the orders lane acked; the board covers it all
  assert.equal(yard.consumerFloor("orders", "despatch-batch"), 25);
  assert.equal(final.throughSeq, 25);
});

test("an operator row about a healthy order: mapping only, no fiction", async () => {
  const day = dayByKey("average-day");
  const yard = new MemoryYard();
  const wes = new DespatchWes(yard, SLOTTING, {
    windowSec: 90,
    zoneCount: 4,
    pickersPerZone: day.profile.pickersPerZone,
    horizonSec: day.horizonSec,
  });
  await wes.boot();
  await stageDay(yard, day, 5);
  await wes.step();

  await yard.publishRow(
    "despatch-control",
    controlSubject("BT-0001"),
    encodeReassignRow({
      kind: "reassign",
      ref: "BT-0001",
      sku: "ZZ-FIX",
      aisle: 7,
      bay: 2,
      cls: "standard",
      arrivalSec: 4,
      dueSec: 7204,
      lines: [{ sku: "ZZ-FIX", qty: 1 }],
    }),
  );
  const final = await wes.finalize(day.horizonSec);

  // the mapping fix journaled; no quarantine row was ever invented
  assert.equal(final.controls, 1);
  assert.equal(quarantinesOf(yard).length, 0);
  const km = decodeSkuMapRow((await yard.kvGet("despatch-pace", "sku-map")).payload);
  assert.deepEqual([...km.fixes], [{ sku: "ZZ-FIX", aisle: 7, bay: 2 }]);
  assert.equal(yard.consumerFloor("despatch-control", "despatch-ctl"), 1);
});

test("oversize refuses OVERSIZED with an empty sku and never completes", async () => {
  const day = dayByKey("average-day");
  const yard = new MemoryYard();
  const wes = new DespatchWes(yard, SLOTTING, {
    windowSec: 90,
    zoneCount: 4,
    pickersPerZone: day.profile.pickersPerZone,
    horizonSec: day.horizonSec,
  });
  await wes.boot();
  await stageDay(yard, day, 3);
  const bulk: DespatchOrder = {
    id: "BT-BULK",
    arrivalSec: 40,
    dueSec: 7240,
    cls: "standard",
    lines: [{ sku: "VASE-CLAY", qty: 25 }],
  };
  await stageOrder(yard, bulk);
  await wes.finalize(day.horizonSec);

  const q = quarantinesOf(yard);
  assert.equal(q.length, 1);
  assert.equal(q[0].reason, "OVERSIZED");
  assert.equal(q[0].sku, "");
  assert.equal(q[0].status, "open");
  assert.equal((await yard.kvGet("despatch-pace", "q.BT-BULK.OVERSIZED")).found, true);
  for (const lane of zoneLanes()) {
    for (const row of workRowsOf(yard, lane)) {
      assert.ok(!row.orders.includes("BT-BULK"), "oversize never completes");
    }
  }
  assert.equal(
    receiptsOf(yard).filter((r) => r.orders.includes("BT-BULK") && r.status === "released")
      .length,
    0,
  );
  assert.equal(yard.consumerFloor("orders", "despatch-batch"), 4);
});

test("a park that never acked is pulled back by content, once", async () => {
  const day = dayByKey("average-day");
  const yard = new MemoryYard();
  const wes = new DespatchWes(yard, SLOTTING, {
    windowSec: 90,
    zoneCount: 4,
    pickersPerZone: day.profile.pickersPerZone,
    horizonSec: day.horizonSec,
  });
  await wes.boot();
  await stageDay(yard, day, 24);
  await wes.step();
  // the poison lands AFTER the armed ladder: its park never acks
  const late: DespatchOrder = { ...POISON, arrivalSec: 17800, dueSec: 25000 };
  await stageOrder(yard, late);
  await wes.step();

  const pre = wes.stats();
  assert.equal(pre.quarantined.filter((q) => q.ref === "BT-POISON" && q.status === "open").length, 1);

  await yard.publishRow(
    "despatch-control",
    controlSubject("BT-POISON"),
    encodeReassignRow({
      kind: "reassign",
      ref: "BT-POISON",
      sku: "QX-NOPE",
      aisle: 5,
      bay: 3,
      cls: late.cls,
      arrivalSec: late.arrivalSec,
      dueSec: late.dueSec,
      lines: late.lines,
    }),
  );
  const final = await wes.finalize(day.horizonSec);

  // pulled back through the parked entry — exactly one completion
  const rel = final.receipts.filter(
    (r) => r.status === "released" && r.orders.includes("BT-POISON"),
  );
  assert.equal(rel.length, 1);
  assert.equal(final.controls, 1);
  const q = quarantinesOf(yard);
  assert.deepEqual(
    q.map((r) => r.status),
    ["open", "resolved"],
  );
  // the day-end drain froze it at the armed window (its park sat through
  // the last window's ladder — the drain is the first freeze that runs)
  assert.ok(final.freezes.some((f) => f.orderIds.includes("BT-POISON")));
  assert.equal(yard.consumerFloor("orders", "despatch-batch"), 25);
});
