/* ============================================================
   wes — the despatch orchestrator, riding the yard.

   Sheet 02's contract, wired end to end:

   · the order lane in: consumer `despatch-batch` on `orders`
     (filter `orders.>`), deliveries in the lane's gapless order,
     deduped by seq — at-least-once redelivery is the wire's
     promise; idempotence is the cooperant's;
   · the freeze law of sheet 01, in its streaming form: the
     window re-arms as the previous closes, the freeze batches
     everything already landed, a dry pool re-arms from the next
     arrival (batchOnline's loop, driven by journaled arrivals
     instead of a day-order array);
   · per-freeze release: the sheet-01 law (EDD by tightest due,
     picker-seconds affordability accrued from shift start, the
     honesty pass per zone) applied INCREMENTALLY — the crew's
     `given` carries across freezes, and past decisions are
     journaled facts that never re-draw;
   · work items out: one row per batch on its zone's lane
     `work-z{n}`, its release receipt one row on
     `despatch-release` — the decision ledger;
   · quarantine as DLQ: unknown SKU (UNMAPPED_SKU) and lines
     beyond one cart (OVERSIZED) refuse on
     `despatch-quarantine` with reason codes; the control lane
     `despatch-control` carries the reassign path — an operator
     row fixes the mapping (journaled in the pace lane's KV), a
     resolved row lands in the same ledger, and the order rides
     the next window;
   · backpressure: a batch whose zone lane holds more delivered-
     unacked rows than `pendingCap` HOLDS — a `held` receipt
     rides the ledger, the work row waits, a hold in the pace
     lane's KV survives restart (with the full work content), and
     probes resolve at each pass. Nothing is dropped; the curve
     stretches;
   · the board (KV `board` on `despatch-pace`): the watermark
     `releasedThrough`, the freeze counter, the armed window,
     and each zone's cumulative craft — the crash envelope. A
     resumed WES replays from the consumer's floor, skips ≤ the
     watermark, rebuilds holds from KV, and converges to the
     journals the single pass wrote. Duplicates after a crash
     between publish and watermark are honest: same batch ids
     re-land, consumers dedupe by id.

   Determinism law: every control decision is a pure function of
   journaled bytes — the order rows, the KV board, the KV hold
   markers. No wall-clock, no random, no outside input.
   ============================================================ */

import {
  CART_LINES,
  CRAFT_OVERHEAD_SEC,
  LINES_PER_PICKER_HOUR,
  batchOffline,
  zoneCaps,
} from "../../despatch-engine/index.ts";
import { pad } from "../../despatch-engine/src/batch.ts";
import type {
  Batch,
  DespatchOrder,
  PickPos,
  Slotting,
  ZoneCap,
} from "../../despatch-engine/index.ts";
import {
  decodeBoardRow,
  decodeHoldRow,
  decodeOrderRow,
  decodeQuarantineRow,
  decodeReassignRow,
  decodeSkuMapRow,
  encodeBoardRow,
  encodeHoldRow,
  encodeQuarantineRow,
  encodeReceiptRow,
  encodeSkuMapRow,
  encodeWorkRow,
  holdKey,
  quarantineSubject,
  releaseSubject,
} from "./records.ts";
import type {
  OrderRow,
  QuarantineRow,
  ReasonCode,
  ReceiptRow,
} from "./records.ts";
import type {
  LaneDelivery,
  LaneStateLite,
  WesYard,
} from "./yard.ts";
import {
  NAME,
  workLane,
  workSubject,
} from "./yard.ts";
import {
  SEAM,
  orderGate,
  quayBytes,
  seamSubject,
  tourBytes,
  verdictBytes,
  windowBytes,
  windowCall,
} from "./seams.ts";

/* ============================================================
   knobs — the sheet's stated settings, named so the site and the
   tests quote the same law the engine runs.
   ============================================================ */

export interface WesOptions {
  /** the on-line window (sheet 01's sweep: 45/90/150/240/360/720) */
  readonly windowSec: number;
  /** zones on the floor (Bramble: 12 aisles / 3 = 4) */
  readonly zoneCount: number;
  /** pickers per zone (1 on the average day, 2 in December) */
  readonly pickersPerZone: number;
  /** shift length in seconds (the worked day's horizon) */
  readonly horizonSec: number;
  /** the board's pacing grid (default: the engine's minute) */
  readonly binSec?: number;
  /** shift anchor (0) */
  readonly startSec?: number;
  /** work-lane depth a zone absorbs before a hold engages */
  readonly pendingCap?: number;
  /** unpaced = everything leaves at publish (the counterfactual) */
  readonly paced?: boolean;
  /** zones that should hesitate instead of taking a window */
  readonly busyZones?: readonly { zone: number; fromSec: number; toSec: number }[];
}

export interface FreezeRec {
  readonly n: number;
  readonly freezeSec: number;
  readonly batchIds: readonly string[];
  readonly orderIds: readonly string[];
  readonly lines: number;
}

export interface WorkRec {
  readonly batch: string;
  readonly lane: string;
  readonly releaseSec: number;
  readonly effectiveSec: number;
}

export interface WesStats {
  readonly ordersIn: number;
  readonly batches: number;
  readonly freezes: readonly FreezeRec[];
  readonly receipts: readonly ReceiptRow[];
  readonly held: number;
  readonly holdsResolved: number;
  readonly quarantined: readonly QuarantineRow[];
  readonly work: readonly WorkRec[];
  readonly controls: number;
  readonly throughSeq: number;
  readonly eventClock: number;
}

interface Pooled {
  readonly order: DespatchOrder;
  readonly seq: number;
}

/** the full content of a held batch — the re-published work row's
    provenance, whether from memory or from a resumed KV read. */
interface HeldBatch {
  batch: string;
  window: number;
  zone: number;
  plannedSec: number;
  lines: number;
  orders: string[];
  stops: { sku: string; aisle: number; bay: number; qty: number }[];
  tourSec: number;
  craftSec: number;
  dueSec: number;
}

/** the fault injections the resume test drives — the honest way to
    re-run what a crash does without stopping a real process. */
export interface WesFaults {
  /** skip the next board commit once: the dirty crash window between
      published work rows and the persisted watermark. */
  skipBoardOnce?: boolean;
}

const K_BOARD = "board";
const K_SKU_MAP = "sku-map";
const K_HOLD_PREFIX = "hold.";

export class DespatchWes {
  readonly yard: WesYard;
  readonly opts: Required<WesOptions>;
  readonly baseSlotting: Slotting;
  readonly caps: readonly ZoneCap[];

  /** the operator's SKUs fixed this run — KV-backed, so a resumed
      orchestrator re-reads them from the pace lane's journal. */
  private fixes = new Map<string, PickPos>();

  /** the crew's cumulative craft seconds per zone (release.ts's
      `given`, carried across freezes and across crashes) */
  private given: number[];

  private freezeSeq = 0;
  private nextFreeze = 0;
  private armed = false;
  private throughSeq = 0;
  private eventClock = 0;

  private pool: Pooled[] = [];
  private parked: Pooled[] = []; // quarantined this window; acks ride the freeze
  private admitted = new Set<number>();
  private admittedCtl = new Set<number>();

  private holds = new Map<string, HeldBatch>();
  private holdCount = 0;
  private holdResolvedCount = 0;

  private orderInbox: LaneDelivery[] = [];
  private controlInbox: LaneDelivery[] = [];
  private statsOrders = 0;
  private statsControls = 0;
  private freezeRecs: FreezeRec[] = [];
  private receiptRecs: ReceiptRow[] = [];
  private quarantineRecs: QuarantineRow[] = [];
  private workRecs: WorkRec[] = [];

  private bootDone = false;
  private boardSkipArmed = false;

  /** the settled plan decisions per zone — the honesty ledger the
      incremental pass walks (frozen entries contribute, never move). */
  private zoneLedger = new Map<number, DecidedJob[]>();

  constructor(yard: WesYard, baseSlotting: Slotting, opts: WesOptions) {
    this.yard = yard;
    this.baseSlotting = baseSlotting;
    this.opts = {
      binSec: 60,
      startSec: 0,
      pendingCap: 8,
      paced: true,
      ...opts,
      busyZones: opts.busyZones ?? [],
    };
    this.caps = zoneCaps(opts.zoneCount, opts.pickersPerZone);
    this.given = new Array(opts.zoneCount).fill(0);
  }

  /** inject the crash-window fault: the NEXT board commit is skipped
      along with its acks — the process died mid-freeze. */
  fault(f: WesFaults): void {
    if (f.skipBoardOnce) this.boardSkipArmed = true;
  }

  /* ============================================================
     boot: lanes, board, sku-map, holds, consumers
     ============================================================ */

  async boot(): Promise<void> {
    if (this.bootDone) throw new Error("wes: already booted");
    await this.yard.ensureLane(NAME.orders);
    await this.yard.ensureLane(NAME.release);
    await this.yard.ensureLane(NAME.quarantine);
    await this.yard.ensureLane(NAME.control);
    await this.yard.ensureLane(NAME.pace);
    for (let z = 0; z < this.opts.zoneCount; z++) {
      await this.yard.ensureLane(workLane(z));
    }
    await this.yard.ensureLane(SEAM.quay);
    await this.yard.ensureLane(SEAM.northspan);
    await this.yard.ensureLane(SEAM.hearth);
    await this.yard.ensureLane(SEAM.fluxline);

    // the board — chapter one of crash recovery
    const board = await this.yard.kvGet(NAME.pace, K_BOARD);
    if (board.found) {
      const row = decodeBoardRow(board.payload);
      this.throughSeq = row.releasedThrough;
      this.freezeSeq = row.freezeSeq;
      this.given = [...row.given];
      if (row.nextFreeze > 0) {
        this.nextFreeze = row.nextFreeze;
        this.armed = true;
      }
    }

    // the operator's mapping fixes — chapter two
    const fixes = await this.yard.kvGet(NAME.pace, K_SKU_MAP);
    if (fixes.found) {
      for (const f of decodeSkuMapRow(fixes.payload).fixes) {
        this.fixes.set(f.sku, { aisle: f.aisle, bay: f.bay });
      }
    }

    // holds — chapter three
    for (const key of await this.yard.kvKeys(NAME.pace)) {
      if (!key.startsWith(K_HOLD_PREFIX)) continue;
      const v = await this.yard.kvGet(NAME.pace, key);
      if (!v.found) continue;
      const h = decodeHoldRow(v.payload);
      this.holds.set(h.batch, {
        batch: h.batch,
        window: h.window,
        zone: h.zone,
        plannedSec: h.plannedSec,
        lines: h.work.lines,
        orders: [...h.work.orders],
        stops: h.work.stops.map((s) => ({ ...s })),
        tourSec: h.work.tourSec,
        craftSec: h.work.craftSec,
        dueSec: h.work.dueSec,
      });
    }

    await this.yard.attachConsumer(
      NAME.orders,
      NAME.batcher,
      (d) => this.orderInbox.push(d),
      { filter: "orders.>" },
    );
    await this.yard.attachConsumer(
      NAME.control,
      NAME.controller,
      (d) => this.controlInbox.push(d),
    );
    this.bootDone = true;
  }

  /* ============================================================
     the run loop — pull the inboxes in sequence order; then the
     day's close, then the holds.
     ============================================================ */

  /** one quiescent step: controls first (operator intent), then orders
      currently in the inbox, then hold probes. Call again as more
      deliveries land; the resume test drives it to shape crash points. */
  async step(): Promise<void> {
    while (this.controlInbox.length > 0) {
      const d = this.controlInbox.shift()!;
      await this.onControl(d);
    }
    while (this.orderInbox.length > 0) {
      // take the inbox in the ENGINE's order — arrivalSec, ties by id.
      // Same-arrival twin orders otherwise fire the freeze in lane
      // order, and a boundary-straddling tie could land the wrong twin
      // in the window. The batchOffline set is stable under re-sorts,
      // but the freeze trigger is not: sort it once, the same way.
      const ranked = this.orderInbox
        .map((d) => ({ d, o: asOrder(decodeOrderRow(d.payload)) }))
        .sort(
          (a, b) =>
            a.o.arrivalSec - b.o.arrivalSec ||
            (a.o.id < b.o.id ? -1 : a.o.id > b.o.id ? 1 : 0),
        );
      const head = ranked[0];
      this.orderInbox = this.orderInbox.filter((x) => x !== head.d);
      await this.onOrder(head.d, head.o);
    }
    await this.resolveHolds(this.eventClock);
  }

  /** full shift: one step, then the day-end freezes (the engine drains
      pending at the armed schedule), then the holds. */
  async finalize(endSec?: number): Promise<WesStats> {
    if (!this.bootDone) await this.boot();
    await this.step();
    while (this.armed && this.pool.length > 0) {
      await this.doFreeze(this.nextFreeze);
    }
    for (const p of this.parked) {
      // a poison-only window keeps its parked acks for this point —
      // the quarantine row and its marker are already durable bytes.
      if (p.seq >= 1) await this.yard.ackRow(NAME.orders, NAME.batcher, p.seq);
    }
    this.parked = [];
    await this.resolveHolds(endSec ?? this.eventClock);
    return this.stats();
  }

  /* ---------- the order lane ---------- */

  private async onOrder(d: LaneDelivery, pre: DespatchOrder): Promise<void> {
    const seq = d.seq;
    // the watermark chapter: deliveries the board covered are acked
    // where they stand — their consequences are durable bytes already.
    if (seq <= this.throughSeq) {
      await this.yard.ackRow(NAME.orders, NAME.batcher, seq);
      return;
    }
    // per-run dup guard (sweeps, mid-run redeliveries): one admission
    if (this.admitted.has(seq)) return;
    this.admitted.add(seq);
    this.statsOrders += 1;

    const order = pre;
    this.eventClock = Math.max(this.eventClock, order.arrivalSec);

    // ---- the exception path: refuse the poisons before batching
    const reason = poisonOf(order, this.slotting);
    if (reason !== null) {
      await this.admitQuarantine(order, reason, seq);
      return;
    }

    // ---- the streaming freeze law (batchOnline's loop in event time)
    if (!this.armed) {
      this.nextFreeze = order.arrivalSec + this.opts.windowSec;
      this.armed = true;
    }
    while (this.armed && order.arrivalSec >= this.nextFreeze) {
      if (this.pool.length === 0) {
        // dry pool: no batch; the window re-arms from the next arrival
        this.nextFreeze = order.arrivalSec + this.opts.windowSec;
        break;
      }
      await this.doFreeze(this.nextFreeze);
    }
    this.pool.push({ order, seq });
  }

  private async admitQuarantine(order: DespatchOrder, reason: ReasonCode, seq: number): Promise<void> {
    const offending = firstForeignSku(order, this.baseSlotting);
    // idempotence: a redelivered admission must not journal twice
    const marker = `q.${order.id}.${reason}`;
    const seen = await this.yard.kvGet(NAME.pace, marker);
    if (!seen.found) {
      const row: QuarantineRow = {
        kind: "quarantine",
        reason,
        ref: order.id,
        sku: offending,
        status: "open",
        via: "",
      };
      await this.yard.publishRow(
        NAME.quarantine,
        quarantineSubject(reason, order.id),
        encodeQuarantineRow(row),
      );
      await this.yard.kvSet(NAME.pace, marker, encodeQuarantineRow(row));
      this.quarantineRecs.push(row);
    }
    // parked until the freeze: its ack rides the watermark chapter
    this.parked.push({ order, seq });
  }

  /* ---------- the control lane: the reassign path ---------- */

  private async onControl(d: LaneDelivery): Promise<void> {
    // per-run dup guard: a redelivered control row applies once
    if (this.admittedCtl.has(d.seq)) return;
    this.admittedCtl.add(d.seq);
    this.statsControls += 1;
    const row = decodeReassignRow(d.payload);

    // is this order actually quarantined? still parked here, or its
    // open marker is durable bytes from a past run. An operator row
    // about a healthy order never fiction-resolves a ledger.
    const parkedIdx = this.parked.findIndex((p) => p.order.id === row.ref);
    const marker = (await this.yard.kvKeys(NAME.pace)).find((k) =>
      k.startsWith(`q.${row.ref}.`),
    );
    const wasOpen = parkedIdx >= 0 || marker !== undefined;

    // the mapping fix lands as KV state whatever else happens — the
    // resumed orchestrator's chapter two. The operator's word is the
    // overlay: the fix wins for this sku in this run's slotting.
    const fixesNow = [...this.fixes.entries()].map(([sku, p]) => ({
      sku,
      aisle: p.aisle,
      bay: p.bay,
    }));
    if (!fixesNow.some((f) => f.sku === row.sku)) {
      fixesNow.push({ sku: row.sku, aisle: row.aisle, bay: row.bay });
    }
    this.fixes.set(row.sku, { aisle: row.aisle, bay: row.bay });
    await this.yard.kvSet(NAME.pace, K_SKU_MAP, encodeSkuMapRow({ kind: "sku-map", fixes: fixesNow }));

    if (!wasOpen) {
      await this.yard.ackRow(NAME.control, NAME.controller, d.seq);
      return;
    }

    const reason = (marker !== undefined
      ? (marker.slice(marker.lastIndexOf(".") + 1) as ReasonCode)
      : "UNMAPPED_SKU") as ReasonCode;
    const resolved: QuarantineRow = {
      kind: "quarantine",
      reason,
      ref: row.ref,
      sku: row.sku,
      status: "resolved",
      via: "reassign",
    };
    await this.yard.publishRow(
      NAME.quarantine,
      quarantineSubject(reason, `${row.ref}-resolved`),
      encodeQuarantineRow(resolved),
    );
    this.quarantineRecs.push(resolved);

    // the reassign path: the order re-mails itself into the pool —
    // the operator's row re-declared the order in full, so this works
    // whether the park is unacked (move the real entry, keep its seq)
    // or long acked (rebuild from the row, seq 0 — no orders-lane ack).
    const order: DespatchOrder = {
      id: row.ref,
      arrivalSec: row.arrivalSec,
      lines: row.lines.map((l) => ({ ...l })),
      cls: row.cls,
      dueSec: row.dueSec,
    };
    if (poisonOf(order, this.slotting) !== null) {
      // a reassigned cart still has to pass the poison test
      await this.admitQuarantine(order, poisonOf(order, this.slotting)!, 0);
    } else if (parkedIdx >= 0) {
      const [p] = this.parked.splice(parkedIdx, 1);
      this.pool.push(p);
    } else {
      this.pool.push({ order, seq: 0 });
    }
    await this.yard.ackRow(NAME.control, NAME.controller, d.seq);
  }

  /* ============================================================
     the freeze — sheet 01's batchOffline + the incremental release
     law; then the receipts, the work rows, the holds, the board.
     ============================================================ */

  private async doFreeze(freezeSec: number): Promise<void> {
    const visible = this.pool;
    this.pool = [];
    // the engine's pending order is arrivalSec then id (batchOnline);
    // ties by id keep `orderIds` byte-comparable with the pure run.
    const visibleOrders = visible
      .map((p) => p.order)
      .sort((a, b) => a.arrivalSec - b.arrivalSec || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // the batching law asserts itself (batchOffline, sheet 01 v0.1)
    this.freezeSeq += 1;
    const n = this.freezeSeq;
    const run = batchOffline(visibleOrders, this.slotting);
    const tagged = run.batches.map((b) => ({ ...b, id: `${b.id}/W${pad(n)}` }));

    this.freezeRecs.push({
      n,
      freezeSec,
      batchIds: tagged.map((b) => b.id),
      orderIds: visibleOrders.map((o) => o.id),
      lines: tagged.reduce((s, b) => s + b.lines, 0),
    });

    // the release law: EDD with the crew's affordability, then the
    // honesty pass — incremental, given carries, past never re-draws
    const jobs = tagged.map((b) => ({
      batch: b,
      publishSec: freezeSec,
      dueSec: dueOf(b, visibleOrders),
    }));
    const decisions = this.planIncrement(jobs);
    const byId = new Map(tagged.map((b) => [b.id, b]));

    for (const d of decisions) {
      const lane = workLane(d.zone);
      const depth = await zoneDepth(this.yard, lane);
      const stops = byId.get(d.batchId)!.stops.map((s) => ({
        sku: s.sku,
        aisle: s.pos.aisle,
        bay: s.pos.bay,
        qty: s.qty,
      }));
      const work = {
        batch: d.batchId,
        window: freezeSec,
        zone: d.zone,
        releaseSec: d.releaseSec,
        lines: d.lines,
        orders: [...d.orders],
        stops,
      };
      if (depth > this.opts.pendingCap) {
        // ---- the hold: backpressure honesty, never dropped work
        this.holdCount += 1;
        const heldRow: ReceiptRow = {
          kind: "receipt",
          batch: d.batchId,
          window: freezeSec,
          zone: d.zone,
          releaseSec: d.releaseSec,
          effectiveSec: 0,
          status: "held",
          orders: [...d.orders],
          lines: d.lines,
          tourSec: d.tourSec,
          craftSec: d.craftSec,
          dueSec: d.dueSec,
        };
        await this.yard.publishRow(NAME.release, releaseSubject(d.batchId), encodeReceiptRow(heldRow));
        this.receiptRecs.push(heldRow);
        this.holds.set(d.batchId, {
          batch: d.batchId,
          window: freezeSec,
          zone: d.zone,
          plannedSec: d.releaseSec,
          lines: d.lines,
          orders: [...d.orders],
          stops,
          tourSec: d.tourSec,
          craftSec: d.craftSec,
          dueSec: d.dueSec,
        });
        await this.yard.kvSet(
          NAME.pace,
          holdKey(d.batchId),
          encodeHoldRow({
            kind: "hold",
            batch: d.batchId,
            window: freezeSec,
            zone: d.zone,
            plannedSec: d.releaseSec,
            work: {
              lines: d.lines,
              orders: [...d.orders],
              stops,
              tourSec: d.tourSec,
              craftSec: d.craftSec,
              dueSec: d.dueSec,
            },
          }),
        );
        continue;
      }
      // ---- release now: work row, then the released receipt
      const effective = this.opts.paced ? d.releaseSec : Math.round(d.publishSec);
      await this.yard.publishRow(
        lane,
        workSubject(lane, d.batchId),
        encodeWorkRow({
          kind: "work",
          batch: work.batch,
          window: work.window,
          zone: work.zone,
          releaseSec: work.releaseSec,
          effectiveSec: effective,
          lines: work.lines,
          orders: work.orders,
          stops: work.stops,
        }),
      );
      await this.publishSeams({
        batch: work.batch,
        zone: work.zone,
        releaseSec: work.releaseSec,
        tourSec: d.tourSec,
        orders: work.orders,
        stops: work.stops,
      });
      const row: ReceiptRow = {
        kind: "receipt",
        batch: d.batchId,
        window: freezeSec,
        zone: d.zone,
        releaseSec: d.releaseSec,
        effectiveSec: effective,
        status: "released",
        orders: [...d.orders],
        lines: d.lines,
        tourSec: d.tourSec,
        craftSec: d.craftSec,
        dueSec: d.dueSec,
      };
      await this.yard.publishRow(NAME.release, releaseSubject(d.batchId), encodeReceiptRow(row));
      this.workRecs.push({ batch: d.batchId, lane, releaseSec: d.releaseSec, effectiveSec: effective });
      this.receiptRecs.push(row);
    }

    // ---- the board: the crash envelope commits BEFORE the acks.
    const maxSeq = Math.max(
      this.throughSeq,
      ...visible.map((p) => p.seq),
      ...this.parked.map((p) => p.seq),
    );
    if (this.boardSkipArmed) {
      // the dirty crash: work rows and receipts are journaled, the
      // watermark and acks are not — the resumed session replays this
      // freeze and re-lands the same batch ids. Honest duplication.
      this.boardSkipArmed = false;
    } else {
      await this.yard.kvSet(
        NAME.pace,
        K_BOARD,
        encodeBoardRow({
          kind: "board",
          releasedThrough: maxSeq,
          freezeSeq: this.freezeSeq,
          nextFreeze: this.armed ? freezeSec + this.opts.windowSec : 0,
          given: [...this.given],
        }),
      );
      this.throughSeq = maxSeq;
      for (const p of visible) {
        if (p.seq >= 1) await this.yard.ackRow(NAME.orders, NAME.batcher, p.seq);
      }
      for (const p of this.parked) {
        if (p.seq >= 1) await this.yard.ackRow(NAME.orders, NAME.batcher, p.seq);
      }
      this.parked = [];
      // re-arm (batchOnline's `freeze += windowSec`)
      this.nextFreeze = freezeSec + this.opts.windowSec;
    }
  }

  /* ============================================================
     the pacing law, incremental
     ============================================================ */

  /** release.ts's gate, carried across freezes: the same EDD key, the
      same affordability law, the same honesty pass — `given` carries,
      journaled decisions never re-draw. */
  private planIncrement(
    jobs: readonly { batch: Batch; publishSec: number; dueSec: number }[],
  ): DecidedJob[] {
    if (!this.opts.paced) {
      return jobs.map((j) => ({
        batchId: j.batch.id,
        publishSec: Math.round(j.publishSec),
        releaseSec: Math.round(j.publishSec),
        dueSec: Math.round(j.dueSec),
        zone: j.batch.zone,
        tourSec: Math.round(j.batch.ledger.tourSec * 1000) / 1000,
        craftSec: Math.round(j.batch.ledger.tourSec + CRAFT_OVERHEAD_SEC),
        lines: j.batch.lines,
        orders: [...j.batch.orders],
      }));
    }
    // EDD, ties by publish then batch id — the slack key A–Z
    const sorted = [...jobs].sort(
      (a, b) =>
        a.dueSec - b.dueSec ||
        a.publishSec - b.publishSec ||
        (a.batch.id < b.batch.id ? -1 : a.batch.id > b.batch.id ? 1 : 0),
    );
    const givenNow = new Map<number, number>();
    for (let z = 0; z < this.given.length; z++) givenNow.set(z, this.given[z]);

    const out: DecidedJob[] = [];
    for (const job of sorted) {
      const home = job.batch.zone;
      const craft = job.batch.ledger.tourSec + CRAFT_OVERHEAD_SEC;
      let t = Math.max(Math.ceil(job.publishSec), this.opts.startSec);
      for (;;) {
        const cap = this.caps.find((c) => c.zone === home)!;
        const pickers = cap.linesPerHour / LINES_PER_PICKER_HOUR;
        const affordable = pickers * (t - this.opts.startSec);
        if ((givenNow.get(home) ?? 0) + craft <= affordable + 1e-6) break;
        t += this.opts.binSec;
      }
      givenNow.set(home, (givenNow.get(home) ?? 0) + craft);
      out.push({
        batchId: job.batch.id,
        publishSec: Math.round(job.publishSec),
        releaseSec: Math.round(t),
        dueSec: Math.round(job.dueSec),
        zone: home,
        tourSec: Math.round(job.batch.ledger.tourSec * 1000) / 1000,
        craftSec: Math.round(craft),
        lines: job.batch.lines,
        orders: [...job.batch.orders],
      });
    }

    // the honesty pass, per zone, in release order over the zone's
    // full ledger; frozen entries contribute and never move —
    // they are journal bytes now.
    for (const cap of this.caps) {
      const pickers = cap.linesPerHour / LINES_PER_PICKER_HOUR;
      const newArrivals = out.filter((d) => d.zone === cap.zone);
      const events = [...(this.zoneLedger.get(cap.zone) ?? []), ...newArrivals].sort(
        (a, b) => a.releaseSec - b.releaseSec || (a.batchId < b.batchId ? -1 : 1),
      );
      let cum = 0;
      for (const e of events) {
        cum += e.craftSec;
        if (!newArrivals.includes(e)) continue; // frozen: never re-draws
        while (cum > pickers * (e.releaseSec - this.opts.startSec) + 1e-6) {
          e.releaseSec += this.opts.binSec;
        }
      }
      // the settled ledger grows: the next freeze's pass sees these
      const ledger = this.zoneLedger.get(cap.zone) ?? [];
      for (const e of newArrivals) {
        if (!ledger.includes(e)) ledger.push(e);
      }
      this.zoneLedger.set(cap.zone, ledger);
    }
    for (let z = 0; z < this.given.length; z++) {
      this.given[z] = givenNow.get(z) ?? 0;
    }
    return out.sort(
      (a, b) => a.releaseSec - b.releaseSec || (a.batchId < b.batchId ? -1 : 1),
    );
  }

  /* family lanes. The work row is unchanged. These four rows are
     the seam each engine can replace later. */
  private async publishSeams(row: {
    batch: string
    zone: number
    releaseSec: number
    tourSec: number
    orders: readonly string[]
    stops: readonly { sku: string; aisle: number; bay: number; qty: number }[]
  }): Promise<void> {
    const busy = this.opts.busyZones ?? []
    for (let i = 0; i < row.stops.length; i++) {
      await this.yard.publishRow(
        SEAM.quay,
        seamSubject(SEAM.quay, `${row.batch}.${i}`),
        quayBytes(row.batch, row.stops[i]),
      )
    }
    await this.yard.publishRow(
      SEAM.northspan,
      seamSubject(SEAM.northspan, row.batch),
      tourBytes(row.batch, row.zone, row.tourSec),
    )
    const call = windowCall(row.zone, row.releaseSec, busy)
    await this.yard.publishRow(
      SEAM.hearth,
      seamSubject(SEAM.hearth, row.batch),
      windowBytes(row.batch, row.zone, row.releaseSec, call.decision, call.reason),
    )
    for (const order of row.orders) {
      await this.yard.publishRow(
        SEAM.fluxline,
        seamSubject(SEAM.fluxline, `${row.batch}.${order}`),
        verdictBytes(row.batch, order, orderGate(order)),
      )
    }
  }

  /* ============================================================
     the holds: a zone with room lets its held batches out
     ============================================================ */

  private async resolveHolds(nowSec: number): Promise<void> {
    for (const batchId of [...this.holds.keys()].sort((a, b) =>
      (this.holds.get(a)!.plannedSec - this.holds.get(b)!.plannedSec) ||
      (a < b ? -1 : 1),
    )) {
      const h = this.holds.get(batchId)!;
      const lane = workLane(h.zone);
      const depth = await zoneDepth(this.yard, lane);
      if (depth > this.opts.pendingCap) continue;
      const effective = Math.max(h.plannedSec, nowSec);
      await this.yard.publishRow(
        lane,
        workSubject(lane, batchId),
        encodeWorkRow({
          kind: "work",
          batch: h.batch,
          window: h.window,
          zone: h.zone,
          releaseSec: h.plannedSec,
          effectiveSec: Math.round(effective),
          lines: h.lines,
          orders: h.orders,
          stops: h.stops,
        }),
      );
      await this.publishSeams({
        batch: h.batch,
        zone: h.zone,
        releaseSec: h.plannedSec,
        tourSec: h.tourSec,
        orders: h.orders,
        stops: h.stops,
      });
      const row: ReceiptRow = {
        kind: "receipt",
        batch: h.batch,
        window: h.window,
        zone: h.zone,
        releaseSec: h.plannedSec,
        effectiveSec: Math.round(effective),
        status: "released",
        orders: [...h.orders],
        lines: h.lines,
        tourSec: h.tourSec,
        craftSec: h.craftSec,
        dueSec: h.dueSec,
      };
      await this.yard.publishRow(NAME.release, releaseSubject(batchId), encodeReceiptRow(row));
      this.receiptRecs.push(row);
      this.workRecs.push({
        batch: batchId,
        lane,
        releaseSec: h.plannedSec,
        effectiveSec: Math.round(effective),
      });
      this.holds.delete(batchId);
      this.holdResolvedCount += 1;
      await this.yard.kvDelete(NAME.pace, holdKey(batchId));
    }
  }

  /* ============================================================
     readings
     ============================================================ */

  /** the effective slotting = the base + the operator's overlay. The
      fix wins for its sku: the operator's word is the floor's word. */
  get slotting(): Slotting {
    if (this.fixes.size === 0) return this.baseSlotting;
    const merged: Slotting = new Map(this.baseSlotting);
    for (const [sku, pos] of this.fixes) merged.set(sku, pos);
    return merged;
  }

  get freezeNumber(): number {
    return this.freezeSeq;
  }

  stats(): WesStats {
    return {
      ordersIn: this.statsOrders,
      batches: this.workRecs.length,
      freezes: this.freezeRecs,
      receipts: this.receiptRecs,
      held: this.holdCount,
      holdsResolved: this.holdResolvedCount,
      quarantined: this.quarantineRecs,
      work: this.workRecs,
      controls: this.statsControls,
      throughSeq: this.throughSeq,
      eventClock: this.eventClock,
    };
  }
}

interface DecidedJob {
  batchId: string;
  publishSec: number;
  releaseSec: number;
  dueSec: number;
  zone: number;
  tourSec: number;
  craftSec: number;
  lines: number;
  orders: readonly string[];
}

/* ---------- helpers ---------- */

/** the depth the shipped gauge reads: Σ consumers' pending on a lane. */
export async function zoneDepth(yard: WesYard, lane: string): Promise<number> {
  const state: LaneStateLite = await yard.laneState(lane);
  return state.pending;
}

/** tightest due in a batch — release.ts's buildJobList fact. */
function dueOf(b: Batch, orders: readonly DespatchOrder[]): number {
  const byId = new Map<string, DespatchOrder>(orders.map((o) => [o.id, o]));
  let due = Infinity;
  for (const id of b.orders) {
    const d = byId.get(id)?.dueSec;
    if (d !== undefined && d < due) due = d;
  }
  return due === Infinity ? 0 : due;
}

/** the poison test: null when the order rides; else the reason code. */
export function poisonOf(order: DespatchOrder, ref: Slotting): ReasonCode | null {
  for (const line of order.lines) {
    if (!ref.has(line.sku)) return "UNMAPPED_SKU";
  }
  const total = order.lines.reduce((s, l) => s + l.qty, 0);
  if (total > CART_LINES) return "OVERSIZED";
  return null;
}

/** the offending line's sku — the named culprit on the DLQ row. */
function firstForeignSku(order: DespatchOrder, ref: Slotting): string {
  for (const line of order.lines) {
    if (!ref.has(line.sku)) return line.sku;
  }
  return "";
}

/** the lane's canonical order row becomes the engine's order — the
    `ref` on the wire is the `id` in the batching law's hand. */
function asOrder(row: OrderRow): DespatchOrder {
  return {
    id: row.ref,
    arrivalSec: row.arrivalSec,
    lines: row.lines.map((l) => ({ ...l })),
    cls: row.cls,
    dueSec: row.dueSec,
  };
}
