/* ============================================================
   online — on-line order batching (v0.2), the real project.

   The interval protocol, Henn's window background:

   · the window re-arms whenever the previous freeze closes;
   · at a freeze, everything already *landed* (arrival < freeze)
     is batched off-line and the batch group is published;
   · orders landing inside a window wait for the next one — the
     window's price, measured as publication delay and tardiness
     (published after due) against the class SLAs;
   · if the pool ran dry at a freeze, no batch, and the window
     re-arms from the next arrival.

   One parameter — the window w — and the sweep over it is the
   family's signature figure: walks saved climbs, fresh lateness
   creeps. Both are honest, both are here.
   ============================================================ */

import { batchOffline, batchFcfs, batchRunOf, linesOf, makeBatch } from "./batch.ts";
import type { Slotting } from "./batch.ts";
import { pad } from "./batch.ts";
import type {
  Batch,
  DespatchOrder,
  Freeze,
  OnlineRun,
} from "./types.ts";

export function batchOnline(
  orders: readonly DespatchOrder[],
  windowSec: number,
  slotting: Slotting,
): OnlineRun {
  const sorted = [...orders].sort(
    (a, b) => a.arrivalSec - b.arrivalSec || cmpStr(a.id, b.id),
  );
  const fcfs = batchFcfs(orders, slotting);

  const publish: Record<string, number> = {};
  const batchPublish: Record<string, number> = {};
  const waits: Record<string, number> = {};
  const tardy: Record<string, number> = {};
  const freezes: Freeze[] = [];
  const batchSeq: Batch[] = [];

  let pending = [...sorted];
  let seq = 0;
  let totalTour = 0;

  const first = pending[0];
  let freeze = first ? first.arrivalSec + windowSec : 0;

  let guard = pending.length * 2 + 8; // every order publishes at most… 1 round; guard is paranoia
  while (pending.length > 0) {
    if (guard-- < 0) throw new Error("batchOnline: window protocol stalled");
    const visible = pending.filter((o) => o.arrivalSec < freeze);
    if (visible.length === 0) {
      const next = Math.min(...pending.map((o) => o.arrivalSec));
      freeze = next + windowSec;
      continue;
    }

    const run = batchOffline(visible, slotting);
    seq += 1;
    // freeze-tag the ids before anything records them
    const tagged = run.batches.map((b) => ({ ...b, id: freezeTag(b.id, seq) }));
    totalTour += run.totalTourSec;
    freezes.push({
      freezeSec: freeze,
      batchIds: tagged.map((b) => b.id),
      orderIds: visible.map((o) => o.id),
      lines: visible.reduce((s, o) => s + linesOf(o), 0),
    });
    for (const b of tagged) {
      batchSeq.push(b);
      batchPublish[b.id] = freeze;
    }
    for (const o of visible) {
      publish[o.id] = freeze;
      waits[o.id] = Math.round(freeze - o.arrivalSec);
      tardy[o.id] = Math.max(0, Math.round(freeze - o.dueSec));
    }
    const gone = new Set(visible.map((o) => o.id));
    pending = pending.filter((o) => !gone.has(o.id));
    freeze += windowSec;
  }

  const batched = batchRunOf(batchSeq, fcfs, []);
  const tardies = Object.values(tardy);
  const sortedTardies = [...tardies].sort((a, b) => a - b);
  const p90 = sortedTardies[Math.min(sortedTardies.length - 1, Math.floor(sortedTardies.length * 0.9))] ?? 0;

  return {
    windowSec,
    freezes,
    publishedBatches: batchSeq,
    batchPublish,
    totalTourSec: Math.round(totalTour * 1000) / 1000,
    fcfsTourSec: batched.fcfsTourSec,
    walksSaved: batched.walksSaved,
    publish,
    waitsSec: waits,
    tardySec: tardy,
    meanTardySec: Math.round((tardies.reduce((s, t) => s + t, 0) / Math.max(1, tardies.length)) * 100) / 100,
    p90TardySec: p90,
    maxTardySec: tardies.length ? sortedTardies[sortedTardies.length - 1] : 0,
    lateOrders: Object.keys(tardy).filter((k) => tardy[k] > 0).sort(cmpStr),
  };
}

/** re-stamp an off-line batch id with its freeze index, so ids
    stay unique across the day's publications. */
function freezeTag(baseId: string, freezeSeq: number): string {
  return `${baseId}/W${pad(freezeSeq)}`;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export { makeBatch };
