// node:test custom reporter. Prints a readable summary and writes evidence/ci-evidence.json,
// mapping each test tagged "[REQ-ID] ..." to its requirement. This file is what CI signs and
// posts to /api/readiness/evidence. Untagged tests are counted but produce no evidence.
// A test may carry several leading tags ("[TEST-002] [CRM-001] journey 1: ...") and then produces one
// result per tag. Skipped tests (node:test reports them as test:pass with `skip` set) are recorded as
// outcome "skipped" with the skip reason, never as "passed".
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const sh = (c) => { try { return execSync(c, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };

export default async function* reporter(source) {
  const startedAt = new Date().toISOString();
  const results = [];
  let pass = 0, fail = 0, skipped = 0, untagged = 0;
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    if (event.data.details?.type === "suite") continue;
    const name = event.data.name;
    const ok = event.type === "test:pass";
    const skip = ok && (event.data.skip !== undefined && event.data.skip !== false || event.data.todo !== undefined && event.data.todo !== false);
    const reason = skip ? String(typeof event.data.skip === "string" ? event.data.skip : typeof event.data.todo === "string" ? event.data.todo : "skipped") : "";
    skip ? skipped++ : ok ? pass++ : fail++;
    const m = /^((?:\[[A-Z]+-\d{3}\]\s*)+)(.*)$/.exec(name);
    yield `${skip ? "-" : ok ? "✔" : "✖"} ${name}${skip ? ` # SKIP ${reason}` : ""}\n`;
    if (!ok) {
      // The first lines of the error, whitespace collapsed: a bare first line ("…regular expression. Input:") hid the
      // actual page text in deploy #61. In GitHub Actions each failure is also an ::error annotation, which the checks
      // API exposes even when the raw job log cannot be downloaded.
      const msg = String(event.data.details?.error?.cause?.message ?? event.data.details?.error?.message ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 12).join(" ").replace(/\s+/g, " ").slice(0, 600);
      yield `    ${msg}\n`;
      if (process.env.GITHUB_ACTIONS === "true") {
        const enc = (v) => v.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
        yield `::error title=${enc(name.slice(0, 120)).replace(/[:,]/g, " ")}::${enc(msg)}\n`;
      }
    }
    if (!m) { untagged++; continue; }
    for (const requirementId of new Set(m[1].match(/[A-Z]+-\d{3}/g))) {
      results.push({ requirementId, testName: m[2], outcome: skip ? "skipped" : ok ? "passed" : "failed", durationMs: Math.round(event.data.details?.duration_ms ?? 0),
        ...(skip ? { message: reason.slice(0, 1000) } : ok ? {} : { message: String(event.data.details?.error?.message ?? "").slice(0, 1000) }) });
    }
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
  yield `\n${pass} passed, ${fail} failed, ${skipped} skipped, ${untagged} untagged — evidence for ${reqs.size} requirements written to ${process.env.EVIDENCE_FILE || "evidence/ci-evidence.json"}\n`;
}
