/* ============================================================
   load — rated load respected, and the split-not-violate rule.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import { BinRunner } from "../src/placement.ts";
import { pack, toOrderInput, validateSolution } from "../index.ts";
import type { OrderInputRaw } from "../src/types.ts";
import { mkUnit, resetSeq, mkBin } from "./helpers.ts";
import { CARTON_LIBRARY } from "../fixtures/cartons.ts";

test("a heavy unit is refused where it would exceed the stack's rating", () => {
  resetSeq();
  const bin = new BinRunner(mkBin("SC", [30, 20, 15]));
  const plate = mkUnit("BASE-PLATE", [30, 20, 5], { maxLoadKg: 0.3 });
  assert.ok(bin.tryPlace(plate));

  const heavy = mkUnit("HEAVY", [15, 10, 10], { weightKg: 0.6 });
  // the plate's floor is fully covered: the only conversions are on
  // top of it, and 0.6 kg > rated 0.3 kg → the chain vetoes every one
  assert.equal(bin.tryPlace(heavy), false);
});

test("a heavy unit under the rating rides the stack, to the gram", () => {
  resetSeq();
  const bin = new BinRunner(mkBin("SC", [30, 20, 15]));
  const plate = mkUnit("BASE-PLATE", [30, 20, 5], { maxLoadKg: 0.3 });
  assert.ok(bin.tryPlace(plate));
  const light = mkUnit("LIGHT", [15, 10, 10], { weightKg: 0.29 });
  assert.ok(bin.tryPlace(light));
  const pack = bin.toCartonPack();
  const placed = pack.boxes.find((b) => b.unit.sku === "LIGHT");
  assert.equal(placed!.pos.z, 500); // settled on the plate
});

test("weight-invalid pack-outs split to an extra carton, never violate", () => {
  const raw: OrderInputRaw = {
    id: "order-split",
    name: "split-not-violate",
    lines: [
      {
        line: 1,
        sku: "BASE-PLATE",
        family: "standard",
        qty: 1,
        dims: { x: 30.0, y: 20.0, z: 5.0 },
        rotate: "no",
        weightKg: 0.2,
        maxLoadKg: 0.3,
      },
      {
        line: 2,
        sku: "HEAVY",
        family: "standard",
        qty: 1,
        dims: { x: 15.0, y: 10.0, z: 10.0 },
        rotate: "any",
        weightKg: 0.6,
        maxLoadKg: 6.0,
      },
    ],
  };
  const sol = pack(toOrderInput(raw), CARTON_LIBRARY);
  assert.ok(sol.unfilled.length === 0, "nothing may be unfilled");
  assert.ok(sol.cartons.length === 2, "the heavy unit earns its own carton");
  const report = validateSolution(sol);
  const load = report.checks.filter((c) => c.id === "LOAD");
  assert.ok(load.length > 0 && load.every((c) => c.ok));
  // the plate's carton must not secretly contain the heavy box
  const plateCarton = sol.cartons.find((c) =>
    c.boxes.some((b) => b.unit.sku === "BASE-PLATE"),
  );
  assert.ok(
    plateCarton!.boxes.every((b) => b.unit.sku !== "HEAVY"),
    "no violation, no cargo stacking on an overweight base",
  );
  assert.ok(report.ok);
});
