import "./footer.css";

/** The house sign. Three hairline columns and one honesty line. */
export default function SiteFooter() {
  return (
    <footer className="footer" id="footer">
      <div className="wrp">
        <div className="footer__grid">
          <div className="footer__brand">
            <div className="footer__mark">
              <span>switchyard</span>
              <span className="footer__ver mono">/1.0.0</span>
            </div>
            <p className="footer__pitch">
              A Go message broker in one binary, documented in one file. The
              README is short, and the tests keep it honest.
            </p>
          </div>

          <nav className="footer__col" aria-label="the broker">
            <p className="footer__head">THE BROKER</p>
            <a
              className="wl-link"
              href="https://github.com/SukrutN/switchyard"
              target="_blank"
              rel="noreferrer"
            >
              the repository
            </a>
            <a
              className="wl-link"
              href="https://github.com/SukrutN/switchyard#switchyard"
              target="_blank"
              rel="noreferrer"
            >
              the README
            </a>
            <a
              className="wl-link"
              href="https://github.com/SukrutN/switchyard/blob/main/scripts/bench.ps1"
              target="_blank"
              rel="noreferrer"
            >
              the bench rod
            </a>
          </nav>

          <nav className="footer__col" aria-label="the documents">
            <p className="footer__head">THE FAMILY</p>
            <a className="wl-link" href="/boxcar/">
              boxcar · unit-04 · the pack-out
            </a>
            <a className="wl-link" href="/despatch/">
              despatch · unit-01 · the despatch board
            </a>
            <a className="wl-link" href="/foreman/">
              foreman · unit-06 · the labor plan
            </a>
            <a className="wl-link" href="/gangway/">
              gangway · unit-10 · the dock day
            </a>
            <a className="wl-link" href="/dcsim/">
              dcsim · unit-11 · one closed hour
            </a>
            <p className="footer__head footer__head--gap">THE YARD</p>
            <a
              className="wl-link"
              href="https://github.com/SukrutN/switchyard/blob/main/docs/PROTOCOL.md"
              target="_blank"
              rel="noreferrer"
            >
              PROTOCOL.md · the wire
            </a>
            <a
              className="wl-link"
              href="https://github.com/SukrutN/switchyard/blob/main/CHANGELOG.md"
              target="_blank"
              rel="noreferrer"
            >
              CHANGELOG.md · the birthlog
            </a>
          </nav>

          <div className="footer__col" aria-label="the house">
            <p className="footer__head">THE HOUSE</p>
            <p className="footer__law">
              Every number on this page was printed by the yard first.
            </p>
            <p className="footer__lic mono">apache-2.0</p>
            <p className="footer__lic mono">built by sukrut nadigotti</p>
          </div>
        </div>

        <div className="footer__base">
          <span className="mono footer__base-line">
            site/ in the switchyard repo · next.js, exported static, deployed from main
          </span>
          <span className="mono footer__base-line">
            <a
              className="footer__top wl-link"
              href="#top"
            >
              back to the yard ⇧
            </a>
          </span>
        </div>
      </div>
    </footer>
  );
}
