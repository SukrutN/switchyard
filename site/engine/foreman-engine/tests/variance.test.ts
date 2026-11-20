/* ============================================================
   variance characterization — the realization is a fixture:
   same seed, same tickets, any machine. The locks hold MAPE
   per zone, the hour waterfalls, the totals, and the law that
   the realization can never stray beyond its amplitude.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BRAMBLE,
  FORECAST_CONFIG,
  HISTORY,
  SUPPLEMENT_MINUTES,
  ZONE_STANDARDS,
  forecast,
  realizeActuals,
  variance,
  workload,
} from "../index.ts";
import { LOCKED } from "../fixtures/expected.ts";

const realize = () => realizeActuals(forecast(HISTORY, FORECAST_CONFIG), {
  seed: BRAMBLE.actualSeed,
  amplitude: BRAMBLE.actualNoiseAmplitude,
});

test("the realization is a fixture: two draws, one realization", () => {
  assert.deepEqual(realize(), realize());
  assert.equal(realize().length, 60); /* 5 zones × 12 weeks */
  /* the draw order is frozen: weeks ascending, zones in table order */
  const first = realize().slice(0, 5).map((r) => r.zone);
  assert.deepEqual(first, ZONE_STANDARDS.map((s) => s.zone));
});

test("the realization never strays beyond its amplitude", () => {
  for (const row of realize()) {
    const dev = Math.abs(row.actualLines - row.forecastLines) / row.forecastLines;
    /* rounding adds at most half a ticket on ~1.5k lines/zone-week */
    assert.ok(
      dev <= BRAMBLE.actualNoiseAmplitude + 0.002,
      `${row.week} ${row.zone} deviates ${(dev * 100).toFixed(3)}%`,
    );
  }
});

test("MAPE by zone is the locked one", () => {
  const vr = variance(realize(), BRAMBLE.actualSeed);
  for (const zone of vr.zones) {
    assert.ok(
      Math.abs(zone.mape - LOCKED.variance.mape[zone.zone]) < 0.002,
      `${zone.zone} MAPE ${zone.mape} vs lock ${LOCKED.variance.mape[zone.zone]}`,
    );
  }
  for (const zone of vr.zones) {
    assert.ok(zone.mape > 1.5, `${zone.zone} MAPE too good — a silent noise loss`);
    assert.ok(zone.mape < 4.5, `${zone.zone} MAPE too bad — a leak`);
  }
});

test("the waterfall: noise is the only thing between forecast and actual", () => {
  const vr = variance(realize(), BRAMBLE.actualSeed);
  const weeks = FORECAST_CONFIG.horizonWeeks;
  for (const zone of vr.zones) {
    const mpl = ZONE_STANDARDS.find((s) => s.zone === zone.zone)!.mplMinutes;
    /* the consumption the plan priced, recomputed another way:
       12 weeks of volume × MPL, one supplement hour a week */
    const recomputedForecastHours =
      (zone.forecastLines * mpl) / 60 + weeks * (SUPPLEMENT_MINUTES / 60);
    assert.ok(
      Math.abs(recomputedForecastHours - zone.forecastHours) < 0.01,
      `${zone.zone} forecast hours ${zone.forecastHours}`,
    );
    assert.ok(
      Math.abs(zone.actualHours - LOCKED.variance.actualHours[zone.zone]) < 0.01,
      `${zone.zone} actual hours ${zone.actualHours}`,
    );
    assert.ok(
      Math.abs(zone.noiseDelta - (zone.actualHours - zone.forecastHours)) < 1e-9,
      "the delta is the noise, nothing else",
    );
    const hoursJump = (zone.actualLines - zone.forecastLines) * mpl / 60;
    assert.ok(
      Math.abs(zone.noiseDelta - hoursJump) < 1e-9,
      "the round-trip through the standards agrees to the line",
    );
    assert.ok(Math.abs(recomputedForecastHours - zone.forecastHours) < 0.01);
  }
  assert.ok(
    Math.abs(vr.hoursGap - vr.zones.reduce((sum, z) => sum + z.noiseDelta, 0)) < 1e-9,
  );
  assert.ok(Math.abs(vr.hoursGap - LOCKED.variance.hoursGap) < 0.01);
});

test("the locked totals: forecast, actual, and the seed that drew them", () => {
  const vr = variance(realize(), BRAMBLE.actualSeed);
  assert.equal(vr.seed, LOCKED.variance.seed);
  for (const zone of vr.zones) {
    assert.equal(zone.actualLines, LOCKED.variance.actualLines[zone.zone]);
  }
  assert.ok(Math.abs(vr.totalForecastLines - LOCKED.variance.totalForecastLines) < 0.5);
  assert.equal(vr.totalActualLines, LOCKED.variance.totalActualLines);
});

test("the schedule consumed the same volume the variance judged", () => {
  const fc = forecast(HISTORY, FORECAST_CONFIG);
  const wl = workload(fc, ZONE_STANDARDS);
  const vr = variance(realizeActuals(fc, {
    seed: BRAMBLE.actualSeed,
    amplitude: BRAMBLE.actualNoiseAmplitude,
  }), BRAMBLE.actualSeed);
  /* the plan priced the forecast; variance prices the exact same forecast */
  const plannedHours = wl.rows.reduce((sum, row) => sum + row.hours, 0);
  const forecastHours = vr.zones.reduce((sum, zone) => sum + zone.forecastHours, 0);
  assert.ok(
    Math.abs(plannedHours - forecastHours) < 1e-6,
    `${plannedHours} plan hours vs ${forecastHours} variance hours`,
  );
});
