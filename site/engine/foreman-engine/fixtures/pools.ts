/* ============================================================
   The bench. Bramble & Twine carries ten pickers' worth of
   paid weekly hours, split three ways by band. A band is a
   speed factor on the zone standard, so covering one standard
   hour at day band costs 1/0.85 paid hours — the conversion the
   sheet-05 matrix turns into the labor plan.

   Floors: Cinder is a hot run and anchors on veterans; the flow
   runs take day band or better; Cobalt tolerates the night desk.
   ============================================================ */

import type { BandId, ZoneCode, PoolBand, ShiftId } from "../src/types.ts";

export const BANDS: PoolBand[] = [
  { id: "veteran", name: "Veteran", factor: 1.0, count: 2, hoursCap: 40 },
  { id: "day", name: "Day", factor: 0.85, count: 3, hoursCap: 40 },
  { id: "night", name: "Night", factor: 0.7, count: 2, hoursCap: 24 },
];

/** Bands ordered strongest factor first; the casing fills down this order. */
export const BAND_ORDER: BandId[] = ["veteran", "day", "night"];

/** How deep a zone may reach: its weakest allowed band (strongest = index 0). */
export const ZONE_FLOORS: Record<ZoneCode, BandId> = {
  CIN: "veteran",
  LOA: "day",
  FLI: "day",
  REE: "day",
  COB: "night",
};

/** Share of each zone's weekly hours the night shift carries. */
export const SHIFT_SHARE: Record<ShiftId, number> = { day: 0.72, night: 0.28 };
