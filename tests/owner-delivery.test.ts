// Owner command-center delivery modules (projects, tasks, employees, notifications) exercised through
// the real request pipeline. All records created here are TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import type { Env } from "../src/app/context.ts";

type App = Awaited<ReturnType<typeof createTestApp>>;

async function staffClient(t: App, role: Parameters<typeof createStaff>[1], email?: string) {
  const s = await createStaff(t.db, role, email);
  const c = await t.client().login(s.email, TEST_PASSWORD, s.secret);
  return { ...s, c };
}
async function apiLead(c: TestClient, over: Record<string, string> = {}) {
  const res = await c.request("POST", "/api/leads", { body: JSON.stringify({ name: "Morgan Reyes", email: "morgan@harborcoffee.example", company: "Harbor Coffee", interest: "custom", message: "We need online ordering.", source: "quote_form", ...over }), headers: { "content-type": "application/json" } });
  assert.equal(res.status, 201);
  return ((await res.json()) as { leadId: string }).leadId;
}
const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;

async function project(db: Env["DB"], orgId: string, name: string, status = "development") {
  const id = newId("prj");
  await db.prepare(`INSERT INTO projects (id, organization_id, product_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES (?,?, 'business', ?,?, 3, 'upfront', ?, ?)`).bind(id, orgId, name, status, nowIso(), nowIso()).run();
  return id;
}
async function task(db: Env["DB"], projectId: string, title: string, over: { status?: string; due?: string | null; estimate?: number | null; assignee?: string } = {}) {
  const id = newId("tsk");
  await db.prepare(`INSERT INTO tasks (id, project_id, title, status, estimate_minutes, due_at, created_at) VALUES (?,?,?,?,?,?,?)`).bind(id, projectId, title, over.status ?? "todo", over.estimate ?? null, over.due ?? null, nowIso()).run();
  if (over.assignee) await db.prepare(`INSERT INTO assignments (id, subject_type, subject_id, user_id, created_at) VALUES (?, 'task', ?, ?, ?)`).bind(newId("asg"), id, over.assignee, nowIso()).run();
  return id;
}

test("[PM-004] task list: search, unassigned and dependency filters, pagination and an audited CSV export", async () => {
  const t = await createTestApp();
  const cust = await createCustomer(t.db, "tasks@cust.example", "Task Co");
  const pid = await project(t.db, cust.organizationId, "Task Co website");
  const pm = await staffClient(t, "project_manager", "pm@crestmont.test");
  const dev = await staffClient(t, "developer", "dev@crestmont.test");
  const design = await task(t.db, pid, "Design homepage", { assignee: dev.id, due: "2020-01-01", estimate: 120 });
  const build = await task(t.db, pid, "Build checkout", { assignee: dev.id });
  await task(t.db, pid, "Write privacy copy");
  await t.db.prepare(`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`).bind(build, design).run();
  for (let i = 0; i < 26; i++) await task(t.db, pid, `Bulk item ${String(i).padStart(2, "0")}`, { due: "2099-01-01" });

  const search = await (await pm.c.get("/staff/tasks?q=homepage")).text();
  assert.match(search, /Design homepage/);
  assert.doesNotMatch(search, /Write privacy copy/);
  assert.match(await (await pm.c.get("/staff/tasks?assignee=unassigned&q=privacy")).text(), /Write privacy copy/);
  assert.doesNotMatch(await (await pm.c.get("/staff/tasks?assignee=unassigned")).text(), /Design homepage/);
  const blocked = await (await pm.c.get("/staff/tasks?blocked=1")).text();
  assert.match(blocked, /Build checkout/);
  assert.match(blocked, /Waiting on 1 task/);
  assert.doesNotMatch(blocked, /Design homepage/);
  const first = await (await pm.c.get("/staff/tasks")).text();
  assert.match(first, /Page 1/);
  assert.match(first, /href="\/staff\/tasks\?page=2"/);
  assert.match(await (await pm.c.get("/staff/tasks?page=2")).text(), /Bulk item/);

  const csvRes = await pm.c.get("/staff/tasks/export.csv?status=all");
  assert.equal(csvRes.status, 200);
  const csv = await csvRes.text();
  assert.match(csv, /^task_id,title,project_id/);
  assert.match(csv, /Design homepage,[^\n]*,2020-01-01,yes,120,0,0,/);
  assert.match(csv, /Build checkout,[^\n]*,no,,0,1,/);
  assert.equal(csv.trim().split("\n").length, 1 + 29);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'task.exported'`)).n, 1);
  // Developers see and export only their own assigned tasks.
  const devCsv = await (await dev.c.get("/staff/tasks/export.csv?status=all")).text();
  assert.equal(devCsv.trim().split("\n").length, 1 + 2);
});

test("[PM-001] project list is paginated, filterable and exports CSV with overdue task counts", async () => {
  const t = await createTestApp();
  const cust = await createCustomer(t.db, "plist@cust.example", "PList Co");
  const ids: string[] = [];
  for (let i = 0; i < 27; i++) ids.push(await project(t.db, cust.organizationId, `Site ${String(i).padStart(2, "0")}`, i === 0 ? "design" : "development"));
  await task(t.db, ids[0], "Late task", { due: "2020-01-01" });
  const owner = await staffClient(t, "owner");
  const p1 = await (await owner.c.get("/staff/projects")).text();
  assert.match(p1, /Page 1/);
  assert.match(p1, /page=2/);
  assert.match(await (await owner.c.get("/staff/projects?status=design")).text(), /1 overdue/);
  const csv = await (await owner.c.get("/staff/projects/export.csv?status=design")).text();
  assert.match(csv, /^project_id,name,customer/);
  assert.equal(csv.trim().split("\n").length, 2);
  assert.match(csv, /Site 00,PList Co,business,design,,0,1,1,/);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'project.exported'`)).n, 1);
  const sales = await staffClient(t, "sales");
  assert.equal((await sales.c.get("/staff/projects/export.csv")).status, 403);
});

test("[PM-007] project closure checklist blocks completion until tasks, invoices, change orders, revisions and the handoff are settled; maintenance needs a plan", async () => {
  const t = await createTestApp();
  const cust = await createCustomer(t.db, "close@cust.example", "Close Co");
  const pid = await project(t.db, cust.organizationId, "Close Co site", "deployment");
  const pm = await staffClient(t, "project_manager", "pm2@crestmont.test");
  await t.db.prepare(`INSERT INTO customer_deployments (id, project_id, url, deployed_by, deployed_at) VALUES (?,?,?,?,?)`).bind(newId("dep"), pid, "https://close.example", pm.id, nowIso()).run();
  const open = await task(t.db, pid, "QA pass");
  await t.db.prepare(`INSERT INTO invoices (id, organization_id, project_id, milestone_kind, amount_cents, status, created_at) VALUES (?,?,?, 'change_order', 5000, 'open', ?)`).bind(newId("inv"), cust.organizationId, pid, nowIso()).run();

  const panel = await (await pm.c.get(`/staff/projects/${pid}?tab=approvals`)).text();
  assert.match(panel, /Project closure &amp; handoff/);
  assert.match(panel, /1 open task\(s\)/);
  assert.match(panel, /1 unpaid invoice\(s\)/);
  assert.match(panel, /handoff not published/);
  const res = await pm.c.post(`/staff/projects/${pid}/status`, { to: "completed" });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /Project closure is incomplete/);

  await t.db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).bind(open).run();
  await t.db.prepare(`UPDATE invoices SET status = 'paid' WHERE project_id = ?`).bind(pid).run();
  assert.equal((await pm.c.post(`/staff/projects/${pid}/handoff`, { intent: "publish", website_url: "https://close.example", documentation: "Docs", access_instructions: "Shared vault", ownership_notes: "Registrar in customer name", training_notes: "Recorded session" })).status, 303);
  const done = await pm.c.post(`/staff/projects/${pid}/status`, { to: "completed", note: "Delivered and handed over." });
  assert.equal(done.status, 303);
  const row = await one<{ status: string; completed_at: string; closed_by: string; closure_notes: string }>(t.db, `SELECT status, completed_at, closed_by, closure_notes FROM projects WHERE id = ?`, pid);
  assert.equal(row.status, "completed");
  assert.ok(row.completed_at);
  assert.equal(row.closed_by, pm.id);
  assert.equal(row.closure_notes, "Delivered and handed over.");
  assert.match(await (await pm.c.get(`/staff/projects/${pid}?tab=approvals`)).text(), /not yet recorded by the customer/);

  assert.equal((await pm.c.post(`/staff/projects/${pid}/status`, { to: "maintenance" })).status, 409);
  await t.db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, status, created_at, updated_at) VALUES (?,?, 'essential', 'active', ?, ?)`).bind(newId("sub"), cust.organizationId, nowIso(), nowIso()).run();
  assert.equal((await pm.c.post(`/staff/projects/${pid}/status`, { to: "maintenance" })).status, 303);
});

test("[EMP-003] employee workload: per-person open, overdue and estimated work, capacity utilisation, detail page, validated profile and CSV export", async () => {
  const t = await createTestApp();
  const cust = await createCustomer(t.db, "emp@cust.example", "Emp Co");
  const pid = await project(t.db, cust.organizationId, "Emp Co site");
  const admin = await staffClient(t, "administrator", "admin@crestmont.test");
  const dev = await createStaff(t.db, "developer", "dev.w@crestmont.test", "Devon Worker");
  const tk = await task(t.db, pid, "Overdue build", { assignee: dev.id, due: "2020-01-01", estimate: 180 });
  await task(t.db, pid, "Unestimated", { assignee: dev.id });
  await task(t.db, pid, "Finished", { assignee: dev.id, status: "done", estimate: 600 });
  await t.db.prepare(`INSERT INTO time_entries (id, task_id, user_id, minutes, worked_on) VALUES (?,?,?,?,?)`).bind(newId("te"), tk, dev.id, 300, new Date().toISOString().slice(0, 10)).run();

  const list = await (await admin.c.get("/staff/employees?role=developer")).text();
  assert.match(list, /Devon Worker/);
  assert.match(list, /2 tasks/);
  assert.match(list, /1 overdue/);
  assert.match(list, /3\.0 h/);
  assert.match(list, /\+1 unestimated/);
  assert.match(list, /Unknown \(capacity not set\)/);
  assert.doesNotMatch(await (await admin.c.get("/staff/employees?role=support")).text(), /Devon Worker/);

  const detail = await (await admin.c.get(`/staff/employees/${dev.id}`)).text();
  assert.match(detail, /Overdue build/);
  assert.doesNotMatch(detail, /Finished/);
  assert.equal((await admin.c.post(`/staff/employees/${dev.id}/profile`, { job_title: "Engineer", weekly_capacity_hours: "500" })).status, 422);
  assert.equal((await admin.c.post(`/staff/employees/${dev.id}/profile`, { job_title: "Engineer", weekly_capacity_hours: "10" })).status, 303);
  assert.match(await (await admin.c.get(`/staff/employees/${dev.id}`)).text(), /Utilisation: 50%/);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'employee.profile_updated' AND subject_id = ?`, dev.id)).n, 1);

  const csv = await (await admin.c.get("/staff/employees/export.csv?role=developer")).text();
  assert.match(csv, /^user_id,name,email,role/);
  assert.match(csv, /Devon Worker,dev\.w@crestmont\.test,developer,Engineer,active,yes,,2,1,0,0,3\.00,1,1,0,0,5\.00,5\.00,10\.00,0\.500/);
  assert.equal((await admin.c.get(`/staff/employees/${newId("usr")}`)).status, 404);
  const devC = await t.client().login(dev.email, TEST_PASSWORD, dev.secret);
  assert.equal((await devC.get(`/staff/employees/${dev.id}`)).status, 403);
  assert.equal((await devC.get("/staff/employees/export.csv")).status, 403);
});

test("[EMP-003] My work links leads to their records; notification pages page, filter, link and mark read without crossing users", async () => {
  const t = await createTestApp();
  // The lead is captured before the sales user exists, so CREST-GAP-005's "new lead" notice does not apply to them here.
  const leadId = await apiLead(t.client(), { name: "Linked Lead", email: "ll@x.example" });
  const sales = await staffClient(t, "sales", "s1@crestmont.test");
  await t.db.prepare(`UPDATE leads SET owner_user_id = ? WHERE id = ?`).bind(sales.id, leadId).run();
  await t.db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) VALUES (?,?,?,?,?,?,?)`).bind("ntf_one", sales.id, "lead_assigned", "lead", leadId, "A lead was assigned to you.", nowIso()).run();
  const other = await createStaff(t.db, "sales", "s2@crestmont.test");
  await t.db.prepare(`INSERT INTO notifications (id, user_id, kind, body, created_at) VALUES (?,?,?,?,?)`).bind("ntf_other", other.id, "x", "Someone else's notice", nowIso()).run();

  const home = await (await sales.c.get("/staff")).text();
  assert.match(home, new RegExp(`href="/staff/crm/leads/${leadId}">Linked Lead`));
  assert.match(home, new RegExp(`<a href="/staff/crm/leads/${leadId}">A lead was assigned to you\\.</a>`));
  const page = await (await sales.c.get("/staff/notifications?unread=1")).text();
  assert.match(page, /A lead was assigned to you/);
  assert.doesNotMatch(page, /Someone else/);
  assert.equal((await sales.c.post("/staff/notifications/ntf_other/read")).status, 404);
  assert.equal((await sales.c.post("/staff/notifications/ntf_one/read")).status, 303);
  assert.match(await (await sales.c.get("/staff/notifications?unread=1")).text(), /No unread notifications/);
  assert.equal((await one<{ read_at: string | null }>(t.db, `SELECT read_at FROM notifications WHERE id = 'ntf_other'`)).read_at, null);

  const cust = await createCustomer(t.db, "notify@cust.example", "Notify Co");
  const pid = await project(t.db, cust.organizationId, "Notify site");
  await t.db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) VALUES (?,?,?,?,?,?,?)`).bind("ntf_c", cust.id, "project_status", "project", pid, "Your project moved to a new stage", nowIso()).run();
  const cc = await t.client().login(cust.email);
  const portal = await (await cc.get("/portal/notifications")).text();
  assert.match(portal, new RegExp(`href="/portal/projects/${pid}">Your project moved`));
  assert.equal((await cc.post("/portal/notifications/ntf_one/read")).status, 404);
  const all = await cc.post("/portal/notifications/read", { back: "/portal/notifications" });
  assert.equal(all.headers.get("location"), "/portal/notifications");
  assert.ok((await one<{ read_at: string | null }>(t.db, `SELECT read_at FROM notifications WHERE id = 'ntf_c'`)).read_at);
  assert.equal((await cc.get("/staff/notifications")).status, 403);
});
