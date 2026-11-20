/* units — the fixed-point edge stays exact. */

import test from "node:test";
import assert from "node:assert/strict";
import { toTick, toGram, fmtCm, fmtKg, volumeOf } from "../src/units.ts";

test("cm ticks: 2dp decimals convert exactly, and only once", () => {
  assert.equal(toTick(24.5), 2450);
  assert.equal(toTick(0.01), 1);
  assert.equal(toTick(60.0), 6000);
  // the drift killer: 24.499999999 stays 2450 at the edge
  assert.equal(toTick(24.499999999), 2450);
});

test("kg grams: 2dp decimals convert exactly", () => {
  assert.equal(toGram(0.35), 350);
  assert.equal(toGram(1.25), 1250);
  assert.equal(toGram(30.0), 30000);
});

test("display formats keep the 2dp contract", () => {
  assert.equal(fmtCm(2450), "24.50");
  assert.equal(fmtKg(350), "0.35");
  assert.equal(fmtKg(30000), "30.00");
});

test("tick volume is an exact integer product", () => {
  // 20×15×10 cm = 2000×1500×1000 ticks = 3e9 tick³ = 3.00 L exact
  const d = { x: toTick(20), y: toTick(15), z: toTick(10) };
  assert.equal(volumeOf(d), 3000000000);
});
