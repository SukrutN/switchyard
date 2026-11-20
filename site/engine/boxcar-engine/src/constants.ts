/* ============================================================
   constants — the three knurled knobs of the packer.

   They live alone in a file so characterization tests can pin
   them and the site can quote them. Change one and the locked
   figures are expected to move — that is the point of locking.
   ============================================================ */

/**
 * Minimum fraction of a box's own footprint that must actually
 * touch something (floor or a support top) for the placement to
 * be admitted. The stability line in the validation report.
 */
export const STABILITY_RATIO = 0.55;

/**
 * Score penalty per opened carton: util + 0.3·margin − this.
 * Small on purpose: fill quality beats box count, but the last
 * lonely unit must not blow a warehouse up.
 */
export const CARTON_PENALTY = 0.12;

/** The weight-margin term added to a run's score: margin × this. */
export const MARGIN_WEIGHT = 0.3;
