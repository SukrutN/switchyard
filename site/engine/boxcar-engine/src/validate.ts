/* ============================================================
   validate — the pack-out is graded before it leaves.

   The no-floating check is a test, not a feature: the packer's
   own admissions are re-derived from the placements alone — no
   trusting the same code path that created them. Every failure
   carries its reason spelled out (the behaviour contract the
   skjolber engine made famous: a result box tells you WHY).
   ============================================================ */

import type {
  ShipSolution,
  ValidationReport,
  CheckLine,
  PlacedBox,
  CartonPack,
  Family,
} from "./types.ts";
import type { Gram } from "./units.ts";
import { STABILITY_RATIO } from "./constants.ts";
import { coPackable } from "./compat.ts";

function footprintArea(a: PlacedBox, b: PlacedBox): number {
  const w =
    Math.min(a.pos.x + a.dims.x, b.pos.x + b.dims.x) - Math.max(a.pos.x, b.pos.x);
  const d =
    Math.min(a.pos.y + a.dims.y, b.pos.y + b.dims.y) - Math.max(a.pos.y, b.pos.y);
  return w > 0 && d > 0 ? w * d : 0;
}

const axisOverlap = (a0: number, a1: number, b0: number, b1: number) =>
  a0 < b1 && b0 < a1;

const overlaps = (a: PlacedBox, b: PlacedBox): boolean =>
  axisOverlap(a.pos.x, a.pos.x + a.dims.x, b.pos.x, b.pos.x + b.dims.x) &&
  axisOverlap(a.pos.y, a.pos.y + a.dims.y, b.pos.y, b.pos.y + b.dims.y) &&
  axisOverlap(a.pos.z, a.pos.z + a.dims.z, b.pos.z, b.pos.z + b.dims.z);

/**
 * Re-derive who actually supports one box, from placements alone:
 * floor contact plus supports whose top edge is exactly at z.
 */
export function surfaceContacts(box: PlacedBox, pack: CartonPack): {
  floor: number;
  onItems: { other: PlacedBox; area: number }[];
} {
  const bottom = box.dims.x * box.dims.y;
  let floor = 0;
  const onItems: { other: PlacedBox; area: number }[] = [];
  for (const other of pack.boxes) {
    if (other.unit.seq === box.unit.seq) continue;
    const area = footprintArea(box, other);
    if (area <= 0) continue;
    if (other.pos.z + other.dims.z === box.pos.z) onItems.push({ other, area });
  }
  if (box.pos.z === 0) floor = bottom;
  return { floor, onItems };
}

export function validateSolution(sol: ShipSolution): ValidationReport {
  const checks: CheckLine[] = [];

  // unfilled lines are reported, not rationalized
  if (sol.unfilled.length > 0) {
    checks.push({
      id: "UNFILLED",
      ok: false,
      reason: `${sol.unfilled.length} line(s) unfilled: ${sol.unfilled
        .map((u) => u.sku)
        .join(", ")}`,
    });
  }

  for (let ci = 0; ci < sol.cartons.length; ci++) {
    const pack = sol.cartons[ci];
    const tag = (t: string) => (sol.cartons.length > 1 ? `${t} · ${pack.template.id}#${ci + 1}` : t);

    // BOUNDS + OVERLAP
    const boundsBad = pack.boxes.filter(
      (b) =>
        b.pos.x < 0 ||
        b.pos.y < 0 ||
        b.pos.z < 0 ||
        b.pos.x + b.dims.x > pack.template.dims.x ||
        b.pos.y + b.dims.y > pack.template.dims.y ||
        b.pos.z + b.dims.z > pack.template.dims.z,
    );
    checks.push({
      id: "BOUNDS",
      ok: boundsBad.length === 0,
      reason:
        boundsBad.length === 0
          ? `${pack.boxes.length} box(es) inside ${pack.template.id}`
          : `${boundsBad.length} box(es) breach ${pack.template.id} walls`,
    });

    const clashes: string[] = [];
    for (let i = 0; i < pack.boxes.length; i++) {
      for (let j = i + 1; j < pack.boxes.length; j++) {
        if (overlaps(pack.boxes[i], pack.boxes[j])) {
          clashes.push(`${pack.boxes[i].unit.sku}×${pack.boxes[j].unit.sku}`);
        }
      }
    }
    checks.push({
      id: "OVERLAP",
      ok: clashes.length === 0,
      reason: clashes.length === 0 ? "no two boxes share an interior point" : `intersections: ${clashes.join(", ")}`,
    });

    // FLOATING + STABILITY (derived, not trusted)
    const floaters: string[] = [];
    const stumbles: string[] = [];
    for (const b of pack.boxes) {
      const bottom = b.dims.x * b.dims.y;
      const { floor, onItems } = surfaceContacts(b, pack);
      const contact = floor + onItems.reduce((s, c) => s + c.area, 0);
      if (contact <= 0) floaters.push(b.unit.sku);
      else if (contact / bottom < STABILITY_RATIO - 1e-9) {
        stumbles.push(`${b.unit.sku} @ ${(contact / bottom).toFixed(2)}`);
      }
    }
    checks.push({
      id: "FLOATING",
      ok: floaters.length === 0,
      reason:
        floaters.length === 0
          ? "every box base meets floor or support, within exact ticks"
          : `floating bases: ${floaters.join(", ")}`,
    });
    checks.push({
      id: "STABILITY",
      ok: stumbles.length === 0,
      reason:
        stumbles.length === 0
          ? `contact ratio ≥ ${STABILITY_RATIO} for all placements`
          : `unstable: ${stumbles.join(", ")}`,
    });

    // LOAD: walk each box's support list, flow weight down, check ratings
    const carried = new Map<number, Gram>();
    1; // (the walk below builds `carried` bottom-up; see delivered())
    const delivered = (b: PlacedBox, grams: Gram, seen: Set<number>): void => {
      const bottom = b.dims.x * b.dims.y;
      const { floor, onItems } = surfaceContacts(b, pack);
      const itemArea = onItems.reduce((s, c) => s + c.area, 0);
      const denom = floor + itemArea || 1;
      for (const c of onItems) {
        const share = c.area / denom;
        const load = grams * share;
        carried.set(c.other.unit.seq, (carried.get(c.other.unit.seq) ?? 0) + load);
        const below = pack.boxes.find(
          (x) => x.unit.seq === c.other.unit.seq,
        );
        if (below && !seen.has(below.unit.seq)) {
          seen.add(below.unit.seq);
          delivered(below, load, seen);
        }
      }
      void bottom;
    };
    for (const b of pack.boxes) delivered(b, b.unit.weightG, new Set());
    const loadBreakers = pack.boxes.filter((b) => {
      const on = carried.get(b.unit.seq) ?? 0;
      return on > b.unit.maxLoadG;
    });
    checks.push({
      id: "LOAD",
      ok: loadBreakers.length === 0,
      reason:
        loadBreakers.length === 0
          ? "no box carries past its rated load"
          : `rated load exceeded: ${loadBreakers.map((b) => b.unit.sku).join(", ")}`,
    });

    // WEIGHT
    const wOver = pack.payloadG > pack.template.payloadG;
    checks.push({
      id: "WEIGHT",
      ok: !wOver,
      reason: wOver
        ? `payload ${pack.payloadG} g > ${pack.template.id} limit ${pack.template.payloadG} g`
        : `payload ${pack.payloadG} g ≤ ${pack.template.payloadG} g (${pack.template.id})`,
    });

    // MERGE — the co-pack table in BOTH directions, like the packer reads it
    const families: Family[] = [...new Set(pack.boxes.map((b) => b.unit.family))];
    let mergeOk = true;
    outer: for (let i = 0; i < families.length; i++) {
      for (let j = i + 1; j < families.length; j++) {
        if (!coPackable(families[i], families[j]) ||
            !coPackable(families[j], families[i])) {
          mergeOk = false;
          break outer;
        }
      }
    }
    checks.push({
      id: "MERGE",
      ok: mergeOk,
      reason: mergeOk
        ? "co-pack table clean in this carton"
        : `incompatible families share ${pack.template.id}`,
    });
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}
