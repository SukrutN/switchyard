import Reveal from "./Reveal";
import ConsoleReplay from "./ConsoleReplay";
import "./consoleSection.css";

/**
 * The site mirrors the yardmaster console, the read-only companion
 * binary the broker repo ships (switchyard PR #10), and lets the page
 * drive it: a replay seeded from the REAL snapshot the console served
 * (2026-10-22T17:28:00Z), with buttons for the recorded bring-up. Wire
 * receipts print spur's own words; every replayed op costs the journal
 * delta the yard actually charged, measured live during the bring-up.
 * The section's copy says plainly: this is a replay, the live console
 * runs where the binary runs.
 */
export default function ConsoleSection() {
  return (
    <section className="section section--pad consol" id="console">
      <div className="wrp">
        <p className="eyebrow">
          <span className="consol__signal">05</span> · the console
        </p>
        <h2 className="display consol__title" data-anim="wipe">
          <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
            <span className="wl__t">
              The yard has a browser now.
            </span>
          </span>
        </h2>
        <p className="consol__body" data-fill>
          <span className="mono">yardmaster</span> is the yard&apos;s
          console: a companion binary that runs beside a live yard,
          connects as an ordinary client, and shows its state, its
          sessions, its lanes, and its keys. The pages it serves are
          part of the binary.
        </p>
        <p className="consol__body consol__body--mut" data-fill>
          Every panel is a read: the console cannot write a single byte
          to the yard, and quarantine is reported, never cleared. The
          panel below is a working replica: click through a publish, an
          attach, an ack, and a wire cut.
        </p>

        <Reveal delay={80}>
          <ConsoleReplay />
        </Reveal>
      </div>
    </section>
  );
}
