// Signs evidence/ci-evidence.json and posts it to the readiness API.
// Env: READINESS_URL (e.g. https://staging.<domain>), EVIDENCE_INGEST_SECRET.
// Exits non-zero on any failure so CI surfaces broken ingestion rather than hiding it.
import { readFileSync, writeFileSync } from "node:fs";
import { signEvidence } from "../src/readiness/ingest.ts";

const url = process.env.READINESS_URL;
const secret = process.env.EVIDENCE_INGEST_SECRET;
if (!url || !secret) {
  console.error("READINESS_URL and EVIDENCE_INGEST_SECRET must be set; evidence NOT posted.");
  process.exit(2);
}
const args = process.argv.slice(2);
const ri = args.indexOf("--receipt");
const receipt = ri >= 0 ? args.splice(ri, 2)[1] : null; // --receipt <file>: the API answer, for the readiness journeys
const body = readFileSync(args[0] ?? "evidence/ci-evidence.json", "utf8");
const res = await fetch(new URL("/api/readiness/evidence", url), {
  method: "POST",
  headers: { "content-type": "application/json", "x-crestmont-signature": await signEvidence(secret, body) },
  body,
});
const text = await res.text();
console.log(res.status, text);
if (receipt) { let json: unknown = {}; try { json = JSON.parse(text); } catch { /* not JSON */ } writeFileSync(receipt, JSON.stringify({ status: res.status, json })); }
if (!res.ok) process.exit(1);
