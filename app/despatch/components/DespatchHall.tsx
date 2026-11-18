"use client";

import { useMemo, useState } from "react";
import {
  batchOnline,
  buildJobList,
  releasePlan,
  zoneCaps,
  CRAFT_OVERHEAD_SEC,
} from "@/engine/despatch-engine/index.ts";
import type {
  Batch,
  OnlineRun,
  ReleasePlan,
} from "@/engine/despatch-engine/index.ts";
import { WINDOW_SWEEP } from "@/engine/despatch-engine/index.ts";
import { CATALOG, SLOTTING, dayByKey } from "@/engine/despatch-engine/fixtures/dc.ts";
import DCPlan from "./DCPlan";
import { escTitle, tourPath } from "./plan";
import "./hall.css";

/* ============================================================
   DespatchHall, the board, run live in the reader's tab.

   Every switch re-calls the pure engine (batchOnline, releasePlan)
   the same way the characterization suite calls it, a window swap
   costs milliseconds, so the sweep is felt, not narrated. The one
   thing pre-baked is the tabu pass: its scan is quadratic by
   design, so it arrives here as a reported delta, not a demo stall.
   ============================================================ */

export interface DespatchHallProps {
  profiles: { key: string; short: string; sub: string }[];
  tabu: Record<
    string,
    { deltaSec: number; deltaPct: number; appliedMoves: number }
  >;
}

const fmtInt = (n: number): string =>
  n.toLocaleString("en-US", { maximumFractionDigits: 0 });

const fmtSec = (n: number): string =>
  Math.abs(n - Math.round(n)) < 1e-9
    ? fmtInt(n)
    : n.toLocaleString("en-US", { maximumFractionDigits: 1 });

function p90Of(waits: number[]): number {
  const s = [...waits].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] ?? 0;
}

export default function DespatchHall({ profiles, tabu }: DespatchHallProps) {
  const [profileKey, setProfileKey] = useState(profiles[0].key);
  const [wSec, setWSec] = useState<number>(90);
  const [sel, setSel] = useState(0);

  const day = useMemo(() => dayByKey(profileKey), [profileKey]);

  /* the whole window sweep for the current day, six pure calls */
  const sweeps = useMemo(
    () =>
      WINDOW_SWEEP.map((w) => ({
        w,
        run: batchOnline(day.orders, w, SLOTTING),
      })),
    [day],
  );
  const picked = sweeps.find((s) => s.w === wSec) ?? sweeps[0];
  const run: OnlineRun = picked.run;

  /* the release board for the picked window: unpaced vs paced */
  const board = useMemo(() => {
    const jobs = buildJobList(run.publishedBatches, day.orders, run.batchPublish);
    const caps = zoneCaps(4, day.profile.pickersPerZone);
    const opts = { startSec: 0, horizonSec: day.horizonSec, binSec: 60 };
    return {
      unpaced: releasePlan(jobs, caps, { ...opts, paced: false }),
      paced: releasePlan(jobs, caps, { ...opts, paced: true }),
    };
  }, [run, day]);

  const carts = run.publishedBatches;
  const selIx = Math.min(sel, Math.max(0, carts.length - 1));
  const batch: Batch | undefined = carts[selIx];

  const waits = Object.values(run.waitsSec);
  const meanWait = waits.length
    ? waits.reduce((s, x) => s + x, 0) / waits.length
    : 0;
  const p90Wait = p90Of(waits);
  const units = day.orders.reduce(
    (s, o) => s + o.lines.reduce((t, l) => t + l.qty, 0),
    0,
  );
  const tabuOf = tabu[profileKey];

  /* sweep chart geometry */
  const maxSaved = Math.max(...sweeps.map((s) => s.run.walksSaved), 0.0001);
  const maxLate = Math.max(...sweeps.map((s) => s.run.lateOrders.length), 1);

  /* release bar geometry */
  const peakMax = Math.max(
    board.unpaced.peakQueueCarts,
    board.paced.peakQueueCarts,
    1,
  );

  const pickProfile = (key: string) => {
    setProfileKey(key);
    setSel(0);
  };
  const pickWindow = (w: number) => {
    setWSec(w);
    setSel(0);
  };

  const batchFreezeIx = batch
    ? run.freezes.findIndex((f) => f.batchIds.includes(batch.id))
    : -1;

  return (
    <div className="dh">
      {/* ---------- the rail: worked days × freeze windows ---------- */}
      <div className="dh__rail">
        <div className="dh__tabs" role="tablist" aria-label="worked days">
          {profiles.map((p) => {
            const active = p.key === profileKey;
            return (
              <button
                key={p.key}
                role="tab"
                aria-selected={active}
                className={`dh__tab${active ? " dh__tab--on" : ""}`}
                onClick={() => pickProfile(p.key)}
              >
                <span className="dh__tab-name mono">{p.short}</span>
                <span className="dh__tab-sub mono">{p.sub}</span>
              </button>
            );
          })}
        </div>

        <div className="dh__wins" aria-label="freeze window">
          <span className="dh__wins-k mono">freeze w</span>
          {WINDOW_SWEEP.map((w) => (
            <button
              key={w}
              className={`dh__win mono${w === wSec ? " dh__win--on" : ""}`}
              aria-pressed={w === wSec}
              onClick={() => pickWindow(w)}
            >
              {w}s
            </button>
          ))}
        </div>
      </div>

      {/* ---------- stat strip ---------- */}
      <div className="dh__stats">
        <div className="dh__stat">
          <span className="dh__stat-k mono">stream</span>
          <span className="dh__stat-v display">{fmtInt(day.orders.length)}</span>
          <span className="dh__stat-s mono">
            orders · {fmtInt(units)} pick units ·{" "}
            {day.profile.pickersPerZone} picker
            {day.profile.pickersPerZone === 1 ? "" : "s"}/zone
          </span>
        </div>
        <div className="dh__stat">
          <span className="dh__stat-k mono">carts built</span>
          <span className="dh__stat-v display">{fmtInt(carts.length)}</span>
          <span className="dh__stat-s mono">
            {(day.orders.length / Math.max(1, carts.length)).toFixed(1)} orders
            per tour
          </span>
        </div>
        <div className="dh__stat">
          <span className="dh__stat-k mono">walks saved</span>
          <span className="dh__stat-v display dh__stat-v--signal">
            {(run.walksSaved * 100).toFixed(1)}%
          </span>
          <span className="dh__stat-s mono">
            vs first-come ·{" "}
            <span className="dh__stat-tabu">
              tabu −{fmtSec(tabuOf?.deltaSec ?? 0)}s
            </span>
          </span>
        </div>
        <div className="dh__stat">
          <span className="dh__stat-k mono">mean wait</span>
          <span className="dh__stat-v display">{fmtSec(meanWait)}s</span>
          <span className="dh__stat-s mono">
            window {wSec}s · p90 {fmtSec(p90Wait)}s
          </span>
        </div>
        <div className="dh__stat">
          <span className="dh__stat-k mono">late orders</span>
          <span
            className={`dh__stat-v display${
              run.lateOrders.length ? " dh__stat-v--signal" : ""
            }`}
          >
            {run.lateOrders.length ? fmtInt(run.lateOrders.length) : "none"}
          </span>
          <span className="dh__stat-s mono">
            {run.lateOrders.length
              ? `worst ${fmtSec(run.maxTardySec)}s past the promise`
              : "dues hold at this window"}
          </span>
        </div>
      </div>

      {/* ---------- floor + side ledgers ---------- */}
      <div className="dh__grid">
        <figure className="dh__fig">
          <figcaption className="dh__cap mono">
            <span>
              {profileKey} · freeze w={wSec}s
            </span>
            <span>
              batch {carts.length ? selIx + 1 : 0}/{carts.length}
            </span>
          </figcaption>

          <DCPlan
            className="dh__svg"
            catalog={CATALOG}
            tour={batch ? tourPath(batch.stops) : undefined}
            stops={batch?.stops}
            label={batch ? batch.id : undefined}
            tag="BRAMBLE & TWINE · 12 AISLES · Z1➝Z4"
          />

          <p className="dh__ledger-line mono">
            {batch ? (
              <>
                {batch.id} · Z{batch.zone + 1} cart · {batch.orders.length}{" "}
                order{batch.orders.length === 1 ? "" : "s"} ·{" "}
                {batch.lines} units · tour {fmtSec(batch.ledger.tourSec)}s = h{" "}
                {fmtSec(batch.ledger.horizontalSec)}s + v{" "}
                {fmtSec(batch.ledger.verticalSec)}s + {batch.stops.length} faces{" "}
                {fmtSec(batch.ledger.stopsSec)}s
              </>
            ) : (
              "no carts at this window"
            )}
          </p>
        </figure>

        <aside className="dh__side">
          {/* the batches the windows built */}
          <p className="dh__side-h mono">carts, pick one, read its tour</p>
          <ol className="dh__chips">
            {carts.map((b, i) => (
              <li key={b.id}>
                <button
                  className={`dh__chip mono${i === selIx ? " dh__chip--on" : ""}`}
                  onClick={() => setSel(i)}
                >
                  <span className="dh__chip-id">{b.id}</span>
                  <span className="dh__chip-meta">
                    Z{b.zone + 1} · {b.orders.length}or ·{" "}
                    {fmtSec(b.ledger.tourSec)}s
                  </span>
                </button>
              </li>
            ))}
          </ol>

          {/* the freeze ledger */}
          <p className="dh__side-h mono">freeze ledger, when the board let go</p>
          <ol className="dh__ledger">
            {run.freezes.map((f, i) => (
              <li
                key={f.freezeSec}
                className={
                  i === batchFreezeIx ? "dh__frow dh__frow--hit" : "dh__frow"
                }
              >
                <span className="dh__frow-w mono">
                  W{String(i + 1).padStart(3, "0")}
                </span>
                <span className="mono">t+{fmtInt(f.freezeSec)}s</span>
                <span className="mono">{f.batchIds.length} cart</span>
                <span className="mono">{f.orderIds.length} ord</span>
                <span className="mono">{f.lines} lin</span>
              </li>
            ))}
          </ol>
        </aside>
      </div>

      {/* ---------- release board + the sweep ---------- */}
      <div className="dh__lower">
        <div className="dh__release">
          <p className="dh__panel-h mono">
            release board, w={wSec}s ·{" "}
            {day.profile.pickersPerZone} picker
            {day.profile.pickersPerZone === 1 ? "" : "s"}/zone · EDD · craft =
            tour + {CRAFT_OVERHEAD_SEC}s
          </p>
          <div className="dh__plans">
            <ReleaseColumn
              title="unpaced"
              sub="everything leaves at its publish tick"
              plan={board.unpaced}
              peakMax={peakMax}
            />
            <ReleaseColumn
              title="paced"
              sub="EDD · a zone only spends minutes it owns"
              plan={board.paced}
              peakMax={peakMax}
            />
          </div>
          <p className="dh__release-note mono">
            {board.paced.breaches.length > 0 ? (
              <>
                pacing holds {board.unpaced.peakQueueCarts}➝
                {board.paced.peakQueueCarts} carts of peak queue on this day and
                signs for{" "}
                <span className="dh__sig">
                  {board.paced.breaches.length} releases
                </span>{" "}
                past due, the trade, on the record, not smoothed away, last
                release: t+{fmtInt(board.paced.lastReleaseSec)}s paced vs t+
                {fmtInt(board.unpaced.lastReleaseSec)}s unpaced.
              </>
            ) : (
              <>
                pacing holds the peak and{" "}
                <span className="dh__sig">breaches nothing</span> at this
                window, the dues survive the crew they were promised to.
              </>
            )}
          </p>
        </div>

        <div className="dh__sweep">
          <p className="dh__panel-h mono">
            the sweep, walks saved vs lateness across the windows
          </p>
          <SweepChart
            sweeps={sweeps}
            wSec={wSec}
            maxSaved={maxSaved}
            maxLate={maxLate}
            onPick={pickWindow}
          />
          <p className="dh__sweep-note mono">
            windows pool orders into tours: savings climb, waits grow, and the
            signal bars are the orders the promise lost, v0.2's tardiness is
            reported, never swept under.
          </p>
        </div>
      </div>

      <p className="dh__note mono">
        recomputed in this tab on every switch, batchOnline and releasePlan are
        pure, byte-stable calls, the same ones the characterization suite
        grades, the tabu pass is pre-baked per day: its scan is quadratic, and{" "}
        {tabuOf
          ? `${fmtInt(tabuOf.appliedMoves)} moves were applied off-line.`
          : "no moves were applied off-line."}
      </p>
    </div>
  );
}

/* ---------- one release column (unpaced | paced) ---------- */

function ReleaseColumn({
  title,
  sub,
  plan,
  peakMax,
}: {
  title: string;
  sub: string;
  plan: ReleasePlan;
  peakMax: number;
}) {
  return (
    <div className={`dh__rcol dh__rcol--${title}`}>
      <p className="dh__rcol-title mono">{title}</p>
      <p className="dh__rcol-sub mono">{sub}</p>
      {plan.zones.map((z) => (
        <div key={z.zone} className="dh__z">
          <span className="dh__z-label mono">Z{z.zone + 1}</span>
          <span className="dh__z-bar">
            <span
              className="dh__z-fill"
              style={{ width: `${(z.peakCarts / peakMax) * 100}%` }}
            />
          </span>
          <span className="dh__z-val mono">{z.peakCarts}</span>
        </div>
      ))}
      <p className="dh__rcol-peak mono">
        peak {plan.peakQueueCarts} · t+{fmtInt(plan.lastReleaseSec)}s
        {plan.breaches.length ? (
          <span className="dh__breach mono">
            {plan.breaches.length} past due
          </span>
        ) : null}
      </p>
    </div>
  );
}

/* ---------- the sweep chart ---------- */

interface SweepEntry {
  w: number;
  run: OnlineRun;
}

function SweepChart({
  sweeps,
  wSec,
  maxSaved,
  maxLate,
  onPick,
}: {
  sweeps: SweepEntry[];
  wSec: number;
  maxSaved: number;
  maxLate: number;
  onPick: (w: number) => void;
}) {
  const W = 640;
  const H = 190;
  const POL = 64;
  const POR = 112;
  const PT = 20;
  const PB = 34;
  const sx = (i: number) =>
    POL + (i * (W - POL - POR)) / Math.max(1, sweeps.length - 1);
  const sySaved = (v: number) =>
    H - PB - (v / maxSaved) * (H - PT - PB) * 0.98;
  const syLate = (v: number) => H - PB - (v / maxLate) * 52;

  const line = sweeps
    .map((s, i) => `${sx(i).toFixed(1)},${sySaved(s.run.walksSaved).toFixed(1)}`)
    .join(" ");

  return (
    <svg
      className="dh__chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`walks saved from ${(sweeps[0].run.walksSaved * 100).toFixed(1)}% at w=${sweeps[0].w}s to ${(sweeps[sweeps.length - 1].run.walksSaved * 100).toFixed(1)}% at w=${sweeps[sweeps.length - 1].w}s; signal bars count orders past due`}
    >
      <line
        className="dh__chart-axis"
        x1={POL - 10}
        y1={H - PB}
        x2={W - 10}
        y2={H - PB}
      />
      {sweeps.map((s, i) => (
        <g
          key={s.w}
          className={`dh__chart-col${s.w === wSec ? " dh__chart-col--on" : ""}`}
        >
          <rect
            className="dh__chart-hit"
            x={sx(i) - 30}
            y={PT - 12}
            width={60}
            height={H - PT - PB + 26}
            onClick={() => onPick(s.w)}
            aria-label={`window ${s.w}s: walks saved ${(s.run.walksSaved * 100).toFixed(1)}%`}
            /* React 19 empties real svg <title> children on the server;
               the hover tooltip rides in as innerHTML instead */
            dangerouslySetInnerHTML={{
              __html: `<title>${escTitle(
                `w=${s.w}s · walks saved ${(s.run.walksSaved * 100).toFixed(1)}% · ${s.run.lateOrders.length} late`,
              )}</title>`,
            }}
          />
          {s.run.lateOrders.length > 0 ? (
            <rect
              className="dh__chart-late"
              x={sx(i) - 7}
              y={syLate(s.run.lateOrders.length)}
              width={14}
              height={H - PB - syLate(s.run.lateOrders.length)}
            />
          ) : null}
        </g>
      ))}

      <polyline className="dh__chart-line" points={line} />
      {sweeps.map((s, i) => (
        <circle
          key={`d-${s.w}`}
          className={`dh__chart-dot${s.w === wSec ? " dh__chart-dot--on" : ""}`}
          cx={sx(i)}
          cy={sySaved(s.run.walksSaved)}
          r={3.4}
        />
      ))}

      {sweeps.map((s, i) => (
        <text
          key={`l-${s.w}`}
          className={`dh__chart-lab${s.w === wSec ? " dh__chart-lab--on" : ""}`}
          x={sx(i)}
          y={H - 12}
          textAnchor="middle"
        >
          {s.w}s
        </text>
      ))}

      <text
        className="dh__chart-lab dh__chart-lab--saved"
        x={POL - 14}
        y={PT + 8}
        textAnchor="end"
      >
        {(maxSaved * 100).toFixed(0)}% saved
      </text>
      <text
        className="dh__chart-lab dh__chart-lab--late"
        x={W - 8}
        y={H - PB - 6}
        textAnchor="end"
      >
        late ×{maxLate}
      </text>
    </svg>
  );
}
