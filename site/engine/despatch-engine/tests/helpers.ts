/* ============================================================
   helpers — micro-fixture builders for the despatch tests.
   ============================================================ */

import { buildSlotting } from "../src/batch.ts";
import type { Slotting } from "../src/batch.ts";
import type {
  DespatchOrder,
  OrderClass,
  OrderLine,
} from "../src/types.ts";

export const CATALOG: readonly { sku: string; aisle: number; bay: number }[] = [
  { sku: "TWN-JUTE", aisle: 1, bay: 2 },
  { sku: "OAT-ROLO", aisle: 1, bay: 7 },
  { sku: "TEA-LEAF", aisle: 2, bay: 3 },
  { sku: "SOAP-BAR", aisle: 2, bay: 6 },
  { sku: "JAM-STRA", aisle: 3, bay: 2 },
  { sku: "CAN-BRO", aisle: 3, bay: 9 },
  { sku: "TISS-BOX", aisle: 4, bay: 4 },
  { sku: "SCR-TOW", aisle: 4, bay: 13 },
  { sku: "JAM-APRI", aisle: 5, bay: 5 },
  { sku: "BAG-NET", aisle: 5, bay: 11 },
  { sku: "WAX-WRAP", aisle: 6, bay: 6 },
  { sku: "SPICE-SET", aisle: 6, bay: 15 },
  { sku: "TUM-SET", aisle: 7, bay: 8 },
  { sku: "DRN-COST", aisle: 7, bay: 16 },
  { sku: "PIL-LINN", aisle: 8, bay: 10 },
  { sku: "BASK-WILW", aisle: 8, bay: 7 },
  { sku: "THROW-WOOL", aisle: 9, bay: 12 },
  { sku: "STOR-BIN", aisle: 9, bay: 5 },
  { sku: "CAND-BIRC", aisle: 10, bay: 9 },
  { sku: "VASE-CLAY", aisle: 10, bay: 17 },
  { sku: "QUILT-PAT", aisle: 11, bay: 14 },
  { sku: "LAMP-DESK", aisle: 11, bay: 8 },
  { sku: "BUBL-NOEL", aisle: 12, bay: 18 },
  { sku: "WREATH-IVY", aisle: 12, bay: 20 },
];

/** the slotting the tests quote: hand-rolled, mirror of the catalog */
export const SLOTTING_TEST: Slotting = buildSlotting(CATALOG);

let seq = 0;

export function mkOrder(
  opts: {
    id?: string;
    arrivalSec?: number;
    lines?: { sku: string; qty: number }[];
    cls?: OrderClass;
    dueSec?: number;
  } = {},
): DespatchOrder {
  seq += 1;
  const lines: OrderLine[] = opts.lines ?? [
    { sku: CATALOG[seq % 5].sku, qty: 2 },
  ];
  const arrival = opts.arrivalSec ?? seq * 90;
  return {
    id: opts.id ?? `T-${String(seq).padStart(4, "0")}`,
    arrivalSec: arrival,
    lines,
    cls: opts.cls ?? "standard",
    dueSec: opts.dueSec ?? arrival + 5400,
  };
}

export function resetSeq(): void {
  seq = 0;
}
