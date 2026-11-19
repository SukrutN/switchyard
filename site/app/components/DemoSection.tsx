import Reveal from "./Reveal";
import WireDemo from "./WireDemo";
import "./wiredemo.css";

/**
 * The demo: the wire's matching and delivery rules, click-driven.
 * The panel simulates the broker's semantics, and the copy says so
 * once, plainly. The section sits right after the laws, because the
 * demo is law 01 made visible.
 */
export default function DemoSection() {
  return (
    <section className="section section--pad demo" id="demo">
      <div className="wrp">
        <p className="eyebrow">
          <span className="demo__signal">02</span> · the demo
        </p>
        <h2 className="display demo__title" data-anim="wipe">
          <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
            <span className="wl__t">Watch the wire deliver.</span>
          </span>
        </h2>
        <p className="demo__body" data-fill>
          Pick a subject and publish it. Every matching subscriber receives
          the message in order, each counting its own deliveries with no
          gaps.
        </p>
        <Reveal delay={80}>
          <div className="demo__band">
            <WireDemo />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
