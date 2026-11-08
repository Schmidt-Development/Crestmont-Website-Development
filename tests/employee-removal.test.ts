// Removing an employee (Founder directive 2026-11-08): access revoked immediately (membership and every session),
// open work unassigned for reassignment, history and the person's other organisations untouched, the last Owner
// protected. Through the real request pipeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer } from "./support/app.ts";
import { newId, nowIso } from "../src/lib/db.ts";

async function world() {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner", "owner@crestmont.test", "Olive Owner");
  const admin = await createStaff(t.db, "administrator", "admin@crestmont.test", "Ada Admin");
  const dev = await createStaff(t.db, "developer", "dev@crestmont.test", "Dev Eloper");
  const ownerC = await t.client().login(owner.email);
  const adminC = await t.client().login(admin.email);
  return { t, owner, admin, dev, ownerC, adminC };
}

const one = async <T>(db: Awaited<ReturnType<typeof createTestApp>>["db"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;

test("[EMP-001] an administrator removes an employee: access and sessions revoked, work unassigned for reassignment, history kept", async () => {
  const { t, admin, dev, adminC } = await world();
  // The developer has an open task, completed work and history.
  const cust = await createCustomer(t.db);
  const pid = newId("prj"), task = newId("tsk"), done = newId("tsk");
  await t.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES (?,?, 'Site', 'development', 2, 'upfront', ?, ?)`).bind(pid, cust.organizationId, nowIso(), nowIso()).run();
  for (const [id, status] of [[task, "in_progress"], [done, "done"]]) {
    await t.db.prepare(`INSERT INTO tasks (id, project_id, title, status, created_at) VALUES (?,?,?,?,?)`).bind(id, pid, `Task ${status}`, status, nowIso()).run();
    await t.db.prepare(`INSERT INTO assignments (id, subject_type, subject_id, user_id, assigned_by, created_at) VALUES (?, 'task', ?, ?, ?, ?)`).bind(newId("asg"), id, dev.id, admin.id, nowIso()).run();
  }
  const devC = await t.client().login(dev.email);
  assert.equal((await devC.get("/staff")).status, 200, "the developer can work before removal");

  // The page offers it, clearly, with a typed confirmation.
  const page = await (await adminC.get(`/staff/employees/${dev.id}`)).text();
  assert.match(page, /<h2 class="card__title">Remove employee<\/h2>/);
  assert.match(page, /Type REMOVE to confirm/);
  // Without the typed confirmation nothing happens.
  await adminC.post(`/staff/employees/${dev.id}/remove`, { reason: "Left the company", confirm: "" });
  assert.ok(await t.db.prepare(`SELECT 1 FROM memberships WHERE user_id = ?`).bind(dev.id).first(), "not removed without confirmation");

  const res = await adminC.post(`/staff/employees/${dev.id}/remove`, { reason: "Left the company", confirm: "REMOVE" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/staff/employees");
  // Access: no staff membership, every session revoked, the identity kept but disabled (no other organisation).
  assert.equal(await t.db.prepare(`SELECT 1 FROM memberships WHERE user_id = ?`).bind(dev.id).first(), null);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL`, dev.id)).n, 0);
  assert.ok((await one<{ disabled_at: string | null }>(t.db, `SELECT disabled_at FROM users WHERE id = ?`, dev.id)).disabled_at);
  assert.notEqual((await devC.get("/staff")).status, 200, "the old session no longer opens the staff area");
  // Even a session that somehow survived revocation is refused: the membership itself is gone.
  await t.db.prepare(`UPDATE sessions SET revoked_at = NULL WHERE user_id = ?`).bind(dev.id).run();
  await t.db.prepare(`UPDATE users SET disabled_at = NULL WHERE id = ?`).bind(dev.id).run();
  const stale = await devC.get("/staff/tasks");
  assert.ok([303, 403].includes(stale.status), `a stale session cannot reach staff routes (got ${stale.status})`);
  assert.equal((await devC.post(`/staff/tasks/${task}/status`, { status: "done" })).status === 303 && (await one<{ status: string }>(t.db, `SELECT status FROM tasks WHERE id = ?`, task)).status === "done", false, "and cannot act");
  // Work: the open task is unassigned and recorded for reassignment; the completed one keeps its history.
  assert.equal(await t.db.prepare(`SELECT 1 FROM assignments WHERE subject_id = ? AND user_id = ? AND ended_at IS NULL`).bind(task, dev.id).first(), null, "open assignment ended");
  assert.ok(await t.db.prepare(`SELECT 1 FROM offboarding_items WHERE user_id = ? AND subject_id = ? AND status = 'ended'`).bind(dev.id, task).first(), "flagged for coordinators");
  assert.ok(await t.db.prepare(`SELECT 1 FROM tasks WHERE id = ?`).bind(done).first(), "completed work kept");
  // History: the person's record and the audit trail are preserved.
  assert.ok(await t.db.prepare(`SELECT 1 FROM users WHERE id = ?`).bind(dev.id).first());
  const audit = await one<{ actor_user_id: string; details_json: string }>(t.db, `SELECT actor_user_id, details_json FROM audit_logs WHERE action = 'employee.removed' AND subject_id = ?`, dev.id);
  assert.equal(audit.actor_user_id, admin.id);
  assert.match(audit.details_json, /"reason":"Left the company"/);
  assert.match(audit.details_json, /"keptIdentity":false/);
});

test("[EMP-001] a person who is also a customer keeps their customer access when removed as staff", async () => {
  const { t, dev, adminC } = await world();
  const cust = await createCustomer(t.db);
  await t.db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?, 'customer_member', ?)`).bind(newId("mbr"), dev.id, cust.organizationId, nowIso()).run();
  assert.equal((await adminC.post(`/staff/employees/${dev.id}/remove`, { reason: "Contract ended", confirm: "REMOVE" })).status, 303);
  assert.equal((await one<{ disabled_at: string | null }>(t.db, `SELECT disabled_at FROM users WHERE id = ?`, dev.id)).disabled_at, null, "the shared identity is not disabled");
  const c = await t.client().login(dev.email);
  assert.equal((await c.get("/portal")).status, 200, "their customer portal still works");
  assert.equal((await c.get("/staff")).status, 403, "the staff area does not");
});

test("[EMP-001] permissions and Owner protection: no self-removal, only an Owner removes an Owner, never the last one", async () => {
  const { t, owner, admin, dev, ownerC, adminC } = await world();
  // Roles without employee.manage cannot remove anyone.
  const pm = await createStaff(t.db, "project_manager", "pm@crestmont.test");
  const pmC = await t.client().login(pm.email);
  assert.equal((await pmC.post(`/staff/employees/${dev.id}/remove`, { reason: "x".repeat(10), confirm: "REMOVE" })).status, 403);
  assert.equal((await (await t.client().login(dev.email)).post(`/staff/employees/${pm.id}/remove`, { reason: "x".repeat(10), confirm: "REMOVE" })).status, 403);
  // Nobody removes themselves.
  assert.equal((await adminC.post(`/staff/employees/${admin.id}/remove`, { reason: "Leaving", confirm: "REMOVE" })).status, 403);
  // An administrator cannot remove an Owner.
  assert.equal((await adminC.post(`/staff/employees/${owner.id}/remove`, { reason: "No", confirm: "REMOVE" })).status, 403);
  // The last active Owner cannot be removed (by another Owner either: add a second Owner, then try the first).
  const owner2 = await createStaff(t.db, "owner", "owner2@crestmont.test", "Second Owner");
  const o2 = await t.client().login(owner2.email);
  assert.equal((await o2.post(`/staff/employees/${owner.id}/remove`, { reason: "Handing over", confirm: "REMOVE" })).status, 303, "with another Owner active, an Owner may remove an Owner");
  // owner2 is now the only Owner: nobody can remove them. (The removed Owner's own session is revoked, so use the
  // admin, who is refused for the Owner rule, and a check of the count rule directly.)
  assert.equal((await adminC.post(`/staff/employees/${owner2.id}/remove`, { reason: "No", confirm: "REMOVE" })).status, 403);
  const { removeEmployee } = await import("../src/services/employees.ts");
  const third = await createStaff(t.db, "owner", "owner3@crestmont.test");
  await t.db.prepare(`UPDATE users SET disabled_at = ? WHERE id = ?`).bind(nowIso(), third.id).run(); // a disabled Owner does not count
  await assert.rejects(removeEmployee(t.db, { userId: third.id, isOwner: true }, owner2.id, "Handing over"), /last active Owner/);
  void ownerC;
  assert.ok(await t.db.prepare(`SELECT 1 FROM memberships WHERE user_id = ? AND role_id = 'owner'`).bind(owner2.id).first(), "the last Owner keeps access");
});
