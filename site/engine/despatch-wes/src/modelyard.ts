/* ============================================================
   modelyard — MemoryYard: the whole §2.8–§2.23 contract, in
   process, with no broker and no timers.

   It is the tabletop stand-in for the real yard: the promises
   the orchestrator leans on, honored honestly but cheaply —

   · one journal per lane, sequence gapless from 1, fsync-free
     but order-faithful (write order is the contract, §2.10);
   · durable consumers with floors and pending rows; attach
     replays everything past the floor; explicit `sweep()` does
     what the yard's ackWait reprobe does — redelivery of
     pending rows, always in sequence order, duplicates carrying
     their seq (§2.15, at-least-once);
   · KV rows journal on the lane's own sequence space and stay
     invisible to stream consumers (§2.18) — tombstones too;
   · the drill-down (§2.27) reads the same numbers a real
     LANE_STATE would: seq, quarantined, journalBytes, keyCount,
     consumer rows ascending by name.

   Determinism law: no wall-clock enters here. Redelivery is a
   call, receive order is the lane's, and the journal bytes are
   a pure function of the writes. The characterization tests and
   the bench run this yard; the real Go yard runs in
   integration/run.ts over the same WesYard seam.
   ============================================================ */

import { subjectMatches } from "./wire.ts";
import type {
  KVValue,
  LaneDelivery,
  LaneStateLite,
  WesYard,
} from "./yard.ts";
import { NAME } from "./yard.ts";

type RowKind = "msg" | "kv" | "tomb";

interface LaneRow {
  readonly seq: number;
  readonly kind: RowKind;
  readonly subject: string; // msg rows only
  readonly key: string; // kv/tomb rows only
  readonly payload: Uint8Array;
}

interface Consumer {
  name: string;
  handler: (d: LaneDelivery) => void;
  attached: boolean;
  floor: number;
  ackedAboveFloor: Set<number>;
  pending: Set<number>;
  filter?: string;
}

interface KVEntry {
  payload: Uint8Array;
  seq: number;
}

interface Lane {
  name: string;
  seq: number;
  rows: LaneRow[];
  consumers: Map<string, Consumer>;
  kv: Map<string, KVEntry>;
  quarantined: boolean;
}

function bytesOf(row: LaneRow): number {
  // mirror of the on-disk record's rough size: seq + kind + the body
  return row.subject.length + row.key.length + row.payload.length + 12;
}

export class MemoryYard implements WesYard {
  private lanes = new Map<string, Lane>();

  private laneOf(name: string, create = false): Lane {
    let lane = this.lanes.get(name);
    if (!lane && create) {
      lane = {
        name,
        seq: 0,
        rows: [],
        consumers: new Map(),
        kv: new Map(),
        quarantined: false,
      };
      this.lanes.set(name, lane);
    }
    if (!lane) throw new Error(`MemoryYard: lane "${name}" does not exist`);
    return lane;
  }

  async ensureLane(name: string): Promise<void> {
    this.laneOf(name, true);
  }

  async publishRow(lane: string, subject: string, payload: Uint8Array): Promise<number> {
    const l = this.laneOf(lane, true);
    if (l.quarantined) throw new Error("MemoryYard: lane quarantined (SERVER_FAULT)");
    l.seq += 1;
    const row: LaneRow = { seq: l.seq, kind: "msg", subject, key: "", payload };
    l.rows.push(row);
    // fan-out to attached consumers, §2.11's "journals first, then fans out"
    for (const c of sortedConsumers(l)) {
      if (c.filter && !subjectMatches(c.filter, subject)) continue;
      c.pending.add(row.seq);
      // §2.14: same seq for every consumer of one lane
      this.deliver(l, c, row);
    }
    return l.seq;
  }

  private deliver(l: Lane, c: Consumer, row: LaneRow): void {
    if (!c.attached) return;
    const d: LaneDelivery = {
      lane: l.name,
      seq: row.seq,
      subject: row.subject,
      payload: row.payload,
    };
    try {
      c.handler(d);
    } catch (e) {
      // handler errors belong to the consumer, not the lane's journal
      void e;
    }
  }

  async attachConsumer(
    lane: string,
    consumer: string,
    onDelivery: (d: LaneDelivery) => void,
    opts?: { filter?: string },
  ): Promise<number> {
    const l = this.laneOf(lane, true);
    const existing = l.consumers.get(consumer);
    // §2.12's law decides the resume path: re-attaching a durable
    // consumer name whose session died IS the resume (the yard replays
    // from the persisted floor; DUP_CONSUMER is only for a name live
    // on ANOTHER session — an in-process model has no other sessions,
    // so a live re-attach takes over the delivery handler instead).
    const c: Consumer = existing ?? {
      name: consumer,
      handler: onDelivery,
      attached: false,
      floor: 0,
      ackedAboveFloor: new Set(),
      pending: new Set(),
      filter: opts?.filter,
    };
    c.handler = onDelivery;
    if (opts?.filter) c.filter = opts.filter;
    c.attached = true;
    l.consumers.set(consumer, c);
    // resume: replay everything past the floor, in sequence order —
    // pending rows carry their seq (at-least-once, §2.15).
    for (const row of l.rows) {
      if (row.kind !== "msg" || row.seq <= c.floor) continue;
      if (!c.filter || subjectMatches(c.filter, row.subject)) {
        this.deliver(l, c, row);
      }
    }
    return c.floor + 1;
  }

  async ackRow(lane: string, consumer: string, seq: number): Promise<void> {
    const l = this.laneOf(lane);
    const c = l.consumers.get(consumer);
    if (!c) throw new Error(`MemoryYard: NO_CONSUMER "${consumer}" on "${lane}"`);
    c.pending.delete(seq);
    c.ackedAboveFloor.add(seq);
    // the floor advances across contiguous acks (§2.15)
    while (c.ackedAboveFloor.has(c.floor + 1)) {
      c.floor += 1;
      c.ackedAboveFloor.delete(c.floor);
    }
  }

  /** what the yard's ackWait reprobe does, as an explicit call: pending
      rows redeliver, always in sequence order, duplicates carry their
      seq (§2.15). No timers live in this yard.
      Returns the number of redeliveries. */
  sweep(lane: string, consumer?: string): number {
    const l = this.laneOf(lane);
    let count = 0;
    for (const c of sortedConsumers(l)) {
      if (consumer && c.name !== consumer) continue;
      if (!c.attached) continue;
      for (const seq of [...c.pending].sort((a, b) => a - b)) {
        const row = l.rows.find((r) => r.seq === seq);
        if (row && row.kind === "msg") {
          this.deliver(l, c, row);
          count += 1;
        }
      }
    }
    return count;
  }

  detachConsumer(lane: string, consumer: string): void {
    const l = this.laneOf(lane);
    const c = l.consumers.get(consumer);
    if (c) c.attached = false; // forgets nothing; the floor holds (§2.12)
  }

  async laneState(lane: string): Promise<LaneStateLite> {
    const l = this.laneOf(lane);
    const consumers = sortedConsumers(l).map((c) => ({
      name: c.name,
      floor: c.floor,
      pending: c.pending.size,
      attached: c.attached,
    }));
    return {
      lane: l.name,
      seq: l.seq,
      quarantined: l.quarantined,
      journalBytes: l.rows.reduce((s, r) => s + bytesOf(r), 0),
      keyCount: l.kv.size,
      pending: consumers.reduce((s, c) => s + c.pending, 0),
      consumers,
    };
  }

  /* ---------- KV family (§2.18–§2.23) ---------- */

  async kvSet(lane: string, key: string, payload: Uint8Array): Promise<number> {
    const l = this.laneOf(lane, true);
    if (l.quarantined) throw new Error("MemoryYard: lane quarantined (SERVER_FAULT)");
    l.seq += 1;
    l.rows.push({ seq: l.seq, kind: "kv", subject: "", key, payload });
    l.kv.set(key, { payload, seq: l.seq });
    return l.seq;
  }

  async kvGet(lane: string, key: string): Promise<KVValue> {
    const l = this.laneOf(lane);
    const entry = l.kv.get(key);
    if (!entry) return { found: false, payload: new Uint8Array(0), seq: 0 };
    return { found: true, payload: entry.payload, seq: entry.seq };
  }

  async kvKeys(lane: string): Promise<readonly string[]> {
    const l = this.laneOf(lane);
    return [...l.kv.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  async kvDelete(lane: string, key: string): Promise<number> {
    const l = this.laneOf(lane, true);
    l.seq += 1;
    l.rows.push({ seq: l.seq, kind: "tomb", subject: "", key, payload: new Uint8Array(0) });
    l.kv.delete(key); // the tombstone is the record; live keys subtract it
    return l.seq;
  }

  /* ---------- inspection (tests & runs) ---------- */

  /** the journaled rows of one lane — the replay story's raw truth.
      KV rows ride along (kind "kv"/"tomb"), per §2.18's journal law. */
  rowsOf(lane: string): readonly { seq: number; kind: RowKind; subject: string; key: string; payload: Uint8Array }[] {
    return this.laneOf(lane).rows;
  }

  msgRows(lane: string): readonly { seq: number; subject: string; payload: Uint8Array }[] {
    return this.laneOf(lane)
      .rows.filter((r) => r.kind === "msg")
      .map((r) => ({ seq: r.seq, subject: r.subject, payload: r.payload }));
  }

  consumerFloor(lane: string, consumer: string): number {
    return this.laneOf(lane).consumers.get(consumer)?.floor ?? 0;
  }

  consumerNames(lane: string): readonly string[] {
    return this.laneOf(lane).consumers.size > 0
      ? [...this.laneOf(lane).consumers.keys()].sort()
      : [];
  }

  laneNames(): readonly string[] {
    return [...this.lanes.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** fault injection: the §9 quarantine — a write that has failed once
      refuses further writes with SERVER_FAULT until restart. Tests drive
      it explicitly; the real yard earns it from a disk. */
  quarantine(lane: string): void {
    this.laneOf(lane).quarantined = true;
  }
}

function sortedConsumers(l: Lane): Consumer[] {
  return [...l.consumers.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

/** the pre-staging half of a shift: the fixture publisher that turns a
    day of engine orders into `orders` lane rows (the inbound freight).
    Subject: `orders.<ref>.paid`; payload: the canonical order record. */
export async function hasLane(yard: MemoryYard, lane: string): Promise<boolean> {
  return yard.laneNames().includes(lane);
}

/** convenience for tests: is the batcher's floor exactly expected? */
export function floorOf(yard: MemoryYard, consumer: string = NAME.batcher): number {
  return yard.consumerFloor(NAME.orders, consumer);
}
