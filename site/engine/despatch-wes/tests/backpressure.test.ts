/* ============================================================
   backpressure.test — the hold law: when a zone lane's delivered-
   unacked depth outruns `pendingCap`, the batch HOLDS — a `held`
   receipt rides the ledger (effectiveSec 0), the work content
   parks in the pace lane's KV, and nothing is ever dropped. When
   the crews catch up, the very same bytes leave the lane, the
   curve stretched and the manifest complete.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import { dayByKey } from "../../despatch-engine/fixtures/dc.ts";
import { SLOTTING } from "../../despatch-engine/fixtures/dc.ts";
import { receiptsOf, stageOrders, workRowsOf, zoneLanes } from "../fixtures/daylane.ts";
import { MemoryYard } from "../src/modelyard.ts";
import { DespatchWes } from "../src/wes.ts";
import { workLane } from "../src/yard.ts";

test("backpressure: a saturated zone holds, then releases every byte", async () => {
  const day = dayByKey("average-day");
  const head = day.orders.slice(0, 60);
  const yard = new MemoryYard();

  // the crew consumers attach BEFORE the orchestrator boots — zone 2's
  // crew takes every delivery and never acks; the others ack inline.
  const z2 = workLane(1);
  for (let z = 0; z < 4; z++) {
    const lane = workLane(z);
    const crew = `crew-z${z + 1}`;
    await yard.attachConsumer(lane, crew, (d) => {
      if (z === 1) return; // the silent crew
      void yard.ackRow(lane, crew, d.seq);
    });
  }

  const wes = new DespatchWes(yard, SLOTTING, {
    windowSec: 90,
    zoneCount: 4,
    pickersPerZone: 1,
    horizonSec: 5400,
    pendingCap: 4,
  });
  await wes.boot();
  await stageOrders(yard, head);
  const mid = await wes.finalize(5400);

  // the cap engaged: batch holds sit on the z2 lane only
  const held = mid.receipts.filter((r) => r.status === "held");
  assert.ok(held.length > 0, "the cap engaged");
  for (const h of held) {
    assert.equal(h.zone, 1, "holds happen on the saturated zone");
    assert.equal(h.effectiveSec, 0, "a hold has no effective second yet");
  }
  const keys = await yard.kvKeys("despatch-pace");
  assert.equal(keys.filter((k) => k.startsWith("hold.")).length, held.length);
  const st = await yard.laneState(z2);
  assert.ok(st.pending > 4, "the lane really is saturated");

  // the crews catch up — pass by pass. Each cap-bounded pass releases
  // at most pendingCap+1 holds (every published row parks pending until
  // the crew acks it), so recovery walks: ack, finalize, until the
  // manifest is complete. The very same bytes leave the lane.
  let lastAcked = 0;
  let done = mid;
  for (let pass = 0; pass < 100; pass++) {
    const releasedBatches = new Set(
      done.receipts.filter((r) => r.status === "released").map((r) => r.batch),
    );
    const unresolved = held.filter((h) => !releasedBatches.has(h.batch));
    if (unresolved.length === 0) break;
    for (const r of yard.msgRows(z2)) {
      if (r.seq > lastAcked) {
        await yard.ackRow(z2, "crew-z2", r.seq);
        lastAcked = r.seq;
      }
    }
    done = await wes.finalize();
  }
  assert.equal(done.holdsResolved, held.length, "every hold resolved");

  const keys2 = await yard.kvKeys("despatch-pace");
  assert.equal(keys2.filter((k) => k.startsWith("hold.")).length, 0, "tombstoned");
  for (const r of yard.msgRows(z2)) {
    if (r.seq > lastAcked) {
      await yard.ackRow(z2, "crew-z2", r.seq);
      lastAcked = r.seq;
    }
  }

  // nothing was dropped: exactly one released row per frozen batch
  const rel = new Map<string, number>();
  for (const r of done.receipts) {
    if (r.status !== "released") continue;
    assert.ok(!rel.has(r.batch), "one released row per batch");
    rel.set(r.batch, r.effectiveSec);
  }
  const allBatches = [...new Set(mid.freezes.flatMap((f) => [...f.batchIds]))].sort();
  assert.deepEqual([...rel.keys()].sort(), allBatches);
  for (const h of held) {
    const r = receiptsOf(yard).find((x) => x.batch === h.batch && x.status === "released");
    assert.ok(r !== undefined, `held batch ${h.batch} released`);
    assert.ok(r.effectiveSec >= r.releaseSec, "the curve stretched, not compressed");
  }

  // work rows on each lane in step with that zone's released receipts
  const lanes = zoneLanes();
  for (let z = 0; z < 4; z++) {
    const rows = workRowsOf(yard, lanes[z]);
    const expected = done.receipts.filter((r) => r.status === "released" && r.zone === z).length;
    assert.equal(rows.length, expected, `work-z${z + 1} rows`);
    for (const row of rows) assert.equal(row.effectiveSec > 0, true);
  }
  assert.equal((await yard.laneState(z2)).pending, 0, "the lane drained");
});
