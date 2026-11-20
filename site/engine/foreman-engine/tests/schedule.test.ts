/* ============================================================
   schedule characterization — the casing's laws:
   1. every forecast hour is covered (covered stays true);
   2. no zone takes a band weaker than its floor;
   3. no band exceeds its pool's weekly cap;
   4. the fixture's bench was sized right: nothing spills;
   and on a hand-cut synthetic bench the spill walks UP the
   strength order and the plan refuses before it under-covers.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BANDS,
  FORECAST_CONFIG,
  HISTORY,
  SHIFT_SHARE,
  ZONE_FLOORS,
  ZONE_STANDARDS,
  allowedFor,
  forecast,
  plan,
  preferenceFor,
  workload,
} from "../index.ts";
import { LOCKED } from "../fixtures/expected.ts";
import type { BandId, PlanRow } from "../index.ts";

const BAND_ORDER: BandId[] = ["veteran", "day", "night"];
const rank = (band: BandId) => BAND_ORDER.indexOf(band);

const fullPipeline = () => {
  const fc = forecast(HISTORY, FORECAST_CONFIG);
  const wl = workload(fc, ZONE_STANDARDS);
  return { fc, wl, pl: plan(wl) };
};

test("the casing covers every forecast hour, exactly", () => {
  const { wl, pl } = fullPipeline();
  assert.equal(pl.compliance.covered, true);
  for (let i = 0; i < wl.weeks.length; i++) {
    const coveredHours = pl.rows
      .filter((row) => row.week === wl.weeks[i].week)
      .reduce((sum, row) => sum + row.standardHours, 0);
    assert.ok(
      Math.abs(coveredHours - wl.weeks[i].total) < 1e-6,
      `week ${wl.weeks[i].week}: covered ${coveredHours} vs forecast ${wl.weeks[i].total}`,
    );
  }
});

test("the shift split matches the fixture share", () => {
  const { wl, pl } = fullPipeline();
  for (const shift of ["day", "night"] as const) {
    for (const week of wl.weeks) {
      const shiftHours = pl.rows
        .filter((row) => row.week === week.week && row.shift === shift)
        .reduce((sum, row) => sum + row.standardHours, 0);
      assert.ok(
        Math.abs(shiftHours - week.total * SHIFT_SHARE[shift]) < 1e-6,
        `week ${week.week} ${shift}`,
      );
    }
  }
});

test("floors point one way: no band weaker than a zone's floor", () => {
  const { pl } = fullPipeline();
  assert.equal(pl.compliance.floorsRespected, true);
  for (const row of pl.rows) {
    assert.ok(
      rank(row.band) <= rank(ZONE_FLOORS[row.zone]),
      `${row.zone} took ${row.band} below its floor ${ZONE_FLOORS[row.zone]}`,
    );
  }
  /* the zone vocabulary respects the same rule by construction */
  assert.deepEqual(allowedFor("CIN"), ["veteran"]);
  assert.deepEqual(allowedFor("LOA"), ["veteran", "day"]);
  assert.deepEqual(allowedFor("COB"), ["veteran", "day", "night"]);
  /* the casing prefers the band the velocity runs best at, floor-first */
  assert.deepEqual(preferenceFor("CIN"), ["veteran"]);
  assert.deepEqual(preferenceFor("LOA"), ["day", "veteran"]);
  assert.deepEqual(preferenceFor("COB"), ["night", "day", "veteran"]);
});

test("no band exceeds its pool's weekly cap", () => {
  const { pl } = fullPipeline();
  assert.equal(pl.compliance.capsRespected, true);
  for (const band of BAND_ORDER) {
    const spec = BANDS.find((b) => b.id === band)!;
    pl.byBand[band].forEach((hours, i) => {
      assert.ok(
        hours <= spec.count * spec.hoursCap + 1e-6,
        `${band} week ${i}: ${hours} over ${spec.count * spec.hoursCap}`,
      );
    });
  }
});

test("the bench was sized right: the fixture locks paid hours, no spill", () => {
  const { wl, pl } = fullPipeline();
  assert.equal(pl.compliance.spilled, false);
  for (const band of BAND_ORDER) {
    pl.byBand[band].forEach((hours, i) => {
      assert.ok(
        Math.abs(hours - LOCKED.plan.byBand[band][i]) < 1e-3,
        `${band} week ${53 + i}: ${hours} vs ${LOCKED.plan.byBand[band][i]}`,
      );
    });
  }
  const peakFromByBand = Math.max(
    ...wl.weeks.map((_, i) =>
      BAND_ORDER.reduce((sum, b) => sum + pl.byBand[b][i], 0),
    ),
  );
  assert.ok(Math.abs(peakFromByBand - LOCKED.plan.peakPaid) < 1e-3);
  assert.equal(LOCKED.plan.poolHours, 248); /* vet 2×40 + day 3×40 + night 2×24 */
  assert.ok(Math.abs(LOCKED.plan.utilizationPeak - Number((LOCKED.plan.peakPaid / LOCKED.plan.poolHours).toFixed(4))) < 1e-9);
  assert.ok(Math.abs(LOCKED.plan.utilizationPeak - LOCKED.plan.peakPaid / LOCKED.plan.poolHours) < 1e-4);
});

test("the anniversary week is cased exactly as locked", () => {
  const { pl } = fullPipeline();
  const rows: PlanRow[] = pl.rows.filter((row) => row.week === 62);
  assert.equal(rows.length, LOCKED.plan.anniversary.length); /* 10 tasks, no spill */
  rows.forEach((row, i) => {
    const lock = LOCKED.plan.anniversary[i];
    assert.deepEqual([row.zone, row.shift, row.band], [lock.zone, lock.shift, lock.band]);
    assert.ok(Math.abs(row.standardHours - lock.standardHours) < 1e-3);
    assert.ok(Math.abs(row.paidHours - lock.paidHours) < 1e-3);
    assert.equal(row.headcount, lock.headcount);
  });
});

/* ---------- the synthetic bench: spill + refusal ---------- */

/* A hand-cut week against the fixture bench (vet 2×40, day 3×40,
   night 2×24 = 248 paid hours). One Cobalt zone is given a demand
   big enough to force the cascade, then to break it. plan() splits
   each zone's hours into day/night tasks first (0.72 / 0.28), so
   the numbers below are the honest, hand-checked cascade. */

function syntheticWorkload(cobaltHours: number) {
  return {
    weeks: [
      {
        week: 53,
        total: cobaltHours,
        rows: [
          {
            zone: "COB" as const,
            week: 53,
            lines: 0,
            standardHours: cobaltHours,
            supplementHours: 0,
            hours: cobaltHours,
          },
        ],
      },
    ],
    rows: [
      {
        zone: "COB" as const,
        week: 53,
        lines: 0,
        standardHours: cobaltHours,
        supplementHours: 0,
        hours: cobaltHours,
      },
    ],
  };
}

test("on a starved bench the spill walks up the strength order", () => {
  /* COB 100 h → day task 72, night task 28. The night desk's whole
     capacity (48 paid) rides the day task at factor 0.7 (33.6 std),
     the day band takes both tasks (38.4 + 28 std), nobody spills to
     the veterans — and every hour is still covered. */
  const pl = plan(syntheticWorkload(100));
  assert.equal(pl.compliance.covered, true);
  assert.equal(pl.compliance.spilled, true);
  assert.equal(pl.compliance.capsRespected, true);
  assert.equal(pl.compliance.floorsRespected, true);

  assert.deepEqual(pl.byBand.night, [48]); /* the whole night desk rode the day task */
  const dayPaid = 38.4 / 0.85 + 28 / 0.85;
  assert.ok(Math.abs(pl.byBand.day[0] - dayPaid) < 1e-9);
  assert.deepEqual(pl.byBand.veteran, [0]);

  const rows = pl.rows;
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].band, rows[0].spilled], ["night", false]);
  assert.ok(Math.abs(rows[0].standardHours - 33.6) < 1e-9);
  assert.ok(Math.abs(rows[0].paidHours - 48) < 1e-9);
  assert.equal(rows[0].headcount, 2);
  assert.deepEqual([rows[1].band, rows[1].spilled], ["day", true]);
  assert.ok(Math.abs(rows[1].standardHours - 38.4) < 1e-9);
  assert.equal(rows[2].band, "day");
  assert.equal(rows[2].spilled, true);
  const totalStandard = rows.reduce((sum, row) => sum + row.standardHours, 0);
  assert.ok(Math.abs(totalStandard - 100) < 1e-9);
});

test("the plan refuses before it under-covers", () => {
  /* COB's allowed bands can cover 48×0.7 + 120×0.85 + 80×1.0 = 215.6
     standard hours. 216.6 refuses — by exactly one hour. */
  const pl = plan(syntheticWorkload(216.6));
  assert.equal(pl.compliance.covered, false);
  assert.equal(pl.compliance.capsRespected, true);
  const totalStandard = pl.rows.reduce((sum, row) => sum + row.standardHours, 0);
  assert.ok(
    Math.abs(totalStandard - 215.6) < 1e-9,
    "the refusal happens only after the bench is dry",
  );
});
