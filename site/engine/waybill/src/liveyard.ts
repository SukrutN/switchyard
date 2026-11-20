/* ============================================================
   liveyard — the WaybillLane seam over a live spur session.

   The thin, boring translation layer between the adapter's
   clean seam and the real line protocol: every method is one
   spur round-trip or fire-and-forget, and the §6 refusals
   surface exactly as WireErrors. STREAM_EXISTS on ensure is
   not an error to its caller — "already there" is the success
   case, per §2.8's idempotence story.

   One honest asymmetry stands in the mirror (§2.18): on the
   real yard, KV records are journal rows of their own kind and
   are NEVER delivered to lane consumers — the key state reads
   back through kvGet. So `rows()` over a live lane is the
   stream-row window only: an attach from the lane's start,
   collecting stream rows and acknowledging each as it lands.
   The DeskYard's blanket journal (kv rows included) is the
   in-process truth; the live mirror reads what the wire
   offers.

   Live-only tooling: the walk closes on quiescence at the
   boundary — the one place waybill lets a wall clock speak.
   Engine determinism is untouched.
   ============================================================ */

import * as w from "./wire.ts";
import type { Spur } from "./spur.ts";
import type { KVAnswer, LaneRow, WaybillLane } from "./lane.ts";

export class LiveYard implements WaybillLane {
  private spur: Spur;
  private walks = 0;

  constructor(spur: Spur) {
    this.spur = spur;
  }

  async ensure(lane: string): Promise<void> {
    try {
      await this.spur.streamCreate(lane);
      return;
    } catch (e) {
      if (e instanceof w.WireError && e.code === w.ERR.STREAM_EXISTS) return;
      throw e;
    }
  }

  publish(lane: string, subject: string, payload: Uint8Array): Promise<number> {
    return this.spur.streamPublish(lane, subject, payload);
  }

  kvSet(lane: string, key: string, payload: Uint8Array): Promise<number> {
    return this.spur.kvSet(lane, key, payload);
  }

  async kvGet(lane: string, key: string): Promise<KVAnswer> {
    const v = await this.spur.kvGet(lane, key);
    if (!v.found) return { found: false, payload: new Uint8Array(0), seq: 0 };
    return { found: true, payload: v.payload ?? new Uint8Array(0), seq: v.seq };
  }

  kvDelete(lane: string, key: string): Promise<number> {
    return this.spur.kvDelete(lane, key);
  }

  keys(lane: string): Promise<readonly string[]> {
    return this.spur.kvKeys(lane);
  }

  /** the stream-row window (see header). The walk ends after
      quietMs with no new delivery: the lane's last stream row is
      in hand, and KV rows — which share the sequence space but
      never deliver (§2.18) — cannot strand it. */
  async rows(lane: string, quietMs = 250): Promise<readonly LaneRow[]> {
    const info = await this.spur.laneInfo(lane);
    if (info.seq === 0) return [];
    const name = `wl-walk-${++this.walks}`;
    const rows: LaneRow[] = [];
    const ready = await this.spur.consumerAttach(
      lane,
      name,
      (d) => {
        rows.push({
          seq: d.seq,
          kind: "stream",
          subject: d.subject,
          key: "",
          payload: d.payload,
        });
        this.spur.ack(d.sid, d.seq);
      },
    );
    try {
      let seen = -1;
      while (seen !== rows.length) {
        seen = rows.length;
        await quiet(quietMs);
      }
    } finally {
      this.spur.consumerDetach(ready.sid);
    }
    return rows;
  }
}

/** the walk's closing gate: one unhurried wait. */
function quiet(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
}
