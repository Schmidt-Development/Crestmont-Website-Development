// FD-27 (billing starts at approved launch) and Founder clarifications 1–2 (seven-day failed-payment suspension after
// notice, never deleting data, restored on payment). TEST DATA only: Stripe events are SIGNED FIXTURES and email goes to
// the development outbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, lastEmail, type TestClient } from "./support/app.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import type { Env } from "../src/app/context.ts";
import { createPackageOrder, provisionProjectOnce, markInvoicePaid } from "../src/services/commerce.ts";
import {
  openMaintenanceActivation, maintenanceCheckoutBlock, completeActivationForSubscription, runSuspensionSweep,
  suspendHosting, SUSPENSION_GRACE_DAYS,
} from "../src/services/maintenance-lifecycle.ts";
import { renderTemplate } from "../src/services/mailer.ts";
import { OutboxEmail } from "../src/adapters/email.ts";

const mctx = (db: Env["DB"]) => ({ db, email: new OutboxEmail(db), baseUrl: "http://crestmont.test" });

const WHSEC = "whsec_test_maintenance_lifecycle";
const DAY = 86_400_000;
let seq = 0;
const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;
const nowS = () => Math.floor(Date.now() / 1000);

async function webhook(t: { client: () => TestClient }, type: string, object: Record<string, unknown>, created = nowS()) {
  const body = JSON.stringify({ id: `evt_life_${++seq}_${Date.now()}`, type, created, data: { object } });
  const ts = nowS();
  return t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(WHSEC, `${ts}.${body}`)}`, "content-type": "application/json" } });
}

/** A paid Business package order committed to `plan`, with its provisioned project. */
async function paidPackage(db: Env["DB"], plan = "professional") {
  const cu = await createCustomer(db, `life${++seq}@fixture.example`, "Fixture Junk Haulers LLC");
  const o = await createPackageOrder(db, cu.organizationId, "business", cu.id, new Date(), { maintenancePlanId: plan });
  await markInvoicePaid(db, o.invoiceId, { amountCents: o.amountCents, paymentIntentId: `pi_test_${o.invoiceId}` });
  const { projectId } = await provisionProjectOnce(db, o.orderId);
  return { cu, projectId, orderId: o.orderId };
}

test("[PAY-004] FD-27: before launch a package customer cannot start the maintenance subscription; nothing is billed", async () => {
  const t = await createTestApp();
  const { cu } = await paidPackage(t.db);
  assert.match((await maintenanceCheckoutBlock(t.db, cu.organizationId, "professional"))!, /starts when you approve and launch/);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM subscriptions`)).n, 0);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM maintenance_activations`)).n, 0);
});

test("[PAY-004] FD-27 / FD-05: launch opens one activation for the committed plan; unverified plan benefits are never billed and the Owner is told", async () => {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner");
  const { cu, projectId } = await paidPackage(t.db, "executive");
  const a = await openMaintenanceActivation(t.db, null, projectId, "deployment_recorded");
  assert.equal(a!.plan_id, "executive");
  assert.equal(a!.status, "awaiting_plan_verification", "catalog entitlements are not yet operationally verified");
  const again = await openMaintenanceActivation(t.db, null, projectId, "release_live");
  assert.equal(again!.id, a!.id, "one activation per project, whatever launches it");
  assert.equal(again!.trigger, "deployment_recorded");
  assert.match((await one<{ body: string }>(t.db, `SELECT body FROM notifications WHERE user_id = ? AND kind = 'maintenance_activation'`, owner.id)).body, /awaiting operational verification/);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM subscriptions`)).n, 0, "no subscription was created");
  // Once launched, the customer may choose the committed plan or higher; never lower.
  assert.equal(await maintenanceCheckoutBlock(t.db, cu.organizationId, "executive"), null);
  assert.match((await maintenanceCheckoutBlock(t.db, cu.organizationId, "professional"))!, /requires the Executive plan or higher/);
});

test("[PAY-004] FD-27: an active subscription for the committed plan (or higher) completes the activation; a lower plan does not", async () => {
  const t = await createTestApp();
  const { cu, projectId } = await paidPackage(t.db, "professional");
  await openMaintenanceActivation(t.db, null, projectId, "release_live");
  await t.db.prepare(`UPDATE maintenance_activations SET status = 'due' WHERE project_id = ?`).bind(projectId).run(); // as if the plan were verified
  const low = newId("sub"), high = newId("sub");
  for (const [id, plan] of [[low, "essential"], [high, "executive"]]) {
    await t.db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, stripe_subscription_id, status, created_at, updated_at) VALUES (?,?,?,?, 'active', ?, ?)`).bind(id, cu.organizationId, plan, `sub_${id}`, nowIso(), nowIso()).run();
  }
  await completeActivationForSubscription(t.db, cu.organizationId, low, "essential", "active");
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM maintenance_activations WHERE project_id = ?`, projectId)).status, "due", "a downgrade never satisfies the commitment");
  await completeActivationForSubscription(t.db, cu.organizationId, high, "executive", "active");
  const done = await one<{ status: string; subscription_id: string }>(t.db, `SELECT status, subscription_id FROM maintenance_activations WHERE project_id = ?`, projectId);
  assert.deepEqual({ ...done }, { status: "active", subscription_id: high });
});

test("[PAY-004] clarifications 1–2: a failed payment starts a seven-day clock; reminder from day five; eligible on day seven; suspension is an Owner decision that deletes nothing; payment restores", async () => {
  const t = await createTestApp({ STRIPE_WEBHOOK_SECRET: WHSEC });
  const owner = await createStaff(t.db, "owner");
  const cu = await createCustomer(t.db, "late@fixture.example", "Fixture Late Payer LLC");
  const subId = newId("sub");
  await t.db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, stripe_subscription_id, status, created_at, updated_at) VALUES (?,?, 'essential', 'sub_late_1', 'active', ?, ?)`).bind(subId, cu.organizationId, nowIso(), nowIso()).run();
  const failedAt = Date.now();
  assert.equal((await webhook(t, "invoice.payment_failed", { id: "in_late_1", object: "invoice", subscription: "sub_late_1", customer_email: cu.email }, Math.floor(failedAt / 1000))).status, 200);
  const s1 = await one<{ status: string; payment_failed_at: string; suspension_eligible_at: string }>(t.db, `SELECT status, payment_failed_at, suspension_eligible_at FROM subscriptions WHERE id = ?`, subId);
  assert.equal(s1.status, "past_due");
  assert.equal(Date.parse(s1.suspension_eligible_at) - Date.parse(s1.payment_failed_at), SUSPENSION_GRACE_DAYS * DAY);
  const day0 = await lastEmail(t.db, cu.email);
  assert.equal(day0?.template, "failed_payment");
  assert.match(day0!.text_body, /seven days/);
  assert.match(day0!.text_body, /never deletes your website or data/);
  // A second failure in the same episode keeps the original clock.
  await webhook(t, "invoice.payment_failed", { id: "in_late_2", object: "invoice", subscription: "sub_late_1", customer_email: cu.email }, Math.floor((failedAt + 3 * DAY) / 1000));
  assert.equal((await one<{ payment_failed_at: string }>(t.db, `SELECT payment_failed_at FROM subscriptions WHERE id = ?`, subId)).payment_failed_at, s1.payment_failed_at);

  // Day 3: too early for anything. The Owner cannot suspend.
  assert.deepEqual(await runSuspensionSweep(mctx(t.db), new Date(failedAt + 3 * DAY)), { reminded: 0, eligible: 0 });
  await assert.rejects(suspendHosting(mctx(t.db), owner.id, subId, "Unpaid for three days only", new Date(failedAt + 3 * DAY)), /Not eligible until/);
  // Day 5: the reminder goes to the customer administrator, once.
  assert.deepEqual(await runSuspensionSweep(mctx(t.db), new Date(failedAt + 5 * DAY + 60_000)), { reminded: 1, eligible: 0 });
  assert.match((await lastEmail(t.db, cu.email))!.subject, /Reminder: payment still needed/);
  assert.deepEqual(await runSuspensionSweep(mctx(t.db), new Date(failedAt + 6 * DAY)), { reminded: 0, eligible: 0 });
  // Day 7: eligible; the Owner is told; the sweep itself never suspends.
  assert.deepEqual(await runSuspensionSweep(mctx(t.db), new Date(failedAt + 7 * DAY + 60_000)), { reminded: 0, eligible: 1 });
  assert.ok(await t.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'hosting_suspension_eligible'`).bind(owner.id).first());
  assert.equal((await one<{ hosting_suspended_at: string | null }>(t.db, `SELECT hosting_suspended_at FROM subscriptions WHERE id = ?`, subId)).hosting_suspended_at, null);

  // The Owner suspends with a recorded reason. Nothing is deleted.
  await assert.rejects(suspendHosting(mctx(t.db), owner.id, subId, "short", new Date(failedAt + 8 * DAY)), /at least 10 characters/);
  const before = await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM organizations WHERE id = ?`, cu.organizationId);
  await suspendHosting(mctx(t.db), owner.id, subId, "Unpaid eight days after the day-five notice", new Date(failedAt + 8 * DAY));
  const sus = await one<{ hosting_suspended_at: string; hosting_suspended_by: string; status: string }>(t.db, `SELECT hosting_suspended_at, hosting_suspended_by, status FROM subscriptions WHERE id = ?`, subId);
  assert.ok(sus.hosting_suspended_at);
  assert.equal(sus.hosting_suspended_by, owner.id);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM organizations WHERE id = ?`, cu.organizationId)).n, before.n, "organization and data kept");
  assert.equal((await one<{ details: string }>(t.db, `SELECT details_json AS details FROM audit_logs WHERE action = 'hosting.suspended' AND subject_id = ?`, subId)).details.includes('"dataDeleted":false'), true);
  assert.match((await lastEmail(t.db, cu.email))!.text_body, /have not been deleted/);
  await assert.rejects(suspendHosting(mctx(t.db), owner.id, subId, "Trying to suspend a second time", new Date(failedAt + 9 * DAY)), /already suspended/);

  // Payment arrives: failure cleared, hosting restored, customer told.
  assert.equal((await webhook(t, "invoice.paid", { id: "in_late_3", object: "invoice", subscription: "sub_late_1", amount_paid: 9900, customer_email: cu.email })).status, 200);
  const back = await one<{ status: string; payment_failed_at: string | null; hosting_suspended_at: string | null; hosting_restored_at: string | null }>(t.db,
    `SELECT status, payment_failed_at, hosting_suspended_at, hosting_restored_at FROM subscriptions WHERE id = ?`, subId);
  assert.equal(back.status, "active");
  assert.equal(back.payment_failed_at, null);
  assert.equal(back.hosting_suspended_at, null);
  assert.ok(back.hosting_restored_at);
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'hosting.restored' AND subject_id = ?`).bind(subId).first());
  assert.match((await lastEmail(t.db, cu.email))!.text_body, /hosting restored/i);
});

test("[PAY-004] clarification 1: the Owner page lists eligible subscriptions; only the Owner may suspend (other staff 403)", async () => {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner");
  const admin = await createStaff(t.db, "administrator");
  const cu = await createCustomer(t.db, "page@fixture.example", "Fixture Page LLC");
  const subId = newId("sub"), old = new Date(Date.now() - 9 * DAY).toISOString();
  await t.db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, stripe_subscription_id, status, payment_failed_at, suspension_eligible_at, suspension_reminder_sent_at, created_at, updated_at) VALUES (?,?, 'essential', 'sub_page_1', 'past_due', ?, ?, ?, ?, ?)`)
    .bind(subId, cu.organizationId, old, new Date(Date.now() - 2 * DAY).toISOString(), old, nowIso(), nowIso()).run();
  const o = await t.client().login(owner.email, undefined, owner.secret);
  const page = await (await o.get("/staff/billing/hosting")).text();
  assert.match(page, /Fixture Page LLC/);
  assert.match(page, /Suspend hosting/);
  const a = await t.client().login(admin.email, undefined, admin.secret);
  assert.equal((await a.post("/staff/billing/hosting/suspend", { subscription_id: subId, reason: "Administrator should not be able to" })).status, 403);
  assert.equal((await o.post("/staff/billing/hosting/suspend", { subscription_id: subId, reason: "Unpaid nine days after notice" })).status, 303);
  assert.ok((await one<{ hosting_suspended_at: string | null }>(t.db, `SELECT hosting_suspended_at FROM subscriptions WHERE id = ?`, subId)).hosting_suspended_at);
});

test("[EMAIL-002] failed-payment notices state the seven-day rule, that nothing is deleted, and charge no late fee (FD-12)", () => {
  const id = { legalName: null, address: null, contactEmail: "support@fixture.example" };
  const day0 = renderTemplate("failed_payment", { url: "https://x.example/portal/billing", kind: "plan", suspendAfter: "2026-11-09" } as never, id);
  assert.match(day0.text, /seven days/);
  assert.match(day0.text, /no late fee/i);
  const warn = renderTemplate("failed_payment", { url: "https://x.example/portal/billing", kind: "suspension_notice", suspendAfter: "2026-11-09" } as never, id);
  assert.match(warn.text, /2026-11-09/);
  const sus = renderTemplate("failed_payment", { url: "https://x.example/portal/billing", kind: "suspended" } as never, id);
  assert.match(sus.text, /have not been deleted/);
});

test("[CAT-005] FD-26: public pages and the website assistant no longer describe maintenance plans as optional", async () => {
  const t = await createTestApp();
  for (const path of ["/pricing", "/hosting-maintenance", "/services/hosting-maintenance", "/"]) {
    const r = await t.client().get(path);
    if (r.status !== 200) continue;
    const html = await r.text();
    assert.doesNotMatch(html, /Optional maintenance plans|Maintenance plans are optional|Plans are optional|Ongoing care \(optional\)/, path);
  }
  const hosting = await (await t.client().get("/hosting-maintenance")).text();
  assert.match(hosting, /requires a minimum maintenance plan/);
  const { assistantKnowledge } = await import("../src/services/assistant.ts");
  const facts = assistantKnowledge({ email: "hello@fixture.example", pricesCents: {}, process: [], faqs: [] });
  assert.doesNotMatch(facts, /MAINTENANCE PLANS \(optional/);
  assert.match(facts, /every website package requires a minimum plan/);
});
