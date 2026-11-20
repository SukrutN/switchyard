/* The four family lanes land beside the work row, and a busy zone
   hesitates instead of taking the window. */

import test from "node:test"
import assert from "node:assert/strict"

import { dayByKey, SLOTTING } from "../../despatch-engine/fixtures/dc.ts"
import { divert } from "../../dcsim/src/divert.ts"
import {
  FLUX_CASES,
  HEARTH_HOLD,
  NORTHSPAN_CIN,
  QUAY_FACE,
} from "../fixtures/family-contract.ts"
import { stageOrders } from "../fixtures/daylane.ts"
import { MemoryYard } from "../src/modelyard.ts"
import { attachSeamReaders } from "../src/seamreader.ts"
import { SEAM, orderGate, quayBytes, tourBytes, verdictBytes, windowBytes } from "../src/seams.ts"
import { DespatchWes } from "../src/wes.ts"

function text(payload: Uint8Array): string {
  return new TextDecoder().decode(payload)
}

test("a release writes quay, northspan, hearth, and fluxline lanes", async () => {
  const day = dayByKey("average-day")
  const yard = new MemoryYard()
  const wes = new DespatchWes(yard, SLOTTING, {
    windowSec: 90,
    zoneCount: 4,
    pickersPerZone: 1,
    horizonSec: day.horizonSec,
    busyZones: [{ zone: 0, fromSec: 0, toSec: 100000 }],
  })
  await wes.boot()
  await stageOrders(yard, day.orders.slice(0, 12))
  await wes.finalize(day.horizonSec)

  const slots = yard.msgRows(SEAM.quay)
  const tours = yard.msgRows(SEAM.northspan)
  const windows = yard.msgRows(SEAM.hearth)
  const verdicts = yard.msgRows(SEAM.fluxline)
  assert.ok(slots.length > 0)
  assert.ok(tours.length > 0)
  assert.equal(windows.length, tours.length)
  assert.ok(verdicts.length > 0)

  const slot = JSON.parse(text(slots[0].payload))
  const face = SLOTTING.get(slot.sku)
  assert.ok(face)
  assert.equal(slot.aisle, face.aisle)
  assert.equal(slot.bay, face.bay)

  const tour = JSON.parse(text(tours[0].payload))
  assert.equal(tour.kind, "tour")
  assert.equal(typeof tour.tourSec, "number")

  const gates = new Set(["L01", "L02", "L03", "RJ"])
  for (const row of verdicts) {
    const verdict = JSON.parse(text(row.payload))
    assert.equal(verdict.gate, orderGate(verdict.order))
    assert.ok(gates.has(verdict.gate))
  }

  let hesitated = 0
  let fired = 0
  for (const row of windows) {
    const call = JSON.parse(text(row.payload))
    if (call.zone === 0) {
      assert.equal(call.decision, "hesitate")
      hesitated += 1
    } else {
      assert.equal(call.decision, "fire")
      fired += 1
    }
  }
  assert.ok(hesitated > 0)
  assert.ok(fired > 0)
})

test("the seam bytes keep the other engines' locked facts", () => {
  const slot = JSON.parse(new TextDecoder().decode(quayBytes("day", {
    sku: QUAY_FACE.sku,
    aisle: QUAY_FACE.aisleIndex,
    bay: QUAY_FACE.bay,
    qty: 1,
  })))
  assert.equal(slot.sku, "LN-03")
  assert.equal(slot.aisle, 0)
  assert.equal(slot.bay, 1)

  const tour = JSON.parse(new TextDecoder().decode(tourBytes(NORTHSPAN_CIN.run, 0, NORTHSPAN_CIN.seconds)))
  assert.equal(tour.tourSec, 43.652)

  const held = JSON.parse(new TextDecoder().decode(windowBytes(
    HEARTH_HOLD.id,
    0,
    4,
    HEARTH_HOLD.decision,
    HEARTH_HOLD.reason,
  )))
  assert.equal(held.decision, "hesitate")
  assert.equal(held.reason, "The Main Run carries conflict density in ticks 4\u20137.")

  for (const sample of FLUX_CASES) {
    assert.equal(divert(sample), sample.gate)
    const verdict = JSON.parse(new TextDecoder().decode(verdictBytes("b", "o", divert(sample))))
    assert.equal(verdict.gate, sample.gate)
  }
})

test("a repeated family row is acked and not applied twice", async () => {
  const day = dayByKey("average-day")
  const yard = new MemoryYard()
  const wes = new DespatchWes(yard, SLOTTING, {
    windowSec: 90,
    zoneCount: 4,
    pickersPerZone: 1,
    horizonSec: day.horizonSec,
  })
  await wes.boot()
  await stageOrders(yard, day.orders.slice(0, 6))
  await wes.finalize(day.horizonSec)

  const inbox = await attachSeamReaders(yard)
  const first = inbox.accepted.length
  assert.equal(inbox.dupes, 0)
  assert.ok(first > 0)

  const again = yard.msgRows(SEAM.fluxline)[0]
  await yard.publishRow(SEAM.fluxline, again.subject, again.payload)
  assert.equal(inbox.accepted.length, first)
  assert.equal(inbox.dupes, 1)
})
