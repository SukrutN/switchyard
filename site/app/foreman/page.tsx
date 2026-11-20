// foreman, unit 06. The page is the engine's output: the ledger, the
// staged forecast, the casing, the realization. Everything below is
// computed at build from the same deterministic fixtures the tests lock.
import type { Metadata } from "next";

import SiteHeader from "../components/SiteHeader";
import SiteFooter from "../components/SiteFooter";
import Reveal from "../components/Reveal";
import "../components/hero.css"; /* the shared banner + button voice */
import "./components/foreman.css";

/* the engine: everything below is its output, judged by its tests */
import {
  BRAMBLE,
  EVENTS,
  FORECAST_CONFIG,
  HISTORY,
  SEASON_INDICES,
  ZONE_STANDARDS,
  allowedFor,
  calendarFactor,
  forecast,
  plan,
  realizeActuals,
  variance,
  workload,
} from "@/engine/foreman-engine/index.ts";
import type { BandId } from "@/engine/foreman-engine/index.ts";

export const metadata: Metadata = {
  title: "foreman · unit-06, the labor plan",
  description:
    "Zone-workload forecast and a shift/skill labor plan, priced by northspan's standards. 52 weeks of ledger, a 12-week spring surge, a seeded realization, and MAPE by zone locked. Zero dependencies, byte-stable.",
};

/* ============================================================
   build-time foreman: the page's whole ledger. Every figure the
   page prints is a call into engine/foreman-engine, the same
   deterministic pipeline fixtures/expected.ts locks, re-run at
   build so the site can never drift from the engine.
   ============================================================ */

const fc = forecast(HISTORY, FORECAST_CONFIG);
const wl = workload(fc, ZONE_STANDARDS);
const pl = plan(wl);
const realization = realizeActuals(fc, {
  seed: BRAMBLE.actualSeed,
  amplitude: BRAMBLE.actualNoiseAmplitude,
});
const report = variance(realization, BRAMBLE.actualSeed);

const WEEKS = 12;
const FIRST_WEEK = FORECAST_CONFIG.horizonStartWeek; /* 53 */

/* ---------- the pool, the peak week ---------- */

const BAND_IDS: BandId[] = ["veteran", "day", "night"];

const weeklyTotals = Array.from({ length: WEEKS }, (_, i) =>
  BAND_IDS.reduce((sum, band) => sum + pl.byBand[band][i], 0),
);
let peakWeekIndex = 0;
for (let i = 0; i < WEEKS; i++) if (weeklyTotals[i] > weeklyTotals[peakWeekIndex]) peakWeekIndex = i;
const PEAK_WEEK = FIRST_WEEK + peakWeekIndex;
const peakPaid = weeklyTotals[peakWeekIndex];
const poolHours = BAND_IDS.reduce((sum, band) => sum + pl.poolHours[band][0], 0);
const utilizationPeak = peakPaid / poolHours;

/* ---------- the five runs, the realization, the MAPE ---------- */

const RUNS = ZONE_STANDARDS.map((standard) => {
  const forecastLines = fc.zones.find((z) => z.zone === standard.zone)!.lines;
  const actual = realization
    .filter((r) => r.zone === standard.zone)
    .sort((a, b) => a.week - b.week)
    .map((r) => r.actualLines);
  const scored = report.zones.find((z) => z.zone === standard.zone)!;
  return {
    code: standard.zone,
    name: standard.runName,
    velocity: standard.velocity,
    mpl: standard.mplMinutes,
    forecastLines,
    actual,
    mape: scored.mape,
    forecastHours: scored.forecastHours,
    actualHours: scored.actualHours,
    noiseDelta: scored.noiseDelta,
  };
});

/* ---------- stage 0: the fitted model, walked over the ledger ---------- */

const modelOverHistory = HISTORY.map((_, i) => {
  const week = i + 1;
  const level = fc.trend.base + fc.trend.slopePerWeek * i;
  return level * calendarFactor(SEASON_INDICES, FORECAST_CONFIG.weeksPerBlock, EVENTS, week);
});

/* ---------- heat strip: paid hours per zone × shift × week ---------- */

const heatRows = ZONE_STANDARDS.flatMap((standard) =>
  (["day", "night"] as const).map((shift) => ({
    zone: standard.zone,
    runName: standard.runName,
    shift,
    cells: Array.from({ length: WEEKS }, (_, i) => {
      const week = FIRST_WEEK + i;
      const rows = pl.rows.filter(
        (row) => row.zone === standard.zone && row.shift === shift && row.week === week,
      );
      return rows.reduce((sum, row) => sum + row.paidHours, 0);
    }),
  })),
);
const heatMax = Math.max(...heatRows.flatMap((r) => r.cells));

/* ---------- the anniversary casing table ---------- */

const anniversary = pl.rows.filter((row) => row.week === PEAK_WEEK);

/* ---------- the standards tie-out, verbatim ---------- */

const tieOut = ([
  ["CIN", 0.364],
  ["LOA", 0.416],
  ["FLI", 0.44],
  ["REE", 0.406],
  ["COB", 0.451],
] as const)
  .map(([zone, mpl]) => {
    const standard = ZONE_STANDARDS.find((s) => s.zone === zone)!;
    return { zone, mpl, engine: standard.mplMinutes, run: standard.runName };
  })
  .map((row) => ({
    ...row,
    ok: row.mpl === row.engine,
  }));

/* ---------- numbers formatting ---------- */

const k = (x: number) => `${(x / 1000).toFixed(1)}k`;
const n0 = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });
const n1 = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/* ============================================================
   figures, inline svg, printed from the computed data above.
   ============================================================ */

/* ---------- fig 1: the ledger, the fit, the surge ---------- */

const LEDGER_W = 1000;
const LEDGER_H = 300;
const LEDGER_PL = 4;
const LEDGER_PR = 4;
const LEDGER_PT = 24;
const LEDGER_PB = 30;
const TOTAL_DAYS = 64;
const ledgerMax = Math.max(...HISTORY, ...fc.total) * 1.09;
const lx = (week: number) =>
  LEDGER_PL + ((week - 1) / (TOTAL_DAYS - 1)) * (LEDGER_W - LEDGER_PL - LEDGER_PR);
const ly = (lines: number) =>
  LEDGER_H - LEDGER_PB - (lines / ledgerMax) * (LEDGER_H - LEDGER_PT - LEDGER_PB);

const modelPoints = modelOverHistory
  .map((lines, i) => `${lx(i + 1).toFixed(2)},${ly(lines).toFixed(2)}`)
  .join(" ");
const forecastPoints = fc.total
  .map((lines, i) => `${lx(FIRST_WEEK + i).toFixed(2)},${ly(lines).toFixed(2)}`)
  .join(" ");

const ledAxe = [
  { week: 1, label: "1" },
  { week: 13, label: "13" },
  { week: 26, label: "26" },
  { week: 39, label: "39" },
  { week: 52, label: "52" },
  { week: 64, label: "64" },
];

const ledgerEvents = EVENTS.map((event) => ({
  ...event,
  inHorizon: event.week >= FIRST_WEEK,
}));

/* ---------- fig 2: the runs, forecast vs the week that happened ---------- */

const runW = 300;
const runH = 168;
const runPL = 10;
const runPR = 10;
const runPT = 26;
const runPB = 26;

function RunChart({ run }: { run: (typeof RUNS)[number] }) {
  const top = Math.max(...run.forecastLines, ...run.actual) * 1.06;
  const bottom = Math.min(...run.forecastLines, ...run.actual) * 0.9;
  const px = (i: number) => runPL + (i / (WEEKS - 1)) * (runW - runPL - runPR);
  const py = (lines: number) =>
    runH - runPB - ((lines - bottom) / (top - bottom)) * (runH - runPT - runPB);
  const line = run.forecastLines
    .map((lines, i) => `${px(i).toFixed(2)},${py(lines).toFixed(2)}`)
    .join(" ");
  return (
    <svg
      className="fm__run"
      viewBox={`0 0 ${runW} ${runH}`}
      role="img"
      aria-label={`${run.name} run, forecast against the realized week, MAPE ${run.mape.toFixed(2)} percent`}
    >
      <line className="fm__run-base" x1={runPL} y1={runH - runPB} x2={runW - runPR} y2={runH - runPB} />
      <polyline className="fm__run-line" points={line} />
      {run.actual.map((lines, i) => (
        <circle key={i} className="fm__run-dot" cx={px(i)} cy={py(lines)} r={3.1}>
          <title>{`week ${FIRST_WEEK + i}: forecast ${n0(run.forecastLines[i])} · actual ${n0(lines)}`}</title>
        </circle>
      ))}
      <text className="fm__run-name" x={runPL} y={runPT - 2}>{run.name}</text>
      <text className="fm__run-code" x={runPL} y={runH - 8}>
        {run.code} · {run.velocity}
      </text>
      <text className="fm__run-mape" x={runW - runPR} y={runPT - 2} textAnchor="end">
        MAPE {run.mape.toFixed(2)}%
      </text>
      <text className="fm__run-wk" x={runW - runPR} y={runH - 8} textAnchor="end">
        wk {FIRST_WEEK}–{FIRST_WEEK + WEEKS - 1}
      </text>
    </svg>
  );
}

/* ---------- fig 4: the variance waterfalls ---------- */

const fallW = 300;
const fallH = 190;
const fallPL = 12;
const fallPR = 12;
const fallPT = 30;
const fallPB = 26;

function FallChart({ run }: { run: (typeof RUNS)[number] }) {
  const top = Math.max(run.forecastHours, run.actualHours) * 1.12;
  const colW = (fallW - fallPL - fallPR) / 3;
  const cy = (hours: number) =>
    fallH - fallPB - (hours / top) * (fallH - fallPT - fallPB);
  const fBar = cy(run.forecastHours);
  const aBar = cy(run.actualHours);
  const deltaTop = Math.min(fBar, aBar);
  const deltaH = Math.abs(aBar - fBar);
  const up = run.noiseDelta >= 0;
  return (
    <svg
      className="fm__fall"
      viewBox={`0 0 ${fallW} ${fallH}`}
      role="img"
      aria-label={`${run.name} waterfall: forecast ${run.forecastHours.toFixed(1)} hours, noise ${run.noiseDelta >= 0 ? "+" : ""}${run.noiseDelta.toFixed(1)}, actual ${run.actualHours.toFixed(1)}`}
    >
      <rect className="fm__fall-forecast" x={fallPL} y={fBar} width={colW - 10} height={fallH - fallPB - fBar} />
      <rect
        className={`fm__fall-delta ${up ? "fm__fall-delta--up" : "fm__fall-delta--down"}`}
        x={fallPL + colW}
        y={deltaTop}
        width={colW - 10}
        height={deltaH}
      />
      <rect className="fm__fall-actual" x={fallPL + 2 * colW} y={aBar} width={colW - 10} height={fallH - fallPB - aBar} />
      <line className="fm__fall-base" x1={fallPL} y1={fallH - fallPB} x2={fallW - fallPR} y2={fallH - fallPB} />
      {[0, 1, 2].map((i) => (
        <text
          key={i}
          className="fm__fall-lab"
          x={fallPL + i * colW + (colW - 10) / 2}
          y={fallH - 8}
          textAnchor="middle"
        >
          {["forecast", "noise", "actual"][i]}
        </text>
      ))}
      <text className="fm__fall-num" x={fallPL} y={fBar - 6}>
        {n1(run.forecastHours)}
      </text>
      <text
        className={`fm__fall-num ${up ? "fm__fall-num--up" : ""}`}
        x={fallPL + colW}
        y={up ? deltaTop - 6 : deltaTop + deltaH + 14}
      >
        {up ? "+" : ""}
        {n1(run.noiseDelta)}
      </text>
      <text className="fm__fall-num" x={fallPL + 2 * colW} y={aBar - 6}>
        {n1(run.actualHours)}
      </text>
      <text className="fm__run-code" x={fallPL} y={runPT - 16}>
        {run.name}
      </text>
    </svg>
  );
}

/* ============================================================
   the page
   ============================================================ */

export default function ForemanPage() {
  return (
    <>
      <SiteHeader
        cross
        family={{ name: "foreman", unit: "/unit-06", href: "/foreman/" }}
      />
      <main>
        {/* ---------- hero ---------- */}
        <section className="section fm-hero" id="top">
          <div className="wrp">
            <div className="hero__tags">
              <div className="hero__tag">
                <div className="hero__tag__k">UNIT</div>
                <div className="hero__tag__v">06 · FORECAST &amp; LABOR PLAN</div>
              </div>
              <div className="hero__tag">
                <div className="hero__tag__k">STANDARDS</div>
                <div className="hero__tag__v">NORTHSPAN · SHEET 05</div>
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
                <div className="hero__tag__k">
                  CENTER: BRAMBLE &amp; TWINE, MEADOWFIELD
                </div>
                <div className="hero__tag__v hero__tag__v--signal">SPRING SURGE ×12 WK</div>
              </div>
            </div>

            <div className="hero__grid">
              <div>
                <p className="eyebrow">foreman, the forecast &amp; labor family</p>
                <h1 className="display hero__claim">
                  The foreman plans the week before it starts.
                </h1>
                <p className="lede hero__lede" data-fill>
                  Fifty-two weeks of ledger go in. A forecast comes out, staged
                  the classic way; the forecast turns into hours through the
                  standards&apos; own rates; the casing covers every one of those
                  hours with people who can actually do the work. Then the week
                  happens, seeded, and the plan is scored against it.
                </p>
                <div className="hero__cta-row">
                  <a className="hero__cta" href="#ledger">
                    the ledger ↓
                  </a>
                  <a
                    className="hero__cta hero__cta--ghost"
                    href="https://github.com/SukrutN/switchyard-site/blob/main/engine/foreman-engine/README.md"
                    target="_blank"
                    rel="noreferrer"
                  >
                    the engine README ↗
                  </a>
                </div>
              </div>

              <div className="fm-stats" aria-label="the unit in six numbers">
                <div className="fm-stat">
                  <span className="fm-stat__k">LEDGER</span>
                  <span className="fm-stat__v">{HISTORY.length} wk</span>
                </div>
                <div className="fm-stat">
                  <span className="fm-stat__k">HORIZON</span>
                  <span className="fm-stat__v">wk {FIRST_WEEK}–{FIRST_WEEK + WEEKS - 1}</span>
                </div>
                <div className="fm-stat">
                  <span className="fm-stat__k">STANDARD HOURS</span>
                  <span className="fm-stat__v">{n1(wl.rows.reduce((s, r) => s + r.hours, 0))}</span>
                </div>
                <div className="fm-stat">
                  <span className="fm-stat__k">PEAK PAID / POOL</span>
                  <span className="fm-stat__v">{(utilizationPeak * 100).toFixed(1)}%</span>
                </div>
                <div className="fm-stat">
                  <span className="fm-stat__k">MAPE (5 RUNS)</span>
                  <span className="fm-stat__v">{Math.max(...RUNS.map((r) => r.mape)).toFixed(2)}% max</span>
                </div>
                <div className="fm-stat fm-stat--signal">
                  <span className="fm-stat__k">REALIZATION SEED</span>
                  <span className="fm-stat__v">{BRAMBLE.actualSeed}</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------- 01 · the ledger and the fit ---------- */}
        <section className="section" id="ledger">
          <div className="wrp">
            <Reveal>
              <p className="eyebrow">
                <span className="eyebrow--signal">01</span>, the ledger, the fit
              </p>
              <h2 className="display fm__title">
                The year the engine read, and the quarter it wrote.
              </h2>
              <p className="lede fm__lede">
                Bars are the ledger. {HISTORY.length} weeks of tickets, seeded,
                with the opener&apos;s tent sale sitting in week {ledgerEvents[0].week}. The dotted line is
                the staged model walked back over the same weeks:{' '}
                <span className="mono">level × season × event</span>. The solid line is the
                horizon it wrote: weeks {FIRST_WEEK}–{FIRST_WEEK + WEEKS - 1}, the spring surge, the
                Anniversary week the pool works its hardest.
              </p>
            </Reveal>

            <div className="fm__fig fm__fig--wide">
              <svg
                viewBox={`0 0 ${LEDGER_W} ${LEDGER_H}`}
                role="img"
                aria-label="52 weeks of ledger bars, the fitted model line over them, and the 12-week forecast surge"
              >
                {HISTORY.map((lines, i) => (
                  <rect
                    key={`bar-${i}`}
                    className="fm__bar"
                    x={lx(i + 1) - 3.1}
                    y={ly(lines)}
                    width={6.2}
                    height={LEDGER_H - LEDGER_PB - ly(lines)}
                    rx={0.5}
                  >
                    <title>{`week ${i + 1}: ${n0(lines)} lines`}</title>
                  </rect>
                ))}
                <polyline className="fm__model" points={modelPoints} />
                <polyline className="fm__forecast" points={forecastPoints} />
                <line
                  className="fm__divide"
                  x1={lx(FIRST_WEEK) - 4}
                  y1={LEDGER_PT - 12}
                  x2={lx(FIRST_WEEK) - 4}
                  y2={LEDGER_H - LEDGER_PB}
                />
                {ledgerEvents.map((event) => (
                  <g key={event.label}>
                    <line
                      className={`fm__event ${event.inHorizon ? "fm__event--soon" : ""}`}
                      x1={lx(event.week)}
                      y1={LEDGER_PT - 12}
                      x2={lx(event.week)}
                      y2={LEDGER_PT - 4}
                    />
                    <text className="fm__event-lab" x={lx(event.week)} y={LEDGER_PT - 18} textAnchor="middle">
                      {event.label.toLowerCase()} ×{event.multiplier.toFixed(2)}
                    </text>
                  </g>
                ))}
                {ledAxe.map((axe) => (
                  <text
                    key={axe.week}
                    className="fm__axelab"
                    x={lx(axe.week)}
                    y={LEDGER_H - 8}
                    textAnchor="middle"
                  >
                    {axe.label}
                  </text>
                ))}
                <text className="fm__axelab" x={LEDGER_PL + 2} y={LEDGER_PT - 16}>
                  LINES/WK · {n0(ledgerMax)}
                </text>
              </svg>
              <figcaption className="fm__caption">
                <span className="fm__caption-k">FIG 1</span> the ledger, the model
                walked over it, and the twelve weeks the foreman signs its name to.
                Season shape and events are fixture data, the only thing fitted is the line.
              </figcaption>
            </div>

            <div className="fm__stages">
              {[
                { n: "01", name: "calendar lift", note: "season + events off the raw ledger, a tent sale is not a trend" },
                { n: "02", name: "smoothing", note: `exponential, α ${FORECAST_CONFIG.alpha.toFixed(2)}, on the plain week's demand` },
                { n: "03", name: "trend", note: `OLS level line: ${n0(fc.trend.base)} + ${n1(fc.trend.slopePerWeek)} lines/wk` },
                { n: "04", name: "calendar back", note: "the horizon re-dresses each week in its own season and events" },
                { n: "05", name: "zone split", note: "× five runs, by velocity share" },
              ].map((stage, i) => (
                <Reveal key={stage.n} delay={i * 60}>
                  <div className="fm__stage">
                    <span className="fm__stage-n mono">{stage.n}</span>
                    <h3 className="fm__stage-name">{stage.name}</h3>
                    <p className="fm__stage-note">{stage.note}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- 02 · forecast vs the week that happened ---------- */}
        <section className="section section--pad" id="realized">
          <div className="wrp">
            <Reveal>
              <p className="eyebrow">
                <span className="eyebrow--signal">02</span>, forecast vs the week that happened
              </p>
              <h2 className="display fm__title">
                The forecast, then the seeded week, scored against it.
              </h2>
              <p className="lede fm__lede">
                Lines are the plan&apos;s forecast. Dots are the realization . 
                the same forecast hit by a seeded jolt of ±
                {(BRAMBLE.actualNoiseAmplitude * 100).toFixed(1)}% per
                zone-week, drawn in a frozen order. The realization is a fixture:{" "}
                seed {BRAMBLE.actualSeed}, same tickets on any machine. Error
                travels with the volume, never with the minutes, the standards
                stay pinned while the tickets move.
              </p>
            </Reveal>

            <div className="fm__runs">
              {RUNS.map((run, i) => (
                <Reveal key={run.code} delay={i * 70}>
                  <RunChart run={run} />
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- 03 · the plan, seen as heat ---------- */}
        <section className="section" id="heat">
          <div className="wrp">
            <Reveal>
              <p className="eyebrow">
                <span className="eyebrow--signal">03</span>, the plan as heat
              </p>
              <h2 className="display fm__title">
                Paid hours by shift × run, week by week.
              </h2>
              <p className="lede fm__lede">
                Every cell is paid hours the casing assigned: {FIRST_WEEK} →{" "}
                {FIRST_WEEK + WEEKS - 1}, ten rows (five runs × two shifts), one
                bench behind it ({BAND_IDS.length} bands, 248 paid hours/week at
                full draw). The bench holds: no cell consumes a pool it does not
                belong to, and the hottest cells land on the surge weeks.
              </p>
            </Reveal>

            <div className="fm__heat" role="table" aria-label="paid hours by run, shift and week">
              <div className="fm__heat-row fm__heat-row--head">
                <span className="fm__heat-zone fm__heat-zone--head">RUN · SHIFT</span>
                {Array.from({ length: WEEKS }, (_, i) => (
                  <span
                    key={i}
                    className={`fm__heat-week ${FIRST_WEEK + i === PEAK_WEEK ? "fm__heat-week--peak" : ""}`}
                  >
                    {FIRST_WEEK + i}
                  </span>
                ))}
              </div>
              {heatRows.map((row) => (
                <div key={`${row.zone}-${row.shift}`} className="fm__heat-row">
                  <span className="fm__heat-zone">
                    <span className="fm__heat-run">
                      {row.runName} <span className="mono fm__heat-code">{row.zone}</span>
                    </span>
                    <span className="fm__heat-shift">{row.shift}</span>
                  </span>
                  {row.cells.map((paid, i) => (
                    <span
                      key={i}
                      className={`fm__cell ${FIRST_WEEK + i === PEAK_WEEK ? "fm__cell--peak" : ""}`}
                      style={{
                        backgroundColor:
                          `color-mix(in srgb, var(--signal) ${(
                            (0.1 + 0.9 * (paid / heatMax)) * 100
                          ).toFixed(1)}%, var(--paper))`,
                      }}
                      title={`${row.zone} ${row.shift} wk ${FIRST_WEEK + i}: ${n1(paid)} paid h`}
                    />
                  ))}
                </div>
              ))}
              <div className="fm__heat-legend">
                <span>the bench, lightly used</span>
                {[0, 0.25, 0.5, 0.75, 1].map((v) => (
                  <span
                    key={v}
                    className="fm__heat-swatch"
                    style={{
                      backgroundColor: `color-mix(in srgb, var(--signal) ${((0.1 + 0.9 * v) * 100).toFixed(1)}%, var(--paper))`,
                    }}
                  />
                ))}
                <span>the counter at full draw</span>
              </div>
            </div>
          </div>
        </section>

        {/* ---------- 04 · the waterfalls ---------- */}
        <section className="section section--pad" id="waterfalls">
          <div className="wrp">
            <Reveal>
              <p className="eyebrow">
                <span className="eyebrow--signal">04</span>, the variance waterfalls
              </p>
              <h2 className="display fm__title">
                The noise is the whole bridge.
              </h2>
              <p className="lede fm__lede">
                Forecast hours, the seeded week&apos;s noise, actual hours . 
                consumed through the same northspan standards both sides. The
                whole gap is the noise:{" "}
                {report.hoursGap >= 0 ? "+" : ""}
                {n1(report.hoursGap)} standard hours DC-wide. No zone wanders
                past its own amplitude. Variance moves volume; it never moves
                the minutes per line.
              </p>
            </Reveal>

            <div className="fm__falls">
              {RUNS.map((run, i) => (
                <Reveal key={run.code} delay={i * 70}>
                  <FallChart run={run} />
                </Reveal>
              ))}
            </div>

            <Reveal>
              <div className="fm__scope-note">
                <span className="fm__caption-k">TOTALS</span>
                <span className="mono">
                  forecast {n0(report.totalForecastLines)} lines · actual{" "}
                  {n0(report.totalActualLines)} lines · hours gap{" "}
                  {report.hoursGap >= 0 ? "+" : ""}
                  {n1(report.hoursGap)} h · seed {BRAMBLE.actualSeed}
                </span>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ---------- 05 · the peak week, cased ---------- */}
        <section className="section" id="cased">
          <div className="wrp">
            <Reveal>
              <p className="eyebrow">
                <span className="eyebrow--signal">05</span>, the peak week, cased
              </p>
              <h2 className="display fm__title">
                Week {PEAK_WEEK}, the Anniversary, worked to the hour.
              </h2>
              <p className="lede fm__lede">
                {n0(fc.total[peakWeekIndex])} forecast lines → {" "}
                {n1(weeklyTotals[peakWeekIndex])} standard hours → {" "}
                {n1(peakPaid)} paid hours against a 248-hour bench (
                {(utilizationPeak * 100).toFixed(1)}% draw). The casing worked
                every task to exactly its forecast: no spill, no under-coverage,
                no band below a floor.
              </p>
            </Reveal>

            <div className="fm__table-wrap">
              <table className="fm__table">
                <thead>
                  <tr>
                    <th>RUN</th>
                    <th>SHIFT</th>
                    <th>BAND</th>
                    <th className="num">STD H</th>
                    <th className="num">PAID H</th>
                    <th className="num">MULTIPLE</th>
                    <th className="num">HEAD</th>
                  </tr>
                </thead>
                <tbody>
                  {anniversary.map((row) => {
                    const multiple = row.paidHours / row.standardHours;
                    return (
                      <tr key={`${row.zone}-${row.shift}-${row.band}`}>
                        <td>{ZONE_STANDARDS.find((s) => s.zone === row.zone)!.runName} <span className="mono">{row.zone}</span></td>
                        <td>{row.shift}</td>
                        <td>
                          {row.band}
                          {row.spilled ? <span className="fm__spill"> · spill</span> : null}
                        </td>
                        <td className="num">{row.standardHours.toFixed(2)}</td>
                        <td className="num">{row.paidHours.toFixed(2)}</td>
                        <td className="num">×{multiple.toFixed(2)}</td>
                        <td className="num">{row.headcount}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>week {PEAK_WEEK}, all shifts</td>
                    <td className="num">
                      {anniversary.reduce((s, r) => s + r.standardHours, 0).toFixed(2)}
                    </td>
                    <td className="num">
                      {anniversary.reduce((s, r) => s + r.paidHours, 0).toFixed(2)}
                    </td>
                    <td className="num">. </td>
                    <td className="num">
                      {anniversary.reduce((s, r) => s + r.headcount, 0)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="fm__floors">
              <p className="fm__floors-note">
                <span className="fm__caption-k">FLOORS</span>
                Cinder anchors on veterans and takes nobody weaker
                (<span className="mono">{allowedFor("CIN").join(" ")}</span>); the
                flow runs take day band or better; Cobalt tolerates the night
                desk. Covering one standard hour at a band&apos;s factor costs
                <span className="mono"> 1 / factor </span> paid hours, the
                conversion the whole bench rides on.
              </p>
            </div>
          </div>
        </section>

        {/* ---------- 06 · what the standards did ---------- */}
        <section className="section section--pad" id="standards">
          <div className="wrp">
            <Reveal>
              <p className="eyebrow">
                <span className="eyebrow--signal">06</span>, what the standards did
              </p>
              <h2 className="display fm__title">
                Sheet 05&apos;s five numbers, priced across twelve weeks.
              </h2>
              <p className="lede fm__lede">
                The labor plan exists because the standards exist. Every hour
                this page prints converts ticket volume through northspan&apos;s
                counter-refill table, consumed verbatim:{" "}
                <span className="mono">
                  hours = lines × minutes-per-line ÷ 60 + supplement
                </span>
                . The tie-out below reads both engines&apos; numbers and holds.
              </p>
            </Reveal>

            <div className="fm__tie">
              {tieOut.map((row) => (
                <div key={row.zone} className={`fm__tie-row ${row.ok ? "" : "fm__tie-row--fail"}`}>
                  <span className="fm__tie-run">
                    {row.run} <span className="mono">{row.zone}</span>
                  </span>
                  <span className="mono fm__tie-num">{row.mpl.toFixed(3)}</span>
                  <span className="mono fm__tie-num">min/line</span>
                  <span className={`fm__tie-ok ${row.ok ? "" : "fm__tie-ok--fail"}`}>
                    {row.ok ? "matches northspan ✓" : "DRIFT"}
                  </span>
                </div>
              ))}
            </div>

            <Reveal>
              <div className="fm__northspan">
                <div>
                  <p className="fm__tie-run">
                    The standards&apos; home is{" "}
                    <a
                      className="wl-link"
                      href="https://github.com/SukrutN/northspan"
                      target="_blank"
                      rel="noreferrer"
                    >
                      northspan · sheet 05 ↗
                    </a>
                    : the same five MPL values locked in its characterization
                    bench, its site&apos;s standards page, and here, no new
                    constants anywhere on this row of the family tree.
                  </p>
                </div>
                <div>
                  <span className="fm__caption-k">SUPPLEMENT</span>
                  <p className="fm__stage-note">
                    One fixed hour per run-week for counting, housekeeping, and
                    receipt. It rides whichever band covers the task, fixed
                    time is fixed time.
                  </p>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ---------- 07 · fences + lineage ---------- */}
        <section className="section section--pad" id="fences">
          <div className="wrp">
            <Reveal>
              <p className="eyebrow">
                <span className="eyebrow--signal">07</span>, scope &amp; lineage
              </p>
              <h2 className="display fm__title">
                One planner, four fences, three sources.
              </h2>
            </Reveal>

            <div className="fm__fences">
              {[
                {
                  n: "01",
                  name: "No HR detail",
                  body: "Skill bands and weekly hour caps only. No names, no rosters, no leave policy, the pool is a sheet of capacity, not a crew list.",
                },
                {
                  n: "02",
                  name: "No WES coupling yet",
                  body: "The release seam to despatch-wes (sheet 02) is left open: the foreman reads forecasts and standards, and writes none of the lanes. When the WES wants a plan, it asks for rows.",
                },
                {
                  n: "03",
                  name: "The book is data",
                  body: "The season shape and the known events are fixture lines, never refit. The only thing this engine estimates is the level line under them.",
                },
                {
                  n: "04",
                  name: "One DC, one pool",
                  body: "Bramble & Twine, Meadowfield, one bench. Multi-site balancing is a later sheet's problem, and this engine refuses to quietly solve it.",
                },
              ].map((fence, i) => (
                <Reveal key={fence.n} delay={i * 60}>
                  <div className="fm__fence">
                    <span className="fm__fence-n mono">{fence.n}</span>
                    <div>
                      <h3 className="fm__fence-name">{fence.name}</h3>
                      <p className="fm__fence-body">{fence.body}</p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>

            <Reveal>
              <div className="fm__lineage">
                <div>
                  <span className="fm__caption-k">LINEAGE</span>
                  <ul className="fm__lineage-list">
                    <li>
                      <a
                        className="wl-link"
                        href="https://ecommons.cornell.edu"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Labuskes 1998, Cornell ↗
                      </a>{" "}
                     , the staged method&apos;s skeleton: smoothing → trend →
                      seasonality → calendar. The one honest re-order here lifts
                      the known calendar before the smoothing, so a tent sale
                      never reads as a trend.
                    </li>
                    <li>
                      <a
                        className="wl-link"
                        href="https://www.warehouse-science.com"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Bartholdi &amp; Hackman 0.98.1 ↗
                      </a>{" "}
                     . <em>Warehouse &amp; Distribution Science</em>; the
                      standards → workload → coverage chain this engine rides.
                    </li>
                    <li>
                      <a
                        className="wl-link"
                        href="https://github.com/SukrutN/northspan"
                        target="_blank"
                        rel="noreferrer"
                      >
                        northspan-engine, sheet 05 ↗
                      </a>{" "}
                     , the standards&apos; home. Pointless without them,
                      delightful with them.
                    </li>
                  </ul>
                </div>
              </div>
            </Reveal>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
