/* ============================================================
   workload characterization — the conversion is northspan's
   table, verbatim, consumed at 1e-9: the foreman carries no
   coefficients of its own. The standards pin below is
   hard-coded from sheet 05's locked export so editing the
   fixture (or the upstream table it mirrors) breaks loud.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FORECAST_CONFIG,
  HISTORY,
  SUPPLEMENT_MINUTES,
  ZONE_STANDARDS,
  forecast,
  workload,
  zoneHours,
} from "../index.ts";
import { LOCKED } from "../fixtures/expected.ts";

/* the northspan counter-refill standards, hard-coded: sheet 05's law */
const NORTHSPAN_MPL = { CIN: 0.364, LOA: 0.416, FLI: 0.44, REE: 0.406, COB: 0.451 } as const;

test("the standards fixture is the northspan export, verbatim", () => {
  assert.deepEqual(
    ZONE_STANDARDS.map((s) => s.zone),
    Object.keys(NORTHSPAN_MPL),
  );
  for (const standard of ZONE_STANDARDS) {
    assert.equal(
      standard.mplMinutes,
      NORTHSPAN_MPL[standard.zone],
      `${standard.zone} minutes per line must match sheet 05's locked export`,
    );
  }
  assert.equal(SUPPLEMENT_MINUTES, 60);
});

test("the conversion consumes the table exactly — 1e-9, no drift", () => {
  const fc = forecast(HISTORY, FORECAST_CONFIG);
  const wl = workload(fc, ZONE_STANDARDS);
  for (const row of wl.rows) {
    const mpl = NORTHSPAN_MPL[row.zone];
    const standardHours = (row.lines * mpl) / 60;
    assert.ok(
      Math.abs(row.standardHours - standardHours) < 1e-9,
      `${row.zone} week ${row.week}: ${row.standardHours} vs ${standardHours}`,
    );
    assert.equal(row.supplementHours, SUPPLEMENT_MINUTES / 60);
    assert.ok(
      Math.abs(row.hours - (standardHours + SUPPLEMENT_MINUTES / 60)) < 1e-9,
    );
  }
});

test("zoneHours is the pure unit of the same arithmetic", () => {
  const cin = ZONE_STANDARDS.find((s) => s.zone === "CIN")!;
  const row = zoneHours(cin, 1000, 53);
  assert.equal((row.lines * 0.364) / 60, row.standardHours);
  assert.equal((1000 * 0.364) / 60, 6.066666666666666);
  assert.ok(Math.abs(row.standardHours - 6.066666666666666) < 1e-12);
  assert.ok(Math.abs(row.hours - (6.066666666666666 + 1)) < 1e-12);
});

test("the horizon converts to the locked hours, week by week", () => {
  const fc = forecast(HISTORY, FORECAST_CONFIG);
  const wl = workload(fc, ZONE_STANDARDS);
  assert.equal(wl.weeks.length, 12);
  assert.equal(wl.rows.length, 60); /* 5 zones × 12 weeks */
  wl.weeks.forEach((weekRow, i) => {
    assert.ok(
      Math.abs(weekRow.total - LOCKED.workload.weekly[i]) < 1e-3,
      `week ${weekRow.week} total ${weekRow.total}`,
    );
  });
  assert.ok(Math.abs(wl.rows.reduce((sum, r) => sum + r.hours, 0) - LOCKED.workload.total) < 1e-3);

  /* the weekly standards consumed equal the weekly standards consumed
     through the fixture table — same numbers, one summing */
  const throughTable = wl.rows.reduce((sum, row) => {
    const mpl = ZONE_STANDARDS.find((s) => s.zone === row.zone)!.mplMinutes;
    return sum + row.lines * mpl / 60 + 1;
  }, 0);
  assert.ok(Math.abs(throughTable - LOCKED.workload.total) < 1e-3);
});

test("minutes per line carry the catalogue's velocity order", () => {
  for (const standard of ZONE_STANDARDS) {
    if (standard.velocity === "hot") {
      assert.equal(standard.mplMinutes, Math.min(...ZONE_STANDARDS.map((s) => s.mplMinutes)));
    }
    if (standard.velocity === "calm") {
      assert.equal(standard.mplMinutes, Math.max(...ZONE_STANDARDS.map((s) => s.mplMinutes)));
    }
  }
});
