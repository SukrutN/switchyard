import type { Metadata } from "next";

import SiteHeader from "../components/SiteHeader";
import SiteFooter from "../components/SiteFooter";
import Reveal from "../components/Reveal";
import "../components/hero.css"; /* the shared banner + button voice */
import "./components/boxcar.css";
import "./components/packhall.css";

import HeroCarton from "./components/HeroCarton";
import PackHall from "./components/PackHall";
import { boxFaces, project } from "./components/iso";
import type { IsoBox } from "./components/iso";

/* the engine: everything below is its output, judged by its tests */
import {
  pack,
  validateSolution,
  CARTON_PENALTY,
  MARGIN_WEIGHT,
  STABILITY_RATIO,
} from "@/engine/boxcar-engine/index.ts";
import type {
  ShipSolution,
  ValidationReport,
} from "@/engine/boxcar-engine/index.ts";
import { PROFILES } from "@/engine/boxcar-engine/fixtures/orders.ts";
import {
  CARTON_LIBRARY,
  CARTON_LIBRARY_RAW,
} from "@/engine/boxcar-engine/fixtures/cartons.ts";
import bench from "@/engine/boxcar-engine/bench/results.json";

export const metadata: Metadata = {
  title: "boxcar · unit-04, the pack-out solver",
  description:
    "Cartonization from the switchyard family: carton selection, 3D placements, and a validation report where no-floating is a test, not a feature. Fixed-point arithmetic, zero dependencies, byte-stable.",
};

/* ---------- build-time pack-out: the page's whole ledger ----------
   pack(·) runs here, at build; the static bytes the site ships are
   the same bytes npm test grades against fixtures/expected.ts. */

const HALL_PROFILES = PROFILES.map((p) => ({
  key: p.key,
  label: p.label,
  short: {
    "order-feather": "featherweight",
    "order-dense": "dense cubes",
    "order-awkward": "mixed awkward",
  }[p.key] ?? p.key,
}));

const solutions: Record<string, ShipSolution> = Object.fromEntries(
  PROFILES.map((p) => [p.key, pack(p.order, CARTON_LIBRARY)]),
);

const reports: Record<string, ValidationReport> = Object.fromEntries(
  PROFILES.map((p) => [p.key, validateSolution(solutions[p.key])]),
);

const HERO_CARTON =
  CARTON_LIBRARY_RAW.find((c) => c.id === "MD-4025") ?? CARTON_LIBRARY_RAW[0];

/* ---------- iso helpers for the fix glyphs ----------
   Scenes are drawn in cm; boxFaces takes ticks, so ×100 once, exactly
   like the fixtures do. No floating numbers style themselves. */

const P = (x: number, y: number, z: number): string => {
  const p = project(x, y, z);
  return `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
};

const LP = (pts: [number, number, number][]): string =>
  pts.map(([x, y, z]) => P(x, y, z)).join(" ");

/** viewBox padded around everything a scene actually draws. */
function cam(parts: string[], pad = 9): string {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const part of parts) {
    for (const pair of part.split(" ")) {
      const [u, w] = pair.split(",").map(Number);
      xs.push(u);
      ys.push(w);
    }
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(...xs) - minX;
  const height = Math.max(...ys) - minY;
  return `${(minX - pad).toFixed(2)} ${(minY - pad).toFixed(2)} ${(width + pad * 2).toFixed(2)} ${(height + pad * 2).toFixed(2)}`;
}

/* fix 01, the naive result floats; the admitted one rests */
const F1_GHOST = boxFaces({
  unit: { sku: "FLOATS" },
  pos: { x: 3000, y: 300, z: 1700 },
  dims: { x: 2000, y: 1400, z: 700 },
});
const F1_REAL = boxFaces({
  unit: { sku: "SETTLED" },
  pos: { x: 200, y: 200, z: 0 },
  dims: { x: 2600, y: 2000, z: 900 },
});
const F1_FLOOR = LP([
  [0, 0, 0],
  [36, 0, 0],
  [36, 24, 0],
  [0, 24, 0],
]);
const F1_LINE = LP([
  [40, 10, 16.8],
  [40, 10, 0.4],
]);
const F1_HEAD = LP([
  [40, 10, 0],
  [39.25, 10, 3.1],
  [40.75, 10, 3.1],
]);
const F1_VIEW = cam([
  F1_FLOOR,
  ...F1_GHOST.faces.map((f) => f.points),
  ...F1_REAL.faces.map((f) => f.points),
  F1_LINE,
  F1_HEAD,
]);

/* fix 02, weight flows down the support chain */
const F2_BOTTOM = boxFaces({
  unit: { sku: "CART-500" },
  pos: { x: 300, y: 300, z: 0 },
  dims: { x: 2400, y: 2400, z: 900 },
});
const F2_TOP = boxFaces({
  unit: { sku: "JAR-400" },
  pos: { x: 700, y: 700, z: 900 },
  dims: { x: 1800, y: 1800, z: 700 },
});
const F2_FLOOR = LP([
  [0, 0, 0],
  [34, 0, 0],
  [34, 30, 0],
  [0, 30, 0],
]);
const F2_LINE = LP([
  [29, 15, 18.6],
  [29, 15, -0.2],
]);
const F2_HEAD = LP([
  [29, 15, -1.9],
  [28.3, 15, 1.4],
  [29.7, 15, 1.4],
]);
const F2_VIEW = cam([
  F2_FLOOR,
  ...F2_BOTTOM.faces.map((f) => f.points),
  ...F2_TOP.faces.map((f) => f.points),
  F2_LINE,
  F2_HEAD,
]);

/* fix 03, a lid mostly off the ridge is refused at the gate */
const F3_BASE = boxFaces({
  unit: { sku: "base" },
  pos: { x: 200, y: 200, z: 0 },
  dims: { x: 2600, y: 2000, z: 800 },
});
const F3_LID = boxFaces({
  unit: { sku: "lid" },
  pos: { x: 2000, y: 400, z: 800 },
  dims: { x: 2200, y: 1600, z: 800 },
});
const F3_FLOOR = LP([
  [0, 0, 0],
  [32, 0, 0],
  [32, 26, 0],
  [0, 26, 0],
]);
const F3_CROSS: [string, string] = [
  LP([
    [20, 4, 16],
    [42, 20, 16],
  ]),
  LP([
    [42, 4, 16],
    [20, 20, 16],
  ]),
];
const F3_VIEW = cam(
  [
    F3_FLOOR,
    ...F3_BASE.faces.map((f) => f.points),
    ...F3_LID.faces.map((f) => f.points),
    ...F3_CROSS,
  ],
  13,
);

/* the share this drawn geometry really has: overlap / lid footprint.
   Computed from the same cells the lid was drawn with, then graded
   against STABILITY_RATIO in the caption, refused either way. */
const F3_CELLS = { base: [2, 2, 26, 20], lid: [20, 4, 22, 16] };
const f3Share = (() => {
  const overlap = Math.min(
    F3_CELLS.lid[0] + F3_CELLS.lid[2],
    F3_CELLS.base[0] + F3_CELLS.base[2],
  ) - Math.max(F3_CELLS.lid[0], F3_CELLS.base[0]);
  const overlapY = Math.min(
    F3_CELLS.lid[1] + F3_CELLS.lid[3],
    F3_CELLS.base[1] + F3_CELLS.base[3],
  ) - Math.max(F3_CELLS.lid[1], F3_CELLS.base[1]);
  return (overlap * overlapY) / (F3_CELLS.lid[2] * F3_CELLS.lid[3]);
})();

/* curtains: the tick strip of the five-carton library */
const libTick = CARTON_LIBRARY_RAW.map((c) => ({
  op: c.id,
  text: `${c.name} · ${c.dims.x.toFixed(1)}×${c.dims.y.toFixed(1)}×${c.dims.z.toFixed(1)} cm · payload ${c.payloadKg.toFixed(1)} kg`,
  signal: c.id === "XL-6050",
}));

const ENGINE_README =
  "https://github.com/SukrutN/switchyard-site/blob/main/engine/boxcar-engine/README.md";

/* the selector's law, quoted with the constants' own values . 
   change src/constants.ts and the sheet repoints itself. */
const LAWSHEET = `/* the run score, src/constants.ts */
F = util + ${MARGIN_WEIGHT} × margin − ${CARTON_PENALTY}

  orphaned ?  →  the run is vetoed
  empty run? →  never beats a productive one
  tie       →  most boxes placed, then the smaller carton

STABILITY_RATIO = ${STABILITY_RATIO}  /* share of its own
                          footprint that must touch */

merge: standard ↔ fragile co-pack
       hazard rides alone, the table is the law`;

export default function BoxcarPage() {
  return (
    <>
      <SiteHeader cross />
      <main>
        {/* ---------- hero ---------- */}
        <section className="section bc-hero bp-grid" id="top">
          <div className="wrp">
            <div className="hero__tags">
              <div className="hero__tag">
                <div className="hero__tag__k">UNIT</div>
                <div className="hero__tag__v">04 · CARTONIZATION</div>
              </div>
              <div className="hero__tag">
                <div className="hero__tag__k">ARITHMETIC</div>
                <div className="hero__tag__v">FIXED-POINT · 0.01 CM</div>
              </div>
              <div className="hero__tag hero__tag--right">
                <div className="hero__tag__k">DEPENDENCIES</div>
                <div className="hero__tag__v">ZERO</div>
              </div>
              <div className="hero__tag hero__tag--right">
                <div className="hero__tag__k">FAMILIES</div>
                <div className="hero__tag__v hero__tag__v--signal">
                  STANDARD · FRAGILE · HAZARD
                </div>
              </div>
            </div>

            <div className="hero__grid">
              <div>
                <p className="eyebrow">boxcar, the pack-out family</p>
                <h1 className="display hero__claim">
                  <span className="hero__line">
                    <span style={{ "--d": "0ms" } as React.CSSProperties}>
                      pick the carton,
                    </span>
                  </span>
                  <span className="hero__line">
                    <span style={{ "--d": "90ms" } as React.CSSProperties}>
                      settle every box,
                    </span>
                  </span>
                  <span className="hero__line">
                    <span style={{ "--d": "180ms" } as React.CSSProperties}>
                      <em>prove the pack-out.</em>
                    </span>
                  </span>
                </h1>

                <p className="lede hero__lede">
                  An order sheet and a five-carton library become placements:
                  gravity-settled, load-rated, stability-checked, and stamped
                  with a validation report where no-floating is a test, not a
                  feature. Same order bytes in, same solution bytes out.
                </p>

                <div className="hero__cta">
                  <a className="btn" href="#hall">
                    <span className="btn__text">
                      <span>Open the pack hall</span>
                      <span aria-hidden="true">Open the pack hall</span>
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
              </div>

              <div className="bc-hero__rig">
                <HeroCarton carton={HERO_CARTON} />
                <p className="bc-hero__rig-note mono">
                  drawn from fixtures/cartons.ts, the library the engine
                  packs into
                </p>
              </div>
            </div>
          </div>

          {/* the strip: five cartons, real inner dims */}
          <div className="tick" aria-hidden="true">
            <div className="tick__track">
              {libTick.map((t) => (
                <span
                  key={t.op}
                  className={`tick__item ${t.signal ? "tick__item--signal" : ""}`}
                >
                  <span className="tick__op">{t.op}</span> {t.text}
                  <i className="tick__dash" />
                </span>
              ))}
              {libTick.map((t) => (
                <span
                  key={`${t.op}-2`}
                  className={`tick__item ${t.signal ? "tick__item--signal" : ""}`}
                >
                  <span className="tick__op">{t.op}</span> {t.text}
                  <i className="tick__dash" />
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- the three fixes ---------- */}
        <section className="section section--pad" id="fixes">
          <div className="wrp">
            <p className="eyebrow">
              <span className="eyebrow--signal">01</span> · the three fixes
            </p>
            <h2 className="display bc__title" data-anim="wipe">
              <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
                <span className="wl__t">The fixes that matter,</span>
              </span>
              <span className="wl" style={{ "--i": 1 } as React.CSSProperties}>
                <span className="wl__t">kept in the engine.</span>
              </span>
            </h2>
            <p className="lede bc__lede" data-fill>
              Hand-rolled packers fail three exact ways: boxes float in
              mid-air, supports carry past their rating, and lids rest on
              ridges they barely touch, boxcar closes each one behind an
              admission gate, and a report line, so you can grade the gate.
            </p>

            <div className="bc__fix-grid">
              <Reveal>
                <article className="bc__fix">
                  <span className="bc__fix-n mono">fix 01</span>
                  <h3 className="bc__fix-name display">
                    gravity is an admission gate
                  </h3>
                  <GlyphFloat />
                  <p className="bc__glyph-cap mono">
                    FLOATING · one report line per box
                  </p>
                  <p className="bc__fix-body" data-fill>
                    Placements drop to the top of the support stack actually
                    beneath them before they are admitted. The base py3dbp
                    results can hang boxes in mid-air; none of this engine's
                    solutions can, and the validator proves it box by box.
                  </p>
                </article>
              </Reveal>

              <Reveal delay={90}>
                <article className="bc__fix">
                  <span className="bc__fix-n mono">fix 02</span>
                  <h3 className="bc__fix-name display">
                    load flows down the chain
                  </h3>
                  <GlyphLoad />
                  <p className="bc__glyph-cap mono">
                    LOAD · rated exceedance splits to another carton
                  </p>
                  <p className="bc__fix-body" data-fill>
                    Weight moves through contact shares that renormalize to
                    one, so a unit never carries past its rated{" "}
                    <span className="mono">maxLoad</span>. The exceedance
                    case opens a fresh carton instead of quietly violating.
                  </p>
                </article>
              </Reveal>

              <Reveal delay={180}>
                <article className="bc__fix">
                  <span className="bc__fix-n mono">fix 03</span>
                  <h3 className="bc__fix-name display">
                    rest on the footprint, or refuse
                  </h3>
                  <GlyphStable />
                  <p className="bc__glyph-cap mono">
                    contact share {(f3Share * 100).toFixed(0)}% &lt;{" "}
                    {(STABILITY_RATIO * 100).toFixed(0)}% → refused at the
                    gate
                  </p>
                  <p className="bc__fix-body" data-fill>
                    A placement needs at least {STABILITY_RATIO} of its own
                    footprint really touching floor or support . {" "}
                    <span className="mono">STABILITY_RATIO</span> in the
                    constants file. A lid overhanging a ridge is refused on
                    admission, not forgiven at the validator.
                  </p>
                </article>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ---------- the pack hall ---------- */}
        <section className="section section--pad bc-hall" id="hall">
          <div className="wrp">
            <p className="eyebrow">
              <span className="eyebrow--signal">02</span> · the pack hall
            </p>
            <h2 className="display bc__title" data-anim="wipe">
              <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
                <span className="wl__t">One sheet, three ships.</span>
              </span>
            </h2>
            <p className="lede bc__lede" data-fill>
              The characterization trio, packed live in your browser by the
              same deterministic engine the tests grade. Flip between
              profiles, page through cartons, and read the wire format the
              waybill family would carry.
            </p>

            <PackHall profiles={HALL_PROFILES} solutions={solutions} reports={reports} />

            {/* the locked sheet, from this build's own pack(·) output */}
            <table className="bc__table" aria-label="the characterization trio">
              <thead>
                <tr>
                  <th>order wave</th>
                  <th>profile key</th>
                  <th>cartons</th>
                  <th>templates</th>
                  <th>cube util.</th>
                  <th>worst margin</th>
                  <th>score</th>
                </tr>
              </thead>
              <tbody>
                {HALL_PROFILES.map((p) => {
                  const s = solutions[p.key];
                  return (
                    <tr key={p.key}>
                      <td>{p.label}</td>
                      <td>{p.key}</td>
                      <td>{s.cartons.length}</td>
                      <td>
                        {s.cartons
                          .map((c) => c.template.id)
                          .join(" + ")}
                      </td>
                      <td>{(s.cubeUtilization * 100).toFixed(1)}%</td>
                      <td>
                        {(s.weightMargin * 100).toFixed(0)}%
                      </td>
                      <td>{s.score.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="bc__note mono">
              the same figures are pinned in fixtures/expected.ts and held to
              ±0.006 by tests/characterization.test.ts, the table above is
              this build's own pack(·) call, not a transcription.
            </p>
          </div>
        </section>

        {/* ---------- the selector law ---------- */}
        <section className="section section--pad" id="law">
          <div className="wrp bc-law__grid">
            <div>
              <p className="eyebrow">
                <span className="eyebrow--signal">03</span> · the selector
              </p>
              <h2 className="display bc__title" data-anim="wipe">
                <span
                  className="wl"
                  style={{ "--i": 0 } as React.CSSProperties}
                >
                  <span className="wl__t">One score</span>
                </span>
                <span
                  className="wl"
                  style={{ "--i": 1 } as React.CSSProperties}
                >
                  <span className="wl__t">runs the shelf.</span>
                </span>
              </h2>
              <p className="lede bc__lede" data-fill>
                Every template in the library gets a saturated run, repeat
                passes in canonical bigger-first order until nothing
                converts. The score is cube utilization plus a
                weight-margin term, minus a small penalty per opened carton:
                fill quality outranks box count, but the last lonely unit
                doesn't blow open a warehouse.
              </p>
              <p className="bc__law-note" data-fill>
                Two rules sit above the score. The orphan veto: a run that
                strands a unit no template could ever carry loses to any run
                that completes the order. And an empty run never wins . 
                without that tripwire, a phantom weight margin out of an
                empty box would beat honest work, so the packer reports the
                stranding under <span className="mono">unfilled</span> and
                moves on.
              </p>
            </div>

            <pre className="bc__law" aria-label="the run score, as code">
              {LAWSHEET}
            </pre>
          </div>
        </section>

        {/* ---------- the bench: dark, honest, timestamped by data ---------- */}
        <section className="section section--pad console" id="bench">
          <div className="wrp">
            <p className="eyebrow">
              <span className="eyebrow--signal">04</span> · the bench
            </p>
            <h2 className="display bc__title" data-anim="wipe">
              <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
                <span className="wl__t">Fast, and</span>
              </span>
              <span className="wl" style={{ "--i": 1 } as React.CSSProperties}>
                <span className="wl__t">byte-stable.</span>
              </span>
            </h2>
            <p className="lede bc__lede" data-fill>
              Placement runtime against order-line count, re-measured until
              it stopped moving. Every row re-checks byte-level
              determinism: two packs of the same order must be identical,
              or the row can't call itself a result.
            </p>

            <BenchSpark />

            <table className="bc__table" aria-label="bench results, median of three">
              <thead>
                <tr>
                  <th>lines</th>
                  <th>units</th>
                  <th>cartons</th>
                  <th>cube util.</th>
                  <th>pack ms</th>
                  <th>validate ms</th>
                  <th>stable</th>
                </tr>
              </thead>
              <tbody>
                {bench.runs.map((r) => (
                  <tr key={r.lines}>
                    <td>{r.lines}</td>
                    <td>{r.units}</td>
                    <td>{r.cartons}</td>
                    <td>{(r.cubeUtilization * 100).toFixed(1)}%</td>
                    <td>{r.packMs.toFixed(2)}</td>
                    <td>{r.validateMs.toFixed(2)}</td>
                    <td>
                      {r.deterministic ? (
                        <span className="bc__ok">✓</span>
                      ) : (
                        ". "
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="bc__note mono">
              {bench.note} · bench run dated {bench.generated} · read from
              bench/results.json, the committed artifact
            </p>
          </div>
        </section>

        {/* ---------- fences + lineage ---------- */}
        <section className="section section--pad" id="fences">
          <div className="wrp">
            <p className="eyebrow">
              <span className="eyebrow--signal">05</span> · scope & lineage
            </p>
            <h2 className="display bc__title" data-anim="wipe">
              <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
                <span className="wl__t">Some doors</span>
              </span>
              <span className="wl" style={{ "--i": 1 } as React.CSSProperties}>
                <span className="wl__t">stay shut.</span>
              </span>
            </h2>
            <p className="lede bc__lede" data-fill>
              The family sheet drew the scope fences before the first line
              of solver code. They are what keep one unit small enough to
              read in an afternoon, and honest about what it is.
            </p>

            <div className="bc__fences">
              <div className="bc__fence">
                <span className="bc__fence-n mono">01</span>
                <div>
                  <h3 className="bc__fence-name">No label printing</h3>
                  <p className="bc__fence-body">
                    The waybill family carries labels; boxcar's decision
                    travels to it as the ship-solution JSON, cartons, boxes,
                    supports, margins. One job per unit.
                  </p>
                </div>
              </div>
              <div className="bc__fence">
                <span className="bc__fence-n mono">02</span>
                <div>
                  <h3 className="bc__fence-name">No rate shopping</h3>
                  <p className="bc__fence-body">
                    Carriers and tariffs never enter the room. Which box the
                    goods ride in is the whole assignment.
                  </p>
                </div>
              </div>
              <div className="bc__fence">
                <span className="bc__fence-n mono">03</span>
                <div>
                  <h3 className="bc__fence-name">Heuristic only</h3>
                  <p className="bc__fence-body">
                    No exact MIP in here. The exact frontier belongs to the
                    Martello–Pisinger–Vigo (2000) formulation and{" "}
                    <a
                      href="https://developers.google.com/optimization"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Google OR-Tools
                    </a>
                    ; when a business needs a provable optimum on hard
                    instances, that is the door, and the validation report
                    stays as the judge.
                  </p>
                </div>
              </div>
              <div className="bc__fence">
                <span className="bc__fence-n mono">04</span>
                <div>
                  <h3 className="bc__fence-name">Zero runtime dependencies</h3>
                  <p className="bc__fence-body">
                    Fixed-point arithmetic end to end. 0.01&nbsp;cm ticks,
                    integer grams, so floats never drift inside the solver
                    and the site ships the same solution bytes the tests
                    grade.{" "}
                    <a
                      href="https://github.com/SukrutN/switchyard-site/blob/main/package.json"
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span className="mono">npm test</span>
                    </a>{" "}
                    keeps it that way.
                  </p>
                </div>
              </div>
            </div>

            <div className="bc__git">
              <p className="bc__git-head">lineage, sources read, credited</p>
              <div className="bc__git-row">
                <span className="mono">enzoruiz/3dbinpacking · py3dbp (MIT)</span>{" "}
               , the anchor-point loop this engine descends from;{" "}
                <a
                  href="https://github.com/enzoruiz/3dbinpacking"
                  target="_blank"
                  rel="noreferrer"
                >
                  repository
                </a>
                . Its plain results float; ours can't.
              </div>
              <div className="bc__git-row">
                <span className="mono">jerry800416/3D-bin-packing (MIT)</span>, the
                gravity, load-bearing and stability fixes, retold in
                TypeScript:{" "}
                <a
                  href="https://github.com/jerry800416/3D-bin-packing"
                  target="_blank"
                  rel="noreferrer"
                >
                  repository
                </a>
                .
              </div>
              <div className="bc__git-row">
                <span className="mono">skjolber/3d-bin-container-packing (Apache-2.0)</span>{" "}
               , reasons-on-results engineering culture, borrowed to build
                the validation bench:{" "}
                <a
                  href="http://skjolber.github.io/3d-bin-container-packing/"
                  target="_blank"
                  rel="noreferrer"
                >
                  site
                </a>
                .
              </div>
              <div className="bc__git-row">
                <span className="mono">
                  Martello, Pisinger & Vigo (2000), Operations Research 48(2)
                </span>{" "}
               , the exact lineage a serious heuristic nods to:{" "}
                <a
                  href="https://doi.org/10.1287/opre.48.2.256.12363"
                  target="_blank"
                  rel="noreferrer"
                >
                  the paper
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
   the three glyph scenes, drawn, not decoratted: geometry the
   gate really computes, projected by the same iso.ts the pack
   hall shares.
   ============================================================ */

function GlyphFace({ box }: { box: IsoBox }) {
  return (
    <>
      {box.faces.map((f) => (
        <polygon
          key={f.side}
          className={`bc__f bc__f--${f.side}`}
          points={f.points}
        />
      ))}
      {box.label ? (
        <text className="fx__sku" x={box.label.x} y={box.label.y}>
          {box.label.text}
        </text>
      ) : null}
    </>
  );
}

function GlyphFloat() {
  return (
    <svg className="bc__glyph" viewBox={F1_VIEW} role="img" aria-label="a floating draft refused, a settled box resting on the floor">
      <polygon className="fx__floor" points={F1_FLOOR} />
      <polyline className="fx__fall" points={F1_LINE} />
      <g className="bc__ghost">
        <GlyphFace box={F1_GHOST} />
      </g>
      <GlyphFace box={F1_REAL} />
      <polygon className="fx__head" points={F1_HEAD} />
    </svg>
  );
}

function GlyphLoad() {
  return (
    <svg className="bc__glyph" viewBox={F2_VIEW} role="img" aria-label="one box resting on another, weight pressing down the support chain">
      <polygon className="fx__floor" points={F2_FLOOR} />
      <polyline className="fx__fall" points={F2_LINE} />
      <GlyphFace box={F2_BOTTOM} />
      <GlyphFace box={F2_TOP} />
      <polygon className="fx__head" points={F2_HEAD} />
    </svg>
  );
}

function GlyphStable() {
  return (
    <svg className="bc__glyph" viewBox={F3_VIEW} role="img" aria-label="a lid overhanging a ridge, crossed out as refused">
      <polygon className="fx__floor" points={F3_FLOOR} />
      <GlyphFace box={F3_BASE} />
      <GlyphFace box={F3_LID} />
      <polyline className="fx__no" points={F3_CROSS[0]} />
      <polyline className="fx__no" points={F3_CROSS[1]} />
    </svg>
  );
}

/* the bench curve: pack(·) wall-clock against order line count */
function BenchSpark() {
  const W = 640;
  const H = 132;
  const PL = 16;
  const PR = 16;
  const PT = 22;
  const PB = 30;
  const msMax = Math.max(...bench.runs.map((r) => r.packMs));
  const sx = (i: number) =>
    PL + (i * (W - PL - PR)) / (bench.runs.length - 1);
  const sy = (ms: number) =>
    H - PB - (ms / msMax) * (H - PT - PB);
  const line = bench.runs
    .map((r, i) => `${sx(i).toFixed(1)},${sy(r.packMs).toFixed(1)}`)
    .join(" ");
  const first = bench.runs[0];
  const last = bench.runs[bench.runs.length - 1];

  return (
    <svg
      className="bc__spark"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`pack time from ${first.packMs.toFixed(2)} ms at ${first.lines} lines to ${last.packMs.toFixed(2)} ms at ${last.lines} lines`}
    >
      <polyline className="bc__spark-line" points={line} />
      <line
        className="bc__spark-axis"
        x1={PL}
        y1={H - PB}
        x2={W - PR}
        y2={H - PB}
      />
      {bench.runs.map((r, i) => (
        <circle
          key={r.lines}
          className="bc__spark-dot"
          cx={sx(i)}
          cy={sy(r.packMs)}
          r={3.2}
        >
          <title>{`${r.lines} lines · ${r.packMs.toFixed(2)} ms`}</title>
        </circle>
      ))}
      {bench.runs.map((r, i) => (
        <text
          key={`lab-${r.lines}`}
          className="bc__spark-lab"
          x={sx(i)}
          y={H - 10}
          textAnchor="middle"
        >
          {r.lines}
        </text>
      ))}
      <text
        className="bc__spark-lab bc__spark-lab--ms"
        x={sx(0) + 7}
        y={sy(first.packMs) - 8}
        textAnchor="start"
      >
        {first.packMs.toFixed(2)} ms
      </text>
      <text
        className="bc__spark-lab bc__spark-lab--ms"
        x={sx(bench.runs.length - 1) - 7}
        y={sy(last.packMs) - 8}
        textAnchor="end"
      >
        {last.packMs.toFixed(2)} ms
      </text>
    </svg>
  );
}
