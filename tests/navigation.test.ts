import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer } from "./support/app.ts";
import { staffNav, portalNav, OWNER_MODULE_LABELS, RETIRED_STAFF_PAGES } from "../src/routes/nav.ts";
import { can } from "../src/domain/authz.ts";

const OWNER_MODULES = OWNER_MODULE_LABELS;
// The Founder's simplified sidebar (directive 2026-11-08): 20 modules, the retired ones listed in RETIRED_STAFF_PAGES.
assert.equal(OWNER_MODULES.length, 20);

test("[OWN-001] the Owner navigation exposes every module of the simplified sidebar and every one renders (200)", async () => {
  const { db, client } = await createTestApp();
  const o = await createStaff(db, "owner");
  const c = await client().login(o.email, undefined, o.secret);
  const items = staffNav({} as never).flatMap((g) => g.items);
  for (const m of OWNER_MODULES) assert.ok(items.some((i) => i.label === m), `module ${m} in navigation`);
  for (const i of items) {
    const res = await c.get(i.href);
    assert.equal(res.status, 200, `${i.label} (${i.href}) → ${res.status}`);
    const body = await res.text();
    const visible = body.replace(/placeholder="[^"]*"/g, "");
    assert.doesNotMatch(visible, /coming soon|lorem ipsum|\bplaceholder\b/i, `${i.href} has no placeholder copy`);
    assert.doesNotMatch(visible, /\bTODO\b|FIXME/, `${i.href} has no unfinished-work markers`);
  }
});

test("[OWN-001] staff only see and reach modules their role permits", async () => {
  const { db, client } = await createTestApp();
  const dev = await createStaff(db, "developer");
  const c = await client().login(dev.email, undefined, dev.secret);
  const actor = { kind: "user" as const, userId: dev.id, roles: [{ role: "developer" as const, organizationId: dev.organizationId }], mfaVerified: true };
  const home = await (await c.get("/staff")).text();
  for (const i of staffNav({} as never).flatMap((g) => g.items)) {
    const allowed = !i.perm || can(actor, i.perm);
    assert.equal(home.includes(`href="${i.href}"`), allowed, `${i.href} visibility for developer`);
    if (!allowed) assert.equal((await c.get(i.href)).status, 403, `${i.href} refused server-side for developer`);
  }
});

test("[PORTAL-009] customer portal navigation includes support and every portal module renders", async () => {
  const { db, client } = await createTestApp();
  const cust = await createCustomer(db, "nav@example.com");
  const c = await client().login(cust.email);
  for (const i of portalNav({} as never).flatMap((g) => g.items)) {
    assert.equal((await c.get(i.href)).status, 200, `${i.href}`);
  }
  assert.ok(portalNav({} as never).flatMap((g) => g.items).some((i) => i.href === "/portal/support"));
});

test("[OWN-001] retired pages are gone from the sidebar, with no duplicates, yet every one still answers for the Owner; nothing behind them was removed", async () => {
  const { db, client } = await createTestApp();
  const o = await createStaff(db, "owner");
  const c = await client().login(o.email);
  const items = staffNav({} as never).flatMap((g) => g.items);
  // No duplicate entries.
  assert.equal(new Set(items.map((i) => i.href)).size, items.length, "no duplicate hrefs");
  assert.equal(new Set(items.map((i) => i.label)).size, items.length, "no duplicate labels");
  // Every retired page is out of the sidebar...
  for (const r of RETIRED_STAFF_PAGES) {
    assert.ok(!items.some((i) => i.href === r.href), `${r.label} is not in the sidebar`);
    assert.ok(!items.some((i) => i.label === r.label), `${r.label} label is not in the sidebar`);
  }
  for (const gone of ["Executive overview", "Launch readiness", "Engineering", "Development", "Staging", "Production", "Tasks", "Profitability",
    "Reconciliation", "AI operations", "Artifact Builder", "Email suppressions", "Monitoring", "Deployments", "Security", "Backups"]) {
    assert.ok(!items.some((i) => i.label === gone), `${gone} removed`);
  }
  assert.ok(!staffNav({} as never).some((g) => g.label === "Launch readiness"), "the whole Launch readiness group is gone");
  const home = await (await c.get("/staff")).text();
  for (const r of RETIRED_STAFF_PAGES) assert.ok(!home.includes(`class="side-link" href="${r.href}"`), `${r.href} not rendered in the sidebar`);
  // ...but its route still answers (no broken deep links). Tasks redirects into My Work, keeping its filters.
  for (const r of RETIRED_STAFF_PAGES) {
    const res = await c.get(r.href);
    if (r.href === "/staff/tasks") continue;
    assert.equal(res.status, 200, `${r.label} (${r.href}) still answers → ${res.status}`);
  }
  const tasks = await c.get("/staff/tasks?assignee=me&status=open");
  assert.equal(tasks.status, 303);
  assert.equal(tasks.headers.get("location"), "/staff?assignee=me&status=open&tab=tasks");
  // The technical pages are listed for administrators under Business settings.
  const settings = await (await c.get("/staff/settings")).text();
  assert.match(settings, /Technical administration/);
  for (const r of RETIRED_STAFF_PAGES.filter((x) => x.technical)) assert.ok(settings.includes(`href="${r.href}"`), `${r.href} reachable from Business settings`);
});

test("[OWN-001] My Work is the single task interface: All tasks tab, inline status updates that return to My Work", async () => {
  const { db, client } = await createTestApp();
  const pm = await createStaff(db, "project_manager");
  const c = await client().login(pm.email);
  const { newId, nowIso } = await import("../src/lib/db.ts");
  const cust = await createCustomer(db);
  const pid = newId("prj"), tid = newId("tsk");
  await db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES (?,?, 'Nav project', 'development', 2, 'upfront', ?, ?)`).bind(pid, cust.organizationId, nowIso(), nowIso()).run();
  await db.prepare(`INSERT INTO tasks (id, project_id, title, status, created_at) VALUES (?,?, 'Write the homepage copy', 'todo', ?)`).bind(tid, pid, nowIso()).run();
  await db.prepare(`INSERT INTO assignments (id, subject_type, subject_id, user_id, assigned_by, created_at) VALUES (?, 'task', ?, ?, ?, ?)`).bind(newId("asg"), tid, pm.id, pm.id, nowIso()).run();
  const mine = await (await c.get("/staff")).text();
  assert.match(mine, /href="\/staff\?tab=tasks"[^>]*>All tasks</);
  assert.match(mine, /Write the homepage copy/);
  assert.match(mine, new RegExp(`action="/staff/tasks/${tid}/status"`), "the task can be updated from My Work");
  const all = await c.get("/staff?tab=tasks");
  assert.equal(all.status, 200);
  const allBody = await all.text();
  assert.match(allBody, /All tasks/);
  assert.match(allBody, /Write the homepage copy/);
  assert.match(allBody, /name="tab" value="tasks"/, "the filters stay on My Work");
  const done = await c.post(`/staff/tasks/${tid}/status`, { status: "done", back: "/staff" });
  assert.equal(done.status, 303);
  assert.equal(done.headers.get("location"), "/staff", "back to My Work");
  assert.equal((await db.prepare(`SELECT status FROM tasks WHERE id = ?`).bind(tid).first<{ status: string }>())!.status, "done");
  // An off-site or odd "back" is ignored.
  const evil = await c.post(`/staff/tasks/${tid}/status`, { status: "in_progress", back: "https://evil.example/x" });
  assert.equal(evil.headers.get("location"), `/staff/tasks/${tid}`);
});

test("[OWN-001] relocated actions stay reachable: AI drafts, data-deletion requests and payment discrepancies in My Work; suppressions on Email operations; budgets moved", async () => {
  const { db, client } = await createTestApp();
  const o = await createStaff(db, "owner");
  const c = await client().login(o.email);
  const { newId, nowIso } = await import("../src/lib/db.ts");
  await db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, created_at, updated_at) VALUES (?, 'support_reply', 'local-runner', 'm', 'awaiting_approval', 'x', ?, ?)`).bind(newId("aij"), nowIso(), nowIso()).run();
  const cust = await createCustomer(db);
  await db.prepare(`INSERT INTO privacy_requests (id, user_id, kind, status, created_at) VALUES (?, ?, 'deletion', 'received', ?)`).bind(newId("prv"), cust.id, nowIso()).run();
  await db.prepare(`INSERT INTO reconciliation_findings (id, fingerprint, kind, scope, detail, status, first_seen_at, last_seen_at) VALUES (?, 'fp1', 'amount_mismatch', 'checkout', 'x', 'open', ?, ?)`).bind(newId("rf"), nowIso(), nowIso()).run().catch(() => undefined);
  const home = await (await c.get("/staff")).text();
  assert.match(home, /Needs your attention/);
  assert.match(home, /AI draft waiting for your review/);
  assert.match(home, /data-deletion request/);
  assert.match(await (await c.get("/staff/email")).text(), /Suppressed addresses[\s\S]*href="\/staff\/email-suppressions"/);
  // The monthly AI budget lives on AI sales optimization; the voice page no longer has a budget.
  const so = await (await c.get("/staff/sales-optimization")).text();
  assert.match(so, /id="ai-budget"/);
  assert.match(so, /action="\/staff\/ai\/budget"/);
  assert.doesNotMatch(so, /<h2>Rollback history<\/h2>/);
  assert.doesNotMatch(so, /<h2>Experiments<\/h2>/);
  const voice = await (await c.get("/staff/voice")).text();
  assert.doesNotMatch(voice, /Monthly voice budget/);
  assert.match(voice, /Voice costs this month/);
  // Reports no longer offers the Profitability export; the others remain.
  const reports = await (await c.get("/staff/reports")).text();
  assert.doesNotMatch(reports, /\/staff\/reports\/profitability\.csv/);
  for (const k of ["transactions", "invoices", "refunds", "subscriptions"]) assert.match(reports, new RegExp(`/staff/reports/${k}\\.csv`));
});
