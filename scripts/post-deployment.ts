// Records a deployment in the readiness system (READY-009) from GitHub Actions.
// Signs the JSON body with EVIDENCE_INGEST_SECRET (same HMAC scheme as scripts/post-evidence.ts) and
// POSTs it to /api/readiness/deployments. Exits non-zero on any failure so the workflow shows it.
//
// Env: READINESS_URL, EVIDENCE_INGEST_SECRET
//   node --no-warnings scripts/post-deployment.ts --id gh-123-1-staging --environment staging \
//     --commit $GITHUB_SHA --status succeeded --url https://staging.example.com --by github-actions:alice \
//     [--release rel_…] [--rollback-target <deployment id>] [--ci-run gh-123-1] [--run-url https://…] \
//     [--verification passed|failed|not_verified] [--notes "…"]
import { signEvidence } from "../src/readiness/ingest.ts";

const args = process.argv.slice(2);
const get = (k: string) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined; };

const url = process.env.READINESS_URL;
const secret = process.env.EVIDENCE_INGEST_SECRET;
if (!url || !secret) { console.error("READINESS_URL and EVIDENCE_INGEST_SECRET must be set; deployment NOT recorded."); process.exit(2); }

const doc = {
  deploymentId: get("--id"), environment: get("--environment"), commitSha: get("--commit"), status: get("--status"), initiatedBy: get("--by"),
  url: get("--url"), releaseId: get("--release"), rollbackTargetDeploymentId: get("--rollback-target"), ciRunId: get("--ci-run"),
  runUrl: get("--run-url"), verificationStatus: get("--verification"), notes: get("--notes"),
};
for (const k of ["deploymentId", "environment", "commitSha", "status", "initiatedBy"] as const) {
  if (!doc[k]) { console.error(`Missing --${k === "deploymentId" ? "id" : k === "commitSha" ? "commit" : k === "initiatedBy" ? "by" : k}`); process.exit(2); }
}
const body = JSON.stringify(Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined && v !== "")));
const res = await fetch(new URL("/api/readiness/deployments", url), {
  method: "POST",
  headers: { "content-type": "application/json", "x-crestmont-signature": await signEvidence(secret, body) },
  body,
});
const text = await res.text();
console.log(res.status, text);
if (!res.ok) process.exit(1);
try {
  const r = JSON.parse(text) as { releaseCheck?: string; incidentBlockerId?: string | null };
  if (r.releaseCheck === "mismatch") { console.error(`::error::Deployed commit does not match the Founder-approved release candidate. Incident ${r.incidentBlockerId ?? ""} opened.`); process.exit(3); }
} catch { /* response already printed */ }
