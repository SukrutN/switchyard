/* Harbor & Lane, day 07 — the same dock geometry as quay's putaway day.
   Fictional carriers. Two doors, an eight-hour shift, a meal gap, a cap
   at 85% of door-minutes. The last bookings are the ones the cap refuses. */

import type { DockDay } from "../src/types.ts"

export const HARBOR: DockDay = {
  id: "harbor-lane-day-07",
  name: "Harbor & Lane inbound, day 07",
  seed: 20261118,
  doorCount: 2,
  doorPitchDm: 40,
  shiftMin: 480,
  targetUtilization: 0.85,
  handlingMin: { parcel: 30, dry: 45, cold: 60 },
  noShowRate: 0.12,
  lateSpreadMin: 25,
  laborWindows: [
    { startMin: 0, endMin: 240 },
    { startMin: 300, endMin: 480 },
  ],
  dockToAisleDm: 124,
  aislePitchDm: 36,
  requests: [
    { id: "HL-01", carrier: "Kettle Freight", klass: "cold", requestedMin: 0, cartons: { F: 22, G: 4, H: 1 } },
    { id: "HL-02", carrier: "Marrow Line", klass: "dry", requestedMin: 0, cartons: { F: 2, G: 6, H: 20 } },
    { id: "HL-03", carrier: "Silt & Haul", klass: "parcel", requestedMin: 20, cartons: { F: 8, G: 8, H: 8 } },
    { id: "HL-04", carrier: "Northglass", klass: "cold", requestedMin: 30, cartons: { F: 1, G: 3, H: 24 } },
    { id: "HL-05", carrier: "Plover Cartage", klass: "dry", requestedMin: 45, cartons: { F: 14, G: 6, H: 2 } },
    { id: "HL-06", carrier: "Umber Dray", klass: "parcel", requestedMin: 70, cartons: { F: 1, G: 4, H: 16 } },
    { id: "HL-07", carrier: "Lowtide", klass: "dry", requestedMin: 90, cartons: { F: 18, G: 2, H: 2 } },
    { id: "HL-08", carrier: "Bracken Haul", klass: "cold", requestedMin: 110, cartons: { F: 6, G: 16, H: 4 } },
    { id: "HL-09", carrier: "Yarrow", klass: "parcel", requestedMin: 140, cartons: { F: 3, G: 14, H: 3 } },
    { id: "HL-10", carrier: "Cinder Wharf", klass: "dry", requestedMin: 160, cartons: { F: 2, G: 2, H: 18 } },
    { id: "HL-11", carrier: "Loom Transit", klass: "parcel", requestedMin: 190, cartons: { F: 12, G: 4, H: 2 } },
    { id: "HL-12", carrier: "Hearth Cartage", klass: "dry", requestedMin: 220, cartons: { F: 4, G: 12, H: 6 } },
    { id: "HL-13", carrier: "Vellum", klass: "cold", requestedMin: 250, cartons: { F: 2, G: 2, H: 20 } },
    { id: "HL-14", carrier: "Oakwharf", klass: "parcel", requestedMin: 280, cartons: { F: 10, G: 6, H: 4 } },
    { id: "HL-15", carrier: "Sedge Miller", klass: "dry", requestedMin: 310, cartons: { F: 16, G: 3, H: 1 } },
    { id: "HL-16", carrier: "Quill Freight", klass: "cold", requestedMin: 340, cartons: { F: 5, G: 5, H: 14 } },
    { id: "HL-17", carrier: "Bramble Dray", klass: "dry", requestedMin: 370, cartons: { F: 7, G: 9, H: 7 } },
    { id: "HL-18", carrier: "Wick & Haul", klass: "parcel", requestedMin: 400, cartons: { F: 2, G: 11, H: 9 } },
    { id: "HL-19", carrier: "Nettle Line", klass: "dry", requestedMin: 420, cartons: { F: 1, G: 1, H: 15 } },
    { id: "HL-20", carrier: "Ash Cartage", klass: "cold", requestedMin: 440, cartons: { F: 9, G: 8, H: 8 } },
  ],
}
