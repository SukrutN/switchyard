/* Unload order. Cold before dry before parcel. A jam — late arrival,
   a door still working, the meal gap — waits for the next labor window.
   It never borrows a minute outside one. */

import type { Appointment, Arrival, DockDay, QueueHold, Unload } from "./types.ts"
import type { TrailerClass } from "./types.ts"

const RANK: Record<TrailerClass, number> = { cold: 0, dry: 1, parcel: 2 }

type Span = { start: number; end: number }

function windowIndex(day: DockDay, start: number, end: number): number {
  return day.laborWindows.findIndex((window) => start >= window.startMin && end <= window.endMin)
}

function earliest(day: DockDay, spans: Span[], ready: number, handling: number): number | null {
  const from = Math.max(0, ready)
  for (let start = from; start + handling <= day.shiftMin; start++) {
    const end = start + handling
    if (windowIndex(day, start, end) < 0) continue
    if (spans.some((span) => start < span.end && end > span.start)) continue
    return start
  }
  return null
}

export function sequence(
  day: DockDay,
  appointments: Appointment[],
  arrivals: Arrival[],
): { unloads: Unload[]; holds: QueueHold[]; pressureMin: number } {
  const arrivalOf = new Map(arrivals.map((arrival) => [arrival.id, arrival]))
  const byDoor = new Map<number, Appointment[]>()
  for (const appointment of appointments) {
    const list = byDoor.get(appointment.door) ?? []
    list.push(appointment)
    byDoor.set(appointment.door, list)
  }

  const unloads: Unload[] = []
  const holds: QueueHold[] = []
  let pressureMin = 0

  for (const [door, list] of byDoor) {
    const live = list.filter((appointment) => arrivalOf.get(appointment.id)?.outcome === "arrived")
    live.sort((a, b) => {
      const byClass = RANK[a.klass] - RANK[b.klass]
      if (byClass !== 0) return byClass
      if (a.requestedMin !== b.requestedMin) return a.requestedMin - b.requestedMin
      return a.id < b.id ? -1 : 1
    })
    const spans: Span[] = []
    for (const appointment of live) {
      const arrival = arrivalOf.get(appointment.id)!
      const ready = arrival.actualMin ?? 0
      const start = earliest(day, spans, ready, appointment.handlingMin)
      if (start === null) {
        holds.push({ id: appointment.id, door, reason: "no-window" })
        continue
      }
      const waitMin = Math.max(0, start - ready)
      pressureMin += waitMin
      spans.push({ start, end: start + appointment.handlingMin })
      unloads.push({
        id: appointment.id,
        carrier: appointment.carrier,
        klass: appointment.klass,
        door,
        startMin: start,
        endMin: start + appointment.handlingMin,
        waitMin,
        windowIndex: windowIndex(day, start, start + appointment.handlingMin),
      })
    }
  }

  unloads.sort((a, b) => a.startMin - b.startMin || a.door - b.door || (a.id < b.id ? -1 : 1))
  return { unloads, holds, pressureMin }
}
