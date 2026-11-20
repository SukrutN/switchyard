/* ============================================================
   run — the integration bring-up: the orchestrator against the
   REAL Go yard, sibling repo `switchyard`, on the wire.

   The script:
   1. spawns `go run ./cmd/switchyard -data-dir <scratch>` (the
      journal needs a home; lanes stay off without one);
   2. waits for 127.0.0.1:4780 to accept (cold build included);
   3. opens one spur session, wraps it in a LiveYard, attaches
      four inline-acking zone crews, boots the WES;
   4. stages ~300 synthetic orders onto the orders lane (the
      average day re-stamped across waves), runs the shift;
   5. prints the honest stat sheet — staged, freezes, batches,
      quarantines, work rows per zone, the board's watermark —
      then says goodbye, kills the yard, and removes the
      scratch dir. Nothing here has timestamps in DATA; wall
      clock appears only as elapsed ms.

   Run: npm run run:wes
   ============================================================ */

import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spur } from "../src/spur.ts";
import { LiveYard } from "../src/liveyard.ts";
import { DespatchWes } from "../src/wes.ts";
import { SLOTTING, dayByKey } from "../../despatch-engine/fixtures/dc.ts";
import { SLA_BY_CLASS } from "../../despatch-engine/index.ts";
import type { DespatchOrder } from "../../despatch-engine/index.ts";
import { decodeBoardRow, encodeOrderRow } from "../src/records.ts";
import { workLane } from "../src/yard.ts";

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

/** the yard's port: $WES_INT_PORT if set, else a free port the OS
    names — two bring-ups must never fight over 4780 (a stuck `go
    run` child from an earlier shell owns a port forever). */
const PORT = parseInt(process.env.WES_INT_PORT ?? "", 10) || (await freePort());

const day = dayByKey("average-day");

/** the average day, re-stamped across waves up to n — the same
    synthetic shape the bench uses. */
function synthOrders(n: number): DespatchOrder[] {
  const base = day.orders;
  const out: DespatchOrder[] = [];
  for (let i = 0; i < n; i++) {
    const o = base[i % base.length];
    const wave = Math.floor(i / base.length);
    const arrival = o.arrivalSec + wave * day.horizonSec;
    out.push({
      id: `IT-${String(i + 1).padStart(4, "0")}`,
      arrivalSec: arrival,
      lines: o.lines,
      cls: o.cls,
      dueSec: arrival + SLA_BY_CLASS[o.cls],
    });
  }
  return out;
}

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
  const dir = mkdtempSync(join(tmpdir(), "wes-int-"));
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
      name: "wes-int",
      label: "ts-wes",
      keepAliveMs: 5000,
    });
    const welcome = await spur.open();
    console.log(`hello: ${welcome.serverLabel} (max body ${welcome.maxBody})`);

    const yard = new LiveYard(spur);
    // the crews' lanes first (§2.8: a repeat STREAM_CREATE is fine)
    for (let z = 0; z < 4; z++) {
      await yard.ensureLane(workLane(z));
    }
    for (let z = 0; z < 4; z++) {
      const lane = workLane(z);
      const crew = `crew-z${z + 1}`;
      await yard.attachConsumer(lane, crew, (d) => {
        void yard.ackRow(lane, crew, d.seq);
      });
    }

    const wes = new DespatchWes(yard, SLOTTING, {
      windowSec: 90,
      zoneCount: 4,
      pickersPerZone: day.profile.pickersPerZone,
      horizonSec: day.horizonSec,
    });
    await wes.boot();

    const orders = synthOrders(300);
    const t0 = performance.now();
    for (const o of orders) {
      await yard.publishRow(
        "orders",
        `orders.${o.id}.paid`,
        encodeOrderRow({
          kind: "order",
          ref: o.id,
          cls: o.cls,
          dueSec: o.dueSec,
          arrivalSec: o.arrivalSec,
          lines: o.lines,
        }),
      );
    }
    const stageMs = Math.round(performance.now() - t0);
    const stats = await wes.finalize(day.horizonSec);
    const runMs = Math.round(performance.now() - t0) - stageMs;

    // the honest stat sheet
    const board = await yard.kvGet("despatch-pace", "board");
    const b = decodeBoardRow(board.payload);
    console.log("── the stat sheet ─────────────────────────────");
    console.log(`orders staged        ${stats.ordersIn} (staging ${stageMs}ms, shift ${runMs}ms)`);
    console.log(`freezes / batches    ${stats.freezes.length} / ${stats.batches}`);
    console.log(`quarantines          ${stats.quarantined.length}`);
    console.log(`held / resolved      ${stats.held} / ${stats.holdsResolved}`);
    for (let z = 0; z < 4; z++) {
      console.log(
        `  work-z${z + 1} rows         ${stats.work.filter((x) => x.lane === workLane(z)).length}`,
      );
    }
    console.log(`board through / seq  ${b.releasedThrough} / ${b.freezeSeq}`);
    console.log("───────────────────────────────────────────────");

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
