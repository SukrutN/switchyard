/* merge — co-pack only compatible families, both directions. */

import test from "node:test";
import assert from "node:assert/strict";
import { pack, validateSolution, coPackable, FAMILY_COMPAT } from "../index.ts";
import { MIXED_AWKWARD_RAW, PROFILES } from "../fixtures/orders.ts";
import { toOrderInput } from "../index.ts";
import { CARTON_LIBRARY } from "../fixtures/cartons.ts";

test("the compat table's fiction is exactly this fiction", () => {
  // hazard rides alone, in both directions
  assert.equal(coPackable("hazard", "hazard"), true);
  assert.equal(coPackable("hazard", "standard"), false);
  assert.equal(coPackable("standard", "hazard"), false);
  assert.equal(coPackable("hazard", "fragile"), false);
  // fragile may share with standard or fragile, never more
  assert.equal(coPackable("fragile", "standard"), true);
  assert.equal(coPackable("standard", "fragile"), true);
  assert.equal(coPackable("fragile", "fragile"), true);
  // the table is closed under its own rows
  for (const [f, g] of Object.entries(FAMILY_COMPAT)) {
    for (const other of g) {
      assert.ok(
        FAMILY_COMPAT[other as keyof typeof FAMILY_COMPAT].includes(
          f as never,
        ),
        `${f} grants ${other}, the row must read back`,
      );
    }
  }
});

test("hazard rides alone: no carton mixes hazard with anything", () => {
  const sol = pack(toOrderInput(MIXED_AWKWARD_RAW), CARTON_LIBRARY);
  const hazardCartons = sol.cartons.filter((c) =>
    c.boxes.some((b) => b.unit.family === "hazard"),
  );
  assert.ok(hazardCartons.length >= 1, "the aerosol is in the order");
  for (const c of hazardCartons) {
    const fams = new Set(c.boxes.map((b) => b.unit.family));
    assert.deepEqual(
      [...fams],
      ["hazard"],
      "hazard shares a carton with nobody",
    );
  }
  const all = validateSolution(sol);
  assert.ok(all.checks.filter((c) => c.id === "MERGE").every((c) => c.ok));
});

test("the trio profiles stay three, so a fixture edit is loud", () => {
  assert.equal(PROFILES.length, 3);
});
