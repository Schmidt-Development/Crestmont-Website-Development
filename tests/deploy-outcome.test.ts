// Staging deploy evidence must agree with what the run achieved (INFRA-005, TEST-004), and the Worker-log capture
// must prove it is connected to THIS Worker before its silence can mean anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { deployOutcome, MANDATORY } from "../scripts/deploy-outcome.ts";

const all = (o: string) => Object.fromEntries(MANDATORY.map((id) => [id, { outcome: o }]));
const wf = readFileSync(".github/workflows/deploy-staging.yml", "utf8");

test("[INFRA-005] deploy outcome: succeeded only when every mandatory check passed", () => {
  assert.deepEqual(deployOutcome(all("success"), { rotationPending: false }).status, "succeeded");
  assert.equal(deployOutcome(all("success"), { rotationPending: false }).verification, "passed");
  for (const bad of ["failure", "skipped", "cancelled"]) {
    const r = deployOutcome({ ...all("success"), crm_e2e: { outcome: bad } }, { rotationPending: false });
    assert.equal(r.status, "failed", bad); assert.equal(r.verification, "failed", bad);
    assert.match(r.notes, new RegExp(`crm_e2e=${bad}`));
  }
  // A step that never ran at all is not a pass either.
  const { verify: _v, ...missing } = all("success");
  assert.match(deployOutcome(missing, { rotationPending: false }).notes, /verify=not run/);
  // The rotation proof is mandatory only after a rotation.
  assert.equal(deployOutcome(all("success"), { rotationPending: true }).status, "failed");
  assert.equal(deployOutcome({ ...all("success"), revoked: { outcome: "success" } }, { rotationPending: true }).status, "succeeded");
  // `outcome` (before continue-on-error) decides, not `conclusion`, which reads success for a continue-on-error failure.
  assert.equal(deployOutcome({ ...all("success"), e2e: { outcome: "failure", conclusion: "success" } as never }, { rotationPending: false }).status, "failed");
});

test("[INFRA-005] the mandatory list covers every check that can fail the job, and the record never hard-codes success", () => {
  const gated = [...wf.matchAll(/- name: Fail the deploy when[^\n]*\n\s+if: ([^\n]+)/g)].flatMap((m) => [...m[1].matchAll(/steps\.(\w+)\.outcome == 'failure'/g)].map((x) => x[1]));
  assert.ok(gated.length >= 8);
  for (const id of gated) assert.ok((MANDATORY as readonly string[]).includes(id), `${id} fails the job but is not mandatory for the record`);
  for (const id of ["verify", "smoke", "frontend", "frontend_browser", "preview_render"]) assert.ok((MANDATORY as readonly string[]).includes(id), id);
  for (const id of MANDATORY) assert.match(wf, new RegExp(`\\n\\s+id: ${id}\\n`), `${id} exists in the workflow`);
  const rec = wf.slice(wf.indexOf("- name: Record evidence and deployment"), wf.indexOf("- name: GitHub readiness snapshot"));
  assert.match(rec, /STEPS: \$\{\{ toJSON\(steps\) \}\}/);
  assert.match(rec, /scripts\/deploy-outcome\.ts/);
  assert.match(rec, /--status "\$status"/);
  assert.match(rec, /--verification "\$verification"/);
  assert.doesNotMatch(rec, /--status succeeded|steps\.smoke\.outcome == 'success' && 'passed'/);
  // Every mandatory step runs before the record is made.
  for (const id of MANDATORY) assert.ok(wf.indexOf(`id: ${id}\n`) < wf.indexOf("- name: Record evidence and deployment"), `${id} runs before the record`);
});

test("[INFRA-005] deploy-outcome CLI: reads the steps context and writes status/verification/notes", () => {
  const r = spawnSync(process.execPath, ["--no-warnings", "scripts/deploy-outcome.ts", "--rotation-pending", "false"], { env: { ...process.env, STEPS: JSON.stringify({ ...all("success"), tls: { outcome: "failure" } }), GITHUB_OUTPUT: "" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).status, "failed");
});

test("[INFRA-005] Worker-log capture: named Worker without --env, and connection PROVEN by its own probe request", () => {
  const start = wf.slice(wf.indexOf("- name: Start capturing the Worker's own log"), wf.indexOf("- name: Verify the full access sequence"));
  assert.match(start, /\$WRANGLER tail crestmont-platform-staging --format json/);
  assert.doesNotMatch(start, /tail crestmont-platform-staging[^\n]*--env/, "a named Worker plus --env staging tails crestmont-platform-staging-staging");
  assert.match(start, /api\/health\?tailprobe=\$probe/);
  assert.match(start, /grep -q "\$probe" worker-tail\.jsonl/);
  assert.match(start, /echo "\$proven" > worker-tail\.proven/);
  assert.match(wf, /worker-faults\.ts worker-tail\.jsonl[^\n]*\\\n[^\n]*--proven "\$\(cat worker-tail\.proven/);
  for (const f of [".github/workflows/deploy-staging.yml", ".github/workflows/deploy-production.yml"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /wrangler[^\n]* tail crestmont-platform-(staging|production) [^\n]*--env/, f);
  }
});

test("[INFRA-005] worker-faults: an unproven capture says nothing, even when it wrote output", () => {
  const f = `${tmpdir()}/tail-${process.pid}.jsonl`;
  writeFileSync(f, JSON.stringify({ outcome: "ok", event: { request: { url: "https://x/a" } }, logs: [] }) + "\n");
  const run = (proven: string) => spawnSync(process.execPath, ["--no-warnings", "scripts/worker-faults.ts", f, "--title", "T", "--alive", "yes", "--proven", proven], { encoding: "utf8" }).stdout;
  assert.match(run("no"), /never received its own probe request[\s\S]*says NOTHING/);
  assert.match(run("yes"), /connected and logged nothing at error level/);
});
