/* ============================================================
   stateless — the engine carries no memory between calls: same
   input bytes in, same solution bytes out, interleaving other
   orders in between changes nothing. The bench's headline claim
   is a test, not a slogan.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import { pack } from "../index.ts";
import { PROFILES } from "../fixtures/orders.ts";
import { CARTON_LIBRARY } from "../fixtures/cartons.ts";
import { allProfiles } from "../bench/profiles.ts";

test("interleaved packs do not bleed into each other", () => {
  const packJson = (i: number) =>
    JSON.stringify(pack(PROFILES[i].order, CARTON_LIBRARY));

  const a1 = packJson(0);
  packJson(1);
  packJson(2);
  packJson(1);
  const a2 = packJson(0);
  assert.equal(a1, a2, "A packs byte-identical before and after B and C");

  const b1 = packJson(3 - 1);
  packJson(0);
  const b2 = packJson(3 - 1);
  assert.equal(b1, b2);
});

test("the bench's profile summarizer agrees the trio validates", () => {
  const all = allProfiles();
  for (const key of ["order-feather", "order-dense", "order-awkward"] as const) {
    assert.equal(all[key].reportOk, true, `${key} must validate`);
    assert.equal(all[key].solution.unfilled.length, 0);
  }
});
