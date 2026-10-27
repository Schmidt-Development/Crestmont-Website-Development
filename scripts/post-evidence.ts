// Signs evidence/ci-evidence.json and posts it to the readiness API.
// Env: READINESS_URL (e.g. https://staging.<domain>), EVIDENCE_INGEST_SECRET.
// Exits non-zero on any failure so CI surfaces broken ingestion rather than hiding it.
import { readFileSync } from "node:fs";
import { signEvidence } from "../src/readiness/ingest.ts";

const url = process.env.READINESS_URL;
const secret = process.env.EVIDENCE_INGEST_SECRET;
if (!url || !secret) {
  console.error("READINESS_URL and EVIDENCE_INGEST_SECRET must be set; evidence NOT posted.");
  process.exit(2);
}
const body = readFileSync(process.argv[2] ?? "evidence/ci-evidence.json", "utf8");
const res = await fetch(new URL("/api/readiness/evidence", url), {
  method: "POST",
  headers: { "content-type": "application/json", "x-crestmont-signature": await signEvidence(secret, body) },
  body,
});
const text = await res.text();
console.log(res.status, text);
if (!res.ok) process.exit(1);
