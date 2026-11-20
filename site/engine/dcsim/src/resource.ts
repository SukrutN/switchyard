/* One server pool. FIFO sorts by ready time. EDD sorts by due date.
   Neither invents a tour or a carton; it only decides who waits. */

export type Discipline = "fifo" | "edd"

export type Claim = {
  id: string
  ready: number
  service: number
  due: number
}

export type Seat = { id: string; start: number; end: number }

export function serve(capacity: number, claims: readonly Claim[], discipline: Discipline): Seat[] {
  const order = [...claims].sort((a, b) => {
    if (discipline === "edd" && a.due !== b.due) return a.due - b.due
    if (a.ready !== b.ready) return a.ready - b.ready
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const free = Array.from({ length: capacity }, () => 0)
  const seats: Seat[] = []
  for (const claim of order) {
    let index = 0
    for (let i = 1; i < free.length; i++) if (free[i] < free[index]) index = i
    const start = Math.max(claim.ready, free[index])
    const end = start + claim.service
    free[index] = end
    seats.push({ id: claim.id, start, end })
  }
  return seats
}

/** Seconds in [0, horizon) when `holds` covers the clock and `busy` does not. */
export function idleWhileHeld(
  busy: readonly { start: number; end: number }[],
  holds: readonly { start: number; end: number }[],
  horizon: number,
): number {
  const points = new Set<number>([0, horizon])
  for (const span of [...busy, ...holds]) {
    if (span.start > 0 && span.start < horizon) points.add(span.start)
    if (span.end > 0 && span.end < horizon) points.add(span.end)
  }
  const ticks = [...points].sort((a, b) => a - b)
  let seconds = 0
  for (let i = 0; i < ticks.length - 1; i++) {
    const t = ticks[i]
    const held = holds.some((span) => span.start <= t && t < span.end)
    const working = busy.some((span) => span.start <= t && t < span.end)
    if (held && !working) seconds += ticks[i + 1] - t
  }
  return seconds
}
