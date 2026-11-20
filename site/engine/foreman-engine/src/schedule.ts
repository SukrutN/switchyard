/* ============================================================
   The casing scheduler — cover the workload, respect the bench.

   For each week, every zone's hours split into day and night
   tasks, then a casing fills each task from the band its
   velocity runs best at, spilling up the strength order only
   when a pool runs dry. Covering one standard hour at band
   factor f costs 1/f paid hours, so a spill is honest
   arithmetic, not a rounding.

   Floors point one way: a zone's skill floor is the weakest
   band allowed on it. Cinder anchors on veterans and takes
   nobody weaker; Cobalt tolerates the night desk and may take
   anybody stronger.

   If a task cannot be covered the plan refuses — compliance
   turns false and the characterization fails loud. The pool
   is a fixture, and its sizing is a lock, not a promise.
   ============================================================ */

import { BANDS, SHIFT_SHARE, ZONE_FLOORS } from "../fixtures/pools.ts";
import { BAND_FACTORS, ZONE_STANDARDS } from "../fixtures/standards.ts";
import type { BandId, Plan, PlanRow, ShiftId, Workload, ZoneCode, ZoneWorkloadRow } from "./types.ts";

/* Bands strongest-first; the floor filter drops the ones too weak. */
const BAND_ORDER: BandId[] = ["veteran", "day", "night"];

const EPS = 1e-9;

function rank(band: BandId): number {
  return BAND_ORDER.indexOf(band);
}

/** Bands allowed on a zone: everything at least as strong as its floor. */
export function allowedFor(zone: ZoneCode): BandId[] {
  const floor = rank(ZONE_FLOORS[zone]);
  return BAND_ORDER.filter((band) => rank(band) <= floor);
}

/**
 * Casing preference per velocity class: the band the zone runs
 * best at comes first; spills walk up the strength order.
 * Filters through the floor so a preference can never dip below the
 * zone's weakest allowed band.
 */
export function preferenceFor(zone: ZoneCode): BandId[] {
  const velocity = ZONE_STANDARDS.find((standard) => standard.zone === zone)!.velocity;
  const wish: Record<typeof velocity, BandId[]> = {
    hot: ["veteran"],
    flow: ["day", "veteran"],
    calm: ["night", "day", "veteran"],
  };
  const allowed = allowedFor(zone);
  const candidates: BandId[] = [...wish[velocity], "veteran", "day", "night"];
  return candidates.filter((band, index) => allowed.includes(band) && candidates.indexOf(band) === index);
}

/** Pool capacity for one week: people × weekly cap, per band. */
export function poolCapacity(): Record<BandId, number> {
  const out: Record<BandId, number> = { veteran: 0, day: 0, night: 0 };
  for (const band of BANDS) out[band.id] = band.count * band.hoursCap;
  return out;
}

const SHIFTS: ShiftId[] = ["day", "night"];

export function plan(workload: Workload): Plan {
  const rows: PlanRow[] = [];
  const byBand: Record<BandId, number[]> = { veteran: [], day: [], night: [] };
  const poolHours: Record<BandId, number[]> = { veteran: [], day: [], night: [] };
  let covered = true;
  let floorsRespected = true;
  let capsRespected = true;
  let spilled = false;

  for (const week of workload.weeks) {
    const paid: Record<BandId, number> = { veteran: 0, day: 0, night: 0 };
    const capacity = poolCapacity();

    /* Tasks in casing order: biggest zones first, day before night. */
    const zoneOrder = [...week.rows].sort(
      (a, b) => b.standardHours - a.standardHours || a.zone.localeCompare(b.zone),
    );
    const tasks: Array<{ row: ZoneWorkloadRow; shift: ShiftId; standardHours: number }> = [];
    for (const row of zoneOrder) {
      for (const shift of SHIFTS) {
        tasks.push({ row, shift, standardHours: row.hours * SHIFT_SHARE[shift] });
      }
    }

    for (const task of tasks) {
      let remaining = task.standardHours;
      const taskRows: PlanRow[] = [];
      const preferred = preferenceFor(task.row.zone)[0];
      for (const band of preferenceFor(task.row.zone)) {
        if (remaining <= EPS) break;
        const factor = BAND_FACTORS[band];
        const room = capacity[band] - paid[band];
        const give = Math.min(remaining / factor, Math.max(0, room));
        if (give <= EPS) continue;
        const standardHours = give * factor;
        remaining -= standardHours;
        paid[band] += give;
        taskRows.push({
          week: task.row.week,
          zone: task.row.zone,
          shift: task.shift,
          band,
          standardHours,
          paidHours: give,
          headcount: Math.ceil(give / BANDS.find((b) => b.id === band)!.hoursCap),
          spilled: band !== preferred,
        });
      }
      if (remaining > 1e-6) {
        covered = false;
      }
      if (taskRows.length > 1) {
        spilled = true;
      }
      floorsRespected &&= taskRows.every((row) => rank(row.band) <= rank(ZONE_FLOORS[row.zone]));
      rows.push(...taskRows);
    }

    for (const band of BAND_ORDER) {
      byBand[band].push(paid[band]);
      if (paid[band] > capacity[band] + EPS) capsRespected = false;
      poolHours[band].push(capacity[band]);
    }
  }

  return { rows, byBand, poolHours, compliance: { covered, floorsRespected, capsRespected, spilled } };
}
