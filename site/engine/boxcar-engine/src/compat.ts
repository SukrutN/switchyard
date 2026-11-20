/* ============================================================
   compat — the co-pack table.

   Fiction, but table-driven fiction: a carton may contain two
   families only if the row of each allows the other's. The merge
   rule is checked as a report line (MERGE), and the packer itself
   consults the same table before offering a unit to a running
   carton — one truth, two readers.
   ============================================================ */

import type { Family } from "./types.ts";

/**
 * Co-pack closure, symmetric by construction: a carton may hold two
 * families only when BOTH rows grant the other — which is why every
 * pair below reads both ways. Fragile rides with standard (and with
 * fragile), hazard rides alone. Rows are the one truth: the packer,
 * the merge gate and the report all read this table.
 */
export const FAMILY_COMPAT: Record<Family, Family[]> = {
  standard: ["standard", "fragile"],
  fragile: ["standard", "fragile"],
  hazard: ["hazard"],
};

export function coPackable(a: Family, b: Family): boolean {
  return FAMILY_COMPAT[a].includes(b);
}

/** Can `f` join a carton that already holds `families`? */
export function coPackables(f: Family, present: Family[]): boolean {
  return present.every((p) => coPackable(f, p) && coPackable(p, f));
}
