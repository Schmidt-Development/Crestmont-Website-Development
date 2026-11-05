// Phase 1 non-AI certification: ONE connected customer journey through the real request pipeline (src/app/app.ts),
// real migrations and real services, with the AI website generation gate closed as on production:
//
//   public site → registration → email verification → package selection → agreements → Stripe TEST-mode checkout
//   (signed webhook fixtures; FakePayments stands in for Stripe's API, so no Stripe account is contacted) → failed and
//   duplicate payment events → project → intake → staff assignment and reassignment → scope approval → design →
//   development → QA → customer review → customer-requested revision → files (unscanned, missing) → support →
//   maintenance subscription → cross-customer and permission refusals → expired session → MFA failure →
//   notification provider failure.
//
// Provider truth (docs/NON-AI-CERTIFICATION.md): Stripe and Resend are exercised through their real adapters' code
// paths with fixtures — this proves the platform's side, not a live provider connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, lastEmail, linkFrom, MemoryStorage, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import { FakePayments } from "./support/security-world.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { ResendEmail } from "../src/adapters/email.ts";
import { PACKAGES, MAINTENANCE_PLANS } from "../src/domain/catalog.ts";
import type { Env } from "../src/app/context.ts";

const WHSEC = "whsec_certification";
const MFA_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 53 + 7) % 256)).toString("base64");
type App = Awaited<ReturnType<typeof createTestApp>>;
const one = async <T>(t: App, sql: string, ...b: unknown[]) => (await t.db.prepare(sql).bind(...b).first<T>())!;
const count = async (t: App, sql: string, ...b: unknown[]) => (await one<{ n: number }>(t, sql, ...b)).n;

let evt = 0;
async function stripe(t: App, type: string, object: Record<string, unknown>, id = `evt_cert_${++evt}_${Date.now()}`) {
  const body = JSON.stringify({ id, type, livemode: false, created: Math.floor(Date.now() / 1000), data: { object: { livemode: false, ...object } } });
  const ts = Math.floor(Date.now() / 1000);
  const res = await t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(WHSEC, `${ts}.${body}`)}` } });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown>, id };
}
const INTAKE = { intent: "submit", business_name: "Harbor Bakery", contact_name: "Dana Reyes", contact_email: "dana@harbor.example", industry: "Bakery", goals: "More catering orders",
  target_audience: "Local offices", has_branding: "no", brand_style: "Warm and simple", pages: "Home\nMenu\nCatering\nAbout\nContact", content_source: "crestmont_draft", images_source: "licensed",
  domain_status: "need", domain_wishes: "harborbakery.example", hosting: "crestmont", functionality: ["contact_form"], competitors: "" };

test("phase 1 certification: the complete non-AI customer journey, with its failure cases, on a configuration with AI generation off", async () => {
  const t = await createTestApp({ AI_BUILD_AUTOMATION: "off", STRIPE_WEBHOOK_SECRET: WHSEC, MFA_ENCRYPTION_KEY: MFA_KEY, overrides: { storage: new MemoryStorage(), payments: new FakePayments() } } as Partial<Env>);
  const owner = await createStaff(t.db, "owner", "owner@crestmont.test", "Olivia Owner");
  const pmA = await createStaff(t.db, "project_manager", "pm.a@crestmont.test", "Pat Manager");
  const pmB = await createStaff(t.db, "project_manager", "pm.b@crestmont.test", "Quinn Manager");
  const supportAgent = await createStaff(t.db, "support", "support@crestmont.test", "Sam Support");
  const oc = await t.client().login(owner.email, undefined, owner.secret);
  const pmc = await t.client().login(pmA.email, undefined, pmA.secret);

  // ── 1. Public website: packages and prices are the approved ones; nothing promises automated delivery.
  const pricing = await (await t.client().get("/pricing")).text();
  for (const id of ["starter", "business", "premium"] as const) assert.ok(pricing.includes(PACKAGES[id].name), `pricing lists ${id}`);
  for (const price of ["$999", "$2,499", "$4,999"]) assert.ok(pricing.includes(price), `pricing shows ${price}`);

  // ── 2. Registration → email verification → sign in.
  const c = t.client();
  const email = "dana@harbor.example";
  assert.equal((await c.post("/register", { name: "Dana Reyes", organization: "Harbor Bakery", email, password: TEST_PASSWORD, terms: "1" })).status, 200);
  const verifyMail = await lastEmail(t.db, email);
  assert.equal(verifyMail?.template, "verification");
  assert.equal((await c.get(linkFrom(verifyMail!.text_body, "/verify-email"))).status, 303);
  assert.equal((await c.post("/login", { email, password: TEST_PASSWORD })).headers.get("location"), "/portal");
  const org = await one<{ id: string }>(t, `SELECT m.organization_id AS id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?`, email);

  // ── 3. Package selection + agreements: checkout refuses without acceptance, then records it against the order.
  const checkoutPage = await (await c.get("/checkout/business")).text();
  assert.match(checkoutPage, /\$2,499/, "the Business package at its approved price");
  assert.equal((await c.post("/checkout/business", {})).status, 422, "no order without accepting the agreements");
  assert.equal(await count(t, `SELECT COUNT(*) AS n FROM orders WHERE organization_id = ?`, org.id), 0);
  const go = await c.post("/checkout/business", { terms: "1" });
  assert.equal(go.status, 303);
  assert.match(go.headers.get("location") ?? "", /^https:\/\/checkout\.stripe\.com\//, "the customer is sent to Stripe Checkout (test mode)");
  const order = await one<{ id: string; total_cents: number }>(t, `SELECT id, total_cents FROM orders WHERE organization_id = ?`, org.id);
  assert.equal(order.total_cents, PACKAGES.business.basePriceCents, "server-side price, not the browser's");
  const inv = await one<{ id: string; amount_cents: number; status: string }>(t, `SELECT id, amount_cents, status FROM invoices WHERE order_id = ?`, order.id);
  assert.equal(inv.status, "open");
  const accepted = (await t.db.prepare(`SELECT a.kind, a.version, a.body_sha256 FROM agreement_acceptances x JOIN agreements a ON a.id = x.agreement_id WHERE x.organization_id = ? AND x.context_type = 'package_checkout' AND x.context_id = ?`).bind(org.id, order.id).all<{ kind: string; version: number; body_sha256: string }>()).results;
  assert.ok(accepted.length >= 2 && accepted.every((a) => /^[0-9a-f]{64}$/.test(a.body_sha256)), `the exact agreement texts accepted are recorded with their hashes (${accepted.map((a) => a.kind).join(", ")})`);
  const session = (status: string, pi: string) => ({ id: `cs_${pi}`, mode: "payment", payment_status: status, amount_total: inv.amount_cents, payment_intent: pi, metadata: { organization_id: org.id, invoice_id: inv.id, order_id: order.id, kind: "package" } });

  // ── 4. Failed payment: an async payment that fails leaves the invoice open and creates no project.
  assert.equal((await stripe(t, "checkout.session.async_payment_failed", session("unpaid", "pi_cert_fail"))).status, 200);
  assert.equal((await one<{ status: string }>(t, `SELECT status FROM invoices WHERE id = ?`, inv.id)).status, "open");
  assert.equal(await count(t, `SELECT COUNT(*) AS n FROM projects WHERE order_id = ?`, order.id), 0, "a failed payment provisions nothing");
  // An event with a bad signature is refused outright.
  const forged = await t.client().request("POST", "/api/webhooks/stripe", { body: JSON.stringify({ id: "evt_forged", type: "checkout.session.completed", data: { object: session("paid", "pi_forged") } }), headers: { "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` } });
  assert.ok(forged.status === 400 || forged.status === 401, `unsigned/forged webhooks are refused (${forged.status})`);
  assert.equal((await one<{ status: string }>(t, `SELECT status FROM invoices WHERE id = ?`, inv.id)).status, "open", "and mark nothing paid");

  // ── 5. Successful payment, delivered twice (Stripe retries) and once more under a different event id.
  const paid = await stripe(t, "checkout.session.completed", session("paid", "pi_cert_ok"));
  assert.equal(paid.status, 200);
  const again = await stripe(t, "checkout.session.completed", session("paid", "pi_cert_ok"), paid.id);
  assert.equal(again.json.duplicate, true, "the same event id is recognised as a redelivery");
  await stripe(t, "checkout.session.completed", session("paid", "pi_cert_ok"));
  assert.equal((await one<{ status: string }>(t, `SELECT status FROM invoices WHERE id = ?`, inv.id)).status, "paid");
  assert.equal(await count(t, `SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?`, inv.id), 1, "one payment however often Stripe tells us");
  assert.equal(await count(t, `SELECT COUNT(*) AS n FROM projects WHERE order_id = ?`, order.id), 1, "exactly one project");
  const pid = (await one<{ id: string }>(t, `SELECT id FROM projects WHERE order_id = ?`, order.id)).id;
  assert.equal((await lastEmail(t.db, email))?.template === "receipt" || (await count(t, `SELECT COUNT(*) AS n FROM email_deliveries WHERE to_email = ? AND template IN ('receipt','purchase')`, email)) >= 1, true, "the customer is told the payment arrived");

  // ── 6. Intake: the project moves to scope review and NO AI build is created (gate closed).
  assert.equal((await c.post(`/portal/projects/${pid}/onboarding`, INTAKE)).status, 303);
  assert.equal((await one<{ status: string }>(t, `SELECT status FROM projects WHERE id = ?`, pid)).status, "scope_review");
  assert.equal(await count(t, `SELECT COUNT(*) AS n FROM build_jobs`), 0, "no autonomous build exists");

  // ── 7. Staff assignment, then reassignment (audited); the second PM can work the project.
  assert.equal((await oc.post(`/staff/projects/${pid}/pm`, { user_id: pmA.id })).status, 303);
  assert.equal((await one<{ pm_user_id: string }>(t, `SELECT project_manager_id AS pm_user_id FROM projects WHERE id = ?`, pid)).pm_user_id, pmA.id);
  assert.equal((await oc.post(`/staff/projects/${pid}/pm`, { user_id: pmB.id })).status, 303);
  assert.equal((await one<{ pm_user_id: string }>(t, `SELECT project_manager_id AS pm_user_id FROM projects WHERE id = ?`, pid)).pm_user_id, pmB.id, "reassigned");
  assert.ok(await count(t, `SELECT COUNT(*) AS n FROM audit_logs WHERE subject_id = ? AND action LIKE 'project.%'`, pid) >= 2, "assignments are audited");
  const pmbc = await t.client().login(pmB.email, undefined, pmB.secret);

  // ── 8. Scope approval by the customer, then design → development → internal QA → customer review.
  assert.equal((await pmbc.post(`/staff/projects/${pid}/status`, { to: "design" })).status, 409, "design waits for an approved scope");
  assert.equal((await pmbc.post(`/staff/projects/${pid}/scope`, { scope: "Business package: 5 pages (Home, Menu, Catering, About, Contact), contact form, 2 revision rounds." })).status, 303);
  assert.equal((await pmbc.post(`/staff/projects/${pid}/request-approval`, { kind: "scope", note: "Please review the five-page scope for Harbor Bakery." })).status, 303);
  const notice = await one<{ body: string }>(t, `SELECT n.body FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = ? ORDER BY n.created_at DESC LIMIT 1`, email);
  assert.match(notice.body, /^Please review the five-page scope for Harbor Bakery\./, "the customer's notification says what to review, not only when");
  assert.equal((await c.post(`/portal/projects/${pid}/approvals`, { kind: "scope", decision: "approved", notes: "" })).status, 303);
  for (const to of ["design", "development", "internal_qa", "customer_review"]) {
    assert.equal((await pmbc.post(`/staff/projects/${pid}/status`, { to })).status, 303, to);
  }
  const portalProject = await (await c.get(`/portal/projects/${pid}`)).text();
  assert.match(portalProject, /Customer review/i, "the customer sees where the project is");

  // ── 9. Customer-requested revision: counted against the allowance, handled by people (no AI job).
  const rev = await c.post(`/portal/projects/${pid}/revisions`, { request: "Please make the catering menu the second item in the navigation.", kind: "change" });
  assert.equal(rev.status, 303);
  assert.equal(await count(t, `SELECT COUNT(*) AS n FROM revisions WHERE project_id = ?`, pid), 1);
  assert.equal(await count(t, `SELECT COUNT(*) AS n FROM build_jobs`), 0, "a revision does not reach the AI builder");

  // ── 10. Files: an upload is stored unscanned and never labelled clean; another customer's or a missing file is refused.
  const up = await c.post(`/portal/projects/${pid}/files`, { file: new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a])], "brand-guide.pdf", { type: "application/pdf" }), folder: "brand" });
  assert.equal(up.status, 303);
  const file = await one<{ id: string; scan_status: string }>(t, `SELECT id, scan_status FROM files WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`, pid);
  assert.equal(file.scan_status, "pending", "no scanner verdict, so not clean");
  assert.doesNotMatch(await (await c.get(`/portal/files/${file.id}`)).text(), /\bScanned clean\b|scan: clean/i, "an unscanned file is never shown as clean");
  assert.equal((await c.get(`/portal/files/fil_does_not_exist`)).status, 404, "a missing file is a 404, not an error");

  // ── 11. Support: the customer opens a ticket; support replies; the customer sees the reply.
  assert.equal((await c.post("/portal/support/new", { subject: "Menu photo question", category: "technical", description: "Can we use our own photos for the catering page?", project_id: pid })).status, 303);
  const ticket = await one<{ id: string }>(t, `SELECT id FROM tickets WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1`, org.id);
  const sc = await t.client().login(supportAgent.email, undefined, supportAgent.secret);
  assert.equal((await sc.post(`/staff/support/${ticket.id}/reply`, { body: "Yes, upload them in Files and we will place them." })).status, 303);
  assert.match(await (await c.get(`/portal/support/${ticket.id}`)).text(), /Yes, upload them in Files/);

  // ── 12. Maintenance: the plan page shows the approved monthly price; subscribing goes to Stripe; the signed
  //        subscription webhook records the plan against this customer.
  // The Founder approved the plans' entitlements (BLK-010, 23f56e1), so they are sold at $99 / $199 / $299 a month.
  const plans = Object.values(MAINTENANCE_PLANS) as { id: string; entitlementsStatus: string }[];
  assert.deepEqual(plans.map((p) => p.entitlementsStatus), ["approved", "approved", "approved"]);
  const hosting = await (await t.client().get("/hosting-maintenance")).text();
  for (const price of ["$99", "$199", "$299"]) assert.ok(hosting.includes(price), `maintenance page shows ${price}`);
  const plan = plans[0];
  const mPage = await c.get(`/checkout/maintenance/${plan.id}`);
  assert.equal(mPage.status, 200);
  assert.match(await mPage.text(), /\/month/);
  assert.equal((await c.post(`/checkout/maintenance/${plan.id}`, {})).status, 422, "no subscription without accepting the maintenance terms");
  const sub = await c.post(`/checkout/maintenance/${plan.id}`, { terms: "1" });
  assert.equal(sub.status, 303);
  assert.match(sub.headers.get("location") ?? "", /^https:\/\/checkout\.stripe\.com\//);
  assert.ok(await count(t, `SELECT COUNT(*) AS n FROM agreement_acceptances WHERE organization_id = ? AND context_type = 'maintenance_checkout'`, org.id) >= 1, "maintenance terms acceptance recorded");
  assert.equal((await stripe(t, "customer.subscription.created", { id: "sub_cert_1", status: "active", customer: "cus_cert", current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, metadata: { organization_id: org.id, product_id: plan.id } })).status, 200);
  assert.equal((await one<{ status: string }>(t, `SELECT status FROM subscriptions WHERE organization_id = ? AND product_id = ?`, org.id, plan.id)).status, "active");
  // A failed renewal (current Stripe shape: parent.subscription_details) marks the plan past due and tells the
  // customer how to fix it; the next paid invoice restores it. (Staging cannot force a renewal to fail without a
  // Stripe test clock — journey 25 is skipped there — so this is where the recovery path is proven.)
  const sid = { parent: { subscription_details: { subscription: "sub_cert_1" } } };
  assert.equal((await stripe(t, "invoice.payment_failed", { id: "in_cert_fail", customer: "cus_cert", customer_email: email, ...sid })).status, 200);
  assert.equal((await one<{ status: string }>(t, `SELECT status FROM subscriptions WHERE stripe_subscription_id = 'sub_cert_1'`)).status, "past_due");
  assert.equal((await lastEmail(t.db, email))?.template, "failed_payment", "the customer is told the renewal failed and where to update payment");
  assert.equal((await stripe(t, "invoice.paid", { id: "in_cert_retry", customer: "cus_cert", ...sid })).status, 200);
  assert.equal((await one<{ status: string }>(t, `SELECT status FROM subscriptions WHERE stripe_subscription_id = 'sub_cert_1'`)).status, "active", "recovered");
  // Cancellation arrives the same way and is reflected, not assumed.
  assert.equal((await stripe(t, "customer.subscription.deleted", { id: "sub_cert_1", status: "canceled", customer: "cus_cert", metadata: { organization_id: org.id, product_id: plan.id } })).status, 200);
  assert.equal((await one<{ status: string }>(t, `SELECT status FROM subscriptions WHERE organization_id = ? AND product_id = ?`, org.id, plan.id)).status, "canceled");

  // ── 13. Cross-customer and permission refusals on THIS journey's records.
  const other = await createCustomer(t.db, "rival@other.example", "Rival Bakery");
  const rc = await t.client().login(other.email, TEST_PASSWORD);
  for (const path of [`/portal/projects/${pid}`, `/portal/files/${file.id}`, `/portal/support/${ticket.id}`, `/portal/projects/${pid}/revisions`]) {
    const r = await rc.get(path);
    assert.ok(r.status === 404 || r.status === 403, `${path}: another customer is refused (${r.status})`);
    assert.doesNotMatch(await r.text(), /Harbor Bakery|brand-guide\.pdf|Menu photo question/, `${path}: nothing of this customer leaks`);
  }
  assert.equal((await c.get(`/staff/projects/${pid}`)).status, 403, "a customer cannot open staff pages");
  assert.equal((await sc.post(`/staff/projects/${pid}/status`, { to: "revisions" })).status, 403, "support staff cannot move a project");

  // ── 14. Expired session: the cookie stops working once the session has expired.
  await t.db.prepare(`UPDATE sessions SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)`).bind(new Date(Date.now() - 60_000).toISOString(), email).run();
  const expired = await c.get("/portal");
  assert.equal(expired.status, 303);
  assert.match(expired.headers.get("location") ?? "", /^\/login/);

  // ── 15. MFA failure: a wrong second factor signs nobody in and is recorded.
  const s = t.client();
  await s.post("/login", { email: pmA.email, password: TEST_PASSWORD });
  const wrong = await s.post("/mfa", { code: "000000" });
  assert.ok(wrong.status === 400 || wrong.status === 401 || wrong.status === 422, `a wrong code is refused (${wrong.status})`);
  assert.equal((await s.get("/staff")).status === 200, false, "no staff page without the second factor");
  assert.ok(await count(t, `SELECT COUNT(*) AS n FROM security_events WHERE user_id = ? AND kind = 'mfa_failed'`, pmA.id) >= 1, "recorded as a security event");

  // ── 16. AI gate: nothing in the whole journey created, queued or dispatched an AI build.
  assert.equal(await count(t, `SELECT COUNT(*) AS n FROM build_jobs`), 0);
  void pmc; t.close();
});

test("phase 1 certification: a notification provider outage never breaks the business action; the email is queued for retry", async () => {
  const t = await createTestApp({ ENVIRONMENT: "development" } as Partial<Env>);
  const cu = await createCustomer(t.db, "outage@harbor.example", "Outage Bakery");
  // The real Resend adapter, with a transport that is down: what production does when Resend is unreachable.
  let calls = 0;
  const down = (async () => { calls++; throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.resend.com"); }) as unknown as typeof fetch;
  t.env.overrides = { ...t.env.overrides, email: new ResendEmail(t.db, "re_test_fixture", "Crestmont <support@crestmontwebsitedevelopment.com>", down) };
  const c = await t.client().login(cu.email, TEST_PASSWORD);
  const res = await c.post("/portal/support/new", { subject: "Contact form", category: "technical", description: "The contact form shows an error when I submit it." });
  assert.equal(res.status, 303, "the customer's ticket is created although email is down");
  assert.ok(await count(t, `SELECT COUNT(*) AS n FROM tickets WHERE organization_id = ?`, cu.organizationId) === 1);
  assert.ok(calls >= 1, "the provider was actually called");
  const d = await one<{ n: number; attempts: number; err: string }>(t, `SELECT COUNT(*) AS n, MAX(attempts) AS attempts, MAX(last_error) AS err FROM email_deliveries WHERE status = 'queued' AND attempts >= 1`);
  assert.ok(d.n >= 1, "the undelivered email is queued, not lost");
  assert.match(d.err, /ENOTFOUND/, "with the provider's error recorded for the retry job and the Owner");
  t.close();
});
