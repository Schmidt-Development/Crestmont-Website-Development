// Unit tests: owner report content and honest requirement normalization.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildReport } from "../src/report.ts";
import type { ReportInput } from "../src/report.ts";
import { normalizeItem, readRequirements, checkRequirements } from "../src/requirements.ts";
import { makeJob, tmp } from "./helpers.ts";

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    job: makeJob(), outcome: "ready_for_review", stopReason: null, error: null,
    requirements: [
      { key: "page:home", label: "Home page", status: "verified", evidence: "npm run check exit 0" },
      { key: "page:about", status: "implemented_unverified" },
      { key: "page:blog", status: "remaining" },
      { key: "seo:domain", status: "blocked", blocker: "Domain not confirmed" },
    ],
    checks: [{ id: "static-check", label: "Static", command: "npm run -s check -- --package starter", ok: true, code: 0, timedOut: false, outputTail: "" }],
    preview: { url: null, note: "PREVIEW_DEPLOY_COMMAND is not configured on the runner." },
    source: { repoUrl: null, branch: "ai-build/first-build", commit: "abc123", pushed: false, note: "PROJECT_REPO_* is not configured", workspace: "/ws/bld_1-a1-x" },
    costUsd: 3.21, turns: 57, costCaveats: [], sessionId: "sess-1", sessionNotes: ["Resumed Agent SDK session sess-0."],
    skills: { provisioned: ["frontend-design"], missingOptional: ["image-to-code"] },
    assumptions: ["No logo; text wordmark"], missingInformation: [], agentReport: "## Completed\n- home\n```\nnested\n```",
    envVarNames: ["CONTROL_PLANE_URL", "BUILD_RUNNER_SECRET", "ANTHROPIC_API_KEY"], starter: "brochure-v1",
    ...over,
  };
}

test("[AIB-RUNNER] owner report lists completed / remaining / blocked, assumptions, checks, preview, how to run, env var names only", () => {
  const r = buildReport(input());
  for (const h of ["## Completed", "## Remaining", "## Blocked", "## Assumptions", "## Checks run by the runner", "## Preview", "## Source", "## How to run locally", "## Environment variables (names only)", "## Run details"]) {
    assert.ok(r.includes(h), h);
  }
  assert.match(r, /Home page \(`page:home`\): verified\. Evidence: npm run check exit 0/);
  assert.match(r, /`page:about`: implemented, not verified/);
  assert.match(r, /`page:blog`: remaining/);
  assert.match(r, /`seo:domain`: blocked\. Domain not confirmed/);
  assert.match(r, /PASS `npm run -s check -- --package starter`/);
  assert.match(r, /Preview unavailable: PREVIEW_DEPLOY_COMMAND is not configured/);
  assert.match(r, /npx wrangler dev/);
  assert.match(r, /`BUILD_RUNNER_SECRET`/);
  assert.match(r, /\$3\.21 \(Agent SDK client-side estimate/);
  assert.match(r, /Optional skills unavailable: image-to-code/);
  assert.match(r, /Agent's own report \(unverified narrative/);
  assert.match(r, /````markdown/, "agent narrative fenced so it cannot forge sections");
  assert.match(r, /Nothing was published to production or sent to the customer/);
});

test("[AIB-RUNNER] report stays within 50 KB and states failures and stops plainly", () => {
  const big = buildReport(input({ agentReport: "x".repeat(200_000), requirements: Array.from({ length: 2000 }, (_, i) => ({ key: `k${i}`, status: "remaining" as const, label: "y".repeat(40) })) }));
  assert.ok(Buffer.byteLength(big) <= 50 * 1024);
  assert.match(big, /report truncated/);
  const failed = buildReport(input({ outcome: "failed", error: "Acceptance checks failed: static-check", checks: [{ id: "static-check", label: "s", command: "npm run -s check", ok: false, code: 1, timedOut: false, outputTail: "ERROR public/index.html: missing <title>" }] }));
  assert.match(failed, /^# AI build report: Failed/);
  assert.match(failed, /FAIL `npm run -s check` \(exit 1\)/);
  assert.match(failed, /missing <title>/);
  const stopped = buildReport(input({ outcome: "stopped", stopReason: "control plane requested stop (budget)" }));
  assert.match(stopped, /Stopped because: control plane requested stop \(budget\)/);
});

test("[AIB-RUNNER] requirement statuses are normalized honestly (verified needs evidence, blocked needs a blocker)", () => {
  assert.deepEqual(normalizeItem({ key: "a", status: "verified" }), { key: "a", status: "implemented_unverified" });
  assert.deepEqual(normalizeItem({ key: "b", status: "verified", evidence: "ran npm test" }), { key: "b", status: "verified", evidence: "ran npm test" });
  assert.equal(normalizeItem({ key: "c", status: "blocked" })?.blocker, "Blocked (no reason recorded by the agent)");
  assert.equal(normalizeItem({ key: "d", status: "done!" })?.status, "remaining");
  assert.equal(normalizeItem({ status: "verified" }), null);
  assert.equal(normalizeItem({ key: "e", status: "verified", evidence: "z".repeat(5000) })?.evidence?.length, 1000);
  const repo = tmp();
  mkdirSync(path.join(repo, ".crestmont"));
  writeFileSync(path.join(repo, ".crestmont", "requirements.json"), JSON.stringify([{ key: "page:home", status: "verified", evidence: "screenshot home.png" }, { key: "new:item", status: "remaining" }]));
  const merged = readRequirements(repo, [{ key: "page:home", label: "Home", status: "remaining" }, { key: "page:contact", label: "Contact", status: "remaining" }]);
  assert.deepEqual(merged.map((r) => [r.key, r.status, r.label]), [["page:home", "verified", "Home"], ["page:contact", "remaining", "Contact"], ["new:item", "remaining", undefined]]);
  const cr = checkRequirements([{ id: "x", label: "X", command: "npm test", ok: false, code: 2, timedOut: true, outputTail: "" }]);
  assert.deepEqual(cr, [{ key: "check:x", label: "X", status: "blocked", blocker: "Runner ran `npm test`: exit 2 (timed out)" }]);
});
