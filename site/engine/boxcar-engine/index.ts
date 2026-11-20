/* ============================================================
   boxcar-engine — public surface.
   `pack` is the door; `validateSolution` is the grading bench;
   the rest is vocabulary the site needs to render honestly.
   ============================================================ */

export { pack, sequenceUnits, toOrderInput, toCartonSpec, whyNoFit } from "./src/boxcar.ts";
export type { OrderInputRaw } from "./src/boxcar.ts";
export { validateSolution, surfaceContacts } from "./src/validate.ts";
export { runBin, runScore, chooseRun, sortLibrary } from "./src/selector.ts";
export { BinRunner } from "./src/placement.ts";
export { orientationsForUnit, orientationsFor } from "./src/orientations.ts";
export { FAMILY_COMPAT, coPackable, coPackables } from "./src/compat.ts";
export {
  STABILITY_RATIO,
  CARTON_PENALTY,
  MARGIN_WEIGHT,
} from "./src/constants.ts";
export { toTick, toGram, fmtCm, fmtKg, volumeOf } from "./src/units.ts";
export type {
  Tick,
  Gram,
  Dim3,
  Vec3,
} from "./src/units.ts";
export type {
  Family,
  Rotate,
  OrderLine,
  OrderInput,
  CartonSpec,
  PackUnit,
  PlacedBox,
  Support,
  CartonPack,
  UnfilledLine,
  ShipSolution,
  CheckLine,
  ValidationReport,
} from "./src/types.ts";
