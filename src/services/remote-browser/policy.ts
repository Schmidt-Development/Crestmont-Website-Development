// Request policy for Crestmont's remote-browser viewer (Mode B, docs/frontend/PORTFOLIO.md). Every request the remote
// Chromium makes is paused and decided here before it leaves the browser:
//   • only https to public DNS names — no IP literals, localhost, internal/link-local names or cloud metadata hosts;
//   • only reading methods (GET/HEAD/OPTIONS): form posts, purchases, uploads and any other state change are refused;
//   • page navigations stay on the project's own site (its host and subdomains) and never reach sign-in, account, admin,
//     owner, dashboard, billing, checkout or similar private routes;
//   • sub-resources (images, scripts, fonts, styles from CDNs) may come from any public host, read-only.
// Nothing here weakens the visited site's own protections: authentication, bot checks and access rules apply as for any
// visitor, and a challenge or refusal is shown as such.

export type RequestDecision = { action: "continue" } | { action: "fail"; reason: string } | { action: "block-page"; title: string; message: string };

const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** Hosts a remote session may never contact, whatever else holds. */
export function forbiddenHost(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return "no host";
  if (h.startsWith("[") || h.includes(":")) return "IP address";
  if (/^\d+(\.\d+){0,3}$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return "IP address";
  if (!HOST_RE.test(h)) return "not a public host name";
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa|test|invalid|example|onion)$/.test(h)) return "internal host name";
  if (/(^|\.)(metadata\.google\.internal|metadata\.azure\.com|instance-data|metadata)$/.test(h) || h === "169.254.169.254") return "cloud metadata host";
  return null;
}

/** The site a project's live URL belongs to: its host without a leading "www.". Navigations may stay on that host and
 *  its subdomains (www., app., …). */
export function siteOf(liveUrl: string): string | null {
  try { const u = new URL(liveUrl); if (u.protocol !== "https:" || forbiddenHost(u.hostname)) return null; return u.hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}
export const onSite = (hostname: string, site: string) => { const h = hostname.toLowerCase(); return h === site || h.endsWith(`.${site}`); };

/** Private or sensitive routes that are never part of a public demonstration (case-insensitive, path segments). */
const SENSITIVE_SEGMENTS = new Set([
  "login", "log-in", "signin", "sign-in", "signon", "sso", "auth", "oauth", "oauth2", "authorize", "logout", "log-out", "signout", "sign-out",
  "register", "signup", "sign-up", "password", "reset-password", "forgot-password", "verify", "mfa", "2fa",
  "account", "accounts", "my-account", "myaccount", "profile", "settings", "preferences",
  "admin", "administrator", "wp-admin", "wp-login.php", "owner", "staff", "dashboard", "portal", "console", "manage", "backend", "cms",
  "billing", "invoice-portal", "checkout", "cart", "basket", "payment", "payments", "pay", "subscribe", "subscription", "subscriptions", "order", "orders", "purchase",
  "api", "graphql", "upload", "uploads", "download", "downloads", "export",
]);
export function sensitivePath(pathname: string): string | null {
  let p: string;
  try { p = decodeURIComponent(pathname).toLowerCase(); } catch { p = pathname.toLowerCase(); }
  for (const seg of p.split("/").filter(Boolean)) {
    const s = seg.replace(/\.(html?|php|aspx?)$/, "");
    if (SENSITIVE_SEGMENTS.has(seg) || SENSITIVE_SEGMENTS.has(s)) return seg;
  }
  return null;
}

export interface RequestFacts { url: string; method: string; resourceType: string; isNavigation: boolean }
/** Decides one paused request. `site` comes from siteOf(project live URL). */
export function decideRequest(r: RequestFacts, site: string): RequestDecision {
  let u: URL;
  try { u = new URL(r.url); } catch { return { action: "fail", reason: "invalid URL" }; }
  if (u.protocol === "data:" || u.protocol === "blob:") return r.isNavigation ? { action: "fail", reason: "data/blob navigation" } : { action: "continue" };
  if (u.protocol !== "https:") return r.isNavigation
    ? { action: "block-page", title: "Not available in this demonstration", message: "Only secure (https) pages of this website can be opened here." }
    : { action: "fail", reason: `${u.protocol} request` };
  const bad = forbiddenHost(u.hostname);
  if (bad) return r.isNavigation ? { action: "block-page", title: "Not available in this demonstration", message: "That address is not a public website." } : { action: "fail", reason: bad };
  const method = r.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    return r.isNavigation
      ? { action: "block-page", title: "Submitting is turned off in this demonstration", message: "Forms, sign-in, purchases and uploads are disabled in Crestmont's portfolio viewer. Visit the live website to use them." }
      : { action: "fail", reason: `${method} request` };
  }
  // The browser's own favicon fetch for a page it was refused (the notice is shown under that page's address) must not
  // reach that other website either.
  if (!r.isNavigation && !onSite(u.hostname, site) && /\/favicon\.ico$/i.test(u.pathname)) return { action: "fail", reason: "favicon of another website" };
  if (r.isNavigation) {
    if (!onSite(u.hostname, site)) return { action: "block-page", title: "This link leaves the website", message: `The demonstration stays on ${site}. Visit the live website to follow links elsewhere.` };
    const s = sensitivePath(u.pathname);
    if (s) return { action: "block-page", title: "Private page", message: "Sign-in, account, administration, billing and checkout pages are not part of the public demonstration." };
  }
  return { action: "continue" };
}

/** A small, self-contained notice page served in place of a refused navigation (no external resources). */
export function blockPageHtml(title: string, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="icon" href="data:,">
<style>html,body{margin:0;height:100%;background:#0b0b0b;color:#f4f1ea;font:16px/1.5 system-ui,sans-serif}main{min-height:100%;display:grid;place-content:center;gap:12px;padding:32px;text-align:center}h1{margin:0;font-size:22px;color:#d7b56f}p{margin:0;max-width:44ch;color:#cfc9bd}button{margin-top:8px;font:inherit;padding:10px 18px;border-radius:999px;border:1px solid #d7b56f;background:transparent;color:#f4f1ea;cursor:pointer}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p><p><button onclick="history.back()">Go back</button></p></main></body></html>`;
}

/**
 * Runs in every page of a remote session before the site's own scripts. It disables what a public demonstration must
 * not do: password entry, form submission, new windows, file pickers and downloads by link. It does not change how the
 * site looks or behaves otherwise.
 */
export const GUARD_SCRIPT = `(() => {
  try {
    const note = "Disabled in Crestmont's portfolio demonstration";
    window.open = function () { return null; };
    const lock = (el) => { if (el && el.tagName === "INPUT" && (el.type === "password" || el.type === "file")) { el.readOnly = true; el.disabled = true; el.title = note; } };
    document.addEventListener("submit", (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
    document.addEventListener("focusin", (e) => lock(e.target), true);
    document.addEventListener("click", (e) => {
      const a = e.target && e.target.closest ? e.target.closest("a[download], input[type=file]") : null;
      if (a) { e.preventDefault(); e.stopImmediatePropagation(); }
      const t = e.target && e.target.closest ? e.target.closest("a[target]") : null;
      if (t && t.target && t.target !== "_self") t.target = "_self";
    }, true);
    new MutationObserver(() => document.querySelectorAll("input[type=password],input[type=file]").forEach(lock)).observe(document.documentElement, { subtree: true, childList: true });
  } catch (_) {}
})();`;
