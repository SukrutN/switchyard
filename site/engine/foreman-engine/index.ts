/* ============================================================
   foreman-engine — public surface.

   `forecast` is the pipeline; `workload` consumes northspan's
   standards; `plan` covers every forecast hour; `realizeActuals`
   + `variance` judge the plan against a fixed realization. The
   fixtures are Bramble & Twine: 52 weeks of ledger, one spring
   surge, one seeded realization.
   ============================================================ */

export { forecast, smooth, fitTrend, seasonIndex, adjustForCalendar, calendarFactor, eventMultiplier } from "./src/forecaster.ts";
export type { ForecastConfig } from "./src/forecaster.ts";
export { workload, zoneHours } from "./src/workload.ts";
export { plan, allowedFor, preferenceFor, poolCapacity } from "./src/schedule.ts";
export { realizeActuals, variance } from "./src/variance.ts";
export type { RealizedWeek, VarianceConfig } from "./src/variance.ts";
export { mulberry32, jolt } from "./src/rng.ts";

export type {
  BandId,
  CalendarEvent,
  Compliance,
  Forecast,
  Plan,
  PlanRow,
  PoolBand,
  Season,
  ShiftId,
  Smooth,
  Trend,
  Variance,
  VarianceZone,
  Workload,
  WorkloadWeek,
  ZoneCode,
  ZoneDemand,
  ZoneWorkloadRow,
} from "./src/types.ts";
export type { ZoneStandard } from "./fixtures/standards.ts";

/* Bramble & Twine — history, calendar, and the drawn realization. */
export {
  BRAMBLE,
  EVENTS,
  FORECAST_CONFIG,
  HISTORY,
  SEASON_INDICES,
  ZONE_SHARES,
} from "./fixtures/bramble.ts";

/* Northspan's standards, exported verbatim — the whole point of sheet 05. */
export { BAND_FACTORS, SUPPLEMENT_MINUTES, ZONE_STANDARDS } from "./fixtures/standards.ts";

/* The bench and its rules. */
export { BANDS, SHIFT_SHARE, ZONE_FLOORS } from "./fixtures/pools.ts";
