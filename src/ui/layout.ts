// Page shells. Every surface shares the design system in /assets/app.css (BRAND-006) — see docs/frontend/DESIGN.md.
import { html, safeUrl, type SafeHtml } from "../lib/html.ts";
import type { AppContext } from "../app/context.ts";
import { can, type Permission } from "../domain/authz.ts";
import { csrf, drawerShell, skeleton } from "./components.ts";
import { requestAttribution } from "../services/leads.ts";

// Type is self-hosted from /assets/fonts (SIL OFL): Gloock for display, Instrument Sans for text and UI.
// The two faces used above the fold are preloaded; no third-party font requests.
const PRELOAD_FONTS = ["/assets/fonts/Gloock-Regular.woff", "/assets/fonts/InstrumentSans-Regular.woff"];

export interface PageMeta { title: string; description?: string; path?: string; noindex?: boolean; canonical?: string }

function head(ctx: AppContext, m: PageMeta): SafeHtml {
  const title = m.title.includes("Crestmont") ? m.title : `${m.title} · Crestmont Website Development`;
  const canonical = m.canonical ?? (ctx.baseUrl + (m.path ?? ctx.url.pathname));
  return html`<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${m.description ? html`<meta name="description" content="${m.description}">` : ""}
${m.noindex || ctx.env.ENVIRONMENT !== "production" ? html`<meta name="robots" content="noindex, nofollow">` : html`<link rel="canonical" href="${canonical}">`}
<meta property="og:title" content="${title}"><meta property="og:type" content="website">${m.description ? html`<meta property="og:description" content="${m.description}">` : ""}
<meta name="theme-color" content="#0d0d0d"><meta name="color-scheme" content="dark">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/brand/favicon-32.png"><link rel="icon" type="image/png" sizes="16x16" href="/assets/brand/favicon-16.png">
${PRELOAD_FONTS.map((f) => html`<link rel="preload" href="${f}" as="font" type="font/woff" crossorigin>`)}<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/boot.js"></script><script src="/assets/app.js" defer></script></head>`;
}

/** Header mark: the original crest artwork at exactly 2× pixel density, plus the company name as text. */
export function brandMark(href = "/"): SafeHtml {
  return html`<a class="brand" href="${href}" aria-label="Crestmont Website Development — home">
<img class="brand__mark" src="/assets/brand/crestmont-crest.png" width="42" height="41" alt="" decoding="async">
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
  return html`<html lang="en">${head(ctx, meta)}<body>
<a class="skip" href="#main">Skip to content</a>${envBanner(ctx)}
<header class="site-header" data-site-header><div class="container">${brandMark()}
${menuButton("site-nav")}
<nav class="nav" id="site-nav" aria-label="Primary">${PUBLIC_NAV.map(([h, l]) => html`<a href="${h}"${here === h || here.startsWith(h + "/") ? html` aria-current="page"` : ""}>${l}</a>`)}
${account}<a class="btn btn--primary btn--sm" href="/quote">Request a quote</a></nav></div></header>
<main id="main">${body}</main>
${siteFooter(ctx)}${flashToast(ctx)}</body></html>`;
}

function siteFooter(ctx: AppContext): SafeHtml {
  const email = ctx.settings["contact.email"] ?? "support@crestmontwebsitedevelopment.com";
  const hours = ctx.settings["support.staffed_hours"] ?? null;
  const links = (items: [string, string][]) => html`<ul class="footer-links">${items.map(([h, l]) => html`<li><a href="${h}">${l}</a></li>`)}</ul>`;
  return html`<footer class="site-footer"><div class="container"><div class="footer-grid">
<div>${brandMark()}<p class="faint" style="margin-top:1.25rem;max-width:26rem">Website design, development and digital systems for businesses across the United States.</p>
<p class="footer-cta"><a class="btn btn--secondary btn--sm" href="/quote">Request a custom quote</a></p>
<p><a href="mailto:${email}">${email}</a></p>${hours ? html`<p class="faint">Staffed support: ${hours}</p>` : ""}</div>
<div><h4>Services</h4>${links([["/services", "All services"], ["/services/website-design-development", "Design & development"], ["/services/website-redesign", "Redesign"], ["/services/custom-development", "Custom development"], ["/services/technical-seo", "Technical SEO"], ["/hosting-maintenance", "Hosting & maintenance"]])}</div>
<div><h4>Company</h4>${links([["/about", "About"], ["/process", "Process"], ["/portfolio", "Portfolio"], ["/faq", "FAQs"], ["/contact", "Contact"], ["/pricing/compare", "Compare packages"]])}</div>
<div><h4>Policies</h4>${links([["/legal/privacy", "Privacy"], ["/legal/terms", "Terms"], ["/legal/development-agreement", "Development agreement"], ["/legal/refunds", "Refunds"], ["/legal/cancellation", "Cancellation"], ["/legal/support", "Support policy"], ["/legal/accessibility", "Accessibility"], ["/legal/disclosures", "Business disclosures"]])}</div>
</div><div class="footer-base"><p class="faint">© ${new Date().getFullYear()} Crestmont Website Development.</p><p class="faint"><a href="/login">Customer portal</a></p></div></div></footer>`;
}

export function authLayout(ctx: AppContext, meta: PageMeta, body: SafeHtml): SafeHtml {
  return html`<html lang="en">${head(ctx, { ...meta, noindex: true })}<body>${envBanner(ctx)}
<div class="auth-shell auth-shell--split"><aside class="auth-aside" aria-label="Crestmont Website Development">
${brandMark()}
<div><div class="auth-aside__crest">${crestRing()}<img src="/assets/brand/crestmont-logo-original.png" width="232" height="213" alt=""></div>
<p class="auth-aside__line">Your project, its approvals and its history in one place.</p></div>
<div class="auth-aside__foot"><a href="/">Website</a><a href="/legal/privacy">Privacy</a><a href="/legal/support">Support policy</a></div></aside>
<main id="main" class="auth-main"><div class="auth-card card card--gold">${brandMark()}${body}</div></main></div>${flashToast(ctx)}</body></html>`;
}

/** Pages whose server-side computation takes noticeable time; navigating to them shows a skeleton (BRAND-005). */
const SLOW_PATHS = ["/staff/readiness", "/staff/owner", "/staff/finance", "/staff/reports", "/staff/sales"];

export interface NavItem { href: string; label: string; perm?: Permission; count?: number }
export interface NavGroup { label: string; items: NavItem[] }

const initials = (name: string | undefined) => (name ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "·";

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
<span class="who"><span class="avatar" aria-hidden="true">${initials(ctx.user?.displayName)}</span>${ctx.user?.displayName ?? ""} · <a href="/account">Account</a></span>
<form method="post" action="/logout">${csrf(ctx)}<button class="btn btn--ghost btn--sm" type="submit">Sign out</button></form></div>
<main id="main" class="page" data-slow-target>${body}</main></div></div>${drawerShell()}
<template id="skeleton-tpl"><div class="loading-state" role="status"><span class="visually-hidden">Loading…</span>${skeleton({ kpis: 4, lines: 6 })}</div></template>${flashToast(ctx)}</body></html>`;
}

export function errorPage(ctx: AppContext, status: number, title: string, message: string): SafeHtml {
  return publicLayout(ctx, { title, noindex: true }, html`<section class="error-page container"><div class="error-page__mark" aria-hidden="true">${status}</div><div class="eyebrow">Error ${status}</div><h1>${title}</h1><p class="lede">${message}</p><div class="row" style="justify-content:center"><a class="btn btn--secondary" href="/">Return home</a><a class="btn btn--ghost" href="/contact">Contact us</a></div></section>`);
}
