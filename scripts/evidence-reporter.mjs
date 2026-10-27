// node:test custom reporter. Prints a readable summary and writes evidence/ci-evidence.json,
// mapping each test tagged "[REQ-ID] ..." to its requirement. This file is what CI signs and
// posts to /api/readiness/evidence. Untagged tests are counted but produce no evidence.
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const sh = (c) => { try { return execSync(c, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };

export default async function* reporter(source) {
  const startedAt = new Date().toISOString();
  const results = [];
  let pass = 0, fail = 0, untagged = 0;
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    if (event.data.details?.type === "suite") continue;
    const name = event.data.name;
    const ok = event.type === "test:pass";
    ok ? pass++ : fail++;
    const m = /^\[([A-Z]+-\d{3})\]\s*(.*)$/.exec(name);
    yield `${ok ? "✔" : "✖"} ${name}\n`;
    if (!ok) yield `    ${String(event.data.details?.error?.cause?.message ?? event.data.details?.error?.message ?? "").split("\n")[0]}\n`;
    if (!m) { untagged++; continue; }
    results.push({ requirementId: m[1], testName: m[2], outcome: ok ? "passed" : "failed", durationMs: Math.round(event.data.details?.duration_ms ?? 0),
      ...(ok ? {} : { message: String(event.data.details?.error?.message ?? "").slice(0, 1000) }) });
  }
  const commitSha = process.env.GITHUB_SHA || sh("git rev-parse HEAD") || "0000000";
  // Evidence from an uncommitted working tree is labelled so it is never mistaken for the commit itself.
  const dirty = !process.env.GITHUB_SHA && sh("git status --porcelain --untracked-files=no") !== "";
  const doc = {
    runId: (process.env.GITHUB_RUN_ID ? `gh-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}` : `local-${commitSha.slice(0, 12)}-${Date.now()}`) + (process.env.EVIDENCE_SUFFIX ? `-${process.env.EVIDENCE_SUFFIX}` : "") + (dirty ? "-dirty" : ""),
    source: process.env.EVIDENCE_SOURCE || "ci",
    environment: process.env.EVIDENCE_ENVIRONMENT || "development",
    commitSha,
    branch: process.env.GITHUB_REF_NAME || sh("git rev-parse --abbrev-ref HEAD") || undefined,
    ...(process.env.GITHUB_RUN_ID ? { runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` } : {}),
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
  };
  mkdirSync("evidence", { recursive: true });
  const out = process.env.EVIDENCE_FILE || "evidence/ci-evidence.json";
  writeFileSync(out, JSON.stringify(doc, null, 2));
  const reqs = new Set(results.map((r) => r.requirementId));
  yield `\n${pass} passed, ${fail} failed, ${untagged} untagged — evidence for ${reqs.size} requirements written to ${process.env.EVIDENCE_FILE || "evidence/ci-evidence.json"}\n`;
}
