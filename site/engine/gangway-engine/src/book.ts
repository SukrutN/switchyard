/* Slot liability. A door-minute past the utilization cap is refused.
   A trailer the cap would allow, but no labor window can hold, queues.
   Neither path opens a shadow slot. */

import type { Appointment, DockDay, LaborWindow, Refusal, Request, TrailerClass } from "./types.ts"

type Span = { start: number; end: number }

export function availableMin(day: DockDay): number {
  return day.doorCount * day.shiftMin
}

export function capMin(day: DockDay): number {
  return Math.floor(availableMin(day) * day.targetUtilization)
}

/** (doors × hours) ÷ handling hours, floored — the all-one-class slot count. */
export function classSlots(day: DockDay, klass: TrailerClass): number {
  return Math.floor(availableMin(day) / day.handlingMin[klass])
}

function insideWindow(windows: LaborWindow[], start: number, end: number): boolean {
  return windows.some((window) => start >= window.startMin && end <= window.endMin)
}

function overlaps(spans: Span[], start: number, end: number): boolean {
  return spans.some((span) => start < span.end && end > span.start)
}

function earliestStart(day: DockDay, spans: Span[], requested: number, handling: number): number | null {
  for (let start = requested; start + handling <= day.shiftMin; start++) {
    const end = start + handling
    if (!insideWindow(day.laborWindows, start, end)) continue
    if (overlaps(spans, start, end)) continue
    return start
  }
  return null
}

export function book(
  day: DockDay,
  doors: Map<string, number>,
): { appointments: Appointment[]; refusals: Refusal[]; bookedMin: number } {
  const limit = capMin(day)
  const spans = new Map<number, Span[]>()
  for (let door = 0; door < day.doorCount; door++) spans.set(door, [])

  const appointments: Appointment[] = []
  const refusals: Refusal[] = []
  let booked = 0

  const order = [...day.requests].sort((a, b) => a.requestedMin - b.requestedMin || (a.id < b.id ? -1 : 1))
  for (const request of order) {
    const handling = day.handlingMin[request.klass]
    if (booked + handling > limit) {
      refusals.push({ id: request.id, reason: "cap" })
      continue
    }
    const door = doors.get(request.id)
    if (door === undefined) throw new Error(`no door for ${request.id}`)
    const start = earliestStart(day, spans.get(door)!, request.requestedMin, handling)
    if (start === null) {
      refusals.push({ id: request.id, reason: "no-window" })
      continue
    }
    const appointment = place(request, door, start, handling)
    spans.get(door)!.push({ start, end: appointment.endMin })
    appointments.push(appointment)
    booked += handling
  }

  return { appointments, refusals, bookedMin: booked }
}

function place(request: Request, door: number, start: number, handling: number): Appointment {
  return {
    id: request.id,
    carrier: request.carrier,
    klass: request.klass,
    door,
    requestedMin: request.requestedMin,
    startMin: start,
    endMin: start + handling,
    handlingMin: handling,
    cartons: request.cartons,
  }
}
