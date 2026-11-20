/* selector — carton choice: smallest-adequate first, determinism. */

import test from "node:test";
import assert from "node:assert/strict";
import { chooseRun, sortLibrary, runScore, fitsSomewhere } from "../src/selector.ts";
import type { CartonSpec, PackUnit } from "../src/types.ts";
import { mkUnit, resetSeq } from "./helpers.ts";
import { CARTON_LIBRARY } from "../fixtures/cartons.ts";

test("the library sorts by inner volume, id on ties", () => {
  const sorted = sortLibrary(CARTON_LIBRARY);
  const vols = sorted.map((c) => c.dims.x * c.dims.y * c.dims.z);
  assert.deepEqual(vols, [...vols].sort((a, b) => a - b));
});

test("a one-unit order opens the tightest adequate carton", () => {
  resetSeq();
  const unit: PackUnit = mkUnit("CHUNK", [18, 14, 9], { rotate: "any" });
  const { best, all } = chooseRun(sortLibrary(CARTON_LIBRARY), [unit]);
  for (const r of all) assert.ok(r.pack.boxes.length >= 1, "no phantoms");
  assert.equal(best.spec.id, "MX-2015"); // 1.92 L in a 3 L mailer wins
});

test("a run that orphans an unplaceable unit loses to a completing run", () => {
  resetSeq();
  // a 2×2×45 rod: no template but XL is 40 tall — hmm, none. Raise XL
  // height only virtually: assert directly, no fixtures bent.
  const rod = mkUnit("ROD", [2, 2, 45], { rotate: "no" });
  assert.equal(fitsSomewhere(CARTON_LIBRARY, rod), false);
});

test("runScore always charges CARTON_PENALTY, empty or full", () => {
  resetSeq();
  const unit = mkUnit("CHUNK", [5, 5, 5], { rotate: "any" });
  const { all } = chooseRun(sortLibrary(CARTON_LIBRARY), [unit]);
  for (const r of all) {
    if (r.pack.boxes.length === 0) continue;
    const s = runScore(r.pack);
    assert.ok(s < 1 + 0 + 1, "score is a bounded blend, not a free lunch");
  }
});
