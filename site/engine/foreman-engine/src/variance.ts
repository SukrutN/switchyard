/* ============================================================
   Variance — the plan meets the week that actually happened.

   The "actual" is a fixed realization: the forecast lines hit
   by a seeded jolt per zone-week, drawn in one frozen order
   (weeks ascending, zones in standards-table order), so the
   realization is a fixture — same seed, same tickets, any
   machine. MAPE is scored per zone against those actuals,
   and the waterfall bridges forecast hours to actual hours
   by the one delta that separates them: the noise.

   Consumption is the same northspan standards as the plan's —
   variance moves volume, never the minutes per line.
   ============================================================ */

import { SUPPLEMENT_MINUTES, ZONE_STANDARDS } from "../fixtures/standards.ts";
import { jolt, mulberry32 } from "./rng.ts";
import type { Forecast, Variance, VarianceZone, ZoneCode } from "./types.ts";

export interface VarianceConfig {
  seed: number;
  /** Max symmetric multiplicative jolt on a zone-week. */
  amplitude: number;
}

export interface RealizedWeek {
  week: number;
  zone: ZoneCode;
  forecastLines: number;
  actualLines: number;
}

/** The seeded realization, drawn in one frozen order. */
export function realizeActuals(forecast: Forecast, cfg: VarianceConfig): RealizedWeek[] {
  const rng = mulberry32(cfg.seed);
  const out: RealizedWeek[] = [];
  for (let i = 0; i < forecast.total.length; i++) {
    const week = forecast.firstWeek + i;
    for (const standard of ZONE_STANDARDS) {
      const forecastLines = forecast.zones.find((demand) => demand.zone === standard.zone)!.lines[i];
      const epsilon = jolt(rng, cfg.amplitude);
      out.push({
        week,
        zone: standard.zone,
        forecastLines,
        actualLines: Math.round(forecastLines * (1 + epsilon)),
      });
    }
  }
  return out;
}

/** Score the realization: per-zone MAPE, hours, waterfalls. */
export function variance(realized: RealizedWeek[], seed = 0): Variance {
  const zones: VarianceZone[] = ZONE_STANDARDS.map(({ zone, mplMinutes }) => {
    const own = realized.filter((weekRow) => weekRow.zone === zone);
    let forecastLines = 0;
    let actualLines = 0;
    let forecastHours = 0;
    let actualHours = 0;
    let absErrorShare = 0;
    for (const row of own) {
      forecastLines += row.forecastLines;
      actualLines += row.actualLines;
      forecastHours += (row.forecastLines * mplMinutes) / 60 + SUPPLEMENT_MINUTES / 60;
      actualHours += (row.actualLines * mplMinutes) / 60 + SUPPLEMENT_MINUTES / 60;
      absErrorShare += Math.abs(row.forecastLines - row.actualLines) / row.actualLines;
    }
    return {
      zone,
      forecastLines,
      actualLines,
      forecastHours,
      actualHours,
      mape: (absErrorShare / own.length) * 100,
      noiseDelta: actualHours - forecastHours,
    };
  });

  const totalForecastLines = zones.reduce((sum, zone) => sum + zone.forecastLines, 0);
  const totalActualLines = zones.reduce((sum, zone) => sum + zone.actualLines, 0);
  const hoursGap = zones.reduce((sum, zone) => sum + zone.noiseDelta, 0);

  return { zones, totalForecastLines, totalActualLines, hoursGap, seed };
}
