// Public website (WEB-001..010, CAT-001, PORT-004/006, LEGAL-001/002), Website CMS admin
// (CMS-001..003) and Portfolio admin (PORT-007). Content: CMS-published revisions over the
// repository defaults in src/content. Prices: only src/domain/catalog.ts.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, raw, safeUrl, formatCents, formatDate, formatDateTime, type SafeHtml } from "../lib/html.ts";
import { HttpError, htmlResponse, redirect, str, securityHeaders } from "../app/http.ts";
import { publicLayout, appLayout, crestRing } from "../ui/layout.ts";
import { csrf, input, textarea, select, button, linkButton, actionForm, formErrors, alert, table, badge, emptyState, pageHead, dl, fileInput, attributionFields, richText } from "../ui/components.ts";
import { requireStaff } from "../app/app.ts";
import { staffNav } from "./nav.ts";
import { verifyTurnstile } from "./api.ts";
import { PACKAGES, MAINTENANCE_PLANS, type PackageId } from "../domain/catalog.ts";
import { effectivePrices } from "../services/pricing-approvals.ts";
import { can } from "../domain/authz.ts";
import { captureLead, requestAttribution, submittedAttribution } from "../services/leads.ts";
import { rateLimit, securityEvent } from "../services/security.ts";
import { sendMail } from "../services/mailer.ts";
import { ValidationError } from "../lib/validate.ts";
import { newId, nowIso } from "../lib/db.ts";
import * as cms from "../services/cms.ts";
import { lineDiff } from "../services/voice.ts";
import * as pf from "../services/portfolio.ts";
import { SERVICES, SERVICE_GROUPS, serviceBySlug, servicePath, PRICING_NOTE, type ServiceDef } from "../content/services.ts";
import { CMS_KEYS, cmsKeyDef, parseItems, paragraphs, type CmsKeyDef } from "../content/registry.ts";
import { renderMarkdown, markdownIssues } from "../ui/markdown.ts";
import { legalDocs, LEGAL_SLUGS, DRAFT_BANNER, type LegalSlug, type LegalFacts } from "../content/legal.ts";

const SUPPORT_EMAIL = "support@crestmontwebsitedevelopment.com";
const SALES_EMAIL = "sales@crestmontwebsitedevelopment.com";
const BILLING_EMAIL = "billing@crestmontwebsitedevelopment.com";
const LEGAL_EMAIL = "legal@crestmontwebsitedevelopment.com";

const PKG_ORDER: PackageId[] = ["starter", "business", "premium"];
// CAT-007: prices shown are the Founder-approved effective prices (same lookup checkout uses), refreshed by page().
let effective: Record<string, number> = {};
const pkgPrice = (id: PackageId) => formatCents(effective[`package:${id}`] ?? PACKAGES[id].basePriceCents) + (PACKAGES[id].priceIsFloor ? "+" : "");
const plans = () => Object.values(MAINTENANCE_PLANS);

/** Static public paths, used by the sitemap and checked by the dead-link test. */
export const PUBLIC_PATHS = [
  "/", "/services", ...SERVICES.map(servicePath), "/pricing", "/pricing/compare", "/portfolio", "/about", "/process", "/quote", "/contact", "/faq",
  "/legal", ...LEGAL_SLUGS.map((s) => `/legal/${s}`),
];

// ───────────────────────── shared view helpers ─────────────────────────

type Content = Awaited<ReturnType<typeof cms.loadContent>>;

async function page(ctx: AppContext, seoKey: string, keys: string[], render: (c: Content) => SafeHtml | Promise<SafeHtml>, status = 200): Promise<Response> {
  const c = await cms.loadContent(ctx, [`seo.${seoKey}`, ...keys]);
  effective = await effectivePrices(ctx.db, ctx.now());
  const seo = c.get(`seo.${seoKey}`);
  const body = await render(c);
  const banner = c.previewing
    ? html`<div class="preview-banner" role="status">Preview of an unpublished revision (${c.previewing}). Visitors still see the published version. <a href="/staff/cms/${c.previewing}">Back to the editor</a></div>`
    : html``;
  return htmlResponse(ctx, publicLayout(ctx, { title: seo.title, description: seo.description }, html`${banner}${body}`), status);
}

// Margin-label composition (docs/frontend/DESIGN.md §8): the section name sits in a narrow left column on wide
// screens; when the label would only repeat the heading it is left empty so columns still align.
const section = (eyebrow: string, title: string, body: SafeHtml, opts: { id?: string; lede?: string } = {}) => html`<section class="section"${opts.id ? html` id="${opts.id}"` : ""}><div class="container section__inner">
<p class="section__label"${eyebrow === title ? html` aria-hidden="true" style="visibility:hidden"` : ""}>${eyebrow}</p><div><div class="section__head"><h2>${title}</h2>${opts.lede ? html`<p class="lede">${opts.lede}</p>` : ""}</div>${body}</div></div></section>`;

const pageHero = (eyebrow: string, title: string, lede?: string, actions?: SafeHtml) => html`<section class="hero hero--page"><div class="container">
<div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${lede ? html`<p class="lede">${lede}</p>` : ""}${actions ? html`<div class="row">${actions}</div>` : ""}</div></section>`;

const itemCards = (text: string) => html`<div class="grid grid-2">${parseItems(text).map((i) => html`<div class="card card--feature"><h3 class="card__title">${i.title}</h3><p class="muted">${i.body}</p></div>`)}</div>`;
/** Two-column hairline ledger for principles and capabilities (no card chrome). */
const ledger = (text: string) => html`<ul class="ledger">${parseItems(text).map((i) => html`<li><h3>${i.title}</h3><p>${i.body}</p></li>`)}</ul>`;

function packageCards(c: Content, opts: { compact?: boolean } = {}): SafeHtml {
  const pr = c.get("pricing.presentation");
  return html`<div class="grid grid-3 pricing-grid">${PKG_ORDER.map((id) => {
    const p = PACKAGES[id];
    return html`<article class="card${id === "business" ? " card--gold" : ""} package" aria-labelledby="pkg-${id}">
<h3 class="card__title" id="pkg-${id}">${p.name}</h3><p class="muted">${pr[`${id}_tagline`] ?? ""}</p>
<div class="price" data-testid="price-${id}">${pkgPrice(id)}</div><p class="faint package__terms">${p.priceIsFloor ? "Starting price · final price in your written scope · " : "Fixed price · "}paid 100% upfront</p>
${opts.compact ? html`<ul class="checklist">${p.includes.slice(0, 5).map((i) => html`<li>${i}</li>`)}</ul>` : html`<ul class="checklist">${p.includes.map((i) => html`<li>${i}</li>`)}</ul>`}
<div class="package__actions">${linkButton(`Choose ${p.name}`, `/checkout/${id}`, id === "business" ? "primary" : "secondary")}${id === "premium" ? html` <a class="btn btn--ghost" href="/quote?package=premium">Discuss a larger scope</a>` : ""}</div>
</article>`;
  })}</div>`;
}

function maintenanceCards(): SafeHtml {
  const approved = plans().every((m) => m.entitlementsStatus === "approved");
  return html`<div class="grid grid-3">${plans().map((m) => html`<div class="card"><h3 class="card__title">${m.name}</h3><div class="price" data-testid="price-${m.id}">${formatCents(effective[`maintenance:${m.id}`] ?? m.monthlyCents)}<small> / month</small></div>
${approved ? html`<ul class="checklist">${Object.values(m.proposedEntitlements).map((e) => html`<li>${e}</li>`)}</ul>` : html`<p class="muted">Full plan details will be published here once finalised.</p>`}</div>`)}</div>
${approved ? "" : html`<p class="muted">Each plan will have explicit, published limits for hosting, maintenance time, content updates, security updates, monitoring, backups and support response targets — with no unlimited development or unlimited support. Have a question in the meantime? <a href="/contact?topic=maintenance">Ask us about maintenance</a>.</p>`}`;
}

function portfolioCard(p: pf.PortfolioProject): SafeHtml {
  return html`<article class="card portfolio-card"><a class="portfolio-card__shot" href="/portfolio/${p.slug}">${shot(p, "desktop")}</a>
<div class="eyebrow">${p.industry}</div><h3 class="card__title"><a href="/portfolio/${p.slug}">${p.name}</a></h3><p class="muted">${p.description.length > 180 ? p.description.slice(0, 177) + "…" : p.description}</p>
<div class="row"><a class="btn btn--secondary btn--sm" href="/portfolio/${p.slug}">Case study</a><a class="btn btn--ghost btn--sm" href="${safeUrl(p.live_url)}" rel="noopener" target="_blank">Visit live website</a></div></article>`;
}

function shot(p: pf.PortfolioProject, kind: "desktop" | "mobile", viewer = false): SafeHtml {
  const id = kind === "desktop" ? p.desktop_screenshot_file_id : p.mobile_screenshot_file_id;
  const alt = `${kind === "desktop" ? "Desktop" : "Mobile"} screenshot of ${p.name} (${p.live_url})`;
  if (!id) return html`<div class="shot shot--pending${kind === "mobile" ? " shot--mobile" : ""}" role="img" aria-label="${alt} — capture pending"><span>Verified screenshot capture pending</span></div>`;
  const src = `/portfolio-media/${id}`;
  const img = html`<img src="${src}" alt="${alt}" loading="lazy" decoding="async">`;
  return viewer ? html`<a class="shot${kind === "mobile" ? " shot--mobile" : ""}" href="${src}" data-viewer data-alt="${alt}">${img}<span class="visually-hidden">Open full-screen</span></a>` : html`<div class="shot">${img}</div>`;
}

/** Editorial index of services: name, summary and an arrow per row; the whole row is the link. */
function serviceList(list: ServiceDef[], c?: Content): SafeHtml {
  return html`<ul class="index-list">${list.map((s) => {
    const summary = c?.get(`service.${s.slug}`).summary ?? s.summary;
    return html`<li><a href="${servicePath(s)}"><span class="index-list__name">${s.name}</span><span class="index-list__summary">${summary}</span><span class="index-list__arrow" aria-hidden="true">→</span></a></li>`;
  })}</ul>`;
}

/**
 * "Anatomy of a build" (DESIGN.md §10): an illustrative miniature website assembled in six layers, each tied to a
 * real stage of the Crestmont process. Labelled as a concept; the business in the miniature is fictional.
 */
const ANATOMY: { title: string; stage: string; body: string }[] = [
  { title: "Structure", stage: "Scope review", body: "Pages, content order and the main calls to action are agreed against your package or quote before any visual design starts." },
  { title: "Design system", stage: "Design", body: "Type, colour, spacing and components are defined once and applied everywhere, so every page belongs to the same site." },
  { title: "Real content", stage: "Design and development", body: "Your words and images replace placeholders, and layouts are checked against real lengths rather than filler text." },
  { title: "Interaction", stage: "Development", body: "Menus, buttons and forms respond to touch, mouse and keyboard, and every action confirms what happened." },
  { title: "Accessibility", stage: "Internal quality assurance", body: "Focus order, contrast, labels and page landmarks are checked toward WCAG 2.1 AA before you see a review build." },
  { title: "Performance", stage: "Internal quality assurance", body: "Images are sized and compressed, scripts are kept minimal and pages are served from modern edge hosting." },
];

function anatomy(): SafeHtml {
  const last = ANATOMY.length;
  return html`<div class="anatomy" data-anatomy>
<div><p class="anatomy__note">Illustrative concept — not a client project</p>
<ol class="anatomy__layers" role="tablist" aria-label="Layers of a website build" aria-orientation="vertical">${ANATOMY.map((l, i) => html`<li class="anatomy__layer">
<button class="anatomy__tab" type="button" role="tab" id="anatomy-tab-${i + 1}" aria-controls="anatomy-stage" aria-selected="${i === last - 1 ? "true" : "false"}"><span class="anatomy__tab-title">${l.title}</span><span class="anatomy__tab-stage">Process stage: ${l.stage}</span></button>
<p class="anatomy__detail">${l.body}</p></li>`)}</ol></div>
<div class="anatomy__stage" id="anatomy-stage" role="tabpanel" aria-label="Miniature website preview">
<div class="mini" data-layer="${last}" aria-hidden="true"><div class="mini__chrome"><i></i><i></i><i></i><span class="mini__url">your-business.example</span><span class="mini__score">✓ Checks complete</span></div>
<div class="mini__viewport"><div class="mini__page">
<div class="mini__nav mini__region"><span class="mini__tag">header</span><span class="mini__logo"></span><span class="mini__links"><i></i><i></i><i></i></span><span class="mini__btn"><span class="mini__btn-label">Visit</span></span></div>
<div class="mini__hero mini__region"><span class="mini__tag">main</span><div><span class="mini__h" style="display:block"></span><span class="mini__h mini__h--2" style="display:block"></span>
<p class="mini__text mini__text--h">Fresh bread, baked before sunrise.</p><span class="mini__p" style="display:block"></span><span class="mini__p mini__p--2" style="display:block"></span>
<p class="mini__text mini__text--p">Order ahead online and collect a warm loaf on your way to work.</p><span class="mini__cta"><span class="mini__cta-label">Order ahead</span></span></div><span class="mini__img"></span></div>
<div class="mini__cards"><span class="mini__card"></span><span class="mini__card"></span><span class="mini__card"></span></div>
</div></div>
<div class="mini__caption"><span>Layer: <strong data-anatomy-caption>${ANATOMY[last - 1]!.title}</strong></span><span>Fictional business, for illustration</span></div></div></div></div>`;
}

/** The development process as a selectable stepper; without JavaScript it is a complete ordered list. */
function processStepper(steps: { title: string; body: string }[]): SafeHtml {
  return html`<div class="stepper" data-stepper>
<ol class="stepper__track" role="tablist" aria-label="Project stages" aria-orientation="vertical">${steps.map((s, i) => html`<li class="stepper__item">
<button class="stepper__btn" type="button" role="tab" id="step-tab-${i + 1}" aria-controls="step-panel" aria-selected="${i === 0 ? "true" : "false"}" data-title="${s.title}" data-body="${s.body}">${s.title}</button>
<p class="stepper__text">${s.body}</p></li>`)}</ol>
<div class="stepper__panel" id="step-panel" role="tabpanel" aria-live="polite" data-stepper-panel hidden><div data-panel-body>
<span class="stepper__count" data-panel-count>Step 1 of ${steps.length}</span><h3 data-panel-title>${steps[0]?.title ?? ""}</h3><p data-panel-text>${steps[0]?.body ?? ""}</p></div>
<div class="stepper__nav"><button class="btn btn--ghost btn--sm" type="button" data-step-prev>Previous stage</button><button class="btn btn--secondary btn--sm" type="button" data-step-next>Next stage</button></div>
<p class="faint" style="margin:1.5rem 0 0;font-size:.8rem">Your customer portal shows which stage your project is in and what is waiting on you.</p></div></div>`;
}

const serviceKeys = () => SERVICES.filter((s) => s.pricing !== "maintenance").map((s) => `service.${s.slug}`);

function legalFacts(ctx: AppContext): LegalFacts {
  return {
    legalName: ctx.settings["business.legal_name"]?.trim() || null,
    address: ctx.settings["business.address"]?.trim() || null,
    staffedHours: ctx.settings["support.staffed_hours"]?.trim() || null,
    supportEmail: ctx.settings["contact.email"]?.trim() || SUPPORT_EMAIL,
    legalEmail: LEGAL_EMAIL, billingEmail: BILLING_EMAIL,
  };
}

// ───────────────────────── lead forms ─────────────────────────

const INTERESTS = [
  { value: "starter", label: `Starter package (${pkgPrice("starter")})` }, { value: "business", label: `Business package (${pkgPrice("business")})` },
  { value: "premium", label: `Premium package (${pkgPrice("premium")})` }, { value: "custom", label: "Custom development" },
  { value: "maintenance", label: "Hosting & maintenance" }, { value: "other", label: "Something else" },
];
const BUDGETS = ["Under $1,000", "$1,000 – $2,500", "$2,500 – $5,000", "$5,000 – $10,000", "$10,000 – $25,000", "$25,000 or more", "Not sure yet"];
const TIMELINES = ["As soon as practical", "Within 1 month", "1 – 3 months", "3 – 6 months", "Flexible"];
const HONEYPOT = "fax_number";

type FormVals = Record<string, string>;
type FieldErrors = Record<string, string>;

function turnstileWidget(ctx: AppContext): SafeHtml {
  if (!ctx.env.TURNSTILE_SITE_KEY) return html``;
  return html`<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><div class="cf-turnstile field" data-sitekey="${ctx.env.TURNSTILE_SITE_KEY}"></div>`;
}

const honeypot = () => html`<div class="hp" aria-hidden="true"><label for="f-${HONEYPOT}">Leave this field empty</label><input id="f-${HONEYPOT}" name="${HONEYPOT}" type="text" tabindex="-1" autocomplete="off"></div>`;

function contactFields(v: FormVals, e: FieldErrors): SafeHtml {
  return html`<div class="grid grid-2 form-grid">
${input({ name: "name", label: "Your name", value: v.name, autocomplete: "name", required: true, error: e.name, maxlength: 120 })}
${input({ name: "email", label: "Email", type: "email", value: v.email, autocomplete: "email", required: true, error: e.email, maxlength: 254 })}
${input({ name: "phone", label: "Phone (optional)", type: "tel", value: v.phone, autocomplete: "tel", error: e.phone, maxlength: 40 })}
${input({ name: "company", label: "Business name (optional)", value: v.company, autocomplete: "organization", error: e.company, maxlength: 160 })}</div>`;
}

function validateLeadForm(v: FormVals, kind: "quote" | "contact"): { errors: FieldErrors; list: string[] } {
  const e: FieldErrors = {};
  if (v.name.length < 2 || v.name.length > 120) e.name = "Enter your name (2–120 characters)";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email) || v.email.length > 254) e.email = "Enter a valid email address";
  if (v.phone && !/^[+0-9 ().-]{7,40}$/.test(v.phone)) e.phone = "Enter a valid phone number, or leave it blank";
  if (v.company.length > 160) e.company = "Business name must be at most 160 characters";
  if (v.website && (!/^https?:\/\/[^\s]+$/.test(v.website) || v.website.length > 300)) e.website = "Enter a full web address starting with https://, or leave it blank";
  if (!INTERESTS.some((i) => i.value === v.interest)) e.interest = "Choose what you are interested in";
  if (kind === "quote") {
    if (v.service && !SERVICES.some((s) => s.slug === v.service)) e.service = "Choose a service from the list";
    if (!BUDGETS.includes(v.budget)) e.budget = "Choose a budget range";
    if (!TIMELINES.includes(v.timeline)) e.timeline = "Choose a timeline";
    if (v.message.length < 20 || v.message.length > 4000) e.message = "Describe your project in 20–4000 characters";
  } else if (v.message.length < 10 || v.message.length > 4000) e.message = "Enter a message of 10–4000 characters";
  return { errors: e, list: Object.values(e) };
}

function quoteForm(ctx: AppContext, v: FormVals, e: FieldErrors): SafeHtml {
  return html`${formErrors(Object.values(e))}<form method="post" action="/quote" class="lead-form" novalidate>${csrf(ctx)}${honeypot()}${attributionFields(requestAttribution(ctx))}
${contactFields(v, e)}
${input({ name: "website", label: "Current website (optional)", type: "url", value: v.website, placeholder: "https://", error: e.website, maxlength: 300 })}
<div class="grid grid-2 form-grid">
${select({ name: "interest", label: "What are you interested in?", options: INTERESTS, value: v.interest || "custom", required: true, error: e.interest })}
${select({ name: "service", label: "Main service (optional)", options: SERVICES.map((s) => ({ value: s.slug, label: s.name })), value: v.service, includeBlank: "Not sure yet", error: e.service })}
${select({ name: "budget", label: "Budget range", options: BUDGETS.map((b) => ({ value: b, label: b })), value: v.budget, includeBlank: "Choose…", required: true, error: e.budget })}
${select({ name: "timeline", label: "Timeline", options: TIMELINES.map((t) => ({ value: t, label: t })), value: v.timeline, includeBlank: "Choose…", required: true, error: e.timeline })}</div>
${textarea({ name: "message", label: "Describe your project", value: v.message, rows: 7, required: true, maxlength: 4000, error: e.message, hint: "What should the website or system do, who uses it, and anything it must connect to." })}
${turnstileWidget(ctx)}
<p class="faint form-note">We use these details only to respond to your request. See our <a href="/legal/privacy">privacy policy</a>.</p>
<div class="form-actions">${button("Request my quote")}</div></form>`;
}

function contactForm(ctx: AppContext, v: FormVals, e: FieldErrors, opts: { compact?: boolean } = {}): SafeHtml {
  return html`${formErrors(Object.values(e))}<form method="post" action="/contact" class="lead-form" novalidate>${csrf(ctx)}${honeypot()}${attributionFields(requestAttribution(ctx))}
${contactFields(v, e)}
${opts.compact ? html`<input type="hidden" name="interest" value="${v.interest || "other"}">` : select({ name: "interest", label: "Topic", options: INTERESTS, value: v.interest || "other", required: true, error: e.interest })}
${textarea({ name: "message", label: "Message", value: v.message, rows: opts.compact ? 4 : 6, required: true, maxlength: 4000, error: e.message })}
${turnstileWidget(ctx)}
<p class="faint form-note">We reply by email. See our <a href="/legal/privacy">privacy policy</a>.</p>
<div class="form-actions">${button("Send message")}</div></form>`;
}

const formValues = (f: FormData, names: string[]): FormVals => Object.fromEntries(names.map((n) => [n, str(f, n)]));
const LEAD_FIELDS = ["name", "email", "phone", "company", "website", "interest", "service", "budget", "timeline", "message"];

/** Shared POST handling: honeypot, rate limit, bot verification, validation, CRM lead, acknowledgement email, PRG. */
async function handleLead(ctx: AppContext, kind: "quote" | "contact", rerender: (v: FormVals, e: FieldErrors, status: number) => Promise<Response>): Promise<Response> {
  const f = await ctx.form();
  const v = formValues(f, LEAD_FIELDS);
  const thanks = kind === "quote" ? "/quote/thanks" : "/contact/thanks";
  if (str(f, HONEYPOT)) {
    await securityEvent(ctx.db, "lead_form_honeypot", { ip: ctx.ip, detail: kind });
    return redirect(ctx, thanks);
  }
  const rl = await rateLimit(ctx.db, `leadform:${ctx.ip ?? "unknown"}`, 10, 3600);
  if (!rl.allowed) return rerender(v, { form: "Too many submissions from your network. Please wait an hour or email us directly." }, 429);
  if (!(await verifyTurnstile(ctx, f.get("cf-turnstile-response")))) {
    return rerender(v, { form: "We could not verify that this submission came from a person. Please try again." }, 400);
  }
  const { errors } = validateLeadForm(v, kind);
  if (Object.keys(errors).length) return rerender(v, errors, 422);

  const service = v.service ? serviceBySlug(v.service) : undefined;
  const details = kind === "quote"
    ? [`Service: ${service?.name ?? "Not sure yet"}`, `Budget range: ${v.budget}`, `Timeline: ${v.timeline}`, "", v.message].join("\n")
    : v.message;
  try {
    const { leadId } = await captureLead(ctx.db, {
      name: v.name, email: v.email, phone: v.phone || undefined, company: v.company || undefined, website: v.website || undefined,
      interest: v.interest, message: details, source: kind === "quote" ? "quote_form" : "web_form",
    }, { ip: ctx.ip ?? undefined, attribution: submittedAttribution(ctx, f) });
    if (kind === "quote") {
      await ctx.db.prepare(`INSERT INTO lead_request_details (lead_id, service_slug, budget_range, timeline, created_at) VALUES (?,?,?,?,?)`)
        .bind(leadId, service?.slug ?? null, v.budget, v.timeline, nowIso()).run();
    }
    try {
      await sendMail(ctx, { template: "lead_received", to: v.email.toLowerCase(), subject: kind === "quote" ? "We received your quote request — Crestmont" : "We received your message — Crestmont",
        heading: kind === "quote" ? "Your quote request is in" : "Your message is in", idempotencyKey: `lead-ack:${leadId}`,
        paragraphs: [`Hello ${v.name}, thank you for contacting Crestmont Website Development.`,
          kind === "quote" ? "A member of our team will review your project details and reply by email. If the work is feasible within our services, we will follow up with questions or a written quote." : "A member of our team will read your message and reply by email.",
          "If you did not send this request, you can ignore this email."] });
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", msg: "lead acknowledgement email failed", leadId, error: (err as Error).message }));
    }
  } catch (err) {
    if (err instanceof ValidationError) return rerender(v, { form: err.issues.join(". ") }, 422);
    throw err;
  }
  return redirect(ctx, thanks, { kind: "success", text: kind === "quote" ? "Thank you — your quote request was received." : "Thank you — your message was received." });
}

// ───────────────────────── public routes ─────────────────────────

export function register(r: Router): void {
  r.get("/", (ctx) => page(ctx, "home", ["home.hero", "home.why", "home.capabilities", "home.experience", "home.cta", "process.page", "faq.items", "pricing.presentation", "portfolio.intro", ...serviceKeys()], async (c) => {
    const hero = c.get("home.hero"), why = c.get("home.why"), caps = c.get("home.capabilities"), exp = c.get("home.experience"), cta = c.get("home.cta");
    const steps = parseItems(c.get("process.page").steps);
    const faqs = parseItems(c.get("faq.items").items).slice(0, 5);
    const projects = await pf.listPublished(ctx.db);
    const featured = ["website-design-development", "website-redesign", "e-commerce-development", "custom-web-applications", "technical-seo", "ai-automation"].map((s) => serviceBySlug(s)!);
    const email = ctx.settings["contact.email"] ?? SUPPORT_EMAIL;
    return html`<section class="hero hero--home"><div class="container hero__grid"><div class="hero__copy">
<div class="eyebrow">${hero.eyebrow}</div><h1>${hero.heading}</h1><p class="lede">${hero.lede}</p>
<div class="hero__actions">${linkButton(hero.primary_label, "/pricing")}${linkButton(hero.quote_label, "/quote", "secondary")}</div></div>
<div class="hero__crest" aria-hidden="true">${crestRing()}<img src="/assets/brand/crestmont-logo-original.png" width="232" height="213" alt=""></div></div></section>
<section class="commitments" aria-label="Commitments"><ul class="commitments__list">
<li><span class="commitments__value">From ${pkgPrice("starter")}</span><span class="commitments__label">Published package prices, enforced at checkout</span></li>
<li><span class="commitments__value">Counted revisions</span><span class="commitments__label">Every round is recorded in your project</span></li>
<li><span class="commitments__value">Your approval first</span><span class="commitments__label">Nothing launches until you sign off</span></li>
<li><span class="commitments__value">Yours to keep</span><span class="commitments__label">Your domain stays registered to you</span></li></ul></section>
${section("Services", "What we build", html`${serviceList(featured, c)}<p class="section__more"><a href="/services">All services</a></p>`, { id: "services" })}
${section("How it comes together", "Anatomy of a build", anatomy(), { id: "anatomy", lede: "A website is a stack of decisions. Choose a layer to see what changes, and which stage of our process is responsible for it." })}
${section("Packages", "Published packages", html`${packageCards(c, { compact: true })}<p class="section__more"><a href="/pricing">Full package details</a> · <a href="/pricing/compare">Compare packages</a> · <a href="/quote">Custom development quote</a></p>`, { id: "packages", lede: c.get("pricing.presentation").lede })}
${section("Process", "How a project runs", html`${processStepper(steps)}<p class="section__more"><a href="/process">The full process</a></p>`, { id: "process" })}
${section("Portfolio", "Real websites", projects.length ? html`<div class="grid grid-2">${projects.slice(0, 2).map(portfolioCard)}</div><p class="section__more"><a href="/portfolio">View the portfolio</a></p>`
      : html`<p class="muted">Portfolio projects are published here once genuine screenshots of each live site have been captured and verified. We do not use mock-ups or stock imagery. <a href="/portfolio">About our portfolio</a></p>`, { id: "portfolio" })}
${section("Why Crestmont", why.heading, ledger(why.items), { id: "why" })}
${section("Capabilities", caps.heading, ledger(caps.items), { id: "capabilities" })}
${section("Maintenance", "Optional maintenance plans", html`${maintenanceCards()}<p class="section__more"><a href="/hosting-maintenance">Hosting &amp; maintenance</a></p>`, { id: "maintenance" })}
${section("Customer experience", exp.heading, itemCards(exp.items), { id: "experience", lede: exp.lede })}
${section("FAQs", "Common questions", html`${faqs.map((q) => html`<details class="disclosure"><summary>${q.title}</summary><p>${q.body}</p></details>`)}<p class="section__more"><a href="/faq">All questions</a></p>`, { id: "faq" })}
<section class="section cta-band" id="contact"><div class="container cta-band__grid"><div><p class="section__label">Contact</p><h2 style="margin-top:1.5rem">${cta.heading}</h2><p class="lede">${cta.body}</p>
<div class="hero__actions">${linkButton("Request a custom quote", "/quote")}${linkButton("Contact us", "/contact", "secondary")}</div>
<p class="cta-band__contact">Prefer email? Write to <a href="mailto:${email}">${email}</a>.</p></div>
<div class="card card--gold">${contactForm(ctx, { interest: "other" }, {}, { compact: true })}</div></div></section>`;
  }));

  r.get("/services", (ctx) => page(ctx, "services", ["services.overview", ...serviceKeys()], (c) => {
    const o = c.get("services.overview");
    return html`${pageHero("Services", o.heading, o.lede, html`${linkButton("View pricing", "/pricing")}${linkButton("Request a quote", "/quote", "secondary")}`)}
${SERVICE_GROUPS.map((g) => section("Services", g, serviceList(SERVICES.filter((s) => s.group === g), c)))}
${section("Not offered", "What we do not offer", html`<p class="muted">We do not run advertising campaigns, operate social media accounts on your behalf or sell full-service marketing retainers, and we do not promise rankings, leads, traffic or sales. We only take on work that passes a reasonable technical feasibility and delivery-capability review.</p>`)}`;
  }));

  r.get("/services/hosting-maintenance", (ctx) => redirect(ctx, "/hosting-maintenance"));
  r.get("/services/:slug", async (ctx, p) => {
    const s = serviceBySlug(p.slug);
    if (!s || s.pricing === "maintenance") throw new HttpError(404, "That service page does not exist.");
    return page(ctx, "services", [`service.${s.slug}`, "pricing.presentation"], (c) => {
      const copy = c.get(`service.${s.slug}`);
      const related = SERVICES.filter((x) => x.group === s.group && x.slug !== s.slug).slice(0, 3);
      return html`${pageHero(s.group, s.name, copy.summary, html`${s.pricing === "custom" ? linkButton("Request a quote", `/quote?service=${s.slug}`) : linkButton("View packages", "/pricing")}${linkButton(s.pricing === "custom" ? "Contact us" : "Request a quote", s.pricing === "custom" ? "/contact" : `/quote?service=${s.slug}`, "secondary")}`)}
<section class="section"><div class="container grid grid-2"><div class="prose">${renderMarkdown(copy.intro)}
<h2>How it is priced</h2><p>${PRICING_NOTE[s.pricing]}</p>${s.pricing !== "custom" ? html`<p class="muted">Packages: ${PKG_ORDER.map((id) => `${PACKAGES[id].name} ${pkgPrice(id)}`).join(" · ")}.</p>` : html`<p class="muted">Custom projects are billed 50% as a deposit, 25% after the approved design milestone and 25% before production launch.</p>`}</div>
<div>${s.includes.length ? html`<div class="card"><h3 class="card__title">What is included</h3><ul class="checklist">${s.includes.map((i) => html`<li>${i}</li>`)}</ul></div>` : ""}
${s.boundaries.length ? html`<div class="card card--quiet"><h3 class="card__title">Good to know</h3><ul class="plain-list">${s.boundaries.map((i) => html`<li>${i}</li>`)}</ul></div>` : ""}</div></div></section>
${related.length ? section("Related", "Related services", serviceList(related)) : ""}`;
    });
  });

  r.get("/pricing", (ctx) => page(ctx, "pricing", ["pricing.presentation"], (c) => {
    const pr = c.get("pricing.presentation");
    return html`${pageHero("Pricing", pr.heading, pr.lede)}
<section class="section section--flush"><div class="container">${packageCards(c)}<p class="section__more"><a href="/pricing/compare">Compare the packages side by side</a></p></div></section>
${section("Custom", pr.custom_heading, html`<div class="grid grid-2"><div><p class="lede">${pr.custom_body}</p>${linkButton("Request a custom quote", "/quote?package=custom")}</div>
<div class="card"><h3 class="card__title">Custom payment schedule</h3><ul class="checklist"><li>50% deposit to begin</li><li>25% after the approved design milestone</li><li>25% before production launch</li></ul></div></div>`)}
${section("Maintenance", "Optional monthly plans", html`${maintenanceCards()}<p class="section__more"><a href="/hosting-maintenance">Hosting &amp; maintenance details</a></p>`)}
${section("Policies", "Before you buy", html`<ul class="plain-list"><li>Every revision round is counted; additional work requires an approved change order.</li><li>You receive the agreed intellectual property rights after full payment, subject to third-party licences. Your domain remains yours.</li><li>Sites launch only after internal quality certification and your approval.</li><li>Refunds are reviewed by support and decided by the Founder, except where law or card-network rules require otherwise — see the <a href="/legal/refunds">refund policy</a>.</li></ul>`)}`;
  }));

  r.get("/pricing/compare", (ctx) => page(ctx, "compare", ["pricing.presentation"], () => {
    const covered = /^(up to \d+ pages|\d+ revision rounds)/i;
    const featureRows = [...new Set(PKG_ORDER.flatMap((id) => PACKAGES[id].includes.filter((i) => !covered.test(i))))];
    const cell = (ok: boolean) => ok ? html`<span class="tick" aria-label="Included">✓</span>` : html`<span class="faint" aria-label="Not included">—</span>`;
    return html`${pageHero("Pricing", "Compare packages", "Every row below comes from the same server-side catalogue that checkout uses.")}
<section class="section section--flush"><div class="container"><div class="table-wrap"><table class="table compare"><caption class="visually-hidden">Package comparison</caption>
<thead><tr><th scope="col">Feature</th>${PKG_ORDER.map((id) => html`<th scope="col">${PACKAGES[id].name}</th>`)}</tr></thead><tbody>
<tr><th scope="row">Price</th>${PKG_ORDER.map((id) => html`<td><strong>${pkgPrice(id)}</strong></td>`)}</tr>
<tr><th scope="row">Payment</th>${PKG_ORDER.map(() => html`<td>100% upfront</td>`)}</tr>
<tr><th scope="row">Pages</th>${PKG_ORDER.map((id) => html`<td>Up to ${PACKAGES[id].pageLimit}${id === "premium" ? " within approved scope" : ""}</td>`)}</tr>
<tr><th scope="row">Revision rounds</th>${PKG_ORDER.map((id) => html`<td>${PACKAGES[id].revisionRounds}</td>`)}</tr>
${featureRows.map((feat) => html`<tr><th scope="row">${feat}</th>${PKG_ORDER.map((id) => html`<td>${cell(PACKAGES[id].includes.includes(feat))}</td>`)}</tr>`)}
<tr><th scope="row"><span class="visually-hidden">Choose</span></th>${PKG_ORDER.map((id) => html`<td>${linkButton(`Choose ${PACKAGES[id].name}`, `/checkout/${id}`, "secondary", "sm")}</td>`)}</tr>
</tbody></table></div>
<p class="muted">A dash means the item is not listed for that package; packages differ in scope as well as features. Need more than Premium? <a href="/quote?package=custom">Request a custom quote</a>.</p></div></section>`;
  }));

  r.get("/portfolio", (ctx) => page(ctx, "portfolio", ["portfolio.intro"], async (c) => {
    const intro = c.get("portfolio.intro");
    const projects = await pf.listPublished(ctx.db);
    return html`${pageHero("Portfolio", intro.heading, intro.lede)}
<section class="section section--flush"><div class="container">${projects.length ? html`<div class="grid grid-3">${projects.map(portfolioCard)}</div>`
      : emptyState("Portfolio projects are being prepared", "Projects appear here once genuine desktop and mobile screenshots of each live website have been captured and verified, and the project's relationship to Crestmont is documented. We never substitute mock-ups or stock imagery.", html`<a class="btn btn--secondary" href="/contact">Ask us about our work</a>`)}</div></section>`;
  }));

  r.get("/portfolio/:slug", async (ctx, p) => {
    const proj = await pf.getBySlug(ctx.db, p.slug);
    if (!proj || !proj.published) throw new HttpError(404, "That portfolio project is not available.");
    const tms = await pf.publishedTestimonials(ctx.db, proj.id);
    return htmlResponse(ctx, publicLayout(ctx, { title: `${proj.name} — case study`, description: proj.description.slice(0, 160) }, html`
${pageHero(proj.industry, proj.name, undefined, html`<a class="btn btn--primary" href="${safeUrl(proj.live_url)}" rel="noopener" target="_blank">Visit live website</a>${linkButton("All projects", "/portfolio", "ghost")}`)}
<section class="section section--flush"><div class="container case-shots"><figure>${shot(proj, "desktop", true)}<figcaption class="faint">Desktop${proj.screenshot_captured_at ? ` · captured ${formatDate(proj.screenshot_captured_at)}` : ""}</figcaption></figure>
<figure>${shot(proj, "mobile", true)}<figcaption class="faint">Mobile</figcaption></figure></div></section>
<section class="section"><div class="container grid grid-2"><div class="prose"><h2>About the project</h2>${paragraphs(proj.description).map((x) => html`<p>${x}</p>`)}
${proj.technology_summary ? html`<h3>Technology</h3><p>${proj.technology_summary}</p>` : ""}<p class="faint">${proj.relationship}</p></div>
<div class="card"><h3 class="card__title">Verified features</h3><ul class="checklist">${pf.features(proj).map((f) => html`<li>${f}</li>`)}</ul>
${dl([["Industry", proj.industry], ["Live site", html`<a href="${safeUrl(proj.live_url)}" rel="noopener" target="_blank">${proj.live_url.replace(/^https?:\/\//, "")}</a>`], ["Link verified", formatDate(proj.link_verified_at)]])}</div></div></section>
${tms.length ? section("Testimonials", "What they said", html`<div class="grid grid-2">${tms.map((t) => html`<blockquote class="card testimonial"><p>“${t.body}”</p><footer class="faint">— ${t.author_name}</footer></blockquote>`)}</div>`) : ""}
<dialog id="viewer" class="viewer" aria-label="Screenshot viewer"><img alt=""><form method="dialog"><button class="btn btn--secondary btn--sm" type="submit" data-close>Close</button></form></dialog>`));
  });

  // Public screenshot bytes: ONLY files that are the current screenshot of a published project.
  r.get("/portfolio-media/:fileId", async (ctx, p) => {
    if (!(await pf.isPublicPortfolioFile(ctx.db, p.fileId))) throw new HttpError(404, "Not found");
    return serveImage(ctx, p.fileId, "public, max-age=3600");
  });

  r.get("/about", (ctx) => page(ctx, "about", ["about.page"], (c) => {
    const a = c.get("about.page");
    return html`${pageHero("About", a.heading, a.lede)}<section class="section section--flush"><div class="container grid grid-2"><div class="prose">${renderMarkdown(a.body)}</div>
<div class="card card--gold"><h3 class="card__title">What we will not do</h3><ul class="plain-list"><li>Promise search rankings, traffic, leads or sales.</li><li>Run advertising campaigns or manage social media accounts.</li><li>Publish invented testimonials, ratings, awards or client counts.</li><li>Launch your site without your approval.</li><li>Add work to your bill without an approved change order.</li></ul>
<p><a href="/process">How a project runs</a> · <a href="/legal/disclosures">Business disclosures</a></p></div></div></section>`;
  }));

  r.get("/process", (ctx) => page(ctx, "process", ["process.page"], (c) => {
    const pp = c.get("process.page");
    return html`${pageHero("Process", pp.heading, pp.lede)}<section class="section section--flush"><div class="container"><ol class="steps steps--full">${parseItems(pp.steps).map((s) => html`<li class="step"><h3 class="step__title">${s.title}</h3><p class="muted">${s.body}</p></li>`)}</ol>
<div class="row section__more">${linkButton("View packages", "/pricing")}${linkButton("Request a quote", "/quote", "secondary")}<a href="/legal/development-agreement">Development agreement information</a></div></div></section>`;
  }));

  r.get("/faq", (ctx) => page(ctx, "faq", ["faq.items"], (c) => html`${pageHero("FAQs", "Frequently asked questions")}<section class="section section--flush"><div class="container prose-wide">
${parseItems(c.get("faq.items").items).map((q) => html`<details class="disclosure"><summary>${q.title}</summary><p>${q.body}</p></details>`)}
<p class="section__more">Another question? <a href="/contact">Contact us</a>.</p></div></section>`));

  r.get("/hosting-maintenance", (ctx) => page(ctx, "hosting", ["hosting.page"], (c) => {
    const h = c.get("hosting.page");
    return html`${pageHero("Ongoing care", h.heading, h.lede, html`${linkButton("Ask about maintenance", "/contact?topic=maintenance")}`)}
<section class="section section--flush"><div class="container">${maintenanceCards()}</div></section>
${section("Ownership", "Your site, your choice", html`<ul class="plain-list"><li>Maintenance plans are optional. Your domain always remains registered to you.</li><li>You can use your own domain registrar or agency-managed DNS services.</li><li>Plans renew monthly by automatic billing, with self-service payment management in your customer portal; see the <a href="/legal/cancellation">cancellation policy</a>.</li><li>Support tickets can be submitted at any time; see the <a href="/legal/support">support policy</a> for staffed hours.</li></ul>`)}`;
  }));

  // ── lead forms ──
  r.get("/quote", (ctx) => {
    const pkg = ctx.url.searchParams.get("package") ?? "";
    const svc = ctx.url.searchParams.get("service") ?? "";
    return renderQuote(ctx, { interest: INTERESTS.some((i) => i.value === pkg) ? pkg : "custom", service: serviceBySlug(svc) ? svc : "" }, {}, 200);
  });
  r.post("/quote", (ctx) => handleLead(ctx, "quote", (v, e, s) => renderQuote(ctx, v, e, s)));
  r.get("/quote/thanks", (ctx) => thanksPage(ctx, "Quote request received", "Thank you. Your request is now in our CRM and a member of the team will review it and reply by email. If your project fits our services, we will follow up with questions or a written quote."));

  r.get("/contact", (ctx) => {
    const topic = ctx.url.searchParams.get("topic") ?? "";
    return renderContact(ctx, { interest: INTERESTS.some((i) => i.value === topic) ? topic : "other" }, {}, 200);
  });
  r.post("/contact", (ctx) => handleLead(ctx, "contact", (v, e, s) => renderContact(ctx, v, e, s)));
  r.get("/contact/thanks", (ctx) => thanksPage(ctx, "Message received", "Thank you. A member of the team will read your message and reply by email."));

  // ── legal ──
  r.get("/legal", (ctx) => {
    const docs = legalDocs(legalFacts(ctx));
    return htmlResponse(ctx, publicLayout(ctx, { title: "Policies", description: "Crestmont policies and business disclosures." }, html`${pageHero("Policies", "Policies & disclosures")}
<section class="section section--flush"><div class="container">${alert("warn", DRAFT_BANNER)}<div class="grid grid-3">${LEGAL_SLUGS.map((s) => html`<a class="card card--link" href="/legal/${s}"><h3 class="card__title">${docs[s].title}</h3><p class="muted">${docs[s].summary}</p></a>`)}</div></div></section>`));
  });
  r.get("/legal/:slug", (ctx, p) => {
    if (!(LEGAL_SLUGS as readonly string[]).includes(p.slug)) throw new HttpError(404, "That policy does not exist.");
    const docs = legalDocs(legalFacts(ctx));
    const d = docs[p.slug as LegalSlug];
    return htmlResponse(ctx, publicLayout(ctx, { title: d.title, description: d.summary }, html`${pageHero("Policies", d.title, d.summary)}
<section class="section section--flush"><div class="container"><div class="legal-draft" role="note"><strong>Draft — pending attorney review.</strong> ${DRAFT_BANNER.replace(/^Draft — pending attorney review\.\s*/, "")}</div>
<article class="prose legal">${d.sections.map((s) => html`<h2>${s.heading}</h2>${(s.paras ?? []).map((x) => html`<p>${x}</p>`)}${s.list ? html`<ul>${s.list.map((x) => html`<li>${x}</li>`)}</ul>` : ""}`)}</article>
<hr><nav aria-label="Other policies" class="legal-nav"><span class="faint">Other policies:</span> <a href="/legal">All policies</a> ${LEGAL_SLUGS.filter((s) => s !== d.slug).map((s) => html`<a href="/legal/${s}">${docs[s].title}</a> `)}</nav></div></section>`));
  });

  // ── SEO ──
  r.get("/robots.txt", (ctx) => {
    const body = ctx.env.ENVIRONMENT === "production"
      ? `User-agent: *\nDisallow: /staff\nDisallow: /portal\nDisallow: /account\nDisallow: /api/\nDisallow: /checkout\nAllow: /\n\nSitemap: ${ctx.baseUrl}/sitemap.xml\n`
      : "User-agent: *\nDisallow: /\n";
    return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600", ...securityHeaders("api") } });
  });
  r.get("/sitemap.xml", async (ctx) => {
    const projects = await pf.listPublished(ctx.db);
    const urls = [...PUBLIC_PATHS, ...projects.map((x) => `/portfolio/${x.slug}`)];
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(ctx.baseUrl + u)}</loc></url>`).join("\n")}\n</urlset>\n`;
    return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600", ...securityHeaders("api") } });
  });

  registerCmsAdmin(r);
  registerPortfolioAdmin(r);
}

function renderQuote(ctx: AppContext, v: FormVals, e: FieldErrors, status: number) {
  return page(ctx, "quote", [], () => html`${pageHero("Custom quote", "Request a custom quote", "Tell us about the project. We review technical feasibility before quoting, and every quote is a written scope with a fixed price and payment schedule.")}
<section class="section section--flush"><div class="container grid grid-2 form-layout"><div class="card card--gold">${quoteForm(ctx, v, e)}</div>
<aside><h2 class="h4">What happens next</h2><ol class="plain-list numbered"><li>Your request is recorded and reviewed by our team.</li><li>We reply by email, usually with questions about scope.</li><li>If the work is feasible, you receive a written quote.</li><li>Custom work is billed 50% / 25% / 25% across deposit, design approval and pre-launch.</li></ol>
<p class="muted">Looking for a standard website? The <a href="/pricing">published packages</a> can be purchased directly.</p></aside></div></section>`, status);
}

function renderContact(ctx: AppContext, v: FormVals, e: FieldErrors, status: number) {
  return page(ctx, "contact", ["contact.page"], (c) => {
    const cp = c.get("contact.page");
    const hours = ctx.settings["support.staffed_hours"];
    const email = ctx.settings["contact.email"] ?? SUPPORT_EMAIL;
    return html`${pageHero("Contact", cp.heading, cp.lede)}
<section class="section section--flush"><div class="container grid grid-2 form-layout"><div class="card card--gold">${contactForm(ctx, v, e)}</div>
<aside>${dl([["General & support", html`<a href="mailto:${email}">${email}</a>`], ["Sales", html`<a href="mailto:${SALES_EMAIL}">${SALES_EMAIL}</a>`], ["Billing", html`<a href="mailto:${BILLING_EMAIL}">${BILLING_EMAIL}</a>`],
  ["Staffed hours", hours ?? "Staffed support hours will be published here."]])}
<p class="muted">Existing customers can submit support tickets at any time from the <a href="/login">customer portal</a>.</p><p class="muted">Need a project estimate? Use the <a href="/quote">custom quote form</a>.</p></aside></div></section>`;
  }, status);
}

function thanksPage(ctx: AppContext, title: string, body: string) {
  return htmlResponse(ctx, publicLayout(ctx, { title, noindex: true }, html`<section class="hero hero--page"><div class="container"><div class="eyebrow">Received</div><h1>${title}</h1><p class="lede">${body}</p>
<div class="row">${linkButton("Return home", "/", "secondary")}${linkButton("View packages", "/pricing", "ghost")}</div></div></section>`));
}

async function serveImage(ctx: AppContext, fileId: string, cache: string): Promise<Response> {
  const file = await ctx.db.prepare(`SELECT r2_key, content_type FROM files WHERE id = ? AND deleted_at IS NULL AND folder = 'portfolio'`).bind(fileId).first<{ r2_key: string; content_type: string }>();
  if (!file || !ctx.storage || !["image/png", "image/jpeg", "image/webp"].includes(file.content_type)) throw new HttpError(404, "Not found");
  const obj = await ctx.storage.get(file.r2_key);
  if (!obj) throw new HttpError(404, "Not found");
  return new Response(obj.body as BodyInit, { headers: { "content-type": file.content_type, "cache-control": cache, ...securityHeaders("api") } });
}

// ───────────────────────── CMS admin (/staff/cms) ─────────────────────────

const staffShell = (ctx: AppContext, title: string, body: SafeHtml, status = 200) =>
  htmlResponse(ctx, appLayout(ctx, { title, nav: staffNav(ctx), home: "/staff", area: "Staff" }, body), status);

function cmsFail(e: unknown): never {
  if (e instanceof cms.CmsError || e instanceof pf.PortfolioError) throw new HttpError(e.status, e.issues.length ? `${e.message}: ${e.issues.join(" ")}` : e.message);
  throw e;
}

function registerCmsAdmin(r: Router) {
  r.get("/staff/cms", async (ctx) => {
    requireStaff(ctx, "cms.edit");
    const rows = await cms.overview(ctx.db);
    const groups = [...new Set(rows.map((x) => x.def.group))];
    const pending = rows.filter((x) => x.state?.pending_status === "pending_founder_approval");
    return staffShell(ctx, "Website CMS", html`${pageHead("Website CMS", undefined, "Content")}
<p class="muted">Edit public website content. Saving creates a draft revision; publishing makes it live. Unpublished content falls back to the repository default. Prices are never editable here — they come from the server-side catalogue.</p>
${pending.length ? alert("warn", html`<strong>${pending.length} pricing presentation change${pending.length > 1 ? "s" : ""} awaiting Founder approval.</strong> ${pending.map((x) => html`<a href="/staff/cms/${x.def.key}">${x.def.label}</a> `)}`) : ""}
${groups.map((g) => html`<h2 class="h4">${g}</h2>${table(rows.filter((x) => x.def.group === g), [
  { header: "Content", cell: (x) => html`<a href="/staff/cms/${x.def.key}">${x.def.label}</a>${x.def.sensitivePricing ? html` ${badge("requires_founder_approval", "Founder approval")}` : ""}` },
  { header: "Live version", cell: (x) => x.state?.published_id ? html`${badge("published")} <span class="faint">${formatDateTime(x.state.published_at)}</span>` : html`<span class="faint">Repository default</span>` },
  { header: "Unpublished", cell: (x) => x.state?.pending_status ? badge(x.state.pending_status) : "—" },
  { header: "Last edit", cell: (x) => formatDateTime(x.state?.last_edit) },
], { caption: g })}`)}`);
  });

  r.get("/staff/cms/revisions/:id", async (ctx, p) => {
    requireStaff(ctx, "cms.edit");
    const rev = await cms.getRevision(ctx.db, p.id);
    const def = rev && cmsKeyDef(rev.key);
    if (!rev || !def) throw new HttpError(404, "Revision not found");
    const body = JSON.parse(rev.body_json) as Record<string, string>;
    return staffShell(ctx, "Revision", html`${pageHead(`${def.label} — revision`, html`${linkButton("Back to editor", `/staff/cms/${def.key}`, "ghost", "sm")}${linkButton("Preview on site", `${def.previewPath}?preview=${rev.id}`, "secondary", "sm")}`, "Website CMS")}
${dl([["Status", badge(rev.status)], ["Created", formatDateTime(rev.created_at)], ["Published", formatDateTime(rev.published_at)], ["Note", rev.note]])}
<div class="card">${def.fields.map((f) => html`<h3 class="h4">${f.label}</h3><pre class="cms-pre">${body[f.name] ?? ""}</pre>${f.kind === "richtext" ? html`<div class="richtext__preview prose">${renderMarkdown(body[f.name])}</div>` : ""}`)}</div>`);
  });

  r.get("/staff/cms/revisions/:id/compare", async (ctx, p) => {
    requireStaff(ctx, "cms.edit");
    const rev = await cms.getRevision(ctx.db, p.id);
    const def = rev && cmsKeyDef(rev.key);
    if (!rev || !def) throw new HttpError(404, "Revision not found");
    const live = await cms.liveContent(ctx.db, def.key);
    const body = { ...def.defaults, ...(JSON.parse(rev.body_json) as Record<string, string>) };
    const changed = def.fields.filter((f) => (live.body[f.name] ?? "") !== (body[f.name] ?? ""));
    return staffShell(ctx, "Compare revision", html`${pageHead(`${def.label} — compare with live`, html`${linkButton("Back to editor", `/staff/cms/${def.key}`, "ghost", "sm")}${linkButton("Preview on site", `${def.previewPath}?preview=${rev.id}`, "secondary", "sm")}`, "Website CMS")}
<p class="muted">Lines prefixed <code>-</code> are on the live page now (${live.source === "published" ? "published revision" : "repository default"}); lines prefixed <code>+</code> are in this ${rev.status.replace(/_/g, " ")} revision from ${formatDateTime(rev.created_at)}.</p>
${changed.length ? def.fields.map((f) => {
      const diff = lineDiff(live.body[f.name] ?? "", body[f.name] ?? "");
      return changed.includes(f) ? html`<h3 class="h4">${f.label}</h3><pre class="code-block diff">${diff.map((d) => html`<span class="diff__${d.op === "+" ? "add" : d.op === "-" ? "del" : "ctx"}">${d.op} ${d.text}\n</span>`)}</pre>` : html``;
    }) : alert("info", "This revision is identical to what the live page shows.")}`);
  });

  r.post("/staff/cms/revisions/:id/discard", async (ctx, p) => {
    requireStaff(ctx, "cms.edit");
    try {
      const { key } = await cms.discardRevision(ctx.db, ctx.actor!, p.id, { ip: ctx.ip });
      return redirect(ctx, `/staff/cms/${key}`, { kind: "success", text: "Draft discarded. It stays in the revision history as archived." });
    } catch (e) { cmsFail(e); }
  });

  r.post("/staff/cms/revisions/:id/restore", async (ctx, p) => {
    requireStaff(ctx, "cms.edit");
    try {
      const res = await cms.restoreRevision(ctx.db, ctx.actor!, p.id, { ip: ctx.ip });
      return redirect(ctx, `/staff/cms/${res.key}`, { kind: "success", text: res.status === "pending_founder_approval" ? "Restored as a new revision awaiting Founder approval." : "Restored as a new draft. Preview it, then publish when ready." });
    } catch (e) {
      if (e instanceof cms.CmsError && e.status === 422) return redirect(ctx, "/staff/cms", { kind: "error", text: `That revision no longer passes content rules: ${e.issues.join(" ")}`.slice(0, 280) });
      cmsFail(e);
    }
  });

  r.post("/staff/cms/revisions/:id/publish", async (ctx, p) => {
    requireStaff(ctx, "cms.edit");
    try {
      const { key } = await cms.publishRevision(ctx.db, ctx.actor!, p.id, { ip: ctx.ip });
      return redirect(ctx, `/staff/cms/${key}`, { kind: "success", text: "Published. The public page now shows this revision." });
    } catch (e) { cmsFail(e); }
  });

  r.get("/staff/cms/:key", async (ctx, p) => {
    requireStaff(ctx, "cms.edit");
    const def = cmsKeyDef(p.key);
    if (!def) throw new HttpError(404, "Unknown content key");
    return cmsEditor(ctx, def);
  });

  r.post("/staff/cms/:key", async (ctx, p) => {
    requireStaff(ctx, "cms.edit");
    const def = cmsKeyDef(p.key);
    if (!def) throw new HttpError(404, "Unknown content key");
    const f = await ctx.form();
    const vals = Object.fromEntries(def.fields.map((x) => [x.name, String(f.get(x.name) ?? "")]));
    const rtIssues = def.fields.filter((x) => x.kind === "richtext").flatMap((x) => markdownIssues(vals[x.name]).map((m) => `${x.label}: ${m}`));
    if (rtIssues.length) return cmsEditor(ctx, def, vals, rtIssues, 422);
    try {
      const res = await cms.saveDraft(ctx.db, ctx.actor!, def.key, vals, { note: str(f, "note"), ip: ctx.ip });
      return redirect(ctx, `/staff/cms/${def.key}`, { kind: "success", text: res.status === "pending_founder_approval" ? "Saved. This pricing presentation change now awaits Founder approval." : "Draft saved. Preview it, then publish when ready." });
    } catch (e) {
      if (e instanceof cms.CmsError && e.status === 422) return cmsEditor(ctx, def, vals, e.issues, 422);
      cmsFail(e);
    }
  });

  r.post("/staff/cms/:key/revert", async (ctx, p) => {
    requireStaff(ctx, "cms.edit");
    try {
      await cms.unpublishEntry(ctx.db, ctx.actor!, p.key, { ip: ctx.ip });
      return redirect(ctx, `/staff/cms/${p.key}`, { kind: "success", text: "The public page now shows the repository default." });
    } catch (e) { cmsFail(e); }
  });
}

async function cmsEditor(ctx: AppContext, def: CmsKeyDef, values?: Record<string, string>, errors: string[] = [], status = 200): Promise<Response> {
  const hist = await cms.history(ctx.db, def.key);
  const latest = hist[0];
  const live = hist.find((h) => h.status === "published");
  const current = values ?? (latest ? { ...def.defaults, ...JSON.parse(latest.body_json) } : def.defaults);
  const canPublish = ctx.actor ? can(ctx.actor, "cms.publish") && (!def.sensitivePricing || can(ctx.actor, "pricing.change")) : false;
  return staffShell(ctx, `Edit ${def.label}`, html`${pageHead(def.label, html`${linkButton("All content", "/staff/cms", "ghost", "sm")}${linkButton("View live page", def.previewPath, "ghost", "sm")}`, `Website CMS · ${def.group}`)}
${def.sensitivePricing ? alert("warn", html`<strong>Pricing presentation.</strong> Changes need Founder approval: they are saved as “pending Founder approval” and only the Owner can publish them. Prices themselves are not editable here — they always come from the server-side catalogue, so checkout amounts never change.`) : ""}
${latest && latest.status !== "published" ? alert("info", html`The form shows the newest unpublished revision (${latest.status.replace(/_/g, " ")}). ${live ? "The live page still shows the published revision." : "The live page still shows the repository default."}`) : ""}
${formErrors(errors)}
<form method="post" action="/staff/cms/${def.key}" class="card">${csrf(ctx)}
${def.fields.map((f) => f.kind === "text" ? input({ name: f.name, label: f.label, value: current[f.name], required: true, maxlength: f.max, hint: f.hint })
    : f.kind === "richtext" ? richText({ name: f.name, label: f.label, value: current[f.name], rows: 10, required: true, maxlength: f.max, hint: f.hint, preview: renderMarkdown(current[f.name]) })
    : textarea({ name: f.name, label: f.label, value: current[f.name], rows: f.kind === "items" ? 16 : 6, required: true, maxlength: f.max, hint: f.hint }))}
${input({ name: "note", label: "Revision note (optional)", maxlength: 300 })}
<div class="form-actions">${button(def.sensitivePricing ? "Save for Founder approval" : "Save draft")}</div></form>
<h2 class="h4">Revision history</h2>
${table(hist, [
  { header: "Created", cell: (h) => html`<a href="/staff/cms/revisions/${h.id}">${formatDateTime(h.created_at)}</a>` },
  { header: "Status", cell: (h) => badge(h.status) },
  { header: "Author", cell: (h) => h.author_name ?? "—" },
  { header: "Published / approved by", cell: (h) => h.approver_name ? `${h.approver_name} · ${formatDateTime(h.published_at)}` : "—" },
  { header: "Note", cell: (h) => h.note ?? "" },
  { header: "Actions", cell: (h) => html`<a class="btn btn--ghost btn--sm" href="${def.previewPath}?preview=${h.id}">Preview</a> <a class="btn btn--ghost btn--sm" href="/staff/cms/revisions/${h.id}/compare">Compare with live</a>
${h.status !== "published" ? (canPublish ? actionForm(ctx, `/staff/cms/revisions/${h.id}/publish`, def.sensitivePricing ? "Approve & publish" : "Publish", { variant: "primary", confirm: "Publish this revision to the public website?" }) : html`<span class="faint">${def.sensitivePricing ? "Awaiting Founder approval" : "Needs a publisher"}</span>`) : ""}
${h.status === "draft" || h.status === "pending_founder_approval" ? actionForm(ctx, `/staff/cms/revisions/${h.id}/discard`, "Discard", { variant: "ghost", confirm: "Discard this unpublished draft?" }) : ""}
${h.status === "archived" ? actionForm(ctx, `/staff/cms/revisions/${h.id}/restore`, "Restore as new draft", { variant: "ghost" }) : ""}` },
], { empty: emptyState("No revisions yet", "The public page shows the repository default. Save a draft to start a revision history."), caption: "Revision history" })}
${live && canPublish ? html`<p>${actionForm(ctx, `/staff/cms/${def.key}/revert`, "Revert live page to repository default", { variant: "ghost", confirm: "Unpublish the live revision?" })}</p>` : ""}`, status);
}

// ───────────────────────── Portfolio admin (/staff/portfolio) ─────────────────────────

const projectFormValues = (f: FormData): pf.ProjectInput => ({
  name: str(f, "name"), slug: str(f, "slug").toLowerCase(), industry: str(f, "industry"), live_url: str(f, "live_url"), description: str(f, "description"),
  features: String(f.get("features") ?? ""), technology_summary: str(f, "technology_summary"), relationship: str(f, "relationship"),
});

function projectForm(ctx: AppContext, action: string, v: Partial<pf.ProjectInput>, submit: string, errors: string[] = []): SafeHtml {
  return html`${formErrors(errors)}<form method="post" action="${action}" class="card">${csrf(ctx)}
<div class="grid grid-2 form-grid">${input({ name: "name", label: "Project name", value: v.name, required: true, maxlength: 120 })}
${input({ name: "slug", label: "URL slug", value: v.slug, required: true, maxlength: 80, hint: "Lowercase letters, numbers and hyphens: /portfolio/<slug>" })}
${input({ name: "industry", label: "Industry", value: v.industry, required: true, maxlength: 120 })}
${input({ name: "live_url", label: "Live website link", type: "url", value: v.live_url, required: true, maxlength: 300, hint: "Changing the link clears its verification date and unpublishes the project." })}</div>
${textarea({ name: "description", label: "Description (verified facts only)", value: v.description, rows: 5, required: true, maxlength: 4000 })}
${textarea({ name: "features", label: "Verified features (one per line)", value: v.features, rows: 6, maxlength: 7000, hint: "List only functionality you have confirmed on the live site." })}
${textarea({ name: "technology_summary", label: "Technology summary (optional, only when known)", value: v.technology_summary, rows: 2, maxlength: 600 })}
${input({ name: "relationship", label: "Relationship to Crestmont", value: v.relationship, required: true, maxlength: 300 })}
<div class="form-actions">${button(submit)}</div></form>`;
}

function registerPortfolioAdmin(r: Router) {
  r.get("/staff/portfolio", async (ctx) => {
    requireStaff(ctx, "portfolio.manage");
    return portfolioList(ctx);
  });

  r.post("/staff/portfolio", async (ctx) => {
    requireStaff(ctx, "portfolio.manage");
    const v = projectFormValues(await ctx.form());
    try {
      const { id } = await pf.createProject(ctx.db, ctx.actor!, v, ctx.ip);
      return redirect(ctx, `/staff/portfolio/${id}`, { kind: "success", text: "Project added (unpublished)." });
    } catch (e) {
      if (e instanceof pf.PortfolioError && e.status === 422) return portfolioList(ctx, v, e.issues, 422);
      cmsFail(e);
    }
  });

  r.get("/staff/portfolio/files/:fileId", async (ctx, p) => {
    requireStaff(ctx, "portfolio.manage");
    return serveImage(ctx, p.fileId, "private, no-store");
  });

  r.post("/staff/portfolio/testimonials/:tid/:action", async (ctx, p) => {
    requireStaff(ctx, "portfolio.manage");
    if (p.action !== "publish" && p.action !== "unpublish") throw new HttpError(404, "Not found");
    try {
      const { projectId } = await pf.setTestimonialPublished(ctx.db, ctx.actor!, p.tid, p.action === "publish", ctx.ip);
      return redirect(ctx, projectId ? `/staff/portfolio/${projectId}` : "/staff/portfolio", { kind: "success", text: p.action === "publish" ? "Testimonial published." : "Testimonial unpublished." });
    } catch (e) { cmsFail(e); }
  });

  r.get("/staff/portfolio/:id", async (ctx, p) => {
    requireStaff(ctx, "portfolio.manage");
    return portfolioEditor(ctx, p.id);
  });

  r.post("/staff/portfolio/:id", async (ctx, p) => {
    requireStaff(ctx, "portfolio.manage");
    const v = projectFormValues(await ctx.form());
    try {
      await pf.updateProject(ctx.db, ctx.actor!, p.id, v, ctx.ip);
      return redirect(ctx, `/staff/portfolio/${p.id}`, { kind: "success", text: "Project details saved." });
    } catch (e) {
      if (e instanceof pf.PortfolioError && e.status === 422) return portfolioEditor(ctx, p.id, { errors: e.issues, values: v, status: 422 });
      cmsFail(e);
    }
  });

  const action = (path: string, run: (ctx: AppContext, id: string, f: FormData) => Promise<string>) => {
    r.post(`/staff/portfolio/:id/${path}`, async (ctx, p) => {
      requireStaff(ctx, "portfolio.manage");
      const f = await ctx.form();
      try {
        const msg = await run(ctx, p.id, f);
        return redirect(ctx, path === "move" ? "/staff/portfolio" : `/staff/portfolio/${p.id}`, { kind: "success", text: msg });
      } catch (e) {
        if (e instanceof pf.PortfolioError && (e.status === 422 || e.status === 409 || e.status === 503)) return portfolioEditor(ctx, p.id, { errors: [e.message, ...e.issues], status: e.status });
        cmsFail(e);
      }
    });
  };

  action("screenshot", async (ctx, id, f) => {
    const kind = str(f, "kind");
    if (kind !== "desktop" && kind !== "mobile") throw new pf.PortfolioError(422, "Screenshot not accepted", ["Choose desktop or mobile"]);
    const file = f.get("screenshot");
    if (!(file instanceof File) || file.size === 0) throw new pf.PortfolioError(422, "Screenshot not accepted", ["Choose an image file to upload"]);
    await pf.uploadScreenshot(ctx.db, ctx.storage, ctx.actor!, id, kind, file, str(f, "captured_on"), ctx.ip);
    return `${kind === "desktop" ? "Desktop" : "Mobile"} screenshot saved.`;
  });
  action("verify-link", async (ctx, id, f) => { await pf.recordLinkVerification(ctx.db, ctx.actor!, id, str(f, "verified_on"), ctx.ip); return "Link verification recorded."; });
  action("relationship", async (ctx, id, f) => { await pf.documentRelationship(ctx.db, ctx.actor!, id, str(f, "relationship"), str(f, "evidence"), ctx.ip); return "Relationship documentation recorded."; });
  action("publish", async (ctx, id) => { await pf.setPublished(ctx.db, ctx.actor!, id, true, ctx.ip); return "Project published."; });
  action("unpublish", async (ctx, id) => { await pf.setPublished(ctx.db, ctx.actor!, id, false, ctx.ip); return "Project unpublished."; });
  action("move", async (ctx, id, f) => { await pf.move(ctx.db, ctx.actor!, id, str(f, "dir") === "up" ? "up" : "down", ctx.ip); return "Order updated."; });
  action("testimonials", async (ctx, id, f) => { await pf.addTestimonial(ctx.db, ctx.actor!, id, { author: str(f, "author"), body: str(f, "body"), evidence: str(f, "evidence") }, ctx.ip); return "Verified testimonial saved (unpublished)."; });
}

async function portfolioList(ctx: AppContext, v: Partial<pf.ProjectInput> = {}, errors: string[] = [], status = 200): Promise<Response> {
  const all = await pf.listAll(ctx.db);
  return staffShell(ctx, "Portfolio", html`${pageHead("Portfolio", undefined, "Content")}
<p class="muted">Projects are public only when published. Publishing requires genuine desktop and mobile screenshots of the live site, a verified live link and documented relationship to Crestmont.</p>
${table(all, [
  { header: "#", cell: (p) => p.position, numeric: true },
  { header: "Project", cell: (p) => html`<a href="/staff/portfolio/${p.id}">${p.name}</a><br><span class="faint">${p.live_url}</span>` },
  { header: "Status", cell: (p) => p.published ? badge("published") : badge("draft", "Unpublished") },
  { header: "Ready to publish", cell: (p) => { const b = pf.publishBlockers(p); return b.length ? html`${badge("blocked", `${b.length} blocker${b.length > 1 ? "s" : ""}`)}` : badge("ok", "Ready"); } },
  { header: "Order", cell: (p) => html`${actionForm(ctx, `/staff/portfolio/${p.id}/move`, "Up", { hidden: { dir: "up" } })} ${actionForm(ctx, `/staff/portfolio/${p.id}/move`, "Down", { hidden: { dir: "down" } })}` },
], { empty: emptyState("No portfolio projects", "Add a project below."), caption: "Portfolio projects" })}
<h2 class="h4">Add a project</h2>${projectForm(ctx, "/staff/portfolio", { relationship: "Relationship documentation pending", ...v }, "Add project", errors)}`, status);
}

async function portfolioEditor(ctx: AppContext, id: string, opts: { errors?: string[]; values?: pf.ProjectInput; status?: number } = {}): Promise<Response> {
  const p = await pf.getById(ctx.db, id);
  if (!p) throw new HttpError(404, "Project not found");
  const blockers = pf.publishBlockers(p);
  const tms = await pf.testimonialsFor(ctx.db, id);
  const v = opts.values ?? { name: p.name, slug: p.slug, industry: p.industry, live_url: p.live_url, description: p.description, features: pf.features(p).join("\n"), technology_summary: p.technology_summary ?? "", relationship: p.relationship };
  const shotAdmin = (kind: "desktop" | "mobile") => {
    const fid = kind === "desktop" ? p.desktop_screenshot_file_id : p.mobile_screenshot_file_id;
    return html`<div class="card"><h3 class="card__title">${kind === "desktop" ? "Desktop" : "Mobile"} screenshot</h3>
${fid ? html`<a class="shot" href="/staff/portfolio/files/${fid}"><img src="/staff/portfolio/files/${fid}" alt="Current ${kind} screenshot of ${p.name}"></a>` : html`<div class="shot shot--pending"><span>Verified screenshot capture pending</span></div>`}
<form method="post" action="/staff/portfolio/${p.id}/screenshot" enctype="multipart/form-data">${csrf(ctx)}<input type="hidden" name="kind" value="${kind}">
${fileInput("screenshot", fid ? "Replace with a new genuine capture" : "Upload a genuine capture of the live site", { accept: ".png,.jpg,.jpeg,.webp", hint: "PNG, JPEG or WebP captured from the live production site · up to 25 MB. Never mock-ups or AI-generated images." })}
${input({ name: "captured_on", label: "Captured on", type: "date", required: true })}
<div class="form-actions">${button(fid ? "Replace screenshot" : "Upload screenshot", { variant: "secondary", size: "sm" })}</div></form></div>`;
  };
  return staffShell(ctx, p.name, html`${pageHead(p.name, html`${linkButton("All projects", "/staff/portfolio", "ghost", "sm")}${p.published ? linkButton("View public page", `/portfolio/${p.slug}`, "ghost", "sm") : ""}`, "Portfolio")}
${formErrors(opts.errors ?? [])}
<div class="card"><div class="row row--between"><div>${p.published ? badge("published") : badge("draft", "Unpublished")} <span class="faint">Updated ${formatDateTime(p.updated_at)}</span></div>
<div>${p.published ? actionForm(ctx, `/staff/portfolio/${p.id}/unpublish`, "Unpublish", { confirm: "Remove this project from the public portfolio?" }) : actionForm(ctx, `/staff/portfolio/${p.id}/publish`, "Publish", { variant: "primary" })}</div></div>
${blockers.length ? html`<div class="alert alert--warn" role="status"><strong>Publishing is blocked until:</strong><ul>${blockers.map((b) => html`<li>${b}</li>`)}</ul></div>` : html`<p class="muted">All publishing requirements are met.</p>`}</div>
<div class="grid grid-2">${shotAdmin("desktop")}${shotAdmin("mobile")}</div>
<div class="grid grid-2"><div class="card"><h3 class="card__title">Live link verification</h3>${dl([["Live link", html`<a href="${safeUrl(p.live_url)}" rel="noopener" target="_blank">${p.live_url}</a>`], ["Last verified", formatDate(p.link_verified_at)]])}
<form method="post" action="/staff/portfolio/${p.id}/verify-link">${csrf(ctx)}${input({ name: "verified_on", label: "Date you opened the link and confirmed it loads the correct site", type: "date", required: true })}<div class="form-actions">${button("Record verification", { variant: "secondary", size: "sm" })}</div></form></div>
<div class="card"><h3 class="card__title">Relationship documentation</h3>${dl([["Current", p.relationship], ["Documented", p.relationship_documented_at ? formatDate(p.relationship_documented_at) : "Not yet documented"], ["Evidence", p.relationship_evidence]])}
<form method="post" action="/staff/portfolio/${p.id}/relationship">${csrf(ctx)}${input({ name: "relationship", label: "Relationship statement shown publicly", value: /pending/i.test(p.relationship) ? "" : p.relationship, required: true, maxlength: 300 })}
${textarea({ name: "evidence", label: "Documentation (where it is kept, who authorised it, date)", rows: 3, required: true, maxlength: 2000 })}<div class="form-actions">${button("Record documentation", { variant: "secondary", size: "sm" })}</div></form></div></div>
<h2 class="h4">Project details</h2>${projectForm(ctx, `/staff/portfolio/${p.id}`, v, "Save details")}
<h2 class="h4">Verified testimonials</h2><p class="muted">Add only testimonials you have confirmed with the author, including permission to publish. They are stored separately and are unpublished until you publish them.</p>
${table(tms, [
  { header: "Author", cell: (t) => t.author_name }, { header: "Testimonial", cell: (t) => t.body }, { header: "Evidence", cell: (t) => html`<span class="faint">${t.verification_evidence}</span>` },
  { header: "Verified by", cell: (t) => t.verifier ?? "—" }, { header: "Status", cell: (t) => t.published ? badge("published") : badge("draft", "Unpublished") },
  { header: "", cell: (t) => actionForm(ctx, `/staff/portfolio/testimonials/${t.id}/${t.published ? "unpublish" : "publish"}`, t.published ? "Unpublish" : "Publish") },
], { empty: emptyState("No testimonials", "No verified testimonials have been recorded for this project."), caption: "Testimonials" })}
<form method="post" action="/staff/portfolio/${p.id}/testimonials" class="card">${csrf(ctx)}
${input({ name: "author", label: "Author name", required: true, maxlength: 120 })}${textarea({ name: "body", label: "Testimonial (exact words)", rows: 3, required: true, maxlength: 1500 })}
${textarea({ name: "evidence", label: "Verification evidence", rows: 2, required: true, maxlength: 2000, hint: "How the quote and permission to publish were confirmed (e.g. signed email on file, date)." })}
<div class="form-actions">${button("Add verified testimonial", { variant: "secondary" })}</div></form>`, opts.status ?? 200);
}

