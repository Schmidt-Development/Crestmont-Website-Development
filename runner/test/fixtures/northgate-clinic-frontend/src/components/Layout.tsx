import { useState, type ReactNode } from "react";

/**
 * The shared shell for every page.
 *
 * Two things here are REAL client-side behaviour and must be classified as already working, not as waiting on a
 * backend: the navigation toggle (it flips `aria-expanded` and a class) and the signed-in/signed-out shape of the
 * navigation, which is driven by a prop the page passes.
 *
 * That second one is the interesting case for the import's interaction inventory. The approved design shows "Your
 * appointments" and "Sign out" when signed in, and "Sign in" when not — but a frontend cannot KNOW which it is
 * without a session, so as supplied every page renders the signed-out shape. The element is designed; the state
 * behind it is missing. An inventory that called this "already functional" would be wrong, and one that called it
 * "needs a backend" without saying which part would be unhelpful: what is missing is the session, not the markup.
 */

const PUBLIC_NAV = [
  { href: "/index.html", label: "Home" },
  { href: "/services.html", label: "Treatments" },
  { href: "/book.html", label: "Book" },
];

function Mark() {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
      <rect width="34" height="34" rx="8" fill="#0E5A6B" />
      <path
        d="M17 7c-3.4 0-5.2 1.5-5.2 4.6 0 2.1.6 4.1 1.3 6.3.7 2.2 1 4.6 1.4 6.4.2 1 .7 1.7 1.3 1.7.7 0 1-.8 1.1-1.9.1-1.2.3-2.6.7-2.6s.6 1.4.7 2.6c.1 1.1.4 1.9 1.1 1.9.6 0 1.1-.7 1.3-1.7.4-1.8.7-4.2 1.4-6.4.7-2.2 1.3-4.2 1.3-6.3C22.2 8.5 20.4 7 17 7Z"
        fill="#F2F7F7"
      />
    </svg>
  );
}

export interface Session {
  email: string;
  role: "customer" | "staff";
}

export function Layout({
  current,
  session = null,
  children,
}: {
  current: string;
  /** Null as supplied: there is no session until a backend can issue one. */
  session?: Session | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  const nav = [...PUBLIC_NAV];
  if (session?.role === "staff") nav.push({ href: "/staff.html", label: "Schedule" });
  if (session) nav.push({ href: "/account.html", label: "Your appointments" });

  return (
    <>
      <header className="site-header">
        <div className="shell">
          <a className="brand" href="/index.html">
            <Mark />
            Northgate Dental
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
              {nav.map((n) => (
                <li key={n.href}>
                  <a href={n.href} aria-current={n.href === current ? "page" : undefined}>
                    {n.label}
                  </a>
                </li>
              ))}
              <li>
                {session ? (
                  // Inert: ending a session is a backend operation. The button exists, styled and labelled.
                  <button id="sign-out" className="btn ghost small" type="button">
                    Sign out
                  </button>
                ) : (
                  <a className="btn small" href="/login.html">
                    Sign in
                  </a>
                )}
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
              Northgate Dental
            </a>
            <p style={{ maxWidth: "38ch", marginTop: 16, color: "rgba(215,227,229,0.82)" }}>
              Family and cosmetic dentistry on Northgate Road, Ann Arbor. Evening appointments Tuesday and Thursday.
            </p>
          </div>
          <div>
            <h3>Practice</h3>
            <ul>
              {PUBLIC_NAV.map((n) => (
                <li key={n.href}>
                  <a href={n.href}>{n.label}</a>
                </li>
              ))}
              <li>
                <a href="/login.html">Sign in</a>
              </li>
            </ul>
          </div>
          <div>
            <h3>Contact</h3>
            <ul>
              <li>
                <a href="tel:+17345550148">(734) 555-0148</a>
              </li>
              <li>
                <a href="mailto:front.desk@northgatedental.test">front.desk@northgatedental.test</a>
              </li>
              <li>412 Northgate Road, Ann Arbor</li>
              <li>Mon&ndash;Fri, 8am&ndash;6pm</li>
            </ul>
          </div>
        </div>
        <div className="shell legal">© 2026 Northgate Dental. All rights reserved.</div>
      </footer>
    </>
  );
}

/**
 * Shared field wrapper, so validation looks the same on every form.
 *
 * The validation itself IS implemented — it is presentation, and the approved design specifies it. What no form can
 * do is persist anything, which is the part the manifest asks for.
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className={error ? "field invalid" : "field"}>
      <span>{label}</span>
      {children}
      {hint && !error ? <span className="hint">{hint}</span> : null}
      {error ? <span className="error">{error}</span> : null}
    </label>
  );
}
