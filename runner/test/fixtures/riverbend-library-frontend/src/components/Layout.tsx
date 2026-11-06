import { useState, type ReactNode } from "react";

/**
 * The shared shell.
 *
 * As with the other fixtures, the navigation toggle is real behaviour and the signed-in shape is not: a frontend
 * cannot know who is looking at it, so every page renders the signed-out navigation until something can issue a
 * session. The element is designed; the state behind it is the missing part.
 */

const NAV = [
  { href: "/index.html", label: "Catalogue" },
  { href: "/join.html", label: "Join" },
];

function Mark() {
  return (
    <svg width="30" height="30" viewBox="0 0 36 36" aria-hidden="true">
      <rect width="36" height="36" rx="4" fill="#9C4722" />
      <path d="M8 26 L20 9 L23 11 L11 28 Z" fill="#F6EDE2" />
      <circle cx="26" cy="24" r="5" fill="none" stroke="#F6EDE2" strokeWidth="2.5" />
    </svg>
  );
}

export interface Member {
  name: string;
  role: "member" | "staff";
}

export function Layout({ current, member = null, children }: { current: string; member?: Member | null; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  const nav = [...NAV];
  if (member?.role === "staff") nav.push({ href: "/admin.html", label: "Library desk" });
  if (member) nav.push({ href: "/account.html", label: "Your reservations" });

  return (
    <>
      <header className="site-header">
        <div className="shell">
          <a className="brand" href="/index.html">
            <Mark />
            Riverbend Tool Library
          </a>

          <button className="nav-toggle" type="button" aria-expanded={open} aria-controls="primary-nav" onClick={() => setOpen((v) => !v)}>
            {open ? "Close" : "Menu"}
          </button>

          <nav id="primary-nav" className={open ? "site-nav is-open" : "site-nav"} aria-label="Primary">
            <ul>
              {nav.map((n) => (
                <li key={n.href}>
                  <a href={n.href} aria-current={n.href === current ? "page" : undefined}>{n.label}</a>
                </li>
              ))}
              <li>
                {member
                  ? <button id="sign-out" className="btn ghost small" type="button">Sign out</button>
                  : <a className="btn small" href="/login.html">Sign in</a>}
              </li>
            </ul>
          </nav>
        </div>
      </header>

      <main>{children}</main>

      <footer className="site-footer">
        <div className="shell">
          <div>
            <a className="brand" href="/index.html"><Mark />Riverbend Tool Library</a>
            <p style={{ maxWidth: "40ch", marginTop: 14, color: "rgba(228,216,203,0.82)" }}>
              A community tool library at 14 Mill Lane. Members borrow up to three items for seven days at a time.
            </p>
          </div>
          <div>
            <h3>Library</h3>
            <ul>
              {NAV.map((n) => <li key={n.href}><a href={n.href}>{n.label}</a></li>)}
              <li><a href="/login.html">Sign in</a></li>
            </ul>
          </div>
          <div>
            <h3>Opening hours</h3>
            <ul>
              <li>Wed &amp; Fri, 10am&ndash;6pm</li>
              <li>Sat, 9am&ndash;2pm</li>
              <li><a href="mailto:desk@riverbendtools.test">desk@riverbendtools.test</a></li>
            </ul>
          </div>
        </div>
        <div className="shell legal">© 2026 Riverbend Tool Library. A volunteer-run community project.</div>
      </footer>
    </>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className={error ? "field invalid" : "field"}>
      <span>{label}</span>
      {children}
      {hint && !error ? <span className="hint">{hint}</span> : null}
      {error ? <span className="error">{error}</span> : null}
    </label>
  );
}
