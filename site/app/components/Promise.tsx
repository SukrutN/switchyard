import Reveal from "./Reveal";
import "./promise.css";

/**
 * The protocol promise: v1 is frozen, and the table is the capability
 * map, one plain sentence per op family. Op ranges come from the
 * spec's own family table.
 */
const FAMILIES: Array<{ name: string; ops: string; gives: string }> = [
  { name: "pub/sub core", ops: "0x01–0x0A", gives: "publish, subscribe, and wildcard matching" },
  { name: "durable streams (\"lanes\")", ops: "0x0B–0x14", gives: "topics on the journal that replay what was never acknowledged" },
  { name: "key-value state", ops: "0x15–0x1A", gives: "set, get, delete, and list on the same journal" },
  { name: "the yardmaster lens", ops: "0x1B–0x1E", gives: "live, read-only monitoring over the wire" },
  { name: "the gate and the wrap", ops: "0x1F–0x20", gives: "token auth before HELLO, TLS around every byte" },
];

export default function PromiseSection() {
  return (
    <section className="section section--pad promise" id="promise">
      <div className="wrp promise__grid">
        <div className="promise__copy">
          <p className="eyebrow">
            <span className="promise__signal">07</span> · the promise
          </p>
          <h2 className="display promise__title" data-anim="wipe">
            <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
              <span className="wl__t">The protocol is frozen.</span>
            </span>
          </h2>
          <p className="promise__body">
            Version 1 of the wire protocol is frozen. Operation numbers,
            framing, and error codes stay exactly where they are in every
            1.x release, so the client you build today keeps working
            against future yards without a rewrite.
          </p>
          <p className="promise__body promise__body--mut" data-fill>
            The whole contract fits in one file,{" "}
            <span className="mono promise__chip">docs/PROTOCOL.md</span>, and
            one package implements it. Five families of operations,
            thirty-two in all:
          </p>
          <div className="promise__cta">
            <a
              className="btn btn--ghost"
              href="https://github.com/SukrutN/switchyard/blob/main/docs/PROTOCOL.md"
              target="_blank"
              rel="noreferrer"
            >
              <span className="btn__text">
                <span>docs/PROTOCOL.md</span>
                <span aria-hidden="true">docs/PROTOCOL.md</span>
              </span>
              <span className="btn__arrow" aria-hidden="true">
                <svg className="arrow" viewBox="0 0 12 12">
                  <path d="M7.3 0.7 10.9 6l-3.6 5.3H5.4l2.4-3.3H1v-4h6.8L5.4 0.7h1.9Z" />
                </svg>
              </span>
            </a>
          </div>
        </div>

        <div className="promise__table">
          <div className="promise__thead mono" aria-hidden="true">
            <span>family</span>
            <span>ops</span>
            <span>what it gives you</span>
          </div>
          {FAMILIES.map((f, i) => (
            <Reveal key={f.name} delay={i * 60}>
              <div className="promise__row">
                <span className="promise__name">{f.name}</span>
                <span className="mono promise__ops">{f.ops}</span>
                <span className="promise__gives">{f.gives}</span>
              </div>
            </Reveal>
          ))}
          <p className="promise__note">
            New operations append after the last family; existing numbers
            never move.
          </p>
        </div>
      </div>
    </section>
  );
}
