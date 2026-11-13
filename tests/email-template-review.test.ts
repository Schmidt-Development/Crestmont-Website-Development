// Founder action F2 (2026-11-09): every email template the platform sends, reviewed without sending. These tests check
// what a person cannot check by eye across 34 templates and their variants: no missing variables, no broken links, no
// internal identifiers in the words a customer reads, business identification in every footer, well-formed HTML, the
// review page is the Owner's alone, its previews are locked down, and looking at them sends nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import { EMAIL_TEMPLATES, TEMPLATES, renderTemplate, identityFrom, type EmailTemplate, type TemplateDef } from "../src/services/mailer.ts";
import { REVIEW_CHECKLIST } from "../src/routes/email-review.ts";

const variants = EMAIL_TEMPLATES.flatMap((t) => (TEMPLATES[t] as TemplateDef<EmailTemplate>).samples.map((_, i) => [t, i] as const));
const render = (t: EmailTemplate, i: number) => {
  const def = TEMPLATES[t] as TemplateDef<EmailTemplate>;
  // Business settings as migrations leave them (0106 sets the public contact email to support@).
  return renderTemplate(t, def.samples[i] as never, identityFrom({ "contact.email": "support@crestmontwebsitedevelopment.com" }), def.category === "marketing" ? "https://example.com/unsubscribe/preview" : undefined);
};
/** Internal record ids (prj_…, inv_…) and Stripe object ids (pi_…, cs_…) as they would appear in words a customer reads. */
const INTERNAL_ID = /\b(prj|inv|ord|pay|usr|ses|mact|tkt|ld|ct|apt|scall|evt|aud|ntf|rcpt|pi|cs|ch|re|in|sub|cus|pm|seti|txn|dp|du)_[A-Za-z0-9]{3,}\b/;

test("[EMAIL-002] every template variant renders: subject, no missing values, working links, identification, well-formed HTML", () => {
  assert.ok(variants.length >= 60, `${variants.length} variants`);
  for (const [t, i] of variants) {
    const m = render(t, i);
    const where = `${t}#${i}`;
    assert.ok(m.subject.trim().length > 5, `${where}: subject`);
    for (const [part, s] of [["subject", m.subject], ["text", m.text], ["html", m.html]] as const) {
      assert.doesNotMatch(s, /\bundefined\b|\bNaN\b|\[object Object\]|\$\{|\{\{/, `${where}: unresolved value in ${part}`);
    }
    const hrefs = [...m.html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]);
    for (const h of hrefs) assert.match(h, /^https:\/\//, `${where}: link "${h}" is not an absolute https URL`);
    assert.match(m.text, /Crestmont Website Development/, `${where}: business identification in the text footer`);
    assert.match(m.html, /data-footer[^>]*>Crestmont Website Development/, `${where}: business identification in the HTML footer`);
    assert.match(m.html, /^<!doctype html><html>/i, `${where}: document`);
    assert.equal((m.html.match(/<table\b/g) ?? []).length, (m.html.match(/<\/table>/g) ?? []).length, `${where}: balanced tables`);
    assert.equal((m.html.match(/<\/html>/g) ?? []).length, 1, `${where}: one document`);
    assert.match(m.html, /<meta name="viewport" content="width=device-width">/, `${where}: mobile viewport`);
    assert.match(m.html, /max-width:560px;width:100%/, `${where}: fluid width on phones`);
    // The words a person reads, with URLs removed: no internal or Stripe identifiers (a link's path may carry one).
    const words = m.text.replace(/https?:\/\/\S+/g, "");
    assert.doesNotMatch(words, INTERNAL_ID, `${where}: internal identifier in the readable text`);
    for (const money of m.text.match(/\$[^\s,.;)]*/g) ?? []) assert.match(money, /^\$\d[\d,]*(\.\d{2})?(\/month)?$/, `${where}: amount "${money}"`);
    const def = TEMPLATES[t] as TemplateDef<EmailTemplate>;
    if (def.category === "marketing") assert.match(m.html, /Unsubscribe/, `${where}: marketing carries an unsubscribe link`);
    else assert.doesNotMatch(m.html, /Unsubscribe/, `${where}: transactional mail has no unsubscribe link`);
  }
});

test("[EMAIL-002] the review checklist covers the Founder's twelve notification types with templates that exist and are customer-relevant", () => {
  assert.equal(REVIEW_CHECKLIST.length, 12);
  for (const c of REVIEW_CHECKLIST) for (const t of c.templates) assert.ok((EMAIL_TEMPLATES as readonly string[]).includes(t), `${c.topic}: ${t}`);
  // The maintenance and payment-failure topics have a variant for each case the platform sends.
  const kinds = (t: EmailTemplate) => (TEMPLATES[t] as TemplateDef<EmailTemplate>).samples.map((s) => (s as { kind?: string }).kind ?? "");
  for (const k of ["agreement_requested", "restored"]) assert.ok(kinds("subscription_update").includes(k), k);
  for (const k of ["initial_subscription", "suspension_notice", "suspended", "checkout"]) assert.ok(kinds("failed_payment").includes(k), k);
  const events = (TEMPLATES.consultation as TemplateDef<"consultation">).samples.map((s) => s.event);
  for (const e of ["requested", "confirmed", "rescheduled", "cancelled"]) assert.ok(events.includes(e as never), e);
});

test("[EMAIL-002] the maintenance agreement request reads as a request, not as a status pasted into a sentence", () => {
  const m = renderTemplate("subscription_update", { planName: "Essential", status: "due", kind: "agreement_requested", url: "https://example.com/portal/projects/x" }, identityFrom({}));
  assert.equal(m.subject, "Two steps before your website goes live");
  assert.match(m.text, /sign the maintenance agreement for your Essential plan, then activate the monthly subscription/);
  assert.match(m.text, /Signing the agreement does not charge you/);
  const r = renderTemplate("subscription_update", { planName: "Essential", status: "active", kind: "restored", url: "https://example.com/portal/billing" }, identityFrom({}));
  assert.equal(r.subject, "Your website hosting is restored");
  assert.equal(renderTemplate("subscription_update", { planName: "Essential", status: "past_due", url: "https://example.com/portal/billing" }, identityFrom({})).subject, "Your Essential plan: past due: a payment is needed");
});

test("[EMAIL-002] [SEC-002] the review page is the Owner's, its previews are locked down, and viewing every one sends nothing", async () => {
  const app = await createTestApp();
  const owner = await createStaff(app.db, "owner");
  const c = await app.client().login(owner.email, TEST_PASSWORD, owner.secret);
  const before = (await app.db.prepare(`SELECT COUNT(*) AS n FROM email_deliveries`).first<{ n: number }>())!.n;
  const page = await c.get("/staff/email/templates");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-review-checklist/);
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-src[^;]*http:\/\/localhost|frame-src[^;]*https?:\/\//, "the page may frame this site's own previews");
  for (const [t, i] of variants) {
    assert.ok(html.includes(`/staff/email/templates/${t}/view?sample=${i}`), `${t}#${i} framed`);
    const v = await c.get(`/staff/email/templates/${t}/view?sample=${i}`);
    assert.equal(v.status, 200, `${t}#${i}`);
    const csp = v.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/); assert.match(csp, /frame-ancestors 'self'/); assert.match(csp, /\bsandbox\b/); assert.match(csp, /form-action 'none'/);
    assert.doesNotMatch(csp, /script-src/, "no script can run in a preview");
    assert.equal(v.headers.get("x-frame-options"), "SAMEORIGIN");
    // Exactly what would be sent (the marketing unsubscribe link carries this site's own address).
    assert.equal((await v.text()).replace(/href="[^"]*\/unsubscribe\/preview"/, "U"), render(t, i).html.replace(/href="[^"]*\/unsubscribe\/preview"/, "U"), `${t}#${i}`);
  }
  assert.equal((await c.get("/staff/email/templates/invoice/view?sample=99")).status, 404);
  assert.equal((await c.get("/staff/email/templates/not_a_template/view")).status, 404);
  const after = (await app.db.prepare(`SELECT COUNT(*) AS n FROM email_deliveries`).first<{ n: number }>())!.n;
  assert.equal(after, before, "reviewing templates never creates a delivery");
  for (const role of ["administrator", "support", "sales", "project_manager"] as const) {
    const s = await createStaff(app.db, role);
    const sc = await app.client().login(s.email, TEST_PASSWORD, s.secret);
    for (const path of ["/staff/email/templates", "/staff/email/templates/invoice/view", "/staff/email/templates/invoice/html"]) {
      assert.ok([403, 404].includes((await sc.get(path)).status), `${role} ${path}`);
    }
  }
  assert.ok([302, 303, 401].includes((await app.client().get("/staff/email/templates")).status), "anonymous is refused");
});
