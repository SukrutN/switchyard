/* ============================================================
   lock — the once-per-adapters run: receive the fixed partner
   940s and the crime zoo through the adapter door, stage the
   canonical orders and the refusals onto a DeskYard's lanes,
   mint the 945 and the 856 on fresh reservations, and take
   the row digests. The script PRINTS the JSON; the human
   pastes it into `expected.ts` (pure data, no imports) and
   the characterization tests read it as the law.

   Run: npm run lock
   ============================================================ */

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
import {
  ALDERLINE_940,
  ALDERLINE_940_SE,
  ALDERLINE_940_WIDTH,
  ALDERLINE_SHIPMENT,
  KELRICK_940,
  UNKNOWN_940,
  encodeText,
} from "./documents.ts";

/* ---------- the file set: two partners + the crime zoo ---------- */

const files = [
  { name: "AHL-940-0001", doc: ALDERLINE_940 },
  { name: "KLK-940-0001", doc: KELRICK_940 },
  { name: "UNK-940-0001", doc: UNKNOWN_940 },
  { name: "AHL-940-0002", doc: ALDERLINE_940_WIDTH },
  { name: "AHL-940-0003", doc: ALDERLINE_940_SE },
  {
    // the order date never arrives: a one-order MAP_MISS
    name: "AHL-940-0004",
    doc: ALDERLINE_940.replace("W06*AHL-DEPOT-1*AHL-00175~", "").replace("SE*24", "SE*23"),
  },
  {
    // the ref cannot ride its lane token: a REF_CHARS
    name: "AHL-940-0005",
    doc: ALDERLINE_940.replace(
      "W06*AHL-DEPOT-1*AHL-00175~",
      "W06*AHL-DEPOT-1*AHL 00175~",
    ),
  },
];

/* ---------- stage the through-line on the desk ---------- */

const yard = new DeskYard();
const orders: CanonOrder[] = [];
const refusals: Refusal[] = [];

for (const f of files) {
  const out = receive({ name: f.name, bytes: encodeText(f.doc) });
  orders.push(...out.orders);
  refusals.push(...out.refusals);
  for (const o of out.orders) {
    const profile: Profile = o.partner === "kelrick" ? KELRICK : ALDERLINE;
    await yard.publish(
      LANES.orders,
      orderSubject(o.ref),
      despatchRowOf(o, profile.despatch.cls, profile.despatch.slaSec),
    );
  }
  for (const r of out.refusals) {
    await yard.publish(LANES.dead, deadSubject(r.code, r.docName), encodeCanon(r));
  }
}

/* ---------- the paperwork on literal first reservations ---------- */

const advice = produceAdvice(ALDERLINE_SHIPMENT, orders.filter((o) => o.partner === "alderline"), ALDERLINE, { isa: 1, group: 1, txn: 1 });
const notice = produceNotice(ALDERLINE_SHIPMENT, orders.filter((o) => o.partner === "alderline"), ALDERLINE, { isa: 1, group: 1, txn: 1 });

const digestRows = (rows: readonly LaneRow[]): string =>
  rowDigest(
    rows.map((r) => ({
      // the desk's own framing: a KV row's key rides where a stream row's subject goes
      subject: r.kind === "stream" ? r.subject : r.key,
      payload: r.payload,
    })),
  );

const WAYBILL_LOCK = {
  receive: {
    files: files.length,
    orders: orders.length,
    refusals: refusals.map((r) => `${r.code}@${r.at}`),
  },
  canonical: {
    alderline: fnv1a64(encodeCanon(orders.find((o) => o.partner === "alderline")!)),
    kelrick: fnv1a64(encodeCanon(orders.find((o) => o.partner === "kelrick")!)),
  },
  lanes: {
    orders: digestRows(await yard.rows(LANES.orders)),
    dead: digestRows(await yard.rows(LANES.dead)),
  },
  mint: {
    advice945: fnv1a64(advice.bytes),
    notice856: fnv1a64(notice.bytes),
  },
};

console.log(JSON.stringify(WAYBILL_LOCK, null, 2));
