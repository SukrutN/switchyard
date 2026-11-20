/* ============================================================
   plan, the floor of Bramble & Twine, as svg coordinates.

   One projection every panel shares: aisles are columns, bays
   run away from the front cross-aisle, the depot sits west of
   aisle 1. The tour path is the traversal proxy exactly as the
   engine pays it, along the front, into every visited aisle,
   out again, so the drawing is the arithmetic, not a metaphor.
   ============================================================ */

import type { PickStop } from "@/engine/despatch-engine/index.ts";

export const PLAN = {
  aisles: 12,
  bays: 22,
  gapX: 24, // horizontal distance between aisle column centers
  mouthX: 26, // center of aisle 1
  frontY: 62, // y of the front cross-aisle walk line
  bayGap: 9.5, // y per bay of aisle depth
  W: 322, // incl, west depot apron + east bay-ruler margin
} as const;

export function planX(aisle: number): number {
  return PLAN.mouthX + (aisle - 1) * PLAN.gapX;
}

export function planY(bay: number): number {
  return PLAN.frontY + bay * PLAN.bayGap;
}

export function planRearY(): number {
  return planY(PLAN.bays) + PLAN.bayGap * 1.5;
}

export function planH(): number {
  return planRearY() + 26;
}

/** west apron: where the depot stands */
export const DEPOT = { x: planX(1) - 16, y: PLAN.frontY } as const;

/** escape a string for an inline <title>. React 19 hoists real
    <title> children out of svg on the server, emptying them, so
    tooltips ride in as raw innerHTML instead. */
export function escTitle(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** the far right edge for clearance */
export function planEastX(): number {
  return planX(PLAN.aisles) + 12;
}

export interface PlanStop {
  readonly x: number;
  readonly y: number;
  readonly sku: string;
  readonly qty: number;
}

/** pick faces as dots: r grows with qty, capped so 6 × doesn't lie */
export function faceDots(stops: readonly PickStop[]): PlanStop[] {
  return stops.map((s) => ({
    x: planX(s.pos.aisle),
    y: planY(s.pos.bay),
    sku: s.sku,
    qty: s.qty,
  }));
}

/** deepest bay per visited aisle, insertion-ordered by aisle */
export function visitedAisles(
  stops: readonly PickStop[],
): { aisle: number; deepBay: number }[] {
  const map = new Map<number, number>();
  for (const s of stops) {
    const prev = map.get(s.pos.aisle) ?? 0;
    if (s.pos.bay > prev) map.set(s.pos.aisle, s.pos.bay);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([aisle, deepBay]) => ({ aisle, deepBay }));
}

/**
 * The tour as the proxy pays it: out the front cross-aisle from
 * the depot, into each visited aisle to its deepest pick and
 * back, home again. Pure polyline points.
 */
export function tourPath(stops: readonly PickStop[]): string {
  if (stops.length === 0) return "";
  const teeth = visitedAisles(stops);
  const pts: string[] = [`${DEPOT.x.toFixed(1)},${PLAN.frontY.toFixed(1)}`];
  for (const t of teeth) {
    const x = planX(t.aisle).toFixed(1);
    pts.push(`${x},${PLAN.frontY.toFixed(1)}`);
    pts.push(`${x},${planY(t.deepBay).toFixed(1)}`);
    pts.push(`${x},${PLAN.frontY.toFixed(1)}`);
  }
  pts.push(`${DEPOT.x.toFixed(1)},${PLAN.frontY.toFixed(1)}`);
  return pts.join(" ");
}

/** zone band rects: one per three aisles, for shading + labels */
export function zoneBands(zoneCount: number): {
  zone: number;
  x: number;
  w: number;
  label: string;
}[] {
  const out: {
    zone: number;
    x: number;
    w: number;
    label: string;
  }[] = [];
  for (let z = 0; z < zoneCount; z++) {
    const westIsle = z * 3 + 1;
    const eastIsle = z * 3 + 3;
    const x = planX(westIsle) - PLAN.gapX / 2 + 2;
    const w = planX(eastIsle) - planX(westIsle) + PLAN.gapX - 4;
    out.push({ zone: z, x, w, label: `Z${z + 1}` });
  }
  return out;
}
