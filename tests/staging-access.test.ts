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
import { applyAccess, accessReadme, annotation, D1_READ_ATTEMPTS, type D1Ops } from "../scripts/staging-access.ts";
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
import { decode, decodeEntities, stripTags } from "../scripts/verify-staging-access.ts";

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

test("[INFRA-002] [SEC-001] staging verifier strips nested and split tags to a fixed point (no tag can reassemble)", () => {
  assert.equal(stripTags("<<b>script>alert(1)<</b>/script>"), "alert(1)");
  assert.equal(stripTags("<scr<i>ipt>x"), "x");
  assert.equal(stripTags("<<<a>>>b"), "b", "repeated passes peel every nested layer");
  assert.doesNotMatch(stripTags("<<<<<<x>>>>>>"), /<[^<>]*>/);
  assert.equal(decode("<a>&lt;script&gt;</a>"), "<script>", "an escaped label is decoded once into plain text (compared, never rendered)");
  assert.equal(stripTags("Refunds & disputes > 30 days"), "Refunds & disputes > 30 days", "a lone '>' or '&' in text is kept");
});

test("[INFRA-006] a failed wrangler call reports what wrangler said, with the account id elided", async () => {
  // execFileSync pipes stderr, so Node's error holds wrangler's real complaint — and every caller used to
  // report only "Command failed: npx --yes wrangler@… d1 execute …". Deploy #150's research E2E failed seven
  // checks that way, starting with owner.sign_in, and nothing recorded why the query was refused.
  const { wranglerOps } = await import("../scripts/staging-access.ts");
  const dir = mkdtempSync(join(tmpdir(), "wrangler-stub-"));
  try {
    const stub = join(dir, "stub.mjs");
    // Colour codes, an account id, a blank line and a message on each stream: all of it must come back usable.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(stub, [
      `process.stderr.write("\\u001b[31m\\u2718 [ERROR]\\u001b[0m A request to the Cloudflare API `
        + `(/accounts/acct0123456789abcdef/d1/database/dbid/query) failed.\\n\\n  no such column: count\\n");`,
      `process.stdout.write("trailing stdout\\n");`,
      `process.exit(1);`,
    ].join("\n"));

    const prev = process.env.WRANGLER;
    process.env.WRANGLER = `${process.execPath} ${stub}`;
    try {
      let message = "";
      try { await wranglerOps().query("SELECT window_start, count FROM rate_limits WHERE key = 'mfa:usr_x'"); }
      catch (e) { message = (e as Error).message; }

      assert.ok(message, "the call fails");
      assert.match(message, /wrangler said:/, "the cause is reported, not only that a command failed");
      assert.match(message, /no such column: count/, "wrangler's own diagnosis survives");
      assert.match(message, /trailing stdout/, "stdout is included too: wrangler does not always use stderr");
      assert.match(message, /\(exit 1\)/);
      assert.ok(!message.includes("acct0123456789abcdef"), "the Cloudflare account id is elided");
      assert.match(message, /\/accounts\/…\//);
      // Node's own message embeds the raw stderr, so the colour codes have to be stripped from it as well,
      // otherwise the GitHub annotation is unreadable.
      assert.ok(!message.includes("\u001b["), "no terminal colour codes");
    } finally {
      if (prev === undefined) delete process.env.WRANGLER; else process.env.WRANGLER = prev;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[INFRA-006] the deploy's own annotation keeps the cause, not just \"Command failed\"", () => {
  // Deploy 42087171814 -- the merge of #150 -- failed at "Apply staging access" and the run said only
  //   Staging access could not be applied: Command failed: npx … d1 execute … (SELECT MAX(a.created_at) FROM audit
  // The reason D1 refused the query appeared nowhere, because the annotation kept only the first line of the
  // message while wranglerOps puts wrangler's complaint on the SECOND. The cause has to survive the printing too.
  const LF = String.fromCharCode(10);
  const e = new Error([
    "Command failed: npx --yes wrangler@4.149.0 d1 execute crestmont-staging --remote --env staging (exit 1)",
    "  wrangler said: ✘ [ERROR] D1_ERROR: internal error; reference = 4q6b19qrbnaus0gl55cg4lf4",
  ].join(LF));

  const a = annotation(e);
  assert.match(a, /wrangler said:/, "the cause reaches the annotation");
  assert.match(a, /D1_ERROR: internal error; reference = 4q6b19qrbnaus0gl55cg4lf4/,
    "including Cloudflare's reference id, which is how a platform fault is told apart from one of ours");
  assert.ok(!a.includes(LF), "an annotation is one line: GitHub drops everything after a real newline");
  assert.match(a, /%0A/, "the line break is encoded, so the log still reads as two lines");

  // A long message is cut, but the cut is visible rather than silent.
  const long = annotation(new Error("x".repeat(4000)), 120);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith("…"), "the truncation is marked");

  // "::" inside the text would close the workflow command early and hide everything after it.
  assert.ok(!annotation(new Error("endgroup::then nothing")).includes("::"),
    "a :: in the message cannot terminate the annotation");
});

test("[INFRA-006] a staging read survives a transient Cloudflare fault; a deterministic refusal still fails at once", async () => {
  // The same narrow rule the Worker applies (isTransientDbError, src/lib/db.ts), now on the deploy's side of
  // the wire. Before this, one `D1_ERROR: internal error` at step 28 skipped every post-deploy verification the
  // staging deploy performs: the access sequence, TLS, smoke checks, the browser journeys, CRM and research.
  // Like the [INFRA-006] test above, this drives the real wranglerOps by pointing WRANGLER at a stub. That
  // command is split on spaces (the workflow passes "npx --yes wrangler@4.149.0"), so on a machine whose node
  // lives under "C:\Program Files" the spawn fails before the stub runs and both tests fail locally. CI is
  // Linux, where the interpreter path has no space.
  const { wranglerOps } = await import("../scripts/staging-access.ts");
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "wrangler-retry-"));
  const prev = process.env.WRANGLER;
  const LF = String.fromCharCode(10), SEP = String.fromCharCode(92);
  try {
    // Fails with Cloudflare's own transient fault on the first two calls, then answers.
    const stub = join(dir, "stub.mjs");
    const counter = join(dir, "calls").split(SEP).join("/");
    writeFileSync(stub, [
      `import { appendFileSync, readFileSync } from "node:fs";`,
      `appendFileSync("${counter}", "x");`,
      `const n = readFileSync("${counter}", "utf8").length;`,
      `if (n < 3) { process.stderr.write("[ERROR] D1_ERROR: internal error; reference = abc" + n); process.exit(1); }`,
      `process.stdout.write(JSON.stringify([{ results: [{ n }], success: true }]));`,
    ].join(LF));
    process.env.WRANGLER = `${process.execPath} ${stub}`;

    const rows = await wranglerOps().query<{ n: number }>("SELECT 1");
    assert.deepEqual(rows, [{ n: 3 }], "the read succeeds on the third attempt");
    assert.equal(D1_READ_ATTEMPTS, 3, "one try plus two retries, as the Worker does");

    // A deterministic refusal must not be retried: it would turn a clear failure into a slow one.
    const bad = join(dir, "bad.mjs");
    const badCounter = join(dir, "bad-calls").split(SEP).join("/");
    writeFileSync(bad, [
      `import { appendFileSync } from "node:fs";`,
      `appendFileSync("${badCounter}", "x");`,
      `process.stderr.write("[ERROR] no such column: count");`,
      `process.exit(1);`,
    ].join(LF));
    process.env.WRANGLER = `${process.execPath} ${bad}`;

    let message = "";
    try { await wranglerOps().query("SELECT count FROM rate_limits"); } catch (e) { message = (e as Error).message; }
    assert.match(message, /no such column: count/, "the real refusal is reported");
    assert.equal(readFileSync(badCounter, "utf8").length, 1, "attempted exactly once");
  } finally {
    if (prev === undefined) delete process.env.WRANGLER; else process.env.WRANGLER = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[INFRA-006] no deploy script reduces a wrangler error to its first line", async () => {
  // The regression guard. wranglerOps attaches the cause on a second line, so any annotation built from the
  // first line alone silently throws it away -- which is how a failed deploy came to have no stated reason.
  // staging-binding-guard.ts is exempt: it builds single-line errors of its own and imports nothing from here.
  const { readdirSync } = await import("node:fs");
  const ESC = String.fromCharCode(92), QUOTES = [String.fromCharCode(34), String.fromCharCode(39)];
  const offenders: string[] = [];
  for (const name of readdirSync("scripts").filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join("scripts", name), "utf8");
    if (name !== "staging-access.ts" && !text.includes(`from "./staging-access.ts"`)) continue;
    for (const line of text.split(/\r?\n/)) {
      // The needle is assembled, not written: it has to be the two characters backslash and n as they
      // appear in the file being read, not a line feed.
      const dropsTheCause = QUOTES.some((q) => line.includes(".split(" + q + ESC + "n" + q + ")[0]"));
      if (/::error/.test(line) && dropsTheCause) offenders.push(`${name}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, [], "these annotations would drop what wrangler said");
});
