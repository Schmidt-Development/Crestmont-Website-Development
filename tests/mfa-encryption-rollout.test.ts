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
  assert.ok(overallFeedHealth(Object.values(missing)).ok, "a missing key does not page anyone");

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
