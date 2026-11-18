/* ============================================================
   resume.test — the crash envelope, three shots:

   (a) CLEAN crash: an abandoned mid-day session (inbox undrained,
       the armed window on hold) replays from the consumer's floor
       and journals byte-identical lanes to the single-pass run.
   (b) DIRTY crash: the process died between the work-row
       publications and the board commit — same batch ids re-land
       from the resumed run (twice on the wire, once in effect),
       and the board, floors and freeze tags converge to the
       single-pass run's ledger.
   (c) HOLD KV resume: holds rebuilt from the pace lane's KV on
       boot, released with the identical work content, tombstoned.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import type { DespatchOrder } from "../../despatch-engine/index.ts";
import { dayByKey } from "../../despatch-engine/fixtures/dc.ts";
import { SLOTTING } from "../../despatch-engine/fixtures/dc.ts";
import {
  boardOf,
  receiptsOf,
  rowsBytes,
  stageOrders,
  workRowsOf,
  zoneLanes,
} from "../fixtures/daylane.ts";
import { MemoryYard } from "../src/modelyard.ts";
import { DespatchWes, type WesOptions } from "../src/wes.ts";
import { workLane } from "../src/yard.ts";

function optsFor(day: ReturnType<typeof dayByKey>): WesOptions {
  return {
    windowSec: 90,
    zoneCount: 4,
    pickersPerZone: day.profile.pickersPerZone,
    horizonSec: day.horizonSec,
  };
}

const JOURNAL_LANES = [
  "despatch-release",
  "despatch-quarantine",
  "despatch-control",
  "work-z1",
  "work-z2",
  "work-z3",
  "work-z4",
  "quay-slots",
  "northspan-tours",
  "hearth-windows",
  "fluxline-verdicts",
] as const;

test("(a) clean crash: the abandoned session replays to identical journals", async () => {
  const day = dayByKey("average-day");

  const base = new MemoryYard();
  const single = new DespatchWes(base, SLOTTING, optsFor(day));
  await single.boot();
  await stageOrders(base, day.orders.slice(0, 40));
  await single.finalize(day.horizonSec);

  // A stages 25, processes them, and dies with 15 rows unprocessed
  const ry = new MemoryYard();
  const A = new DespatchWes(ry, SLOTTING, optsFor(day));
  await A.boot();
  await stageOrders(ry, day.orders.slice(0, 25));
  await A.step();
  await stageOrders(ry, day.orders.slice(25, 40));

  const B = new DespatchWes(ry, SLOTTING, optsFor(day));
  await B.boot();
  await B.finalize(day.horizonSec);

  for (const lane of JOURNAL_LANES) {
    assert.deepEqual(rowsBytes(base, lane), rowsBytes(ry, lane), `lane ${lane}`);
  }
  assert.deepEqual(await boardOf(base), await boardOf(ry), "board bytes");
  assert.equal(
    base.consumerFloor("orders", "despatch-batch"),
    ry.consumerFloor("orders", "despatch-batch"),
  );
  assert.equal(ry.consumerFloor("orders", "despatch-batch"), 40, "everything acked");
});

test("(b) dirty crash: the same batch ids re-land, then the ledgers converge", async () => {
  const day = dayByKey("average-day");

  // the single-pass truth: 20 orders staged, one dummy after
  const base0 = new MemoryYard();
  const single = new DespatchWes(base0, SLOTTING, optsFor(day));
  await single.boot();
  await stageOrders(base0, day.orders.slice(0, 20));
  const dummy: DespatchOrder = { ...day.orders[20], arrivalSec: 3600 };
  await stageOrders(base0, [dummy]);
  await single.finalize(day.horizonSec);
  const baselineBoard = await boardOf(base0);

  // A runs clean to the same point, then the crash lands inside a
  // freeze: rows journaled, board + acks + re-arm skipped exactly once.
  const ry = new MemoryYard();
  const A = new DespatchWes(ry, SLOTTING, optsFor(day));
  await A.boot();
  await stageOrders(ry, day.orders.slice(0, 20));
  await A.step();
  const preCount = A.stats().freezes.length;
  A.fault({ skipBoardOnce: true });
  await stageOrders(ry, [dummy]);
  await A.step(); // the dirty freeze fires here; A dies right after

  const dirty = A.stats().freezes[preCount];
  assert.ok(dirty !== undefined, "the dirty freeze happened under A");

  const B = new DespatchWes(ry, SLOTTING, optsFor(day));
  await B.boot();
  await B.finalize(day.horizonSec);

  // the re-fired window carried the SAME batch ids (same tags)
  const refired = B.stats().freezes[0];
  assert.ok(refired !== undefined, "B re-fired the dirty window");
  assert.equal(refired.freezeSec, dirty.freezeSec);
  assert.deepEqual([...refired.batchIds], [...dirty.batchIds]);

  // on the release ledger the dirty window's rows count 2;
  // every other batch id counts exactly 1
  const counts = new Map<string, number>();
  for (const r of receiptsOf(ry)) counts.set(r.batch, (counts.get(r.batch) ?? 0) + 1);
  const others = new Set<string>();
  for (const [id, n] of counts) {
    if (dirty.batchIds.includes(id)) {
      assert.equal(n, 2, `dup row for ${id}`);
    } else {
      assert.equal(n, 1, `single row for ${id}`);
      others.add(id);
    }
  }
  for (const id of dirty.batchIds) assert.ok(counts.get(id) !== undefined, `${id} journaled`);

  // the work rows for the dup window are the same bytes twice
  for (const lane of zoneLanes()) {
    const seen = new Map<string, number>();
    for (const row of rowsBytes(ry, lane)) {
      seen.set(row.subject, (seen.get(row.subject) ?? 0) + 1);
    }
    for (const id of dirty.batchIds) {
      const sub = `${lane}.batch.${id}`;
      if (seen.has(sub)) assert.equal(seen.get(sub), 2, `${sub} re-land`);
    }
  }

  // convergence: the board, the freeze tags' final numbering, the floor
  const rr = await boardOf(ry);
  assert.deepEqual(rr, baselineBoard, "board converged");
  assert.equal(rr.freezeSeq, [...single.stats().freezes].length, "same freeze count");
  assert.equal(
    ry.consumerFloor("orders", "despatch-batch"),
    base0.consumerFloor("orders", "despatch-batch"),
  );
  assert.equal(ry.consumerFloor("orders", "despatch-batch"), 21, "all 21 rows acked");
  const seamLanes = ["quay-slots", "northspan-tours", "hearth-windows", "fluxline-verdicts"] as const;
  for (const lane of seamLanes) {
    const seen = new Map<string, number>();
    for (const row of rowsBytes(ry, lane)) {
      seen.set(row.subject, (seen.get(row.subject) ?? 0) + 1);
    }
    for (const [subject, n] of seen) {
      const dirtyHit = dirty.batchIds.some(
        (id) => subject.endsWith("." + id) || subject.includes("." + id + "."),
      );
      assert.equal(n, dirtyHit ? 2 : 1, `${subject} on ${lane}`);
    }
  }
  // nothing extra, nothing missing on the manifest
  const baseCounts = new Map<string, number>();
  for (const r of receiptsOf(base0)) baseCounts.set(r.batch, (baseCounts.get(r.batch) ?? 0) + 1);
  assert.deepEqual(
    [...others].sort(),
    [...baseCounts.keys()].filter((k) => !dirty.batchIds.includes(k)).sort(),
  );
});

test("(c) hold KV resume: holds rebuilt on boot, released once, tombstoned", async () => {
  const day = dayByKey("average-day");
  const hy = new MemoryYard();

  const z2 = workLane(1);
  for (let z = 0; z < 4; z++) {
    const lane = workLane(z);
    const crew = `crew-z${z + 1}`;
    await hy.attachConsumer(lane, crew, (d) => {
      if (z === 1) return; // the silent crew
      void hy.ackRow(lane, crew, d.seq);
    });
  }

  const A = new DespatchWes(hy, SLOTTING, { ...optsFor(day), pendingCap: 4 });
  await A.boot();
  await stageOrders(hy, day.orders.slice(0, 40));
  await A.finalize();

  const held = receiptsOf(hy).filter((r) => r.status === "held");
  assert.ok(held.length > 0, "holds engage under the silent crew");
  const holdKeys = (await hy.kvKeys("despatch-pace")).filter((k) => k.startsWith("hold."));
  assert.equal(holdKeys.length, held.length);

  const boardBefore = await hy.kvGet("despatch-pace", "board");
  const boardHexBefore = hexOf(boardBefore.payload);

  // A is abandoned; B rebuilds its hold ledger from the pace KV
  const B = new DespatchWes(hy, SLOTTING, { ...optsFor(day), pendingCap: 4 });
  await B.boot();
  // recovery walks pass by pass: releases are cap-bounded per probe and
  // each published row parks pending until the crew acks it
  let st = await B.finalize();
  for (let pass = 0; pass < 100; pass++) {
    const relSoFar = new Set(
      receiptsOf(hy).filter((r) => r.status === "released").map((r) => r.batch),
    );
    if (held.every((h) => relSoFar.has(h.batch))) break;
    for (const r of hy.msgRows(z2)) await hy.ackRow(z2, "crew-z2", r.seq);
    st = await B.finalize();
  }

  const rel = new Map<string, (typeof held)[number]>();
  for (const r of receiptsOf(hy)) {
    if (r.status !== "released") continue;
    assert.ok(!rel.has(r.batch), "one released row per batch");
    rel.set(r.batch, r);
  }
  for (const h of held) {
    const r = rel.get(h.batch);
    assert.ok(r !== undefined, `held batch ${h.batch} resolved after resume`);
    assert.deepEqual([...r.orders], [...h.orders], "work content survived the crash");
    assert.ok(r.effectiveSec >= r.releaseSec);
  }
  assert.equal(st.holdsResolved, held.length, "every hold resolved");
  const keys = await hy.kvKeys("despatch-pace");
  assert.equal(keys.filter((k) => k.startsWith("hold.")).length, 0, "tombs walked off");
  for (const r of hy.msgRows(z2)) await hy.ackRow(z2, "crew-z2", r.seq);
  const boardAfter = await hy.kvGet("despatch-pace", "board");
  const boardHexAfter = hexOf(boardAfter.payload);
  assert.equal(boardHexAfter, boardHexBefore, "resolves never touch the board");
  assert.equal((await hy.laneState(z2)).pending, 0);
  for (const lane of zoneLanes()) {
    for (const row of workRowsOf(hy, lane)) {
      assert.equal(row.effectiveSec > 0, true, `${lane} released with a real instant`);
    }
  }
});

function hexOf(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
