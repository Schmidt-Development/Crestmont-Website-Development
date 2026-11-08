// Financial issues as My Work items (Founder directive 2026-11-08, Phase 4). Driven through the real reconciliation
// engine steps (storeFindings / autoClear) and the real request pipeline: issues appear automatically, never duplicate,
// disappear when genuinely resolved, re-open when a "fixed" problem comes back, are assignable and audited, and
// resolving one from My Work changes no payment or invoice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer } from "./support/app.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import { storeFindings, autoClear, type Finding } from "../src/services/stripe-reconcile.ts";

type Db = Awaited<ReturnType<typeof createTestApp>>["db"];

async function world() {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner", "owner@crestmont.test", "Olive Owner");
  const support = await createStaff(t.db, "support", "support@crestmont.test", "Sam Support");
  const dev = await createStaff(t.db, "developer", "dev@crestmont.test", "Dev Eloper");
  const cust = await createCustomer(t.db, "billing@acme.example", "Acme Plumbing (TEST)");
  const ownerC = await t.client().login(owner.email);
  return { t, owner, support, dev, cust, ownerC };
}

async function run(db: Db): Promise<string> {
  const id = newId("rcn");
  await db.prepare(`INSERT INTO reconciliation_runs (id, started_at, status, scope) VALUES (?,?, 'running', 'checkout')`).bind(id, nowIso()).run();
  return id;
}

const finding = (orgId: string, key = "cs_test_fw_1"): Finding => ({
  kind: "paid_in_stripe_unpaid_locally", key, stripeObjectId: key, organizationId: orgId, stripeAmount: 99900, localAmount: 99900,
  detail: `Checkout session ${key} is paid in Stripe; invoice inv_x is open locally.`,
});

const financeTab = async (c: { get(p: string): Promise<Response> }) => (await c.get("/staff?tab=finance")).text();
const countIssues = (html: string) => (html.match(/data-finance-issue="/g) ?? []).length;
const findingId = async (db: Db, key = "cs_test_fw_1") =>
  (await db.prepare(`SELECT id FROM reconciliation_findings WHERE fingerprint = ?`).bind(`paid_in_stripe_unpaid_locally:${key}`).first<{ id: string }>())!.id;

test("[FIN-W01] a discrepancy appears in My Work automatically, in plain English, once, and leaves when it clears", async () => {
  const { t, cust, ownerC } = await world();
  assert.match(await financeTab(ownerC), /Nothing to review/);

  const r1 = await run(t.db);
  assert.equal(await storeFindings(t.db, r1, [finding(cust.organizationId)], "checkout"), 1);
  let page = await financeTab(ownerC);
  assert.equal(countIssues(page), 1);
  assert.match(page, /Customer paid, but the invoice still shows unpaid/);
  assert.match(page, /Acme Plumbing \(TEST\)/);
  assert.match(page, /\$999\b/);
  assert.match(page, /Urgent/);
  assert.match(page, /Recommended next step/);
  assert.match(page, /<summary class="faint">Technical details<\/summary>/, "raw technical text is tucked away");
  // The My Work tab bar offers the view and the attention list counts it.
  const home = await (await ownerC.get("/staff")).text();
  assert.match(home, /href="\/staff\?tab=finance"/);
  assert.match(home, /1 financial issue to review/);

  // A retry or the next run seeing the same problem never duplicates it.
  const r2 = await run(t.db);
  assert.equal(await storeFindings(t.db, r2, [finding(cust.organizationId)], "checkout"), 0);
  assert.equal(countIssues(await financeTab(ownerC)), 1);
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM reconciliation_findings`).first<{ n: number }>())!.n, 1);

  // A later run no longer sees it: it resolved itself and leaves My Work.
  const r3 = await run(t.db);
  await storeFindings(t.db, r3, [], "checkout");
  assert.equal(await autoClear(t.db, r3, "checkout"), 1);
  page = await financeTab(ownerC);
  assert.equal(countIssues(page), 0);
  assert.match(page, /Nothing to review/);
});

test("[FIN-W02] resolving from My Work records the note only; a problem marked fixed that comes back re-opens, an explained one does not", async () => {
  const { t, cust, ownerC } = await world();
  await storeFindings(t.db, await run(t.db), [finding(cust.organizationId, "cs_fixed"), finding(cust.organizationId, "cs_explained")], "checkout");
  const fixed = await findingId(t.db, "cs_fixed"), explained = await findingId(t.db, "cs_explained");
  const before = await t.db.prepare(`SELECT (SELECT COUNT(*) FROM payments) AS p, (SELECT COUNT(*) FROM invoices) AS i, (SELECT COUNT(*) FROM refunds) AS r`).first();

  // A note is required.
  let res = await ownerC.post(`/staff/finance/reconciliation/${fixed}/resolve`, { resolution: "corrected_locally", note: "", back: "mywork" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/staff?tab=finance");
  assert.equal((await t.db.prepare(`SELECT status FROM reconciliation_findings WHERE id = ?`).bind(fixed).first<{ status: string }>())!.status, "open");

  res = await ownerC.post(`/staff/finance/reconciliation/${fixed}/resolve`, { resolution: "corrected_locally", note: "Re-processed the stored event; invoice now paid.", back: "mywork" });
  assert.equal(res.headers.get("location"), "/staff?tab=finance");
  await ownerC.post(`/staff/finance/reconciliation/${explained}/resolve`, { resolution: "no_action_needed", note: "Test-mode session; nothing owed.", back: "mywork" });
  assert.equal(countIssues(await financeTab(ownerC)), 0, "both resolved issues leave My Work");
  assert.deepEqual(await t.db.prepare(`SELECT (SELECT COUNT(*) FROM payments) AS p, (SELECT COUNT(*) FROM invoices) AS i, (SELECT COUNT(*) FROM refunds) AS r`).first(), before,
    "resolving changes no payment, invoice or refund");

  // The next run still sees both problems.
  await storeFindings(t.db, await run(t.db), [finding(cust.organizationId, "cs_fixed"), finding(cust.organizationId, "cs_explained")], "checkout");
  const rows = new Map((await t.db.prepare(`SELECT id, status, reopened_count, resolution FROM reconciliation_findings`).all<{ id: string; status: string; reopened_count: number; resolution: string | null }>()).results.map((r) => [r.id, r]));
  assert.equal(rows.get(fixed)!.status, "open", "a problem recorded as fixed that is seen again genuinely recurred");
  assert.equal(rows.get(fixed)!.reopened_count, 1);
  assert.equal(rows.get(fixed)!.resolution, null);
  assert.equal(rows.get(explained)!.status, "resolved", "an explained (no action needed) finding stays resolved");
  const recurred = await t.db.prepare(`SELECT details_json FROM audit_logs WHERE action = 'reconciliation.finding_recurred' AND subject_id = ?`).bind(fixed).first<{ details_json: string }>();
  assert.ok(recurred, "the recurrence is audited");
  assert.equal(JSON.parse(recurred!.details_json).previousResolution, "corrected_locally", "the earlier resolution is kept in the audit trail");

  const page = await financeTab(ownerC);
  assert.equal(countIssues(page), 1);
  assert.match(page, /came back after being fixed/);
  assert.match(page, /Re-opened/);
});

test("[FIN-W03] failed maintenance payments, disputes, refund requests and a failed cost import appear and disappear with their source", async () => {
  const { t, cust, ownerC, support } = await world();
  const at = nowIso();
  const sub = newId("sub"), dsp = newId("dsp"), pay = newId("pay"), ref = newId("ref");
  await t.db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, stripe_subscription_id, status, payment_failed_at, suspension_eligible_at, created_at, updated_at)
    VALUES (?,?, 'essential', 'sub_test_fw', 'past_due', ?, ?, ?, ?)`).bind(sub, cust.organizationId, at, new Date(Date.now() + 7 * 864e5).toISOString(), at, at).run();
  await t.db.prepare(`INSERT INTO payments (id, organization_id, amount_cents, stripe_payment_intent_id, status, created_at) VALUES (?,?, 99900, 'pi_test_fw', 'succeeded', ?)`).bind(pay, cust.organizationId, at).run();
  await t.db.prepare(`INSERT INTO disputes (id, organization_id, payment_id, stripe_dispute_id, amount_cents, reason, status, evidence_due_by, created_at, updated_at)
    VALUES (?,?,?, 'dp_test_fw', 99900, 'product_not_received', 'needs_response', ?, ?, ?)`).bind(dsp, cust.organizationId, pay, at, at, at).run();
  await t.db.prepare(`INSERT INTO refunds (id, organization_id, payment_id, amount_cents, reason, status, requested_by, created_at) VALUES (?,?,?, 50000, 'Changed our mind (TEST)', 'requested', ?, ?)`)
    .bind(ref, cust.organizationId, pay, cust.id, at).run();
  await t.db.prepare(`INSERT INTO ingestion_status (source, last_attempt_at, last_error) VALUES ('job:cost_import', ?, 'Anthropic usage API: 503')`).bind(at).run();

  let page = await financeTab(ownerC);
  assert.equal(countIssues(page), 4);
  for (const re of [/Maintenance payment failed/, /Payment dispute needs a response/, /Refund request to review/, /Cost import failed/]) assert.match(page, re);

  // Support reviews refunds: it sees the refund request only, never the Owner's financial records.
  const supportC = await t.client().login(support.email);
  const supportPage = await financeTab(supportC);
  assert.equal(countIssues(supportPage), 1);
  assert.match(supportPage, /Refund request to review/);
  assert.doesNotMatch(supportPage, /Maintenance payment failed|Payment dispute|Cost import/);
  assert.doesNotMatch(supportPage, /action="\/staff\/finance-work\/assign"/, "support cannot assign");

  // Each source resolves on its own; its item leaves.
  await t.db.prepare(`UPDATE subscriptions SET status = 'active', payment_failed_at = NULL WHERE id = ?`).bind(sub).run();
  await t.db.prepare(`UPDATE disputes SET status = 'won' WHERE id = ?`).bind(dsp).run();
  await t.db.prepare(`UPDATE refunds SET status = 'denied' WHERE id = ?`).bind(ref).run();
  await t.db.prepare(`UPDATE ingestion_status SET last_error = NULL, last_success_at = ? WHERE source = 'job:cost_import'`).bind(at).run();
  page = await financeTab(ownerC);
  assert.equal(countIssues(page), 0);
  assert.match(page, /Nothing to review/);
});

test("[FIN-W04] issues can be assigned to someone who can see them; assignment is audited and refused otherwise", async () => {
  const { t, owner, support, dev, cust, ownerC } = await world();
  await storeFindings(t.db, await run(t.db), [finding(cust.organizationId)], "checkout");
  const fid = await findingId(t.db);
  const key = `finding:${fid}`;

  let res = await ownerC.post("/staff/finance-work/assign", { key, user_id: owner.id });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/staff?tab=finance");
  assert.equal((await t.db.prepare(`SELECT user_id FROM finance_work_assignments WHERE item_key = ?`).bind(key).first<{ user_id: string }>())!.user_id, owner.id);
  assert.match(await financeTab(ownerC), /<dt>Assigned to<\/dt>\s*<dd>You<\/dd>/);
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'finance_work.assigned' AND subject_id = ? AND actor_user_id = ?`).bind(key, owner.id).first());

  // A developer or support member cannot see Stripe discrepancies, so cannot be given one.
  for (const who of [dev, support]) {
    await ownerC.post("/staff/finance-work/assign", { key, user_id: who.id });
    assert.equal((await t.db.prepare(`SELECT user_id FROM finance_work_assignments WHERE item_key = ?`).bind(key).first<{ user_id: string }>())!.user_id, owner.id, `${who.email} refused`);
  }
  // A refund request can go to a refund reviewer.
  const pay = newId("pay"), ref = newId("ref");
  await t.db.prepare(`INSERT INTO payments (id, organization_id, amount_cents, stripe_payment_intent_id, status, created_at) VALUES (?,?, 99900, 'pi_test_fw4', 'succeeded', ?)`).bind(pay, cust.organizationId, nowIso()).run();
  await t.db.prepare(`INSERT INTO refunds (id, organization_id, payment_id, amount_cents, reason, status, requested_by, created_at) VALUES (?,?,?, 1000, 'Test', 'requested', ?, ?)`).bind(ref, cust.organizationId, pay, cust.id, nowIso()).run();
  await ownerC.post("/staff/finance-work/assign", { key: `refund:${ref}`, user_id: support.id });
  assert.equal((await t.db.prepare(`SELECT user_id FROM finance_work_assignments WHERE item_key = ?`).bind(`refund:${ref}`).first<{ user_id: string }>())!.user_id, support.id);

  // Unknown or no-longer-open issues cannot be assigned.
  assert.equal((await ownerC.post("/staff/finance-work/assign", { key: "finding:../etc", user_id: owner.id })).status, 404);
  await ownerC.post("/staff/finance-work/assign", { key: "job:cost_import", user_id: owner.id });
  assert.equal(await t.db.prepare(`SELECT 1 FROM finance_work_assignments WHERE item_key = 'job:cost_import'`).first(), null, "no cost-import failure is open");

  // Staff without finance access cannot assign at all.
  const supportC = await t.client().login(support.email);
  assert.equal((await supportC.post("/staff/finance-work/assign", { key, user_id: support.id })).status, 403);
  const devC = await t.client().login(dev.email);
  assert.equal((await devC.get("/staff?tab=finance")).status, 200);
  assert.doesNotMatch(await (await devC.get("/staff?tab=finance")).text(), /data-finance-issue=/, "a developer never sees financial issues");

  // Unassigning clears it.
  await ownerC.post("/staff/finance-work/assign", { key, user_id: "" });
  assert.equal(await t.db.prepare(`SELECT 1 FROM finance_work_assignments WHERE item_key = ?`).bind(key).first(), null);
});
