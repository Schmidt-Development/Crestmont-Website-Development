// Commerce & sales closeout (CREST-GAP-005, 006, 007, 008, 010, 031, 032, 033, 034, 035, 036, 037, 038, 039, 080, 082,
// 083, 091, 093, 094). All records are TEST DATA. Stripe and Resend are never called: Stripe events are SIGNED FIXTURES
// (HMAC with a test webhook secret, like tests/finance.test.ts) and adapters run against recording fake fetches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, lastEmail, linkFrom, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import type { Env } from "../src/app/context.ts";
import type { PaymentsAdapter, CheckoutRequest } from "../src/adapters/payments.ts";
import { StripePayments, StripeReadOnly, LivePaymentsNotAuthorized } from "../src/adapters/payments.ts";
import { ResendEmail, OutboxEmail } from "../src/adapters/email.ts";
import { paymentsMode, expectedLivemode, commerceBlock } from "../src/domain/payments-mode.ts";
import { buildContext } from "../src/app/app.ts";
import { runJobs } from "../src/app/scheduled.ts";
import { provisionProjectOnce, createPackageOrder } from "../src/services/commerce.ts";
import { endOfBusinessDay } from "../src/lib/business-time.ts";
import { signVoiceEvent } from "../src/services/voice.ts";
import { notifyRefundIssued } from "../src/services/refunds.ts";

/** FIXTURE: records Checkout requests; never contacts Stripe. */
class FakePayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  checkouts: CheckoutRequest[] = [];
  async createCheckout(req: CheckoutRequest) { this.checkouts.push(req); const id = `cs_test_fixture_${this.checkouts.length}`; return { id, url: `https://checkout.stripe.com/c/pay/${id}` }; }
  async createBillingPortal(customerId: string) { return { url: `https://billing.stripe.com/p/session/test_${customerId}` }; }
  async createRefund(pi: string, amount: number) { return { id: `re_test_${pi}_${amount}`, status: "succeeded" }; }
}

const WHSEC = "whsec_test_commerce_closeout_fixture";
const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;
const count = async (db: Env["DB"], sql: string, ...b: unknown[]) => (await one<{ n: number }>(db, sql, ...b)).n;
const nowS = () => Math.floor(Date.now() / 1000);
let seq = 0;

async function app(extra: Partial<Env> = {}) {
  const fake = new FakePayments();
  const t = await createTestApp({ STRIPE_WEBHOOK_SECRET: WHSEC, ...extra, overrides: { payments: fake, ...(extra.overrides ?? {}) } });
  return { ...t, fake };
}
/** Posts a SIGNED FIXTURE event to the real webhook route. */
async function webhook(t: { client: () => TestClient }, type: string, object: Record<string, unknown>, opts: { id?: string; livemode?: boolean } = {}) {
  const body = JSON.stringify({ id: opts.id ?? `evt_fixture_${++seq}_${Date.now()}`, type, created: nowS(), ...(opts.livemode === undefined ? {} : { livemode: opts.livemode }), data: { object } });
  const ts = nowS();
  return t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(WHSEC, `${ts}.${body}`)}`, "content-type": "application/json" } });
}
async function customerClient(t: { db: Env["DB"]; client: () => TestClient }, email: string, org = "Fixture Bakery LLC") {
  const cu = await createCustomer(t.db, email, org);
  const c = t.client(); await c.login(cu.email);
  return { ...cu, c };
}
async function staffClient(t: { db: Env["DB"]; client: () => TestClient }, role: Parameters<typeof createStaff>[1], email?: string) {
  const s = await createStaff(t.db, role, email);
  const c = t.client(); await c.login(s.email, TEST_PASSWORD, s.secret);
  return { ...s, c };
}
const paidSession = (co: CheckoutRequest, pi: string, extra: Record<string, unknown> = {}) => ({
  id: `cs_${pi}`, object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: co.lines.reduce((s, l) => s + l.amountCents * (l.quantity ?? 1), 0),
  payment_intent: pi, customer: `cus_${pi}`, customer_email: co.customerEmail, metadata: co.metadata, ...extra });

// ───────────── CREST-GAP-007 / 008 / 010: payments mode per environment ─────────────

test("[PAY-010] payments mode: production refuses test keys and needs the Founder flag for live; staging/dev refuse live keys; nothing defaults to live", () => {
  const prod = (k?: string, flag?: string) => paymentsMode({ ENVIRONMENT: "production", STRIPE_SECRET_KEY: k, PAYMENTS_LIVE_AUTHORIZED: flag });
  assert.equal(prod("sk_test_fixture").mode, "none", "production + test key (DEPLOYMENT.md used to say this) is refused");
  assert.equal(prod("rk_test_fixture").mode, "none");
  assert.equal(prod("sk_live_fixture").mode, "none", "a live key alone is not enough");
  assert.equal(prod("sk_live_fixture", "true").mode, "none", "only the exact value \"yes\" authorises");
  assert.equal(prod("sk_test_fixture", "yes").mode, "none", "flag + test key is still refused on production");
  assert.equal(prod("sk_live_fixture", "yes").mode, "live");
  assert.equal(prod("rk_live_fixture", "yes").mode, "live");
  for (const env of ["staging", "development"]) {
    assert.equal(paymentsMode({ ENVIRONMENT: env, STRIPE_SECRET_KEY: "sk_live_fixture", PAYMENTS_LIVE_AUTHORIZED: "yes" }).mode, "none", `${env} never uses live, flag or not`);
    assert.equal(paymentsMode({ ENVIRONMENT: env, STRIPE_SECRET_KEY: "sk_test_fixture" }).mode, "test");
  }
  assert.equal(expectedLivemode({ ENVIRONMENT: "production" }), null, "production without authorisation refuses every event");
  assert.equal(expectedLivemode({ ENVIRONMENT: "production", STRIPE_SECRET_KEY: "sk_live_fixture", PAYMENTS_LIVE_AUTHORIZED: "yes" }), true);
  assert.equal(expectedLivemode({ ENVIRONMENT: "staging", STRIPE_SECRET_KEY: "sk_test_fixture" }), false);
  // CREST-GAP-010: even authorised, production checkout stays closed while the policies are drafts.
  assert.match(commerceBlock({ ENVIRONMENT: "production", STRIPE_SECRET_KEY: "sk_live_fixture", PAYMENTS_LIVE_AUTHORIZED: "yes" }, { "business.legal_name": "Crestmont Test Entity LLC (TEST DATA)" }) ?? "", /drafts/);
  assert.equal(commerceBlock({ ENVIRONMENT: "staging", STRIPE_SECRET_KEY: "sk_test_fixture" }, {}), null, "staging unchanged");
});

test("[PAY-010] adapters compare every key and object with the expected mode (FIXTURE fetch; Stripe is never called)", async () => {
  const calls: { auth: string; body: string }[] = [];
  const fetchFixture = (async (_url: string, init: RequestInit) => {
    calls.push({ auth: String((init.headers as Record<string, string>).authorization), body: String(init.body ?? "") });
    return new Response(JSON.stringify({ id: "cs_live_fixture", url: "https://checkout.stripe.com/c/pay/cs_live_fixture", livemode: true }), { status: 200 });
  }) as unknown as typeof fetch;
  // Mocked production + live key + flag: the live adapter creates a live session.
  const pm = paymentsMode({ ENVIRONMENT: "production", STRIPE_SECRET_KEY: "sk_live_fixture", PAYMENTS_LIVE_AUTHORIZED: "yes" });
  assert.equal(pm.mode, "live");
  const live = new StripePayments(pm.key!, fetchFixture, "live");
  const s = await live.createCheckout({ mode: "payment", lines: [{ name: "Starter", amountCents: 99_900 }], customerEmail: "c@fixture.example", successUrl: "https://x/s", cancelUrl: "https://x/c", metadata: {}, idempotencyKey: "k1" });
  assert.equal(s.id, "cs_live_fixture");
  assert.equal(calls[0].auth, "Bearer sk_live_fixture");
  // Default mode is test: a live key is refused at construction, and a live object is refused in test mode.
  assert.throws(() => new StripePayments("sk_live_fixture", fetchFixture), LivePaymentsNotAuthorized);
  assert.throws(() => new StripePayments("sk_test_fixture", fetchFixture, "live"), LivePaymentsNotAuthorized, "live mode refuses a test key");
  await assert.rejects(new StripePayments("sk_test_fixture", fetchFixture).createCheckout({ mode: "payment", lines: [{ name: "x", amountCents: 1 }], customerEmail: "c@fixture.example", successUrl: "https://x/s", cancelUrl: "https://x/c", metadata: {}, idempotencyKey: "k2" }), LivePaymentsNotAuthorized);
  const testObj = (async () => new Response(JSON.stringify({ id: "pi_1", livemode: false }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(new StripeReadOnly("sk_live_fixture", testObj, "live").get("payment_intents/pi_1"), LivePaymentsNotAuthorized, "live reader refuses a test-mode object");
  assert.equal((await new StripeReadOnly("sk_test_fixture", testObj).get<{ id: string }>("payment_intents/pi_1")).id, "pi_1");
  const r = new StripeReadOnly("sk_test_fixture", testObj);
  assert.throws(() => r.assertMode({ livemode: true }), LivePaymentsNotAuthorized);
});

test("[PAY-010] production with a test key shows payments as not configured; production checkout CTAs route to /quote and POST /checkout is refused (CREST-GAP-010)", async () => {
  const t = await createTestApp({ ENVIRONMENT: "production", STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: WHSEC });
  const ctx = await buildContext(new Request("http://crestmont.test/pricing"), t.env);
  assert.equal(ctx.payments.configured, false, "production + test key → checkout not configured");
  const authorised = await createTestApp({ ENVIRONMENT: "production", STRIPE_SECRET_KEY: "sk_live_fixture", PAYMENTS_LIVE_AUTHORIZED: "yes", STRIPE_WEBHOOK_SECRET: WHSEC });
  await authorised.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('business.legal_name','Crestmont Test Entity LLC (TEST DATA)',?)`).bind(nowIso()).run();
  const actx = await buildContext(new Request("http://crestmont.test/pricing"), authorised.env);
  assert.equal(actx.payments.configured, false, "draft policies keep production checkout closed even when live is authorised");
  assert.match((actx.payments as unknown as { reason: string }).reason, /drafts pending attorney review/);
  for (const path of ["/", "/pricing", "/pricing/compare"]) {
    const page = await (await t.client().get(path)).text();
    assert.doesNotMatch(page, /href="\/checkout\//, `${path}: no checkout links in production while closed`);
    assert.match(page, /href="\/quote\?package=(starter|business|premium)"/, `${path}: package CTAs request a quote`);
  }
  // Staging/test mode unchanged.
  const dev = await createTestApp({ STRIPE_SECRET_KEY: "sk_test_fixture" });
  assert.match(await (await dev.client().get("/pricing")).text(), /href="\/checkout\/starter"/);
  // POST /checkout is refused in production and creates nothing.
  const cu = await createCustomer(t.db, "prodbuyer@fixture.example");
  const c = t.client();
  await c.login(cu.email);
  const res = await c.post("/checkout/starter", { terms: "1", maintenance_plan: "essential" });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /not configured/);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM orders`), 0);
});

test("[PAY-003] webhook livemode guard: events whose livemode differs from the environment's mode are never applied", async () => {
  const t = await app();
  const cu = await createCustomer(t.db, "mode@fixture.example");
  const order = await createPackageOrder(t.db, cu.organizationId, "starter", cu.id);
  const obj = { id: "cs_mode_1", mode: "payment", payment_status: "paid", amount_total: order.amountCents, payment_intent: "pi_mode_1", metadata: { organization_id: cu.organizationId, invoice_id: order.invoiceId, order_id: order.orderId, kind: "package" } };
  assert.equal((await webhook(t, "checkout.session.completed", obj, { id: "evt_live_in_dev", livemode: true })).status, 200);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM invoices WHERE id = ?`, order.invoiceId)).status, "open", "a live event is ignored outside production");
  assert.match((await one<{ last_error: string }>(t.db, `SELECT last_error FROM stripe_events WHERE id = 'evt_live_in_dev'`)).last_error, /expects livemode=false/);
  // Production, not authorised: even a test-mode event is refused.
  const p = await createTestApp({ ENVIRONMENT: "production", STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: WHSEC });
  const pc = await createCustomer(p.db, "prodmode@fixture.example");
  const po = await createPackageOrder(p.db, pc.organizationId, "starter", pc.id);
  const pobj = { ...obj, id: "cs_mode_2", payment_intent: "pi_mode_2", metadata: { organization_id: pc.organizationId, invoice_id: po.invoiceId, order_id: po.orderId, kind: "package" } };
  await webhook(p, "checkout.session.completed", pobj, { id: "evt_test_in_prod", livemode: false });
  assert.equal((await one<{ status: string }>(p.db, `SELECT status FROM invoices WHERE id = ?`, po.invoiceId)).status, "open", "livemode:false event ignored on production");
  // Production, authorised live: test-card events refused, live events applied.
  const l = await createTestApp({ ENVIRONMENT: "production", STRIPE_SECRET_KEY: "sk_live_fixture", PAYMENTS_LIVE_AUTHORIZED: "yes", STRIPE_WEBHOOK_SECRET: WHSEC });
  const lc = await createCustomer(l.db, "livemode@fixture.example");
  const lo = await createPackageOrder(l.db, lc.organizationId, "starter", lc.id);
  const lobj = { ...obj, id: "cs_mode_3", payment_intent: "pi_mode_3", metadata: { organization_id: lc.organizationId, invoice_id: lo.invoiceId, order_id: lo.orderId, kind: "package" } };
  await webhook(l, "checkout.session.completed", lobj, { id: "evt_test_card_live", livemode: false });
  assert.equal((await one<{ status: string }>(l.db, `SELECT status FROM invoices WHERE id = ?`, lo.invoiceId)).status, "open");
  await webhook(l, "checkout.session.completed", lobj, { id: "evt_real_live", livemode: true });
  assert.equal((await one<{ status: string }>(l.db, `SELECT status FROM invoices WHERE id = ?`, lo.invoiceId)).status, "paid");
});

// ───────────── CREST-GAP-031: verified email before buying or paying ─────────────

test("[AUTH-001] unverified customers cannot check out or pay (403, nothing created, resend offered); verified customers reach Stripe", async () => {
  const t = await app();
  const cu = await createCustomer(t.db, "unverified@fixture.example");
  await t.db.prepare(`UPDATE users SET email_verified_at = NULL WHERE id = ?`).bind(cu.id).run();
  const c = t.client(); await c.login(cu.email);
  assert.equal((await c.get("/portal/billing")).status, 200, "browsing stays allowed");
  const res = await c.post("/checkout/starter", { terms: "1", maintenance_plan: "essential" });
  assert.equal(res.status, 403);
  const page = await res.text();
  assert.match(page, /Confirm your email/);
  assert.match(page, /action="\/verify-email\/resend"/);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM orders`), 0);
  assert.equal(t.fake.checkouts.length, 0);
  const inv = await createPackageOrder(t.db, cu.organizationId, "business", cu.id);
  assert.equal((await c.post(`/portal/billing/invoices/${inv.invoiceId}/pay`)).status, 403);
  assert.equal(t.fake.checkouts.length, 0, "no session for an unverified payer");
  assert.equal((await c.post("/checkout/maintenance/essential", { terms: "1" })).status, 409, "maintenance stays gated by Founder approval first");
  assert.equal((await c.post("/verify-email/resend")).status, 303);
  assert.equal((await lastEmail(t.db, cu.email))?.template, "verification");
  // Verified → redirected to the Stripe fixture URL.
  await t.db.prepare(`UPDATE users SET email_verified_at = ? WHERE id = ?`).bind(nowIso(), cu.id).run();
  const ok = await c.post("/checkout/starter", { terms: "1", maintenance_plan: "essential" });
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get("location")!, /^https:\/\/checkout\.stripe\.com\//);
});

// ───────────── CREST-GAP-006 / 037 / 091 / 038: paid invoice follow-ups ─────────────

test("[PAY-003] fault injection: provisioning fails after the invoice is marked paid; the retry completes exactly once (one project, converted lead, one receipt, one staff notice)", async () => {
  const t = await app();
  const owner = await createStaff(t.db, "owner");
  const pm = await createStaff(t.db, "project_manager");
  const cu = await customerClient(t, "fault@fixture.example");
  assert.equal((await cu.c.post("/checkout/starter", { terms: "1", maintenance_plan: "essential" })).status, 303);
  const co = t.fake.checkouts.at(-1)!;
  const invoiceId = co.metadata.invoice_id, orderId = co.metadata.order_id;
  const leadId = (await one<{ lead_id: string }>(t.db, `SELECT lead_id FROM orders WHERE id = ?`, orderId)).lead_id;
  assert.ok(leadId, "CREST-GAP-091: the direct purchase is linked to a CRM lead");
  // Inject: the projects table refuses inserts.
  t.db.raw.exec(`CREATE TRIGGER fixture_fail_projects BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT, 'injected provisioning failure'); END;`);
  const evt = paidSession(co, "pi_fault_1");
  assert.equal((await webhook(t, "checkout.session.completed", evt, { id: "evt_fault_1" })).status, 200);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM invoices WHERE id = ?`, invoiceId)).status, "paid", "the payment itself is recorded");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM projects WHERE order_id = ?`, orderId), 0);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM stripe_events WHERE id = 'evt_fault_1'`)).status, "failed");
  t.db.raw.exec(`DROP TRIGGER fixture_fail_projects`);
  // Retry by the scheduled reconciliation (invoice already paid): the follow-ups now run.
  await runJobs(t.env, ["stripe_reconcile"]);
  await runJobs(t.env, ["stripe_reconcile", "payment_repair"]);
  // Duplicate delivery of the same event and a second event for the same session change nothing.
  assert.deepEqual(await (await webhook(t, "checkout.session.completed", evt, { id: "evt_fault_1" })).json(), { received: true, duplicate: true });
  await webhook(t, "checkout.session.completed", evt, { id: "evt_fault_1b" });
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM projects WHERE order_id = ?`, orderId), 1, "exactly one project");
  assert.equal((await one<{ stage: string }>(t.db, `SELECT stage FROM leads WHERE id = ?`, leadId)).stage, "converted");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM crm_activities WHERE lead_id = ? AND body LIKE '%lead converted%'`, leadId), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE template = 'receipt' AND to_email = ?`, cu.email), 1, "one receipt");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM payments WHERE invoice_id = ?`, invoiceId), 1);
  // CREST-GAP-037: one notification each for owners and project managers, none on replay.
  for (const u of [owner.id, pm.id]) assert.equal(await count(t.db, `SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND kind = 'project_provisioned'`, u), 1);
  // CREST-GAP-038: the Stripe Customer from the first payment is stored and reused; the billing portal opens.
  assert.equal((await one<{ stripe_customer_id: string }>(t.db, `SELECT stripe_customer_id FROM organizations WHERE id = ?`, cu.organizationId)).stripe_customer_id, "cus_pi_fault_1");
  const portal = await cu.c.post("/portal/billing/manage");
  assert.equal(portal.status, 303);
  assert.match(portal.headers.get("location")!, /billing\.stripe\.com/);
  assert.equal((await cu.c.post("/checkout/business", { terms: "1", maintenance_plan: "professional" })).status, 303);
  assert.equal(t.fake.checkouts.at(-1)!.customerId, "cus_pi_fault_1", "later checkouts pass the stored customer");
  assert.equal(co.customerId ?? null, null, "the first checkout had no customer yet");
});

test("[PAY-003] dead-lettered provisioning is repaired by the scheduled sweep; projects.order_id is unique (concurrent provisioning creates one)", async () => {
  const t = await app();
  const cu = await customerClient(t, "sweep@fixture.example");
  await cu.c.post("/checkout/starter", { terms: "1", maintenance_plan: "essential" });
  const co = t.fake.checkouts.at(-1)!;
  t.db.raw.exec(`CREATE TRIGGER fixture_fail_projects2 BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
  await webhook(t, "checkout.session.completed", paidSession(co, "pi_sweep_1"), { id: "evt_sweep_1" });
  await t.db.prepare(`UPDATE stripe_events SET status = 'dead_letter', attempts = 5 WHERE id = 'evt_sweep_1'`).run();
  t.db.raw.exec(`DROP TRIGGER fixture_fail_projects2`);
  await runJobs(t.env, ["stripe_reconcile"]);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM projects WHERE order_id = ?`, co.metadata.order_id), 0, "dead letters are not retried");
  const r = await runJobs(t.env, ["payment_repair"]);
  assert.equal(r.payment_repair.ok, true, r.payment_repair.detail);
  assert.match(r.payment_repair.detail, /1 of 1 paid invoices without a project repaired/);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM projects WHERE order_id = ?`, co.metadata.order_id), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE template = 'receipt' AND to_email = ?`, cu.email), 1, "receipt to the billing admin");
  assert.match((await runJobs(t.env, ["payment_repair"])).payment_repair.detail, /^0 of 0/);
  // Unique index: two concurrent provisions of one order create one project.
  const o2 = await createPackageOrder(t.db, cu.organizationId, "premium", cu.id);
  const [a, b] = await Promise.all([provisionProjectOnce(t.db, o2.orderId), provisionProjectOnce(t.db, o2.orderId)]);
  assert.equal(a.projectId, b.projectId);
  assert.equal([a.created, b.created].filter(Boolean).length, 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM projects WHERE order_id = ?`, o2.orderId), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM milestones WHERE project_id = ?`, a.projectId), 7);
  await assert.rejects(t.db.prepare(`INSERT INTO projects (id, organization_id, order_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES ('prj_dup', ?, ?, 'dup', 'awaiting_onboarding', 2, 'upfront', ?, ?)`).bind(cu.organizationId, o2.orderId, nowIso(), nowIso()).run(), /UNIQUE/);
});

// ───────────── CREST-GAP-036 / 083: duplicate checkout, expiry, async failure ─────────────

test("[PAY-005] duplicate checkout reuses one open package invoice; checkout.session.expired voids it ($0 outstanding); a stale session never voids a newer one", async () => {
  const t = await app();
  const cu = await customerClient(t, "dupe@fixture.example");
  assert.equal((await cu.c.post("/checkout/starter", { terms: "1", maintenance_plan: "essential" })).status, 303);
  assert.equal((await cu.c.post("/checkout/starter", { terms: "1", maintenance_plan: "essential" })).status, 303);
  const [c1, c2] = t.fake.checkouts;
  assert.equal(c1.metadata.invoice_id, c2.metadata.invoice_id, "the second start reuses the open invoice");
  assert.equal(c1.idempotencyKey, c2.idempotencyKey, "and the same Stripe session on the same day");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM invoices WHERE organization_id = ? AND status = 'open'`, cu.organizationId), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM orders WHERE organization_id = ?`, cu.organizationId), 1);
  // A different package is a different order.
  await cu.c.post("/checkout/business", { terms: "1", maintenance_plan: "professional" });
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM invoices WHERE organization_id = ? AND status = 'open'`, cu.organizationId), 2);
  // Expiry of an older session id (not the one recorded) is ignored.
  await webhook(t, "checkout.session.expired", { id: "cs_test_fixture_old", object: "checkout.session", status: "expired", metadata: c1.metadata });
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM invoices WHERE id = ?`, c1.metadata.invoice_id)).status, "open");
  // Expiry of the recorded session voids the invoice and cancels the order.
  const sess = (await one<{ stripe_checkout_session_id: string }>(t.db, `SELECT stripe_checkout_session_id FROM invoices WHERE id = ?`, c1.metadata.invoice_id)).stripe_checkout_session_id;
  await webhook(t, "checkout.session.expired", { id: sess, object: "checkout.session", status: "expired", metadata: c1.metadata });
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM invoices WHERE id = ?`, c1.metadata.invoice_id)).status, "void");
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM orders WHERE id = ?`, c1.metadata.order_id)).status, "cancelled");
  const starterOutstanding = await one<{ c: number }>(t.db, `SELECT COALESCE(SUM(i.amount_cents),0) c FROM invoices i JOIN orders o ON o.id = i.order_id WHERE i.status = 'open' AND o.product_id = 'starter' AND i.organization_id = ?`, cu.organizationId);
  assert.equal(starterOutstanding.c, 0, "$0 outstanding for the abandoned package");
  // Outstanding (all open invoices, the finance dashboard definition) is only the still-open Business invoice.
  assert.equal((await one<{ c: number }>(t.db, `SELECT COALESCE(SUM(amount_cents),0) c FROM invoices WHERE status = 'open' AND organization_id = ?`, cu.organizationId)).c, 249_900);
  // Starting again issues a fresh invoice.
  await cu.c.post("/checkout/starter", { terms: "1", maintenance_plan: "essential" });
  assert.notEqual(t.fake.checkouts.at(-1)!.metadata.invoice_id, c1.metadata.invoice_id);
});

test("[PAY-003] async payment failure emails the customer; payment_intent.payment_failed is recorded; subscription checkout sends subscription_data metadata", async () => {
  const t = await app();
  const cu = await customerClient(t, "async@fixture.example");
  await cu.c.post("/checkout/starter", { terms: "1", maintenance_plan: "essential" });
  const co = t.fake.checkouts.at(-1)!;
  await webhook(t, "checkout.session.async_payment_failed", { id: "cs_async_1", object: "checkout.session", mode: "payment", payment_status: "unpaid", customer_email: cu.email, metadata: co.metadata });
  const mail = await lastEmail(t.db, cu.email);
  assert.equal(mail?.template, "failed_payment");
  assert.match(mail!.text_body, /could not be completed by your bank/);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM invoices WHERE id = ?`, co.metadata.invoice_id)).status, "open");
  await webhook(t, "payment_intent.payment_failed", { id: "pi_declined_1", object: "payment_intent", metadata: co.metadata, last_payment_error: { code: "card_declined", decline_code: "insufficient_funds" } });
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'payment.intent_failed' AND subject_id = ?`, co.metadata.invoice_id), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE to_email = ? AND template = 'failed_payment'`, cu.email), 1, "declines are not emailed per attempt");
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM stripe_events WHERE type = 'payment_intent.payment_failed'`)).status, "processed");
  // Adapter (FIXTURE fetch): payment mode creates a Customer; subscription mode carries subscription metadata; a stored customer is passed instead of the email.
  const forms: URLSearchParams[] = [];
  const f = (async (_u: string, init: RequestInit) => { forms.push(new URLSearchParams(String(init.body))); return new Response(JSON.stringify({ id: "cs_x", url: "https://checkout.stripe.com/x" }), { status: 200 }); }) as unknown as typeof fetch;
  const s = new StripePayments("sk_test_fixture", f);
  await s.createCheckout({ mode: "payment", lines: [{ name: "x", amountCents: 100 }], customerEmail: "a@fixture.example", successUrl: "https://x/s", cancelUrl: "https://x/c", metadata: { invoice_id: "inv_1" }, idempotencyKey: "k" });
  assert.equal(forms[0].get("customer_creation"), "always");
  assert.equal(forms[0].get("customer_email"), "a@fixture.example");
  await s.createCheckout({ mode: "subscription", lines: [{ name: "Essential", amountCents: 9_900 }], customerEmail: "a@fixture.example", customerId: "cus_stored", successUrl: "https://x/s", cancelUrl: "https://x/c", metadata: { organization_id: "org_1", product_id: "essential" }, recurringInterval: "month", idempotencyKey: "k2" });
  assert.equal(forms[1].get("customer"), "cus_stored");
  assert.equal(forms[1].get("customer_email"), null, "customer and customer_email are exclusive");
  assert.equal(forms[1].get("customer_creation"), null);
  assert.equal(forms[1].get("subscription_data[metadata][organization_id]"), "org_1");
  assert.equal(forms[1].get("subscription_data[metadata][product_id]"), "essential");
});

// ───────────── CREST-GAP-039: missing emails (refund, dispute, reset) ─────────────

test("[PAY-007] charge.refunded: Dashboard refunds email the customer once; platform-issued refunds are not emailed twice", async () => {
  const t = await app();
  const cu = await customerClient(t, "refund@fixture.example");
  await cu.c.post("/checkout/starter", { terms: "1", maintenance_plan: "essential" });
  const co = t.fake.checkouts.at(-1)!;
  await webhook(t, "checkout.session.completed", paidSession(co, "pi_refund_1"));
  const charge = { id: "ch_refund_1", object: "charge", payment_intent: "pi_refund_1", amount: 99_900, amount_refunded: 99_900, refunds: { data: [{ id: "re_dash_1", amount: 99_900 }] } };
  await webhook(t, "charge.refunded", charge);
  await webhook(t, "charge.refunded", charge); // redelivered as a new event
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM payments WHERE stripe_payment_intent_id = 'pi_refund_1'`)).status, "refunded");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE to_email = ? AND template = 'refund_decision'`, cu.email), 1);
  assert.match((await lastEmail(t.db, cu.email))!.text_body, /\$999\.00[\s\S]*re_dash_1/);
  // A refund the platform issued (and already emailed through its issue step) produces no second email.
  const pay = await one<{ id: string }>(t.db, `SELECT id FROM payments WHERE stripe_payment_intent_id = 'pi_refund_1'`);
  await t.db.prepare(`INSERT INTO refunds (id, organization_id, payment_id, amount_cents, reason, status, requested_by, stripe_refund_id, issued_at, customer_notified_at, created_at) VALUES ('rf_fixture', ?, ?, 500, 'fixture refund reason', 'issued', ?, 're_platform_1', ?, ?, ?)`)
    .bind(cu.organizationId, pay.id, cu.id, nowIso(), nowIso(), nowIso()).run();
  await notifyRefundIssued({ db: t.db, email: new OutboxEmail(t.db), baseUrl: "http://crestmont.test" }, "rf_fixture", "re_platform_1"); // the issue step's own notice
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE to_email = ? AND template = 'refund_decision'`, cu.email), 2);
  await webhook(t, "charge.refunded", { ...charge, id: "ch_refund_2", refunds: { data: [{ id: "re_platform_1", amount: 500 }] } });
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE to_email = ? AND template = 'refund_decision'`, cu.email), 2);
});

test("[PAY-008] dispute opened emails the Owner once (in-app notices unchanged)", async () => {
  const t = await app();
  const owner = await createStaff(t.db, "owner", "owner-dispute@crestmont.test");
  const dispute = { id: "dp_fixture_1", object: "dispute", payment_intent: "pi_none", amount: 99_900, reason: "fraudulent", status: "needs_response", evidence_details: { due_by: nowS() + 7 * 86400 } };
  await webhook(t, "charge.dispute.created", dispute);
  await webhook(t, "charge.dispute.created", dispute);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE to_email = ? AND template = 'dispute_opened'`, owner.email), 1);
  assert.match((await lastEmail(t.db, owner.email))!.text_body, /\$999\.00[\s\S]*Evidence is due by \d{4}-\d{2}-\d{2}/);
});

test("[AUTH-002] completing a password reset sends a security notice", async () => {
  const t = await createTestApp();
  const cu = await createCustomer(t.db, "resetdone@fixture.example");
  await t.client().post("/password/forgot", { email: cu.email });
  const link = linkFrom((await lastEmail(t.db, cu.email))!.text_body, "/password/reset");
  const token = new URL(`http://x${link}`).searchParams.get("token")!;
  const res = await t.client().post("/password/reset", { token, password: "a-brand-new-fixture-passphrase-42" });
  assert.equal(res.status, 303);
  const mail = await lastEmail(t.db, cu.email);
  assert.equal(mail?.template, "security_notification");
  assert.match(mail!.text_body, /reset using an emailed reset link/);
});

// ───────────── CREST-GAP-005 / 082 / 093: lead capture ─────────────

async function leadApp(extra: Partial<Env> = {}) {
  // Turnstile FIXTURE: tokens beginning with "ok" pass.
  const fetchFixture = (async (_u: string, init: RequestInit) => new Response(JSON.stringify({ success: String((init.body as FormData).get("response")).startsWith("ok") }))) as unknown as typeof fetch;
  return createTestApp({ TURNSTILE_SECRET: "turnstile-fixture", ...extra, overrides: { fetch: fetchFixture } });
}
const quoteForm = (over: Record<string, string> = {}) => ({ name: "Morgan Fixture", email: "Morgan.Fixture@Example.COM", company: "Fixture Coffee", interest: "business", budget: "", timeline: "", message: "We need a new website with online ordering.", "cf-turnstile-response": "ok-1", ...over });

test("[CRM-001] a new web lead notifies Owners and sales in-app plus one staff email; resubmitting creates nothing; the default lead owner is applied", async () => {
  const t = await leadApp();
  const owner = await createStaff(t.db, "owner", "owner-leads@crestmont.test");
  const sales = await createStaff(t.db, "sales", "sales-leads@crestmont.test");
  const dev = await createStaff(t.db, "developer", "dev-leads@crestmont.test");
  const visitor = t.client();
  const form = await (await visitor.get("/quote")).text();
  const submission = /name="submission" value="([^"]+)"/.exec(form)?.[1] ?? "";
  const fields = quoteForm({ submission, budget: "Not sure yet", timeline: "Flexible" });
  const res = await visitor.post("/quote", fields);
  assert.equal(res.status, 303, await res.clone().text());
  const lead = await one<{ id: string; owner_user_id: string | null }>(t.db, `SELECT id, owner_user_id FROM leads ORDER BY created_at DESC LIMIT 1`);
  for (const u of [owner.id, sales.id]) assert.equal(await count(t.db, `SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND kind = 'lead_new' AND subject_id = ?`, u, lead.id), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM notifications WHERE user_id = ?`, dev.id), 0, "developers are not notified");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE template = 'lead_alert'`), 1, "one staff email");
  assert.equal((await lastEmail(t.db, owner.email))?.template, "lead_alert", "no contact email set → first Owner");
  // CREST-GAP-093: stored lowercased and trimmed.
  assert.equal((await one<{ email: string }>(t.db, `SELECT c.email FROM contacts c JOIN leads l ON l.contact_id = c.id WHERE l.id = ?`, lead.id)).email, "morgan.fixture@example.com");
  // Resubmitting the same form (same submission token) creates no lead, notification or email.
  await visitor.post("/quote", fields);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM leads`), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM notifications WHERE kind = 'lead_new'`), 2);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE template = 'lead_alert'`), 1);
  // Default lead owner (Business settings) → new leads arrive assigned and the email goes to that owner.
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('crm.default_lead_owner', ?, ?)`).bind(sales.id, nowIso()).run();
  const api = await t.client().request("POST", "/api/leads", { body: JSON.stringify({ name: "Api Fixture", email: "  API.Fixture@Example.com ", interest: "custom", message: "Integration with our booking system please.", source: "web_form", turnstileToken: "ok-2" }), headers: { "content-type": "application/json" } });
  assert.equal(api.status, 201);
  const { leadId } = (await api.json()) as { leadId: string };
  assert.equal((await one<{ owner_user_id: string }>(t.db, `SELECT owner_user_id FROM leads WHERE id = ?`, leadId)).owner_user_id, sales.id);
  assert.equal((await lastEmail(t.db, sales.email))?.template, "lead_alert");
  assert.equal((await one<{ email: string }>(t.db, `SELECT c.email FROM contacts c JOIN leads l ON l.contact_id = c.id WHERE l.id = ?`, leadId)).email, "api.fixture@example.com");
  // A disabled or non-sales default owner is ignored.
  await t.db.prepare(`UPDATE business_settings SET value = ? WHERE key = 'crm.default_lead_owner'`).bind(dev.id).run();
  const api2 = await t.client().request("POST", "/api/leads", { body: JSON.stringify({ name: "Api Fixture Two", email: "two@fixture.example", interest: "custom", message: "Another enquiry about a custom portal.", source: "web_form", turnstileToken: "ok-3" }), headers: { "content-type": "application/json" } });
  assert.equal((await one<{ owner_user_id: string | null }>(t.db, `SELECT owner_user_id FROM leads WHERE id = ?`, ((await api2.json()) as { leadId: string }).leadId)).owner_user_id, null);
  // Mixed-case lead email links to the account registered later with the same address.
  const cu = await createCustomer(t.db, "morgan.fixture@example.com");
  assert.ok(await t.db.prepare(`SELECT 1 FROM contacts WHERE email = ?`).bind(cu.email).first(), "exact lowercase match");
});

test("[CRM-001] lead-form rate limit counts only submissions that passed Turnstile and validation: 11 errors then a valid submit succeeds", async () => {
  const t = await leadApp();
  const visitor = t.client();
  await visitor.get("/contact");
  for (let i = 0; i < 6; i++) assert.equal((await visitor.post("/contact", { name: "R", email: "bad", message: "short", interest: "other", "cf-turnstile-response": "ok-x" })).status, 422);
  for (let i = 0; i < 5; i++) assert.equal((await visitor.post("/contact", { name: "Robin Fixture", email: "robin@fixture.example", message: "A real message about a website.", interest: "other", "cf-turnstile-response": "bad-token" })).status, 400);
  const ok = await visitor.post("/contact", { name: "Robin Fixture", email: "robin@fixture.example", message: "A real message about a website.", interest: "other", "cf-turnstile-response": "ok-y" });
  assert.equal(ok.status, 303, "not locked out by earlier mistakes");
  // JSON API: invalid and unverified submissions do not count either.
  const post = (b: Record<string, unknown>) => t.client().request("POST", "/api/leads", { body: JSON.stringify(b), headers: { "content-type": "application/json" } });
  for (let i = 0; i < 11; i++) assert.equal((await post({ name: "x", turnstileToken: "ok-z" })).status, 422);
  const good = { name: "Api Robin", email: "api.robin@fixture.example", interest: "other", message: "Hello there, a real enquiry.", source: "web_form", turnstileToken: "ok-z" };
  assert.equal((await post(good)).status, 201);
  // The budget still applies to accepted submissions: 10 per hour per network in total.
  let last = 0;
  for (let i = 0; i < 10; i++) last = (await post({ ...good, email: `api${i}@fixture.example` })).status;
  assert.equal(last, 429);
});

test("[VOICE-003] voice-captured lead emails are stored lowercased (CREST-GAP-093)", async () => {
  const SECRET = "voice-fixture-secret";
  const t = await createTestApp({ VOICE_WEBHOOK_SECRET: SECRET });
  const send = async (body: Record<string, unknown>) => {
    const raw = JSON.stringify({ provider: "fixtureprov", ...body });
    return t.client().request("POST", "/api/webhooks/voice", { body: raw, headers: { "content-type": "application/json", "x-crestmont-voice-signature": await signVoiceEvent(SECRET, raw) } });
  };
  await send({ event: "call_started", call_id: "c-case" });
  await send({ event: "function_call", call_id: "c-case", event_id: "f1", function: { name: "create_lead", arguments: { name: "Casey Caller", email: " Casey.Caller@Example.COM ", interest: "business", requirements: "A ten page site for a clinic" } } });
  assert.equal((await one<{ email: string }>(t.db, `SELECT email FROM contacts WHERE name = 'Casey Caller'`)).email, "casey.caller@example.com");
});

// ───────────── CREST-GAP-080: effective prices in voice and AI prompts ─────────────

test("[CAT-007] the voice pricing tool and the AI lead-qualification prompt use the Founder-approved effective price", async () => {
  const SECRET = "voice-fixture-secret-2";
  const t = await createTestApp({ VOICE_WEBHOOK_SECRET: SECRET, AI_PROVIDER: "local-runner", BUILD_RUNNER_SECRET: "runner-fixture" });
  const owner = await staffClient(t, "owner");
  const req = newId("pcr");
  await t.db.prepare(`INSERT INTO price_change_requests (id, item_type, item_id, current_cents, proposed_cents, effective_at, reason, status, requested_by, requested_at, decided_by, decided_at) VALUES (?, 'package', 'business', 249900, 279900, ?, 'fixture approval', 'approved', ?, ?, ?, ?)`)
    .bind(req, "2020-01-01T00:00:00.000Z", owner.id, nowIso(), owner.id, nowIso()).run();
  await t.db.prepare(`INSERT INTO price_overrides (id, item_type, item_id, amount_cents, effective_at, request_id, approved_by, created_at) VALUES (?, 'package', 'business', 279900, '2020-01-01T00:00:00.000Z', ?, ?, ?)`).bind(newId("po"), req, owner.id, nowIso()).run();
  const raw = (b: Record<string, unknown>) => JSON.stringify({ provider: "fixtureprov", ...b });
  const send = async (b: Record<string, unknown>) => { const r = raw(b); return t.client().request("POST", "/api/webhooks/voice", { body: r, headers: { "content-type": "application/json", "x-crestmont-voice-signature": await signVoiceEvent(SECRET, r) } }); };
  await send({ event: "call_started", call_id: "c-eff" });
  const res = await send({ event: "function_call", call_id: "c-eff", event_id: "p1", function: { name: "get_published_pricing", arguments: {} } });
  const pricing = ((await res.json()) as { result: { pricing: { packages: { name: string; priceCents: number; price: string }[] } } }).result.pricing;
  assert.deepEqual(pricing.packages.find((p) => p.name === "Business"), { ...pricing.packages.find((p) => p.name === "Business")!, priceCents: 279_900, price: "$2,799" });
  const leadRes = await t.client().request("POST", "/api/leads", { body: JSON.stringify({ name: "Price Fixture", email: "price@fixture.example", interest: "business", message: "Interested in the business package.", source: "web_form" }), headers: { "content-type": "application/json" } });
  const { leadId } = (await leadRes.json()) as { leadId: string };
  assert.equal((await owner.c.post(`/staff/crm/leads/${leadId}/ai-draft`)).status, 303);
  const prompt = (await one<{ prompt: string }>(t.db, `SELECT i.prompt FROM ai_job_inputs i JOIN ai_jobs j ON j.id = i.job_id WHERE j.input_ref = ?`, `lead:${leadId}`)).prompt;
  assert.match(prompt, /Business \$2,799/);
  assert.doesNotMatch(prompt, /\$2,499/);
});

// ───────────── CREST-GAP-091: direct purchase attribution ─────────────

test("[CRM-006] a direct package purchase creates a CRM lead with the first-party attribution cookie and converts on payment; an existing open lead is linked instead", async () => {
  const t = await app();
  const cu = await createCustomer(t.db, "attrib@fixture.example");
  const c = t.client();
  await c.get("/pricing?utm_source=fixture_news&utm_medium=email&utm_campaign=autumn");
  assert.ok(c.cookies.get("cm_attr")?.includes("fixture_news"));
  await c.login(cu.email);
  await c.post("/checkout/business", { terms: "1", maintenance_plan: "professional" });
  const co = t.fake.checkouts.at(-1)!;
  const lead = await one<{ id: string; source: string; stage: string; utm_source: string; utm_campaign: string; interest: string }>(t.db, `SELECT l.id, l.source, l.stage, l.utm_source, l.utm_campaign, l.interest FROM leads l JOIN orders o ON o.lead_id = l.id WHERE o.id = ?`, co.metadata.order_id);
  assert.deepEqual({ source: lead.source, stage: lead.stage, utm_source: lead.utm_source, utm_campaign: lead.utm_campaign, interest: lead.interest }, { source: "checkout", stage: "awaiting_payment", utm_source: "fixture_news", utm_campaign: "autumn", interest: "business" });
  await webhook(t, "checkout.session.completed", paidSession(co, "pi_attr_1"));
  assert.equal((await one<{ stage: string }>(t.db, `SELECT stage FROM leads WHERE id = ?`, lead.id)).stage, "converted");
  // An existing open lead for the buyer's email is linked (no second lead).
  const cu2 = await createCustomer(t.db, "existing@fixture.example", "Existing Co");
  await t.client().request("POST", "/api/leads", { body: JSON.stringify({ name: "Existing Buyer", email: "Existing@Fixture.example", interest: "starter", message: "Thinking about the starter package.", source: "web_form" }), headers: { "content-type": "application/json" } });
  const before = await count(t.db, `SELECT COUNT(*) n FROM leads`);
  const c2 = t.client(); await c2.login(cu2.email);
  await c2.post("/checkout/starter", { terms: "1", maintenance_plan: "essential" });
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM leads`), before);
  const linked = await one<{ stage: string; source: string }>(t.db, `SELECT l.stage, l.source FROM leads l JOIN orders o ON o.lead_id = l.id WHERE o.id = ?`, t.fake.checkouts.at(-1)!.metadata.order_id);
  assert.deepEqual({ ...linked }, { stage: "awaiting_payment", source: "web_form" });
});

// ───────────── CREST-GAP-032 / 033 / 034 / 039 / 094: quotes ─────────────

async function quoteFlow(t: Awaited<ReturnType<typeof app>>, opts: { pkg?: "premium" | "custom"; email: string; validUntil?: string }) {
  const rep = await staffClient(t, "owner", `owner-${opts.email}`);
  const res = await t.client().request("POST", "/api/leads", { body: JSON.stringify({ name: "Quote Fixture", email: opts.email, company: "Quote Fixture Co", interest: "custom", message: "We need a bigger website please.", source: "quote_form" }), headers: { "content-type": "application/json" } });
  const { leadId } = (await res.json()) as { leadId: string };
  for (const to of ["qualified", "quote_required"]) await rep.c.post(`/staff/crm/leads/${leadId}/stage`, { to });
  const valid = opts.validUntil ?? new Date(Date.now() + 20 * 86400e3).toISOString().slice(0, 10);
  const fields = opts.pkg === "premium"
    ? { package: "premium", line_desc: ["Extra booking integration", ""], line_amount: ["1,000", ""], scope: "Premium package website with 25 pages and a booking integration, 4 revision rounds.", valid_until: valid }
    : { package: "custom", line_desc: ["Custom portal", ""], line_amount: ["6,000", ""], scope: "Custom web application with a customer portal and admin area for staff.", valid_until: valid };
  const save = await rep.c.post(`/staff/quotes/new?lead=${leadId}`, fields);
  assert.equal(save.status, 303, await save.clone().text());
  const quoteId = save.headers.get("location")!.split("/").pop()!;
  const sent = await rep.c.post(`/staff/quotes/${quoteId}/send`);
  const qpath = linkFrom((await lastEmail(t.db, opts.email))!.text_body, "/q/");
  const cu = await customerClient(t, opts.email, "Quote Fixture Co");
  return { rep, leadId, quoteId, qpath, cu, sent };
}

test("[SALES-004] fault injection: a failure while accepting leaves nothing accepted; the retry completes once (order, invoice, agreement records, confirmation email)", async () => {
  const t = await app();
  const q = await quoteFlow(t, { email: "accept-fault@fixture.example" });
  t.db.raw.exec(`CREATE TRIGGER fixture_fail_invoices BEFORE INSERT ON invoices BEGIN SELECT RAISE(ABORT, 'injected acceptance failure'); END;`);
  const bad = await q.cu.c.post(`${q.qpath}/accept`, { agree: "1" });
  assert.equal(bad.status, 500);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM quotes WHERE id = ?`, q.quoteId)).status, "sent", "quote not accepted");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM quote_versions WHERE quote_id = ? AND accepted_at IS NOT NULL`, q.quoteId), 0);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM orders WHERE lead_id = ?`, q.leadId), 0);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM agreement_acceptances WHERE user_id = ?`, q.cu.id), 0);
  assert.equal((await one<{ stage: string }>(t.db, `SELECT stage FROM leads WHERE id = ?`, q.leadId)).stage, "quote_sent");
  t.db.raw.exec(`DROP TRIGGER fixture_fail_invoices`);
  const ok = await q.cu.c.post(`${q.qpath}/accept`, { agree: "1" });
  assert.equal(ok.status, 303);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM orders WHERE lead_id = ?`, q.leadId), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM invoices i JOIN orders o ON o.id = i.order_id WHERE o.lead_id = ?`, q.leadId), 1);
  const acc = (await t.db.prepare(`SELECT a.kind, x.context_type FROM agreement_acceptances x JOIN agreements a ON a.id = x.agreement_id WHERE x.user_id = ?`).bind(q.cu.id).all<{ kind: string; context_type: string }>()).results;
  assert.deepEqual(acc.map((r) => r.kind).sort(), ["custom_development_agreement", "data_processing_addendum", "terms_of_service"]);
  assert.ok(acc.every((r) => r.context_type === "quote_acceptance"));
  assert.equal((await one<{ stage: string }>(t.db, `SELECT stage FROM leads WHERE id = ?`, q.leadId)).stage, "awaiting_payment");
  // CREST-GAP-039: confirmation lists the exact agreement versions.
  const mail = await lastEmail(t.db, q.cu.email);
  assert.equal(mail?.template, "proposal_accepted");
  assert.match(mail!.text_body, /Custom development agreement \(draft\) — version \S+/);
  // A second acceptance (double submit) is refused and creates nothing.
  assert.equal((await q.cu.c.post(`${q.qpath}/accept`, { agree: "1" })).status, 409);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM orders WHERE lead_id = ?`, q.leadId), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM agreement_acceptances WHERE user_id = ?`, q.cu.id), 3);
});

test("[PM-002] a paid Premium package quote provisions as Premium: 4 revision rounds and the package agreement set", async () => {
  const t = await app();
  const q = await quoteFlow(t, { pkg: "premium", email: "premium-quote@fixture.example" });
  assert.match(await (await q.cu.c.get(q.qpath)).text(), /the Development Agreement, the Refund Policy/);
  const ok = await q.cu.c.post(`${q.qpath}/accept`, { agree: "1" });
  assert.equal(ok.status, 303);
  const invoiceId = ok.headers.get("location")!.split("/").pop()!;
  const order = await one<{ id: string; product_id: string; organization_id: string }>(t.db, `SELECT id, product_id, organization_id FROM orders WHERE lead_id = ?`, q.leadId);
  assert.equal(order.product_id, "premium");
  const kinds = (await t.db.prepare(`SELECT a.kind, x.context_type FROM agreement_acceptances x JOIN agreements a ON a.id = x.agreement_id WHERE x.user_id = ?`).bind(q.cu.id).all<{ kind: string; context_type: string }>()).results;
  assert.deepEqual(kinds.map((k) => k.kind).sort(), ["data_processing_addendum", "development_agreement", "refund_policy", "terms_of_service"]);
  assert.ok(kinds.every((k) => k.context_type === "package_quote_acceptance"));
  const inv = await one<{ amount_cents: number }>(t.db, `SELECT amount_cents FROM invoices WHERE id = ?`, invoiceId);
  await webhook(t, "checkout.session.completed", { id: "cs_prem_1", mode: "payment", payment_status: "paid", amount_total: inv.amount_cents, payment_intent: "pi_prem_1", customer_email: q.cu.email, metadata: { organization_id: order.organization_id, invoice_id: invoiceId, order_id: order.id, kind: "quote" } });
  const prj = await one<{ revision_allowance: number; product_id: string; name: string }>(t.db, `SELECT revision_allowance, product_id, name FROM projects WHERE order_id = ?`, order.id);
  assert.deepEqual({ ...prj }, { revision_allowance: 4, product_id: "premium", name: "Quote Fixture Co — Premium website" });
});

test("[SALES-003] staff never see \"Proposal emailed.\" when delivery failed or is only queued; the activity says what happened", async () => {
  // Resend FIXTURE: every send fails with 500.
  const failing = (async () => new Response(JSON.stringify({ message: "fixture outage" }), { status: 500 })) as unknown as typeof fetch;
  const fake = new FakePayments();
  const holder: { t?: Awaited<ReturnType<typeof createTestApp>> } = {};
  const t0 = await createTestApp({ STRIPE_WEBHOOK_SECRET: WHSEC });
  holder.t = t0;
  t0.env.overrides = { ...t0.env.overrides, payments: fake, email: new ResendEmail(t0.db, "re_fixture_key", "Crestmont <support@crestmontwebsitedevelopment.com>", failing) };
  const t = { ...t0, fake };
  const rep = await staffClient(t, "owner", "owner-send@crestmont.test");
  const r = await t.client().request("POST", "/api/leads", { body: JSON.stringify({ name: "Send Fixture", email: "send@fixture.example", interest: "custom", message: "Please quote a custom portal.", source: "quote_form" }), headers: { "content-type": "application/json" } });
  const { leadId } = (await r.json()) as { leadId: string };
  for (const to of ["qualified", "quote_required"]) await rep.c.post(`/staff/crm/leads/${leadId}/stage`, { to });
  const save = await rep.c.post(`/staff/quotes/new?lead=${leadId}`, { package: "custom", line_desc: ["Portal", ""], line_amount: ["5,000", ""], scope: "Custom web application with a customer portal for orders.", valid_until: new Date(Date.now() + 10 * 86400e3).toISOString().slice(0, 10) });
  const quoteId = save.headers.get("location")!.split("/").pop()!;
  const sent = await rep.c.post(`/staff/quotes/${quoteId}/send`);
  assert.equal(sent.status, 303);
  const flash = decodeURIComponent(rep.c.cookies.get("cm_flash") ?? "");
  assert.doesNotMatch(flash, /Proposal emailed\./);
  assert.match(flash, /NOT delivered \(failed/);
  assert.match(flash, /\/q\/[0-9a-f]{64}/, "the link is shown so staff can share it");
  assert.match(await (await rep.c.get(`/staff/quotes/${quoteId}`)).text(), /NOT delivered/);
  assert.match((await one<{ body: string }>(t.db, `SELECT body FROM crm_activities WHERE lead_id = ? AND kind = 'email' ORDER BY created_at DESC LIMIT 1`, leadId)).body, /was not delivered \(failed\)/);
  // Development outbox: queued, never "emailed".
  const d = await app();
  const q = await quoteFlow(d, { email: "outbox-send@fixture.example" });
  const f2 = decodeURIComponent(q.rep.c.cookies.get("cm_flash") ?? "");
  void q.sent;
  assert.doesNotMatch(f2, /Proposal emailed\./);
  assert.match(f2, /queued and has not been delivered/);
});

test("[SALES-003] proposal expiry and follow-up due times use the end of the day in America/New_York", async () => {
  let now = new Date("2026-11-10T15:00:00.000Z");
  const fake = new FakePayments();
  const t0 = await createTestApp({ STRIPE_WEBHOOK_SECRET: WHSEC, overrides: { payments: fake, now: () => now } });
  const t = { ...t0, fake };
  const q = await quoteFlow(t, { email: "tz@fixture.example", validUntil: "2026-11-12" });
  assert.equal((await one<{ expires_at: string }>(t.db, `SELECT expires_at FROM quote_access_tokens WHERE quote_id = ?`, q.quoteId)).expires_at, "2026-11-13T04:59:59.999Z", "23:59:59.999 EST");
  // 23:30 Eastern on the valid-until date (04:30 UTC the next day): still open, acceptance works.
  now = new Date("2026-11-13T04:30:00.000Z");
  assert.match(await (await q.cu.c.get(q.qpath)).text(), /Accept this proposal/);
  assert.equal((await q.cu.c.post(`${q.qpath}/accept`, { agree: "1" })).status, 303);
  // A second proposal: 00:30 Eastern the next day it has expired.
  const q2 = await quoteFlow(t, { email: "tz2@fixture.example", validUntil: "2026-11-13" });
  now = new Date("2026-11-14T05:30:00.000Z");
  assert.match(await (await q2.cu.c.get(q2.qpath)).text(), /This proposal has expired/);
  assert.equal(endOfBusinessDay("2026-07-04"), "2026-07-05T03:59:59.999Z", "EDT in summer");
});

// ───────────── CREST-GAP-035: automatic email retry ─────────────

test("[EMAIL-003] queued Resend deliveries are retried by the scheduled job with backoff (500 then 200 → sent); stuck messages are counted and flagged", async () => {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner", "owner-email@crestmont.test");
  let fail = true;
  const calls: string[] = [];
  // Resend FIXTURE: first call 500, then 200.
  const fx = (async (_u: string, init: RequestInit) => {
    calls.push(String((init.headers as Record<string, string>)["idempotency-key"]));
    return fail ? new Response(JSON.stringify({ message: "fixture 500" }), { status: 500 }) : new Response(JSON.stringify({ id: "re_msg_fixture" }), { status: 200 });
  }) as unknown as typeof fetch;
  const resend = new ResendEmail(t.db, "re_fixture_key", "Crestmont <support@crestmontwebsitedevelopment.com>", fx);
  t.env.overrides = { ...t.env.overrides, email: resend };
  const res = await resend.send({ to: "retry@fixture.example", subject: "S", html: "<p>x</p>", text: "x", template: "receipt", idempotencyKey: "retry:1" });
  assert.equal(res.status, "failed");
  const row = await one<{ id: string; status: string; attempts: number }>(t.db, `SELECT id, status, attempts FROM email_deliveries WHERE idempotency_key = 'retry:1'`);
  assert.deepEqual({ status: row.status, attempts: row.attempts }, { status: "queued", attempts: 1 });
  fail = false;
  // Within the backoff window nothing is retried.
  let r = await runJobs(t.env, ["email_retry"]);
  assert.match(r.email_retry.detail, /^0 queued deliveries retried/);
  await t.db.prepare(`UPDATE email_deliveries SET updated_at = ? WHERE id = ?`).bind(new Date(Date.now() - 6 * 60_000).toISOString(), row.id).run();
  r = await runJobs(t.env, ["email_retry"]);
  assert.match(r.email_retry.detail, /^1 queued deliveries retried, 1 sent; 0 stuck/);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM email_deliveries WHERE id = ?`, row.id)).status, "sent");
  assert.deepEqual(calls, ["retry:1", "retry:1"], "same idempotency key, so Resend never sends twice");
  // Stuck signal: a queued message whose last attempt was over an hour ago and that keeps failing.
  fail = true;
  await resend.send({ to: "stuck@fixture.example", subject: "S", html: "<p>x</p>", text: "x", template: "receipt", idempotencyKey: "retry:stuck" });
  await t.db.prepare(`UPDATE email_deliveries SET updated_at = ? WHERE idempotency_key = 'retry:stuck'`).bind(new Date(Date.now() - 2 * 3600e3).toISOString()).run();
  await t.db.prepare(`UPDATE email_deliveries SET attempts = 5 WHERE idempotency_key = 'retry:stuck'`).run(); // exhausted attempts: not retried, still counted
  r = await runJobs(t.env, ["email_retry"]);
  assert.match(r.email_retry.detail, /1 stuck/);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND kind = 'email_stuck'`, owner.id), 1);
  await runJobs(t.env, ["email_retry"]);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND kind = 'email_stuck'`, owner.id), 1, "at most one notice per day");
  // The development outbox is never "retried" into a send.
  const dev = await createTestApp();
  await new OutboxEmail(dev.db).send({ to: "o@fixture.example", subject: "S", html: "x", text: "x", template: "receipt", idempotencyKey: "o:1" });
  assert.match((await runJobs(dev.env, ["email_retry"])).email_retry.detail, /retry skipped/);
});
