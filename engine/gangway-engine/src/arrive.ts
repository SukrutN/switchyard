/* Booked versus actual. The seed draws no-shows first, then a symmetric
   lateness, one accepted appointment at a time in id order. */

import type { Appointment, Arrival, DockDay } from "./types.ts"
import { mulberry32 } from "./rng.ts"

export function arrive(day: DockDay, appointments: Appointment[]): Arrival[] {
  const rng = mulberry32(day.seed)
  const order = [...appointments].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return order.map((appointment) => {
    if (rng() < day.noShowRate) {
      return { id: appointment.id, outcome: "no-show", actualMin: null, lateMin: null }
    }
    const lateMin = Math.round((rng() * 2 - 1) * day.lateSpreadMin)
    return {
      id: appointment.id,
      outcome: "arrived",
      actualMin: appointment.startMin + lateMin,
      lateMin,
    }
  })
}
