"use client";

import { useMemo, useState } from "react";
import type {
  ShipSolution,
  ValidationReport,
} from "@/engine/boxcar-engine/index.ts";
import { boxFaces, cartonFrame } from "./iso";
import "./packhall.css";

export interface PackHallProps {
  profiles: {
    key: string;
    label: string;
    short: string;
  }[];
  solutions: Record<string, ShipSolution>;
  reports: Record<string, ValidationReport>;
}

const CHECK_LABEL: Record<string, string> = {
  BOUNDS: "bounds",
  OVERLAP: "overlap",
  FLOATING: "no floating",
  LOAD: "load",
  WEIGHT: "weight",
  STABILITY: "stability",
  MERGE: "merge",
  UNFILLED: "unfilled",
};

const pct = (x: number, dp = 1) => `${(x * 100).toFixed(dp)}%`;

export default function PackHall({ profiles, solutions, reports }: PackHallProps) {
  const [profileKey, setProfileKey] = useState(profiles[0].key);
  const [cartonIndex, setCartonIndex] = useState(0);
  const [playToken, setPlayToken] = useState(0);

  const solution = solutions[profileKey];
  const report = reports[profileKey];
  const cartonCount = solution.cartons.length;
  const index = Math.min(cartonIndex, cartonCount - 1);
  const carton = solution.cartons[index];

  // painter order: farther boxes (x+y+z) first, faces over boxes
  const ordered = useMemo(
    () =>
      [...carton.boxes].sort(
        (a, b) =>
          a.pos.x + a.pos.y + a.pos.z - (b.pos.x + b.pos.y + b.pos.z),
      ),
    [carton],
  );

  const frame = useMemo(
    () =>
      cartonFrame(
        carton.template.dims.x * 0.01,
        carton.template.dims.y * 0.01,
        carton.template.dims.z * 0.01,
      ),
    [carton],
  );

  const json = useMemo(() => {
    const slice = {
      carton: index + 1,
      template: carton.template.id,
      inner: carton.template.dims,
      payloadG: carton.payloadG,
      weightMargin: Number(carton.weightMargin.toFixed(3)),
      cubeUtilization: Number(carton.cubeUtilization.toFixed(3)),
      boxes: carton.boxes.map((b) => ({
        sku: b.unit.sku,
        family: b.unit.family,
        pos: b.pos,
        dims: b.dims,
        supports: b.supports,
      })),
    };
    return JSON.stringify(slice, null, 2);
  }, [carton, index]);

  const pick = (key: string) => {
    setProfileKey(key);
    setCartonIndex(0);
    setPlayToken((t) => t + 1);
  };

  return (
    <div className="ph">
      {/* the profile strip */}
      <div className="ph__tabs" role="tablist" aria-label="order profiles">
        {profiles.map((p) => {
          const sol = solutions[p.key];
          const active = p.key === profileKey;
          return (
            <button
              key={p.key}
              role="tab"
              aria-selected={active}
              className={`ph__tab ${active ? "ph__tab--on" : ""}`}
              onClick={() => pick(p.key)}
            >
              <span className="ph__tab-name mono">{p.short}</span>
              <span className="ph__tab-meta mono">
                {sol.cartons.length} ct · {pct(sol.cubeUtilization, 1)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="ph__stage">
        {/* the diagram */}
        <figure className="ph__figure">
          <figcaption className="ph__cap mono">
            <span>
              {profileKey} · carton {index + 1}/{cartonCount} ·{" "}
              {carton.template.id}
            </span>
            <button
              className="ph__replay mono"
              onClick={() => setPlayToken((t) => t + 1)}
            >
              re-run the pack ↻
            </button>
          </figcaption>

          <svg
            key={`${profileKey}:${index}:${playToken}`}
            className="ph__svg"
            viewBox={frame.view}
            role="img"
            aria-label={`isometric pack-out of ${carton.template.id}: ${carton.boxes.length} units, cube utilization ${pct(carton.cubeUtilization, 0)}`}
          >
            <g className="ph__grid">
              {frame.grid.map((g, gi) => (
                <polyline key={gi} points={g} />
              ))}
            </g>
            <polygon className="ph__floor" points={frame.walls.floor} />
            <g className="ph__vert">
              {frame.walls.verticals.map((v, vi) => (
                <polyline key={vi} points={v} />
              ))}
            </g>

            {ordered.map((box, bi) => {
              const { faces, label } = boxFaces(box);
              return (
                <g
                  key={box.unit.seq}
                  className={`ph__box ph__box--${box.unit.family}`}
                  style={{
                    animationDelay: `${0.15 + bi * 0.12}s`,
                  }}
                >
                  {faces.map((f) => (
                    <polygon
                      key={f.side}
                      className={`ph__f ph__f--${f.side}`}
                      points={f.points}
                    />
                  ))}
                  {label ? (
                    <text className="ph__sku" x={label.x} y={label.y}>
                      {box.unit.sku}
                    </text>
                  ) : null}
                </g>
              );
            })}

            <polyline className="ph__rim" points={frame.walls.rim} />
          </svg>

          {/* carton pager */}
          {cartonCount > 1 ? (
            <div className="ph__pager" role="group" aria-label="cartons">
              {solution.cartons.map((c, ci) => (
                <button
                  key={ci}
                  className={`ph__pg mono ${ci === index ? "ph__pg--on" : ""}`}
                  onClick={() => {
                    setCartonIndex(ci);
                    setPlayToken((t) => t + 1);
                  }}
                >
                  {c.template.id}
                </button>
              ))}
            </div>
          ) : (
            <p className="ph__one mono">single carton carries the wave</p>
          )}
        </figure>

        {/* the numbers + the report + the wire */}
        <aside className="ph__side">
          <dl className="ph__stats">
            <div className="ph__stat">
              <dt>cartons opened</dt>
              <dd className="ph__big">{cartonCount}</dd>
            </div>
            <div className="ph__stat">
              <dt>cube utilization</dt>
              <dd className="ph__big">{pct(solution.cubeUtilization, 1)}</dd>
            </div>
            <div className="ph__stat">
              <dt>worst weight margin</dt>
              <dd className="ph__big">{pct(solution.weightMargin, 0)}</dd>
            </div>
            <div className="ph__stat">
              <dt>boxes this carton</dt>
              <dd className="ph__big">{carton.boxes.length}</dd>
            </div>
          </dl>

          <div className="ph__checks" aria-label="validation report">
            {report.checks
              .filter((c, i, arr) =>
                arr.findIndex((x) => x.id === c.id) === i,
              )
              .map((c) => (
                <span
                  key={c.id}
                  className={`ph__chip mono ${c.ok ? "" : "ph__chip--bad"}`}
                >
                  {CHECK_LABEL[c.id] ?? c.id}
                  {c.ok ? "" : " ✕"}
                </span>
              ))}
            <span className="ph__chip--note mono">
              {report.ok ? "pack-out validates clean" : "see the engine report"}
            </span>
          </div>

          <pre className="ph__wire mono" aria-label="solution json">
            {json}
          </pre>
        </aside>
      </div>
    </div>
  );
}
