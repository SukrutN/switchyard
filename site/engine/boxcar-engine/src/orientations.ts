/* ============================================================
   orientations — rotate, but respect the orientation rules.

   Six axis permutations for "any", two on-footprint spins for
   "upright", one for "no". Result is ORDERED flatten-first
   (lowest profile first): the packer tries each candidate
   orientation until one converts gravity + load + stability,
   so ordering is part of the contract, not a cosmetic choice.
   Duplicates from equal sides are dropped.
   ============================================================ */

import type { Dim3, PackUnit, Rotate } from "./types.ts";
import type { Tick } from "./units.ts";

type Triple = [Tick, Tick, Tick];

const PERMUTATIONS: Triple[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

function orientedDims(n: Dim3, p: Triple): Dim3 {
  const nT: Triple = [n.x, n.y, n.z];
  return { x: nT[p[0]], y: nT[p[1]], z: nT[p[2]] };
}

const same3 = (a: Dim3, b: Dim3) =>
  a.x === b.x && a.y === b.y && a.z === b.z;

/** Allowed candidate orientations, flatten-first ordered, deduplicated. */
export function orientationsFor(rotate: Rotate, dims: Dim3): Dim3[] {
  if (rotate === "no") return [{ ...dims }];

  const list: Dim3[] = [];
  if (rotate === "upright") {
    list.push({ ...dims });
    list.push({ x: dims.y, y: dims.x, z: dims.z });
  } else {
    for (const p of PERMUTATIONS) list.push(orientedDims(dims, p));
  }

  const seen: Dim3[] = [];
  for (const d of list) {
    if (!seen.some((s) => same3(s, d))) seen.push(d);
  }
  seen.sort(
    (a, b) => a.z - b.z || Math.max(a.x, a.y) - Math.max(b.x, b.y) || a.x - b.x,
  );
  return seen;
}

/** Same list, on a full unit (the packer's general entry). */
export function orientationsForUnit(u: PackUnit): Dim3[] {
  return orientationsFor(u.rotate, u.dims);
}
