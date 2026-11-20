/* ============================================================
   expected — the locked characterization values for the
   foreman's year, printed once by the engine's own
   fixtures/lock.ts and pasted here by hand (pure data, no
   imports, per the engine family's convention).

   Locked 2026-11-05, after the staged order settled: the
   known calendar lifts off the raw ledger, THEN smoothing,
   then the OLS line, then the calendar re-applied to the
   horizon, then the zone split. The tests hold numbers to
   small tolerances (1e-3 of the last printed digit unless
   stated) so float noise swims underneath, but any drift in
   stage parameters, the standards' consumption, the casing,
   or the seeded realization is caught the moment it shows.

   The Northspan numbers (0.364 / 0.416 / 0.440 / 0.406 /
   0.451 min per line) are locked again in
   tests/workload.test.ts, hard-coded, so editing the
   standards fixture breaks loud.
   ============================================================ */

export const LOCKED = {
  history: {
    length: 52,
    first: [14153, 15134, 14463, 14862],
    last: [16719, 15881, 16956, 16328],
    sum: 694556,
  },
  seasonIndices: [
    1.19858, 1.27234, 1.23546, 1.08794, 0.94043, 0.86667, 0.81135, 0.75603, 0.79291, 0.84823,
    0.95887, 1.0695, 1.1617,
  ],
  trend: {
    base: 12043.4573,
    slopePerWeek: 46.9473,
  },
  forecastTotals: [
    17361.11, 17417.38, 17473.65, 17529.92, 18668.42, 22099.22, 18787.88, 18847.62, 18359.31,
    22837.47, 18475.31, 18533.32,
  ],
  workload: {
    weekly: [
      122.691, 123.072, 123.454, 123.835, 131.553, 154.811, 132.363, 132.768, 129.458, 159.815,
      130.244, 130.637,
    ],
    total: 1594.702,
  },
  plan: {
    compliance: {
      covered: true,
      floorsRespected: true,
      capsRespected: true,
      spilled: false,
    },
    byBand: {
      veteran: [
        36.81, 36.926, 37.042, 37.158, 39.507, 46.583, 39.753, 39.876, 38.869, 48.106, 39.108,
        39.228,
      ],
      day: [
        75.295, 75.528, 75.761, 75.993, 80.7, 94.882, 81.193, 81.44, 79.422, 97.933, 79.901,
        80.141,
      ],
      night: [
        31.257, 31.353, 31.45, 31.547, 33.503, 39.397, 33.708, 33.811, 32.972, 40.666, 33.171,
        33.271,
      ],
    },
    peakPaid: 186.705,
    poolHours: 248,
    utilizationPeak: 0.7528,
    anniversary: [
      { zone: "CIN", shift: "day", band: "veteran", standardHours: 34.636, paidHours: 34.636, headcount: 1 },
      { zone: "CIN", shift: "night", band: "veteran", standardHours: 13.47, paidHours: 13.47, headcount: 1 },
      { zone: "FLI", shift: "day", band: "day", standardHours: 22.425, paidHours: 26.382, headcount: 1 },
      { zone: "FLI", shift: "night", band: "day", standardHours: 8.721, paidHours: 10.26, headcount: 1 },
      { zone: "COB", shift: "day", band: "night", standardHours: 20.495, paidHours: 29.279, headcount: 2 },
      { zone: "COB", shift: "night", band: "night", standardHours: 7.97, paidHours: 11.386, headcount: 1 },
      { zone: "LOA", shift: "day", band: "day", standardHours: 20.101, paidHours: 23.648, headcount: 1 },
      { zone: "LOA", shift: "night", band: "day", standardHours: 7.817, paidHours: 9.196, headcount: 1 },
      { zone: "REE", shift: "day", band: "day", standardHours: 17.41, paidHours: 20.482, headcount: 1 },
      { zone: "REE", shift: "night", band: "day", standardHours: 6.77, paidHours: 7.965, headcount: 1 },
    ],
  },
  variance: {
    seed: 20261106,
    amplitude: 0.055,
    mape: { CIN: 2.9078, LOA: 2.0759, FLI: 2.6074, REE: 2.6464, COB: 3.0157 },
    forecastHours: {
      CIN: 478.968,
      LOA: 278.839,
      FLI: 310.836,
      REE: 241.786,
      COB: 284.272,
    },
    actualHours: {
      CIN: 473.516,
      LOA: 281.7,
      FLI: 312.102,
      REE: 245.017,
      COB: 287.426,
    },
    actualLines: {
      CIN: 76074,
      LOA: 38899,
      FLI: 40923,
      REE: 34436,
      COB: 36642,
    },
    totalForecastLines: 226391,
    totalActualLines: 226974,
    hoursGap: 5.058,
  },
} as const;
