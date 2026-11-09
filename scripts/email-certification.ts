// Runs the email delivery certification on a deployed environment (src/services/email-certification.ts) and follows
// every message until Resend's delivery webhook answers. Prints a matrix (template, Resend accepted, webhook result);
// never an address, subject or body. Exit 1 unless every template was delivered and the bounce probe bounced.
//
// Env: BASE (https origin), EVIDENCE_INGEST_SECRET, ENVIRONMENT_LABEL.   node --no-warnings scripts/email-certification.ts
import { appendFileSync } from "node:fs";
import { signEvidence } from "../src/readiness/ingest.ts";

const base = process.env.BASE?.replace(/\/+$/, "") ?? "";
const secret = process.env.EVIDENCE_INGEST_SECRET ?? "";
const envLabel = process.env.ENVIRONMENT_LABEL ?? "unknown";
if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(base) || !secret) { console.error("::error::BASE (https origin) and EVIDENCE_INGEST_SECRET are required"); process.exit(2); }
const runId = `cert-${Date.now().toString(36)}`;
const body = JSON.stringify({ runId });
const res = await fetch(`${base}/api/ops/email-certification`, { method: "POST", headers: { "content-type": "application/json", "x-crestmont-signature": await signEvidence(secret, body) }, body, signal: AbortSignal.timeout(120_000) });
const out = await res.json().catch(() => ({})) as { error?: string; sent?: { template: string; probe: "delivered" | "bounced"; deliveryId: string; status: string }[] };
if (res.status !== 200 || !out.sent) { console.error(`::error title=Email certification refused::HTTP ${res.status}: ${out.error ?? "no reason given"}`); process.exit(1); }
console.log(`Run ${runId} on ${envLabel}: ${out.sent.length} messages handed to the email adapter.`);

type Row = { template: string; probe: string; accepted: boolean; status: string; events: string; error: string };
const rows = new Map<string, Row>(out.sent.map((s) => [s.deliveryId, { template: s.template, probe: s.probe, accepted: false, status: s.status, events: "", error: "" }]));
const done = (r: Row) => (r.probe === "bounced" ? ["bounced", "failed", "suppressed"] : ["delivered", "bounced", "failed", "suppressed"]).includes(r.status);
for (let round = 0; round < 20 && [...rows.values()].some((r) => !done(r)); round++) {
  if (round) await new Promise((r) => setTimeout(r, 15_000));
  for (const [id, r] of rows) {
    if (done(r) || !id) continue;
    const u = new URL(`${base}/api/ops/email-deliveries/${id}`);
    const d = await fetch(u, { headers: { "x-crestmont-signature": await signEvidence(secret, `GET ${u.pathname}${u.search}`) }, signal: AbortSignal.timeout(20_000) })
      .then((x) => x.json()).catch(() => null) as { status?: string; acceptedByResend?: boolean; events?: { type: string }[]; lastError?: string | null } | null;
    if (!d) continue;
    r.status = d.status ?? r.status; r.accepted = !!d.acceptedByResend; r.events = (d.events ?? []).map((e) => e.type).join(" → "); r.error = d.lastError ?? "";
  }
}
const ok = (r: Row) => r.accepted && (r.probe === "bounced" ? r.status === "bounced" : r.status === "delivered");
const lines = ["| Template | Probe | Resend accepted | Delivery result | Webhook events | Result |", "|---|---|---|---|---|---|",
  ...[...rows.values()].map((r) => `| ${r.template} | ${r.probe} | ${r.accepted ? "yes" : "no"} | ${r.status} | ${r.events || "none"} | ${ok(r) ? "PASS" : `FAIL${r.error ? ` (${r.error.slice(0, 80)})` : ""}`} |`)];
const passed = [...rows.values()].filter(ok).length;
const summary = `${passed}/${rows.size} email delivery checks passed on ${envLabel} (run ${runId})`;
console.log(lines.join("\n"));
console.log(`\n${summary}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Email delivery certification — ${envLabel}\n\n${lines.join("\n")}\n\n${summary}\n`);
console.log(`::${passed === rows.size ? "notice" : "error"} title=Email delivery certification::${summary}`);
process.exit(passed === rows.size ? 0 : 1);
