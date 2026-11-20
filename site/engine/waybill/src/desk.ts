/* ============================================================
   desk — DeskYard, the adapters' tabletop yard.

   The in-process WaybillLane: lanes journal every write with a
   gapless per-lane sequence (stream rows, KV sets, KV deletes —
   all in one sequence space, §2.18), KV answers read back the
   value plus the seq of the set that wrote it, and `rows`
   hands over the whole journal for replay. No broker, no
   sockets, no clock — the same bytes out twice.

   What it deliberately does NOT do: consumers, floors, redelivery.
   Waybill publishes and paces; the reading side of the order lane
   belongs to despatch-wes. The live bring-up's replay proof rides
   the real yard's durable consumers instead (integration/run.ts),
   which is the honest rehearsal of both halves.
   ============================================================ */

import type { KVAnswer, LaneRow, WaybillLane } from "./lane.ts";

interface LaneState {
  seq: number;
  rows: LaneRow[];
  kv: Map<string, { payload: Uint8Array; seq: number; del: boolean }>;
}

export class DeskYard implements WaybillLane {
  private lanes = new Map<string, LaneState>();

  private state(lane: string): LaneState {
    let s = this.lanes.get(lane);
    if (s === undefined) {
      s = { seq: 0, rows: [], kv: new Map() };
      this.lanes.set(lane, s);
    }
    return s;
  }

  async ensure(lane: string): Promise<void> {
    if (lane.length < 1 || lane.length > 64) {
      throw new Error(`desk: lane name ${JSON.stringify(lane)} is not a name`);
    }
    this.state(lane);
  }

  async publish(lane: string, subject: string, payload: Uint8Array): Promise<number> {
    const s = this.state(lane);
    s.seq += 1;
    s.rows.push({ seq: s.seq, kind: "stream", subject, key: "", payload });
    return s.seq;
  }

  async kvSet(lane: string, key: string, payload: Uint8Array): Promise<number> {
    const s = this.state(lane);
    s.seq += 1;
    s.kv.set(key, { payload, seq: s.seq, del: false });
    s.rows.push({ seq: s.seq, kind: "kv", subject: "", key, payload });
    return s.seq;
  }

  async kvGet(lane: string, key: string): Promise<KVAnswer> {
    const s = this.state(lane);
    const v = s.kv.get(key);
    if (v === undefined || v.del) {
      return { found: false, payload: new Uint8Array(0), seq: 0 };
    }
    return { found: true, payload: v.payload, seq: v.seq };
  }

  async kvDelete(lane: string, key: string): Promise<number> {
    const s = this.state(lane);
    const v = s.kv.get(key);
    s.seq += 1;
    s.rows.push({ seq: s.seq, kind: "kvdel", subject: "", key, payload: new Uint8Array(0) });
    if (v !== undefined && !v.del) {
      v.del = true;
      return s.seq;
    }
    return s.seq; // deleting a missing key still journals; the yard's law
  }

  async keys(lane: string): Promise<readonly string[]> {
    const s = this.state(lane);
    return [...s.kv.entries()].filter(([, v]) => !v.del).map(([k]) => k).sort();
  }

  async rows(lane: string): Promise<readonly LaneRow[]> {
    return [...this.state(lane).rows];
  }
}
