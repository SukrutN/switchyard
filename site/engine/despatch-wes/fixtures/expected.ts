/* ============================================================
   expected — the WES lock: pure data, no imports. Written by
   hand ONCE from `fixtures/lock.ts`'s printed JSON (the human
   in the loop, per the engine family's convention) and read
   by the characterization tests. Tolerances: seconds ±0.5,
   counts exact, digests byte-exact (fnv1a64 hex).
   ============================================================ */

export interface WesDayLock {
  /** staged orders (the intake = the day's orders this run) */
  readonly orders: number;
  /** batched freezes (the window ladder's dry re-arms aren't here) */
  readonly freezes: number;
  /** work rows out */
  readonly batches: number;
  /** released receipt rows (a held batch adds its own rows) */
  readonly releaseRows: number;
  /** work rows per zone lane */
  readonly workZ1: number;
  readonly workZ2: number;
  readonly workZ3: number;
  readonly workZ4: number;
  /** fnv1a64 over each lane's msg rows (records.ts rowDigest) */
  readonly digests: {
    readonly release: string;
    readonly quarantine: string;
    readonly control: string;
    readonly workZ1: string;
    readonly workZ2: string;
    readonly workZ3: string;
    readonly workZ4: string;
  };
  /** the board's final state — the crash envelope's last commit */
  readonly board: {
    readonly releasedThrough: number;
    readonly freezeSeq: number;
    readonly nextFreeze: number;
    readonly given: readonly number[];
  };
}

export interface WesLatencyLock {
  /** released orders this curve covers */
  readonly orders: number;
  /** effectiveSec − arrivalSec percentiles (floor convention) */
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

export const WES_LOCK: {
  readonly averageDay: WesDayLock;
  readonly rushMorning: WesDayLock;
  readonly seasonalSpike: WesDayLock;
  readonly latency: WesLatencyLock;
} = {
  averageDay: {
    orders: 204,
    freezes: 172,
    batches: 180,
    releaseRows: 180,
    workZ1: 49,
    workZ2: 49,
    workZ3: 51,
    workZ4: 31,
    digests: {
      release: "731283e207d2b6ed",
      quarantine: "cbf29ce484222325",
      control: "cbf29ce484222325",
      workZ1: "677a94a1dbf54b81",
      workZ2: "f5fa9db861352617",
      workZ3: "8a9bcf4f0a5756c4",
      workZ4: "8d75fb0983670051",
    },
    board: {
      releasedThrough: 204,
      freezeSeq: 172,
      nextFreeze: 18136,
      given: [17473.2, 20010, 22824.4, 14690.2],
    },
  },
  rushMorning: {
    orders: 268,
    freezes: 160,
    batches: 169,
    releaseRows: 169,
    workZ1: 53,
    workZ2: 42,
    workZ3: 46,
    workZ4: 28,
    digests: {
      release: "1e0cf96896b3904a",
      quarantine: "cbf29ce484222325",
      control: "cbf29ce484222325",
      workZ1: "e6e91ff506128fb2",
      workZ2: "33aed837ec2bd9fc",
      workZ3: "a748f79dd57c17bd",
      workZ4: "948256ea8e60211a",
    },
    board: {
      releasedThrough: 268,
      freezeSeq: 160,
      nextFreeze: 14522,
      given: [18658.6, 16255.2, 19358.8, 12300.2],
    },
  },
  seasonalSpike: {
    orders: 426,
    freezes: 200,
    batches: 246,
    releaseRows: 246,
    workZ1: 93,
    workZ2: 61,
    workZ3: 45,
    workZ4: 47,
    digests: {
      release: "04b5a0c2c4616a44",
      quarantine: "cbf29ce484222325",
      control: "cbf29ce484222325",
      workZ1: "e64df60810739a89",
      workZ2: "13100db4034f9782",
      workZ3: "6a89cfb7affdcf49",
      workZ4: "ad3588df2476cf3e",
    },
    board: {
      releasedThrough: 426,
      freezeSeq: 200,
      nextFreeze: 18147,
      given: [38127.4, 29806.6, 23122.6, 25067],
    },
  },
  latency: {
    orders: 204,
    p50: 1149,
    p90: 4530,
    p99: 5250,
    max: 5361,
    mean: 1722.43,
  },
};
