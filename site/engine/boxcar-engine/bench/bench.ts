/* ============================================================
   bench — placement runtime vs order line count.

   The orders are synthetic, assembled from the trio's own lines
   (one unit per line, cycled) so the curve is honest about the
   input the family actually packs. Fixed-point work everywhere;
   the only floats are the wall clock. Determinism is re-checked
   here too: two packs of the same order must be byte-identical.

   Run: npm run bench — writes bench/results.json, which the site
   reads as a static artifact. The engine is stateless and so is
   the artifact: no timestamps in the data, only the lock date.
   ============================================================ */

import { pack, validateSolution, toOrderInput } from "../index.ts";
import { PROFILES } from "../fixtures/orders.ts";
import { CARTON_LIBRARY } from "../fixtures/cartons.ts";
import type { OrderInputRaw, OrderInput } from "../index.ts";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const sizes = [5, 10, 20, 40, 80, 160];

function synthRaw(lines: number): OrderInputRaw {
  const out: OrderInputRaw["lines"] = [];
  for (let i = 0; i < lines; i++) {
    const p = PROFILES[i % PROFILES.length];
    const src = p.raw.lines[Math.floor(i / 3) % p.raw.lines.length];
    out.push({
      line: i + 1,
      sku: `${src.sku}-${Math.floor(i / 12)}`,
      family: src.family,
      qty: 1,
      dims: { ...src.dims },
      rotate: src.rotate,
      weightKg: src.weightKg,
      maxLoadKg: src.maxLoadKg,
    });
  }
  return { id: `bench-${lines}`, name: `bench wave ×${lines} lines`, lines: out };
}

function median3(fn: () => void): number {
  const t: number[] = [];
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    fn();
    t.push(performance.now() - t0);
  }
  return Math.round(t.sort((a, b) => a - b)[1] * 100) / 100;
}

const runs = sizes.map((n) => {
  const order: OrderInput = toOrderInput(synthRaw(n));
  const packOnce = () => pack(order, CARTON_LIBRARY);
  // warm once, then time the median of three
  const probe = packOnce();
  const cartons = probe.cartons.length;
  const packMs = median3(() => void packOnce());
  const sol = packOnce();
  const validateMs = median3(() => void validateSolution(sol));
  const stable = JSON.stringify(packOnce()) === JSON.stringify(sol);
  return {
    lines: n,
    units: sol.cartons.reduce((s, c) => s + c.boxes.length, 0),
    cartons,
    cubeUtilization: Number(sol.cubeUtilization.toFixed(4)),
    packMs,
    validateMs,
    deterministic: stable,
  };
});

const results = {
  generated: "2026-10-24",
  note: "median of 3 in-process runs after one warm-up; deterministic re-check per row",
  runs,
};

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(
  join(here, "results.json"),
  JSON.stringify(results, null, 2) + "\n",
);
console.log("bench rows written to bench/results.json:");
for (const r of runs) {
  console.log(
    `  ${String(r.lines).padStart(3)} lines → ${String(r.cartons).padStart(3)} cartons, ${r.units} units, pack ${r.packMs.toFixed(3)} ms, validate ${r.validateMs.toFixed(3)} ms, stable=${r.deterministic}`,
  );
}
