// MFA encryption-at-rest rollout on deployed environments: the re-encryption script's database identity safeguards,
// and the public readiness feeds that report whether the Worker holds a usable key and whether plaintext remains.
// No key, secret or count is ever reported. Every record created here is TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertTargetIdentity, declaredDatabase, PRODUCTION_CONFIRM_ENV } from "../scripts/encrypt-totp-secrets.ts";
import { mfaFeeds, overallFeedHealth } from "../src/services/readiness-admin.ts";
import { sealWithKey } from "../src/lib/totp-secrets.ts";
import { newTotpSecret } from "../src/lib/auth-crypto.ts";
import { createTestApp } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";

const TOML = readFileSync("wrangler.toml", "utf8");
const KEY = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const recorded = (...envs: string[]) => async () => envs;

test("[SEC-004] encrypt-totp-secrets: wrangler.toml bindings are read per environment", () => {
  assert.equal(declaredDatabase(TOML, "staging"), "crestmont-staging");
  assert.equal(declaredDatabase(TOML, "production"), "crestmont-production");
  assert.equal(declaredDatabase(TOML, "nonexistent"), null);
});

test("[SEC-004] encrypt-totp-secrets refuses any remote target whose identity is not unambiguous", async () => {
  const base = { env: "staging", database: "crestmont-staging", toml: TOML };
  // Accepted: staging database, bound to [env.staging], whose deployment records are staging only.
  await assertTargetIdentity({ ...base, recordedEnvironments: recorded("staging", "staging") });

  await assert.rejects(assertTargetIdentity({ ...base, env: "development", recordedEnvironments: recorded("staging") }), /--env must be staging or production/);
  await assert.rejects(assertTargetIdentity({ ...base, database: "crestmont-production", recordedEnvironments: recorded("staging") }), /not the staging database/);
  await assert.rejects(assertTargetIdentity({ ...base, recordedEnvironments: recorded() }), /no recorded deployments/);
  await assert.rejects(assertTargetIdentity({ ...base, recordedEnvironments: recorded("production") }), /records deployments for production/);
  await assert.rejects(assertTargetIdentity({ ...base, recordedEnvironments: recorded("staging", "production") }), /not only staging/);

  // Production: both explicit confirmations must name the production database exactly, and the records must agree.
  const prod = { env: "production", database: "crestmont-production", toml: TOML, recordedEnvironments: recorded("production") };
  await assert.rejects(assertTargetIdentity(prod), new RegExp(PRODUCTION_CONFIRM_ENV));
  await assert.rejects(assertTargetIdentity({ ...prod, confirmProduction: "crestmont-production" }), /both exactly/);
  await assert.rejects(assertTargetIdentity({ ...prod, confirmEnv: "crestmont-production" }), /both exactly/);
  await assert.rejects(assertTargetIdentity({ ...prod, confirmProduction: "crestmont-staging", confirmEnv: "crestmont-production" }), /both exactly/);
  await assert.rejects(assertTargetIdentity({ ...prod, database: "crestmont-staging", confirmProduction: "crestmont-staging", confirmEnv: "crestmont-staging" }), /not the production database/);
  await assert.rejects(assertTargetIdentity({ ...prod, confirmProduction: "crestmont-production", confirmEnv: "crestmont-production", recordedEnvironments: recorded("staging") }), /records deployments for staging/);
  // The deployment records are not even consulted until the flags pass.
  let consulted = false;
  await assert.rejects(assertTargetIdentity({ ...prod, recordedEnvironments: async () => { consulted = true; return ["production"]; } }));
  assert.equal(consulted, false);
  await assertTargetIdentity({ ...prod, confirmProduction: "crestmont-production", confirmEnv: "crestmont-production" });
});

test("[SEC-004] encrypt-totp-secrets CLI refuses --remote without --env before touching any database", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["--no-warnings", "scripts/encrypt-totp-secrets.ts", "--remote", "--database", "crestmont-staging"], { encoding: "utf8", env: { ...process.env, MFA_ENCRYPTION_KEY: KEY(), PATH: "" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--env/);
});

test("[SEC-004] [READY-012] mfa-key / mfa-at-rest feeds report key state and plaintext presence without values or counts", async () => {
  const app = await createTestApp();
  const ctx = (extra: Partial<Env>) => ({ db: app.db, env: { ...app.env, ...extra } as Env });
  const now = new Date().toISOString();
  const secret = newTotpSecret();
  await app.db.prepare(`INSERT INTO users (id, email, display_name, totp_secret, mfa_enabled, created_at) VALUES ('usr_mfa_feed','feed@x.test','F',?,1,?)`).bind(secret, now).run();
  const byEnv = async (e: Partial<Env>) => Object.fromEntries((await mfaFeeds(ctx(e))).map((f) => [f.source.split(":")[0], f]));

  assert.deepEqual(await mfaFeeds(ctx({ ENVIRONMENT: "development" })), [], "development has no such feeds");

  const missing = await byEnv({ ENVIRONMENT: "staging" });
  assert.equal(missing["mfa-key"].source, "mfa-key:staging");
  assert.equal(missing["mfa-key"].status, "unavailable");
  assert.equal(missing["mfa-at-rest"].status, "unavailable");
  assert.ok(overallFeedHealth(Object.values(missing)).ok, "a missing key on staging does not page anyone");
  const prodMissing = await byEnv({ ENVIRONMENT: "production" });
  assert.equal(prodMissing["mfa-key"].status, "failing", "production without the key alerts");
  assert.equal(overallFeedHealth(Object.values(prodMissing)).ok, false);

  const invalid = await byEnv({ ENVIRONMENT: "staging", MFA_ENCRYPTION_KEY: "not-a-valid-key" });
  assert.equal(invalid["mfa-key"].status, "failing");
  assert.equal(overallFeedHealth(Object.values(invalid)).ok, false, "a malformed key alerts");

  const key = KEY();
  const plain = await byEnv({ ENVIRONMENT: "staging", MFA_ENCRYPTION_KEY: key });
  assert.equal(plain["mfa-key"].status, "healthy");
  assert.equal(plain["mfa-at-rest"].status, "unavailable");
  assert.match(plain["mfa-at-rest"].detail, /plaintext/);

  await app.db.prepare(`UPDATE users SET totp_secret = ? WHERE totp_secret IS NOT NULL`).bind(await sealWithKey(key, "usr_mfa_feed", secret)).run();
  const all = await app.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE totp_secret IS NOT NULL AND totp_secret NOT LIKE 'v1:%'`).first<{ n: number }>();
  assert.equal(all!.n, 0);
  const pend = await byEnv({ ENVIRONMENT: "staging", MFA_ENCRYPTION_KEY: key });
  // A plaintext pending (unfinished) enrolment also counts.
  await app.db.prepare(`UPDATE users SET totp_pending_secret = ? WHERE id = 'usr_mfa_feed'`).bind(newTotpSecret()).run();
  assert.equal((await byEnv({ ENVIRONMENT: "staging", MFA_ENCRYPTION_KEY: key }))["mfa-at-rest"].status, "unavailable");
  await app.db.prepare(`UPDATE users SET totp_pending_secret = NULL`).run();
  const done = await byEnv({ ENVIRONMENT: "production", MFA_ENCRYPTION_KEY: key });
  assert.equal(pend["mfa-at-rest"].status, "healthy");
  assert.equal(done["mfa-at-rest"].source, "mfa-at-rest:production");
  assert.equal(done["mfa-at-rest"].status, "healthy");

  for (const f of [...Object.values(missing), ...Object.values(invalid), ...Object.values(plain), ...Object.values(done)]) {
    assert.ok(!f.detail.includes(key) && !f.detail.includes(secret) && !f.detail.includes("not-a-valid-key"), "no key or secret in any detail");
    assert.ok(!/\d/.test(f.detail.replace(/base64|32 bytes|v1/g, "")), `no counts in "${f.detail}"`);
  }
});

test("[SEC-004] [READY-012] public /api/readiness/health lists the MFA feeds with a sanitized reason and no secret", async () => {
  const key = KEY();
  const app = await createTestApp({ ENVIRONMENT: "staging", MFA_ENCRYPTION_KEY: "AAAA" });
  const body = await (await app.client().get("/api/readiness/health?view=report")).json() as { feeds: { source: string; status: string; reason?: string; detail?: string }[] };
  const k = body.feeds.find((f) => f.source === "mfa-key:staging")!;
  assert.equal(k.status, "failing");
  assert.match(k.reason ?? "", /not base64 of exactly 32 bytes/);
  assert.equal(k.detail, undefined, "anonymous callers get no detail field");
  assert.ok(body.feeds.some((f) => f.source === "mfa-at-rest:staging"));
  assert.ok(!JSON.stringify(body).includes(key) && !JSON.stringify(body).includes("AAAA"));
});

test("[SEC-004] cross-environment isolation: a secret sealed under one environment's key never opens under another's or for another user", async () => {
  const { openWithKey } = await import("../src/lib/totp-secrets.ts");
  const staging = KEY(), production = KEY();
  const secret = newTotpSecret();
  const sealed = await sealWithKey(staging, "usr_1", secret);
  assert.equal(await openWithKey(staging, "usr_1", sealed), secret);
  await assert.rejects(openWithKey(production, "usr_1", sealed), "a production key cannot read a staging row");
  await assert.rejects(openWithKey(staging, "usr_2", sealed), "nor can the row be moved to another user");
  const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAA=") ? "BBB=" : "AAA=");
  await assert.rejects(openWithKey(staging, "usr_1", tampered), "authenticated: tampering is detected");
  assert.notEqual(await sealWithKey(staging, "usr_1", secret), sealed, "a fresh nonce for every encryption");
});

test("[AUTH-003] [SEC-004] end to end with a key: invalid and expired codes refused, valid accepted, and no secret or code is written to any log table", async () => {
  const { totpCode } = await import("../src/lib/auth-crypto.ts");
  const key = KEY();
  const app = await createTestApp({ ENVIRONMENT: "development", MFA_ENCRYPTION_KEY: key });
  const { createStaff, TEST_PASSWORD } = await import("./support/app.ts");
  const s = await createStaff(app.db, "support", "e2e-mfa@crestmont.test");
  await app.db.prepare(`UPDATE users SET totp_secret = NULL, mfa_enabled = 0 WHERE id = ?`).bind(s.id).run();
  const c = app.client();
  await c.post("/login", { email: s.email, password: TEST_PASSWORD });
  const setup = await (await c.get("/mfa/setup")).text();
  const secret = /data-testid="totp-secret">([A-Z2-7 ]+)</.exec(setup)![1].replace(/ /g, "");
  const enrolCode = await totpCode(secret);
  const done = await c.post("/mfa/setup", { code: enrolCode });
  const codes = [...(await done.text()).matchAll(/<li><code>([a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4})<\/code><\/li>/g)].map((m) => m[1]);
  assert.equal(codes.length, 10);
  const row = await app.db.prepare(`SELECT totp_secret, totp_pending_secret FROM users WHERE id = ?`).bind(s.id).first<{ totp_secret: string; totp_pending_secret: string | null }>();
  assert.match(row!.totp_secret, /^v1:/, "stored encrypted");
  assert.equal(row!.totp_pending_secret, null);

  const reset = () => app.db.prepare(`UPDATE users SET totp_last_step = NULL WHERE id = ?`).bind(s.id).run().then(() => app.db.prepare(`DELETE FROM rate_limits WHERE key = ?`).bind(`mfa:${s.id}`).run());
  const fresh = app.client();
  await fresh.post("/login", { email: s.email, password: TEST_PASSWORD });
  const now = Math.floor(Date.now() / 1000);
  const tried: string[] = [];
  for (const [label, code] of [["expired (3 steps old)", await totpCode(secret, now - 90)], ["future (3 steps ahead)", await totpCode(secret, now + 90)], ["malformed", "12345"], ["wrong", "000000"]] as const) {
    if (code === await totpCode(secret)) continue; // astronomically unlikely collision
    await reset(); tried.push(code);
    assert.equal((await fresh.post("/mfa", { code })).status, 401, `${label} code refused`);
    assert.notEqual((await fresh.get("/staff")).status, 200);
  }
  await reset();
  const good = await totpCode(secret, now - 30); // one step of clock drift is accepted
  assert.equal(loc(await fresh.post("/mfa", { code: good })), "/staff");
  const r = app.client();
  await r.post("/login", { email: s.email, password: TEST_PASSWORD });
  assert.equal(loc(await r.post("/mfa", { code: codes[0] })), "/staff", "recovery code accepted once");

  // Nothing secret anywhere in the log / audit / event tables (or the stored email bodies).
  const dump = JSON.stringify([
    ...(await app.db.prepare(`SELECT * FROM security_events`).all()).results,
    ...(await app.db.prepare(`SELECT * FROM audit_logs`).all()).results,
    ...(await app.db.prepare(`SELECT * FROM email_messages`).all().catch(() => ({ results: [] }))).results,
  ]);
  for (const v of [secret, key, ...codes]) assert.ok(!dump.includes(v), "no TOTP secret, key or recovery code is logged");
  // 6-digit codes as standalone tokens (a hex id or timestamp may contain the same digits by chance).
  for (const v of [enrolCode, good, ...tried.filter((t) => t.length === 6 && t !== "000000")]) assert.ok(!new RegExp(`(?<![0-9a-zA-Z])${v}(?![0-9a-zA-Z])`).test(dump), "no TOTP code is logged");
});
const loc = (r: Response) => r.headers.get("location") ?? "";
