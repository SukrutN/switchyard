/* Door fitness: busiest trailer first, then the door whose street
   distance to Harbor & Lane's aisle mouths costs the fewest carton-decimetres.
   Street geometry is quay's: along the dock, then dock-to-mouth. */

import type { AisleId, Cartons, DockDay, Request } from "./types.ts"
import { mulberry32 } from "./rng.ts"

export const AISLES: AisleId[] = ["F", "G", "H"]

export function doorX(day: DockDay, door: number): number {
  return door * day.doorPitchDm
}

export function aisleX(day: DockDay, aisle: AisleId): number {
  return AISLES.indexOf(aisle) * day.aislePitchDm
}

export function streetDm(day: DockDay, door: number, aisle: AisleId): number {
  return Math.abs(doorX(day, door) - aisleX(day, aisle)) + day.dockToAisleDm
}

export function cartonCount(cartons: Cartons): number {
  return cartons.F + cartons.G + cartons.H
}

export function trailerDm(day: DockDay, cartons: Cartons, door: number): number {
  let dm = 0
  for (const aisle of AISLES) dm += cartons[aisle] * streetDm(day, door, aisle)
  return dm
}

export type DoorScore = { id: string; door: number; cartonDm: number }

/** Greedy door fitness over the whole manifest. Ties take the lower door. */
export function assignFitness(day: DockDay): DoorScore[] {
  const order = [...day.requests].sort((a, b) => {
    const byCartons = cartonCount(b.cartons) - cartonCount(a.cartons)
    if (byCartons !== 0) return byCartons
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return order.map((request) => {
    let bestDoor = 0
    let best = trailerDm(day, request.cartons, 0)
    for (let door = 1; door < day.doorCount; door++) {
      const cost = trailerDm(day, request.cartons, door)
      if (cost < best) {
        best = cost
        bestDoor = door
      }
    }
    return { id: request.id, door: bestDoor, cartonDm: best }
  })
}

/** Seeded uniform doors, request-id order. The baseline, not the plan. */
export function assignRandom(day: DockDay): DoorScore[] {
  const rng = mulberry32(day.seed + 1)
  const order = [...day.requests].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return order.map((request) => {
    const door = Math.floor(rng() * day.doorCount)
    return { id: request.id, door, cartonDm: trailerDm(day, request.cartons, door) }
  })
}

export function totalDm(scores: DoorScore[]): number {
  return scores.reduce((sum, score) => sum + score.cartonDm, 0)
}

export function doorOf(scores: DoorScore[]): Map<string, number> {
  return new Map(scores.map((score) => [score.id, score.door]))
}

export function byId(requests: Request[]): Request[] {
  return [...requests].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
