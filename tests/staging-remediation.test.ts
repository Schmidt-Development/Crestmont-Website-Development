// Staging credential-exposure remediation (2026-10-28): sealed delivery, complete revocation on rotation, the
// pre-rotation delivery gate, the revocation proof over real HTTP, the forensic snapshot and the workflow guards.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../dev/sqlite-d1.ts";
import { handle } from "../src/app/app.ts";
import { syncRequirements } from "../src/readiness/ingest.ts";
import type { Env } from "../src/app/context.ts";
import { applyAccess, currentAccess, DEMO_DOMAIN, type D1Ops } from "../scripts/staging-access.ts";
import { seal, open, passphraseProblem, SealError, MAGIC } from "../scripts/seal.ts";
import { capture, verify, gate, report, rotationState } from "../scripts/staging-rotation-check.ts";
import { snapshot, summary } from "../scripts/staging-forensics.ts";

const BASE = "https://crestmont-platform-staging.example.workers.dev";
const KEY = "test-root-key-0123456789abcdef";
const PASS = "correct horse battery staple, but 32+ chars";

async function staging() {
  const dir = mkdtempSync(join(tmpdir(), "rem-"));
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
  const env = (): Env => ({ DB: db, ENVIRONMENT: "staging", APP_URL: BASE }); // the deployed staging configuration: public, no preview gate
  const f = async (url: string, init?: RequestInit) => handle(new Request(url, init), env());
  return { db, ops, secrets, f };
}
const one = (db: Awaited<ReturnType<typeof staging>>["db"], sql: string) => Number((db.raw.prepare(sql).get() as { n: number }).n);
/** Real crypto and HTTP, simulated clock: each "sleep" advances Date, so 30-second 2FA steps pass instantly. */
const fakeClock = (t: TestContext) => { t.mock.timers.enable({ apis: ["Date"], now: Date.now() }); return async (ms: number) => { t.mock.timers.tick(ms); }; };

test("[INFRA-002] sealed delivery: AES-256-GCM round trip; wrong passphrase, tampering and weak passphrases are refused; no plaintext in the file", () => {
  const plain = Buffer.from("Owner password: `abcde-fghij`\n2FA setup key: `JBSWY3DPEHPK3PXP`\n");
  const sealed = seal(plain, PASS);
  assert.ok(sealed.subarray(0, MAGIC.length).equals(MAGIC));
  assert.equal(sealed.includes(Buffer.from("abcde-fghij")), false);
  assert.equal(sealed.includes(Buffer.from("JBSWY3DPEHPK3PXP")), false);
  assert.deepEqual(open(sealed, PASS), plain);
  assert.throws(() => open(sealed, PASS + "x"), SealError);
  const tampered = Buffer.from(sealed); tampered[tampered.length - 20] ^= 1;
  assert.throws(() => open(tampered, PASS), SealError);
  const header = Buffer.from(sealed); header[10] ^= 1;   // the header (salt) is authenticated too
  assert.throws(() => open(header, PASS), SealError);
  assert.match(passphraseProblem(undefined) ?? "", /not configured/);
  assert.match(passphraseProblem("short") ?? "", /shorter than 32/);
  assert.match(passphraseProblem("a".repeat(40)) ?? "", /variety/);
  assert.equal(passphraseProblem(PASS), null);
  assert.throws(() => seal(plain, "short"), SealError);
  assert.notDeepEqual(seal(plain, PASS), sealed, "fresh salt and IV every time");
});

test("[INFRA-002] rotation also revokes demo recovery codes and pending demo invitations, is audited, and leaves real accounts alone", async () => {
  const s = await staging();
  await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false });
  const demoOwner = (s.db.raw.prepare(`SELECT u.id, m.organization_id AS org FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.role_id = 'owner' AND u.email LIKE '%@${DEMO_DOMAIN}'`).get()) as { id: string; org: string };
  const future = new Date(Date.now() + 7 * 864e5).toISOString(), now = new Date().toISOString();
  s.db.raw.exec(`
    INSERT INTO users (id, email, display_name, mfa_enabled, created_at) VALUES ('usr_real', 'founder@crestmont.example', 'Founder', 1, '${now}');
    INSERT INTO mfa_recovery_codes (id, user_id, lookup, code_hash, created_at) VALUES ('rc1', '${demoOwner.id}', 'abcd', 'h', '${now}'), ('rc2', 'usr_real', 'efgh', 'h', '${now}');
    INSERT INTO invitations (id, email, organization_id, role_id, token_hash, invited_by, expires_at) VALUES
      ('inv_open', 'x@attacker.example', '${demoOwner.org}', 'owner', 't1', '${demoOwner.id}', '${future}'),
      ('inv_done', 'y@ok.example', '${demoOwner.org}', 'support', 't2', '${demoOwner.id}', '${future}'),
      ('inv_real', 'z@ok.example', '${demoOwner.org}', 'support', 't3', 'usr_real', '${future}');
    UPDATE invitations SET accepted_at = '${now}' WHERE id = 'inv_done';
    INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES ('s_demo', '${demoOwner.id}', 'th1', '${now}', '${future}'), ('s_real', 'usr_real', 'th2', '${now}', '${future}');`);
  const r = await applyAccess(s.ops, { rootKey: KEY, epoch: "3", rotate: false });
  assert.equal(r.rotated, true);
  assert.deepEqual(r.revoked, { sessions: 1, authTokens: 0, recoveryCodes: 1, invitations: 1 });
  assert.equal(one(s.db, `SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = '${demoOwner.id}'`), 0);
  assert.equal(one(s.db, `SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = 'usr_real'`), 1, "real account's codes untouched");
  assert.equal(one(s.db, `SELECT COUNT(*) AS n FROM invitations WHERE id = 'inv_open' AND expires_at > '${new Date().toISOString()}'`), 0, "pending demo invitation expired");
  assert.equal(one(s.db, `SELECT COUNT(*) AS n FROM invitations WHERE id = 'inv_real' AND expires_at = '${future}'`), 1, "real account's invitation untouched");
  assert.equal(one(s.db, `SELECT COUNT(*) AS n FROM sessions WHERE id = 's_real'`), 1, "real account's session untouched");
  assert.equal(one(s.db, `SELECT COUNT(*) AS n FROM sessions WHERE id = 's_demo'`), 0);
  const a = s.db.raw.prepare(`SELECT actor_kind, details_json FROM audit_logs WHERE action = 'staging.access_rotated' AND subject_id = '3'`).get() as { actor_kind: string; details_json: string };
  assert.equal(a.actor_kind, "system");
  assert.deepEqual(JSON.parse(a.details_json).revoked, r.revoked);
  assert.doesNotMatch(a.details_json, /password|totp|[A-Z2-7]{32}/i, "no credential in the audit record");
  // A non-rotating run revokes nothing.
  assert.equal((await applyAccess(s.ops, { rootKey: KEY, epoch: "3", rotate: false })).revoked, undefined);
});

test("[INFRA-002] delivery gate: a pending rotation needs a usable passphrase before any credential changes", async () => {
  const s = await staging();
  await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false });
  assert.deepEqual(await gate({ ops: s.ops, epoch: "2", rotate: false }), { pending: false, problems: [] });
  const noPass = await gate({ ops: s.ops, epoch: "3", rotate: false });
  assert.equal(noPass.pending, true);
  assert.match(noPass.problems.join(), /not configured.*could not be delivered/);
  assert.deepEqual(await gate({ ops: s.ops, epoch: "3", rotate: false, passphrase: PASS }), { pending: true, problems: [] });
  assert.equal((await gate({ ops: s.ops, epoch: "2", rotate: true, passphrase: "short" })).problems.length, 1, "a manual rotate also needs delivery");
});

test("[INFRA-002] revocation proof over HTTP on the public site: after rotation the old password, 2FA key, recovery code and session fail; the new ones and recovery work", async (t) => {
  const sleep = fakeClock(t);
  const s = await staging();
  await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false });
  const masked: string[] = [];
  const st = await capture({ base: BASE, ops: s.ops, rootKey: KEY, epoch: "3", rotate: false, f: s.f, sleep, out: (l) => masked.push(l) });
  assert.ok(st, "a rotation is pending, so the current access is captured");
  assert.deepEqual(st.notes, []);
  assert.ok(st.sessionCookie && st.oldRecoveryCode);
  for (const v of [st.oldOwner.password, st.oldOwner.totp, st.sessionCookie, st.oldRecoveryCode]) assert.ok(masked.includes(`::add-mask::${v}`), "every captured value is masked");
  assert.deepEqual(await currentAccess(s.ops, KEY).then((c) => c?.owner), st.oldOwner, "derived = live");

  const access = await applyAccess(s.ops, { rootKey: KEY, epoch: "3", rotate: false });
  const checks = await verify({ base: BASE, ops: s.ops, state: st, access, f: s.f, sleep, out: () => {} });
  assert.deepEqual(checks.filter((c) => !c.ok), [], report(checks));
  assert.deepEqual(checks.map((c) => c.name), [
    "Old Owner session invalid", "Old Owner password rejected",
    "New Owner password accepted (2FA requested)", "Old recovery code rejected", "Old Owner 2FA key rejected", "New Owner 2FA key accepted",
    "New recovery codes can be generated and used", "No demo recovery codes remain", "No pending invitations from demo accounts",
  ]);
  const text = report(checks);
  for (const v of [st.oldOwner.password, st.oldOwner.totp, ...access.accounts.map((a) => a.password)]) assert.equal(text.includes(v!), false, "report carries no value");
  // Nothing pending after the rotation: capture does nothing.
  assert.equal(await capture({ base: BASE, ops: s.ops, rootKey: KEY, epoch: "3", rotate: false, f: s.f, sleep, out: () => {} }), null);
});

test("[INFRA-002] forensic snapshot: every query runs on the real schema; indicators are counts only", async () => {
  const s = await staging();
  await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false });
  s.db.raw.exec(`INSERT INTO users (id, email, display_name, mfa_enabled, created_at) VALUES ('usr_x', 'someone@customer.example.co', 'X', 0, '2026-10-27T06:00:00Z')`);
  const snap = await snapshot(s.ops, "2026-01-01T00:00:00Z", "2026-10-27T08:15:00Z");
  assert.deepEqual(snap.errors, []);
  assert.equal(snap.indicators.real_looking_emails_at_export, 1);
  assert.equal(snap.indicators.real_looking_email_domains_at_export, 1);
  assert.equal(snap.indicators.users_created_outside_demo, 1);
  const text = summary(snap.indicators, snap.errors);
  assert.doesNotMatch(text, /@|customer\.example/, "the public summary names no address or domain");
});

test("[INFRA-002] workflows: no plaintext credential or database artifact; staging runs from main only; release tag never interpolated", () => {
  const wf = (n: string) => readFileSync(`.github/workflows/${n}.yml`, "utf8");
  const staging = wf("deploy-staging");
  assert.doesNotMatch(staging, /path:\s*access\/README\.md/);
  assert.doesNotMatch(staging, /openssl enc|upload=plain|aes-256-cbc/);
  assert.match(staging, /preflight:\n(?:\s+#.*\n)*\s+if: github\.ref == 'refs\/heads\/main'/);
  // Any version tag or SHA pin (CREST-GAP-063).
  const uploads = [...staging.matchAll(/upload-artifact@(?:v\d+|[0-9a-f]{40})[\s\S]*?path:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uploads.includes("access/staging-access.sealed") && uploads.includes("forensics/staging-forensics.sealed"), uploads.join());
  for (const p of uploads) assert.ok(/\.sealed$/.test(p) || /^evidence/.test(p), `unexpected upload ${p}`);
  const order = ["Credential delivery gate", "Forensic snapshot", "Apply D1 migrations", "Capture the pre-rotation access", "Apply staging access", "Verify the full access sequence", "Prove the old access is revoked", "Seal the access notes", "Remove credentials and evidence"];
  const at = order.map((n) => staging.indexOf(`- name: ${n}`));
  assert.ok(at.every((i) => i > 0), `steps present: ${order.filter((_, i) => at[i] < 0)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, "steps run in this order");
  for (const n of ["staging-restore-drill", "staging-rollback-rehearsal", "staging-health-monitor"]) assert.match(wf(n), /if: github\.ref == 'refs\/heads\/main'/, n);
  const prod = wf("deploy-production");
  assert.doesNotMatch(prod, /run:[^\n]*\$\{\{ inputs\.tag \}\}|--notes "tag \$\{\{ inputs\.tag/);
  assert.match(prod, /RELEASE_TAG: \$\{\{ inputs\.tag \}\}/);
  assert.doesNotMatch(prod, /upload-artifact[\s\S]*?path:\s*backups/, "no production database export as an artifact");
});

// Deploy #56 (preview pass refused while a rotated preview password propagated) cannot recur: staging issues no preview
// password since 2026-10-28, so there is nothing to propagate. Those regression tests were removed with the gate.

test("[INFRA-002] rotation state in D1 (read-only): complete after the rotation; a surviving pre-rotation session fails", async () => {
  const s = await staging();
  await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false });
  const before = new Date(Date.now() - 60_000).toISOString(), future = new Date(Date.now() + 864e5).toISOString();
  await applyAccess(s.ops, { rootKey: KEY, epoch: "3", rotate: false });
  const ok = await rotationState(s.ops, "3");
  assert.deepEqual(ok.filter((c) => !c.ok), [], report(ok));
  assert.equal(ok.length, 5);
  assert.equal((await rotationState(s.ops, "4")).find((c) => c.name === "Access epoch is 4")?.ok, false);
  const owner = (s.db.raw.prepare(`SELECT id FROM users WHERE email LIKE '%@${DEMO_DOMAIN}' LIMIT 1`).get()) as { id: string };
  s.db.raw.exec(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES ('s_old', '${owner.id}', 'th-old', '${before}', '${future}')`);
  assert.equal((await rotationState(s.ops, "3")).find((c) => c.name === "No demo session from before the rotation")?.ok, false);
});
