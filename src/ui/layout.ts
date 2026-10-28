// Page shells. Every surface shares the design system in /assets/app.css (BRAND-006) — see docs/frontend/DESIGN.md.
import { html, safeUrl, type SafeHtml } from "../lib/html.ts";
import type { AppContext } from "../app/context.ts";
import { can, type Permission } from "../domain/authz.ts";
import { csrf, drawerShell, skeleton, ctaLink } from "./components.ts";
import { requestAttribution } from "../services/leads.ts";

// Type is self-hosted from /assets/fonts (SIL OFL): Inter Display Medium for headlines, Inter for text and UI.
// The faces used above the fold are preloaded; no third-party font requests.
const PRELOAD_FONTS = ["/assets/fonts/InterDisplay-Medium.woff", "/assets/fonts/Inter-Regular.woff", "/assets/fonts/Inter-Medium.woff"];

export interface PageMeta { title: string; description?: string; path?: string; noindex?: boolean; canonical?: string }

function head(ctx: AppContext, m: PageMeta): SafeHtml {
  const title = m.title.includes("Crestmont") ? m.title : `${m.title} · Crestmont Website Development`;
  const canonical = m.canonical ?? (ctx.baseUrl + (m.path ?? ctx.url.pathname));
  return html`<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${m.description ? html`<meta name="description" content="${m.description}">` : ""}
${m.noindex || ctx.env.ENVIRONMENT !== "production" ? html`<meta name="robots" content="noindex, nofollow">` : html`<link rel="canonical" href="${canonical}">`}
<meta property="og:title" content="${title}"><meta property="og:type" content="website">${m.description ? html`<meta property="og:description" content="${m.description}">` : ""}
<meta name="theme-color" content="#080808"><meta name="color-scheme" content="dark">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/brand/favicon-32.png"><link rel="icon" type="image/png" sizes="16x16" href="/assets/brand/favicon-16.png">
${PRELOAD_FONTS.map((f) => html`<link rel="preload" href="${f}" as="font" type="font/woff" crossorigin>`)}<link rel="stylesheet" href="/assets/app.css">
<noscript><link rel="stylesheet" href="/assets/nojs.css"></noscript><script src="/assets/app.js" defer></script></head>`;
}

/** Header mark: the original crest artwork (unaltered, 2× pixel density) in a black tile of its own background
 *  colour, plus the company name as text. */
export function brandMark(href = "/"): SafeHtml {
  return html`<a class="brand" href="${href}" aria-label="Crestmont Website Development — home">
<span class="brand__tile"><img class="brand__mark" src="/assets/brand/crestmont-crest.png" width="42" height="41" alt="" decoding="async"></span>
<span><span class="brand__word">CRESTMONT</span><span class="brand__sub">WEBSITE DEVELOPMENT</span></span></a>`;
}

/**
 * Decorative engraved ring drawn around the crest lockup (hero, sign-in panel). Pure SVG line work in the
 * logo's gold; aria-hidden. Its centre is transparent over --ink-0, the artwork's own background colour.
 * With JavaScript the rings "engrave" once on load (pathLength=1 dash animation); reduced motion skips it.
 */
export function crestRing(): SafeHtml {
  const ticks = Array.from({ length: 72 }, (_, i) => {
    const a = (i / 72) * Math.PI * 2, long = i % 6 === 0;
    const r1 = 189, r2 = long ? 178 : 183;
    const p = (r: number) => `${(200 + r * Math.sin(a)).toFixed(2)} ${(200 - r * Math.cos(a)).toFixed(2)}`;
    return `M${p(r1)}L${p(r2)}`;
  }).join("");
  return html`<svg class="hero__ring" viewBox="0 0 400 400" aria-hidden="true" focusable="false">
<circle class="ring-draw" style="--i:0" cx="200" cy="200" r="197" fill="none" stroke="currentColor" stroke-width=".75" pathLength="1"/>
<circle class="ring-draw" style="--i:1" cx="200" cy="200" r="170" fill="none" stroke="currentColor" stroke-width=".6" stroke-opacity=".7" pathLength="1"/>
<circle class="ring-draw" style="--i:2" cx="200" cy="200" r="163" fill="none" stroke="var(--gold-2)" stroke-width="1" pathLength="1"/>
<path class="ring-ticks" d="${ticks}" stroke="currentColor" stroke-width=".7" stroke-opacity=".85" fill="none"/>
</svg>`;
}

function flashToast(ctx: AppContext): SafeHtml {
  if (!ctx.flash) return html``;
  return html`<div class="toast alert alert--${ctx.flash.kind}" role="status">${ctx.flash.text}</div>`;
}

function envBanner(ctx: AppContext): SafeHtml {
  if (ctx.env.ENVIRONMENT === "production") return html``;
  return html`<div class="draft-banner">${ctx.env.ENVIRONMENT === "staging" ? "Staging environment" : "Development environment"} — test data only. Payments, email and phone integrations are not live here.</div>`;
}

/**
 * M01 opening sequence (docs/frontend/MOTION.md). Shown on the first public page view of a browser session:
 * a GET for an indexable page, no flash message, and no `cm_intro` session cookie yet. The cookie is set with
 * that response, so internal navigation, form re-renders and error pages never replay it. The overlay is a pure
 * CSS timeline (no script needed to finish), never intercepts input, and is hidden for reduced motion and
 * without JavaScript.
 */
function wantsIntro(ctx: AppContext, meta: PageMeta): boolean {
  if (ctx.req.method !== "GET" || meta.noindex || ctx.flash) return false;
  if (/(?:^|;\s*)cm_intro=/.test(ctx.req.headers.get("cookie") ?? "")) return false;
  if ((ctx.req.headers.get("sec-purpose") ?? ctx.req.headers.get("purpose") ?? "").includes("prefetch")) return false;
  return true;
}

function introOverlay(): SafeHtml {
  // Seeded stagger (deterministic per tile, visually random) — tiles clear over ~230 ms after the mark.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const tiles = Array.from({ length: 12 * 7 }, () => html`<i style="--d:${Math.round(rnd() * 230)}ms"></i>`);
  return html`<div class="intro" data-intro aria-hidden="true"><div class="intro__tiles">${tiles}</div>
<div class="intro__mark"><img src="/assets/brand/crestmont-crest.png" width="42" height="41" alt=""><span>CRESTMONT</span></div></div>`;
}

const PUBLIC_NAV = [
  ["/services", "Services"], ["/pricing", "Pricing"], ["/portfolio", "Portfolio"], ["/process", "Process"], ["/about", "About"], ["/contact", "Contact"],
] as const;

const menuButton = (target: string, extraClass = "") =>
  html`<button class="nav-toggle${extraClass}" type="button" data-toggle="${target}" aria-controls="${target}" aria-expanded="false"><span class="nav-toggle__icon" aria-hidden="true"></span>Menu</button>`;

export function publicLayout(ctx: AppContext, meta: PageMeta, body: SafeHtml): SafeHtml {
  const here = ctx.url.pathname;
  // First-party campaign attribution (CRM-001): any public landing page records UTM parameters in cm_attr.
  // Skipped on noindex pages (proposal and share links carry secret tokens in their path).
  if (!ctx.user && !meta.noindex) requestAttribution(ctx);
  const account = ctx.user
    ? html`<a class="nav__account" href="${ctx.user.isStaff ? "/staff" : "/portal"}">${ctx.user.isStaff ? "Staff" : "My account"}</a>`
    : html`<a class="nav__account" href="/login">Sign in</a>`;
  const intro = wantsIntro(ctx, meta);
  if (intro) ctx.setCookies.push(`cm_intro=1; Path=/; SameSite=Lax${ctx.url.protocol === "https:" ? "; Secure" : ""}`);
  return html`<html lang="en"${intro ? html` class="has-intro"` : ""}>${head(ctx, meta)}<body>
${intro ? introOverlay() : ""}<a class="skip" href="#main">Skip to content</a>${envBanner(ctx)}
<header class="site-header" data-site-header><div class="container">${brandMark()}
${menuButton("site-nav")}
<nav class="nav" id="site-nav" aria-label="Primary">${PUBLIC_NAV.map(([h, l]) => html`<a href="${h}"${here === h || here.startsWith(h + "/") ? html` aria-current="page"` : ""}>${l}</a>`)}
${account}${ctaLink("Request a quote", "/quote", "primary", "sm", "nav__cta")}</nav></div></header>
<main id="main">${body}</main>
${siteFooter(ctx)}${flashToast(ctx)}${assistantWidget(ctx)}</body></html>`;
}

/** Crestmont website assistant (docs/frontend/CHATBOT.md): on every public page, bottom-right. Hidden until
 *  /assets/assistant.js starts (it needs JavaScript); it asks /api/assistant whether live AI answers are available and
 *  says so honestly when they are not. */
function assistantWidget(ctx: AppContext): SafeHtml {
  const email = ctx.settings["contact.email"] ?? "support@crestmontwebsitedevelopment.com";
  const ask = ["What's included in each package?", "How does the AI Receptionist work?", "How long does a website take?", "Do I need a custom quote?"];
  return html`<div class="cb" data-cb hidden>
<button type="button" class="cb__launch" data-cb-launch aria-expanded="false" aria-controls="cb-panel"><img src="/assets/brand/crestmont-crest.png" width="84" height="82" alt=""><span class="visually-hidden">Open the Crestmont assistant</span><span class="cb__dot" data-cb-dot hidden aria-hidden="true"></span></button>
<p class="cb__hello" data-cb-hello hidden><span>Questions? Ask the Crestmont assistant.</span><button type="button" class="cb__hello-x" data-cb-hello-x aria-label="Dismiss">×</button></p>
<section class="cb__panel" id="cb-panel" data-cb-panel role="dialog" aria-modal="false" aria-labelledby="cb-title" hidden>
<header class="cb__head"><span class="cb__crest" aria-hidden="true"><img src="/assets/brand/crestmont-crest.png" width="84" height="82" alt=""></span>
<span class="cb__titles"><span class="cb__title" id="cb-title">Crestmont assistant</span><span class="cb__status" data-cb-status>Checking…</span></span>
<button type="button" class="cb__icon" data-cb-restart title="Start a new conversation"><span class="visually-hidden">Start a new conversation</span><svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M4 10a6 6 0 1 0 1.8-4.3M4 3.5v3.5h3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
<button type="button" class="cb__icon" data-cb-close title="Close"><span class="visually-hidden">Close the assistant</span><svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></header>
<div class="cb__log" data-cb-log role="log" aria-live="polite" aria-relevant="additions" tabindex="0">
<div class="cb__msg cb__msg--welcome"><p>Hi — I'm Crestmont's AI assistant. I can explain our services and packages, the AI Receptionist and how a project works, and point you to the right page.</p><p class="cb__fine">I can make mistakes, so check important details on the linked pages. Please don't share passwords or payment details here.</p></div>
</div>
<div class="cb__suggest" data-cb-suggest role="group" aria-label="Suggested questions">${ask.map((q) => html`<button type="button" class="cb__chip" data-cb-ask>${q}</button>`)}</div>
<div class="cb__offline" data-cb-offline hidden><p><strong>Live AI answers aren't switched on right now.</strong> These pages answer most questions, and a person replies to every message:</p>
<ul class="cb__links">${([["/pricing", "Packages and prices"], ["/pricing/compare", "Compare packages"], ["/services", "All services"], ["/services/ai-receptionist", "AI Receptionist"], ["/process", "How a project works"], ["/quote", "Request a quote"]] as [string, string][]).map(([h, l]) => html`<li><a href="${h}">${l}</a></li>`)}</ul></div>
<form class="cb__form" data-cb-form><label class="visually-hidden" for="cb-input">Your question</label>
<textarea id="cb-input" class="cb__input" data-cb-input rows="1" maxlength="600" placeholder="Ask about services, pricing or the process…" autocomplete="off"></textarea>
<button type="submit" class="cb__send" data-cb-send><span class="visually-hidden">Send</span><svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M3.5 10h12M10.5 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button></form>
<p class="cb__foot"><a href="/contact?topic=assistant">Talk to a person</a><span aria-hidden="true">·</span><a href="mailto:${email}">Email us<span class="visually-hidden"> at ${email}</span></a></p>
</section></div><script src="/assets/assistant.js" defer></script>`;
}

function siteFooter(ctx: AppContext): SafeHtml {
  const email = ctx.settings["contact.email"] ?? "support@crestmontwebsitedevelopment.com";
  const hours = ctx.settings["support.staffed_hours"] ?? null;
  const links = (items: [string, string][]) => html`<ul class="footer-links">${items.map(([h, l]) => html`<li><a href="${h}">${l}</a></li>`)}</ul>`;
  // M10: columns enter in a short stagger (data-reveal-group); the oversized outline wordmark is decorative text.
  return html`<footer class="site-footer"><div class="container"><div class="footer-grid" data-reveal-group>
<div data-reveal>${brandMark()}<p class="faint" style="margin-top:1.25rem;max-width:26rem">Website design, development and digital systems for businesses across the United States.</p>
<p class="footer-cta">${ctaLink("Request a custom quote", "/quote", "primary", "sm")}</p>
<p><a href="mailto:${email}">${email}</a></p>${hours ? html`<p class="faint">Staffed support: ${hours}</p>` : ""}</div>
<div data-reveal><h4>Services</h4>${links([["/services", "All services"], ["/services/website-design-development", "Design & development"], ["/services/website-redesign", "Redesign"], ["/services/ai-receptionist", "AI Receptionist"], ["/services/custom-development", "Custom development"], ["/services/technical-seo", "Technical SEO"], ["/hosting-maintenance", "Hosting & maintenance"]])}</div>
<div data-reveal><h4>Company</h4>${links([["/about", "About"], ["/process", "Process"], ["/portfolio", "Portfolio"], ["/faq", "FAQs"], ["/contact", "Contact"], ["/pricing/compare", "Compare packages"]])}</div>
<div data-reveal><h4>Policies</h4>${links([["/legal/privacy", "Privacy"], ["/legal/terms", "Terms"], ["/legal/development-agreement", "Development agreement"], ["/legal/refunds", "Refunds"], ["/legal/cancellation", "Cancellation"], ["/legal/support", "Support policy"], ["/legal/accessibility", "Accessibility"], ["/legal/disclosures", "Business disclosures"]])}</div>
</div><div class="footer-base"><p class="faint">© ${new Date().getFullYear()} Crestmont Website Development.</p><p class="faint"><a href="/login">Customer portal</a></p></div></div>
<span class="footer-word" aria-hidden="true">CRESTMONT</span></footer>`;
}

export function authLayout(ctx: AppContext, meta: PageMeta, body: SafeHtml): SafeHtml {
  return html`<html lang="en">${head(ctx, { ...meta, noindex: true })}<body>${envBanner(ctx)}
<div class="auth-shell auth-shell--split"><main id="main" class="auth-main"><div class="auth-card card card--gold">${brandMark()}${body}</div></main>
<aside class="auth-aside" aria-label="Crestmont Website Development">
${brandMark()}
<div><div class="auth-aside__crest">${crestRing()}<img src="/assets/brand/crestmont-logo-original.png" width="232" height="213" alt=""></div>
<p class="auth-aside__line">Your project, its approvals and its history in one place.</p></div>
<div class="auth-aside__foot"><a href="/">Website</a><a href="/legal/privacy">Privacy</a><a href="/legal/support">Support policy</a></div></aside></div>${flashToast(ctx)}</body></html>`;
}

/** Pages whose server-side computation takes noticeable time; navigating to them shows a skeleton (BRAND-005). */
const SLOW_PATHS = ["/staff/readiness", "/staff/owner", "/staff/finance", "/staff/reports", "/staff/sales"];

export interface NavItem { href: string; label: string; perm?: Permission; count?: number }
export interface NavGroup { label: string; items: NavItem[] }

const initials = (name: string | undefined) => (name ?? "").replace(/\(.*?\)/g, " ").split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "·";

export function appLayout(ctx: AppContext, opts: { title: string; nav: NavGroup[]; home: string; area: string }, body: SafeHtml): SafeHtml {
  const here = ctx.url.pathname;
  const visible = (i: NavItem) => !i.perm || (ctx.actor && can(ctx.actor, i.perm));
  const current = (h: string) => here === h || (h !== opts.home && here.startsWith(h + "/"));
  return html`<html lang="en">${head(ctx, { title: opts.title, noindex: true })}<body>
<a class="skip" href="#main">Skip to content</a>${envBanner(ctx)}
<div class="app"><aside class="sidebar" id="app-nav">${brandMark(opts.home)}
<nav aria-label="${opts.area} navigation">${opts.nav.map((g) => {
  const items = g.items.filter(visible);
  if (!items.length) return html``;
  return html`<div class="side-group"><div class="side-group__label">${g.label}</div>${items.map((i) => html`<a class="side-link" href="${safeUrl(i.href)}"${current(i.href) ? html` aria-current="page"` : ""}${SLOW_PATHS.some((p) => i.href.startsWith(p)) ? html` data-slow` : ""}><span>${i.label}</span>${i.count ? html`<span class="badge badge--gold">${i.count}</span>` : ""}</a>`)}</div>`;
})}</nav>${ctx.user ? html`<div class="live-status" data-live-root role="status" aria-live="polite" hidden></div>` : ""}</aside>
<div class="app-scrim" data-close-nav="app-nav" aria-hidden="true"></div>
<div class="app-main"><div class="topbar">${menuButton("app-nav")}
<span class="topbar__area faint">${opts.area}</span>
<span class="who"><span class="avatar" aria-hidden="true">${initials(ctx.user?.displayName)}</span><span class="who__name">${ctx.user?.displayName ?? ""} · </span><a href="/account">Account</a></span>
<form method="post" action="/logout">${csrf(ctx)}<button class="btn btn--ghost btn--sm" type="submit">Sign out</button></form></div>
<main id="main" class="page" data-slow-target>${body}</main></div></div>${drawerShell()}
<template id="skeleton-tpl"><div class="loading-state" role="status"><span class="visually-hidden">Loading…</span>${skeleton({ kpis: 4, lines: 6 })}</div></template>${flashToast(ctx)}</body></html>`;
}

export function errorPage(ctx: AppContext, status: number, title: string, message: string): SafeHtml {
  return publicLayout(ctx, { title, noindex: true }, html`<section class="error-page container"><div class="error-page__mark" aria-hidden="true">${status}</div><div class="eyebrow">Error ${status}</div><h1>${title}</h1><p class="lede">${message}</p><div class="row" style="justify-content:center"><a class="btn btn--primary" href="/">Return home</a><a class="btn btn--ghost" href="/contact">Contact us</a></div></section>`);
}
