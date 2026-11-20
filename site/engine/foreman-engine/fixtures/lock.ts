/* ============================================================
   lock — the once-per-horizon run: fit the forecaster on the
   52-week ledger, convert to hours through northspan's
   standards, case the plan, draw the seeded realization, and
   score it. The script PRINTS the JSON; the human pastes it
   into `expected.ts` (pure data, no imports) and the
   characterization tests read it as the law.

   Run: npm run lock:foreman
   ============================================================ */

import {
  BRAMBLE,
  FORECAST_CONFIG,
  HISTORY,
  SEASON_INDICES,
  forecast,
  plan,
  realizeActuals,
  variance,
  workload,
} from "../index.ts";
import { BANDS } from "./pools.ts";
import { ZONE_STANDARDS } from "./standards.ts";

const round = (x: number, dp: number) => Number(x.toFixed(dp));

const fc = forecast(HISTORY, FORECAST_CONFIG);
const wl = workload(fc, ZONE_STANDARDS);
const pl = plan(wl);
const realized = realizeActuals(fc, {
  seed: BRAMBLE.actualSeed,
  amplitude: BRAMBLE.actualNoiseAmplitude,
});
const vr = variance(realized, BRAMBLE.actualSeed);

const poolHours = BANDS.reduce((sum, band) => sum + band.count * band.hoursCap, 0);
const peakPaid = Math.max(
  ...wl.weeks.map((_, i) =>
    (["veteran", "day", "night"] as const).reduce((sum, b) => sum + pl.byBand[b][i], 0),
  ),
);
const peakWeekIndex = wl.weeks.findIndex((w) => w.week === 62);
const anniversary = pl.rows
  .filter((row) => row.week === 62)
  .map((row) => ({
    zone: row.zone,
    shift: row.shift,
    band: row.band,
    standardHours: round(row.standardHours, 3),
    paidHours: round(row.paidHours, 3),
    headcount: row.headcount,
  }));

const FOREMAN_LOCK = {
  fixed: {
    seasonIndices: SEASON_INDICES.map((x) => round(x, 5)),
    standards: ZONE_STANDARDS.map((s) => ({ zone: s.zone, mplMinutes: s.mplMinutes })),
  },
  history: {
    length: HISTORY.length,
    first: HISTORY.slice(0, 4),
    last: HISTORY.slice(-4),
    sum: HISTORY.reduce((a, b) => a + b, 0),
  },
  trend: {
    base: round(fc.trend.base, 4),
    slopePerWeek: round(fc.trend.slopePerWeek, 4),
  },
  forecast: {
    totals: fc.total.map((x) => round(x, 2)),
    peakWeek: 62,
  },
  workload: {
    weekly: wl.weeks.map((w) => round(w.total, 3)),
    total: round(wl.rows.reduce((sum, r) => sum + r.hours, 0), 3),
  },
  plan: {
    compliance: pl.compliance,
    byBand: {
      veteran: pl.byBand.veteran.map((x) => round(x, 3)),
      day: pl.byBand.day.map((x) => round(x, 3)),
      night: pl.byBand.night.map((x) => round(x, 3)),
    },
    peakPaid: round(peakPaid, 3),
    poolHours,
    utilizationPeak: round(peakPaid / poolHours, 4),
    anniversary,
  },
  variance: {
    seed: BRAMBLE.actualSeed,
    amplitude: BRAMBLE.actualNoiseAmplitude,
    mape: Object.fromEntries(vr.zones.map((z) => [z.zone, round(z.mape, 4)])),
    forecastHours: Object.fromEntries(
      vr.zones.map((z) => [z.zone, round(z.forecastHours, 3)]),
    ),
    actualHours: Object.fromEntries(vr.zones.map((z) => [z.zone, round(z.actualHours, 3)])),
    actualLines: Object.fromEntries(vr.zones.map((z) => [z.zone, z.actualLines])),
    totalForecastLines: round(vr.totalForecastLines, 0),
    totalActualLines: vr.totalActualLines,
    hoursGap: round(vr.hoursGap, 3),
  },
};

console.log(JSON.stringify(FOREMAN_LOCK, null, 2));
