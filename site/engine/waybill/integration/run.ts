/* ============================================================
   run — the integration bring-up: waybill's adapters against
   the REAL Go yard, sibling repo `switchyard`, on the wire.

   The script tells the unit 03 story end to end:

   1. spawns `go run ./cmd/switchyard -data-dir <scratch>`;
   2. waits for the port to accept (cold build included);
   3. opens one spur session wrapped in a LiveYard;
   4. receives the two partner 940s through the adapter door —
      canonical orders ride `orders`, every refusal rides the
      DLQ `waybill-dead` — and prints the refusal's reason;
   5. proves the replay: a live consumer attaches on `orders`
      and reads the journal's stream window from the start —
      the bytes it collects decode to the same canonical
      orders the adapter published (row for row);
   6. mints the shipment paperwork — the 945 advice and the
      856 notice — with the control numbers reserved as KV on
      `waybill-pace`, then re-reads them through the yard's
      own KV and parses them back;
   7. prints the honest stat sheet, says goodbye, kills the
      yard, removes the scratch dir.

   Nothing here carries timestamps in DATA; the wall clock
   appears only as elapsed ms.
   ============================================================ */

import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCanon, encodeCanon, type CanonOrder } from "../src/canon.ts";
import { decodeControls, isa13, reserve, txnCtl } from "../src/cntrl.ts";
import { LANES, decodeDespatchRow, despatchRowOf, deadSubject, orderSubject } from "../src/lane.ts";
import { LiveYard } from "../src/liveyard.ts";
import { receive } from "../src/inbound.ts";
import { produceAdvice, produceNotice } from "../src/outbound.ts";
import { ALDERLINE, KELRICK } from "../src/partners.ts";
import { Spur } from "../src/spur.ts";
import {
  ALDERLINE_940,
  KELRICK_940,
  UNKNOWN_940,
  ALDERLINE_SHIPMENT,
  encodeText,
} from "../fixtures/documents.ts";
import { parseX12 } from "../src/x12.ts";

const SIBLING = "D:/Projects/Default Project/switchyard";

/** the OS names a free listen spec: bind on 0, read it, close. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const port = typeof a === "object" && a !== null ? a.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

const PORT = parseInt(process.env.WAYBILL_INT_PORT ?? "", 10) || (await freePort());

function waitPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const once = (): void => {
      const s = createConnection({ host: "127.0.0.1", port });
      s.once("connect", () => {
        s.destroy();
        resolve();
      });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`run: ${port} never accepted within ${timeoutMs}ms`));
          return;
        }
        setTimeout(once, 300);
      });
    };
    once();
  });
}

function killTree(child: ChildProcess): void {
  // `go run` runs the server as a grandchild; on Windows the
  // terminate-the-tree ritual is the only honest kill.
  if (process.platform === "win32" && child.pid !== undefined) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

/* ============================================================ */

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "waybill-int-"));
  console.log(`yard: go run ./cmd/switchyard -data-dir ${dir} -addr 127.0.0.1:${PORT}`);
  const child = spawn(
    "go",
    ["run", "./cmd/switchyard", "-data-dir", dir, "-addr", `127.0.0.1:${PORT}`],
    { cwd: SIBLING, stdio: ["ignore", "inherit", "inherit"] },
  );
  let spur: InstanceType<typeof Spur> | null = null;
  try {
    await waitPort(PORT, 120_000);
    spur = new Spur("127.0.0.1", PORT, {
      name: "waybill-int",
      label: "ts-waybill",
    });
    const welcome = await spur.open();
    console.log(`hello: ${welcome.serverLabel} (max body ${welcome.maxBody})`);

    const yard = new LiveYard(spur);
    for (const lane of [LANES.orders, LANES.dead, LANES.pace]) {
      await yard.ensure(lane);
    }

    /* ---------- the adapter door: two partner 940s + a stranger ---------- */

    const files = [
      { name: "AHL-940-0001", doc: ALDERLINE_940 },
      { name: "KLK-940-0001", doc: KELRICK_940 },
      { name: "UNK-940-0001", doc: UNKNOWN_940 },
    ];
    const canonicals: CanonOrder[] = [];
    let refusals = 0;
    const tRecv = performance.now();
    for (const f of files) {
      const out = receive({ name: f.name, bytes: encodeText(f.doc) });
      for (const o of out.orders) {
        canonicals.push(o);
        const despatch = o.partner === "kelrick" ? KELRICK.despatch : ALDERLINE.despatch;
        await yard.publish(
          LANES.orders,
          orderSubject(o.ref),
          despatchRowOf(o, despatch.cls, despatch.slaSec),
        );
      }
      for (const r of out.refusals) {
        refusals += 1;
        await yard.publish(LANES.dead, deadSubject(r.code, r.docName), encodeCanon(r));
        console.log(`  refused ${r.docName}: ${r.code} at ${r.at} — ${r.detail}`);
      }
    }
    const recvMs = Math.round(performance.now() - tRecv);

    /* ---------- the replay proof: a live consumer reads the journal ---------- */

    const tWalk = performance.now();
    const readBack = await yard.rows(LANES.orders);
    const walkMs = Math.round(performance.now() - tWalk);
    const replayed = readBack.map((r) => decodeDespatchRow(r.payload));
    const replayOk =
      replayed.length === canonicals.length &&
      replayed.every(
        (row, i) =>
          row.ref === canonicals[i].ref &&
          row.lines.length === canonicals[i].lines.length &&
          row.lines.every((l, j) => l.sku === canonicals[i].lines[j].sku && l.qty === canonicals[i].lines[j].qty),
      );
    console.log(
      `replay: ${readBack.length} stream rows redelivered, ${replayOk ? "every row decodes to its canonical order" : "MISMATCH"},
       acks floor advanced`,
    );

    /* ---------- the counters live in the yard's own KV ---------- */

    const pace = LANES.pace;
    const c945 = await reserve(yard, pace, "alderline", "945");
    const shipmentRound = decodeCanon(encodeCanon(ALDERLINE_SHIPMENT)); // round the spine once
    if (shipmentRound.kind !== "shipment") {
      throw new Error(`the shipment round left the spine (${shipmentRound.kind})`);
    }
    const shipment = shipmentRound;
    const tMint = performance.now();
    const advice = produceAdvice(shipment, canonicals.filter((o) => o.partner === "alderline"), ALDERLINE, c945);
    const c856 = await reserve(yard, pace, "alderline", "856");
    const notice = produceNotice(shipment, canonicals.filter((o) => o.partner === "alderline"), ALDERLINE, c856);
    const mintMs = Math.round(performance.now() - tMint);

    // the minted bytes re-parse; the counters re-read from the yard's KV
    const reparsed945 = parseX12(advice.bytes);
    const reparsed856 = parseX12(notice.bytes);
    const kv945 = await yard.kvGet(pace, `cntrl.alderline.945`);
    const kv856 = await yard.kvGet(pace, `cntrl.alderline.856`);
    const controlsOk =
      decodeControls(kv945.payload).isa === c945.isa &&
      decodeControls(kv856.payload).isa === c856.isa;

    /* ---------- the honest stat sheet ---------- */

    const orders = await yard.rows(LANES.orders);
    const dead = await yard.rows(LANES.dead);
    const orderLane = await spur.laneInfo(LANES.orders);
    const deadLane = await spur.laneInfo(LANES.dead);
    const paceLane = await spur.laneInfo(pace);
    const keys = await yard.keys(pace);

    console.log("── the stat sheet ─────────────────────────────");
    console.log(`documents received   ${files.length} (adapter ${recvMs}ms)`);
    console.log(`canonical orders     ${canonicals.length} — ${canonicals.map((o) => `${o.ref} (${o.partner})`).join(", ")}`);
    console.log(`refusals to the DLQ  ${refusals}`);
    console.log(`tickets staged       ${orders.length} rows (walk ${walkMs}ms)`);
    console.log(`945 minted           SE01 ${reparsed945.groups[0].txs[0].se[0]}, ISA13 ${isa13(c945.isa)}, ST02 ${txnCtl(c945.txn)} (mint ${mintMs}ms)`);
    console.log(`856 minted           SE01 ${reparsed856.groups[0].txs[0].se[0]}, ISA13 ${isa13(c856.isa)}, ST02 ${txnCtl(c856.txn)}`);
    console.log(`counters re-read     ${controlsOk ? "945 and 856 agree with the reservations" : "MISMATCH"}`);
    console.log(`pace keys            ${keys.join(", ")}`);
    console.log(`lane seq             orders ${orderLane.seq} / dead ${deadLane.seq} / pace ${paceLane.seq}`);
    console.log(`dead-lane rows       ${dead.length}`);
    console.log("───────────────────────────────────────────────");

    // the canonical bytes themselves, once, for the record
    for (const o of canonicals) {
      const text = new TextDecoder().decode(encodeCanon(o));
      console.log(`  ${o.ref}: ${text.slice(0, 96)}…`);
    }

    await spur.bye();
  } finally {
    try {
      if (spur) await spur.bye();
    } catch {
      // the yard may already be gone; the kill is the truth
    }
    killTree(child);
    await waitExit(child);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // the journal dir rashly claimed by a dying yard: its file locks
      // release shortly after; the temp dir is the OS's to sweep.
    }
  }
}

main().then(
  () => process.exitCode = 0,
  (err) => {
    console.error("run failed:", err);
    process.exitCode = 1;
  },
);
