/* ============================================================
   orders — three working profiles, the characterization trio.

   · featherweight  soft, bulky, light: the packer's easy day
   · dense-cubes    heavy small boxes: util should tile, weight bites
   · mixed-awkward  upright rods, fragile bottles, one hazard:
                    merge + stability earn their keep here

   All dims cm / weights kg, 2 decimals, fictional SKUs. The
   fragile/hazard families exist so the merge rule is honest,
   not decorative.
   ============================================================ */

import { toOrderInput } from "../src/boxcar.ts";
import type { OrderInputRaw, OrderInput } from "../src/types.ts";

export { toOrderInput } from "../src/boxcar.ts";

export const FEATHERWEIGHT_RAW: OrderInputRaw = {
  id: "order-feather",
  name: "featherweight outlet restock",
  lines: [
    {
      line: 1,
      sku: "TEE-BNDL",
      family: "standard",
      qty: 6,
      dims: { x: 30.0, y: 24.0, z: 4.0 },
      rotate: "any",
      weightKg: 0.35,
      maxLoadKg: 2.0,
    },
    {
      line: 2,
      sku: "HOD-PULL",
      family: "standard",
      qty: 3,
      dims: { x: 35.0, y: 28.0, z: 12.0 },
      rotate: "any",
      weightKg: 0.9,
      maxLoadKg: 3.0,
    },
    {
      line: 3,
      sku: "SOCK-BOX",
      family: "standard",
      qty: 4,
      dims: { x: 20.0, y: 10.0, z: 8.0 },
      rotate: "any",
      weightKg: 0.25,
      maxLoadKg: 3.0,
    },
  ],
};

export const DENSE_CUBES_RAW: OrderInputRaw = {
  id: "order-dense",
  name: "pantry dense-cubes run",
  lines: [
    {
      line: 1,
      sku: "JAR-400",
      family: "fragile",
      qty: 12,
      dims: { x: 10.0, y: 10.0, z: 12.0 },
      rotate: "upright",
      weightKg: 0.8,
      maxLoadKg: 4.0,
    },
    {
      line: 2,
      sku: "TIN-200",
      family: "standard",
      qty: 16,
      dims: { x: 10.0, y: 8.0, z: 5.0 },
      rotate: "any",
      weightKg: 0.5,
      maxLoadKg: 6.0,
    },
    {
      line: 3,
      sku: "CART-500",
      family: "standard",
      qty: 8,
      dims: { x: 12.0, y: 10.0, z: 6.0 },
      rotate: "any",
      weightKg: 0.6,
      maxLoadKg: 5.0,
    },
  ],
};

export const MIXED_AWKWARD_RAW: OrderInputRaw = {
  id: "order-awkward",
  name: "mixed awkward wave",
  lines: [
    {
      line: 1,
      sku: "BTL-SAUCE",
      family: "fragile",
      qty: 4,
      dims: { x: 8.0, y: 8.0, z: 20.0 },
      rotate: "upright",
      weightKg: 0.75,
      maxLoadKg: 1.0,
    },
    {
      line: 2,
      sku: "ROD-ANT",
      family: "standard",
      qty: 3,
      dims: { x: 2.0, y: 2.0, z: 28.0 },
      rotate: "no",
      weightKg: 0.3,
      maxLoadKg: 2.0,
    },
    {
      line: 3,
      sku: "PILLOW-PL",
      family: "standard",
      qty: 2,
      dims: { x: 40.0, y: 30.0, z: 15.0 },
      rotate: "any",
      weightKg: 0.45,
      maxLoadKg: 6.0,
    },
    {
      line: 4,
      sku: "AER-CLOTH",
      family: "hazard",
      qty: 1,
      dims: { x: 8.0, y: 8.0, z: 22.0 },
      rotate: "upright",
      weightKg: 0.4,
      maxLoadKg: 3.0,
    },
  ],
};

export interface ProfileSet {
  key: string;
  label: string;
  raw: OrderInputRaw;
  order: OrderInput;
}

function asProfile(raw: OrderInputRaw): ProfileSet {
  return { key: raw.id, label: raw.name, raw, order: toOrderInput(raw) };
}

export const PROFILES: ProfileSet[] = [
  asProfile(FEATHERWEIGHT_RAW),
  asProfile(DENSE_CUBES_RAW),
  asProfile(MIXED_AWKWARD_RAW),
];
