// Static and unit checks for the production provisioning path (INFRA-002, INFRA-005): it creates infrastructure
// only, behind the same Founder gates as a production deploy, and can never reach staging or the frontend preview.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { guardProduction, d1Uuid, turnstileProblems, secretNames, stagingTurnstile, PRODUCTION } from "../scripts/provision-production.ts";

const wf = readFileSync(".github/workflows/provision-production.yml", "utf8");
const toml = readFileSync("wrangler.toml", "utf8");

test("[INFRA-002] production guard: the committed wrangler.toml targets exactly the production Worker, D1 and R2", () => {
  const t = guardProduction(toml);
  assert.equal(t.worker, PRODUCTION.worker);
  assert.equal(t.database, PRODUCTION.database);
  assert.equal(t.bucket, PRODUCTION.bucket);
  assert.equal(t.workersDev, false);
  const swap = (from: string, to: string) => toml.replace(new RegExp(`(\\[env\\.production\\][\\s\\S]*?)${from}`), `$1${to}`);
  assert.throws(() => guardProduction(swap('database_name = "crestmont-production"', 'database_name = "crestmont-staging"')), /database is "crestmont-staging"/);
  assert.throws(() => guardProduction(swap('bucket_name = "crestmont-files-production"', 'bucket_name = "crestmont-files-staging"')), /bucket/);
  assert.throws(() => guardProduction(swap('name = "crestmont-platform-production"', 'name = "crestmont-platform-staging"')), /worker name/);
  assert.throws(() => guardProduction(swap("workers_dev = false", "workers_dev = true")), /workers_dev/);
  assert.throws(() => guardProduction(swap('database_id = "[^"]*"', 'database_id = "not-a-uuid"')), /not a D1 UUID/);
  // The production database provisioned by provision-production.yml (run #1) is pinned, and only in production.
  assert.equal(t.databaseId, "c667f1a9-0802-4c52-a0e1-b512219a6eea");
  assert.equal(toml.split(t.databaseId).length - 1, 1, "no other environment references the production database");
  assert.throws(() => guardProduction("name = \"x\"\n"), /no \[env\.production\]/);
});

test("[INFRA-002] D1 lookup matches the exact name and tolerates Wrangler's banner", () => {
  const out = "⛅️ wrangler 4\n" + JSON.stringify([
    { name: "crestmont-staging", uuid: "11111111-1111-4111-8111-111111111111" },
    { name: "crestmont-production-old", uuid: "22222222-2222-4222-8222-222222222222" },
    { name: "crestmont-production", uuid: "33333333-3333-4333-8333-333333333333" },
  ]);
  assert.equal(d1Uuid(out, "crestmont-production"), "33333333-3333-4333-8333-333333333333");
  assert.equal(d1Uuid("[]", "crestmont-production"), null);
  assert.throws(() => d1Uuid(JSON.stringify([{ name: "crestmont-production", uuid: "a" }, { name: "crestmont-production", uuid: "b" }]), "crestmont-production"), /More than one/);
});

test("[INFRA-002] Turnstile: production refuses missing keys, Cloudflare test keys and staging's keys", () => {
  const staging = stagingTurnstile(toml);
  assert.ok(staging.siteKey && staging.secret, "staging's public test keys are read from wrangler.toml");
  assert.deepEqual(turnstileProblems("0x4AAAAAAAreal-site-key", "0x4AAAAAAAreal-secret-value", staging), []);
  assert.equal(turnstileProblems(undefined, "").length, 2);
  for (const k of ["1x00000000000000000000AA", "2x00000000000000000000AB", "3x00000000000000000000FF"]) assert.match(turnstileProblems(k, "0x4real").join(";"), /test key/, k);
  assert.match(turnstileProblems("0x4real", "1x0000000000000000000000000000000AA").join(";"), /test key/);
  assert.match(turnstileProblems(staging.siteKey, staging.secret, staging).join(";"), /staging/);
  assert.match(turnstileProblems("same", "same").join(";"), /same value/);
});

test("[INFRA-002] secret names are read without values", () => {
  assert.deepEqual(secretNames('[{"name":"TURNSTILE_SECRET","type":"secret_text"},{"name":"EVIDENCE_INGEST_SECRET","type":"secret_text"}]'), ["TURNSTILE_SECRET", "EVIDENCE_INGEST_SECRET"]);
  assert.deepEqual(secretNames("✘ [ERROR] This Worker does not exist"), []);
});

test("[INFRA-005] provisioning workflow: manual, main-only, confirmed, Founder-gated; infrastructure only", () => {
  assert.match(wf, /on:\s*\n\s*workflow_dispatch:/);
  assert.doesNotMatch(wf, /^\s*(push|pull_request|schedule|workflow_run):/m, "never runs automatically");
  assert.match(wf, /environment:\s*\n\s*name: production/, "runs in the Founder-approved production environment");
  assert.match(wf, /\[ "\$GITHUB_REF" = "refs\/heads\/main" \]/);
  assert.match(wf, /\[ "\$CONFIRM" = "provision crestmont-platform-production" \]/);
  assert.match(wf, /group: deploy-production/, "never overlaps a production deploy");
  assert.match(wf, /permissions:\s*\n\s*contents: read/);
  // Infrastructure only: no code upload, no domain, no migrations, no data, no deletions, no other environment.
  for (const forbidden of [/wrangler\S* deploy\b|\$WRANGLER deploy\b/, /versions (upload|deploy)/, /migrations apply/, /d1 execute/, /d1 delete/, /r2 bucket (create|delete)/, /--env (staging|frontend-preview)/, /crestmont-staging|frontend-preview"|seed-staging/, /dns_records|\/routes|custom_domain/])
    assert.doesNotMatch(wf, forbidden, String(forbidden));
  assert.match(wf, /\$WRANGLER d1 create "\$DB_NAME"/);
  assert.match(wf, /r2 bucket info "\$BUCKET"/);
  assert.match(wf, /"enabled":false,"previews_enabled":false/, "draft Worker gets no public URL");
  // Secrets: Turnstile from production-only environment secrets; the evidence secret is generated once and kept.
  assert.match(wf, /secrets\.PRODUCTION_TURNSTILE_SITE_KEY/);
  assert.match(wf, /secrets\.PRODUCTION_TURNSTILE_SECRET/);
  assert.match(wf, /grep -qx EVIDENCE_INGEST_SECRET[\s\S]*already set[\s\S]*kept/);
  assert.doesNotMatch(wf, /STRIPE_SECRET_KEY \||RESEND_API_KEY \||secret put (STRIPE|RESEND|RETELL|ANTHROPIC|BUILD_RUNNER|STAGING_ACCESS)/, "never installs a live-service or preview secret");
  assert.doesNotMatch(wf, /echo\s+["']?\$(PROD_TURNSTILE_SECRET|CLOUDFLARE_API_TOKEN|PROD_TURNSTILE_SITE_KEY)\b/, "never echoes a secret");
  assert.doesNotMatch(wf, /upload-artifact/, "no artifacts (public repository)");
});

test("[AUTH-003] [INFRA-002] production MFA key: well-formed 32-byte base64 from the Founder's environment secret, installed once and never replaced", async () => {
  const { mfaKeyProblems } = await import("../scripts/provision-production.ts");
  const { importMfaKey } = await import("../src/lib/totp-secrets.ts");
  const good = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)).toString("base64");
  assert.deepEqual(mfaKeyProblems(good), []);
  await importMfaKey(good); // the Worker accepts the same format
  assert.match(mfaKeyProblems(undefined).join(), /not set/);
  assert.match(mfaKeyProblems("not base64!").join(), /base64/);
  assert.match(mfaKeyProblems(Buffer.alloc(16, 7).toString("base64")).join(), /exactly 32 bytes \(got 16\)/);
  assert.match(mfaKeyProblems(Buffer.alloc(32, 0).toString("base64")).join(), /random/);
  assert.ok(!mfaKeyProblems("x".repeat(43) + "=").join().includes("x".repeat(43)), "the value is never echoed");
  assert.match(wf, /PROD_MFA_ENCRYPTION_KEY: \$\{\{ secrets\.PRODUCTION_MFA_ENCRYPTION_KEY \}\}/);
  const keep = wf.indexOf("grep -qx MFA_ENCRYPTION_KEY"), put = wf.indexOf("secret put MFA_ENCRYPTION_KEY");
  assert.ok(keep > 0 && put > keep, "the existing key is checked before anything is installed");
  assert.match(wf.slice(keep, put), /already set[\s\S]*kept \(never replaced\)[\s\S]*elif/);
  assert.doesNotMatch(wf, /randomBytes\(32\)\.toString\("base64"\)/, "the workflow never invents an MFA key the Founder has no copy of");
});
