import CountUp from "./CountUp";
import Reveal from "./Reveal";
import "./numbers.css";

/**
 * The yard by the numbers, a dark console band. Every gauge is the
 * upper bound of a three-run range printed by scripts/bench.ps1
 * (2026-10-21, i7-8700, Windows 11, Go 1.25); the full spread sits
 * under each number, so the page shows the range, not just the best
 * run.
 */
export default function Numbers() {
  return (
    <section className="section numbers" id="numbers">
      <div className="wrp">
        <div className="numbers__head">
          <p className="eyebrow">
            <span className="numbers__eyebrow-signal">02</span> · the yard by
            the numbers
          </p>
          <h2 className="display numbers__title" data-anim="wipe">
            <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
              <span className="wl__t">What the rod prints.</span>
            </span>
          </h2>
          <p className="numbers__lede" data-fill>
            yardstick starts a temporary yard and runs each scene three
            times, printing the spread so the table can&apos;t lie. The
            gauges below show the strong end of each range.
          </p>
        </div>

        <div className="numbers__grid">
          <Reveal>
            <div className="gauge">
              <div className="gauge__value">
                <CountUp to={17.4} decimals={1} suffix=" k/s" />
              </div>
              <div className="gauge__op mono">ping · probes/sec</div>
              <p className="gauge__note">
                PONG round trip, p95 ≈ 0.52 ms · 14.3–17.4 k/s over three runs
              </p>
            </div>
          </Reveal>
          <Reveal>
            <div className="gauge">
              <div className="gauge__value">
                <CountUp to={1.15} decimals={2} suffix=" M/s" />
              </div>
              <div className="gauge__op mono">pubsub · deliveries/sec</div>
              <p className="gauge__note">
                fan-out through the dams · 2,000 msgs × 4 sids × 128 B
              </p>
            </div>
          </Reveal>
          <Reveal>
            <div className="gauge">
              <div className="gauge__value">
                <CountUp to={273} suffix=" /s" />
              </div>
              <div className="gauge__op mono">lane · rows/sec</div>
              <p className="gauge__note">
                journal-backed stream, receipt per row · 228–273
              </p>
            </div>
          </Reveal>
          <Reveal>
            <div className="gauge">
              <div className="gauge__value">
                <CountUp to={297} suffix=" /s" />
              </div>
              <div className="gauge__op mono">kv · keys/sec</div>
              <p className="gauge__note">
                every write a receipt · 273–297 over three runs
              </p>
            </div>
          </Reveal>
        </div>

        <div className="numbers__foot">
          <p className="numbers__foot-line mono">
            conditions: throwaway yard on 127.0.0.1 · windows 11 · go 1.25 ·
            i7-8700 · three runs 2026-10-21
          </p>
          <p className="numbers__foot-line mono">
            reproduce:{" "}
            <span className="numbers__cmd">
              powershell -File scripts/bench.ps1
            </span>
          </p>
          <p className="numbers__reading" data-fill>
            Read it the yardmaster&apos;s way: the top row is the wire&apos;s
            clock. The bottom two gauges are bound by the disk, because
            each journal row waits for fsync, on a system SSD here. On
            slower disks the journal numbers fall with the hardware. A
            receipt still means the row is on disk.
          </p>
        </div>
      </div>
    </section>
  );
}
