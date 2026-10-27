// Owner command-center platform modules (support, email, AI, security, backups, settings, voice,
// operational reports) exercised through the real request pipeline. All records are TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD } from "./support/app.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import type { Env } from "../src/app/context.ts";

type App = Awaited<ReturnType<typeof createTestApp>>;
async function staffClient(t: App, role: Parameters<typeof createStaff>[1], email?: string) {
  const s = await createStaff(t.db, role, email);
  const c = await t.client().login(s.email, TEST_PASSWORD, s.secret);
  return { ...s, c };
}
const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;
const auditCount = async (db: Env["DB"], action: string) => (await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?`, action)).n;

test("[SUP-002] support queue exports the filtered queue as CSV with first-response timing (audited, permission-checked)", async () => {
  const t = await createTestApp();
  const cust = await createCustomer(t.db, "help@cust.example", "Help Co");
  const mk = (subject: string, status: string, priority: string, created: string, first: string | null) => t.db.prepare(`INSERT INTO tickets (id, organization_id, subject, category, priority, status, opened_by, first_response_at, created_at, updated_at) VALUES (?,?,?, 'technical', ?, ?, ?, ?, ?, ?)`)
    .bind(newId("tkt"), cust.organizationId, subject, priority, status, cust.id, first, created, created).run();
  await mk("Site down", "open", "urgent", "2026-10-01T10:00:00.000Z", "2026-10-01T12:00:00.000Z");
  await mk("Old question", "closed", "low", "2026-09-01T10:00:00.000Z", null);
  const sup = await staffClient(t, "support");
  assert.match(await (await sup.c.get("/staff/support")).text(), /Export CSV/);
  const csv = await (await sup.c.get("/staff/support/export.csv")).text();
  assert.match(csv, /^ticket_id,opened,customer,subject/);
  assert.match(csv, /Site down,technical,urgent,open,,2026-10-01T12:00:00.000Z,2,/);
  assert.doesNotMatch(csv, /Old question/, "default 'active' filter applies to the export");
  assert.match(await (await sup.c.get("/staff/support/export.csv?status=all")).text(), /Old question/);
  assert.equal(await auditCount(t.db, "ticket.exported"), 2);
  const sales = await staffClient(t, "sales");
  assert.equal((await sales.c.get("/staff/support/export.csv")).status, 403);
});

test("[EMAIL-003] email delivery log filters by date and exports CSV; dev-outbox rows are never reported as sent", async () => {
  const t = await createTestApp();
  const owner = await staffClient(t, "owner");
  const mk = async (template: string, to: string, status: string, created: string, provider: string) => {
    const id = newId("dlv");
    await t.db.prepare(`INSERT INTO email_deliveries (id, template, to_email, idempotency_key, status, attempts, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)`).bind(id, template, to, id, status, created, created).run();
    await t.db.prepare(`INSERT INTO email_messages (delivery_id, provider, subject, html_body, text_body) VALUES (?,?,?,?,?)`).bind(id, provider, `Subject for ${to}`, "<p>x</p>", "x").run();
  };
  await mk("registration", "early@x.example", "queued", "2026-09-01T00:00:00.000Z", "dev-outbox");
  await mk("invoice", "late@x.example", "failed", "2026-10-20T00:00:00.000Z", "resend");
  const page = await (await owner.c.get("/staff/email?from=2026-10-01&until=2026-10-31")).text();
  assert.match(page, /late@x\.example/);
  assert.doesNotMatch(page, /early@x\.example/);
  const csv = await (await owner.c.get("/staff/email/export.csv")).text();
  assert.match(csv, /^delivery_id,created_at/);
  assert.match(csv, /early@x\.example,Subject for early@x\.example,dev-outbox,dev_outbox_not_sent/);
  assert.match(csv, /late@x\.example,[^\n]*,resend,failed/);
  assert.equal(await auditCount(t.db, "email.log_exported"), 1);
  const sup = await staffClient(t, "support");
  assert.equal((await sup.c.get("/staff/email/export.csv")).status, 403);
});

test("[AIOPS-001] AI jobs export keeps unknown cost distinct from zero and honours filters", async () => {
  const t = await createTestApp();
  const admin = await staffClient(t, "administrator");
  const at = nowIso();
  await t.db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, cost_microusd, retries, created_at, updated_at) VALUES ('aij_known','lead_qualification','anthropic','m','approved','lead:1',2500,0,?,?)`).bind(at, at).run();
  await t.db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, cost_microusd, error, retries, created_at, updated_at) VALUES ('aij_fail','support_reply','anthropic','m','failed','ticket:1',NULL,'not_configured',0,?,?)`).bind(at, at).run();
  const csv = await (await admin.c.get("/staff/ai/export.csv")).text();
  assert.match(csv, /aij_known,[^\n]*,0\.002500,known,/);
  assert.match(csv, /aij_fail,[^\n]*,,unknown,0,,,not_configured/);
  const failedOnly = await (await admin.c.get("/staff/ai/export.csv?status=failed")).text();
  assert.doesNotMatch(failedOnly, /aij_known/);
  assert.equal(await auditCount(t.db, "ai.jobs_exported"), 2);
  const dev = await staffClient(t, "developer");
  assert.equal((await dev.c.get("/staff/ai/export.csv")).status, 403);
});

test("[AUTH-005] security events export applies the page filters and is audited", async () => {
  const t = await createTestApp();
  const owner = await staffClient(t, "owner");
  await t.db.prepare(`INSERT INTO security_events (kind, email, ip, detail, created_at) VALUES ('login_failed','x@y.example','203.0.113.5','bad password','2026-10-10T00:00:00.000Z')`).run();
  await t.db.prepare(`INSERT INTO security_events (kind, email, ip, detail, created_at) VALUES ('rate_limited','z@y.example','203.0.113.9','burst','2026-10-11T00:00:00.000Z')`).run();
  const csv = await (await owner.c.get("/staff/security/events.csv?kind=login_failed")).text();
  assert.match(csv, /^id,created_at,kind/);
  assert.match(csv, /login_failed,,x@y\.example,203\.0\.113\.5,bad password/);
  assert.doesNotMatch(csv, /rate_limited/);
  assert.equal(await auditCount(t.db, "security.events_exported"), 1);
  const sales = await staffClient(t, "sales");
  assert.equal((await sales.c.get("/staff/security/events.csv")).status, 403);
});

test("[OWN-003] business settings validate recovery targets and the receptionist number; backups and voice pages read them instead of hardcoded values", async () => {
  const t = await createTestApp();
  const owner = await staffClient(t, "owner");
  const base = { "business.legal_name": "", "business.address": "", "contact.email": "", "contact.phone": "", staffed_hours: "Mon–Fri 9am–5pm ET", first_response_target_hours: "8" };
  const backups0 = await (await owner.c.get("/staff/backups")).text();
  assert.match(backups0, /Recovery targets<\/div><div class="kpi__value">Not set/);
  assert.doesNotMatch(backups0, /RPO 24 h/);
  assert.match(backups0, /No passed restore drill is recorded/);
  assert.match(await (await owner.c.get("/staff/voice")).text(), /None recorded/);

  const bad = await owner.c.post("/staff/settings", { ...base, "backup.rpo_target_hours": "0", "backup.rto_target_hours": "4.5", "voice.phone_number": "call me" });
  assert.equal(bad.status, 422);
  const text = await bad.text();
  assert.match(text, /Recovery point objective must be a whole number/);
  assert.match(text, /Recovery time objective must be a whole number/);
  assert.match(text, /valid receptionist phone number/);
  assert.equal((await owner.c.post("/staff/settings", { ...base, "business.legal_name": "<b>Acme</b>" })).status, 422);

  assert.equal((await owner.c.post("/staff/settings", { ...base, "backup.rpo_target_hours": "24", "backup.rto_target_hours": "4", "voice.phone_number": "+1 517 555 0100" })).status, 303);
  const changed = JSON.parse((await one<{ details_json: string }>(t.db, `SELECT details_json FROM audit_logs WHERE action = 'settings.updated' ORDER BY id DESC LIMIT 1`)).details_json);
  assert.ok(changed.changed.includes("backup.rpo_target_hours"));
  const s = await staffClient(t, "administrator", "adm@crestmont.test");
  await t.db.prepare(`INSERT INTO restore_tests (id, what, target, environment, performed_at, performed_by, result, duration_minutes, data_loss_minutes, evidence, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(newId("rst"), "D1 export", "scratch db", "development", "2026-10-20T10:00:00.000Z", s.id, "passed", 300, 30, "row counts matched", nowIso()).run();
  const backups = await (await owner.c.get("/staff/backups")).text();
  assert.match(backups, /RPO 24 h · RTO 4 h/);
  assert.match(backups, /restore time 300 min EXCEEDS the 4 h target/);
  assert.match(backups, /data-loss window 30 min within the 24 h target/);
  assert.match(await (await owner.c.get("/staff/voice")).text(), /\+1 517 555 0100/);
});

test("[OWN-001] operational reports: range summary counted from records, permission-filtered exports, audited summary and time CSVs", async () => {
  const t = await createTestApp();
  const owner = await staffClient(t, "owner");
  const cust = await createCustomer(t.db, "ops@cust.example", "Ops Co");
  const pid = newId("prj");
  await t.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(pid, cust.organizationId, "Ops site", "completed", 3, "upfront", "2026-10-02T00:00:00.000Z", nowIso(), "2026-10-15T00:00:00.000Z").run();
  await t.db.prepare(`INSERT INTO tasks (id, project_id, title, status, created_at, completed_at) VALUES ('t_ops', ?, 'Ship it', 'done', ?, '2026-10-14T00:00:00.000Z')`).bind(pid, nowIso()).run();
  await t.db.prepare(`INSERT INTO time_entries (id, task_id, user_id, minutes, worked_on) VALUES ('te_ops','t_ops',?,90,'2026-10-14')`).bind(owner.id).run();
  await t.db.prepare(`INSERT INTO tickets (id, organization_id, subject, category, priority, status, opened_by, first_response_at, resolved_at, created_at, updated_at) VALUES ('tk1',?,'Q','other','normal','resolved',?,'2026-10-05T03:00:00.000Z','2026-10-06T00:00:00.000Z','2026-10-05T00:00:00.000Z','2026-10-06T00:00:00.000Z')`).bind(cust.organizationId, cust.id).run();

  const page = await (await owner.c.get("/staff/reports/operations?from=2026-10-01&to=2026-10-31")).text();
  const row = (label: string) => new RegExp(`<td>${label}</td><td class="num">([^<]+)</td>`).exec(page)?.[1];
  assert.equal(row("Projects completed"), "1");
  assert.equal(row("Tasks completed"), "1");
  assert.equal(row("Time logged"), "1.5 h");
  assert.equal(row("Support tickets resolved"), "1");
  assert.equal(row("Median first response"), "3.0 h");
  assert.match(page, /\/staff\/reports\/operations\/time\.csv\?from=2026-10-01&amp;to=2026-10-31/);
  const empty = await (await owner.c.get("/staff/reports/operations?from=2025-01-01&to=2025-01-31")).text();
  assert.match(empty, /<td>Median first response<\/td><td class="num">Unknown<\/td>/);

  const summary = await (await owner.c.get("/staff/reports/operations/summary.csv?from=2026-10-01&to=2026-10-31")).text();
  assert.match(summary, /2026-10-01,2026-10-31,projects_completed,1,count/);
  const time = await (await owner.c.get("/staff/reports/operations/time.csv?from=2026-10-01&to=2026-10-31")).text();
  assert.match(time, /te_ops,2026-10-14,[^\n]*,90,1\.50,t_ops,Ship it/);
  assert.equal(await auditCount(t.db, "report.operations_exported"), 1);
  assert.equal(await auditCount(t.db, "report.time_exported"), 1);

  // A developer sees only delivery figures and cannot download other modules' exports.
  const dev = await staffClient(t, "developer");
  const devPage = await (await dev.c.get("/staff/reports/operations?from=2026-10-01&to=2026-10-31")).text();
  assert.match(devPage, /Tasks completed/);
  assert.doesNotMatch(devPage, /<td>Leads created<\/td>/);
  assert.match(devPage, /Not permitted for your role/);
  assert.equal((await dev.c.get("/staff/reports/operations/time.csv")).status, 403);
  assert.doesNotMatch(await (await dev.c.get("/staff/reports/operations/summary.csv?from=2026-10-01&to=2026-10-31")).text(), /leads_created/);
  assert.equal((await (await t.client().login(cust.email)).get("/staff/reports/operations")).status, 403);
});
