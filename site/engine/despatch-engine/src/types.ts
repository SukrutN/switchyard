/* ============================================================
   despatch-engine vocabulary — orders, the DC layout, batches,
   the on-line freeze ledger, and the release schedule.

   Everything is plain data: the site, the tests, and the bench
   all read the same serializable shapes.
   ============================================================ */

/* ---------- the floor ---------- */

/** where a pick face lives: aisle runs 1..N front to back columnwise. */
export interface PickPos {
  readonly aisle: number; // 1-based, west → east
  readonly bay: number;   // 1-based, front cross-aisle → rear
}

/** the layout model — the seam northspan would slot into. */
export interface DcMap {
  readonly name: string;
  readonly aisles: number; // columns of pick faces
  readonly bays: number;   // pick faces per aisle
  readonly depotAisle: number; // the mouth the carts start at
  /** label of the travel proxy, so a README can name what moved */
  readonly proxy: string;
}

/* ---------- demand ---------- */

export type OrderClass = "standard" | "expedite" | "critical";

export interface OrderLine {
  readonly sku: string;
  readonly qty: number;
}

/** one order on the stream: arrival, contents, class, due. */
export interface DespatchOrder {
  readonly id: string;
  readonly arrivalSec: number;
  readonly lines: readonly OrderLine[];
  readonly cls: OrderClass;
  readonly dueSec: number;
}

/** catalog entry: the map's slotting promises where each SKU lives. */
export interface CatalogEntry {
  readonly sku: string;
  readonly name: string;
  readonly aisle: number;
  readonly bay: number;
  /** pick-face velocity tier: 0 fastest — the slotter's say */
  readonly tier: 0 | 1 | 2;
}

/* ---------- batches ---------- */

/** one pick stop: sku, where, how many (qty merged across orders). */
export interface PickStop {
  readonly sku: string;
  readonly pos: PickPos;
  readonly qty: number;
}

/** the internal ledger of one tour's proxy — the drawn numbers. */
export interface TourLedger {
  readonly horizontalSec: number; // front cross-aisle sweep
  readonly verticalSec: number;   // in-and-out of visited aisles
  readonly stopsSec: number;      // stop at every pick face
  readonly tourSec: number;       // the sum
  readonly aislesVisited: number;
  readonly deepestBay: number;
}

/** a cart tour: a set of orders, their merged stops, its proxy tour. */
export interface Batch {
  readonly id: string;
  readonly orders: readonly string[];
  readonly lines: number; // Σ order lines (the cart's load)
  readonly stops: readonly PickStop[];
  readonly ledger: TourLedger;
  /** zone of the plurality of its stop lines — release pacing's key */
  readonly zone: number; // 0-based
}

export interface BatchRun {
  readonly batches: readonly Batch[];
  readonly totalTourSec: number;
  /** the naive baseline: one order, one cart, released as it lands */
  readonly fcfsTourSec: number;
  /** walks saved vs fcfs: (fcfs − batched) / fcfs */
  readonly walksSaved: number;
  /** the seed order of each constructed batch, for the hall's story */
  readonly seeds: readonly { readonly batchId: string; readonly orderId: string }[];
}

/* ---------- on-line (v0.2) ---------- */

/** one freeze: the wall-clock moment work left the despatch board. */
export interface Freeze {
  readonly freezeSec: number;
  readonly batchIds: readonly string[];
  readonly orderIds: readonly string[];
  readonly lines: number;
}

export interface OnlineRun {
  readonly windowSec: number;
  readonly freezes: readonly Freeze[];
  /** the batches published across the day, freeze-tagged ids */
  readonly publishedBatches: readonly Batch[];
  /** batch id → the freeze second it left the board */
  readonly batchPublish: Readonly<Record<string, number>>;
  readonly totalTourSec: number;
  readonly fcfsTourSec: number;
  readonly walksSaved: number;
  /** per-order publication moment — the window's say */
  readonly publish: Readonly<Record<string, number>>;
  readonly waitsSec: Readonly<Record<string, number>>;
  readonly tardySec: Readonly<Record<string, number>>;
  readonly meanTardySec: number;
  readonly p90TardySec: number;
  readonly maxTardySec: number;
  readonly lateOrders: readonly string[];
}

/* ---------- release pacing (v0.3) ---------- */

export interface ZoneCap {
  readonly zone: number; // 0-based
  readonly aisles: readonly [number, number]; // inclusive aisle span
  readonly linesPerHour: number; // pickers × rate
}

export interface ReleaseDecision {
  readonly batchId: string;
  readonly publishSec: number;
  readonly releaseSec: number;
  readonly dueSec: number; // tightest order due in the batch
  readonly zone: number;
  readonly tourSec: number; // the walk the cart asks for
  readonly craftSec: number; // tour + marshal/hand-off — the plate's cost
  readonly lines: number;
}

/** queue depth in one zone, one bin per reading */
export interface QueueReading {
  readonly t: number; // bin start, seconds
  readonly carts: number; // released crafts still owed work in the zone
}

export interface ZoneSeries {
  readonly zone: number;
  readonly readings: readonly QueueReading[];
  readonly peakCarts: number;
}

export interface ReleasePlan {
  readonly paced: boolean;
  readonly decisions: readonly ReleaseDecision[];
  readonly zones: readonly ZoneSeries[];
  readonly peakQueueCarts: number;
  readonly avgQueueCarts: number;
  readonly lastReleaseSec: number;
  /** batches whose release ran past the tightest due inside them */
  readonly breaches: readonly string[];
}

/* ---------- improvement (v1.1) ---------- */

export interface TabuRun {
  readonly batches: readonly Batch[];
  /** total tour seconds after the pass */
  readonly totalTourSec: number;
  readonly constructionTourSec: number;
  /** seconds the pass clawed back — reported, never promised */
  readonly deltaSec: number;
  readonly deltaPct: number;
  readonly iterations: number;
  readonly appliedMoves: number;
}
