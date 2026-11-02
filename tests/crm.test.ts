// CRM, quotes/proposals, checkout and the end-to-end sales journey (area C).
// All records created here are TEST DATA. The Stripe adapter is a local fake that records calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, lastEmail, linkFrom, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import type { PaymentsAdapter, CheckoutRequest } from "../src/adapters/payments.ts";
import type { Env } from "../src/app/context.ts";
import { MAINTENANCE_PLANS, type MaintenanceDef } from "../src/domain/catalog.ts";
import { startMaintenanceCheckout } from "../src/services/billing.ts";
import { buildContext } from "../src/app/app.ts";
import { endOfBusinessDay } from "../src/lib/business-time.ts";

class FakePayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  checkouts: CheckoutRequest[] = [];
  async createCheckout(req: CheckoutRequest) { this.checkouts.push(req); const id = `cs_test_fake_${this.checkouts.length}`; return { id, url: `https://checkout.stripe.com/c/pay/${id}` }; }
  async createBillingPortal(customerId: string) { return { url: `https://billing.stripe.com/p/session/test_${customerId}` }; }
  async createRefund(pi: string, amount: number) { return { id: `re_test_${pi}_${amount}`, status: "succeeded" }; }
}

const WHSEC = "whsec_test_area_c";
const future = (days = 30) => new Date(Date.now() + days * 86400e3).toISOString().slice(0, 10);

async function app(opts: { payments?: boolean } = {}) {
  const fake = new FakePayments();
  const t = await createTestApp({ STRIPE_WEBHOOK_SECRET: WHSEC, overrides: opts.payments ? { payments: fake } : {} });
  return { ...t, fake };
}

async function staffClient(t: { db: Env["DB"]; client: () => TestClient }, role: Parameters<typeof createStaff>[1], email?: string) {
  const s = await createStaff(t.db, role, email);
  const c = t.client();
  await c.login(s.email, TEST_PASSWORD, s.secret);
  return { ...s, c };
}

async function postWebhook(c: TestClient, evt: unknown) {
  const body = JSON.stringify(evt);
  const ts = Math.floor(Date.now() / 1000);
  const sig = await hmacSha256Hex(WHSEC, `${ts}.${body}`);
  return c.request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${sig}`, "content-type": "application/json" } });
}

async function apiLead(c: TestClient, over: Record<string, string> = {}) {
  const res = await c.request("POST", "/api/leads", { body: JSON.stringify({ name: "Morgan Reyes", email: "morgan@harborcoffee.example", company: "Harbor Coffee", interest: "custom", message: "We need online ordering and a loyalty portal.", source: "quote_form", ...over }), headers: { "content-type": "application/json" } });
  assert.equal(res.status, 201);
  return ((await res.json()) as { leadId: string }).leadId;
}

const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;

test("[SALES-004] end-to-end: web lead → CRM → quote → proposal email → customer accepts → pays via Stripe → webhook provisions project and converts lead", async () => {
  const t = await app({ payments: true });
  const visitor = t.client();
  const leadId = await apiLead(visitor);

  // Owner assigns the lead to a sales rep; the rep sees it in the pipeline.
  const owner = await staffClient(t, "owner");
  const rep = await staffClient(t, "sales");
  assert.equal((await owner.c.post(`/staff/crm/leads/${leadId}/assign`, { owner: rep.id })).status, 303);
  const board = await rep.c.get("/staff/crm");
  assert.equal(board.status, 200);
  assert.match(await board.text(), /Morgan Reyes/);

  // Rep qualifies and builds a custom quote; a client-supplied total is ignored.
  for (const to of ["qualified", "quote_required"]) assert.equal((await rep.c.post(`/staff/crm/leads/${leadId}/stage`, { to })).status, 303);
  const save = await rep.c.post(`/staff/quotes/new?lead=${leadId}`, {
    package: "custom", line_desc: ["Online ordering system", "Loyalty portal", ""], line_amount: ["6,000", "2000.50", ""],
    scope: "Custom web application with online ordering, loyalty accounts, admin portal and 3 revision rounds.", valid_until: future(), total_cents: "100", total: "1",
  });
  assert.equal(save.status, 303);
  const quoteId = save.headers.get("location")!.split("/").pop()!;
  const qv = await one<{ total_cents: number; payment_schedule: string; version: number }>(t.db, `SELECT total_cents, payment_schedule, version FROM quote_versions WHERE quote_id = ?`, quoteId);
  assert.deepEqual({ ...qv }, { total_cents: 800_050, payment_schedule: "milestone_50_25_25", version: 1 });

  // Send → token emailed (only its hash is stored) → lead moves to quote_sent.
  assert.equal((await rep.c.post(`/staff/quotes/${quoteId}/send`)).status, 303);
  const mail = await lastEmail(t.db, "morgan@harborcoffee.example");
  assert.equal(mail?.template, "quote_sent");
  const qpath = linkFrom(mail!.text_body, "/q/");
  const token = qpath.split("/").pop()!;
  const stored = await one<{ token_hash: string }>(t.db, `SELECT token_hash FROM quote_access_tokens WHERE quote_id = ?`, quoteId);
  assert.notEqual(stored.token_hash, token);
  assert.equal((await one<{ stage: string }>(t.db, `SELECT stage FROM leads WHERE id = ?`, leadId)).stage, "quote_sent");

  // Anonymous visitors can view the proposal but must sign in to accept.
  const view = await visitor.get(qpath);
  assert.equal(view.status, 200);
  const viewHtml = await view.text();
  assert.match(viewHtml, /\$8,000\.50/);
  assert.match(viewHtml, /50% deposit/);
  assert.match(viewHtml, /Sign in/);
  const anonAccept = await visitor.post(`${qpath}/accept`, { agree: "1" });
  assert.equal(anonAccept.status, 303);
  assert.match(anonAccept.headers.get("location")!, /^\/login\?next=/);

  // Customer registers with the contact email, verifies and signs in.
  const cust = t.client();
  await cust.post("/register", { name: "Morgan Reyes", organization: "Harbor Coffee LLC", email: "morgan@harborcoffee.example", password: TEST_PASSWORD, terms: "1" });
  const verify = await lastEmail(t.db, "morgan@harborcoffee.example");
  await cust.get(linkFrom(verify!.text_body, "/verify-email"));
  await cust.login("morgan@harborcoffee.example");
  // FD-30: the new customer administrator must enrol two-factor authentication before accepting; nothing is created first.
  const early = await cust.post(`${qpath}/accept`, { agree: "1" });
  assert.match(early.headers.get("location") ?? "", /^\/mfa\/setup\?next=/);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM orders`)).n, 0);
  await cust.enrolMfa(qpath);
  assert.match(await (await cust.get(qpath)).text(), /Accept this proposal/);
  const accept = await cust.post(`${qpath}/accept`, { agree: "1" });
  assert.equal(accept.status, 303, await accept.clone().text());
  const invoicePath = accept.headers.get("location")!;
  assert.match(invoicePath, /^\/portal\/billing\/invoices\/inv_/);
  const invoiceId = invoicePath.split("/").pop()!;

  const order = await one<{ id: string; status: string; total_cents: number; lead_id: string; organization_id: string }>(t.db, `SELECT o.id, o.status, o.total_cents, o.lead_id, o.organization_id FROM orders o WHERE o.lead_id = ?`, leadId);
  assert.equal(order.status, "pending_payment");
  assert.equal(order.total_cents, 800_050);
  const inv = await one<{ status: string; amount_cents: number; milestone_kind: string }>(t.db, `SELECT status, amount_cents, milestone_kind FROM invoices WHERE id = ?`, invoiceId);
  assert.deepEqual({ ...inv }, { status: "open", amount_cents: 400_025, milestone_kind: "deposit_50" });
  assert.equal((await one<{ stage: string }>(t.db, `SELECT stage FROM leads WHERE id = ?`, leadId)).stage, "awaiting_payment");
  assert.ok((await one<{ accepted_at: string }>(t.db, `SELECT accepted_at FROM quote_versions WHERE quote_id = ?`, quoteId)).accepted_at);
  // A second acceptance is refused.
  assert.equal((await cust.post(`${qpath}/accept`, { agree: "1" })).status, 409);

  // Pay: our route asks the (fake) Stripe adapter for a checkout session and redirects there.
  assert.match(await (await cust.get(invoicePath)).text(), /Pay \$4,000\.25 securely/);
  const pay = await cust.post(`${invoicePath}/pay`, { amount_cents: "1" });
  assert.equal(pay.status, 303);
  assert.match(pay.headers.get("location")!, /^https:\/\/checkout\.stripe\.com\//);
  const co = t.fake.checkouts.at(-1)!;
  assert.equal(co.mode, "payment");
  assert.equal(co.lines[0].amountCents, 400_025, "amount comes from the invoice, not the form");
  assert.deepEqual(co.metadata, { organization_id: order.organization_id, invoice_id: invoiceId, order_id: order.id, kind: "quote" });
  assert.equal(co.customerEmail, "morgan@harborcoffee.example");
  // The browser success redirect never marks anything paid.
  assert.match(await (await cust.get("/portal/billing?checkout=success")).text(), /Stripe is confirming your payment/);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM invoices WHERE id = ?`, invoiceId)).status, "open");

  // Verified webhook → invoice paid, order partially paid, project provisioned, lead converted.
  const wh = await postWebhook(visitor, { id: "evt_e2e_1", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: {
    id: "cs_test_fake_1", object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: 400_025, payment_intent: "pi_test_e2e", customer: "cus_test_e2e", customer_email: "morgan@harborcoffee.example", metadata: co.metadata } } });
  assert.equal(wh.status, 200);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM invoices WHERE id = ?`, invoiceId)).status, "paid");
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM orders WHERE id = ?`, order.id)).status, "partially_paid");
  const project = await one<{ id: string; payment_schedule: string }>(t.db, `SELECT id, payment_schedule FROM projects WHERE order_id = ?`, order.id);
  assert.equal(project.payment_schedule, "milestone_50_25_25");
  assert.equal((await one<{ stage: string }>(t.db, `SELECT stage FROM leads WHERE id = ?`, leadId)).stage, "converted");
  assert.equal((await one<{ stripe_customer_id: string }>(t.db, `SELECT stripe_customer_id FROM organizations WHERE id = ?`, order.organization_id)).stripe_customer_id, "cus_test_e2e");

  // CRM integration: the lead detail shows the linked quote, order and project; billing shows the receipt.
  const detail = await (await rep.c.get(`/staff/crm/leads/${leadId}`)).text();
  assert.match(detail, new RegExp(quoteId));
  assert.match(detail, new RegExp(order.id));
  assert.match(detail, /Payment confirmed by Stripe webhook/);
  const billing = await (await cust.get("/portal/billing")).text();
  assert.match(billing, /Receipt/);
  assert.match(billing, /\$4,000\.25/);
});

test("[CRM-007] proposal acceptance requires the contact's email; superseded and expired versions cannot be accepted", async () => {
  const t = await app();
  const leadId = await apiLead(t.client(), { email: "pat@lakeside.example" });
  const owner = await staffClient(t, "owner");
  const make = await owner.c.post(`/staff/quotes/new?lead=${leadId}`, { package: "business", scope: "Business package website: 12 pages with booking integration.", valid_until: future() });
  const quoteId = make.headers.get("location")!.split("/").pop()!;
  await owner.c.post(`/staff/quotes/${quoteId}/send`);
  const v1 = linkFrom((await lastEmail(t.db, "pat@lakeside.example"))!.text_body, "/q/");

  // Someone else signed in cannot accept.
  const other = await createCustomer(t.db, "intruder@example.com");
  const oc = t.client(); await oc.login(other.email);
  assert.match(await (await oc.get(v1)).text(), /different address/);
  assert.equal((await oc.post(`${v1}/accept`, { agree: "1" })).status, 403);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM orders`)).n, 0);

  // Revising creates v2 as a draft; the v1 link is superseded.
  assert.equal((await owner.c.post(`/staff/quotes/${quoteId}`, { package: "business", scope: "Business package website: 12 pages with booking integration and blog.", valid_until: future() })).status, 303);
  assert.deepEqual({ ...(await one<{ status: string; current_version: number }>(t.db, `SELECT status, current_version FROM quotes WHERE id = ?`, quoteId)) }, { status: "draft", current_version: 2 });
  const pat = await createCustomer(t.db, "pat@lakeside.example", "Lakeside Dental");
  const pc = t.client(); await pc.login(pat.email);
  assert.match(await (await pc.get(v1)).text(), /replaced by a newer proposal/);
  assert.equal((await pc.post(`${v1}/accept`, { agree: "1" })).status, 409);

  // Expired version: send v2, then move its validity into the past.
  await owner.c.post(`/staff/quotes/${quoteId}/send`);
  const v2 = linkFrom((await lastEmail(t.db, "pat@lakeside.example"))!.text_body, "/q/");
  await t.db.prepare(`UPDATE quote_versions SET valid_until = '2020-01-01' WHERE quote_id = ? AND version = 2`).bind(quoteId).run();
  assert.match(await (await pc.get(v2)).text(), /has expired/);
  assert.equal((await pc.post(`${v2}/accept`, { agree: "1" })).status, 409);
  await t.db.prepare(`UPDATE quote_versions SET valid_until = ? WHERE quote_id = ? AND version = 2`).bind(future(), quoteId).run();
  // Agreement checkbox is required.
  assert.equal((await pc.post(`${v2}/accept`, {})).status, 422);
  assert.equal((await pc.post(`${v2}/accept`, { agree: "1" })).status, 303);
  const inv = await one<{ amount_cents: number; milestone_kind: string }>(t.db, `SELECT i.amount_cents, i.milestone_kind FROM invoices i JOIN orders o ON o.id = i.order_id WHERE o.lead_id = ?`, leadId);
  assert.deepEqual({ ...inv }, { amount_cents: 249_900, milestone_kind: "full" });
  // Invalid tokens 404.
  assert.equal((await pc.get(`/q/${"0".repeat(64)}`)).status, 404);
});

test("[SALES-002] quote builder computes totals server-side, versions every save, and enforces package rules", async () => {
  const t = await app();
  const leadId = await apiLead(t.client());
  const owner = await staffClient(t, "owner");
  const scope = "Premium site with bespoke design and booking integration for 20 pages.";
  // Fixed-price packages cannot take extra lines.
  const bad = await owner.c.post(`/staff/quotes/new?lead=${leadId}`, { package: "starter", line_desc: "Extra page", line_amount: "100", scope, valid_until: future() });
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /fixed-price/);
  // Past valid-until and missing scope are rejected.
  assert.equal((await owner.c.post(`/staff/quotes/new?lead=${leadId}`, { package: "premium", scope, valid_until: "2020-01-01" })).status, 422);
  assert.equal((await owner.c.post(`/staff/quotes/new?lead=${leadId}`, { package: "premium", scope: "short", valid_until: future() })).status, 422);
  // Premium above the floor: base + extra lines, 100% upfront.
  const ok = await owner.c.post(`/staff/quotes/new?lead=${leadId}`, { package: "premium", line_desc: "Booking integration", line_amount: "1500", scope, valid_until: future(), price: "1", total_cents: "1" });
  assert.equal(ok.status, 303);
  const quoteId = ok.headers.get("location")!.split("/").pop()!;
  let v = await one<{ total_cents: number; payment_schedule: string }>(t.db, `SELECT total_cents, payment_schedule FROM quote_versions WHERE quote_id = ? AND version = 1`, quoteId);
  assert.deepEqual({ ...v }, { total_cents: 649_900, payment_schedule: "upfront" });
  // Revision → v2 custom 50/25/25.
  await owner.c.post(`/staff/quotes/${quoteId}`, { package: "custom", line_desc: "Custom SaaS MVP", line_amount: "12000", scope, valid_until: future() });
  v = await one(t.db, `SELECT total_cents, payment_schedule FROM quote_versions WHERE quote_id = ? AND version = 2`, quoteId);
  assert.deepEqual({ ...v }, { total_cents: 1_200_000, payment_schedule: "milestone_50_25_25" });
  const page = await (await owner.c.get(`/staff/quotes/${quoteId}`)).text();
  assert.match(page, /Version history/);
  assert.match(page, /\$6,000/); // 50% deposit shown in schedule
  assert.match(await (await owner.c.get("/staff/quotes")).text(), new RegExp(quoteId));
  // Audit trail for quote changes.
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE subject_type='quote' AND subject_id = ?`, quoteId)).n, 2);
});

test("[CRM-005] a sales rep sees only assigned leads; search, filters and CSV export respect assignment", async () => {
  const t = await app();
  const v = t.client();
  const a = await apiLead(v, { name: "Alice Assigned", email: "alice@a.example", company: "Alpha Bakery" });
  const b = await apiLead(v, { name: "Bob Other", email: "bob@b.example", company: "Beta Bikes" });
  const owner = await staffClient(t, "owner");
  const repA = await staffClient(t, "sales", "rep.a@crestmont.test");
  const repB = await staffClient(t, "sales", "rep.b@crestmont.test");
  await owner.c.post(`/staff/crm/leads/${a}/assign`, { owner: repA.id });
  await owner.c.post(`/staff/crm/leads/${b}/assign`, { owner: repB.id });

  const list = await (await repA.c.get("/staff/crm?view=list")).text();
  assert.match(list, /Alice Assigned/);
  assert.doesNotMatch(list, /Bob Other/);
  assert.equal((await repA.c.get(`/staff/crm/leads/${b}`)).status, 404);
  assert.equal((await repA.c.post(`/staff/crm/leads/${b}/stage`, { to: "qualified" })).status, 404);
  assert.equal((await repA.c.post(`/staff/crm/leads/${b}/note`, { body: "sneaky" })).status, 404);
  assert.equal((await repA.c.get(`/staff/quotes/new?lead=${b}`)).status, 404);
  assert.equal((await repA.c.post(`/staff/crm/leads/${a}/assign`, { owner: repA.id })).status, 403, "sales cannot reassign");
  const csvA = await (await repA.c.get("/staff/crm/export.csv")).text();
  assert.match(csvA, /alice@a\.example/);
  assert.doesNotMatch(csvA, /bob@b\.example/);

  // Owner: search, stage/source filters, pagination controls.
  assert.doesNotMatch(await (await owner.c.get("/staff/crm?view=list&q=beta")).text(), /Alice Assigned/);
  assert.match(await (await owner.c.get("/staff/crm?view=list&q=beta")).text(), /Bob Other/);
  assert.match(await (await owner.c.get(`/staff/crm?view=list&owner=${repA.id}`)).text(), /Alice Assigned/);
  assert.doesNotMatch(await (await owner.c.get("/staff/crm?view=list&source=referral")).text(), /Alice Assigned/);
  assert.doesNotMatch(await (await owner.c.get("/staff/crm?view=list&stage=lost")).text(), /Alice Assigned/);
  // Search wildcards are literal.
  assert.doesNotMatch(await (await owner.c.get("/staff/crm?view=list&q=%25")).text(), /Alice Assigned/);
  // Developers have no CRM access.
  const dev = await staffClient(t, "developer");
  assert.equal((await dev.c.get("/staff/crm")).status, 403);
});

test("[CRM-005] CSV export neutralises spreadsheet formulas", async () => {
  const t = await app();
  await apiLead(t.client(), { name: "=HYPERLINK(\"http://evil\",\"x\")", company: "@SUM(A1:A9)", email: "f@formula.example" });
  const owner = await staffClient(t, "owner");
  const res = await owner.c.get("/staff/crm/export.csv");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /text\/csv/);
  const csv = await res.text();
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil"",""x""\)"/);
  assert.match(csv, /'@SUM\(A1:A9\)/);
  assert.doesNotMatch(csv, /,=HYPERLINK/);
  assert.ok((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'lead.exported'`)).n >= 1);
});

test("[CRM-004] stage transitions are validated, lost requires a reason, leads can be reopened; notes, tasks and history persist", async () => {
  const t = await app();
  const leadId = await apiLead(t.client());
  const owner = await staffClient(t, "owner");
  const base = `/staff/crm/leads/${leadId}`;
  const invalid = await owner.c.post(`${base}/stage`, { to: "accepted" });
  assert.equal(invalid.status, 422);
  assert.match(await invalid.text(), /not allowed/);
  assert.equal((await owner.c.post(`${base}/stage`, { to: "lost" })).status, 422, "reason required");
  assert.equal((await owner.c.post(`${base}/stage`, { to: "converted" })).status, 422, "converted only via webhook");
  assert.equal((await owner.c.post(`${base}/stage`, { to: "lost", reason: "Chose another vendor" })).status, 303);
  assert.equal((await one<{ lost_reason: string }>(t.db, `SELECT lost_reason FROM leads WHERE id = ?`, leadId)).lost_reason, "Chose another vendor");
  assert.match(await (await owner.c.get(base)).text(), /Reopen \(qualified\)/);
  assert.equal((await owner.c.post(`${base}/stage`, { to: "qualified" })).status, 303);
  assert.equal((await one<{ stage: string }>(t.db, `SELECT stage FROM leads WHERE id = ?`, leadId)).stage, "qualified");

  assert.equal((await owner.c.post(`${base}/note`, { kind: "call", body: "Discussed budget; prefers phased launch." })).status, 303);
  assert.equal((await owner.c.post(`${base}/task`, { body: "Send case studies", due: "" })).status, 422);
  assert.equal((await owner.c.post(`${base}/task`, { body: "Send case studies", due: future(3) })).status, 303);
  const task = await one<{ id: string; due_at: string }>(t.db, `SELECT id, due_at FROM crm_activities WHERE lead_id = ? AND kind = 'task'`, leadId);
  // CREST-GAP-094: a due date means the end of that day in Eastern time.
  assert.equal(task.due_at, endOfBusinessDay(future(3)));
  assert.equal((await owner.c.post(`${base}/tasks/${task.id}/complete`)).status, 303);
  assert.equal((await owner.c.post(`${base}/tasks/${task.id}/complete`)).status, 409);
  const page = await (await owner.c.get(base)).text();
  assert.match(page, /Reopened: lost → qualified/);
  assert.match(page, /Discussed budget/);
  assert.match(page, /<s>Send case studies<\/s>/);

  // Contact & company edits.
  assert.equal((await owner.c.post(`${base}/contact`, { name: "Morgan R. Reyes", email: "bad", phone: "", company: "Harbor Coffee", website: "", qualification_notes: "" })).status, 422);
  assert.equal((await owner.c.post(`${base}/contact`, { name: "Morgan R. Reyes", email: "morgan@harborcoffee.example", phone: "+1 555 0100", company: "Harbor Coffee Co", website: "https://harbor.example", qualification_notes: "Budget ~$8k" })).status, 303);
  assert.match(await (await owner.c.get(base)).text(), /Harbor Coffee Co/);
});

test("[CRM-001] manual and referral lead entry; AI qualification shows an honest not-configured state", async () => {
  const t = await app();
  const rep = await staffClient(t, "sales");
  assert.equal((await rep.c.post("/staff/crm/new", { name: "R", email: "", phone: "", company: "", website: "", interest: "custom", message: "", source: "web_form" })).status, 422);
  const res = await rep.c.post("/staff/crm/new", { name: "Riley Referral", email: "riley@ref.example", phone: "", company: "Ref Co", website: "", interest: "business", message: "Referred by an existing client", source: "referral" });
  assert.equal(res.status, 303);
  const leadId = res.headers.get("location")!.split("/").pop()!;
  const row = await one<{ source: string; owner_user_id: string }>(t.db, `SELECT source, owner_user_id FROM leads WHERE id = ?`, leadId);
  assert.deepEqual({ ...row }, { source: "referral", owner_user_id: rep.id }, "a rep owns the leads they enter");
  const ai = await rep.c.post(`/staff/crm/leads/${leadId}/ai-draft`);
  assert.equal(ai.status, 303);
  const page = await (await rep.c.get(`/staff/crm/leads/${leadId}`)).text();
  assert.match(page, /AI drafting is not configured/);
  const job = await one<{ status: string; workflow: string }>(t.db, `SELECT status, workflow FROM ai_jobs WHERE input_ref = ?`, `lead:${leadId}`);
  assert.deepEqual({ ...job }, { status: "failed", workflow: "lead_qualification" });
});

test("[CRM-002] contacts and customer records show orders, projects, subscriptions and tickets", async () => {
  const t = await app();
  const cust = await createCustomer(t.db, "owner@acme.example", "Acme Plumbing");
  const at = new Date().toISOString();
  await t.db.batch([
    t.db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, created_at) VALUES ('ord_t1', ?, 'starter', 99900, 'paid', 'package', ?)`).bind(cust.organizationId, at),
    t.db.prepare(`INSERT INTO projects (id, organization_id, order_id, product_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES ('prj_t1', ?, 'ord_t1', 'starter', 'Acme Plumbing — Starter website', 'design', 2, 'upfront', ?, ?)`).bind(cust.organizationId, at, at),
    t.db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, status, created_at, updated_at) VALUES ('sub_t1', ?, 'essential', 'active', ?, ?)`).bind(cust.organizationId, at, at),
    t.db.prepare(`INSERT INTO tickets (id, organization_id, subject, category, priority, status, opened_by, created_at, updated_at) VALUES ('tk_t1', ?, 'Contact form not sending', 'technical', 'normal', 'open', ?, ?, ?)`).bind(cust.organizationId, cust.id, at, at),
  ]);
  const support = await staffClient(t, "support");
  const list = await (await support.c.get("/staff/customers")).text();
  assert.match(list, /Acme Plumbing/);
  const detail = await (await support.c.get(`/staff/customers/${cust.organizationId}`)).text();
  for (const s of ["ord_t1", "Acme Plumbing — Starter website", "Essential", "Contact form not sending"]) assert.match(detail, new RegExp(s));
  assert.equal((await support.c.get("/staff/crm/contacts")).status, 403, "support has no CRM access");
  const dev = await staffClient(t, "developer");
  assert.equal((await dev.c.get("/staff/customers")).status, 403);
  const owner = await staffClient(t, "owner");
  await apiLead(t.client(), { name: "Casey Contact", email: "casey@contact.example" });
  assert.match(await (await owner.c.get("/staff/crm/contacts?q=casey")).text(), /Casey Contact/);
});

test("[CRM-006] sales report derives funnel, conversion and attributed revenue from real rows", async () => {
  const t = await app();
  const v = t.client();
  const l1 = await apiLead(v, { email: "one@x.example" });
  await apiLead(v, { email: "two@x.example", source: "web_form" });
  const cust = await createCustomer(t.db, "one@x.example");
  const at = new Date().toISOString();
  await t.db.batch([
    t.db.prepare(`UPDATE leads SET stage = 'converted' WHERE id = ?`).bind(l1),
    t.db.prepare(`INSERT INTO orders (id, organization_id, total_cents, status, kind, lead_id, created_at) VALUES ('ord_r1', ?, 99900, 'paid', 'quote', ?, ?)`).bind(cust.organizationId, l1, at),
    t.db.prepare(`INSERT INTO payments (id, organization_id, order_id, amount_cents, status, created_at) VALUES ('pay_r1', ?, 'ord_r1', 99900, 'succeeded', ?)`).bind(cust.organizationId, at),
  ]);
  const owner = await staffClient(t, "owner");
  const page = await (await owner.c.get("/staff/sales")).text();
  assert.match(page, /Conversion rate[\s\S]*?50\.0%/);
  assert.match(page, /Quote Form/);
  assert.match(page, /\$999/);
  assert.match(page, /How these numbers are calculated/);
  // A rep with no leads sees zeros, not company-wide data.
  const rep = await staffClient(t, "sales");
  assert.doesNotMatch(await (await rep.c.get("/staff/sales")).text(), /\$999/);
});

test("[PAY-001] checkout without Stripe configured explains it and creates no order", async () => {
  const t = await app();
  const cust = await createCustomer(t.db);
  const c = t.client(); await c.login(cust.email);
  const page = await c.get("/checkout/starter");
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /Online payment is not configured yet/);
  assert.match(body, /href="\/quote"/);
  assert.match(body, /href="\/contact"/);
  assert.equal((await c.post("/checkout/starter", { terms: "1" })).status, 409);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM orders`)).n, 0);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM invoices`)).n, 0);
  // Signed-out visitors are sent to sign in.
  const anon = await t.client().get("/checkout/starter");
  assert.equal(anon.status, 303);
  assert.match(anon.headers.get("location")!, /^\/login\?next=%2Fcheckout%2Fstarter/);
  assert.equal((await c.get("/checkout/platinum")).status, 404);
});

test("[CAT-007] package checkout ignores client-supplied prices and redirects to Stripe with server-side amounts", async () => {
  const t = await app({ payments: true });
  const cust = await createCustomer(t.db);
  const c = t.client(); await c.login(cust.email);
  assert.equal((await c.post("/checkout/business", { price: "1" })).status, 422, "terms required");
  const res = await c.post("/checkout/business", { terms: "1", price: "1", amount_cents: "100", total_cents: "100" });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location")!, /^https:\/\/checkout\.stripe\.com\//);
  const co = t.fake.checkouts[0];
  assert.equal(co.lines[0].amountCents, 249_900);
  assert.equal(co.metadata.kind, "package");
  assert.equal(co.metadata.organization_id, cust.organizationId);
  assert.equal(co.successUrl, "http://crestmont.test/portal/billing?checkout=success");
  const order = await one<{ id: string; total_cents: number; status: string }>(t.db, `SELECT id, total_cents, status FROM orders WHERE organization_id = ?`, cust.organizationId);
  assert.deepEqual({ total_cents: order.total_cents, status: order.status }, { total_cents: 249_900, status: "pending_payment" });
  assert.equal(co.metadata.order_id, order.id);
  const inv = await one<{ id: string; amount_cents: number; stripe_checkout_session_id: string }>(t.db, `SELECT id, amount_cents, stripe_checkout_session_id FROM invoices WHERE order_id = ?`, order.id);
  assert.equal(co.metadata.invoice_id, inv.id);
  assert.equal(inv.stripe_checkout_session_id, "cs_test_fake_1");
  // A forged webhook amount that does not match the invoice is rejected (stays open).
  await postWebhook(t.client(), { id: "evt_forged", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: { id: "cs_test_fake_1", mode: "payment", payment_status: "paid", amount_total: 100, payment_intent: "pi_forged", metadata: co.metadata } } });
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM invoices WHERE id = ?`, inv.id)).status, "open");
  // Staff cannot use customer checkout.
  const owner = await staffClient(t, "owner");
  assert.equal((await owner.c.post("/checkout/starter", { terms: "1" })).status, 403);
});

test("[CAT-006] maintenance subscriptions are refused until the Founder approves entitlements; the approved path uses subscription mode", async () => {
  const t = await app({ payments: true });
  const cust = await createCustomer(t.db);
  const c = t.client(); await c.login(cust.email);
  const gated = await c.get("/checkout/maintenance/essential");
  assert.equal(gated.status, 409);
  assert.match(await gated.text(), /awaiting Founder approval/);
  assert.equal((await c.post("/checkout/maintenance/professional", { terms: "1" })).status, 409);
  assert.equal(t.fake.checkouts.length, 0);

  // Same code path once approved (catalog copy marked approved; the real catalog is untouched).
  const approved: Record<string, MaintenanceDef> = { ...MAINTENANCE_PLANS, essential: { ...MAINTENANCE_PLANS.essential, entitlementsStatus: "approved" } };
  const sessionCookie = c.cookies.get("cm_session")!;
  const ctx = await buildContext(new Request("http://crestmont.test/checkout/maintenance/essential", { headers: { cookie: `cm_session=${sessionCookie}` } }), t.env);
  const res = await startMaintenanceCheckout(ctx, { id: cust.id, email: cust.email }, cust.organizationId, "essential", approved);
  assert.match(res.url, /^https:\/\/checkout\.stripe\.com\//);
  const co = t.fake.checkouts[0];
  assert.equal(co.mode, "subscription");
  assert.equal(co.recurringInterval, "month");
  assert.equal(co.lines[0].amountCents, 9_900);
  assert.deepEqual(co.metadata, { organization_id: cust.organizationId, product_id: "essential", kind: "subscription" });
  // Stripe then reports the subscription → active row.
  await postWebhook(t.client(), { id: "evt_sub_1", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: { id: "cs_sub_1", mode: "subscription", subscription: "sub_test_1", customer: "cus_sub", metadata: co.metadata } } });
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM subscriptions WHERE organization_id = ?`, cust.organizationId)).status, "active");
  await assert.rejects(startMaintenanceCheckout(ctx, { id: cust.id, email: cust.email }, cust.organizationId, "essential", approved), /already have an active/);
});
