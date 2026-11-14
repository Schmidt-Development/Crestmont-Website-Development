// Who may receive the commercial sales_info email (Owner decision 2026-11-13, option a; migration 0108).
//
// Rule: sales_info goes only to an address with a recorded, recipient-originated confirmation — the prospect stated
// the address on an outbound AI sales call (source 'call_confirmed': sales call, Retell call id, time) or submitted it
// on an inbound form (source 'inbound_form': lead, channel, time). Research data (the ~36,000 publicly sourced
// contacts from the Overture / OSM / Foursquare harvest and crm-import) is "not consent to call or email" and never
// qualifies, whatever contacts.email holds. Opt-outs (sales_email_optouts) and bounce/complaint suppressions
// (email_suppressions) always win over a confirmation.
//
// Transactional templates (quote_sent, consultation, …) do not need this confirmation; they still honour opt-outs and
// suppressions (src/adapters/email.ts).
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";

export type SalesEmailConsentSource = "call_confirmed" | "inbound_form";

export interface SalesEmailConsentInput {
  email: string; source: SalesEmailConsentSource;
  /** call_confirmed: the sales call id; inbound_form: the lead id. One row per address, source and ref. */
  ref: string;
  leadId?: string | null; contactId?: string | null; salesCallId?: string | null; providerCallId?: string | null; channel?: string | null;
  evidence: string; at?: string;
}

/** Records a recipient-originated confirmation of an address. Idempotent per (email, source, ref). */
export async function recordSalesEmailConsent(db: Db, c: SalesEmailConsentInput): Promise<void> {
  const email = c.email.trim().toLowerCase();
  if (!email) return;
  await db.prepare(`INSERT INTO sales_email_consents (id, email, source, ref, lead_id, contact_id, sales_call_id, provider_call_id, channel, evidence, confirmed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(email, source, ref) DO NOTHING`)
    .bind(newId("sec"), email, c.source, c.ref, c.leadId ?? null, c.contactId ?? null, c.salesCallId ?? null, c.providerCallId ?? null, c.channel ?? null, c.evidence.slice(0, 500), c.at ?? nowIso()).run();
}

/** The earliest recorded recipient confirmation of the address, if any. */
export async function salesEmailConsent(db: Db, email: string): Promise<{ source: SalesEmailConsentSource; ref: string; confirmed_at: string } | null> {
  return (await db.prepare(`SELECT source, ref, confirmed_at FROM sales_email_consents WHERE email = ? ORDER BY confirmed_at LIMIT 1`).bind(email.trim().toLowerCase())
    .first<{ source: SalesEmailConsentSource; ref: string; confirmed_at: string }>()) ?? null;
}

export type SalesInfoRefusal = "opted_out" | "suppressed" | "recipient_not_confirmed";
export type SalesInfoEligibility = { eligible: true; source: SalesEmailConsentSource; confirmedAt: string } | { eligible: false; code: SalesInfoRefusal; reason: string };

/** Opt-out and suppression only (every sales-originated or proposal email). Null = may be mailed. */
export async function optOutOrSuppression(db: Db, emailRaw: string): Promise<{ code: "opted_out" | "suppressed"; reason: string } | null> {
  const email = emailRaw.trim().toLowerCase();
  const opt = await db.prepare(`SELECT source, created_at FROM sales_email_optouts WHERE email = ?`).bind(email).first<{ source: string; created_at: string }>();
  if (opt) return { code: "opted_out", reason: `Not sent: the recipient opted out of sales email (${opt.source.replace(/_/g, " ")}, ${opt.created_at.slice(0, 10)}).` };
  const sup = await db.prepare(`SELECT reason, created_at FROM email_suppressions WHERE email = ? AND removed_at IS NULL`).bind(email).first<{ reason: string; created_at: string }>();
  if (sup) return { code: "suppressed", reason: `Not sent: recipient suppressed (${sup.reason === "complaint" ? "spam complaint" : "hard bounce"} recorded ${sup.created_at.slice(0, 10)}).` };
  return null;
}

/** Whether sales_info may be sent to this address. Fails closed: no recorded recipient confirmation = refused. */
export async function salesInfoEligibility(db: Db, emailRaw: string): Promise<SalesInfoEligibility> {
  const blocked = await optOutOrSuppression(db, emailRaw);
  if (blocked) return { eligible: false, ...blocked };
  const consent = await salesEmailConsent(db, emailRaw);
  if (!consent) return { eligible: false, code: "recipient_not_confirmed", reason: "Not sent: sales_info requires an address the recipient confirmed themselves (stated on a sales call or submitted on an inbound form); research/import data is not consent to email." };
  return { eligible: true, source: consent.source, confirmedAt: consent.confirmed_at };
}
