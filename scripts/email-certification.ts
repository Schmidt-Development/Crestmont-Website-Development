// Runs the email delivery certification on a deployed environment (src/services/email-certification.ts) and follows
// every message until Resend's delivery webhook answers. Prints a matrix (template, Resend accepted, webhook result);
// never an address, subject or body. Exit 1 unless every template was delivered and the bounce probe bounced.
// Auth: CHALLENGE_FILE (production; RUN_ID must match the challenge) or EVIDENCE_INGEST_SECRET (staging).
// Status: D1 (D1_DATABASE + D1_ENV) or the signed endpoint.
import { appendFileSync, readFileSync } from "node:fs";
import { signEvidence } from "../src/readiness/ingest.ts";
import { follow, d1Source, signedSource } from "./delivery-follow.ts";

const base = process.env.BASE?.replace(/\/+$/, "") ?? "";
const secret = process.env.EVIDENCE_INGEST_SECRET ?? "";
const envLabel = process.env.ENVIRONMENT_LABEL ?? "unknown";
const challengeFile = process.env.CHALLENGE_FILE;
if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(base) || (!secret && !challengeFile)) { console.error("::error::BASE and EVIDENCE_INGEST_SECRET or CHALLENGE_FILE are required"); process.exit(2); }
const runId = process.env.RUN_ID || `cert-${Date.now().toString(36)}`;
const nonce = challengeFile ? readFileSync(challengeFile, "utf8").trim() : null;
type Sent = { template: string; probe: "delivered" | "bounced"; deliveryId: string; status: string; error?: string };
const sentAll: Sent[] = [];
for (let part = 0, parts = 1; part < parts; part++) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const body = JSON.stringify(nonce ? { challenge: nonce, part } : { runId, part });
  if (!nonce) headers["x-crestmont-signature"] = await signEvidence(secret, body);
  const res = await fetch(`${base}/api/ops/email-certification`, { method: "POST", headers, body, signal: AbortSignal.timeout(120_000) });
  const out = await res.json().catch(() => ({})) as { error?: string; sent?: Sent[]; parts?: number };
  if (res.status !== 200 || !out.sent) { console.error(`::error title=Email certification refused::part ${part}: HTTP ${res.status}: ${out.error ?? "no reason given"}`); process.exit(1); }
  parts = out.parts ?? 1;
  sentAll.push(...out.sent);
  console.log(`part ${part + 1}/${parts}: ${out.sent.map((x) => `${x.template}=${x.status}`).join(", ")}`);
}
const out = { sent: sentAll };
console.log(`Run ${runId} on ${envLabel}: ${out.sent.length} messages handed to the email adapter.`);

const source = process.env.D1_DATABASE ? d1Source(process.env.D1_DATABASE, process.env.D1_ENV ?? "production") : signedSource(base, secret);
const states = await follow(out.sent.filter((s) => s.deliveryId).map((s) => ({ id: s.deliveryId, probe: s.probe })), source, { log: console.log });
const ok = (probe: string, s?: { status: string; accepted: boolean }) => !!s && s.accepted && (probe === "bounced" ? s.status === "bounced" : s.status === "delivered");
const lines = ["| Template | Probe | Resend accepted | Delivery result | Webhook events | Result |", "|---|---|---|---|---|---|",
  ...out.sent.map((x) => { const s = states.get(x.deliveryId); const err = s?.error || x.error || ""; return `| ${x.template} | ${x.probe} | ${s?.accepted ? "yes" : "no"} | ${s?.status ?? x.status} | ${s?.events.join(" → ") || "none"} | ${ok(x.probe, s) ? "PASS" : `FAIL${err ? ` (${err.slice(0, 80).replace(/\|/g, "/")})` : ""}`} |`; })];
const passed = out.sent.filter((x) => ok(x.probe, states.get(x.deliveryId))).length;
const summary = `${passed}/${out.sent.length} email delivery checks passed on ${envLabel} (run ${runId})`;
console.log(lines.join("\n"));
console.log(`\n${summary}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Email delivery certification — ${envLabel}\n\n${lines.join("\n")}\n\n${summary}\n`);
console.log(`::${passed === out.sent.length ? "notice" : "error"} title=Email delivery certification::${summary}`);
process.exit(passed === out.sent.length ? 0 : 1);
