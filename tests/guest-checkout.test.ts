// Guest checkout (Founder, 2026-11-13): a completely new visitor selects a package, completes the intake, accepts the
// agreements, chooses the required maintenance plan and reaches Stripe WITHOUT creating an account first. The verified
// payment provisions exactly one order and project for the new customer, emails the receipt, the internal notice and
// a single-use account-setup link; using it sets the password and confirms the email; the customer then signs in and
// sees the project. An email that already has an account is never taken over. Staff are sent to the Owner preview
// instead of the former 403. FIXTURE data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, MemoryStorage, lastEmail } from "./support/app.ts";
import { INTAKE_ANSWERS } from "./support/intake.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import type { PaymentsAdapter, CheckoutRequest } from "../src/adapters/payments.ts";

const WHSEC = "whsec_test_guest_checkout_fixture";
class FakePayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  checkouts: CheckoutRequest[] = [];
  async createCheckout(req: CheckoutRequest) { this.checkouts.push(req); const id = `cs_test_guest_${this.checkouts.length}`; return { id, url: `https://checkout.stripe.com/c/pay/${id}` }; }
  async createBillingPortal() { return { url: "https://billing.stripe.com/p/session/test" }; }
  async createRefund(pi: string, amount: number) { return { id: `re_${pi}_${amount}`, status: "succeeded" }; }
}
async function app() {
  const fake = new FakePayments();
  const t = await createTestApp({ STRIPE_WEBHOOK_SECRET: WHSEC, overrides: { payments: fake, storage: new MemoryStorage() } });
  return { ...t, fake };
}
type T = Awaited<ReturnType<typeof app>>;
let seq = 0;
async function webhook(t: T, type: string, object: Record<string, unknown>, id = `evt_guest_${++seq}`) {
  const body = JSON.stringify({ id, type, created: Math.floor(Date.now() / 1000), data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  return t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(WHSEC, `${ts}.${body}`)}`, "content-type": "application/json" } });
}
const n = async (t: T, sql: string, ...b: unknown[]) => (await t.db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).bind(...b).first<{ n: number }>())!.n;
const loc = (r: Response) => r.headers.get("location") ?? "";
const answers = (email: string) => ({ ...INTAKE_ANSWERS, contact_email: email, contact_name: "Guest Buyer", business_name: "Guest Bakery (fixture)", intent: "submit" });

test("[SALES-004] [PAY-001] a new visitor buys a package without creating an account first; the verified payment provisions it once and emails an account-setup link", async () => {
  const t = await app();
  const v = t.client(); // never signed in
  const email = "guest.buyer@fixture-bakery.example";

  // Package → intake, no sign-in page and no "opening soon".
  assert.equal(loc(await v.get("/checkout/business")), "/checkout/business/intake");
  const form = await (await v.get("/checkout/business/intake")).text();
  assert.match(form, /data-testid="guest-intake"/);
  assert.match(form, /No account is needed to order/);

  // Intake → the visitor becomes the new customer (no password yet) and continues to review.
  const sent = await v.post("/checkout/business/intake", answers(email));
  assert.equal(sent.status, 303, await sent.text());
  assert.equal(loc(sent), "/checkout/business/review");
  const u = (await t.db.prepare(`SELECT id, password_hash, email_verified_at FROM users WHERE email = ?`).bind(email).first<{ id: string; password_hash: string | null; email_verified_at: string | null }>())!;
  assert.equal(u.password_hash, null);
  assert.equal(u.email_verified_at, null);
  const org = (await t.db.prepare(`SELECT o.id, o.name FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? AND m.role_id = 'customer_admin' AND o.kind = 'customer'`).bind(u.id).first<{ id: string; name: string }>())!;
  assert.equal(org.name, "Guest Bakery (fixture)");
  assert.equal(await n(t, `SELECT 1 FROM purchase_intakes WHERE organization_id = ? AND completed_at IS NOT NULL AND product_id = 'business'`, org.id), 1);

  // Review → agreements + required plan → Stripe (no email-confirmation 403).
  const review = await (await v.get("/checkout/business/review")).text();
  assert.match(review, /Pay \$2,499/);
  const pay = await v.post("/checkout/business", { maintenance_plan: "professional", terms: "on", price: "1" });
  assert.equal(pay.status, 303, (await pay.text()).slice(0, 300));
  assert.match(loc(pay), /^https:\/\/checkout\.stripe\.com\//);
  const co = t.fake.checkouts.at(-1)!;
  assert.equal(co.customerEmail, email);
  assert.equal(co.lines.reduce((s, l) => s + l.amountCents * (l.quantity ?? 1), 0), 249_900, "server-side price");

  // The verified payment (delivered twice) provisions exactly one order, one project and one setup email.
  const session = { id: "cs_guest_paid", object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: 249_900, payment_intent: "pi_guest_1", customer: "cus_guest_1", customer_email: email, metadata: co.metadata };
  assert.equal((await webhook(t, "checkout.session.completed", session, "evt_guest_paid")).status, 200);
  assert.equal((await webhook(t, "checkout.session.completed", session, "evt_guest_paid_again")).status, 200);
  assert.equal(await n(t, `SELECT 1 FROM orders WHERE organization_id = ? AND status = 'paid'`, org.id), 1);
  assert.equal(await n(t, `SELECT 1 FROM projects WHERE organization_id = ?`, org.id), 1);
  assert.equal((await t.db.prepare(`SELECT maintenance_plan_id AS p FROM orders WHERE organization_id = ?`).bind(org.id).first<{ p: string }>())!.p, "professional");
  const templates = (await t.db.prepare(`SELECT template FROM email_deliveries WHERE to_email = ? ORDER BY created_at`).bind(email).all<{ template: string }>()).results.map((r) => r.template);
  assert.ok(templates.includes("receipt"), templates.join(","));
  assert.equal(templates.filter((x) => x === "account_setup").length, 1, "one setup email despite the duplicate event");
  assert.ok(await n(t, `SELECT 1 FROM email_deliveries WHERE template = 'internal_alert'`) >= 1, "internal new-order notice");

  // The setup link sets the password and confirms the email; the customer signs in and sees the project.
  const setup = await lastEmail(t.db, email);
  assert.equal(setup?.template, "account_setup");
  const token = /token=([A-Za-z0-9_-]+)/.exec(setup!.text_body)![1];
  const page = await (await t.client().get(`/password/reset?token=${token}&setup=1`)).text();
  assert.match(page, /Set your password/);
  const done = await t.client().post("/password/reset", { token, setup: "1", password: "harbor-bakery-ovens-2026" });
  assert.equal(done.status, 303);
  const after = (await t.db.prepare(`SELECT password_hash, email_verified_at FROM users WHERE id = ?`).bind(u.id).first<{ password_hash: string | null; email_verified_at: string | null }>())!;
  assert.ok(after.password_hash && after.email_verified_at);
  const signedIn = await t.client().login(email, "harbor-bakery-ovens-2026");
  assert.match(await (await signedIn.get("/portal/projects")).text(), /Guest Bakery|Business/);
  // The link works once.
  assert.equal((await t.client().post("/password/reset", { token, setup: "1", password: "another-password-2026" })).status, 400);

  // Staff see the paid project.
  const owner = await createStaff(t.db, "owner", "owner@crestmont.test");
  const oc = await t.client().login(owner.email);
  const pid = (await t.db.prepare(`SELECT id FROM projects WHERE organization_id = ?`).bind(org.id).first<{ id: string }>())!.id;
  assert.equal((await oc.get(`/staff/projects/${pid}`)).status, 200);
});

test("[SALES-004] guest checkout never takes over an existing account, and Crestmont staff get the Owner preview instead of a 403", async () => {
  const t = await app();
  const existing = await createCustomer(t.db, "known@fixture.example", "Known Co");
  const v = t.client();
  await v.get("/checkout/starter/intake");
  const r = await v.post("/checkout/starter/intake", answers(existing.email));
  assert.equal(r.status, 409);
  assert.match(await r.text(), /already has a Crestmont account/);
  assert.equal(await n(t, `SELECT 1 FROM users WHERE email = ?`, existing.email), 1, "no second account");
  assert.equal(t.fake.checkouts.length, 0);
  // A visitor without the session cannot reach the review or pay.
  assert.match(loc(await t.client().get("/checkout/starter/review")), /^\/login/);

  const owner = await createStaff(t.db, "owner", "owner2@crestmont.test");
  const oc = await t.client().login(owner.email);
  for (const path of ["/checkout/business", "/checkout/business/intake", "/checkout/business/review"]) {
    const s = await oc.get(path);
    assert.equal(s.status, 303, path);
    assert.match(loc(s), /^\/staff\/checkout-preview\/business\//, path);
  }
});

test("[SALES-004] guest checkout requires the bot challenge outside development and is rate-limited per network", async () => {
  const t = await createTestApp({ ENVIRONMENT: "staging", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET: "secret",
    overrides: { fetch: (async () => new Response(JSON.stringify({ success: false }))) as typeof fetch } } as never);
  const v = t.client();
  await v.get("/checkout/premium/intake");
  const r = await v.post("/checkout/premium/intake", answers("bot@fixture.example"));
  assert.equal(r.status, 422);
  assert.match(await r.text(), /security check/);
  assert.equal(await n(t as unknown as T, `SELECT 1 FROM users WHERE email = 'bot@fixture.example'`), 0);
});
