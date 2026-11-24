"use client";

import { useCallback, useState } from "react";

/**
 * The console replay: the yardmaster console's view, driven live in the
 * browser. Every number starts at the REAL snapshot the console served
 * (2026-10-22T17:28:00Z) and every action costs what the yard actually
 * charged for that op during the recorded bring-up, measured live:
 *   publish "box 42 left the dock"   (orders.dock.out)   journal += 59
 *   publish "box 7 hit the junction" (orders.junction.in) journal += 64
 *   kv set box-42 → "box 42 signed for at the door"       journal += 58
 * Wire receipts print spur's own words; lines the replay narrates are
 * prefixed "·". Attach/ack/detach follow the receipts measured live:
 * a durable consumer re-attaches at its standing floor and the watch
 * redelivers the unacked stream rows past it (kv sets ride the same
 * journal but are never delivered to a watcher), an ack moves the
 * durable floor to the acked sequence, and a detach leaves the floor
 * standing. The dark state is the real refusal the console printed at
 * boot, verbatim.
 */

type KeyRow = {
  name: string;
  seq: number;
  bytes: number;
  payload: string;
};

type ReplayState = {
  seq: number;
  journal: number;
  keys: KeyRow[];
  consumers: ConsumerState[];
  /** the lane's journal kinds, seq 1..n: pushes deliver, kv sets do not */
  kinds: ("push" | "set")[];
  dark: boolean;
  log: string[];
};

type ConsumerState = {
  name: string;
  floor: number;
  pending: number;
  attached: boolean;
};

/** the recorded snapshot: real snapshot, real receipt time, real numbers */
const BASE: ReplayState = {
  seq: 4,
  journal: 263,
  keys: [
    { name: "box-42", seq: 3, bytes: 29, payload: "box 42 signed for at the door" },
    { name: "box-7", seq: 4, bytes: 22, payload: "box 7 hit the junction" },
  ],
  consumers: [
    // the recorded watcher, auto-acked to the tip at snapshot time
    { name: "inspector", floor: 4, pending: 0, attached: true },
  ],
  kinds: ["push", "push", "set", "set"],
  dark: false,
  log: [],
};

/** the recorded upstream ops, with the journal cost the yard charged each */
const RECORDED = [
  {
    kind: "push" as const,
    subject: "orders.dock.out",
    payload: "box 42 left the dock",
    jbytes: 20,
    delta: 59,
  },
  {
    kind: "push" as const,
    subject: "orders.junction.in",
    payload: "box 7 hit the junction",
    jbytes: 22,
    delta: 64,
  },
  {
    kind: "set" as const,
    subject: "",
    key: "box-42",
    payload: "box 42 signed for at the door",
    jbytes: 29,
    delta: 58,
  },
];

/** the recorded pushes the demo cycles; the set op lives on its own button */
const PUSHES = [RECORDED[0], RECORDED[1]];

/** the real refusal the console printed when its dial was refused at boot */
const DARK_LINE =
  "the yard is dark, dial 127.0.0.1:4780: dial tcp 127.0.0.1:4780: connectex: No connection could be made because the target machine actively refused it.";

export default function ConsoleReplay() {
  const [state, setState] = useState<ReplayState>(BASE);
  const [cursor, setCursor] = useState(0); // next recorded op index
  const [activeKey, setActiveKey] = useState<string>("box-42");

  const inspector = state.consumers[0];

  const push = useCallback(() => {
    setState((s) => {
      const op = PUSHES[cursor % PUSHES.length];
      const nextSeq = s.seq + 1;
      const log: string[] = [
        `stored at seq ${nextSeq} in lane orders (${op.jbytes} bytes on the journal)`,
      ];
      let pending = s.consumers[0].pending;
      if (s.consumers[0].attached) {
        // the push is delivered to the attached watcher, as the
        // measured receipt shows
        log.push(`[lane orders #${nextSeq}] ${op.subject} ${op.payload}`);
        pending += 1;
      }
      return {
        ...s,
        seq: nextSeq,
        journal: s.journal + op.delta,
        kinds: [...s.kinds, "push" as const],
        consumers: [{ ...s.consumers[0], pending }],
        log: [...log, ...s.log].slice(0, 5),
      };
    });
    setCursor((c) => (c + 1) % PUSHES.length);
  }, [cursor]);

  const setKey = useCallback(() => {
    setState((s) => {
      const op = RECORDED[2]; // the recorded set: box-42
      const nextSeq = s.seq + 1;
      return {
        ...s,
        seq: nextSeq,
        journal: s.journal + op.delta,
        kinds: [...s.kinds, "set" as const],
        keys: s.keys.map((k) =>
          k.name === op.key
            ? { ...k, seq: nextSeq, payload: op.payload, bytes: op.jbytes }
            : k
        ),
        log: [
          `stored at seq ${nextSeq} (key ${op.key}, ${op.jbytes} bytes in lane orders)`,
          ...s.log,
        ].slice(0, 5),
      };
    });
  }, []);

  const attach = useCallback(() => {
    setState((s) => {
      if (s.consumers[0].attached) return s;
      const c = s.consumers[0];
      // a durable consumer re-attaches at its standing floor; the watch
      // redelivers every stream row past the floor it never
      // delivered-and-acked, kv sets ride the same journal but are never
      // delivered to a watcher (the measured idler receipt).
      const owed = s.kinds.slice(c.floor, s.seq).filter((k) => k === "push").length;
      return {
        ...s,
        consumers: [{ ...c, attached: true, pending: c.pending + owed }],
        log: [
          `· inspector attaches: resumes from floor ${c.floor}, ${owed} row${owed === 1 ? "" : "s"} owed`,
          ...s.log,
        ].slice(0, 5),
      };
    });
  }, []);

  const ack = useCallback(() => {
    setState((s) => {
      const inspector = s.consumers[0];
      if (!inspector.attached || inspector.pending === 0) return s;
      // ack the tip, as the recorded watcher's receipts show: the durable
      // floor jumps to the acked sequence, every debt drops
      return {
        ...s,
        consumers: [{ ...inspector, floor: s.seq, pending: 0 }],
        log: [
          `· inspector acks: the durable floor resumes from seq ${s.seq}`,
          ...s.log,
        ].slice(0, 5),
      };
    });
  }, []);

  const detach = useCallback(() => {
    setState((s) => {
      if (!s.consumers[0].attached) return s;
      return {
        ...s,
        consumers: [{ ...s.consumers[0], attached: false }],
        log: [
          `· inspector detaches: the durable floor ${s.consumers[0].floor} stands`,
          ...s.log,
        ].slice(0, 5),
      };
    });
  }, []);

  const cut = useCallback(() => {
    setState((s) =>
      s.dark ? s : { ...s, dark: true, log: [DARK_LINE, ...s.log].slice(0, 5) }
    );
  }, []);

  const reconnect = useCallback(() => {
    setState((s) =>
      s.dark
        ? {
            ...s,
            dark: false,
            log: ["· reconnected: the console keeps watching", ...s.log].slice(0, 5),
          }
        : s
    );
  }, []);

  const reset = useCallback(() => {
    setState(BASE);
    setCursor(0);
    setActiveKey("box-42");
  }, []);

  const kv = state.keys.find((k) => k.name === activeKey) ?? state.keys[0];

  return (
    <div
      className={`consol__band${state.dark ? " consol__band--dark" : ""}`}
      aria-label="yardmaster console, replayed"
    >
      {/* the console's gate, as it read that second */}
      <div className="consol__gate">
        <span className="consol__chip">
          target <b>127.0.0.1:4780</b>
        </span>
        <span className="consol__chip consol__chip--warn">
          tls <b>plain</b>
        </span>
        <span className="consol__chip consol__chip--warn">
          token <b>auth off</b>
        </span>
        <span
          className={`consol__chip consol__chip--live${state.dark ? " consol__chip--dark" : ""}`}
        >
          <span className="consol__dot" />
          <b>{state.dark ? "the yard is dark" : "watching"}</b>
        </span>
      </div>

      {/* the replay controls: recorded ops, replayed */}
      <div className="consol__plate replay__controls">
        <p className="consol__kicker">
          replay controls <span className="consol__roi">not a live yard</span>
        </p>
        <div className="replay__btns">
          <button className="replay__btn" onClick={push} disabled={state.dark}>
            publish row
          </button>
          <button
            className="replay__btn"
            onClick={setKey}
            disabled={state.dark}
          >
            set box-42
          </button>
          <button
            className="replay__btn"
            onClick={inspector.attached ? detach : attach}
            disabled={state.dark}
          >
            {inspector.attached ? "detach inspector" : "attach inspector"}
          </button>
          <button
            className="replay__btn"
            onClick={ack}
            disabled={
              state.dark || !inspector.attached || inspector.pending === 0
            }
          >
            inspector acks
            {inspector.pending > 0 ? ` (${inspector.pending})` : ""}
          </button>
          <button className="replay__btn" onClick={state.dark ? reconnect : cut}>
            {state.dark ? "reconnect" : "cut the wire"}
          </button>
          <button className="replay__btn replay__btn--reset" onClick={reset}>
            reset replay
          </button>
        </div>
        {state.log.length > 0 && (
          <div className="replay__log mono" aria-live="polite">
            {state.log.map((line, i) => (
              <p key={`${i}-${line.slice(0, 18)}`} className="replay__line">
                {line}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* the yard card */}
      <div className="consol__plate">
        <p className="consol__kicker">the yard</p>
        {state.dark ? (
          <p className="consol__note consol__note--dark">{DARK_LINE}</p>
        ) : (
          <>
            <dl className="consol__grid">
              <div className="consol__cell">
                <dt>version</dt>
                <dd>
                  <span className="consol__hot">1.0.0</span>
                </dd>
              </div>
              <div className="consol__cell">
                <dt>uptime</dt>
                <dd>41s</dd>
              </div>
              <div className="consol__cell">
                <dt>sessions</dt>
                <dd>2</dd>
              </div>
              <div className="consol__cell">
                <dt>lanes</dt>
                <dd>1</dd>
              </div>
            </dl>
            <p className="consol__note">
              read from the wire · read-only
            </p>
          </>
        )}
      </div>

      {/* the lane table */}
      <div className="consol__plate">
        <p className="consol__kicker">lanes</p>
        <table className="consol__table">
          <thead>
            <tr>
              <th>lane</th>
              <th className="num">seq</th>
              <th className="num">journal</th>
              <th className="num">keys</th>
              <th className="num">consumers</th>
            </tr>
          </thead>
          <tbody>
            {state.dark ? null : (
              <tr className="consol__row--active">
                <td className="consol__lane-name">orders</td>
                <td className="num">{state.seq}</td>
                <td className="num">{state.journal} B</td>
                <td className="num">{state.keys.length}</td>
                <td className="num">{state.consumers.length}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* the drill-down */}
      <div className="consol__plate" hidden={state.dark}>
        <p className="consol__kicker">
          lane <b>orders</b>
        </p>
        <dl className="consol__grid">
          <div className="consol__cell">
            <dt>seq</dt>
            <dd>{state.seq}</dd>
          </div>
          <div className="consol__cell">
            <dt>journal</dt>
            <dd>{state.journal} B</dd>
          </div>
          <div className="consol__cell">
            <dt>keys</dt>
            <dd>{state.keys.length}</dd>
          </div>
          <div className="consol__cell">
            <dt>consumers</dt>
            <dd>{state.consumers.length}</dd>
          </div>
        </dl>
        <table className="consol__table" style={{ marginTop: "0.8rem" }}>
          <thead>
            <tr>
              <th>consumer</th>
              <th className="num">floor</th>
              <th className="num">pending</th>
              <th>state</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>inspector</td>
              <td className="num">{inspector.floor}</td>
              <td className="num">{inspector.pending}</td>
              <td>
                <span className="consol__chip--state">
                  {inspector.attached ? "attached" : "detached"}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="consol__note">
          floor is the durable position a consumer resumes from
        </p>
      </div>

      {/* the KV index, look-only in the real console; stays stale while dark */}
      <div className="consol__plate">
        <p className="consol__kicker">
          key–value <span className="consol__roi">read-only</span>
        </p>
        <div className="consol__kvrow">
          <select
            className="consol__sel"
            aria-label="lane (mirror: disabled)"
            disabled
            defaultValue="orders"
          >
            <option value="orders">orders</option>
          </select>
          <span className="consol__sep mono">·</span>
          <div className="consol__keyscol">
            <ul className="consol__keys">
              {state.keys.map((k) => (
                <li key={k.name} className={k.name === activeKey ? "active" : ""}>
                  <button
                    type="button"
                    className="replay__keyline"
                    onClick={() => setActiveKey(k.name)}
                    disabled={state.dark}
                  >
                    {k.name}
                  </button>
                </li>
              ))}
            </ul>
            <p className="consol__note">{state.keys.length} key(s)</p>
          </div>
        </div>
        <div className="consol__value">
          <p className="consol__kicker">
            key <b>{kv.name}</b>{" "}
            <span className="consol__roi">
              seq {kv.seq} | {kv.bytes} B
            </span>
          </p>
          <pre className="consol__payload">{kv.payload}</pre>
        </div>
      </div>

      <p className="replay__foot">
        run the binary to see the real console live:{" "}
        <span className="mono">bin\yardmaster.exe</span>
      </p>
    </div>
  );
}
