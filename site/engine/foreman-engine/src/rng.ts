/* ============================================================
   mulberry32 — one seed, one stream, no platform drift.

   Every number the foreman ever treats as "actual" comes through
   this door. Same seed in, same stream out, on any machine, any
   node, at build time or in a test run. The realization is a
   fixture, not an accident.
   ============================================================ */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw one symmetric multiplicative jolt within ±amplitude. */
export function jolt(rng: () => number, amplitude: number): number {
  return (rng() * 2 - 1) * amplitude;
}
