import "./footer.css";

/** The house sign: hairline columns and the provenance line. */
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
              A Go message broker in one binary, documented in one file.
            </p>
          </div>

          <nav className="footer__col" aria-label="the broker">
            <p className="footer__head">The broker</p>
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
              the benchmark suite
            </a>
          </nav>

          <nav className="footer__col" aria-label="the documents">
            <p className="footer__head">The documents</p>
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
              CHANGELOG.md · the releases
            </a>
          </nav>

          <div className="footer__col" aria-label="the house">
            <p className="footer__head">The house</p>
            <p className="footer__law">
              Every number on this page was measured by the repo&apos;s own
              tools.
            </p>
            <p className="footer__lic mono">apache-2.0</p>
            <p className="footer__lic mono">built by sukrut nadigotti</p>
          </div>
        </div>

        <div className="footer__base">
          <span className="mono footer__base-line">
            site/ in the switchyard repository
          </span>
          <span className="mono footer__base-line">
            <a className="footer__top wl-link" href="#top">
              back to the yard ⇧
            </a>
          </span>
        </div>
      </div>
    </footer>
  );
}
