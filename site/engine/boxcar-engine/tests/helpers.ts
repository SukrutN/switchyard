/* ============================================================
   helpers — micro-fixture builders for the placement tests.
   ============================================================ */

import { toTick, toGram, volumeOf } from "../src/units.ts";
import type { CartonSpec, PackUnit } from "../src/types.ts";

let autoSeq = 0;

export function mkUnit(
  sku: string,
  dims: [number, number, number], // cm, h = z
  opts: {
    family?: PackUnit["family"];
    rotate?: PackUnit["rotate"];
    weightKg?: number;
    maxLoadKg?: number;
    qty?: number;
  } = {},
): PackUnit {
  return {
    line: 1,
    sku,
    family: opts.family ?? "standard",
    seq: autoSeq++,
    dims: { x: toTick(dims[0]), y: toTick(dims[1]), z: toTick(dims[2]) },
    rotate: opts.rotate ?? "no",
    weightG: toGram(opts.weightKg ?? 0.2),
    maxLoadG: toGram(opts.maxLoadKg ?? 3.0),
  };
}

export function resetSeq(): void {
  autoSeq = 0;
}

export function mkBin(
  id: string,
  dims: [number, number, number],
  payloadKg = 15,
): CartonSpec {
  return {
    id,
    name: `test ${id}`,
    dims: { x: toTick(dims[0]), y: toTick(dims[1]), z: toTick(dims[2]) },
    payloadG: toGram(payloadKg),
    tareG: 10,
  };
}

export { volumeOf };
