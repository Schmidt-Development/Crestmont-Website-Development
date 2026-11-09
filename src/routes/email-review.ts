// Email Template Review (Founder action F2, 2026-11-09). Owner-only, read-only.
//
// Every template is rendered by the SAME code the delivery path uses (mailer.ts renderTemplate -> renderLayout), with
// the template's own clearly labelled fictional samples and the business identity recorded in Business settings. The
// HTML is shown as it is sent, inside a sandboxed frame served from a separate route with a locked-down policy (no
// scripts, no forms, framable only by this site), at desktop and phone width; the plain-text alternative sits beside it.
// Nothing here sends anything: there is no POST route, and no code path reaches the mailer's send.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, label, type SafeHtml } from "../lib/html.ts";
import { HttpError, download } from "../app/http.ts";
import { pageHead, linkButton } from "../ui/components.ts";
import { requireStaff } from "../app/app.ts";
import { isOwner } from "../domain/authz.ts";
import { renderTemplate, identityFrom, EMAIL_TEMPLATES, TEMPLATES, type EmailTemplate, type TemplateDef, type Audience } from "../services/mailer.ts";

export const DEFAULT_FROM = "Crestmont <support@crestmontwebsitedevelopment.com>";

/** The Founder's twelve notification types, mapped to the templates that actually carry them. */
export const REVIEW_CHECKLIST: { topic: string; templates: EmailTemplate[]; note?: string }[] = [
  { topic: "Account creation and welcome", templates: ["registration", "verification", "password_reset", "email_change_confirm", "security_notification"] },
  { topic: "Website package purchase confirmation", templates: ["purchase", "proposal_accepted"], note: "proposal_accepted is the custom-quote equivalent." },
  { topic: "Invoice delivery", templates: ["invoice"] },
  { topic: "Payment receipt", templates: ["receipt"] },
  { topic: "Appointment booked, rescheduled or cancelled", templates: ["consultation"], note: "Four variants: requested, confirmed, rescheduled, cancelled." },
  { topic: "Customer support replies", templates: ["support_ticket", "support_reply"] },
  { topic: "Refund requests and status updates", templates: ["refund_request", "refund_decision"] },
  { topic: "Dispute notifications", templates: ["dispute_opened"], note: "Internal only: the customer opened the dispute with their bank, which notifies them; Crestmont's internal mailbox gets this notice." },
  { topic: "Maintenance agreement request (and completion)", templates: ["subscription_update"], note: "The request is the “Two steps before your website goes live” variant. Signing is confirmed on screen and recorded; no separate “agreement signed” email exists today (a Founder decision if one is wanted)." },
  { topic: "Maintenance subscription activation", templates: ["subscription_update"], note: "The “active” variant, sent when Stripe confirms the subscription." },
  { topic: "Subscription activation failure", templates: ["failed_payment"], note: "The “Your maintenance subscription did not start” variant (first payment declined)." },
  { topic: "Subscription payment failure, retries and recovery", templates: ["failed_payment", "subscription_update"], note: "Renewal failed (Stripe retries automatically), the seven-day reminder, hosting suspended, then “Your website hosting is restored”." },
];

const AUDIENCE: Record<Audience, string> = { customer: "Customer (account administrators)", any: "Customer or staff member (whoever the event concerns)", prospect: "Prospect (not yet a customer)", staff: "Crestmont internal mailbox / staff" };

/** A short name for each sample, from the variant fields templates already use. */
function variantLabel(sample: Record<string, unknown>, i: number): string {
  const v = sample.kind ?? sample.event ?? sample.decision ?? sample.milestone ?? (typeof sample.status === "string" && sample.status.length < 30 ? sample.status : undefined);
  return typeof v === "string" ? label(v) : `Sample ${i + 1}`;
}

export function renderPreview(ctx: AppContext, t: EmailTemplate, sample: number) {
  const def = TEMPLATES[t] as TemplateDef<EmailTemplate>;
  const data = def.samples[sample];
  if (data === undefined) return null;
  return renderTemplate(t, data as never, identityFrom(ctx.settings), def.category === "marketing" ? `${ctx.baseUrl}/unsubscribe/preview` : undefined);
}

function requireOwner(ctx: AppContext) {
  requireStaff(ctx, "settings.operational");
  if (!isOwner(ctx.actor!)) throw new HttpError(403, "Only the Owner reviews email templates.");
}

const customerFacing = (t: EmailTemplate) => (TEMPLATES[t] as TemplateDef<EmailTemplate>).audience !== "staff";

function templateCard(ctx: AppContext, t: EmailTemplate, from: string): SafeHtml {
  const def = TEMPLATES[t] as TemplateDef<EmailTemplate>;
  return html`<section class="card stack" id="tpl-${t}" data-template="${t}">
<h3 class="card__title">${label(t)} <span class="faint" style="font-size:.8rem">(${t})</span></h3>
<p class="muted">${def.description}</p>
<dl class="dl"><dt>Sender</dt><dd><code>${from}</code></dd><dt>Recipient</dt><dd>${AUDIENCE[def.audience]}</dd>
<dt>Kind</dt><dd>${def.category === "transactional" ? "Transactional (no unsubscribe link)" : "Marketing (with unsubscribe link)"}</dd><dt>Variants</dt><dd>${def.samples.length}</dd></dl>
${def.samples.map((s, i) => {
    const m = renderPreview(ctx, t, i)!;
    const src = `/staff/email/templates/${t}/view?sample=${i}`;
    return html`<details class="email-sample" data-sample="${String(i)}"${i === 0 ? html` open` : ""}>
<summary><strong>${variantLabel(s as Record<string, unknown>, i)}</strong> — Subject: ${m.subject}</summary>
<div class="grid grid-2" style="align-items:start;margin-top:.75rem">
<figure style="margin:0"><figcaption class="faint">Desktop</figcaption><iframe src="${src}" title="${label(t)} — ${variantLabel(s as Record<string, unknown>, i)} (desktop)" sandbox referrerpolicy="no-referrer" loading="lazy" style="width:100%;height:780px;border:1px solid var(--line,#3a3222);background:#0b0b0c"></iframe></figure>
<figure style="margin:0"><figcaption class="faint">Phone (375 px)</figcaption><iframe src="${src}" title="${label(t)} — ${variantLabel(s as Record<string, unknown>, i)} (phone)" sandbox referrerpolicy="no-referrer" loading="lazy" style="width:375px;max-width:100%;height:780px;border:1px solid var(--line,#3a3222);background:#0b0b0c"></iframe></figure>
</div>
<details><summary class="faint">Plain-text version</summary><pre class="code-block">${m.text}</pre></details>
<p><a class="btn btn--ghost btn--sm" href="/staff/email/templates/${t}/html?sample=${String(i)}">Download this HTML</a></p></details>`;
  })}</section>`;
}

export function register(r: Router, staffPage: (ctx: AppContext, title: string, body: SafeHtml) => Response): void {
  r.get("/staff/email/templates", (ctx) => {
    requireOwner(ctx);
    // The previews are frames served by this same site (their own locked-down policy below), so this page may frame
    // its own origin and nothing else new.
    ctx.frameSrc = [...new Set([...(ctx.frameSrc ?? []), new URL(ctx.baseUrl).origin])];
    const from = ctx.env.EMAIL_FROM ?? DEFAULT_FROM;
    const customer = EMAIL_TEMPLATES.filter(customerFacing);
    const internal = EMAIL_TEMPLATES.filter((t) => !customerFacing(t));
    const variants = EMAIL_TEMPLATES.reduce((n, t) => n + (TEMPLATES[t] as TemplateDef<EmailTemplate>).samples.length, 0);
    const body = html`${pageHead("Email template review", linkButton("Delivery log", "/staff/email", "secondary", "sm"), "Email operations")}
<div class="alert alert--warn" role="note"><strong>Review only — nothing on this page sends email.</strong> Every message below is rendered by the same code Crestmont uses to send real mail, with clearly fictional sample data (names such as “Sample Bakery”, example.com links) and the business identity recorded in Business settings. Approving the wording is your decision; this page records nothing.</div>
<p class="muted" data-testid="template-coverage">${customer.length} customer-facing templates and ${internal.length} internal ones; ${variants} variants in total.</p>
<section class="card stack" data-review-checklist><h2 class="card__title">What to review</h2>
<table class="table"><thead><tr><th>Notification</th><th>Template(s)</th><th>Note</th></tr></thead><tbody>
${REVIEW_CHECKLIST.map((c) => html`<tr><td>${c.topic}</td><td>${c.templates.map((t, i) => html`${i ? ", " : ""}<a href="#tpl-${t}">${label(t)}</a>`)}</td><td class="faint">${c.note ?? ""}</td></tr>`)}
</tbody></table></section>
<h2>Customer-facing messages</h2>
${customer.map((t) => templateCard(ctx, t, from))}
<h2>Internal messages (Crestmont staff only)</h2>
${internal.map((t) => templateCard(ctx, t, from))}`;
    return staffPage(ctx, "Email templates", body);
  });

  /** The rendered HTML, inline, for the review page's frames only. */
  r.get("/staff/email/templates/:name/view", (ctx, p) => {
    requireOwner(ctx);
    const m = sampleOf(ctx, p.name);
    return new Response(m.html, { headers: {
      "content-type": "text/html; charset=utf-8",
      // The email's own inline styles are its layout; nothing else may load or run, and only this site may frame it.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox",
      "x-frame-options": "SAMEORIGIN", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store",
    } });
  });

  r.get("/staff/email/templates/:name/html", (ctx, p) => {
    requireOwner(ctx);
    const m = sampleOf(ctx, p.name);
    return download(ctx, m.html, `preview-${p.name}-${Number(ctx.url.searchParams.get("sample") ?? "0")}.html`, "text/html; charset=utf-8");
  });
}

function sampleOf(ctx: AppContext, name: string) {
  if (!(EMAIL_TEMPLATES as readonly string[]).includes(name)) throw new HttpError(404, "Unknown template");
  const n = Number(ctx.url.searchParams.get("sample") ?? "0");
  const m = Number.isInteger(n) && n >= 0 ? renderPreview(ctx, name as EmailTemplate, n) : null;
  if (!m) throw new HttpError(404, "Unknown sample");
  return m;
}
