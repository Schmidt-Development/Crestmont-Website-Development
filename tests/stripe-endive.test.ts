// Staging APP_URL, Stripe webhook endpoints on 2026-10-28.endive, and exactly-once refund confirmation emails.
// All records are TEST DATA. Stripe is never called: events are SIGNED FIXTURES posted to the real webhook route, and the
// pinned-version refund lookup runs against a recording fake fetch. Payload shapes follow Stripe's changelog (SIMULATED,
// not events from a real Stripe account): charge payloads at 2022-11-15+ carry no Charge.refunds list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { nowIso } from "../src/lib/db.ts";
import type { Env } from "../src/app/context.ts";
import type { PaymentsAdapter, CheckoutRequest } from "../src/adapters/payments.ts";
import { STRIPE_API_VERSION, SUPPORTED_WEBHOOK_API_VERSIONS } from "../src/adapters/payments.ts";
import { STRIPE_WEBHOOK_EVENTS } from "../src/domain/stripe-events.ts";
import { webhookEndpointProblem, verifyIntegration } from "../src/services/integrations.ts";
import { chargeLatestRefund, chargeLacksRefundList } from "../src/domain/stripe-shapes.ts";
import { runJobs } from "../src/app/scheduled.ts";

const WHSEC = "whsec_test_endive_fixture";
const STAGING = "https://crestmont-platform-staging.partners-df4.workers.dev";
const nowS = () => Math.floor(Date.now() / 1000);
let seq = 0;
const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;
const count = async (db: Env["DB"], sql: string, ...b: unknown[]) => (await one<{ n: number }>(db, sql, ...b)).n;

const toml = readFileSync("wrangler.toml", "utf8");
const envBlock = (name: string) => { const s = toml.indexOf(`[env.${name}]`); const e = toml.indexOf("\n[env.", s + 1); return toml.slice(s, e > 0 ? e : undefined).replace(/^#.*$/gm, ""); };
const appUrlOf = (name: string) => /APP_URL = "([^"]+)"/.exec(envBlock(name))?.[1];

// ───────────── Staging APP_URL ─────────────

test("[INFRA-002] staging sets APP_URL to its own workers.dev host; production keeps the custom domain; they never share a URL", () => {
  assert.equal(appUrlOf("staging"), STAGING);
  assert.equal(appUrlOf("production"), "https://crestmontwebsitedevelopment.com");
  // The same host the staging workflows probe by default (STAGING_URL overrides it).
  for (const wf of ["staging-health-monitor.yml", "staging-rollback-rehearsal.yml", "staging-restore-drill.yml"]) {
    assert.ok(readFileSync(`.github/workflows/${wf}`, "utf8").includes(`vars.STAGING_URL || '${STAGING}'`), wf);
  }
  // The Stripe probe now looks for the staging test webhook at the real staging URL (it looked for "/api/webhooks/stripe").
  const ep = { url: `${STAGING}/api/webhooks/stripe`, status: "enabled", api_version: "2026-10-28.endive", enabled_events: ["*"] };
  assert.equal(webhookEndpointProblem([ep], appUrlOf("staging")), null);
  assert.match(webhookEndpointProblem([ep], undefined)!, /no webhook endpoint is registered for \/api\/webhooks\/stripe/);
  assert.match(webhookEndpointProblem([ep], appUrlOf("production"))!, /no webhook endpoint is registered for https:\/\/crestmontwebsitedevelopment\.com/, "staging's endpoint never satisfies production");
});

test("[PAY-003] scheduled Stripe retries on staging email links to the staging site, not https://scheduled.invalid", async () => {
  const linkAfterRetry = async (appUrl: string | undefined) => {
    const t = await createTestApp({ APP_URL: appUrl });
    const id = `evt_retry_${++seq}`;
    const payload = JSON.stringify({ id, type: "checkout.session.async_payment_failed", created: nowS(), data: { object: { id: `cs_retry_${seq}`, object: "checkout.session", customer_email: "retry@fixture.example", metadata: { invoice_id: "inv_retry" } } } });
    await t.db.prepare(`INSERT INTO stripe_events (id, type, object_id, stripe_created, payload, status, attempts, received_at) VALUES (?, 'checkout.session.async_payment_failed', ?, ?, ?, 'failed', 1, ?)`).bind(id, `cs_retry_${seq}`, nowS(), payload, nowIso()).run();
    const res = await runJobs(t.env, ["stripe_reconcile"]);
    assert.equal(res.stripe_reconcile.ok, true);
    return (await one<{ text_body: string }>(t.db, `SELECT m.text_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.to_email = 'retry@fixture.example'`)).text_body;
  };
  const staged = await linkAfterRetry(appUrlOf("staging"));
  assert.ok(staged.includes(`${STAGING}/portal/billing/invoices/inv_retry`), staged);
  assert.doesNotMatch(staged, /scheduled\.invalid/);
  // The defect this fixes: with no APP_URL a cron run has no request origin to fall back on.
  assert.match(await linkAfterRetry(undefined), /https:\/\/scheduled\.invalid\/portal\/billing/);
});

// ───────────── Webhook endpoints on 2026-10-28.endive ─────────────

test("[PAY-003] the webhook probe accepts endpoints on 2025-02-24.acacia or 2026-10-28.endive and refuses every untested version; requests stay pinned", async () => {
  assert.equal(STRIPE_API_VERSION, "2025-02-24.acacia", "requests are not upgraded by this change");
  assert.deepEqual([...SUPPORTED_WEBHOOK_API_VERSIONS], ["2025-02-24.acacia", "2026-10-28.endive"]);
  const base = { url: "https://crestmontwebsitedevelopment.com/api/webhooks/stripe", status: "enabled", enabled_events: [...STRIPE_WEBHOOK_EVENTS] };
  for (const v of SUPPORTED_WEBHOOK_API_VERSIONS) assert.equal(webhookEndpointProblem([{ ...base, api_version: v }], "https://crestmontwebsitedevelopment.com"), null, v);
  for (const v of ["2026-09-30.endive", "2025-09-30.clover", "2026-03-25.dahlia", "2025-03-31.basil", "2023-10-16", null]) {
    assert.match(webhookEndpointProblem([{ ...base, api_version: v }], "https://crestmontwebsitedevelopment.com")!, /expected 2025-02-24\.acacia or 2026-10-28\.endive/, String(v));
  }
  // End to end through the probe: verified, naming the endpoint's version and the pinned request version.
  const t = await createTestApp({ STRIPE_SECRET_KEY: "sk_test_endive_probe" });
  const versions: string[] = [];
  const f = (async (u: string | URL, init?: RequestInit) => {
    versions.push(new Headers(init?.headers).get("stripe-version") ?? "none");
    const body = String(u).includes("webhook_endpoints") ? { data: [{ ...base, url: "http://crestmont.test/api/webhooks/stripe", api_version: "2026-10-28.endive" }] } : { object: "balance", livemode: false };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const res = await verifyIntegration({ db: t.db, env: t.env, storage: null, fetchImpl: f }, "stripe", null);
  assert.equal(res.status, "verified", res.detail);
  assert.match(res.detail, /enabled at API version 2026-10-28\.endive with every handled event \(requests pinned to 2025-02-24\.acacia\)/);
  assert.deepEqual(versions, [STRIPE_API_VERSION, STRIPE_API_VERSION]);
});

test("[PAY-003] charge readers: pre-2022-11-15 payloads list refunds; acacia and endive payloads do not", () => {
  assert.deepEqual(chargeLatestRefund({ refunds: { data: [{ id: "re_new", amount: 500 }, { id: "re_old", amount: 100 }] } }), { id: "re_new", amount: 500 });
  assert.equal(chargeLacksRefundList({ refunds: { object: "list", data: [] } }), false, "an empty list is not a missing list");
  assert.equal(chargeLatestRefund({ refunds: { object: "list", data: [] } }), null);
  assert.equal(chargeLacksRefundList({ id: "ch_x", amount_refunded: 500 }), true);
  assert.equal(chargeLatestRefund({ id: "ch_x", amount_refunded: 500 }), null);
});

// ───────────── Exactly-once refund confirmation (CREST-GAP-039) ─────────────

/** FIXTURE Stripe: records refunds and serves GET /v1/refunds?charge= (newest first) at the pinned version. */
class FakeStripe implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  checkouts: CheckoutRequest[] = [];
  refundsByCharge = new Map<string, { id: string; amount: number }[]>();
  lookups: { url: string; version: string | null }[] = [];
  /** Runs inside createRefund, after Stripe has created the refund but before the call returns (webhook race). */
  onRefund: ((pi: string, refund: { id: string; amount: number }) => Promise<void>) | null = null;
  async createCheckout(req: CheckoutRequest) { this.checkouts.push(req); return { id: `cs_test_${this.checkouts.length}`, url: "https://checkout.stripe.com/c/pay/x" }; }
  async createBillingPortal() { return { url: "https://billing.stripe.com/p/session/x" }; }
  async createRefund(pi: string, amount: number) {
    const refund = this.addRefund(`ch_${pi.slice(3)}`, amount);
    if (this.onRefund) await this.onRefund(pi, refund);
    return { id: refund.id, status: "succeeded" };
  }
  addRefund(charge: string, amount: number) {
    const list = this.refundsByCharge.get(charge) ?? [];
    const refund = { id: `re_fixture_${charge.slice(3)}_${list.length + 1}`, amount };
    this.refundsByCharge.set(charge, [refund, ...list]);
    return refund;
  }
  fetch = (async (u: string | URL, init?: RequestInit) => {
    const url = new URL(String(u));
    this.lookups.push({ url: `${url.pathname}${url.search}`, version: new Headers(init?.headers).get("stripe-version") });
    if (url.pathname !== "/v1/refunds") return new Response(JSON.stringify({ error: { message: "unexpected" } }), { status: 404 });
    const data = (this.refundsByCharge.get(url.searchParams.get("charge") ?? "") ?? []).slice(0, Number(url.searchParams.get("limit") ?? 10)).map((r) => ({ ...r, object: "refund", livemode: false, status: "succeeded" }));
    return new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
  }) as typeof fetch;
}

async function app(extra: Partial<Env> = {}) {
  const stripe = new FakeStripe();
  const t = await createTestApp({ STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_SECRET_KEY: "sk_test_endive_fixture", ...extra, overrides: { payments: stripe, fetch: stripe.fetch } });
  return { ...t, stripe };
}
/** Posts a SIGNED FIXTURE event to the real webhook route. */
async function webhook(t: { client: () => TestClient }, type: string, object: Record<string, unknown>, id = `evt_endive_${++seq}`) {
  const body = JSON.stringify({ id, object: "event", api_version: "2026-10-28.endive", type, created: nowS(), livemode: false, data: { object } });
  const ts = nowS();
  return t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(WHSEC, `${ts}.${body}`)}`, "content-type": "application/json" } });
}
/** An endive-shaped refunded charge: no Charge.refunds list (2022-11-15+). */
const refundedCharge = (pi: string, amount: number, refunded: number, email: string) =>
  ({ id: `ch_${pi.slice(3)}`, object: "charge", payment_intent: pi, amount, amount_refunded: refunded, refunded: refunded >= amount, receipt_email: email, livemode: false });

async function staffClient(t: { db: Env["DB"]; client: () => TestClient }, role: Parameters<typeof createStaff>[1]) {
  const s = await createStaff(t.db, role);
  const c = t.client(); await c.login(s.email, TEST_PASSWORD, s.secret);
  return { ...s, c };
}
/** A paid order, then a customer refund request taken to Founder approval through the real routes. TEST DATA. */
async function approvedRefund(t: Awaited<ReturnType<typeof app>>, amountDollars = "500") {
  const email = `refund-${++seq}@fixture.example`;
  const cu = await createCustomer(t.db, email, `Refund Fixture ${seq} LLC`);
  const c = t.client(); await c.login(cu.email);
  const suffix = `endive${seq}`, pi = `pi_${suffix}`, at = nowIso();
  await t.db.batch([
    t.db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, created_at) VALUES (?,?, 'starter', 99900, 'paid', 'package', ?)`).bind(`ord_${suffix}`, cu.organizationId, at),
    t.db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, description, created_at, paid_at) VALUES (?,?,?, 'full', 99900, 'paid', 'Starter package — 100% upfront', ?, ?)`).bind(`inv_${suffix}`, cu.organizationId, `ord_${suffix}`, at, at),
    t.db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, order_id, amount_cents, stripe_payment_intent_id, status, created_at) VALUES (?,?,?,?, 99900, ?, 'succeeded', ?)`).bind(`pay_${suffix}`, cu.organizationId, `inv_${suffix}`, `ord_${suffix}`, pi, at),
  ]);
  assert.equal((await c.post("/portal/billing/refund-request", { payment_id: `pay_${suffix}`, amount: amountDollars, reason: "Project cancelled before kickoff." })).status, 303);
  const r = await one<{ id: string }>(t.db, `SELECT id FROM refunds WHERE payment_id = ?`, `pay_${suffix}`);
  const support = await staffClient(t, "support");
  assert.equal((await support.c.post(`/staff/refunds/${r.id}/review`, { to: "under_review", notes: "Checking" })).status, 303);
  assert.equal((await support.c.post(`/staff/refunds/${r.id}/review`, { to: "recommended", notes: "No work started" })).status, 303);
  const owner = await staffClient(t, "owner");
  assert.equal((await owner.c.post(`/staff/refunds/${r.id}/decide`, { decision: "approved", notes: "Approved per policy." })).status, 303);
  return { cu, email, pi, refundRequest: r.id, owner, payment: `pay_${suffix}` };
}
const issuedEmails = (db: Env["DB"], email: string) =>
  count(db, `SELECT COUNT(*) n FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.to_email = ? AND d.template = 'refund_decision' AND m.subject LIKE '%issued%'`, email);
const refundEmails = (db: Env["DB"], email: string) => count(db, `SELECT COUNT(*) n FROM email_deliveries WHERE to_email = ? AND template = 'refund_decision'`, email);
const issuedNotices = (db: Env["DB"], refundRequest: string) =>
  count(db, `SELECT COUNT(*) n FROM notifications WHERE kind = 'refund_update' AND subject_id = ? AND body LIKE '%issued%'`, refundRequest);

test("[PAY-007] a refund issued in the platform is confirmed once when the endive charge.refunded webhook arrives afterwards", async () => {
  const t = await app();
  const f = await approvedRefund(t);
  const before = await refundEmails(t.db, f.email); // request received, under review, approved
  assert.equal((await f.owner.c.post(`/staff/refunds/${f.refundRequest}/issue`)).status, 303);
  assert.equal(await refundEmails(t.db, f.email), before + 1);
  const rf = await one<{ status: string; stripe_refund_id: string }>(t.db, `SELECT status, stripe_refund_id FROM refunds WHERE id = ?`, f.refundRequest);
  assert.deepEqual({ ...rf }, { status: "issued", stripe_refund_id: `re_fixture_${f.pi.slice(3)}_1` });
  const res = await webhook(t, "charge.refunded", refundedCharge(f.pi, 99_900, 50_000, f.email));
  assert.equal(res.status, 200);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM stripe_events WHERE type = 'charge.refunded'`)).status, "processed");
  // Before the fix the payload's missing refund list made this a second, "Stripe refund" email keyed on the event id.
  assert.equal(await refundEmails(t.db, f.email), before + 1, "no second confirmation");
  assert.equal(await issuedEmails(t.db, f.email), 1);
  assert.equal(await issuedNotices(t.db, f.refundRequest), 1);
  // The refund was identified through the pinned-version lookup, never by expanding Charge.refunds.
  assert.deepEqual(t.stripe.lookups, [{ url: `/v1/refunds?charge=ch_${f.pi.slice(3)}&limit=1`, version: STRIPE_API_VERSION }]);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM payments WHERE id = ?`, f.payment)).status, "partially_refunded");
});

test("[PAY-007] the webhook racing the issue step (arriving before Stripe's response) still confirms the refund once", async () => {
  const t = await app();
  const f = await approvedRefund(t);
  const before = await refundEmails(t.db, f.email);
  let delivered = 0;
  t.stripe.onRefund = async (pi) => { delivered++; assert.equal((await webhook(t, "charge.refunded", refundedCharge(pi, 99_900, 50_000, f.email))).status, 200); };
  assert.equal((await f.owner.c.post(`/staff/refunds/${f.refundRequest}/issue`)).status, 303);
  assert.equal(delivered, 1);
  assert.equal(await refundEmails(t.db, f.email), before + 1, "webhook and issue step share one confirmation");
  assert.equal(await issuedEmails(t.db, f.email), 1);
  assert.equal(await issuedNotices(t.db, f.refundRequest), 1, "one in-app notice");
  const rf = await one<{ status: string; stripe_refund_id: string }>(t.db, `SELECT status, stripe_refund_id FROM refunds WHERE id = ?`, f.refundRequest);
  assert.deepEqual({ ...rf }, { status: "issued", stripe_refund_id: `re_fixture_${f.pi.slice(3)}_1` });
  assert.equal((await f.owner.c.post(`/staff/refunds/${f.refundRequest}/issue`)).status, 409, "cannot issue twice");
});

test("[PAY-007] an approved request completed in the Stripe Dashboard is confirmed once, and later issues are refused", async () => {
  const t = await app();
  const f = await approvedRefund(t);
  const before = await refundEmails(t.db, f.email);
  t.stripe.addRefund(`ch_${f.pi.slice(3)}`, 50_000);
  const charge = refundedCharge(f.pi, 99_900, 50_000, f.email);
  await webhook(t, "charge.refunded", charge);
  await webhook(t, "charge.refunded", charge); // the same refund delivered again under a new event id
  assert.equal(await refundEmails(t.db, f.email), before + 1);
  assert.equal(await issuedNotices(t.db, f.refundRequest), 1);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM refunds WHERE id = ?`, f.refundRequest)).status, "issued");
  assert.equal((await f.owner.c.post(`/staff/refunds/${f.refundRequest}/issue`)).status, 409);
});

test("[PAY-007] a Dashboard-only refund is emailed once per Stripe refund; a second partial refund gets its own email", async () => {
  const t = await app();
  const cu = await createCustomer(t.db, "dash@fixture.example", "Dashboard Fixture LLC");
  const at = nowIso();
  await t.db.prepare(`INSERT INTO payments (id, organization_id, amount_cents, stripe_payment_intent_id, status, created_at) VALUES ('pay_dash', ?, 99900, 'pi_dashonly', 'succeeded', ?)`).bind(cu.organizationId, at).run();
  t.stripe.addRefund("ch_dashonly", 10_000);
  await webhook(t, "charge.refunded", refundedCharge("pi_dashonly", 99_900, 10_000, cu.email));
  await webhook(t, "charge.refunded", refundedCharge("pi_dashonly", 99_900, 10_000, cu.email));
  assert.equal(await refundEmails(t.db, cu.email), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE idempotency_key = 'refund:stripe:re_fixture_dashonly_1'`), 1);
  t.stripe.addRefund("ch_dashonly", 5_000);
  await webhook(t, "charge.refunded", refundedCharge("pi_dashonly", 99_900, 15_000, cu.email));
  assert.equal(await refundEmails(t.db, cu.email), 2);
  assert.match((await one<{ text_body: string }>(t.db, `SELECT m.text_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.idempotency_key = 'refund:stripe:re_fixture_dashonly_2'`)).text_body, /\$50\.00/);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM payments WHERE id = 'pay_dash'`)).status, "partially_refunded");
});

test("[PAY-007] a late webhook for an issued refund never marks a different approved request as issued", async () => {
  const t = await app();
  const f = await approvedRefund(t, "100");
  assert.equal((await f.owner.c.post(`/staff/refunds/${f.refundRequest}/issue`)).status, 303);
  // A second request on the same payment is approved but not yet issued when the first refund's webhook arrives.
  const at = nowIso();
  await t.db.prepare(`INSERT INTO refunds (id, organization_id, payment_id, amount_cents, reason, status, requested_by, created_at) VALUES ('rf_second', ?, ?, 20000, 'Second fixture refund request', 'approved', ?, ?)`)
    .bind(f.cu.organizationId, f.payment, f.cu.id, at).run();
  await webhook(t, "charge.refunded", refundedCharge(f.pi, 99_900, 10_000, f.email));
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM refunds WHERE id = 'rf_second'`)).status, "approved");
  assert.equal(await issuedEmails(t.db, f.email), 1);
});

test("[PAY-007] without a way to look the refund up, an endive charge.refunded applies nothing and is retried later", async () => {
  const t = await app({ STRIPE_SECRET_KEY: undefined });
  const f = await approvedRefund(t);
  const before = await refundEmails(t.db, f.email);
  assert.equal((await webhook(t, "charge.refunded", refundedCharge(f.pi, 99_900, 50_000, f.email))).status, 200);
  const evt = await one<{ status: string; last_error: string }>(t.db, `SELECT status, last_error FROM stripe_events WHERE type = 'charge.refunded'`);
  assert.equal(evt.status, "failed");
  assert.match(evt.last_error, /no refund list and Stripe is not configured to look it up/);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM payments WHERE id = ?`, f.payment)).status, "succeeded", "nothing applied");
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM refunds WHERE id = ?`, f.refundRequest)).status, "approved");
  assert.equal(await refundEmails(t.db, f.email), before);
  // Once Stripe is configured, the scheduled retry applies it exactly once.
  t.stripe.addRefund(`ch_${f.pi.slice(3)}`, 50_000);
  const res = await runJobs({ ...t.env, STRIPE_SECRET_KEY: "sk_test_endive_fixture" }, ["stripe_reconcile"]);
  assert.equal(res.stripe_reconcile.ok, true, res.stripe_reconcile.detail);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM stripe_events WHERE type = 'charge.refunded'`)).status, "processed");
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM refunds WHERE id = ?`, f.refundRequest)).status, "issued");
  assert.equal(await refundEmails(t.db, f.email), before + 1);
});
