/* One dock day: fitness doors, capped booking, seeded arrivals,
   priority unload. `stretch` repeats the manifest to draw the load curve. */

import { arrive } from "./arrive.ts"
import { availableMin, book, capMin, classSlots } from "./book.ts"
import { assignFitness, assignRandom, doorOf, totalDm } from "./doors.ts"
import { sequence } from "./sequence.ts"
import type { CurvePoint, DockDay, Reading, Request, TrailerClass } from "./types.ts"

const CLASSES: TrailerClass[] = ["parcel", "dry", "cold"]

export function stretch(day: DockDay, copies: number): DockDay {
  const requests: Request[] = []
  for (let copy = 0; copy < copies; copy++) {
    for (const request of day.requests) {
      requests.push({ ...request, id: copies === 1 ? request.id : `${request.id}#${copy + 1}` })
    }
  }
  return { ...day, requests }
}

export function run(day: DockDay): Reading {
  const fitness = assignFitness(day)
  const random = assignRandom(day)
  const booked = book(day, doorOf(fitness))
  const arrivals = arrive(day, booked.appointments)
  const unloaded = sequence(day, booked.appointments, arrivals)
  const offeredMin = day.requests.reduce((sum, request) => sum + day.handlingMin[request.klass], 0)
  const available = availableMin(day)
  return {
    availableMin: available,
    capMin: capMin(day),
    classSlots: {
      parcel: classSlots(day, "parcel"),
      dry: classSlots(day, "dry"),
      cold: classSlots(day, "cold"),
    },
    offered: day.requests.length,
    offeredMin,
    accepted: booked.appointments.length,
    refused: booked.refusals.length,
    bookedMin: booked.bookedMin,
    utilization: booked.bookedMin / available,
    arrived: arrivals.filter((arrival) => arrival.outcome === "arrived").length,
    noShows: arrivals.filter((arrival) => arrival.outcome === "no-show").length,
    queued: unloaded.holds.length,
    pressureMin: unloaded.pressureMin,
    fitnessDm: totalDm(fitness),
    randomDm: totalDm(random),
    appointments: booked.appointments,
    refusals: booked.refusals,
    arrivals,
    unloads: unloaded.unloads,
    holds: unloaded.holds,
  }
}

export function loadCurve(day: DockDay, copies: number[]): CurvePoint[] {
  return copies.map((count) => {
    const reading = run(stretch(day, count))
    return {
      copies: count,
      offeredMin: reading.offeredMin,
      bookedMin: reading.bookedMin,
      availableMin: reading.availableMin,
      utilization: reading.utilization,
      refused: reading.refused,
      queued: reading.queued,
    }
  })
}

export function classes(): TrailerClass[] {
  return CLASSES
}
