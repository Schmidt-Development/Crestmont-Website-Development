// Founder E2E benchmark (2026-10-30): "$2,500 simulated customer purchase + real autonomous website build".
// The ONLY simulated component in this file is the payment provider (src/services/payment-simulation.ts): Stripe is
// not configured. Every other step goes through the real request pipeline and routes (tests/support/app.ts runs
// src/app/app.ts on the real migrations, in-memory SQLite). The test stops at dispatch to the GPU worker: no model
// is called and no build result is produced here — the real build needs Node 1 (docs/ai-builds/E2E-BENCHMARK.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, lastEmail, linkFrom, MemoryStorage, TEST_PASSWORD } from "./support/app.ts";
import { createPackageOrder } from "../src/services/commerce.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import * as B from "../src/services/builds.ts";
import * as W from "../src/services/build-workers.ts";
import * as SIM from "../src/services/payment-simulation.ts";
import { releaseBlockers } from "../src/services/site-delivery.ts";
import { markInvoicePaid } from "../src/services/commerce.ts";
import { releaseReadiness, saveHandoff } from "../src/services/projects.ts";
import { financeDashboard } from "../src/services/finance.ts";
import { loadReceipt } from "../src/services/receipts.ts";
import { customerBilling } from "../src/services/billing.ts";
import { STEP_UP_ROUTES } from "../src/app/step-up.ts";
import { JUNK_IN_THE_TRUNK as JT } from "./fixtures/junk-in-the-trunk.ts";
import type { Env } from "../src/app/context.ts";

const RUNNER_SECRET = "test-runner-secret";
const future = (days = 30) => new Date(Date.now() + days * 86400e3).toISOString().slice(0, 10);
type T = Awaited<ReturnType<typeof createTestApp>>;
const one = async <R>(t: T, sql: string, ...b: unknown[]) => (await t.db.prepare(sql).bind(...b).first<R>())!;
const count = async (t: T, sql: string, ...b: unknown[]) => (await one<{ n: number }>(t, `SELECT COUNT(*) AS n FROM (${sql})`, ...b)).n;
const flash = (res: Response) => {
  // The response may clear the previous flash and set a new one; the non-empty one is the new message.
  const c = res.headers.getSetCookie().filter((x) => x.startsWith("cm_flash=") && !x.startsWith("cm_flash=;")).pop();
  return c ? JSON.parse(decodeURIComponent(c.split(";")[0].slice("cm_flash=".length))) as { kind: string; text: string } : null;
};

async function app(extra: Partial<Env> = {}) {
  // No STRIPE_SECRET_KEY and no payments override: exactly today's state (Stripe not configured).
  const t = await createTestApp({ BUILD_RUNNER_SECRET: RUNNER_SECRET, PAYMENT_SIMULATION_ENABLED: "true", overrides: { storage: new MemoryStorage() }, ...extra });
  const owner = await createStaff(t.db, "owner", "owner@crestmont.test");
  const oc = await t.client().login(owner.email, undefined, owner.secret);
  return { ...t, owner, oc };
}
async function runner(t: T, path: string, body: unknown) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const res = await t.client().request("POST", `/api/builds/runner/${path}`, { body: raw, headers: { "content-type": "application/json", "x-crestmont-runner-signature": `t=${ts},v1=${await hmacSha256Hex(RUNNER_SECRET, `${ts}.${raw}`)}` } });
  return { status: res.status, json: await res.json() as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

test("[AIB-020] [AIB-019] Junk in the Trunk: lead → $2,500 quote → sign-up → acceptance → SIMULATED payment → real onboarding → one queued build → dispatched to the GPU worker (stops before inference)", async () => {
  const t = await app();

  // ── Lead: a visitor submits the public quote form ──
  const visitor = t.client();
  const lead = await visitor.post("/quote", { name: JT.lead.name, email: JT.email, phone: JT.lead.phone, company: JT.business, website: "", interest: JT.lead.interest, budget: JT.lead.budget, timeline: JT.lead.timeline, message: JT.lead.message });
  assert.equal(lead.status, 303, await lead.clone().text());
  const leadId = (await one<{ id: string }>(t, `SELECT l.id FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE c.email = ?`, JT.email)).id;

  // ── Quote: the Owner prices the internal $2,500 package as a custom quote and sends it ──
  for (const to of ["qualified", "quote_required"]) assert.equal((await t.oc.post(`/staff/crm/leads/${leadId}/stage`, { to })).status, 303);
  const save = await t.oc.post(`/staff/quotes/new?lead=${leadId}`, { package: JT.quote.package, line_desc: [JT.quote.lineDescription], line_amount: [JT.quote.lineAmount], scope: JT.quote.scope, valid_until: future() });
  assert.equal(save.status, 303, await save.clone().text());
  const quoteId = save.headers.get("location")!.split("/").pop()!;
  const qv = await one<{ total_cents: number; payment_schedule: string }>(t, `SELECT total_cents, payment_schedule FROM quote_versions WHERE quote_id = ?`, quoteId);
  assert.deepEqual({ ...qv }, { total_cents: 250_000, payment_schedule: "milestone_50_25_25" }, "exactly $2,500.00; custom quotes are 50/25/25 (CAT-004)");
  assert.equal((await t.oc.post(`/staff/quotes/${quoteId}/send`)).status, 303);
  const qpath = linkFrom((await lastEmail(t.db, JT.email))!.text_body, "/q/");

  // ── Customer: registers with the quoted address, confirms it, accepts the proposal ──
  const cust = t.client();
  assert.equal((await cust.post("/register", { name: JT.lead.name, organization: JT.business, email: JT.email, password: TEST_PASSWORD, terms: "1" })).status, 200);
  await cust.get(linkFrom((await lastEmail(t.db, JT.email))!.text_body, "/verify-email"));
  await cust.login(JT.email);
  await cust.enrolMfa(qpath); // FD-30: a customer administrator enrols two-factor authentication before accepting
  const accept = await cust.post(`${qpath}/accept`, { agree: "1" });
  assert.equal(accept.status, 303, await accept.clone().text());
  const invoicePath = accept.headers.get("location")!;
  const invoiceId = invoicePath.split("/").pop()!;
  const user = await one<{ id: string; organization_id: string }>(t, `SELECT u.id, m.organization_id FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.email = ? AND m.role_id = 'customer_admin'`, JT.email);
  const order = await one<{ id: string; total_cents: number; status: string; organization_id: string; quote_version_id: string; lead_id: string }>(t, `SELECT id, total_cents, status, organization_id, quote_version_id, lead_id FROM orders WHERE lead_id = ?`, leadId);
  assert.deepEqual({ total: order.total_cents, status: order.status, org: order.organization_id, lead: order.lead_id }, { total: 250_000, status: "pending_payment", org: user.organization_id, lead: leadId }, "order belongs to the customer and the lead");
  const inv = await one<{ amount_cents: number; milestone_kind: string; status: string; order_id: string }>(t, `SELECT amount_cents, milestone_kind, status, order_id FROM invoices WHERE id = ?`, invoiceId);
  assert.deepEqual({ ...inv }, { amount_cents: JT.quote.depositCents, milestone_kind: "deposit_50", status: "open", order_id: order.id });
  assert.equal((await one<{ organization_id: string }>(t, `SELECT co.organization_id FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.email = ?`, JT.email)).organization_id, user.organization_id, "CRM company matched to the customer organization");
  assert.equal(await count(t, `SELECT 1 FROM organizations WHERE name = ? AND kind = 'customer'`, JT.business), 1, "one customer record");

  // ── Real checkout: unavailable, because Stripe is not configured (nothing is simulated on this path) ──
  const pay = await cust.post(`${invoicePath}/pay`);
  const payLocation = pay.headers.get("location");
  const payHost = payLocation ? new URL(payLocation, "http://crestmont.test").hostname : null;
  assert.ok(payHost === null || (payHost !== "stripe.com" && !payHost.endsWith(".stripe.com")), "no Stripe checkout exists");
  assert.equal(inv.status, "open");

  // ── Simulated payment: refused for an unmarked organization, then the Owner marks the fictional org ──
  const refused = await t.oc.post("/staff/test-payments/simulate", { invoice_id: invoiceId, outcome: "paid" });
  assert.equal(flash(refused)?.kind, "error");
  assert.match(flash(refused)!.text, /not a marked test organization/);
  assert.equal(await count(t, `SELECT 1 FROM payments WHERE invoice_id = ?`, invoiceId), 0);
  assert.equal(flash(await t.oc.post(`/staff/test-payments/organizations/${user.organization_id}/mark`, { mark: "1", confirm: JT.business }))?.kind, "success");
  const page = await (await t.oc.get("/staff/test-payments")).text();
  assert.match(page, /No real transaction happens here/);
  assert.match(page, /Test organization/);

  const paid = await t.oc.post("/staff/test-payments/simulate", { invoice_id: invoiceId, outcome: "paid" });
  assert.equal(flash(paid)?.kind, "success", flash(paid)?.text ?? "");
  const evt = await one<{ id: string; transaction_id: string; amount_cents: number; currency: string; payment_status: string; outcome: string; environment: string; correlation_id: string; customer_id: string; package_id: string; order_id: string }>(t,
    `SELECT * FROM simulated_payment_events WHERE invoice_id = ? AND outcome = 'applied'`, invoiceId);
  assert.match(evt.id, /^evt_sim_[0-9a-f]{24}$/);
  assert.match(evt.transaction_id, /^txn_sim_[0-9a-f]{24}$/);
  assert.match(evt.correlation_id, /^corr_/);
  assert.deepEqual({ amount: evt.amount_cents, currency: evt.currency, status: evt.payment_status, env: evt.environment, customer: evt.customer_id, pkg: evt.package_id, order: evt.order_id },
    { amount: JT.quote.depositCents, currency: "usd", status: "SIMULATED_PAID", env: "development", customer: user.id, pkg: `quote_version:${order.quote_version_id}`, order: order.id });

  // Downstream is the real workflow: invoice paid, project provisioned, lead converted, build record created.
  const payment = await one<{ provider: string; amount_cents: number; stripe_payment_intent_id: string | null; simulated_transaction_id: string }>(t, `SELECT provider, amount_cents, stripe_payment_intent_id, simulated_transaction_id FROM payments WHERE invoice_id = ?`, invoiceId);
  assert.deepEqual({ ...payment }, { provider: "simulated", amount_cents: JT.quote.depositCents, stripe_payment_intent_id: null, simulated_transaction_id: evt.transaction_id });
  assert.equal((await one<{ status: string }>(t, `SELECT status FROM orders WHERE id = ?`, order.id)).status, "partially_paid", "deposit paid; the 25% milestones follow later under CAT-004");
  const project = await one<{ id: string; status: string; organization_id: string; payment_schedule: string; product_id: string | null }>(t, `SELECT id, status, organization_id, payment_schedule, product_id FROM projects WHERE order_id = ?`, order.id);
  assert.deepEqual({ status: project.status, org: project.organization_id, schedule: project.payment_schedule }, { status: "awaiting_onboarding", org: user.organization_id, schedule: "milestone_50_25_25" });
  assert.equal((await one<{ stage: string }>(t, `SELECT stage FROM leads WHERE id = ?`, leadId)).stage, "converted");
  assert.match((await one<{ body: string }>(t, `SELECT body FROM crm_activities WHERE lead_id = ? AND body LIKE '%payment confirmed%' COLLATE NOCASE`, leadId)).body, /SIMULATED payment confirmed/);
  assert.equal(await count(t, `SELECT 1 FROM email_deliveries WHERE to_email = ? AND template = 'receipt'`, JT.email), 0, "no receipt for a simulated payment");
  assert.equal((await B.getJob(t.db, (await one<{ id: string }>(t, `SELECT id FROM build_jobs WHERE project_id = ?`, project.id)).id))!.state, "awaiting_intake");

  // Duplicate order protection: a second simulation for the same invoice records no second payment.
  const again = await t.oc.post("/staff/test-payments/simulate", { invoice_id: invoiceId, outcome: "paid" });
  assert.match(flash(again)!.text, /duplicate_order/);
  assert.equal(await count(t, `SELECT 1 FROM payments WHERE order_id = ?`, order.id), 1);
  assert.equal(await count(t, `SELECT 1 FROM projects WHERE order_id = ?`, order.id), 1);

  // ── Onboarding: the customer submits the real intake form ──
  assert.equal((await cust.get(`/portal/projects/${project.id}/onboarding`)).status, 200);
  const intake = await cust.post(`/portal/projects/${project.id}/onboarding`, { ...JT.intake, functionality: [...JT.intake.functionality] });
  assert.equal(intake.status, 303, await intake.clone().text());
  const ob = await one<{ completed_at: string | null; answers_json: string }>(t, `SELECT completed_at, answers_json FROM onboarding_responses WHERE project_id = ?`, project.id);
  assert.ok(ob.completed_at, "onboarding saved and completed through validation");
  assert.equal(JSON.parse(ob.answers_json).colors, JT.intake.colors);
  // Re-submission does not create more work.
  await cust.post(`/portal/projects/${project.id}/onboarding`, { ...JT.intake, functionality: [...JT.intake.functionality] });
  const jobs = (await t.db.prepare(`SELECT * FROM build_jobs WHERE project_id = ?`).bind(project.id).all<B.BuildJob>()).results;
  assert.equal(jobs.length, 1, "exactly one build per project");
  const job = jobs[0];
  assert.equal(job.state, "queued", "eligible: verified (simulated, test-organization) payment and submitted intake");
  assert.equal(job.strategy, "custom");
  const brief = JSON.parse((await one<{ content_json: string }>(t, `SELECT content_json FROM build_briefs WHERE id = ?`, job.brief_id)).content_json);
  assert.deepEqual(brief.customerData.pages, [...JT.requiredPages], "all seven pages, none over a limit");
  assert.match(brief.custom.scope, /quote-request flow/);
  const reqs = (await t.db.prepare(`SELECT key FROM build_requirements WHERE job_id = ?`).bind(job.id).all<{ key: string }>()).results.map((r) => r.key);
  assert.equal(reqs.filter((k) => k.startsWith("page:")).length, 7);
  assert.ok(reqs.includes("feature:contact-form"));
  assert.deepEqual(B.decideEligibility(await B.projectFacts(t.db, project.id)), { verdict: "queued", reasons: ["verified payment and submitted intake"] });

  // ── Dispatch: the registered GPU worker (Node 1) claims it through the signed runner protocol ──
  // No GPU telemetry is reported here: the real worker reports it from nvidia-smi on Node 1.
  const w = await W.registerWorker({ db: t.db, userId: t.owner.id }, { label: "Node 1 RTX 5090", maxActiveProjects: 1 });
  const claim = await runner(t, "claim", { runnerId: "node1-e2e", capabilities: ["local-model", "container-sandbox", "zero-token-cost", "git", "dual-model"], workerId: w.id, workerKey: w.enrollmentKey, workerStatus: {} });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  assert.equal(claim.json.job.id, job.id);
  assert.equal(claim.json.job.brief.content.schema, "crestmont.build-brief/1");
  assert.equal(claim.json.job.worker.maxActiveProjects, 1);
  assert.ok(await t.db.prepare(`SELECT 1 FROM build_assignments WHERE project_id = ? AND worker_id = ? AND released_at IS NULL`).bind(project.id, w.id).first(), "project assigned to the GPU worker");
  // Nothing further happens here: the build itself is Phase 3 on Node 1 (real models), not a fixture.
});

/** A fresh fictional test organization with an open invoice, for the adapter checks. */
async function testInvoice(t: Awaited<ReturnType<typeof app>>, name = "Adapter Test Org", mark = true) {
  const cu = await createCustomer(t.db, `adapter${Math.random().toString(16).slice(2, 8)}@adapter.test`, name);
  const order = await createPackageOrder(t.db, cu.organizationId, "starter", cu.id);
  if (mark) await SIM.markTestOrganization(t, t.owner.id, cu.organizationId, true, name);
  return { cu, order };
}

test("[AIB-019] simulated payment adapter: success, duplicate delivery, duplicate order, wrong amount, wrong currency, failed payment, replays, forged events", async () => {
  const t = await app();
  const ctx = { db: t.db, env: t.env, email: undefined as never, baseUrl: "http://crestmont.test" };
  const deliver = (e: SIM.SimulatedPaymentEvent, now?: Date) => SIM.deliverSimulatedEvent(ctx, t.owner.id, e, now);
  const make = (invoiceId: string, o: Partial<Parameters<typeof SIM.createSimulatedEvent>[3]> = {}) => SIM.createSimulatedEvent(t.db, t.env, invoiceId, { correlationId: "corr_adapter", ...o });
  const paidCount = async (invoiceId: string) => count(t, `SELECT 1 FROM payments WHERE invoice_id = ?`, invoiceId);
  const invStatus = async (id: string) => (await one<{ status: string }>(t, `SELECT status FROM invoices WHERE id = ?`, id)).status;

  // Incorrect amount (the $2,500 order total against a smaller first invoice) and incorrect currency: rejected, nothing unlocked.
  const a = await testInvoice(t);
  let r = await deliver(await make(a.order.invoiceId, { amountCents: 250_000 }));
  assert.equal(r.outcome, "rejected"); assert.match(r.reason!, /incorrect amount: 250000 cents, invoice is 99900 cents/);
  r = await deliver(await make(a.order.invoiceId, { currency: "eur" }));
  assert.equal(r.outcome, "rejected"); assert.match(r.reason!, /incorrect currency: eur/);
  // Failed payment: recorded, nothing unlocked.
  r = await deliver(await make(a.order.invoiceId, { paymentStatus: SIM.SIMULATED_FAILED }));
  assert.equal(r.outcome, "failed_payment");
  // Unknown status: rejected.
  r = await deliver(await make(a.order.invoiceId, { paymentStatus: "PAID" }));
  assert.equal(r.outcome, "rejected");
  assert.equal(await invStatus(a.order.invoiceId), "open");
  assert.equal(await paidCount(a.order.invoiceId), 0);
  assert.equal(await count(t, `SELECT 1 FROM projects WHERE order_id = ?`, a.order.orderId), 0);

  // Success.
  const good = await make(a.order.invoiceId);
  r = await deliver(good);
  assert.equal(r.outcome, "applied");
  assert.ok(r.projectId);
  assert.equal(await invStatus(a.order.invoiceId), "paid");
  // Deterministic adapter: the same inputs give the same event, so it is a duplicate delivery, never a second payment.
  assert.equal((await make(a.order.invoiceId)).id, good.id);
  r = await deliver(good);
  assert.deepEqual({ dup: r.duplicateDelivery, outcome: r.outcome }, { dup: true, outcome: "applied" });
  // Duplicate order: a new, valid event for the paid invoice.
  r = await deliver(await make(a.order.invoiceId, { correlationId: "corr_second_attempt" }));
  assert.equal(r.outcome, "duplicate_order");
  assert.equal(await paidCount(a.order.invoiceId), 1);
  assert.equal(await count(t, `SELECT 1 FROM projects WHERE order_id = ?`, a.order.orderId), 1);

  // Replays: an old event (outside 5 minutes), and a captured transaction re-sent under a new event id.
  const b = await testInvoice(t, "Replay Test Org");
  r = await deliver(await make(b.order.invoiceId, { now: new Date(Date.now() - 10 * 60e3) }));
  assert.equal(r.outcome, "rejected"); assert.match(r.reason!, /stale or replayed/);
  const first = await make(b.order.invoiceId, { correlationId: "corr_replay", paymentStatus: SIM.SIMULATED_FAILED });
  await deliver(first);
  r = await deliver({ ...first, id: "evt_sim_" + "a".repeat(24), paymentStatus: SIM.SIMULATED_PAID });
  assert.equal(r.outcome, "rejected"); assert.match(r.reason!, /replayed transaction/);
  // Forged or mismatched events.
  const ok = await make(b.order.invoiceId, { correlationId: "corr_forge" });
  for (const [forged, why] of [
    [{ ...ok, simulated: false as unknown as true }, /not a simulated-payment event/],
    [{ ...ok, id: "evt_live_123" }, /malformed/],
    [{ ...ok, environment: "production" }, /environment "production"/],
    [{ ...ok, orderId: a.order.orderId }, /does not belong to that order/],
    [{ ...ok, packageId: "premium" }, /package does not match/],
    [{ ...ok, customerId: a.cu.id }, /not an administrator/],
  ] as const) {
    const res = await deliver({ ...forged, id: forged.id === ok.id ? `evt_sim_${Math.random().toString(16).slice(2, 10).padEnd(24, "0")}` : forged.id, transactionId: `txn_sim_${Math.random().toString(16).slice(2, 10).padEnd(24, "1")}` });
    assert.equal(res.outcome, "rejected", String(why)); assert.match(res.reason!, why);
  }
  assert.equal(await paidCount(b.order.invoiceId), 0);

  // A real customer can never be paid by simulation, nor marked as a test organization once it paid through Stripe.
  const real = await testInvoice(t, "Real Customer Co", false);
  r = await deliver(await make(real.order.invoiceId));
  assert.equal(r.outcome, "rejected"); assert.match(r.reason!, /not a marked test organization/);
  await t.db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, order_id, amount_cents, stripe_payment_intent_id, status, created_at) VALUES ('pay_real', ?, NULL, NULL, 100, 'pi_real_1', 'succeeded', ?)`).bind(real.cu.organizationId, new Date().toISOString()).run();
  await assert.rejects(SIM.markTestOrganization(t, t.owner.id, real.cu.organizationId, true, "Real Customer Co"), /real \(Stripe\) payments/);
  await assert.rejects(SIM.markTestOrganization(t, t.owner.id, b.cu.organizationId, false, "wrong name"), /exact name/);

  // Review fixes. (1) Real money arriving AFTER the mark ends simulation for that organization.
  const late = await testInvoice(t, "Late Real Money Org");
  const second = await createPackageOrder(t.db, late.cu.organizationId, "starter", late.cu.id);
  await t.db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, order_id, amount_cents, stripe_payment_intent_id, status, created_at) VALUES ('pay_late', ?, NULL, NULL, 100, 'pi_late_1', 'succeeded', ?)`).bind(late.cu.organizationId, new Date().toISOString()).run();
  r = await deliver(await make(second.invoiceId));
  assert.equal(r.outcome, "rejected"); assert.match(r.reason!, /real \(Stripe\) payments/);
  // (1) An organization with a member on a real email domain can never be marked.
  const realDomain = await createCustomer(t.db, `owner${Date.now()}@realbusiness.com`, "Real Domain Co");
  await assert.rejects(SIM.markTestOrganization(t, t.owner.id, realDomain.organizationId, true, "Real Domain Co"), /real email domain/);
  // (3) Only open invoices: a void invoice is never "paid".
  const v = await testInvoice(t, "Void Invoice Org");
  await t.db.prepare(`UPDATE invoices SET status = 'void' WHERE id = ?`).bind(v.order.invoiceId).run();
  r = await deliver(await make(v.order.invoiceId));
  assert.equal(r.outcome, "rejected"); assert.match(r.reason!, /invoice is void/);
  assert.equal(await count(t, `SELECT 1 FROM projects WHERE order_id = ?`, v.order.orderId), 0);
  // (2) A real Stripe payment for a simulation-paid invoice is never silently acknowledged (the webhook event fails → reconciliation).
  await assert.rejects(markInvoicePaid(t.db, a.order.invoiceId, { amountCents: 99_900, paymentIntentId: "pi_real_after_sim" }), /SIMULATION: needs manual review/);
  // Concurrency: two different valid events for one fresh invoice at once → one payment.
  const cc = await testInvoice(t, "Concurrent Org");
  const [e1, e2] = await Promise.all([make(cc.order.invoiceId, { correlationId: "corr_c1" }), make(cc.order.invoiceId, { correlationId: "corr_c2" })]);
  const outs = (await Promise.all([deliver(e1), deliver(e2)])).map((x) => x.outcome).sort();
  assert.deepEqual(outs, ["applied", "duplicate_order"]);
  assert.equal(await paidCount(cc.order.invoiceId), 1);

  // Every outcome is in the event log and the audit log.
  for (const o of ["applied", "rejected", "failed_payment", "duplicate_order"]) assert.ok(await count(t, `SELECT 1 FROM simulated_payment_events WHERE outcome = ?`, o) > 0, o);
  assert.ok(await count(t, `SELECT 1 FROM audit_logs WHERE action LIKE 'payments.simulated_%'`) >= 10);
});

test("[AIB-019] unauthorized simulation attempts: production, flag off, non-Owner staff, customers, anonymous; step-up MFA on both actions", async () => {
  assert.equal(STEP_UP_ROUTES["POST /staff/test-payments/simulate"], "simulated test payment");
  assert.equal(STEP_UP_ROUTES["POST /staff/test-payments/organizations/:id/mark"], "marking a fictional test organization");
  for (const env of [{ ENVIRONMENT: "production" as const, PAYMENT_SIMULATION_ENABLED: "true" }, { ENVIRONMENT: "staging" as const }, { ENVIRONMENT: "development" as const, PAYMENT_SIMULATION_ENABLED: "1" }]) {
    assert.throws(() => SIM.assertSimulationAllowed(env), SIM.SimulationDisabled, JSON.stringify(env));
  }
  assert.doesNotThrow(() => SIM.assertSimulationAllowed({ ENVIRONMENT: "staging", PAYMENT_SIMULATION_ENABLED: "true" }));
  // Allow-list: a missing or misspelled environment fails closed.
  for (const bad of [undefined, "Production", "prod", ""]) assert.throws(() => SIM.assertSimulationAllowed({ ENVIRONMENT: bad as never, PAYMENT_SIMULATION_ENABLED: "true" }), SIM.SimulationDisabled);

  const t = await app();
  const { cu, order } = await testInvoice(t, "Unauthorized Test Org");
  const fields = { invoice_id: order.invoiceId, outcome: "paid" };
  for (const role of ["administrator", "sales", "developer", "project_manager", "support"] as const) {
    const s = await createStaff(t.db, role, `${role}@crestmont.test`);
    const c = await t.client().login(s.email, undefined, s.secret);
    assert.equal((await c.post("/staff/test-payments/simulate", fields)).status, 403, role);
    assert.equal((await c.post(`/staff/test-payments/organizations/${cu.organizationId}/mark`, { mark: "0", confirm: "Unauthorized Test Org" })).status, 403, role);
    assert.equal((await c.get("/staff/test-payments")).status, 403, role);
  }
  const customer = await t.client().login(cu.email, TEST_PASSWORD);
  assert.equal((await customer.post("/staff/test-payments/simulate", fields)).status, 403);
  const anon = await t.client().post("/staff/test-payments/simulate", fields);
  assert.equal(anon.status, 303); assert.match(anon.headers.get("location")!, /^\/login/);
  assert.equal(await count(t, `SELECT 1 FROM simulated_payment_events`), 0, "no unauthorized attempt reached the adapter");
  assert.equal(await count(t, `SELECT 1 FROM payments WHERE invoice_id = ?`, order.invoiceId), 0);

  // The Owner, in an environment where simulation is off (e.g. production), is refused before anything is recorded.
  const prod = await app({ ENVIRONMENT: "production", PAYMENT_SIMULATION_ENABLED: "true", APP_URL: "http://crestmont.test" } as Partial<Env>);
  const p = await testInvoice({ ...prod, env: { ...prod.env, ENVIRONMENT: "development" } } as typeof prod, "Prod Test Org", false);
  const res = await prod.oc.post("/staff/test-payments/simulate", { invoice_id: p.order.invoiceId, outcome: "paid" });
  assert.match(flash(res)?.text ?? "", /never available in production/);
  assert.equal(await count(prod as unknown as T, `SELECT 1 FROM simulated_payment_events`), 0);
});

test("[AIB-019] a simulated payment never authorizes real customer fulfillment: unmarking cancels the build; no customer preview; no production release", async () => {
  const t = await app();
  const { cu, order } = await testInvoice(t, "Guard Test Org");
  const r = await SIM.deliverSimulatedEvent({ db: t.db, env: t.env, email: undefined as never, baseUrl: "" }, t.owner.id, await SIM.createSimulatedEvent(t.db, t.env, order.invoiceId, { correlationId: "corr_guard" }));
  assert.equal(r.outcome, "applied");
  const pid = r.projectId!;
  const c = await t.client().login(cu.email, TEST_PASSWORD);
  await c.post(`/portal/projects/${pid}/onboarding`, { ...JT.intake, functionality: [...JT.intake.functionality], business_name: "Guard Test Org", pages: "Home\nContact" });
  const job = (await t.db.prepare(`SELECT * FROM build_jobs WHERE project_id = ?`).bind(pid).first<B.BuildJob>())!;
  assert.equal(job.state, "queued");
  assert.equal(await B.projectPaidBySimulation(t.db, pid), true);

  // Pure rule: a simulated payment for an organization without the test mark is never eligible.
  const facts = await B.projectFacts(t.db, pid);
  assert.equal(B.decideEligibility({ ...facts, simulationTestOrg: false }).verdict, "ineligible");

  // FIXTURE (labelled): the job is put in owner review with a gated preview by SQL, to prove the release gates.
  // No build ran; this is not a build result.
  await t.db.prepare(`UPDATE build_jobs SET state = 'ready_for_review', preview_gated = 1, preview_name = 'guard-preview', preview_url = 'https://guard-preview.example.workers.dev', internal_approved_at = ?, internal_approved_by = ? WHERE id = ?`)
    .bind(new Date().toISOString(), t.owner.id, job.id).run();
  const share = await t.oc.post(`/staff/builds/${job.id}/share-preview`, { action: "share" });
  assert.match(flash(share)?.text ?? (await share.text()), /SIMULATED payment/);
  assert.equal((await B.getJob(t.db, job.id))!.customer_preview_shared_at, null, "never shown to the customer");
  const blockers = await releaseBlockers(t.db, { ...(await B.getJob(t.db, job.id))!, state: "approved" }, "not applicable");
  assert.match(blockers.join(" "), /SIMULATED payment .* can never be released to production/);

  // The manual delivery path is closed too: release readiness fails and the handoff cannot be published.
  const rr = await releaseReadiness(t.db, pid);
  assert.ok(rr.missing.includes("payment:simulated_test_payment"));
  await assert.rejects(saveHandoff({ db: t.db, email: undefined as never, baseUrl: "" } as never, { kind: "user", userId: t.owner.id, roles: [{ role: "owner", organizationId: "org_crestmont" }], mfaVerified: true }, pid,
    { website_url: "https://guard.example", documentation: "x", access_instructions: "x", ownership_notes: "x", training_notes: "x", documentation_file_id: null }, true), /SIMULATED payment/);
  // Simulated money is not revenue, not refundable and has no receipt.
  const day = 86_400_000;
  const dash = await financeDashboard(t.db, { fromIso: new Date(Date.now() - day).toISOString(), toIso: new Date(Date.now() + day).toISOString() } as never);
  assert.equal(dash.gross, 0, "simulated payments are excluded from revenue");
  const payId = (await one<{ id: string }>(t, `SELECT id FROM payments WHERE order_id = ?`, order.orderId)).id;
  assert.equal((await customerBilling(t.db, cu.organizationId)).payments[0].refundable, 0);
  await assert.rejects(loadReceipt(t.db, payId, cu.organizationId), /Receipt not found/);

  // Removing the test mark makes the project ineligible: the sweep cancels the build.
  await SIM.markTestOrganization(t, t.owner.id, cu.organizationId, false, "Guard Test Org");
  await B.syncProjectBuild(t.db, pid, "sweep");
  assert.equal((await B.getJob(t.db, job.id))!.state, "canceled");
});
