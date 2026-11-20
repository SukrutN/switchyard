/* ============================================================
   Bramble & Twine — Meadowfield DC, the arc's worked example.

   52 weeks of ledger, built deterministically from a seeded
   stream so the same bytes sit behind every figure: weekly
   totals straight from the family calendar, one opener tent
   sale inside the year, the spring surge as the next year's
   first quarter (the plan horizon).

   The labor plan prices five runs with northspan's counter-
   refill standards (fixtures/standards.ts, sheet 05's own
   export): the zone codes here are the standards' row keys.

   The generator is code; the locks in fixtures/expected.ts pin
   it. Nothing reads a clock or asks the network.
   ============================================================ */

import { mulberry32 } from "../src/rng.ts";
import type { CalendarEvent, ZoneCode } from "../src/types.ts";

export const BRAMBLE = {
  house: "Bramble & Twine",
  site: "Meadowfield distribution center",
  /** Weekly base at the head of the ledger year. */
  baseLinesPerWeek: 12400,
  /** Mild compounding growth the forecaster may fit or misfit. */
  growthPerWeek: 1.003,
  /** Weekly realization noise. */
  historyNoiseAmplitude: 0.06,
  /** Seeded stream for the history year. */
  historySeed: 20261105,
  /** Seeded stream for the variance realization. */
  actualSeed: 20261106,
  /** Max multiplicative jolt on a zone-week of the realization. */
  actualNoiseAmplitude: 0.055,
} as const;

/** Zone split by velocity share — the shape Kiln Annex works at. */
export const ZONE_SHARES: Record<ZoneCode, number> = {
  CIN: 0.34,
  LOA: 0.17,
  FLI: 0.18,
  REE: 0.15,
  COB: 0.16,
};

/**
 * The family's annual shape, 13 four-week blocks, tallest at the
 * spring surge. Normalized so the year's mean multiplier is 1.
 */
const SEASONAL_SHAPE = [1.3, 1.38, 1.34, 1.18, 1.02, 0.94, 0.88, 0.82, 0.86, 0.92, 1.04, 1.16, 1.26];

export const SEASON_INDICES: number[] = normalizeShape(SEASONAL_SHAPE);

function normalizeShape(shape: number[]): number[] {
  const mean = shape.reduce((sum, x) => sum + x, 0) / shape.length;
  return shape.map((x) => x / mean);
}

/** Events the family knows about before it plans: the opener inside
 *  the ledger year and the two weeks of the spring surge. */
export const EVENTS: CalendarEvent[] = [
  { label: "Tent sale", week: 12, multiplier: 1.25, note: "The year's opener: a full week of walk-up trade." },
  { label: "Spring trade", week: 58, multiplier: 1.18, note: "The tent returns to the apron for the season." },
  { label: "Anniversary", week: 62, multiplier: 1.24, note: "The counter's own week; the surge at its peak." },
];

/** The 52 weeks of ledger: weekly lines shipped, week 1 first. */
export const HISTORY: number[] = buildHistory();

function buildHistory(): number[] {
  const rng = mulberry32(BRAMBLE.historySeed);
  const weeks: number[] = [];
  for (let w = 1; w <= 52; w++) {
    const t = w - 1;
    const level = BRAMBLE.baseLinesPerWeek * Math.pow(BRAMBLE.growthPerWeek, t);
    const block = Math.floor(t / 4) % SEASON_INDICES.length;
    const event = EVENTS.find((e) => e.week === w)?.multiplier ?? 1;
    weeks.push(Math.round(level * SEASON_INDICES[block] * event * (1 + (rng() * 2 - 1) * BRAMBLE.historyNoiseAmplitude)));
  }
  return weeks;
}

/** Forecaster configuration, straight off this fixture. The events
 *  list is the family's whole calendar: the trend is fitted with it
 *  lifted off, and the horizon re-applies its own weeks. */
export const FORECAST_CONFIG = {
  alpha: 0.35,
  seasonIndices: SEASON_INDICES,
  weeksPerBlock: 4,
  horizonStartWeek: 53,
  horizonWeeks: 12,
  events: EVENTS,
  zoneShares: ZONE_SHARES,
} as const;
