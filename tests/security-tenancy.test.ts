// Route security matrix, part 2: tenant isolation for EVERY customer route (AUTH-008). Two customer
// organizations each own every customer resource type (projects, files, share links, messages,
// revisions, change orders, approvals, handoffs, tickets, invoices, payments, receipts, refunds,
// agreements, team members, invitations, sessions). Customer A replays every customer route with B's
// ids. Every record created here is TEST DATA.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, idFor, fillPath, type World, type Tenant } from "./support/security-world.ts";
import { classified, pathFor, call, snapshot, changedTables, appErrors, crossTenantLinks, leakedFrom, toLogin, type RouteEntry } from "./support/security-helpers.ts";
import { customerPostFields, auditScenarios } from "./support/security-scenarios.ts";
import type { ResourceKind } from "./support/route-inventory.ts";
import type { SqliteDb } from "../dev/sqlite-d1.ts";

let w: World;
before(async () => { w = await buildWorld(); });

/** Resource kinds owned by a tenant (vs. public catalogue identifiers such as packages or policy slugs). */
const tenantKinds = (t: Tenant) => new Set(Object.keys(t.ids) as ResourceKind[]);
const customerSide = (r: RouteEntry) => r.spec.access.kind === "customer" || r.spec.access.kind === "session";
const describe = async (res: Response) => `${res.status}${res.headers.get("location") ? ` → ${res.headers.get("location")}` : ""}`;

/** Hash of every row that belongs to `t` (by organization, project or user), to prove another tenant changed none of it. */
function tenantRows(db: World["db"], t: Tenant): Map<string, string> {
  const raw = (db as SqliteDb).raw;
  const out = new Map<string, string>();
  const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('audit_logs','security_events','rate_limits','app_errors','d1_migrations')`).all() as { name: string }[]).map((x) => x.name);
  const users = [t.admin.id, t.member.id];
  for (const table of tables) {
    const cols = new Set((raw.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name));
    const where: string[] = [];
    if (cols.has("organization_id")) where.push(`organization_id = '${t.orgId}'`);
    if (cols.has("project_id")) where.push(`project_id IN (SELECT id FROM projects WHERE organization_id = '${t.orgId}')`);
    if (cols.has("user_id")) where.push(`user_id IN ('${users.join("','")}')`);
    if (table === "organizations") where.push(`id = '${t.orgId}'`);
    if (table === "users") where.push(`id IN ('${users.join("','")}')`);
    if (!where.length) continue;
    // sessions.last_seen_at moves on every request a tenant makes; it is bookkeeping, not tenant data.
    const rows = raw.prepare(`SELECT * FROM "${table}" WHERE ${where.join(" OR ")}`).all().map((r) => { const x = { ...(r as Record<string, unknown>) }; delete x.last_seen_at; return x; });
    out.set(table, JSON.stringify(rows));
  }
  return out;
}

test("[AUTH-008] customer A gets 403/404 on every customer route addressed with customer B's record ids (GET and POST), with no B data leaked and no B record changed", async () => {
  const errors0 = appErrors(w.db);
  const bBefore = tenantRows(w.db, w.b);
  const all = classified().filter((r) => customerSide(r) && r.spec.params);
  const kinds = tenantKinds(w.b);
  const covered: string[] = [], notTenant: string[] = [], problems: string[] = [];
  for (const r of all) {
    const entries = Object.entries(r.spec.params!);
    if (!entries.some(([, k]) => kinds.has(k))) { notTenant.push(r.key); continue; }
    covered.push(r.key);
    // Typed substitution (the right kind of B record), then every other B id in each tenant-owned param.
    const attempts: Record<string, string>[] = [Object.fromEntries(entries.map(([n, k]) => [n, idFor(w, k, w.b)]))];
    for (const [name, k] of entries) {
      if (!kinds.has(k)) continue;
      for (const other of w.b.allIds) attempts.push({ ...Object.fromEntries(entries.map(([n, kk]) => [n, idFor(w, kk, w.a)])), [name]: other });
    }
    for (const params of attempts) {
      for (const who of [w.a.admin, w.a.member]) {
        const path = fillPath(r.pattern, params);
        const res = await call(who.c, r, path);
        const body = await res.text();
        if (res.status !== 403 && res.status !== 404) problems.push(`${r.key} ${path} → ${await describe(res)}`);
        const leaks = leakedFrom(body.replaceAll(path, ""), w.b);
        if (leaks.length) problems.push(`${r.key} ${path} leaked ${leaks.join(", ")}`);
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(covered.length >= 29, `covered ${covered.length} id-addressed customer routes`);
  assert.deepEqual(notTenant.sort(), ["GET /checkout/:packageId", "GET /checkout/maintenance/:planId", "POST /checkout/:packageId", "POST /checkout/maintenance/:planId", "POST /q/:token/accept"],
    "only catalogue-addressed routes and the emailed proposal token are outside the tenant matrix");
  // A proposal is bound to the lead's email address: another organization's administrator holding the link cannot accept it.
  const orders0 = (w.db as SqliteDb).raw.prepare(`SELECT COUNT(*) AS n FROM orders`).get() as { n: number };
  assert.equal((await w.a.admin.c.post(`/q/${w.ids.quoteToken}/accept`, { agree: "1" })).status, 403);
  assert.deepEqual((w.db as SqliteDb).raw.prepare(`SELECT COUNT(*) AS n FROM orders`).get(), orders0);
  assert.equal(appErrors(w.db), errors0, "no cross-tenant attempt produced a server error");
  assert.deepEqual(changedTables(bBefore, tenantRows(w.db, w.b)), [], "no record of tenant B changed");
  assert.deepEqual(crossTenantLinks(w.db), []);

  // Positive control: B is served every one of those GET pages with its own ids, so A's 404s are isolation.
  const served: string[] = [];
  for (const r of all.filter((x) => x.method === "GET" && covered.includes(x.key))) {
    const res = await w.b.admin.c.get(pathFor(w, r, w.b));
    if (res.status !== 200) served.push(`${r.key} → ${res.status}`);
  }
  assert.deepEqual(served, []);
});

test("[AUTH-008] every customer page, list and data export served to A (also with ?org=<B>) contains none of B's records", async () => {
  const problems: string[] = [];
  const gets = classified().filter((r) => customerSide(r) && r.method === "GET" && !Object.values(r.spec.params ?? {}).some((k) => k === "package" || k === "plan"));
  for (const who of [w.a.admin, w.a.member]) {
    for (const r of gets) {
      for (const suffix of ["", `${r.spec.query ? "&" : "?"}org=${w.b.orgId}`]) {
        const path = pathFor(w, r, w.a) + suffix;
        const res = await who.c.get(path);
        if (res.status !== 200) { problems.push(`${r.key} ${path} → ${res.status}`); continue; }
        const leaks = leakedFrom(await res.text(), w.b);
        if (leaks.length) problems.push(`${r.key} ${path} leaked ${leaks.join(", ")}`);
      }
    }
    // The personal data export (SEC-006) is a JSON download: it must not include the other tenant.
    const exp = await who.c.post("/account/privacy/export");
    assert.equal(exp.status, 200);
    const leaks = leakedFrom(await exp.text(), w.b);
    if (leaks.length) problems.push(`privacy export leaked ${leaks.join(", ")}`);
  }
  assert.deepEqual(problems, []);
  // A sanity check that the marker detection works: A's own pages do show A's records.
  assert.match(await (await w.a.admin.c.get("/portal/projects")).text(), new RegExp(w.a.marker));
});

test("[AUTH-008] staff with assigned-only access are denied every project-scoped record of projects they are not assigned to", async () => {
  // The developer is assigned to tenant A's project only (project.read_assigned). Every staff route that
  // addresses a record of B's project must be refused, while the same route on A's project is reachable.
  const dev = w.staff.developer.c;
  const projectKinds = new Set<ResourceKind>(["project", "task", "task2", "milestone", "revision", "file", "assignment"]);
  const errors0 = appErrors(w.db);
  const bBefore = tenantRows(w.db, w.b);
  const problems: string[] = [];
  let n = 0;
  for (const r of classified().filter((x) => x.spec.access.kind === "staff" || (x.spec.access.kind === "customer" && x.spec.access.staffToo))) {
    const roles = r.spec.access.kind === "staff" ? r.spec.access.roles : ["developer"];
    if (!roles.includes("developer") || !Object.values(r.spec.params ?? {}).some((k) => projectKinds.has(k))) continue;
    n++;
    const res = await call(dev, r, pathFor(w, r, w.b));
    if (res.status !== 403 && res.status !== 404) problems.push(`${r.key} (B) → ${await describe(res)}`);
    if (r.method === "GET") {
      const own = await dev.get(pathFor(w, r, w.a));
      if (own.status !== 200) problems.push(`${r.key} (A, assigned) → ${await describe(own)}`);
    }
  }
  assert.ok(n >= 8, `checked ${n} routes`);
  assert.deepEqual(problems, []);
  assert.equal(appErrors(w.db), errors0);
  assert.deepEqual(changedTables(bBefore, tenantRows(w.db, w.b)), [], "no record of tenant B changed");
  assert.ok(toLogin(await w.anon().get(`/portal/projects/${w.b.ids.project}`)));
  // Lists and exports apply the same scoping: the developer's views show A's project and never B's.
  for (const p of ["/staff/projects?status=all", "/staff/projects/export.csv?status=all", "/staff/tasks?status=all", "/staff/tasks/export.csv?status=all", "/staff/reports/operations/summary.csv", "/staff"]) {
    const res = await dev.get(p);
    assert.equal(res.status, 200, p);
    const body = await res.text();
    assert.deepEqual(leakedFrom(body, w.b), [], `${p} shows tenant B's records to an unassigned developer`);
  }
  assert.match(await (await dev.get("/staff/projects/export.csv?status=all")).text(), new RegExp(w.a.ids.project!));
});

test("[AUTH-008] ids smuggled into form fields cannot attach A's actions to B's records", async () => {
  // Runs last in this file: it performs real customer actions (uploads, deletes, approvals) on tenant A.
  const errors0 = appErrors(w.db);
  const bBefore = tenantRows(w.db, w.b);
  const smuggle: Record<string, ResourceKind> = {
    project_id: "project", payment_id: "payment", invoice_id: "invoice", file_id: "file", documentation_file_id: "file", attachment_file_id: "file",
    subject_id: "revision", ticket_id: "ticket", change_order_id: "changeOrder", revision_id: "revision", organization_id: "org", org: "org", share_link_id: "shareLink",
  };
  const fields = customerPostFields(w, w.a);
  const attempted: string[] = [];
  // Own-account routes (/account/*) act only on the caller's user and carry no record ids; they are excluded
  // here because revoking the caller's own session would end the run.
  for (const r of classified().filter((x) => customerSide(x) && x.method === "POST" && !x.pattern.startsWith("/account/"))) {
    const base = fields[r.key];
    assert.ok(base, `${r.key}: no valid body in tests/support/security-scenarios.ts`);
    const injected: Record<string, string | string[] | File> = { ...base() };
    for (const [f, k] of Object.entries(smuggle)) injected[f] = idFor(w, k, w.b);
    // ?org= selects among the caller's OWN organizations only; naming B's must not switch A into B.
    const res = await w.a.admin.c.post(`${pathFor(w, r, w.a)}?org=${w.b.orgId}`, injected);
    attempted.push(`${r.key} → ${res.status} ${res.headers.get("location") ?? ""}`);
    assert.ok(res.status < 500 && !toLogin(res), `${r.key} → ${res.status} ${res.headers.get("location")}`);
  }
  assert.ok(attempted.length >= 24, attempted.join("\n"));
  assert.equal(appErrors(w.db), errors0);
  assert.deepEqual(changedTables(bBefore, tenantRows(w.db, w.b)), [], "no record of tenant B changed");
  assert.deepEqual(crossTenantLinks(w.db), [], "no row links A's records to B's");
  // The detector itself works: a message of A pointing at B's project is reported (inserted and rolled back).
  const rawDb = (w.db as SqliteDb).raw;
  rawDb.exec("BEGIN");
  try {
    rawDb.prepare(`INSERT INTO messages (id, organization_id, project_id, author_user_id, body, created_at) VALUES ('msg_detector', ?, ?, ?, 'x', ?)`).run(w.a.orgId, w.b.ids.project!, w.a.admin.id, new Date().toISOString());
    assert.ok(crossTenantLinks(w.db).some((p) => p.startsWith("messages.project_id")));
  } finally { rawDb.exec("ROLLBACK"); }
  const raw = (w.db as SqliteDb).raw;
  assert.equal((raw.prepare(`SELECT COUNT(*) AS n FROM refunds WHERE payment_id = ? AND organization_id = ?`).get(w.b.ids.payment!, w.a.orgId) as { n: number }).n, 0);
  assert.equal((raw.prepare(`SELECT COUNT(*) AS n FROM messages WHERE organization_id = ? AND attachment_file_id IN (SELECT id FROM files WHERE organization_id = ?)`).get(w.a.orgId, w.b.orgId) as { n: number }).n, 0);
});

test("[AUTH-008] staff forms acting on one customer's records cannot link them to another customer's records", async () => {
  // The Owner (who may see every tenant) edits tenant A's project, tasks, milestones and handoff with tenant B's
  // ids in every id-carrying field. Each service must refuse the foreign record or ignore it.
  const smuggle: Record<string, ResourceKind> = {
    documentation_file_id: "file", attachment_file_id: "file", revision_id: "revision", subject_id: "revision", milestone_id: "milestone",
    depends_on: "task", task_id: "task", ticket_id: "ticket", change_order_id: "changeOrder", invoice_id: "invoice", payment_id: "payment",
  };
  const staffBodies = new Map(auditScenarios(w).filter((s) => s.fields && s.key.includes("/staff/")).map((s) => [s.key, s.fields!]));
  const errors0 = appErrors(w.db);
  let n = 0;
  for (const r of classified().filter((x) => x.method === "POST" && x.spec.access.kind === "staff" && staffBodies.has(x.key))) {
    const kinds = Object.values(r.spec.params ?? {});
    if (!kinds.some((k) => ["project", "task", "task2", "milestone", "revision", "ticket"].includes(k))) continue;
    let body: Record<string, string | string[] | File>;
    try { body = { ...staffBodies.get(r.key)!(w) }; } catch { continue; }
    for (const [f, k] of Object.entries(smuggle)) body[f] = idFor(w, k, w.b);
    const res = await w.staff.owner.c.post(pathFor(w, r, w.a), body); n++;
    assert.ok(res.status < 500, `${r.key} → ${res.status}`);
  }
  assert.ok(n >= 15, `checked ${n} staff forms`);
  assert.equal(appErrors(w.db), errors0);
  assert.deepEqual(crossTenantLinks(w.db), [], "no row links A's records to B's");
  // Detector self-check for link tables: a dependency between A's and B's tasks is reported (rolled back).
  const rawDb = (w.db as SqliteDb).raw;
  rawDb.exec("BEGIN");
  try {
    rawDb.prepare(`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`).run(w.a.ids.task2!, w.b.ids.task!);
    assert.ok(crossTenantLinks(w.db).some((p) => p.startsWith("task_dependencies")));
  } finally { rawDb.exec("ROLLBACK"); }
});
