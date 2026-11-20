import Reveal from "./Reveal";
import "./promise.css";

/**
 * The protocol promise: v1 is frozen, families append, op numbers
 * never move. The table is lifted from the spec's own family ranges.
 */
const FAMILIES: Array<{ name: string; sections: string; ops: string }> = [
  { name: "pub/sub core", sections: "§2.1–§2.7", ops: "0x01–0x0A" },
  { name: "durable streams (\"lanes\")", sections: "§2.8–§2.17", ops: "0x0B–0x14" },
  { name: "key-value state", sections: "§2.18–§2.23", ops: "0x15–0x1A" },
  { name: "the yardmaster lens (read-only)", sections: "§2.24–§2.27", ops: "0x1B–0x1E" },
  { name: "the gate and the wrap", sections: "§2.28–§2.29", ops: "0x1F–0x20" },
];

export default function PromiseSection() {
  return (
    <section className="section section--pad promise" id="promise">
      <div className="wrp promise__grid">
        <div className="promise__copy">
          <p className="eyebrow">
            <span className="promise__signal">06</span> · the promise
          </p>
          <h2 className="display promise__title" data-anim="wipe">
            <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
              <span className="wl__t">The protocol is frozen.</span>
            </span>
          </h2>
          <p className="promise__body">
            Protocol v1 is frozen. Op numbers never move, families only
            append, error codes keep their names. A client written against
            §2 today will still wire up against a later 1.x yard, unchanged.
          </p>
          <p className="promise__body promise__body--mut" data-fill>
            The spec is the wire&apos;s only definition, and{" "}
            <span className="mono promise__chip">internal/wire</span> is the
            only code that defines it. The whole contract is 29 numbered
            sections:
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
            <span>sections</span>
            <span>ops</span>
          </div>
          {FAMILIES.map((f, i) => (
            <Reveal key={f.name} delay={i * 60}>
              <div className="promise__row">
                <span className="promise__name">{f.name}</span>
                <span className="mono promise__sec">{f.sections}</span>
                <span className="mono promise__ops">{f.ops}</span>
              </div>
            </Reveal>
          ))}
          <p className="promise__note">
            Appends land after the last family; earlier numbers stay
            exactly where they are.
          </p>
        </div>
      </div>
    </section>
  );
}
