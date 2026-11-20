/* ============================================================
   report — the grading bench catches mutations. A cloned
   solution is bent in each direction the packer could have
   lied; the validation report must light up with the reason.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import { pack, validateSolution } from "../index.ts";
import { MIXED_AWKWARD_RAW, DENSE_CUBES_RAW } from "../fixtures/orders.ts";
import { toOrderInput } from "../index.ts";
import { CARTON_LIBRARY } from "../fixtures/cartons.ts";
import type { ShipSolution } from "../index.ts";

function awkwardSolution(): ShipSolution {
  return pack(toOrderInput(MIXED_AWKWARD_RAW), CARTON_LIBRARY);
}

test("clean clones pass every check", () => {
  const report = validateSolution(awkwardSolution());
  assert.ok(report.ok);
  const ids = new Set(report.checks.map((c) => c.id));
  for (const id of ["BOUNDS", "OVERLAP", "FLOATING", "LOAD", "WEIGHT", "STABILITY", "MERGE"] as const) {
    assert.ok(ids.has(id), `${id} is graded`);
  }
});

test("lifting a box creates a floater the bench catches", () => {
  const sol = awkwardSolution();
  const lifted = structuredClone(sol);
  lifted.cartons[0].boxes[0].pos.z += 500;
  const report = validateSolution(lifted);
  assert.equal(report.ok, false);
  const floating = report.checks.find((c) => c.id === "FLOATING")!;
  assert.equal(floating.ok, false);
  assert.match(floating.reason, /floating/);
});

test("shifting a box into its neighbour screams OVERLAP", () => {
  const sol = awkwardSolution();
  const shifted = structuredClone(sol);
  const box = shifted.cartons[0].boxes[0];
  // slide half its own width onto a neighbour: whatever sits there
  // now shares an interior point
  const neighbour = shifted.cartons[0].boxes.find(
    (b) => b.unit.seq !== box.unit.seq,
  );
  assert.ok(neighbour);
  box.pos.x = neighbour.pos.x + Math.ceil(neighbour.dims.x / 2);
  const report = validateSolution(shifted);
  const overlap = report.checks.find((c) => c.id === "OVERLAP")!;
  assert.equal(overlap.ok, false);
  assert.match(overlap.reason, /intersections/);
});

test("a box past the wall is a BOUNDS breach with the carton named", () => {
  const sol = awkwardSolution();
  const punched = structuredClone(sol);
  const box = punched.cartons[0].boxes[0];
  box.pos.x += box.dims.x; // its far face now clears the near wall
  const report = validateSolution(punched);
  const bounds = report.checks.filter((c) => c.id === "BOUNDS");
  assert.ok(bounds.length >= 1);
  assert.equal(bounds.some((c) => !c.ok), true);
});

test("an unfillable SKU is reported UNFILLED, not faked or crashed", () => {
  const raw = structuredClone(DENSE_CUBES_RAW);
  raw.lines.push({
    line: 9,
    sku: "CRATE-XXL",
    family: "standard",
    qty: 1,
    dims: { x: 70.0, y: 60.0, z: 50.0 },
    rotate: "any",
    weightKg: 2.0,
    maxLoadKg: 4.0,
  });
  const sol = pack(toOrderInput(raw), CARTON_LIBRARY);
  assert.equal(sol.unfilled.length, 1);
  assert.equal(sol.unfilled[0].sku, "CRATE-XXL");
  assert.match(sol.unfilled[0].reason, /exceed/);
  // everything else still shipped and still validates
  const report = validateSolution(sol);
  assert.equal(report.ok, false); // UNFILLED line trips the gate
  const unfilled = report.checks.find((c) => c.id === "UNFILLED")!;
  assert.equal(unfilled.ok, false);
});
