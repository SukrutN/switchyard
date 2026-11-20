import type { Metadata } from "next";

import SiteHeader from "../components/SiteHeader";
import SiteFooter from "../components/SiteFooter";
import Reveal from "../components/Reveal";
import "../components/hero.css"; /* the shared banner + button voice */
import "./components/despatch.css";

import DCPlan from "./components/DCPlan";
import DespatchHall from "./components/DespatchHall";
import { tourPath } from "./components/plan";

/* the engine: everything below is its output, judged by its tests */
import {
  batchOffline,
  batchOnline,
  buildJobList,
  mergeStops,
  releasePlan,
  stopsOfOrder,
  tabuImprove,
  tourSecOf,
  zoneCaps,
  CART_LINES,
  CART_ORDERS,
  CRAFT_OVERHEAD_SEC,
  LINES_PER_PICKER_HOUR,
  SEC_PER_AISLE,
  SEC_PER_BAY,
  SEC_PER_STOP,
  TABU_TENURE,
} from "@/engine/despatch-engine/index.ts";
import type {
  BatchRun,
  PickStop,
  TabuRun,
} from "@/engine/despatch-engine/index.ts";
import {
  CATALOG,
  DAYS,
  SLOTTING,
  dayByKey,
} from "@/engine/despatch-engine/fixtures/dc.ts";
import benchRaw from "@/engine/despatch-engine/bench/results.json";

export const metadata: Metadata = {
  title: "despatch · unit-01, the despatch board",
  description:
    "Batching and release from the switchyard family: freeze windows that batch an on-line order stream onto cart tours, a waveless release gate that paces them against zone labor, and a tabu pass reported as a delta. Deterministic demand, zero dependencies, byte-stable.",
};

/* ---------- bench artifact typing (the file is engine-written) */

interface BenchRun {
  orders: number;
  lines: number;
  carts: number;
  batchMs: number;
  onlineMs: number;
  releaseMs: number;
  tabuMs: number | null;
  tabuDeltaSec: number | null;
  deterministic: boolean;
}

interface BenchDayRow {
  key: string;
  orders: number;
  lines: number;
  carts: number;
  batchMs: number;
  tabuMs: number;
  onlineMs: number;
  releaseMs: number;
  walksSaved: number;
}

const bench = benchRaw as {
  generated: string;
  note: string;
  runs: BenchRun[];
  dayRows: BenchDayRow[];
};

/* ============================================================
   build-time despatch: the page's whole ledger. Every figure the
   page prints is its own batchOffline/batchOnline/releasePlan
   call, the same deterministic days fixtures/expected.ts locks,
   re-run at build so the site can never drift from the engine.
   ============================================================ */

const runs: Record<string, BatchRun> = Object.fromEntries(
  DAYS.map((d) => [d.profile.key, batchOffline(d.orders, SLOTTING)]),
);

const tabus: Record<string, TabuRun> = Object.fromEntries(
  DAYS.map((d) => [d.profile.key, tabuImprove(runs[d.profile.key], d.orders, SLOTTING)]),
);

/* the hero rig's tour: the average day's longest walk, honest teeth */
const AVG = dayByKey("average-day");
const heroBatch = [...runs["average-day"].batches].sort(
  (a, b) => b.ledger.tourSec - a.ledger.tourSec,
)[0];

/* fix 01, the best co-picking pair among the day's first orders:
   two singles vs their merged tour, straight off the proxy */
const f1 = (() => {
  const pool: { id: string; stops: readonly PickStop[]; sec: number }[] =
    AVG.orders.slice(0, 48).map((o) => ({
      id: o.id,
      stops: stopsOfOrder(o, SLOTTING),
      sec: tourSecOf(stopsOfOrder(o, SLOTTING)),
    }));
  let best: {
    a: (typeof pool)[number];
    b: (typeof pool)[number];
    union: PickStop[];
    unionSec: number;
    save: number;
  } | null = null;
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const union = mergeStops([pool[i].stops, pool[j].stops]);
      const unionSec = tourSecOf(union);
      const save = pool[i].sec + pool[j].sec - unionSec;
      if (save > 0 && (!best || save > best.save)) {
        best = { a: pool[i], b: pool[j], union, unionSec, save };
      }
    }
  }
  return best!;
})();

/* fix 02, the 90-second window: where the ticks and freezes land */
const f2run = batchOnline(AVG.orders, 90, SLOTTING);
const TL_SPAN = 2700; // the first 45 minutes, drawn
const f2arrivals = AVG.orders
  .filter((o) => o.arrivalSec < TL_SPAN)
  .sort((a, b) => a.arrivalSec - b.arrivalSec);
const f2freezes = f2run.freezes.filter((f) => f.freezeSec <= TL_SPAN);
const f2meanWait =
  Object.values(f2run.waitsSec).reduce((s, x) => s + x, 0) /
  AVG.orders.length;
const f2p90 = (() => {
  const w = Object.values(f2run.waitsSec).sort((a, b) => a - b);
  return w[Math.min(w.length - 1, Math.floor(w.length * 0.9))];
})();
/* the exemplar wait: the longest held order the drawn span shows fully */
const f2exemplar = f2arrivals
  .map((o) => ({
    o,
    wait: (f2run.publish[o.id] ?? 0) - o.arrivalSec,
  }))
  .filter((e) => (f2run.publish[e.o.id] ?? 0) < TL_SPAN)
  .sort((a, b) => b.wait - a.wait)[0];

/* fix 03, the release board on the average day at w=90 */
const f3 = (() => {
  const jobs = buildJobList(
    f2run.publishedBatches,
    AVG.orders,
    f2run.batchPublish,
  );
  const caps = zoneCaps(4, AVG.profile.pickersPerZone);
  const opts = { startSec: 0, horizonSec: AVG.horizonSec, binSec: 60 };
  return {
    unpaced: releasePlan(jobs, caps, { ...opts, paced: false }),
    paced: releasePlan(jobs, caps, { ...opts, paced: true }),
  };
})();

/* the hall's day strip (tabu deltas pre-baked; the rest live) */
const HALL_PROFILES = DAYS.map((d) => ({
  key: d.profile.key,
  short: d.profile.short,
  sub: d.profile.sub,
}));

const HALL_TABU = Object.fromEntries(
  DAYS.map((d) => [
    d.profile.key,
    {
      deltaSec: Math.round(tabus[d.profile.key].deltaSec * 10) / 10,
      deltaPct: tabus[d.profile.key].deltaPct,
      appliedMoves: tabus[d.profile.key].appliedMoves,
    },
  ]),
);

/* curtain: the catalog, one SKU a beat */
const libTick = CATALOG.map((c) => ({
  sku: c.sku,
  text: `${c.name} · aisle ${c.aisle} · bay ${c.bay} · tier ${c.tier}`,
  signal: c.tier === 0,
}));

const ENGINE_README =
  "https://github.com/SukrutN/switchyard/blob/main/site/engine/despatch-engine/README.md";

/* the despatch law, quoted with the constants' own values . 
   change src/constants.ts and the sheet repoints itself. */
const LAWSHEET = `/* the despatch law, src/constants.ts */

tour = 2×(farthest−1)×${SEC_PER_AISLE}s        /* horizontal sweep */
     + Σ visited 2×deepest×${SEC_PER_BAY}s  /* aisle depth     */
     + stops×${SEC_PER_STOP}s                    /* the pick faces  */

cart: ≤ ${CART_LINES} units · ≤ ${CART_ORDERS} orders     /* hard caps, everywhere  */

window w → freeze: everything landed publishes
  waits ≤ w · tardiness = max(0, publish − due)

release key: EDD · home-zone crew ${LINES_PER_PICKER_HOUR} lines/h
  craft = tour + ${CRAFT_OVERHEAD_SEC}s  ·  never before its publish tick
honesty pass: releases re-walked by zone · collision +60s

tabu: relocate + swap · tenure ${TABU_TENURE} · Δ reported, never promised`;

/* formats */
const fmtInt = (n: number): string =>
  n.toLocaleString("en-US", { maximumFractionDigits: 0 });

export default function DespatchPage() {
  return (
    <>
      <SiteHeader
        cross
        family={{ name: "despatch", unit: "/unit-01", href: "/despatch/" }}
      />
      <main>
        {/* ---------- hero ---------- */}
        <section className="section dp-hero" id="top">
          <div className="wrp">
            <div className="hero__tags">
              <div className="hero__tag">
                <div className="hero__tag__k">UNIT</div>
                <div className="hero__tag__v">01 · BATCHING &amp; DESPATCH</div>
              </div>
              <div className="hero__tag">
                <div className="hero__tag__k">PROXY</div>
                <div className="hero__tag__v">TRAVERSAL SECONDS</div>
              </div>
              <div className="hero__tag">
                <div className="hero__tag__k">DEMAND</div>
                <div className="hero__tag__v">SEEDED · BYTE-STABLE</div>
              </div>
              <div className="hero__tag hero__tag--right">
                <div className="hero__tag__k">DEPENDENCIES</div>
                <div className="hero__tag__v">ZERO</div>
              </div>
              <div className="hero__tag hero__tag--right">
                <div className="hero__tag__k">DAYS</div>
                <div className="hero__tag__v hero__tag__v--signal">
                  BRAMBLE &amp; TWINE ×3
                </div>
              </div>
            </div>

            <div className="hero__grid">
              <div>
                <p className="eyebrow">despatch, the batching &amp; release family</p>
                <h1 className="display hero__claim">
                  <span className="hero__line">
                    <span style={{ "--d": "0ms" } as React.CSSProperties}>
                      batch the stream,
                    </span>
                  </span>
                  <span className="hero__line">
                    <span style={{ "--d": "90ms" } as React.CSSProperties}>
                      pace the release,
                    </span>
                  </span>
                  <span className="hero__line">
                    <span style={{ "--d": "180ms" } as React.CSSProperties}>
                      <em>prove the despatch.</em>
                    </span>
                  </span>
                </h1>

                <p className="lede hero__lede">
                  An order stream becomes cart tours: frozen inside windows and
                  published on the tick, released only when a zone has the
                  picker-seconds to afford them, with the tardiness and the
                  trade-offs written into the ledger, never smoothed away.
                  Same order bytes in, same batches out.
                </p>

                <div className="hero__cta">
                  <a className="btn" href="#hall">
                    <span className="btn__text">
                      <span>Open the despatch hall</span>
                      <span aria-hidden="true">Open the despatch hall</span>
                    </span>
                    <span className="btn__arrow" aria-hidden="true">
                      <svg className="arrow" viewBox="0 0 12 12">
                        <path d="M7.3 0.7 10.9 6l-3.6 5.3H5.4l2.4-3.3H1v-4h6.8L5.4 0.7h1.9Z" />
                      </svg>
                    </span>
                  </a>
                  <a
                    className="btn btn--ghost"
                    href={ENGINE_README}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="btn__text">
                      <span>Read the engine README</span>
                      <span aria-hidden="true">Read the engine README</span>
                    </span>
                    <span className="btn__arrow" aria-hidden="true">
                      <svg className="arrow" viewBox="0 0 12 12">
                        <path d="M7.3 0.7 10.9 6l-3.6 5.3H5.4l2.4-3.3H1v-4h6.8L5.4 0.7h1.9Z" />
                      </svg>
                    </span>
                  </a>
                </div>

                {/* the three moves, numbered, the runner's step strip */}
                <div className="dp-hero__steps">
                  <div className="dp-hero__step">
                    <span className="dp-hero__step-k mono">01 · observe</span>
                    <p className="dp-hero__step-t">arrivals, dues, labor</p>
                    <p className="dp-hero__step-b">
                      An order stream with SLA clocks and a picker crew per
                      zone, the only inputs a worked day needs.
                    </p>
                  </div>
                  <div className="dp-hero__step">
                    <span className="dp-hero__step-k mono">02 · freeze</span>
                    <p className="dp-hero__step-t">windows batch, then publish</p>
                    <p className="dp-hero__step-b">
                      Every w seconds the board closes: what has landed
                      batches onto tours, and nothing rides two freezes.
                    </p>
                  </div>
                  <div className="dp-hero__step">
                    <span className="dp-hero__step-k mono">03 · pace</span>
                    <p className="dp-hero__step-t">the floor breathes by release</p>
                    <p className="dp-hero__step-b">
                      EDD holds carts until a zone can afford the craft, and
                      the breaches get signed, not hidden.
                    </p>
                  </div>
                </div>
              </div>

              <div className="dp-hero__rig">
                <DCPlan
                  className="dp-hero__plan"
                  catalog={CATALOG}
                  tour={tourPath(heroBatch.stops)}
                  stops={heroBatch.stops}
                  label={heroBatch.id}
                  tag="BRAMBLE & TWINE · MEADOWFIELD DC"
                />
                <p className="dp-hero__rig-note mono">
                  the average day's longest tour · {heroBatch.stops.length}{" "}
                  pick faces in {heroBatch.ledger.aislesVisited} aisles ·{" "}
                  {fmtInt(heroBatch.ledger.tourSec)}s drawn as the proxy pays it
                </p>
              </div>
            </div>
          </div>

          {/* the strip: the catalog, real slotting */}
          <div className="tick" aria-hidden="true">
            <div className="tick__track">
              {[0, 1].map((pass) =>
                libTick.map((t, ti) => (
                  <span
                    key={`${pass}-${t.sku}-${ti}`}
                    className={`tick__item ${t.signal ? "tick__item--signal" : ""}`}
                  >
                    <span className="tick__op">{t.sku}</span> {t.text}
                    <i className="tick__dash" />
                  </span>
                )),
              )}
            </div>
          </div>
        </section>

        {/* ---------- the three fixes ---------- */}
        <section className="section section--pad" id="fixes">
          <div className="wrp">
            <p className="eyebrow">
              <span className="eyebrow--signal">01</span> · the three fixes
            </p>
            <h2 className="display dp__title" data-anim="wipe">
              <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
                <span className="wl__t">The fixes that matter,</span>
              </span>
              <span className="wl" style={{ "--i": 1 } as React.CSSProperties}>
                <span className="wl__t">kept in the engine.</span>
              </span>
            </h2>
            <p className="lede dp__lede" data-fill>
              Despatch fails three exact ways: batching that double-charges
              shared aisles, windows that hide the lateness they cause, and a
              release that floods a zone with more work than its crew owns.
              despatch closes each one behind a ledger line, so the trade can
              be graded rather than narrated.
            </p>

            <div className="dp__fix-grid">
              <Reveal>
                <article className="dp__fix">
                  <span className="dp__fix-n mono">fix 01</span>
                  <h3 className="dp__fix-name display">
                    co-picking is free, proven
                  </h3>
                  <GlyphBatch />
                  <p className="dp__glyph-cap mono">
                    two single tours {fmtInt(f1.a.sec)}s + {fmtInt(f1.b.sec)}s →
                    merged {fmtInt(f1.unionSec)}s · −{fmtInt(f1.save)}s on one
                    shared face
                  </p>
                  <p className="dp__fix-body" data-fill>
                    Merged stops are the whole trick: one face visited once,
                    quantity added. The engine asserts{" "}
                    <span className="mono">tour(A)+tour(B) ≥ tour(A∪B)</span>{" "}
                    and the tests hold the inequality across every worked day . 
                    the savings are exactly what the proxy pays, nothing
                    invented.
                  </p>
                </article>
              </Reveal>

              <Reveal delay={90}>
                <article className="dp__fix">
                  <span className="dp__fix-n mono">fix 02</span>
                  <h3 className="dp__fix-name display">
                    the window's price is printed
                  </h3>
                  <GlyphWindow />
                  <p className="dp__glyph-cap mono">
                    w=90s · mean wait {f2meanWait.toFixed(1)}s · p90{" "}
                    {fmtInt(f2p90)}s · wait never past the window
                  </p>
                  <p className="dp__fix-body" data-fill>
                    The freeze window is the whole on-line rule: land inside a
                    window, out at the freeze; land later, wait one. Widening w
                    buys bigger pools and better tours, and the ledger keeps
                    the price in black and white: orders past their SLA due get
                    counted, listed, and shown.
                  </p>
                </article>
              </Reveal>

              <Reveal delay={180}>
                <article className="dp__fix">
                  <span className="dp__fix-n mono">fix 03</span>
                  <h3 className="dp__fix-name display">
                    pacing signs its trade
                  </h3>
                  <GlyphPace />
                  <p className="dp__glyph-cap mono">
                    peak {f3.unpaced.peakQueueCarts} →{" "}
                    {f3.paced.peakQueueCarts} carts ·{" "}
                    {f3.paced.breaches.length} releases signed past due
                  </p>
                  <p className="dp__fix-body" data-fill>
                    A zone spends only the picker-seconds it owns: one craft
                    leaves the moment the crew can afford tour plus{" "}
                    {CRAFT_OVERHEAD_SEC}s of marshal and hand-off. Where pacing
                    runs late, the plan names the batches . {" "}
                    <span className="mono">breaches[]</span>, not a footnote.
                  </p>
                </article>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ---------- the despatch hall ---------- */}
        <section className="section section--pad dp-hall" id="hall">
          <div className="wrp">
            <p className="eyebrow">
              <span className="eyebrow--signal">02</span> · the despatch hall
            </p>
            <h2 className="display dp__title" data-anim="wipe">
              <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
                <span className="wl__t">Three days.</span>
              </span>
              <span className="wl" style={{ "--i": 1 } as React.CSSProperties}>
                <span className="wl__t">Six windows.</span>
              </span>
            </h2>
            <p className="lede dp__lede" data-fill>
              The worked trio, run live in your browser by the same
              deterministic engine the tests grade. Flip the day, drag the
              freeze window across its sweep, and watch carts, waits, and
              lateness answer in milliseconds, the trade, felt rather than
              narrated.
            </p>

            <DespatchHall profiles={HALL_PROFILES} tabu={HALL_TABU} />

            {/* the locked sheet, from this build's own engine calls */}
            <table className="dp__table" aria-label="the characterization trio, batched off-line">
              <thead>
                <tr>
                  <th>worked day</th>
                  <th>orders</th>
                  <th>units</th>
                  <th>carts</th>
                  <th>fcfs walks</th>
                  <th>batched walks</th>
                  <th>saved</th>
                  <th>tabu Δ</th>
                </tr>
              </thead>
              <tbody>
                {DAYS.map((d) => {
                  const k = d.profile.key;
                  const r = runs[k];
                  const t = tabus[k];
                  return (
                    <tr key={k}>
                      <td>{d.profile.label}</td>
                      <td>{d.orders.length}</td>
                      <td>
                        {fmtInt(
                          d.orders.reduce(
                            (s, o) =>
                              s + o.lines.reduce((u, l) => u + l.qty, 0),
                            0,
                          ),
                        )}
                      </td>
                      <td>{r.batches.length}</td>
                      <td>{fmtInt(r.fcfsTourSec)}s</td>
                      <td>{fmtInt(r.totalTourSec)}s</td>
                      <td>
                        <span className="dp__ok">
                          {(r.walksSaved * 100).toFixed(1)}%
                        </span>
                      </td>
                      <td>
                        −{fmtInt(t.deltaSec)}s ({(t.deltaPct * 100).toFixed(1)}
                        %)
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="dp__note mono">
              the same figures are pinned in fixtures/expected.ts and held to
              ±0.5 s by tests/characterization.test.ts, the table above is
              this build's own batchOffline + tabuImprove calls, not a
              transcription.
            </p>
          </div>
        </section>

        {/* ---------- the despatch law ---------- */}
        <section className="section section--pad" id="law">
          <div className="wrp dp-law__grid">
            <div>
              <p className="eyebrow">
                <span className="eyebrow--signal">03</span> · the despatch law
              </p>
              <h2 className="display dp__title" data-anim="wipe">
                <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
                  <span className="wl__t">One proxy,</span>
                </span>
                <span className="wl" style={{ "--i": 1 } as React.CSSProperties}>
                  <span className="wl__t">one ledger.</span>
                </span>
              </h2>
              <p className="lede dp__lede" data-fill>
                Batching decides before routes exist, so travel is paid in a
                traversal proxy the whole family shares: sweep the front
                cross-aisle, walk each visited aisle to its deepest pick and
                back, stop once per face. The same seconds that build the
                saved-percent are the ones the release gate charges the zones
                . {" "}
                <span className="mono">craft = tour + {CRAFT_OVERHEAD_SEC}s</span>{" "}
               , so no half of the engine can flatter the other.
              </p>
              <p className="dp__law-note" data-fill>
                Two rules sit above the batching. The window: an order is
                visible only once it has landed, and everything landed
                publishes at the freeze, v0.2's honesty about time. The gate:
                a batch rides its home zone's crew, one picker ×{" "}
                {LINES_PER_PICKER_HOUR} lines/hour, with the craft counted the
                moment the cart rolls, never before its publish tick. December's
                spike is where the gate is loudest: Z1's crew saturates around{" "}
                fifty carts however cleverly the windows pool, and the fix there
                is labor, not sequencing.
              </p>
            </div>

            <pre className="dp__law" aria-label="the despatch law, as code">
              {LAWSHEET}
            </pre>
          </div>
        </section>

        {/* ---------- the bench: dark, honest, dated by data ---------- */}
        <section className="section section--pad console" id="bench">
          <div className="wrp">
            <p className="eyebrow">
              <span className="eyebrow--signal">04</span> · the bench
            </p>
            <h2 className="display dp__title" data-anim="wipe">
              <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
                <span className="wl__t">Milliseconds per switch,</span>
              </span>
              <span className="wl" style={{ "--i": 1 } as React.CSSProperties}>
                <span className="wl__t">seconds per day.</span>
              </span>
            </h2>
            <p className="lede dp__lede" data-fill>
              Batching runtime against order count, re-measured until it stopped
              moving. Every row re-checks byte-level determinism: two full
              passes of the same day must serialize identically, or the row
              can't call itself a result. The tabu pass runs its quadratic scan
              only on day-sized inputs, beyond that, the honest cell is a dash,
              not a fudged number.
            </p>

            <BenchSpark />

            <table className="dp__table" aria-label="bench results, median of three">
              <thead>
                <tr>
                  <th>orders</th>
                  <th>units</th>
                  <th>carts</th>
                  <th>batch ms</th>
                  <th>online ms</th>
                  <th>release ms</th>
                  <th>tabu ms</th>
                  <th>stable</th>
                </tr>
              </thead>
              <tbody>
                {bench.runs.map((r) => (
                  <tr key={r.orders}>
                    <td>{r.orders}</td>
                    <td>{fmtInt(r.lines)}</td>
                    <td>{r.carts}</td>
                    <td>{r.batchMs.toFixed(2)}</td>
                    <td>{r.onlineMs.toFixed(2)}</td>
                    <td>{r.releaseMs.toFixed(2)}</td>
                    <td>{r.tabuMs === null ? ". " : r.tabuMs.toFixed(2)}</td>
                    <td>
                      {r.deterministic ? (
                        <span className="dp__ok">✓</span>
                      ) : (
                        ". "
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* the trio, timed for the record */}
            <p className="dp__table-head">the worked trio, timed once for the record</p>
            <table className="dp__table" aria-label="the worked trio, timed">
              <thead>
                <tr>
                  <th>day</th>
                  <th>orders</th>
                  <th>carts</th>
                  <th>batch ms</th>
                  <th>tabu ms</th>
                  <th>online ms</th>
                  <th>release ms</th>
                  <th>saved</th>
                </tr>
              </thead>
              <tbody>
                {bench.dayRows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.key}</td>
                    <td>{r.orders}</td>
                    <td>{r.carts}</td>
                    <td>{r.batchMs.toFixed(2)}</td>
                    <td>{r.tabuMs.toFixed(2)}</td>
                    <td>{r.onlineMs.toFixed(2)}</td>
                    <td>{r.releaseMs.toFixed(2)}</td>
                    <td>{(r.walksSaved * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="dp__note mono">
              {bench.note} · bench run dated {bench.generated} · read from
              bench/results.json, the committed artifact · carts here are the
              batch stage&apos;s whole-day pooled tours, the hall&apos;s{" "}
              carts built are the on-line window freezes; one cap, two lenses
            </p>
          </div>
        </section>

        {/* ---------- fences + lineage ---------- */}
        <section className="section section--pad" id="fences">
          <div className="wrp">
            <p className="eyebrow">
              <span className="eyebrow--signal">05</span> · scope &amp; lineage
            </p>
            <h2 className="display dp__title" data-anim="wipe">
              <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
                <span className="wl__t">Some doors</span>
              </span>
              <span className="wl" style={{ "--i": 1 } as React.CSSProperties}>
                <span className="wl__t">stay shut.</span>
              </span>
            </h2>
            <p className="lede dp__lede" data-fill>
              The family sheet drew the scope fences before the first line of
              engine code. They are what keep one unit small enough to read in
              an afternoon, and honest about what it is.
            </p>

            <div className="dp__fences">
              <div className="dp__fence">
                <span className="dp__fence-n mono">01</span>
                <div>
                  <h3 className="dp__fence-name">No path routing</h3>
                  <p className="dp__fence-body">
                    Tour seconds are batching's proxy, not a route plan;
                    turn-by-turn walking belongs to{" "}
                    <span className="mono">northspan</span>, the routing
                    family, and the stop ledger here is its seam. One job per
                    unit.
                  </p>
                </div>
              </div>
              <div className="dp__fence">
                <span className="dp__fence-n mono">02</span>
                <div>
                  <h3 className="dp__fence-name">No putaway or replenishment</h3>
                  <p className="dp__fence-body">
                    The inbound half is <span className="mono">quay</span>'s
                    (sheet 07). The catalog's slotting is treated as the
                    slotter's word, despatch reads faces where they stand.
                  </p>
                </div>
              </div>
              <div className="dp__fence">
                <span className="dp__fence-n mono">03</span>
                <div>
                  <h3 className="dp__fence-name">No robot windows</h3>
                  <p className="dp__fence-body">
                    AMR/AGV gating is <span className="mono">hearthline</span>'s
                    sheet 08. The release gate here reads labor, picker crews,
                    craft seconds, and stops at the cart, not the robot.
                  </p>
                </div>
              </div>
              <div className="dp__fence">
                <span className="dp__fence-n mono">04</span>
                <div>
                  <h3 className="dp__fence-name">No conveyor, no lanes</h3>
                  <p className="dp__fence-body">
                    PLC divert logic is sheet 09 and truck-lane transport is
                    sheet 02. Due dates are the only outbound word the engine
                    takes, and none of the machinery past the dock door shows
                    up here.
                  </p>
                </div>
              </div>
            </div>

            <div className="dp__git">
              <p className="dp__git-head">lineage, sources read, credited</p>
              <div className="dp__git-row">
                <span className="mono">
                  Ratliff, H.D. &amp; Rosenthal, A.S. (1983), Operations
                  Research 31(3)
                </span>{" "}
               , the solvable case of the TSP the traversal proxy respects:{" "}
                <a
                  href="https://doi.org/10.1287/opre.31.3.507"
                  target="_blank"
                  rel="noreferrer"
                >
                  the paper
                </a>
                .
              </div>
              <div className="dp__git-row">
                <span className="mono">
                  Gademann, N. &amp; van de Velde, S. (2005), IIE Transactions
                  37(1)
                </span>{" "}
               , batching to minimize total travel time in a parallel-aisle
                warehouse; the standing heuristic family the seed-and-grow
                construction descends from.
              </div>
              <div className="dp__git-row">
                <span className="mono">
                  de Koster, R., Le-Duc, T. &amp; Roodbergen, K.J. (2007),
                  European Journal of Operational Research 182(2)
                </span>{" "}
               , the review that maps batching rule families and the traversal
                proxy:{" "}
                <a
                  href="https://www.sciencedirect.com/science/article/abs/pii/S0377221706006473"
                  target="_blank"
                  rel="noreferrer"
                >
                  the paper
                </a>
                .
              </div>
              <div className="dp__git-row">
                <span className="mono">
                  Henn, S. (2012), Computers &amp; Operations Research 39(11)
                </span>{" "}
               , the on-line order batching algorithms v0.2's window-frozen
                protocol implements:{" "}
                <a
                  href="https://doi.org/10.1016/j.cor.2011.12.019"
                  target="_blank"
                  rel="noreferrer"
                >
                  the paper
                </a>
                .
              </div>
              <div className="dp__git-row">
                <span className="mono">
                  Henn, S. &amp; Wäscher, G. (2012), Production Planning &amp;
                  Control 23(2–3)
                </span>{" "}
               , the tabu neighborhoods v1.1 borrows: relocate, swap, tenure,
                aspiration.
              </div>
              <div className="dp__git-row">
                <span className="mono">
                  Bartholdi, J.J. &amp; Hackman, S.T., Warehouse &amp;
                  Distribution Science
                </span>{" "}
               , the free textbook: batch to savings, release to labor;{" "}
                <a
                  href="https://www.warehouse-science.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  the book
                </a>
                .
              </div>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

/* ============================================================
   the three glyph scenes, drawn, not decorated: numbers and
   polylines the engine really produced at build time, projected
   by plan.ts like the hall and the hero share.
   ============================================================ */

/* fix 01, two single tours vs their merged union, one plan each */
function GlyphBatch() {
  return (
    <div className="dp__glyph" aria-hidden="true">
      <div className="dp__duo">
        <div>
          <div className="dp__duo-panel">
            <DCPlan
              tours={[
                { path: tourPath(f1.a.stops), tone: "ink" },
                { path: tourPath(f1.b.stops), tone: "dash" },
              ]}
            />
          </div>
          <p className="dp__duo-note mono">
            <span>
              two carts. <b>{fmtInt(f1.a.sec)}s + {fmtInt(f1.b.sec)}s</b>
            </span>
            <span>{f1.a.id} · {f1.b.id}</span>
          </p>
        </div>
        <span className="dp__duo-arrow" aria-hidden="true">
          →
        </span>
        <div>
          <div className="dp__duo-panel">
            <DCPlan
              tour={tourPath(f1.union)}
              stops={f1.union}
              label="one tour"
            />
          </div>
          <p className="dp__duo-note mono">
            <span>
              one tour. <b>{fmtInt(f1.unionSec)}s</b>
            </span>
            <span>−{fmtInt(f1.save)}s</span>
          </p>
        </div>
      </div>
    </div>
  );
}

/* fix 02, the first 45 minutes: landings, freezes, the wait */
function GlyphWindow() {
  const W = 640;
  const H = 168;
  const left = 34;
  const right = W - 18;
  const x = (t: number) => left + (t / TL_SPAN) * (right - left);
  const pitch = (right - left) / (TL_SPAN / 90); // px per window
  const axisY = 118;
  const freezeTops = 42;
  const waitBandY = 58;

  const exemplarPub = (f2run.publish[f2exemplar.o.id] ?? 0) as number;
  const xArr = x(f2exemplar.o.arrivalSec);
  const xPub = x(exemplarPub);

  return (
    <svg
      className="dp__tl"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`the first 45 minutes of the average day: ${f2arrivals.length} orders land, ${f2freezes.length} freezes publish them, the longest wait in the drawn span is ${fmtInt(f2exemplar.wait)} seconds`}
    >
      {/* axis */}
      <line className="dp__tl-axis" x1={left} y1={axisY} x2={right} y2={axisY} />

      {/* window bands: the sweep tick by tick */}
      {f2freezes.map((f, i) => (
        <g key={f.freezeSec}>
          <rect
            className="dp__tl-band"
            x={x(f.freezeSec) - pitch}
            y={freezeTops}
            width={pitch}
            height={axisY - freezeTops}
          />
          <line
            className="dp__tl-freeze"
            x1={x(f.freezeSec)}
            y1={freezeTops - 8}
            x2={x(f.freezeSec)}
            y2={axisY + 6}
          />
          {i % 8 === 0 ? (
            <text
              className="dp__tl-lab"
              x={x(f.freezeSec) + 2}
              y={freezeTops - 12}
              textAnchor="start"
            >
              W{i + 1}
            </text>
          ) : null}
        </g>
      ))}

      {/* the arrivals, tick by tick */}
      {f2arrivals.map((o) => (
        <line
          key={o.id}
          className="dp__tl-tick"
          x1={x(o.arrivalSec)}
          y1={axisY + 2}
          x2={x(o.arrivalSec)}
          y2={axisY + 14}
        />
      ))}

      {/* the exemplar's wait: from landing to its freeze */}
      <path
        className="dp__tl-wait"
        d={`M ${xArr} ${waitBandY} H ${xPub}`}
      />
      <line className="dp__tl-wait" x1={xArr} y1={waitBandY - 5} x2={xArr} y2={waitBandY + 5} />
      <line className="dp__tl-wait" x1={xPub} y1={waitBandY - 5} x2={xPub} y2={waitBandY + 5} />
      <text
        className="dp__tl-lab dp__tl-lab--signal"
        x={(xArr + xPub) / 2}
        y={waitBandY - 8}
        textAnchor="middle"
      >
        {f2exemplar.o.id} waits {fmtInt(f2exemplar.wait)}s
      </text>

      {/* legends */}
      <text className="dp__tl-lab" x={left} y={H - 12} textAnchor="start">
        orders land ↓
      </text>
      <text className="dp__tl-lab" x={right} y={H - 12} textAnchor="end">
        the board freezes, and publishes ↓
      </text>
    </svg>
  );
}

/* fix 03, the queue: unpaced peak vs the paced crew the zone owns */
function GlyphPace() {
  const W = 640;
  const H = 128;
  const left = 60;
  const right = W - 26;
  const cart0 = (n: number) => {
    // stack of little carts left-aligned
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(left + i * 22);
    return out;
  };

  const floorY = H - 18;
  const un = f3.unpaced.peakQueueCarts;
  const pa = f3.paced.peakQueueCarts;

  return (
    <svg
      className="dp__pb"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`the average day at w=90s: the unpaced release floods the floor with ${un} carts of peak queue, the paced release holds it to ${pa}`}
    >
      <line className="dp__pb-axis" x1={left - 18} y1={floorY} x2={right} y2={floorY} />

      {/* the unpaced park */}
      <text className="dp__pb-lab" x={left - 18} y={40} textAnchor="start">
        unpaced
      </text>
      {cart0(un).map((cx, i) => (
        <rect
          key={`u-${i}`}
          className="dp__pb-cart"
          x={cx}
          y={28}
          width={14}
          height={10}
        />
      ))}

      {/* the paced park */}
      <text className="dp__pb-lab dp__pb-lab--signal" x={left - 18} y={82} textAnchor="start">
        paced
      </text>
      {cart0(pa).map((cx, i) => (
        <rect
          key={`p-${i}`}
          className="dp__pb-bar-p"
          x={cx}
          y={70}
          width={14}
          height={10}
        />
      ))}

      {/* the counts, honest where they end */}
      <text className="dp__pb-lab" x={left + un * 22 + 6} y={37} textAnchor="start">
        {un} carts
      </text>
      <text
        className="dp__pb-lab dp__pb-lab--signal"
        x={left + pa * 22 + 6}
        y={79}
        textAnchor="start"
      >
        {pa} carts
      </text>

      <text className="dp__pb-lab" x={left - 18} y={H - 4} textAnchor="start">
        peak queue in a zone, the release gate's word, not a promise
      </text>
    </svg>
  );
}

/* the bench curve: batchOffline wall-clock against order count */
function BenchSpark() {
  const W = 640;
  const H = 132;
  const PL = 16;
  const PR = 16;
  const PT = 22;
  const PB = 30;
  const msMax = Math.max(...bench.runs.map((r) => r.batchMs));
  const sx = (i: number) =>
    PL + (i * (W - PL - PR)) / (bench.runs.length - 1);
  const sy = (ms: number) =>
    H - PB - (ms / msMax) * (H - PT - PB);
  const line = bench.runs
    .map((r, i) => `${sx(i).toFixed(1)},${sy(r.batchMs).toFixed(1)}`)
    .join(" ");
  const first = bench.runs[0];
  const last = bench.runs[bench.runs.length - 1];

  return (
    <svg
      className="dp__spark"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`batching time from ${first.batchMs.toFixed(2)} ms at ${first.orders} orders to ${last.batchMs.toFixed(2)} ms at ${last.orders} orders`}
    >
      <polyline className="dp__spark-line" points={line} />
      <line
        className="dp__spark-axis"
        x1={PL}
        y1={H - PB}
        x2={W - PR}
        y2={H - PB}
      />
      {bench.runs.map((r, i) => (
        <circle
          key={r.orders}
          className="dp__spark-dot"
          cx={sx(i)}
          cy={sy(r.batchMs)}
          r={3.2}
        >
          <title>{`${r.orders} orders · ${r.batchMs.toFixed(2)} ms`}</title>
        </circle>
      ))}
      {bench.runs.map((r, i) => (
        <text
          key={`lab-${r.orders}`}
          className="dp__spark-lab"
          x={sx(i)}
          y={H - 10}
          textAnchor="middle"
        >
          {r.orders}
        </text>
      ))}
      <text
        className="dp__spark-lab dp__spark-lab--ms"
        x={sx(0) + 7}
        y={sy(first.batchMs) - 8}
        textAnchor="start"
      >
        {first.batchMs.toFixed(2)} ms
      </text>
      <text
        className="dp__spark-lab dp__spark-lab--ms"
        x={sx(bench.runs.length - 1) - 7}
        y={sy(last.batchMs) - 8}
        textAnchor="end"
      >
        {last.batchMs.toFixed(2)} ms
      </text>
    </svg>
  );
}
