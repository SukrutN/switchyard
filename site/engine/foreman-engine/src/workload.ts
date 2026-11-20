/* ============================================================
   Workload conversion — why sheet 05 ships first.

   Forecast lines per zone × the northspan standards, exactly
   (a table lookup × volume, no new constants), plus the fixed
   zone supplement. The exactness test holds the consumed hours
   to the exported table at 1e-9: the foreman carries no
   coefficients of its own.
   ============================================================ */

import { SUPPLEMENT_MINUTES } from "../fixtures/standards.ts";
import type { ZoneStandard } from "../fixtures/standards.ts";
import type { Forecast, Workload, ZoneWorkloadRow } from "./types.ts";

export type { Workload, ZoneWorkloadRow };

/** Convert one zone-week. `standard.mplMinutes` is northspan's own number. */
export function zoneHours(
  standard: ZoneStandard,
  lines: number,
  week: number,
  supplementMinutes: number = SUPPLEMENT_MINUTES,
): ZoneWorkloadRow {
  const standardHours = (lines * standard.mplMinutes) / 60;
  const supplementHours = supplementMinutes / 60;
  return {
    zone: standard.zone,
    week,
    lines,
    standardHours,
    supplementHours,
    hours: standardHours + supplementHours,
  };
}

/** The whole horizon, zone rows in the standards table's order. */
export function workload(forecast: Forecast, standards: ZoneStandard[]): Workload {
  const weeks: Workload["weeks"] = [];
  const rows: ZoneWorkloadRow[] = [];
  for (let i = 0; i < forecast.total.length; i++) {
    const week = forecast.firstWeek + i;
    let total = 0;
    const weekRows: ZoneWorkloadRow[] = [];
    for (const standard of standards) {
      const lines = forecast.zones.find((demand) => demand.zone === standard.zone)!.lines[i];
      const row = zoneHours(standard, lines, week);
      total += row.hours;
      weekRows.push(row);
    }
    weeks.push({ week, rows: weekRows, total });
    rows.push(...weekRows);
  }
  return { weeks, rows };
}
