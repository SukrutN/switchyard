/* ============================================================
   release — waveless release pacing (v0.3).

   The despatch board's second half: after the window publishes
   batches, the floor must absorb them. The law, in cart units,
   because a cart is what physically occupies a picker:

   · the release key is due-date slack (the tightest order due
     in the batch first — EDD, ties by batch id);
   · a zone may give away exactly the picker-seconds its crew
     affords: pickers × elapsed, accrued from shift start. A
     cart loads its tour seconds against its zone the moment
     it is released;
   · a batch waits in whole shift-seconds steps until every
     zone it touches has room; it never leaves before it was
     published.

   The queue series is honest FIFO one-craft service: a released
   cart starts when its zone's last craft finishes (and it was
   released), ends tour seconds later. The unpaced plan is the
   counterfactual — everything leaves at its publication
   instant, the zones cope or queue. The same service model
   reads both, so the curves compare fairly.
   ============================================================ */

import {
  CRAFT_OVERHEAD_SEC,
  LINES_PER_PICKER_HOUR,
  ZONE_GROUP,
} from "./constants.ts";
import { zoneOfAisle } from "./travel.ts";
import type {
  Batch,
  DespatchOrder,
  ReleaseDecision,
  ReleasePlan,
  ZoneCap,
  ZoneSeries,
} from "./types.ts";

/** one batch as the board holds it: its cart, its tightest due,
    the moment its window published it. */
export interface BatchJob {
  readonly batch: Batch;
  readonly publishSec: number;
  readonly dueSec: number; // tightest order due riding in it
}

export function buildJobList(
  batches: readonly Batch[],
  orders: readonly DespatchOrder[],
  publish: Readonly<Record<string, number>>,
): BatchJob[] {
  const orderById = new Map(orders.map((o) => [o.id, o]));
  return batches.map((batch) => {
    let due = Infinity;
    for (const id of batch.orders) {
      const d = orderById.get(id)?.dueSec ?? Infinity;
      if (d < due) due = d;
    }
    return {
      batch,
      publishSec: publish[batch.id] ?? 0,
      dueSec: due === Infinity ? 0 : due,
    };
  });
}

export function zoneCaps(
  zoneCount: number,
  pickersPerZone: number,
): ZoneCap[] {
  const caps: ZoneCap[] = [];
  for (let z = 0; z < zoneCount; z++) {
    caps.push({
      zone: z,
      aisles: [z * ZONE_GROUP + 1, z * ZONE_GROUP + ZONE_GROUP],
      linesPerHour: pickersPerZone * LINES_PER_PICKER_HOUR,
    });
  }
  return caps;
}

/** zone → units of released work (for the decision record) */
function zoneUnitsOf(batch: Batch): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of batch.stops) {
    const z = zoneOfAisle(s.pos.aisle);
    m.set(z, (m.get(z) ?? 0) + s.qty);
  }
  return m;
}

export interface ReleaseInput {
  readonly paced: boolean;
  readonly startSec: number;
  readonly horizonSec: number;
  readonly binSec: number; // series + pacing grid (the board's minute)
}

/**
 * The plan itself. Paced: EDD with the picker-seconds floor. Unpaced:
 * everything at publish. Both return the identical shape so the hall
 * can flip between them with one boolean.
 */
export function releasePlan(
  jobs: readonly BatchJob[],
  caps: readonly ZoneCap[],
  input: ReleaseInput,
): ReleasePlan {
  const decided = makeDecisions(jobs, caps, input);
  const series = simulateSeries(decided, caps, input);

  const peak = Math.max(0, ...series.map((s) => s.peakCarts));
  const readings = series.flatMap((s) => s.readings.map((r) => r.carts));
  const avg =
    Math.round(
      (readings.reduce((s, x) => s + x, 0) / Math.max(1, readings.length)) *
        100,
    ) / 100;

  return {
    paced: input.paced,
    decisions: decided,
    zones: series,
    peakQueueCarts: peak,
    avgQueueCarts: avg,
    lastReleaseSec: decided.reduce((m, d) => Math.max(m, d.releaseSec), 0),
    breaches: decided
      .filter((d) => d.releaseSec > d.dueSec + 1e-9)
      .map((d) => d.batchId)
      .sort(cmpStr),
  };
}

/** the seconds this cart charges its zone when released */
function craftSecOf(batch: Batch): number {
  return batch.ledger.tourSec + CRAFT_OVERHEAD_SEC;
}

/* ---------- the release gate ---------- */

/** a mutable cousin of the decision — the honesty pass must be
    able to push a release forward */
interface WorkDecision {
  readonly batchId: string;
  readonly publishSec: number;
  releaseSec: number;
  readonly dueSec: number;
  readonly zone: number;
  readonly tourSec: number;
  readonly craftSec: number;
  readonly lines: number;
}

function makeDecisions(
  jobs: readonly BatchJob[],
  caps: readonly ZoneCap[],
  input: ReleaseInput,
): ReleaseDecision[] {
  // EDD, ties by publish, then batch id — the slack key A–Z
  const sorted = [...jobs].sort(
    (a, b) =>
      a.dueSec - b.dueSec ||
      a.publishSec - b.publishSec ||
      cmpStr(a.batch.id, b.batch.id),
  );

  // cumulative craft-seconds a zone has already been promised
  const given = new Map<number, number>();
  const out: WorkDecision[] = [];

  for (const job of sorted) {
    const units = zoneUnitsOf(job.batch);
    const home = job.batch.zone; // one craft, one station — the cart
    const craft = craftSecOf(job.batch); // loads its own zone, full cost

    if (!input.paced) {
      given.set(home, (given.get(home) ?? 0) + craft);
      out.push(mkDecision(job, job.publishSec, units, craft));
      continue;
    }

    let t = Math.max(Math.ceil(job.publishSec), input.startSec);
    for (;;) {
      const pickers =
        caps.find((c) => c.zone === home)!.linesPerHour /
        LINES_PER_PICKER_HOUR;
      const affordable = pickers * (t - input.startSec);
      if ((given.get(home) ?? 0) + craft <= affordable + 1e-6) break;
      t += input.binSec;
    }
    given.set(home, (given.get(home) ?? 0) + craft);
    out.push(mkDecision(job, t, units, craft));
  }

  // ---- the honesty pass: the gate counted decided jobs in EDD
  // processing order; the floor feels them in release order. A
  // job approved now can collide with a later-processed job that
  // escaped earlier — so walk every zone's releases forward and
  // push any collision past the crew's affordability. Delaying a
  // cart only loosens the bins behind it, so one pass settles.
  if (input.paced) {
    for (const cap of caps) {
      const pickers = cap.linesPerHour / LINES_PER_PICKER_HOUR;
      const events = out
        .filter((d) => d.zone === cap.zone)
        .sort(
          (a, b) => a.releaseSec - b.releaseSec || cmpStr(a.batchId, b.batchId),
        );
      let cum = 0;
      for (const d of events) {
        cum += d.craftSec;
        while (cum > pickers * (d.releaseSec - input.startSec) + 1e-6) {
          d.releaseSec += input.binSec;
        }
      }
    }
  }

  return out
    .sort((a, b) => a.releaseSec - b.releaseSec || cmpStr(a.batchId, b.batchId))
    .map((d): ReleaseDecision => ({ ...d, releaseSec: Math.round(d.releaseSec) }));
}

function mkDecision(
  job: BatchJob,
  releaseSec: number,
  units: Map<number, number>,
  craft: number,
): WorkDecision {
  return {
    batchId: job.batch.id,
    publishSec: Math.round(job.publishSec),
    releaseSec: Math.round(releaseSec),
    dueSec: Math.round(job.dueSec),
    zone: job.batch.zone,
    tourSec: job.batch.ledger.tourSec,
    craftSec: Math.round(craft),
    lines: [...units.values()].reduce((s, n) => s + n, 0),
  };
}

/* ---------- the honest FIFO service sim ---------- */

interface ServedCart {
  readonly releaseSec: number;
  readonly finishSec: number;
}

function serveZone(
  zone: number,
  decided: readonly ReleaseDecision[],
): ServedCart[] {
  // FIFO by release, ties by batch id — the craft takes the first
  // cart that arrived
  const mine = decided
    .filter((d) => d.zone === zone)
    .sort(
      (a, b) =>
        a.releaseSec - b.releaseSec || cmpStr(a.batchId, b.batchId),
    );
  let finish = 0;
  const out: ServedCart[] = [];
  for (const d of mine) {
    const start = Math.max(d.releaseSec, finish);
    finish = start + d.craftSec;
    out.push({ releaseSec: d.releaseSec, finishSec: finish });
  }
  return out;
}

function simulateSeries(
  decided: readonly ReleaseDecision[],
  caps: readonly ZoneCap[],
  input: ReleaseInput,
): ZoneSeries[] {
  const end = Math.max(
    input.horizonSec,
    decided.reduce((m, d) => Math.max(m, d.releaseSec), 0) + input.binSec,
  );
  const bins = Math.ceil((end - input.startSec) / input.binSec);

  return caps.map((cap) => {
    const served = serveZone(cap.zone, decided);
    const readings: { t: number; carts: number }[] = [];
    let peak = 0;
    for (let i = 0; i < bins; i++) {
      const t = input.startSec + i * input.binSec;
      const q = served.filter(
        (c) => c.releaseSec <= t && c.finishSec > t,
      ).length;
      if (q > peak) peak = q;
      readings.push({ t, carts: q });
    }
    return { zone: cap.zone, readings, peakCarts: peak };
  });
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
