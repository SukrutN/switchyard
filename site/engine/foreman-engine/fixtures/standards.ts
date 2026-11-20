/* ============================================================
   The standards this planner consumes are northspan's.

   Exported verbatim from northspan-engine's counter-refill
   characterization (fixtures/kiln-annex/operation.json; locked by
   its tests, re-locked on the site at northspan/src/lib/
   standards.test.ts). The foreman carries no coefficients of its
   own: the minutes per line below ARE the locked Kiln Annex
   counter-refill speed, and the factors ARE the bands — the
   foreman prices Bramble & Twine's five runs with them, as data,
   which is the whole point of building the standards first.
   ============================================================ */

import type { BandId, ZoneCode } from "../src/types.ts";

export interface ZoneStandard {
  zone: ZoneCode;
  runName: string;
  velocity: "hot" | "flow" | "calm";
  /** Minutes per line of the counter-refill standard. */
  mplMinutes: number;
}

export const ZONE_STANDARDS: ZoneStandard[] = [
  { zone: "CIN", runName: "Cinder", velocity: "hot", mplMinutes: 0.364 },
  { zone: "LOA", runName: "Loam", velocity: "flow", mplMinutes: 0.416 },
  { zone: "FLI", runName: "Flint", velocity: "flow", mplMinutes: 0.44 },
  { zone: "REE", runName: "Reed", velocity: "flow", mplMinutes: 0.406 },
  { zone: "COB", runName: "Cobalt", velocity: "calm", mplMinutes: 0.451 },
];

/** The push factor each skill band applies to a zone's rate. */
export const BAND_FACTORS: Record<BandId, number> = {
  veteran: 1.0,
  day: 0.85,
  night: 0.7,
};

/** Fixed weekly zone supplement: counting, housekeeping, receipt. */
export const SUPPLEMENT_MINUTES = 60;
