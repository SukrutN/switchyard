/* ============================================================
   forecaster characterization — the staged pipeline against
   the locks: history reconstruction, stage params, the ring
   of the seasonal index, the calendar, and the composed
   horizon. A second run through the same door must produce
   the same totals — the planner is a function, stateless.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BRAMBLE,
  EVENTS,
  FORECAST_CONFIG,
  HISTORY,
  SEASON_INDICES,
  ZONE_SHARES,
  adjustForCalendar,
  calendarFactor,
  eventMultiplier,
  fitTrend,
  forecast,
  seasonIndex,
  smooth,
} from "../index.ts";
import { LOCKED } from "../fixtures/expected.ts";

const TOL = 0.01; /* reads the locks at their printed precision */

test("the ledger is a 52-week realization of the known season", () => {
  assert.equal(HISTORY.length, 52);
  assert.deepEqual(HISTORY.slice(0, 4), LOCKED.history.first);
  assert.deepEqual(HISTORY.slice(-4), LOCKED.history.last);
  assert.equal(
    HISTORY.reduce((sum, x) => sum + x, 0),
    LOCKED.history.sum,
  );

  /* Every week sits inside ±6% of its expectation: base×growth×season×event.
     The generator is the fixture's own story — this test holds it charitably. */
  for (let w = 1; w <= 52; w++) {
    const t = w - 1;
    const level = BRAMBLE.baseLinesPerWeek * Math.pow(BRAMBLE.growthPerWeek, t);
    const shape = SEASON_INDICES[Math.floor(t / 4)];
    const event = eventMultiplier(EVENTS, w);
    const expectedLevel = level * shape * event;
    const dev = Math.abs(HISTORY[t] - expectedLevel) / expectedLevel;
    assert.ok(
      dev <= BRAMBLE.historyNoiseAmplitude + 0.002,
      `week ${w} drifts ${dev.toFixed(4)} from its expectation`,
    );
  }
});

test("the seasonal shape is normalized: mean exactly 1, surged at spring", () => {
  const mean = SEASON_INDICES.reduce((sum, x) => sum + x, 0) / SEASON_INDICES.length;
  assert.ok(Math.abs(mean - 1) < 1e-12, "shape must average exactly 1");
  assert.deepEqual(
    SEASON_INDICES.map((x) => Number(x.toFixed(5))),
    LOCKED.seasonIndices,
  );
  assert.equal(Math.max(...SEASON_INDICES), SEASON_INDICES[1]); /* block 1: the surge's crown */
});

test("smoothing is exponential and indifferent to history order", () => {
  const out = smooth([100, 110], 0.5);
  assert.equal(out.series[0], 100);
  assert.ok(Math.abs(out.series[1] - 105) < 1e-12);
  assert.equal(out.alpha, 0.5);
  assert.deepEqual(smooth([100, 110], 0.5).series, out.series);
});

test("the trend fits a seasonally adjusted straight line to 1e-9", () => {
  const line = [100, 102, 104, 106, 108];
  const trend = fitTrend(line);
  assert.ok(Math.abs(trend.slopePerWeek - 2) < 1e-9);
  assert.ok(Math.abs(trend.base - 100) < 1e-9);

  /* lifting the known calendar off the RAW ledger, then smoothing:
     the level under the OLS is a plain week's worth of demand —
     inside noise, with the ES lag shy of a rising level */
  const plain = adjustForCalendar(
    HISTORY,
    FORECAST_CONFIG.seasonIndices,
    FORECAST_CONFIG.weeksPerBlock,
    FORECAST_CONFIG.events,
  );
  const adjusted = smooth(plain, FORECAST_CONFIG.alpha).series;
  assert.equal(adjusted.length, 52);
  const devs: number[] = [];
  for (let t = 0; t < 52; t++) {
    const expectedLevel = BRAMBLE.baseLinesPerWeek * Math.pow(BRAMBLE.growthPerWeek, t);
    devs.push((adjusted[t] - expectedLevel) / expectedLevel);
  }
  const absDevs = devs.map((dev) => Math.abs(dev));
  const meanDev = absDevs.reduce((sum, dev) => sum + dev, 0) / 52;
  /* ES carries the noise at a fraction of its raw amplitude and lags
     the growth a hair. Measured on the 2026-11-05 lock: mean 1.6%,
     max 4.8% (week 1, unsmoothed). */
  assert.ok(meanDev <= 0.03, `mean adjusted drift ${(meanDev * 100).toFixed(2)}%`);
  assert.ok(Math.max(...absDevs) <= 0.065, `max adjusted drift ${(Math.max(...absDevs) * 100).toFixed(2)}%`);
});

test("the seasonal index rings the calendar year", () => {
  assert.equal(seasonIndex(SEASON_INDICES, 4, 1), SEASON_INDICES[0]);
  assert.equal(seasonIndex(SEASON_INDICES, 4, 4), SEASON_INDICES[0]);
  assert.equal(seasonIndex(SEASON_INDICES, 4, 5), SEASON_INDICES[1]);
  assert.equal(seasonIndex(SEASON_INDICES, 4, 52), SEASON_INDICES[12]);
  assert.equal(seasonIndex(SEASON_INDICES, 4, 53), SEASON_INDICES[0], "the year wraps");
  assert.equal(seasonIndex(SEASON_INDICES, 4, 64), SEASON_INDICES[2]);
});

test("known events ride their weeks and only their weeks", () => {
  assert.equal(eventMultiplier(EVENTS, 12), 1.25);
  assert.equal(eventMultiplier(EVENTS, 58), 1.18);
  assert.equal(eventMultiplier(EVENTS, 62), 1.24);
  assert.equal(eventMultiplier(EVENTS, 57), 1);
  /* the family's whole calendar rides with the forecaster: the opener's
     event lifted off the trend, the surge's two re-applied on the
     horizon */
  assert.deepEqual(FORECAST_CONFIG.events, EVENTS);
  assert.equal(
    calendarFactor(FORECAST_CONFIG.seasonIndices, 4, EVENTS, 12),
    SEASON_INDICES[2] * 1.25,
  );
});

test("the composed horizon is the locked one, peak at the anniversary", () => {
  const fc = forecast(HISTORY, FORECAST_CONFIG);
  assert.ok(Math.abs(fc.trend.base - LOCKED.trend.base) < TOL);
  assert.ok(Math.abs(fc.trend.slopePerWeek - LOCKED.trend.slopePerWeek) < TOL);
  assert.equal(fc.total.length, 12);
  fc.total.forEach((value, i) => {
    assert.ok(Math.abs(value - LOCKED.forecastTotals[i]) < TOL, `week ${53 + i} total`);
  });
  assert.equal(FORECAST_CONFIG.horizonStartWeek + fc.total.indexOf(Math.max(...fc.total)), 62);

  /* the zone split multiplies to the total, exactly */
  const sum = Object.values(ZONE_SHARES).reduce((acc, share) => acc + share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, "the five zones own the week's demand");
  fc.zones.forEach((zoneDemand) => {
    const share = ZONE_SHARES[zoneDemand.zone];
    assert.ok(
      Math.abs(zoneDemand.lines[0] - fc.total[0] * share) < 1e-9,
      `${zoneDemand.zone} share`,
    );
    assert.ok(
      Math.abs(
        zoneDemand.lines.reduce((a, b) => a + b, 0) -
          fc.total.reduce((a, b) => a + b, 0) * share,
      ) < 1e-6,
      `${zoneDemand.zone} share sums`,
    );
  });
});

test("the planner is a function: run twice, same totals", () => {
  const a = forecast(HISTORY, FORECAST_CONFIG);
  const b = forecast(HISTORY, FORECAST_CONFIG);
  assert.deepEqual(b.total, a.total);
  assert.deepEqual(b.trend.base, a.trend.base);
  assert.deepEqual(b.zones.map((z) => z.lines), a.zones.map((z) => z.lines));
});
