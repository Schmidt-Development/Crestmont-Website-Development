// Sends the one-time first-Owner invitation on a deployed environment (src/services/owner-bootstrap.ts) and follows its
// delivery. Prints no address, token or link: the link exists only in the email.
// Auth: CHALLENGE_FILE (a one-time challenge written to the environment's D1 by the workflow; production) or
// EVIDENCE_INGEST_SECRET + FOUNDER_EMAIL (signed; staging). Status: D1 (D1_DATABASE + D1_ENV) or the signed endpoint.
import { readFileSync, appendFileSync } from "node:fs";
import { signEvidence } from "../src/readiness/ingest.ts";
import { follow, d1Source, signedSource } from "./delivery-follow.ts";

const base = process.env.BASE?.replace(/\/+$/, "") ?? "";
if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(base)) { console.error("::error::BASE must be a bare https origin"); process.exit(2); }
const challengeFile = process.env.CHALLENGE_FILE;
const secret = process.env.EVIDENCE_INGEST_SECRET ?? "";
let body: string, headers: Record<string, string> = { "content-type": "application/json" };
if (challengeFile) body = JSON.stringify({ challenge: readFileSync(challengeFile, "utf8").trim() });
else {
  const email = process.env.FOUNDER_EMAIL?.trim();
  if (!email || !secret) { console.error("::error title=FOUNDER_EMAIL not set::Add the Founder's sign-in address as the secret FOUNDER_EMAIL on the GitHub environment, then run this again."); process.exit(2); }
  body = JSON.stringify({ email });
  headers["x-crestmont-signature"] = await signEvidence(secret, body);
}
const res = await fetch(`${base}/api/ops/owner-invitation`, { method: "POST", headers, body, signal: AbortSignal.timeout(30_000) });
const out = await res.json().catch(() => ({})) as { error?: string; invitationId?: string; expiresAt?: string; delivery?: { id: string; status: string } };
if (res.status !== 200) { console.error(`::error title=Owner invitation refused::HTTP ${res.status}: ${out.error ?? "no reason given"}`); process.exit(1); }
console.log(`Owner invitation ${out.invitationId} created (valid until ${out.expiresAt}). Email ${out.delivery!.id}: ${out.delivery!.status} (sent = accepted by Resend).`);

const source = process.env.D1_DATABASE ? d1Source(process.env.D1_DATABASE, process.env.D1_ENV ?? "production") : signedSource(base, secret);
const states = await follow([{ id: out.delivery!.id, probe: "delivered" }], source, { rounds: 18, intervalMs: 10_000, log: console.log });
const s = states.get(out.delivery!.id);
const line = `Resend accepted: ${s?.accepted ? "yes" : "no"}; status: ${s?.status ?? out.delivery!.status}; webhook events: ${s?.events.join(" → ") || "none yet"}${s?.error ? `; error: ${s.error}` : ""}`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### First Owner invitation\n\n- invitation ${out.invitationId}, valid until ${out.expiresAt}\n- email ${out.delivery!.id}: ${line}\n`);
if (s?.status === "delivered") { console.log("::notice title=Owner invitation delivered::Resend reports the invitation delivered. Open it, accept, and choose a password (valid 72 hours)."); process.exit(0); }
if (s && ["bounced", "failed", "suppressed"].includes(s.status)) { console.error(`::error title=Owner invitation not delivered::${line}`); process.exit(1); }
console.log(`::warning title=Delivery not confirmed yet::${line}. Check the inbox and spam folder; the delivery webhook may still arrive.`);
