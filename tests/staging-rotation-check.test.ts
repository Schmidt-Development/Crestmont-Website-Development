// End to end against the real request pipeline (src/app/app.ts) on an in-memory staging database:
// exposure audit → hold an old Owner session → rotate → every old credential and the old session are rejected.
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
import { applyAccess, type D1Ops } from "../scripts/staging-access.ts";
import { audit, pre, post } from "../scripts/staging-rotation-check.ts";

const BASE = "https://crestmont-platform-staging.example.workers.dev";
const KEY = "test-root-key-0123456789abcdef";

async function world() {
  const dir = mkdtempSync(join(tmpdir(), "rc-"));
  execFileSync(process.execPath, ["--no-warnings", "scripts/seed-staging.ts", "--out", join(dir, "seed.sql"), "--credentials", join(dir, "c.md")], { stdio: "pipe" });
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
  const env = (): Env => ({ DB: db, ENVIRONMENT: "staging", PREVIEW_GATE: "required", APP_URL: BASE, STAGING_ACCESS_PASSWORD: secrets.STAGING_ACCESS_PASSWORD, ACTION_RATE_LIMIT: "off" });
  const f = async (url: string, init?: RequestInit) => handle(new Request(url, init), env());
  return { db, ops, secrets, f };
}
const owner = (r: Awaited<ReturnType<typeof applyAccess>>) => { const o = r.accounts.find((a) => a.role === "owner")!; return { email: o.email, password: o.password, totp: o.totp! }; };

test("[INFRA-002] [SEC-007] rotation check: audit counts sign-ins by client; after rotation every old credential and the old Owner session are rejected", async () => {
  const w = await world();
  const r1 = await applyAccess(w.ops, { rootKey: KEY, epoch: "2", rotate: false });
  // An "intruder" session with a browser user agent, recorded like a real sign-in.
  const now = new Date().toISOString();
  w.db.raw.exec(`INSERT INTO sessions (id, user_id, token_hash, mfa_verified, ip, user_agent, created_at, expires_at)
    SELECT 'ses_intruder', u.id, 'th_intruder', 1, '203.0.113.9', 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0', '${now}', '2099-01-01T00:00:00Z' FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.role_id = 'owner' LIMIT 1;`);
  const a = await audit(w.ops);
  assert.equal(a.unknownSignIns, 1);
  assert.ok(a.publicLines.every((l) => !l.includes("203.0.113.9") && !l.includes("Firefox")), "public summary has counts only");
  assert.match(a.privateText, /203\.0\.113\.9/);

  const state = await pre(w.ops, { base: BASE, rootKey: KEY, epoch: "2", rotate: true }, w.f);
  assert.equal(state.due, true);
  assert.equal(state.livePreview, r1.previewPassword, "live preview password identified");
  assert.equal(state.ownerSignedIn, true, "old Owner session held before rotation");
  assert.deepEqual(state.owner, owner(r1));

  const r2 = await applyAccess(w.ops, { rootKey: KEY, epoch: "2", rotate: true });
  const checks = await post(w.ops, state, { base: BASE, previewPassword: r2.previewPassword, owner: owner(r2) }, w.f);
  const failed = checks.filter((c) => !c.ok);
  assert.deepEqual(failed, [], JSON.stringify(failed));
  for (const name of ["old preview password #1 rejected", "old preview cookie rejected", "old Owner session rejected", "old Owner password rejected", "old 2FA key rejected", "new Owner password + new 2FA key accepted"])
    assert.ok(checks.some((c) => c.name === name && c.ok), name);
});

test("[INFRA-002] rotation check fails when nothing was rotated (old credentials still work)", async () => {
  const w = await world();
  const r1 = await applyAccess(w.ops, { rootKey: KEY, epoch: "2", rotate: false });
  const state = await pre(w.ops, { base: BASE, rootKey: KEY, epoch: "2", rotate: true }, w.f);
  // Simulate a broken rotation: credentials are re-applied unchanged.
  const r2 = await applyAccess(w.ops, { rootKey: KEY, epoch: "2", rotate: false });
  assert.equal(r2.previewPassword, r1.previewPassword);
  const checks = await post(w.ops, state, { base: BASE, previewPassword: r2.previewPassword, owner: owner(r2) }, w.f);
  for (const name of ["old preview password #1 rejected", "old Owner session rejected", "old Owner password rejected"])
    assert.ok(checks.some((c) => c.name === name && !c.ok), `${name} must FAIL`);
});

test("[INFRA-002] rotation pre-check does nothing when no rotation is due or on first issue", async () => {
  const w = await world();
  assert.equal((await pre(w.ops, { base: BASE, rootKey: KEY, epoch: "2", rotate: false }, w.f)).reason, "first issue (no live credentials)");
  await applyAccess(w.ops, { rootKey: KEY, epoch: "2", rotate: false });
  const s = await pre(w.ops, { base: BASE, rootKey: KEY, epoch: "2", rotate: false }, w.f);
  assert.deepEqual([s.due, s.reason, s.owner], [false, "no rotation due", null]);
  assert.equal((await pre(w.ops, { base: BASE, rootKey: KEY, epoch: "3", rotate: false }, w.f)).due, true, "an ACCESS_EPOCH bump is a rotation");
});
