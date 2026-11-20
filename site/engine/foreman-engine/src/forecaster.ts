/* ============================================================
   Staged forecaster — Labuskes' skeleton, one honest order:
   the known calendar is lifted off the RAW ledger first (a
   tent sale is not a trend), then the plain week's demand is
   smoothed, then the line is fitted over it, then the
   calendar is re-applied to the horizon, and finally the zone
   split fans the week's demand out to the runs.

   Every stage is a pure function of the stage before it, and
   the composed forecast keeps all of them, so the showcase
   can show the seams as well as the sum. Nothing here reads a
   clock: the trend is the only thing fitted; the season shape
   and the events are the family's book — fixture data, not
   inference.
   ============================================================ */

import type { CalendarEvent, Forecast, Season, Smooth, Trend, ZoneCode, ZoneDemand } from "./types.ts";

export interface ForecastConfig {
  /** Exponential smoothing weight for the adjusted weekly series. */
  alpha: number;
  /** The family's annual shape: multiplier per calendar block. */
  seasonIndices: number[];
  weeksPerBlock: number;
  /** Week number the horizon starts on (history ends the week before). */
  horizonStartWeek: number;
  horizonWeeks: number;
  events: CalendarEvent[];
  /** Share of the DC's demand each zone carries (velocity share). */
  zoneShares: Record<ZoneCode, number>;
}

/** Stage 1 — the known calendar: season index × event, by week. */
export function calendarFactor(
  seasonIndices: number[],
  weeksPerBlock: number,
  events: CalendarEvent[],
  week: number,
): number {
  return seasonIndex(seasonIndices, weeksPerBlock, week) * eventMultiplier(events, week);
}

/**
 * Stage 1 — lift the known calendar off a series. The family
 * keeps the season and its events in its book; a week that
 * sold 1.25× is not a week that grows.
 */
export function adjustForCalendar(
  series: number[],
  seasonIndices: number[],
  weeksPerBlock: number,
  events: CalendarEvent[],
): number[] {
  return series.map((value, i) => {
    const week = i + 1;
    return value / calendarFactor(seasonIndices, weeksPerBlock, events, week);
  });
}

/** Stage 2 — exponential smoothing on the plain ledger. */
export function smooth(series: number[], alpha: number): Smooth {
  const out = new Array<number>(series.length);
  out[0] = series[0];
  for (let i = 1; i < series.length; i++) {
    out[i] = alpha * series[i] + (1 - alpha) * out[i - 1];
  }
  return { series: out, alpha };
}

/** Stage 3 — ordinary least squares over the smoothed level. */
export function fitTrend(adjusted: number[]): Trend {
  const n = adjusted.length;
  let sumT = 0;
  let sumY = 0;
  let sumTT = 0;
  let sumTY = 0;
  for (let t = 0; t < n; t++) {
    sumT += t;
    sumY += adjusted[t];
    sumTT += t * t;
    sumTY += t * adjusted[t];
  }
  const denom = n * sumTT - sumT * sumT;
  const slopePerWeek = denom === 0 ? 0 : (n * sumTY - sumT * sumY) / denom;
  const base = (sumY - slopePerWeek * sumT) / n;
  return { base, slopePerWeek, levels: adjusted };
}

/**
 * The annual shape the family keeps in its book, indexed by
 * absolute calendar block (block 0 covers weeks 1..wpb, and
 * the ring wraps every year of 13×wpb weeks).
 */
export function seasonIndex(indices: number[], weeksPerBlock: number, week: number): number {
  return indices[blockOf(week, indices.length, weeksPerBlock)];
}

function blockOf(week: number, blockCount: number, weeksPerBlock: number): number {
  const yearWeeks = blockCount * weeksPerBlock;
  const weekOfYear = ((week - 1) % yearWeeks + yearWeeks) % yearWeeks;
  return Math.floor(weekOfYear / weeksPerBlock);
}

/** Known events. A week under an event sails on its multiply. */
export function eventMultiplier(events: CalendarEvent[], week: number): number {
  const hit = events.find((event) => event.week === week);
  return hit ? hit.multiplier : 1;
}

/** Compose the stages into zone-level forecast lines for the horizon. */
export function forecast(history: number[], cfg: ForecastConfig): Forecast {
  const plain = adjustForCalendar(history, cfg.seasonIndices, cfg.weeksPerBlock, cfg.events);
  const staged: Smooth = smooth(plain, cfg.alpha);
  const trend: Trend = fitTrend(staged.series);
  const season: Season = {
    firstWeek: cfg.horizonStartWeek,
    weeksPerBlock: cfg.weeksPerBlock,
    indices: cfg.seasonIndices,
  };

  const total: number[] = [];
  for (let i = 0; i < cfg.horizonWeeks; i++) {
    const week = cfg.horizonStartWeek + i;
    const t = history.length + i;
    const level = trend.base + trend.slopePerWeek * t;
    total.push(level * calendarFactor(cfg.seasonIndices, cfg.weeksPerBlock, cfg.events, week));
  }

  const zones: ZoneDemand[] = zoneEntries(cfg.zoneShares).map(([zone, share]) => ({
    zone,
    lines: total.map((lines) => lines * share),
  }));

  return {
    history,
    firstWeek: cfg.horizonStartWeek,
    total,
    zones,
    season,
    trend,
    smooth: staged,
    events: cfg.events,
  };
}

function zoneEntries(shares: Record<ZoneCode, number>): Array<[ZoneCode, number]> {
  return (Object.entries(shares) as Array<[ZoneCode, number]>).sort((a, b) => a[0].localeCompare(b[0]));
}
