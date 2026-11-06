// Production authentication hardening (docs/AUTH-PRODUCTION.md gaps 1–4 and 6): administrator reset of stored MFA
// data, the Owner break-glass script, the step-up policy list, the TOTP-secret re-encryption script, bot protection on
// /register and /password/forgot, and the versioned password hash. (MFA itself was removed on 2026-11-06; the
// sign-in behaviour without it is covered by tests/mfa-removed.test.ts.)
// Every account and record created here is TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, createStaff, createCustomer, lastEmail, TEST_PASSWORD } from "./support/app.ts";
import { toLogin, routes } from "./support/security-helpers.ts";
import { ROUTE_INVENTORY } from "./support/route-inventory.ts";
import { newTotpSecret, hashPassword, ITERATIONS } from "../src/lib/auth-crypto.ts";
import { STEP_UP_ROUTES, stepUpAction } from "../src/app/step-up.ts";
import { openDb } from "../dev/sqlite-d1.ts";
import { run as encryptRun, planReencryption, SELECT_ROWS, type TotpRow } from "../scripts/encrypt-totp-secrets.ts";
import type { Env } from "../src/app/context.ts";

const KEY = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => db.prepare(sql).bind(...b).first<T>();
const loc = (r: Response) => r.headers.get("location") ?? "";

// ───────────── 1b. Administrator MFA reset ─────────────

test("[AUTH-002] [AUTH-007] an administrator resets an employee's stored MFA data: factors cleared, sessions revoked, audited; never the Owner by a non-Owner, never yourself", async () => {
  const app = await createTestApp();
  const owner = await createStaff(app.db, "owner");
  const admin = await createStaff(app.db, "administrator");
  const sales = await createStaff(app.db, "sales");
  const dev = await createStaff(app.db, "developer", "reset-me@crestmont.test");
  const devClient = await app.client().login(dev.email);
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
  assert.ok(toLogin(await devClient.get("/staff")), "their sessions were revoked");
  const au = await one<{ actor_user_id: string }>(app.db, `SELECT actor_user_id FROM audit_logs WHERE action = 'employee.mfa_reset' AND subject_id = ?`, dev.id);
  assert.equal(au?.actor_user_id, admin.id);
  assert.match((await lastEmail(app.db, dev.email))!.subject, /Two-factor authentication was reset/);
  // MFA was removed: at next sign-in the password alone reaches the staff area.
  const again = app.client();
  assert.equal(loc(await again.post("/login", { email: dev.email, password: TEST_PASSWORD })), "/staff");
  assert.equal((await again.get("/staff")).status, 200);
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
  // MFA was removed: the Owner signs in again with the password alone.
  const c = app.client();
  assert.equal(loc(await c.post("/login", { email: owner.email, password: TEST_PASSWORD })), "/staff");
  assert.equal((await c.get("/staff")).status, 200);

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

// ───────────── 3. TOTP secrets at rest ─────────────

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
