// Closeout fixes for the Owner, staff and customer modules (CREST-GAP-040..044, 070..074, 079, 081).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, lastEmail, linkFrom, TEST_PASSWORD } from "./support/app.ts";
import { provisionProject } from "../src/services/commerce.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import type { Db } from "../src/lib/db.ts";
import type { SqliteDb } from "../dev/sqlite-d1.ts";
import { unreadCountForCustomer, THREAD_PAGE_SIZE } from "../src/services/messages.ts";
import { portalNav } from "../src/routes/nav.ts";

const one = async <T>(db: Db, sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;
const auditCount = async (db: Db, action: string, subjectId?: string) =>
  (await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = ? ${subjectId ? "AND subject_id = ?" : ""}`, action, ...(subjectId ? [subjectId] : []))).n;
const staffLogin = async (app: Awaited<ReturnType<typeof createTestApp>>, role: Parameters<typeof createStaff>[1], email?: string) => {
  const s = await createStaff(app.db, role, email ?? `${role}-${Math.random().toString(16).slice(2, 8)}@crestmont.test`);
  return { ...s, c: await app.client().login(s.email, undefined, s.secret) };
};
/** Test data: a lead with a contact (and optional company/owner). */
async function seedLead(db: Db, o: { name: string; email?: string | null; phone?: string | null; company?: string | null; owner?: string | null; at?: string }) {
  const at = o.at ?? nowIso(), cid = newId("con"), lid = newId("lead");
  let co: string | null = null;
  if (o.company) { co = newId("co"); await db.prepare(`INSERT INTO companies (id, name, created_at) VALUES (?,?,?)`).bind(co, o.company, at).run(); }
  await db.prepare(`INSERT INTO contacts (id, company_id, name, email, phone, created_at) VALUES (?,?,?,?,?,?)`).bind(cid, co, o.name, o.email ?? null, o.phone ?? null, at).run();
  await db.prepare(`INSERT INTO leads (id, contact_id, source, stage, owner_user_id, created_at, updated_at) VALUES (?,?, 'manual', 'new', ?, ?, ?)`).bind(lid, cid, o.owner ?? null, at, at).run();
  return { leadId: lid, contactId: cid };
}

// Test data only: a paid package order provisioned through the real service.
async function makeProject(db: Db, organizationId: string) {
  const orderId = newId("ord");
  await db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, created_at) VALUES (?,?, 'business', 249900, 'paid', 'package', ?)`).bind(orderId, organizationId, nowIso()).run();
  await db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, created_at, paid_at) VALUES (?,?,?, 'full', 249900, 'paid', ?, ?)`).bind(newId("inv"), organizationId, orderId, nowIso(), nowIso()).run();
  return provisionProject(db, orderId);
}

async function seedMessages(db: Db, orgId: string, projectId: string | null, authorId: string, count: number) {
  const base = Date.parse("2026-01-01T00:00:00Z");
  const stmts = [];
  for (let i = 1; i <= count; i++) {
    stmts.push(db.prepare(`INSERT INTO messages (id, organization_id, project_id, author_user_id, body, internal, created_at) VALUES (?,?,?,?,?,0,?)`)
      .bind(`msg_seed_${String(i).padStart(4, "0")}`, orgId, projectId, authorId, `Seed message number ${i} end`, new Date(base + i * 1000).toISOString()));
  }
  await db.batch(stmts);
}

// ───────────── CREST-GAP-040 ─────────────
test("[PORTAL-005] CREST-GAP-040 long threads show the newest messages with an earlier-messages link; only displayed messages are marked read", async () => {
  const { db, client } = await createTestApp();
  const cust = await createCustomer(db, "thread@a.example", "Thread Co");
  const pm = await createStaff(db, "project_manager");
  const pid = await makeProject(db, cust.organizationId);
  await seedMessages(db, cust.organizationId, pid, pm.id, 520);
  const c = await client().login(cust.email);
  assert.equal(await unreadCountForCustomer(db, cust.id, cust.organizationId), 520);
  const page = await (await c.get(`/portal/projects/${pid}/messages`)).text();
  assert.match(page, /Seed message number 520 end/, "the newest message is visible");
  assert.doesNotMatch(page, /Seed message number 1 end/, "the oldest message is behind the earlier link");
  assert.match(page, new RegExp(`Show earlier messages \\(${520 - THREAD_PAGE_SIZE} more\\)`));
  // Only what was displayed is marked read.
  assert.equal(await unreadCountForCustomer(db, cust.id, cust.organizationId), 520 - THREAD_PAGE_SIZE);
  const href = /href="([^"]+)" data-earlier-messages/.exec(page)![1].replace(/&amp;/g, "&");
  const older = await (await c.get(href)).text();
  assert.match(older, new RegExp(`Seed message number ${520 - THREAD_PAGE_SIZE} end`));
  assert.doesNotMatch(older, /Seed message number 520 end/);
  assert.match(older, /Back to latest messages/);
  assert.equal(await unreadCountForCustomer(db, cust.id, cust.organizationId), 520 - 2 * THREAD_PAGE_SIZE);
  // A cursor from another organization's thread is ignored (falls back to the latest page; no leak).
  const other = await createCustomer(db, "other@b.example", "Other Co");
  await seedMessages(db, other.organizationId, null, pm.id, 0);
  await db.prepare(`INSERT INTO messages (id, organization_id, project_id, author_user_id, body, internal, created_at) VALUES ('msg_foreign', ?, NULL, ?, 'Foreign secret', 0, ?)`).bind(other.organizationId, pm.id, nowIso()).run();
  const foreign = await (await c.get(`/portal/projects/${pid}/messages?before=msg_foreign`)).text();
  assert.match(foreign, /Seed message number 520 end/);
  assert.doesNotMatch(foreign, /Foreign secret/);
  // Staff side: project tab and general conversation paginate too.
  const p = await client().login(pm.email, undefined, pm.secret);
  const staffPage = await (await p.get(`/staff/projects/${pid}?tab=messages`)).text();
  assert.match(staffPage, /Seed message number 520 end/);
  assert.match(staffPage, /data-earlier-messages/);
  assert.match(staffPage, /tab=messages&amp;before=|before=[^"]*tab=messages/);
});

// ───────────── CREST-GAP-042 ─────────────
test("[OWN-002] CREST-GAP-042 a failing metric query shows Unknown — query failed and records an app error instead of 0", async () => {
  const { db, client } = await createTestApp();
  const owner = await createStaff(db, "owner");
  const o = await client().login(owner.email, undefined, owner.secret);
  // Break exactly one source table so its queries fail.
  await db.prepare(`ALTER TABLE refunds RENAME TO refunds_broken`).run();
  const before = (await db.prepare(`SELECT COUNT(*) n FROM app_errors`).first<{ n: number }>())!.n;
  const page = await (await o.get("/staff/owner")).text();
  const tile = (label: string) => new RegExp(`data-metric="${label}"[^>]*>[\\s\\S]*?kpi__value">([^<]+)<`).exec(page)?.[1];
  assert.equal(tile("Pending approvals"), "Unknown — query failed");
  assert.doesNotMatch(page, /Nothing is waiting for an approval/);
  assert.match(page, /Some figures could not be computed/);
  assert.equal(tile("Active projects"), "0", "unaffected tiles keep real zeros");
  const errs = (await db.prepare(`SELECT path, message FROM app_errors`).all<{ path: string; message: string }>()).results;
  assert.ok(errs.length > before);
  assert.ok(errs.some((e) => e.path === "/staff/owner" && /metric query failed/.test(e.message)));
  await db.prepare(`ALTER TABLE refunds_broken RENAME TO refunds`).run();
});

// ───────────── CREST-GAP-044 ─────────────
test("[EMP-003] CREST-GAP-044 an unassigned developer sees no live task link and gets an explanation, not a bare 404; unknown ids still 404", async () => {
  const { db, client } = await createTestApp();
  const cust = await createCustomer(db, "tasks@a.example", "Task Co");
  const pm = await createStaff(db, "project_manager");
  const dev = await createStaff(db, "developer");
  const stranger = await createStaff(db, "developer", "stranger@crestmont.test");
  const pid = await makeProject(db, cust.organizationId);
  const pmC = await client().login(pm.email, undefined, pm.secret);
  const devC = await client().login(dev.email, undefined, dev.secret);
  const strangerC = await client().login(stranger.email, undefined, stranger.secret);
  assert.equal((await pmC.post(`/staff/projects/${pid}/tasks`, { title: "Build the gallery", assignee_id: dev.id })).status, 303);
  const task = (await db.prepare(`SELECT id FROM tasks WHERE title = 'Build the gallery'`).first<{ id: string }>())!.id;
  // While assigned: the notification links to the task and the task opens.
  assert.match(await (await devC.get("/staff/notifications")).text(), new RegExp(`href="/staff/tasks/${task}"`));
  assert.equal((await devC.get(`/staff/tasks/${task}`)).status, 200);
  // Unassign.
  const asg = (await db.prepare(`SELECT id FROM assignments WHERE subject_id = ? AND user_id = ? AND ended_at IS NULL`).bind(task, dev.id).first<{ id: string }>())!.id;
  assert.equal((await pmC.post(`/staff/assignments/${asg}/end`)).status, 303);
  for (const p of ["/staff/notifications", "/staff"]) {
    const page = await (await devC.get(p)).text();
    assert.match(page, /You were assigned a task/, `${p} still lists the notification`);
    assert.doesNotMatch(page, new RegExp(`href="/staff/tasks/${task}"`), `${p} renders no dead task link`);
  }
  const res = await devC.get(`/staff/tasks/${task}`);
  assert.equal(res.status, 403);
  const body = await res.text();
  assert.match(body, /You no longer have access to this task/);
  assert.doesNotMatch(body, /Build the gallery|Task Co/, "nothing about the task or project is revealed");
  // Unknown ids and tasks the person was never linked to stay 404.
  assert.equal((await devC.get(`/staff/tasks/tsk_doesnotexist`)).status, 404);
  assert.equal((await strangerC.get(`/staff/tasks/${task}`)).status, 404);
  // The PM (project.read_all) keeps the live link and the page.
  assert.equal((await pmC.get(`/staff/tasks/${task}`)).status, 200);
});

// ───────────── CREST-GAP-041 ─────────────
test("[EMP-002] CREST-GAP-041 disabling staff queues their assignments, PM roles, leads and tickets for reassignment; reassign/end is audited and permission-checked", async () => {
  const app = await createTestApp();
  const { db } = app;
  const owner = await staffLogin(app, "owner", "owner-off@crestmont.test");
  const admin = await staffLogin(app, "administrator", "admin-off@crestmont.test");
  const pmA = await staffLogin(app, "project_manager", "pm-a@crestmont.test");
  const pmB = await createStaff(db, "project_manager", "pm-b@crestmont.test", "Bea Manager");
  const devA = await createStaff(db, "developer", "dev-a@crestmont.test", "Dana Developer");
  const devB = await createStaff(db, "developer", "dev-b@crestmont.test", "Bo Developer");
  const sales = await createStaff(db, "sales", "rep-off@crestmont.test", "Sam Seller");
  const sup = await createStaff(db, "support", "sup-off@crestmont.test", "Sue Support");
  const cust = await createCustomer(db, "offb@a.example", "Offboard Co");
  const pid = await makeProject(db, cust.organizationId);
  // Work owned by Dana (developer): a task and a project assignment. Bea manages the project.
  assert.equal((await owner.c.post(`/staff/projects/${pid}/pm`, { user_id: pmB.id })).status, 303);
  assert.equal((await owner.c.post(`/staff/projects/${pid}/assign`, { user_id: devA.id })).status, 303);
  assert.equal((await owner.c.post(`/staff/projects/${pid}/tasks`, { title: "Build contact form", assignee_id: devA.id })).status, 303);
  const task = (await one<{ id: string }>(db, `SELECT id FROM tasks WHERE title = 'Build contact form'`)).id;
  const { leadId } = await seedLead(db, { name: "Lead For Sam", email: "lead-sam@example.com", owner: sales.id });
  const ticket = newId("tkt");
  await db.prepare(`INSERT INTO tickets (id, organization_id, subject, category, priority, status, opened_by, created_at, updated_at) VALUES (?,?, 'Site is slow', 'technical', 'high', 'open', ?, ?, ?)`).bind(ticket, cust.organizationId, cust.id, nowIso(), nowIso()).run();
  await db.prepare(`INSERT INTO assignments (id, subject_type, subject_id, user_id, assigned_by, created_at) VALUES (?, 'ticket', ?, ?, ?, ?)`).bind(newId("asg"), ticket, sup.id, owner.id, nowIso()).run();

  // Before disabling, the queue page previews the open work.
  const preview = await (await admin.c.get(`/staff/employees/${devA.id}/offboarding`)).text();
  assert.match(preview, /Build contact form/);
  assert.match(preview, /Project assignment/);

  // Disable Dana (queue mode): sent to the queue, nothing removed yet, task flagged "owner disabled".
  const res = await admin.c.post(`/staff/employees/${devA.id}/disable`, { reason: "Left the company", offboarding: "queue" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), `/staff/employees/${devA.id}/offboarding`);
  const items = (await db.prepare(`SELECT id, subject_type, subject_id, status FROM offboarding_items WHERE user_id = ? ORDER BY subject_type`).bind(devA.id).all<{ id: string; subject_type: string; subject_id: string; status: string }>()).results;
  assert.deepEqual(items.map((i) => [i.subject_type, i.status]), [["project", "pending"], ["task", "pending"]]);
  assert.match(await (await owner.c.get(`/staff/tasks/${task}`)).text(), /Owner disabled\.<\/strong> Dana Developer/);
  const audit = JSON.parse((await one<{ details_json: string }>(db, `SELECT details_json FROM audit_logs WHERE action = 'employee.disabled' AND subject_id = ?`, devA.id)).details_json);
  assert.deepEqual({ offboarding: audit.offboarding, queued: audit.queued }, { offboarding: "queue", queued: 2 });

  // Permission: a PM (no employee.manage) can neither see nor act on the queue.
  assert.equal((await pmA.c.get(`/staff/employees/${devA.id}/offboarding`)).status, 403);
  assert.equal((await pmA.c.post(`/staff/employees/${devA.id}/offboarding`, { item: "all", action: "end" })).status, 403);

  // Reassign the task to Bo; end the project assignment.
  const taskItem = items.find((i) => i.subject_type === "task")!, projItem = items.find((i) => i.subject_type === "project")!;
  assert.equal((await admin.c.post(`/staff/employees/${devA.id}/offboarding`, { item: taskItem.id, action: "reassign", to_user_id: devB.id })).status, 303);
  assert.ok(await one(db, `SELECT 1 AS x FROM assignments WHERE subject_type = 'task' AND subject_id = ? AND user_id = ? AND ended_at IS NULL`, task, devB.id));
  assert.equal((await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM assignments WHERE subject_type = 'task' AND subject_id = ? AND user_id = ? AND ended_at IS NULL`, task, devA.id)).n, 0);
  assert.equal((await admin.c.post(`/staff/employees/${devA.id}/offboarding`, { item: projItem.id, action: "end" })).status, 303);
  assert.equal((await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM assignments WHERE subject_type = 'project' AND subject_id = ? AND user_id = ? AND ended_at IS NULL`, pid, devA.id)).n, 0);
  assert.deepEqual((await db.prepare(`SELECT status FROM offboarding_items WHERE user_id = ? ORDER BY subject_type`).bind(devA.id).all<{ status: string }>()).results.map((r) => r.status), ["ended", "reassigned"]);
  assert.equal(await auditCount(db, "offboarding.resolved", devA.id), 2);
  assert.match(await (await admin.c.get(`/staff/employees/${devA.id}/offboarding`)).text(), /Nothing is waiting/);

  // PM role and lead: Bea (PM) and Sam (sales). Roles are respected: a developer cannot become PM or lead owner.
  assert.equal((await admin.c.post(`/staff/employees/${pmB.id}/disable`, { reason: "Contract ended" })).status, 303);
  const pmItem = await one<{ id: string }>(db, `SELECT id FROM offboarding_items WHERE user_id = ? AND subject_type = 'project_manager'`, pmB.id);
  const skipped = await admin.c.post(`/staff/employees/${pmB.id}/offboarding`, { item: pmItem.id, action: "reassign", to_user_id: devB.id });
  assert.equal(skipped.status, 303);
  assert.equal((await one<{ project_manager_id: string }>(db, `SELECT project_manager_id FROM projects WHERE id = ?`, pid)).project_manager_id, pmB.id, "a developer cannot take the PM role");
  assert.equal((await admin.c.post(`/staff/employees/${pmB.id}/offboarding`, { item: "all", action: "reassign", to_user_id: pmA.id })).status, 303);
  assert.equal((await one<{ project_manager_id: string }>(db, `SELECT project_manager_id FROM projects WHERE id = ?`, pid)).project_manager_id, pmA.id);
  assert.equal((await admin.c.post(`/staff/employees/${sales.id}/disable`, { reason: "Moved on" })).status, 303);
  assert.equal((await admin.c.post(`/staff/employees/${sales.id}/offboarding`, { item: "all", action: "reassign", to_user_id: admin.id })).status, 303);
  assert.equal((await one<{ owner_user_id: string }>(db, `SELECT owner_user_id FROM leads WHERE id = ?`, leadId)).owner_user_id, admin.id);

  // "End now" mode: the support person's ticket assignment is ended at once and flagged "owner disabled".
  assert.equal((await admin.c.post(`/staff/employees/${sup.id}/disable`, { reason: "Left", offboarding: "end" })).status, 303);
  assert.equal((await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM assignments WHERE subject_type = 'ticket' AND subject_id = ? AND ended_at IS NULL`, ticket)).n, 0);
  assert.equal((await one<{ status: string }>(db, `SELECT status FROM offboarding_items WHERE user_id = ? AND subject_type = 'ticket'`, sup.id)).status, "ended");
  assert.match(await (await owner.c.get(`/staff/support/${ticket}`)).text(), /Owner disabled\.<\/strong> Sue Support/);

  // Re-enabling returns still-pending work.
  const { leadId: lead2 } = await seedLead(db, { name: "Second Lead", email: "second@example.com", owner: admin.id });
  const rep2 = await createStaff(db, "sales", "rep2@crestmont.test");
  await db.prepare(`UPDATE leads SET owner_user_id = ? WHERE id = ?`).bind(rep2.id, lead2).run();
  assert.equal((await admin.c.post(`/staff/employees/${rep2.id}/disable`, { reason: "Leave" })).status, 303);
  assert.equal((await admin.c.post(`/staff/employees/${rep2.id}/enable`)).status, 303);
  assert.equal((await one<{ status: string }>(db, `SELECT status FROM offboarding_items WHERE user_id = ?`, rep2.id)).status, "restored");
  assert.equal((await one<{ owner_user_id: string }>(db, `SELECT owner_user_id FROM leads WHERE id = ?`, lead2)).owner_user_id, rep2.id);
  // Acting on an active person's queue is refused.
  assert.equal((await admin.c.post(`/staff/employees/${rep2.id}/offboarding`, { item: "all", action: "end" })).status, 409);
});

// ───────────── CREST-GAP-043 ─────────────
test("[SEC-006] CREST-GAP-043 /account and the portal Account navigation link to /account/privacy", async () => {
  const app = await createTestApp();
  const cust = await createCustomer(app.db, "priv@a.example", "Privacy Co");
  const c = await app.client().login(cust.email);
  const account = await (await c.get("/account")).text();
  assert.match(account, /href="\/account\/privacy"/);
  assert.match(account, /href="\/account\/profile"/);
  const account2 = await (await c.get("/portal")).text();
  assert.match(account2, /href="\/account\/privacy"/, "portal sidebar Account group");
  const accountGroup = portalNav({} as never).find((g) => g.label === "Account")!;
  assert.ok(accountGroup.items.some((i) => i.href === "/account/privacy"));
  assert.equal((await c.get("/account/privacy")).status, 200);
  // Staff see the privacy link too (but not the customer profile editor).
  const s = await staffLogin(app, "developer");
  const staffAccount = await (await s.c.get("/account")).text();
  assert.match(staffAccount, /href="\/account\/privacy"/);
  assert.doesNotMatch(staffAccount, /href="\/account\/profile"/);
});

// ───────────── CREST-GAP-070 ─────────────
test("[EMP-002] CREST-GAP-070 broad staff customer visibility is kept but every customer record and conversation view is audited", async () => {
  const app = await createTestApp();
  const cust = await createCustomer(app.db, "view@a.example", "Viewed Co");
  const sales = await staffLogin(app, "sales");
  const supp = await staffLogin(app, "support");
  const dev = await staffLogin(app, "developer");
  for (const s of [sales, supp]) {
    assert.equal((await s.c.get(`/staff/customers/${cust.organizationId}`)).status, 200, "sales/support keep customer visibility (Founder default)");
    assert.equal((await s.c.get(`/staff/conversations/${cust.organizationId}`)).status, 200);
  }
  const rows = (await app.db.prepare(`SELECT action, actor_user_id FROM audit_logs WHERE subject_id = ? AND action IN ('customer.viewed','conversation.viewed') ORDER BY id`).bind(cust.organizationId).all<{ action: string; actor_user_id: string }>()).results;
  assert.deepEqual(rows.map((r) => [r.action, r.actor_user_id]), [["customer.viewed", sales.id], ["conversation.viewed", sales.id], ["customer.viewed", supp.id], ["conversation.viewed", supp.id]]);
  // Access is not widened: a developer (no customers.read) is still refused and nothing is logged as a view.
  assert.equal((await dev.c.get(`/staff/customers/${cust.organizationId}`)).status, 403);
  assert.equal((await dev.c.get(`/staff/conversations/${cust.organizationId}`)).status, 403);
  assert.equal(await auditCount(app.db, "customer.viewed", cust.organizationId), 2);
});

// ───────────── CREST-GAP-071 ─────────────
test("[PORTAL-004] CREST-GAP-071 portal projects, files and approvals, staff conversations, customer sub-tables and My work page with true totals", async () => {
  const app = await createTestApp();
  const { db } = app;
  const cust = await createCustomer(db, "lists@a.example", "Lists Co");
  const c = await app.client().login(cust.email);
  const owner = await staffLogin(app, "owner");
  // 30 projects (test data through the real provisioning service).
  const pids: string[] = [];
  for (let i = 0; i < 30; i++) pids.push(await makeProject(db, cust.organizationId));
  const p1 = await (await c.get("/portal/projects")).text();
  assert.match(p1, /Showing 1–25 of 30 projects/);
  assert.match(p1, /href="\/portal\/projects\?page=2"/);
  assert.match(await (await c.get("/portal/projects?page=2")).text(), /Showing 26–30 of 30 projects/);
  // Files: 30 rows; the old silent cap was 500, the list now pages at 25 and states the total.
  const stmts = [];
  for (let i = 0; i < 30; i++) stmts.push(db.prepare(`INSERT INTO files (id, organization_id, project_id, r2_key, filename, content_type, size_bytes, sha256, scan_status, uploaded_by, created_at) VALUES (?,?,NULL,?,?, 'application/pdf', 10, 'x', 'pending', ?, ?)`)
    .bind(newId("fil"), cust.organizationId, `k/${i}`, `doc-${String(i).padStart(2, "0")}.pdf`, cust.id, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()));
  await db.batch(stmts);
  const f1 = await (await c.get("/portal/files")).text();
  assert.match(f1, /Showing 1–25 of 30 files/);
  assert.match(await (await c.get("/portal/files?page=2")).text(), /Showing 26–30 of 30 files/);
  // Approvals history: 30 decisions.
  const ap = [];
  for (let i = 0; i < 30; i++) ap.push(db.prepare(`INSERT INTO approvals (id, project_id, kind, decision, decided_by, created_at) VALUES (?,?, 'design', 'approved', ?, ?)`).bind(newId("apv"), pids[i], cust.id, new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString()));
  await db.batch(ap);
  assert.match(await (await c.get("/portal/approvals")).text(), /Showing 1–25 of 30 decisions/);
  // Customer record sub-tables: 30 projects → paged per section, other sections unaffected.
  const cr = await (await owner.c.get(`/staff/customers/${cust.organizationId}`)).text();
  assert.match(cr, /Showing 1–25 of 30 projects/);
  assert.match(cr, /projects_page=2#projects/);
  assert.match(await (await owner.c.get(`/staff/customers/${cust.organizationId}?projects_page=2`)).text(), /Showing 26–30 of 30 projects/);
  // Staff conversations: 30 organizations with a general conversation.
  for (let i = 0; i < 30; i++) {
    const o = await createCustomer(db, `conv${i}@x.example`, `Conv Org ${String(i).padStart(2, "0")}`);
    await db.prepare(`INSERT INTO messages (id, organization_id, project_id, author_user_id, body, internal, created_at) VALUES (?,?,NULL,?, 'hello', 0, ?)`).bind(newId("msg"), o.organizationId, o.id, nowIso()).run();
  }
  const conv = await (await owner.c.get("/staff/conversations")).text();
  assert.match(conv, /Showing 1–25 of 30 conversations/);
  assert.match(await (await owner.c.get("/staff/conversations?page=2")).text(), /Showing 26–30 of 30 conversations/);
  // My work: 27 open leads owned by a sales rep (list shows 25) → true KPI and a link to the full list.
  const rep = await staffLogin(app, "sales");
  for (let i = 0; i < 27; i++) await seedLead(db, { name: `Rep Lead ${i}`, owner: rep.id });
  const mw = await (await rep.c.get("/staff")).text();
  assert.match(mw, /Showing 25 of 27 open leads/);
  assert.match(mw, /My open leads<\/div><div class="kpi__value">27/);
  assert.match(mw, new RegExp(`href="/staff/crm\\?view=list&amp;owner=${rep.id}"`));
});

// ───────────── CREST-GAP-072 ─────────────
test("[AUTH-003] CREST-GAP-072 customer administrators without MFA see a dismissible enrolment notice; members, MFA users and staff do not", async () => {
  const app = await createTestApp();
  const { db } = app;
  const adminCu = await createCustomer(db, "mfa-admin@a.example", "Mfa Co");
  const member = newId("usr");
  await db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, created_at) SELECT ?, 'mfa-member@a.example', 'Member', password_hash, ?, ? FROM users WHERE id = ?`).bind(member, nowIso(), nowIso(), adminCu.id).run();
  await db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?, 'customer_member', ?)`).bind(newId("mbr"), member, adminCu.organizationId, nowIso()).run();
  const a = await app.client().login(adminCu.email);
  const m = await app.client().login("mfa-member@a.example");
  const dash = await (await a.get("/portal")).text();
  assert.match(dash, /data-mfa-reminder/);
  assert.match(dash, /href="\/mfa\/setup"/);
  assert.doesNotMatch(await (await m.get("/portal")).text(), /data-mfa-reminder/, "members are not prompted");
  // Dismiss: hidden from then on, audited, and MFA is still optional (the portal keeps working without it).
  assert.equal((await a.post("/portal/notices/mfa-reminder/dismiss")).status, 303);
  assert.doesNotMatch(await (await a.get("/portal")).text(), /data-mfa-reminder/);
  assert.equal(await auditCount(db, "user.mfa_reminder_dismissed", adminCu.id), 1);
  assert.equal((await a.get("/portal/billing")).status, 200);
  // Staff are never shown the customer notice; staff MFA stays mandatory (a password-only staff session reaches nothing).
  const s = await createStaff(db, "support", "mfa-staff@crestmont.test");
  const half = app.client();
  const r = await half.post("/login", { email: s.email, password: TEST_PASSWORD });
  assert.match(r.headers.get("location") ?? "", /^\/mfa/);
  assert.notEqual((await half.get("/staff")).status, 200);
  assert.equal((await half.post("/portal/notices/mfa-reminder/dismiss")).status === 303, false);
});

// ───────────── CREST-GAP-073 ─────────────
test("[AUTH-001] CREST-GAP-073 customers edit their name; an email change re-verifies the new address, notifies the old one and applies only after confirmation", async () => {
  const app = await createTestApp();
  const { db } = app;
  const cu = await createCustomer(db, "old-address@a.example", "Profile Co");
  const c = await app.client().login(cu.email);
  const other = await app.client().login(cu.email); // a second session that must be signed out on change
  // Display name
  assert.equal((await c.post("/account/profile", { display_name: "  Patricia   Customer " })).status, 303);
  assert.equal((await one<{ display_name: string }>(db, `SELECT display_name FROM users WHERE id = ?`, cu.id)).display_name, "Patricia Customer");
  assert.equal((await c.post("/account/profile", { display_name: "x" })).status, 422);
  assert.equal(await auditCount(db, "user.profile_updated", cu.id), 1);
  // Email change: wrong password refused.
  assert.equal((await c.post("/account/email", { new_email: "new-address@a.example", current_password: "wrong-password-123" })).status, 422);
  assert.equal(await lastEmail(db, "new-address@a.example"), null);
  // Correct password: link to the NEW address, notice to the OLD; the email does not change yet.
  assert.equal((await c.post("/account/email", { new_email: "New-Address@a.example", current_password: TEST_PASSWORD })).status, 303);
  const toNew = (await lastEmail(db, "new-address@a.example"))!;
  assert.equal(toNew.template, "email_change_confirm");
  assert.equal((await lastEmail(db, cu.email))!.template, "security_notification");
  assert.match((await lastEmail(db, cu.email))!.text_body, /asked to change its email address/);
  assert.equal((await one<{ email: string }>(db, `SELECT email FROM users WHERE id = ?`, cu.id)).email, cu.email);
  assert.match(await (await c.get("/account/profile")).text(), /waiting for confirmation/);
  assert.equal((await app.client().post("/login", { email: cu.email, password: TEST_PASSWORD })).status, 303, "old address still signs in");
  // Confirmation: GET shows a page and changes nothing; POST applies it.
  const link = linkFrom(toNew.text_body, "/account/email/confirm");
  const token = new URL(link, "http://x").searchParams.get("token")!;
  const anon = app.client();
  const confirmPage = await anon.get(link);
  assert.equal(confirmPage.status, 200);
  assert.match(await confirmPage.text(), /new-address@a\.example/);
  assert.equal((await one<{ email: string }>(db, `SELECT email FROM users WHERE id = ?`, cu.id)).email, cu.email);
  const done = await c.post("/account/email/confirm", { token });
  assert.equal(done.status, 303);
  const u = await one<{ email: string; email_verified_at: string | null }>(db, `SELECT email, email_verified_at FROM users WHERE id = ?`, cu.id);
  assert.equal(u.email, "new-address@a.example");
  assert.ok(u.email_verified_at);
  assert.match((await lastEmail(db, cu.email))!.text_body, /email address on your Crestmont account was changed/);
  assert.equal(await auditCount(db, "user.email_changed", cu.id), 1);
  // Other sessions are signed out; this one stays.
  assert.notEqual((await other.get("/portal")).status, 200);
  assert.equal((await c.get("/portal")).status, 200);
  // The link is single-use; old address no longer signs in; new one does.
  assert.equal((await anon.post("/account/email/confirm", { token })).status, 404);
  assert.equal((await anon.get(link)).status, 404);
  assert.notEqual((await app.client().post("/login", { email: cu.email, password: TEST_PASSWORD })).status, 303, "the old address no longer signs in");
  assert.equal((await app.client().login("new-address@a.example")).cookies.size > 0, true);
  // An address already in use: same message, but no link is sent (no account enumeration).
  const taken = await createCustomer(db, "taken@a.example", "Taken Co");
  assert.equal((await c.post("/account/email", { new_email: taken.email, current_password: TEST_PASSWORD })).status, 303);
  assert.notEqual((await lastEmail(db, taken.email))?.template, "email_change_confirm");
  // Cancel clears a pending change.
  assert.equal((await c.post("/account/email", { new_email: "third@a.example", current_password: TEST_PASSWORD })).status, 303);
  const t3 = new URL(linkFrom((await lastEmail(db, "third@a.example"))!.text_body, "/account/email/confirm"), "http://x").searchParams.get("token")!;
  assert.equal((await c.post("/account/email/cancel")).status, 303);
  assert.equal((await anon.post("/account/email/confirm", { token: t3 })).status, 404);
  // Staff manage email through administrators: the customer profile routes refuse staff.
  const s = await staffLogin(app, "support");
  assert.equal((await s.c.get("/account/profile")).status, 403);
  assert.equal((await s.c.post("/account/email", { new_email: "x@y.example", current_password: TEST_PASSWORD })).status, 403);
});

// ───────────── CREST-GAP-074 ─────────────
test("[PORTAL-007] CREST-GAP-074 /portal/approvals lists open requests across projects, records decisions in history, and is tenant- and role-scoped", async () => {
  const app = await createTestApp();
  const { db } = app;
  const a = await createCustomer(db, "appr-a@a.example", "Approvals A");
  const b = await createCustomer(db, "appr-b@b.example", "Approvals B");
  const member = newId("usr");
  await db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, created_at) SELECT ?, 'appr-member@a.example', 'Member', password_hash, ?, ? FROM users WHERE id = ?`).bind(member, nowIso(), nowIso(), a.id).run();
  await db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?, 'customer_member', ?)`).bind(newId("mbr"), member, a.organizationId, nowIso()).run();
  const pm = await staffLogin(app, "project_manager");
  const pa1 = await makeProject(db, a.organizationId), pa2 = await makeProject(db, a.organizationId), pb = await makeProject(db, b.organizationId);
  await db.prepare(`UPDATE projects SET name = 'Alpha site' WHERE id = ?`).bind(pa1).run();
  await db.prepare(`UPDATE projects SET name = 'Beta shop' WHERE id = ?`).bind(pa2).run();
  await db.prepare(`UPDATE projects SET name = 'Other tenant project' WHERE id = ?`).bind(pb).run();
  assert.equal((await pm.c.post(`/staff/projects/${pa1}/request-approval`, { kind: "design", note: "Homepage design v2" })).status, 303);
  assert.equal((await pm.c.post(`/staff/projects/${pa2}/request-approval`, { kind: "customer_launch", note: "Ready to go live" })).status, 303);
  assert.equal((await pm.c.post(`/staff/projects/${pb}/request-approval`, { kind: "design", note: "B private note" })).status, 303);
  const ca = await app.client().login(a.email);
  const page = await (await ca.get("/portal/approvals")).text();
  assert.match(page, /Waiting for your decision/);
  assert.match(page, new RegExp(`href="/portal/projects/${pa1}/approvals">Alpha site`));
  assert.match(page, new RegExp(`href="/portal/projects/${pa2}/approvals">Beta shop`));
  assert.match(page, /Homepage design v2/);
  assert.doesNotMatch(page, /Other tenant project|B private note/, "another organization's requests never appear");
  assert.match(page, /No decisions yet/);
  // The admin decides on one project; the aggregate page moves it to history with who decided.
  assert.equal((await ca.post(`/portal/projects/${pa1}/approvals`, { kind: "design", decision: "approved", notes: "Looks great" })).status, 303);
  const after = await (await ca.get("/portal/approvals")).text();
  assert.doesNotMatch(after, /Homepage design v2/, "resolved request leaves the waiting list");
  assert.match(after, /Ready to go live/);
  assert.match(after, /Decision history[\s\S]*Alpha site[\s\S]*Approved[\s\S]*Pat Customer[\s\S]*Looks great/);
  // A member sees the page but cannot decide.
  const cm = await app.client().login("appr-member@a.example");
  assert.equal((await cm.get("/portal/approvals")).status, 200);
  assert.equal((await cm.post(`/portal/projects/${pa2}/approvals`, { kind: "customer_launch", decision: "approved" })).status, 403);
  // Staff are refused the customer page.
  assert.equal((await pm.c.get("/portal/approvals")).status, 403);
});

// ───────────── CREST-GAP-079 ─────────────
test("[AUTH-007] CREST-GAP-079 customer-record project and lead links and the retention subnav render only when the viewer can open them", async () => {
  const app = await createTestApp();
  const { db } = app;
  const cust = await createCustomer(db, "links@a.example", "Links Co");
  const pid = await makeProject(db, cust.organizationId);
  const owner = await staffLogin(app, "owner");
  const supp = await staffLogin(app, "support");
  const sales = await staffLogin(app, "sales");
  const dev = await staffLogin(app, "developer");
  const projLink = new RegExp(`href="/staff/projects/${pid}"`);
  assert.match(await (await owner.c.get(`/staff/customers/${cust.organizationId}`)).text(), projLink);
  // Support has customers.read but sees only assigned projects; sales has no delivery access.
  assert.doesNotMatch(await (await supp.c.get(`/staff/customers/${cust.organizationId}`)).text(), projLink);
  assert.equal((await supp.c.get(`/staff/projects/${pid}`)).status, 404, "the link would have been dead");
  const salesPage = await (await sales.c.get(`/staff/customers/${cust.organizationId}`)).text();
  assert.doesNotMatch(salesPage, projLink);
  assert.match(salesPage, /Links Co|Project/);
  // Once assigned, support gets the link and the page opens.
  assert.equal((await owner.c.post(`/staff/projects/${pid}/assign`, { user_id: supp.id })).status, 303);
  assert.match(await (await supp.c.get(`/staff/customers/${cust.organizationId}`)).text(), projLink);
  assert.equal((await supp.c.get(`/staff/projects/${pid}`)).status, 200);
  // Lead links: a sales rep sees a link only for a lead they own.
  const orderLead = await seedLead(db, { name: "Order Lead", owner: null });
  await db.prepare(`UPDATE orders SET lead_id = ? WHERE organization_id = ?`).bind(orderLead.leadId, cust.organizationId).run();
  const leadLink = new RegExp(`href="/staff/crm/leads/${orderLead.leadId}"`);
  assert.doesNotMatch(await (await sales.c.get(`/staff/customers/${cust.organizationId}`)).text(), leadLink);
  assert.equal((await sales.c.get(`/staff/crm/leads/${orderLead.leadId}`)).status, 404);
  await db.prepare(`UPDATE leads SET owner_user_id = ? WHERE id = ?`).bind(sales.id, orderLead.leadId).run();
  assert.match(await (await sales.c.get(`/staff/customers/${cust.organizationId}`)).text(), leadLink);
  assert.match(await (await owner.c.get(`/staff/customers/${cust.organizationId}`)).text(), leadLink);
  // Operations subnav: Data retention needs settings.operational.
  const devOps = await (await dev.c.get("/staff/ops")).text();
  assert.doesNotMatch(devOps, /href="\/staff\/ops\/retention"/);
  assert.match(devOps, /href="\/staff\/readiness\/founder-report"/);
  assert.equal((await dev.c.get("/staff/ops/retention")).status, 403);
  assert.match(await (await owner.c.get("/staff/ops")).text(), /href="\/staff\/ops\/retention"/);
});

// ───────────── CREST-GAP-081 ─────────────
test("[CRM-002] CREST-GAP-081 duplicate detection uses indexed normalized columns, bounded queries and paginated clusters", async () => {
  const app = await createTestApp();
  const { db } = app;
  const raw = (db as SqliteDb).raw;
  // Normalized keys are maintained by triggers on insert and update.
  const x = await seedLead(db, { name: "  Dana   FOX ", email: " Dana@FoxDesign.Example ", phone: "+1 (517) 555-0142", company: "Fox Design" });
  const n1 = await one<{ email_norm: string; phone_norm: string; name_company_norm: string }>(db, `SELECT email_norm, phone_norm, name_company_norm FROM contacts WHERE id = ?`, x.contactId);
  assert.deepEqual({ ...n1 }, { email_norm: "dana@foxdesign.example", phone_norm: "5175550142", name_company_norm: "dana fox|fox design" });
  await db.prepare(`UPDATE contacts SET phone = '517.555.0199', email = NULL WHERE id = ?`).bind(x.contactId).run();
  const n2 = await one<{ email_norm: string | null; phone_norm: string }>(db, `SELECT email_norm, phone_norm FROM contacts WHERE id = ?`, x.contactId);
  assert.deepEqual({ ...n2 }, { email_norm: null, phone_norm: "5175550199" });
  assert.equal((await one<{ phone_norm: string | null }>(db, `SELECT phone_norm FROM contacts WHERE id = (SELECT contact_id FROM leads WHERE id = ?)`, (await seedLead(db, { name: "Short", phone: "555-01" })).leadId)).phone_norm, null);
  // The lookups use the new indexes (no scan of contacts).
  for (const [col, idx] of [["email_norm", "idx_contacts_email_norm"], ["phone_norm", "idx_contacts_phone_norm"], ["name_company_norm", "idx_contacts_name_company_norm"]]) {
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN SELECT id FROM contacts WHERE ${col} = ?`).all("x") as { detail: string }[]).map((p) => p.detail).join(" | ");
    assert.match(plan, new RegExp(idx), `${col}: ${plan}`);
  }
  // 45 duplicate pairs (email), 3 pages of 20 groups; unrelated leads are never read into a cluster.
  for (let i = 0; i < 45; i++) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    await seedLead(db, { name: `Pair ${i} A`, email: `pair${i}@dupe.example`, at });
    await seedLead(db, { name: `Pair ${i} B`, email: `PAIR${i}@Dupe.Example`, at });
  }
  for (let i = 0; i < 50; i++) await seedLead(db, { name: `Solo ${i}`, email: `solo${i}@unique.example` });
  const owner = await staffLogin(app, "owner");
  const p1 = await (await owner.c.get("/staff/crm/duplicates")).text();
  assert.match(p1, /Showing groups 1–20 of 45/);
  assert.equal((p1.match(/data-cluster=/g) ?? []).length, 20);
  assert.doesNotMatch(p1, /Solo \d/);
  assert.match(p1, /href="\/staff\/crm\/duplicates\?page=2"/);
  const p3 = await (await owner.c.get("/staff/crm/duplicates?page=3")).text();
  assert.match(p3, /Showing groups 41–45 of 45/);
  assert.equal((p3.match(/data-cluster=/g) ?? []).length, 5);
  // A sales rep sees only clusters among leads they own.
  const rep = await staffLogin(app, "sales");
  const r1 = await seedLead(db, { name: "Rep A", email: "rep-pair@dupe.example", owner: rep.id });
  await seedLead(db, { name: "Rep B", email: "rep-pair@dupe.example", owner: rep.id });
  const repPage = await (await rep.c.get("/staff/crm/duplicates")).text();
  assert.match(repPage, /Rep A/);
  assert.doesNotMatch(repPage, /Pair \d+ A/);
  // The lead page's "possible duplicates" is one indexed, bounded lookup.
  assert.match(await (await rep.c.get(`/staff/crm/leads/${r1.leadId}`)).text(), /Possible duplicates \(1\)/);
});
