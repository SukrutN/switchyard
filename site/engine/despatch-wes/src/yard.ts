/* ============================================================
   yard — the seam the orchestrator codes against.

   The WES is a spur-style client over the lanes. This interface
   is the contract it needs from a yard — and exactly what the
   real Switchyard promises on the wire (PROTOCOL.md):

   · lanes journal every write with a gapless sequence (§2.10/§2.11);
   · durable consumers push deliveries and ack floors persist
     (§2.12–§2.15) — at-least-once, duplicates carry the same seq;
   · KV rows ride the lane's own sequence space (§2.18) and are
     journal rows of their own kind — consumers see only streams;
   · one lane's drill-down (§2.27) is the depth gauge's read.

   Two implementations ride this seam:
   · `modelyard.ts` — MemoryYard, in-process, deterministic, the
     bench-and-test yard (no broker needed);
   · `liveyard.ts`  — LiveYard, over a real spur session, for the
     real Go yard in `integration/run.ts`.
   ============================================================ */

/** one journaled lane write reaching a consumer (§2.14). */
export interface LaneDelivery {
  readonly lane: string;
  readonly seq: number; // the LANE's sequence — gapless from 1, shared
  readonly subject: string;
  readonly payload: Uint8Array;
}

export interface LaneConsumerRow {
  readonly name: string;
  readonly floor: number; // highest sequence fully acknowledged (§2.27)
  readonly pending: number; // delivered-but-not-acked, right now
  readonly attached: boolean;
}

/** the §2.27 answer, as the orchestrator reads it. */
export interface LaneStateLite {
  readonly lane: string;
  readonly seq: number;
  readonly quarantined: boolean;
  readonly journalBytes: number;
  readonly keyCount: number;
  readonly pending: number; // Σ consumer pending — the depth gauge
  readonly consumers: readonly LaneConsumerRow[];
}

/** a KV answer, with the §2.22 flag law: FOUND by flag, empty legal. */
export interface KVValue {
  readonly found: boolean;
  readonly payload: Uint8Array;
  readonly seq: number; // the set that wrote the value; 0 when not found
}

export interface ConsumerOptions {
  /** §3 pattern (e.g. "orders.>") */
  readonly filter?: string;
}

export interface WesYard {
  /** open (or confirm) a lane; idempotent, STREAM_EXISTS stays calm */
  ensureLane(lane: string): Promise<void>;

  /** the journaled write; resolves with the receipt's lane seq (§2.11) */
  publishRow(lane: string, subject: string, payload: Uint8Array): Promise<number>;

  /** attach or resume a push consumer; resolves with the resume floor
      (§2.13's `next`). Deliveries push; at-least-once after resume. */
  attachConsumer(
    lane: string,
    consumer: string,
    onDelivery: (d: LaneDelivery) => void,
    opts?: ConsumerOptions,
  ): Promise<number>;

  /** §2.15 — one sequence per ack; contiguous floors advance silently */
  ackRow(lane: string, consumer: string, seq: number): Promise<void>;

  /** the depth gauge's read (§2.27). */
  laneState(lane: string): Promise<LaneStateLite>;

  /** §2.18–§2.23. KV rows are journal rows of their own kind (§2.19);
      a delete is the tombstone row (§2.20). */
  kvSet(lane: string, key: string, payload: Uint8Array): Promise<number>;
  kvGet(lane: string, key: string): Promise<KVValue>;
  kvDelete(lane: string, key: string): Promise<number>;
  kvKeys(lane: string): Promise<readonly string[]>;
}

/** lane charter naming — the column names this family uses. */
export const NAME = {
  orders: "orders",
  release: "despatch-release",
  quarantine: "despatch-quarantine",
  control: "despatch-control",
  pace: "despatch-pace",
  workPrefix: "work-z", // zone lanes: work-z1.. (zone display is 1-based)
  batcher: "despatch-batch",
  controller: "despatch-ctl",
} as const;

export function workLane(zone: number): string {
  return `${NAME.workPrefix}${zone + 1}`;
}

export function workSubject(lane: string, batchId: string): string {
  // first token must equal the lane (§2.10); batch ids carry no dots
  return `${lane}.batch.${batchId}`;
}
