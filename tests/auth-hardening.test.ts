// Production authentication hardening (docs/AUTH-PRODUCTION.md gaps 1–4 and 6): MFA recovery codes,
// administrator MFA reset, the Owner break-glass script, step-up MFA for sensitive actions, TOTP secrets
// encrypted at rest, bot protection on /register and /password/forgot, and the versioned password hash.
// Every account and record created here is TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, createStaff, createCustomer, lastEmail, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import { buildWorld } from "./support/security-world.ts";
import { auditScenarios, withFakeAi } from "./support/security-scenarios.ts";
import { pathFor, toLogin, routes } from "./support/security-helpers.ts";
import { ROUTE_INVENTORY } from "./support/route-inventory.ts";
import { totpCode, newTotpSecret, hashPassword, ITERATIONS } from "../src/lib/auth-crypto.ts";
import { STEP_UP_ROUTES, stepUpAction, safeNextPath } from "../src/app/step-up.ts";
import { openDb } from "../dev/sqlite-d1.ts";
import { run as encryptRun, planReencryption, SELECT_ROWS, type TotpRow } from "../scripts/encrypt-totp-secrets.ts";
import type { Env } from "../src/app/context.ts";

const KEY = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => db.prepare(sql).bind(...b).first<T>();
const loc = (r: Response) => r.headers.get("location") ?? "";
const codesIn = (page: string) => [...page.matchAll(/<li><code>([a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4})<\/code><\/li>/g)].map((m) => m[1]);
/** Simulates "the next 30-second window" and a fresh rate-limit window for MFA attempts (tests run many in seconds). */
async function nextWindow(db: Env["DB"], userId: string) {
  await db.prepare(`UPDATE users SET totp_last_step = NULL WHERE id = ?`).bind(userId).run();
  await db.prepare(`DELETE FROM rate_limits WHERE key = ?`).bind(`mfa:${userId}`).run();
}
async function ageMfa(db: Env["DB"], userId: string, minutes: number) {
  await db.prepare(`UPDATE sessions SET mfa_verified_at = ? WHERE user_id = ? AND mfa_verified = 1`).bind(new Date(Date.now() - minutes * 60e3).toISOString(), userId).run();
}

/** Enrols a fresh staff member through the real pages; returns the client, secret and the recovery codes shown once. */
async function enrolledStaff(app: Awaited<ReturnType<typeof createTestApp>>, role: Parameters<typeof createStaff>[1], email: string) {
  const s = await createStaff(app.db, role, email);
  await app.db.prepare(`UPDATE users SET totp_secret = NULL, mfa_enabled = 0 WHERE id = ?`).bind(s.id).run();
  const c = app.client();
  await c.post("/login", { email, password: TEST_PASSWORD });
  const setup = await (await c.get("/mfa/setup")).text();
  const secret = /data-testid="totp-secret">([A-Z2-7 ]+)</.exec(setup)![1].replace(/ /g, "");
  const done = await c.post("/mfa/setup", { code: await totpCode(secret) });
  assert.equal(done.status, 200);
  const codes = codesIn(await done.text());
  return { ...s, c, secret, codes };
}

// ───────────── 1. Recovery codes ─────────────

test("[AUTH-002] enrolment shows 10 single-use recovery codes exactly once; only password hashes are stored", async () => {
  const app = await createTestApp();
  const s = await enrolledStaff(app, "developer", "rc-dev@crestmont.test");
  assert.equal(s.codes.length, 10);
  assert.equal(new Set(s.codes.map((c) => c.slice(0, 4))).size, 10, "distinct lookup prefixes");
  const rows = (await app.db.prepare(`SELECT lookup, code_hash, used_at FROM mfa_recovery_codes WHERE user_id = ?`).bind(s.id).all<{ lookup: string; code_hash: string; used_at: string | null }>()).results;
  assert.equal(rows.length, 10);
  for (const r of rows) assert.match(r.code_hash, new RegExp(`^pbkdf2\\$${ITERATIONS}\\$[0-9a-f]{32}\\$[0-9a-f]{64}$`), "hashed with the password-hash function");
  const dump = JSON.stringify(rows);
  for (const c of s.codes) assert.ok(!dump.includes(c.replace(/-/g, "")) && !dump.includes(c), "no plaintext code at rest");
  const account = await (await s.c.get("/account")).text();
  for (const c of s.codes) assert.ok(!account.includes(c), "codes are never shown again");
  assert.match(account, /Recovery codes: <strong>10<\/strong> of 10 unused/);
  assert.equal((await one<{ n: number }>(app.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'user.mfa_recovery_codes_generated' AND subject_id = ?`, s.id))?.n, 1);
});

test("[AUTH-002] a recovery code signs in once in place of a TOTP code, is audited and emailed, and revokes nothing else", async () => {
  const app = await createTestApp();
  const s = await enrolledStaff(app, "support", "rc-support@crestmont.test");
  const other = s.c; // the enrolment session stays signed in
  const c = app.client();
  assert.match(loc(await c.post("/login", { email: s.email, password: TEST_PASSWORD })), /^\/mfa/);
  const typed = s.codes[3].toUpperCase().replace(/-/g, " "); // case, spaces and dashes are ignored
  const r = await c.post("/mfa", { code: typed });
  assert.equal(r.status, 303);
  assert.equal(loc(r), "/staff");
  assert.equal((await c.get("/staff")).status, 200, "the session is MFA-verified");
  assert.equal((await other.get("/staff")).status, 200, "using a recovery code signed nobody out");
  const ev = await one<{ detail: string }>(app.db, `SELECT detail FROM security_events WHERE kind = 'mfa_recovery_code_used' AND user_id = ?`, s.id);
  assert.match(ev!.detail, /9 left/);
  const au = await one<{ details_json: string }>(app.db, `SELECT details_json FROM audit_logs WHERE action = 'user.mfa_recovery_code_used' AND actor_user_id = ?`, s.id);
  assert.deepEqual(JSON.parse(au!.details_json), { purpose: "login", remaining: 9 });
  const mail = await lastEmail(app.db, s.email);
  assert.equal(mail?.template, "security_notification");
  assert.match(mail!.subject, /recovery code was used/i);
  // Single use: the same code is refused afterwards, also for step-up.
  const d = app.client();
  await d.post("/login", { email: s.email, password: TEST_PASSWORD });
  assert.equal((await d.post("/mfa", { code: s.codes[3] })).status, 401);
  assert.ok((await one<{ n: number }>(app.db, `SELECT COUNT(*) n FROM security_events WHERE kind = 'mfa_failed' AND user_id = ?`, s.id))!.n >= 1);
  // A code that was never issued, and a malformed one, are refused.
  assert.equal((await d.post("/mfa", { code: "aaaa-bbbb-cccc" })).status, 401);
  assert.equal((await d.post("/mfa", { code: "not a code" })).status, 401);
  // Another unused code works.
  assert.equal((await d.post("/mfa", { code: s.codes[7] })).status, 303);
});

test("[AUTH-002] regenerating recovery codes needs an MFA-verified session and a current authenticator code; old codes stop working", async () => {
  const app = await createTestApp();
  const s = await enrolledStaff(app, "project_manager", "rc-pm@crestmont.test");
  // Half-authenticated session (password only): refused.
  const half = app.client();
  await half.post("/login", { email: s.email, password: TEST_PASSWORD });
  await nextWindow(app.db, s.id);
  const r0 = await half.post("/account/mfa/recovery-codes", { code: await totpCode(s.secret) });
  assert.match(loc(r0), /^\/mfa/);
  // Wrong code, and a recovery code in place of the TOTP code: refused, nothing changes.
  const before = JSON.stringify((await app.db.prepare(`SELECT id FROM mfa_recovery_codes WHERE user_id = ? ORDER BY id`).bind(s.id).all()).results);
  assert.match(decodeURIComponent((await s.c.post("/account/mfa/recovery-codes", { code: "000000" })).headers.getSetCookie().join()), /current 6-digit code/);
  await s.c.post("/account/mfa/recovery-codes", { code: s.codes[0] });
  assert.equal(JSON.stringify((await app.db.prepare(`SELECT id FROM mfa_recovery_codes WHERE user_id = ? ORDER BY id`).bind(s.id).all()).results), before);
  // A current TOTP code: 10 new codes, shown once.
  await nextWindow(app.db, s.id);
  const res = await s.c.post("/account/mfa/recovery-codes", { code: await totpCode(s.secret) });
  assert.equal(res.status, 200);
  const fresh = codesIn(await res.text());
  assert.equal(fresh.length, 10);
  assert.equal((await one<{ n: number }>(app.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'user.mfa_recovery_codes_regenerated' AND actor_user_id = ?`, s.id))?.n, 1);
  assert.equal((await one<{ n: number }>(app.db, `SELECT COUNT(*) n FROM security_events WHERE kind = 'mfa_recovery_codes_regenerated' AND user_id = ?`, s.id))?.n, 1);
  assert.match((await lastEmail(app.db, s.email))!.subject, /New two-factor recovery codes/);
  const d = app.client();
  await d.post("/login", { email: s.email, password: TEST_PASSWORD });
  assert.equal((await d.post("/mfa", { code: s.codes[1] })).status, 401, "an old code no longer works");
  assert.equal((await d.post("/mfa", { code: fresh[1] })).status, 303, "a new code works");
});

// ───────────── 1b. Administrator MFA reset ─────────────

test("[AUTH-002] [AUTH-007] an administrator resets an employee's MFA: factors cleared, sessions revoked, re-enrolment forced, audited; never the Owner by a non-Owner, never yourself", async () => {
  const app = await createTestApp();
  const owner = await createStaff(app.db, "owner");
  const admin = await createStaff(app.db, "administrator");
  const sales = await createStaff(app.db, "sales");
  const dev = await enrolledStaff(app, "developer", "reset-me@crestmont.test");
  const oc = await app.client().login(owner.email, TEST_PASSWORD, owner.secret);
  const ac = await app.client().login(admin.email, TEST_PASSWORD, admin.secret);
  const sc = await app.client().login(sales.email, TEST_PASSWORD, sales.secret);
  assert.match(await (await ac.get("/staff/employees")).text(), new RegExp(`/staff/employees/${dev.id}/mfa-reset`), "the reset action is offered");

  assert.equal((await sc.post(`/staff/employees/${dev.id}/mfa-reset`)).status, 403, "sales lacks employee.manage");
  assert.equal((await ac.post(`/staff/employees/${owner.id}/mfa-reset`)).status, 403, "an administrator cannot reset the Owner");
  assert.equal((await ac.post(`/staff/employees/${admin.id}/mfa-reset`)).status, 403, "nobody resets their own MFA here");
  assert.equal((await ac.post(`/staff/employees/usr_missing/mfa-reset`)).status, 404);
  assert.ok((await one<{ totp_secret: string }>(app.db, `SELECT totp_secret FROM users WHERE id = ?`, owner.id))?.totp_secret, "Owner untouched");

  const res = await ac.post(`/staff/employees/${dev.id}/mfa-reset`);
  assert.equal(res.status, 303);
  const u = await one<{ totp_secret: string | null; totp_pending_secret: string | null; mfa_enabled: number }>(app.db, `SELECT totp_secret, totp_pending_secret, mfa_enabled FROM users WHERE id = ?`, dev.id);
  assert.deepEqual({ ...u }, { totp_secret: null, totp_pending_secret: null, mfa_enabled: 0 });
  assert.equal((await one<{ n: number }>(app.db, `SELECT COUNT(*) n FROM mfa_recovery_codes WHERE user_id = ?`, dev.id))?.n, 0);
  assert.equal((await one<{ n: number }>(app.db, `SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL`, dev.id))?.n, 0);
  assert.ok(toLogin(await dev.c.get("/staff")), "their sessions were revoked");
  const au = await one<{ actor_user_id: string }>(app.db, `SELECT actor_user_id FROM audit_logs WHERE action = 'employee.mfa_reset' AND subject_id = ?`, dev.id);
  assert.equal(au?.actor_user_id, admin.id);
  assert.match((await lastEmail(app.db, dev.email))!.subject, /Two-factor authentication was reset/);
  // At next sign-in they must enrol a new authenticator before any staff page.
  const again = app.client();
  assert.match(loc(await again.post("/login", { email: dev.email, password: TEST_PASSWORD })), /^\/mfa/);
  assert.equal(loc(await again.get("/mfa")), "/mfa/setup");
  assert.match(loc(await again.get("/staff")), /^\/mfa/);
  // The Owner may reset an administrator.
  assert.equal((await oc.post(`/staff/employees/${admin.id}/mfa-reset`)).status, 303);
});

// ───────────── 1c. Owner break-glass script ─────────────

test("[AUTH-002] Owner break-glass script refuses without explicit flags; its SQL clears only the Owner's MFA, revokes the Owner's sessions and writes audit_logs", async () => {
  const run = (...a: string[]) => spawnSync(process.execPath, ["--no-warnings", "scripts/reset-owner-mfa.ts", ...a], { encoding: "utf8" });
  const full = ["--email", "owner@crestmont.test", "--operator", "Ops Person", "--reason", "Lost phone; identity confirmed by video call", "--confirm-owner-break-glass"];
  for (const missing of ["--email", "--operator", "--reason", "--confirm-owner-break-glass"]) {
    const i = full.indexOf(missing);
    const args = missing === "--confirm-owner-break-glass" ? full.filter((x) => x !== missing) : [...full.slice(0, i), ...full.slice(i + 2)];
    const r = run(...args, "--print-sql");
    assert.equal(r.status, 2, `refuses without ${missing}`);
    assert.equal(r.stdout, "", "prints no SQL when refusing");
  }
  assert.equal(run(...full.map((x) => (x.startsWith("Lost") ? "too short" : x)), "--print-sql").status, 2, "a reason is required");
  assert.equal(run(...full).status, 2, "a target (--db or --print-sql) is required");

  const app = await createTestApp();
  const owner = await createStaff(app.db, "owner", "owner@crestmont.test");
  const admin = await createStaff(app.db, "administrator", "admin@crestmont.test");
  const oc = await app.client().login(owner.email, TEST_PASSWORD, owner.secret);
  await app.client().login(admin.email, TEST_PASSWORD, admin.secret);
  await app.db.prepare(`INSERT INTO mfa_recovery_codes (id, user_id, lookup, code_hash, created_at) VALUES ('mrc_x', ?, 'abcd', 'pbkdf2$1$00$00', ?)`).bind(owner.id, new Date().toISOString()).run();
  const exec = async (sql: string) => { for (const stmt of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await app.db.prepare(stmt).run(); };

  // Aimed at a non-Owner, the SQL is a no-op.
  const wrong = run(...full.map((x) => (x === "owner@crestmont.test" ? "admin@crestmont.test" : x)), "--print-sql");
  assert.equal(wrong.status, 0);
  await exec(wrong.stdout);
  assert.ok((await one<{ totp_secret: string }>(app.db, `SELECT totp_secret FROM users WHERE id = ?`, admin.id))?.totp_secret, "an administrator is never reset by the break-glass SQL");
  assert.equal((await one<{ n: number }>(app.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'owner.mfa_break_glass_reset'`))?.n, 0);

  const r = run(...full, "--print-sql");
  assert.equal(r.status, 0, r.stderr);
  await exec(r.stdout);
  const u = await one<{ totp_secret: string | null; mfa_enabled: number }>(app.db, `SELECT totp_secret, mfa_enabled FROM users WHERE id = ?`, owner.id);
  assert.deepEqual({ ...u }, { totp_secret: null, mfa_enabled: 0 });
  assert.equal((await one<{ n: number }>(app.db, `SELECT COUNT(*) n FROM mfa_recovery_codes WHERE user_id = ?`, owner.id))?.n, 0);
  assert.equal((await one<{ n: number }>(app.db, `SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL`, owner.id))?.n, 0);
  assert.ok(toLogin(await oc.get("/staff")), "Owner sessions revoked");
  assert.equal((await one<{ n: number }>(app.db, `SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL`, admin.id))?.n, 1, "nobody else is signed out");
  const au = await one<{ actor_kind: string; actor_user_id: string | null; details_json: string }>(app.db, `SELECT actor_kind, actor_user_id, details_json FROM audit_logs WHERE action = 'owner.mfa_break_glass_reset' AND subject_id = ?`, owner.id);
  assert.equal(au?.actor_kind, "system");
  assert.deepEqual(JSON.parse(au!.details_json), { operator: "Ops Person", reason: "Lost phone; identity confirmed by video call", via: "scripts/reset-owner-mfa.ts" });
  assert.ok(await one(app.db, `SELECT 1 FROM security_events WHERE kind = 'mfa_reset_break_glass' AND user_id = ?`, owner.id));
  // The Owner signs in with the password and must enrol again.
  const c = app.client();
  await c.post("/login", { email: owner.email, password: TEST_PASSWORD });
  assert.equal(loc(await c.get("/mfa")), "/mfa/setup");

  // Local mode (operator with a database file): refuses a non-Owner email outright.
  const dir = mkdtempSync(join(tmpdir(), "breakglass-"));
  try {
    const path = join(dir, "db.sqlite");
    const f = openDb(path);
    const now = new Date().toISOString();
    f.raw.exec(`INSERT INTO organizations (id, name, kind, created_at) VALUES ('org_c','Crestmont','internal','${now}');
      INSERT INTO users (id, email, display_name, password_hash, totp_secret, mfa_enabled, created_at) VALUES ('usr_o','owner@crestmont.test','O','x','SECRET',1,'${now}'), ('usr_a','admin@crestmont.test','A','x','SECRET',1,'${now}');
      INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES ('m1','usr_o','org_c','owner','${now}'), ('m2','usr_a','org_c','administrator','${now}');`);
    f.raw.close();
    const bad = run(...full.map((x) => (x === "owner@crestmont.test" ? "admin@crestmont.test" : x)), "--db", path);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not the Owner account/);
    const good = run(...full, "--db", path);
    assert.equal(good.status, 0, good.stderr);
    const g = openDb(path);
    assert.equal((g.raw.prepare(`SELECT totp_secret FROM users WHERE id = 'usr_o'`).get() as { totp_secret: string | null }).totp_secret, null);
    assert.equal((g.raw.prepare(`SELECT totp_secret FROM users WHERE id = 'usr_a'`).get() as { totp_secret: string | null }).totp_secret, "SECRET");
    assert.equal((g.raw.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'owner.mfa_break_glass_reset'`).get() as { n: number }).n, 1);
    g.raw.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────── 2. Step-up MFA ─────────────

test("[AUTH-003] [AUTH-007] the step-up policy names real routes and covers every sensitive category", () => {
  const registered = new Set(routes().map((r) => r.key));
  for (const k of Object.keys(STEP_UP_ROUTES)) assert.ok(registered.has(k), `${k} is a registered route`);
  const u = (p: string) => new URL(p, "http://x");
  const must: [string, string, string][] = [
    ["POST", "/staff/readiness/approve", "release approval"], ["POST", "/staff/employees/:id/role", "role change"],
    ["POST", "/staff/employees/invite", "membership"], ["POST", "/staff/employees/:id/disable", "membership"], ["POST", "/staff/employees/:id/mfa-reset", "MFA change"],
    ["POST", "/staff/refunds/:id/decide", "refund"], ["POST", "/staff/refunds/:id/issue", "payout"],
    ["POST", "/staff/integrations/:name/verify", "integration"], ["POST", "/staff/ops/environments", "integration"], ["POST", "/staff/builds/settings", "settings"],
    ["POST", "/mfa/setup", "MFA change"], ["POST", "/account/privacy/export", "export"],
  ];
  for (const [m, p, why] of must) assert.ok(stepUpAction(m, p, u(p)), `${m} ${p} (${why}) requires step-up`);
  // Every audited export route is covered by the export rule.
  for (const [key, spec] of Object.entries(ROUTE_INVENTORY)) {
    const [m, p] = key.split(" ");
    if (m === "GET" && spec.audit && "action" in spec.audit && /export|exported/.test(spec.audit.action)) assert.ok(stepUpAction(m, p, u(p)), `${key} (export) requires step-up`);
  }
  assert.ok(stepUpAction("GET", "/staff/finance/reconciliation", u("/staff/finance/reconciliation?format=csv")), "?format=csv exports too");
  assert.equal(stepUpAction("GET", "/staff/finance/reconciliation", u("/staff/finance/reconciliation")), null, "ordinary pages are not affected");
  assert.equal(stepUpAction("POST", "/staff/crm/new", u("/staff/crm/new")), null);
});

test("[AUTH-003] [EMP-002] every step-up action is refused without a recent MFA check (nothing recorded) and performed after a fresh TOTP", async () => {
  const w = await buildWorld();
  const restore = withFakeAi(w);
  const problems: string[] = [];
  const refused: string[] = [];
  const maxAudit = async () => (await one<{ n: number }>(w.db, `SELECT COALESCE(MAX(id), 0) n FROM audit_logs`))!.n;
  const actionsSince = async (id: number) => (await w.db.prepare(`SELECT action, actor_user_id FROM audit_logs WHERE id > ?`).bind(id).all<{ action: string; actor_user_id: string }>()).results;
  try {
    for (const s of auditScenarios(w)) {
      const [method, pattern] = s.key.split(" ");
      const spec = ROUTE_INVENTORY[s.key];
      const want = spec.audit && "action" in spec.audit ? spec.audit.action : null;
      await s.setup?.(w);
      if (s.run) { await s.run(w); continue; } // multi-step flows (enrolment, sign-in) are outside the step-up policy
      const who = s.as?.(w) ?? w.staff.owner;
      const path = s.path?.(w) ?? pathFor(w, { method, pattern, key: s.key, spec }, w.a);
      const send = (c: TestClient) => (method === "GET" ? c.get(path) : c.post(path, s.fields?.(w) ?? {}));
      if (!stepUpAction(method, pattern, new URL(path, "http://x"))) { await send(who.c); continue; }
      const secret = (await one<{ totp_secret: string | null }>(w.db, `SELECT totp_secret FROM users WHERE id = ?`, who.id))?.totp_secret;
      if (!secret) { await send(who.c); continue; } // users without MFA (customers who did not opt in) are not asked
      // 1. MFA last verified 11 minutes ago: refused before the route runs.
      await ageMfa(w.db, who.id, 11);
      const before = await maxAudit();
      const res = await send(who.c);
      const ok = spec.api ? res.status === 401 : res.status === 303 && loc(res).startsWith("/mfa/step-up?next=");
      if (!ok) problems.push(`${s.key}: not refused without recent MFA → ${res.status} ${loc(res)}`);
      if (want && (await actionsSince(before)).some((r) => r.action === want)) problems.push(`${s.key}: ${want} written without recent MFA`);
      if (method === "GET" && !spec.api && loc(res) !== `/mfa/step-up?next=${encodeURIComponent(path)}`) problems.push(`${s.key}: step-up does not return to ${path} (${loc(res)})`);
      refused.push(s.key);
      // 2. A fresh TOTP at /mfa/step-up, then the same request is performed.
      await nextWindow(w.db, who.id);
      const up = await who.c.post(`/mfa/step-up?next=${encodeURIComponent("/account")}`, { code: await totpCode(secret) });
      if (up.status !== 303 || loc(up) !== "/account") problems.push(`${s.key}: step-up failed → ${up.status} ${loc(up)}`);
      const after = await maxAudit();
      const res2 = await send(who.c);
      if ((res2.status === 303 && loc(res2).startsWith("/mfa")) || res2.status === 401) problems.push(`${s.key}: still refused after step-up → ${res2.status} ${loc(res2)}`);
      if (want && !(await actionsSince(after)).some((r) => r.action === want && r.actor_user_id === who.id)) problems.push(`${s.key}: ${want} not performed after step-up (${res2.status} ${loc(res2)})`);
    }
  } finally { restore(); }
  assert.deepEqual(problems, []);
  for (const k of Object.keys(STEP_UP_ROUTES).filter((k) => !k.includes("/mfa/setup"))) assert.ok(refused.includes(k), `${k} was exercised`);
  assert.ok(refused.length >= 30, `exercised ${refused.length} step-up actions`);
  // Exports selected by ?format=csv on a page route.
  const o = w.staff.owner;
  await ageMfa(w.db, o.id, 30);
  assert.match(loc(await o.c.get("/staff/finance/reconciliation?format=csv")), /^\/mfa\/step-up\?next=%2Fstaff%2Ffinance%2Freconciliation%3Fformat%3Dcsv$/);
  assert.equal((await o.c.get("/staff/finance/reconciliation")).status, 200, "the page itself needs no step-up");
});

test("[AUTH-003] step-up window is 10 minutes; replacing an authenticator needs it; the return path is same-origin only", async () => {
  const app = await createTestApp();
  const owner = await createStaff(app.db, "owner");
  const c = await app.client().login(owner.email, TEST_PASSWORD, owner.secret);
  const target = "/staff/employees/export.csv";
  await ageMfa(app.db, owner.id, 9);
  assert.equal((await c.get(target)).status, 200, "verified 9 minutes ago: allowed");
  await ageMfa(app.db, owner.id, 11);
  assert.match(loc(await c.get(target)), /^\/mfa\/step-up/, "verified 11 minutes ago: step-up");
  await app.db.prepare(`UPDATE sessions SET mfa_verified_at = NULL WHERE user_id = ?`).bind(owner.id).run();
  assert.match(loc(await c.get(target)), /^\/mfa\/step-up/, "sessions from before the migration step up once");
  // The step-up page itself.
  const page = await c.get(`/mfa/step-up?next=${encodeURIComponent(target)}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Confirm it is you/);
  assert.equal((await c.post(`/mfa/step-up?next=${encodeURIComponent(target)}`, { code: "000000" })).status, 401);
  assert.match(loc(await c.get(target)), /^\/mfa\/step-up/, "a wrong code does not count");
  // A form POST without a Referer returns to the area home; with a same-origin Referer, to that page.
  const post = await c.post("/staff/employees/invite", { email: "x@crestmont.test", role: "sales" });
  assert.equal(loc(post), `/mfa/step-up?next=${encodeURIComponent("/staff")}`);
  const viaRef = await c.request("POST", "/staff/employees/invite", { body: new URLSearchParams({ _csrf: c.cookies.get("cm_csrf")!, email: "x@crestmont.test", role: "sales" }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://crestmont.test", referer: "http://crestmont.test/staff/employees?q=x" } });
  assert.equal(loc(viaRef), `/mfa/step-up?next=${encodeURIComponent("/staff/employees?q=x")}`);
  assert.equal((await one<{ n: number }>(app.db, `SELECT COUNT(*) n FROM invitations WHERE email = 'x@crestmont.test'`))?.n, 0, "nothing was done");
  // Unsafe `next` values fall back to the area home.
  for (const bad of ["//evil.example", "https://evil.example/x", "/\\evil.example", "/%5Cevil.example", "javascript:alert(1)"]) {
    await nextWindow(app.db, owner.id);
    const r = await c.post(`/mfa/step-up?next=${encodeURIComponent(bad)}`, { code: await totpCode(owner.secret) });
    assert.equal(r.status, 303);
    assert.ok(/^\/(?![/\\])/.test(loc(r)) && new URL(loc(r), "http://crestmont.test").origin === "http://crestmont.test", `${bad} → ${loc(r)} stays on this site`);
    if (bad !== "/%5Cevil.example") assert.equal(loc(r), "/staff", `${bad} falls back to the area home`);
  }
  assert.equal(safeNextPath("/\\evil.example", "/x"), "/x");
  assert.equal(safeNextPath("/staff?a=1#b", "/x"), "/staff?a=1#b");
  // Replacing an enrolled authenticator is an MFA change: it needs a recent check.
  await ageMfa(app.db, owner.id, 30);
  assert.match(loc(await c.get("/mfa/setup")), /^\/mfa\/step-up\?next=%2Fmfa%2Fsetup/);
  await nextWindow(app.db, owner.id);
  await c.post(`/mfa/step-up?next=${encodeURIComponent("/mfa/setup")}`, { code: await totpCode(owner.secret) });
  assert.equal((await c.get("/mfa/setup")).status, 200);
  // JSON API exports answer 401 instead of redirecting.
  await ageMfa(app.db, owner.id, 30);
  const api = await c.get("/api/readiness/requirements.csv");
  assert.equal(api.status, 401);
  assert.match((await api.json() as { error: string }).error, /Recent two-factor verification required/);
});

test("[AUTH-003] customers without two-factor are not asked to step up; customers with it are", async () => {
  const app = await createTestApp();
  const cu = await createCustomer(app.db, "plain@example.com");
  const c = await app.client().login(cu.email);
  assert.equal((await c.post("/account/privacy/export")).status, 200);
  assert.equal((await c.get("/mfa/step-up?next=%2Fportal")).status, 200, "an explanatory page, nothing to verify");
  const secret = newTotpSecret();
  const two = await createCustomer(app.db, "twofa@example.com");
  await app.db.prepare(`UPDATE users SET totp_secret = ?, mfa_enabled = 1 WHERE id = ?`).bind(secret, two.id).run();
  const d = await app.client().login(two.email, TEST_PASSWORD, secret);
  await ageMfa(app.db, two.id, 30);
  assert.match(loc(await d.post("/account/privacy/export")), /^\/mfa\/step-up/);
});

// ───────────── 3. TOTP secrets at rest ─────────────

test("[SEC-004] [AUTH-003] with MFA_ENCRYPTION_KEY, TOTP secrets are stored as AES-GCM ciphertext bound to the user; sign-in decrypts transparently", async () => {
  const key = KEY();
  const app = await createTestApp({ ENVIRONMENT: "staging", MFA_ENCRYPTION_KEY: key, TURNSTILE_SECRET: "x", PASSWORD_BREACH_CHECK: "off" });
  const s = await enrolledStaff(app, "developer", "enc-dev@crestmont.test");
  const row = await one<{ totp_secret: string; totp_pending_secret: string | null }>(app.db, `SELECT totp_secret, totp_pending_secret FROM users WHERE id = ?`, s.id);
  assert.match(row!.totp_secret, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.ok(!row!.totp_secret.includes(s.secret), "no plaintext secret at rest");
  assert.equal(row!.totp_pending_secret, null);
  // Sign-in works through the ciphertext.
  const c = await app.client().login(s.email, TEST_PASSWORD, s.secret);
  assert.equal((await c.get("/staff")).status, 200);
  // A pending enrolment is encrypted too, and the setup page still shows the key to its owner (once, at enrolment).
  const p = await createStaff(app.db, "support", "enc-pending@crestmont.test");
  await app.db.prepare(`UPDATE users SET totp_secret = NULL, mfa_enabled = 0 WHERE id = ?`).bind(p.id).run();
  const pc = app.client();
  await pc.post("/login", { email: p.email, password: TEST_PASSWORD });
  const shown = /data-testid="totp-secret">([A-Z2-7 ]+)</.exec(await (await pc.get("/mfa/setup")).text())![1].replace(/ /g, "");
  const pending = (await one<{ totp_pending_secret: string }>(app.db, `SELECT totp_pending_secret FROM users WHERE id = ?`, p.id))!.totp_pending_secret;
  assert.match(pending, /^v1:/);
  assert.ok(!pending.includes(shown));
  // A wrong code re-shows the same (decrypted) pending key.
  assert.match(await (await pc.post("/mfa/setup", { code: "000000" })).text(), new RegExp(shown.match(/.{1,4}/g)!.join(" ")));
  // Ciphertext copied onto another user's row does not decrypt (user id is authenticated data): fail closed.
  await app.db.prepare(`UPDATE users SET totp_secret = ? WHERE id = ?`).bind(row!.totp_secret, p.id).run();
  await app.db.prepare(`UPDATE users SET mfa_enabled = 1 WHERE id = ?`).bind(p.id).run();
  const swap = app.client();
  await swap.post("/login", { email: p.email, password: TEST_PASSWORD });
  const r = await swap.post("/mfa", { code: await totpCode(s.secret) });
  assert.equal(r.status, 503);
  assert.match(await r.text(), /temporarily unavailable/);
  assert.ok(await one(app.db, `SELECT 1 FROM security_events WHERE kind = 'mfa_key_unavailable' AND user_id = ?`, p.id));
});

test("[SEC-004] [AUTH-003] legacy plaintext secrets keep working and are re-encrypted on the next successful verification", async () => {
  const app = await createTestApp({ ENVIRONMENT: "production", MFA_ENCRYPTION_KEY: KEY(), TURNSTILE_SECRET: "x", PASSWORD_BREACH_CHECK: "off" });
  const s = await createStaff(app.db, "sales"); // plaintext, as stored before this change
  assert.equal((await one<{ totp_secret: string }>(app.db, `SELECT totp_secret FROM users WHERE id = ?`, s.id))?.totp_secret, s.secret);
  const c = app.client();
  await c.post("/login", { email: s.email, password: TEST_PASSWORD });
  assert.equal((await c.post("/mfa", { code: "000000" })).status, 401);
  assert.equal((await one<{ totp_secret: string }>(app.db, `SELECT totp_secret FROM users WHERE id = ?`, s.id))?.totp_secret, s.secret, "a failed check changes nothing");
  assert.equal((await c.post("/mfa", { code: await totpCode(s.secret) })).status, 303);
  const after = (await one<{ totp_secret: string }>(app.db, `SELECT totp_secret FROM users WHERE id = ?`, s.id))!.totp_secret;
  assert.match(after, /^v1:/);
  const d = await app.client().login(s.email, TEST_PASSWORD, s.secret);
  assert.equal((await d.get("/staff")).status, 200, "and keeps working encrypted");
});

test("[SEC-004] [AUTH-003] without MFA_ENCRYPTION_KEY: development stores plaintext; staging/production refuse enrolment (fail closed) but do not lock out existing users", async () => {
  const dev = await createTestApp();
  const d = await enrolledStaff(dev, "developer", "dev-plain@crestmont.test");
  assert.equal((await one<{ totp_secret: string }>(dev.db, `SELECT totp_secret FROM users WHERE id = ?`, d.id))?.totp_secret, d.secret, "development fallback: plaintext");

  for (const ENVIRONMENT of ["staging", "production"] as const) {
    const app = await createTestApp({ ENVIRONMENT, TURNSTILE_SECRET: "x", PASSWORD_BREACH_CHECK: "off" });
    const s = await createStaff(app.db, "support");
    await app.db.prepare(`UPDATE users SET totp_secret = NULL, mfa_enabled = 0 WHERE id = ?`).bind(s.id).run();
    const c = app.client();
    await c.post("/login", { email: s.email, password: TEST_PASSWORD });
    const page = await c.get("/mfa/setup");
    assert.equal(page.status, 503, `${ENVIRONMENT}: enrolment refused`);
    const body = await page.text();
    assert.match(body, /MFA_ENCRYPTION_KEY secret is not configured/);
    assert.doesNotMatch(body, /data-testid="totp-secret"/);
    assert.equal((await one<{ p: string | null }>(app.db, `SELECT totp_pending_secret p FROM users WHERE id = ?`, s.id))?.p, null, "nothing stored");
    assert.match(loc(await c.post("/mfa/setup", { code: "123456" })), /^\/mfa\/setup/, "nothing pending to confirm: back to the (refusing) setup page");
    assert.equal((await one<{ m: number }>(app.db, `SELECT mfa_enabled m FROM users WHERE id = ?`, s.id))?.m, 0);
    assert.match(loc(await c.get("/staff")), /^\/mfa/, "and no staff access without MFA");
    // An existing (plaintext) user still signs in during the rollout.
    const old = await createStaff(app.db, "sales");
    const oc = await app.client().login(old.email, TEST_PASSWORD, old.secret);
    assert.equal((await oc.get("/staff")).status, 200, `${ENVIRONMENT}: existing users are not locked out`);
    assert.equal((await one<{ t: string }>(app.db, `SELECT totp_secret t FROM users WHERE id = ?`, old.id))?.t, old.secret, "left as is until the key is set");
  }
  // An encrypted row with the key removed fails closed (no bypass), and a malformed key refuses enrolment.
  const app = await createTestApp({ ENVIRONMENT: "staging", MFA_ENCRYPTION_KEY: KEY(), TURNSTILE_SECRET: "x", PASSWORD_BREACH_CHECK: "off" });
  const s = await enrolledStaff(app, "developer", "rotated@crestmont.test");
  delete app.env.MFA_ENCRYPTION_KEY;
  const c = app.client();
  await c.post("/login", { email: s.email, password: TEST_PASSWORD });
  await nextWindow(app.db, s.id);
  assert.equal((await c.post("/mfa", { code: await totpCode(s.secret) })).status, 503);
  assert.match(loc(await c.get("/staff")), /^\/mfa/);
  app.env.MFA_ENCRYPTION_KEY = Buffer.from("too short").toString("base64");
  const n = await createStaff(app.db, "support", "badkey@crestmont.test");
  await app.db.prepare(`UPDATE users SET totp_secret = NULL, mfa_enabled = 0 WHERE id = ?`).bind(n.id).run();
  const nc = app.client();
  await nc.post("/login", { email: n.email, password: TEST_PASSWORD });
  const bad = await nc.get("/mfa/setup");
  assert.equal(bad.status, 503);
  assert.match(await bad.text(), /must decode to exactly 32 bytes/);
});

test("[SEC-004] scripts/encrypt-totp-secrets.ts re-encrypts plaintext rows (dry run first), refuses a wrong key, and prints no secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "totp-enc-"));
  try {
    const path = join(dir, "db.sqlite");
    const db = openDb(path);
    const now = new Date().toISOString();
    const plain = [newTotpSecret(), newTotpSecret()];
    db.raw.exec(`INSERT INTO users (id, email, display_name, totp_secret, totp_pending_secret, mfa_enabled, created_at) VALUES
      ('usr_1','a@x.test','A','${plain[0]}',NULL,1,'${now}'), ('usr_2','b@x.test','B',NULL,'${plain[1]}',0,'${now}'), ('usr_3','c@x.test','C',NULL,NULL,0,'${now}')`);
    db.raw.close();
    const key = KEY();
    const env = { ...process.env, MFA_ENCRYPTION_KEY: key };
    const cli = (...a: string[]) => spawnSync(process.execPath, ["--no-warnings", "scripts/encrypt-totp-secrets.ts", ...a], { encoding: "utf8", env });
    assert.equal(spawnSync(process.execPath, ["--no-warnings", "scripts/encrypt-totp-secrets.ts"], { encoding: "utf8" }).status, 2, "usage without a target");
    const dry = cli("--db", path);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /2 stored in plaintext, 0 already encrypted[\s\S]*Dry run/);
    const rows = () => { const g = openDb(path); const r = g.raw.prepare(SELECT_ROWS).all() as unknown as TotpRow[]; g.raw.close(); return r; };
    assert.equal(rows().find((r) => r.id === "usr_1")!.totp_secret, plain[0], "dry run writes nothing");
    const wet = cli("--db", path, "--yes");
    assert.equal(wet.status, 0, wet.stderr);
    assert.match(wet.stdout, /Recovery point recorded\. To undo this run: replace .*pre-totp-encrypt-[\s\S]*Encrypted 2 value/);
    const out = dry.stdout + dry.stderr + wet.stdout + wet.stderr;
    for (const v of [...plain, key]) assert.ok(!out.includes(v), "no secret or key in the output");
    const after = rows();
    assert.match(after.find((r) => r.id === "usr_1")!.totp_secret!, /^v1:/);
    assert.match(after.find((r) => r.id === "usr_2")!.totp_pending_secret!, /^v1:/);
    // The encrypted values open with the key, for the right user only.
    const { openWithKey } = await import("../src/lib/totp-secrets.ts");
    assert.equal(await openWithKey(key, "usr_1", after.find((r) => r.id === "usr_1")!.totp_secret!), plain[0]);
    await assert.rejects(openWithKey(key, "usr_2", after.find((r) => r.id === "usr_1")!.totp_secret!));
    // Idempotent; and a different key is refused before anything is written.
    assert.match(cli("--db", path, "--yes").stdout, /0 stored in plaintext, 2 already encrypted[\s\S]*Nothing to do/);
    const wrong = spawnSync(process.execPath, ["--no-warnings", "scripts/encrypt-totp-secrets.ts", "--db", path, "--yes"], { encoding: "utf8", env: { ...process.env, MFA_ENCRYPTION_KEY: KEY() } });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /do not decrypt with this MFA_ENCRYPTION_KEY/);
    const nokey = spawnSync(process.execPath, ["--no-warnings", "scripts/encrypt-totp-secrets.ts", "--db", path], { encoding: "utf8", env: { ...process.env, MFA_ENCRYPTION_KEY: "" } });
    assert.equal(nokey.status, 1);
    await assert.rejects(planReencryption([], "short"), /32 bytes|base64/);
    // run() with in-memory ops, as used for remote D1.
    const applied: string[][] = [];
    const rowsU = async () => [{ id: "u", totp_secret: plain[0], totp_pending_secret: null }];
    // No recovery point → nothing is written; a failing recovery point → nothing is written.
    await assert.rejects(encryptRun({ rows: rowsU, apply: async (s) => { applied.push(s); } }, key, true, () => {}), /recovery point[\s\S]*nothing was written/);
    await assert.rejects(encryptRun({ rows: rowsU, apply: async (s) => { applied.push(s); }, recoveryPoint: async () => { throw new Error("time travel unavailable"); } }, key, true, () => {}), /could not record a recovery point[\s\S]*nothing was written/);
    assert.equal(applied.length, 0);
    const logs: string[] = [];
    await encryptRun({ rows: rowsU, apply: async (s) => { applied.push(s); }, recoveryPoint: async () => "restore bookmark B1" }, key, true, (l) => logs.push(l));
    assert.ok(logs.some((l) => l.includes("To undo this run: restore bookmark B1")), "the restore instruction is printed before writing");
    assert.equal(applied[0].length, 1);
    assert.ok(!applied[0][0].includes(plain[0]), "the SQL carries ciphertext only");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────── 4. Bot protection on /register and /password/forgot ─────────────

test("[AUTH-005] [AUTH-001] /register and /password/forgot require Turnstile outside development (fail closed without a secret) and render the widget", async () => {
  // Staging without TURNSTILE_SECRET: refused, nothing created, nothing sent.
  const bare = await createTestApp({ ENVIRONMENT: "staging", PASSWORD_BREACH_CHECK: "off" });
  const c = bare.client();
  const reg = await c.post("/register", { name: "Bot Person", organization: "Bot Co", email: "bot@example.com", password: TEST_PASSWORD, terms: "1" });
  assert.equal(reg.status, 400);
  assert.match(await reg.text(), /could not verify that this request came from a person/);
  assert.equal(await one(bare.db, `SELECT id FROM users WHERE email = 'bot@example.com'`), null);
  const cu = await createCustomer(bare.db, "real@example.com");
  const fg = await c.post("/password/forgot", { email: cu.email });
  assert.equal(fg.status, 400);
  assert.equal(await lastEmail(bare.db, cu.email), null, "no reset email");
  assert.ok((await one<{ n: number }>(bare.db, `SELECT COUNT(*) n FROM security_events WHERE kind = 'bot_check_failed'`))!.n >= 2);

  // Configured (a stub standing in for Cloudflare siteverify; staging's 1x000…AA test secret always passes there).
  const verified: string[] = [];
  const siteverify: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const token = String((init!.body as FormData).get("response"));
    verified.push(token);
    return Response.json({ success: token === "XXXX.DUMMY.TOKEN.XXXX" });
  };
  const app = await createTestApp({ ENVIRONMENT: "staging", TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET: "1x0000000000000000000000000000000AA", PASSWORD_BREACH_CHECK: "off", overrides: { fetch: siteverify } });
  const d = app.client();
  for (const p of ["/register", "/password/forgot"]) assert.match(await (await d.get(p)).text(), /class="cf-turnstile field" data-sitekey="1x00000000000000000000AA"/, `${p} renders the widget`);
  assert.equal((await d.post("/register", { name: "Pat", organization: "Pat Co", email: "pat@example.com", password: TEST_PASSWORD, terms: "1", "cf-turnstile-response": "forged" })).status, 400);
  assert.equal((await d.post("/register", { name: "Pat", organization: "Pat Co", email: "pat@example.com", password: TEST_PASSWORD, terms: "1" })).status, 400, "missing token");
  const ok = await d.post("/register", { name: "Pat", organization: "Pat Co", email: "pat@example.com", password: TEST_PASSWORD, terms: "1", "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" });
  assert.equal(ok.status, 200);
  assert.equal((await lastEmail(app.db, "pat@example.com"))?.template, "verification");
  const known = await createCustomer(app.db, "known@example.com");
  assert.equal((await d.post("/password/forgot", { email: known.email, "cf-turnstile-response": "forged" })).status, 400);
  assert.equal((await d.post("/password/forgot", { email: known.email, "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" })).status, 200);
  assert.equal((await lastEmail(app.db, known.email))?.template, "password_reset");
  assert.ok(verified.includes("forged") && verified.includes("XXXX.DUMMY.TOKEN.XXXX"));
});

test("[AUTH-005] /password/forgot is limited per IP as well as per email, and the limit is logged", async () => {
  const app = await createTestApp();
  const c = app.client();
  const cu = await createCustomer(app.db, "limited@example.com");
  // Per email (unchanged): only 3 reset emails per hour for one address.
  for (let i = 0; i < 4; i++) assert.equal((await c.post("/password/forgot", { email: cu.email })).status, 200);
  assert.equal((await app.db.prepare(`SELECT COUNT(*) n FROM email_deliveries WHERE to_email = ? AND template = 'password_reset'`).bind(cu.email).first<{ n: number }>())?.n, 3);
  // Per IP: 10 requests per hour from one network, whatever the addresses.
  for (let i = 4; i < 10; i++) assert.equal((await c.post("/password/forgot", { email: `probe${i}@example.com` })).status, 200);
  const limited = await c.post("/password/forgot", { email: "probe-last@example.com" });
  assert.equal(limited.status, 429);
  assert.match(await limited.text(), /Too many reset requests from your network/);
  assert.ok(await one(app.db, `SELECT 1 FROM security_events WHERE kind = 'rate_limited' AND detail = 'password reset (per IP)'`));
});

// ───────────── 6. Versioned password hash ─────────────

test("[AUTH-001] password hashes carry algorithm and cost; a hash with older parameters is replaced on the next successful sign-in", async () => {
  const app = await createTestApp();
  const cu = await createCustomer(app.db, "legacy-hash@example.com");
  assert.match((await one<{ h: string }>(app.db, `SELECT password_hash h FROM users WHERE id = ?`, cu.id))!.h, new RegExp(`^pbkdf2\\$${ITERATIONS}\\$[0-9a-f]{32}\\$[0-9a-f]{64}$`));
  const legacy = await hashPassword(TEST_PASSWORD, 1000);
  await app.db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(legacy, cu.id).run();
  assert.equal((await app.client().post("/login", { email: cu.email, password: "wrong-password-123" })).status, 400);
  assert.equal((await one<{ h: string }>(app.db, `SELECT password_hash h FROM users WHERE id = ?`, cu.id))!.h, legacy, "a failed sign-in never rehashes");
  assert.equal((await app.client().post("/login", { email: cu.email, password: TEST_PASSWORD })).status, 303, "the old-cost hash still verifies");
  const now = (await one<{ h: string }>(app.db, `SELECT password_hash h FROM users WHERE id = ?`, cu.id))!.h;
  assert.match(now, new RegExp(`^pbkdf2\\$${ITERATIONS}\\$`));
  assert.notEqual(now, legacy);
  const au = await one<{ details_json: string; actor_kind: string }>(app.db, `SELECT details_json, actor_kind FROM audit_logs WHERE action = 'user.password_rehashed' AND subject_id = ?`, cu.id);
  assert.deepEqual(JSON.parse(au!.details_json), { from: "pbkdf2$1000" });
  assert.equal((await app.client().post("/login", { email: cu.email, password: TEST_PASSWORD })).status, 303);
  assert.equal((await one<{ n: number }>(app.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'user.password_rehashed' AND subject_id = ?`, cu.id))?.n, 1, "rehashed once");
});

// ───────────── MFA/encryption completion (2026-10-28 audit findings 5 and 6) ─────────────

test("[AUTH-002] [AUTH-005] wrong second-factor codes are capped per rolling 24 hours (successes never count); re-enrolment clears the cap", async () => {
  const { MFA_DAILY_FAILURES } = await import("../src/services/auth.ts");
  const app = await createTestApp();
  const s = await enrolledStaff(app, "sales", "cap@crestmont.test");
  const c = app.client();
  await c.post("/login", { email: s.email, password: TEST_PASSWORD });
  const fail = (at: string) => app.db.prepare(`INSERT INTO security_events (kind, user_id, detail, created_at) VALUES ('mfa_failed', ?, 'totp; login', ?)`).bind(s.id, at).run();
  const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
  for (let i = 0; i < 50; i++) await fail(old); // more than a day ago: ignored
  for (let i = 0; i < MFA_DAILY_FAILURES - 1; i++) await fail(new Date().toISOString());
  // Successes in between never count.
  await nextWindow(app.db, s.id);
  assert.equal(loc(await c.post("/mfa", { code: await totpCode(s.secret) })), "/staff", "under the cap: a valid code signs in");
  const c2 = app.client();
  await c2.post("/login", { email: s.email, password: TEST_PASSWORD });
  await nextWindow(app.db, s.id);
  assert.equal((await c2.post("/mfa", { code: "000000" })).status, 401, "the last allowed wrong code");
  await nextWindow(app.db, s.id);
  const blocked = await c2.post("/mfa", { code: await totpCode(s.secret) });
  assert.equal(blocked.status, 401, "at the cap even a valid code is refused (whether it was valid is not revealed)");
  assert.match(await blocked.text(), /Too many incorrect authenticator codes in the last 24 hours/);
  assert.equal((await one<{ n: number }>(app.db, `SELECT COUNT(*) n FROM security_events WHERE user_id = ? AND kind = 'mfa_locked'`, s.id))?.n, 1, "recorded for the operator");
  assert.notEqual(loc(await c2.get("/staff")), "", "still not signed in");
  // A valid recovery code still works at the cap (someone holding the password cannot lock the person out).
  const c3 = app.client();
  await c3.post("/login", { email: s.email, password: TEST_PASSWORD });
  await nextWindow(app.db, s.id);
  assert.equal(loc(await c3.post("/mfa", { code: s.codes[0] })), "/staff", "recovery code accepted at the cap");
  // Step-up and recovery-code regeneration share the cap.
  await nextWindow(app.db, s.id);
  const su = await c.post("/mfa/step-up?next=%2Fstaff", { code: await totpCode(s.secret) });
  assert.match(await su.text(), /Too many incorrect authenticator codes in the last 24 hours/);
  // A replayed code (double submit) is not a wrong code and never counts.
  assert.equal((await one<{ n: number }>(app.db, `SELECT COUNT(*) n FROM security_events WHERE user_id = ? AND kind = 'mfa_failed' AND detail LIKE 'totp%' AND created_at > ?`, s.id, new Date(Date.now() - 3_600_000).toISOString()))!.n, MFA_DAILY_FAILURES);
  // An administrator MFA reset + re-enrolment (user.mfa_enabled) starts a fresh count.
  await app.db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, created_at) VALUES (?, 'user', 'user.mfa_enabled', 'user', ?, ?)`).bind(s.id, s.id, new Date(Date.now() + 1000).toISOString()).run();
  await new Promise((r) => setTimeout(r, 1100));
  await nextWindow(app.db, s.id);
  assert.equal(loc(await c2.post("/mfa", { code: await totpCode(s.secret) })), "/staff", "unblocked after re-enrolment");
});

test("[AUTH-002] [AUTH-007] replacing the authenticator signs out every other session; the old authenticator stops working", async () => {
  const app = await createTestApp();
  const owner = await createStaff(app.db, "owner", "replace@crestmont.test");
  const device = await app.client().login(owner.email, TEST_PASSWORD, owner.secret);
  await nextWindow(app.db, owner.id);
  const lost = await app.client().login(owner.email, TEST_PASSWORD, owner.secret); // e.g. a stolen laptop
  assert.equal((await lost.get("/staff")).status, 200);
  const setup = await (await device.get("/mfa/setup")).text();
  const secret = /data-testid="totp-secret">([A-Z2-7 ]+)</.exec(setup)?.[1].replace(/ /g, "");
  assert.ok(secret && secret !== owner.secret, "a new setup key is shown (step-up was satisfied by the fresh sign-in)");
  assert.equal((await device.post("/mfa/setup", { code: await totpCode(secret) })).status, 200);
  assert.equal((await device.get("/staff")).status, 200, "the session that replaced it stays signed in");
  assert.match(loc(await lost.get("/staff")), /^\/login/, "the other session is signed out");
  assert.ok((await one<{ n: number }>(app.db, `SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL`, owner.id))!.n === 1);
  // Stored encrypted? (development without a key stores plaintext — covered with a key in the SEC-004 tests.) Old secret refused:
  await nextWindow(app.db, owner.id);
  await assert.rejects(app.client().login(owner.email, TEST_PASSWORD, owner.secret));
  await nextWindow(app.db, owner.id);
  await app.client().login(owner.email, TEST_PASSWORD, secret);
});
