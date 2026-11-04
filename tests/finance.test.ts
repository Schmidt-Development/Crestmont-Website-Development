// Customer billing, refunds & disputes, finance dashboards and exports (area C).
// All records created here are TEST DATA. The Stripe adapter is a local fake that records calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, lastEmail, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import type { PaymentsAdapter, CheckoutRequest } from "../src/adapters/payments.ts";
import type { Env } from "../src/app/context.ts";
import { refundTransition } from "../src/domain/refunds.ts";
import type { Actor } from "../src/domain/authz.ts";

class FakePayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  checkouts: CheckoutRequest[] = [];
  portals: string[] = [];
  refunds: { pi: string; amount: number; key: string }[] = [];
  refundStatus = "succeeded";
  failRefund = false;
  async createCheckout(req: CheckoutRequest) { this.checkouts.push(req); return { id: `cs_test_${this.checkouts.length}`, url: `https://checkout.stripe.com/c/pay/cs_test_${this.checkouts.length}` }; }
  async createBillingPortal(customerId: string) { this.portals.push(customerId); return { url: `https://billing.stripe.com/p/session/test_${this.portals.length}` }; }
  async createRefund(pi: string, amount: number, key: string) {
    if (this.failRefund) throw new Error("Stripe: charge already refunded");
    this.refunds.push({ pi, amount, key }); return { id: `re_test_${this.refunds.length}`, status: this.refundStatus };
  }
}

const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;

async function app(payments = true) {
  const fake = new FakePayments();
  const t = await createTestApp(payments ? { overrides: { payments: fake } } : {});
  return { ...t, fake };
}
async function staffClient(t: { db: Env["DB"]; client: () => TestClient }, role: Parameters<typeof createStaff>[1], email?: string) {
  const s = await createStaff(t.db, role, email);
  const c = t.client(); await c.login(s.email, TEST_PASSWORD, s.secret);
  return { ...s, c };
}
async function customerClient(t: { db: Env["DB"]; client: () => TestClient }, email?: string, org?: string) {
  const cu = await createCustomer(t.db, email, org);
  const c = t.client(); await c.login(cu.email);
  return { ...cu, c };
}

/** Seeds an order with an invoice (and optionally a payment) for an organization. TEST DATA. */
async function seedPaid(db: Env["DB"], orgId: string, o: { amount?: number; fee?: number | null; paid?: boolean; at?: string; pi?: string; kind?: string; milestone?: string } = {}) {
  const amount = o.amount ?? 99_900, at = o.at ?? new Date().toISOString(), suffix = Math.random().toString(16).slice(2, 10);
  const ord = `ord_${suffix}`, inv = `inv_${suffix}`, pay = `pay_${suffix}`;
  await db.batch([
    db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, created_at) VALUES (?,?,?,?,?,?,?)`).bind(ord, orgId, o.kind === "subscription" ? "essential" : "starter", amount, o.paid === false ? "pending_payment" : "paid", o.kind ?? "package", at),
    db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, description, created_at, paid_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(inv, orgId, ord, o.milestone ?? "full", amount, o.paid === false ? "open" : "paid", "Starter package — 100% upfront", at, o.paid === false ? null : at),
    ...(o.paid === false ? [] : [db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, order_id, amount_cents, fee_cents, stripe_payment_intent_id, status, created_at) VALUES (?,?,?,?,?,?,?, 'succeeded', ?)`).bind(pay, orgId, inv, ord, amount, o.fee === undefined ? null : o.fee, o.pi ?? `pi_test_${suffix}`, at)]),
  ]);
  return { ord, inv, pay };
}

test("[AUTH-008] customer org A cannot see or pay org B's invoices, receipts or refund requests", async () => {
  const t = await app();
  const a = await customerClient(t, "a@alpha.example", "Alpha LLC");
  const b = await customerClient(t, "b@beta.example", "Beta LLC");
  const bSeed = await seedPaid(t.db, b.organizationId, { paid: false, amount: 50_000 });
  const bPaid = await seedPaid(t.db, b.organizationId, { amount: 77_700 });
  assert.equal((await a.c.get(`/portal/billing/invoices/${bSeed.inv}`)).status, 404);
  assert.equal((await a.c.post(`/portal/billing/invoices/${bSeed.inv}/pay`)).status, 404);
  assert.equal(t.fake.checkouts.length, 0);
  const aBilling = await (await a.c.get("/portal/billing")).text();
  assert.doesNotMatch(aBilling, new RegExp(bSeed.inv));
  assert.doesNotMatch(aBilling, /\$777/);
  const ref = await a.c.post("/portal/billing/refund-request", { payment_id: bPaid.pay, reason: "Trying to refund someone else's payment" });
  assert.equal(ref.status, 422);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM refunds`)).n, 0);
  // ?org= cannot select an organization the user does not belong to.
  assert.doesNotMatch(await (await a.c.get(`/portal/billing?org=${b.organizationId}`)).text(), /\$777/);
  // B sees its own invoice and can pay it.
  assert.match(await (await b.c.get(`/portal/billing/invoices/${bSeed.inv}`)).text(), /\$500/);
  assert.equal((await b.c.post(`/portal/billing/invoices/${bSeed.inv}/pay`)).status, 303);
  // Staff do not get the customer portal.
  const owner = await staffClient(t, "owner");
  assert.equal((await owner.c.get("/portal/billing")).status, 403);
});

test("[PAY-005] any open invoice (milestone, change order) can be paid via Stripe checkout with full metadata; paid invoices cannot", async () => {
  const t = await app();
  const cu = await customerClient(t);
  const at = new Date().toISOString();
  await t.db.batch([
    t.db.prepare(`INSERT INTO orders (id, organization_id, total_cents, status, kind, created_at) VALUES ('ord_m', ?, 1000000, 'partially_paid', 'quote', ?)`).bind(cu.organizationId, at),
    t.db.prepare(`INSERT INTO projects (id, organization_id, order_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES ('prj_m', ?, 'ord_m', 'Custom app', 'design', 3, 'milestone_50_25_25', ?, ?)`).bind(cu.organizationId, at, at),
    t.db.prepare(`INSERT INTO invoices (id, organization_id, order_id, project_id, milestone_kind, amount_cents, status, description, created_at) VALUES ('inv_d25', ?, 'ord_m', 'prj_m', 'design_25', 250000, 'open', '25% on approved design', ?)`).bind(cu.organizationId, at),
    t.db.prepare(`INSERT INTO invoices (id, organization_id, project_id, milestone_kind, amount_cents, status, description, created_at) VALUES ('inv_co', ?, 'prj_m', 'change_order', 40000, 'open', 'Change order: extra page', ?)`).bind(cu.organizationId, at),
  ]);
  const res = await cu.c.post("/portal/billing/invoices/inv_d25/pay");
  assert.equal(res.status, 303);
  assert.deepEqual(t.fake.checkouts[0].metadata, { organization_id: cu.organizationId, invoice_id: "inv_d25", order_id: "ord_m", kind: "milestone" });
  assert.equal(t.fake.checkouts[0].lines[0].amountCents, 250_000);
  await cu.c.post("/portal/billing/invoices/inv_co/pay");
  assert.deepEqual(t.fake.checkouts[1].metadata, { organization_id: cu.organizationId, invoice_id: "inv_co", order_id: "", kind: "change_order" });
  const paid = await seedPaid(t.db, cu.organizationId);
  assert.equal((await cu.c.post(`/portal/billing/invoices/${paid.inv}/pay`)).status, 409);
  // customer_member cannot pay.
  const mem = await createCustomer(t.db, "member@x.example");
  await t.db.prepare(`UPDATE memberships SET organization_id = ?, role_id = 'customer_member' WHERE user_id = ?`).bind(cu.organizationId, mem.id).run();
  const mc = t.client(); await mc.login(mem.email);
  assert.equal((await mc.post("/portal/billing/invoices/inv_d25/pay")).status, 403);
});

test("[PORTAL-008] billing page lists orders, invoices, receipts, subscriptions and refund requests; not-configured is explained", async () => {
  const t = await app(false);
  const cu = await customerClient(t);
  const empty = await (await cu.c.get("/portal/billing")).text();
  assert.match(empty, /No invoices/);
  assert.match(empty, /Online payment is not configured yet/);
  const s = await seedPaid(t.db, cu.organizationId);
  await seedPaid(t.db, cu.organizationId, { paid: false, amount: 12_345 });
  const at = new Date().toISOString();
  await t.db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, status, current_period_end, created_at, updated_at) VALUES ('sub_p', ?, 'professional', 'past_due', ?, ?, ?)`).bind(cu.organizationId, at, at, at).run();
  const page = await (await cu.c.get("/portal/billing")).text();
  for (const re of [/Starter package/, /\$123\.45/, /Professional maintenance/, /Past Due/, /payment failed/i, new RegExp(s.ord)]) assert.match(page, re);
  assert.doesNotMatch(page, /Pay now/, "no pay button without Stripe");
  assert.equal((await cu.c.post(`/portal/billing/invoices/${s.inv}/pay`)).status, 409);
  // Billing portal requires configuration.
  assert.equal((await cu.c.post("/portal/billing/manage")).status, 409);
});

test("[PAY-004] customer billing portal opens Stripe for the organization's saved customer", async () => {
  const t = await app();
  const cu = await customerClient(t);
  assert.equal((await cu.c.post("/portal/billing/manage")).status, 409, "no Stripe customer yet");
  await t.db.prepare(`UPDATE organizations SET stripe_customer_id = 'cus_test_portal' WHERE id = ?`).bind(cu.organizationId).run();
  const res = await cu.c.post("/portal/billing/manage");
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location")!, /^https:\/\/billing\.stripe\.com\//);
  assert.deepEqual(t.fake.portals, ["cus_test_portal"]);
});

test("[PAY-007] refund flow: customer request → support review → Founder approval → Stripe refund, audited and notified", async () => {
  const t = await app();
  const cu = await customerClient(t, "refund@cust.example");
  const support = await staffClient(t, "support");
  const s = await seedPaid(t.db, cu.organizationId, { pi: "pi_test_refund" });
  assert.equal((await cu.c.post("/portal/billing/refund-request", { payment_id: s.pay, reason: "short" })).status, 422);
  assert.equal((await cu.c.post("/portal/billing/refund-request", { payment_id: s.pay, amount: "2000", reason: "Project cancelled before kickoff." })).status, 422, "more than paid");
  assert.equal((await cu.c.post("/portal/billing/refund-request", { payment_id: s.pay, amount: "500", reason: "Project cancelled before kickoff.", evidence: "Email thread 2026-10-01" })).status, 303);
  assert.equal((await cu.c.post("/portal/billing/refund-request", { payment_id: s.pay, reason: "Project cancelled before kickoff." })).status, 422, "no duplicate request");
  const r = await one<{ id: string; status: string; amount_cents: number }>(t.db, `SELECT id, status, amount_cents FROM refunds`);
  assert.deepEqual({ status: r.status, amount_cents: r.amount_cents }, { status: "requested", amount_cents: 50_000 });
  assert.equal((await lastEmail(t.db, "refund@cust.example"))?.template, "refund_request");
  assert.ok((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND kind = 'refund_requested'`, support.id)).n === 1);

  assert.match(await (await support.c.get("/staff/refunds")).text(), /Project cancelled/);
  assert.equal((await support.c.post(`/staff/refunds/${r.id}/review`, { to: "under_review", notes: "" })).status, 422, "notes required");
  assert.equal((await support.c.post(`/staff/refunds/${r.id}/review`, { to: "under_review", notes: "Checking project status" })).status, 303);
  assert.equal((await support.c.post(`/staff/refunds/${r.id}/review`, { to: "recommended", notes: "No work started; recommend refund." })).status, 303);
  // Support cannot decide or issue.
  assert.equal((await support.c.post(`/staff/refunds/${r.id}/decide`, { decision: "approved", notes: "ok" })).status, 403);
  assert.equal((await support.c.post(`/staff/refunds/${r.id}/issue`)).status, 403);
  // Administrators cannot either.
  const admin = await staffClient(t, "administrator");
  assert.equal((await admin.c.post(`/staff/refunds/${r.id}/decide`, { decision: "approved", notes: "ok" })).status, 403);

  const owner = await staffClient(t, "owner");
  assert.equal((await owner.c.post(`/staff/refunds/${r.id}/issue`)).status, 409, "must be approved first");
  assert.equal((await owner.c.post(`/staff/refunds/${r.id}/decide`, { decision: "approved", notes: "Approved per policy." })).status, 303);
  assert.equal((await lastEmail(t.db, "refund@cust.example"))?.template, "refund_decision");
  assert.equal((await owner.c.post(`/staff/refunds/${r.id}/issue`)).status, 303);
  assert.deepEqual(t.fake.refunds, [{ pi: "pi_test_refund", amount: 50_000, key: `refund:${r.id}` }]);
  const done = await one<{ status: string; stripe_refund_id: string; decided_by: string; reviewed_by: string; customer_notified_at: string }>(t.db, `SELECT status, stripe_refund_id, decided_by, reviewed_by, customer_notified_at FROM refunds WHERE id = ?`, r.id);
  assert.deepEqual({ ...done, customer_notified_at: !!done.customer_notified_at }, { status: "issued", stripe_refund_id: "re_test_1", decided_by: owner.id, reviewed_by: support.id, customer_notified_at: true });
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM payments WHERE id = ?`, s.pay)).status, "partially_refunded");
  const actions = (await t.db.prepare(`SELECT action FROM audit_logs WHERE subject_type = 'refund' AND subject_id = ? ORDER BY id`).bind(r.id).all<{ action: string }>()).results.map((x) => x.action);
  assert.deepEqual(actions, ["refund.requested", "refund.under_review", "refund.recommended", "refund.approved", "refund.issued"]);
  assert.equal((await owner.c.post(`/staff/refunds/${r.id}/issue`)).status, 409, "cannot issue twice");
});

test("[PAY-007] mandatory obligations cannot be denied; issuing without Stripe explains it; AI can never act", async () => {
  const t = await app(false);
  const cu = await customerClient(t);
  const s = await seedPaid(t.db, cu.organizationId);
  await cu.c.post("/portal/billing/refund-request", { payment_id: s.pay, reason: "Card network chargeback rights apply." });
  const r = await one<{ id: string }>(t.db, `SELECT id FROM refunds`);
  const support = await staffClient(t, "support");
  await support.c.post(`/staff/refunds/${r.id}/review`, { to: "under_review", notes: "Reviewing" });
  assert.equal((await support.c.post(`/staff/refunds/${r.id}/review`, { to: "denied", notes: "No", mandatory: "1" })).status, 403, "FD-03: support can never deny");
  assert.doesNotMatch(await (await support.c.get(`/staff/refunds/${r.id}`)).text(), />Deny</, "FD-03: support sees no Deny button");
  assert.equal((await support.c.post(`/staff/refunds/${r.id}/review`, { to: "recommended", notes: "Legally required", mandatory: "1" })).status, 303);
  const owner = await staffClient(t, "owner");
  const page = await (await owner.c.get(`/staff/refunds/${r.id}`)).text();
  assert.doesNotMatch(page, /Deny refund/);
  assert.equal((await owner.c.post(`/staff/refunds/${r.id}/decide`, { decision: "denied", notes: "No" })).status, 422);
  assert.equal((await owner.c.post(`/staff/refunds/${r.id}/decide`, { decision: "approved", notes: "Required by card network rules." })).status, 303);
  const issue = await owner.c.post(`/staff/refunds/${r.id}/issue`);
  assert.equal(issue.status, 409);
  assert.match(await issue.text(), /Online payment is not configured yet/);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM refunds WHERE id = ?`, r.id)).status, "approved");
  const ai: Actor = { kind: "ai", userId: owner.id, roles: [{ role: "owner", organizationId: "x" }], mfaVerified: true };
  assert.throws(() => refundTransition(ai, "approved", "issued"), /AI cannot act/);
});

test("[PAY-007] a failed Stripe refund is recorded as failed and can be retried by the Owner", async () => {
  const t = await app();
  const cu = await customerClient(t);
  const s = await seedPaid(t.db, cu.organizationId);
  await cu.c.post("/portal/billing/refund-request", { payment_id: s.pay, reason: "Duplicate purchase by mistake." });
  const r = await one<{ id: string }>(t.db, `SELECT id FROM refunds`);
  const support = await staffClient(t, "support");
  await support.c.post(`/staff/refunds/${r.id}/review`, { to: "under_review", notes: "x" });
  await support.c.post(`/staff/refunds/${r.id}/review`, { to: "recommended", notes: "Duplicate" });
  const owner = await staffClient(t, "owner");
  await owner.c.post(`/staff/refunds/${r.id}/decide`, { decision: "approved", notes: "ok" });
  t.fake.failRefund = true;
  assert.equal((await owner.c.post(`/staff/refunds/${r.id}/issue`)).status, 502);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM refunds WHERE id = ?`, r.id)).status, "failed");
  t.fake.failRefund = false;
  assert.equal((await owner.c.post(`/staff/refunds/${r.id}/issue`)).status, 303);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM refunds WHERE id = ?`, r.id)).status, "issued");
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM payments WHERE id = ?`, s.pay)).status, "refunded");
});

test("[PAY-008] disputes list shows evidence deadline and linked payment/customer", async () => {
  const t = await app();
  const cu = await customerClient(t, undefined, "Disputed Co");
  const s = await seedPaid(t.db, cu.organizationId, { pi: "pi_test_disp" });
  const at = new Date().toISOString();
  await t.db.prepare(`INSERT INTO disputes (id, organization_id, payment_id, stripe_dispute_id, amount_cents, reason, status, evidence_due_by, created_at, updated_at) VALUES ('dsp_1', ?, ?, 'du_test_1', 99900, 'fraudulent', 'needs_response', ?, ?, ?)`)
    .bind(cu.organizationId, s.pay, new Date(Date.now() + 2 * 86400e3).toISOString(), at, at).run();
  const owner = await staffClient(t, "owner");
  const page = await (await owner.c.get("/staff/disputes")).text();
  for (const re of [/Disputed Co/, /du_test_1/, /pi_test_disp/, /Fraudulent/, /error-text/]) assert.match(page, re);
  const support = await staffClient(t, "support");
  assert.equal((await support.c.get("/staff/disputes")).status, 403);
});

test("[FIN-001] revenue dashboard derives metrics from records and shows Unknown for unreconciled Stripe fees", async () => {
  const t = await app();
  const cu = await customerClient(t);
  await seedPaid(t.db, cu.organizationId, { amount: 100_000, fee: 3_000 });
  await seedPaid(t.db, cu.organizationId, { amount: 200_000, fee: null });
  await seedPaid(t.db, cu.organizationId, { amount: 9_900, fee: 300, kind: "subscription", milestone: "subscription" });
  await seedPaid(t.db, cu.organizationId, { amount: 50_000, paid: false });
  await seedPaid(t.db, cu.organizationId, { amount: 70_000, at: "2020-01-15T00:00:00.000Z" }); // outside range
  const at = new Date().toISOString();
  const old = new Date(Date.now() - 60 * 86400e3).toISOString();
  await t.db.batch([
    t.db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, status, created_at, updated_at) VALUES ('s1', ?, 'essential', 'active', ?, ?)`).bind(cu.organizationId, old, old),
    t.db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, status, created_at, updated_at) VALUES ('s2', ?, 'executive', 'canceled', ?, ?)`).bind(cu.organizationId, old, at),
  ]);
  const p = (await one<{ id: string }>(t.db, `SELECT id FROM payments WHERE amount_cents = 100000`)).id;
  await t.db.prepare(`INSERT INTO refunds (id, organization_id, payment_id, amount_cents, reason, status, requested_by, created_at, decided_at, issued_at) VALUES ('rf1', ?, ?, 10000, 'x', 'issued', ?, ?, ?, ?)`).bind(cu.organizationId, p, cu.id, at, at, at).run();
  const owner = await staffClient(t, "owner");
  const page = await (await owner.c.get("/staff/finance")).text();
  const kpiVal = (label: string) => new RegExp(`${label}</div><div class="kpi__value">([^<]+)<`).exec(page)?.[1];
  assert.equal(kpiVal("Gross revenue"), "$3,099");
  assert.equal(kpiVal("Refunds"), "$100");
  assert.equal(kpiVal("Net revenue"), "$2,999");
  assert.equal(kpiVal("Stripe fees"), "Unknown — not yet reconciled");
  assert.equal(kpiVal("Subscription revenue"), "$99");
  assert.equal(kpiVal("MRR"), "$99");
  assert.equal(kpiVal("Churn"), "50.0%");
  assert.equal(kpiVal("Outstanding invoices"), "$500");
  assert.equal(kpiVal("Average order value"), "$1,033");
  assert.match(page, /How these numbers are calculated/);
  assert.match(page, /not tax or accounting advice/);
  // Old range includes the 2020 payment only.
  const old2020 = await (await owner.c.get("/staff/finance?from=2020-01-01&to=2020-01-31")).text();
  assert.match(old2020, /Gross revenue<\/div><div class="kpi__value">\$700</);
  // Permission: sales and support cannot see finance.
  const rep = await staffClient(t, "sales");
  assert.equal((await rep.c.get("/staff/finance")).status, 403);
  // Lists with filters.
  assert.match(await (await owner.c.get("/staff/finance/invoices?status=open")).text(), /\$500/);
  assert.doesNotMatch(await (await owner.c.get("/staff/finance/invoices?status=open")).text(), /\$2,000/);
  const subs = await (await owner.c.get("/staff/finance/subscriptions?status=canceled")).text();
  assert.match(subs, /Executive maintenance/);
  assert.doesNotMatch(subs, /Essential maintenance/);
});

test("[FIN-001] all fees known → dashboard shows the fee total", async () => {
  const t = await app();
  const cu = await customerClient(t);
  await seedPaid(t.db, cu.organizationId, { amount: 100_000, fee: 2_930 });
  const owner = await staffClient(t, "owner");
  assert.match(await (await owner.c.get("/staff/finance")).text(), /Stripe fees<\/div><div class="kpi__value">\$29\.30</);
});

test("[FIN-002] [FIN-003] cost tracking keeps unknown costs unknown; profitability is Incomplete until all costs are known", async () => {
  const t = await app();
  const cu = await customerClient(t);
  const s = await seedPaid(t.db, cu.organizationId, { amount: 249_900 });
  const at = new Date().toISOString();
  const dev = await createStaff(t.db, "developer");
  await t.db.batch([
    t.db.prepare(`INSERT INTO projects (id, organization_id, order_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES ('prj_f', ?, ?, 'Profit Test Site', 'development', 3, 'upfront', ?, ?)`).bind(cu.organizationId, s.ord, at, at),
    t.db.prepare(`UPDATE invoices SET project_id = 'prj_f' WHERE id = ?`).bind(s.inv),
    t.db.prepare(`INSERT INTO tasks (id, project_id, title, status, created_at) VALUES ('tsk_f', 'prj_f', 'Build pages', 'done', ?)`).bind(at),
    t.db.prepare(`INSERT INTO time_entries (id, task_id, user_id, minutes, hourly_cost_cents, worked_on) VALUES ('te1', 'tsk_f', ?, 120, 5000, '2026-10-01')`).bind(dev.id),
  ]);
  const owner = await staffClient(t, "owner");
  assert.equal((await owner.c.post("/staff/finance/costs", { project_id: "prj_f", category: "hosting", amount: "abc", description: "Hosting", incurred_on: "2026-10-02" })).status, 422);
  assert.equal((await owner.c.post("/staff/finance/costs", { project_id: "prj_f", category: "bribes", amount: "1", description: "Hosting", incurred_on: "2026-10-02" })).status, 422);
  assert.equal((await owner.c.post("/staff/finance/costs", { project_id: "prj_f", category: "hosting", amount: "40.50", description: "Cloudflare hosting", incurred_on: "2026-10-02" })).status, 303);
  let page = await (await owner.c.get("/staff/finance/profitability")).text();
  assert.match(page, /\$2,358\.50/, "2499 - 100 labor - 40.50 hosting");
  // Unknown cost (blank amount) → stored NULL, profit incomplete and listed.
  assert.equal((await owner.c.post("/staff/finance/costs", { project_id: "prj_f", category: "third_party_api", amount: "", description: "Maps API usage", incurred_on: "2026-10-03" })).status, 303);
  assert.equal((await one<{ amount_cents: number | null }>(t.db, `SELECT amount_cents FROM project_costs WHERE description = 'Maps API usage'`)).amount_cents, null);
  page = await (await owner.c.get("/staff/finance/profitability")).text();
  assert.match(page, /Incomplete — unknown costs/);
  assert.match(page, /third_party_api: Maps API usage/);
  assert.doesNotMatch(page, /\$2,358\.50/);
  // A time entry without an hourly cost is also unknown.
  await t.db.prepare(`INSERT INTO time_entries (id, task_id, user_id, minutes, hourly_cost_cents, worked_on) VALUES ('te2', 'tsk_f', ?, 30, NULL, '2026-10-04')`).bind(dev.id).run();
  assert.match(await (await owner.c.get("/staff/finance/profitability")).text(), /hourly cost unknown/);
  const csv = await (await owner.c.get("/staff/reports/profitability.csv")).text();
  assert.match(csv, /prj_f,Profit Test Site,.*,249900,2499\.00,14050,140\.50,2,,,incomplete_unknown_costs/);
});

test("[FIN-004] accounting exports use date ranges, ISO dates, cents and dollars, and escape formulas", async () => {
  const t = await app();
  const cu = await customerClient(t, undefined, "=cmd|' /C calc'!A0");
  await seedPaid(t.db, cu.organizationId, { amount: 123_456, fee: null, at: "2026-09-15T12:00:00.000Z" });
  await seedPaid(t.db, cu.organizationId, { amount: 5_000, fee: 175, at: "2026-08-01T12:00:00.000Z" });
  const owner = await staffClient(t, "owner");
  const reports = await (await owner.c.get("/staff/reports?from=2026-09-01&to=2026-09-30")).text();
  assert.match(reports, /not tax or accounting advice/);
  assert.match(reports, /\/staff\/reports\/transactions\.csv\?from=2026-09-01&amp;to=2026-09-30/);
  const res = await owner.c.get("/staff/reports/transactions.csv?from=2026-09-01&to=2026-09-30");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition")!, /crestmont-transactions-2026-09-01-to-2026-09-30\.csv/);
  const csv = await res.text();
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 2, "only the September payment");
  assert.match(lines[0], /^payment_id,date,customer,invoice_id,order_id,amount_cents,amount_usd,fee_cents,fee_usd,fee_status/);
  assert.match(lines[1], /,2026-09-15,'=cmd\|' \/C calc'!A0,/);
  assert.match(lines[1], /,123456,1234\.56,,,unknown,succeeded,/);
  for (const kind of ["invoices", "refunds", "subscriptions", "profitability"]) {
    const r = await owner.c.get(`/staff/reports/${kind}.csv?from=2026-09-01&to=2026-09-30`);
    assert.equal(r.status, 200, kind);
    const text = await r.text();
    assert.doesNotMatch(text, /,=cmd/, kind);
  }
  assert.match(await (await owner.c.get("/staff/reports/invoices.csv?from=2026-09-01&to=2026-09-30")).text(), /,2026-09-15,2026-09-15,,'=cmd/);
  assert.equal((await owner.c.get("/staff/reports/secrets.csv")).status, 404);
  assert.ok((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'finance.exported'`)).n >= 5);
  const rep = await staffClient(t, "sales");
  assert.equal((await rep.c.get("/staff/reports/transactions.csv")).status, 403);
});

test("[PAY-003] Stripe webhook for an invoice payment is idempotent: replays do not double-record payments", async () => {
  const secret = "whsec_test_fin";
  const fake = new FakePayments();
  const t = await createTestApp({ STRIPE_WEBHOOK_SECRET: secret, overrides: { payments: fake } });
  const cu = await createCustomer(t.db);
  const s = await seedPaid(t.db, cu.organizationId, { paid: false, amount: 99_900 });
  const { hmacSha256Hex } = await import("../src/lib/crypto.ts");
  const evt = { id: "evt_fin_1", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: { id: "cs_x", mode: "payment", payment_status: "paid", amount_total: 99_900, payment_intent: "pi_fin_1", metadata: { organization_id: cu.organizationId, invoice_id: s.inv, order_id: s.ord, kind: "package" } } } };
  const send = async (e: unknown) => {
    const body = JSON.stringify(e); const ts = Math.floor(Date.now() / 1000);
    return t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(secret, `${ts}.${body}`)}` } });
  };
  assert.equal((await send(evt)).status, 200);
  assert.equal((await send(evt)).status, 200);
  assert.equal((await send({ ...evt, id: "evt_fin_2" })).status, 200);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM payments WHERE invoice_id = ?`, s.inv)).n, 1);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM projects WHERE order_id = ?`, s.ord)).n, 1);
  // The finance dashboard reflects the webhook-recorded payment, with fee unknown.
  const owner = await createStaff(t.db, "owner");
  const oc = t.client(); await oc.login(owner.email, TEST_PASSWORD, owner.secret);
  const page = await (await oc.get("/staff/finance")).text();
  assert.match(page, /Gross revenue<\/div><div class="kpi__value">\$999</);
  assert.match(page, /Unknown — not yet reconciled/);
});
