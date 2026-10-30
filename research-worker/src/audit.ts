// Stage-C/E website audit. Every finding states what was observed, where, how, when, with a severity and a confidence,
// and how a person can reproduce it. Indicators (Lighthouse scores, copyright years) are labelled as indicators: they
// are not presented as proof of lost revenue. No form is ever submitted.
import type { Finding, Severity } from "../../src/domain/research.ts";
import type { FetchResult, Http } from "./http.ts";
import type { PageFacts } from "./identity.ts";
import type { BrowserCheck } from "./browser.ts";

const f = (code: string, title: string, severity: Severity, confidence: number, url: string, method: string, evidence: string, reproduction?: string): Finding =>
  ({ code, title, severity, confidence, url, method, observedAt: new Date().toISOString(), evidence: evidence.slice(0, 500), ...(reproduction ? { reproduction: reproduction.slice(0, 300) } : {}) });

const GET = "HTTP GET without JavaScript (CrestmontResearchBot)";

/** A home-page response that means the site is not working for visitors. Null when it is working. */
export function brokenReason(r: FetchResult): { code: string; title: string; evidence: string } | null {
  if (r.robotsBlocked) return null;
  if (r.error) {
    const k = r.error.kind;
    if (k === "blocked_address") return null; // not a public site; never treated as the business's site
    const title = { dns: "Domain does not resolve (DNS)", refused: "Server refuses connections", timeout: "Home page does not respond (timeout)", tls: "Secure connection fails (TLS/certificate error)", reset: "Connection is reset by the server", too_large: "", other: "Home page cannot be loaded" }[k];
    if (!title) return null;
    return { code: `site_${k}`, title, evidence: r.error.message };
  }
  if (r.status !== null && r.status >= 500) return { code: "http_5xx", title: `Home page returns HTTP ${r.status}`, evidence: `Status ${r.status} for ${r.finalUrl}` };
  if (r.status === 404 || r.status === 410) return { code: "http_404", title: `Home page returns HTTP ${r.status}`, evidence: `Status ${r.status} for ${r.finalUrl}` };
  return null;
}

/** HTTP 401/403/429, robots exclusion: the site exists but may not be tested; record it, never work around it. */
export const accessRestricted = (r: FetchResult) => r.robotsBlocked || r.status === 401 || r.status === 403 || r.status === 429;

export function htmlFindings(home: FetchResult, facts: PageFacts, html: string, now = new Date()): Finding[] {
  const out: Finding[] = [];
  const url = home.finalUrl;
  const finalIsHttps = url.startsWith("https://");
  if (!finalIsHttps) out.push(f("no_https", "Site is served without HTTPS", "high", 0.9, url, GET, `Final URL after ${home.chain.length} request(s) is ${url} (plain HTTP)`, `Open ${url} in a browser and look for the "Not secure" warning`));
  if (home.chain.length > 3) out.push(f("redirect_chain", `Home page needs ${home.chain.length - 1} redirects`, "medium", 0.9, home.url, GET, home.chain.map((h) => `${h.status} ${h.url}`).join(" → "), `curl -IL ${home.url}`));
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) out.push(f("no_viewport_meta", "No mobile viewport setting (page is not set up for phone screens)", "high", 0.8, url, GET, "No <meta name=\"viewport\"> tag in the home page HTML", "View the page source and search for name=\"viewport\""));
  if (!facts.title) out.push(f("missing_title", "Home page has no title", "medium", 0.95, url, GET, "Empty or missing <title> element"));
  if (!/<meta[^>]+name=["']description["']/i.test(html)) out.push(f("missing_meta_description", "No meta description for search results", "low", 0.9, url, GET, "No <meta name=\"description\"> tag"));
  if (!facts.h1) out.push(f("missing_h1", "No main heading (h1) on the home page", "low", 0.85, url, GET, "No <h1> element in the server-rendered HTML"));
  if (!/<html[^>]+lang=/i.test(html)) out.push(f("missing_lang", "Page language is not declared (screen readers)", "low", 0.9, url, GET, "<html> has no lang attribute"));
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const noAlt = imgs.filter((i) => !/\balt\s*=/i.test(i)).length;
  if (imgs.length >= 5 && noAlt / imgs.length > 0.5) out.push(f("images_without_alt", `${noAlt} of ${imgs.length} images have no text alternative`, "medium", 0.85, url, GET, `${noAlt}/${imgs.length} <img> elements without an alt attribute`));
  if (finalIsHttps) {
    const mixed = [...html.matchAll(/\b(?:src|href)=["']http:\/\/[^"']+\.(?:js|css|png|jpe?g|gif|webp|svg)["']/gi)].length;
    if (mixed) out.push(f("mixed_content", `${mixed} page resource(s) load over insecure HTTP`, "medium", 0.8, url, GET, `${mixed} http:// script/style/image references on an https page`));
    const insecureForm = /<form[^>]+action=["']http:\/\//i.test(html);
    if (insecureForm) out.push(f("insecure_form", "A form sends data over insecure HTTP", "high", 0.85, url, GET, "<form action=\"http://…\"> on an https page (not submitted)"));
  }
  const obsolete = [/<frameset/i.test(html) && "frameset", /\.swf["'\s]/i.test(html) && "Flash (.swf)", /<marquee/i.test(html) && "marquee", /<font\b/i.test(html) && "font tags"].filter(Boolean);
  if (obsolete.length) out.push(f("obsolete_markup", `Uses obsolete web technology: ${obsolete.join(", ")}`, obsolete.includes("Flash (.swf)") || obsolete.includes("frameset") ? "high" : "medium", 0.85, url, GET, `Found ${obsolete.join(", ")} in the home page HTML`));
  const years = [...facts.text.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?((?:19|20)\d{2})/gi)].map((m) => Number(m[1]));
  const latest = years.length ? Math.max(...years) : null;
  if (latest && latest <= now.getUTCFullYear() - 4) out.push(f("stale_copyright", `Copyright notice last updated ${latest} (indicator the site is not maintained)`, "low", 0.6, url, GET, `Footer copyright year ${latest}`));
  // Without a rendering browser, script-built pages may show contact details we cannot see: recorded, but below the
  // 0.6 confidence that lets a finding drive classification or score.
  if (!facts.phones.length && !/href=["']mailto:/i.test(html) && !/<form/i.test(html)) out.push(f("no_contact_method", "No phone number, email link or contact form in the home page HTML", "medium", /<script/i.test(html) ? 0.4 : 0.7, url, GET, `No tel:/phone pattern, mailto: link or <form> found in the server-rendered HTML${/<script/i.test(html) ? " (page uses scripts; content added by JavaScript was not seen)" : ""}`));
  // Only the final HTML request's own network time counts (never robots.txt fetches or our politeness waits).
  const rt = home.responseMs ?? null;
  if (rt !== null && rt > 4000) out.push(f("slow_response", `Home page HTML took ${(rt / 1000).toFixed(1)} s to arrive`, "medium", 0.6, url, GET, `${rt} ms for the final HTML response (redirects excluded), measured from the research workstation`, "Indicator only; network conditions vary"));
  if (facts.text.length < 40 && !/<script/i.test(html)) out.push(f("empty_page", "Home page has almost no content", "high", 0.75, url, GET, `${facts.text.length} characters of visible text`));
  return out;
}

/** Up to `max` same-site links from the home page, checked politely (robots, per-host interval). */
export async function brokenInternalLinks(http: Http, home: FetchResult, html: string, max = 8): Promise<Finding[]> {
  const base = new URL(home.finalUrl);
  const links = [...new Set([...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)].map((m) => { try { return new URL(m[1], base); } catch { return null; } })
    .filter((u): u is URL => !!u && u.host === base.host && /^https?:$/.test(u.protocol) && !/\.(pdf|jpe?g|png|gif|zip|docx?|xlsx?)$/i.test(u.pathname) && u.href !== base.href).map((u) => u.href))].slice(0, max);
  const bad: string[] = [];
  for (const l of links) {
    const r = await http.get(l, "GET");
    if (!r.robotsBlocked && (r.status === 404 || r.status === 410 || (r.status !== null && r.status >= 500) || (r.error && r.error.kind !== "blocked_address"))) bad.push(`${l} → ${r.status ?? r.error?.kind}`);
  }
  return bad.length ? [f("broken_internal_links", `${bad.length} of ${links.length} checked internal links are broken`, bad.length >= 3 ? "high" : "medium", 0.9, home.finalUrl, `${GET}, ${links.length} same-site links`, bad.slice(0, 6).join("; "), "Open each link listed")] : [];
}

export function browserFindings(url: string, b: BrowserCheck): Finding[] {
  const out: Finding[] = [];
  const m = `Playwright Chromium ${b.viewport} (mobile emulation)`;
  if (b.error) return out;
  if (b.overflowPx > 8) out.push(f("mobile_horizontal_scroll", "Page is wider than a phone screen (sideways scrolling)", "high", 0.9, url, m, `document width ${b.scrollWidth}px vs viewport ${b.viewportWidth}px`, `Open on a phone or in device mode at ${b.viewport}`));
  if (b.textLength < 40) out.push(f("render_blank", "Page renders almost no content in a browser", "critical", 0.8, url, m, `${b.textLength} characters of visible text after load`));
  if (b.consoleErrors >= 3) out.push(f("script_errors", `${b.consoleErrors} JavaScript errors while loading`, "medium", 0.75, url, m, b.firstErrors.join(" | ").slice(0, 400)));
  if (b.smallTapTargets >= 5) out.push(f("small_tap_targets", `${b.smallTapTargets} links/buttons are too small to tap reliably`, "medium", 0.7, url, m, `${b.smallTapTargets} interactive elements under 24×24 px`));
  return out;
}

export function lighthouseFindings(url: string, scores: { performance: number | null; accessibility: number | null; seo: number | null; version: string }): Finding[] {
  const out: Finding[] = [];
  const m = `Lighthouse ${scores.version} mobile (indicator)`;
  if (scores.performance !== null && scores.performance < 0.5) out.push(f("lighthouse_performance", `Lighthouse mobile performance score ${Math.round(scores.performance * 100)}/100`, "medium", 0.7, url, m, `performance ${scores.performance}`, "Run Lighthouse (mobile) in Chrome DevTools"));
  if (scores.accessibility !== null && scores.accessibility < 0.7) out.push(f("lighthouse_accessibility", `Lighthouse accessibility score ${Math.round(scores.accessibility * 100)}/100`, "medium", 0.7, url, m, `accessibility ${scores.accessibility}`));
  if (scores.seo !== null && scores.seo < 0.7) out.push(f("lighthouse_seo", `Lighthouse SEO score ${Math.round(scores.seo * 100)}/100`, "low", 0.7, url, m, `seo ${scores.seo}`));
  return out;
}
