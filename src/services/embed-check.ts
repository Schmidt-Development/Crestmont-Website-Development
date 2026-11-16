// Live-site embedding check (Owner, 2026-11-15: the portfolio shows each client's real, working website). Before the
// portfolio frames a live site, Crestmont asks that site — over the network, exactly as a browser would load it —
// whether it permits being framed by Crestmont's own origin. The answer is read from the site's response headers:
//   • Content-Security-Policy frame-ancestors (every enforced policy must allow Crestmont); when present, browsers
//     ignore X-Frame-Options, so it decides on its own;
//   • otherwise X-Frame-Options (DENY / SAMEORIGIN refuse every other origin).
// Nothing here weakens or bypasses a site's choice: a site that refuses framing is shown with a genuine screenshot and
// its "Visit live website" link instead. The check never sends cookies or credentials and only follows https redirects
// to public host names.
//
// Egress (src/lib/egress.ts): the deployed Worker only reaches allow-listed provider hosts. For each request this check
// makes, the one validated host is allowed for the duration of that request and removed again — the same mechanism the
// environment probe uses. Crestmont's own provider hosts and paid AI APIs are never checked (untrustedHostAllowed).

import { allowEgressHost, untrustedHostAllowed } from "../lib/egress.ts";

export type EmbedStatus = "unchecked" | "allowed" | "blocked" | "error";
export interface EmbedCheck { status: Exclude<EmbedStatus, "unchecked">; url: string | null; origin: string | null; detail: string; httpStatus: number | null; title: string | null; description: string | null; siteName: string | null }

const MAX_REDIRECTS = 5;
const MAX_HTML = 512 * 1024;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Only https URLs on public DNS names (no IP literals, no single-label or internal names, default port). */
export function safePublicUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const host = u.hostname.toLowerCase();
  if (!HOST_RE.test(host) || /^\d+(\.\d+)*$/.test(host) || host.includes(":")) return null;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host)) return null;
  return u;
}

/** Splits a (possibly comma-joined) Content-Security-Policy header into its policies' frame-ancestors source lists.
 *  Returns null for a policy that has no frame-ancestors directive. */
export function frameAncestorPolicies(csp: string | null): (string[] | null)[] {
  if (!csp) return [];
  return csp.split(",").map((policy) => {
    for (const d of policy.split(";")) {
      const parts = d.trim().split(/\s+/).filter(Boolean);
      if (parts[0]?.toLowerCase() === "frame-ancestors") return parts.slice(1);
    }
    return null;
  });
}

/** CSP source-expression match for frame-ancestors: does `source` allow the ancestor `ancestor` (an https origin)?
 *  `self` is the framed site's own origin. Paths are ignored for frame-ancestors (only origins are compared). */
export function sourceAllows(source: string, ancestor: URL, self: URL): boolean {
  const s = source.trim();
  if (s.length > 300) return false; // no real origin is that long; bounds the work on remote header text
  const lower = s.toLowerCase();
  if (lower === "'none'") return false;
  if (lower === "'self'") return ancestor.origin === self.origin;
  if (lower === "*") return ancestor.protocol === "https:" || ancestor.protocol === "http:";
  if (/^[a-z][a-z0-9+.-]*:$/.test(lower)) return ancestor.protocol === lower || (lower === "http:" && ancestor.protocol === "https:");
  if (lower.startsWith("'")) return false; // nonces, hashes and keywords never match an ancestor
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([a-z0-9.-]+|\*)(?::(\d+|\*))?(?:\/.*)?$/i.exec(s);
  if (!m) return false;
  const [, scheme, wildcard, hostRaw, port] = m;
  const host = hostRaw.toLowerCase(), ah = ancestor.hostname.toLowerCase();
  if (scheme) {
    const sc = scheme.toLowerCase() + ":";
    if (!(sc === ancestor.protocol || (sc === "http:" && ancestor.protocol === "https:"))) return false;
  } else if (!(ancestor.protocol === self.protocol || (self.protocol === "http:" && ancestor.protocol === "https:"))) return false;
  if (host === "*") { /* any host */ } else if (wildcard) { if (!ah.endsWith("." + host)) return false; } else if (ah !== host) return false;
  const aPort = ancestor.port || (ancestor.protocol === "https:" ? "443" : "80");
  if (port) return port === "*" || port === aPort;
  return !ancestor.port; // no port in the source: only the scheme's default port matches
}

/** Decides from response headers whether `ancestorOrigin` may frame the page at `pageUrl`. */
export function evaluateFraming(headers: Headers, pageUrl: URL, ancestorOrigin: string): { allowed: boolean; detail: string } {
  const ancestor = new URL(ancestorOrigin);
  const policies = frameAncestorPolicies(headers.get("content-security-policy")).filter((p): p is string[] => p !== null);
  if (policies.length) {
    for (const sources of policies) {
      if (!sources.some((src) => sourceAllows(src, ancestor, pageUrl))) {
        return { allowed: false, detail: `Content-Security-Policy frame-ancestors ${sources.join(" ") || "(empty)"} does not include ${ancestor.origin}` };
      }
    }
    return { allowed: true, detail: `Content-Security-Policy frame-ancestors allows ${ancestor.origin}` };
  }
  const xfo = (headers.get("x-frame-options") ?? "").trim().toLowerCase();
  if (xfo === "deny") return { allowed: false, detail: "X-Frame-Options: DENY (the site refuses to be shown inside any other page)" };
  if (xfo === "sameorigin") return pageUrl.origin === ancestor.origin ? { allowed: true, detail: "X-Frame-Options: SAMEORIGIN" } : { allowed: false, detail: "X-Frame-Options: SAMEORIGIN (only the site itself may frame it)" };
  // Browsers treat an unrecognised X-Frame-Options value (including the obsolete ALLOW-FROM) as absent.
  return { allowed: true, detail: xfo ? `No frame-ancestors; X-Frame-Options "${xfo}" is not enforced by browsers` : "No framing restriction is sent" };
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
/** Decodes the common HTML entities in ONE pass (so "&amp;quot;" stays "&quot;"; never double-unescaped). */
const decode = (s: string) => s.replace(/&(?:amp|quot|#39|#x27|lt|gt|nbsp);/g, (m) => ENTITIES[m] ?? m).replace(/\s+/g, " ").trim();
function meta(html: string, attr: "name" | "property", key: string): string | null {
  const re = new RegExp(`<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`, "i");
  const tag = re.exec(html)?.[0];
  const c = tag && /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
  const v = c ? decode(c[2] ?? c[3] ?? "") : "";
  return v || null;
}
/** Page facts the staff form can pre-fill (the staff member confirms or edits every one). */
export function pageFacts(html: string): { title: string | null; description: string | null; siteName: string | null } {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return {
    title: t ? decode(t).slice(0, 200) || null : null,
    description: (meta(html, "name", "description") ?? meta(html, "property", "og:description"))?.slice(0, 1000) ?? null,
    siteName: meta(html, "property", "og:site_name")?.slice(0, 120) ?? null,
  };
}

async function readText(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (n < limit) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value); n += value.length;
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(Math.min(n, limit));
  let o = 0;
  for (const c of chunks) { const take = Math.min(c.length, all.length - o); all.set(c.subarray(0, take), o); o += take; if (o >= all.length) break; }
  return new TextDecoder().decode(all);
}

/**
 * Loads `liveUrl` the way a visitor's browser would (following https redirects) and reports whether the final page
 * may be framed by `ancestorOrigin` (this Crestmont environment's own origin). `url` is the final address to frame,
 * so the frame never starts with a cross-origin redirect.
 */
export async function checkEmbed(liveUrl: string, ancestorOrigin: string, fetcher: typeof fetch = fetch, timeoutMs = 10_000): Promise<EmbedCheck> {
  const none = { title: null, description: null, siteName: null };
  let url = safePublicUrl(liveUrl);
  if (!url) return { status: "error", url: null, origin: null, detail: "The live link must be a public https:// address", httpStatus: null, ...none };
  let ancestor: URL;
  try { ancestor = new URL(ancestorOrigin); } catch { return { status: "error", url: null, origin: null, detail: "This environment has no valid site address", httpStatus: null, ...none }; }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    if (!untrustedHostAllowed(url.hostname)) return { status: "error", url: url.toString(), origin: url.origin, detail: `${url.hostname} is a service Crestmont itself uses, not a client website, so it is not checked`, httpStatus: null, ...none };
    const release = allowEgressHost(url.hostname);
    try {
      res = await fetcher(url.toString(), {
        method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "user-agent": "Mozilla/5.0 (compatible; CrestmontPortfolioCheck/1.0; +https://crestmontwebsitedevelopment.com/portfolio)" },
      });
    } catch (e) {
      // Keep the real cause (name and message) so a failure is diagnosable from Staff → Portfolio and the release log.
      const why = e instanceof Error ? (e.name === "TimeoutError" ? "timed out" : `${e.name}: ${e.message}`.replace(/\s+/g, " ").slice(0, 200)) : "network error";
      return { status: "error", url: url.toString(), origin: url.origin, detail: `The site did not answer (${why})`, httpStatus: null, ...none };
    } finally {
      release();
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel().catch(() => undefined);
      let next: URL | null = null;
      try { next = safePublicUrl(new URL(res.headers.get("location")!, url).toString()); } catch { next = null; }
      if (!next) return { status: "error", url: url.toString(), origin: url.origin, detail: `The site redirects to an address that is not a public https:// page`, httpStatus: res.status, ...none };
      url = next;
      continue;
    }
    // A bot check (e.g. Cloudflare's managed challenge) is the site's protection: Crestmont reports it and never tries
    // to get past it, so such a site is shown with the honest fallback (Mode C).
    if (res.headers.get("cf-mitigated") === "challenge") {
      await res.body?.cancel().catch(() => undefined);
      return { status: "error", url: url.toString(), origin: url.origin, detail: "The site answers automated visitors with a bot check, which Crestmont does not bypass", httpStatus: res.status, ...none };
    }
    if (res.status < 200 || res.status > 299) {
      await res.body?.cancel().catch(() => undefined);
      return { status: "error", url: url.toString(), origin: url.origin, detail: `The site answered HTTP ${res.status}`, httpStatus: res.status, ...none };
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!type.includes("text/html") && !type.includes("application/xhtml")) {
      await res.body?.cancel().catch(() => undefined);
      return { status: "error", url: url.toString(), origin: url.origin, detail: `The link is not a web page (${type || "no content type"})`, httpStatus: res.status, ...none };
    }
    const verdict = evaluateFraming(res.headers, url, ancestor.origin);
    const facts = pageFacts(await readText(res, MAX_HTML).catch(() => ""));
    if (/^(just a moment|attention required|access denied)/i.test(facts.title ?? "")) {
      return { status: "error", url: url.toString(), origin: url.origin, detail: `The site answers automated visitors with a bot check ("${facts.title}"), which Crestmont does not bypass`, httpStatus: res.status, ...facts };
    }
    return { status: verdict.allowed ? "allowed" : "blocked", url: url.toString(), origin: url.origin, detail: verdict.detail, httpStatus: res.status, ...facts };
  }
  return { status: "error", url: url.toString(), origin: url.origin, detail: "The site redirects too many times", httpStatus: null, ...none };
}
