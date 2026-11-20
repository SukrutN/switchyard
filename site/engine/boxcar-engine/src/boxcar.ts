/* ============================================================
   boxcar — the pack-out entry. Stateless on purpose: same order
   bytes in, same solution bytes out, no hidden module state, no
   clock, no RNG. The bench double-checks that promise.
   ============================================================ */

import type {
  CartonSpec,
  CartonSpecRaw,
  PackUnit,
  OrderInput,
  ShipSolution,
  UnfilledLine,
  OrderInputRaw,
} from "./types.ts";
import { toTick, toGram, volumeOf } from "./units.ts";
import { chooseRun, sortLibrary } from "./selector.ts";
import { CARTON_PENALTY, MARGIN_WEIGHT } from "./constants.ts";
import { orientationsForUnit } from "./orientations.ts";

export type { CartonSpecRaw, OrderInputRaw };

export function toOrderInput(raw: OrderInputRaw): OrderInput {
  return {
    id: raw.id,
    name: raw.name,
    lines: raw.lines.map((l) => ({
      line: l.line,
      sku: l.sku,
      family: l.family,
      qty: l.qty,
      dims: { x: toTick(l.dims.x), y: toTick(l.dims.y), z: toTick(l.dims.z) },
      rotate: l.rotate,
      weightG: toGram(l.weightKg),
      maxLoadG: toGram(l.maxLoadKg),
    })),
  };
}

export function toCartonSpec(raw: CartonSpecRaw): CartonSpec {
  return {
    id: raw.id,
    name: raw.name,
    dims: {
      x: toTick(raw.dims.x),
      y: toTick(raw.dims.y),
      z: toTick(raw.dims.z),
    },
    payloadG: toGram(raw.payloadKg),
    tareG: toGram(raw.tareKg),
  };
}

/** qty expanded, stable global sequence (line order), bigger-first sort. */
export function sequenceUnits(order: OrderInput): PackUnit[] {
  const units: PackUnit[] = [];
  let seq = 0;
  for (const line of order.lines) {
    for (let k = 0; k < line.qty; k++) {
      units.push({
        line: line.line,
        sku: line.sku,
        family: line.family,
        seq: seq++,
        dims: line.dims,
        rotate: line.rotate,
        weightG: line.weightG,
        maxLoadG: line.maxLoadG,
      });
    }
  }
  units.sort(
    (a, b) =>
      volumeOf(b.dims) - volumeOf(a.dims) ||
      b.weightG - a.weightG ||
      a.line - b.line ||
      a.seq - b.seq,
  );
  return units;
}

/**
 * The packer. Opens cartons until the queue is empty; a head unit
 * that no template can admit is reported under `unfilled` rather
 * than breaking the run or, worse, bending a rule.
 */
export function pack(order: OrderInput, library: CartonSpec[]): ShipSolution {
  const queue = sequenceUnits(order);
  const lib = sortLibrary(library);
  const cartons: ShipSolution["cartons"] = [];
  const unfilled: UnfilledLine[] = [];

  let rest = queue;
  while (rest.length > 0) {
    const { best } = chooseRun(lib, rest);
    if (best.pack.boxes.length === 0) {
      const head = rest[0];
      unfilled.push({
        line: head.line,
        sku: head.sku,
        reason: whyNoFit(lib, head),
      });
      rest = rest.slice(1);
      continue;
    }
    cartons.push(best.pack);
    rest = best.rest;
  }

  const itemVolume = sequenceUnits(order).reduce(
    (s, u) => s + volumeOf(u.dims),
    0,
  );
  const cartonVolume = cartons.reduce((s, c) => s + volumeOf(c.template.dims), 0);
  const margins = cartons.map((c) => c.weightMargin);
  const score =
    cartons.reduce((s, c) => s + c.cubeUtilization + MARGIN_WEIGHT * c.weightMargin, 0) -
    CARTON_PENALTY * cartons.length;

  return {
    order: { id: order.id, name: order.name },
    cartons,
    cubeUtilization: cartonVolume === 0 ? 0 : itemVolume / cartonVolume,
    weightMargin: margins.length === 0 ? 0 : Math.min(...margins),
    unfilled,
    score: round6(score),
  };
}

/** Why one head unit fit nothing — three honest buckets. */
export function whyNoFit(lib: CartonSpec[], unit: PackUnit): string {
  const boundsOk = lib.some((spec) =>
    orientationsForUnit(unit).some(
      (d) => d.x <= spec.dims.x && d.y <= spec.dims.y && d.z <= spec.dims.z,
    ),
  );
  if (!boundsOk) return "dims exceed every carton's inner volume";
  if (lib.every((spec) => unit.weightG > spec.payloadG)) {
    return `weight ${unit.weightG} g exceeds every carton's payload`;
  }
  return "merge, load-bearing or stability rule refuses every placement";
}

/** Round-trip float hygiene on the one derived percentage score. */
function round6(n: number): number {
  return Number(n.toFixed(6));
}
