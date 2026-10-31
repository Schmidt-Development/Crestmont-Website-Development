// Static checks of the delivery pipeline (INFRA-004, DOC-002, READY-012, SEC-004). These prove the workflows are
// configured as documented; whether a given run passed is recorded as evidence by the runs themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const wf = (n: string) => readFileSync(`.github/workflows/${n}`, "utf8");

test("[INFRA-004] CI runs on every pull request and push to main: typecheck, unit/integration tests (incl. the secret scan), runner build and tests, dependency audit, evidence", () => {
  const ci = wf("ci.yml");
  assert.match(ci, /on:\s*\n\s*pull_request:/);
  assert.match(ci, /push:\s*\n\s*branches: \[main\]/);
  for (const step of [/npx tsc -p tsconfig\.json/, /npm test/, /runner\/tsconfig\.json/, /npm audit/, /upload-artifact/]) assert.match(ci, step);
  assert.ok(existsSync("tests/secret-scan.test.ts"), "secret scan runs inside npm test");
  assert.match(wf("codeql.yml"), /codeql-action\/analyze/);
  assert.match(ci, /permissions:\s*\n\s*contents: read/, "CI token is read-only");
});

test("[SEC-004] dependency scanning: Dependabot watches npm (root and runner), GitHub Actions and the runner images; workflows never echo secrets", () => {
  const dep = readFileSync(".github/dependabot.yml", "utf8");
  for (const [eco, dir] of [["npm", "/"], ["npm", "/runner"], ["github-actions", "/"], ["docker", "/runner"], ["docker", "/runner/sandbox"]])
    assert.match(dep, new RegExp(`package-ecosystem: ${eco}\\s*\\n\\s*directory: "${dir.replace(/\//g, "\\/")}"`), `${eco} ${dir}`);
  for (const n of ["ci.yml", "deploy-staging.yml", "deploy-production.yml", "release.yml", "staging-restore-drill.yml", "staging-rollback-rehearsal.yml", "staging-health-monitor.yml"]) {
    const s = wf(n);
    assert.doesNotMatch(s, /echo\s+["']?\$\{\{\s*secrets\./, `${n} never echoes a secret`);
    assert.doesNotMatch(s, /echo\s+["']?\$(EVIDENCE_INGEST_SECRET|CLOUDFLARE_API_TOKEN|BUILD_RUNNER_SECRET)\b/, `${n} never echoes a secret variable`);
  }
});

test("[READY-012] [DOC-002] external alerting: an off-platform monitor probes service and evidence-feed health every 30 minutes with retries and fails loudly; the runbook documents the channel", () => {
  const m = wf("staging-health-monitor.yml");
  assert.match(m, /schedule:\s*\n\s*- cron: "11,41 \* \* \* \*"/);
  assert.match(m, /\/api\/health/);
  assert.match(m, /\/api\/readiness\/health/);
  assert.match(m, /for attempt in 1 2 3/);
  assert.match(m, /exit 1/);
  assert.deepEqual([...m.matchAll(/secrets\.([A-Z_]+)/g)].map((x) => x[1]), ["CLOUDFLARE_API_TOKEN"], "only the scheduler step uses a secret (to derive its key)");
  assert.match(m, /scripts\/trigger-scheduler\.ts run --url "\$BASE"/);
  assert.match(m, /if: github\.event_name == 'workflow_dispatch' && inputs\.run_jobs/, "the backup job run is manual only (native Cron Triggers run the jobs)");
  assert.match(m, /persist-credentials: false/);
  const rb = readFileSync("docs/RUNBOOK.md", "utf8");
  assert.match(rb, /staging-health-monitor\.yml/);
  assert.match(rb, /Founder.*F-03|F-03/);
  assert.doesNotMatch(rb, /No external alerting exists yet/);
});

test("[TEST-004] [DOC-002] recovery is rehearsed after every successful staging deploy: rollback rehearsal and restore drill share the deploy concurrency group and never touch production", () => {
  for (const n of ["staging-rollback-rehearsal.yml", "staging-restore-drill.yml"]) {
    const s = wf(n);
    assert.match(s, /workflow_run:\s*\n\s*workflows: \["Deploy staging"\]\s*\n\s*types: \[completed\]/, n);
    assert.match(s, /github\.event\.workflow_run\.conclusion == 'success'/, n);
    assert.match(s, /group: deploy-staging/, n);
    assert.doesNotMatch(s, /--env production|crestmont-platform-production|crestmont-production/, n);
  }
  assert.match(wf("deploy-staging.yml"), /^name: Deploy staging$/m, "workflow_run names the real deploy workflow");
  const rb = readFileSync("docs/RUNBOOK.md", "utf8");
  for (const s of ["## 3. Rollback", "BACKUP-RECOVERY", "Incident"]) assert.ok(rb.includes(s), s);
});

test("[TEST-004] [INFRA-002] CREST-GAP-065: the restore drill and rollback rehearsal inject the staging D1 id exactly as deploy-staging.yml does, before any wrangler --env staging command", () => {
  const injection = /node -e 'const fs=require\("fs"\);let t=fs\.readFileSync\("wrangler\.toml","utf8"\);t=t\.replace\(\/\(database_name = "crestmont-staging", database_id = \)""\/, `\$1"\$\{process\.argv\[1\]\}"`\);fs\.writeFileSync\("wrangler\.toml",t\)' "\$id"/;
  assert.match(wf("deploy-staging.yml"), injection, "the reference injection");
  for (const n of ["staging-restore-drill.yml", "staging-rollback-rehearsal.yml"]) {
    const s = wf(n);
    assert.match(s, injection, n);
    assert.match(s, /CREST-GAP-065/, `${n} explains why`);
    assert.match(s, /find\(d=>d\.name==="crestmont-staging"\)/, `${n} looks the id up by name`);
    assert.doesNotMatch(s, /d1 create crestmont-staging/, `${n} never creates the staging database`);
    const at = s.indexOf("Resolve the staging D1 database id");
    assert.ok(at > 0 && at < s.search(/\$WRANGLER (d1 export|deployments status)/), `${n}: injected before the first --env staging command`);
  }
});

test("[INFRA-006] [READY-012] CREST-GAP-015: a production health monitor mirrors the staging one against vars.PRODUCTION_URL and skips cleanly while it is unset", () => {
  const p = wf("production-health-monitor.yml"), s = wf("staging-health-monitor.yml");
  assert.match(p, /schedule:\s*\n\s*- cron: "26,56 \* \* \* \*"/, "every 30 minutes");
  for (const x of [/\/api\/health/, /\/api\/readiness\/health/, /for attempt in 1 2 3/, /sleep 60/, /exit 1/]) { assert.match(p, x); assert.match(s, x); }
  assert.match(p, /BASE: \$\{\{ vars\.PRODUCTION_URL \}\}/);
  assert.match(p, /if \[ -z "\$BASE" \]; then\s*\n\s*echo "::notice title=Production health monitor skipped::/);
  assert.match(p, /if: steps\.pre\.outputs\.ok == 'true'/);
  assert.doesNotMatch(p, /secrets\./, "public endpoints only, no secret");
  assert.doesNotMatch(p, /^\s+environment:/m, "no environment: required reviewers would pause every scheduled run");
  assert.match(p, /if: github\.ref == 'refs\/heads\/main'/);
  // The skip path really exits 0 and the probe never runs without a URL.
  const pre = /- name: Skip until production has a URL[\s\S]*?run: \|\n([\s\S]*?)\n\n/.exec(p)![1].replace(/^ {10}/gm, "");
  const out = execFileSync("bash", ["-c", pre], { env: { ...process.env, BASE: "", GITHUB_OUTPUT: "/dev/null" }, encoding: "utf8" });
  assert.match(out, /Production health monitor skipped/);
  assert.throws(() => execFileSync("bash", ["-c", pre], { env: { ...process.env, BASE: "http://insecure.example", GITHUB_OUTPUT: "/dev/null" }, stdio: "pipe" }), "an http or path URL is rejected");
});

test("[INFRA-006] CREST-GAP-016: a daily production backup exports D1 read-only, seals it, uploads it off-Cloudflare with sha256 recorded, and a second job restores it into a scratch database", () => {
  const b = wf("production-backup.yml");
  assert.match(b, /schedule:\s*\n\s*- cron: "\d+ \d+ \* \* \*"/, "daily");
  assert.match(b, /environment: \$\{\{ vars\.BACKUP_ENVIRONMENT \|\| 'production' \}\}/);
  assert.match(b, /if: github\.ref == 'refs\/heads\/main'/);
  for (const sec of ["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY", "BACKUP_SEAL_PASSPHRASE"]) assert.match(b, new RegExp(`secrets\\.${sec} != ''`), `${sec} checked before anything runs`);
  assert.match(b, /::notice title=Production backup skipped::Off-Cloudflare destination not configured\. Set BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY and BACKUP_SEAL_PASSPHRASE/);
  assert.match(b, /d1 export crestmont-production --remote --env production --output backup\/export\.sql/);
  assert.match(b, /scripts\/seal\.ts seal backup\/export\.sql/);
  assert.ok(b.indexOf("rm -f backup/export.sql") > b.indexOf("seal.ts seal backup/export.sql") && b.indexOf("rm -f backup/export.sql") < b.indexOf("offsite-backup.ts put"), "plaintext removed before upload");
  assert.match(b, /scripts\/offsite-backup\.ts put "backup\/\$NAME\.sql\.sealed"/, "only the SEALED file is uploaded");
  assert.match(b, /sha256 \(export\)[\s\S]*sha256 \(sealed object\)/, "both sha256 values in the run summary");
  assert.doesNotMatch(b, /upload-artifact/, "never a workflow artifact (public repository)");
  // Production is only ever read: every command naming the production database is an export or a --json SELECT.
  const prodCmds = b.split("\n").filter((l) => /crestmont-production\b/.test(l) && /\$WRANGLER/.test(l));
  assert.ok(prodCmds.length >= 3);
  for (const l of prodCmds) assert.match(l.trim(), /^\$WRANGLER d1 (export crestmont-production --remote --env production --output|execute crestmont-production --remote --env production --json --command)/, l);
  assert.doesNotMatch(b, /--env production[^\n]*--file|migrations apply|time-travel restore|\bdeploy --env|rollback --env|d1 delete crestmont-production/);
  // Restore verification into a scratch database, modelled on the staging drill.
  assert.match(b, /restore-verify:\s*\n\s*needs: backup/);
  assert.match(b, /SCRATCH: crestmont-backup-verify-\$\{\{ github\.run_id \}\}/);
  assert.match(b, /offsite-backup\.ts get "\$OBJECT"/, "restores the copy that is OFF Cloudflare");
  assert.match(b, /sha256 does not match the manifest/);
  assert.match(b, /d1 create "\$SCRATCH"[\s\S]*d1 execute "\$SCRATCH" --remote --file verify\/import\.sql[\s\S]*offsite-backup\.ts compare/);
  assert.match(b, /- name: Delete the scratch database\s*\n\s*if: always\(\)/);
  assert.match(b, /- name: Remove the export from the runner\s*\n\s*if: always\(\)\s*\n\s*run: rm -rf backup/);
  const doc = readFileSync("docs/BACKUP-RECOVERY.md", "utf8");
  assert.match(doc, /RPO 24 h, RTO 4 h/);
  assert.match(doc, /pending Founder approval/);
  assert.match(doc, /production-backup\.yml/);
});

test("[DOC-002] [INFRA-005] CREST-GAP-068: the runbook documents first-release rollback and the deploy warns when it lands on the empty draft Worker", () => {
  const rb = readFileSync("docs/RUNBOOK.md", "utf8");
  assert.match(rb, /### 3\.1 First production release/);
  assert.match(rb, /empty draft Worker/);
  assert.match(rb, /Fix forward/);
  assert.match(rb, /Why the domain is not attached only after the checks pass/);
  const prod = wf("deploy-production.yml");
  const rollback = prod.slice(prod.indexOf("- name: Roll back on failed production checks"), prod.indexOf("- name: Record failed deployment"));
  assert.match(rollback, /rollback --env production/, "failed code never keeps serving");
  assert.match(rollback, /if \[ -f backups\/EMPTY-DATABASE\.txt \]; then[\s\S]*First release rolled back/);
  assert.match(prod, /backups\/EMPTY-DATABASE\.txt/, "the marker is written by the safety-export step");
});
