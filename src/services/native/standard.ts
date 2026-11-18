// The native-embedding standard (Owner, 2026-11-18) — one definition used by the onboarding automation, every provider
// adapter, the release checks and the website templates Crestmont builds:
//   • public, read-only marketing pages send `Content-Security-Policy: frame-ancestors <Crestmont origins>` and no
//     X-Frame-Options; never `*`, never another site;
//   • every other page — sign-in, sign-up, accounts, owner/staff/admin areas, booking, quotes and applications, checkout,
//     billing, payment, token links, the API — keeps `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
// Crestmont only ever changes the public set; it never adds a sensitive route to it, whatever a page links to.

/** The origins that may frame a public page: this environment's own origin, and its www twin for an apex domain. */
export function crestmontOrigins(siteOrigin: string): string[] {
  const u = new URL(siteOrigin);
  const out = [u.origin];
  if (u.protocol === "https:" && u.hostname.split(".").length === 2) out.push(`https://www.${u.hostname}`);
  else if (u.protocol === "https:" && u.hostname.startsWith("www.") && u.hostname.split(".").length === 3) out.unshift(`https://${u.hostname.slice(4)}`);
  return out;
}
export const frameAncestorsValue = (siteOrigin: string) => `frame-ancestors ${crestmontOrigins(siteOrigin).join(" ")}`;

/** Sensitive routes by path segment (shared with scripts/preview-explorer-checks.mjs SENSITIVE_ROUTE). */
export const SENSITIVE_ROUTE = /(^|\/)(log-?in|log-?out|sign-?in|sign-?up|sign-?out|register|auth|oauth|sso|account|accounts|my-account|portal|owner|admin|staff|dashboard|checkout|cart|billing|pay|payment|payments|subscribe|subscription|reset-password|password|token|api|book|booking|bookings|appointment|apply|application|applications|quote|quotes|reserve|reservation|reservations|invoice|invoices|order|orders|manage|confirm|confirmation|verify|unsubscribe|_next\/data|graphql|wp-admin|wp-login\.php)(\/|$|\.)/i;

/** A path that may be opened to Crestmont framing: same-site, plain, no query/token, not sensitive, bounded. */
export function isPublicPath(path: string): boolean {
  if (!path.startsWith("/") || path.length > 200 || /[?#\s"\\]/.test(path) || path.includes("..")) return false;
  if (SENSITIVE_ROUTE.test(path)) return false;
  if (/\.(json|xml|txt|js|mjs|css|map|png|jpe?g|gif|webp|svg|ico|pdf|zip|woff2?)$/i.test(path)) return false;
  return true;
}

/** The public pages to open, read from the homepage itself: "/" plus every same-site link that is a public path
 *  (both "/x" and "/x/" so a trailing-slash redirect target is covered). Sorted, unique, at most `max`. */
export function publicPaths(homeUrl: string, html: string, max = 40): string[] {
  const home = new URL(homeUrl);
  const set = new Set<string>(["/"]);
  if (home.pathname !== "/" && isPublicPath(home.pathname)) set.add(home.pathname);
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const raw = (m[2] ?? m[3] ?? "").trim();
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(raw)) continue;
    let u: URL; try { u = new URL(raw.replace(/&amp;/g, "&"), home); } catch { continue; }
    if (u.origin !== home.origin || u.search) continue;
    const p = decodeURI(u.pathname);
    if (!isPublicPath(p)) continue;
    set.add(p);
    if (p !== "/") set.add(p.endsWith("/") ? p.slice(0, -1) : `${p}/`);
    if (set.size >= max) break;
  }
  return [...set].sort().slice(0, max);
}

/** Same-site sensitive paths the homepage links to (checked to still refuse framing after any change). */
export function sensitiveLinks(homeUrl: string, html: string, max = 12): string[] {
  const home = new URL(homeUrl);
  const set = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    let u: URL; try { u = new URL((m[2] ?? m[3] ?? "").replace(/&amp;/g, "&"), home); } catch { continue; }
    if (u.origin === home.origin && SENSITIVE_ROUTE.test(u.pathname)) set.add(u.pathname);
    if (set.size >= max) break;
  }
  return [...set].sort();
}

/** Every frame-ancestors directive in the response's CSP headers (one entry per policy that has one). */
export function frameAncestorDirectives(csp: string | null): string[] {
  if (!csp) return [];
  const out: string[] = [];
  for (const policy of csp.split(",")) for (const d of policy.split(";")) { const t = d.trim(); if (/^frame-ancestors(\s|$)/i.test(t)) out.push(t); }
  return out;
}
