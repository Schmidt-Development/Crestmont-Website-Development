// Static checks of the delivery pipeline (INFRA-004, DOC-002, READY-012, SEC-004). These prove the workflows are
// configured as documented; whether a given run passed is recorded as evidence by the runs themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

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
