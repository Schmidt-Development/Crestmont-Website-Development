// Founder requirement (2026-11): select package → website intake → review scope and pricing → accept agreements →
// Stripe payment → project fulfilment. Customers describe what they want BEFORE paying (purchase_intakes, migration
// 0089). Everything here runs through the real request pipeline on the real migrations; Stripe is a FIXTURE adapter
// that records Checkout requests, and webhooks are signed FIXTURE events posted to the real webhook route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, MemoryStorage } from "./support/app.ts";
import { completeIntake, completeQuoteIntake, INTAKE_ANSWERS } from "./support/intake.ts";
import { png } from "./support/security-world.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import { buildContext } from "../src/app/app.ts";
import { createPackageOrder, createQuoteOrder } from "../src/services/commerce.ts";
import { startPackageCheckout, startInvoiceCheckout } from "../src/services/billing.ts";
import * as B from "../src/services/builds.ts";
import type { Env } from "../src/app/context.ts";
import type { PaymentsAdapter, CheckoutRequest } from "../src/adapters/payments.ts";

const WHSEC = "whsec_test_purchase_intake_fixture";

/** FIXTURE: records each Checkout request together with the agreement acceptances that existed when it was made. */
class RecordingPayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  db!: Env["DB"];
  checkouts: { req: CheckoutRequest; acceptancesAtCall: number }[] = [];
  async createCheckout(req: CheckoutRequest) {
    const n = (await this.db.prepare(`SELECT COUNT(*) AS n FROM agreement_acceptances WHERE context_type = 'package_checkout' AND context_id = ?`).bind(req.metadata.order_id ?? "").first<{ n: number }>())!.n;
    this.checkouts.push({ req, acceptancesAtCall: n });
    const id = `cs_test_intake_${this.checkouts.length}`;
    return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
  }
  async createBillingPortal(customerId: string) { return { url: `https://billing.stripe.com/p/session/test_${customerId}` }; }
  async createRefund(pi: string, amount: number) { return { id: `re_test_${pi}_${amount}`, status: "succeeded" }; }
}

async function app() {
  const fake = new RecordingPayments();
  const t = await createTestApp({ STRIPE_WEBHOOK_SECRET: WHSEC, overrides: { payments: fake, storage: new MemoryStorage() } });
  fake.db = t.db;
  return { ...t, fake };
}
type T = Awaited<ReturnType<typeof app>>;
const one = async <R>(t: T, sql: string, ...b: unknown[]) => (await t.db.prepare(sql).bind(...b).first<R>())!;
const count = async (t: T, sql: string, ...b: unknown[]) => (await one<{ n: number }>(t, `SELECT COUNT(*) AS n FROM (${sql})`, ...b)).n;
let seq = 0;
/** Posts a SIGNED FIXTURE Stripe event to the real webhook route. */
async function webhook(t: T, type: string, object: Record<string, unknown>, id = `evt_intake_${++seq}_${Date.now()}`) {
  const body = JSON.stringify({ id, type, created: Math.floor(Date.now() / 1000), data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  return t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(WHSEC, `${ts}.${body}`)}`, "content-type": "application/json" } });
}
const paidSession = (co: CheckoutRequest, pi: string) => ({ id: `cs_${pi}`, object: "checkout.session", mode: "payment", payment_status: "paid",
  amount_total: co.lines.reduce((s, l) => s + l.amountCents * (l.quantity ?? 1), 0), payment_intent: pi, customer: `cus_${pi}`, customer_email: co.customerEmail, metadata: co.metadata });
async function buyer(t: T, email: string, org = "Intake Fixture Co") {
  const cu = await createCustomer(t.db, email, org);
  const c = await t.client().login(cu.email);
  return { ...cu, c };
}
const loc = (r: Response) => r.headers.get("location");

test("[SALES-004] [PORTAL-002] the website intake is saved before payment: drafts keep valid answers, an incomplete intake resumes, and submitting leads to review", async () => {
  const t = await app();
  const b = await buyer(t, "draft@intake.example");
  // The package entry point starts with the intake.
  assert.equal(loc(await b.c.get("/checkout/business")), "/checkout/business/intake");
  const blank = await (await b.c.get("/checkout/business/intake")).text();
  assert.match(blank, /Tell us about your website/);
  assert.match(blank, /name="business_name"[^>]*value="Intake Fixture Co"/, "prefilled from the organization");
  // A partial draft (with a logo upload) is kept.
  const draft = await b.c.post("/checkout/business/intake", { intent: "draft", business_name: "Draft Bakery", goals: "More catering orders", has_branding: "yes", logo: png("logo.png") });
  assert.equal(draft.status, 303);
  assert.equal(loc(draft), "/checkout/business/intake");
  const row = await one<{ id: string; product_id: string; completed_at: string | null; order_id: string | null; project_id: string | null; answers_json: string }>(t, `SELECT * FROM purchase_intakes WHERE organization_id = ?`, b.organizationId);
  assert.deepEqual({ product: row.product_id, completed: row.completed_at, order: row.order_id, project: row.project_id }, { product: "business", completed: null, order: null, project: null });
  const saved = JSON.parse(row.answers_json);
  assert.equal(saved.business_name, "Draft Bakery");
  assert.equal(saved.logo.length, 1, "the logo is stored before any project exists");
  assert.equal((await one<{ project_id: string | null; folder: string }>(t, `SELECT project_id, folder FROM files WHERE id = ?`, saved.logo[0])).project_id, null);
  // Resume: the draft is shown again, and nothing else exists yet.
  assert.equal(loc(await b.c.get("/checkout/business")), "/checkout/business/intake", "an incomplete intake resumes at the intake");
  const page = await (await b.c.get("/checkout/business/intake")).text();
  assert.match(page, /value="Draft Bakery"/);
  assert.match(page, /data-testid="intake-draft-saved"/);
  assert.match(page, /logo\.png/);
  assert.equal(loc(await b.c.get("/checkout/business/review")), "/checkout/business/intake", "no review before the intake is complete");
  // Submitting with required answers missing is refused with the reasons, and what was typed is kept.
  const bad = await b.c.post("/checkout/business/intake", { intent: "submit", industry: "Bakery" });
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /Target audience|target audience/i);
  const kept = JSON.parse((await one<{ answers_json: string }>(t, `SELECT answers_json FROM purchase_intakes WHERE id = ?`, row.id)).answers_json);
  assert.deepEqual({ name: kept.business_name, industry: kept.industry, logo: kept.logo.length }, { name: "Draft Bakery", industry: "Bakery", logo: 1 });
  assert.equal((await one<{ completed_at: string | null }>(t, `SELECT completed_at FROM purchase_intakes WHERE id = ?`, row.id)).completed_at, null);
  // Completing it leads to review; still no order, invoice, Stripe session, project or build.
  const done = await completeIntake(b.c, "business", { has_branding: "no" });
  assert.equal(loc(done), "/checkout/business/review");
  assert.ok((await one<{ completed_at: string | null }>(t, `SELECT completed_at FROM purchase_intakes WHERE id = ?`, row.id)).completed_at);
  assert.equal(await count(t, `SELECT 1 FROM purchase_intakes WHERE organization_id = ?`, b.organizationId), 1, "one intake per organization and package");
  assert.equal(loc(await b.c.get("/checkout/business")), "/checkout/business/review", "a completed intake resumes at the review");
  for (const table of ["orders", "invoices", "projects", "build_jobs"]) assert.equal(await count(t, `SELECT 1 FROM ${table}`), 0, `no ${table} before payment`);
  assert.equal(t.fake.checkouts.length, 0);
});

test("[SALES-004] checkout is refused without a completed intake: no order, no invoice, no Stripe session", async () => {
  const t = await app();
  const b = await buyer(t, "refused@intake.example");
  const res = await b.c.post("/checkout/business", { terms: "1", maintenance_plan: "professional" });
  assert.equal(res.status, 303);
  assert.equal(loc(res), "/checkout/business/intake");
  // A draft is not enough either.
  await b.c.post("/checkout/business/intake", { intent: "draft", business_name: "Half Done" });
  assert.equal(loc(await b.c.post("/checkout/business", { terms: "1", maintenance_plan: "professional" })), "/checkout/business/intake");
  // Nor is another package's intake.
  await completeIntake(b.c, "starter");
  assert.equal(loc(await b.c.post("/checkout/business", { terms: "1", maintenance_plan: "professional" })), "/checkout/business/intake");
  // The service refuses on its own too (defence in depth), before any order exists.
  const ctx = await buildContext(new Request("http://crestmont.test/checkout/business", { headers: { cookie: `cm_session=${b.c.cookies.get("cm_session")}` } }), t.env);
  await assert.rejects(startPackageCheckout(ctx, { id: b.id, email: b.email }, b.organizationId, "business", "professional"), /Complete the website intake/);
  assert.equal(await count(t, `SELECT 1 FROM orders`), 0);
  assert.equal(await count(t, `SELECT 1 FROM invoices`), 0);
  assert.equal(await count(t, `SELECT 1 FROM agreement_acceptances WHERE context_type = 'package_checkout'`), 0, "nothing accepted either");
  assert.equal(t.fake.checkouts.length, 0);
});

test("[CAT-007] [LEGAL-003] review shows the server-side price and scope; the agreements are accepted BEFORE the Stripe session, which carries the server amount and the intake id", async () => {
  const t = await app();
  const b = await buyer(t, "review@intake.example");
  await completeIntake(b.c, "business");
  const review = await (await b.c.get("/checkout/business/review")).text();
  assert.match(review, /data-testid="checkout-price">\$2,499/);
  assert.match(review, /data-testid="checkout-scope"/);
  assert.match(review, /data-testid="checkout-intake-summary"/);
  assert.match(review, /Fixture Bakery \(test data\)/, "the customer's own intake is shown for review");
  assert.match(review, /name="maintenance_plan" value="professional"/, "the plan choice is on the review page");
  assert.match(review, /name="terms"/);
  assert.match(review, /Pay \$2,499/);
  // Agreements are still required on the review step.
  assert.equal((await b.c.post("/checkout/business", { maintenance_plan: "professional" })).status, 422);
  assert.equal(await count(t, `SELECT 1 FROM orders`), 0);
  const res = await b.c.post("/checkout/business", { terms: "1", maintenance_plan: "professional", price: "1", amount_cents: "100", total_cents: "100" });
  assert.equal(res.status, 303);
  assert.match(loc(res)!, /^https:\/\/checkout\.stripe\.com\//);
  const { req, acceptancesAtCall } = t.fake.checkouts[0];
  assert.equal(req.lines[0].amountCents, 249_900, "server-side price, not the form's");
  assert.equal(acceptancesAtCall, 4, "development agreement, terms, refund policy and DPA were recorded before Stripe was called");
  const intake = await one<{ id: string; order_id: string }>(t, `SELECT id, order_id FROM purchase_intakes WHERE organization_id = ? AND product_id = 'business'`, b.organizationId);
  assert.equal(req.metadata.intake_id, intake.id);
  assert.equal(intake.order_id, req.metadata.order_id, "the intake is stamped with the order it is bought with");
  assert.equal(req.cancelUrl, "http://crestmont.test/checkout/business/review?checkout=cancelled");
  const order = await one<{ total_cents: number; status: string }>(t, `SELECT total_cents, status FROM orders WHERE id = ?`, req.metadata.order_id);
  assert.deepEqual({ ...order }, { total_cents: 249_900, status: "pending_payment" });
  // A cancelled Stripe checkout returns to the review page.
  assert.match(await (await b.c.get("/checkout/business/review?checkout=cancelled")).text(), /Checkout was cancelled\. Nothing was charged\./);
});

test("[PAY-003] [PORTAL-002] a verified payment provisions exactly one project carrying the intake (answers, uploads, scope review); duplicate webhooks create nothing more; no second intake", async () => {
  const t = await app();
  const b = await buyer(t, "paid@intake.example");
  await b.c.post("/checkout/business/intake", { intent: "draft", has_branding: "yes", logo: png("brand-logo.png") });
  await completeIntake(b.c, "business", { has_branding: "yes", brand_guidelines: "Navy and cream, serif headings." });
  assert.equal((await b.c.post("/checkout/business", { terms: "1", maintenance_plan: "professional" })).status, 303);
  const co = t.fake.checkouts[0].req;
  const intake = await one<{ id: string; answers_json: string }>(t, `SELECT id, answers_json FROM purchase_intakes WHERE organization_id = ?`, b.organizationId);
  const logoId = JSON.parse(intake.answers_json).logo[0] as string;
  const evt = paidSession(co, "pi_intake_paid");
  assert.equal((await webhook(t, "checkout.session.completed", evt, "evt_intake_paid")).status, 200);
  // Redelivery of the same event, and the same session under a new event id.
  assert.deepEqual(await (await webhook(t, "checkout.session.completed", evt, "evt_intake_paid")).json(), { received: true, duplicate: true });
  await webhook(t, "checkout.session.completed", evt, "evt_intake_paid_again");
  assert.equal(await count(t, `SELECT 1 FROM projects WHERE order_id = ?`, co.metadata.order_id), 1, "exactly one project");
  assert.equal(await count(t, `SELECT 1 FROM payments WHERE invoice_id = ?`, co.metadata.invoice_id), 1, "exactly one payment");
  const project = await one<{ id: string; status: string }>(t, `SELECT id, status FROM projects WHERE order_id = ?`, co.metadata.order_id);
  assert.equal(project.status, "scope_review", "the same state an intake submission produces, so staff still review the scope");
  const ob = await one<{ answers_json: string; completed_at: string | null }>(t, `SELECT answers_json, completed_at FROM onboarding_responses WHERE project_id = ?`, project.id);
  assert.ok(ob.completed_at);
  assert.deepEqual(JSON.parse(ob.answers_json), JSON.parse(intake.answers_json), "the intake answers are the project's onboarding");
  assert.equal(JSON.parse(ob.answers_json).brand_guidelines, "Navy and cream, serif headings.");
  assert.equal((await one<{ project_id: string }>(t, `SELECT project_id FROM files WHERE id = ?`, logoId)).project_id, project.id, "uploaded intake files are linked to the project");
  const consumed = await one<{ project_id: string; order_id: string }>(t, `SELECT project_id, order_id FROM purchase_intakes WHERE id = ?`, intake.id);
  assert.deepEqual({ ...consumed }, { project_id: project.id, order_id: co.metadata.order_id });
  // Portal: the intake counts as done — no second intake, no "complete onboarding" action.
  const onboarding = await (await b.c.get(`/portal/projects/${project.id}/onboarding`)).text();
  assert.match(onboarding, /Website intake submitted before payment/);
  assert.doesNotMatch(onboarding, /Submit onboarding/);
  assert.doesNotMatch(await (await b.c.get("/portal")).text(), /Complete onboarding for/);
  assert.equal((await b.c.post(`/portal/projects/${project.id}/onboarding`, { ...INTAKE_ANSWERS, intent: "submit" })).status, 422);
  assert.ok(await one<{ id: number }>(t, `SELECT id FROM audit_logs WHERE action = 'onboarding.completed' AND subject_id = ?`, project.id), "the project history shows the intake");
  // The receipt points at the project, not at a second onboarding.
  const receipt = await one<{ text_body: string }>(t, `SELECT m.text_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.template = 'receipt' AND d.to_email = ?`, b.email);
  assert.match(receipt.text_body, new RegExp(`/portal/projects/${project.id}(?!/onboarding)`));
  // The paid intake is closed: the intake page starts afresh for a later purchase of the same package.
  assert.doesNotMatch(await (await b.c.get("/checkout/business/intake")).text(), /You completed this intake/);
});

test("[PAY-003] a failed or expired Checkout session provisions nothing; the intake stays open and is bought with the next order", async () => {
  const t = await app();
  const b = await buyer(t, "expired@intake.example");
  await completeIntake(b.c, "starter");
  await b.c.post("/checkout/starter", { terms: "1", maintenance_plan: "essential" });
  const co = t.fake.checkouts[0].req;
  await webhook(t, "checkout.session.async_payment_failed", { id: "cs_failed", object: "checkout.session", mode: "payment", payment_status: "unpaid", customer_email: b.email, metadata: co.metadata });
  const sess = (await one<{ stripe_checkout_session_id: string }>(t, `SELECT stripe_checkout_session_id FROM invoices WHERE id = ?`, co.metadata.invoice_id)).stripe_checkout_session_id;
  await webhook(t, "checkout.session.expired", { id: sess, object: "checkout.session", status: "expired", metadata: co.metadata });
  assert.equal((await one<{ status: string }>(t, `SELECT status FROM invoices WHERE id = ?`, co.metadata.invoice_id)).status, "void");
  assert.equal(await count(t, `SELECT 1 FROM projects`), 0, "no project without a payment");
  assert.equal(await count(t, `SELECT 1 FROM onboarding_responses`), 0);
  const intake = await one<{ id: string; completed_at: string | null; project_id: string | null }>(t, `SELECT id, completed_at, project_id FROM purchase_intakes WHERE organization_id = ?`, b.organizationId);
  assert.ok(intake.completed_at);
  assert.equal(intake.project_id, null, "the intake is still open");
  // The customer goes straight back to review and checks out again: a fresh order, re-stamped on the intake.
  assert.equal(loc(await b.c.get("/checkout/starter")), "/checkout/starter/review");
  await b.c.post("/checkout/starter", { terms: "1", maintenance_plan: "essential" });
  const co2 = t.fake.checkouts.at(-1)!.req;
  assert.notEqual(co2.metadata.order_id, co.metadata.order_id);
  assert.equal(co2.metadata.intake_id, intake.id);
  assert.equal((await one<{ order_id: string }>(t, `SELECT order_id FROM purchase_intakes WHERE id = ?`, intake.id)).order_id, co2.metadata.order_id);
  await webhook(t, "checkout.session.completed", paidSession(co2, "pi_intake_retry"));
  assert.equal((await one<{ status: string }>(t, `SELECT p.status FROM projects p WHERE p.order_id = ?`, co2.metadata.order_id)).status, "scope_review");
  assert.equal(await count(t, `SELECT 1 FROM projects`), 1);
});

/** An accepted custom quote (50/25/25) for the organization, with its open 50% deposit invoice. */
async function acceptedQuote(t: T, organizationId: string, userId: string) {
  const lead = await one<{ id: string }>(t, `SELECT id FROM leads LIMIT 1`).catch(() => null);
  let leadId = lead?.id;
  if (!leadId) {
    const ct = newId("ct"); leadId = newId("ld");
    await t.db.batch([
      t.db.prepare(`INSERT INTO contacts (id, name, email, created_at) VALUES (?, 'Quote Contact', 'quote-contact@intake.example', ?)`).bind(ct, nowIso()),
      t.db.prepare(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES (?,?, 'quote_form', 'accepted', ?, ?)`).bind(leadId, ct, nowIso(), nowIso()),
    ]);
  }
  const q = newId("quo"), v = newId("qv");
  await t.db.batch([
    t.db.prepare(`INSERT INTO quotes (id, lead_id, status, current_version, created_by, created_at) VALUES (?,?, 'accepted', 1, ?, ?)`).bind(q, leadId, userId, nowIso()),
    t.db.prepare(`INSERT INTO quote_versions (id, quote_id, version, line_items_json, total_cents, payment_schedule, scope_text, package_id, accepted_at, created_at) VALUES (?,?,1,'[]', 600000, 'milestone_50_25_25', 'Custom portal with admin area', 'custom', ?, ?)`).bind(v, q, nowIso(), nowIso()),
  ]);
  const o = await createQuoteOrder(t.db, organizationId, { id: v, total_cents: 600_000, payment_schedule: "milestone_50_25_25", quote_id: q, package_id: "custom" }, null, userId);
  return { ...o, quoteVersionId: v };
}

test("[PAY-006] [SALES-004] a quote's deposit cannot be paid until the website intake is complete; later 25% milestones are not gated", async () => {
  const t = await app();
  const b = await buyer(t, "quote@intake.example");
  const q = await acceptedQuote(t, b.organizationId, b.id);
  const ctx = await buildContext(new Request("http://crestmont.test/portal/billing", { headers: { cookie: `cm_session=${b.c.cookies.get("cm_session")}` } }), t.env);
  // Refused by the service and by the route, with no Stripe session.
  await assert.rejects(startInvoiceCheckout(ctx, { id: b.id, email: b.email }, b.organizationId, q.invoiceId), /Complete the website intake/);
  const pay = await b.c.post(`/portal/billing/invoices/${q.invoiceId}/pay`);
  assert.equal(loc(pay), `/portal/billing/invoices/${q.invoiceId}/intake`);
  assert.equal(t.fake.checkouts.length, 0);
  // The billing and invoice pages send the customer to the intake instead of payment.
  assert.match(await (await b.c.get("/portal/billing")).text(), new RegExp(`href="/portal/billing/invoices/${q.invoiceId}/intake"`));
  const invPage = await (await b.c.get(`/portal/billing/invoices/${q.invoiceId}`)).text();
  assert.match(invPage, /data-testid="invoice-intake-required"/);
  assert.doesNotMatch(invPage, /securely/);
  // A draft is saved (custom work sees the advanced-features question) and is not enough to pay.
  const form = await (await b.c.get(`/portal/billing/invoices/${q.invoiceId}/intake`)).text();
  assert.match(form, /name="advanced_features"/);
  await b.c.post(`/portal/billing/invoices/${q.invoiceId}/intake`, { intent: "draft", business_name: "Quote Draft Co" });
  assert.equal(loc(await b.c.post(`/portal/billing/invoices/${q.invoiceId}/pay`)), `/portal/billing/invoices/${q.invoiceId}/intake`);
  await completeQuoteIntake(b.c, q.invoiceId);
  const intake = await one<{ quote_version_id: string; product_id: string | null; order_id: string; completed_at: string | null }>(t, `SELECT quote_version_id, product_id, order_id, completed_at FROM purchase_intakes WHERE organization_id = ?`, b.organizationId);
  assert.deepEqual({ qv: intake.quote_version_id, product: intake.product_id, order: intake.order_id, done: !!intake.completed_at }, { qv: q.quoteVersionId, product: null, order: q.orderId, done: true });
  const ok = await b.c.post(`/portal/billing/invoices/${q.invoiceId}/pay`);
  assert.match(loc(ok)!, /^https:\/\/checkout\.stripe\.com\//);
  const co = t.fake.checkouts[0].req;
  assert.equal(co.lines[0].amountCents, 300_000, "the 50% deposit, from the invoice");
  await webhook(t, "checkout.session.completed", paidSession(co, "pi_quote_deposit"));
  const project = await one<{ id: string; status: string; payment_schedule: string }>(t, `SELECT id, status, payment_schedule FROM projects WHERE order_id = ?`, q.orderId);
  assert.deepEqual({ status: project.status, schedule: project.payment_schedule }, { status: "scope_review", schedule: "milestone_50_25_25" });
  assert.ok((await one<{ completed_at: string | null }>(t, `SELECT completed_at FROM onboarding_responses WHERE project_id = ?`, project.id)).completed_at);
  // The intake page now shows the submitted answers; edits go through Messages.
  assert.match(await (await b.c.get(`/portal/billing/invoices/${q.invoiceId}/intake`)).text(), /Changes now go to your team through Messages/);
  // A 25% milestone invoice on another accepted quote with NO intake is payable: only the first invoice is gated.
  const q2 = await acceptedQuote(t, b.organizationId, b.id);
  const ms = newId("inv");
  await t.db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, description, created_at) VALUES (?,?,?, 'design_25', 150000, 'open', '25% on approved design', ?)`).bind(ms, b.organizationId, q2.orderId, nowIso()).run();
  assert.match(loc(await b.c.post(`/portal/billing/invoices/${ms}/pay`))!, /^https:\/\/checkout\.stripe\.com\//);
  // Another organization cannot open or fill this organization's intake.
  const other = await buyer(t, "other@intake.example", "Other Co");
  assert.equal((await other.c.get(`/portal/billing/invoices/${q2.invoiceId}/intake`)).status, 404);
  assert.equal((await other.c.post(`/portal/billing/invoices/${q2.invoiceId}/intake`, { intent: "draft", business_name: "x" })).status, 404);
});

test("[AIB-001] completing the intake alone queues no build; after payment the unchanged eligibility rule decides exactly as for an intake submitted after payment", async () => {
  const t = await app();
  // New journey: intake first, then pay.
  const a = await buyer(t, "build-first@intake.example", "Build First Co");
  await completeIntake(a.c, "business");
  assert.equal(await count(t, `SELECT 1 FROM build_jobs`), 0, "an intake alone creates no build record");
  assert.equal(await count(t, `SELECT 1 FROM projects`), 0, "and no project for the eligibility rule to consider");
  await a.c.post("/checkout/business", { terms: "1", maintenance_plan: "professional" });
  assert.equal(await count(t, `SELECT 1 FROM build_jobs`), 0, "starting checkout queues nothing either");
  const coA = t.fake.checkouts.at(-1)!.req;
  await webhook(t, "checkout.session.completed", paidSession(coA, "pi_build_first"));
  const pa = (await one<{ id: string }>(t, `SELECT id FROM projects WHERE order_id = ?`, coA.metadata.order_id)).id;

  // Historical journey: an order paid without an intake, onboarding submitted afterwards (still supported).
  const h = await buyer(t, "build-after@intake.example", "Build After Co");
  const order = await createPackageOrder(t.db, h.organizationId, "business", h.id);
  await webhook(t, "checkout.session.completed", { id: "cs_hist", object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: order.amountCents, payment_intent: "pi_build_after", metadata: { organization_id: h.organizationId, order_id: order.orderId, invoice_id: order.invoiceId, kind: "package" } });
  const ph = (await one<{ id: string; status: string }>(t, `SELECT id, status FROM projects WHERE order_id = ?`, order.orderId));
  assert.equal(ph.status, "awaiting_onboarding", "without a pre-purchase intake the project waits for onboarding as before");
  assert.deepEqual(B.decideEligibility(await B.projectFacts(t.db, ph.id)).verdict, "awaiting_intake");
  assert.equal((await h.c.post(`/portal/projects/${ph.id}/onboarding`, { ...INTAKE_ANSWERS, intent: "submit" })).status, 303);

  // Same facts, same decision, same build state.
  const da = B.decideEligibility(await B.projectFacts(t.db, pa));
  const dh = B.decideEligibility(await B.projectFacts(t.db, ph.id));
  assert.deepEqual(da, dh);
  assert.deepEqual(da, { verdict: "queued", reasons: ["verified payment and submitted intake"] });
  const ja = await one<{ state: string }>(t, `SELECT state FROM build_jobs WHERE project_id = ?`, pa);
  const jh = await one<{ state: string }>(t, `SELECT state FROM build_jobs WHERE project_id = ?`, ph.id);
  assert.equal(ja.state, jh.state);
  assert.equal((await one<{ status: string }>(t, `SELECT status FROM projects WHERE id = ?`, pa)).status, (await one<{ status: string }>(t, `SELECT status FROM projects WHERE id = ?`, ph.id)).status, "both in scope review");
});
