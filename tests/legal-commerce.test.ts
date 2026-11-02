// Agreement versioning/acceptance (LEGAL-003), printable receipts (PAY-005) and Founder-approved
// price changes (CAT-007). All records created here are TEST DATA; the Stripe adapter is a local fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, lastEmail, linkFrom, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import type { PaymentsAdapter, CheckoutRequest } from "../src/adapters/payments.ts";
import type { Env } from "../src/app/context.ts";
import type { Actor } from "../src/domain/authz.ts";
import { MAINTENANCE_PLANS, PACKAGES, priceQuote, type MaintenanceDef } from "../src/domain/catalog.ts";
import { agreementDrift, factsFromSettings, renderAll, AGREEMENT_KINDS, SEED_VERSION } from "../src/services/agreements.ts";
import { sha256Hex } from "../src/lib/crypto.ts";
import { decidePriceChange, proposePriceChange, effectivePrice, withEffectivePackagePrice } from "../src/services/pricing-approvals.ts";
import { startMaintenanceCheckout } from "../src/services/billing.ts";
import { buildContext } from "../src/app/app.ts";
import { HttpError } from "../src/app/http.ts";

class FakePayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  checkouts: CheckoutRequest[] = [];
  async createCheckout(req: CheckoutRequest) { this.checkouts.push(req); const id = `cs_test_lc_${this.checkouts.length}`; return { id, url: `https://checkout.stripe.com/c/pay/${id}` }; }
  async createBillingPortal(customerId: string) { return { url: `https://billing.stripe.com/p/session/test_${customerId}` }; }
  async createRefund(pi: string, amount: number) { return { id: `re_test_${pi}_${amount}`, status: "succeeded" }; }
}

const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;
const all = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).all<T>()).results;

async function app(payments = true) {
  const fake = new FakePayments();
  let clock = Date.now();
  const t = await createTestApp({ overrides: { ...(payments ? { payments: fake } : {}), now: () => new Date(clock) } });
  return { ...t, fake, advance: (ms: number) => { clock += ms; }, now: () => new Date(clock) };
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
async function seedPayment(db: Env["DB"], orgId: string, amount = 99_900) {
  const sfx = Math.random().toString(16).slice(2, 10), at = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, created_at) VALUES (?,?,'starter',?,'paid','package',?)`).bind(`ord_${sfx}`, orgId, amount, at),
    db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, description, created_at, paid_at, stripe_checkout_session_id) VALUES (?,?,?,'full',?,'paid','Starter package — 100% upfront',?,?,'cs_test_seed')`).bind(`inv_${sfx}`, orgId, `ord_${sfx}`, amount, at, at),
    db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, order_id, amount_cents, stripe_payment_intent_id, stripe_charge_id, status, created_at) VALUES (?,?,?,?,?,?,?, 'succeeded', ?)`).bind(`pay_${sfx}`, orgId, `inv_${sfx}`, `ord_${sfx}`, amount, `pi_test_${sfx}`, `ch_test_${sfx}`, at),
  ]);
  return { pay: `pay_${sfx}`, inv: `inv_${sfx}`, pi: `pi_test_${sfx}` };
}
const acceptances = (db: Env["DB"], userId: string) => all<{ kind: string; version: string; context_type: string; ip: string | null; body_sha256: string }>(db,
  `SELECT a.kind, a.version, x.context_type, x.ip, a.body_sha256 FROM agreement_acceptances x JOIN agreements a ON a.id = x.agreement_id WHERE x.user_id = ? ORDER BY a.kind`, userId);

// ───────────────────────── LEGAL-003 ─────────────────────────

test("[LEGAL-003] every policy in src/content/legal.ts has a seeded draft version whose SHA-256 matches the current text (fails until a new version row exists)", async () => {
  const t = await app(false);
  const rendered = await renderAll(factsFromSettings({}));
  assert.equal(rendered.length, Object.keys(AGREEMENT_KINDS).length);
  for (const r of rendered) {
    const row = await one<{ version: string; body_sha256: string; body_text: string; attorney_reviewed: number; effective_at: string | null } | null>(t.db,
      `SELECT version, body_sha256, body_text, attorney_reviewed, effective_at FROM agreements WHERE kind = ? AND body_sha256 = ?`, r.kind, r.sha256);
    assert.ok(row, `a stored draft version for ${r.kind} matches the current text`);
    assert.equal(row.attorney_reviewed, 0, "drafts are never marked attorney reviewed");
    assert.ok(row.effective_at);
    assert.equal(row.body_sha256, await sha256Hex(row.body_text), "stored hash is the hash of the stored text");
  }
  // Drift check: if legal copy changes, this fails until a migration adds a new version
  // (node --no-warnings scripts/agreement-versions.ts --sql <version>).
  assert.deepEqual(await agreementDrift(t.db, factsFromSettings({})), []);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM agreements WHERE attorney_reviewed <> 0`)).n, 0);
  // Versions are immutable.
  await assert.rejects(t.db.prepare(`UPDATE agreements SET body_text = 'x' WHERE kind = 'terms_of_service'`).run(), /immutable/);
});

test("[LEGAL-003] registration records Terms + Privacy acceptance tied to exact versions, with IP; nothing without the checkbox", async () => {
  const t = await app(false);
  const c = t.client();
  const refused = await c.post("/register", { name: "No Box", organization: "Nobox LLC", email: "nobox@example.com", password: TEST_PASSWORD });
  assert.equal(refused.status, 400);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM agreement_acceptances`)).n, 0);
  const res = await c.request("POST", "/register", { body: new URLSearchParams({ _csrf: c.cookies.get("cm_csrf")!, name: "Jordan Lee", organization: "Lee Bakery", email: "jordan@leebakery.example", password: TEST_PASSWORD, terms: "1" }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://crestmont.test", "cf-connecting-ip": "203.0.113.7" } });
  assert.equal(res.status, 200);
  const u = await one<{ id: string }>(t.db, `SELECT id FROM users WHERE email = 'jordan@leebakery.example'`);
  const rows = await acceptances(t.db, u.id);
  assert.deepEqual(rows.map((r) => [r.kind, r.version, r.context_type, r.ip]), [["privacy_policy", "2026-10-draft-2", "registration", "203.0.113.7"], ["terms_of_service", SEED_VERSION, "registration", "203.0.113.7"]]);
  const auditRow = await one<{ details_json: string }>(t.db, `SELECT details_json FROM audit_logs WHERE action = 'agreements.accepted' AND actor_user_id = ?`, u.id);
  assert.match(auditRow.details_json, /"context":"registration"/);
});

test("[LEGAL-003] quote acceptance and package checkout record the development agreement + terms; customer and staff views list them; version pages show the accepted text", async () => {
  const t = await app(true);
  // Package checkout: no acceptance without the checkbox, then exact versions with it.
  const cust = await customerClient(t, "buyer@lc.example", "Buyer Co");
  assert.equal((await cust.c.post("/checkout/starter", { maintenance_plan: "essential" })).status, 422);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM agreement_acceptances WHERE user_id = ?`, cust.id)).n, 0);
  assert.equal((await cust.c.post("/checkout/starter", { maintenance_plan: "essential", terms: "1" })).status, 303);
  const rows = await acceptances(t.db, cust.id);
  assert.deepEqual(rows.map((r) => r.kind), ["data_processing_addendum", "development_agreement", "refund_policy", "terms_of_service"]);
  assert.ok(rows.every((r) => r.context_type === "package_checkout" && r.version === (r.kind === "data_processing_addendum" ? "2026-10-draft-2" : SEED_VERSION)));

  // Quote acceptance (proposal flow).
  const rep = await staffClient(t, "owner");
  const lead = await t.client().request("POST", "/api/leads", { body: JSON.stringify({ name: "Quinn Proposal", email: "quinn@lc.example", company: "Quinn Co", interest: "custom", message: "We need a custom booking portal.", source: "quote_form" }), headers: { "content-type": "application/json" } });
  const leadId = ((await lead.json()) as { leadId: string }).leadId;
  for (const to of ["qualified", "quote_required"]) await rep.c.post(`/staff/crm/leads/${leadId}/stage`, { to });
  const save = await rep.c.post(`/staff/quotes/new?lead=${leadId}`, { package: "custom", line_desc: ["Booking portal"], line_amount: ["5000"], scope: "Custom booking portal with admin and customer accounts, 3 revision rounds.", valid_until: new Date(Date.now() + 20 * 86400e3).toISOString().slice(0, 10) });
  const quoteId = save.headers.get("location")!.split("/").pop()!;
  await rep.c.post(`/staff/quotes/${quoteId}/send`);
  const qpath = linkFrom((await lastEmail(t.db, "quinn@lc.example"))!.text_body, "/q/");
  const q = t.client();
  await q.post("/register", { name: "Quinn Proposal", organization: "Quinn Co", email: "quinn@lc.example", password: TEST_PASSWORD, terms: "1" });
  await q.get(linkFrom((await lastEmail(t.db, "quinn@lc.example"))!.text_body, "/verify-email"));
  await q.login("quinn@lc.example");
  assert.equal((await q.post(`${qpath}/accept`, {})).status, 422, "checkbox required");
  assert.equal((await q.post(`${qpath}/accept`, { agree: "1" })).status, 303);
  const qu = await one<{ id: string }>(t.db, `SELECT id FROM users WHERE email = 'quinn@lc.example'`);
  const qrows = (await acceptances(t.db, qu.id)).filter((r) => r.context_type === "quote_acceptance");
  assert.deepEqual(qrows.map((r) => r.kind), ["custom_development_agreement", "data_processing_addendum", "terms_of_service"]);

  // Customer view: own organization only.
  const mine = await (await cust.c.get("/portal/agreements")).text();
  assert.match(mine, /Development agreement information/);
  assert.match(mine, new RegExp(`/legal/development-agreement/versions/${SEED_VERSION}`));
  assert.doesNotMatch(mine, /quinn@lc\.example/);
  // Staff view (customers.read): sales can read; developer cannot.
  const sales = await staffClient(t, "sales");
  const staffView = await (await sales.c.get("/staff/legal")).text();
  assert.match(staffView, /buyer@lc\.example/);
  assert.match(staffView, /quinn@lc\.example/);
  assert.match(staffView, /Draft — not attorney reviewed/);
  const dev = await staffClient(t, "developer");
  assert.equal((await dev.c.get("/staff/legal")).status, 403);
  // Version page serves the stored text.
  const vp = await t.client().get(`/legal/terms/versions/${SEED_VERSION}`);
  assert.equal(vp.status, 200);
  const vhtml = await vp.text();
  assert.match(vhtml, /Limitation of liability/);
  assert.match(vhtml, /pending attorney review/);
  assert.equal((await t.client().get(`/legal/terms/versions/nope`)).status, 404);
  assert.equal((await t.client().get(`/legal/not-a-policy/versions/${SEED_VERSION}`)).status, 404);
});

test("[LEGAL-003] when the rendered text changes (business legal name set), the next acceptance stores and links a new exact version", async () => {
  const t = await app(true);
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('business.legal_name','Crestmont Test Entity LLC (TEST DATA)',?)`).bind(new Date().toISOString()).run();
  const cust = await customerClient(t, "drift@lc.example", "Drift Co");
  assert.equal((await cust.c.post("/checkout/business", { maintenance_plan: "professional", terms: "1" })).status, 303);
  const rows = await acceptances(t.db, cust.id);
  const terms = rows.find((r) => r.kind === "terms_of_service")!;
  assert.notEqual(terms.version, SEED_VERSION);
  const stored = await one<{ body_text: string; attorney_reviewed: number }>(t.db, `SELECT body_text, attorney_reviewed FROM agreements WHERE kind = 'terms_of_service' AND version = ?`, terms.version);
  assert.match(stored.body_text, /Crestmont Test Entity LLC/);
  assert.equal(stored.attorney_reviewed, 0);
  assert.equal(terms.body_sha256, await sha256Hex(stored.body_text));
  // The development agreement text does not mention the legal name, so it keeps the seed version.
  assert.equal(rows.find((r) => r.kind === "development_agreement")!.version, SEED_VERSION);
  assert.ok(await one(t.db, `SELECT 1 AS x FROM audit_logs WHERE action = 'agreement.version_created'`));
});

// ───────────────────────── PAY-005 / AUTH-008 ─────────────────────────

test("[PAY-005] printable receipt: stable unique number, payment/invoice/Stripe refs, honest business identity, print view; linked from billing and invoice", async () => {
  const t = await app(true);
  const a = await customerClient(t, "rcpt@lc.example", "Receipt Co");
  const p1 = await seedPayment(t.db, a.organizationId);
  const p2 = await seedPayment(t.db, a.organizationId, 249_900);
  const billing = await (await a.c.get("/portal/billing")).text();
  assert.match(billing, new RegExp(`/portal/billing/receipts/${p1.pay}`));
  assert.match(await (await a.c.get(`/portal/billing/invoices/${p1.inv}`)).text(), new RegExp(`/portal/billing/receipts/${p1.pay}`));

  const r1 = await a.c.get(`/portal/billing/receipts/${p1.pay}`);
  assert.equal(r1.status, 200);
  const h1 = await r1.text();
  const num1 = /CWD-R-\d{6}/.exec(h1)![0];
  assert.match(h1, /\$999/);
  assert.match(h1, new RegExp(p1.pi));
  assert.match(h1, new RegExp(p1.inv));
  assert.match(h1, /cs_test_seed/);
  assert.match(h1, /legal business name will appear here once the legal entity is established/);
  assert.match(h1, new RegExp(`/portal/billing/receipts/${p1.pay}/pdf`));
  assert.match(h1, /Print version/);
  // Stable across views; unique across payments.
  assert.equal(/CWD-R-\d{6}/.exec(await (await a.c.get(`/portal/billing/receipts/${p1.pay}`)).text())![0], num1);
  const num2 = /CWD-R-\d{6}/.exec(await (await a.c.get(`/portal/billing/receipts/${p2.pay}`)).text())![0];
  assert.notEqual(num1, num2);
  // Print view: standalone document with the print stylesheet.
  const pv = await (await a.c.get(`/portal/billing/receipts/${p1.pay}?view=print`)).text();
  assert.match(pv, /class="receipt-print"/);
  assert.match(pv, new RegExp(num1));
  // Legal identity from settings when set (never invented otherwise).
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('business.legal_name','Example Legal Name LLC (TEST DATA)',?), ('business.address','1 Test St, Testville (TEST DATA)',?)`).bind(new Date().toISOString(), new Date().toISOString()).run();
  const h3 = await (await a.c.get(`/portal/billing/receipts/${p1.pay}`)).text();
  assert.match(h3, /Example Legal Name LLC/);
  assert.match(h3, /1 Test St/);
  // Staff with finance.read see the same receipt number; others are refused.
  const owner = await staffClient(t, "owner");
  const sr = await owner.c.get(`/staff/finance/receipts/${p1.pay}`);
  assert.equal(sr.status, 200);
  assert.match(await sr.text(), new RegExp(num1));
  const support = await staffClient(t, "support");
  assert.equal((await support.c.get(`/staff/finance/receipts/${p1.pay}`)).status, 403);
  assert.equal((await owner.c.get(`/staff/finance/receipts/pay_missing`)).status, 404);
});

test("[AUTH-008] a customer cannot open another organization's receipt, and staff receipt routes refuse customers", async () => {
  const t = await app(true);
  const a = await customerClient(t, "ra@lc.example", "Alpha Receipts");
  const b = await customerClient(t, "rb@lc.example", "Beta Receipts");
  const pb = await seedPayment(t.db, b.organizationId);
  const denied = await a.c.get(`/portal/billing/receipts/${pb.pay}`);
  assert.equal(denied.status, 404);
  assert.doesNotMatch(await denied.text(), new RegExp(pb.pi));
  assert.equal((await b.c.get(`/portal/billing/receipts/${pb.pay}`)).status, 200);
  assert.equal((await a.c.get(`/staff/finance/receipts/${pb.pay}`)).status, 403);
  // Agreements are org-scoped too.
  await b.c.post("/checkout/starter", { maintenance_plan: "essential", terms: "1" });
  assert.doesNotMatch(await (await a.c.get("/portal/agreements")).text(), /rb@lc\.example/);
});

// ───────────────────────── CAT-007 ─────────────────────────

test("[CAT-007] price change: staff propose with a reason, only the Owner approves; public pricing, compare and checkout show the same effective price before and after; existing orders keep their price", async () => {
  const t = await app(true);
  const sales = await staffClient(t, "sales");
  const admin = await staffClient(t, "administrator");
  const dev = await staffClient(t, "developer");
  const owner = await staffClient(t, "owner");
  const cust = await customerClient(t, "price@lc.example", "Price Co");

  const prices = async () => {
    const pricing = await (await t.client().get("/pricing")).text();
    const compare = await (await t.client().get("/pricing/compare")).text();
    const checkout = await (await cust.c.get("/checkout/starter")).text();
    return {
      pricing: /data-testid="price-starter">([^<]+)</.exec(pricing)![1],
      compare: compare.includes(/data-testid="price-starter">([^<]+)</.exec(pricing)![1]),
      checkout: /data-testid="checkout-price">([^<]+)</.exec(checkout)![1],
    };
  };
  const before = await prices();
  assert.equal(before.pricing, "$999");
  assert.equal(before.checkout, "$999");
  assert.ok(before.compare);
  // An order placed before the change.
  assert.equal((await cust.c.post("/checkout/starter", { maintenance_plan: "essential", terms: "1" })).status, 303);
  const oldOrder = await one<{ id: string; total_cents: number }>(t.db, `SELECT id, total_cents FROM orders WHERE organization_id = ?`, cust.organizationId);

  // Developers cannot propose; reason is required.
  assert.equal((await dev.c.get("/staff/pricing")).status, 403);
  assert.equal((await dev.c.post("/staff/pricing", { item: "package:starter", proposed: "1099", effective_date: new Date().toISOString().slice(0, 10), reason: "Market adjustment for 2027" })).status, 403);
  const tomorrow = new Date(t.now().getTime() + 86400e3).toISOString().slice(0, 10);
  const noReason = await sales.c.post("/staff/pricing", { item: "package:starter", proposed: "1099", effective_date: tomorrow, reason: "" });
  assert.equal(noReason.status, 422);
  assert.equal((await admin.c.post("/staff/pricing", { item: "package:starter", proposed: "1099", effective_date: tomorrow, reason: "Founder-requested market adjustment (TEST DATA)" })).status, 303);
  const req = await one<{ id: string; status: string; current_cents: number; proposed_cents: number }>(t.db, `SELECT id, status, current_cents, proposed_cents FROM price_change_requests`);
  assert.deepEqual({ ...req, id: undefined }, { id: undefined, status: "pending", current_cents: 99_900, proposed_cents: 109_900 });
  assert.equal((await prices()).pricing, "$999", "a proposal alone changes nothing");

  // Non-owners cannot decide (audited denial).
  assert.equal((await sales.c.post(`/staff/pricing/${req.id}/decide`, { decision: "approved" })).status, 403);
  assert.equal((await admin.c.post(`/staff/pricing/${req.id}/decide`, { decision: "approved" })).status, 403);
  assert.ok(await one(t.db, `SELECT 1 AS x FROM audit_logs WHERE action = 'pricing.change_decision_denied'`));
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM price_change_requests WHERE id = ?`, req.id)).status, "pending");

  // Owner approves; effective tomorrow — until then everything still shows/charges the catalog price.
  assert.equal((await owner.c.post(`/staff/pricing/${req.id}/decide`, { decision: "approved", note: "Approved" })).status, 303);
  assert.equal((await owner.c.post(`/staff/pricing/${req.id}/decide`, { decision: "approved" })).status, 409, "decided once");
  const now = await prices();
  assert.equal(now.pricing, "$999");
  assert.equal(now.checkout, "$999");

  t.advance(2 * 86400e3);
  const after = await prices();
  assert.equal(after.pricing, "$1,099");
  assert.equal(after.checkout, "$1,099");
  assert.ok(after.compare, "compare shows the same effective price");
  t.fake.checkouts.length = 0;
  assert.equal((await cust.c.post("/checkout/starter", { maintenance_plan: "essential", terms: "1", price: "1", amount_cents: "100" })).status, 303);
  assert.equal(t.fake.checkouts[0].lines[0].amountCents, 109_900, "Stripe is asked for the effective price");
  const newOrder = await one<{ total_cents: number }>(t.db, `SELECT total_cents FROM orders WHERE organization_id = ? AND id <> ?`, cust.organizationId, oldOrder.id);
  assert.equal(newOrder.total_cents, 109_900);
  assert.equal((await one<{ total_cents: number }>(t.db, `SELECT total_cents FROM orders WHERE id = ?`, oldOrder.id)).total_cents, 99_900, "existing order keeps its stored price");
  assert.equal(PACKAGES.starter.basePriceCents, 99_900, "catalog itself is unchanged");

  const actions = (await all<{ action: string }>(t.db, `SELECT action FROM audit_logs WHERE subject_type = 'price_change_request' ORDER BY id`)).map((r) => r.action);
  assert.deepEqual(actions, ["pricing.change_proposed", "pricing.change_decision_denied", "pricing.change_decision_denied", "pricing.change_approved"]);
  assert.match(await (await owner.c.get("/staff/pricing")).text(), /data-testid="effective-package-starter">\$1,099/);
  // Overrides are immutable.
  await assert.rejects(t.db.prepare(`UPDATE price_overrides SET amount_cents = 1`).run(), /immutable/);
});

test("[CAT-007] AI and automation can never approve a price change, even with an Owner role; rejection needs a reason and changes nothing", async () => {
  const t = await app(false);
  const owner = await createStaff(t.db, "owner");
  const userOwner: Actor = { kind: "user", userId: owner.id, roles: [{ role: "owner", organizationId: owner.organizationId }], mfaVerified: true };
  const res = await proposePriceChange(t.db, userOwner, { itemType: "maintenance", itemId: "essential", proposed: "129", effectiveDate: t.now().toISOString().slice(0, 10), reason: "Hosting cost increase (TEST DATA)" }, t.now());
  assert.ok(res.ok);
  const id = (res as { id: string }).id;
  for (const kind of ["ai", "system", "webhook"] as const) {
    const bot: Actor = { kind, userId: owner.id, roles: [{ role: "owner", organizationId: owner.organizationId }], mfaVerified: true };
    await assert.rejects(decidePriceChange(t.db, bot, id, "approved", "", t.now()), (e) => e instanceof HttpError && e.status === 403);
    await assert.rejects(proposePriceChange(t.db, bot, { itemType: "package", itemId: "starter", proposed: "1", effectiveDate: "2027-01-01", reason: "automation attempt" }, t.now()), (e) => e instanceof HttpError && e.status === 403);
  }
  const noMfa: Actor = { ...userOwner, mfaVerified: false };
  await assert.rejects(decidePriceChange(t.db, noMfa, id, "approved", "", t.now()), /Only the Founder/);
  await assert.rejects(decidePriceChange(t.db, userOwner, id, "rejected", "", t.now()), /reason/);
  await decidePriceChange(t.db, userOwner, id, "rejected", "Not now", t.now());
  assert.equal((await effectivePrice(t.db, "maintenance", "essential", new Date(Date.now() + 365 * 86400e3))).cents, 9_900);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM price_overrides`)).n, 0);
});

test("[CAT-007] an approved maintenance price applies to maintenance checkout only after its effective date (entitlements gate unchanged)", async () => {
  const t = await app(true);
  const owner = await createStaff(t.db, "owner");
  const actor: Actor = { kind: "user", userId: owner.id, roles: [{ role: "owner", organizationId: owner.organizationId }], mfaVerified: true };
  const eff = new Date(t.now().getTime() + 3 * 86400e3).toISOString().slice(0, 10);
  const r = await proposePriceChange(t.db, actor, { itemType: "maintenance", itemId: "essential", proposed: "119", effectiveDate: eff, reason: "Maintenance cost review (TEST DATA)" }, t.now());
  await decidePriceChange(t.db, actor, (r as { id: string }).id, "approved", "", t.now());

  const cust = await customerClient(t, "maint@lc.example", "Maint Co");
  // Gate still refuses the real (unapproved-entitlements) plan.
  assert.equal((await cust.c.post("/checkout/maintenance/essential", { terms: "1" })).status, 409);
  const approved: Record<string, MaintenanceDef> = { ...MAINTENANCE_PLANS, essential: { ...MAINTENANCE_PLANS.essential, entitlementsStatus: "approved" } };
  const ctxFor = async () => buildContext(new Request("http://crestmont.test/checkout/maintenance/essential", { headers: { cookie: `cm_session=${cust.c.cookies.get("cm_session")!}` } }), t.env);
  await startMaintenanceCheckout(await ctxFor(), { id: cust.id, email: cust.email }, cust.organizationId, "essential", approved);
  assert.equal(t.fake.checkouts.at(-1)!.lines[0].amountCents, 9_900, "before the effective date: catalog price");
  t.advance(4 * 86400e3);
  await startMaintenanceCheckout(await ctxFor(), { id: cust.id, email: cust.email }, cust.organizationId, "essential", approved);
  assert.equal(t.fake.checkouts.at(-1)!.lines[0].amountCents, 11_900, "after the effective date: approved price");
  assert.match(await (await t.client().get("/pricing")).text(), /data-testid="price-essential">\$119</);
});

test("[CAT-007] new package quotes use the effective price; priceQuote stays pure and custom quotes are unaffected", async () => {
  const t = await app(false);
  const owner = await createStaff(t.db, "owner");
  const actor: Actor = { kind: "user", userId: owner.id, roles: [{ role: "owner", organizationId: owner.organizationId }], mfaVerified: true };
  const r = await proposePriceChange(t.db, actor, { itemType: "package", itemId: "premium", proposed: "5499", effectiveDate: t.now().toISOString().slice(0, 10), reason: "Premium scope review (TEST DATA)" }, t.now());
  await decidePriceChange(t.db, actor, (r as { id: string }).id, "approved", "", t.now());
  const base = priceQuote({ packageId: "premium", customLines: [{ description: "Booking integration", amountCents: 100_000 }] });
  assert.equal(base.totalCents, 599_900, "pure catalog computation unchanged");
  const eff = await withEffectivePackagePrice(t.db, base, new Date(t.now().getTime() + 1000));
  assert.equal(eff.totalCents, 649_900);
  assert.deepEqual(eff.installments, [{ kind: "full", amountCents: 649_900 }]);
  const custom = priceQuote({ packageId: "custom", customLines: [{ description: "App", amountCents: 500_000 }] });
  assert.equal(await withEffectivePackagePrice(t.db, custom), custom);
});
