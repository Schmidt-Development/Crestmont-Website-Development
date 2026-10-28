// Owner reporting and caller privacy for the AI receptionist (VOICE-005, VOICE-006, SEC-006).
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

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

/**
 * Erases receptionist data about one phone number for a caller who is not an account holder (account
 * holders use the existing privacy request flow). Clears transcripts, recordings, summaries and the number
 * on calls; anonymises consultations and contacts the receptionist created; deletes call consents and
 * finished outbound requests and cancels pending ones. The do-not-call entry is KEPT: honouring an opt-out
 * requires remembering the number. Call outcomes, timings and costs remain for reporting.
 */
export async function eraseCallerData(db: Db, staffUserId: string, phoneRaw: string, note: string): Promise<Record<string, number>> {
  const phone = toE164(phoneRaw);
  if (!phone) throw Object.assign(new Error("Enter the caller's number in a dialable format (e.g. +15551234567)"), { status: 422 });
  if (note.trim().length < 5) throw Object.assign(new Error("Describe the request (who asked, and how)"), { status: 422 });
  const d = digits(phone);
  const callIds = (await db.prepare(`SELECT id, from_number, to_number, direction FROM calls WHERE from_number IS NOT NULL OR to_number IS NOT NULL`).all<{ id: string; from_number: string | null; to_number: string | null; direction: string }>()).results
    .filter((c) => digits(c.direction === "outbound" ? c.to_number : c.from_number) === d).map((c) => c.id);
  const consultationIds = (await db.prepare(`SELECT id, phone FROM consultations WHERE phone IS NOT NULL`).all<{ id: string; phone: string }>()).results.filter((r) => digits(r.phone) === d).map((r) => r.id);
  const contactIds = (await db.prepare(`SELECT c.id, c.phone FROM contacts c JOIN leads l ON l.contact_id = c.id WHERE l.source = 'ai_receptionist' AND c.user_id IS NULL AND c.phone IS NOT NULL`).all<{ id: string; phone: string }>()).results
    .filter((r) => digits(r.phone) === d).map((r) => r.id);
  const at = nowIso();
  const stmts = [
    ...callIds.map((id) => db.prepare(`UPDATE calls SET transcript = NULL, recording_url = NULL, summary = NULL,
        from_number = CASE WHEN direction = 'inbound' THEN NULL ELSE from_number END, to_number = CASE WHEN direction = 'outbound' THEN NULL ELSE to_number END WHERE id = ?`).bind(id)),
    ...consultationIds.map((id) => db.prepare(`UPDATE consultations SET name = 'Deleted contact', phone = NULL, email = NULL, topic = NULL, updated_at = ? WHERE id = ?`).bind(at, id)),
    ...contactIds.map((id) => db.prepare(`UPDATE contacts SET name = 'Deleted contact', email = NULL, phone = NULL WHERE id = ?`).bind(id)),
    // Order matters: detach outbound requests from consents and consultations before deleting what they reference.
    db.prepare(`UPDATE voice_outbound_requests SET status = 'cancelled', status_detail = 'Caller data erased', updated_at = ? WHERE phone_e164 = ? AND status IN ('pending_approval','approved')`).bind(at, phone),
    db.prepare(`UPDATE voice_outbound_requests SET consent_id = NULL WHERE phone_e164 = ? OR consent_id IN (SELECT id FROM voice_call_consents WHERE phone_e164 = ?)`).bind(phone, phone),
    db.prepare(`DELETE FROM voice_outbound_requests WHERE phone_e164 = ? AND status NOT IN ('dialing')`).bind(phone),
    db.prepare(`DELETE FROM voice_call_consents WHERE phone_e164 = ?`).bind(phone),
  ];
  await db.batch(stmts);
  const counts = { calls: callIds.length, consultations: consultationIds.length, contacts: contactIds.length };
  // Only the last four digits are logged; the number itself is the data being erased.
  await audit(db, { actorUserId: staffUserId, action: "voice.caller_data_erased", subjectType: "phone", subjectId: `…${phone.slice(-4)}`, details: { ...counts, note: note.trim().slice(0, 300) } });
  return counts;
}
