/* ============================================================
   lock.test — the through-line, against the pasted lock.

   The same walk `fixtures/lock.ts` takes — receive the fixed
   documents, stage the desk's lanes, mint on the literal first
   reservations — and every facet asserted against
   `fixtures/expected.ts`: counts, the refusal ledger with its
   reason codes AND fields, both canonical digests, both lane
   digests, both paperwork digests. If a value drifts, the
   lock is re-run and the human pastes the new JSON — never a
   silent rewriting.
   ============================================================ */

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeCanon, fnv1a64, rowDigest } from "../src/canon.ts";
import type { CanonOrder, Refusal } from "../src/canon.ts";
import { DeskYard } from "../src/desk.ts";
import { receive } from "../src/inbound.ts";
import {
  LANES,
  type LaneRow,
  deadSubject,
  despatchRowOf,
  orderSubject,
} from "../src/lane.ts";
import { produceAdvice, produceNotice } from "../src/outbound.ts";
import { ALDERLINE, KELRICK, type Profile } from "../src/partners.ts";
import { WAYBILL_LOCK } from "../fixtures/expected.ts";
import {
  ALDERLINE_940,
  ALDERLINE_940_SE,
  ALDERLINE_940_WIDTH,
  ALDERLINE_SHIPMENT,
  KELRICK_940,
  UNKNOWN_940,
  encodeText,
} from "../fixtures/documents.ts";

/* ---------- the walk, word for word with the lock script ---------- */

const files = [
  { name: "AHL-940-0001", doc: ALDERLINE_940 },
  { name: "KLK-940-0001", doc: KELRICK_940 },
  { name: "UNK-940-0001", doc: UNKNOWN_940 },
  { name: "AHL-940-0002", doc: ALDERLINE_940_WIDTH },
  { name: "AHL-940-0003", doc: ALDERLINE_940_SE },
  {
    name: "AHL-940-0004",
    doc: ALDERLINE_940.replace("W06*AHL-DEPOT-1*AHL-00175~", "").replace("SE*24", "SE*23"),
  },
  {
    name: "AHL-940-0005",
    doc: ALDERLINE_940.replace(
      "W06*AHL-DEPOT-1*AHL-00175~",
      "W06*AHL-DEPOT-1*AHL 00175~",
    ),
  },
];

const yard = new DeskYard();
const orders: CanonOrder[] = [];
const refusals: Refusal[] = [];

for (const f of files) {
  const out = receive({ name: f.name, bytes: encodeText(f.doc) });
  orders.push(...out.orders);
  refusals.push(...out.refusals);
  for (const o of out.orders) {
    const profile: Profile = o.partner === "kelrick" ? KELRICK : ALDERLINE;
    void yard.publish(
      LANES.orders,
      orderSubject(o.ref),
      despatchRowOf(o, profile.despatch.cls, profile.despatch.slaSec),
    );
  }
  for (const r of out.refusals) {
    void yard.publish(LANES.dead, deadSubject(r.code, r.docName), encodeCanon(r));
  }
}

const advice = produceAdvice(ALDERLINE_SHIPMENT, orders.filter((o) => o.partner === "alderline"), ALDERLINE, { isa: 1, group: 1, txn: 1 });
const notice = produceNotice(ALDERLINE_SHIPMENT, orders.filter((o) => o.partner === "alderline"), ALDERLINE, { isa: 1, group: 1, txn: 1 });

const digestRows = (rows: readonly LaneRow[]): string =>
  rowDigest(
    rows.map((r) => ({
      subject: r.kind === "stream" ? r.subject : r.key,
      payload: r.payload,
    })),
  );

describe("lock — the through-line holds its digests", () => {
  it("the file set is the lock's file set", () => {
    strictEqual(files.length, WAYBILL_LOCK.receive.files);
  });

  it("two orders and the refusal ledger, reason at field", () => {
    strictEqual(orders.length, WAYBILL_LOCK.receive.orders);
    deepStrictEqual(
      refusals.map((r) => `${r.code}@${r.at}`),
      WAYBILL_LOCK.receive.refusals,
    );
  });

  it("both canonical orders digest as the lock says", () => {
    deepStrictEqual(
      fnv1a64(encodeCanon(orders.find((o) => o.partner === "alderline")!)),
      WAYBILL_LOCK.canonical.alderline,
    );
    deepStrictEqual(
      fnv1a64(encodeCanon(orders.find((o) => o.partner === "kelrick")!)),
      WAYBILL_LOCK.canonical.kelrick,
    );
  });

  it("the staged lanes digest as the lock says", async () => {
    deepStrictEqual(digestRows(await yard.rows(LANES.orders)), WAYBILL_LOCK.lanes.orders);
    deepStrictEqual(digestRows(await yard.rows(LANES.dead)), WAYBILL_LOCK.lanes.dead);
  });

  it("the minted paperwork digests as the lock says", () => {
    deepStrictEqual(fnv1a64(advice.bytes), WAYBILL_LOCK.mint.advice945);
    deepStrictEqual(fnv1a64(notice.bytes), WAYBILL_LOCK.mint.notice856);
  });
});
