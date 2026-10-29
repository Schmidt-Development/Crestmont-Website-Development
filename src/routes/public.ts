// Public website (WEB-001..010, CAT-001, PORT-004/006, LEGAL-001/002), Website CMS admin
// (CMS-001..003) and Portfolio admin (PORT-007). Content: CMS-published revisions over the
// repository defaults in src/content. Prices: only src/domain/catalog.ts.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, raw, safeUrl, formatCents, formatDate, formatDateTime, type SafeHtml } from "../lib/html.ts";
import { HttpError, htmlResponse, redirect, str, securityHeaders } from "../app/http.ts";
import { publicLayout, appLayout, crestRing, metaDescription } from "../ui/layout.ts";
import { csrf, input, textarea, select, button, linkButton, ctaLink, ARROW_SVG, actionForm, formErrors, alert, table, badge, emptyState, pageHead, dl, fileInput, attributionFields, richText } from "../ui/components.ts";
import { requireStaff } from "../app/app.ts";
import { staffNav } from "./nav.ts";
import { verifyTurnstile } from "./api.ts";
import { PACKAGES, PACKAGE_FEATURES, packageAdditions, MAINTENANCE_PLANS, type PackageId } from "../domain/catalog.ts";
import { effectivePrices } from "../services/pricing-approvals.ts";
import { can } from "../domain/authz.ts";
import { captureLead, requestAttribution, submittedAttribution, notifyNewLead } from "../services/leads.ts";
import { rateLimit, securityEvent } from "../services/security.ts";
import { sendMail } from "../services/mailer.ts";
import { ValidationError } from "../lib/validate.ts";
import { newId, nowIso } from "../lib/db.ts";
import * as cms from "../services/cms.ts";
import { lineDiff } from "../services/voice.ts";
import * as pf from "../services/portfolio.ts";
import { serviceVisual } from "../ui/service-visuals.ts";
import { receptionistConsole, voiceLibrary } from "../ui/receptionist.ts";
import { constellation, journey, qualityLab } from "../ui/about.ts";
import { portfolioExplorer } from "../ui/portfolio-explorer.ts";
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

/** `meta`, when given, derives the page's own title and description from its content instead of the shared SEO key. */
async function page(ctx: AppContext, seoKey: string, keys: string[], render: (c: Content) => SafeHtml | Promise<SafeHtml>, status = 200, meta?: (c: Content) => { title: string; description: string }): Promise<Response> {
  const c = await cms.loadContent(ctx, [`seo.${seoKey}`, ...keys]);
  effective = await effectivePrices(ctx.db, ctx.now());
  // CREST-GAP-010: in production, while online checkout is closed (draft policies, unnamed entity or live payments not
  // authorised — the same condition that disables the payments adapter), package CTAs lead to a quote request instead.
  checkoutClosed = ctx.env.ENVIRONMENT === "production" && !ctx.payments.configured;
  const seo = meta ? meta(c) : c.get(`seo.${seoKey}`);
  const body = await render(c);
  const banner = c.previewing
    ? html`<div class="preview-banner" role="status">Preview of an unpublished revision (${c.previewing}). Visitors still see the published version. <a href="/staff/cms/${c.previewing}">Back to the editor</a></div>`
    : html``;
  return htmlResponse(ctx, publicLayout(ctx, { title: seo.title, description: seo.description }, html`${banner}${body}`), status);
}

// Reference-matched section composition (docs/frontend/MOTION.md): a "/ label", then the heading (left) and
// supporting copy (right). Headings resolve word by word as they enter (app.js splits words at runtime, so the
// server HTML keeps whole phrases); supporting copy follows.
const section = (eyebrow: string, title: string, body: SafeHtml, opts: { id?: string; lede?: string; cls?: string } = {}) => html`<section class="section${opts.cls ? ` ${opts.cls}` : ""}"${opts.id ? html` id="${opts.id}"` : ""}><div class="container section__inner">
<p class="section__label">${eyebrow}</p><div class="section__head"><h2 class="reveal-words" data-reveal>${title}</h2>${opts.lede ? html`<p class="lede" data-reveal style="--rd:140ms">${opts.lede}</p>` : ""}</div>${body}</div></section>`;

const pageHero = (eyebrow: string, title: string, lede?: string, actions?: SafeHtml) => html`<section class="hero hero--page"><div class="container">
<div class="eyebrow">${eyebrow}</div><h1 class="hero-title">${title}</h1>${lede ? html`<p class="lede hero-seq" style="--seq:0">${lede}</p>` : ""}${actions ? html`<div class="row hero-seq" style="--seq:1">${actions}</div>` : ""}</div></section>`;

/** Service detail hero: the standard page hero copy and CTAs (unchanged) beside an interactive demonstration. */
const serviceHero = (eyebrow: string, title: string, lede: string | undefined, actions: SafeHtml, visual: SafeHtml | null) => visual
  ? html`<section class="hero hero--page hero--service"><div class="container hero-service"><div class="hero-service__copy">
<div class="eyebrow">${eyebrow}</div><h1 class="hero-title">${title}</h1>${lede ? html`<p class="lede hero-seq" style="--seq:0">${lede}</p>` : ""}<div class="row hero-seq" style="--seq:1">${actions}</div></div>
<div class="hero-service__visual hero-seq" style="--seq:2">${visual}</div></div></section>`
  : pageHero(eyebrow, title, lede, actions);

const itemCards = (text: string) => html`<div class="experience" data-reveal-group>${parseItems(text).map((i) => html`<div class="card card--feature" data-reveal><h3 class="card__title">${i.title}</h3><p class="muted">${i.body}</p></div>`)}</div>`;
/** Capability cards (three columns). */
const ledger = (text: string) => html`<ul class="ledger" data-reveal-group>${parseItems(text).map((i) => html`<li data-reveal><h3>${i.title}</h3><p>${i.body}</p></li>`)}</ul>`;

let checkoutClosed = false;
/** Where a package's "Choose" call to action leads (CREST-GAP-010). */
const packageCta = (id: string) => (checkoutClosed ? `/quote?package=${id}` : `/checkout/${id}`);

function packageCards(c: Content, opts: { compact?: boolean } = {}): SafeHtml {
  const pr = c.get("pricing.presentation");
  return html`<div class="grid grid-3 pricing-grid" data-reveal-group>${PKG_ORDER.map((id, i) => {
    const p = PACKAGES[id];
    const featured = id === "business";
    // Packages are cumulative: higher tiers lead with "Everything in <lower tier>, plus" and list only what they add.
    const items = i === 0 ? p.includes : packageAdditions(id);
    const shown = opts.compact ? items.slice(0, 5) : items;
    return html`<article class="card${featured ? " card--gold on-dark" : ""}${id === "premium" ? " package--premium" : ""} package" aria-labelledby="pkg-${id}" data-reveal>
<h3 class="card__title" id="pkg-${id}">${p.name}</h3><p class="muted">${pr[`${id}_tagline`] ?? ""}</p>
<div class="price" data-testid="price-${id}">${pkgPrice(id)}</div><p class="faint package__terms">${p.priceIsFloor ? "Starting price · final price in your written scope · " : "Fixed price · "}paid 100% upfront</p>
${i > 0 ? html`<p class="package__inherits">Everything in ${PACKAGES[PKG_ORDER[i - 1]].name}, plus:</p>` : ""}<ul class="checklist">${shown.map((it) => html`<li>${it}</li>`)}</ul>${opts.compact && items.length > shown.length ? html`<p class="package__more"><a href="/pricing/compare">See everything in ${p.name}</a></p>` : ""}
<div class="package__actions">${ctaLink(`Choose ${p.name}`, packageCta(id), featured ? "primary" : "secondary")}${id === "premium" ? html` <a class="btn btn--ghost" href="/quote?package=premium">Discuss a larger scope</a>` : ""}</div>
</article>`;
  })}</div>`;
}

/** Maintenance plans are on sale only once their entitlements are approved (CAT-006); billing copy waits for that (CREST-GAP-090). */
const plansApproved = () => plans().every((m) => m.entitlementsStatus === "approved");

function maintenanceCards(): SafeHtml {
  const approved = plansApproved();
  return html`<div class="grid grid-3 pricing-grid" data-reveal-group>${plans().map((m) => html`<div class="card package" data-reveal><h3 class="card__title">${m.name}</h3><div class="price" data-testid="price-${m.id}">${formatCents(effective[`maintenance:${m.id}`] ?? m.monthlyCents)}<small> / month</small></div>
${approved ? html`<ul class="checklist">${Object.values(m.proposedEntitlements).map((e) => html`<li>${e}</li>`)}</ul>` : html`<p class="muted">Full plan details will be published here once finalised.</p>`}</div>`)}</div>
${approved ? "" : html`<p class="muted">Each plan will have explicit, published limits for hosting, maintenance time, content updates, security updates, monitoring, backups and support response targets — with no unlimited development or unlimited support. Have a question in the meantime? <a href="/contact?topic=maintenance">Ask us about maintenance</a>.</p>`}`;
}

function portfolioCard(p: pf.PortfolioProject): SafeHtml {
  return html`<article class="card portfolio-card"><a class="portfolio-card__shot" href="/portfolio/${p.slug}">${shot(p, "desktop")}</a>
<div class="eyebrow">${p.industry}</div><h3 class="card__title"><a href="/portfolio/${p.slug}">${p.name}</a></h3><p class="muted">${p.description.length > 180 ? p.description.slice(0, 177) + "…" : p.description}</p>
<div class="row"><a class="btn btn--secondary btn--sm" href="/portfolio/${p.slug}">Case study</a><a class="btn btn--ghost btn--sm" href="${safeUrl(p.live_url)}" rel="noopener noreferrer" target="_blank">Visit live website</a></div></article>`;
}

function shot(p: pf.PortfolioProject, kind: "desktop" | "mobile", viewer = false): SafeHtml {
  const id = kind === "desktop" ? p.desktop_screenshot_file_id : p.mobile_screenshot_file_id;
  const asset = kind === "desktop" ? p.poster_desktop_asset : p.poster_mobile_asset;
  // CREST-GAP-048: bundled posters are captures of the project's isolated demonstration build (sample data), and the
  // alt text says so; an uploaded screenshot is described without claiming where it was taken.
  const alt = `${kind === "desktop" ? "Desktop" : "Mobile"} screenshot of the ${p.name} website${id ? "" : " (demonstration build with sample data)"}`;
  if (!id && !asset) return html`<div class="shot shot--pending${kind === "mobile" ? " shot--mobile" : ""}" role="img" aria-label="${alt} — capture pending"><span>Verified screenshot capture pending</span></div>`;
  const src = id ? `/portfolio-media/${id}` : asset!;
  // CREST-GAP-078: intrinsic size reserves the space before the image loads (desktop 1440×900, phone 390×844 CSS px).
  const [w, h] = kind === "desktop" ? [1440, 900] : [390, 844];
  const img = html`<img src="${src}" alt="${alt}" width="${String(w)}" height="${String(h)}" loading="lazy" decoding="async">`;
  return viewer ? html`<a class="shot${kind === "mobile" ? " shot--mobile" : ""}" href="${src}" data-viewer data-alt="${alt}">${img}<span class="visually-hidden">Open full-screen</span></a>` : html`<div class="shot">${img}</div>`;
}

/** Large two-up project presentation (M05): image group enters before its text group. */
function showcase(projects: pf.PortfolioProject[]): SafeHtml {
  return html`<div class="showcase" data-reveal-group>${projects.slice(0, 2).map((p) => html`<a class="showcase__item" href="/portfolio/${p.slug}" data-reveal>
<div class="showcase__media">${p.desktop_screenshot_file_id ? html`<img src="/portfolio-media/${p.desktop_screenshot_file_id}" alt="Desktop screenshot of the ${p.name} website" width="1440" height="900" loading="lazy" decoding="async">` : html`<div class="shot shot--pending" role="img" aria-label="Screenshot of ${p.name} — capture pending"><span>Verified screenshot capture pending</span></div>`}</div>
<div data-reveal style="--rd:120ms"><p class="faint" style="margin:0 0 .25rem">${p.industry}</p><h3 class="card__title" style="font-size:1.35rem">${p.name}</h3><p class="muted" style="margin:0">${p.description.length > 160 ? p.description.slice(0, 157) + "…" : p.description}</p></div></a>`)}</div>`;
}

/** Editorial index of services: name, summary and an arrow per row; the whole row is the link. */
function serviceList(list: ServiceDef[], c?: Content): SafeHtml {
  return html`<ul class="index-list" data-reveal-group>${list.map((s) => {
    const summary = c?.get(`service.${s.slug}`).summary ?? s.summary;
    return html`<li data-reveal><a href="${servicePath(s)}"><span class="index-list__name">${s.name}</span><span class="index-list__summary">${summary}</span><span class="index-list__arrow" aria-hidden="true">→</span></a></li>`;
  })}</ul>`;
}

/** Original rendered illustrations (tools/art/render_illustrations.py) for the six featured services. */
const SERVICE_ART: Record<string, string> = {
  "website-design-development": "svc-design-dev", "website-redesign": "svc-redesign", "e-commerce-development": "svc-ecommerce",
  "custom-web-applications": "svc-apps", "technical-seo": "svc-seo", "ai-automation": "svc-automation",
};

/** Services bento (M05): two wide cards, four standard cards; each card links to the service page. */
function serviceBento(list: ServiceDef[], c?: Content): SafeHtml {
  return html`<div class="bento" data-reveal-group>${list.map((s) => {
    const summary = c?.get(`service.${s.slug}`).summary ?? s.summary;
    const art = SERVICE_ART[s.slug];
    return html`<a class="bento__card" href="${servicePath(s)}" data-reveal><span class="bento__go" aria-hidden="true">${ARROW_SVG}</span>
${art ? html`<img class="bento__icon" src="/assets/art/${art}.webp" width="360" height="360" alt="" loading="lazy" decoding="async">` : html`<span class="bento__icon"></span>`}
<span class="bento__text"><span class="bento__title">${s.name}</span><span class="bento__summary">${summary}</span></span></a>`;
  })}</div>`;
}

/**
 * "Anatomy of a build" (M07): an illustrative miniature website assembled in six layers, each tied to a real stage
 * of the Crestmont process. Labelled as a concept; the business in the miniature is fictional.
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
  return html`<p class="anatomy__note">Illustrative concept — not a client project</p><div class="anatomy" data-anatomy>
<div data-reveal><ol class="anatomy__layers" role="tablist" aria-label="Layers of a website build" aria-orientation="vertical">${ANATOMY.map((l, i) => html`<li class="anatomy__layer">
<button class="anatomy__tab" type="button" role="tab" id="anatomy-tab-${i + 1}" aria-controls="anatomy-stage" aria-selected="${i === last - 1 ? "true" : "false"}"><span class="anatomy__tab-title">${l.title}</span><span class="anatomy__tab-stage">Process stage: ${l.stage}</span></button>
<p class="anatomy__detail">${l.body}</p></li>`)}</ol></div>
<div class="anatomy__stage" id="anatomy-stage" role="tabpanel" aria-label="Miniature website preview" data-reveal style="--rd:140ms">
<div class="mini" data-layer="${last}" aria-hidden="true"><div class="mini__chrome"><i></i><i></i><i></i><span class="mini__url">your-business.example</span><span class="mini__score">✓ Checks complete</span></div>
<div class="mini__viewport"><div class="mini__page">
<div class="mini__nav mini__region"><span class="mini__tag">header</span><span class="mini__logo"></span><span class="mini__links"><i></i><i></i><i></i></span><span class="mini__btn"><span class="mini__btn-label">Visit</span></span></div>
<div class="mini__hero mini__region"><span class="mini__tag">main</span><div><span class="mini__h"></span><span class="mini__h mini__h--2"></span>
<p class="mini__text mini__text--h">Fresh bread, baked before sunrise.</p><span class="mini__p"></span><span class="mini__p mini__p--2"></span>
<p class="mini__text mini__text--p">Order ahead online and collect a warm loaf on your way to work.</p><span class="mini__cta"><span class="mini__cta-label">Order ahead</span></span></div><span class="mini__img"></span></div>
<div class="mini__cards mini__region"><span class="mini__tag">section</span><span class="mini__card"><span class="mini__card-text">Sourdough<span>Baked daily</span></span></span><span class="mini__card"><span class="mini__card-text">Pastries<span>Weekends</span></span></span><span class="mini__card"><span class="mini__card-text">Catering<span>Order 48h ahead</span></span></span></div>
</div></div>
<div class="mini__caption"><span>Layer: <strong data-anatomy-caption>${ANATOMY[last - 1]!.title}</strong></span><span>Fictional business, for illustration</span></div></div></div></div>`;
}

/**
 * The approved process steps grouped into four phases for the stage controller (M06). With the default 11 steps the
 * phases follow the real sequence; if the CMS changes the step count, steps are split evenly and each phase takes the
 * name of its first step, so a phase name never contradicts its content.
 */
const PHASES = [
  { name: "Scope", art: "stage-scope", from: 0, to: 4 }, { name: "Design", art: "stage-design", from: 4, to: 5 },
  { name: "Build", art: "stage-build", from: 5, to: 8 }, { name: "Launch", art: "stage-launch", from: 8, to: 11 },
];
function phasesOf(steps: { title: string; body: string }[]) {
  if (steps.length === 11) return PHASES.map((p) => ({ name: p.name, art: p.art, steps: steps.slice(p.from, p.to) }));
  const n = Math.max(1, Math.ceil(steps.length / 4));
  return PHASES.map((p, i) => ({ art: p.art, steps: steps.slice(i * n, i * n + n) })).filter((p) => p.steps.length).map((p) => ({ ...p, name: p.steps[0]!.title }));
}

/** Process stage controller (M06): sticky stage number + illustration; phase text scrolls in normal flow. */
function processStages(steps: { title: string; body: string }[]): SafeHtml {
  const phases = phasesOf(steps);
  const pad = (n: number) => String(n).padStart(2, "0");
  return html`<div class="stages" data-stages>
<div class="stages__aside" aria-hidden="true"><div class="stages__count"><span class="stages__num-wrap"><span class="stages__num" data-stage-num>/${pad(1)}</span></span><span>/${pad(phases.length)}</span></div>
<div class="stages__art" data-stage-art><img src="/assets/art/${phases[0]!.art}.webp" width="720" height="720" alt="" decoding="async"></div></div>
<ol class="stages__list">${phases.map((ph, i) => html`<li class="stage" data-stage="${i}" data-art="/assets/art/${ph.art}.webp"${i === 0 ? html` data-current` : ""}>
<div class="stage__art-m" aria-hidden="true"><img src="/assets/art/${ph.art}.webp" width="720" height="720" alt="" loading="lazy" decoding="async"></div>
<p class="stage__num">/${pad(i + 1)}</p><h3>${ph.name}</h3>
<ol class="stage__steps">${ph.steps.map((s) => html`<li><strong>${s.title}</strong><span>${s.body}</span></li>`)}</ol></li>`)}</ol></div>`;
}

/** AI Receptionist (docs/frontend/AI-RECEPTIONIST.md): the dedicated service page. CREST-GAP-051: every statement is
 *  either something Crestmont delivers or worded as custom, per-client configuration built on the voice provider the
 *  client chooses — nothing here describes booking, text messages, live transfers or outbound calling as a built-in
 *  feature (tests/support/content-rules.ts RECEPTIONIST_UNBUILT). Natural, humanlike conversation is the design goal,
 *  never a claim that callers cannot tell; the assistant always identifies itself as AI. */
const RC_INBOUND: [string, string][] = [
  ["Answering", "Answers the calls you route to it, at the hours you choose, with a greeting written for your business."],
  ["Questions and intake", "Answers from the information you approve, asks follow-up questions and collects the details your team needs."],
  ["Appointment requests", "Takes appointment and callback requests. Booking straight into your calendar can be built where your scheduling tool and the provider support it."],
  ["Urgent calls", "Recognises the call types you define as urgent and follows your rules — a callback task, an alert to your team, or a transfer where your phone setup supports it."],
  ["Records", "Can send each caller's details and the outcome to your CRM, if it has an API we can connect within the scope."],
  ["Summaries", "Each call can end with a written summary: who called, what they needed and what happens next."],
];
const RC_OUTBOUND: [string, string][] = [
  ["Scoped separately", "Outbound calls are not part of a standard setup. Where a client needs them — for example confirming visits customers booked — they are designed and quoted individually."],
  ["Consent first", "Only for contacts who have given the consent the law requires for that kind of call."],
];
const RC_SAFEGUARDS = [
  "Call only contacts who have given the consent the law requires for that kind of call",
  "Check do-not-call and suppression lists before every call, and honour opt-outs immediately",
  "Call only within permitted hours in the contact's local time",
  "Identify itself as an AI assistant calling on behalf of your business",
  "Follow the recording and transcription consent rules that apply to the call",
];
const RC_USES: [string, string, string][] = [
  ["Home and repair services", "Takes estimate requests after hours, captures job details and flags emergencies for the on-call person under your rules.", "Inbound · Intake · Urgent rules"],
  ["Appointment-based studios", "Answers the common questions and takes booking or change requests; direct booking can be connected where your scheduling tool allows it.", "Inbound · Appointment requests"],
  ["Professional offices", "Greets callers, runs a short intake and records each enquiry for the right person to follow up.", "Inbound · Intake · Records"],
  ["Rental and hospitality", "Answers availability and policy questions from your approved information and records callback requests.", "Inbound · Callback requests"],
];
const RC_FLOW: [string, string][] = [
  ["Phone call", "Calls reach the agent through the voice provider you choose — forwarded from your existing number or on a new one."],
  ["AI receptionist", "Follows the script and guardrails you approve and keeps the context of the call."],
  ["Calendar", "Optional: connected where your calendar or booking tool and the provider support it."],
  ["CRM", "Optional: caller details and outcomes sent to your CRM through its API."],
  ["Website and forms", "The same approved information can power your website assistant, so answers stay consistent."],
  ["Your team", "Urgent and sensitive calls follow your rules — a callback task, an alert, or a transfer where your phone setup supports it."],
];
const RC_STEPS: [string, string][] = [
  ["Discovery", "Your call types, hours, rules for urgent calls and the systems to connect."],
  ["Script and guardrails", "What the agent may answer, what it must hand over, and how it identifies itself."],
  ["Voice", "Choose a voice and pace from the options your chosen provider offers."],
  ["Connections", "Calendar, CRM and notifications, within the written scope."],
  ["Testing", "Test calls on non-public numbers until the conversations meet your approval."],
  ["Launch and review", "Go live on your number, then review call outcomes and refine together."],
];
const RC_FAQ: [string, string][] = [
  ["Is it a ready-made product?", "No. Each AI Receptionist is a custom configuration built for one client on the voice provider they choose. What it can do depends on that provider and on the systems connected, and it is agreed in the written scope before work starts."],
  ["Will callers know they are talking to AI?", "Yes. The agent identifies itself as an AI assistant. It is designed to sound natural and conversational — not to pretend to be a person."],
  ["What happens when the AI can't help?", "It follows the rules you set: a callback task with a summary, an alert to your team or, where your phone setup supports it, a transfer. Every agent has a path to a person."],
  ["Can it make outbound calls?", "Only if your project scopes it. Outbound calling is not part of a standard setup; where a client needs it — for example confirming visits customers booked — it is designed and quoted individually, for contacts who have given the consent the law requires, with do-not-call checks, permitted hours and opt-outs. Unsolicited automated calling is not something we set up."],
  ["Which voices and languages are available?", "That depends on the voice provider chosen for your project. You choose a voice and pace during setup; English is standard and other languages, such as Spanish, can be configured where the provider supports them."],
  ["How is it priced?", "It is quoted in writing after a scoping call, like all custom work. Phone numbers, call minutes and voice-provider usage are billed by the provider."],
];

function aiReceptionistPage(s: ServiceDef, copy: Record<string, string>, email: string): SafeHtml {
  const quote = `/quote?service=${s.slug}`;
  return html`${serviceHero("Custom AI voice agents", s.name, copy.summary ?? s.summary, html`${linkButton("Request a quote", quote)}${linkButton("Contact us", "/contact", "secondary")}`, receptionistConsole({ id: "rc-page" }))}
<section class="section"><div class="container section__inner"><p class="section__label">What it can do</p><div class="section__head"><h2 class="reveal-words" data-reveal>Configured around your calls</h2><div class="prose" data-reveal style="--rd:140ms">${renderMarkdown(copy.intro ?? s.intro)}</div></div>
<div class="versus rc-dir" data-reveal-group>
<div class="versus__panel on-dark" data-reveal><p class="versus__title">Inbound — what we can configure</p><ul class="versus__list">${RC_INBOUND.map(([t, b]) => html`<li><span><strong>${t}</strong><span>${b}</span></span></li>`)}</ul></div>
<div class="versus__panel on-dark" data-reveal style="--rd:140ms"><p class="versus__title">Outbound — only when scoped</p><ul class="versus__list">${RC_OUTBOUND.map(([t, b]) => html`<li><span><strong>${t}</strong><span>${b}</span></span></li>`)}</ul>
<p class="rc-safe__title">Any outbound calling we configure must</p><ul class="rc-safe">${RC_SAFEGUARDS.map((x) => html`<li>${x}</li>`)}</ul></div></div></div></section>
${section("Voice", "Choose how it sounds", html`<div data-reveal>${voiceLibrary()}</div>`, { id: "voices", lede: "Pick a voice style during setup from the voices your chosen provider offers. The styles below are text previews of tone, not recordings." })}
${section("Where it helps", "Built around your calls", html`<ul class="ledger rc-uses" data-reveal-group>${RC_USES.map(([t, b, tag]) => html`<li data-reveal><p class="rc-uses__tag">${tag}</p><h3>${t}</h3><p>${b}</p></li>`)}</ul><p class="muted rc-uses__note">Examples of how the service can be configured — not client results.</p>`, { id: "uses" })}
${section("Connected", "How it can connect", html`<ol class="rc-flow" data-reveal-group>${RC_FLOW.map(([t, b], i) => html`<li class="rc-flow__node${i === 1 ? " rc-flow__node--core" : ""}" data-reveal style="${`--rd:${i * 70}ms`}"><span class="rc-flow__n">${String(i + 1).padStart(2, "0")}</span><strong>${t}</strong><span>${b}</span></li>`)}</ol>`, { id: "workflow", lede: "Each connection is optional and is agreed in the written scope of your project, depending on what your provider and systems support." })}
<section class="section" id="handoff"><div class="container section__inner"><p class="section__label">People stay in charge</p><div class="section__head"><h2 class="reveal-words" data-reveal>A person is always one step away</h2><p class="lede" data-reveal style="--rd:140ms">Urgent, sensitive or complicated calls go to your team under rules you set — as a callback task with a summary, an alert, or a live transfer where your phone setup supports it. The “Urgent → a person” scenario in the simulated call above shows one way a handoff can be configured.</p></div>
<div class="versus" data-reveal-group>
<div class="versus__panel on-dark" data-reveal><p class="versus__title">What we design for</p><ul class="versus__list">${["Natural conversation with sensible pacing, using your provider's voice technology", "Handling interruptions and changes of plan, as far as the provider supports it", "Remembering what the caller said earlier in the same call", "Answering from your approved information only", "Working at the hours you choose"].map((x) => html`<li><span>${x}</span></li>`)}</ul></div>
<div class="versus__panel versus__panel--not" data-reveal style="--rd:160ms"><p class="versus__title">What to know</p><ul class="versus__list">${s.boundaries.map((x) => html`<li><span>${x}</span></li>`)}</ul></div></div></div></section>
${section("Setup", "From first call to launch", html`<ol class="rc-steps" data-reveal-group>${RC_STEPS.map(([t, b], i) => html`<li data-reveal><span class="rc-steps__n">${String(i + 1).padStart(2, "0")}</span><strong>${t}</strong><span>${b}</span></li>`)}</ol>
<div class="card rc-price" data-reveal><h3 class="card__title">How it is priced</h3><p>${PRICING_NOTE[s.pricing]}</p><p class="muted">Custom projects are billed 50% as a deposit, 25% after the approved design milestone and 25% before production launch. Phone numbers, call minutes and voice-provider usage are billed by the provider.</p><div class="row">${linkButton("Request a quote", quote)}</div></div>`, { id: "setup" })}
<section class="section" id="faq"><div class="container faq"><div class="faq__aside"><p class="section__label">FAQs</p><h2 class="faq__title reveal-words" data-reveal>AI Receptionist questions</h2>
<p data-reveal style="--rd:120ms">Another question? <a href="/contact">Contact us</a> or write to <a href="mailto:${email}">${email}</a>.</p></div>
<div data-reveal>${RC_FAQ.map(([q, a]) => html`<details class="disclosure"><summary>${q}</summary><div class="disclosure__body"><p>${a}</p></div></details>`)}</div></div></section>
<section class="section"><div class="container"><div class="cta-band on-dark rc-cta" data-reveal-group><p class="section__label" data-reveal>AI Receptionist</p><h2 class="reveal-words" data-reveal>Designed around the calls that matter</h2><p class="lede" data-reveal>Tell us how your calls work today. We'll scope an agent around your hours, systems and rules, and quote it in writing.</p><div class="hero__actions" data-reveal>${ctaLink("Request a quote", quote, "primary")}${ctaLink("Talk to us", "/contact", "secondary")}</div></div></div></section>`;
}

/** Things Crestmont will not do (shown on About and in the homepage comparison; approved copy). */
const WILL_NOT = [
  "Promise search rankings, traffic, leads or sales.", "Run advertising campaigns or manage social media accounts.",
  "Publish invented testimonials, ratings, awards or client counts.", "Launch your site without your approval.",
  "Add work to your bill without an approved change order.",
];

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

/** Cloudflare Turnstile widget (renders nothing without a site key, e.g. in development). Also used by /register and /password/forgot. */
export function turnstileWidget(ctx: AppContext): SafeHtml {
  if (!ctx.env.TURNSTILE_SITE_KEY) return html``;
  return html`<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><div class="cf-turnstile field" data-sitekey="${ctx.env.TURNSTILE_SITE_KEY}"></div>`;
}

/** One-time submission token (not lead data): a second submit of the same form — a double click or a retried request —
 *  lands on the same thank-you page without creating a second lead. Forms posted without it behave as before. */
// One-time submission token: "<issued unix seconds>-<96 random bits>". The issue time is the token's fixed rate_limits
// window, so the claim stays unique for the token's whole life (no reset at a window boundary); retention purges it
// after two days, by which time the token has expired (SUBMISSION_TTL_S) and is no longer honoured.
const SUBMISSION_RE = /^(\d{10})-([a-f0-9]{24})$/;
const SUBMISSION_TTL_S = 36 * 3600;
const newSubmission = () => `${Math.floor(Date.now() / 1000)}-${randomHex(12)}`;
function liveSubmission(token: string | undefined, now = Date.now()): { key: string; issued: number } | null {
  const m = SUBMISSION_RE.exec(token ?? ""); if (!m) return null;
  const issued = Number(m[1]), age = now / 1000 - issued;
  return age >= -300 && age <= SUBMISSION_TTL_S ? { key: m[2], issued } : null;
}
const submissionField = (v: FormVals) => html`<input type="hidden" name="submission" value="${liveSubmission(v.submission) ? v.submission : newSubmission()}">`;
function randomHex(bytes: number): string { const a = new Uint8Array(bytes); crypto.getRandomValues(a); return [...a].map((b) => b.toString(16).padStart(2, "0")).join(""); }

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
  return html`${formErrors(Object.values(e))}<form method="post" action="/quote" class="lead-form" novalidate data-lead-form data-min-message="20">${csrf(ctx)}${honeypot()}${submissionField(v)}${attributionFields(requestAttribution(ctx))}
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
  return html`${formErrors(Object.values(e))}<form method="post" action="/contact" class="lead-form" novalidate>${csrf(ctx)}${honeypot()}${submissionField(v)}${attributionFields(requestAttribution(ctx))}
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
  v.submission = str(f, "submission");
  const thanks = kind === "quote" ? "/quote/thanks" : "/contact/thanks";
  if (str(f, HONEYPOT)) {
    await securityEvent(ctx.db, "lead_form_honeypot", { ip: ctx.ip, detail: kind });
    return redirect(ctx, thanks);
  }
  if (!(await verifyTurnstile(ctx, f.get("cf-turnstile-response")))) {
    return rerender(v, { form: "We could not verify that this submission came from a person. Please try again." }, 400);
  }
  const { errors } = validateLeadForm(v, kind);
  if (Object.keys(errors).length) return rerender(v, errors, 422);
  // CREST-GAP-082: only submissions that passed bot verification and validation count toward the per-network budget,
  // so a visitor correcting typos is never locked out.
  const rl = await rateLimit(ctx.db, `leadform:${ctx.ip ?? "unknown"}`, 10, 3600);
  if (!rl.allowed) return rerender(v, { form: "Too many submissions from your network. Please wait an hour or email us directly." }, 429);

  // Claimed only after validation passed, atomically: a duplicate never creates a second lead. A duplicate reports
  // success only once the first submission's lead is actually saved; while it is still being saved it waits briefly,
  // and otherwise says so neutrally (never "received" for a lead that may not exist).
  const okText = kind === "quote" ? "Thank you — your quote request was received." : "Thank you — your message was received.";
  const sub = liveSubmission(v.submission);
  if (sub) {
    const claim = await ctx.db.prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count`)
      .bind(`leadsub:${sub.key}`, sub.issued).first<{ count: number }>();
    if ((claim?.count ?? 1) > 1) {
      const saved = () => ctx.db.prepare(`SELECT 1 AS ok FROM rate_limits WHERE key = ? AND window_start = ?`).bind(`leadsaved:${sub.key}`, sub.issued).first<{ ok: number }>();
      for (let i = 0; i < 24 && !(await saved()); i++) await new Promise((r) => setTimeout(r, 250));
      if (await saved()) return redirect(ctx, thanks, { kind: "success", text: okText });
      return rerender(v, { form: "This message is already being sent. Please wait a minute and check your email before sending it again." }, 409);
    }
  } else v.submission = "";
  const service = v.service ? serviceBySlug(v.service) : undefined;
  const details = kind === "quote"
    ? [`Service: ${service?.name ?? "Not sure yet"}`, `Budget range: ${v.budget}`, `Timeline: ${v.timeline}`, "", v.message].join("\n")
    : v.message;
  let leadId: string | undefined;
  try {
    ({ leadId } = await captureLead(ctx.db, {
      name: v.name, email: v.email, phone: v.phone || undefined, company: v.company || undefined, website: v.website || undefined,
      interest: v.interest, message: details, source: kind === "quote" ? "quote_form" : "web_form",
    }, { ip: ctx.ip ?? undefined, attribution: submittedAttribution(ctx, f) }));
    // From here the lead exists: mark the token saved so duplicates report success and the token is never released.
    if (sub) await ctx.db.prepare(`INSERT OR IGNORE INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)`).bind(`leadsaved:${sub.key}`, sub.issued).run();
    if (kind === "quote") {
      // The lead's message already carries service, budget and timeline; the structured row is an index, so a failure
      // here is logged rather than reported to the visitor as "not saved" (which would invite a duplicate lead).
      try {
        await ctx.db.prepare(`INSERT INTO lead_request_details (lead_id, service_slug, budget_range, timeline, created_at) VALUES (?,?,?,?,?)`)
          .bind(leadId, service?.slug ?? null, v.budget, v.timeline, nowIso()).run();
      } catch (err) {
        console.error(JSON.stringify({ level: "error", msg: "lead request details not saved", leadId, error: (err as Error).message }));
      }
    }
    try {
      await sendMail(ctx, { template: "lead_received", to: v.email.toLowerCase(), idempotencyKey: `lead-ack:${leadId}`, data: { name: v.name, kind: kind === "quote" ? "quote" : "contact" } });
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", msg: "lead acknowledgement email failed", leadId, error: (err as Error).message }));
    }
    // CREST-GAP-005: Crestmont staff are told about the lead (in-app + one staff email, idempotent per lead).
    try { await notifyNewLead(ctx, leadId, kind); }
    catch (err) { console.error(JSON.stringify({ level: "error", msg: "staff lead notification failed", leadId, error: (err as Error).message })); }
  } catch (err) {
    // The lead was not saved: release the one-time token so the visitor can resubmit, and never report success.
    if (sub && !leadId) await ctx.db.prepare(`DELETE FROM rate_limits WHERE key = ? AND window_start = ?`).bind(`leadsub:${sub.key}`, sub.issued).run().catch(() => undefined);
    if (err instanceof ValidationError) return rerender(v, { form: err.issues.join(". ") }, 422);
    throw err;
  }
  return redirect(ctx, thanks, { kind: "success", text: okText });
}

// ───────────────────────── public routes ─────────────────────────

export function register(r: Router): void {
  r.get("/", (ctx) => page(ctx, "home", ["home.hero", "home.why", "home.capabilities", "home.experience", "home.cta", "process.page", "faq.items", "pricing.presentation", "portfolio.intro", "services.overview", ...serviceKeys()], async (c) => {
    const hero = c.get("home.hero"), why = c.get("home.why"), caps = c.get("home.capabilities"), exp = c.get("home.experience"), cta = c.get("home.cta");
    const pp = c.get("process.page");
    const steps = parseItems(pp.steps);
    const whyItems = parseItems(why.items);
    const faqs = parseItems(c.get("faq.items").items).slice(0, 5);
    const projects = await pf.listPublished(ctx.db);
    const featured = ["website-design-development", "website-redesign", "e-commerce-development", "custom-web-applications", "technical-seo", "ai-automation"].map((s) => serviceBySlug(s)!);
    const email = ctx.settings["contact.email"] ?? SUPPORT_EMAIL;
    const pr = c.get("pricing.presentation");
    return html`<section class="hero hero--home"><div class="container">
<div class="hero__top"><div><p class="eyebrow">${hero.eyebrow}</p><h1 class="hero-title">${hero.heading}</h1></div>
<a class="hero__panel on-dark hero-seq" style="--seq:0" href="/pricing"><span class="hero__panel-head"><span>Published packages</span><span>From</span></span>
<span class="hero__panel-price">${pkgPrice("starter")}</span><span class="hero__panel-note">Package prices are published and enforced at checkout.</span><span class="btn__arrow" aria-hidden="true">${ARROW_SVG}</span><span class="visually-hidden">View pricing</span></a></div>
<div class="hero__body"><div class="hero__art hero-seq hero-seq--art" style="--seq:0"><img src="/assets/art/hero-build.webp" width="960" height="960" alt="" fetchpriority="high" decoding="async"></div>
<div class="hero__copy"><p class="lede hero-seq" style="--seq:1">${hero.lede}</p>
<div class="hero__actions hero-seq" style="--seq:2">${ctaLink(hero.primary_label, "/pricing", "primary")}${ctaLink(hero.quote_label, "/quote", "secondary")}</div>
<ul class="hero__facts hero-seq" style="--seq:3" aria-label="Commitments">
<li><strong>Counted revisions</strong><span>Every round is recorded in your project</span></li>
<li><strong>Your approval first</strong><span>Nothing launches until you sign off</span></li>
<li><strong>Yours to keep</strong><span>Your domain stays registered to you</span></li>
<li><strong>Written scope</strong><span>Custom work is quoted in writing</span></li></ul></div></div></div></section>
<section class="statement statement--pinned" id="principles" data-statement aria-labelledby="principles-title"><div class="statement__stage"><div>
<h2 class="statement__text scroll-words" id="principles-title">Published prices. Counted revisions. Nothing goes live without your approval.</h2>
<ul class="statement__labels">${whyItems.slice(0, 4).map((w) => html`<li class="statement__label">${w.title}</li>`)}</ul></div></div></section>
${section("Our services", "What we build", html`${serviceBento(featured, c)}<p class="section__more"><a href="/services">All services</a></p>`, { id: "services", lede: c.get("services.overview").lede })}
${section("New · AI Receptionist", "AI voice agents, configured for your calls", html`<div class="rc-home"><div class="rc-home__copy" data-reveal-group>
<p class="lede" data-reveal>Custom AI voice agents, built for your business on the voice provider you choose. They can answer questions from your approved information, collect caller details and requests, and pass urgent calls to your team under your rules — each one scoped and quoted in writing.</p>
<ul class="rc-home__points" data-reveal>${["A custom configuration for each client, on the provider you choose", "Answers questions and collects caller details and requests", "Optional calendar, CRM and website connections within the written scope", "Identifies itself as AI; a person is always one step away"].map((x) => html`<li>${x}</li>`)}</ul>
<div class="hero__actions" data-reveal>${ctaLink("Explore AI Receptionist", "/services/ai-receptionist", "primary")}${ctaLink("Request a quote", "/quote?service=ai-receptionist", "secondary")}</div></div>
<div class="rc-home__demo" data-reveal style="--rd:140ms">${receptionistConsole({ compact: true, id: "rc-home" })}</div></div>`, { id: "ai-receptionist" })}
${section("Latest work", c.get("portfolio.intro").heading === "Portfolio" ? "Real websites" : c.get("portfolio.intro").heading, projects.length ? html`${portfolioExplorer(ctx, projects, { variant: "home" })}<p class="section__more"><a href="/portfolio">View the portfolio</a></p>`
      : html`<div class="showcase__pending on-dark" data-reveal><div><h3>Portfolio in preparation</h3><p>Portfolio projects are published here once genuine screenshots of each live site have been captured and verified. We do not use mock-ups or stock imagery.</p></div>${ctaLink("About our portfolio", "/portfolio", "primary")}</div>`, { id: "portfolio" })}
${section("Our approach", pp.heading, html`${processStages(steps)}<p class="section__more"><a href="/process">The full process</a></p>`, { id: "process", lede: pp.lede })}
${section("How it comes together", "Anatomy of a build", anatomy(), { id: "anatomy", lede: "A website is a stack of decisions. Choose a layer to see what changes, and which stage of our process is responsible for it." })}
<section class="section" id="why"><div class="container"><p class="section__label" style="display:flex;justify-content:center">${why.heading}</p>
<h2 class="statement-lg reveal-words" data-reveal>What you can hold us to.</h2>
<div class="versus" data-reveal-group><div class="versus__panel on-dark" data-reveal><p class="versus__title"><span class="brand__tile" aria-hidden="true"><img class="brand__mark" src="/assets/brand/crestmont-crest.png" width="42" height="41" alt=""></span>Working with Crestmont</p>
<ul class="versus__list">${whyItems.map((w) => html`<li><span><strong>${w.title}</strong><span>${w.body}</span></span></li>`)}</ul></div>
<div class="versus__panel versus__panel--not reveal--slide" data-reveal style="--rd:160ms"><p class="versus__title">What we will not do</p><ul class="versus__list">${WILL_NOT.map((x) => html`<li><span>${x}</span></li>`)}</ul></div></div></div></section>
${section("Capabilities", caps.heading, ledger(caps.items), { id: "capabilities" })}
<section class="section section--band" id="packages"><div class="container"><p class="section__label">Packages</p>
<div class="plans__head"><h2 class="reveal-words" data-reveal>Choose your package</h2>
<div class="switch" data-switch hidden><button class="switch__btn" type="button" data-switch-to="plans-packages">Website packages</button><button class="switch__btn" type="button" data-switch-to="maintenance">Monthly care</button><span class="switch__pill" aria-hidden="true"></span></div></div>
<p class="lede" style="margin:-1rem 0 2.5rem">${pr.lede}</p>
<div class="plans" data-plans><div class="plans__set" id="plans-packages"><h3 class="plans__set-title">Website packages</h3>${packageCards(c, { compact: true })}<p class="section__more"><a href="/pricing">Full package details</a><a href="/pricing/compare">Compare packages</a><a href="/quote">Custom development quote</a></p></div>
<div class="plans__set" id="maintenance"><h3 class="plans__set-title">Optional maintenance plans</h3>${maintenanceCards()}<p class="section__more"><a href="/hosting-maintenance">Hosting &amp; maintenance</a></p></div></div></div></section>
${section("Customer portal", exp.heading, itemCards(exp.items), { id: "experience", lede: exp.lede })}
<section class="section" id="faq"><div class="container faq"><div class="faq__aside"><p class="section__label">FAQs</p><h2 class="faq__title reveal-words" data-reveal>Frequently asked questions</h2>
<p data-reveal style="--rd:120ms">Another question? <a href="/contact">Contact us</a> or read <a href="/faq">all questions</a>.</p></div>
<div data-reveal>${faqs.map((q) => html`<details class="disclosure"><summary>${q.title}</summary><div class="disclosure__body"><p>${q.body}</p></div></details>`)}</div></div></section>
<section class="section" id="contact" style="padding-bottom:0"><div class="cta-band on-dark"><div class="container cta-band__grid"><div class="cta-band__copy" data-reveal-group>
<div class="cta-band__art" data-reveal aria-hidden="true"><img src="/assets/art/stage-design.webp" width="720" height="720" alt="" loading="lazy" decoding="async"></div>
<p class="section__label" data-reveal>Contact</p><h2 class="reveal-words" data-reveal>${cta.heading}</h2><p class="lede" data-reveal>${cta.body}</p>
<div class="hero__actions" data-reveal>${ctaLink("Request a custom quote", "/quote", "primary")}${ctaLink("Contact page", "/contact", "secondary")}</div>
<p class="cta-band__contact" data-reveal>Prefer email? Write to <a href="mailto:${email}">${email}</a>.</p></div>
<div class="card" data-reveal style="--rd:160ms">${contactForm(ctx, { interest: "other" }, {}, { compact: true })}</div></div></div></section>`;
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
    // CREST-GAP-046: each service page has its own title (the service name) and description (its summary, which the
    // CMS can override per service through `service.<slug>`).
    const serviceMeta = (c: Content) => ({ title: s.name, description: metaDescription(c.get(`service.${s.slug}`).summary || s.summary) });
    return page(ctx, "services", [`service.${s.slug}`, "pricing.presentation"], (c) => {
      const copy = c.get(`service.${s.slug}`);
      if (s.slug === "ai-receptionist") return aiReceptionistPage(s, copy, ctx.settings["contact.email"] ?? SUPPORT_EMAIL);
      const related = SERVICES.filter((x) => x.group === s.group && x.slug !== s.slug).slice(0, 3);
      return html`${serviceHero(s.group, s.name, copy.summary, html`${s.pricing === "custom" ? linkButton("Request a quote", `/quote?service=${s.slug}`) : linkButton("View packages", "/pricing")}${linkButton(s.pricing === "custom" ? "Contact us" : "Request a quote", s.pricing === "custom" ? "/contact" : `/quote?service=${s.slug}`, "secondary")}`, serviceVisual(s.slug))}
<section class="section"><div class="container grid grid-2"><div class="prose">${renderMarkdown(copy.intro)}
<h2>How it is priced</h2><p>${PRICING_NOTE[s.pricing]}</p>${s.pricing !== "custom" ? html`<p class="muted">Packages: ${PKG_ORDER.map((id) => `${PACKAGES[id].name} ${pkgPrice(id)}`).join(" · ")}.</p>` : html`<p class="muted">Custom projects are billed 50% as a deposit, 25% after the approved design milestone and 25% before production launch.</p>`}</div>
<div>${s.includes.length ? html`<div class="card"><h3 class="card__title">What is included</h3><ul class="checklist">${s.includes.map((i) => html`<li>${i}</li>`)}</ul></div>` : ""}
${s.boundaries.length ? html`<div class="card card--quiet"><h3 class="card__title">Good to know</h3><ul class="plain-list">${s.boundaries.map((i) => html`<li>${i}</li>`)}</ul></div>` : ""}</div></div></section>
${related.length ? section("Related", "Related services", serviceList(related)) : ""}`;
    }, 200, serviceMeta);
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
    // One row per capability from the catalogue's structured feature model (the same data behind checkout, contract scope,
    // proposals and build briefs). Packages are cumulative, so a higher tier never shows a dash where a lower tier is included.
    const top = (fid: string) => PACKAGE_FEATURES.find((f) => f.id === fid)!;
    const uniform = (f: (typeof PACKAGE_FEATURES)[number]) => new Set(PKG_ORDER.map((id) => f.levels[id]).filter(Boolean)).size === 1;
    const cell = (f: (typeof PACKAGE_FEATURES)[number], id: PackageId) => {
      const v = f.levels[id];
      if (!v) return html`<td class="compare__no"><span aria-hidden="true">—</span><span class="visually-hidden">Not included in ${PACKAGES[id].name}</span></td>`;
      if (uniform(f)) return html`<td class="compare__yes"><span class="compare__tick" aria-hidden="true"></span><span class="visually-hidden">Included in ${PACKAGES[id].name}</span></td>`;
      return html`<td class="compare__scope"><span class="compare__tick compare__tick--sm" aria-hidden="true"></span><span class="visually-hidden">Included in ${PACKAGES[id].name}: </span>${v}</td>`;
    };
    const groups: [string, string[]][] = [
      ["Scope", ["pages", "revisions"]],
      ["Design and content", ["responsive", "design", "layouts", "content", "copy", "imagery"]],
      ["Functionality", ["forms", "integrations"]],
      ["Search, measurement and speed", ["seo", "analytics", "performance"]],
      ["Delivery", ["approval", "launch"]],
    ];
    const head = html`<thead><tr><th scope="col" class="compare__corner"><span class="visually-hidden">Capability</span></th>${PKG_ORDER.map((id) => html`<th scope="col" class="compare__pkg${id === "premium" ? " compare__pkg--premium" : ""}">${id === "premium" ? html`<span class="compare__badge">Most complete</span>` : ""}<span class="compare__name">${PACKAGES[id].name}</span><span class="compare__price">${pkgPrice(id)}</span></th>`)}</tr></thead>`;
    return html`${pageHero("Pricing", "Compare packages", "Each package includes everything in the one before it, at the same or a larger scope. Every row comes from the same server-side catalogue that checkout and your written scope use.")}
<section class="section section--flush"><div class="container"><div class="compare-wrap"><table class="table compare" data-compare><caption class="visually-hidden">Website package comparison. Each package includes everything in the package before it.</caption>
${head}
${groups.map(([g, ids]) => html`<tbody><tr class="compare__group"><th scope="rowgroup" colspan="4">${g}</th></tr>
${ids.map((fid) => { const f = top(fid); return html`<tr><th scope="row"><span class="compare__label">${f.label}</span><button type="button" class="toggletip" aria-expanded="false" aria-controls="tip-${f.id}"><span class="visually-hidden">About ${f.label}</span><span aria-hidden="true">i</span></button><span class="toggletip__text" id="tip-${f.id}" role="note">${f.note}</span></th>${PKG_ORDER.map((id) => cell(f, id))}</tr>`; })}</tbody>`)}
<tbody><tr class="compare__group"><th scope="rowgroup" colspan="4">Payment</th></tr>
<tr><th scope="row"><span class="compare__label">Price</span></th>${PKG_ORDER.map((id) => html`<td class="compare__scope"><strong>${pkgPrice(id)}</strong>${PACKAGES[id].priceIsFloor ? html`<span class="compare__sub">final price in your written scope</span>` : ""}</td>`)}</tr>
<tr><th scope="row"><span class="compare__label">Payment</span></th>${PKG_ORDER.map(() => html`<td class="compare__scope">100% upfront</td>`)}</tr>
<tr class="compare__actions"><th scope="row"><span class="visually-hidden">Choose a package</span></th>${PKG_ORDER.map((id) => html`<td>${linkButton(`Choose ${PACKAGES[id].name}`, packageCta(id), id === "premium" ? "primary" : "secondary", "sm")}</td>`)}</tr></tbody>
</table></div>
<p class="muted compare__foot">A gold check means the item is included at the same scope in that package; where the scope grows, the package's own wording is shown. Need more than Premium? <a href="/quote?package=custom">Request a custom quote</a>.</p></div></section>`;
  }));

  r.get("/portfolio", (ctx) => page(ctx, "portfolio", ["portfolio.intro"], async (c) => {
    const intro = c.get("portfolio.intro");
    const projects = await pf.listPublished(ctx.db);
    return html`${pageHero("Portfolio", intro.heading, intro.lede)}
<section class="section section--flush"><div class="container">${projects.length ? html`${portfolioExplorer(ctx, projects, { variant: "portfolio" })}
<div class="pf-index"><h2 class="pf-index__title">Case studies</h2><ul class="index-list">${projects.map((x) => html`<li class="pf-index__item"><a href="/portfolio/${x.slug}"><span class="index-list__name">${x.name}</span><span class="index-list__summary">${x.industry}</span><span class="index-list__arrow" aria-hidden="true">→</span></a><a class="pf-index__live" href="${safeUrl(x.live_url)}" target="_blank" rel="noopener noreferrer">Visit live website<span class="visually-hidden">: ${x.name} (opens in a new tab)</span></a></li>`)}</ul></div>`
      : emptyState("Portfolio projects are being prepared", "Projects appear here once genuine desktop and mobile screenshots of each live website have been captured and verified, and the project's relationship to Crestmont is documented. We never substitute mock-ups or stock imagery.", html`<a class="btn btn--secondary" href="/contact">Ask us about our work</a>`)}</div></section>`;
  }));

  r.get("/portfolio/:slug", async (ctx, p) => {
    const proj = await pf.getBySlug(ctx.db, p.slug);
    if (!proj || !proj.published) throw new HttpError(404, "That portfolio project is not available.");
    const tms = await pf.publishedTestimonials(ctx.db, proj.id);
    return htmlResponse(ctx, publicLayout(ctx, { title: `${proj.name} — case study`, description: metaDescription(proj.description) }, html`
${pageHero(proj.industry, proj.name, undefined, html`<a class="btn btn--primary" href="${safeUrl(proj.live_url)}" rel="noopener noreferrer" target="_blank">Visit live website</a>${linkButton("All projects", "/portfolio", "ghost")}`)}
<section class="section section--flush"><div class="container">${portfolioExplorer(ctx, [proj], { variant: "case", headingLevel: 2 })}</div></section>
<section class="section section--flush"><div class="container case-shots"><figure>${shot(proj, "desktop", true)}<figcaption class="faint">Desktop${proj.desktop_screenshot_file_id ? (proj.screenshot_captured_at ? ` · captured ${formatDate(proj.screenshot_captured_at)}` : "") : " · demonstration build with sample data"}</figcaption></figure>
<figure>${shot(proj, "mobile", true)}<figcaption class="faint">Mobile${proj.mobile_screenshot_file_id ? "" : " · demonstration build"}</figcaption></figure></div></section>
<section class="section"><div class="container grid grid-2"><div class="prose"><h2>About the project</h2>${paragraphs(proj.description).map((x) => html`<p>${x}</p>`)}
${proj.technology_summary ? html`<h3>Technology</h3><p>${proj.technology_summary}</p>` : ""}<p class="faint">${proj.relationship}</p></div>
<div class="card"><h3 class="card__title">Verified features</h3><ul class="checklist">${pf.features(proj).map((f) => html`<li>${f}</li>`)}</ul>
${dl([["Industry", proj.industry], ["Live site", html`<a href="${safeUrl(proj.live_url)}" rel="noopener noreferrer" target="_blank">${proj.live_url.replace(/^https?:\/\//, "")}</a>`], ["Link verified", formatDate(proj.link_verified_at)]])}</div></div></section>
${tms.length ? section("Testimonials", "What they said", html`<div class="grid grid-2">${tms.map((t) => html`<blockquote class="card testimonial"><p>“${t.body}”</p><footer class="faint">— ${t.author_name}</footer></blockquote>`)}</div>`) : ""}
<dialog id="viewer" class="viewer" aria-label="Screenshot viewer"><img alt=""><form method="dialog"><button class="btn btn--secondary btn--sm" type="submit" data-close>Close</button></form></dialog>`));
  });

  // Public screenshot bytes: ONLY files that are the current screenshot of a published project.
  r.get("/portfolio-media/:fileId", async (ctx, p) => {
    if (!(await pf.isPublicPortfolioFile(ctx.db, p.fileId))) throw new HttpError(404, "Not found");
    return serveImage(ctx, p.fileId, "public, max-age=3600");
  });

  // About (docs/frontend/ABOUT.md): the CMS heading, lede and body stay the source of truth; the page adds interactive
  // views built only from the service catalogue and the CMS process steps, and leads into the footer's CRESTMONT wordmark.
  r.get("/about", (ctx) => page(ctx, "about", ["about.page", "process.page"], (c) => {
    const a = c.get("about.page");
    const steps = parseItems(c.get("process.page").steps);
    const chapters = a.body.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
    return html`<section class="hero hero--page hero--about"><div class="container about-hero"><div class="about-hero__copy">
<div class="eyebrow">About</div><h1 class="hero-title about__title">${a.heading}</h1>${a.lede ? html`<p class="lede hero-seq" style="--seq:0">${a.lede}</p>` : ""}
<div class="row hero-seq" style="--seq:1">${linkButton("How a project runs", "/process")}${linkButton("Our services", "/services", "secondary")}</div></div>
<div class="about-hero__art hero-seq hero-seq--art" style="--seq:0" aria-hidden="true"><img src="/assets/art/stage-launch.webp" width="720" height="720" alt="" decoding="async"></div></div></section>
<section class="statement statement--pinned" id="about-principles" data-statement aria-labelledby="about-principles-title"><div class="statement__stage"><div>
<h2 class="statement__text scroll-words" id="about-principles-title">Published prices. Counted revisions. Nothing goes live without your approval.</h2></div></div></section>
${section("How we work", "Principles, in practice", html`<ol class="chapters" data-reveal-group>${chapters.map((ch, i) => html`<li class="chapter" data-reveal><span class="chapter__n" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span><div class="chapter__body prose">${renderMarkdown(ch)}</div></li>`)}</ol>`, { id: "principles" })}
${section("Capabilities", "One team, connected disciplines", html`<div data-reveal>${constellation()}</div>`, { id: "capabilities", lede: "Design, development, integrations, AI, search and ongoing care are planned together, so each part supports the others." })}
${section("The journey", "From first conversation to launch", html`<div data-reveal>${journey(steps)}</div><p class="section__more"><a href="/process">The full process</a></p>`, { id: "journey", lede: "Every project follows the same recorded path. Step through it to see what happens at each stage." })}
${section("Craft", "Quality you can check", html`<div data-reveal>${qualityLab()}</div>`, { id: "craft", lede: "Responsive layouts, accessibility, consistency and maintainability are built in from the start — try them on a live miniature." })}
<section class="section" id="commitments"><div class="container"><p class="section__label">Commitments</p>
<div class="versus" data-reveal-group><div class="versus__panel on-dark" data-reveal><p class="versus__title"><span class="brand__tile" aria-hidden="true"><img class="brand__mark" src="/assets/brand/crestmont-crest.png" width="42" height="41" alt=""></span>What you can hold us to</p>
<ul class="versus__list">${["A written scope and published prices before work starts", "Every revision round counted and recorded", "Your approval before anything goes live", "Your domain registered to you", "People decide scope, price, refunds, contracts and releases"].map((x) => html`<li><span>${x}</span></li>`)}</ul></div>
<div class="versus__panel versus__panel--not reveal--slide" data-reveal style="--rd:160ms"><p class="versus__title">What we will not do</p><ul class="versus__list">${WILL_NOT.map((x) => html`<li><span>${x}</span></li>`)}</ul></div></div>
<p class="section__more"><a href="/legal/disclosures">Business disclosures</a></p></div></section>
<section class="section about-close" data-about-close><div class="container"><p class="section__label">Next</p><h2 class="about-close__title reveal-words" data-reveal>Start with a conversation.</h2>
<p class="lede" data-reveal style="--rd:120ms">Tell us what you need. We'll answer plainly, scope it in writing and show you the price before anything begins.</p>
<div class="hero__actions" data-reveal style="--rd:200ms">${ctaLink("Request a quote", "/quote", "primary")}${ctaLink("Contact us", "/contact", "secondary")}</div></div></section>`;
  }));

  r.get("/process", (ctx) => page(ctx, "process", ["process.page"], (c) => {
    const pp = c.get("process.page");
    return html`${pageHero("Process", pp.heading, pp.lede)}<section class="section section--flush"><div class="container">${processStages(parseItems(pp.steps))}
<div class="row section__more">${ctaLink("View packages", "/pricing", "primary")}${ctaLink("Request a quote", "/quote", "secondary")}<a href="/legal/development-agreement">Development agreement information</a></div></div></section>`;
  }));

  r.get("/faq", (ctx) => page(ctx, "faq", ["faq.items"], (c) => html`${pageHero("FAQs", "Frequently asked questions")}<section class="section section--flush"><div class="container prose-wide">
${parseItems(c.get("faq.items").items).map((q) => html`<details class="disclosure"><summary>${q.title}</summary><p>${q.body}</p></details>`)}
<p class="section__more">Another question? <a href="/contact">Contact us</a>.</p></div></section>`));

  r.get("/hosting-maintenance", (ctx) => page(ctx, "hosting", ["hosting.page"], (c) => {
    const h = c.get("hosting.page");
    return html`${serviceHero("Ongoing care", h.heading, h.lede, html`${linkButton("Ask about maintenance", "/contact?topic=maintenance")}`, serviceVisual("hosting-maintenance"))}
<section class="section section--flush"><div class="container">${maintenanceCards()}</div></section>
${section("Ownership", "Your site, your choice", html`<ul class="plain-list"><li>Maintenance plans are optional. Your domain always remains registered to you.</li><li>You can use your own domain registrar or agency-managed DNS services.</li>${plansApproved() ? html`<li>Plans renew monthly by automatic billing, with self-service payment management in your customer portal; see the <a href="/legal/cancellation">cancellation policy</a>.</li>` : ""}<li>Support tickets can be submitted at any time; see the <a href="/legal/support">support policy</a> for staffed hours.</li></ul>`)}`;
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
${d.slug === "privacy" ? html`<p class="legal-account-link" data-privacy-self-service><strong>Signed in?</strong> Download or delete your data at <a href="/account/privacy">/account/privacy</a>.</p>` : ""}
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

/** Topic → the workspace element that responds to it (decorative; aria-hidden). */
const TOPIC_GLYPH: Record<string, string> = { starter: "site", business: "site", premium: "site", custom: "code", maintenance: "care", other: "chat" };

/** Contact (docs/frontend/CONTACT.md): the same intake contract as before — fields, names, validation, CRM lead,
 *  acknowledgement email and thank-you redirect — presented as a centred, premium form inside a responsive workspace. */
function contactFormPremium(ctx: AppContext, v: FormVals, e: FieldErrors): SafeHtml {
  const topic = v.interest || "other";
  return html`${formErrors(Object.values(e))}<form method="post" action="/contact" class="lead-form cx-form" novalidate data-cx-form>${csrf(ctx)}${honeypot()}${submissionField(v)}${attributionFields(requestAttribution(ctx))}
<div class="cx-progress" aria-hidden="true"><span class="cx-progress__bar" data-cx-bar></span></div>
<p class="cx-progress__text" data-cx-progress aria-live="polite"></p>
<fieldset class="cx-step"><legend class="cx-step__title"><span class="cx-step__n">01</span> About you</legend>${contactFields(v, e)}</fieldset>
<fieldset class="cx-step cx-topics${e.interest ? " has-error" : ""}"${e.interest ? html` aria-describedby="f-interest-err"` : ""}><legend class="cx-step__title"><span class="cx-step__n">02</span> What is it about? <span aria-hidden="true" class="faint">*</span></legend>
<div class="cx-chips">${INTERESTS.map((i) => html`<label class="cx-chip"><input type="radio" name="interest" value="${i.value}"${i.value === topic ? html` checked` : ""} required data-cx-topic="${TOPIC_GLYPH[i.value] ?? "chat"}"><span>${i.label}</span></label>`)}</div>
${e.interest ? html`<span class="error-text" id="f-interest-err" role="alert">${e.interest}</span>` : ""}</fieldset>
<fieldset class="cx-step"><legend class="cx-step__title"><span class="cx-step__n">03</span> Your message</legend>
${textarea({ name: "message", label: "Message", value: v.message, rows: 6, required: true, maxlength: 4000, error: e.message, hint: "At least 10 characters. Please don't include passwords or payment details." })}
<p class="cx-count" aria-hidden="true"><span data-cx-count>${String(v.message?.length ?? 0)}</span> / 4000</p></fieldset>
${turnstileWidget(ctx)}
<div class="cx-submit"><button type="submit" class="btn btn--primary cx-send" data-cx-send><span class="cx-send__label">Send message</span><span class="cx-send__spin" aria-hidden="true"></span></button>
<p class="faint form-note">We reply by email. See our <a href="/legal/privacy">privacy policy</a>.</p></div></form>`;
}

function renderContact(ctx: AppContext, v: FormVals, e: FieldErrors, status: number) {
  return page(ctx, "contact", ["contact.page"], (c) => {
    const cp = c.get("contact.page");
    // CREST-GAP-049: the line appears only once real staffed hours are set (Owner → business settings).
    const hours = ctx.settings["support.staffed_hours"]?.trim() || null;
    const email = ctx.settings["contact.email"] ?? SUPPORT_EMAIL;
    const channel = (title: string, addr: string, note: string) => html`<a class="cx-channel" href="mailto:${addr}" data-reveal><span class="cx-channel__title">${title}</span><span class="cx-channel__addr">${addr}</span><span class="cx-channel__note">${note}</span><span class="cx-channel__go" aria-hidden="true">${ARROW_SVG}</span></a>`;
    return html`<section class="hero hero--page hero--contact"><div class="container cx-hero"><div class="eyebrow">Contact</div><h1 class="hero-title">${cp.heading}</h1>${cp.lede ? html`<p class="lede hero-seq" style="--seq:0">${cp.lede}</p>` : ""}</div></section>
<section class="section section--flush cx-section"><div class="container">
<div class="cx" data-cx data-topic="${TOPIC_GLYPH[v.interest || "other"] ?? "chat"}">
<div class="cx-ws" aria-hidden="true">
<span class="cx-ws__item cx-ws__item--site" data-glyph="site"><i></i><i></i><i></i><b></b></span>
<span class="cx-ws__item cx-ws__item--code" data-glyph="code"><em>&lt;/&gt;</em><i></i><i></i></span>
<span class="cx-ws__item cx-ws__item--care" data-glyph="care"><em>✓</em><i></i></span>
<span class="cx-ws__item cx-ws__item--chat" data-glyph="chat"><i></i><i></i></span>
<span class="cx-ws__orb cx-ws__orb--a"></span><span class="cx-ws__orb cx-ws__orb--b"></span><span class="cx-ws__ring" data-cx-ring></span>
</div>
<div class="cx-card on-dark">${contactFormPremium(ctx, v, e)}</div>
</div>
<div class="cx-channels" data-reveal-group>
${channel("General & support", email, "Questions, existing projects and anything else")}
${channel("Sales", SALES_EMAIL, "Packages, quotes and new projects")}
${channel("Billing", BILLING_EMAIL, "Invoices and payments")}
</div>
<div class="cx-more" data-reveal>${hours ? html`<p><strong>Staffed hours:</strong> ${hours}.</p>` : ""}<p>Existing customers can open support tickets any time in the <a href="/login">customer portal</a>. Planning a project? The <a href="/quote">custom quote form</a> collects the details we need.</p></div>
</div></section>`;
  }, status);
}

/** CREST-GAP-097: the confirmation is shown only on the redirect that follows a saved submission (the one-time success
 *  flash set by handleLead). A direct visit, a reload or a bookmark gets neutral text that confirms nothing. */
function thanksPage(ctx: AppContext, title: string, body: string) {
  if (ctx.flash?.kind !== "success") {
    const quote = ctx.url.pathname.startsWith("/quote");
    return htmlResponse(ctx, publicLayout(ctx, { title: quote ? "Request a quote" : "Contact", noindex: true }, html`<section class="hero hero--page hero--thanks"><div class="container cx-thanks">
<div class="eyebrow">${quote ? "Custom quote" : "Contact"}</div><h1>${quote ? "Request a custom quote" : "Send us a message"}</h1>
<p class="lede">This page confirms a ${quote ? "quote request" : "message"} right after it is sent. If you have already sent one, we will reply by email; otherwise, use the form to send it.</p>
<div class="row">${linkButton(quote ? "Request a quote" : "Contact us", quote ? "/quote" : "/contact")}${linkButton("Return home", "/", "secondary")}</div></div></section>`));
  }
  return htmlResponse(ctx, publicLayout(ctx, { title, noindex: true }, html`<section class="hero hero--page hero--thanks"><div class="container cx-thanks">
<svg class="cx-check" viewBox="0 0 64 64" width="72" height="72" aria-hidden="true"><circle cx="32" cy="32" r="29" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19 33l9 9 17-19" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
<div class="eyebrow">Received</div><h1>${title}</h1><p class="lede">${body}</p>
<ol class="cx-next"><li><strong>Recorded</strong><span>Your message is saved with our team.</span></li><li><strong>Read by a person</strong><span>Someone from Crestmont reviews it.</span></li><li><strong>Reply by email</strong><span>We answer at the address you gave.</span></li></ol>
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
  action("demo", async (ctx, id, f) => {
    await pf.setDemo(ctx.db, ctx.actor!, id, { demo_url: str(f, "demo_url"), demo_status: str(f, "demo_status"), demo_revision: str(f, "demo_revision"), verified_on: str(f, "demo_verified_on"),
      poster_desktop_asset: str(f, "poster_desktop_asset"), poster_mobile_asset: str(f, "poster_mobile_asset"), poster_tablet_asset: str(f, "poster_tablet_asset") }, pf.approvedDemoOrigins(ctx.env.PORTFOLIO_DEMO_ORIGINS, { allowLocal: pf.allowLocalDemos(ctx.env.ENVIRONMENT) }), ctx.ip);
    return "Interactive demo settings saved.";
  });
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
  { header: "Interactive demo", cell: (p) => { const d = pf.demoState(p, pf.approvedDemoOrigins(ctx.env.PORTFOLIO_DEMO_ORIGINS, { allowLocal: pf.allowLocalDemos(ctx.env.ENVIRONMENT) })); return d.kind === "embed" ? badge("ok", "Embedded") : d.kind === "unavailable" ? badge("blocked", "Unavailable") : badge("draft", "None"); } },
  { header: "Ready to publish", cell: (p) => { const b = pf.publishBlockers(p); return b.length ? html`${badge("blocked", `${b.length} blocker${b.length > 1 ? "s" : ""}`)}` : badge("ok", "Ready"); } },
  { header: "Order", cell: (p) => html`${actionForm(ctx, `/staff/portfolio/${p.id}/move`, "Up", { hidden: { dir: "up" } })} ${actionForm(ctx, `/staff/portfolio/${p.id}/move`, "Down", { hidden: { dir: "down" } })}` },
], { empty: emptyState("No portfolio projects", "Add a project below."), caption: "Portfolio projects" })}
<h2 class="h4">Add a project</h2>${projectForm(ctx, "/staff/portfolio", { relationship: "Relationship documentation pending", ...v }, "Add project", errors)}`, status);
}

/** Interactive demo settings (PORTFOLIO.md): isolated demo deployment, its verification and bundled posters. */
function demoAdmin(ctx: AppContext, p: pf.PortfolioProject): SafeHtml {
  const approved = pf.approvedDemoOrigins(ctx.env.PORTFOLIO_DEMO_ORIGINS, { allowLocal: pf.allowLocalDemos(ctx.env.ENVIRONMENT) });
  const st = pf.demoState(p, approved);
  return html`<div class="card"><h3 class="card__title">Interactive demo</h3>
<p class="muted">The portfolio explorer embeds an isolated demonstration deployment of this website — never the production site. Only origins on the approved list for this environment can be embedded.</p>
${dl([["Explorer shows", st.kind === "embed" ? "The interactive demo" : st.kind === "unavailable" ? `Screenshot — ${st.reason}` : "Screenshot only"],
  ["Approved demo origins", approved.size ? [...approved].join(", ") : "None configured (PORTFOLIO_DEMO_ORIGINS)"],
  ["Last verified", p.demo_verified_at ? formatDate(p.demo_verified_at) : "Not verified"], ["Source revision", p.demo_revision ?? "—"]])}
<form method="post" action="/staff/portfolio/${p.id}/demo">${csrf(ctx)}
${input({ name: "demo_url", label: "Demo link (isolated demonstration deployment)", type: "url", value: p.demo_url, hint: "Must be on an approved demo origin and must not be the production website." })}
${select({ name: "demo_status", label: "Demo status", value: p.demo_status, options: [{ value: "none", label: "None — show the screenshot" }, { value: "ready", label: "Ready — embed the demo" }, { value: "unavailable", label: "Unavailable — screenshot with an unavailable notice" }] })}
${input({ name: "demo_verified_on", label: "Date you verified the demo (isolation and navigation)", type: "date" })}
${input({ name: "demo_revision", label: "Source revision", value: p.demo_revision, maxlength: 120, hint: "repository@commit the demo was built from" })}
${input({ name: "poster_desktop_asset", label: "Bundled desktop poster", value: p.poster_desktop_asset, hint: "Optional genuine screenshot shipped with the site: /assets/portfolio/<name>.webp" })}
${input({ name: "poster_tablet_asset", label: "Bundled tablet poster", value: p.poster_tablet_asset })}
${input({ name: "poster_mobile_asset", label: "Bundled mobile poster", value: p.poster_mobile_asset })}
<div class="form-actions">${button("Save demo settings", { variant: "secondary", size: "sm" })}</div></form></div>`;
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
${demoAdmin(ctx, p)}
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

