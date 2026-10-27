// Asks the readiness system whether a valid Founder production approval exists for EXACTLY this
// commit (and deployment configuration) and the current evidence set (LAUNCH-002, §79). Read-only.
// Exit 0 only when authorized; exit 1 otherwise. The production deploy workflow refuses to continue
// on any non-zero exit, so an unreachable readiness API or a bad signature also blocks the deploy.
//
// Env: READINESS_URL, EVIDENCE_INGEST_SECRET
//   node --no-warnings scripts/release-authorization.ts --commit <40-hex> [--config <sha256 of wrangler.toml>]
import { signEvidence } from "../src/readiness/ingest.ts";

const args = process.argv.slice(2);
const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const url = process.env.READINESS_URL;
const secret = process.env.EVIDENCE_INGEST_SECRET;
if (!url || !secret) { console.error("::error::READINESS_URL and EVIDENCE_INGEST_SECRET must be set; cannot confirm Founder authorization. Refusing."); process.exit(1); }
const commit = get("--commit")?.toLowerCase() ?? "";
if (!/^[0-9a-f]{40}$/.test(commit)) { console.error("::error::--commit must be the full 40-character SHA"); process.exit(1); }
const config = get("--config");

const target = new URL("/api/readiness/release-authorization", url);
target.searchParams.set("commit", commit);
if (config) target.searchParams.set("config", config);
// The signature covers the method, path and query exactly as sent (src/routes/ops.ts#signedGetCanonical).
const canonical = `GET ${target.pathname}${target.search}`;
let res: Response;
try {
  res = await fetch(target, { headers: { accept: "application/json", "x-crestmont-signature": await signEvidence(secret, canonical) }, signal: AbortSignal.timeout(20_000) });
} catch (e) { console.error(`::error::Readiness API unreachable (${(e as Error).message}). Refusing to deploy.`); process.exit(1); }
const text = await res.text();
let body: { authorized?: boolean; reason?: string; releaseCandidate?: { id: string; commit: string } | null; approval?: { id: string } | null; gates?: { id: string; status: string }[] };
try { body = JSON.parse(text); } catch { console.error(`::error::Readiness API returned HTTP ${res.status}: ${text.slice(0, 300)}`); process.exit(1); }
console.log(JSON.stringify({ status: res.status, ...body }, null, 2));
if (res.status !== 200 || body.authorized !== true) {
  console.error(`::error::Production deploy NOT authorized for ${commit}: ${body.reason ?? `HTTP ${res.status}`}`);
  process.exit(1);
}
console.log(`Founder approval ${body.approval?.id} is valid for release candidate ${body.releaseCandidate?.id} (${commit}).`);
if (process.env.GITHUB_OUTPUT && body.releaseCandidate) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_OUTPUT, `release_id=${body.releaseCandidate.id}\n`);
}
