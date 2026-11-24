import Reveal from "./Reveal";
import "./laws.css";

/**
 * The yard's three laws as a numbered stack: the broker README's
 * own wording, trimmed for display.
 */
export default function Laws() {
  return (
    <section className="section section--pad laws" id="laws">
      <div className="wrp laws__grid">
        {/* sticky rail: the section plate + a registration cross */}
        <div className="laws__rail">
          <div className="laws__rail-stick">
            <p className="eyebrow">
              <span className="eyebrow--signal">01</span> · the laws
            </p>
            <h2 className="display laws__title" data-anim="wipe">
              <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
                <span className="wl__t">Three laws, enforced.</span>
              </span>
            </h2>
            <div className="xhair laws__xhair" aria-hidden="true">
              <span className="xhair__x">LAW.SHEET</span>
              <span className="xhair__y">REV 1.0</span>
            </div>
          </div>
        </div>

        {/* the stack */}
        <div className="laws__stack">
          <Reveal>
            <article className="law">
              <span className="law__num" aria-hidden="true">
                01
              </span>
              <div className="law__cell">
                <p className="law__eyebrow">LAW 01</p>
                <h3 className="law__name display">What you publish is what they get.</h3>
                <p className="law__body">
                  A subscriber receives the same bytes the publisher sent, in
                  the order the yard accepted them, with nothing invented
                  in between.
                </p>
              </div>
            </article>
          </Reveal>

          <Reveal delay={90}>
            <article className="law">
              <span className="law__num" aria-hidden="true">
                02
              </span>
              <div className="law__cell">
                <p className="law__eyebrow">LAW 02</p>
                <h3 className="law__name display">Bounded by default.</h3>
                <p className="law__body">
                  Frames carry capacity up to 4&nbsp;MiB (1&nbsp;MiB by
                  default). Delivery queues sit 4,096 entries deep, and idle
                  sessions close on a 30&nbsp;s heartbeat window with a
                  10&nbsp;s grace. Each of these is a default sized for
                  safety, adjustable to your workload.
                </p>
              </div>
            </article>
          </Reveal>

          <Reveal delay={180}>
            <article className="law">
              <span className="law__num" aria-hidden="true">
                03
              </span>
              <div className="law__cell">
                <p className="law__eyebrow">LAW 03</p>
                <h3 className="law__name display">Slow-die bias.</h3>
                <p className="law__body">
                  A session that cannot keep up gets one fatal{" "}
                  <span className="law__code">SLOW_CONSUMER</span> instead of
                  letting the yard grow memory without bound. The same bias
                  runs through the rest of the frame rules: oversized bodies
                  are skipped and answered, and framing that breaks ends the
                  connection with the reason spelled out.
                </p>
              </div>
            </article>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
