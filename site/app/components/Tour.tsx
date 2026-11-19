"use client";

import { useEffect, useRef, useState } from "react";
import "./tour.css";

/**
 * The README's quickstart, typed on a loop. Output lines are wire
 * facts the protocol guarantees (PONG, DELIVER in accepted order,
 * fsynced receipts, the Yardmaster's snapshot), nothing invented.
 * Reduced-motion readers get the whole transcript at once.
 */
type Line = { kind: "cmd" | "ok" | "out"; text: string };

const SCRIPT: Line[] = [
  { kind: "cmd", text: "spur ping" },
  { kind: "ok", text: "pong in 0.510 ms from switchyard/1.0.0" },
  { kind: "cmd", text: "spur sub 'orders.*.paid' &" },
  { kind: "out", text: "watching · deliveries land in accepted order" },
  { kind: "cmd", text: "spur pub 'orders.e9.paid' 'box 42 left the dock'" },
  { kind: "ok", text: "written to the wire · delivered to sid1 #1" },
  { kind: "cmd", text: "spur stream push orders orders.9001.paid 'left the dock'" },
  { kind: "ok", text: "stored seq 1 · 20 B on the journal · receipt" },
  { kind: "cmd", text: "spur kv set orders box-42 'box 42'" },
  { kind: "ok", text: "stored seq 2 · receipt" },
  { kind: "cmd", text: "spur yard" },
  { kind: "ok", text: "switchyard/1.0.0 · sessions 2 · lane orders, last seq 2" },
];

const TYPE_MS = 34; // per character of a command
const CMD_HOLD = 500; // after a command finishes
const OUT_GAP = 240; // between transcripts
const END_HOLD = 2800; // before the loop wipes

export default function Tour() {
  const [progress, setProgress] = useState(() => ({
    line: 0,
    chars: 0,
  }));
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let t: ReturnType<typeof setTimeout> | undefined;
    let dead = false;

    const step = (line: number, chars: number) => {
      if (dead) return;
      const cur = SCRIPT[line];
      if (!cur) {
        t = setTimeout(() => {
          if (!dead) {
            setProgress({ line: 0, chars: 0 });
            step(0, 0);
          }
        }, END_HOLD);
        return;
      }
      if (cur.kind === "cmd") {
        if (chars <= cur.text.length) {
          setProgress({ line, chars });
          t = setTimeout(() => step(line, chars + 1), TYPE_MS);
        } else {
          t = setTimeout(() => step(line + 1, 0), CMD_HOLD);
        }
      } else {
        setProgress({ line, chars: 0 });
        t = setTimeout(() => step(line + 1, 0), OUT_GAP);
      }
    };

    step(0, 0);
    return () => {
      dead = true;
      if (t) clearTimeout(t);
    };
  }, []);

  // keep the newest line in view like a real terminal
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [progress.line]);

  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const visible = reduced ? SCRIPT.slice() : SCRIPT.slice(0, progress.line + 1);

  return (
    <div className="tour" aria-hidden="true">
      {[0, 1, 2, 3].map((c) => (
        <span key={c} className={`tour__corner tour__corner--${c + 1}`} />
      ))}
      <div className="tour__bar">
        <span>spur · the reference client</span>
        <span className="tour__addr">127.0.0.1:4780</span>
      </div>
      <div className="tour__body mono" ref={bodyRef}>
        {visible.map((l, i) => {
          const typing =
            !reduced && l.kind === "cmd" && i === progress.line && progress.chars <= l.text.length;
          return (
            <div key={i} className={`tour__line tour__line--${l.kind}`}>
              {l.kind === "cmd" ? <span className="tour__prompt">$ </span> : null}
              <span>
                {l.kind === "cmd" ? l.text.slice(0, typing ? progress.chars : undefined) : l.text}
              </span>
              {typing ? <span className="tour__cursor">▍</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
