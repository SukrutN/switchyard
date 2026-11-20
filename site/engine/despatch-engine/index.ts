/* ============================================================
   despatch-engine — public surface.

   `batchOffline` is the door (v0.1); `batchOnline` is the real
   project (v0.2); `releasePlan` is the pacing half (v0.3);
   `tabuImprove` is the improvement pass (v1.1). The travel proxy
   and every constant it leans on are exported too, so the site
   and the tests quote the same law the engine runs.
   ============================================================ */

export {
  batchFcfs,
  batchOffline,
  batchRunOf,
  buildSlotting,
  linesOf,
  stopsOfOrder,
  sumTour,
} from "./src/batch.ts";
export type { Slotting } from "./src/batch.ts";
export { batchOnline } from "./src/online.ts";
export {
  buildJobList,
  releasePlan,
  zoneCaps,
} from "./src/release.ts";
export type { BatchJob } from "./src/release.ts";
export { tabuImprove } from "./src/tabu.ts";
export {
  atLeastFree,
  mergeStops,
  tourLedger,
  tourSecOf,
  zoneAisleSpan,
  zoneOfAisle,
} from "./src/travel.ts";
export {
  CART_LINES,
  CART_ORDERS,
  CRAFT_OVERHEAD_SEC,
  LINES_PER_PICKER_HOUR,
  PICKERS_PER_ZONE,
  SEC_PER_AISLE,
  SEC_PER_BAY,
  SEC_PER_STOP,
  SLA_BY_CLASS,
  TABU_ITERATIONS,
  TABU_TENURE,
  WINDOW_SWEEP,
  ZONE_GROUP,
} from "./src/constants.ts";
export type {
  Batch,
  BatchRun,
  CatalogEntry,
  DcMap,
  DespatchOrder,
  Freeze,
  OnlineRun,
  OrderClass,
  OrderLine,
  PickPos,
  PickStop,
  QueueReading,
  ReleaseDecision,
  ReleasePlan,
  TabuRun,
  TourLedger,
  ZoneCap,
  ZoneSeries,
} from "./src/types.ts";
