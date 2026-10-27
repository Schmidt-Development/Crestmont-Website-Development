// Regression tests for the evidence-secret blocker (INFRA-005, LAUNCH-002): the staging workflows used to
// install a fresh random EVIDENCE_INGEST_SECRET on every deploy, restore drill and rollback rehearsal, so
// the value held by GitHub (ci.yml, release.yml, deploy-production.yml) could never match the staging
// readiness system and signed production release authorization always failed with 401.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveEvidenceSecret, fingerprint, MIN_SECRET_LENGTH } from "../scripts/evidence-secret.ts";
import { signEvidence, verifyEvidenceSignature } from "../src/readiness/ingest.ts";

const wf = (n: string) => readFileSync(`.github/workflows/${n}`, "utf8");
const STABLE = "a1".repeat(32); // 64 hex chars, like `openssl rand -hex 32`

test("[INFRA-005] evidence secret: a configured GitHub secret is used verbatim on every run; only an unconfigured one falls back to a one-run value", () => {
  const a = resolveEvidenceSecret(STABLE), b = resolveEvidenceSecret(`  ${STABLE}\n`);
  assert.equal(a.mode, "stable");
  assert.equal(a.secret, STABLE);
  assert.deepEqual(a, b, "same value every run (no rotation)");
  assert.equal(a.fingerprint, fingerprint(STABLE));
  assert.match(a.fingerprint, /^[0-9a-f]{12}$/);
  assert.ok(!STABLE.includes(a.fingerprint), "fingerprint is not a substring of the secret");

  let n = 0;
  const e1 = resolveEvidenceSecret(undefined, () => `ephemeral-${++n}`.padEnd(64, "x"));
  const e2 = resolveEvidenceSecret("", () => `ephemeral-${++n}`.padEnd(64, "x"));
  assert.equal(e1.mode, "ephemeral");
  assert.notEqual(e1.secret, e2.secret);

  // A configured but weak or malformed value is refused, never silently replaced.
  assert.throws(() => resolveEvidenceSecret("short"), new RegExp(`shorter than ${MIN_SECRET_LENGTH}`));
  assert.throws(() => resolveEvidenceSecret(`${STABLE.slice(0, 40)} ${STABLE.slice(0, 40)}`), /whitespace/);
});

test("[LAUNCH-002] evidence secret: signatures made by GitHub with the stable value verify on the staging Worker across runs", async () => {
  const run1 = resolveEvidenceSecret(STABLE), run2 = resolveEvidenceSecret(STABLE);
  const canonical = `GET /api/readiness/release-authorization?commit=${"c".repeat(40)}`;
  const sig = await signEvidence(run2.secret, canonical);
  await verifyEvidenceSignature(run1.secret, canonical, sig); // deploy-production signs with what deploy-staging installed
  const eph = resolveEvidenceSecret(undefined);
  await assert.rejects(verifyEvidenceSignature(eph.secret, canonical, sig), "a rotated value is rejected (the old bug)");
});

test("[INFRA-005] evidence-secret CLI: writes the value only to GITHUB_ENV and an ::add-mask:: command; warns when unconfigured; refuses a weak value", () => {
  const dir = mkdtempSync(join(tmpdir(), "evsec-"));
  try {
    const run = (env: Record<string, string>) => {
      const envFile = join(dir, "env"), outFile = join(dir, "out");
      writeFileSync(envFile, ""); writeFileSync(outFile, "");
      const r = spawnSync(process.execPath, ["--no-warnings", "scripts/evidence-secret.ts", "resolve"],
        { env: { PATH: process.env.PATH ?? "", GITHUB_ENV: envFile, GITHUB_OUTPUT: outFile, ...env }, encoding: "utf8", timeout: 30_000 });
      return { ...r, envText: readFileSync(envFile, "utf8"), outText: readFileSync(outFile, "utf8") };
    };
    const s = run({ EVIDENCE_INGEST_SECRET_STABLE: STABLE });
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.envText, `EVIDENCE_INGEST_SECRET=${STABLE}\n`);
    assert.match(s.outText, /^mode=stable$/m);
    assert.match(s.outText, new RegExp(`^fingerprint=${fingerprint(STABLE)}$`, "m"));
    const visible = s.stdout.split("\n").filter((l) => !l.startsWith("::add-mask::")).join("\n") + s.stderr;
    assert.ok(!visible.includes(STABLE), "secret never printed outside the mask command");
    assert.match(s.stdout, /^::add-mask::/m);

    const e = run({});
    assert.equal(e.status, 0);
    assert.match(e.outText, /^mode=ephemeral$/m);
    assert.match(e.stdout, /::warning title=EVIDENCE_INGEST_SECRET not configured::/);

    const w = run({ EVIDENCE_INGEST_SECRET_STABLE: "tooshort" });
    assert.equal(w.status, 1);
    assert.equal(w.envText, "", "nothing exported for a refused value");
    assert.ok(!(w.stdout + w.stderr).includes("tooshort"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[INFRA-005] [LAUNCH-002] staging workflows never generate a random evidence secret; all use the stable GitHub secret, and only install a one-run value when it is missing", () => {
  for (const n of ["deploy-staging.yml", "staging-restore-drill.yml", "staging-rollback-rehearsal.yml"]) {
    const s = wf(n);
    assert.doesNotMatch(s, /randomBytes\(32\)/, `${n} does not mint its own evidence secret`);
    assert.match(s, /EVIDENCE_INGEST_SECRET_STABLE: \$\{\{ secrets\.EVIDENCE_INGEST_SECRET \}\}/, n);
    assert.match(s, /node --no-warnings scripts\/evidence-secret\.ts resolve/, n);
    assert.doesNotMatch(s, /EVIDENCE_INGEST_SECRET="\$ev"/, `${n} posts with the resolved value`);
    assert.doesNotMatch(s, /--env production|crestmont-platform-production|crestmont-production/, `${n} never touches production`);
  }
  for (const n of ["staging-restore-drill.yml", "staging-rollback-rehearsal.yml"]) {
    const s = wf(n);
    const put = s.indexOf("secret put EVIDENCE_INGEST_SECRET");
    assert.ok(put > 0);
    assert.match(s.slice(Math.max(0, put - 400), put), /outputs\.mode \}\}" = "ephemeral"/, `${n} only changes the Worker secret in ephemeral mode`);
  }
  // Every consumer reads the same GitHub secret name.
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
  assert.match(staging, /openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -in access\/README\.md -out access\/staging-access\.md\.enc -pass env:ACCESS_ARTIFACT_PASSPHRASE/);
  // The plaintext notes are uploaded only from a private repository; a public one without a passphrase gets none.
  assert.match(staging, /elif \[ "\$REPO_PRIVATE" = "true" \]; then\s*\n\s*echo "upload=plain"/);
  assert.match(staging, /REPO_PRIVATE: \$\{\{ github\.event\.repository\.private \}\}/);
  const uploads = [...staging.matchAll(/- uses: actions\/upload-artifact@v4\s*\n\s*if: ([^\n]+)\n[\s\S]*?path: ([^\n]+)/g)].map((m) => [m[1].trim(), m[2].trim()]);
  assert.deepEqual(uploads, [
    ["always() && steps.protect.outputs.upload == 'encrypted'", "access/staging-access.md.enc"],
    ["always() && steps.protect.outputs.upload == 'plain'", "access/README.md"],
  ]);
  const prod = wf("deploy-production.yml");
  assert.doesNotMatch(prod, /upload-artifact/, "no production artifact at all");
  assert.match(prod, /r2 object put "crestmont-files-production\/_backups\/[^"]+" --file "\$f" --remote/);
  assert.ok(prod.indexOf("r2 object put") < prod.indexOf("Apply D1 migrations (production"), "the export is stored before anything changes");
  for (const n of ["deploy-staging.yml", "staging-restore-drill.yml", "staging-rollback-rehearsal.yml"])
    assert.doesNotMatch(wf(n), /path: (drill|backups)\//, `${n} never uploads a database export`);
});
