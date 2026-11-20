/* ============================================================
   liveyard — the WesYard seam over a live spur session.

   This is the thin, boring translation layer between the
   orchestrator's clean seam and the real line protocol: every
   method is one spur round-trip or fire-and-forget, and the §6
   refusals surface exactly as WireErrors. STREAM_EXISTS on
   ensureLane is not an error to its caller — "already there" is
   the success case, per §2.8's idempotence story.

   The depth gauge aggregates every consumer's pending (§2.27),
   which is what the backpressure hold probes read.
   ============================================================ */

import * as w from "./wire.ts";
import type { Spur } from "./spur.ts";
import type {
  ConsumerOptions,
  KVValue,
  LaneDelivery,
  LaneStateLite,
  WesYard,
} from "./yard.ts";

export class LiveYard implements WesYard {
  private spur: Spur;
  private sids = new Map<string, number>();
  private ackWait: number;

  constructor(spur: Spur, ackWaitMillis = 0) {
    this.spur = spur;
    this.ackWait = ackWaitMillis;
  }

  async ensureLane(lane: string): Promise<void> {
    try {
      await this.spur.streamCreate(lane);
      return;
    } catch (e) {
      if (e instanceof w.WireError && e.code === w.ERR.STREAM_EXISTS) return;
      throw e;
    }
  }

  publishRow(lane: string, subject: string, payload: Uint8Array): Promise<number> {
    return this.spur.streamPublish(lane, subject, payload);
  }

  async attachConsumer(
    lane: string,
    consumer: string,
    onDelivery: (d: LaneDelivery) => void,
    opts?: ConsumerOptions,
  ): Promise<number> {
    const ready = await this.spur.consumerAttach(
      lane,
      consumer,
      (d) => onDelivery({ lane, seq: d.seq, subject: d.subject, payload: d.payload }),
      { filter: opts?.filter, ackWaitMillis: this.ackWait },
    );
    this.sids.set(sidKey(lane, consumer), ready.sid);
    return ready.next;
  }

  async ackRow(lane: string, consumer: string, seq: number): Promise<void> {
    const sid = this.sids.get(sidKey(lane, consumer));
    if (sid === undefined) return; // never attached: nothing to ack
    this.spur.ack(sid, seq); // no reply frame; refusals ride the error route
  }

  async laneState(lane: string): Promise<LaneStateLite> {
    const s = await this.spur.laneInfo(lane);
    return {
      lane: s.lane,
      seq: s.seq,
      quarantined: s.quarantined,
      journalBytes: s.journalBytes,
      keyCount: s.keyCount,
      pending: s.consumers.reduce((n, c) => n + c.pending, 0),
      consumers: s.consumers,
    };
  }

  async kvSet(lane: string, key: string, payload: Uint8Array): Promise<number> {
    return this.spur.kvSet(lane, key, payload);
  }

  async kvGet(lane: string, key: string): Promise<KVValue> {
    const v = await this.spur.kvGet(lane, key);
    if (!v.found) return { found: false, payload: new Uint8Array(0), seq: 0 };
    return { found: true, payload: v.payload ?? new Uint8Array(0), seq: v.seq };
  }

  kvKeys(lane: string): Promise<readonly string[]> {
    return this.spur.kvKeys(lane);
  }

  kvDelete(lane: string, key: string): Promise<number> {
    return this.spur.kvDelete(lane, key);
  }

  forget(consumer: string): void {
    for (const key of [...this.sids.keys()]) {
      if (key.endsWith(`\u0000${consumer}`)) this.sids.delete(key);
    }
  }
}

function sidKey(lane: string, consumer: string): string {
  return `${lane}\u0000${consumer}`;
}
