/* The closed hour. Conservation is an identity over stages, the trio
   is the point of the picture, and a second run of the same seed
   must not move a millisecond. */

import test from "node:test"
import assert from "node:assert/strict"

import { account, compare, divert, runShift, serve, SHIFT } from "../index.ts"

const trio = compare()

test("every arrival is a departure or still in the building", () => {
  for (const policy of ["fcfs", "despatch", "despatch-amr"] as const) {
    for (const at of [900, 1800, 3600]) {
      const books = account(policy, SHIFT.seed, at)
      assert.equal(books.arrived, books.departed + books.wip, `${policy} @ ${at}`)
    }
  }
})

test("the same seed writes the same registry", () => {
  const again = runShift("despatch", SHIFT.seed)
  assert.deepEqual(again.registry, trio.despatch.registry)
  assert.equal(again.totalTourSec, trio.despatch.totalTourSec)
})

test("batching shortens the walk and holds the release", () => {
  assert.equal(trio.fcfs.totalTourSec, 3640)
  assert.equal(trio.despatch.totalTourSec, 2537)
  assert.ok(trio.despatch.totalTourSec < trio.fcfs.totalTourSec)
  assert.equal(trio.fcfs.meanReleaseLagSec, 0)
  assert.equal(trio.despatch.meanReleaseLagSec, 341.714)
  assert.equal(trio.fcfs.starvationSec, 0)
  assert.equal(trio.despatch.starvationSec, 4015)
  assert.equal(trio.fcfs.meanCycleSec, 125.429)
  assert.equal(trio.despatch.meanCycleSec, 561.851)
  assert.equal(trio.fcfs.departedInWindow, 29)
  assert.equal(trio.despatch.departedInWindow, 31)
})

test("an AMR window keeps the batches and spends the wait", () => {
  assert.equal(trio["despatch-amr"].totalTourSec, trio.despatch.totalTourSec)
  assert.equal(trio["despatch-amr"].meanReleaseLagSec, trio.despatch.meanReleaseLagSec)
  assert.equal(trio["despatch-amr"].amrWaitSec, 1839.2)
  assert.ok(trio["despatch-amr"].meanCycleSec > trio.despatch.meanCycleSec)
  assert.equal(trio["despatch-amr"].meanCycleSec, 664.446)
  assert.equal(trio["despatch-amr"].starvationSec, 3735.4)
})

test("five seeds stay inside the recorded throughput bin", () => {
  const departed = [0, 1, 2, 3, 4].map(
    (i) => runShift("despatch", SHIFT.seed + i * 997).departedInWindow,
  )
  assert.deepEqual(departed, [31, 34, 33, 32, 34])
  const spread = Math.max(...departed) - Math.min(...departed)
  assert.equal(spread, 3)
})

test("the divert law is the floor's, and the hour uses it", () => {
  assert.equal(divert({ heightMm: 170, metal: true, weightKg: 1 }), "L03")
  assert.equal(divert({ heightMm: 140, metal: true, weightKg: 5 }), "L02")
  assert.equal(divert({ heightMm: 140, metal: false, weightKg: 1 }), "RJ")
  assert.equal(divert({ heightMm: 140, metal: false, weightKg: 13 }), "RJ")
  assert.equal(divert({ heightMm: 150, metal: false, weightKg: 6 }), "L01")
  const counts = trio.despatch.divert
  assert.equal(counts.L01 + counts.L02 + counts.L03 + counts.RJ, trio.despatch.orders)
  assert.deepEqual(counts, { L01: 11, L02: 5, L03: 15, RJ: 4 })
})

test("EDD takes the tighter due ahead of an earlier arrival", () => {
  const seats = serve(
    1,
    [
      { id: "early", ready: 0, service: 10, due: 100 },
      { id: "tight", ready: 1, service: 10, due: 5 },
    ],
    "edd",
  )
  assert.deepEqual(
    seats.map((seat) => seat.id),
    ["tight", "early"],
  )
})
