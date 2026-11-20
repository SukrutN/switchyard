/* ============================================================
   replay.test — the sheet's first law: journal replay is
   deterministic, and the streaming lane mode IS the engine's
   batchOnline. Two fresh MemoryYards over the same staged day
   must journal byte-identical lanes; the freeze ledger of one
   pass must match `batchOnline(orders, 90, SLOTTING)` field by
   field (freezeSec, batchIds, orderIds, lines, the /W{n} tags);
   and the locked figures in fixtures/expected.ts must hold.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import { batchOnline } from "../../despatch-engine/index.ts";
import { SLOTTING } from "../../despatch-engine/fixtures/dc.ts";
import {
  boardOf,
  digestOf,
  quarantinesOf,
  receiptsOf,
  rowsBytes,
  runShift,
  windowsOf,
} from "../fixtures/daylane.ts";
import { WES_LOCK, type WesDayLock } from "../fixtures/expected.ts";

const DAY_KEYS = ["average-day", "rush-morning", "seasonal-spike"] as const;
const LOCK_KEY: Record<(typeof DAY_KEYS)[number], WesDayLock> = {
  "average-day": WES_LOCK.averageDay,
  "rush-morning": WES_LOCK.rushMorning,
  "seasonal-spike": WES_LOCK.seasonalSpike,
};

const LANES = [
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

for (const key of DAY_KEYS) {
  test(`${key}: two fresh runs journal byte-identical lanes`, async () => {
    const A = await runShift(key);
    const B = await runShift(key);
    for (const lane of LANES) {
      assert.equal(digestOf(A.yard, lane), digestOf(B.yard, lane), `digest ${lane}`);
      assert.deepEqual(rowsBytes(A.yard, lane), rowsBytes(B.yard, lane), `rows ${lane}`);
    }
    assert.deepEqual(await boardOf(A.yard), await boardOf(B.yard), "board bytes");
  });

  test(`${key}: the lane mode IS batchOnline — freeze ledger parity`, async () => {
    const A = await runShift(key);
    const run = batchOnline(A.day.orders, 90, SLOTTING);
    const mine = A.stats.freezes;
    assert.equal(mine.length, run.freezes.length, "freeze count");
    for (let i = 0; i < mine.length; i++) {
      const f = mine[i];
      const e = run.freezes[i];
      assert.equal(f.n, i + 1, `freeze numbering at ${i}`);
      assert.equal(f.freezeSec, e.freezeSec, `freezeSec at ${i}`);
      assert.deepEqual([...f.batchIds], [...e.batchIds], `batchIds at ${i}`);
      assert.deepEqual([...f.orderIds], [...e.orderIds], `orderIds at ${i}`);
      assert.equal(f.lines, e.lines, `lines at ${i}`);
    }
    // every order's consumed window: the engine's publish map, lane-side
    const win = windowsOf(A.yard);
    assert.deepEqual(
      [...win.keys()].sort(),
      Object.keys(run.publish).sort(),
      "every order published exactly once",
    );
    for (const [ref, sec] of win) assert.equal(sec, run.publish[ref], ref);
  });

  test(`${key}: the locked day figures hold`, async () => {
    const A = await runShift(key);
    const lock = LOCK_KEY[key];
    assert.equal(A.stats.ordersIn, lock.orders);
    assert.equal(A.stats.freezes.length, lock.freezes);
    assert.equal(A.stats.batches, lock.batches);
    assert.equal(
      A.stats.receipts.filter((r) => r.status === "released").length,
      lock.releaseRows,
    );
    assert.deepEqual(
      [1, 2, 3, 4].map((z) => A.yard.msgRows(`work-z${z}`).length),
      [lock.workZ1, lock.workZ2, lock.workZ3, lock.workZ4],
    );
    assert.equal(digestOf(A.yard, "despatch-release"), lock.digests.release);
    assert.equal(digestOf(A.yard, "despatch-quarantine"), lock.digests.quarantine);
    assert.equal(digestOf(A.yard, "despatch-control"), lock.digests.control);
    assert.equal(digestOf(A.yard, "work-z1"), lock.digests.workZ1);
    assert.equal(digestOf(A.yard, "work-z2"), lock.digests.workZ2);
    assert.equal(digestOf(A.yard, "work-z3"), lock.digests.workZ3);
    assert.equal(digestOf(A.yard, "work-z4"), lock.digests.workZ4);

    const b = await boardOf(A.yard);
    assert.equal(b.releasedThrough, lock.board.releasedThrough);
    assert.equal(b.freezeSeq, lock.board.freezeSeq);
    assert.equal(b.nextFreeze, lock.board.nextFreeze);
    assert.deepEqual([...b.given], [...lock.board.given]);

    // a clean day quarantines nothing and holds nothing
    assert.equal(quarantinesOf(A.yard).length, 0);
    assert.equal(A.stats.held, 0);
    assert.equal(A.stats.holdsResolved, 0);
  });
}
