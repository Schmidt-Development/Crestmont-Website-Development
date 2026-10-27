// Creates a release candidate in the readiness system from a release tag (INFRA-005, READY-008).
// The candidate binds the full commit SHA and the SHA-256 of wrangler.toml (deployment configuration);
// the Founder then reviews and approves it at /staff/readiness/approve. This script cannot approve
// anything. Re-running it for the same commit and configuration is a no-op (approvals survive).
//
// Env: READINESS_URL, EVIDENCE_INGEST_SECRET
//   node --no-warnings scripts/release-candidate.ts --tag v1.0.0 --commit <40-hex> --notes-file notes.md [--run-url https://…]
//   node --no-warnings scripts/release-candidate.ts --print-config-digest
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { signEvidence } from "../src/readiness/ingest.ts";

const args = process.argv.slice(2);
const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
// Must equal src/services/deployments.ts#configDigest (CRLF normalised to LF).
const configSha256 = createHash("sha256").update(readFileSync("wrangler.toml", "utf8").replace(/\r\n/g, "\n"), "utf8").digest("hex");
if (args.includes("--print-config-digest")) { console.log(configSha256); process.exit(0); }

const url = process.env.READINESS_URL;
const secret = process.env.EVIDENCE_INGEST_SECRET;
if (!url || !secret) { console.error("READINESS_URL and EVIDENCE_INGEST_SECRET must be set; release candidate NOT created."); process.exit(2); }
const tag = get("--tag"), commitSha = get("--commit")?.toLowerCase();
if (!tag || !/^v[0-9A-Za-z._-]+$/.test(tag)) { console.error("--tag v<version> is required"); process.exit(2); }
if (!commitSha || !/^[0-9a-f]{40}$/.test(commitSha)) { console.error("--commit must be the full 40-character SHA"); process.exit(2); }
const notesFile = get("--notes-file");
const notes = (notesFile ? readFileSync(notesFile, "utf8") : `Release ${tag}`).slice(0, 9_000).padEnd(10, ".");
const rollbackPlan = [
  "1. `wrangler deployments list --env production` and `wrangler rollback <previous deployment id> --env production --message \"Rollback " + tag + "\"`.",
  "2. Confirm /api/health and the post-deploy production checks (deploy-production.yml) pass on the previous version.",
  "3. Record the rollback (scripts/post-deployment.ts --status rolled_back) and open a production_incident blocker.",
  "4. Migrations are additive and are not rolled back; if data must be restored follow docs/BACKUP-RECOVERY.md §3 with Founder approval.",
].join("\n");
const body = JSON.stringify({ tag, commitSha, configSha256, notes, rollbackPlan, ...(get("--run-url") ? { runUrl: get("--run-url") } : {}) });
const res = await fetch(new URL("/api/readiness/release-candidates", url), {
  method: "POST", headers: { "content-type": "application/json", "x-crestmont-signature": await signEvidence(secret, body) }, body,
});
const text = await res.text();
console.log(res.status, text);
if (!res.ok) process.exit(1);
