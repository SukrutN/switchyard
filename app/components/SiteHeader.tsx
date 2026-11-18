// The banner: one brand line, one exit. No menus — the site is the page.
// On a family page (cross) the brand names that family and offers the
// way back to the yard; each family passes its own door.
export default function SiteHeader({
  cross = false,
  family = { name: "boxcar", unit: "/unit-04", href: "/boxcar/" },
}: {
  cross?: boolean;
  family?: { name: string; unit: string; href: string };
}) {
  return (
    <header className="site-header">
      <div className="wrp site-header__inner">
        {cross ? (
          <a className="site-header__brand" href={family.href}>
            <span>{family.name}</span>
            <span className="site-header__ver">{family.unit}</span>
          </a>
        ) : (
          <a className="site-header__brand" href="#top">
            <span>switchyard</span>
            <span className="site-header__ver">/1.0.0</span>
          </a>
        )}
        <div className="site-header__links">
          {cross ? (
            <a className="site-header__link wl-link" href="/">
              <span>THE YARD</span>
              <Arrow />
            </a>
          ) : (
            <>
              <a className="site-header__link wl-link" href="/boxcar/">
                <span>BOXCAR</span>
                <Arrow />
              </a>
              <a className="site-header__link wl-link" href="/despatch/">
                <span>DESPATCH</span>
                <Arrow />
              </a>
              <a className="site-header__link wl-link" href="/foreman/">
                <span>FOREMAN</span>
                <Arrow />
              </a>
              <a className="site-header__link wl-link" href="/gangway/">
                <span>GANGWAY</span>
                <Arrow />
              </a>
              <a className="site-header__link wl-link" href="/dcsim/">
                <span>DCSIM</span>
                <Arrow />
              </a>
            </>
          )}
          <a
            className="site-header__link wl-link"
            href="https://github.com/SukrutN/switchyard"
            target="_blank"
            rel="noreferrer"
          >
            <span>GITHUB</span>
            <Arrow />
          </a>
        </div>
      </div>
    </header>
  );
}

function Arrow() {
  return (
    <svg className="arrow" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M7.3 0.7 10.9 6l-3.6 5.3H5.4l2.4-3.3H1v-4h6.8L5.4 0.7h1.9Z" />
    </svg>
  );
}
