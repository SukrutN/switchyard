/* ============================================================
   foreman-engine vocabulary.

   Zones and bands are northspan's (sheet 05): the same Kiln Annex
   runs the counter-refill standards price. Weeks are the axis
   everything hangs on: week 1..52 is the history year, the plan
   horizon starts the week after.
   ============================================================ */

export type ZoneCode = "CIN" | "LOA" | "FLI" | "REE" | "COB";

export type BandId = "veteran" | "day" | "night";

export type ShiftId = "day" | "night";

export interface ZoneDemand {
  zone: ZoneCode;
  /** Forecast lines shipped in this zone, one entry per horizon week. */
  lines: number[];
}

/** One event the family already knows about when it plans. */
export interface CalendarEvent {
  label: string;
  week: number;
  multiplier: number;
  note: string;
}

/* ---------------- stage 1: smoothing ---------------- */

export interface Smooth {
  series: number[];
  alpha: number;
}

/* ---------------- stage 2: trend ---------------- */

export interface Trend {
  /** Weekly level the OLS line leaves at week index 0. */
  base: number;
  /** Lines per week, per week onwards. Can be zero; never wild. */
  slopePerWeek: number;
  /** The smoothed, calendar-adjusted series the OLS fitted. */
  levels: number[];
}

/* ---------------- stage 3: seasonality ---------------- */

export interface Season {
  /** Week of the first observation, 1-based. */
  firstWeek: number;
  /** Weeks pooled under one annual index. */
  weeksPerBlock: number;
  /** Multipliers, one per block, largest at the year's peak. */
  indices: number[];
}

/* ---------------- the composed forecast ---------------- */

export interface Forecast {
  /** History year the model was fitted on, weekly totals. */
  history: number[];
  /** Weeks ahead of the history year, inclusive start. */
  firstWeek: number;
  /** DC forecast lines, one per horizon week. */
  total: number[];
  /** The five zone forecasts, in run order. */
  zones: ZoneDemand[];
  /** Every seasonal multiplier the horizon draws on. */
  season: Season;
  trend: Trend;
  smooth: Smooth;
  /** Events the horizon carries; empty weeks are untouched by events. */
  events: CalendarEvent[];
}

/* ---------------- stage 4: workload ---------------- */

export interface ZoneWorkloadRow {
  zone: ZoneCode;
  week: number;
  lines: number;
  /** Standards-consumed standard hours for this ticket volume. */
  standardHours: number;
  /** Fixed zone supplement hours (counting, housekeeping). */
  supplementHours: number;
  /** standardHours + supplementHours. */
  hours: number;
}

export interface WorkloadWeek {
  week: number;
  rows: ZoneWorkloadRow[];
  total: number;
}

/** Every zone-week of the horizon, plus the flat view the plan consumes. */
export interface Workload {
  weeks: WorkloadWeek[];
  rows: ZoneWorkloadRow[];
}

/* ---------------- stage 5: the plan ---------------- */

export interface PoolBand {
  id: BandId;
  name: string;
  factor: number;
  /** People in the pool. */
  count: number;
  /** Paid hours one person may carry in one week. */
  hoursCap: number;
}

export interface PlanRow {
  week: number;
  zone: ZoneCode;
  shift: ShiftId;
  band: BandId;
  /** Standard hours this assignment must cover. */
  standardHours: number;
  /** Paid hours the band owes: standardHours / factor. */
  paidHours: number;
  /** People-hours equivalent at the band's weekly cap, rounded up. */
  headcount: number;
  /** True when preferred pool ran dry and a stronger band paid the rest. */
  spilled: boolean;
}

export interface Plan {
  rows: PlanRow[];
  /** Paid hours by band, one entry per horizon week. */
  byBand: Record<BandId, number[]>;
  /** Pool hours by band (count × cap) for the same weeks. */
  poolHours: Record<BandId, number[]>;
  compliance: Compliance;
}

export interface Compliance {
  /** Every forecast hour covered by some assignment. */
  covered: boolean;
  /** No zone assigned a band below its skill floor. */
  floorsRespected: boolean;
  /** No pool band over its weekly hours cap. */
  capsRespected: boolean;
  /** True when any assignment spilled off its preferred band. */
  spilled: boolean;
}

/* ---------------- variance ---------------- */

export interface VarianceZone {
  zone: ZoneCode;
  forecastLines: number;
  actualLines: number;
  forecastHours: number;
  actualHours: number;
  /** Mean absolute percent error over the horizon, percent. */
  mape: number;
  noiseDelta: number;
}

export interface Variance {
  zones: VarianceZone[];
  totalForecastLines: number;
  totalActualLines: number;
  /** Actual standards-consumed hours minus forecast hours, DC-wide. */
  hoursGap: number;
  seed: number;
}
