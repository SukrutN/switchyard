/* ============================================================
   cartons — the one library this family ships with.

   Five sizes, inner dims and payloads in kg/cm with 2 decimals,
   matching the fixture rule: decimals fixed here, integers in the
   engine. Fictional SKUs, real ergonomics: the mailer fits a
   tee bundle, the XL rides a pallet slot.
   ============================================================ */

import { toCartonSpec } from "../src/boxcar.ts";
import type { CartonSpec } from "../src/types.ts";

export interface CartonRaw {
  id: string;
  name: string;
  dims: { x: number; y: number; z: number };
  payloadKg: number;
  tareKg: number;
}

export const CARTON_LIBRARY_RAW: CartonRaw[] = [
  {
    id: "MX-2015",
    name: "mailer · 2015",
    dims: { x: 20.0, y: 15.0, z: 10.0 },
    payloadKg: 4.0,
    tareKg: 0.05,
  },
  {
    id: "SC-3020",
    name: "small cube · 3020",
    dims: { x: 30.0, y: 20.0, z: 15.0 },
    payloadKg: 8.0,
    tareKg: 0.08,
  },
  {
    id: "MD-4025",
    name: "mid cube · 4025",
    dims: { x: 40.0, y: 25.0, z: 25.0 },
    payloadKg: 15.0,
    tareKg: 0.12,
  },
  {
    id: "LG-5035",
    name: "bulk cube · 5035",
    dims: { x: 50.0, y: 35.0, z: 30.0 },
    payloadKg: 25.0,
    tareKg: 0.18,
  },
  {
    id: "XL-6050",
    name: "pallet-ette · 6050",
    dims: { x: 60.0, y: 50.0, z: 40.0 },
    payloadKg: 30.0,
    tareKg: 0.25,
  },
];

export const CARTON_LIBRARY: CartonSpec[] = CARTON_LIBRARY_RAW.map(toCartonSpec);
