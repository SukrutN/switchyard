/* ============================================================
   gravity — no floating items. The naive engine places at the
   candidate point and leaves boxes in the air; this one settles
   every admission onto the top of the stack actually beneath it.
   These tests hold the fix to exact ticks.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import { BinRunner } from "../src/placement.ts";
import { mkUnit, resetSeq, mkBin } from "./helpers.ts";

test("a unit settles onto the support stack below it, exactly", () => {
  resetSeq();
  const bin = new BinRunner(mkBin("MD", [40, 25, 25]));
  const slab = mkUnit("SLAB-A", [40, 25, 5], { maxLoadKg: 5 });
  assert.ok(bin.tryPlace(slab));

  const stackA = mkUnit("STACK-A", [10, 10, 10], { rotate: "any" });
  assert.ok(bin.tryPlace(stackA));
  const pack = bin.toCartonPack();
  const placedStack = pack.boxes.find((b) => b.unit.sku === "STACK-A");
  // settled: z = slab top (5 cm), NOT the free-space candidate origin
  assert.equal(placedStack!.pos.z, 500);
  assert.deepEqual(placedStack!.supports, [
    { floor: false, seq: slab.seq, share: 1 },
  ]);
});

test("settle skips past a neighbouring tower to the surface under it", () => {
  resetSeq();
  const bin = new BinRunner(mkBin("MD", [40, 25, 25]));
  const slab = mkUnit("SLAB-A", [40, 25, 5], { maxLoadKg: 5 });
  assert.ok(bin.tryPlace(slab));
  const a = mkUnit("STACK-A", [10, 10, 10], { rotate: "any" });
  assert.ok(bin.tryPlace(a));
  const b = mkUnit("STACK-B", [10, 10, 10], { rotate: "any" });
  assert.ok(bin.tryPlace(b));
  const pack = bin.toCartonPack();
  const placedB = pack.boxes.find((x) => x.unit.sku === "STACK-B");
  // the property that matters: b rests on the SLAB's surface (z=5,
  // share 1) — beside the first tower, never perched on its edge
  assert.equal(placedB!.pos.z, 500);
  assert.deepEqual(placedB!.supports, [
    { floor: false, seq: slab.seq, share: 1 },
  ]);
});

test("stacked layers: a unit may rest on units, never on nothing", () => {
  resetSeq();
  const bin = new BinRunner(mkBin("MD", [40, 25, 25]));
  const slab = mkUnit("SLAB-A", [40, 25, 5], { maxLoadKg: 5 });
  assert.ok(bin.tryPlace(slab));
  assert.ok(bin.tryPlace(mkUnit("STACK-A", [10, 10, 10], { rotate: "any" })));
  assert.ok(bin.tryPlace(mkUnit("STACK-B", [15, 5, 10], { rotate: "any" })));
  const c = mkUnit("STACK-C", [10, 10, 6], { rotate: "any" });
  assert.ok(bin.tryPlace(c));
  const pack = bin.toCartonPack();
  const placedC = pack.boxes.find((x) => x.unit.sku === "STACK-C");
  assert.ok(placedC!.pos.z > 0, "the slab leaves no free floor below z=5");
  assert.ok(
    placedC!.supports.every((s) => !s.floor),
    "a mid-air unit would float: supports must be units",
  );
  assert.ok(
    placedC!.supports.reduce((s, x) => s + (x as { share: number }).share, 0) >
      0.999 - 1e-9,
    "carried shares renormalize to the full unit weight",
  );
});
