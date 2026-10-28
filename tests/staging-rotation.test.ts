// Security remediation 2026-10-28 (F-18): what a staging credential rotation must invalidate, beyond passwords
// and 2FA keys. Uses the same in-memory staging database as tests/staging-access.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../dev/sqlite-d1.ts";
import { syncRequirements } from "../src/readiness/ingest.ts";
import { applyAccess, previewFingerprint, type D1Ops } from "../scripts/staging-access.ts";

const KEY = "test-root-key-0123456789abcdef";
const FOUNDER = "founder chosen phrase 42";

async function stagingDb() {
  const dir = mkdtempSync(join(tmpdir(), "rot-"));
  execFileSync(process.execPath, ["--no-warnings", "scripts/seed-staging.ts", "--out", join(dir, "seed.sql"), "--credentials", join(dir, "creds.md")], { stdio: "pipe" });
  const db = openDb(":memory:");
  await syncRequirements(db);
  db.raw.exec(readFileSync(join(dir, "seed.sql"), "utf8"));
  rmSync(dir, { recursive: true, force: true });
  const secrets: Record<string, string> = {};
  const ops: D1Ops = {
    async query(sql) { return db.raw.prepare(sql).all() as never; },
    async execFile(path) { db.raw.exec(readFileSync(path, "utf8")); },
    async putSecret(name, value) { secrets[name] = value; },
  };
  return { db, ops, secrets };
}
const one = (db: ReturnType<typeof openDb>, sql: string) => db.raw.prepare(sql).get() as Record<string, unknown>;

test("[INFRA-002] [SEC-007] rotation also removes recovery codes, pending authenticator enrolments and invitations made with the old credentials", async () => {
  const s = await stagingDb();
  await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false });
  const owner = one(s.db, `SELECT id FROM users WHERE email LIKE 'owner%@crestmont-preview.test' OR id IN (SELECT user_id FROM memberships WHERE role_id = 'owner') LIMIT 1`).id as string;
  const now = new Date().toISOString(), later = new Date(Date.now() + 7 * 86400e3).toISOString();
  // What an intruder holding the leaked Owner password and 2FA key could have left behind:
  s.db.raw.exec(`INSERT INTO mfa_recovery_codes (id, user_id, lookup, code_hash, created_at) VALUES ('rc_x', '${owner}', 'lk', 'h', '${now}');
    UPDATE users SET totp_pending_secret = 'PENDINGSECRET' WHERE id = '${owner}';
    INSERT INTO invitations (id, email, organization_id, role_id, token_hash, invited_by, expires_at) VALUES ('inv_x', 'intruder@example.com', (SELECT organization_id FROM memberships WHERE user_id = '${owner}' LIMIT 1), 'administrator', 'th', '${owner}', '${later}');`);
  const r = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: true });
  assert.equal(r.rotated, true);
  assert.equal(one(s.db, `SELECT COUNT(*) n FROM mfa_recovery_codes WHERE user_id = '${owner}'`).n, 0, "recovery codes removed");
  assert.equal(one(s.db, `SELECT totp_pending_secret p FROM users WHERE id = '${owner}'`).p, null, "pending enrolment cleared");
  assert.ok(String(one(s.db, `SELECT expires_at e FROM invitations WHERE id = 'inv_x'`).e) <= new Date().toISOString(), "pending invitation expired");
});

test("[INFRA-002] [SEC-007] a rotation retires the live preview password, including a Founder-fixed one; retired values are never re-issued", async () => {
  const s = await stagingDb();
  // First issue with a Founder-fixed password: honoured, and NOT retired (nothing was live before).
  const r1 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false, fixedPreviewPassword: FOUNDER });
  assert.equal(r1.previewSource, "founder");
  assert.equal(s.secrets.STAGING_ACCESS_PASSWORD, FOUNDER);
  // Exposure → rotation with the same secret still configured: the fixed value is retired, a derived one is used.
  const r2 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: true, fixedPreviewPassword: FOUNDER });
  assert.equal(r2.previewSource, "derived");
  assert.equal(r2.fixedPreviewRetired, true);
  assert.notEqual(s.secrets.STAGING_ACCESS_PASSWORD, FOUNDER);
  // Later ordinary deploys keep ignoring it while the secret still holds the retired value.
  const r3 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false, fixedPreviewPassword: FOUNDER });
  assert.equal(r3.previewSource, "derived");
  assert.equal(r3.previewPassword, r2.previewPassword, "no drift between runs");
  // A NEW Founder value is honoured again.
  const r4 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false, fixedPreviewPassword: "a brand new founder phrase 7" });
  assert.equal(r4.previewSource, "founder");
  // A derived password that was live is retired too: after another rotation it never comes back.
  const derivedBefore = r3.previewPassword;
  await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: true });
  const keys = (s.db.raw.prepare(`SELECT key FROM _staging_access WHERE key LIKE 'retired_preview:%'`).all() as { key: string }[]).map((k) => k.key);
  assert.ok(keys.includes(`retired_preview:${await previewFingerprint(KEY, derivedBefore)}`));
  assert.ok(keys.includes(`retired_preview:${await previewFingerprint(KEY, FOUNDER)}`));
  // Only fingerprints are stored, never the passwords.
  const dump = JSON.stringify(s.db.raw.prepare(`SELECT * FROM _staging_access`).all());
  assert.ok(!dump.includes(FOUNDER) && !dump.includes(derivedBefore));
});
