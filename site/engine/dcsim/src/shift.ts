/* The raster. Despatch batches and releases. Boxcar counts the
   cartons. Gangway's door count and parcel handling are the dock
   resource. Fluxline's divert is applied when the tour ends.
   This file owns none of that math. It owns the clock. */

import { pack, toOrderInput } from "../../boxcar-engine/index.ts"
import type { OrderInputRaw } from "../../boxcar-engine/index.ts"
import { CARTON_LIBRARY } from "../../boxcar-engine/fixtures/cartons.ts"
import { batchFcfs, batchOffline, buildJobList, releasePlan, zoneCaps } from "../../despatch-engine/index.ts"
import type { Batch, DespatchOrder } from "../../despatch-engine/index.ts"
import { makeDay, SLOTTING } from "../../despatch-engine/fixtures/dc.ts"
import type { DayProfile } from "../../despatch-engine/fixtures/dc.ts"
import { HARBOR } from "../../gangway-engine/index.ts"
import { divert, pieceFor } from "./divert.ts"
import type { Gate } from "./divert.ts"
import { idleWhileHeld, serve } from "./resource.ts"

export type Policy = "fcfs" | "despatch" | "despatch-amr"

export const SHIFT: DayProfile = {
  key: "dcsim-hour",
  label: "One seeded hour at Bramble & Twine",
  short: "worked hour",
  sub: "20/hr × 1 h · the closed world",
  ordersPerHour: 36,
  horizonSec: 3600,
  basketMin: 1,
  basketRange: 2,
  classShares: [0.05, 0.15],
  pickersPerZone: 1,
  seed: 20261118,
}

export const WARMUP_SEC = 600
export const FREEZE_SEC = 300
export const ZONES = 4
export const AMR_CAPACITY = 1
export const BENCHES = 2
export const PACK_SEC = 12
const DOORS = HARBOR.doorCount
const DOOR_SEC = HARBOR.handlingMin.parcel * 60

export type Release = {
  id: string
  orderIds: string[]
  releaseSec: number
  tourSec: number
  zone: number
  dueSec: number
}

export type OrderTrace = {
  id: string
  arrivalSec: number
  releaseSec: number
  pickStart: number
  pickEnd: number
  departSec: number
  zone: number
  gate: Gate
  cartons: number
}

export type Report = {
  policy: Policy
  seed: number
  orders: number
  trailers: number
  departedInWindow: number
  wipAtHorizon: number
  totalTourSec: number
  meanReleaseLagSec: number
  meanCycleSec: number
  starvationSec: number
  amrWaitSec: number
  doorUtil: number
  pickerUtil: number
  divert: Record<Gate, number>
  cartons: number
  registry: string[]
}

type Staged = {
  orders: DespatchOrder[]
  releases: Release[]
  traces: OrderTrace[]
  amrWaitSec: number
  doorBusy: number
}

export function releasesFor(orders: readonly DespatchOrder[], policy: Policy, horizon: number): Release[] {
  if (policy === "fcfs") {
    return batchFcfs(orders, SLOTTING).map((batch) => {
      const members = orders.filter((order) => batch.orders.includes(order.id))
      const arrival = Math.max(...members.map((order) => order.arrivalSec))
      const due = Math.min(...members.map((order) => order.dueSec))
      return {
        id: batch.id,
        orderIds: [...batch.orders],
        releaseSec: arrival,
        tourSec: batch.ledger.tourSec,
        zone: batch.zone,
        dueSec: due,
      }
    })
  }

  const jobs = []
  const byId = new Map<string, Batch>()
  let window = 0
  for (let start = 0; start < horizon; start += FREEZE_SEC) {
    const end = start + FREEZE_SEC
    const slice = orders.filter((order) => order.arrivalSec >= start && order.arrivalSec < end)
    if (slice.length === 0) continue
    window += 1
    const run = batchOffline(slice, SLOTTING)
    const publish: Record<string, number> = {}
    const renamed = run.batches.map((batch) => ({ ...batch, id: `W${window}-${batch.id}` }))
    for (const batch of renamed) {
      publish[batch.id] = end
      byId.set(batch.id, batch)
    }
    jobs.push(...buildJobList(renamed, slice, publish))
  }

  const plan = releasePlan(jobs, zoneCaps(ZONES, 1), {
    paced: true,
    startSec: 0,
    horizonSec: horizon,
    binSec: 60,
  })

  return plan.decisions.map((decision) => {
    const batch = byId.get(decision.batchId)
    if (!batch) throw new Error(`missing batch ${decision.batchId}`)
    return {
      id: decision.batchId,
      orderIds: [...batch.orders],
      releaseSec: decision.releaseSec,
      tourSec: decision.tourSec,
      zone: decision.zone,
      dueSec: decision.dueSec,
    }
  })
}

function cartonsOf(order: DespatchOrder): number {
  const raw: OrderInputRaw = {
    id: order.id,
    name: order.id,
    lines: [
      {
        line: 1,
        sku: order.lines[0]?.sku ?? "TWN-JUTE",
        family: "standard",
        qty: Math.max(1, order.lines.length),
        dims: { x: 10, y: 10, z: 10 },
        rotate: "any",
        weightKg: 0.4,
        maxLoadKg: 2,
      },
    ],
  }
  return pack(toOrderInput(raw), CARTON_LIBRARY).cartons.length
}

function stage(orders: DespatchOrder[], policy: Policy, horizon: number, seed: number): Staged {
  const releases = releasesFor(orders, policy, horizon).sort(
    (a, b) => a.releaseSec - b.releaseSec || (a.id < b.id ? -1 : 1),
  )
  const byOrder = new Map(orders.map((order) => [order.id, order]))
  const gated = policy === "despatch-amr"
  const amrFree = Array.from({ length: AMR_CAPACITY }, () => 0)
  const zoneFree = Array.from({ length: ZONES }, () => 0)
  let amrWaitSec = 0

  const pick = releases.map((release) => {
    let ready = release.releaseSec
    if (gated) {
      let index = 0
      for (let i = 1; i < amrFree.length; i++) if (amrFree[i] < amrFree[index]) index = i
      amrWaitSec += Math.max(0, amrFree[index] - release.releaseSec)
      ready = Math.max(ready, amrFree[index])
    }
    const start = Math.max(ready, zoneFree[release.zone] ?? 0)
    const end = start + release.tourSec
    if (gated) {
      let index = 0
      for (let i = 1; i < amrFree.length; i++) if (amrFree[i] < amrFree[index]) index = i
      amrFree[index] = end
    }
    zoneFree[release.zone] = end
    return { release, start, end }
  })

  const packClaims = pick.flatMap((row) =>
    row.release.orderIds.map((id) => {
      const order = byOrder.get(id)!
      const cartons = cartonsOf(order)
      return {
        id,
        ready: row.end,
        service: cartons * PACK_SEC,
        due: order.dueSec,
        release: row.release,
        pickStart: row.start,
        pickEnd: row.end,
        cartons,
      }
    }),
  )
  const seats = new Map(serve(BENCHES, packClaims, "fifo").map((seat) => [seat.id, seat]))

  const traces: OrderTrace[] = packClaims.map((claim, index) => {
    const order = byOrder.get(claim.id)!
    const seat = seats.get(claim.id)
    if (!seat) throw new Error(`no bench for ${claim.id}`)
    return {
      id: claim.id,
      arrivalSec: order.arrivalSec,
      releaseSec: claim.release.releaseSec,
      pickStart: claim.pickStart,
      pickEnd: claim.pickEnd,
      departSec: seat.end,
      zone: claim.release.zone,
      gate: divert(pieceFor(seed, index)),
      cartons: claim.cartons,
    }
  })

  const doorClaims = Array.from({ length: 4 }, (_, i) => ({
    id: `DR-${i + 1}`,
    ready: i * 900,
    service: DOOR_SEC,
    due: i,
  }))
  const doors = serve(DOORS, doorClaims, "fifo")
  const doorBusy = doors.reduce((sum, seat) => sum + Math.min(horizon, seat.end) - Math.min(horizon, seat.start), 0)

  return { orders, releases, traces, amrWaitSec, doorBusy }
}

export function runShift(policy: Policy, seed = SHIFT.seed): Report {
  const day = makeDay({ ...SHIFT, seed })
  const staged = stage(day.orders, policy, day.horizonSec, seed)
  const horizon = day.horizonSec
  const traces = staged.traces

  let tour = 0
  for (const release of staged.releases) tour += release.tourSec
  let lag = 0
  let cycle = 0
  const divertCounts: Record<Gate, number> = { L01: 0, L02: 0, L03: 0, RJ: 0 }
  let cartons = 0
  let departed = 0
  let wip = 0
  for (const trace of traces) {
    lag += trace.releaseSec - trace.arrivalSec
    cycle += trace.departSec - trace.arrivalSec
    divertCounts[trace.gate] += 1
    cartons += trace.cartons
    if (trace.departSec > WARMUP_SEC && trace.departSec <= horizon) departed += 1
    if (trace.arrivalSec <= horizon && trace.departSec > horizon) wip += 1
  }

  let starvation = 0
  let pickerBusy = 0
  const seen = new Set<string>()
  for (let zone = 0; zone < ZONES; zone++) {
    const busy: { start: number; end: number }[] = []
    for (const trace of traces) {
      if (trace.zone !== zone) continue
      const key = `${zone}:${trace.pickStart}:${trace.pickEnd}`
      if (seen.has(key)) continue
      seen.add(key)
      busy.push({ start: trace.pickStart, end: trace.pickEnd })
    }
    const holds = traces
      .filter((trace) => trace.zone === zone)
      .map((trace) => ({ start: trace.arrivalSec, end: trace.releaseSec }))
    starvation += idleWhileHeld(busy, holds, horizon)
    for (const span of busy) {
      pickerBusy += Math.max(0, Math.min(horizon, span.end) - Math.max(0, span.start))
    }
  }

  const registry = traces
    .map((trace) =>
      [
        trace.id,
        trace.releaseSec.toFixed(3),
        trace.pickStart.toFixed(3),
        trace.departSec.toFixed(3),
        trace.gate,
        trace.cartons,
      ].join(":"),
    )
    .sort()

  return {
    policy,
    seed,
    orders: traces.length,
    trailers: 4,
    departedInWindow: departed,
    wipAtHorizon: wip,
    totalTourSec: Math.round(tour * 1000) / 1000,
    meanReleaseLagSec: Math.round((lag / traces.length) * 1000) / 1000,
    meanCycleSec: Math.round((cycle / traces.length) * 1000) / 1000,
    starvationSec: Math.round(starvation * 1000) / 1000,
    amrWaitSec: Math.round(staged.amrWaitSec * 1000) / 1000,
    doorUtil: Math.round((staged.doorBusy / (DOORS * horizon)) * 1000) / 1000,
    pickerUtil: Math.round((pickerBusy / (ZONES * horizon)) * 1000) / 1000,
    divert: divertCounts,
    cartons,
    registry,
  }
}

export function compare(seed = SHIFT.seed): Record<Policy, Report> {
  return {
    fcfs: runShift("fcfs", seed),
    despatch: runShift("despatch", seed),
    "despatch-amr": runShift("despatch-amr", seed),
  }
}

export function account(policy: Policy, seed: number, at: number): { arrived: number; departed: number; wip: number } {
  const day = makeDay({ ...SHIFT, seed })
  const traces = stage(day.orders, policy, day.horizonSec, seed).traces
  let arrived = 0
  let departed = 0
  let wip = 0
  for (const trace of traces) {
    if (trace.arrivalSec > at) continue
    arrived += 1
    if (trace.departSec <= at) departed += 1
    else wip += 1
  }
  return { arrived, departed, wip }
}
