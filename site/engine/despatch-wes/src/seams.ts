import { divert } from "../../dcsim/src/divert.ts"
import type { Gate } from "../../dcsim/src/divert.ts"

export type { Gate }

/* Four family seams. The work row stays the work row. Each family
   gets its own lane and its own bytes, so a later engine can replace
   the function without a new orchestrator.

   quay: the pick face already on the stop (aisle, bay).
   northspan: the tour seconds the batch already walked.
   hearthline: fire, or hesitate when this zone is in a busy band.
   fluxline: the published divert, one piece per order id. */

export const SEAM = {
  quay: "quay-slots",
  northspan: "northspan-tours",
  hearth: "hearth-windows",
  fluxline: "fluxline-verdicts",
} as const

export interface BusyBand {
  readonly zone: number
  readonly fromSec: number
  readonly toSec: number
}

export interface SeamStop {
  readonly sku: string
  readonly aisle: number
  readonly bay: number
  readonly qty: number
}

export interface SeamRelease {
  readonly batch: string
  readonly zone: number
  readonly releaseSec: number
  readonly tourSec: number
  readonly orders: readonly string[]
  readonly stops: readonly SeamStop[]
}

export type WindowCall = "fire" | "hesitate"

function enc(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

function num(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`seam: bad number ${n}`)
  if (Number.isInteger(n)) return String(n)
  return String(Math.round(n * 1000) / 1000)
}

function obj(fields: readonly (readonly [string, string])[]): Uint8Array {
  const body = fields.map(([k, v]) => enc(k) + ":" + v).join(",")
  return new TextEncoder().encode("{" + body + "}")
}

export function quayBytes(batch: string, stop: SeamStop): Uint8Array {
  return obj([
    ["kind", enc("slot")],
    ["batch", enc(batch)],
    ["sku", enc(stop.sku)],
    ["aisle", num(stop.aisle)],
    ["bay", num(stop.bay)],
    ["qty", num(stop.qty)],
  ])
}

export function tourBytes(batch: string, zone: number, tourSec: number): Uint8Array {
  return obj([
    ["kind", enc("tour")],
    ["batch", enc(batch)],
    ["zone", num(zone)],
    ["tourSec", num(tourSec)],
  ])
}

export function windowBytes(
  batch: string,
  zone: number,
  releaseSec: number,
  decision: WindowCall,
  reason: string,
): Uint8Array {
  return obj([
    ["kind", enc("window")],
    ["batch", enc(batch)],
    ["zone", num(zone)],
    ["releaseSec", num(releaseSec)],
    ["decision", enc(decision)],
    ["reason", enc(reason)],
  ])
}

export function verdictBytes(batch: string, order: string, gate: Gate): Uint8Array {
  return obj([
    ["kind", enc("verdict")],
    ["batch", enc(batch)],
    ["order", enc(order)],
    ["gate", enc(gate)],
  ])
}

export function windowCall(
  zone: number,
  releaseSec: number,
  busy: readonly BusyBand[],
): { decision: WindowCall; reason: string } {
  const hit = busy.find((band) => band.zone === zone && releaseSec >= band.fromSec && releaseSec < band.toSec)
  if (!hit) return { decision: "fire", reason: "the zone is clear" }
  return {
    decision: "hesitate",
    reason: `zone ${zone} is busy from ${hit.fromSec}s to ${hit.toSec}s`,
  }
}

/** Stable piece from the order id, then the one divert law dcsim uses. */
export function orderGate(orderId: string): Gate {
  let h = 2166136261
  for (let i = 0; i < orderId.length; i++) h = Math.imul(h ^ orderId.charCodeAt(i), 16777619)
  const u = h >>> 0
  const heightMm = 140 + (u % 50)
  const metal = u % 5 === 0
  const weightKg = (10 + ((u >>> 8) % 130)) / 10
  return divert({ heightMm, metal, weightKg })
}

export function seamSubject(lane: string, token: string): string {
  return `${lane}.${token}`
}
