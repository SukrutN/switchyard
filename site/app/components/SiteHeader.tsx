// The banner: one brand line, one exit. No menus, the site is the page.
export default function SiteHeader() {
  return (
    <header className="site-header">
      <div className="wrp site-header__inner">
        <a className="site-header__brand" href="#top">
          <span>switchyard</span>
          <span className="site-header__ver">/1.0.0</span>
        </a>
        <div className="site-header__links">
          <a
            className="site-header__link wl-link"
            href="https://github.com/SukrutN/switchyard"
            target="_blank"
            rel="noreferrer"
          >
            <span>GitHub</span>
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
