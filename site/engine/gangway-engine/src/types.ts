/* The dock day is plain data. Minutes are integers from shift open.
   Distances are decimetres so the quay pitch (3.6 m, 12.4 m) stays exact. */

export type AisleId = "F" | "G" | "H"
export type TrailerClass = "parcel" | "dry" | "cold"

export type Cartons = Record<AisleId, number>

export type LaborWindow = { startMin: number; endMin: number }

export type Request = {
  id: string
  carrier: string
  klass: TrailerClass
  /** When the carrier asked to be on the door, minutes from shift open. */
  requestedMin: number
  cartons: Cartons
}

export type DockDay = {
  id: string
  name: string
  seed: number
  doorCount: number
  /** Door centres, decimetres, door 0 at the F-aisle end. */
  doorPitchDm: number
  shiftMin: number
  /** Booked door-minutes may not exceed this share of doors × shift. */
  targetUtilization: number
  handlingMin: Record<TrailerClass, number>
  noShowRate: number
  lateSpreadMin: number
  laborWindows: LaborWindow[]
  /** Quay's dock-to-first-aisle, in decimetres (Harbor & Lane: 12.4 m). */
  dockToAisleDm: number
  /** Quay's aisle pitch, in decimetres (Harbor & Lane: 3.6 m). */
  aislePitchDm: number
  requests: Request[]
}

export type Appointment = {
  id: string
  carrier: string
  klass: TrailerClass
  door: number
  requestedMin: number
  startMin: number
  endMin: number
  handlingMin: number
  cartons: Cartons
}

export type Refusal = { id: string; reason: "cap" | "no-window" }

export type Arrival = {
  id: string
  outcome: "arrived" | "no-show"
  actualMin: number | null
  lateMin: number | null
}

export type Unload = {
  id: string
  carrier: string
  klass: TrailerClass
  door: number
  startMin: number
  endMin: number
  waitMin: number
  windowIndex: number
}

export type QueueHold = { id: string; door: number; reason: "no-window" }

export type CurvePoint = {
  copies: number
  offeredMin: number
  bookedMin: number
  availableMin: number
  utilization: number
  refused: number
  queued: number
}

export type Reading = {
  availableMin: number
  capMin: number
  classSlots: Record<TrailerClass, number>
  offered: number
  offeredMin: number
  accepted: number
  refused: number
  bookedMin: number
  utilization: number
  arrived: number
  noShows: number
  queued: number
  pressureMin: number
  fitnessDm: number
  randomDm: number
  appointments: Appointment[]
  refusals: Refusal[]
  arrivals: Arrival[]
  unloads: Unload[]
  holds: QueueHold[]
}
