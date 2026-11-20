/* ============================================================
   characterization — the locked trio (see fixtures/expected.ts).
   Locked 2026-10-24 by the engine itself; tolerance ±0.006 keeps
   float noise honest while any behavioural drift fails loud.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import { pack, validateSolution } from "../index.ts";
import { PROFILES } from "../fixtures/orders.ts";
import { CARTON_LIBRARY } from "../fixtures/cartons.ts";
import { LOCKED_PROFILES } from "../fixtures/expected.ts";

const KEYS = ["order-feather", "order-dense", "order-awkward"] as const;

test("the trio validates: no floating, no overlap, no weight lie", () => {
  for (const key of KEYS) {
    const profile = PROFILES.find((p) => p.raw.id === key)!;
    const sol = pack(profile.order, CARTON_LIBRARY);
    const report = validateSolution(sol);
    assert.equal(
      report.ok,
      true,
      `${key} must validate: ${report.checks
        .filter((c) => !c.ok)
        .map((c) => `${c.id}: ${c.reason}`)
        .join(" | ")}`,
    );
  }
});

test("carton counts and the template story are locked", () => {
  for (const key of KEYS) {
    const profile = PROFILES.find((p) => p.raw.id === key)!;
    const sol = pack(profile.order, CARTON_LIBRARY);
    const locked = LOCKED_PROFILES[key];
    assert.equal(sol.cartons.length, locked.cartons, `${key} carton count`);
    const ids = sol.cartons.map((c) => c.template.id);
    assert.deepEqual(ids, locked.templates, `${key} template lineup`);
  }
});

test("cube utilization is locked per profile", () => {
  for (const key of KEYS) {
    const profile = PROFILES.find((p) => p.raw.id === key)!;
    const sol = pack(profile.order, CARTON_LIBRARY);
    const locked = LOCKED_PROFILES[key];
    assert.ok(
      Math.abs(sol.cubeUtilization - locked.cubeUtilization) < 0.006,
      `${key} cube util drifted: ${sol.cubeUtilization} vs ${locked.cubeUtilization}`,
    );
    assert.ok(
      Math.abs(sol.weightMargin - locked.weightMargin) < 0.006,
      `${key} weight margin drifted`,
    );
    assert.ok(Math.abs(sol.score - locked.score) < 0.002, `${key} score drift`);
  }
});

test("solutions serialize deterministically (byte-stable JSON)", () => {
  for (const key of KEYS) {
    const profile = PROFILES.find((p) => p.raw.id === key)!;
    const a = JSON.stringify(pack(profile.order, CARTON_LIBRARY));
    const b = JSON.stringify(pack(profile.order, CARTON_LIBRARY));
    assert.equal(a, b, "same order bytes in, same solution bytes out");
  }
});
