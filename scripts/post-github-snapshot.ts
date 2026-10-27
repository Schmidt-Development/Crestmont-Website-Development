// Pushes a GitHub readiness snapshot (READY-005) from inside GitHub Actions, so the Worker does not need
// a personal access token. Uses the workflow's own GITHUB_TOKEN (read-only job permissions: contents,
// actions, pull-requests, checks, security-events) to read the default branch, recent commits, open pull
// requests, recent workflow runs, tags and code-scanning alerts, then POSTs the snapshot to
// /api/readiness/github-snapshot signed with EVIDENCE_INGEST_SECRET (same HMAC scheme as post-evidence.ts).
//
// Code scanning needs GitHub Advanced Security on private repositories: a 403/404 is recorded as
// "Unavailable: …" with no count — never as zero alerts. A failing core call (repo, commits, pulls,
// runs, tags) is posted as ok:false with GitHub's reason, so the view shows "failing", not stale data.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/name), READINESS_URL, EVIDENCE_INGEST_SECRET
//      (GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_SERVER_URL are used for the snapshot id and run link).
//   node --no-warnings scripts/post-github-snapshot.ts [--out evidence/github-snapshot.json] [--dry-run]
// The token and the signing secret are never printed.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildPushedSnapshot } from "../src/services/github.ts";
import { signEvidence } from "../src/readiness/ingest.ts";

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined; };
const dryRun = args.includes("--dry-run");
const out = opt("--out");

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const url = process.env.READINESS_URL;
const secret = process.env.EVIDENCE_INGEST_SECRET;
if (!token || !repo) { console.error("GITHUB_TOKEN and GITHUB_REPOSITORY must be set; snapshot NOT posted."); process.exit(2); }
if (!dryRun && (!url || !secret)) { console.error("READINESS_URL and EVIDENCE_INGEST_SECRET must be set; snapshot NOT posted."); process.exit(2); }

const runId = process.env.GITHUB_RUN_ID;
const snapshotId = runId ? `gh-${runId}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}` : `local-${Date.now()}`;
const runUrl = runId ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${runId}` : undefined;

const doc = await buildPushedSnapshot({ token, repo, snapshotId, runUrl });
const s = doc.snapshot;
console.log(doc.ok && s
  ? `GitHub snapshot ${snapshotId}: ${s.defaultBranch} @ ${s.head?.sha.slice(0, 7) ?? "no commits"} · ${s.commits.length} commits · ${s.pulls.length} open PRs · ${s.runs.length} runs · ${s.tags.length} tags · code scanning: ${s.codeScanning.detail}`
  : `GitHub snapshot ${snapshotId} FAILED: ${doc.error}`);
const body = JSON.stringify(doc);
if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, body); }
if (dryRun) process.exit(doc.ok ? 0 : 1);

const res = await fetch(new URL("/api/readiness/github-snapshot", url), {
  method: "POST",
  headers: { "content-type": "application/json", "x-crestmont-signature": await signEvidence(secret!, body) },
  body,
});
console.log(res.status, (await res.text()).slice(0, 500));
if (!res.ok || !doc.ok) process.exit(1);
