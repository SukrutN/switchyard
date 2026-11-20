/* ============================================================
   placement — the free-space point engine for one carton.

   Skeleton lineage, credited: the anchor-point loop and the
   no-collision admission come from enzoruiz/3dbinpacking (and
   the thesis inside it); the three fixes that matter here are
   the ones the naive version lacks:

   1. GRAVITY — every candidate drops to the top of the support
      stack actually beneath it before admission. No floating.
   2. LOAD-BEARING — weight flows down the support chain by
      contact-area share; a unit may never carry more than its
      own rated load.
   3. STABILITY — a placement needs a minimum real contact
      ratio on its bottom before it counts.

   Everything runs on integer ticks; equality is exact.
   ============================================================ */

import type {
  CartonPack,
  CartonSpec,
  PackUnit,
  PlacedBox,
  Support,
} from "./types.ts";
import type { Dim3, Tick, Gram, Vec3 } from "./units.ts";
import { volumeOf } from "./units.ts";
import { coPackables } from "./compat.ts";
import { orientationsForUnit } from "./orientations.ts";
import { STABILITY_RATIO } from "./constants.ts";

interface Node extends PlacedBox {
  /** grams resting on this box through the whole chain above it */
  carriedG: Gram;
}

type TryBox = { pos: Vec3; dims: Dim3 };
type Pull = { node: Node; share: number };

/** Strict-interior overlap on one axis; touching edges never count. */
function axisOverlap(a0: Tick, a1: Tick, b0: Tick, b1: Tick): boolean {
  return a0 < b1 && b0 < a1;
}

function overlaps(a: TryBox, b: TryBox): boolean {
  return (
    axisOverlap(a.pos.x, a.pos.x + a.dims.x, b.pos.x, b.pos.x + b.dims.x) &&
    axisOverlap(a.pos.y, a.pos.y + a.dims.y, b.pos.y, b.pos.y + b.dims.y) &&
    axisOverlap(a.pos.z, a.pos.z + a.dims.z, b.pos.z, b.pos.z + b.dims.z)
  );
}

/** footprint overlap area of two boxes (the XY projection) */
function footprintArea(a: TryBox, b: TryBox): number {
  const w =
    Math.min(a.pos.x + a.dims.x, b.pos.x + b.dims.x) - Math.max(a.pos.x, b.pos.x);
  const d =
    Math.min(a.pos.y + a.dims.y, b.pos.y + b.dims.y) - Math.max(a.pos.y, b.pos.y);
  return w > 0 && d > 0 ? w * d : 0;
}

/**
 * One carton in progress. The public entry is `pack`; tests reach
 * in here to pin the machine's behaviour directly.
 */
export class BinRunner {
  readonly spec: CartonSpec;
  private boxes: Node[] = [];
  private bySeq = new Map<number, Node>();
  private points: Vec3[] = [];
  private payloadG: Gram = 0;

  constructor(spec: CartonSpec) {
    this.spec = spec;
    this.points.push({ x: 0, y: 0, z: 0 });
  }

  get usedUnits(): PackUnit[] {
    return this.boxes.map((b) => b.unit);
  }

  get familiesPresent(): PackUnit["family"][] {
    const set = new Set<PackUnit["family"]>();
    for (const b of this.boxes) set.add(b.unit.family);
    return [...set];
  }

  /** Does this unit keep the co-pack table honest at the door? */
  admitsFamily(f: PackUnit["family"]): boolean {
    return coPackables(f, this.familiesPresent);
  }

  /**
   * Try to admit one unit. Deterministic: candidate points sorted
   * (z, x, y), orientations flatten-first; the first admission that
   * passes bounds → gravity → collision → stability → load wins.
   */
  tryPlace(unit: PackUnit): boolean {
    if (!this.admitsFamily(unit.family)) return false;

    const bottom = unit.dims.x * unit.dims.y;

    for (const point of this.sortedPoints()) {
      for (const dims of orientationsForUnit(unit)) {
        // a. bounds
        if (
          point.x + dims.x > this.spec.dims.x ||
          point.y + dims.y > this.spec.dims.y ||
          point.z + dims.z > this.spec.dims.z
        ) {
          continue;
        }

        // b. gravity: drop to the highest support strictly below
        const zRest = this.settleZ(point, dims);
        const tryBox: TryBox = { pos: { ...point, z: zRest }, dims };

        // c. collision at the settled position
        if (this.boxes.some((b) => overlaps(b, tryBox))) continue;

        // d. contacts & stability — raw areas first, then one
        //    renormalization feeds stability, ledger and report alike
        let floorArea = 0;
        if (zRest === 0) floorArea = bottom;
        let rawContacts = 0;
        for (const b of this.boxes) {
          if (footprintArea(tryBox, b) <= 0) continue;
          if (b.pos.z + b.dims.z === zRest)
            rawContacts += footprintArea(tryBox, b);
        }
        const contactRaw = floorArea + rawContacts;
        if (contactRaw / bottom < STABILITY_RATIO) continue;

        // e. weight: carton payload, then the load-bearing chain.
        //    Shares renormalize to the real contact set so the carried
        //    ledger is exact: every gram flows somewhere, nothing leaks.
        if (this.payloadG + unit.weightG > this.spec.payloadG) continue;
        const pulls: Pull[] = [];
        for (const b of this.boxes) {
          const area = footprintArea(tryBox, b);
          if (area <= 0) continue;
          if (b.pos.z + b.dims.z === zRest) {
            pulls.push({ node: b, share: area / contactRaw });
          }
        }
        const floorShare = floorArea / contactRaw;
        const supports: Support[] = pulls.map((c) => ({
          floor: false,
          seq: c.node.unit.seq,
          share: c.share,
        }));
        if (floorShare > 0) supports.push({ floor: true, share: floorShare });

        if (this.wouldBreakLoad(unit.weightG, pulls)) continue;

        // f. commit weight downstream, register the box, grow the points
        this.addCarried(unit.weightG, pulls);
        const node: Node = {
          unit,
          pos: tryBox.pos,
          dims,
          supports,
          carriedG: 0,
        };
        this.boxes.push(node);
        this.bySeq.set(unit.seq, node);
        this.payloadG += unit.weightG;
        this.growPoints(tryBox);
        return true;
      }
    }
    return false;
  }

  /** The output frame for one packed carton. */
  toCartonPack(): CartonPack {
    const boxes: PlacedBox[] = this.boxes.map(
      ({ unit, pos, dims, supports }) => ({ unit, pos, dims, supports }),
    );
    const payloadG = this.payloadG;
    const vol = volumeOf(this.spec.dims);
    return {
      template: this.spec,
      boxes,
      payloadG,
      weightMargin:
        this.spec.payloadG === 0 ? 0 : (this.spec.payloadG - payloadG) / this.spec.payloadG,
      cubeUtilization: vol === 0 ? 0 : boxes.reduce((s, b) => s + volumeOf(b.dims), 0) / vol,
    };
  }

  // ---------- the fixes ----------

  /**
   * GRAVITY. Highest support top at or under `point.z` whose
   * footprint strictly overlaps the candidate's; floor otherwise.
   */
  private settleZ(point: Vec3, dims: Dim3): Tick {
    const candidate: TryBox = { pos: point, dims };
    let best = 0;
    for (const b of this.boxes) {
      if (footprintArea(candidate, b) <= 0) continue;
      const top = b.pos.z + b.dims.z;
      if (top <= point.z && top > best) best = top;
    }
    return best;
  }

  /**
   * LOAD-BEARING, dry run. `grams` flows to each direct support by
   * contact share, and down each support's own chain. Any node whose
   * carried load would exceed its rating vetoes the placement.
   */
  private wouldBreakLoad(grams: Gram, pulls: Pull[]): boolean {
    for (const s of pulls) {
      const load = grams * s.share;
      if (s.node.carriedG + load > s.node.unit.maxLoadG) return true;
      if (this.wouldBreakLoad(load, this.pullsOf(s.node))) return true;
    }
    return false;
  }

  private addCarried(grams: Gram, pulls: Pull[]): void {
    for (const s of pulls) {
      const load = grams * s.share;
      s.node.carriedG += load;
      this.addCarried(load, this.pullsOf(s.node));
    }
  }

  /** A node's supports, resolved back into Pull records (floor drops out). */
  private pullsOf(node: Node): Pull[] {
    const out: Pull[] = [];
    for (const s of node.supports) {
      if (s.floor) continue;
      const below = this.bySeq.get(s.seq);
      if (below) out.push({ node: below, share: s.share });
    }
    return out;
  }

  // ---------- points bookkeeping ----------

  private sortedPoints(): Vec3[] {
    return [...this.points].sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
  }

  private growPoints(box: TryBox): void {
    const seeds: Vec3[] = [
      { x: box.pos.x + box.dims.x, y: box.pos.y, z: box.pos.z },
      { x: box.pos.x, y: box.pos.y + box.dims.y, z: box.pos.z },
      { x: box.pos.x, y: box.pos.y, z: box.pos.z + box.dims.z },
    ];
    for (const p of seeds) {
      if (
        p.x >= this.spec.dims.x ||
        p.y >= this.spec.dims.y ||
        p.z >= this.spec.dims.z
      ) {
        continue;
      }
      const insideSome = this.boxes.some(
        (b) =>
          p.x > b.pos.x &&
          p.x < b.pos.x + b.dims.x &&
          p.y > b.pos.y &&
          p.y < b.pos.y + b.dims.y &&
          p.z > b.pos.z &&
          p.z < b.pos.z + b.dims.z,
      );
      if (insideSome) continue;
      const dupe = this.points.some(
        (q) => q.x === p.x && q.y === p.y && q.z === p.z,
      );
      if (dupe) continue;
      this.points.push(p);
    }
  }
}
