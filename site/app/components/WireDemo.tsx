"use client";

import { useState } from "react";

/**
 * The wire demo panel: the broker's subject matcher and delivery
 * rules, running in the page. No yard is dialed; the matcher below
 * is a faithful copy of internal/subjects' semantics (dot-separated
 * tokens, * matches exactly one token, > trailing captures the
 * rest), and every subscriber counts its own gapless sequence the
 * way the yard sequences each subscription. The initial board is
 * seeded with one delivered frame, so a no-JS reader still sees a
 * settled state rather than an empty panel.
 */

const SUBJECTS = ["orders.e9.paid", "orders.e3.staged", "ship.b42.left"];

const SUBSCRIBERS = [
  { id: 1, pattern: "orders.*.paid" },
  { id: 2, pattern: "orders.e9.>" },
  { id: 3, pattern: ">" },
];

type Delivery = { seq: number; subject: string };
type Log = Record<number, Delivery[]>;

/** the charter's matcher, as internal/subjects enforces it */
function matches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    const tok = p[i];
    if (tok === ">") return i === p.length - 1 && s.length - i >= 1;
    if (i >= s.length) return false;
    if (tok !== "*" && tok !== s[i]) return false;
  }
  return p.length === s.length;
}

const KEEP = 3;

function statusLine(subject: string): string {
  const hits = SUBSCRIBERS.filter((s) => matches(s.pattern, subject)).length;
  return `${subject} → ${hits} of ${SUBSCRIBERS.length} subscribers`;
}

/** one frame already delivered, the state a no-JS reader lands on */
function seed(): Log {
  const log: Log = {};
  for (const s of SUBSCRIBERS) {
    if (matches(s.pattern, SUBJECTS[0])) {
      log[s.id] = [{ seq: 1, subject: SUBJECTS[0] }];
    }
  }
  return log;
}

export default function WireDemo() {
  const [subject, setSubject] = useState(SUBJECTS[0]);
  const [frames, setFrames] = useState(1);
  const [logs, setLogs] = useState<Log>(seed);
  const [status, setStatus] = useState(statusLine(SUBJECTS[0]));

  const publish = () => {
    setFrames((n) => n + 1);
    setLogs((prev) => {
      const next: Log = { ...prev };
      for (const s of SUBSCRIBERS) {
        if (!matches(s.pattern, subject)) continue;
        const log = next[s.id] ?? [];
        const seq = log.length ? log[log.length - 1].seq + 1 : 1;
        next[s.id] = [...log, { seq, subject }].slice(-KEEP);
      }
      return next;
    });
    setStatus(statusLine(subject));
  };

  const reset = () => {
    setFrames(0);
    setLogs({});
    setStatus("");
  };

  return (
    <div className="wiredemo">
      <span className="wiredemo__corner wiredemo__corner--1" aria-hidden="true" />
      <span className="wiredemo__corner wiredemo__corner--2" aria-hidden="true" />
      <span className="wiredemo__corner wiredemo__corner--3" aria-hidden="true" />
      <span className="wiredemo__corner wiredemo__corner--4" aria-hidden="true" />

      <div className="wiredemo__head">
        <span>WIRE DEMO</span>
        <span className="wiredemo__count mono">frames published: {frames}</span>
      </div>

      <div className="wiredemo__pub">
        <p className="wiredemo__label">PUBLISHER · PICK A SUBJECT</p>
        <div className="wd-subs" role="group" aria-label="the subject to publish">
          {SUBJECTS.map((s) => (
            <button
              key={s}
              type="button"
              className="wd-sub mono"
              aria-pressed={subject === s}
              onClick={() => setSubject(s)}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="wd-actions">
          <button type="button" className="wd-btn wd-btn--go" onClick={publish}>
            Publish
          </button>
          <button type="button" className="wd-btn wd-btn--reset" onClick={reset}>
            Reset
          </button>
        </div>
        {status && (
          <p className="wd-status mono" aria-live="polite">
            {status}
          </p>
        )}
      </div>

      <div className="wiredemo__subs">
        {SUBSCRIBERS.map((s) => {
          const log = logs[s.id] ?? [];
          return (
            <div key={s.id} className="wd-subrow">
              <div className="wd-subrow__id">
                <p className="wd-id mono">SUBSCRIBER {s.id}</p>
                <span className="wd-pattern mono">{s.pattern}</span>
              </div>
              <div
                className="wd-deliveries"
                aria-label={`deliveries for subscriber ${s.id}`}
              >
                {log.length === 0 ? (
                  <span className="wd-empty mono">no deliveries yet</span>
                ) : (
                  log.map((d) => (
                    <span key={d.seq} className="wd-delivery mono">
                      <b>#{d.seq}</b> · {d.subject}
                    </span>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="wiredemo__foot mono">
        match rules: * matches any single word · &gt; matches everything
        after it · only subscribers can use wildcards
      </p>
    </div>
  );
}
