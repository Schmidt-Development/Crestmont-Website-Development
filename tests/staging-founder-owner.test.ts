// Staging: the Founder's own Owner account next to the demo Owner (scripts/bootstrap-owner.ts --staging-additional-owner).
// Proves the invitation path works end to end (password, mandatory MFA enrolment, Owner-only pages such as
// /staff/research), that the demo Owner and every existing account are left exactly as they were, and that the SQL
// fails closed outside staging D1 and never promotes a customer account. All records are TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD } from "./support/app.ts";
import { totpCode } from "../src/lib/auth-crypto.ts";
import type { Env } from "../src/app/context.ts";

const toml = readFileSync("wrangler.toml", "utf8");
const STAGING_URL = /APP_URL\s*=\s*"([^"]+)"/.exec(toml.slice(toml.indexOf("\n[env.staging]")))![1];
const DEMO_OWNER = "owner@crestmont-preview.test";
const FOUNDER = "founder+staging-owner@example.com";
// Staging refuses 2FA enrolment without MFA_ENCRYPTION_KEY (secrets are encrypted at rest), as the real Worker does.
const TEST_MFA_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

const run = (...a: string[]) => spawnSync(process.execPath, ["--no-warnings", "scripts/bootstrap-owner.ts", ...a], { encoding: "utf8" });
const issue = (email: string) => run("--staging-additional-owner", "--print-sql", "--email", email, "--url", STAGING_URL);
async function apply(db: Env["DB"], sql: string) {
  for (const stmt of sql.split(/;\s*\n/).map((x) => x.trim().replace(/;$/, "")).filter(Boolean)) await db.prepare(stmt).run();
}
const tokenOf = (stderr: string) => /\/invite\?token=([0-9a-f]{64})/.exec(stderr)?.[1];

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

test("[AUTH-003] staging: the Founder gets an own Owner account by invitation, with mandatory MFA, while the demo Owner is untouched", async () => {
  const { db, client } = await stagingApp();
  const demo = await createStaff(db, "owner", DEMO_OWNER, "Preview Owner");
  await signIn(client(), DEMO_OWNER, demo.secret); // the demo Owner has live sessions, like staging's
  const customer = await createCustomer(db, "founder@example.com"); // the Founder's existing customer account
  const snapshot = async () => ({
    demo: await db.prepare(`SELECT password_hash, totp_secret, mfa_enabled, disabled_at FROM users WHERE id = ?`).bind(demo.id).first(),
    demoSessions: await db.prepare(`SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL`).bind(demo.id).first<{ n: number }>(),
    demoRoles: (await db.prepare(`SELECT role_id FROM memberships WHERE user_id = ?`).bind(demo.id).all()).results,
    customer: await db.prepare(`SELECT password_hash, email_verified_at FROM users WHERE id = ?`).bind(customer.id).first(),
    customerRoles: (await db.prepare(`SELECT role_id FROM memberships WHERE user_id = ?`).bind(customer.id).all()).results,
  });
  const before = await snapshot();
  assert.ok(before.demoSessions!.n >= 1);

  const r = issue(FOUNDER);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /invite\?token=/, "the link goes to the operator's terminal only, never into the SQL file");
  const token = tokenOf(r.stderr);
  assert.ok(token);
  assert.ok(!r.stdout.includes(token!), "only the hash is stored");
  await apply(db, r.stdout);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM invitations WHERE role_id = 'owner' AND email = ? AND accepted_at IS NULL`).bind(FOUNDER).first<{ n: number }>())?.n, 1);

  const c = client();
  assert.equal((await c.post("/invite", { token: token!, name: "The Founder", password: TEST_PASSWORD })).status, 303);
  assert.equal((await client().post("/invite", { token: token!, name: "Someone else", password: TEST_PASSWORD })).status, 400, "single-use");
  assert.equal((await c.post("/login", { email: FOUNDER, password: TEST_PASSWORD })).headers.get("location"), "/mfa");
  assert.notEqual((await c.get("/staff/research")).status, 200, "no staff page before MFA");
  assert.equal((await c.get("/mfa")).headers.get("location"), "/mfa/setup", "the Owner must enrol an authenticator");
  const setup = await (await c.get("/mfa/setup")).text();
  const secret = /data-testid="totp-secret">([A-Z2-7 ]+)</.exec(setup)![1].replace(/ /g, "");
  assert.equal((await c.post("/mfa/setup", { code: await totpCode(secret) })).status, 200);
  assert.equal((await c.get("/staff/research")).status, 200, "Lead research opens for the Founder's Owner account");
  assert.equal((await c.get("/staff/readiness/approve")).status, 200, "Owner-only pages open");

  const founder = await db.prepare(`SELECT u.id, m.role_id, m.organization_id, u.mfa_enabled FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.email = ?`).bind(FOUNDER).all<{ id: string; role_id: string; organization_id: string; mfa_enabled: number }>();
  assert.deepEqual(founder.results.map((x) => [x.role_id, x.organization_id, x.mfa_enabled]), [["owner", "org_crestmont", 1]], "a separate account holding only the Owner role");
  assert.notEqual(founder.results[0].id, customer.id);
  assert.deepEqual(await snapshot(), before, "demo Owner (password, 2FA, sessions, role) and the customer account unchanged");

  // Re-running cannot mint a second Founder Owner invitation.
  const again = issue("someone-else@example.com");
  await apply(db, again.stdout);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM invitations WHERE email = 'someone-else@example.com'`).first<{ n: number }>())?.n, 0);
});

test("[AUTH-003] staging additional Owner: a verified customer account is never promoted, and nothing applies outside staging D1", async () => {
  const { db } = await stagingApp();
  await createStaff(db, "owner", DEMO_OWNER, "Preview Owner");
  await createCustomer(db, "founder@example.com");
  const r = issue("founder@example.com");
  assert.equal(r.status, 0, r.stderr);
  await apply(db, r.stdout);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM invitations WHERE role_id = 'owner'`).first<{ n: number }>())?.n, 0, "customer address refused (CREST-GAP-001)");

  // A database without the staging deploy's _staging_access table (production, local) rejects the SQL outright.
  const other = await createTestApp();
  await createStaff(other.db, "owner", DEMO_OWNER, "Preview Owner");
  const p = issue(FOUNDER);
  await assert.rejects(apply(other.db, p.stdout), /no such table: _staging_access/);
  assert.equal((await other.db.prepare(`SELECT COUNT(*) n FROM invitations`).first<{ n: number }>())?.n, 0);
});

test("[AUTH-003] staging additional Owner: CLI refuses anything but staging SQL for a non-demo address (exit 2, no SQL, no link)", () => {
  const cases = [
    run("--staging-additional-owner", "--email", FOUNDER, "--url", STAGING_URL),                                         // no --print-sql
    run("--staging-additional-owner", "--print-sql", "--email", FOUNDER, "--url", "https://crestmontwebsitedevelopment.com"), // production URL
    run("--staging-additional-owner", "--print-sql", "--email", DEMO_OWNER, "--url", STAGING_URL),                       // demo domain
  ];
  for (const c of cases) {
    assert.equal(c.status, 2, c.stderr);
    assert.equal(c.stdout, "");
    assert.doesNotMatch(c.stderr, /invite\?token=/);
  }
});
