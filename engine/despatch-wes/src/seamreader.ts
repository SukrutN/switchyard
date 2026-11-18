/* A reader for the four family lanes. Switchyard delivers at least
   once, so a repeated batch or order is acked and ignored. */

import type { WesYard } from "./yard.ts"
import { SEAM } from "./seams.ts"

export interface SeamHit {
  readonly lane: string
  readonly seq: number
  readonly row: Record<string, unknown>
}

function keyOf(row: Record<string, unknown>): string {
  const kind = String(row.kind)
  if (kind === "slot") return `slot:${row.batch}:${row.sku}:${row.aisle}:${row.bay}`
  if (kind === "verdict") return `verdict:${row.order}:${row.gate}`
  if (kind === "tour") return `tour:${row.batch}`
  if (kind === "window") return `window:${row.batch}`
  throw new Error(`seam reader: unknown kind ${kind}`)
}

export interface SeamInbox {
  readonly accepted: SeamHit[]
  readonly dupes: number
}

/** Attach one durable reader per family lane. Replays what is already
    journaled, then keeps listening. */
export async function attachSeamReaders(yard: WesYard): Promise<SeamInbox> {
  const seen = new Set<string>()
  const accepted: SeamHit[] = []
  let dupes = 0
  const lanes = [SEAM.quay, SEAM.northspan, SEAM.hearth, SEAM.fluxline]
  for (const lane of lanes) {
    await yard.attachConsumer(lane, "seam-reader", (delivery) => {
      const row = JSON.parse(new TextDecoder().decode(delivery.payload)) as Record<string, unknown>
      const key = keyOf(row)
      if (seen.has(key)) dupes += 1
      else {
        seen.add(key)
        accepted.push({ lane, seq: delivery.seq, row })
      }
      void yard.ackRow(lane, "seam-reader", delivery.seq)
    })
  }
  return {
    get accepted() {
      return accepted
    },
    get dupes() {
      return dupes
    },
  }
}
