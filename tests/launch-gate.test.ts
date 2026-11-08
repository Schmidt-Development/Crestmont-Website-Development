// The website launch gate (Founder directive 2026-11-08; src/services/launch-gate.ts): no website goes live until the
// customer has signed the maintenance agreement AND Stripe's signed webhook has confirmed the first maintenance payment.
//
// Every Stripe event here goes through the real /api/webhooks/stripe endpoint with a valid signature (TEST DATA,
// signed fixtures; nothing reaches Stripe). Every release path is exercised: release readiness (status -> deployment,
// the "deployment authorized" approval, recording a deployment), handoff publication, the Owner's release preparation
// and authorization, and the runner's claim of an authorized deployment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, type TestClient } from "./support/app.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import type { Env } from "../src/app/context.ts";
import { createPackageOrder, provisionProjectOnce, markInvoicePaid } from "../src/services/commerce.ts";
import { launchEligibility } from "../src/services/launch-gate.ts";
import { releaseReadiness } from "../src/services/projects.ts";
import { claimDeployment } from "../src/services/site-delivery.ts";

const WHSEC = "whsec_test_launch_gate";
let seq = 0;
const nowS = () => Math.floor(Date.now() / 1000);
const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;

async function stripe(t: { client: () => TestClient }, type: string, object: Record<string, unknown>, id = `evt_gate_${++seq}_${Date.now()}`) {
  const body = JSON.stringify({ id, type, created: nowS(), data: { object } });
  const ts = nowS();
  return t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(WHSEC, `${ts}.${body}`)}`, "content-type": "application/json" } });
}

/** A paid Business package committed to the Professional plan, its website complete and moved to customer review. */
async function reviewReady() {
  const t = await createTestApp({ STRIPE_WEBHOOK_SECRET: WHSEC });
  const pm = await createStaff(t.db, "project_manager", `pm${++seq}@crestmont.test`);
  const cu = await createCustomer(t.db, `gate${++seq}@fixture.example`, "Fixture Harbor Dental LLC");
  const o = await createPackageOrder(t.db, cu.organizationId, "business", cu.id, new Date(), { maintenancePlanId: "professional" });
  await markInvoicePaid(t.db, o.invoiceId, { amountCents: o.amountCents, paymentIntentId: `pi_dev_${o.invoiceId}` });
  const { projectId } = await provisionProjectOnce(t.db, o.orderId);
  await t.db.prepare(`UPDATE projects SET status = 'internal_qa' WHERE id = ?`).bind(projectId).run();
  const staff = await t.client().login(pm.email);
  // The website is marked ready for the customer's review through the real transition, which opens the activation.
  assert.equal((await staff.post(`/staff/projects/${projectId}/status`, { to: "customer_review" })).status, 303);
  const customer = await t.client().login(cu.email);
  return { t, pm, cu, projectId, staff, customer };
}

const subObject = (id: string, org: string, status: string) => ({ id, status, customer: "cus_gate", current_period_end: nowS() + 30 * 86400, metadata: { organization_id: org, product_id: "professional" } });
const firstInvoice = (id: string, sub: string, o: Partial<Record<string, unknown>> = {}) => ({ id, customer: "cus_gate", subscription: sub, billing_reason: "subscription_create", amount_paid: 19900, payment_intent: `pi_${id}`, status_transitions: { paid_at: nowS() }, ...o });

const gate = (db: Env["DB"], pid: string) => launchEligibility(db, pid);

test("[PAY-004] launch gate: the activation opens at customer review and the portal shows the two pending actions in order", async () => {
  const { t, projectId, customer } = await reviewReady();
  const act = await one<{ trigger: string; status: string; launched_at: string | null; plan_id: string }>(t.db, `SELECT trigger, status, launched_at, plan_id FROM maintenance_activations WHERE project_id = ?`, projectId);
  assert.deepEqual({ ...act }, { trigger: "ready_for_review", status: "due", launched_at: null, plan_id: "professional" });

  let page = await (await customer.get(`/portal/projects/${projectId}`)).text();
  assert.match(page, /Before your website goes live/);
  assert.match(page, /Pending action: Sign your maintenance agreement/);
  assert.match(page, /Pending action: Activate your maintenance subscription/);
  assert.match(page, /Available after you sign the maintenance agreement/);
  assert.match(await (await customer.get("/portal")).text(), /Pending action: Sign your maintenance agreement/, "listed in Required from you");

  // A customer member (not an administrator) cannot sign for the organisation.
  const member = await t.client().login((await createCustomerMember(t.db, (await one<{ organization_id: string }>(t.db, `SELECT organization_id FROM projects WHERE id = ?`, projectId)).organization_id)));
  assert.equal((await member.post(`/portal/projects/${projectId}/maintenance-agreement`, { agree: "1" })).status, 403);
  // Without ticking the box nothing is recorded.
  await customer.post(`/portal/projects/${projectId}/maintenance-agreement`, {});
  assert.equal((await gate(t.db, projectId)).steps.find((s) => s.key === "agreement_signed")!.done, false);
  assert.equal((await customer.post(`/portal/projects/${projectId}/maintenance-agreement`, { agree: "1" })).status, 303);
  assert.ok((await gate(t.db, projectId)).steps.find((s) => s.key === "agreement_signed")!.done);
  page = await (await customer.get(`/portal/projects/${projectId}`)).text();
  assert.doesNotMatch(page, /Pending action: Sign your maintenance agreement/, "the signed step disappears by itself");
  assert.match(page, /Pending action: Activate your maintenance subscription/);
  assert.match(page, /href="\/checkout\/maintenance\/professional"/);
  const audit = await one<{ details_json: string }>(t.db, `SELECT details_json FROM audit_logs WHERE action = 'agreements.accepted' ORDER BY id DESC LIMIT 1`);
  assert.match(audit.details_json, /"context":"maintenance_agreement"/);
  assert.match(audit.details_json, new RegExp(projectId));
});

async function createCustomerMember(db: Env["DB"], orgId: string): Promise<string> {
  const { hashPassword } = await import("../src/lib/auth-crypto.ts");
  const { TEST_PASSWORD } = await import("./support/app.ts");
  const id = newId("usr"), email = `member${++seq}@fixture.example`;
  await db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, created_at) VALUES (?,?,?,?,?,?)`).bind(id, email, "Member", await hashPassword(TEST_PASSWORD), nowIso(), nowIso()).run();
  await db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?,'customer_member',?)`).bind(newId("mbr"), id, orgId, nowIso()).run();
  return email;
}

test("[PAY-004] launch gate: every incomplete state is blocked; only a signed agreement plus a Stripe-verified first payment unlocks publishing", async () => {
  const { t, cu, projectId, customer } = await reviewReady();
  const org = cu.organizationId;
  const blocked = async (why: string, missing: string) => {
    const g = await gate(t.db, projectId);
    assert.equal(g.eligible, false, why);
    assert.ok(g.missing.includes(missing), `${why}: ${g.missing.join(", ")}`);
    assert.ok((await releaseReadiness(t.db, projectId)).missing.includes(missing), `${why}: release readiness blocks too`);
  };

  // 1. Agreement not signed.
  await blocked("agreement not signed", "maintenance:agreement_not_signed");
  assert.equal((await gate(t.db, projectId)).status, "Website ready — waiting for the maintenance agreement to be signed");
  // The subscription cannot even be started before the agreement is signed.
  assert.equal((await customer.post(`/checkout/maintenance/professional`, { terms: "1" })).status, 409);

  // 2. Signed, no subscription. Checkout abandoned (session expired): still nothing.
  await customer.post(`/portal/projects/${projectId}/maintenance-agreement`, { agree: "1" });
  await blocked("signed, no subscription", "maintenance:subscription_not_active");
  assert.equal((await gate(t.db, projectId)).status, "Website ready — waiting for maintenance subscription");
  assert.equal((await stripe(t, "checkout.session.expired", { id: "cs_gate_abandoned", mode: "subscription", metadata: { organization_id: org, product_id: "professional" } })).status, 200);
  await blocked("checkout abandoned", "maintenance:subscription_not_active");

  // 3. Subscription created incomplete, and the first payment fails (or needs further action).
  assert.equal((await stripe(t, "customer.subscription.created", subObject("sub_gate", org, "incomplete"))).status, 200);
  assert.equal((await stripe(t, "invoice.payment_failed", { id: "in_gate_1", customer: "cus_gate", subscription: "sub_gate", billing_reason: "subscription_create" })).status, 200);
  await blocked("initial payment failed / subscription incomplete", "maintenance:subscription_not_active");
  await blocked("initial payment failed", "maintenance:initial_payment_not_verified");
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM maintenance_activations WHERE project_id = ?`, projectId)).status, "due", "an incomplete subscription does not complete the activation");

  // 4. Out of order: the first invoice's payment arrives BEFORE the subscription turns active. Still blocked (Stripe
  //    has not reported the subscription active), and nothing is lost.
  const paidEvt = `evt_gate_paid_${Date.now()}`;
  assert.equal((await stripe(t, "invoice.paid", firstInvoice("in_gate_1", "sub_gate"), paidEvt)).status, 200);
  await blocked("payment confirmed, subscription not yet active", "maintenance:subscription_not_active");
  // 5. Stripe reports the subscription active: publishing is permitted.
  assert.equal((await stripe(t, "customer.subscription.updated", subObject("sub_gate", org, "active"))).status, 200);
  let g = await gate(t.db, projectId);
  assert.equal(g.eligible, true, g.missing.join(", "));
  assert.equal(g.status, "Website approved for publishing");
  assert.equal((await releaseReadiness(t.db, projectId)).missing.some((m) => m.startsWith("maintenance:")), false);
  const page = await (await customer.get(`/portal/projects/${projectId}`)).text();
  assert.doesNotMatch(page, /Pending action:/, "both pending actions disappear once verified");
  assert.match(page, /Your website can now be published/);

  // 6. Duplicate webhooks change nothing: one first-payment record, one activation event.
  assert.equal((await stripe(t, "invoice.paid", firstInvoice("in_gate_1", "sub_gate"), paidEvt)).status, 200);
  assert.equal((await stripe(t, "invoice.paid", firstInvoice("in_gate_1", "sub_gate"))).status, 200);
  assert.equal((await stripe(t, "customer.subscription.updated", subObject("sub_gate", org, "active"))).status, 200);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM subscription_initial_payments`)).n, 1);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'maintenance.activation_active'`)).n, 1);

  // 7. A LATER renewal failure follows the existing seven-day policy; it does not withdraw launch eligibility.
  assert.equal((await stripe(t, "invoice.payment_failed", { id: "in_gate_2", customer: "cus_gate", subscription: "sub_gate", billing_reason: "subscription_cycle" })).status, 200);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM subscriptions WHERE stripe_subscription_id = 'sub_gate'`)).status, "past_due");
  assert.ok((await one<{ payment_failed_at: string }>(t.db, `SELECT payment_failed_at FROM subscriptions WHERE stripe_subscription_id = 'sub_gate'`)).payment_failed_at, "the seven-day clock started");
  assert.equal((await gate(t.db, projectId)).eligible, true);
  // A renewal invoice is never mistaken for the first payment.
  assert.equal((await stripe(t, "invoice.paid", firstInvoice("in_gate_2", "sub_gate", { billing_reason: "subscription_cycle" }))).status, 200);
  assert.equal((await one<{ stripe_invoice_id: string }>(t.db, `SELECT stripe_invoice_id FROM subscription_initial_payments WHERE stripe_subscription_id = 'sub_gate'`)).stripe_invoice_id, "in_gate_1");

  // 8. A dispute of the first payment closes the gate until it is won; a full refund closes it.
  assert.equal((await stripe(t, "charge.dispute.created", { id: "dp_gate", charge: "ch_gate", payment_intent: "pi_in_gate_1", amount: 19900, reason: "fraudulent", status: "needs_response" })).status, 200);
  await blocked("first payment disputed", "maintenance:initial_payment_not_verified");
  assert.equal((await stripe(t, "charge.dispute.closed", { id: "dp_gate", charge: "ch_gate", payment_intent: "pi_in_gate_1", amount: 19900, reason: "fraudulent", status: "won" })).status, 200);
  assert.equal((await gate(t.db, projectId)).eligible, true, "a won dispute restores it");
  assert.equal((await stripe(t, "charge.refunded", { id: "ch_gate", payment_intent: "pi_in_gate_1", amount: 19900, amount_refunded: 19900, refunds: { data: [{ id: "re_gate", amount: 19900 }] } })).status, 200);
  await blocked("first payment refunded", "maintenance:initial_payment_not_verified");
  g = await gate(t.db, projectId);
  assert.match(g.steps.find((s) => s.key === "initial_payment_verified")!.detail, /refunded/);

  // 9. Cancellation closes it as well.
  await t.db.prepare(`UPDATE subscription_initial_payments SET reversed_at = NULL, reversal_reason = NULL`).run();
  assert.equal((await stripe(t, "customer.subscription.deleted", subObject("sub_gate", org, "canceled"))).status, 200);
  await blocked("subscription cancelled", "maintenance:subscription_not_active");
});

test("[PAY-004] launch gate: a $0 first invoice (a trial) is not a payment, and a trialing subscription does not unlock publishing", async () => {
  const { t, cu, projectId, customer } = await reviewReady();
  await customer.post(`/portal/projects/${projectId}/maintenance-agreement`, { agree: "1" });
  await stripe(t, "invoice.paid", firstInvoice("in_trial", "sub_trial", { amount_paid: 0 }));
  await stripe(t, "customer.subscription.created", subObject("sub_trial", cu.organizationId, "trialing"));
  const g = await gate(t.db, projectId);
  assert.equal(g.eligible, false);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM subscription_initial_payments`)).n, 0);
});

test("[PAY-004] launch gate: no release path can bypass it — deployment record, status change, authorization approval, handoff, Owner release and the runner", async () => {
  const { t, cu, projectId, staff } = await reviewReady();
  const owner = await createStaff(t.db, "owner", `owner${++seq}@crestmont.test`);
  const oc = await t.client().login(owner.email);
  // Everything else in the release chain is in place, so only the maintenance gate stands in the way.
  await t.db.prepare(`UPDATE projects SET status = 'final_approval' WHERE id = ?`).bind(projectId).run();
  for (const kind of ["engineering_complete", "internal_qa", "security_accessibility", "customer_launch"]) {
    await t.db.prepare(`INSERT INTO approvals (id, project_id, kind, decision, decided_by, created_at) VALUES (?,?,?, 'approved', ?, ?)`).bind(newId("apv"), projectId, kind, owner.id, nowIso()).run();
  }
  // Customer approval alone never satisfies the gate.
  const r = await releaseReadiness(t.db, projectId);
  assert.deepEqual(r.missing.filter((m) => !m.startsWith("maintenance:")).sort(), ["deployment_authorized"]);

  // Manual paths (staff, server-side): authorization approval, status change, deployment record, handoff publish.
  const auth = await staff.post(`/staff/projects/${projectId}/approvals`, { kind: "deployment_authorized", decision: "approved" });
  assert.equal(auth.status, 409);
  assert.match(await auth.text(), /maintenance:agreement_not_signed/);
  await t.db.prepare(`INSERT INTO approvals (id, project_id, kind, decision, decided_by, created_at) VALUES (?,?, 'deployment_authorized', 'approved', ?, ?)`).bind(newId("apv"), projectId, owner.id, nowIso()).run();
  assert.equal((await staff.post(`/staff/projects/${projectId}/status`, { to: "deployment" })).status, 409);
  assert.equal((await staff.post(`/staff/projects/${projectId}/deployments`, { url: "https://harbor.example" })).status, 409);
  const ho = await staff.post(`/staff/projects/${projectId}/handoff`, { intent: "publish", website_url: "https://harbor.example", documentation: "Docs", access_instructions: "Invite", ownership_notes: "Domain", training_notes: "Video" });
  assert.equal(ho.status, 409);
  assert.equal(await t.db.prepare(`SELECT 1 FROM customer_deployments WHERE project_id = ?`).bind(projectId).first(), null, "nothing was deployed");

  // Owner release path and the runner: an authorized release whose gate does not hold is never claimed -- it is
  // cancelled with the reason, so the Owner sees why.
  const jobId = newId("bld");
  await t.db.prepare(`INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, strategy, trigger, source_repo, source_commit, approved_at, created_at, updated_at)
    VALUES (?,?,?, 'first_build', 0, ?, 'approved', 'standard', 'payment', 'https://github.com/crestmont-builds/gate', 'abc1234def', ?, ?, ?)`).bind(jobId, projectId, cu.organizationId, `${projectId}:first`, nowIso(), nowIso(), nowIso()).run();
  assert.equal((await oc.post(`/staff/builds/projects/${projectId}/site-target`)).status, 303);
  const prep = await oc.post(`/staff/builds/${jobId}/prepare-release`, { customer_review_na: "Owner-run site; reviewed on a call." });
  const flash = decodeURIComponent(prep.headers.getSetCookie().join(";"));
  assert.match(flash, /waiting for the maintenance agreement to be signed/);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM site_deployments`)).n, 0, "no release was prepared");
  // Even an authorized release (e.g. authorized before the first payment was refunded) is refused at the claim.
  const target = await one<{ id: string; worker_name: string }>(t.db, `SELECT id, worker_name FROM site_targets WHERE project_id = ?`, projectId);
  const depId = newId("sd");
  await t.db.prepare(`INSERT INTO site_deployments (id, target_id, project_id, organization_id, build_job_id, version, kind, state, source_repo, source_commit, worker_name, prepared_at, authorized_at, created_at, updated_at)
    VALUES (?,?,?,?,?, 1, 'release', 'authorized', 'https://github.com/crestmont-builds/gate', 'abc1234def', ?, ?, ?, ?, ?)`).bind(depId, target.id, projectId, cu.organizationId, jobId, target.worker_name, nowIso(), nowIso(), nowIso(), nowIso()).run();
  const claimed = await claimDeployment(t.db, { runnerId: "r1", capabilities: ["production-deploy"] });
  assert.equal(claimed.deployment, null, "the runner is given nothing to deploy");
  const d = await one<{ state: string; state_reason: string }>(t.db, `SELECT state, state_reason FROM site_deployments WHERE id = ?`, depId);
  assert.equal(d.state, "canceled");
  assert.match(d.state_reason, /Launch gate/);
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'builds.site_release_blocked_by_launch_gate' AND subject_id = ?`).bind(projectId).first());

  // Satisfied the real way: sign, then Stripe confirms. Now the manual path goes through.
  const customer = await t.client().login(cu.email);
  await customer.post(`/portal/projects/${projectId}/maintenance-agreement`, { agree: "1" });
  await stripe(t, "customer.subscription.created", subObject("sub_gate_ok", cu.organizationId, "active"));
  await stripe(t, "invoice.paid", firstInvoice("in_gate_ok", "sub_gate_ok"));
  assert.equal((await gate(t.db, projectId)).eligible, true);
  assert.equal((await staff.post(`/staff/projects/${projectId}/deployments`, { url: "https://harbor.example" })).status, 303);
  const act = await one<{ launched_at: string | null; trigger: string }>(t.db, `SELECT launched_at, trigger FROM maintenance_activations WHERE project_id = ?`, projectId);
  assert.ok(act.launched_at, "the launch is recorded on the activation");
  assert.equal(act.trigger, "ready_for_review", "the activation was opened at review, before launch");
  // Staff see the plain-English launch status.
  assert.match(await (await staff.get(`/staff/projects/${projectId}?tab=approvals`)).text(), /Launch status:.*Website approved for publishing/s);
});
