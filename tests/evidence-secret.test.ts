// Regression tests for the evidence-secret blocker (INFRA-005, LAUNCH-002). Staging used to install a fresh random
// EVIDENCE_INGEST_SECRET on every deploy, drill and rehearsal, so (a) the value held by GitHub (ci.yml, release.yml,
// deploy-production.yml) never matched staging and signed release authorization always failed with 401, and (b) every
// secret change blocked Worker rollbacks (Cloudflare 10220). Now: the GitHub secret when configured, otherwise the key
// derived from the Cloudflare token (scripts/staging-secrets.ts); never random, and put only when it changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveEvidenceSecret, fingerprint, MIN_SECRET_LENGTH } from "../scripts/evidence-secret.ts";
import { deriveStagingKey } from "../scripts/staging-secrets.ts";
import { signEvidence, verifyEvidenceSignature } from "../src/readiness/ingest.ts";

const wf = (n: string) => readFileSync(`.github/workflows/${n}`, "utf8");
const STABLE = "a1".repeat(32); // 64 hex chars, like `openssl rand -hex 32`
const ROOT = "cf-token-for-tests-only";

test("[INFRA-005] evidence secret: the GitHub secret is used verbatim when configured, else the stable derived key; never random", () => {
  const a = resolveEvidenceSecret(STABLE, ROOT), b = resolveEvidenceSecret(`  ${STABLE}\n`, "another-root");
  assert.equal(a.mode, "stable");
  assert.equal(a.secret, STABLE);
  assert.deepEqual(a, b, "the GitHub secret wins whatever the token is");
  assert.equal(a.fingerprint, fingerprint(STABLE));
  assert.match(a.fingerprint, /^[0-9a-f]{12}$/);
  assert.ok(!STABLE.includes(a.fingerprint), "fingerprint is not a substring of the secret");

  const d1 = resolveEvidenceSecret(undefined, ROOT), d2 = resolveEvidenceSecret("", ROOT);
  assert.equal(d1.mode, "derived");
  assert.deepEqual(d1, d2, "the fallback is identical on every run (no rotation)");
  assert.equal(d1.secret, deriveStagingKey(ROOT, "evidence"), "same key the backend's staging-secrets.ts derives");

  // Nothing to resolve from, or a configured but weak/malformed value: refused, never invented or replaced.
  assert.throws(() => resolveEvidenceSecret(undefined, undefined), /refusing to invent/);
  assert.throws(() => resolveEvidenceSecret("short", ROOT), new RegExp(`shorter than ${MIN_SECRET_LENGTH}`));
  assert.throws(() => resolveEvidenceSecret(`${STABLE.slice(0, 40)} ${STABLE.slice(0, 40)}`, ROOT), /whitespace/);
});

test("[LAUNCH-002] evidence secret: GitHub-side signatures verify against staging once the GitHub secret is configured", async () => {
  const staging = resolveEvidenceSecret(STABLE, ROOT); // what deploy-staging.yml installs
  const canonical = `GET /api/readiness/release-authorization?commit=${"c".repeat(40)}`;
  const sig = await signEvidence(STABLE, canonical); // what deploy-production.yml signs with (secrets.EVIDENCE_INGEST_SECRET)
  await verifyEvidenceSignature(staging.secret, canonical, sig);
  const derivedOnly = resolveEvidenceSecret(undefined, ROOT);
  await assert.rejects(verifyEvidenceSignature(derivedOnly.secret, canonical, sig), "without the GitHub secret, GitHub-side signing cannot match (warned)");
});

test("[INFRA-005] evidence-secret CLI: value only in GITHUB_ENV / stdout of `print` (masked by the caller); warnings never captured; weak value refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "evsec-"));
  try {
    const run = (cmd: string, env: Record<string, string>) => {
      const envFile = join(dir, "env"), outFile = join(dir, "out");
      writeFileSync(envFile, ""); writeFileSync(outFile, "");
      const r = spawnSync(process.execPath, ["--no-warnings", "scripts/evidence-secret.ts", cmd],
        { env: { PATH: process.env.PATH ?? "", GITHUB_ENV: envFile, GITHUB_OUTPUT: outFile, ...env }, encoding: "utf8", timeout: 30_000 });
      return { ...r, envText: readFileSync(envFile, "utf8"), outText: readFileSync(outFile, "utf8") };
    };
    const s = run("resolve", { EVIDENCE_INGEST_SECRET_STABLE: STABLE, ACCESS_ROOT_KEY: ROOT });
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.envText, `EVIDENCE_INGEST_SECRET=${STABLE}\n`);
    assert.match(s.outText, /^mode=stable$/m);
    assert.match(s.outText, new RegExp(`^fingerprint=${fingerprint(STABLE)}$`, "m"));
    const visible = s.stdout.split("\n").filter((l) => !l.startsWith("::add-mask::")).join("\n") + s.stderr;
    assert.ok(!visible.includes(STABLE), "secret never printed outside the mask command");

    const p = run("print", { ACCESS_ROOT_KEY: ROOT });
    assert.equal(p.status, 0, p.stderr);
    assert.equal(p.stdout, deriveStagingKey(ROOT, "evidence"), "print writes exactly the value, nothing else, to stdout");
    assert.match(p.stderr, /::warning title=EVIDENCE_INGEST_SECRET not configured::/);
    assert.ok(!p.stderr.includes(p.stdout), "the value is never in the warning");
    assert.equal(run("print", { EVIDENCE_INGEST_SECRET_STABLE: STABLE, ACCESS_ROOT_KEY: ROOT }).stdout, STABLE);

    const w = run("resolve", { EVIDENCE_INGEST_SECRET_STABLE: "tooshort", ACCESS_ROOT_KEY: ROOT });
    assert.equal(w.status, 1);
    assert.equal(w.envText, "", "nothing exported for a refused value");
    assert.ok(!(w.stdout + w.stderr).includes("tooshort"));
    assert.equal(run("print", {}).status, 1, "no inputs: refuses instead of inventing a value");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[INFRA-005] [LAUNCH-002] staging workflows: one resolver, no random secrets, put only when changed by the deploy, never by drill or rehearsal", () => {
  for (const n of ["deploy-staging.yml", "staging-restore-drill.yml", "staging-rollback-rehearsal.yml"]) {
    const s = wf(n);
    assert.doesNotMatch(s, /randomBytes/, `${n} does not mint secrets`);
    assert.match(s, /EVIDENCE_INGEST_SECRET_STABLE: \$\{\{ secrets\.EVIDENCE_INGEST_SECRET \}\}/, n);
    assert.match(s, /ev=\$\(node --no-warnings scripts\/evidence-secret\.ts print\)\s*\n\s*echo "::add-mask::\$ev"/, `${n} masks the value immediately`);
    assert.doesNotMatch(s, /staging-secrets\.ts derive evidence/, `${n} uses the shared resolver`);
    assert.doesNotMatch(s, /--env production|crestmont-platform-production|crestmont-production/, `${n} never touches production`);
  }
  assert.match(wf("deploy-staging.yml"), /printf '%s' "\$ev" \| node --no-warnings scripts\/staging-secrets\.ts put EVIDENCE_INGEST_SECRET/, "the deploy puts it only when changed");
  for (const n of ["staging-restore-drill.yml", "staging-rollback-rehearsal.yml"]) assert.doesNotMatch(wf(n), /secret put EVIDENCE_INGEST_SECRET|staging-secrets\.ts put EVIDENCE/, `${n} never changes the Worker secret`);
  // Every GitHub-side consumer reads the same GitHub secret name.
  for (const n of ["ci.yml", "release.yml", "deploy-production.yml"]) assert.match(wf(n), /secrets\.EVIDENCE_INGEST_SECRET\b/, n);
  assert.match(wf("deploy-production.yml"), /scripts\/evidence-secret\.ts fingerprint/);
});

test("[INFRA-005] production workflow: first release tolerates an empty database, waits for the custom domain, and stays manual and gated", () => {
  const p = wf("deploy-production.yml");
  assert.match(p, /on:\s*\n\s*workflow_dispatch:/);
  assert.doesNotMatch(p, /^\s*push:/m, "never deployed on push");
  assert.match(p, /environment:\s*\n\s*name: production/);
  assert.equal((p.match(/scripts\/release-authorization\.ts/g) ?? []).length, 2, "authorization checked twice");
  assert.match(p, /sqlite_master[\s\S]*if \[ "\$tables" = "0" \][\s\S]*d1 export crestmont-production/, "export skipped only for a database with no tables");
  assert.ok(p.indexOf("Wait for the production URL") > p.indexOf("Deploy Worker (production)"));
  assert.ok(p.indexOf("Wait for the production URL") < p.indexOf("Post-deploy production checks"));
});

test("[SEC-004] [INFRA-005] public repository: no workflow uploads plaintext credentials or a database export as an artifact", () => {
  const staging = wf("deploy-staging.yml");
  assert.match(staging, /ACCESS_ARTIFACT_PASSPHRASE: \$\{\{ secrets\.ACCESS_ARTIFACT_PASSPHRASE \}\}/);
  // Sealed with authenticated encryption (scripts/seal.ts, AES-256-GCM) or not issued at all: no plaintext path,
  // whatever the repository's visibility (2026-10-28 incident).
  assert.match(staging, /node --no-warnings scripts\/seal\.ts seal access\/README\.md access\/staging-access\.sealed/);
  assert.doesNotMatch(staging, /openssl enc|aes-256-cbc|upload=plain|REPO_PRIVATE/);
  // Any version or SHA pin of upload-artifact (CREST-GAP-063: Dependabot bumps used to fail this check).
  const uploads = [...staging.matchAll(/- uses: actions\/upload-artifact@[^\s]+(?: #[^\n]*)?\s*\n\s*if: ([^\n]+)\n[\s\S]*?path: ([^\n]+)/g)].map((m) => [m[1].trim(), m[2].trim()]);
  assert.deepEqual(uploads, [
    ["steps.gate.outputs.pending == 'true'", "forensics/staging-forensics.sealed"],
    ["always() && steps.protect.outputs.upload == 'sealed'", "access/staging-access.sealed"],
  ]);
  const prod = wf("deploy-production.yml");
  assert.doesNotMatch(prod, /upload-artifact/, "no production artifact at all");
  assert.match(prod, /r2 object put "crestmont-files-production\/_backups\/[^"]+" --file "\$f" --remote/);
  assert.ok(prod.indexOf("r2 object put") < prod.indexOf("Apply D1 migrations (production"), "the export is stored before anything changes");
  for (const n of ["deploy-staging.yml", "staging-restore-drill.yml", "staging-rollback-rehearsal.yml"])
    assert.doesNotMatch(wf(n), /path: (drill|backups)\//, `${n} never uploads a database export`);
});

test("[INFRA-006] staging secret names may contain digits (RESEARCH_E2E_RUNNER_SECRET); anything that could break the SQL is refused", async () => {
  const { putSecretIfChanged } = await import("../scripts/staging-secrets.ts");
  const puts: string[] = [];
  const ops = { query: async () => [] as never, execFile: async () => {}, putSecret: async (n: string) => { puts.push(n); } };
  // The first deploy after #96 failed: "invalid secret name RESEARCH_E2E_RUNNER_SECRET" (digits were not allowed).
  assert.equal(await putSecretIfChanged(ops as never, "root-key", "RESEARCH_E2E_RUNNER_SECRET", "value-1").catch((e) => (e as Error).message), "updated");
  assert.deepEqual(puts, ["RESEARCH_E2E_RUNNER_SECRET"]);
  for (const bad of ["bad", "X'; DROP TABLE x;--", "2FA_KEY", "A-B-C"]) await assert.rejects(putSecretIfChanged(ops as never, "root-key", bad, "v"), /invalid secret name/);
});
