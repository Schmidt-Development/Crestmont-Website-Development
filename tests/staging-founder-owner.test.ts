// Staging: the Founder's own Owner account next to the demo Owner (scripts/bootstrap-owner.ts --staging-additional-owner).
// Proves the invitation path works end to end (password, mandatory MFA enrolment, Owner-only pages such as
// /staff/research); that the demo Owner and every existing account are left exactly as they were; that the SQL is
// all-or-nothing (an ineligible run changes no row, not even a pending Owner invitation) and fails closed outside
// staging D1; and that the invitation token never reaches the console, the SQL file or the repository. TEST DATA only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD } from "./support/app.ts";
import { totpCode, hashToken } from "../src/lib/auth-crypto.ts";
import type { Env } from "../src/app/context.ts";

const toml = readFileSync("wrangler.toml", "utf8");
const STAGING_URL = /APP_URL\s*=\s*"([^"]+)"/.exec(toml.slice(toml.indexOf("\n[env.staging]")))![1];
const DEMO_OWNER = "owner@crestmont-preview.test";
const FOUNDER = "founder+staging-owner@example.com";
// Staging refuses 2FA enrolment without MFA_ENCRYPTION_KEY (secrets are encrypted at rest), as the real Worker does.
const TEST_MFA_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

// The script refuses to run in CI; the test runner itself runs in CI, so the child gets an environment without those markers.
const childEnv = () => { const e = { ...process.env }; delete e.CI; delete e.GITHUB_ACTIONS; delete e.TF_BUILD; return e; };
const run = (args: string[], env = childEnv()) => spawnSync(process.execPath, ["--no-warnings", "scripts/bootstrap-owner.ts", ...args], { encoding: "utf8", env });

interface Issued { status: number | null; stdout: string; stderr: string; sql: string; link: string; token: string; dir: string }
function issue(email: string): Issued {
  const dir = mkdtempSync(join(tmpdir(), "founder-owner-"));
  const sqlFile = join(dir, "founder-owner.sql"), linkFile = join(dir, "invite-link.txt");
  const r = run(["--staging-additional-owner", "--email", email, "--url", STAGING_URL, "--out-sql", sqlFile, "--out-link", linkFile]);
  assert.equal(r.status, 0, r.stderr);
  const link = readFileSync(linkFile, "utf8");
  const token = /\/invite\?token=([0-9a-f]{64})\n$/.exec(link)![1];
  return { ...r, sql: readFileSync(sqlFile, "utf8"), link, token, dir };
}
async function apply(db: Env["DB"], sql: string) {
  for (const stmt of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await db.prepare(stmt).run();
}
async function stagingApp() {
  const app = await createTestApp({ ENVIRONMENT: "staging", APP_URL: STAGING_URL, MFA_ENCRYPTION_KEY: TEST_MFA_KEY });
  await app.db.prepare(`CREATE TABLE IF NOT EXISTS _staging_access (key TEXT PRIMARY KEY, value TEXT NOT NULL)`).run();
  await app.db.prepare(`INSERT INTO _staging_access (key, value) VALUES ('salt', 'test-salt')`).run();
  return app;
}
async function signIn(client: ReturnType<Awaited<ReturnType<typeof createTestApp>>["client"]>, email: string, secret: string) {
  assert.equal((await client.post("/login", { email, password: TEST_PASSWORD })).headers.get("location"), "/mfa");
  assert.equal((await client.post("/mfa", { code: await totpCode(secret) })).status, 303);
}
/** A pending Owner invitation that existed before (e.g. one issued earlier and not yet used). */
async function pendingOwnerInvitation(db: Env["DB"]) {
  const expires = new Date(Date.now() + 48 * 3600e3).toISOString();
  await db.prepare(`INSERT OR IGNORE INTO users (id, email, display_name, password_hash, disabled_at, created_at) VALUES ('usr_system','system@crestmont.invalid','Crestmont system',NULL,?,?)`).bind(expires, expires).run();
  await db.prepare(`INSERT INTO invitations (id, email, organization_id, role_id, token_hash, invited_by, expires_at) VALUES ('inv_earlier', 'earlier@example.com', 'org_crestmont', 'owner', ?, 'usr_system', ?)`)
    .bind(await hashToken("earlier-token"), expires).run();
  return expires;
}
const dump = async (db: Env["DB"]) => ({
  invitations: (await db.prepare(`SELECT * FROM invitations ORDER BY id`).all()).results,
  organizations: (await db.prepare(`SELECT * FROM organizations ORDER BY id`).all()).results,
  users: (await db.prepare(`SELECT * FROM users ORDER BY id`).all()).results,
  memberships: (await db.prepare(`SELECT * FROM memberships ORDER BY id`).all()).results,
  sessions: (await db.prepare(`SELECT * FROM sessions ORDER BY id`).all()).results,
});

test("[AUTH-003] staging: the Founder gets an own Owner account by invitation, with mandatory MFA, while the demo Owner is untouched", async () => {
  const { db, client } = await stagingApp();
  const demo = await createStaff(db, "owner", DEMO_OWNER, "Preview Owner");
  await signIn(client(), DEMO_OWNER, demo.secret); // the demo Owner has live sessions, like staging's
  const customer = await createCustomer(db, "founder@example.com"); // the Founder's existing customer account
  const snapshot = async () => ({
    demo: await db.prepare(`SELECT password_hash, totp_secret, mfa_enabled, disabled_at FROM users WHERE id = ?`).bind(demo.id).first(),
    demoSessions: (await db.prepare(`SELECT id, revoked_at, expires_at FROM sessions WHERE user_id = ? ORDER BY id`).bind(demo.id).all()).results,
    demoRoles: (await db.prepare(`SELECT role_id FROM memberships WHERE user_id = ?`).bind(demo.id).all()).results,
    customer: await db.prepare(`SELECT password_hash, email_verified_at, totp_secret FROM users WHERE id = ?`).bind(customer.id).first(),
    customerRoles: (await db.prepare(`SELECT role_id FROM memberships WHERE user_id = ?`).bind(customer.id).all()).results,
  });
  const before = await snapshot();
  assert.ok(before.demoSessions.length >= 1);

  const r = issue(FOUNDER);
  await apply(db, r.sql);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM invitations WHERE role_id = 'owner' AND email = ? AND accepted_at IS NULL`).bind(FOUNDER).first<{ n: number }>())?.n, 1);

  const c = client();
  assert.equal((await c.post("/invite", { token: r.token, name: "The Founder", password: TEST_PASSWORD })).status, 303);
  assert.equal((await client().post("/invite", { token: r.token, name: "Someone else", password: TEST_PASSWORD })).status, 400, "single-use");
  assert.equal((await c.post("/login", { email: FOUNDER, password: TEST_PASSWORD })).headers.get("location"), "/mfa");
  assert.notEqual((await c.get("/staff/research")).status, 200, "no staff page before MFA");
  assert.equal((await c.get("/mfa")).headers.get("location"), "/mfa/setup", "the Owner must enrol an authenticator");
  const setup = await (await c.get("/mfa/setup")).text();
  const secret = /data-testid="totp-secret">([A-Z2-7 ]+)</.exec(setup)![1].replace(/ /g, "");
  assert.equal((await c.post("/mfa/setup", { code: await totpCode(secret) })).status, 200);
  assert.equal((await c.get("/staff/research")).status, 200, "Lead research opens for the Founder's Owner account");
  assert.equal((await c.get("/staff/readiness/approve")).status, 200, "Owner-only pages open");

  // A fresh session must pass MFA again before any staff page.
  const d = client();
  assert.equal((await d.post("/login", { email: FOUNDER, password: TEST_PASSWORD })).headers.get("location"), "/mfa");
  assert.notEqual((await d.get("/staff/research")).status, 200);

  const founder = await db.prepare(`SELECT u.id, m.role_id, m.organization_id, u.mfa_enabled FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.email = ?`).bind(FOUNDER).all<{ id: string; role_id: string; organization_id: string; mfa_enabled: number }>();
  assert.deepEqual(founder.results.map((x) => [x.role_id, x.organization_id, x.mfa_enabled]), [["owner", "org_crestmont", 1]], "a separate account holding only the Owner role");
  assert.notEqual(founder.results[0].id, customer.id);
  assert.deepEqual(await snapshot(), before, "demo Owner (password, 2FA, sessions, role) and the customer account unchanged");

  // Re-running cannot mint a second Founder Owner invitation.
  const again = issue("someone-else@example.com");
  await apply(db, again.sql);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM invitations WHERE email = 'someone-else@example.com'`).first<{ n: number }>())?.n, 0);
});

test("[AUTH-003] staging additional Owner: an INELIGIBLE run changes no row — a pending Owner invitation keeps its expiry", async () => {
  // (a) The address is a verified customer account (CREST-GAP-001: never promoted).
  {
    const { db } = await stagingApp();
    await createStaff(db, "owner", DEMO_OWNER, "Preview Owner");
    await createCustomer(db, "founder@example.com");
    const expires = await pendingOwnerInvitation(db);
    const before = await dump(db);
    await apply(db, issue("founder@example.com").sql);
    assert.deepEqual(await dump(db), before, "customer address: nothing changed");
    assert.equal((await db.prepare(`SELECT expires_at FROM invitations WHERE id = 'inv_earlier'`).first<{ expires_at: string }>())?.expires_at, expires);
  }
  // (b) An Owner outside the demo domain already exists.
  {
    const { db } = await stagingApp();
    await createStaff(db, "owner", DEMO_OWNER, "Preview Owner");
    await createStaff(db, "owner", "already-owner@example.com", "Existing Founder Owner");
    const expires = await pendingOwnerInvitation(db);
    const before = await dump(db);
    await apply(db, issue(FOUNDER).sql);
    assert.deepEqual(await dump(db), before, "Founder Owner already exists: nothing changed");
    assert.equal((await db.prepare(`SELECT expires_at FROM invitations WHERE id = 'inv_earlier'`).first<{ expires_at: string }>())?.expires_at, expires);
  }
  // (c) The address is already staff.
  {
    const { db } = await stagingApp();
    await createStaff(db, "owner", DEMO_OWNER, "Preview Owner");
    await createStaff(db, "developer", FOUNDER, "Already staff");
    await pendingOwnerInvitation(db);
    const before = await dump(db);
    await apply(db, issue(FOUNDER).sql);
    assert.deepEqual(await dump(db), before, "already staff: nothing changed");
  }
  // (d) Not staging D1 (no _staging_access): every statement errors, nothing changes. Checked statement by statement,
  //     so it holds even if a client did not stop at the first error.
  {
    const other = await createTestApp();
    await createStaff(other.db, "owner", DEMO_OWNER, "Preview Owner");
    await pendingOwnerInvitation(other.db);
    const before = await dump(other.db);
    const stmts = issue(FOUNDER).sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean);
    assert.equal(stmts.length, 4);
    for (const s of stmts) await assert.rejects(other.db.prepare(s).run(), /no such table: _staging_access/);
    assert.deepEqual(await dump(other.db), before);
  }
});

test("[AUTH-003] staging additional Owner: an eligible run expires the earlier pending Owner invitation only together with the new one; re-applying is a no-op", async () => {
  const { db } = await stagingApp();
  await createStaff(db, "owner", DEMO_OWNER, "Preview Owner");
  await pendingOwnerInvitation(db);
  const r = issue(FOUNDER);
  const stmts = r.sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean);
  // The expiry statement on its own (as if the insert had not happened) changes nothing.
  await db.prepare(stmts[3]).run();
  assert.ok(((await db.prepare(`SELECT expires_at FROM invitations WHERE id = 'inv_earlier'`).first<{ expires_at: string }>())!.expires_at) > new Date().toISOString());
  await apply(db, r.sql);
  const rows = (await db.prepare(`SELECT id, email, expires_at FROM invitations WHERE role_id = 'owner' ORDER BY id`).all<{ id: string; email: string; expires_at: string }>()).results;
  const now = new Date().toISOString();
  assert.ok(rows.find((x) => x.id === "inv_earlier")!.expires_at <= now, "earlier pending Owner invitation stopped working");
  const fresh = rows.find((x) => x.email === FOUNDER)!;
  assert.ok(fresh.expires_at > now);
  const snapshot = await dump(db);
  await apply(db, r.sql); // applied twice by mistake
  assert.deepEqual(await dump(db), snapshot, "re-applying the same file changes nothing");
});

test("[AUTH-003] staging additional Owner: the invitation token never reaches the console, the SQL file or the repository", () => {
  const r = issue(FOUNDER);
  assert.ok(!r.stdout.includes(r.token) && !r.stderr.includes(r.token), "not printed");
  assert.doesNotMatch(r.stdout + r.stderr, /invite\?token=/);
  assert.ok(!r.sql.includes(r.token.slice(0, 8)), "the SQL holds no part of the token (the invitation id is independent)");
  assert.equal(r.link, `${STAGING_URL}/invite?token=${r.token}\n`, "only the link file holds it");
  assert.equal(r.sql.charCodeAt(0) !== 0xfeff && !r.sql.includes("\u0000"), true, "UTF-8 without BOM (wrangler-readable)");

  const dir = mkdtempSync(join(tmpdir(), "founder-owner-refuse-"));
  const ok = (n: string) => join(dir, n);
  const base = ["--staging-additional-owner", "--email", FOUNDER, "--url", STAGING_URL];
  writeFileSync(ok("exists.sql"), "keep");
  const cases: [string, ReturnType<typeof run>][] = [
    ["CI", run([...base, "--out-sql", ok("a.sql"), "--out-link", ok("a.txt")], { ...childEnv(), GITHUB_ACTIONS: "true" })],
    ["CI generic", run([...base, "--out-sql", ok("b.sql"), "--out-link", ok("b.txt")], { ...childEnv(), CI: "true" })],
    ["inside repo (sql)", run([...base, "--out-sql", "founder-owner.sql", "--out-link", ok("c.txt")])],
    ["inside repo (link)", run([...base, "--out-sql", ok("d.sql"), "--out-link", "docs/invite-link.txt"])],
    ["existing file", run([...base, "--out-sql", ok("exists.sql"), "--out-link", ok("e.txt")])],
    ["no output files", run(base)],
    ["--print-sql", run([...base, "--print-sql", "--out-sql", ok("f.sql"), "--out-link", ok("f.txt")])],
    ["production URL", run(["--staging-additional-owner", "--email", FOUNDER, "--url", "https://crestmontwebsitedevelopment.com", "--out-sql", ok("g.sql"), "--out-link", ok("g.txt")])],
    ["demo domain", run(["--staging-additional-owner", "--email", DEMO_OWNER, "--url", STAGING_URL, "--out-sql", ok("h.sql"), "--out-link", ok("h.txt")])],
  ];
  for (const [name, c] of cases) {
    assert.equal(c.status, 2, `${name}: ${c.stderr}`);
    assert.equal(c.stdout, "", name);
    assert.doesNotMatch(c.stderr, /invite\?token=/, name);
  }
  assert.equal(readFileSync(ok("exists.sql"), "utf8"), "keep", "an existing file is never overwritten");
  for (const f of ["a", "b", "c", "e", "f", "g", "h"]) assert.ok(!existsSync(ok(`${f}.txt`)), `no link file left behind (${f})`);
  assert.ok(!existsSync("founder-owner.sql") && !existsSync("docs/invite-link.txt"), "nothing written inside the repository");
  rmSync(dir, { recursive: true, force: true });
});
