/* ============================================================
   stability — the contact-ratio gate at the admission door.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import { BinRunner } from "../src/placement.ts";
import { STABILITY_RATIO } from "../src/constants.ts";
import { mkUnit, resetSeq, mkBin } from "./helpers.ts";

test(`STABILITY gate holds the contact ratio ≥ ${STABILITY_RATIO}`, () => {
  assert.ok(STABILITY_RATIO > 0.5 && STABILITY_RATIO < 1);
});

test("a wide lid on narrow ridge bars: over the flank, the gate refuses", () => {
  resetSeq();
  const bin = new BinRunner(mkBin("TALL", [30, 20, 20]));
  // two bars fill the north half of the floor
  const bar1 = mkUnit("BAR-1", [15, 10, 10]);
  assert.ok(bin.tryPlace(bar1));
  const bar2 = mkUnit("BAR-2", [15, 10, 10]);
  assert.ok(bin.tryPlace(bar2));

  // The lid 30×20×6 would touch 0.5 of its base — below the gate —
  // and the remaining floor cannot host a 20-deep, 30-wide lid either.
  // The gate must refuse it everywhere in this bin.
  const lid = mkUnit("LID", [30, 20, 6], { weightKg: 0.3 });
  assert.equal(bin.tryPlace(lid), false);
});

test("a lid meeting the ratio rides the ridge at the right elevation", () => {
  resetSeq();
  const bin = new BinRunner(mkBin("TALL", [30, 20, 20]));
  // four bars tile the floor fully: the lid touches 1.0 of its base
  const bar1 = mkUnit("BAR-A", [15, 10, 10]);
  assert.ok(bin.tryPlace(bar1));
  const bar2 = mkUnit("BAR-B", [15, 10, 10]);
  assert.ok(bin.tryPlace(bar2));
  const bar3 = mkUnit("BAR-C", [15, 10, 10]);
  assert.ok(bin.tryPlace(bar3));
  const bar4 = mkUnit("BAR-D", [15, 10, 10]);
  assert.ok(bin.tryPlace(bar4));
  const lid = mkUnit("LID", [30, 20, 6], { weightKg: 0.4 });
  assert.ok(bin.tryPlace(lid));
  const placed = bin.toCartonPack().boxes.find((b) => b.unit.sku === "LID");
  assert.equal(placed!.pos.z, 1000); // exactly the bars' top
  const shares = placed!.supports
    .filter((s) => !s.floor)
    .reduce((s, x) => s + (x as { share: number }).share, 0);
  assert.ok(shares > 0.999 - 1e-9);
});
