/* ============================================================
   types — the fixture vocabulary the whole family speaks.

   An order line is what the WES hands the packer. A carton is
   what the library owns. Fragility is a family class, fiction
   kept honest: co-pack rules are table-driven, not vibes.
   ============================================================ */

import type { Dim3, Tick, Gram } from "./units.ts";

/** Re-exported: types.ts is the vocabulary hub for the family. */
export type { Dim3, Vec3, Tick, Gram } from "./units.ts";

/**
 * Fragility class. `standard` rides anywhere, `fragile` may share a
 * carton but refuses `hazard`, `hazard` rides alone. The table lives
 * in compat.ts and the merge rule is a validated report line, not a
 * convention.
 */
export type Family = "standard" | "fragile" | "hazard";

/**
 * Rotation freedom, in the order the engine will respect it:
 *  - "no":      exactly the native orientation
 *  - "upright": may spin on its footprint (x↔y), never lays down
 *  - "any":     all six axis-permutations
 */
export type Rotate = "no" | "upright" | "any";

/** One order line, authored in cm/kg with 2 decimals. */
export interface OrderLine {
  line: number;
  sku: string;
  family: Family;
  qty: number;
  /** native dims, x × y footprint, z = standing height */
  dims: Dim3;
  rotate: Rotate;
  /** weight per unit */
  weightG: Gram;
  /** how much this unit may carry above it before its load rule trips */
  maxLoadG: Gram;
}

/** One order: the input the engine is stateless about. */
export interface OrderInput {
  id: string;
  name: string;
  lines: OrderLine[];
}

/** One carton template from the library. */
export interface CartonSpec {
  id: string;
  name: string;
  /** inner dims */
  dims: Dim3;
  /** max total payload weight */
  payloadG: Gram;
  /** the carton's own weight, reported but not packed */
  tareG: Gram;
}

/** A single unpacked unit of a line (qty expanded away). */
export interface PackUnit {
  line: number;
  sku: string;
  family: Family;
  /** stable global sequence, derived once, never shuffled */
  seq: number;
  dims: Dim3;
  rotate: Rotate;
  weightG: Gram;
  maxLoadG: Gram;
}

/** Result may place on the floor or on top of other boxes. */
export type Support =
  | { floor: true; share: number }
  | { floor: false; seq: number; share: number };

/** One placed box, coordinates in ticks, origin = carton inner corner. */
export interface PlacedBox {
  unit: PackUnit;
  pos: { x: Tick; y: Tick; z: Tick };
  dims: Dim3;
  /** what this box's bottom actually touched, with area share */
  supports: Support[];
}

/** One packed carton. */
export interface CartonPack {
  template: CartonSpec;
  boxes: PlacedBox[];
  /** payload weight, grams */
  payloadG: Gram;
  /** capacity headroom left after packing, 0..1 */
  weightMargin: number;
  /** placed volume / inner volume, 0..1 */
  cubeUtilization: number;
}

export interface UnfilledLine {
  line: number;
  sku: string;
  reason: string;
}

/** The full pack-out for one order. */
export interface ShipSolution {
  order: { id: string; name: string };
  cartons: CartonPack[];
  /** whole-shipment utilization: Σ item volume / Σ carton inner volume */
  cubeUtilization: number;
  /** smallest per-carton weight margin, 0..1 */
  weightMargin: number;
  unfilled: UnfilledLine[];
  /**Solver score: Σ carton (util + 0.3·margin) − CARTON_PENALTY·extra */
  score: number;
}

export interface CheckLine {
  id:
    | "BOUNDS"
    | "OVERLAP"
    | "FLOATING"
    | "LOAD"
    | "WEIGHT"
    | "STABILITY"
    | "MERGE"
    | "UNFILLED";
  ok: boolean;
  reason: string;
}

export interface ValidationReport {
  ok: boolean;
  checks: CheckLine[];
}

/* ---------- the raw edges (cm/kg decimal fixtures) ---------- */

/** One order line, authored in cm/kg with 2 decimals. */
export interface OrderLineRaw {
  line: number;
  sku: string;
  family: Family;
  qty: number;
  /** native dims, x × y footprint, z = standing height */
  dims: { x: number; y: number; z: number };
  rotate: Rotate;
  /** weight per unit, kg */
  weightKg: number;
  /** rated load above this unit, kg */
  maxLoadKg: number;
}

/** One order sheet as authored. */
export interface OrderInputRaw {
  id: string;
  name: string;
  lines: OrderLineRaw[];
}

/** One carton template as authored. */
export interface CartonSpecRaw {
  id: string;
  name: string;
  /** inner dims, cm */
  dims: { x: number; y: number; z: number };
  /** max total payload weight, kg */
  payloadKg: number;
  /** the carton's own weight, kg */
  tareKg: number;
}
