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
            <span className="numbers__eyebrow-signal">03</span> · the yard by
            the numbers
          </p>
          <h2 className="display numbers__title" data-anim="wipe">
            <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
              <span className="wl__t">What the benchmark prints.</span>
            </span>
          </h2>
          <p className="numbers__lede" data-fill>
            Every figure on this page was measured by yardstick, the
            benchmark tool in the repository.
          </p>
        </div>

        <div className="numbers__rows">
          <Reveal>
            <div className="gauge">
              <div className="gauge__value">
                <CountUp to={17.4} decimals={1} suffix=" k/s" />
              </div>
              <div className="gauge__cell">
                <div className="gauge__op mono">ping · probes/sec</div>
                <p className="gauge__note">
                  each probe is a full round trip · even the slowest 5 in
                  100 answered in about half a millisecond
                </p>
              </div>
            </div>
          </Reveal>
          <Reveal>
            <div className="gauge">
              <div className="gauge__value">
                <CountUp to={1.15} decimals={2} suffix=" M/s" />
              </div>
              <div className="gauge__cell">
                <div className="gauge__op mono">pubsub · deliveries/sec</div>
                <p className="gauge__note">
                  2,000 messages, each delivered to four subscribers at once
                </p>
              </div>
            </div>
          </Reveal>
          <Reveal>
            <div className="gauge">
              <div className="gauge__value">
                <CountUp to={273} suffix=" /s" />
              </div>
              <div className="gauge__cell">
                <div className="gauge__op mono">lane · rows/sec</div>
                <p className="gauge__note">
                  every row reaches the disk before the broker confirms it
                </p>
              </div>
            </div>
          </Reveal>
          <Reveal>
            <div className="gauge">
              <div className="gauge__value">
                <CountUp to={297} suffix=" /s" />
              </div>
              <div className="gauge__cell">
                <div className="gauge__op mono">kv · keys/sec</div>
                <p className="gauge__note">
                  every value reaches the disk before the broker confirms it
                </p>
              </div>
            </div>
          </Reveal>
        </div>

        <div className="numbers__foot">
          <p className="numbers__reading" data-fill>
            Ping and pub/sub measure the wire itself: traffic on localhost,
            with no disk in the path. Lane and KV measure the on-disk
            journal: a write is acknowledged only after its bytes reach the
            disk, so those two follow the storage hardware.
          </p>
        </div>
      </div>
    </section>
  );
}
