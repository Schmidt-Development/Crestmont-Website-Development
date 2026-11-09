// Sends the one-time first-Owner invitation on a deployed environment (src/services/owner-bootstrap.ts) and follows its
// delivery: Resend's acceptance, then the delivery webhook. Prints no address, token or link: the link exists only in the
// email. Run by production-owner-invitation.yml after the Founder approves the production environment.
//
// Env: BASE (https origin), EVIDENCE_INGEST_SECRET, FOUNDER_EMAIL.   node --no-warnings scripts/owner-invitation.ts
import { signEvidence } from "../src/readiness/ingest.ts";

const base = process.env.BASE?.replace(/\/+$/, "") ?? "";
const secret = process.env.EVIDENCE_INGEST_SECRET ?? "";
const email = process.env.FOUNDER_EMAIL?.trim() ?? "";
if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(base)) { console.error("::error::BASE must be a bare https origin"); process.exit(2); }
if (!secret) { console.error("::error::EVIDENCE_INGEST_SECRET is not available to this job"); process.exit(2); }
if (!email) { console.error("::error title=FOUNDER_EMAIL not set::Add the Founder's sign-in address as the secret FOUNDER_EMAIL on the GitHub 'production' environment (Settings → Environments → production → Environment secrets), then run this again."); process.exit(2); }

const body = JSON.stringify({ email });
const res = await fetch(`${base}/api/ops/owner-invitation`, { method: "POST", headers: { "content-type": "application/json", "x-crestmont-signature": await signEvidence(secret, body) }, body, signal: AbortSignal.timeout(30_000) });
const out = await res.json().catch(() => ({})) as { error?: string; invitationId?: string; expiresAt?: string; delivery?: { id: string; status: string } };
if (res.status !== 200) { console.error(`::error title=Owner invitation refused::HTTP ${res.status}: ${out.error ?? "no reason given"}`); process.exit(1); }
console.log(`Owner invitation ${out.invitationId} created (valid until ${out.expiresAt}). Email ${out.delivery!.id}: ${out.delivery!.status}.`);
if (out.delivery!.status !== "sent") { console.error(`::error title=Invitation email not accepted by Resend::delivery status "${out.delivery!.status}"; see the delivery check below and /staff/email once signed in`); }

// Follow the delivery: "sent" = Resend accepted it; the signed Resend webhook then records delivered / bounced.
const statusUrl = new URL(`${base}/api/ops/email-deliveries/${out.delivery!.id}`);
let last = "";
for (let i = 0; i < 18; i++) {
  const r = await fetch(statusUrl, { headers: { "x-crestmont-signature": await signEvidence(secret, `GET ${statusUrl.pathname}${statusUrl.search}`) }, signal: AbortSignal.timeout(20_000) });
  const d = await r.json().catch(() => ({})) as { status?: string; acceptedByResend?: boolean; events?: { type: string }[]; lastError?: string | null };
  last = `status ${d.status}; accepted by Resend: ${d.acceptedByResend}; webhook events: ${(d.events ?? []).map((e) => e.type).join(", ") || "none yet"}${d.lastError ? `; error: ${d.lastError}` : ""}`;
  console.log(`  ${new Date().toISOString()} ${last}`);
  if (d.status === "delivered") { console.log(`::notice title=Owner invitation delivered::Resend reports the invitation email delivered. Open it, accept the invitation and choose a password (valid 72 hours).`); process.exit(0); }
  if (d.status === "bounced" || d.status === "failed" || d.status === "suppressed") { console.error(`::error title=Owner invitation not delivered::${last}`); process.exit(1); }
  await new Promise((r) => setTimeout(r, 10_000));
}
console.log(`::warning title=Delivery not confirmed yet::${last}. Resend accepted the email but its delivery webhook has not arrived within 3 minutes; check the inbox (and spam folder).`);
