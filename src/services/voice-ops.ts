// Owner reporting and caller privacy for the AI receptionist (VOICE-005, VOICE-006, SEC-006).
import { eraseIdentityData } from "./identity-erasure.ts";
import { salesOptErasureStatements } from "./sales-opt-erasure.ts";
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";
import { toE164 } from "./voice-settings.ts";

export interface VoiceAnalytics {
  since: string;
  inbound: number; outbound: number; answered: number; missed: number; failed: number;
  totalDurationSeconds: number; averageDurationSeconds: number | null; durationUnknown: number;
  leadsCaptured: number; leadsConverted: number; consultationsBooked: number; supportTickets: number; escalations: number;
  transferFailures: number; outboundPending: number; outboundCompleted: number; outboundNoAnswer: number;
  /** Sum of provider-reported costs (micro-USD). Calls without a reported cost are counted, never priced. */
  costKnownMicroUsd: number; costUnknownCalls: number; testCallsExcluded: number;
}

/** Real (non-test) call metrics since `since`. Each call row is counted once however often Retell retried. */
export async function voiceAnalytics(db: Db, since: Date): Promise<VoiceAnalytics> {
  const s = since.toISOString();
  const c = (await db.prepare(`SELECT
      SUM(CASE WHEN is_test = 0 AND direction = 'inbound' THEN 1 ELSE 0 END) AS inbound,
      SUM(CASE WHEN is_test = 0 AND direction = 'outbound' THEN 1 ELSE 0 END) AS outbound,
      SUM(CASE WHEN is_test = 0 AND ended_at IS NOT NULL AND COALESCE(outcome,'') NOT IN ('abandoned','error')
               AND COALESCE(disconnection_reason,'') NOT IN ('dial_no_answer','dial_busy','dial_failed','voicemail_reached','invalid_destination','user_declined') THEN 1 ELSE 0 END) AS answered,
      SUM(CASE WHEN is_test = 0 AND direction = 'inbound' AND outcome = 'abandoned' THEN 1 ELSE 0 END) AS missed,
      SUM(CASE WHEN is_test = 0 AND (outcome = 'error' OR error IS NOT NULL) THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN is_test = 0 AND duration_ms IS NOT NULL THEN duration_ms ELSE 0 END) AS dur_ms,
      SUM(CASE WHEN is_test = 0 AND duration_ms IS NOT NULL THEN 1 ELSE 0 END) AS dur_n,
      SUM(CASE WHEN is_test = 0 AND ended_at IS NOT NULL AND duration_ms IS NULL THEN 1 ELSE 0 END) AS dur_unknown,
      SUM(CASE WHEN is_test = 0 AND lead_id IS NOT NULL THEN 1 ELSE 0 END) AS leads,
      SUM(CASE WHEN is_test = 0 AND outcome = 'support_routed' THEN 1 ELSE 0 END) AS tickets,
      SUM(CASE WHEN is_test = 0 AND escalated_at IS NOT NULL THEN 1 ELSE 0 END) AS escalations,
      SUM(CASE WHEN is_test = 0 AND cost_microusd IS NOT NULL THEN cost_microusd ELSE 0 END) AS cost,
      SUM(CASE WHEN is_test = 0 AND ended_at IS NOT NULL AND cost_microusd IS NULL THEN 1 ELSE 0 END) AS cost_unknown,
      SUM(CASE WHEN is_test = 1 THEN 1 ELSE 0 END) AS tests
    FROM calls WHERE started_at >= ?`).bind(s).first<Record<string, number | null>>()) ?? {};
  const n = (k: string) => Number(c[k] ?? 0);
  const one = async (sql: string) => Number((await db.prepare(sql).bind(s).first<{ n: number }>())?.n ?? 0);
  const converted = await one(`SELECT COUNT(DISTINCT l.id) AS n FROM calls k JOIN leads l ON l.id = k.lead_id WHERE k.is_test = 0 AND k.started_at >= ? AND l.stage IN ('accepted','awaiting_payment','converted')`);
  const consultations = await one(`SELECT COUNT(*) AS n FROM consultations WHERE source = 'ai_receptionist' AND is_test = 0 AND created_at >= ?`);
  const transferFailures = await one(`SELECT COUNT(*) AS n FROM voice_events e JOIN calls k ON k.id = e.call_id WHERE e.kind = 'transfer_cancelled' AND k.is_test = 0 AND e.created_at >= ?`);
  const ob = (await db.prepare(`SELECT
      SUM(CASE WHEN status IN ('pending_approval','approved','dialing') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'no_answer' THEN 1 ELSE 0 END) AS no_answer
    FROM voice_outbound_requests WHERE is_test = 0 AND created_at >= ?`).bind(s).first<Record<string, number | null>>()) ?? {};
  return {
    since: s, inbound: n("inbound"), outbound: n("outbound"), answered: n("answered"), missed: n("missed"), failed: n("failed"),
    totalDurationSeconds: Math.round(n("dur_ms") / 1000), averageDurationSeconds: n("dur_n") ? Math.round(n("dur_ms") / n("dur_n") / 1000) : null, durationUnknown: n("dur_unknown"),
    leadsCaptured: n("leads"), leadsConverted: converted, consultationsBooked: consultations, supportTickets: n("tickets"), escalations: n("escalations"),
    transferFailures, outboundPending: Number(ob.pending ?? 0), outboundCompleted: Number(ob.completed ?? 0), outboundNoAnswer: Number(ob.no_answer ?? 0),
    costKnownMicroUsd: n("cost"), costUnknownCalls: n("cost_unknown"), testCallsExcluded: n("tests"),
  };
}

const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

/**
 * Erases receptionist data about one phone number for a caller who is not an account holder (account
 * holders use the existing privacy request flow). Clears transcripts, recordings, summaries and the number
 * on calls; anonymises consultations and contacts the receptionist created; deletes call consents and
 * outbound requests; scrubs receptionist-written lead text, CRM notes and notifications about them. The
 * do-not-call entry is KEPT (without its note): honouring an opt-out requires remembering the number. Call
 * outcomes, timings and costs remain for reporting, and outbound calls keep the dialled number so per-number
 * call limits still apply.
 */
export async function eraseCallerData(db: Db, staffUserId: string, phoneRaw: string, note: string, opts: { blockReimport?: boolean } = {}): Promise<Record<string, number>> {
  const phone = toE164(phoneRaw);
  if (!phone) throw Object.assign(new Error("Enter the caller's number in a dialable format (e.g. +15551234567)"), { status: 422 });
  if (note.trim().length < 5) throw Object.assign(new Error("Describe the request (who asked, and how)"), { status: 422 });
  const d = digits(phone);
  // Number matching in SQL (no full-table reads): strip common separators, compare 10-digit forms.
  const norm = (col: string) => `(CASE WHEN length(x) = 11 AND substr(x,1,1) = '1' THEN substr(x,2) ELSE x END)`.replace(/x/g,
    `replace(replace(replace(replace(replace(replace(COALESCE(${col},''),' ',''),'-',''),'(',''),')',''),'.',''),'+','')`);
  const ids = async (sql: string) => (await db.prepare(sql).bind(d).all<{ id: string }>()).results.map((r) => r.id);
  const callIds = await ids(`SELECT id FROM calls WHERE ${norm("CASE WHEN direction = 'outbound' THEN to_number ELSE from_number END")} = ?`);
  const consultationIds = await ids(`SELECT id FROM consultations WHERE ${norm("phone")} = ?`);
  const contactIds = await ids(`SELECT c.id FROM contacts c JOIN leads l ON l.contact_id = c.id WHERE l.source = 'ai_receptionist' AND c.user_id IS NULL AND ${norm("c.phone")} = ?`);
  const outboundIds = (await db.prepare(`SELECT id FROM voice_outbound_requests WHERE phone_e164 = ?`).bind(phone).all<{ id: string }>()).results.map((r) => r.id);
  const leadIds = [...new Set([
    ...(contactIds.length ? (await db.prepare(`SELECT id FROM leads WHERE contact_id IN (${contactIds.map(() => "?").join(",")})`).bind(...contactIds).all<{ id: string }>()).results.map((r) => r.id) : []),
    ...(callIds.length ? (await db.prepare(`SELECT lead_id AS id FROM calls WHERE lead_id IS NOT NULL AND id IN (${callIds.map(() => "?").join(",")})`).bind(...callIds).all<{ id: string }>()).results.map((r) => r.id) : []),
  ])];
  // CRM identity data for this number (research-created prospects, held research candidates, review/field history,
  // identities; customers and businesses that share the number are kept). Idempotent, so a failure below is retryable.
  const crm = await eraseIdentityData(db, staffUserId, { phones: [phone], contactIds, blockReimport: opts.blockReimport ?? true }, { action: "voice.caller_crm_identity_erased" });
  const at = nowIso();
  const inList = (n: number) => Array.from({ length: n }, () => "?").join(",");
  const subjects = [...callIds, ...consultationIds, ...outboundIds];
  const stmts = [
    // Call outcome, timing, cost and the counted number stay (per-number outbound caps and the DNC list need it
    // for outbound calls); transcripts, recordings, summaries and the caller's inbound number go.
    ...callIds.map((id) => db.prepare(`UPDATE calls SET transcript = NULL, recording_url = NULL, summary = NULL,
        from_number = CASE WHEN direction = 'inbound' THEN NULL ELSE from_number END WHERE id = ?`).bind(id)),
    ...consultationIds.map((id) => db.prepare(`UPDATE consultations SET name = 'Deleted contact', phone = NULL, email = NULL, topic = NULL, updated_at = ? WHERE id = ?`).bind(at, id)),
    ...contactIds.map((id) => db.prepare(`UPDATE contacts SET name = 'Deleted contact', email = NULL, phone = NULL WHERE id = ?`).bind(id)),
    // Receptionist-written CRM text quotes names and numbers: replace it on this caller's receptionist leads.
    ...leadIds.map((id) => db.prepare(`UPDATE leads SET message = 'Details erased at the caller''s request' WHERE id = ? AND source = 'ai_receptionist'`).bind(id)),
    ...leadIds.map((id) => db.prepare(`UPDATE crm_activities SET body = 'Details erased at the caller''s request' WHERE lead_id = ? AND kind IN ('call','task') AND lead_id IN (SELECT id FROM leads WHERE source = 'ai_receptionist')`).bind(id)),
    ...(subjects.length ? [db.prepare(`DELETE FROM notifications WHERE subject_id IN (${inList(subjects.length)})`).bind(...subjects)] : []),
    // Sales-analysis text derived from these calls (quotes, labels, queued model inputs, proposal evidence copies).
    ...(await salesOptErasureStatements(db, callIds)).stmts,
    db.prepare(`UPDATE voice_dnc SET detail = NULL WHERE phone_e164 = ?`).bind(phone),
    // Order matters: detach outbound requests from consents before deleting them.
    db.prepare(`UPDATE voice_outbound_requests SET consent_id = NULL WHERE phone_e164 = ? OR consent_id IN (SELECT id FROM voice_call_consents WHERE phone_e164 = ?)`).bind(phone, phone),
    db.prepare(`DELETE FROM voice_outbound_requests WHERE phone_e164 = ?`).bind(phone),
    db.prepare(`DELETE FROM voice_call_consents WHERE phone_e164 = ?`).bind(phone),
  ];
  await db.batch(stmts);
  // CRM identity counts are in their own audit entry (voice.caller_crm_identity_erased).
  const counts = { calls: callIds.length, consultations: consultationIds.length, contacts: Math.max(contactIds.length, crm.contacts) };
  // Only the last four digits are logged; the number itself is the data being erased.
  await audit(db, { actorUserId: staffUserId, action: "voice.caller_data_erased", subjectType: "phone", subjectId: `…${phone.slice(-4)}`, details: { ...counts, note: note.trim().slice(0, 300) } });
  return counts;
}
