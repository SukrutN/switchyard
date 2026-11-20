import CopyBlock from "./CopyBlock";
import Reveal from "./Reveal";
import "./quickstart.css";

/**
 * The quickstart, exactly as the README runs it, four stations,
 * each copyable. Nothing added, nothing polished into inaccuracy.
 */
export default function Quickstart() {
  return (
    <section className="section section--pad quickstart" id="quickstart">
      <div className="wrp">
        <div className="quickstart__head">
          <p className="eyebrow">
            <span className="quickstart__signal">05</span> · quickstart
          </p>
          <h2 className="display quickstart__title" data-anim="wipe">
            <span className="wl" style={{ "--i": 0 } as React.CSSProperties}>
              <span className="wl__t">
                One minute to your first delivery.
              </span>
            </span>
          </h2>
          <p className="quickstart__lede">
            Needs <span className="mono">go 1.25</span>. The first yard runs
            in memory only; step 3 gives the journal a home, step 4 wraps it
            in tokens and TLS.
          </p>
        </div>

        <div className="quickstart__steps">
          <Reveal>
            <div className="qstep">
              <div className="qstep__rail">
                <span className="qstep__num mono">01</span>
                <p className="qstep__why">
                  one command and the yard is up on 127.0.0.1:4780, in
                  memory, with nothing on disk yet.
                </p>
              </div>
              <CopyBlock
                code={"git clone https://github.com/SukrutN/switchyard\ncd switchyard\ngo run ./cmd/switchyard"}
              />
            </div>
          </Reveal>

          <Reveal>
            <div className="qstep">
              <div className="qstep__rail">
                <span className="qstep__num mono">02</span>
                <p className="qstep__why">
                  a watcher in one shell, a publish in another.
                </p>
              </div>
              <CopyBlock
                code={"go run ./cmd/spur ping\ngo run ./cmd/spur sub 'orders.*.paid' &\ngo run ./cmd/spur pub 'orders.e9.paid' 'box 42 left the dock'"}
              />
            </div>
          </Reveal>

          <Reveal>
            <div className="qstep">
              <div className="qstep__rail">
                <span className="qstep__num mono">03</span>
                <p className="qstep__why">
                  give the journal a home and the lane verbs light up.
                  Restart on the same dir and durable consumers replay
                  exactly the rows never acknowledged.
                </p>
              </div>
              <CopyBlock
                code={"go run ./cmd/switchyard -data-dir ./data\ngo run ./cmd/spur stream create orders\ngo run ./cmd/spur stream push orders orders.9001.paid 'box 42 left the dock'\ngo run ./cmd/spur kv set orders box-42 'box 42'\ngo run ./cmd/spur yard"}
              />
            </div>
          </Reveal>

          <Reveal>
            <div className="qstep">
              <div className="qstep__rail">
                <span className="qstep__num mono">04</span>
                <p className="qstep__why">
                  a token required before HELLO, TLS on every byte. The
                  README&apos;s rule: a password on an unwrapped wire is not
                  an operating mode, so use both.
                </p>
              </div>
              <CopyBlock
                code={"go run ./cmd/switchyard -auth shh -cert cert.pem -key key.pem\ngo run ./cmd/spur yard -auth shh -tls -insecure"}
              />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
