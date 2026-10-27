// Page shells. Every surface shares the design system in /assets/app.css (BRAND-006).
import { html, safeUrl, type SafeHtml } from "../lib/html.ts";
import type { AppContext } from "../app/context.ts";
import { can, type Permission } from "../domain/authz.ts";
import { csrf, drawerShell, skeleton } from "./components.ts";
import { requestAttribution } from "../services/leads.ts";

const FONTS = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Inter:wght@400;600&display=swap";

export interface PageMeta { title: string; description?: string; path?: string; noindex?: boolean; canonical?: string }

function head(ctx: AppContext, m: PageMeta): SafeHtml {
  const title = m.title.includes("Crestmont") ? m.title : `${m.title} · Crestmont Website Development`;
  const canonical = m.canonical ?? (ctx.baseUrl + (m.path ?? ctx.url.pathname));
  return html`<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${m.description ? html`<meta name="description" content="${m.description}">` : ""}
${m.noindex || ctx.env.ENVIRONMENT !== "production" ? html`<meta name="robots" content="noindex, nofollow">` : html`<link rel="canonical" href="${canonical}">`}
<meta property="og:title" content="${title}"><meta property="og:type" content="website">${m.description ? html`<meta property="og:description" content="${m.description}">` : ""}
<meta name="theme-color" content="#0d0d0d">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/brand/favicon-32.png"><link rel="icon" type="image/png" sizes="16x16" href="/assets/brand/favicon-16.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}"><link rel="stylesheet" href="/assets/app.css">
<script src="/assets/app.js" defer></script></head>`;
}

/** Header mark: the original crest artwork at exactly 2× pixel density, plus the company name as text. */
export function brandMark(href = "/"): SafeHtml {
  return html`<a class="brand" href="${href}" aria-label="Crestmont Website Development — home">
<img class="brand__mark" src="/assets/brand/crestmont-crest.png" width="42" height="41" alt="" decoding="async">
<span><span class="brand__word">CRESTMONT</span><span class="brand__sub">WEBSITE DEVELOPMENT</span></span></a>`;
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

export function publicLayout(ctx: AppContext, meta: PageMeta, body: SafeHtml): SafeHtml {
  const here = ctx.url.pathname;
  // First-party campaign attribution (CRM-001): any public landing page records UTM parameters in cm_attr.
  // Skipped on noindex pages (proposal and share links carry secret tokens in their path).
  if (!ctx.user && !meta.noindex) requestAttribution(ctx);
  const account = ctx.user
    ? html`<a href="${ctx.user.isStaff ? "/staff" : "/portal"}">${ctx.user.isStaff ? "Staff" : "My account"}</a>`
    : html`<a href="/login">Sign in</a>`;
  return html`<html lang="en">${head(ctx, meta)}<body>
<a class="skip" href="#main">Skip to content</a>${envBanner(ctx)}
<header class="site-header"><div class="container">${brandMark()}
<button class="nav-toggle" type="button" data-toggle="site-nav" aria-controls="site-nav" aria-expanded="false">Menu</button>
<nav class="nav" id="site-nav" aria-label="Primary">${PUBLIC_NAV.map(([h, l]) => html`<a href="${h}"${here === h || here.startsWith(h + "/") ? html` aria-current="page"` : ""}>${l}</a>`)}
${account}<a class="btn btn--primary btn--sm" href="/quote">Request a quote</a></nav></div></header>
<main id="main">${body}</main>
${siteFooter(ctx)}${flashToast(ctx)}</body></html>`;
}

function siteFooter(ctx: AppContext): SafeHtml {
  const email = ctx.settings["contact.email"] ?? "support@crestmontwebsitedevelopment.com";
  const hours = ctx.settings["support.staffed_hours"] ?? null;
  return html`<footer class="site-footer"><div class="container"><div class="footer-grid">
<div>${brandMark()}<p class="faint" style="margin-top:1rem;max-width:28rem">Website design, development and digital systems for businesses across the United States.</p>
<p><a href="mailto:${email}">${email}</a></p>${hours ? html`<p class="faint">Staffed support: ${hours}</p>` : ""}</div>
<div><h4 style="font-size:1rem">Services</h4><p><a href="/services">All services</a><br><a href="/services/website-design-development">Design &amp; development</a><br><a href="/services/website-redesign">Redesign</a><br><a href="/services/custom-development">Custom development</a><br><a href="/services/technical-seo">Technical SEO</a><br><a href="/hosting-maintenance">Hosting &amp; maintenance</a></p></div>
<div><h4 style="font-size:1rem">Company</h4><p><a href="/about">About</a><br><a href="/process">Process</a><br><a href="/portfolio">Portfolio</a><br><a href="/faq">FAQs</a><br><a href="/contact">Contact</a><br><a href="/pricing/compare">Compare packages</a></p></div>
<div><h4 style="font-size:1rem">Policies</h4><p><a href="/legal/privacy">Privacy</a><br><a href="/legal/terms">Terms</a><br><a href="/legal/development-agreement">Development agreement</a><br><a href="/legal/refunds">Refunds</a><br><a href="/legal/cancellation">Cancellation</a><br><a href="/legal/support">Support policy</a><br><a href="/legal/accessibility">Accessibility</a><br><a href="/legal/disclosures">Business disclosures</a></p></div>
</div><hr><p class="faint">© ${new Date().getFullYear()} Crestmont Website Development.</p></div></footer>`;
}

export function authLayout(ctx: AppContext, meta: PageMeta, body: SafeHtml): SafeHtml {
  return html`<html lang="en">${head(ctx, { ...meta, noindex: true })}<body>${envBanner(ctx)}
<main id="main" class="auth-shell"><div class="auth-card card card--gold">${brandMark()}${body}</div></main>${flashToast(ctx)}</body></html>`;
}

/** Pages whose server-side computation takes noticeable time; navigating to them shows a skeleton (BRAND-005). */
const SLOW_PATHS = ["/staff/readiness", "/staff/owner", "/staff/finance", "/staff/reports", "/staff/sales"];

export interface NavItem { href: string; label: string; perm?: Permission; count?: number }
export interface NavGroup { label: string; items: NavItem[] }

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
<div class="app-main"><div class="topbar"><button class="nav-toggle" style="display:inline-flex" type="button" data-toggle="app-nav" aria-controls="app-nav" aria-expanded="false">Menu</button>
<span class="faint">${opts.area}</span>
<span class="who">${ctx.user?.displayName ?? ""} · <a href="/account">Account</a></span>
<form method="post" action="/logout">${csrf(ctx)}<button class="btn btn--ghost btn--sm" type="submit">Sign out</button></form></div>
<main id="main" class="page" data-slow-target>${body}</main></div></div>${drawerShell()}
<template id="skeleton-tpl"><div class="loading-state" role="status"><span class="visually-hidden">Loading…</span>${skeleton({ kpis: 4, lines: 6 })}</div></template>${flashToast(ctx)}</body></html>`;
}

export function errorPage(ctx: AppContext, status: number, title: string, message: string): SafeHtml {
  return publicLayout(ctx, { title, noindex: true }, html`<section class="error-page container"><div class="eyebrow">Error ${status}</div><h1>${title}</h1><p class="lede" style="margin:0 auto 2rem">${message}</p><a class="btn btn--secondary" href="/">Return home</a></section>`);
}
