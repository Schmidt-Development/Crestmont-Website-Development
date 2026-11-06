// Intake-before-payment everywhere (Founder requirement, 2026-11). One server-side rule, requireIntakeForPayment in
// src/services/purchase-intake.ts, guards every path that can start a payment for a website project: Stripe Checkout
// for an invoice (including package orders made before intakes existed), Stripe-hosted invoices (issue / finalize /
// re-send) and the test-only payment simulation. Stripe is a FIXTURE adapter or a FIXTURE fetch; webhooks are signed
// FIXTURE events posted to the real webhook route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, MemoryStorage, TEST_PASSWORD } from "./support/app.ts";
import { completeQuoteIntake, INTAKE_ANSWERS, seedCompletedIntake } from "./support/intake.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import { buildContext } from "../src/app/app.ts";
import { createPackageOrder, createQuoteOrder, markInvoicePaid, provisionProjectOnce } from "../src/services/commerce.ts";
import { startInvoiceCheckout } from "../src/services/billing.ts";
import { requireIntakeForPayment, invoicesNeedingIntake } from "../src/services/purchase-intake.ts";
import { createStripeMilestoneInvoice } from "../src/services/stripe-invoices.ts";
import * as SIM from "../src/services/payment-simulation.ts";
import type { Env } from "../src/app/context.ts";
import type { PaymentsAdapter, CheckoutRequest } from "../src/adapters/payments.ts";

const WHSEC = "whsec_test_intake_enforcement_fixture";

/** FIXTURE: records Checkout requests; never contacts Stripe. */
class FakePayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  checkouts: CheckoutRequest[] = [];
  async createCheckout(req: CheckoutRequest) { this.checkouts.push(req); const id = `cs_test_enf_${this.checkouts.length}`; return { id, url: `https://checkout.stripe.com/c/pay/${id}` }; }
  async createBillingPortal(customerId: string) { return { url: `https://billing.stripe.com/p/session/test_${customerId}` }; }
  async createRefund(pi: string, amount: number) { return { id: `re_test_${pi}_${amount}`, status: "succeeded" }; }
}

async function app(extra: Partial<Env> = {}) {
  const fake = new FakePayments();
  const stripeCalls: string[] = [];
  // FIXTURE Stripe API (Stripe-hosted invoices): records each call and answers with an error, so a call proves the
  // request got past the intake rule and nothing is ever created.
  const fetchFixture = (async (u: string | URL | Request, init?: RequestInit) => {
    stripeCalls.push(`${init?.method ?? "GET"} ${new URL(String(u)).pathname}`);
    return new Response(JSON.stringify({ error: { type: "api_error", message: "fixture: not available" } }), { status: 500, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const t = await createTestApp({ STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_SECRET_KEY: "sk_test_intake_enforcement", PAYMENT_SIMULATION_ENABLED: "true", ...extra,
    overrides: { payments: fake, storage: new MemoryStorage(), fetch: fetchFixture } });
  const owner = await createStaff(t.db, "owner", "owner@enforcement.test");
  const oc = await t.client().login(owner.email, TEST_PASSWORD, owner.secret);
  return { ...t, fake, stripeCalls, owner, oc };
}
type T = Awaited<ReturnType<typeof app>>;
const one = async <R>(t: T, sql: string, ...b: unknown[]) => (await t.db.prepare(sql).bind(...b).first<R>())!;
const count = async (t: T, sql: string, ...b: unknown[]) => (await one<{ n: number }>(t, `SELECT COUNT(*) AS n FROM (${sql})`, ...b)).n;
const loc = (r: Response) => r.headers.get("location");
let seq = 0;
async function webhook(t: T, type: string, object: Record<string, unknown>, id = `evt_enf_${++seq}_${Date.now()}`) {
  const body = JSON.stringify({ id, type, created: Math.floor(Date.now() / 1000), data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  return t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(WHSEC, `${ts}.${body}`)}`, "content-type": "application/json" } });
}
const paid = (co: CheckoutRequest, pi: string) => ({ id: `cs_${pi}`, object: "checkout.session", mode: "payment", payment_status: "paid",
  amount_total: co.lines.reduce((s, l) => s + l.amountCents * (l.quantity ?? 1), 0), payment_intent: pi, customer: `cus_${pi}`, metadata: co.metadata });
async function buyer(t: T, email: string, org = "Enforcement Fixture Co") {
  const cu = await createCustomer(t.db, email, org);
  return { ...cu, c: await t.client().login(cu.email) };
}
async function ctxFor(t: T, c: { cookies: Map<string, string> }) {
  return buildContext(new Request("http://crestmont.test/portal/billing", { headers: { cookie: `cm_session=${c.cookies.get("cm_session")}` } }), t.env);
}
/** An accepted 50/25/25 quote for the organization, with its open 50% deposit invoice. */
async function acceptedQuote(t: T, organizationId: string, userId: string) {
  const ct = newId("ct"), ld = newId("ld"), q = newId("quo"), v = newId("qv");
  await t.db.batch([
    t.db.prepare(`INSERT INTO contacts (id, name, email, created_at) VALUES (?, 'Quote Contact', ?, ?)`).bind(ct, `${ct}@enforcement.example`, nowIso()),
    t.db.prepare(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES (?,?, 'quote_form', 'accepted', ?, ?)`).bind(ld, ct, nowIso(), nowIso()),
    t.db.prepare(`INSERT INTO quotes (id, lead_id, status, current_version, created_by, created_at) VALUES (?,?, 'accepted', 1, ?, ?)`).bind(q, ld, userId, nowIso()),
    t.db.prepare(`INSERT INTO quote_versions (id, quote_id, version, line_items_json, total_cents, payment_schedule, scope_text, package_id, accepted_at, created_at) VALUES (?,?,1,'[]', 600000, 'milestone_50_25_25', 'Custom portal with admin area', 'custom', ?, ?)`).bind(v, q, nowIso(), nowIso()),
  ]);
  return { ...(await createQuoteOrder(t.db, organizationId, { id: v, total_cents: 600_000, payment_schedule: "milestone_50_25_25", quote_id: q, package_id: "custom" }, null, userId)), quoteVersionId: v };
}

test("[SALES-004] [PAY-005] a package order made before intakes existed is paid only after its intake: same order, same invoice, no project before payment; one project after", async () => {
  const t = await app();
  const b = await buyer(t, "legacy@enforcement.example");
  const legacy = await createPackageOrder(t.db, b.organizationId, "business", b.id); // unpaid, no intake (pre-0089 order)
  // Refused by the shared rule (service) and by the route, with no Stripe session.
  await assert.rejects(startInvoiceCheckout(await ctxFor(t, b.c), { id: b.id, email: b.email }, b.organizationId, legacy.invoiceId), /Complete the website intake/);
  assert.equal(loc(await b.c.post(`/portal/billing/invoices/${legacy.invoiceId}/pay`)), `/portal/billing/invoices/${legacy.invoiceId}/intake`);
  assert.equal(t.fake.checkouts.length, 0);
  assert.match(await (await b.c.get(`/portal/billing/invoices/${legacy.invoiceId}`)).text(), /data-testid="invoice-intake-required"/);
  assert.match(await (await b.c.get("/portal/billing")).text(), new RegExp(`href="/portal/billing/invoices/${legacy.invoiceId}/intake"`));
  // The invoice's intake is the package's intake (the package selection is kept): Business questions, no Premium ones.
  const form = await (await b.c.get(`/portal/billing/invoices/${legacy.invoiceId}/intake`)).text();
  assert.match(form, /name="pages"/);
  assert.doesNotMatch(form, /name="advanced_features"/);
  await b.c.post(`/portal/billing/invoices/${legacy.invoiceId}/intake`, { intent: "draft", business_name: "Legacy Draft Co" });
  assert.equal(loc(await b.c.post(`/portal/billing/invoices/${legacy.invoiceId}/pay`)), `/portal/billing/invoices/${legacy.invoiceId}/intake`, "a draft is not enough");
  const done = await b.c.post(`/portal/billing/invoices/${legacy.invoiceId}/intake`, { ...INTAKE_ANSWERS, intent: "submit" });
  assert.equal(loc(done), `/portal/billing/invoices/${legacy.invoiceId}`);
  assert.equal(loc(await b.c.get("/checkout/business")), "/checkout/business/review", "the same open package intake serves the package checkout");
  assert.equal(await count(t, `SELECT 1 FROM projects`), 0, "no project before payment");
  // Now the SAME invoice is paid: no second order, the intake records the legacy order.
  const pay = await b.c.post(`/portal/billing/invoices/${legacy.invoiceId}/pay`);
  assert.match(loc(pay)!, /^https:\/\/checkout\.stripe\.com\//);
  const co = t.fake.checkouts[0];
  const intake = await one<{ id: string; order_id: string; product_id: string }>(t, `SELECT id, order_id, product_id FROM purchase_intakes WHERE organization_id = ?`, b.organizationId);
  assert.deepEqual({ inv: co.metadata.invoice_id, order: co.metadata.order_id, intake: co.metadata.intake_id }, { inv: legacy.invoiceId, order: legacy.orderId, intake: intake.id });
  assert.deepEqual({ order: intake.order_id, product: intake.product_id }, { order: legacy.orderId, product: "business" });
  assert.equal(await count(t, `SELECT 1 FROM orders WHERE organization_id = ?`, b.organizationId), 1, "no duplicate order");
  // Failed and expired sessions start nothing.
  await webhook(t, "checkout.session.async_payment_failed", { id: "cs_failed", object: "checkout.session", mode: "payment", payment_status: "unpaid", metadata: co.metadata });
  assert.equal(await count(t, `SELECT 1 FROM projects`), 0);
  // Paid: exactly one project, with the intake, however often Stripe delivers.
  const evt = paid(co, "pi_legacy_paid");
  await webhook(t, "checkout.session.completed", evt, "evt_legacy_paid");
  await webhook(t, "checkout.session.completed", evt, "evt_legacy_paid");
  await webhook(t, "checkout.session.completed", evt, "evt_legacy_paid_again");
  const projects = (await t.db.prepare(`SELECT id, status FROM projects WHERE order_id = ?`).bind(legacy.orderId).all<{ id: string; status: string }>()).results;
  assert.equal(projects.length, 1);
  assert.equal(projects[0].status, "scope_review");
  const linked = await one<{ project_id: string }>(t, `SELECT project_id FROM purchase_intakes WHERE id = ?`, intake.id);
  const invProject = await one<{ project_id: string }>(t, `SELECT project_id FROM invoices WHERE id = ?`, legacy.invoiceId);
  assert.equal(linked.project_id, projects[0].id, "intake and payment belong to the same project");
  assert.equal(invProject.project_id, projects[0].id);
  assert.equal(await count(t, `SELECT 1 FROM payments WHERE invoice_id = ?`, legacy.invoiceId), 1, "charged once");
});

test("[PAY-005] already-paid orders and their projects stay valid: the rule never applies to a paid invoice or touches its project", async () => {
  const t = await app();
  const b = await buyer(t, "paid-before@enforcement.example");
  const o = await createPackageOrder(t.db, b.organizationId, "starter", b.id);
  await markInvoicePaid(t.db, o.invoiceId, { amountCents: o.amountCents, paymentIntentId: "pi_paid_before", feeCents: null });
  const p = await provisionProjectOnce(t.db, o.orderId);
  const before = await one<{ status: string; updated_at: string }>(t, `SELECT status, updated_at FROM projects WHERE id = ?`, p.projectId);
  assert.equal(before.status, "awaiting_onboarding", "a historical project keeps the post-payment onboarding");
  assert.deepEqual(await requireIntakeForPayment(t.db, o.invoiceId), { required: false, intakeId: null });
  assert.equal((await invoicesNeedingIntake(t.db, b.organizationId)).size, 0);
  await webhook(t, "checkout.session.completed", { id: "cs_replay", object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: o.amountCents, payment_intent: "pi_paid_before", metadata: { organization_id: b.organizationId, invoice_id: o.invoiceId, order_id: o.orderId, kind: "package" } });
  assert.equal(await count(t, `SELECT 1 FROM projects WHERE order_id = ?`, o.orderId), 1);
  assert.deepEqual(await one<{ status: string; updated_at: string }>(t, `SELECT status, updated_at FROM projects WHERE id = ?`, p.projectId), before);
  assert.equal((await b.c.get(`/portal/projects/${p.projectId}/onboarding`)).status, 200, "its onboarding still works");
});

test("[PAY-006] Stripe-hosted quote invoices: no payable deposit is issued before the intake; later milestones follow the milestone rules; issued ones are listed for staff, never changed", async () => {
  const t = await app();
  const b = await buyer(t, "hosted@enforcement.example");
  const q = await acceptedQuote(t, b.organizationId, b.id);
  // Pre-issuance control: refused before any Stripe call; the staff page says why.
  await assert.rejects(createStripeMilestoneInvoice(t.db, t.env, t.owner.id, q.invoiceId), /Complete the website intake/);
  const refused = await t.oc.post(`/staff/finance/invoices/${q.invoiceId}/stripe-invoice`);
  assert.equal(refused.status, 409);
  assert.equal(t.stripeCalls.length, 0, "nothing was sent to Stripe");
  assert.match(await (await t.oc.get(`/staff/finance/invoices/${q.invoiceId}`)).text(), /has not completed the website intake/);
  assert.equal((await one<{ stripe_invoice_id: string | null }>(t, `SELECT stripe_invoice_id FROM invoices WHERE id = ?`, q.invoiceId)).stripe_invoice_id, null);
  // After the intake the same request reaches Stripe (the FIXTURE answers with an error, so nothing is issued).
  await completeQuoteIntake(b.c, q.invoiceId);
  await assert.rejects(createStripeMilestoneInvoice(t.db, t.env, t.owner.id, q.invoiceId), /Stripe invoice was not completed/);
  assert.ok(t.stripeCalls.length > 0, "the intake rule let the request through");
  // A later 25% milestone on an order without an intake is not newly blocked by the intake rule.
  const q2 = await acceptedQuote(t, b.organizationId, b.id);
  const ms = newId("inv");
  await t.db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, description, created_at) VALUES (?,?,?, 'design_25', 150000, 'open', '25% on approved design', ?)`).bind(ms, b.organizationId, q2.orderId, nowIso()).run();
  assert.deepEqual(await requireIntakeForPayment(t.db, ms), { required: false, intakeId: null });
  const calls = t.stripeCalls.length;
  await assert.rejects(createStripeMilestoneInvoice(t.db, t.env, t.owner.id, ms), /Stripe invoice was not completed/);
  assert.ok(t.stripeCalls.length > calls, "the milestone reaches Stripe");
  // An unpaid Stripe-hosted deposit issued before the rule (no intake): listed for manual remediation, never changed.
  const hostedUrl = "https://invoice.stripe.com/i/acct_test/in_legacy_1";
  await t.db.prepare(`UPDATE invoices SET stripe_invoice_id = 'in_legacy_1', stripe_invoice_status = 'open', stripe_invoice_number = 'CRST-LEGACY-1', stripe_hosted_invoice_url = ? WHERE id = ?`).bind(hostedUrl, q2.invoiceId).run();
  const snapshot = async () => one<Record<string, unknown>>(t, `SELECT status, stripe_invoice_id, stripe_invoice_status, stripe_hosted_invoice_url, amount_cents FROM invoices WHERE id = ?`, q2.invoiceId);
  const before = await snapshot();
  const report = await (await t.oc.get("/staff/finance/invoices")).text();
  const section = report.slice(report.indexOf('data-testid="stripe-invoices-missing-intake"'));
  assert.match(section, new RegExp(q2.invoiceId));
  assert.match(section, /CRST-LEGACY-1/);
  assert.doesNotMatch(section, new RegExp(q.invoiceId), "an invoice whose intake is complete is not listed");
  assert.match(section, /nothing is voided or changed automatically/);
  // Re-sending it is refused; the customer is offered the intake, not the hosted link; the invoice is untouched.
  const sends = t.stripeCalls.length;
  assert.equal((await t.oc.post(`/staff/finance/invoices/${q2.invoiceId}/stripe-invoice`)).status, 409);
  assert.equal(t.stripeCalls.length, sends);
  const custPage = await (await b.c.get(`/portal/billing/invoices/${q2.invoiceId}`)).text();
  assert.match(custPage, /data-testid="invoice-intake-required"/);
  assert.equal(custPage.split(hostedUrl).length, 1, "the hosted link is not offered before the intake");
  assert.deepEqual(await snapshot(), before);
  // Once the customer completes that intake it leaves the list and the hosted link is offered again.
  await completeQuoteIntake(b.c, q2.invoiceId);
  const after = await (await t.oc.get("/staff/finance/invoices")).text();
  assert.doesNotMatch(after.slice(after.indexOf('data-testid="stripe-invoices-missing-intake"')), new RegExp(q2.invoiceId));
  assert.ok((await (await b.c.get(`/portal/billing/invoices/${q2.invoiceId}`)).text()).includes(`href="${hostedUrl}"`), "the existing hosted invoice is payable again, unchanged");
  assert.deepEqual(await snapshot(), before);
});

test("[AIB-019] the payment simulation obeys the same rule: missing intake rejected, complete intake accepted on the right order, duplicates refused, no unauthorised build", async () => {
  const t = await app({ STRIPE_SECRET_KEY: undefined });
  const ctx = { db: t.db, env: t.env, email: undefined as never, baseUrl: "http://crestmont.test" };
  const cu = await createCustomer(t.db, `sim${Date.now()}@sim.test`, "Simulation Intake Org");
  await SIM.markTestOrganization(t, t.owner.id, cu.organizationId, true, "Simulation Intake Org");
  const order = await createPackageOrder(t.db, cu.organizationId, "business", cu.id);
  // Missing intake: rejected and recorded as such; nothing paid, provisioned or built.
  const r1 = await SIM.deliverSimulatedEvent(ctx, t.owner.id, await SIM.createSimulatedEvent(t.db, t.env, order.invoiceId, { correlationId: "corr_no_intake" }));
  assert.equal(r1.outcome, "rejected");
  assert.match(r1.reason!, /website intake not completed/);
  assert.equal(await count(t, `SELECT 1 FROM payments WHERE invoice_id = ?`, order.invoiceId), 0);
  assert.equal(await count(t, `SELECT 1 FROM projects`), 0);
  assert.equal(await count(t, `SELECT 1 FROM build_jobs`), 0, "no build without the intake");
  // The staff route reports the refusal too.
  const refused = await t.oc.post("/staff/test-payments/simulate", { invoice_id: order.invoiceId, outcome: "paid" });
  assert.match(decodeURIComponent(refused.headers.getSetCookie().find((c) => c.startsWith("cm_flash=") && !c.startsWith("cm_flash=;")) ?? ""), /website intake not completed/);
  // An intake for a different package does not count.
  await seedCompletedIntake(t.db, cu.organizationId, { productId: "starter" }, cu.id);
  assert.equal((await SIM.deliverSimulatedEvent(ctx, t.owner.id, await SIM.createSimulatedEvent(t.db, t.env, order.invoiceId, { correlationId: "corr_other_pkg" }))).outcome, "rejected");
  // Complete intake for the order's package: applied on exactly this order.
  const intakeId = await seedCompletedIntake(t.db, cu.organizationId, { productId: "business" }, cu.id);
  const ok = await SIM.deliverSimulatedEvent(ctx, t.owner.id, await SIM.createSimulatedEvent(t.db, t.env, order.invoiceId, { correlationId: "corr_with_intake" }));
  assert.equal(ok.outcome, "applied", ok.reason ?? "");
  const project = await one<{ id: string; order_id: string; status: string }>(t, `SELECT id, order_id, status FROM projects WHERE id = ?`, ok.projectId);
  assert.deepEqual({ order: project.order_id, status: project.status }, { order: order.orderId, status: "scope_review" });
  assert.equal((await one<{ project_id: string }>(t, `SELECT project_id FROM purchase_intakes WHERE id = ?`, intakeId)).project_id, project.id, "the order's intake moved to its project");
  assert.equal((await one<{ project_id: string | null }>(t, `SELECT project_id FROM purchase_intakes WHERE organization_id = ? AND product_id = 'starter'`, cu.organizationId)).project_id, null, "the other package's intake is untouched");
  // Duplicate simulated payment: refused, still one payment and one project.
  const dup = await SIM.deliverSimulatedEvent(ctx, t.owner.id, await SIM.createSimulatedEvent(t.db, t.env, order.invoiceId, { correlationId: "corr_second" }));
  assert.equal(dup.outcome, "duplicate_order");
  assert.equal(await count(t, `SELECT 1 FROM payments WHERE invoice_id = ?`, order.invoiceId), 1);
  assert.equal(await count(t, `SELECT 1 FROM projects WHERE order_id = ?`, order.orderId), 1);
  // Builds: at most the one first build of the paid project (marked test org, intake + payment); nothing elsewhere.
  const jobs = (await t.db.prepare(`SELECT project_id FROM build_jobs`).all<{ project_id: string }>()).results;
  assert.ok(jobs.length <= 1 && jobs.every((j) => j.project_id === project.id), `only the paid project can have a build (${JSON.stringify(jobs)})`);
  // An unmarked (real) organization can never be paid by simulation, intake or not.
  const real = await createCustomer(t.db, `real${Date.now()}@sim.test`, "Real Org");
  const ro = await createPackageOrder(t.db, real.organizationId, "starter", real.id);
  await seedCompletedIntake(t.db, real.organizationId, { productId: "starter" }, real.id);
  const rr = await SIM.deliverSimulatedEvent(ctx, t.owner.id, await SIM.createSimulatedEvent(t.db, t.env, ro.invoiceId, { correlationId: "corr_real" }));
  assert.equal(rr.outcome, "rejected");
  assert.match(rr.reason!, /not a marked test organization/);
  assert.equal(await count(t, `SELECT 1 FROM build_jobs WHERE organization_id = ?`, real.organizationId), 0);
});

test("[PAY-003] quote deposit via Stripe Checkout: the session links the intake; failed/expired sessions start nothing; one project per order however often Stripe delivers", async () => {
  const t = await app();
  const b = await buyer(t, "quote-hook@enforcement.example");
  const q = await acceptedQuote(t, b.organizationId, b.id);
  await completeQuoteIntake(b.c, q.invoiceId);
  await b.c.post(`/portal/billing/invoices/${q.invoiceId}/pay`);
  const co = t.fake.checkouts[0];
  const intake = await one<{ id: string }>(t, `SELECT id FROM purchase_intakes WHERE quote_version_id = ?`, q.quoteVersionId);
  assert.equal(co.metadata.intake_id, intake.id);
  const sess = (await one<{ stripe_checkout_session_id: string }>(t, `SELECT stripe_checkout_session_id FROM invoices WHERE id = ?`, q.invoiceId)).stripe_checkout_session_id;
  await webhook(t, "checkout.session.expired", { id: sess, object: "checkout.session", status: "expired", metadata: co.metadata });
  assert.equal(await count(t, `SELECT 1 FROM projects`), 0, "an expired session provisions nothing");
  // A quote deposit is not voided on expiry (CREST-GAP-036 applies to package invoices): pay again with a new session.
  await b.c.post(`/portal/billing/invoices/${q.invoiceId}/pay`);
  const co2 = t.fake.checkouts.at(-1)!;
  const evt = paid(co2, "pi_quote_hook");
  for (const id of ["evt_q1", "evt_q1", "evt_q2"]) await webhook(t, "checkout.session.completed", evt, id);
  const projects = (await t.db.prepare(`SELECT id FROM projects WHERE order_id = ?`).bind(q.orderId).all<{ id: string }>()).results;
  assert.equal(projects.length, 1);
  assert.equal((await one<{ project_id: string }>(t, `SELECT project_id FROM purchase_intakes WHERE id = ?`, intake.id)).project_id, projects[0].id);
  assert.equal((await one<{ project_id: string }>(t, `SELECT project_id FROM invoices WHERE id = ?`, q.invoiceId)).project_id, projects[0].id);
});
