/* Fluxline's published divert. Height, then metal, then the weight
   band. The host may ask; this is the law the piece actually meets.
   Heights in millimetres, weight in kilograms. */

export type Gate = "L01" | "L02" | "L03" | "RJ"

export type Piece = {
  heightMm: number
  metal: boolean
  weightKg: number
}

export function divert(piece: Piece): Gate {
  if (piece.heightMm >= 165) return "L03"
  if (piece.metal) return "L02"
  if (piece.weightKg < 2 || piece.weightKg > 12) return "RJ"
  return "L01"
}

export function pieceFor(seed: number, index: number): Piece {
  const rnd = mulberry(seed + index * 17)
  const heightMm = 140 + Math.floor(rnd() * 50)
  const metal = rnd() < 0.2
  const weightKg = Math.round((1 + rnd() * 14) * 10) / 10
  return { heightMm, metal, weightKg }
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
