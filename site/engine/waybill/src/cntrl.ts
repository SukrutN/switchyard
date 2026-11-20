/* ============================================================
   cntrl — envelope control numbers, paced from KV.

   Every outbound document carries three numbers that MUST NOT
   repeat within a trading partner: the interchange (ISA13),
   the group (GS06), the transaction (ST02). The law: the
   counter state lives on the pace lane's KV; a mint RESERVES
   before the caller gets numbers — the KV write wins, the
   bytes follow. A crash between the reservation and the use
   costs a gap (honest, journaled, documented); a repeat costs
   a partner quarantine. Gaps are free. Duplicates are not.

   Formats are the standard's own: ISA13 nine digits zero-
   padded, ST02 four, GS06 an unpadded decimal. Non-conforming
   values die at the pad, loudly.
   ============================================================ */

import { canonRow, nat } from "./canon.ts";
import type { WaybillLane } from "./lane.ts";

export interface ControlData {
  readonly isa: number;
  readonly group: number;
  readonly txn: number;
}

export function controlKey(partner: string, doc: string): string {
  return `cntrl.${partner}.${doc}`;
}

/** the state's bytes: fixed key order, ints only. */
export function encodeControls(c: ControlData): Uint8Array {
  return canonRow([
    ["isa", nat(c.isa)],
    ["group", nat(c.group)],
    ["txn", nat(c.txn)],
  ]);
}

export function decodeControls(b: Uint8Array): ControlData {
  const o = JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>;
  const bad = (what: string): never => {
    throw new Error(`cntrl: state ${what} is not a count`);
  };
  const n = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return bad(String(v));
    return v;
  };
  return { isa: n(o.isa), group: n(o.group), txn: n(o.txn) };
}

/** reserve the next triple for `partner` + `doc`. The KV write is
    the reservation: it lands BEFORE the numbers are returned, so
    two mints can never race to the same number.

    The race lock: read-modify-write over KV is not atomic, and
    this module is waybill's minting desk — one process mints.
    Reservations for one key queue behind each other here; the
    journal stays the durable state across reboots (the tests
    prove the count resumes from the rows). */
/** per-key mint queue: the promise every next reservation waits on. */
const mintQueues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = mintQueues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job); // a failed predecessor does not strand the queue
  mintQueues.set(key, next.catch(() => undefined));
  return next;
}

export async function reserve(
  yard: WaybillLane,
  paceLane: string,
  partner: string,
  doc: string,
): Promise<ControlData> {
  const key = controlKey(partner, doc);
  return serialized(key, async () => {
    const prev = await yard.kvGet(paceLane, key);
    const base: ControlData = prev.found
      ? decodeControls(prev.payload)
      : { isa: 0, group: 0, txn: 0 };
    const next: ControlData = {
      isa: base.isa + 1,
      group: base.group + 1,
      txn: base.txn + 1,
    };
    await yard.kvSet(paceLane, key, encodeControls(next));
    return next;
  });
}

/** ISA13: nine digits, zero-padded — the width is the law. */
export function isa13(n: number): string {
  if (n < 1 || n > 999_999_999) {
    throw new Error(`cntrl: ISA13 ${n} out of range (1..999999999)`);
  }
  return String(n).padStart(9, "0");
}

/** ST02: four digits, zero-padded. */
export function txnCtl(n: number): string {
  if (n < 1 || n > 9_999) {
    throw new Error(`cntrl: ST02 ${n} out of range (1..9999)`);
  }
  return String(n).padStart(4, "0");
}
