// Closeout fixes for the Owner, staff and customer modules (CREST-GAP-040..044, 070..074, 079, 081).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff } from "./support/app.ts";
import { provisionProject } from "../src/services/commerce.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import type { Db } from "../src/lib/db.ts";
import { unreadCountForCustomer, THREAD_PAGE_SIZE } from "../src/services/messages.ts";

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
