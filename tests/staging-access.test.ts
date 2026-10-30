import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../dev/sqlite-d1.ts";
import { handle } from "../src/app/app.ts";
import { syncRequirements } from "../src/readiness/ingest.ts";
import type { Env } from "../src/app/context.ts";
import { applyAccess, accessReadme, type D1Ops } from "../scripts/staging-access.ts";
import { verifyStagingAccess } from "../scripts/verify-staging-access.ts";

const BASE = "https://crestmont-platform-staging.example.workers.dev";

async function stagingDb() {
  const dir = mkdtempSync(join(tmpdir(), "acc-"));
  execFileSync(process.execPath, ["--no-warnings", "scripts/seed-staging.ts", "--out", join(dir, "seed.sql"), "--credentials", join(dir, "creds.md")], { stdio: "pipe" });
  const db = openDb(":memory:");
  await syncRequirements(db);
  db.raw.exec(readFileSync(join(dir, "seed.sql"), "utf8"));
  const seedCreds = readFileSync(join(dir, "creds.md"), "utf8");
  rmSync(dir, { recursive: true, force: true });
  const secrets: Record<string, string> = {};
  const ops: D1Ops = {
    async query(sql) { return db.raw.prepare(sql).all() as never; },
    async execFile(path) { db.raw.exec(readFileSync(path, "utf8")); },
    async putSecret(name, value) { secrets[name] = value; },
  };
  // The deployed staging configuration: public (no PREVIEW_GATE), even if an old STAGING_ACCESS_PASSWORD secret is still set.
  const env = (): Env => ({ DB: db, ENVIRONMENT: "staging", APP_URL: BASE, STAGING_ACCESS_PASSWORD: "leftover-old-preview-secret" });
  const fetchFor = (e: Env) => async (url: string, init?: RequestInit) => handle(new Request(url, init), e);
  return { db, ops, secrets, env, fetchFor, seedCreds };
}

const ownerOf = (r: Awaited<ReturnType<typeof applyAccess>>) => { const o = r.accounts.find((a) => a.role === "owner")!; return { email: o.email, password: o.password, totp: o.totp! }; };
const KEY = "test-root-key-0123456789abcdef";

test("[INFRA-002] staging access: public site, artifact and live accounts agree; full Owner sequence with MFA verified; rotation revokes old credentials", async () => {
  const s = await stagingDb();

  // First run after this change: rotates (no salt yet) and applies the demo credentials. No preview password is issued.
  const r1 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false });
  assert.equal(r1.rotated, true);
  assert.equal(s.secrets.STAGING_ACCESS_PASSWORD, undefined, "no preview password secret is written");
  assert.match(ownerOf(r1).password, /^[2-9a-km-zA-HJ-NP-Z]{5}(-[2-9a-km-zA-HJ-NP-Z]{5}){3}$/, "unambiguous characters, no markdown-active symbols");
  assert.equal(r1.accounts.length, 8);
  const owner1 = ownerOf(r1);
  assert.match(owner1.totp, /^[A-Z2-7]{32}$/);

  // The complete sequence the Founder follows, over the real request pipeline.
  const v = await verifyStagingAccess({ base: BASE, owner: owner1 }, s.fetchFor(s.env()));
  assert.deepEqual(v, { modules: 32, pages: 32 });

  // The seed's own random credentials (what an older artifact would have held) no longer work.
  const seedOwner = /^\| owner \| (\S+) \| `([^`]+)` \| `([A-Z2-7]+)` \|/m.exec(s.seedCreds)!;
  await assert.rejects(verifyStagingAccess({ base: BASE, owner: { email: seedOwner[1], password: seedOwner[2], totp: seedOwner[3] } }, s.fetchFor(s.env())), /Owner password/);

  // A later run without rotation reports identical credentials (no silent drift between runs).
  const r2 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false });
  assert.equal(r2.rotated, false);
  assert.deepEqual(r2.accounts, r1.accounts);
  s.db.raw.prepare("UPDATE users SET totp_last_step = NULL").run(); // next 30 s window
  await verifyStagingAccess({ base: BASE, owner: ownerOf(r2) }, s.fetchFor(s.env()));

  // An Owner session exists; rotation must revoke it along with every old credential.
  const sessionsBefore = (s.db.raw.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
  assert.ok(sessionsBefore > 0);
  const r3 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: true });
  assert.equal(r3.rotated, true);
  assert.notEqual(ownerOf(r3).password, owner1.password);
  assert.notEqual(ownerOf(r3).totp, owner1.totp, "2FA setup key rotated");
  assert.equal((s.db.raw.prepare(`SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email LIKE '%@crestmont-preview.test'`).get() as { n: number }).n, 0, "demo sessions revoked");
  await assert.rejects(verifyStagingAccess({ base: BASE, owner: owner1 }, s.fetchFor(s.env())), /Owner password/, "old Owner password refused after rotation");
  s.db.raw.prepare("UPDATE users SET totp_last_step = NULL").run();
  await verifyStagingAccess({ base: BASE, owner: ownerOf(r3) }, s.fetchFor(s.env()));

  // Bumping ACCESS_EPOCH in the workflow forces a rotation without anyone ticking a box.
  assert.equal((await applyAccess(s.ops, { rootKey: KEY, epoch: "3", rotate: false })).rotated, true);

  assert.equal(s.secrets.STAGING_ACCESS_PASSWORD, undefined, "still no preview password secret after rotations");

  // The artifact README carries the required items and no preview password.
  const md = accessReadme(BASE, r3, "2026-10-27T08:00:00.000Z");
  assert.doesNotMatch(md, /## \d\. Preview password/);
  for (const item of [BASE, ownerOf(r3).email, ownerOf(r3).password, ownerOf(r3).totp]) assert.ok(md.includes(item));
  assert.match(md, /Verified by the deploy run/);
});

test("[INFRA-002] staging access refuses to run without a root key", async () => {
  const s = await stagingDb();
  await assert.rejects(applyAccess(s.ops, { rootKey: "", epoch: "2", rotate: false }), /ACCESS_ROOT_KEY/);
});

test("[INFRA-002] [SEC-004] staging access writes a demo 2FA secret only when it changes, never re-plaintexts an encrypted one, and seals it when given MFA_ENCRYPTION_KEY", async () => {
  const s = await stagingDb();
  const mfaKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const { openWithKey } = await import("../src/lib/totp-secrets.ts");
  const stored = (id: string) => (s.db.raw.prepare(`SELECT totp_secret AS t FROM users WHERE id = ?`).get(id) as { t: string | null }).t;
  const ownerId = (email: string) => (s.db.raw.prepare(`SELECT id FROM users WHERE email = ?`).get(email) as { id: string }).id;

  // First run without a key (key not configured in GitHub): plaintext, as before; fingerprint recorded.
  const r1 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false });
  const owner = ownerOf(r1), id = ownerId(owner.email);
  assert.equal(stored(id), owner.totp);

  // The Worker later encrypts it at rest (next sign-in or the migration script). A redeploy must leave it alone.
  const { sealWithKey } = await import("../src/lib/totp-secrets.ts");
  const sealed = await sealWithKey(mfaKey, id, owner.totp);
  s.db.raw.prepare(`UPDATE users SET totp_secret = ? WHERE id = ?`).run(sealed, id);
  const r2 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false });
  assert.equal(r2.rotated, false);
  assert.equal(ownerOf(r2).totp, owner.totp, "same reported setup key");
  assert.equal(stored(id), sealed, "the encrypted value is not overwritten with plaintext");
  s.db.raw.prepare("UPDATE users SET totp_last_step = NULL").run();
  await verifyStagingAccess({ base: BASE, owner: ownerOf(r2) }, s.fetchFor({ ...s.env(), MFA_ENCRYPTION_KEY: mfaKey }));

  // A secret that was cleared (e.g. an MFA reset) is written again even though the marker matches. A deploy key is
  // given, but no secret encrypted by the Worker exists yet to prove it is the Worker's key: written in plaintext.
  s.db.raw.prepare(`UPDATE users SET totp_secret = NULL WHERE id = ?`).run(id);
  const r4 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false, mfaKey });
  assert.equal(r4.totpStorage, "plaintext-unverified");
  assert.equal(stored(id), owner.totp);
  // The real sign-in path (Worker holds the key) encrypts it at rest.
  s.db.raw.prepare("UPDATE users SET totp_last_step = NULL").run();
  await verifyStagingAccess({ base: BASE, owner: ownerOf(r4) }, s.fetchFor({ ...s.env(), MFA_ENCRYPTION_KEY: mfaKey }));
  assert.match(stored(id)!, /^v1:/, "encrypted by the Worker at sign-in");
  assert.equal(await openWithKey(mfaKey, id, stored(id)!), owner.totp);
  await assert.rejects(openWithKey(mfaKey, "usr_other", stored(id)!)); // bound to this user

  // A deploy key that is NOT the Worker's (or is malformed) stops the run before anything is written — even a rotation.
  const before = s.db.raw.prepare(`SELECT key, value FROM _staging_access ORDER BY key`).all();
  const usersBefore = s.db.raw.prepare(`SELECT id, password_hash, totp_secret FROM users ORDER BY id`).all();
  const wrongKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  await assert.rejects(applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: true, mfaKey: wrongKey }), /does not match the staging Worker's MFA_ENCRYPTION_KEY[\s\S]*nothing was written/);
  await assert.rejects(applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: true, mfaKey: "short" }), /malformed[\s\S]*nothing was written/);
  assert.deepEqual(s.db.raw.prepare(`SELECT key, value FROM _staging_access ORDER BY key`).all(), before);
  assert.deepEqual(s.db.raw.prepare(`SELECT id, password_hash, totp_secret FROM users ORDER BY id`).all(), usersBefore);

  // Rotation with the proven key: every demo secret is new and stored encrypted, none in plaintext.
  const r3 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: true, mfaKey });
  assert.equal(r3.totpStorage, "encrypted");
  assert.notEqual(ownerOf(r3).totp, owner.totp);
  const demo = s.db.raw.prepare(`SELECT id, totp_secret AS t FROM users WHERE email LIKE '%@crestmont-preview.test' AND totp_secret IS NOT NULL`).all() as { id: string; t: string }[];
  assert.ok(demo.length > 0);
  for (const d of demo) assert.match(d.t, /^v1:/, `${d.id} stored encrypted`);
  assert.equal(await openWithKey(mfaKey, id, stored(id)!), ownerOf(r3).totp);
  s.db.raw.prepare("UPDATE users SET totp_last_step = NULL").run();
  await verifyStagingAccess({ base: BASE, owner: ownerOf(r3) }, s.fetchFor({ ...s.env(), MFA_ENCRYPTION_KEY: mfaKey }));
  // A redeploy without rotation leaves every encrypted secret byte-for-byte unchanged.
  const sealedAll = s.db.raw.prepare(`SELECT id, totp_secret FROM users ORDER BY id`).all();
  const r6 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false, mfaKey });
  assert.deepEqual(ownerOf(r6), ownerOf(r3));
  assert.deepEqual(s.db.raw.prepare(`SELECT id, totp_secret FROM users ORDER BY id`).all(), sealedAll);

  // If the root key changes (Cloudflare token replaced) the derived setup keys change, so they are rewritten and the
  // reported key always matches the stored one.
  const r7 = await applyAccess(s.ops, { rootKey: KEY + "-replaced", epoch: "2", rotate: false, mfaKey });
  assert.notEqual(ownerOf(r7).totp, ownerOf(r3).totp);
  assert.equal(await openWithKey(mfaKey, id, stored(id)!), ownerOf(r7).totp);

  // Stored markers are 64-hex HMACs over derivation inputs; the artifact never carries the key.
  const meta = s.db.raw.prepare(`SELECT key, value FROM _staging_access WHERE key LIKE 'totp_fp:%'`).all() as { key: string; value: string }[];
  assert.ok(meta.length >= demo.length);
  for (const m of meta) { assert.match(m.value, /^[0-9a-f]{64}$/); assert.notEqual(m.value, ownerOf(r7).totp); }
  assert.ok(!accessReadme(BASE, r7, "2026-10-28T00:00:00.000Z").includes(mfaKey));
});

test("[INFRA-002] [SEC-004] staging access: adopts secrets the Worker already encrypted (no plaintext rewrite on the first run), heals a replaced demo authenticator, and clears a reviewer-caused 2FA lock", async () => {
  const s = await stagingDb();
  const mfaKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const { sealWithKey, openWithKey } = await import("../src/lib/totp-secrets.ts");
  const stored = (id: string) => (s.db.raw.prepare(`SELECT totp_secret AS t FROM users WHERE id = ?`).get(id) as { t: string | null }).t;
  const idOf = (email: string) => (s.db.raw.prepare(`SELECT id FROM users WHERE email = ?`).get(email) as { id: string }).id;

  // A database from before this change: credentials applied, then the Worker encrypted the Owner's secret, and no
  // change markers exist yet.
  const r1 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false });
  const owner = ownerOf(r1), id = idOf(owner.email);
  s.db.raw.prepare(`DELETE FROM _staging_access WHERE key LIKE 'totp_%'`).run();
  const sealed = await sealWithKey(mfaKey, id, owner.totp);
  s.db.raw.prepare(`UPDATE users SET totp_secret = ? WHERE id = ?`).run(sealed, id);
  await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false });
  assert.equal(stored(id), sealed, "first run of the new logic adopts the encrypted secret instead of writing plaintext");

  // A reviewer replaces the demo Owner's authenticator (POST /mfa/setup writes user.mfa_enabled). The next deploy
  // restores the published setup key, so demo-accounts.md stays true.
  const other = await sealWithKey(mfaKey, id, "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
  s.db.raw.prepare(`UPDATE users SET totp_secret = ? WHERE id = ?`).run(other, id);
  s.db.raw.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, created_at) VALUES (?, 'user', 'user.mfa_enabled', 'user', ?, ?)`).run(id, id, new Date(Date.now() + 1000).toISOString());
  await new Promise((r) => setTimeout(r, 1100));
  const r2 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false });
  assert.equal(stored(id), owner.totp, "healed (in plaintext without a proven deploy key; the Worker re-encrypts at sign-in)");
  assert.equal(ownerOf(r2).totp, owner.totp);
  // With a proven deploy key a replaced secret is detected by decrypting it, and healed encrypted.
  s.db.raw.prepare(`UPDATE users SET totp_secret = ? WHERE id = ?`).run(sealed, id); // something encrypted → key provable
  const someoneElse = s.db.raw.prepare(`SELECT id FROM users WHERE email LIKE '%@crestmont-preview.test' AND id != ? AND totp_secret IS NOT NULL LIMIT 1`).get(id) as { id: string };
  s.db.raw.prepare(`UPDATE users SET totp_secret = ? WHERE id = ?`).run(await sealWithKey(mfaKey, someoneElse.id, "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"), someoneElse.id);
  const r3 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false, mfaKey });
  assert.equal(r3.totpStorage, "encrypted");
  assert.equal(stored(id), sealed, "an encrypted secret that already matches is left byte-for-byte");
  const healed = stored(someoneElse.id)!;
  assert.match(healed, /^v1:/);
  assert.equal(await openWithKey(mfaKey, someoneElse.id, healed), r3.accounts.find((a) => idOf(a.email) === someoneElse.id)!.totp, "mismatching secret healed, encrypted");

  // Reviewers sharing the demo password exhaust the daily wrong-code cap; the next deploy restarts the count.
  for (let i = 0; i < 30; i++) s.db.raw.prepare(`INSERT INTO security_events (kind, user_id, detail, created_at) VALUES ('mfa_failed', ?, 'totp; login', ?)`).run(id, new Date().toISOString());
  await new Promise((r) => setTimeout(r, 5));
  const r4 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false, mfaKey });
  assert.ok(s.db.raw.prepare(`SELECT 1 FROM audit_logs WHERE action = 'user.mfa_provisioned' AND subject_id = ?`).get(id), "provisioning recorded");
  s.db.raw.prepare("UPDATE users SET totp_last_step = NULL").run();
  await new Promise((r) => setTimeout(r, 5));
  await verifyStagingAccess({ base: BASE, owner: ownerOf(r4) }, s.fetchFor({ ...s.env(), MFA_ENCRYPTION_KEY: mfaKey }));
});

// CodeQL js/double-escaping: the verifier's HTML decoder must decode each character reference exactly once.
import { decode, decodeEntities } from "../scripts/verify-staging-access.ts";

test("[INFRA-002] [SEC-001] staging verifier decodes HTML entities in a single pass: nested references stay literal", () => {
  assert.equal(decodeEntities("&amp;#39;"), "&#39;");
  assert.equal(decodeEntities("&amp;quot;"), "&quot;");
  assert.equal(decodeEntities("&amp;amp;"), "&amp;");
  assert.equal(decodeEntities("&#38;lt;"), "&lt;");
  assert.equal(decodeEntities("&#x26;#x27;"), "&#x27;");
  assert.equal(decode("<a>Q&amp;A &amp;lt;b&amp;gt;</a>"), "Q&A &lt;b&gt;");
});

test("[INFRA-002] [SEC-001] staging verifier decodes legitimate encoded text exactly as escapeHtml produced it", async () => {
  const { escapeHtml } = await import("../src/lib/html.ts");
  for (const label of ["Refunds & disputes", "Owner's \"command\" center", "Tax <beta>", "a`b", "Plain label"]) assert.equal(decode(`<a class="side-link"><span>${escapeHtml(label)}</span></a>`), label, label);
  assert.equal(decodeEntities("/staff/x?a=1&amp;b=2"), "/staff/x?a=1&b=2", "hrefs: &amp; separators");
  assert.equal(decode("  Profit &nbsp; &amp;\n loss  "), "Profit & loss");
});

test("[INFRA-002] [SEC-001] staging verifier leaves malformed references alone and never yields invalid characters", () => {
  assert.equal(decodeEntities("&amp"), "&amp");
  assert.equal(decodeEntities("&bogus;"), "&bogus;");
  assert.equal(decodeEntities("&#;&#x;&#xZZ;"), "&#;&#x;&#xZZ;");
  assert.equal(decodeEntities("&#0;&#xD800;&#1114112;"), "���");
  assert.equal(decodeEntities("&#99999999999;"), "&#99999999999;");
  assert.doesNotThrow(() => decode("&".repeat(5000) + "<".repeat(5000)));
});
