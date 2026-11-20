/* ============================================================
   despatch-engine constants — the whole law the site quotes.

   Every number here has one job: make the batching, the freeze
   windows, the pacing, and the tabu pass agree on the same DC.
   Change one and the fixtures re-lock against the new truth.
   ============================================================ */

/** pick lines a cart tour may carry (the batching capacity), */
export const CART_LINES = 20;

/** orders a cart tour may carry, on top of CART_LINES (multi-order carts) */
export const CART_ORDERS = 6;

/* the travel proxy, already in seconds (no float chains):
   the front cross-aisle sweep between aisle mouths, the in-and-out
   of an aisle's deepest pick, and the stop at every pick face. */
export const SEC_PER_AISLE = 4.5; // horizontal step to cross one aisle pitch
export const SEC_PER_BAY = 1.6;   // in-and-out cost, per bay of aisle depth
export const SEC_PER_STOP = 8;    // scan + lift at a pick face

/** the pick module's zones: ZONE_GROUP consecutive aisles per zone */
export const ZONE_GROUP = 3;

/** release pacing's law: the crew the zone actually gives — one
    picker on an average day, one on rush, the flex pair in
    December — and what a cart really costs its craft beyond the
    tour: marshal, stage, hand-off, counted the moment the cart
    is released. */
export const PICKERS_PER_ZONE = 1;
export const LINES_PER_PICKER_HOUR = 42;
export const CRAFT_OVERHEAD_SEC = 240;

/** the on-line sweep: one parameter, tardiness on one side,
    walks saved on the other. THE trade-off of the whole family. */
export const WINDOW_SWEEP = [45, 90, 150, 240, 360, 720] as const;

/** due-date slack by order class, seconds after arrival:
    the promise Bramble bought — ten minutes for the shop floor,
    thirty for next-day delivery, the afternoon for the van. */
export const SLA_BY_CLASS = {
  critical: 600,
  expedite: 1800,
  standard: 5400,
} as const;

/** the tabu pass (v1.1): relocate + swap, tabu tenure, no shuffling */
export const TABU_ITERATIONS = 20;
export const TABU_TENURE = 6;
