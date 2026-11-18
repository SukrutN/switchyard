/* Harbor & Lane day 07, plus the two laws the fixture must not be
   able to talk its way out of: the cap refuses, and a waiting cold
   trailer takes the door ahead of a waiting parcel. */

import test from "node:test"
import assert from "node:assert/strict"

import { book, capMin, classSlots, HARBOR, loadCurve, run, sequence } from "../index.ts"
import type { Appointment, Arrival, DockDay } from "../index.ts"
import { assignFitness, doorOf } from "../src/doors.ts"

const reading = run(HARBOR)
const curve = loadCurve(HARBOR, [1, 2, 3])

test("class slots are (doors × shift) ÷ handling, floored", () => {
  assert.deepEqual(reading.classSlots, { parcel: 32, dry: 21, cold: 16 })
  assert.equal(classSlots(HARBOR, "parcel"), Math.floor(960 / 30))
  assert.equal(reading.availableMin, 960)
  assert.equal(reading.capMin, 816)
  assert.equal(capMin(HARBOR), Math.floor(960 * 0.85))
})

test("the fixture day stays inside the utilization cap", () => {
  assert.equal(reading.offered, 20)
  assert.equal(reading.offeredMin, 900)
  assert.equal(reading.accepted, 15)
  assert.equal(reading.refused, 5)
  assert.equal(reading.bookedMin, 660)
  assert.ok(reading.bookedMin <= reading.capMin)
  assert.equal(reading.utilization, 0.6875)
})

test("extra copies pile onto the cap and stop, they do not overbook", () => {
  assert.deepEqual(
    curve.map((point) => ({
      copies: point.copies,
      bookedMin: point.bookedMin,
      utilization: point.utilization,
      refused: point.refused,
    })),
    [
      { copies: 1, bookedMin: 660, utilization: 0.6875, refused: 5 },
      { copies: 2, bookedMin: 810, utilization: 0.84375, refused: 21 },
      { copies: 3, bookedMin: 810, utilization: 0.84375, refused: 43 },
    ],
  )
  for (const point of curve) {
    assert.ok(point.bookedMin <= Math.floor(point.availableMin * HARBOR.targetUtilization))
    assert.ok(point.utilization <= HARBOR.targetUtilization)
  }
})

test("a window that could hold the trailer still refuses once the cap is full", () => {
  const day: DockDay = {
    ...HARBOR,
    doorCount: 1,
    shiftMin: 100,
    targetUtilization: 0.5,
    laborWindows: [{ startMin: 0, endMin: 100 }],
    requests: [
      { id: "A", carrier: "A", klass: "dry", requestedMin: 0, cartons: { F: 1, G: 0, H: 0 } },
      { id: "B", carrier: "B", klass: "dry", requestedMin: 0, cartons: { F: 0, G: 0, H: 1 } },
    ],
  }
  const booked = book(day, doorOf(assignFitness(day)))
  assert.equal(capMin(day), 50)
  assert.equal(booked.appointments.length, 1)
  assert.deepEqual(booked.refusals, [{ id: "B", reason: "cap" }])
  assert.ok(booked.bookedMin <= 50)
})

test("every unload sits inside a labor window and doors do not overlap", () => {
  for (const unload of reading.unloads) {
    const window = HARBOR.laborWindows[unload.windowIndex]
    assert.ok(window)
    assert.ok(unload.startMin >= window.startMin)
    assert.ok(unload.endMin <= window.endMin)
  }
  for (let i = 0; i < reading.unloads.length; i++) {
    for (let j = i + 1; j < reading.unloads.length; j++) {
      const a = reading.unloads[i]
      const b = reading.unloads[j]
      if (a.door !== b.door) continue
      assert.ok(a.endMin <= b.startMin || b.endMin <= a.startMin)
    }
  }
})

test("a cold trailer waiting with a parcel takes the door first", () => {
  const day: DockDay = {
    ...HARBOR,
    shiftMin: 120,
    laborWindows: [{ startMin: 0, endMin: 120 }],
  }
  const appointments: Appointment[] = [
    {
      id: "P",
      carrier: "parcel",
      klass: "parcel",
      door: 0,
      requestedMin: 0,
      startMin: 0,
      endMin: 30,
      handlingMin: 30,
      cartons: { F: 1, G: 0, H: 0 },
    },
    {
      id: "C",
      carrier: "cold",
      klass: "cold",
      door: 0,
      requestedMin: 0,
      startMin: 30,
      endMin: 90,
      handlingMin: 60,
      cartons: { F: 0, G: 0, H: 1 },
    },
  ]
  const arrivals: Arrival[] = [
    { id: "P", outcome: "arrived", actualMin: 0, lateMin: 0 },
    { id: "C", outcome: "arrived", actualMin: 0, lateMin: 0 },
  ]
  const unloaded = sequence(day, appointments, arrivals)
  assert.deepEqual(
    unloaded.unloads.map((unload) => unload.id),
    ["C", "P"],
  )
  assert.equal(unloaded.unloads[0].startMin, 0)
  assert.equal(unloaded.unloads[1].startMin, 60)
  assert.equal(unloaded.holds.length, 0)
})

test("the seeded day is one no-show, two holds, and a shorter walk", () => {
  assert.deepEqual(
    reading.arrivals.filter((arrival) => arrival.outcome === "no-show").map((arrival) => arrival.id),
    ["HL-01"],
  )
  assert.equal(reading.arrived, 14)
  assert.equal(reading.noShows, 1)
  assert.deepEqual(
    reading.holds.map((hold) => hold.id),
    ["HL-12", "HL-09"],
  )
  assert.equal(reading.queued, 2)
  assert.equal(reading.pressureMin, 276)
  assert.equal(reading.fitnessDm, 66212)
  assert.equal(reading.randomDm, 72492)
  assert.ok(reading.fitnessDm < reading.randomDm)
})

test("the same day run twice is the same reading", () => {
  assert.deepEqual(run(HARBOR), reading)
})
