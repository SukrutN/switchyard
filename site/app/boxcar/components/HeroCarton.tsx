"use client";

import { useCallback, useRef, useState } from "react";
import type { CartonRaw } from "@/engine/boxcar-engine/fixtures/cartons.ts";

/**
 * hero-carton, the CSS-3D parcel, cydstumpel's rotating box retold
 * in the yard's paper. The pose is plain CSS (no-JS readers get the
 * same parcel at rest); a pointer simply re-answers the custom
 * properties, and prefers-reduced-motion keeps it still.
 */
export default function HeroCarton({ carton }: { carton: CartonRaw }) {
  const [tilt, setTilt] = useState({ rx: -24, ry: 32 });

  const raf = useRef(0);
  const onMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = e.currentTarget.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width - 0.5;
    const ny = (e.clientY - r.top) / r.height - 0.5;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      setTilt({
        rx: -24 - ny * 16,
        ry: 32 + nx * 46,
      });
    });
  }, []);

  const onLeave = useCallback(() => setTilt({ rx: -24, ry: 32 }), []);

  const style = {
    "--rx": `${tilt.rx}deg`,
    "--ry": `${tilt.ry}deg`,
  } as React.CSSProperties;

  return (
    <figure
      className="hc"
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      aria-label={`a shipped ${carton.id}, drawn in three dimensions`}
    >
      {/* the hard-offset plate the parcel sits on */}
      <div className="hc__plate" aria-hidden="true" />

      <div className="hc__scene" aria-hidden="true">
        <div className="hc__box" style={style}>
          {/* top: the tape and the plate line */}
          <div className="hc__face hc__face--top">
            <span className="hc__tape" />
            <span className="hc__plate-line mono">
              {carton.id} · INNER {carton.dims.x.toFixed(1)}×
              {carton.dims.y.toFixed(1)}×{carton.dims.z.toFixed(1)}
            </span>
          </div>

          {/* front: the brand face */}
          <div className="hc__face hc__face--front">
            <span className="hc__brand">
              boxcar <i>/unit-04</i>
            </span>
            <span className="hc__bars" />
            <span className="hc__haul mono">SWITCHYARD FAMILY FREIGHT</span>
            <span className="hc__side-note mono">
              STANDARD ↔ FRAGILE OK · HAZARD ALONE
            </span>
          </div>

          {/* right: the merge law, stamped */}
          <div className="hc__face hc__face--right">
            <span className="hc__stamp mono">
              NO FLOATING
              <br />
              BOXES
            </span>
            <span className="hc__side-note mono">
              MAX-LOAD flows by share
            </span>
          </div>

          {/* left: short passage, looks fine at grazing angles */}
          <div className="hc__face hc__face--left">
            <span className="hc__bars hc__bars--soft" />
            <span className="hc__side-note mono">THIS SIDE UP ⇧</span>
          </div>

          {/* back: the rotation stamp */}
          <div className="hc__face hc__face--back">
            <span className="hc__stamp hc__stamp--signal mono">
              STABILITY ≥ 0.55
            </span>
            <span className="hc__bars hc__bars--soft" />
          </div>

          {/* bottom: the dock stamp (rarely seen) */}
          <div className="hc__face hc__face--bottom">
            <span className="mono hc__side-note">
              PAYLOAD {carton.payloadKg.toFixed(1)} KG · TARE{" "}
              {carton.tareKg.toFixed(2)} KG
            </span>
          </div>
        </div>
      </div>

      <figcaption className="hc__cap mono">
        <span>
          {carton.name} · payload {carton.payloadKg.toFixed(1)} kg
        </span>
        <span className="hc__cap--signal">turn the parcel ↻</span>
      </figcaption>
    </figure>
  );
}
