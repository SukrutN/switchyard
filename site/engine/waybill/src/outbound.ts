/* ============================================================
   outbound — canonical shipments become the partner's paperwork.

   The 945 (warehouse shipping advice) and the 856 (the ship
   notice, ASN) mint from the spine with three inputs: the
   canonical shipment, the canonical orders its items cite
   (the ship-to lives on the order, not the shipment), and a
   control reservation from cntrl. Both writers count their
   own segments (SE01 = body + 2), and both ride profile data
   for the functional codes and id qualifiers — no partner
   branches. Transport is NOT here: nothing in this family
   dials a VAN. The bytes go back to the caller; the control
   numbers already rode the journal.

   The 945's shape (per the companion-guide subset the fixtures
   lock): BGN, W06 (account + shipment id), the ship-to N1
   (+N3/N4), G62*11 (ship date), MAN*GM marks at the shipment
   level, an LX/W12 line loop (W12 = original, shipped, uom,
   id pair), W03 totals (units, and grams when weighed). The
   856's shape: BSN, DTM*011, an HL hierarchy — S at the top,
   an O loop per order with PRF (the PO when the order has
   one), an I line under each with LIN (the id pair) and SN1
   (what left). The standard is paid ANSI; these are the
   segments the fixtures carry, and the round-trip holds them.
   ============================================================ */

import { type CanonOrder, type CanonShipment, civilDate, civilTime } from "./canon.ts";
import type { ControlData } from "./cntrl.ts";
import { isa13, txnCtl } from "./cntrl.ts";
import type { Profile } from "./partners.ts";
import { OURS } from "./partners.ts";
import {
  buildTx,
  encodeX12,
  type Envelope,
  type Segment,
  padIsa,
  seg,
} from "./x12.ts";

export interface OutboundDoc {
  readonly doc: "945" | "856";
  readonly bytes: Uint8Array;
  readonly envelope: Envelope;
  readonly controls: ControlData;
}

const DELIMS = { elem: "*", comp: ":", segTerm: "~" } as const;

function interchange(
  doc: "945" | "856",
  profile: Profile,
  out: NonNullable<Profile["out"]>,
  date: string,
  time: string,
  ctl: ControlData,
  txs: Envelope["groups"][number]["txs"],
): Envelope {
  const num = isa13(ctl.isa);
  const isa = [
    padIsa(0, "00"),
    padIsa(1, ""), // authorization info withheld: ten blanks
    padIsa(2, "00"),
    padIsa(3, ""),
    padIsa(4, OURS.isaQual),
    padIsa(5, OURS.isaId),
    padIsa(6, profile.isa.qual),
    padIsa(7, profile.isa.id),
    padIsa(8, date.slice(2)), // YYMMDD
    padIsa(9, time),
    padIsa(10, "U"), // 4010: the standards identifier owns ISA11
    padIsa(11, "00401"),
    padIsa(12, num),
    padIsa(13, "0"),
    padIsa(14, "P"),
    padIsa(15, DELIMS.comp),
  ];
  return {
    isa,
    groups: [
      {
        gs: [
          out.gsfn[doc],
          OURS.gsApp,
          profile.isa.id,
          date,
          time,
          String(ctl.group),
          "X",
          "004010",
        ],
        txs,
        ge: ["1", String(ctl.group)],
      },
    ],
    iea: ["1", num],
    delims: DELIMS,
    trailingTerminator: true,
  };
}

/* ---------- the 945 ---------- */

export function produceAdvice(
  ship: CanonShipment,
  orders: readonly CanonOrder[],
  profile: Profile,
  ctl: ControlData,
): OutboundDoc {
  if (profile.out === undefined) {
    throw new Error(`outbound: ${profile.key} ships nothing (no out map)`);
  }
  const out = profile.out;
  if (ship.items.length === 0) {
    throw new Error(`outbound: shipment ${ship.ref} carries no items`);
  }
  const orderOf = orders.find((o) => o.ref === (ship.items[0]?.orderRef ?? ""));
  if (orderOf === undefined) {
    throw new Error(`outbound: shipment ${ship.ref} cites order ${JSON.stringify(ship.items[0]?.orderRef)} which no canonical order carries`);
  }
  const shipTo = orderOf.parties.find((p) => p.role === "shipTo");
  const date = civilDate(ship.dateSec);
  const time = civilTime(ship.dateSec);

  const body: Segment[] = [];
  body.push(seg("BGN", "00", date, time, ship.ref));
  body.push(seg("W06", ship.account, ship.ref));
  if (shipTo !== undefined) {
    if (shipTo.id !== undefined && shipTo.idQual !== undefined) {
      body.push(seg("N1", out.n1ShipTo, shipTo.name ?? "", shipTo.idQual, shipTo.id));
    } else {
      body.push(seg("N1", out.n1ShipTo, shipTo.name ?? ""));
    }
    if (shipTo.address !== undefined) {
      const a = shipTo.address;
      body.push(seg("N3", a.line1, ...(a.line2 !== undefined ? [a.line2] : [undefined])));
      body.push(seg("N4", a.city, a.region, a.postal, ...(a.country !== "" ? [a.country] : [undefined])));
    }
  }
  body.push(seg("G62", "11", date));
  for (const p of ship.packages) {
    body.push(seg("MAN", "GM", p.sscc));
  }
  if (ship.bol !== "") {
    body.push(seg("N9", "BM", ship.bol));
  }
  let lx = 0;
  for (const it of ship.items) {
    lx += 1;
    body.push(seg("LX", String(lx)));
    body.push(seg("W12", String(it.origQty), String(it.shipQty), it.uom, out.lineIdQual, it.sku));
  }
  if (ship.weightG > 0) {
    body.push(seg("W03", String(ship.totalUnits), "KG", String(ship.weightG)));
  } else {
    body.push(seg("W03", String(ship.totalUnits)));
  }
  const tx = buildTx("945", body, txnCtl(ctl.txn));
  const envelope = interchange("945", profile, out, date, time, ctl, [tx]);
  return { doc: "945", bytes: encodeX12(envelope), envelope, controls: ctl };
}

/* ---------- the 856 ---------- */

export function produceNotice(
  ship: CanonShipment,
  orders: readonly CanonOrder[],
  profile: Profile,
  ctl: ControlData,
): OutboundDoc {
  if (profile.out === undefined) {
    throw new Error(`outbound: ${profile.key} ships nothing (no out map)`);
  }
  const out = profile.out;
  if (ship.items.length === 0) {
    throw new Error(`outbound: shipment ${ship.ref} carries no items`);
  }
  const date = civilDate(ship.dateSec);
  const time = civilTime(ship.dateSec);

  const body: Segment[] = [];
  body.push(seg("BSN", "00", ship.ref, date, time));
  body.push(seg("DTM", "011", date));
  body.push(seg("HL", "1", undefined, "S", "1"));
  if (ship.bol !== "") {
    body.push(seg("REF", "BM", ship.bol));
  }
  let hl = 1;
  for (const orderRef of new Set(ship.items.map((it) => it.orderRef))) {
    const order = orders.find((o) => o.ref === orderRef);
    if (order === undefined) {
      throw new Error(`outbound: shipment cites order ${JSON.stringify(orderRef)} which no canonical order carries`);
    }
    hl += 1;
    const orderHl = hl;
    body.push(seg("HL", String(orderHl), "1", "O", "1"));
    if (order.refs.po !== "") {
      body.push(seg("PRF", order.refs.po));
    }
    for (const it of ship.items.filter((x) => x.orderRef === orderRef)) {
      hl += 1;
      body.push(seg("HL", String(hl), String(orderHl), "I", "0"));
      body.push(seg("LIN", "", out.lineIdQual, it.sku));
      body.push(seg("SN1", String(it.shipQty), it.uom));
    }
  }
  const tx = buildTx("856", body, txnCtl(ctl.txn));
  const envelope = interchange("856", profile, out, date, time, ctl, [tx]);
  return { doc: "856", bytes: encodeX12(envelope), envelope, controls: ctl };
}
