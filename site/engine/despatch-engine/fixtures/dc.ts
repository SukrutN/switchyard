/* ============================================================
   dc — Bramble & Twine, Meadowfield distribution center.

   The fictional worked example the whole family shows: a
   dry-goods brand, twelve single-deep aisles, depot on the
   front cross-aisle at the west end. The catalog invents its
   goods; slotting put the fast movers low and shallow, the
   seasonal tail deep — which is exactly the geometry the
   batching's travel proxy pays in.

   Orders are generated deterministically from a seed: the same
   seed is the same day, byte for byte, on the site, in the
   tests, and in the bench. No scraping, no invented "real"
   brand: this is the house rule.

   · average-day      40 orders/hour × 5 hours — the worked day
   · rush-morning     68 orders/hour × 4 hours — Friday, tight dues
   · seasonal-spike   84 orders/hour × 5 hours — the December test
   ============================================================ */

import { SLA_BY_CLASS, CART_LINES } from "../src/constants.ts";
import type {
  CatalogEntry,
  DcMap,
  DespatchOrder,
  OrderClass,
} from "../src/types.ts";

export const BRAMBLE_MAP: DcMap = {
  name: "Bramble & Twine — Meadowfield DC",
  aisles: 12,
  bays: 22,
  depotAisle: 1,
  proxy: "traversal — front sweep + deepest in-and-out + stops",
};

export const CATALOG: CatalogEntry[] = [
  // aisle 1 — fast grocery, shallow
  { sku: "TWN-JUTE", name: "jute twine spool", aisle: 1, bay: 2, tier: 0 },
  { sku: "OAT-ROLO", name: "rolled oats barrel", aisle: 1, bay: 7, tier: 1 },
  // aisle 2
  { sku: "TEA-LEAF", name: "loose-leaf tea tin", aisle: 2, bay: 3, tier: 0 },
  { sku: "SOAP-BAR", name: "soap bars, four-pack", aisle: 2, bay: 6, tier: 1 },
  // aisle 3
  { sku: "JAM-STRA", name: "strawberry jam", aisle: 3, bay: 2, tier: 0 },
  { sku: "CAN-BRO", name: "broth cans, six-pack", aisle: 3, bay: 9, tier: 1 },
  // aisle 4
  { sku: "TISS-BOX", name: "facial tissue box", aisle: 4, bay: 4, tier: 0 },
  { sku: "SCR-TOW", name: "dish towels, two-pack", aisle: 4, bay: 13, tier: 2 },
  // aisle 5
  { sku: "JAM-APRI", name: "apricot preserves", aisle: 5, bay: 5, tier: 0 },
  { sku: "BAG-NET", name: "net produce bag", aisle: 5, bay: 11, tier: 1 },
  // aisle 6
  { sku: "WAX-WRAP", name: "beeswax wraps", aisle: 6, bay: 6, tier: 1 },
  { sku: "SPICE-SET", name: "spice jar set", aisle: 6, bay: 15, tier: 2 },
  // aisle 7
  { sku: "TUM-SET", name: "glass tumblers, set of four", aisle: 7, bay: 8, tier: 1 },
  { sku: "DRN-COST", name: "drink coasters", aisle: 7, bay: 16, tier: 2 },
  // aisle 8
  { sku: "PIL-LINN", name: "linen cushion", aisle: 8, bay: 10, tier: 2 },
  { sku: "BASK-WILW", name: "willow basket", aisle: 8, bay: 7, tier: 1 },
  // aisle 9
  { sku: "THROW-WOOL", name: "wool throw", aisle: 9, bay: 12, tier: 2 },
  { sku: "STOR-BIN", name: "storage bin, small", aisle: 9, bay: 5, tier: 1 },
  // aisle 10
  { sku: "CAND-BIRC", name: "birch candle", aisle: 10, bay: 9, tier: 1 },
  { sku: "VASE-CLAY", name: "clay vase", aisle: 10, bay: 17, tier: 2 },
  // aisle 11
  { sku: "QUILT-PAT", name: "patchwork quilt", aisle: 11, bay: 14, tier: 2 },
  { sku: "LAMP-DESK", name: "desk lamp, paper", aisle: 11, bay: 8, tier: 1 },
  // aisle 12 — the seasonal tail, deep and slow
  { sku: "BUBL-NOEL", name: "noel baubles, box of twelve", aisle: 12, bay: 18, tier: 2 },
  { sku: "WREATH-IVY", name: "ivy wreath", aisle: 12, bay: 20, tier: 2 },
];

/** sku → pick face, sold as the slotter's word (quay's say) */
export const SLOTTING = new Map(
  CATALOG.map((c) => [
    c.sku,
    { aisle: c.aisle, bay: c.bay } as { aisle: number; bay: number },
  ]),
);

/* ---------- the seeded day generator ---------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DayProfile {
  readonly key: string;
  readonly label: string;
  readonly short: string;
  readonly sub: string;
  /** orders per hour the stream runs at */
  readonly ordersPerHour: number;
  /** how long the stream runs (seconds) */
  readonly horizonSec: number;
  /** basket shape: [min lines, extra range] before the tail does its say */
  readonly basketMin: number;
  readonly basketRange: number;
  /** class shares: [critical, expedite] — the rest rides standard */
  readonly classShares: readonly [number, number];
  /** the labor context release pacing reads: pickers per pick zone */
  readonly pickersPerZone: number;
  readonly seed: number;
}

export const DAY_PROFILES: DayProfile[] = [
  {
    key: "average-day",
    label: "Average day — 40 orders/hour × 12 aisles",
    short: "average day",
    sub: "40/hr × 5 h · routine dues · 1 picker/zone",
    ordersPerHour: 40,
    horizonSec: 18000,
    basketMin: 2,
    basketRange: 4,
    classShares: [0.04, 0.16],
    pickersPerZone: 1,
    seed: 20261024,
  },
  {
    key: "rush-morning",
    label: "Rush morning — order flood, tighter dues",
    short: "rush morning",
    sub: "68/hr × 4 h · Friday folk · 1 picker/zone",
    ordersPerHour: 68,
    horizonSec: 14400,
    basketMin: 1,
    basketRange: 3,
    classShares: [0.06, 0.22],
    pickersPerZone: 1,
    seed: 20261025,
  },
  {
    key: "seasonal-spike",
    label: "Seasonal spike — the December test",
    short: "seasonal spike",
    sub: "84/hr × 5 h · bigger baskets · 2 pickers/zone",
    ordersPerHour: 84,
    horizonSec: 18000,
    basketMin: 2,
    basketRange: 4,
    classShares: [0.05, 0.25],
    pickersPerZone: 2,
    seed: 20261026,
  },
];

interface QuantityLaw {
  readonly tier: 0 | 1 | 2;
  readonly min: number;
  readonly max: number; // inclusive
}

const QTY_LAW: Record<0 | 1 | 2, QuantityLaw> = {
  0: { tier: 0, min: 2, max: 4 },
  1: { tier: 1, min: 1, max: 3 },
  2: { tier: 2, min: 1, max: 2 },
};

export interface DayPlan {
  readonly profile: DayProfile;
  readonly orders: DespatchOrder[];
  readonly horizonSec: number;
}

/** one fictional day, byte for byte reproducible from the seed */
export function makeDay(profile: DayProfile): DayPlan {
  const rnd = mulberry32(profile.seed);
  const orders: DespatchOrder[] = [];

  const byTier = (tier: 0 | 1 | 2) => CATALOG.filter((c) => c.tier === tier);
  const byAisle = new Map<number, CatalogEntry[]>();
  for (const c of CATALOG) {
    const list = byAisle.get(c.aisle) ?? [];
    list.push(c);
    byAisle.set(c.aisle, list);
  }

  let t = 0;
  let seq = 0;
  while (t < profile.horizonSec) {
    t += (3600 / profile.ordersPerHour) * (0.45 + 1.1 * rnd());
    if (t >= profile.horizonSec && seq > 0) break;
    seq += 1;

    const cluster = 1 + Math.floor(rnd() * 12); // 1..12
    const lineCount =
      profile.basketMin + Math.floor(rnd() * profile.basketRange);
    const lines: { sku: string; qty: number }[] = [];
    for (let i = 0; i < lineCount; i++) {
      const walk = Math.floor(rnd() * 5) - 2; // −2..+2 aisles of drift
      const aisle = Math.min(12, Math.max(1, cluster + walk));
      const faces = byAisle.get(aisle)!;
      const face = faces[Math.floor(rnd() * faces.length)];
      const law = QTY_LAW[face.tier];
      const qty =
        law.min + Math.floor(rnd() * (law.max - law.min + 1));
      const prev = lines.find((l) => l.sku === face.sku);
      if (prev) prev.qty += qty;
      else lines.push({ sku: face.sku, qty });
    }

    const r = rnd();
    const cls: OrderClass =
      r < profile.classShares[0]
        ? "critical"
        : r < profile.classShares[0] + profile.classShares[1]
          ? "expedite"
          : "standard";
    const arrivalSec = Math.round(t);

    // one order = one pick craft: the generator clamps the biggest
    // basket the brand drew to the cart the board dispatches. The
    // engine still guards (batchOffline throws) — the demand law is
    // the fixture's job, the hard cap is the engine's.
    const units = lines.reduce((s, l) => s + l.qty, 0);
    if (units > CART_LINES) {
      let over = units - CART_LINES;
      for (let i = lines.length - 1; i >= 0 && over > 0; i--) {
        const cut = Math.min(over, lines[i].qty - 1);
        lines[i].qty -= cut;
        over -= cut;
      }
    }

    orders.push({
      id: `BT-${String(seq).padStart(4, "0")}`,
      arrivalSec,
      lines,
      cls,
      dueSec: arrivalSec + SLA_BY_CLASS[cls],
    });
  }

  return { profile, orders, horizonSec: profile.horizonSec };
}

/** the three worked days, made once, shared by site + tests + bench */
export const DAYS: DayPlan[] = DAY_PROFILES.map(makeDay);

export function dayByKey(key: string): DayPlan {
  const found = DAYS.find((d) => d.profile.key === key);
  if (!found) throw new Error(`no such day: ${key}`);
  return found;
}
