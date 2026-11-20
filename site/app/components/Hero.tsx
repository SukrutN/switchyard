import Reveal from "./Reveal";
import "./hero.css";

/**
 * The first screen. Paper with blueprint lines, a headline that rises
 * word by word, a real wire receipt on the right, and the yard's
 * departure-board strip running along the bottom.
 */
export default function Hero() {
  return (
    <section className="section hero bp-grid" id="top">
      <Xhair pos="tr" x="0x0742" y="0x0032" />
      <Xhair pos="bl" x="0x0010" y="0x05e0" />

      <div className="wrp hero__inner">
        {/* tag row: the name and the plate */}
        <div className="hero__tags">
          <div className="hero__tag">
            <div className="hero__tag__k">SYSTEM</div>
            <div className="hero__tag__v">ONE BINARY</div>
          </div>
          <div className="hero__tag hero__tag--right">
            <div className="hero__tag__k">EST. 2026</div>
            <div className="hero__tag__v hero__tag__v--signal">V1.0.0</div>
          </div>
        </div>

        <div className="hero__grid">
          <div className="hero__main">
            <h1 className="display hero__claim">
              <span className="hero__line">
                <span style={{ "--d": "0ms" } as React.CSSProperties}>
                  The&nbsp;yard
                </span>
              </span>
              <span className="hero__line">
                <span style={{ "--d": "90ms" } as React.CSSProperties}>
                  never&nbsp;<em>lies.</em>
                </span>
              </span>
            </h1>

            <p className="lede hero__lede">
              A Go message broker you can run from one binary and read from
              one file. Pub/sub, durable streams, key-value state, and a
              console view all ride the same 8-byte wire. What lands on it is
              exactly what every subscriber gets, in accepted order.
            </p>

            <div className="hero__cta">
              <a className="btn btn--solid" href="#quickstart">
                <span className="btn__text">
                  <span>Run the yard</span>
                  <span aria-hidden="true">Run the yard</span>
                </span>
                <span className="btn__arrow" aria-hidden="true">
                  <svg className="arrow" viewBox="0 0 12 12">
                    <path d="M7.3 0.7 10.9 6l-3.6 5.3H5.4l2.4-3.3H1v-4h6.8L5.4 0.7h1.9Z" />
                  </svg>
                </span>
              </a>
              <a
                className="btn btn--ghost"
                href="https://github.com/SukrutN/switchyard#switchyard"
                target="_blank"
                rel="noreferrer"
              >
                <span className="btn__text">
                  <span>Read the yard</span>
                  <span aria-hidden="true">Read the yard</span>
                </span>
                <span className="btn__arrow" aria-hidden="true">
                  <svg className="arrow" viewBox="0 0 12 12">
                    <path d="M7.3 0.7 10.9 6l-3.6 5.3H5.4l2.4-3.3H1v-4h6.8L5.4 0.7h1.9Z" />
                  </svg>
                </span>
              </a>
            </div>
          </div>

          {/* the wire, as an operator sees it */}
          <Reveal delay={140}>
            <figure className="ticket" aria-label="a live wire receipt">
              {["c1", "c2", "c3", "c4"].map((c) => (
                <span key={c} className={`ticket__corner ${c}`} />
              ))}
              <figcaption className="ticket__head">
                <span>RECEIPT</span>
                <span className="ticket__num">#0x0052</span>
              </figcaption>
              <div className="ticket__body mono">
                <div className="ticket__row">
                  <span className="ticket__prompt">$</span> spur ping
                </div>
                <div className="ticket__row">
                  <span className="ticket__ok">pong</span>{" "}
                  <span className="ticket__mut">in 0.510</span> ms{" "}
                  <span className="ticket__mut">from</span> switchyard/1.0.0
                </div>
                <div className="ticket__sep" />
                <div className="ticket__row">
                  <span className="ticket__prompt">$</span> spur stream push
                  orders orders.9001.paid &lsquo;ok&rsquo;
                </div>
                <div className="ticket__row">
                  <span className="ticket__ok">stored</span> seq 1{" "}
                  <span className="ticket__mut">· 20 B on the journal</span>
                </div>
                <div className="ticket__row ticket__row--blank">
                  <span className="ticket__cursor">▊</span>
                </div>
              </div>
              <div className="ticket__foot">
                <span>THE WIRE ANSWERS</span>
                <span className="ticket__foot--signal">PONG</span>
              </div>
            </figure>
          </Reveal>
        </div>
      </div>

      {/* the strip: subjects mounting, receipts landing */}
      <div className="tick" aria-hidden="true">
        <div className="tick__track">
          {tickRow.map((t) => (
            <span
              key={t.text}
              className={`tick__item ${t.signal ? "tick__item--signal" : ""}`}
            >
              <span className="tick__op">{t.op}</span> {t.text}
              <i className="tick__dash" />
            </span>
          ))}
          {tickRow.map((t) => (
            <span
              key={`${t.text}-2`}
              className={`tick__item ${t.signal ? "tick__item--signal" : ""}`}
            >
              <span className="tick__op">{t.op}</span> {t.text}
              <i className="tick__dash" />
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/* the strip's content: short, true, all shown earlier by the yard */
const tickRow = [
  { op: "PUBLISH", text: "orders.e9.paid", signal: false },
  { op: "DELIVER", text: "sid1 #1 · in accepted order", signal: false },
  { op: "SUBSCRIBE", text: "orders.*.paid", signal: false },
  { op: "PING", text: "pong 0.510 ms · 14.3–17.4k probes/s", signal: true },
  { op: "KV_SET", text: "orders/box-42 · receipt", signal: false },
  { op: "STREAM_PUSH", text: "orders · row #4 · 20 B on disk", signal: false },
  { op: "AUTH", text: "token before HELLO · TLS wraps", signal: false },
  { op: "SLOW_CONSUMER", text: "one fatal frame, and it says why", signal: false },
];

/* registration cross: a corner + two coordinates, like a drawing sheet */
function Xhair({ pos, x, y }: { pos: "tr" | "bl"; x: string; y: string }) {
  return (
    <div className={`xhair xhair--${pos}`} aria-hidden="true">
      <span className="xhair__x">{x}</span>
      <span className="xhair__y">{y}</span>
    </div>
  );
}
