/* ============================================================
   units — fixed-point arithmetic for the packer.

   The classic failure when porting this family is rounding drift:
   a 24.50 cm wall becomes 24.499999 and a placement that should
   touch lands 10⁻⁶ short, or an overlap check says "gap" one
   hundredth of a millimetre late. The engine therefore never
   multiplies two fixtures fields in floating point at decision
   time: every dimension is an integer tick (0.01 cm — a tenth
   of a millimetre) and every weight is an integer gram.

   Fixture sheets are authored in cm/kg with 2 decimals, exactly
   like the roadmap calls for; `toTick`/`toGram` accept those
   decimals once, at the edge, and everything inside runs on
   integers. Output goes back through `fmtCm`/`fmtKg`.
   ============================================================ */

/** One horizontal/vertical dimension step: 0.01 cm. */
export type Tick = number;
/** One weight step: 1 gram. */
export type Gram = number;

/** cm with 2 decimals → ticks (0.01 cm). */
export function toTick(cm: number): Tick {
  return Math.round(cm * 100);
}

/** kg with 2 decimals → grams. */
export function toGram(kg: number): Gram {
  return Math.round(kg * 1000);
}

/** ticks → a "12.34" string, the display contract for the site + JSON. */
export function fmtCm(t: Tick): string {
  return (t / 100).toFixed(2);
}

/** grams → a "1.25" string in kg, 2 decimals. */
export function fmtKg(g: Gram): string {
  return (g / 1000).toFixed(2);
}

export interface Dim3 {
  /** footprint X */
  x: Tick;
  /** footprint Y */
  y: Tick;
  /** vertical Z ("height" in the native position) */
  z: Tick;
}

export interface Vec3 {
  x: Tick;
  y: Tick;
  z: Tick;
}

/** Volume of a dim triple in tick³ (exact integer). */
export function volumeOf(d: Dim3): number {
  return d.x * d.y * d.z;
}
