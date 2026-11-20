/* ============================================================
   expected — the locked characterization values for the trio.

   Locked 2026-10-24, printed by the engine they describe. The
   tests hold them to ±0.006 so float noise and cosmetic reorder
   swim underneath, but any change in the solver's behaviour is
   caught the moment it shows.
   ============================================================ */

export interface LockedProfile {
  /** number of cartons the packer opens */
  cartons: number;
  /** whole-shipment cube utilization, exact from the 2026-10-24 run */
  cubeUtilization: number;
  /** smallest per-carton weight margin */
  weightMargin: number;
  /** solver score, 3dp */
  score: number;
  /** template ids in opening order — the merge/weight story in one line */
  templates: string[];
}

export const LOCKED_PROFILES: Record<
  "order-feather" | "order-dense" | "order-awkward",
  LockedProfile
> = {
  "order-feather": {
    cartons: 2,
    cubeUtilization: 0.761,
    weightMargin: 0.81,
    score: 1.853,
    templates: ["MD-4025", "LG-5035"],
  },
  "order-dense": {
    cartons: 5,
    cubeUtilization: 0.805,
    weightMargin: 0.15,
    score: 3.853,
    templates: ["SC-3020", "SC-3020", "SC-3020", "MX-2015", "MX-2015"],
  },
  "order-awkward": {
    cartons: 2,
    cubeUtilization: 0.553,
    weightMargin: 0.81,
    score: 1.14,
    templates: ["LG-5035", "MD-4025"],
  },
};
