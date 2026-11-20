/* ============================================================
   selector — carton selection as the sheet draws it.

   Candidates run in library order sorted by inner volume. Each
   template gets a saturated run: repeat passes in the canonical
   bigger-first order until nothing else converts. Runs are scored
   on cube utilization + weight margin, with a small penalty per
   opened carton folded in — the extra-box cost is a feature.

   Determinism notes, since tests pin this: volume ties are broken
   by template id, score ties by more units placed, and both runs
   of the same input produce byte-identical solutions.
   ============================================================ */

import type { CartonPack, CartonSpec, PackUnit } from "./types.ts";
import { BinRunner } from "./placement.ts";
import { CARTON_PENALTY, MARGIN_WEIGHT } from "./constants.ts";
import { orientationsForUnit } from "./orientations.ts";
import { volumeOf } from "./units.ts";

export interface RunResult {
  /** the template this run packed into */
  spec: CartonSpec;
  pack: CartonPack;
  /** seqs admitted in this run */
  placedSeqs: number[];
  /** what is left, in canonical order */
  rest: PackUnit[];
  /** rest units that no template can ever accept — the run orphans them */
  orphaned: number;
}

/**
 * Would this unit fit inside ANY template on bounds and payload
 * alone (merge/derivation aside)? Shared by the allocator's veto
 * and the packer's honest `whyNoFit` report.
 */
export function fitsSomewhere(
  library: CartonSpec[],
  u: PackUnit,
): boolean {
  if (library.every((s) => u.weightG > s.payloadG)) return false;
  return library.some((spec) =>
    orientationsForUnit(u).some(
      (d) =>
        d.x <= spec.dims.x && d.y <= spec.dims.y && d.z <= spec.dims.z,
    ),
  );
}

function orphanCount(library: CartonSpec[], rest: PackUnit[]): number {
  let n = 0;
  for (const u of rest) if (!fitsSomewhere(library, u)) n++;
  return n;
}

/** Saturation loop: place over `queue` in order until a pass adds nothing. */
export function runBin(spec: CartonSpec, library: CartonSpec[], queue: PackUnit[]): RunResult {
  const runner = new BinRunner(spec);
  const rest = [...queue];
  for (;;) {
    let progressed = false;
    for (let i = 0; i < rest.length; ) {
      if (runner.tryPlace(rest[i])) {
        rest.splice(i, 1);
        progressed = true;
      } else {
        i += 1;
      }
    }
    if (!progressed) break;
  }
  const pack = runner.toCartonPack();
  return {
    spec,
    pack,
    placedSeqs: pack.boxes.map((b) => b.unit.seq),
    rest,
    orphaned: orphanCount(library, rest),
  };
}

/** Score of one run: util + margin×MARGIN_WEIGHT − CARTON_PENALTY. */
export function runScore(pack: CartonPack): number {
  return (
    pack.cubeUtilization + MARGIN_WEIGHT * pack.weightMargin - CARTON_PENALTY
  );
}

/** Library volume-sorted; the id breaks exact volume ties. */
export function sortLibrary(library: CartonSpec[]): CartonSpec[] {
  return [...library].sort(
    (a, b) => volumeOf(a.dims) - volumeOf(b.dims) || a.id.localeCompare(b.id),
  );
}

/** Run every template against `queue`, hand back the scored winner.
 *  A run that orphans an unplaceable unit loses to any run that
 *  does not — completing the order outranks utilization. When
 *  every run orphans, fewest orphans wins, and `pack` reports
 *  the stranding honestly instead of faking a carton. */
export function chooseRun(
  library: CartonSpec[],
  queue: PackUnit[],
): { best: RunResult; all: RunResult[] } {
  const all = library.map((spec) => runBin(spec, library, queue));
  let best = all[0];
  const better = (a: RunResult, b: RunResult): boolean => {
    // fewest orphans first — completing the order outranks the score
    if (a.orphaned !== b.orphaned) return a.orphaned < b.orphaned;
    // an empty run must never beat a productive one (phantom margin
    // otherwise wins); between two empties prefer the smallest box
    // and let `pack` report the stranding honestly
    const aEmpty = a.pack.boxes.length === 0;
    const bEmpty = b.pack.boxes.length === 0;
    if (aEmpty !== bEmpty) return bEmpty; // the non-empty run wins
    if (aEmpty) return volumeOf(a.spec.dims) < volumeOf(b.spec.dims);
    const sa = runScore(a.pack);
    const sb = runScore(b.pack);
    if (sa !== sb) return sa > sb;
    if (a.pack.boxes.length !== b.pack.boxes.length)
      return a.pack.boxes.length > b.pack.boxes.length;
    return volumeOf(a.spec.dims) < volumeOf(b.spec.dims);
  };
  for (const r of all.slice(1)) {
    if (better(r, best)) best = r;
  }
  return { best, all };
}
