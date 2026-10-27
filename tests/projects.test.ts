// Staff delivery: lifecycle, tasks/dependencies, assignments, release readiness, deployment, inactivity, dashboards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, lastEmail, TEST_PASSWORD } from "./support/app.ts";
import { provisionProject, markInvoicePaid } from "../src/services/commerce.ts";
import { runInactivitySweep } from "../src/services/projects.ts";
import { OutboxEmail } from "../src/adapters/email.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import type { Db } from "../src/lib/db.ts";

// Test data only.
async function makeProject(db: Db, organizationId: string, opts: { schedule?: "upfront" | "milestone_50_25_25"; total?: number; paid?: boolean } = {}) {
  const orderId = newId("ord");
  const total = opts.total ?? 249_900;
  await db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, created_at) VALUES (?,?, 'business', ?, 'paid', 'package', ?)`).bind(orderId, organizationId, total, nowIso()).run();
  const kind = opts.schedule === "milestone_50_25_25" ? "deposit_50" : "full";
  await db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, created_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(newId("inv"), organizationId, orderId, kind, kind === "full" ? total : total / 2, opts.paid === false ? "open" : "paid", nowIso()).run();
  const pid = await provisionProject(db, orderId);
  if (opts.schedule) await db.prepare(`UPDATE projects SET payment_schedule = ? WHERE id = ?`).bind(opts.schedule, pid).run();
  return pid;
}
const status = async (db: Db, id: string) => (await db.prepare(`SELECT status, paused_from_status FROM projects WHERE id = ?`).bind(id).first<{ status: string; paused_from_status: string | null }>())!;
const setStatus = (db: Db, id: string, s: string) => db.prepare(`UPDATE projects SET status = ? WHERE id = ?`).bind(s, id).run();

async function setup() {
  const app = await createTestApp();
  const cust = await createCustomer(app.db, "cust@acme.example", "Acme");
  const owner = await createStaff(app.db, "owner", "owner@crestmont.test");
  const pm = await createStaff(app.db, "project_manager", "pm@crestmont.test");
  const dev = await createStaff(app.db, "developer", "dev@crestmont.test");
  const dev2 = await createStaff(app.db, "developer", "dev2@crestmont.test");
  const login = (s: { email: string; secret: string }) => app.client().login(s.email, TEST_PASSWORD, s.secret);
  return { ...app, cust, owner, pm, dev, dev2, login, ownerC: await login(owner), pmC: await login(pm), devC: await login(dev), dev2C: await login(dev2) };
}

test("[AUTH-007] delivery routes enforce staff permissions server-side", async () => {
  const { db, cust, client, login } = await setup();
  const pid = await makeProject(db, cust.organizationId);
  const customer = await client().login(cust.email);
  assert.equal((await customer.get("/staff/projects")).status, 403);
  assert.equal((await customer.get(`/staff/projects/${pid}`)).status, 403);
  assert.equal((await customer.post(`/staff/projects/${pid}/status`, { to: "scope_review" })).status, 403);
  assert.equal((await customer.post("/staff/projects/sweep-inactivity")).status, 403);
  const sales = await login(await createStaff(db, "sales", "sales@crestmont.test"));
  assert.equal((await sales.get("/staff/projects")).status, 403, "sales has no delivery access");
  assert.equal((await sales.get("/staff")).status, 200, "every staff role has a My work dashboard");
  const anon = client();
  assert.equal((await anon.get("/staff/projects")).status, 303);
});

test("[PM-001] status transitions follow the state machine; design requires an approved scope", async () => {
  const { db, cust, pmC, devC } = await setup();
  const pid = await makeProject(db, cust.organizationId);
  assert.equal((await pmC.post(`/staff/projects/${pid}/status`, { to: "development" })).status, 409, "cannot skip stages");
  assert.equal((await devC.post(`/staff/projects/${pid}/status`, { to: "scope_review" })).status, 403, "developers cannot move projects");
  assert.equal((await pmC.post(`/staff/projects/${pid}/status`, { to: "scope_review" })).status, 303);
  const blocked = await pmC.post(`/staff/projects/${pid}/status`, { to: "design" });
  assert.equal(blocked.status, 409);
  assert.match(await blocked.text(), /scope version must be approved/);
  await db.prepare(`UPDATE project_scopes SET approved_at = ? WHERE project_id = ?`).bind(nowIso(), pid).run();
  assert.equal((await pmC.post(`/staff/projects/${pid}/status`, { to: "design" })).status, 303);
  assert.equal((await status(db, pid)).status, "design");
  assert.equal((await pmC.post(`/staff/projects/${pid}/status`, { to: "cancelled" })).status, 409, "cancellation is not a normal transition");
  assert.ok(await db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'project.status_changed' AND subject_id = ? AND details_json LIKE '%"to":"design"%'`).bind(pid).first());
  assert.equal((await lastEmail(db, cust.email))?.template, "project_update");
});

test("[PM-005] pause and resume restore the previous status; cancellation is Owner-only with a reason", async () => {
  const { db, cust, pmC, ownerC } = await setup();
  const pid = await makeProject(db, cust.organizationId);
  await setStatus(db, pid, "development");
  assert.equal((await pmC.post(`/staff/projects/${pid}/status`, { to: "paused", note: "Waiting on content" })).status, 303);
  assert.deepEqual({ ...(await status(db, pid)) }, { status: "paused", paused_from_status: "development" });
  assert.match((await lastEmail(db, cust.email))!.text_body, /paused: Waiting on content/);
  assert.equal((await pmC.post(`/staff/projects/${pid}/status`, { to: "paused" })).status, 409, "already paused");
  assert.equal((await pmC.post(`/staff/projects/${pid}/resume`)).status, 303);
  assert.deepEqual({ ...(await status(db, pid)) }, { status: "development", paused_from_status: null });
  assert.equal((await pmC.post(`/staff/projects/${pid}/resume`)).status, 409);
  assert.equal((await pmC.post(`/staff/projects/${pid}/cancel`, { reason: "Customer asked to stop the project" })).status, 403, "PM cannot cancel");
  assert.equal((await ownerC.post(`/staff/projects/${pid}/cancel`, { reason: "short" })).status, 422, "reason required");
  assert.equal((await ownerC.post(`/staff/projects/${pid}/cancel`, { reason: "Customer requested cancellation in writing" })).status, 303);
  const row = await db.prepare(`SELECT status, cancel_reason FROM projects WHERE id = ?`).bind(pid).first<{ status: string; cancel_reason: string }>();
  assert.deepEqual({ ...row }, { status: "cancelled", cancel_reason: "Customer requested cancellation in writing" });
  assert.ok(await db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'project.cancelled' AND subject_id = ?`).bind(pid).first());
});

test("[PM-004] tasks: CRUD, assignments, dependencies block completion, cycles are refused, time is tracked with unknown cost as NULL", async () => {
  const { db, cust, pm, dev, pmC, devC, dev2C } = await setup();
  const pid = await makeProject(db, cust.organizationId);
  await pmC.post(`/staff/projects/${pid}/pm`, { user_id: pm.id });
  assert.equal((await pmC.post(`/staff/projects/${pid}/tasks`, { title: "Build header", estimate_minutes: "120", due_at: "2026-11-05", assignee_id: dev.id })).status, 303);
  assert.equal((await pmC.post(`/staff/projects/${pid}/tasks`, { title: "Build footer", assignee_id: dev.id })).status, 303);
  assert.equal((await pmC.post(`/staff/projects/${pid}/tasks`, { title: "x" })).status, 422);
  const header = (await db.prepare(`SELECT id FROM tasks WHERE title = 'Build header'`).first<{ id: string }>())!.id;
  const footer = (await db.prepare(`SELECT id FROM tasks WHERE title = 'Build footer'`).first<{ id: string }>())!.id;
  assert.equal((await devC.post(`/staff/tasks/${footer}/dependencies`, { depends_on: header })).status, 403, "developers cannot edit dependencies");
  assert.equal((await pmC.post(`/staff/tasks/${footer}/dependencies`, { depends_on: header })).status, 303);
  const cycle = await pmC.post(`/staff/tasks/${header}/dependencies`, { depends_on: footer });
  assert.equal(cycle.status, 409);
  assert.match(await cycle.text(), /cycle/);
  assert.equal((await pmC.post(`/staff/tasks/${header}/dependencies`, { depends_on: header })).status, 409, "self-dependency refused");

  const early = await devC.post(`/staff/tasks/${footer}/status`, { status: "done" });
  assert.equal(early.status, 409);
  assert.match(await early.text(), /depends on unfinished work: Build header/);
  assert.equal((await devC.post(`/staff/tasks/${header}/status`, { status: "done" })).status, 303);
  assert.equal((await devC.post(`/staff/tasks/${footer}/status`, { status: "done" })).status, 303);

  // Developer 2 is not assigned: cannot update or log time, and cannot see the project.
  assert.equal((await dev2C.post(`/staff/tasks/${header}/status`, { status: "in_progress" })).status, 404);
  assert.equal((await dev2C.get(`/staff/projects/${pid}`)).status, 404);
  assert.equal((await dev2C.get(`/staff/tasks/${header}`)).status, 404);

  assert.equal((await devC.post(`/staff/tasks/${header}/time`, { minutes: "90", worked_on: "2026-10-26", hourly_cost: "50" })).status, 303);
  assert.equal((await pmC.post(`/staff/tasks/${header}/time`, { minutes: "30", worked_on: "2026-10-26", hourly_cost: "" })).status, 303);
  assert.equal((await pmC.post(`/staff/tasks/${header}/time`, { minutes: "0", worked_on: "2026-10-26" })).status, 422);
  const entries = (await db.prepare(`SELECT minutes, hourly_cost_cents FROM time_entries WHERE task_id = ? ORDER BY minutes`).bind(header).all<{ minutes: number; hourly_cost_cents: number | null }>()).results;
  assert.deepEqual(entries.map((e) => ({ ...e })), [{ minutes: 30, hourly_cost_cents: null }, { minutes: 90, hourly_cost_cents: null }], "developer-supplied rate ignored; unknown stays NULL");
  assert.equal((await pmC.post(`/staff/tasks/${header}/delete`)).status, 409, "tasks with logged time cannot be deleted");
  assert.match(await (await pmC.get(`/staff/projects/${pid}?tab=costs`)).text(), /2 entries with unknown rate/);
  assert.match(await (await pmC.get(`/staff/projects/${pid}?tab=plan`)).text(), /Build footer/);
});

test("[EMP-002] developer cannot update tasks not assigned to them even on a project they can see", async () => {
  const { db, cust, dev, pmC, devC } = await setup();
  const pid = await makeProject(db, cust.organizationId);
  await pmC.post(`/staff/projects/${pid}/tasks`, { title: "Mine", assignee_id: dev.id });
  await pmC.post(`/staff/projects/${pid}/tasks`, { title: "Not mine" });
  const notMine = (await db.prepare(`SELECT id FROM tasks WHERE title = 'Not mine'`).first<{ id: string }>())!.id;
  assert.equal((await devC.get(`/staff/projects/${pid}`)).status, 200, "assigned via a task: can see the project");
  const res = await devC.post(`/staff/tasks/${notMine}/status`, { status: "done" });
  assert.equal(res.status, 403);
  assert.equal((await devC.post(`/staff/tasks/${notMine}/time`, { minutes: "10", worked_on: "2026-10-26" })).status, 403);
  assert.equal((await db.prepare(`SELECT status FROM tasks WHERE id = ?`).bind(notMine).first<{ status: string }>())!.status, "todo");
  const list = await (await devC.get(`/staff/tasks`)).text();
  assert.match(list, /Mine/);
  assert.doesNotMatch(list, /Not mine/, "developers see only their assigned tasks");
});

test("[PM-004] milestones: create, update status/due date, delete; developers may only change status", async () => {
  const { db, cust, dev, pmC, devC } = await setup();
  const pid = await makeProject(db, cust.organizationId);
  await pmC.post(`/staff/projects/${pid}/assign`, { user_id: dev.id });
  assert.equal((await pmC.post(`/staff/projects/${pid}/milestones`, { name: "SEO pass", due_at: "2026-12-01" })).status, 303);
  const ms = (await db.prepare(`SELECT id FROM milestones WHERE name = 'SEO pass'`).first<{ id: string }>())!.id;
  assert.equal((await devC.post(`/staff/milestones/${ms}`, { status: "in_progress", due_at: "2027-01-01" })).status, 303);
  const row = await db.prepare(`SELECT status, due_at FROM milestones WHERE id = ?`).bind(ms).first<{ status: string; due_at: string }>();
  assert.deepEqual({ ...row }, { status: "in_progress", due_at: "2026-12-01" }, "developer changed status only");
  assert.equal((await pmC.post(`/staff/milestones/${ms}`, { status: "done", due_at: "2026-12-05" })).status, 303);
  assert.ok((await db.prepare(`SELECT completed_at FROM milestones WHERE id = ?`).bind(ms).first<{ completed_at: string }>())!.completed_at);
  assert.equal((await devC.post(`/staff/milestones/${ms}/delete`)).status, 403);
  assert.equal((await pmC.post(`/staff/milestones/${ms}/delete`)).status, 303);
  assert.equal(await db.prepare(`SELECT 1 FROM milestones WHERE id = ?`).bind(ms).first(), null);
});

test("[PM-006] release readiness blocks deployment until all internal and customer approvals and payments exist", async () => {
  const { db, cust, pmC, client } = await setup();
  const pid = await makeProject(db, cust.organizationId, { schedule: "milestone_50_25_25", total: 400_000 });
  const ca = await client().login(cust.email);
  await setStatus(db, pid, "customer_review");
  // Record the customer-review stage through the real transition path.
  await setStatus(db, pid, "internal_qa");
  assert.equal((await pmC.post(`/staff/projects/${pid}/status`, { to: "customer_review" })).status, 303);
  assert.equal((await pmC.post(`/staff/projects/${pid}/status`, { to: "final_approval" })).status, 303);

  const panel = await (await pmC.get(`/staff/projects/${pid}?tab=approvals`)).text();
  assert.match(panel, /1\. Engineering completion/);
  assert.match(panel, /7\. Deployment authorization/);
  assert.match(panel, /Blocked: 6 check\(s\) outstanding/);
  const tooEarly = await pmC.post(`/staff/projects/${pid}/deployments`, { url: "https://acme.example" });
  assert.equal(tooEarly.status, 409);
  assert.match(await tooEarly.text(), /engineering_complete/);
  assert.equal((await pmC.post(`/staff/projects/${pid}/approvals`, { kind: "deployment_authorized", decision: "approved" })).status, 409, "authorization comes last");
  for (const k of ["engineering_complete", "internal_qa", "security_accessibility"]) assert.equal((await pmC.post(`/staff/projects/${pid}/approvals`, { kind: k, decision: "approved", notes: "evidence" })).status, 303);

  // Milestone invoices: design invoice needs design approval; pre-launch needs final launch approval.
  assert.equal((await pmC.post(`/staff/projects/${pid}/invoices`, { kind: "design_25" })).status, 409);
  await pmC.post(`/staff/projects/${pid}/request-approval`, { kind: "design" });
  await ca.post(`/portal/projects/${pid}/approvals`, { kind: "design", decision: "approved" });
  assert.equal((await pmC.post(`/staff/projects/${pid}/invoices`, { kind: "design_25" })).status, 303);
  assert.equal((await pmC.post(`/staff/projects/${pid}/invoices`, { kind: "design_25" })).status, 409, "no duplicate milestone invoice");
  await pmC.post(`/staff/projects/${pid}/request-approval`, { kind: "customer_launch" });
  await ca.post(`/portal/projects/${pid}/approvals`, { kind: "customer_launch", decision: "approved" });
  assert.equal((await pmC.post(`/staff/projects/${pid}/invoices`, { kind: "prelaunch_25" })).status, 303);
  assert.equal((await lastEmail(db, cust.email))?.template, "invoice");

  // Approvals done but payments outstanding: still blocked.
  const unpaid = await pmC.post(`/staff/projects/${pid}/approvals`, { kind: "deployment_authorized", decision: "approved" });
  assert.equal(unpaid.status, 409);
  assert.match(await unpaid.text(), /payment:/);
  const invs = (await db.prepare(`SELECT id, amount_cents FROM invoices WHERE project_id = ? AND status = 'open'`).bind(pid).all<{ id: string; amount_cents: number }>()).results;
  for (const i of invs) await markInvoicePaid(db, i.id, { amountCents: i.amount_cents, paymentIntentId: `pi_test_${i.id}` });
  // Deposit (inserted 'paid' by fixture), design and pre-launch now paid.
  assert.equal((await pmC.post(`/staff/projects/${pid}/approvals`, { kind: "deployment_authorized", decision: "approved" })).status, 303);
  // An unpaid change order blocks again.
  const coInv = newId("inv");
  await db.prepare(`INSERT INTO invoices (id, organization_id, project_id, milestone_kind, amount_cents, status, created_at) VALUES (?,?,?, 'change_order', 1000, 'open', ?)`).bind(coInv, cust.organizationId, pid, nowIso()).run();
  assert.equal((await pmC.post(`/staff/projects/${pid}/deployments`, { url: "https://acme.example" })).status, 409);
  await markInvoicePaid(db, coInv, { amountCents: 1000, paymentIntentId: "pi_test_co" });

  assert.equal((await pmC.post(`/staff/projects/${pid}/deployments`, { url: "javascript:alert(1)" })).status, 422);
  assert.equal((await pmC.post(`/staff/projects/${pid}/deployments`, { url: "https://acme.example", commit_sha: "abc1234" })).status, 303);
  assert.equal((await status(db, pid)).status, "deployment");
  const dep = await db.prepare(`SELECT url, commit_sha FROM customer_deployments WHERE project_id = ?`).bind(pid).first<{ url: string; commit_sha: string }>();
  assert.deepEqual({ ...dep }, { url: "https://acme.example", commit_sha: "abc1234" });
  // Closure checklist: the handoff must be published before the project can be completed.
  const blocked = await pmC.post(`/staff/projects/${pid}/status`, { to: "completed" });
  assert.equal(blocked.status, 409);
  assert.match(await blocked.text(), /Handoff published to the customer/);
  assert.equal((await pmC.post(`/staff/projects/${pid}/handoff`, { intent: "publish", website_url: "https://acme.example", documentation: "Docs", access_instructions: "Via password manager", ownership_notes: "Domain in customer account", training_notes: "Video walkthrough" })).status, 303);
  assert.equal((await pmC.post(`/staff/projects/${pid}/status`, { to: "completed" })).status, 303);
  assert.ok((await db.prepare(`SELECT completed_at FROM projects WHERE id = ?`).bind(pid).first<{ completed_at: string }>())!.completed_at);
});

test("[PM-006] a later rejection of an internal check re-blocks readiness", async () => {
  const { db, cust, pmC } = await setup();
  const pid = await makeProject(db, cust.organizationId);
  await pmC.post(`/staff/projects/${pid}/approvals`, { kind: "internal_qa", decision: "approved" });
  await pmC.post(`/staff/projects/${pid}/approvals`, { kind: "internal_qa", decision: "rejected", notes: "Contact form broken on mobile" });
  const panel = await (await pmC.get(`/staff/projects/${pid}?tab=approvals`)).text();
  assert.match(panel, /2\. Internal QA<\/td><td><span class="badge badge--bad">Missing<\/span><\/td><td>Rejected/);
});

test("[PM-007] project costs: unknown amounts stay NULL and display as Unknown", async () => {
  const { db, cust, pmC, devC } = await setup();
  const pid = await makeProject(db, cust.organizationId);
  assert.equal((await pmC.post(`/staff/projects/${pid}/costs`, { category: "hosting", amount: "12.50", description: "Hosting October", incurred_on: "2026-10-01" })).status, 303);
  assert.equal((await pmC.post(`/staff/projects/${pid}/costs`, { category: "third_party_api", amount: "", description: "Maps API — bill not received", incurred_on: "2026-10-02" })).status, 303);
  assert.equal((await pmC.post(`/staff/projects/${pid}/costs`, { category: "bogus", amount: "1", description: "x", incurred_on: "2026-10-02" })).status, 422);
  assert.equal((await devC.post(`/staff/projects/${pid}/costs`, { category: "hosting", amount: "1", description: "dev", incurred_on: "2026-10-02" })).status, 403, "developers cannot record project costs");
  const rows = (await db.prepare(`SELECT amount_cents FROM project_costs WHERE project_id = ? ORDER BY incurred_on`).bind(pid).all<{ amount_cents: number | null }>()).results;
  assert.deepEqual(rows.map((r) => r.amount_cents), [1250, null]);
  const page = await (await pmC.get(`/staff/projects/${pid}?tab=costs`)).text();
  assert.match(page, /Unknown/);
  assert.match(page, /1 cost\(s\) unknown/);
});

test("[PM-005] inactivity sweep reminds, escalates to the PM, then pauses — idempotently and never cancels", async () => {
  const { db, cust, pm, pmC } = await setup();
  const pid = await makeProject(db, cust.organizationId);
  await db.prepare(`UPDATE projects SET project_manager_id = ?, last_customer_activity_at = '2026-10-01T00:00:00.000Z' WHERE id = ?`).bind(pm.id, pid).run();
  const at = (iso: string) => ({ db, email: new OutboxEmail(db), baseUrl: "http://crestmont.test", now: () => new Date(iso) });
  const count = async (kind: string) => (await db.prepare(`SELECT COUNT(*) n FROM inactivity_notices WHERE project_id = ? AND kind = ?`).bind(pid, kind).first<{ n: number }>())!.n;

  assert.deepEqual(await runInactivitySweep(at("2026-10-05T00:00:00Z")), [], "4 days: nothing");
  assert.deepEqual((await runInactivitySweep(at("2026-10-09T00:00:00Z"))).map((r) => r.action), ["remind"]);
  assert.deepEqual(await runInactivitySweep(at("2026-10-09T06:00:00Z")), [], "same day: idempotent");
  assert.equal((await lastEmail(db, cust.email))?.template, "project_update");
  assert.match((await lastEmail(db, cust.email))!.text_body, /never cancelled automatically/);
  assert.deepEqual((await runInactivitySweep(at("2026-10-16T00:00:00Z"))).map((r) => r.reminder), [2]);
  assert.deepEqual((await runInactivitySweep(at("2026-10-23T00:00:00Z"))).map((r) => r.action), ["escalate"]);
  assert.ok(await db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'inactivity_escalation'`).bind(pm.id).first());
  assert.equal((await status(db, pid)).status, "awaiting_onboarding", "escalation does not pause");
  assert.deepEqual((await runInactivitySweep(at("2026-11-01T00:00:00Z"))).map((r) => r.action), ["pause"]);
  assert.deepEqual({ ...(await status(db, pid)) }, { status: "paused", paused_from_status: "awaiting_onboarding" });
  for (let i = 0; i < 3; i++) assert.deepEqual(await runInactivitySweep(at("2026-12-31T00:00:00Z")), []);
  assert.equal((await status(db, pid)).status, "paused", "never cancelled");
  assert.deepEqual([await count("remind"), await count("escalate"), await count("pause")], [2, 1, 1]);
  const actions = (await db.prepare(`SELECT action FROM audit_logs WHERE subject_id = ? AND actor_kind = 'system' ORDER BY id`).bind(pid).all<{ action: string }>()).results.map((r) => r.action);
  assert.deepEqual(actions.filter((a) => a !== "project.provisioned"), ["project.inactivity_reminder", "project.inactivity_reminder", "project.inactivity_escalated", "project.paused"]);
  assert.equal(await db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'project.cancelled'`).first(), null);

  // Restart procedure: resume starts a fresh inactivity cycle.
  assert.equal((await pmC.post(`/staff/projects/${pid}/resume`)).status, 303);
  assert.equal((await status(db, pid)).status, "awaiting_onboarding");
  assert.deepEqual(await runInactivitySweep({ db, email: new OutboxEmail(db), baseUrl: "http://crestmont.test", now: () => new Date(Date.now() + 2 * 86400e3) }), []);
  // On-demand route.
  const res = await pmC.post("/staff/projects/sweep-inactivity");
  assert.equal(res.status, 303);
});

test("[EMP-003] My work dashboard shows assigned tasks (overdue), leads, tickets, notifications and activity", async () => {
  const { db, cust, dev, pmC, devC, login } = await setup();
  const pid = await makeProject(db, cust.organizationId);
  await pmC.post(`/staff/projects/${pid}/tasks`, { title: "Overdue thing", due_at: "2020-01-01", assignee_id: dev.id });
  const dash = await (await devC.get("/staff")).text();
  assert.match(dash, /Overdue thing/);
  assert.match(dash, /1 overdue/);
  assert.match(dash, /You were assigned a task/);
  assert.match(dash, /Tasks completed \(30 days\)/);
  // Sales: assigned leads; Support: assigned tickets.
  const sales = await createStaff(db, "sales", "sales@crestmont.test");
  const contact = newId("ct"), lead = newId("lead");
  await db.prepare(`INSERT INTO contacts (id, name, email, created_at) VALUES (?, 'Lead Person', 'lead@x.example', ?)`).bind(contact, nowIso()).run();
  await db.prepare(`INSERT INTO leads (id, contact_id, source, stage, owner_user_id, interest, created_at, updated_at) VALUES (?,?, 'web_form', 'qualified', ?, 'Business package', ?, ?)`).bind(lead, contact, sales.id, nowIso(), nowIso()).run();
  assert.match(await (await (await login(sales)).get("/staff")).text(), /Lead Person/);
  const sup = await createStaff(db, "support", "support@crestmont.test");
  const tk = newId("tkt");
  await db.prepare(`INSERT INTO tickets (id, organization_id, subject, category, priority, status, opened_by, created_at, updated_at) VALUES (?,?, 'Site is down', 'technical', 'urgent', 'open', ?, ?, ?)`).bind(tk, cust.organizationId, cust.id, nowIso(), nowIso()).run();
  await db.prepare(`INSERT INTO assignments (id, subject_type, subject_id, user_id, created_at) VALUES (?, 'ticket', ?, ?, ?)`).bind(newId("asg"), tk, sup.id, nowIso()).run();
  const supDash = await (await (await login(sup)).get("/staff")).text();
  assert.match(supDash, /Site is down/);
  assert.match(supDash, /My open tickets/);
  const pmDash = await (await pmC.get("/staff")).text();
  assert.match(pmDash, /task created/, "activity history");
  assert.match(pmDash, /Without a PM/);
});

test("[PM-001] project list filters, search and kanban board", async () => {
  const { db, cust, pm, pmC } = await setup();
  const other = await createCustomer(db, "o@other.example", "Other Co");
  const p1 = await makeProject(db, cust.organizationId);
  const p2 = await makeProject(db, other.organizationId);
  await setStatus(db, p2, "development");
  await pmC.post(`/staff/projects/${p1}/pm`, { user_id: pm.id });
  const all = await (await pmC.get("/staff/projects")).text();
  assert.match(all, /Acme — Business website/);
  assert.match(all, /Other Co — Business website/);
  const filtered = await (await pmC.get("/staff/projects?status=development")).text();
  assert.doesNotMatch(filtered, /Acme — Business website/);
  assert.match(filtered, /Other Co/);
  assert.doesNotMatch(await (await pmC.get(`/staff/projects?pm=${pm.id}`)).text(), /Other Co — Business website/);
  assert.doesNotMatch(await (await pmC.get(`/staff/projects?q=Acme`)).text(), /Other Co — Business website/);
  assert.doesNotMatch(await (await pmC.get(`/staff/projects?customer=${cust.organizationId}`)).text(), /Other Co — Business website/);
  const board = await (await pmC.get("/staff/projects?view=kanban")).text();
  assert.match(board, /class="kanban"/);
  assert.match(board, /Development · 1/);
  assert.match(board, /Awaiting Onboarding · 1/);
});

test("[PORTAL-005] staff internal notes and replies; staff without project visibility cannot post", async () => {
  const { db, cust, pmC, dev2C } = await setup();
  const pid = await makeProject(db, cust.organizationId);
  assert.equal((await dev2C.post(`/staff/projects/${pid}/messages`, { body: "hello" })).status, 404);
  assert.equal((await pmC.post(`/staff/projects/${pid}/messages`, { body: "" })).status, 422);
  assert.equal((await pmC.post(`/staff/projects/${pid}/messages`, { body: "Kickoff notes", internal: "1" })).status, 303);
  assert.equal((await db.prepare(`SELECT internal FROM messages WHERE project_id = ?`).bind(pid).first<{ internal: number }>())!.internal, 1);
  assert.equal(await lastEmail(db, cust.email).then((m) => m?.template === "project_update" && /Kickoff/.test(m.text_body)), false, "internal notes never email the customer");
});
