/* ============================================================
   expected — the locked characterization values for the three
   worked days.

   Locked 2026-10-24, printed by the engine they describe, from
   the seeded days in fixtures/dc.ts. The tests hold tours and
   wait seconds to ±0.5 s, ratios to ±0.002, cart counts exactly:
   float noise and cosmetic re-hash swim underneath, but any
   change in behavior fails loud.
   ============================================================ */

export interface LockedDay {
  /** orders the seeded day drew */
  orders: number;
  /** pick units the day carried */
  lines: number;
  /** cart tours the construction pass opened */
  batches: number;
  /** naive release: one order, one cart, out as it lands */
  fcfsTourSec: number;
  /** the construction pass's walk total */
  totalTourSec: number;
  /** (fcfs − batched) / fcfs */
  walksSaved: number;
  /** the tabu pass's seconds clawed back */
  tabuDeltaSec: number;
  tabuDeltaPct: number;
  /** applied moves in the pass */
  tabuApplied: number;
}

export interface LockedWindow {
  freezes: number;
  walksSaved: number;
  meanWaitSec: number;
  p90WaitSec: number;
  meanTardySec: number;
  p90TardySec: number;
  maxTardySec: number;
  lateOrders: number;
}

export interface LockedRelease {
  peakUnpacedCarts: number;
  peakPacedCarts: number;
  /** batches the paced plan released past their tightest due */
  breachedPaced: number;
  lastPacedSec: number;
  zonePeaksPaced: number[];
}

export const LOCKED_DAYS: Record<
  "average-day" | "rush-morning" | "seasonal-spike",
  {
    day: LockedDay;
    windows: Record<string, LockedWindow>;
    release: LockedRelease;
  }
> = {
  "average-day": {
    day: {
      orders: 204,
      lines: 1477,
      batches: 83,
      fcfsTourSec: 33385.4,
      totalTourSec: 17282.6,
      walksSaved: 0.4823,
      tabuDeltaSec: 854.8,
      tabuDeltaPct: 0.0495,
      tabuApplied: 20,
    },
    windows: {
      "45": {
        freezes: 199,
        walksSaved: 0.0019,
        meanWaitSec: 34.1,
        p90WaitSec: 45,
        meanTardySec: 0,
        p90TardySec: 0,
        maxTardySec: 0,
        lateOrders: 0,
      },
      "90": {
        freezes: 172,
        walksSaved: 0.0476,
        meanWaitSec: 48.9,
        p90WaitSec: 90,
        meanTardySec: 0,
        p90TardySec: 0,
        maxTardySec: 0,
        lateOrders: 0,
      },
      "150": {
        freezes: 120,
        walksSaved: 0.1428,
        meanWaitSec: 71.4,
        p90WaitSec: 133,
        meanTardySec: 0,
        p90TardySec: 0,
        maxTardySec: 0,
        lateOrders: 0,
      },
      "240": {
        freezes: 75,
        walksSaved: 0.2125,
        meanWaitSec: 120.2,
        p90WaitSec: 211,
        meanTardySec: 0,
        p90TardySec: 0,
        maxTardySec: 0,
        lateOrders: 0,
      },
      "360": {
        freezes: 50,
        walksSaved: 0.2599,
        meanWaitSec: 182,
        p90WaitSec: 325,
        meanTardySec: 0,
        p90TardySec: 0,
        maxTardySec: 0,
        lateOrders: 0,
      },
      "720": {
        freezes: 25,
        walksSaved: 0.3319,
        meanWaitSec: 353.1,
        p90WaitSec: 638,
        meanTardySec: 0.18,
        p90TardySec: 0,
        maxTardySec: 22,
        lateOrders: 2,
      },
    },
    release: {
      peakUnpacedCarts: 14,
      peakPacedCarts: 8,
      breachedPaced: 17,
      lastPacedSec: 22846,
      zonePeaksPaced: [8, 4, 3, 5],
    },
  },
  "rush-morning": {
    day: {
      orders: 268,
      lines: 1008,
      batches: 60,
      fcfsTourSec: 31190.8,
      totalTourSec: 10348.6,
      walksSaved: 0.6682,
      tabuDeltaSec: 953.2,
      tabuDeltaPct: 0.0921,
      tabuApplied: 20,
    },
    windows: {
      "45": {
        freezes: 239,
        walksSaved: 0.0425,
        meanWaitSec: 26.2,
        p90WaitSec: 45,
        meanTardySec: 0,
        p90TardySec: 0,
        maxTardySec: 0,
        lateOrders: 0,
      },
      "90": {
        freezes: 160,
        walksSaved: 0.166,
        meanWaitSec: 44.9,
        p90WaitSec: 83,
        meanTardySec: 0,
        p90TardySec: 0,
        maxTardySec: 0,
        lateOrders: 0,
      },
      "150": {
        freezes: 96,
        walksSaved: 0.2792,
        meanWaitSec: 74.1,
        p90WaitSec: 137,
        meanTardySec: 0,
        p90TardySec: 0,
        maxTardySec: 0,
        lateOrders: 0,
      },
      "240": {
        freezes: 60,
        walksSaved: 0.3682,
        meanWaitSec: 119,
        p90WaitSec: 216,
        meanTardySec: 0,
        p90TardySec: 0,
        maxTardySec: 0,
        lateOrders: 0,
      },
      "360": {
        freezes: 40,
        walksSaved: 0.4376,
        meanWaitSec: 181.2,
        p90WaitSec: 319,
        meanTardySec: 0,
        p90TardySec: 0,
        maxTardySec: 0,
        lateOrders: 0,
      },
      "720": {
        freezes: 20,
        walksSaved: 0.5069,
        meanWaitSec: 359.9,
        p90WaitSec: 651,
        meanTardySec: 0.27,
        p90TardySec: 0,
        maxTardySec: 39,
        lateOrders: 2,
      },
    },
    release: {
      peakUnpacedCarts: 16,
      peakPacedCarts: 6,
      breachedPaced: 21,
      lastPacedSec: 19412,
      zonePeaksPaced: [6, 3, 6, 4],
    },
  },
  "seasonal-spike": {
    day: {
      orders: 426,
      lines: 2992,
      batches: 165,
      fcfsTourSec: 69143.8,
      totalTourSec: 33712,
      walksSaved: 0.5124,
      tabuDeltaSec: 1037.4,
      tabuDeltaPct: 0.0308,
      tabuApplied: 20,
    },
    windows: {
      "45": {
        freezes: 351,
        walksSaved: 0.0623,
        meanWaitSec: 24.4,
        p90WaitSec: 45,
        meanTardySec: 0,
        p90TardySec: 0,
        maxTardySec: 0,
        lateOrders: 0,
      },
      "90": {
        freezes: 200,
        walksSaved: 0.1744,
        meanWaitSec: 45.5,
        p90WaitSec: 81,
        meanTardySec: 0,
        p90TardySec: 0,
        maxTardySec: 0,
        lateOrders: 0,
      },
      "150": {
        freezes: 120,
        walksSaved: 0.2439,
        meanWaitSec: 75.3,
        p90WaitSec: 134,
        meanTardySec: 0,
        p90TardySec: 0,
        maxTardySec: 0,
        lateOrders: 0,
      },
      "240": {
        freezes: 75,
        walksSaved: 0.2954,
        meanWaitSec: 119,
        p90WaitSec: 217,
        meanTardySec: 0,
        p90TardySec: 0,
        maxTardySec: 0,
        lateOrders: 0,
      },
      "360": {
        freezes: 50,
        walksSaved: 0.3369,
        meanWaitSec: 179,
        p90WaitSec: 321,
        meanTardySec: 0,
        p90TardySec: 0,
        maxTardySec: 0,
        lateOrders: 0,
      },
      "720": {
        freezes: 25,
        walksSaved: 0.3783,
        meanWaitSec: 357.3,
        p90WaitSec: 639,
        meanTardySec: 0.38,
        p90TardySec: 0,
        maxTardySec: 75,
        lateOrders: 3,
      },
    },
    release: {
      peakUnpacedCarts: 51,
      peakPacedCarts: 50,
      breachedPaced: 0,
      lastPacedSec: 19107,
      zonePeaksPaced: [50, 27, 13, 15],
    },
  },
};
