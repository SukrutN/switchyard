/* ============================================================
   DCPlan, the Bramble & Twine floor as svg, one shared rig.

   Pure and stateless: the hero (server, build time) and the
   despatch hall (client, live) render the same component with
   different tour data, so a drawn tour is always the engine's
   own ledger points, never a decoration.
   ============================================================ */

import type { CatalogEntry, PickStop } from "@/engine/despatch-engine/index.ts";
import { BRAMBLE_MAP } from "@/engine/despatch-engine/fixtures/dc.ts";
import {
  DEPOT,
  PLAN,
  escTitle,
  faceDots,
  planEastX,
  planH,
  planX,
  planY,
  planRearY,
  zoneBands,
} from "./plan";

export interface PlanTour {
  readonly path: string;
  readonly tone?: "ink" | "dash" | "signal";
}

export interface DCPlanProps {
  /** the catalog's 24 pick faces, drawn soft as background grain */
  catalog?: readonly CatalogEntry[];
  /** one signal tour, sugar for `tours` */
  tour?: string;
  /** the tour's merged stops, drawn as qty-sized face dots */
  stops?: readonly PickStop[];
  /** several overlaid tours, for the before/after comparisons */
  tours?: readonly PlanTour[];
  /** stamp the tour id on the plate */
  label?: string;
  /** label of the drawn day/profile, top-left */
  tag?: string;
  className?: string;
}

export default function DCPlan({
  catalog,
  tour,
  stops,
  tours,
  label,
  tag,
  className,
}: DCPlanProps) {
  const h = planH();
  const bands = zoneBands(4);
  const faces = stops ? faceDots(stops) : [];
  const maxQty = Math.max(1, ...(stops?.map((s) => s.qty) ?? [1]));
  const aisles = Array.from({ length: BRAMBLE_MAP.aisles }, (_, i) => i + 1);
  const bayLabels = [1, 5, 10, 15, 20];
  const drawn: readonly PlanTour[] =
    tours ?? (tour ? [{ path: tour, tone: "signal" }] : []);

  return (
    <svg
      className={`dp-plan${className ? ` ${className}` : ""}`}
      viewBox={`0 0 ${PLAN.W} ${h}`}
      role="img"
      aria-label={`plan of ${BRAMBLE_MAP.name}: twelve aisles in four pick zones, depot west of aisle one${
        drawn.length ? ", cart tour drawn" : ""
      }`}
    >
      {tag ? (
        <text className="dp-plan__tag" x={8} y={16} textAnchor="start">
          {tag}
        </text>
      ) : null}

      {/* the zone bands */}
      {bands.map((b) => (
        <g key={b.zone} className="dp-plan__band">
          <rect
            className="dp-plan__band-rect"
            x={b.x}
            y={PLAN.frontY - 26}
            width={b.w}
            height={planRearY() - PLAN.frontY + 44}
          />
          <text
            className="dp-plan__zone"
            x={b.x + 4}
            y={PLAN.frontY - 24}
            textAnchor="start"
          >
            {b.label}
          </text>
        </g>
      ))}

      {/* the cross-aisles: front walk + rear passage */}
      <line
        className="dp-plan__cross"
        x1={4}
        y1={PLAN.frontY}
        x2={planEastX()}
        y2={PLAN.frontY}
      />
      <line
        className="dp-plan__cross dp-plan__cross--rear"
        x1={4}
        y1={planRearY()}
        x2={planEastX()}
        y2={planRearY()}
      />

      {/* the aisle columns */}
      {aisles.map((a) => (
        <rect
          key={a}
          className="dp-plan__aisle"
          x={planX(a) - 6}
          y={PLAN.frontY - 9}
          width={12}
          height={planRearY() - PLAN.frontY + 18}
          rx={1.5}
        />
      ))}

      {/* bay depth ruler on the east wall */}
      {bayLabels.map((b) => (
        <text
          key={`bay-${b}`}
          className="dp-plan__bay"
          x={planEastX() + 4}
          y={planY(b) + 2.5}
          textAnchor="start"
        >
          {b}
        </text>
      ))}

      {/* the catalog's pick faces, the slotter's word, tooltips ride
          as innerHTML: React 19 empties real svg <title> on the server */}
      {catalog?.length
        ? catalog.map((c) => (
            <circle
              key={c.sku}
              className={`dp-plan__face dp-plan__face--t${c.tier}`}
              cx={planX(c.aisle)}
              cy={planY(c.bay)}
              r={1.7}
              dangerouslySetInnerHTML={{
                __html: `<title>${escTitle(
                  `${c.sku} · ${c.name} · aisle ${c.aisle} · bay ${c.bay}`,
                )}</title>`,
              }}
            />
          ))
        : null}

      {/* the tours: front sweep + aisle teeth */}
      {drawn.map((t, i) => (
        <polyline
          key={`tour-${i}`}
          className={`dp-plan__tour${
            t.tone && t.tone !== "signal" ? ` dp-plan__tour--${t.tone}` : ""
          }`}
          points={t.path}
        />
      ))}

      {/* the tour's pick faces */}
      {faces.map((f, i) => (
        <circle
          key={`${f.sku}-${i}`}
          className="dp-plan__stop"
          cx={f.x}
          cy={f.y}
          r={2.6 + 2.2 * (f.qty / maxQty)}
        />
      ))}

      {/* the depot, west apron */}
      <g className="dp-plan__depot-g">
        <rect
          className="dp-plan__depot"
          x={DEPOT.x - 5}
          y={DEPOT.y - 5}
          width={10}
          height={10}
        />
        <text
          className="dp-plan__depot-label"
          x={DEPOT.x + 1}
          y={DEPOT.y - 12}
          textAnchor="middle"
        >
          depot
        </text>
      </g>

      {label ? (
        <text className="dp-plan__label" x={PLAN.W - 8} y={16} textAnchor="end">
          {label}
        </text>
      ) : null}
    </svg>
  );
}
