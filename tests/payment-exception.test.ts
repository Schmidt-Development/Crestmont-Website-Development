// FD-16 (Founder decision, 2026-11): the Founder may authorize a documented launch/payment exception through an
// authenticated, MFA-protected workflow. It waives only unpaid scheduled milestones; never approvals, change orders or
// simulated payments; it is revocable. TEST DATA only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff } from "./support/app.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import type { Env } from "../src/app/context.ts";
import type { Actor } from "../src/domain/authz.ts";
import { provisionProject } from "../src/services/commerce.ts";
import { releaseReadiness, grantPaymentException, revokePaymentException } from "../src/services/projects.ts";

const staffActor = (s: { id: string; organizationId: string }, role: "owner" | "project_manager" | "administrator", mfa = true): Actor =>
  ({ kind: "user", userId: s.id, roles: [{ role, organizationId: s.organizationId }], mfaVerified: mfa });

/** A milestone project with the deposit paid and every approval recorded, so only payment is outstanding. */
async function nearlyReady(db: Env["DB"], approver: string) {
  const cu = await createCustomer(db, `pex${Math.random()}@fixture.example`, "Fixture Exception LLC");
  const orderId = newId("ord");
  await db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, created_at) VALUES (?,?, 'custom', 400000, 'partially_paid', 'quote', ?)`).bind(orderId, cu.organizationId, nowIso()).run();
  await db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, created_at) VALUES (?,?,?, 'deposit_50', 200000, 'paid', ?)`).bind(newId("inv"), cu.organizationId, orderId, nowIso()).run();
  const pid = await provisionProject(db, orderId);
  await db.prepare(`UPDATE projects SET payment_schedule = 'milestone_50_25_25' WHERE id = ?`).bind(pid).run();
  for (const kind of ["engineering_complete", "internal_qa", "security_accessibility", "customer_launch", "deployment_authorized"]) {
    await db.prepare(`INSERT INTO approvals (id, project_id, kind, decision, decided_by, created_at) VALUES (?,?,?, 'approved', ?, ?)`).bind(newId("apv"), pid, kind, approver, nowIso()).run();
  }
  await db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, created_at) VALUES (?, 'user', 'project.status_changed', 'project', ?, '{"to":"customer_review"}', ?)`).bind(approver, pid, nowIso()).run();
  return { pid, cu };
}

test("[PAY-006] [PM-006] FD-16: an Owner exception waives only unpaid scheduled milestones; revoking restores the block", async () => {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner");
  const { pid } = await nearlyReady(t.db, owner.id);
  const before = await releaseReadiness(t.db, pid);
  assert.equal(before.ready, false);
  assert.deepEqual(before.missing, ["payment:design_25,prelaunch_25"]);

  await assert.rejects(grantPaymentException(t.db, staffActor(owner, "owner"), pid, "too short"), /20–2000 characters/);
  await grantPaymentException(t.db, staffActor(owner, "owner"), pid, "Customer agreed in writing to pay both milestones within 7 days of launch (TEST DATA)");
  const after = await releaseReadiness(t.db, pid);
  assert.equal(after.ready, true);
  assert.match(after.checks.find((c) => c.key === "payment_verified")!.detail, /Founder payment exception in force/);
  await assert.rejects(grantPaymentException(t.db, staffActor(owner, "owner"), pid, "A second exception for the same project (TEST DATA)"), /already in force/);

  // An unpaid change order is never waived.
  await t.db.prepare(`INSERT INTO invoices (id, organization_id, project_id, milestone_kind, amount_cents, status, created_at) SELECT ?, organization_id, id, 'change_order', 5000, 'open', ? FROM projects WHERE id = ?`).bind(newId("inv"), nowIso(), pid).run();
  assert.deepEqual((await releaseReadiness(t.db, pid)).missing, ["payment:change_order"]);
  await t.db.prepare(`UPDATE invoices SET status = 'paid' WHERE project_id = ? AND milestone_kind = 'change_order'`).bind(pid).run();

  await revokePaymentException(t.db, staffActor(owner, "owner"), pid, "Customer withdrew the agreement");
  assert.deepEqual((await releaseReadiness(t.db, pid)).missing, ["payment:design_25,prelaunch_25"], "the block applies again");
  const actions = (await t.db.prepare(`SELECT action FROM audit_logs WHERE subject_id = ? AND action LIKE 'release.payment_exception%' ORDER BY id`).bind(pid).all<{ action: string }>()).results.map((r) => r.action);
  assert.deepEqual(actions, ["release.payment_exception_granted", "release.payment_exception_revoked"]);
});

test("[PAY-006] FD-16: only the Founder (Owner with MFA, a person) may grant; AI, other staff and unverified sessions are refused", async () => {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner");
  const pm = await createStaff(t.db, "project_manager");
  const admin = await createStaff(t.db, "administrator");
  const { pid } = await nearlyReady(t.db, owner.id);
  const reason = "Customer agreed in writing to pay both milestones within 7 days of launch (TEST DATA)";
  for (const a of [staffActor(pm, "project_manager"), staffActor(admin, "administrator"), staffActor(owner, "owner", false), { ...staffActor(owner, "owner"), kind: "ai" } as Actor]) {
    await assert.rejects(grantPaymentException(t.db, a, pid, reason), /Only the Founder/);
  }
  assert.equal((await t.db.prepare(`SELECT COUNT(*) n FROM release_payment_exceptions`).first<{ n: number }>())!.n, 0);
});

test("[PAY-006] FD-16: a project paid by a simulated test payment can never be released, exception or not; a fully paid project needs none", async () => {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner");
  const { pid } = await nearlyReady(t.db, owner.id);
  await grantPaymentException(t.db, staffActor(owner, "owner"), pid, "Customer agreed in writing to pay both milestones within 7 days of launch (TEST DATA)");
  const order = (await t.db.prepare(`SELECT order_id, organization_id FROM projects WHERE id = ?`).bind(pid).first<{ order_id: string; organization_id: string }>())!;
  await t.db.prepare(`INSERT INTO payments (id, organization_id, order_id, amount_cents, status, provider, created_at) VALUES (?,?,?, 1, 'succeeded', 'simulated', ?)`).bind(newId("pay"), order.organization_id, order.order_id, nowIso()).run();
  assert.ok((await releaseReadiness(t.db, pid)).missing.includes("payment:simulated_test_payment"));

  const paid = await nearlyReady(t.db, owner.id);
  await t.db.prepare(`UPDATE invoices SET status = 'paid' WHERE order_id = (SELECT order_id FROM projects WHERE id = ?)`).bind(paid.pid).run();
  for (const k of ["design_25", "prelaunch_25"]) await t.db.prepare(`INSERT INTO invoices (id, organization_id, project_id, milestone_kind, amount_cents, status, created_at) VALUES (?,?,?,?, 100000, 'paid', ?)`).bind(newId("inv"), paid.cu.organizationId, paid.pid, k, nowIso()).run();
  await assert.rejects(grantPaymentException(t.db, staffActor(owner, "owner"), paid.pid, "Not needed: every milestone is already paid (TEST DATA)"), /already paid/);
});

test("[PAY-006] FD-16: the route is Owner-only and requires a fresh second factor (step-up)", async () => {
  const { STEP_UP_ROUTES } = await import("../src/app/step-up.ts");
  assert.ok(STEP_UP_ROUTES["POST /staff/projects/:id/payment-exception"]);
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner");
  const pm = await createStaff(t.db, "project_manager");
  const { pid } = await nearlyReady(t.db, owner.id);
  await t.db.prepare(`UPDATE projects SET project_manager_id = ? WHERE id = ?`).bind(pm.id, pid).run();
  const pmc = await t.client().login(pm.email, undefined, pm.secret);
  assert.equal((await pmc.post(`/staff/projects/${pid}/payment-exception`, { intent: "grant", reason: "A project manager must not be able to do this" })).status, 403);
  const oc = await t.client().login(owner.email, undefined, owner.secret);
  assert.match(await (await oc.get(`/staff/projects/${pid}?tab=approvals`)).text(), /data-testid="payment-exception"/);
  assert.doesNotMatch(await (await pmc.get(`/staff/projects/${pid}?tab=approvals`)).text(), /data-testid="payment-exception"/);
  assert.equal((await oc.post(`/staff/projects/${pid}/payment-exception`, { intent: "grant", reason: "Customer agreed in writing to pay within 7 days of launch (TEST DATA)" })).status, 303);
  assert.equal((await releaseReadiness(t.db, pid)).ready, true);
});
