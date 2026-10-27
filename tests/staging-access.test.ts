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
  const env = (): Env => ({ DB: db, ENVIRONMENT: "staging", PREVIEW_GATE: "required", APP_URL: BASE, STAGING_ACCESS_PASSWORD: secrets.STAGING_ACCESS_PASSWORD });
  const fetchFor = (e: Env) => async (url: string, init?: RequestInit) => handle(new Request(url, init), e);
  return { db, ops, secrets, env, fetchFor, seedCreds };
}

const ownerOf = (r: Awaited<ReturnType<typeof applyAccess>>) => { const o = r.accounts.find((a) => a.role === "owner")!; return { email: o.email, password: o.password, totp: o.totp! }; };
const KEY = "test-root-key-0123456789abcdef";

test("[INFRA-002] staging access: live secret and artifact always agree; full Owner sequence verified; rotation revokes old credentials", async () => {
  const s = await stagingDb();

  // First run after this change: rotates (no salt yet), applies the secret and demo credentials.
  const r1 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false });
  assert.equal(r1.rotated, true);
  assert.equal(s.secrets.STAGING_ACCESS_PASSWORD, r1.previewPassword, "the Worker secret is exactly the reported password");
  assert.match(r1.previewPassword, /^[2-9a-km-zA-HJ-NP-Z]{5}(-[2-9a-km-zA-HJ-NP-Z]{5}){3}$/, "unambiguous characters, no markdown-active symbols");
  assert.equal(r1.accounts.length, 8);
  const owner1 = ownerOf(r1);
  assert.match(owner1.totp, /^[A-Z2-7]{32}$/);

  // The complete sequence the Founder follows, over the real request pipeline.
  const v = await verifyStagingAccess({ base: BASE, previewPassword: r1.previewPassword, owner: owner1 }, s.fetchFor(s.env()));
  assert.deepEqual(v, { modules: 32, pages: 32 });

  // The seed's own random credentials (what an older artifact would have held) no longer work.
  const seedOwner = /^\| owner \| (\S+) \| `([^`]+)` \| `([A-Z2-7]+)` \|/m.exec(s.seedCreds)!;
  await assert.rejects(verifyStagingAccess({ base: BASE, previewPassword: r1.previewPassword, owner: { email: seedOwner[1], password: seedOwner[2], totp: seedOwner[3] } }, s.fetchFor(s.env())), /Owner password/);

  // A later run without rotation reports identical credentials (no silent drift between runs).
  const r2 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: false });
  assert.equal(r2.rotated, false);
  assert.equal(r2.previewPassword, r1.previewPassword);
  assert.deepEqual(r2.accounts, r1.accounts);
  s.db.raw.prepare("UPDATE users SET totp_last_step = NULL").run(); // next 30 s window
  await verifyStagingAccess({ base: BASE, previewPassword: r2.previewPassword, owner: ownerOf(r2) }, s.fetchFor(s.env()));

  // An Owner session exists; rotation must revoke it along with every old credential.
  const sessionsBefore = (s.db.raw.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
  assert.ok(sessionsBefore > 0);
  const r3 = await applyAccess(s.ops, { rootKey: KEY, epoch: "2", rotate: true });
  assert.equal(r3.rotated, true);
  assert.notEqual(r3.previewPassword, r1.previewPassword);
  assert.notEqual(ownerOf(r3).password, owner1.password);
  assert.notEqual(ownerOf(r3).totp, owner1.totp, "2FA setup key rotated");
  assert.equal((s.db.raw.prepare(`SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email LIKE '%@crestmont-preview.test'`).get() as { n: number }).n, 0, "demo sessions revoked");
  await assert.rejects(verifyStagingAccess({ base: BASE, previewPassword: r1.previewPassword, owner: owner1 }, s.fetchFor(s.env())), /preview password/);
  s.db.raw.prepare("UPDATE users SET totp_last_step = NULL").run();
  await verifyStagingAccess({ base: BASE, previewPassword: r3.previewPassword, owner: ownerOf(r3) }, s.fetchFor(s.env()));

  // Bumping ACCESS_EPOCH in the workflow forces a rotation without anyone ticking a box.
  assert.equal((await applyAccess(s.ops, { rootKey: KEY, epoch: "3", rotate: false })).rotated, true);

  // A Founder-chosen preview password is honoured and applied as-is.
  const r5 = await applyAccess(s.ops, { rootKey: KEY, epoch: "3", rotate: false, fixedPreviewPassword: "founder chosen phrase 42" });
  assert.equal(s.secrets.STAGING_ACCESS_PASSWORD, "founder chosen phrase 42");
  assert.equal(r5.previewSource, "founder");

  // The artifact README carries the five required items.
  const md = accessReadme(BASE, r3, "2026-10-27T08:00:00.000Z");
  for (const item of [BASE, r3.previewPassword, ownerOf(r3).email, ownerOf(r3).password, ownerOf(r3).totp]) assert.ok(md.includes(item));
  assert.match(md, /Verified by the deploy run/);
});

test("[INFRA-002] staging access refuses to run without a root key", async () => {
  const s = await stagingDb();
  await assert.rejects(applyAccess(s.ops, { rootKey: "", epoch: "2", rotate: false }), /ACCESS_ROOT_KEY/);
});
