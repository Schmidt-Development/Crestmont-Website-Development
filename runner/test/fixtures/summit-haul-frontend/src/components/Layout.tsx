import { useState, type ReactNode } from "react";

const NAV = [
  { href: "/index.html", label: "Home" },
  { href: "/services.html", label: "Services" },
  { href: "/quote.html", label: "Get a quote" },
];

function Mark() {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
      <rect width="34" height="34" rx="3" fill="#D98324" />
      <path d="M6 23 L13 10 L20 23 Z" fill="#1F3D2B" />
      <path d="M17 23 L23 13 L29 23 Z" fill="#15291D" />
    </svg>
  );
}

/**
 * The shared shell. The navigation toggle is real client-side behaviour — it flips `aria-expanded` and adds a
 * class — so the import's interaction probe should classify it as already functional and NOT as something
 * waiting on a backend.
 */
export function Layout({ current, children }: { current: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <header className="site-header">
        <div className="shell">
          <a className="brand" href="/index.html">
            <Mark />
            Summit Haul Co.
          </a>

          <button
            className="nav-toggle"
            type="button"
            aria-expanded={open}
            aria-controls="primary-nav"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Close" : "Menu"}
          </button>

          <nav id="primary-nav" className={open ? "site-nav is-open" : "site-nav"} aria-label="Primary">
            <ul>
              {NAV.map((n) => (
                <li key={n.href}>
                  <a href={n.href} aria-current={n.href === current ? "page" : undefined}>
                    {n.label}
                  </a>
                </li>
              ))}
              <li>
                <a href="tel:+15175550123">(517) 555-0123</a>
              </li>
            </ul>
          </nav>
        </div>
      </header>

      <main>{children}</main>

      <footer className="site-footer">
        <div className="shell">
          <div>
            <a className="brand" href="/index.html">
              <Mark />
              Summit Haul Co.
            </a>
            <p style={{ maxWidth: "38ch", marginTop: 16, color: "rgba(232,220,200,0.8)" }}>
              Junk removal and hauling across mid-Michigan. Licensed, insured, and in and out the same day.
            </p>
          </div>
          <div>
            <h3>Company</h3>
            <ul>
              {NAV.map((n) => (
                <li key={n.href}>
                  <a href={n.href}>{n.label}</a>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3>Contact</h3>
            <ul>
              <li><a href="tel:+15175550123">(517) 555-0123</a></li>
              <li><a href="mailto:dispatch@summithaul.test">dispatch@summithaul.test</a></li>
              <li>Mon&ndash;Sat, 7am&ndash;7pm</li>
            </ul>
          </div>
        </div>
        <div className="shell legal">© 2026 Summit Haul Co. All rights reserved.</div>
      </footer>
    </>
  );
}
