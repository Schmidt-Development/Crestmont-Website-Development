import { test } from "node:test";
import { STRIPE_WEBHOOK_EVENTS } from "../src/domain/stripe-events.ts";
import { STRIPE_API_VERSION } from "../src/adapters/payments.ts";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, lastEmail, linkFrom, TEST_PASSWORD } from "./support/app.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import { verifyIntegration, refreshIntegrationHealth, secretPresence } from "../src/services/integrations.ts";
import { recordAppError } from "../src/services/monitoring.ts";
import { csvCell } from "../src/routes/platform.ts";
import { EMAIL_TEMPLATES } from "../src/services/mailer.ts";
import type { Env } from "../src/app/context.ts";

async function staffClient(app: Awaited<ReturnType<typeof createTestApp>>, role: Parameters<typeof createStaff>[1], email?: string) {
  const s = await createStaff(app.db, role, email);
  const c = await app.client().login(s.email, TEST_PASSWORD, s.secret);
  return { s, c };
}

const fakeFetch = (handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const r = handler(String(url), init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

// ── Employees ──
test("[EMP-001] administrator cannot change the Owner's role, grant owner, or disable the Owner", async () => {
  const app = await createTestApp();
  const owner = await createStaff(app.db, "owner");
  const { c: admin } = await staffClient(app, "administrator");
  const dev = await createStaff(app.db, "developer");
  assert.equal((await admin.post(`/staff/employees/${owner.id}/role`, { role: "support" })).status, 403);
  assert.equal((await admin.post(`/staff/employees/${owner.id}/disable`, { reason: "attempt" })).status, 403);
  assert.equal((await admin.post(`/staff/employees/${dev.id}/role`, { role: "owner" })).status, 403);
  const inv = await admin.post("/staff/employees/invite", { email: "new@crestmont.test", role: "owner" });
  assert.equal(inv.status, 422);
  const roles = (await app.db.prepare(`SELECT role_id FROM memberships WHERE user_id IN (?, ?) ORDER BY role_id`).bind(owner.id, dev.id).all<{ role_id: string }>()).results.map((r) => r.role_id);
  assert.deepEqual(roles, ["developer", "owner"]);
  assert.equal((await app.db.prepare(`SELECT disabled_at FROM users WHERE id = ?`).bind(owner.id).first<{ disabled_at: string | null }>())!.disabled_at, null);
});

test("[EMP-002] role change is audited and revokes the target's sessions", async () => {
  const app = await createTestApp();
  const { c: admin } = await staffClient(app, "administrator");
  const { s: dev, c: devClient } = await staffClient(app, "developer");
  assert.equal((await devClient.get("/staff/employees")).status, 403);
  const res = await admin.post(`/staff/employees/${dev.id}/role`, { role: "project_manager" });
  assert.equal(res.status, 303);
  const m = await app.db.prepare(`SELECT role_id FROM memberships WHERE user_id = ?`).bind(dev.id).first<{ role_id: string }>();
  assert.equal(m!.role_id, "project_manager");
  const a = await app.db.prepare(`SELECT details_json FROM audit_logs WHERE action = 'employee.role_changed' AND subject_id = ?`).bind(dev.id).first<{ details_json: string }>();
  assert.deepEqual(JSON.parse(a!.details_json), { from: "developer", to: "project_manager" });
  assert.equal((await devClient.get("/staff")).status, 303, "old session no longer works");
});

test("[EMP-002] disabling a user revokes all sessions; re-enabling restores sign-in", async () => {
  const app = await createTestApp();
  const { c: admin } = await staffClient(app, "administrator");
  const { s: sup, c: supClient } = await staffClient(app, "support");
  assert.equal((await supClient.get("/account")).status, 200);
  const missing = await admin.post(`/staff/employees/${sup.id}/disable`, { reason: "" });
  assert.equal(missing.status, 303);
  assert.equal((await app.db.prepare(`SELECT disabled_at FROM users WHERE id = ?`).bind(sup.id).first<{ disabled_at: string | null }>())!.disabled_at, null, "reason required");
  assert.equal((await admin.post(`/staff/employees/${sup.id}/disable`, { reason: "Left the company" })).status, 303);
  const open = await app.db.prepare(`SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL`).bind(sup.id).first<{ n: number }>();
  assert.equal(open!.n, 0);
  assert.equal((await supClient.get("/account")).status, 303);
  const login = await app.client().post("/login", { email: sup.email, password: TEST_PASSWORD });
  assert.equal(login.status, 400, "disabled account cannot sign in");
  assert.match(await login.text(), /Email or password is incorrect/);
  assert.ok(await app.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'employee.disabled' AND subject_id = ?`).bind(sup.id).first());
  assert.equal((await admin.post(`/staff/employees/${sup.id}/enable`)).status, 303);
  await app.client().login(sup.email, TEST_PASSWORD, sup.secret);
});

test("[AUTH-006] staff invitation sends a staff_invitation email with a working /invite link", async () => {
  const app = await createTestApp();
  const { c: admin } = await staffClient(app, "administrator");
  const res = await admin.post("/staff/employees/invite", { email: "Dana@Crestmont.test", role: "sales" });
  assert.equal(res.status, 303);
  const mail = await lastEmail(app.db, "dana@crestmont.test");
  assert.equal(mail?.template, "staff_invitation");
  const link = linkFrom(mail!.text_body, "/invite");
  const page = await app.client().get(link);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Sales/);
  const list = await (await admin.get("/staff/employees")).text();
  assert.match(list, /dana@crestmont\.test/);
});

test("[EMP-003] employees page shows MFA status, sessions and assignment workload", async () => {
  const app = await createTestApp();
  const { c: owner } = await staffClient(app, "owner");
  const dev = await createStaff(app.db, "developer");
  const cust = await createCustomer(app.db, "wl@cust.example", "Workload Co");
  const pid = newId("prj");
  await app.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(pid, cust.organizationId, "WL site", "development", 3, "upfront", nowIso(), nowIso()).run();
  await app.db.prepare(`INSERT INTO tasks (id, project_id, title, status, estimate_minutes, due_at, created_at) VALUES ('t1', ?, 'Build header', 'todo', 90, '2020-01-01', ?)`).bind(pid, nowIso()).run();
  await app.db.prepare(`INSERT INTO assignments (id, subject_type, subject_id, user_id, created_at) VALUES (?,?,?,?,?)`).bind(newId("asg"), "task", "t1", dev.id, nowIso()).run();
  await app.db.prepare(`UPDATE users SET totp_secret = NULL WHERE id = ?`).bind(dev.id).run();
  const html = await (await owner.get("/staff/employees")).text();
  assert.match(html, /1 task <span class="badge[^"]*">1 overdue/);
  assert.match(html, /1\.5 h/);
  assert.match(html, /Not enrolled/);
  assert.match(html, /Owner — protected/);
});

// ── Authorization on every page ──
test("[EMP-002] non-permitted roles get 403 on every platform page", async () => {
  const app = await createTestApp();
  const { c: dev } = await staffClient(app, "developer");
  const { c: sales } = await staffClient(app, "sales");
  const pages = ["/staff/employees", "/staff/email", "/staff/email/templates", "/staff/integrations", "/staff/monitoring", "/staff/security", "/staff/audit", "/staff/audit/export.csv", "/staff/backups", "/staff/settings", "/staff/ai", "/staff/voice"];
  for (const p of pages) {
    assert.equal((await dev.get(p)).status, 403, `developer ${p}`);
    assert.equal((await sales.get(p)).status, 403, `sales ${p}`);
  }
  const cust = await createCustomer(app.db);
  const cc = await app.client().login(cust.email);
  for (const p of pages) assert.equal((await cc.get(p)).status, 403, `customer ${p}`);
  assert.equal((await app.client().get("/staff/audit")).status, 303, "anonymous redirected to login");
  // Administrators: everything except voice.manage
  const { c: admin } = await staffClient(app, "administrator");
  for (const p of pages.filter((x) => x !== "/staff/voice")) assert.equal((await admin.get(p)).status, 200, `admin ${p}`);
  assert.equal((await admin.get("/staff/voice")).status, 403);
  const { c: owner } = await staffClient(app, "owner");
  assert.equal((await owner.get("/staff/voice")).status, 200);
});

// ── Integrations ──
test("[INFRA-006] integration verify marks verified only after a successful fake provider call", async () => {
  const app = await createTestApp();
  const env: Env = { ...app.env, STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_WEBHOOK_SECRET: "whsec_x" };
  const calls: string[] = [];
  const endpoint = { url: "http://crestmont.test/api/webhooks/stripe", status: "enabled", api_version: STRIPE_API_VERSION, enabled_events: [...STRIPE_WEBHOOK_EVENTS] };
  const ok = fakeFetch((u) => { calls.push(u); return u.includes("webhook_endpoints") ? { status: 200, body: { data: [endpoint] } } : { status: 200, body: { object: "balance", livemode: false } }; });
  await refreshIntegrationHealth({ db: app.db, env, storage: null });
  const before = await app.db.prepare(`SELECT status FROM integration_health WHERE integration = 'stripe' AND environment = 'development'`).first<{ status: string }>();
  assert.equal(before!.status, "configured_unverified");
  const res = await verifyIntegration({ db: app.db, env, storage: null, fetchImpl: ok }, "stripe", null);
  assert.equal(res.status, "verified");
  assert.deepEqual(calls, ["https://api.stripe.com/v1/balance", "https://api.stripe.com/v1/webhook_endpoints?limit=100"]);
  const row = await app.db.prepare(`SELECT status, verified_at FROM integration_health WHERE integration = 'stripe' AND environment = 'development'`).first<{ status: string; verified_at: string | null }>();
  assert.equal(row!.status, "verified");
  assert.ok(row!.verified_at);
  // Refresh keeps verification while the key is unchanged, drops it when the key changes.
  await refreshIntegrationHealth({ db: app.db, env, storage: null });
  assert.equal((await app.db.prepare(`SELECT status FROM integration_health WHERE integration = 'stripe'`).first<{ status: string }>())!.status, "verified");
  await refreshIntegrationHealth({ db: app.db, env: { ...env, STRIPE_SECRET_KEY: "sk_test_other" }, storage: null });
  assert.equal((await app.db.prepare(`SELECT status FROM integration_health WHERE integration = 'stripe'`).first<{ status: string }>())!.status, "configured_unverified");
  // CREST-GAP-017: a missing endpoint, wrong API version or missing event is reported, never "verified".
  const noEndpoint = fakeFetch((u) => (u.includes("webhook_endpoints") ? { status: 200, body: { data: [] } } : { status: 200, body: { object: "balance", livemode: false } }));
  const ne = await verifyIntegration({ db: app.db, env, storage: null, fetchImpl: noEndpoint }, "stripe", null);
  assert.equal(ne.status, "degraded");
  assert.match(ne.detail, /no webhook endpoint is registered for http:\/\/crestmont\.test\/api\/webhooks\/stripe/);
  const oldVersion = fakeFetch((u) => (u.includes("webhook_endpoints") ? { status: 200, body: { data: [{ ...endpoint, api_version: "2023-10-16" }] } } : { status: 200, body: { object: "balance", livemode: false } }));
  assert.match((await verifyIntegration({ db: app.db, env, storage: null, fetchImpl: oldVersion }, "stripe", null)).detail, /expected 2025-02-24\.acacia/);
  const fewEvents = fakeFetch((u) => (u.includes("webhook_endpoints") ? { status: 200, body: { data: [{ ...endpoint, enabled_events: ["invoice.paid"] }] } } : { status: 200, body: { object: "balance", livemode: false } }));
  assert.match((await verifyIntegration({ db: app.db, env, storage: null, fetchImpl: fewEvents }, "stripe", null)).detail, /does not send: checkout\.session\.completed/);
  // Provider rejects → failing with the error.
  const bad = fakeFetch(() => ({ status: 401, body: { error: { message: "Invalid API Key provided" } } }));
  const f = await verifyIntegration({ db: app.db, env, storage: null, fetchImpl: bad }, "stripe", null);
  assert.equal(f.status, "failing");
  assert.match(f.detail, /401: Invalid API Key/);
  // Network error → failing.
  const boom = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
  assert.equal((await verifyIntegration({ db: app.db, env, storage: null, fetchImpl: boom }, "stripe", null)).status, "failing");
});

test("[INFRA-006] unconfigured integrations stay not_configured and cannot be probed; database probe is live", async () => {
  const app = await createTestApp();
  const d = { db: app.db, env: app.env, storage: null, fetchImpl: fakeFetch(() => ({ status: 200, body: {} })) };
  await assert.rejects(verifyIntegration(d, "stripe", null), /no verification probe/);
  await assert.rejects(verifyIntegration(d, "telephony", null), /no verification probe/);
  const rows = await refreshIntegrationHealth(d);
  for (const id of ["stripe", "resend", "ai", "voice", "telephony", "monitoring", "github", "turnstile", "object_storage"]) {
    assert.equal(rows.find((r) => r.integration === id)!.status, "not_configured", id);
  }
  assert.equal((await verifyIntegration(d, "database", null)).status, "verified");
  // Resend: valid key but official domain not verified → degraded, never verified.
  const resendEnv: Env = { ...app.env, RESEND_API_KEY: "re_test_123456789012" };
  const r = await verifyIntegration({ ...d, env: resendEnv, fetchImpl: fakeFetch(() => ({ status: 200, body: { data: [{ name: "other.com", status: "verified" }] } })) }, "resend", null);
  assert.equal(r.status, "degraded");
  // Live Stripe key is blocked without a network call.
  const rows2 = await refreshIntegrationHealth({ ...d, env: { ...app.env, STRIPE_SECRET_KEY: "sk_live_x" } });
  assert.equal(rows2.find((x) => x.integration === "stripe")!.status, "blocked");
});

test("[INFRA-006] POST /staff/integrations/:name/verify records the probe and is staff-only", async () => {
  const app = await createTestApp();
  const { c: admin } = await staffClient(app, "administrator");
  const res = await admin.post("/staff/integrations/database/verify");
  assert.equal(res.status, 303);
  const page = await (await admin.get("/staff/integrations")).text();
  assert.match(page, /SELECT 1 succeeded/);
  assert.equal((await admin.post("/staff/integrations/nope/verify")).status, 404);
  const { c: sales } = await staffClient(app, "sales");
  assert.equal((await sales.post("/staff/integrations/database/verify")).status, 403);
});

// ── Monitoring ──
test("[INFRA-006] recordAppError feeds the monitoring page; alerting is reported as not configured", async () => {
  const app = await createTestApp();
  await recordAppError(app.db, { path: "/staff/boom", message: "Exploded with sk_test_SECRETKEY123", stack: "Error: x\n at y" });
  const stored = await app.db.prepare(`SELECT message FROM app_errors`).first<{ message: string }>();
  assert.doesNotMatch(stored!.message, /SECRETKEY123/);
  const { c } = await staffClient(app, "administrator");
  const html = await (await c.get("/staff/monitoring")).text();
  assert.match(html, /\/staff\/boom/);
  assert.match(html, /Alerting: email to the Owners, no paging/, "the page states exactly which alerting exists");
  assert.match(html, /5xx errors \(24 h\)<\/div><div class="kpi__value">1</);
});

// ── Security ──
test("[SEC-004] security page lists secret names only, never values, and zero runtime dependencies", async () => {
  const app = await createTestApp({ STRIPE_SECRET_KEY: "sk_test_SUPERSECRETVALUE", EVIDENCE_INGEST_SECRET: "evidence-secret-value" });
  const { c } = await staffClient(app, "administrator");
  const html = await (await c.get("/staff/security")).text();
  assert.match(html, /STRIPE_SECRET_KEY/);
  assert.match(html, /0 runtime dependencies/);
  assert.doesNotMatch(html, /SUPERSECRETVALUE|evidence-secret-value/);
  const p = secretPresence(app.env);
  assert.equal(p.find((x) => x.name === "STRIPE_SECRET_KEY")!.present, true);
  assert.equal(p.find((x) => x.name === "RESEND_API_KEY")!.present, false);
});

test("[SEC-001] audit CSV export neutralises spreadsheet formulas and is itself audited", async () => {
  assert.equal(csvCell("=HYPERLINK(\"http://x\")"), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("-2"), "'-2");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("plain"), "plain");
  const app = await createTestApp();
  const { c } = await staffClient(app, "administrator");
  await app.db.prepare(`INSERT INTO audit_logs (actor_kind, action, subject_type, subject_id, details_json, created_at) VALUES ('system','test.formula','lead','=cmd|calc',?,?)`).bind(JSON.stringify({ note: "@evil" }), nowIso()).run();
  const res = await c.get("/staff/audit/export.csv?action=test.");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  const csv = await res.text();
  assert.match(csv, /,'=cmd\|calc,/);
  assert.doesNotMatch(csv, /,=cmd/);
  assert.equal(csv.trim().split("\n").length, 2, "filtered to the one matching row");
  assert.ok(await app.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'audit.exported'`).first());
});

test("[SEC-005] audit search filters by actor, action and date with pagination", async () => {
  const app = await createTestApp();
  const { s, c } = await staffClient(app, "administrator", "admin@crestmont.test");
  for (let i = 0; i < 30; i++) await app.db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, created_at) VALUES (?,'user','bulk.test','x',?)`).bind(s.id, nowIso()).run();
  const p1 = await (await c.get("/staff/audit?action=bulk.&actor=admin%40crestmont.test")).text();
  assert.equal((p1.match(/bulk\.test/g) ?? []).length, 25);
  assert.match(p1, /page=2/);
  const p2 = await (await c.get("/staff/audit?action=bulk.&page=2")).text();
  assert.equal((p2.match(/bulk\.test/g) ?? []).length, 5);
  const none = await (await c.get("/staff/audit?action=bulk.&from=2000-01-01&to=2000-01-02")).text();
  assert.match(none, /No audit entries match/);
});

// ── Settings ──
test("[OWN-003] settings warn about residential addresses, require confirmation, and apply to public pages", async () => {
  const app = await createTestApp();
  const { c } = await staffClient(app, "administrator");
  const page = await (await c.get("/staff/settings")).text();
  assert.match(page, /Never enter a home or residential address/);
  assert.match(page, /pricing is not editable here/);
  const base = { _x: "", "business.legal_name": "", "contact.email": "hello@crestmont.test", "contact.phone": "", staffed_hours: "Mon–Fri 9am–5pm ET", first_response_target_hours: "8" };
  const noConfirm = await c.post("/staff/settings", { ...base, "business.address": "100 Main St, Suite 4" });
  assert.equal(noConfirm.status, 422);
  const claim = await c.post("/staff/settings", { ...base, "business.address": "", staffed_hours: "24/7 live support" });
  assert.equal(claim.status, 422);
  const ok = await c.post("/staff/settings", { ...base, "business.address": "100 Main St, Suite 4", address_confirm: "1" });
  assert.equal(ok.status, 303);
  const sup = await app.db.prepare(`SELECT staffed_hours, first_response_target_hours FROM support_settings WHERE id = 1`).first<{ staffed_hours: string; first_response_target_hours: number }>();
  assert.deepEqual({ ...sup }, { staffed_hours: "Mon–Fri 9am–5pm ET", first_response_target_hours: 8 });
  assert.ok(await app.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'settings.updated'`).first());
  const pub = await (await app.client().get("/no-such-page")).text();
  assert.match(pub, /hello@crestmont\.test/);
  assert.match(pub, /Mon–Fri 9am–5pm ET/);
});

// ── Email ──
test("[EMAIL-002] template catalogue renders every template as a labelled preview", async () => {
  const app = await createTestApp();
  const { c } = await staffClient(app, "administrator");
  const html = await (await c.get("/staff/email/templates")).text();
  assert.match(html, /Preview only/);
  for (const t of EMAIL_TEMPLATES) assert.ok(html.includes(`/staff/email/templates/${t}/html`), t);
  const dl = await c.get("/staff/email/templates/invoice/html");
  assert.match(dl.headers.get("content-disposition") ?? "", /attachment/);
});

test("[EMAIL-003] delivery log shows the dev outbox escaped and refuses retry when Resend is absent", async () => {
  const app = await createTestApp();
  const { c } = await staffClient(app, "administrator");
  const id = newId("em");
  await app.db.prepare(`INSERT INTO email_deliveries (id, template, to_email, idempotency_key, status, attempts, last_error, created_at, updated_at) VALUES (?,?,?,?, 'failed', 5, 'Resend 500', ?, ?)`).bind(id, "invoice", "x@example.com", "k1", nowIso(), nowIso()).run();
  await app.db.prepare(`INSERT INTO email_messages (delivery_id, provider, subject, html_body, text_body) VALUES (?, 'resend', ?, ?, ?)`).bind(id, "Invoice <script>", "<b>hi</b><script>alert(1)</script>", "Body <script>x</script>").run();
  const list = await (await c.get("/staff/email?status=failed")).text();
  assert.match(list, /Invoice &lt;script&gt;/);
  const detail = await (await c.get(`/staff/email/${id}`)).text();
  assert.doesNotMatch(detail, /<script>x<\/script>|<script>alert/);
  assert.match(detail, /Body &lt;script&gt;x&lt;\/script&gt;/);
  assert.match(detail, /Retry is unavailable: Resend is not configured/);
  const retry = await c.post(`/staff/email/${id}/retry`);
  assert.equal(retry.status, 303);
  assert.equal((await app.db.prepare(`SELECT attempts FROM email_deliveries WHERE id = ?`).bind(id).first<{ attempts: number }>())!.attempts, 5, "no attempt made");
  const html = await c.get(`/staff/email/${id}/html`);
  assert.match(html.headers.get("content-disposition") ?? "", /attachment/);
  assert.match(html.headers.get("content-security-policy") ?? "", /default-src 'none'/);
});

// ── Backups ──
test("[INFRA-006] backup register states no automated backups and records backups and restore drills", async () => {
  const app = await createTestApp();
  const { s, c } = await staffClient(app, "administrator");
  const page = await (await c.get("/staff/backups")).text();
  assert.match(page, /No automated backups exist yet/);
  const bad = await c.post("/staff/backups/records", { what: "", location: "", environment: "staging", method: "d1_export", taken_at: "", result: "succeeded", evidence: "" });
  assert.equal(bad.status, 422);
  const ok = await c.post("/staff/backups/records", { what: "D1 dev export", location: "local disk ~/backups/dev.sql", environment: "development", method: "d1_export", taken_at: "2026-10-26T10:00", result: "succeeded", evidence: "wrangler d1 export output: 12 tables", verified_by: s.id, size_bytes: "2048" });
  assert.equal(ok.status, 303);
  const b = await app.db.prepare(`SELECT id, size_bytes, verified_by FROM backup_records`).first<{ id: string; size_bytes: number; verified_by: string }>();
  assert.equal(b!.size_bytes, 2048);
  const prod = await c.post("/staff/backups/restore-tests", { what: "dev db", target: "prod", environment: "production", performed_at: "2026-10-26T11:00", result: "passed", evidence: "row counts" });
  assert.equal(prod.status, 422, "drills never target production");
  const drill = await c.post("/staff/backups/restore-tests", { what: "dev db", target: "scratch sqlite file", environment: "development", backup_record_id: b!.id, performed_at: "2026-10-26T11:00", result: "passed", duration_minutes: "12", evidence: "row counts matched for 12 tables" });
  assert.equal(drill.status, 303);
  assert.ok(await app.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'backup.restore_test_recorded'`).first());
  assert.match(await (await c.get("/staff/backups")).text(), /12 min/);
});

// ── AI operations ──
test("[AIOPS-001] AI jobs page lists jobs with Unknown cost, and approve/reject uses decideAiJob", async () => {
  const app = await createTestApp();
  const { c } = await staffClient(app, "administrator");
  const at = nowIso();
  await app.db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, output_ref, cost_microusd, created_at, updated_at) VALUES ('ai_a','support_reply','anthropic','claude-sonnet-5-5','awaiting_approval','ticket:1','Draft reply',NULL,?,?)`).bind(at, at).run();
  await app.db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, output_ref, cost_microusd, created_at, updated_at) VALUES ('ai_b','quote_draft','anthropic','claude-sonnet-5-5','awaiting_approval','lead:1','Draft quote',1200,?,?)`).bind(at, at).run();
  const html = await (await c.get("/staff/ai")).text();
  assert.match(html, /Unknown/);
  assert.match(html, /\$0\.0012/);
  assert.match(html, /cannot<\/strong> issue or approve refunds/);
  assert.equal((await c.post("/staff/ai/ai_a/decide", { decision: "approved", final_text: "Edited reply" })).status, 303);
  assert.equal((await c.post("/staff/ai/ai_b/decide", { decision: "rejected" })).status, 303);
  const rows = (await app.db.prepare(`SELECT id, status, output_ref, approved_by FROM ai_jobs ORDER BY id`).all<{ id: string; status: string; output_ref: string; approved_by: string }>()).results;
  assert.equal(rows[0].status, "approved");
  assert.equal(rows[0].output_ref, "Edited reply");
  assert.equal(rows[1].status, "rejected");
  assert.ok(await app.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'ai.draft_approved' AND subject_id = 'ai_a'`).first());
  const again = await c.post("/staff/ai/ai_a/decide", { decision: "rejected" });
  assert.equal(again.status, 303);
  assert.equal((await app.db.prepare(`SELECT status FROM ai_jobs WHERE id = 'ai_a'`).first<{ status: string }>())!.status, "approved", "decided jobs cannot be re-decided");
});

test("[AIOPS-002] retrying a failed job without a provider fails honestly and records a new failed job", async () => {
  const app = await createTestApp();
  const { c } = await staffClient(app, "administrator");
  const { startAiJob } = await import("../src/services/monitoring.ts");
  const first = await startAiJob(app.db, null, { workflow: "project_summary", inputRef: "project:1", prompt: "Summarise", requestedBy: null });
  assert.equal(first.status, "failed");
  assert.match(first.error!, /not configured/);
  const page = await (await c.get("/staff/ai")).text();
  assert.match(page, /No AI backend is selected/);
  assert.match(page, /not_configured: no AI provider key is set/);
  const r = await c.post(`/staff/ai/${first.jobId}/retry`);
  assert.equal(r.status, 303);
  const jobs = (await app.db.prepare(`SELECT id, status, retry_of, retries FROM ai_jobs ORDER BY created_at, rowid`).all<{ id: string; status: string; retry_of: string | null; retries: number }>()).results;
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].retries, 1);
  assert.equal(jobs[1].retry_of, first.jobId);
  assert.equal(jobs[1].status, "failed");
  assert.equal(jobs.filter((j) => j.status !== "failed").length, 0, "nothing fabricated");
});

test("[AIOPS-003] AI actors never hold Founder-protected permissions", async () => {
  const { can } = await import("../src/domain/authz.ts");
  const ai = { kind: "ai" as const, roles: [{ role: "owner" as const, organizationId: "org_crestmont" }], mfaVerified: true };
  for (const p of ["refund.decide", "refund.issue", "pricing.change", "release.approve_production", "release.deploy_production", "security.exception"] as const) assert.equal(can(ai, p), false, p);
});

// ── Privacy ──
test("[SEC-006] privacy export contains only the requester's own organization data", async () => {
  const app = await createTestApp();
  const a = await createCustomer(app.db, "alice@example.com", "Alice Co");
  const b = await createCustomer(app.db, "bob@example.com", "Bob Co");
  const at = nowIso();
  for (const [org, name] of [[a.organizationId, "Alice Site"], [b.organizationId, "Bob Secret Site"]]) {
    await app.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES (?,?,?,'design',2,'upfront',?,?)`).bind(newId("prj"), org, name, at, at).run();
  }
  const tId = newId("tkt");
  await app.db.prepare(`INSERT INTO tickets (id, organization_id, subject, category, priority, status, opened_by, created_at, updated_at) VALUES (?,?,'Help','technical','normal','open',?,?,?)`).bind(tId, a.organizationId, a.id, at, at).run();
  await app.db.prepare(`INSERT INTO ticket_messages (id, ticket_id, body, internal, created_at) VALUES (?,?, 'STAFF ONLY NOTE', 1, ?)`).bind(newId("tm"), tId, at).run();
  const c = await app.client().login(a.email);
  const page = await c.get("/account/privacy");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /What is kept/);
  const res = await c.post("/account/privacy/export");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment/);
  const text = await res.text();
  const data = JSON.parse(text);
  assert.equal(data.profile.email, "alice@example.com");
  assert.match(text, /Alice Site/);
  assert.doesNotMatch(text, /Bob|bob@example\.com/);
  assert.doesNotMatch(text, /STAFF ONLY NOTE|password_hash|totp/);
  assert.ok(await app.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'privacy.export_generated' AND subject_id = ?`).bind(a.id).first());
});

test("[SEC-006] deletion request is processed by staff: anonymised, sessions revoked, financial records retained", async () => {
  const app = await createTestApp();
  const cust = await createCustomer(app.db, "leaving@example.com", "Leaving Co");
  const at = nowIso();
  await app.db.prepare(`INSERT INTO invoices (id, organization_id, amount_cents, status, created_at) VALUES ('inv_keep',?,99900,'paid',?)`).bind(cust.organizationId, at).run();
  const c = await app.client().login(cust.email);
  assert.equal((await c.post("/account/privacy/delete", { reason: "Closing business" })).status, 303);
  assert.equal((await app.db.prepare(`SELECT COUNT(*) n FROM privacy_requests WHERE user_id = ?`).bind(cust.id).first<{ n: number }>())!.n, 0, "confirmation required");
  assert.equal((await c.post("/account/privacy/delete", { reason: "Closing business", confirm: "1" })).status, 303);
  const req = await app.db.prepare(`SELECT id, status FROM privacy_requests WHERE user_id = ? AND kind = 'deletion'`).bind(cust.id).first<{ id: string; status: string }>();
  assert.equal(req!.status, "received");
  const { c: admin } = await staffClient(app, "administrator");
  assert.match(await (await admin.get("/staff/security")).text(), /leaving@example\.com/);
  const { c: sup } = await staffClient(app, "support");
  assert.equal((await sup.post(`/staff/privacy/${req!.id}/process`, { decision: "complete" })).status, 403);
  assert.equal((await admin.post(`/staff/privacy/${req!.id}/process`, { decision: "complete", notes: "Verified by email" })).status, 303);
  const u = await app.db.prepare(`SELECT email, display_name, password_hash, disabled_at FROM users WHERE id = ?`).bind(cust.id).first<{ email: string; display_name: string; password_hash: string | null; disabled_at: string | null }>();
  assert.match(u!.email, /@deleted\.invalid$/);
  assert.equal(u!.display_name, "Deleted user");
  assert.equal(u!.password_hash, null);
  assert.ok(u!.disabled_at);
  assert.equal((await app.db.prepare(`SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL`).bind(cust.id).first<{ n: number }>())!.n, 0);
  assert.ok(await app.db.prepare(`SELECT 1 FROM invoices WHERE id = 'inv_keep'`).first(), "financial record retained");
  assert.equal((await c.get("/account")).status, 303);
  assert.ok(await app.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'privacy.deletion_completed' AND subject_id = ?`).bind(cust.id).first());
});

test("[SEC-007] ASVS review, runbook and backup/recovery documents exist and do not claim compliance", async () => {
  const { readFileSync } = await import("node:fs");
  const asvs = readFileSync(new URL("../docs/security/ASVS-REVIEW.md", import.meta.url), "utf8");
  assert.match(asvs, /ASVS 4\.0\.3/);
  assert.match(asvs, /not.{0,40}complian/i);
  assert.match(asvs, /\| *F-\d+/);
  for (const f of ["../docs/RUNBOOK.md", "../docs/BACKUP-RECOVERY.md", "../docs/voice/PROVIDER-EVALUATION.md"]) assert.ok(readFileSync(new URL(f, import.meta.url), "utf8").length > 1000, f);
});
