/* Facts copied from the other engines' locked fixtures.
   quay-engine/fixtures/lane.json: LN-03 is locked to A-01-L1.
   northspan standards table: Cinder counter-refill, 43.652 seconds.
   hearthlane window walk: Kiln fires, Ash hesitates.
   fluxline divert: tall, metal, light, and in-band. */

export const QUAY_FACE = {
  sku: "LN-03",
  slotId: "A-01-L1",
  aisleIndex: 0,
  bay: 1,
} as const

export const NORTHSPAN_CIN = {
  run: "CIN",
  seconds: 43.652,
} as const

export const HEARTH_FIRE = {
  id: "W-1",
  decision: "fire",
  reason: "The window is granted and the Dispatch Apron is clear at the departure.",
} as const

export const HEARTH_HOLD = {
  id: "W-2",
  decision: "hesitate",
  reason: "The Main Run carries conflict density in ticks 4\u20137.",
} as const

export const FLUX_CASES = [
  { heightMm: 180, metal: true, weightKg: 1, gate: "L03" },
  { heightMm: 140, metal: true, weightKg: 5, gate: "L02" },
  { heightMm: 140, metal: false, weightKg: 1, gate: "RJ" },
  { heightMm: 150, metal: false, weightKg: 6, gate: "L01" },
] as const
