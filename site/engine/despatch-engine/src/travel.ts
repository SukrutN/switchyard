/* ============================================================
   travel — the routing-free travel proxy.

   No TSP solver lives here: the despatch board's money is won at
   aisle-indexed granularity, seconds before routes are planned
   (northspan's job). The proxy is the classic traversal model:

   · horizontal: a front cross-aisle sweep from the depot mouth
     out to the farthest visited aisle and back;
   · vertical: every visited aisle is walked in to its deepest
     pick and back out;
   · every pick face costs one stop.

   It matches the Ratliff-Rosenthal solvable case (a rectangular
   warehouse, depot on the front aisle) at the granularity
   batching decides at — which is exactly why it may stay cheap.
   ============================================================ */

import {
  SEC_PER_AISLE,
  SEC_PER_BAY,
  SEC_PER_STOP,
  ZONE_GROUP,
} from "./constants.ts";
import type { PickStop, TourLedger } from "./types.ts";

/** zone of an aisle, 0-based: three aisles per zone */
export function zoneOfAisle(aisle: number): number {
  return Math.floor((aisle - 1) / ZONE_GROUP);
}

/** aisle span names of one zone, for labels + caps */
export function zoneAisleSpan(zone: number): [number, number] {
  return [zone * ZONE_GROUP + 1, (zone + 1) * ZONE_GROUP];
}

/** the tour ledger for one stop set — every number the site draws. */
export function tourLedger(stops: readonly PickStop[]): TourLedger {
  if (stops.length === 0) {
    return {
      horizontalSec: 0,
      verticalSec: 0,
      stopsSec: 0,
      tourSec: 0,
      aislesVisited: 0,
      deepestBay: 0,
    };
  }

  let maxAisle = 0;
  let deepestBay = 0;
  const deepPerAisle = new Map<number, number>();
  for (const s of stops) {
    if (s.pos.aisle > maxAisle) maxAisle = s.pos.aisle;
    const prev = deepPerAisle.get(s.pos.aisle) ?? 0;
    if (s.pos.bay > prev) {
      deepPerAisle.set(s.pos.aisle, s.pos.bay);
      if (s.pos.bay > deepestBay) deepestBay = s.pos.bay;
    }
  }

  const horizontalSec = 2 * (maxAisle - 1) * SEC_PER_AISLE;
  let verticalSec = 0;
  for (const deep of deepPerAisle.values()) {
    verticalSec += 2 * deep * SEC_PER_BAY;
  }
  const stopsSec = stops.length * SEC_PER_STOP;

  return {
    horizontalSec: round3(horizontalSec),
    verticalSec: round3(verticalSec),
    stopsSec,
    tourSec: round3(horizontalSec + verticalSec + stopsSec),
    aislesVisited: deepPerAisle.size,
    deepestBay,
  };
}

/** merged stops for a batch: same sku, one qty — one face, one stop. */
export function mergeStops(
  stopSets: readonly (readonly PickStop[])[],
): PickStop[] {
  const bySku = new Map<string, PickStop>();
  for (const set of stopSets) {
    for (const s of set) {
      const prev = bySku.get(s.sku);
      if (prev) {
        bySku.set(s.sku, { ...s, qty: prev.qty + s.qty });
      } else {
        bySku.set(s.sku, { ...s });
      }
    }
  }
  // canonical face order: aisle, then bay — the picker's own sweep
  return [...bySku.values()].sort(
    (a, b) => a.pos.aisle - b.pos.aisle || a.pos.bay - b.pos.bay,
  );
}

/** the proxy tour of one batch's stops. */
export function tourSecOf(stops: readonly PickStop[]): number {
  return tourLedger(stops).tourSec;
}

/** the property the batching lives on: co-picking never costs more
    than the parts. The union shares aisles (deepest wins, the rest
    is shared) and shares stop faces (same sku merges), and the
    horizontal sweep can only shrink: max ≤ sum, always. */
export function atLeastFree(
  parts: readonly number[],
  unionSec: number,
): boolean {
  const sum = parts.reduce((a, b) => a + b, 0);
  return unionSec <= sum + 1e-9;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
