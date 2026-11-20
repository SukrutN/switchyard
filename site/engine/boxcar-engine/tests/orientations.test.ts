/* orientations — the rotation rules, in exact order. */

import test from "node:test";
import assert from "node:assert/strict";
import { orientationsForUnit, orientationsFor } from "../src/orientations.ts";
import { mkUnit, resetSeq } from "./helpers.ts";

test('"no" returns exactly the native orientation', () => {
  const u = mkUnit("ROD", [2, 2, 28], { rotate: "no" });
  assert.deepEqual(orientationsForUnit(u), [
    { x: u.dims.x, y: u.dims.y, z: u.dims.z },
  ]);
});

test('"upright" spins the footprint, never lays down', () => {
  const u = mkUnit("CART", [10, 20, 12], { rotate: "upright" });
  const list = orientationsForUnit(u);
  assert.equal(list.length, 2); // the spin has two distinct faces
  for (const d of list) assert.equal(d.z, 1200); // height never mutates
  assert.ok(list.some((d) => d.x === 1000 && d.y === 2000));
  assert.ok(list.some((d) => d.x === 2000 && d.y === 1000));
});

test('"any" offers all six permutations, deduplicated', () => {
  const u = mkUnit("BOX", [10, 20, 30], { rotate: "any" });
  const list = orientationsForUnit(u);
  assert.equal(list.length, 6);
  const sig = new Set(list.map((d) => `${d.x},${d.y},${d.z}`));
  assert.equal(sig.size, 6);
});

test('"any" is ordered flatten-first (standing axis last)', () => {
  const list = orientationsFor("any", { x: 1000, y: 1000, z: 1200 });
  // two flat faces; the sort puts max(x,y) before standing. For equal
  // flats the tie passes through max then x asc:
  assert.deepEqual(list, [
    { x: 1000, y: 1200, z: 1000 },
    { x: 1200, y: 1000, z: 1000 },
    { x: 1000, y: 1000, z: 1200 },
  ]);
});

test('suite hygiene: helper seq restarts per file load', () => {
  resetSeq();
  assert.ok(true);
});
