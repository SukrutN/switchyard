/* gangway — dock appointments, arrival pressure, unload order, door fitness.
   Harbor & Lane day 07. Stateless: same day in, same reading out. */

export { mulberry32 } from "./src/rng.ts"
export { streetDm, trailerDm, assignFitness, assignRandom, totalDm, cartonCount } from "./src/doors.ts"
export { availableMin, capMin, classSlots, book } from "./src/book.ts"
export { arrive } from "./src/arrive.ts"
export { sequence } from "./src/sequence.ts"
export { run, stretch, loadCurve } from "./src/day.ts"
export { HARBOR } from "./fixtures/harbor.ts"

export type {
  AisleId,
  Appointment,
  Arrival,
  Cartons,
  CurvePoint,
  DockDay,
  LaborWindow,
  QueueHold,
  Reading,
  Refusal,
  Request,
  TrailerClass,
  Unload,
} from "./src/types.ts"
