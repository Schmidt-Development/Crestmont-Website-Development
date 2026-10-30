// Outreach deduplication ledgers (VOICE-005, EMAIL-003, CRM-007).
//
// PHONE. One phone_outreach_ledger row per canonical E.164 number. Before any outbound call is released the caller
// takes a lease with reservePhone(): a single conditional UPDATE that succeeds only when the number is free (or its
// lease expired), is not on the do-not-call list, and is past its retry time. Two workers can therefore never hold the
// same number at once. The lease is released only by releasePhone() (call result, cancellation, failure) or recovered
// by recoverExpiredLeases() after it expires, so a crashed Worker cannot block a number for ever.
//
// Duplicate prevention is NOT permission to call. reservePhone() is called only AFTER voice-outbound.ts eligibility()
// passed (staff approval, unrevoked consent for the purpose, no DNC entry, calling window, caps), and it re-checks DNC
// itself inside the same statement, failing closed.
//
// EMAIL. enrollEmailCampaign() enrolls a canonical email identity in a campaign at most once (UNIQUE(identity,
// campaign)), refuses suppressed addresses, and is safe under concurrent imports. Crestmont sends no marketing email
// today (src/services/mailer.ts refuses marketing mail without an unsubscribe link); this is the gate any future
// automated sequence must use.
import type { Db } from "../lib/db.ts";
import { newId } from "../lib/db.ts";
import { emailKey, phoneKey } from "./contact-identity.ts";

export type LeaseRef = { type: "voice_outbound_request"; id: string };
export type ReserveResult =
  | { ok: true; reservationId: string; recoveredExpired: boolean }
  | { ok: false; reason: "invalid_number" | "do_not_call" | "reserved" | "retry_after"; detail: string; retryAt?: string };

const iso = (d: Date) => d.toISOString();

async function event(db: Db, phone: string, ev: string, p: { reservationId?: string | null; ref?: LeaseRef | null; purpose?: string | null; detail?: string | null }, at: string) {
  await db.prepare(`INSERT INTO phone_outreach_events (id, phone_e164, event, reservation_id, ref_type, ref_id, purpose, detail, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(newId("poe"), phone, ev, p.reservationId ?? null, p.ref?.type ?? null, p.ref?.id ?? null, p.purpose ?? null, p.detail?.slice(0, 300) ?? null, at).run();
}

/** Ensures the ledger row exists (no reservation). */
async function ensureRow(db: Db, phone: string, at: string) {
  await db.prepare(`INSERT INTO phone_outreach_ledger (phone_e164, identity_id, created_at, updated_at) VALUES (?, (SELECT id FROM contact_identities WHERE kind = 'phone' AND value_norm = ?), ?, ?)
      ON CONFLICT(phone_e164) DO UPDATE SET identity_id = COALESCE(phone_outreach_ledger.identity_id, excluded.identity_id)`).bind(phone, phone, at, at).run();
}

/**
 * Atomically reserves a number for one authorized outbound request. Re-reserving by the same request (a retry of the
 * same run) is allowed and refreshes the lease.
 */
export async function reservePhone(db: Db, raw: string, ref: LeaseRef, purpose: string, leaseMs: number, now: Date = new Date()): Promise<ReserveResult> {
  const phone = phoneKey(raw);
  if (!phone) return { ok: false, reason: "invalid_number", detail: "not a dialable E.164 number" };
  const at = iso(now), until = iso(new Date(now.getTime() + leaseMs));
  await ensureRow(db, phone, at);
  const before = await db.prepare(`SELECT reservation_id, reserved_for_id, lease_expires_at, retry_after FROM phone_outreach_ledger WHERE phone_e164 = ?`).bind(phone)
    .first<{ reservation_id: string | null; reserved_for_id: string | null; lease_expires_at: string | null; retry_after: string | null }>();
  const reservationId = newId("rsv");
  const res = await db.prepare(`UPDATE phone_outreach_ledger SET reservation_id = ?, reserved_for_type = ?, reserved_for_id = ?, reserved_purpose = ?, reserved_at = ?, lease_expires_at = ?,
        call_state = 'reserved', active_call_id = NULL, version = version + 1, updated_at = ?
      WHERE phone_e164 = ?
        AND (reservation_id IS NULL OR lease_expires_at < ? OR (reserved_for_type = ? AND reserved_for_id = ? AND call_state = 'reserved'))
        AND (retry_after IS NULL OR retry_after <= ?)
        AND NOT EXISTS (SELECT 1 FROM voice_dnc WHERE phone_e164 = ?)`)
    .bind(reservationId, ref.type, ref.id, purpose, at, until, at, phone, at, ref.type, ref.id, at, phone).run();
  if (res.meta.changes === 1) {
    const recovered = !!(before?.reservation_id && before.lease_expires_at && before.lease_expires_at < at && before.reserved_for_id !== ref.id);
    if (recovered) await event(db, phone, "expired", { reservationId: before!.reservation_id, detail: `lease expired at ${before!.lease_expires_at}; recovered by a new reservation` }, at);
    await event(db, phone, "reserved", { reservationId, ref, purpose, detail: `lease until ${until}` }, at);
    return { ok: true, reservationId, recoveredExpired: recovered };
  }
  const dnc = await db.prepare(`SELECT 1 AS x FROM voice_dnc WHERE phone_e164 = ?`).bind(phone).first();
  const row = await db.prepare(`SELECT reserved_for_id, lease_expires_at, retry_after FROM phone_outreach_ledger WHERE phone_e164 = ?`).bind(phone).first<{ reserved_for_id: string | null; lease_expires_at: string | null; retry_after: string | null }>();
  const out: ReserveResult = dnc ? { ok: false, reason: "do_not_call", detail: "number is on the do-not-call list" }
    : row?.retry_after && row.retry_after > at ? { ok: false, reason: "retry_after", detail: `retry policy: not before ${row.retry_after}`, retryAt: row.retry_after }
    : { ok: false, reason: "reserved", detail: `number is reserved by ${row?.reserved_for_id ?? "another request"} until ${row?.lease_expires_at ?? "?"}`, retryAt: row?.lease_expires_at ?? undefined };
  await event(db, phone, "denied", { ref, purpose, detail: out.detail }, at);
  return out;
}

/** Marks the reserved number as being dialled (provider call id known). Only the holder of the lease can do this. */
export async function markDialing(db: Db, raw: string, reservationId: string, callId: string, now: Date = new Date()): Promise<boolean> {
  const phone = phoneKey(raw); if (!phone) return false;
  const at = iso(now);
  const r = await db.prepare(`UPDATE phone_outreach_ledger SET call_state = 'dialing', active_call_id = ?, attempts = attempts + 1, last_attempt_at = ?, version = version + 1, updated_at = ? WHERE phone_e164 = ? AND reservation_id = ?`)
    .bind(callId, at, at, phone, reservationId).run();
  if (r.meta.changes === 1) await event(db, phone, "dialing", { reservationId, detail: `provider call ${callId}` }, at);
  return r.meta.changes === 1;
}

/**
 * Releases the lease held for `ref` (completion, cancellation, failure). `retryAfter` records the retry policy so the
 * number cannot be reserved again before then by any request.
 */
export async function releasePhone(db: Db, raw: string, ref: LeaseRef, outcome: string, opts: { retryAfter?: string | null; now?: Date } = {}): Promise<boolean> {
  const phone = phoneKey(raw); if (!phone) return false;
  const at = iso(opts.now ?? new Date());
  const held = await db.prepare(`SELECT reservation_id FROM phone_outreach_ledger WHERE phone_e164 = ? AND reserved_for_type = ? AND reserved_for_id = ?`).bind(phone, ref.type, ref.id).first<{ reservation_id: string | null }>();
  const r = await db.prepare(`UPDATE phone_outreach_ledger SET reservation_id = NULL, reserved_for_type = NULL, reserved_for_id = NULL, reserved_purpose = NULL, reserved_at = NULL, lease_expires_at = NULL,
        call_state = 'idle', active_call_id = NULL, last_outcome = ?, retry_after = COALESCE(?, retry_after), version = version + 1, updated_at = ?
      WHERE phone_e164 = ? AND reserved_for_type = ? AND reserved_for_id = ?`).bind(outcome.slice(0, 120), opts.retryAfter ?? null, at, phone, ref.type, ref.id).run();
  if (r.meta.changes === 1) await event(db, phone, "released", { reservationId: held?.reservation_id ?? null, ref, detail: outcome }, at);
  return r.meta.changes === 1;
}

/** Frees every lease past its expiry (crash recovery). Returns the numbers recovered. */
export async function recoverExpiredLeases(db: Db, now: Date = new Date()): Promise<{ phone: string; ref: string | null }[]> {
  const at = iso(now);
  const rows = (await db.prepare(`SELECT phone_e164, reservation_id, reserved_for_id FROM phone_outreach_ledger WHERE reservation_id IS NOT NULL AND lease_expires_at < ? LIMIT 200`).bind(at)
    .all<{ phone_e164: string; reservation_id: string; reserved_for_id: string | null }>()).results;
  const out: { phone: string; ref: string | null }[] = [];
  for (const r of rows) {
    const u = await db.prepare(`UPDATE phone_outreach_ledger SET reservation_id = NULL, reserved_for_type = NULL, reserved_for_id = NULL, reserved_purpose = NULL, reserved_at = NULL, lease_expires_at = NULL,
          call_state = 'idle', active_call_id = NULL, last_outcome = 'lease_expired', version = version + 1, updated_at = ? WHERE phone_e164 = ? AND reservation_id = ? AND lease_expires_at < ?`)
      .bind(at, r.phone_e164, r.reservation_id, at).run();
    if (u.meta.changes === 1) { await event(db, r.phone_e164, "expired", { reservationId: r.reservation_id, detail: "lease expired; recovered" }, at); out.push({ phone: r.phone_e164, ref: r.reserved_for_id }); }
  }
  return out;
}

/** Records a call outcome against the number (history only; does not touch the lease). */
export async function recordPhoneOutcome(db: Db, raw: string, outcome: string, ref: LeaseRef | null, now: Date = new Date()) {
  const phone = phoneKey(raw); if (!phone) return;
  const at = iso(now);
  await ensureRow(db, phone, at);
  await db.prepare(`UPDATE phone_outreach_ledger SET last_outcome = ?, updated_at = ? WHERE phone_e164 = ?`).bind(outcome.slice(0, 120), at, phone).run();
  await event(db, phone, "outcome", { ref, detail: outcome }, at);
}

export interface PhoneLedgerStatus {
  phone: string; attempts: number; lastAttemptAt: string | null; lastOutcome: string | null; retryAfter: string | null;
  callState: string; reservedFor: string | null; reservedPurpose: string | null; leaseExpiresAt: string | null; activeCallId: string | null;
  doNotCall: boolean; consents: string[]; leads: { id: string; stage: string }[]; history: { event: string; detail: string | null; purpose: string | null; created_at: string }[];
}

/** Everything known about one number, for the CRM identity panel and the runbook. */
export async function phoneLedgerStatus(db: Db, raw: string): Promise<PhoneLedgerStatus | null> {
  const phone = phoneKey(raw); if (!phone) return null;
  const row = await db.prepare(`SELECT * FROM phone_outreach_ledger WHERE phone_e164 = ?`).bind(phone).first<Record<string, string | number | null>>();
  const dnc = !!(await db.prepare(`SELECT 1 AS x FROM voice_dnc WHERE phone_e164 = ?`).bind(phone).first());
  const consents = (await db.prepare(`SELECT purpose FROM voice_call_consents WHERE phone_e164 = ? AND revoked_at IS NULL`).bind(phone).all<{ purpose: string }>()).results.map((c) => c.purpose);
  const leads = (await db.prepare(`SELECT DISTINCT l.id, l.stage FROM contact_identities ci JOIN contact_identity_links k ON k.identity_id = ci.id AND k.removed_at IS NULL JOIN leads l ON l.contact_id = k.contact_id
      WHERE ci.kind = 'phone' AND ci.value_norm = ? AND l.merged_into_lead_id IS NULL LIMIT 20`).bind(phone).all<{ id: string; stage: string }>()).results;
  const history = (await db.prepare(`SELECT event, detail, purpose, created_at FROM phone_outreach_events WHERE phone_e164 = ? ORDER BY created_at DESC LIMIT 20`).bind(phone).all<{ event: string; detail: string | null; purpose: string | null; created_at: string }>()).results;
  return {
    phone, attempts: Number(row?.attempts ?? 0), lastAttemptAt: (row?.last_attempt_at as string) ?? null, lastOutcome: (row?.last_outcome as string) ?? null, retryAfter: (row?.retry_after as string) ?? null,
    callState: (row?.call_state as string) ?? "idle", reservedFor: (row?.reserved_for_id as string) ?? null, reservedPurpose: (row?.reserved_purpose as string) ?? null,
    leaseExpiresAt: (row?.lease_expires_at as string) ?? null, activeCallId: (row?.active_call_id as string) ?? null, doNotCall: dnc, consents, leads, history,
  };
}

// ───────────── Email ─────────────

export type EnrollResult = { status: "enrolled"; enrollmentId: string } | { status: "already_enrolled" | "suppressed" | "invalid"; detail: string };

export async function enrollEmailCampaign(db: Db, p: { email: string; campaignKey: string; leadId?: string | null; source: string; actorUserId?: string | null; now?: Date }): Promise<EnrollResult> {
  const key = emailKey(p.email);
  if (!key) return { status: "invalid", detail: "not a valid email address" };
  if (!/^[a-z0-9][a-z0-9_.:-]{1,80}$/.test(p.campaignKey)) return { status: "invalid", detail: "campaign key must be 2–81 lowercase letters, digits, _ . : -" };
  if (await db.prepare(`SELECT 1 AS x FROM email_suppressions WHERE removed_at IS NULL AND lower(email) = ?`).bind(key).first()) return { status: "suppressed", detail: "address is suppressed (bounce, complaint or unsubscribe)" };
  const at = iso(p.now ?? new Date());
  const id = newId("eoe");
  const [, res] = await db.batch([
    db.prepare(`INSERT INTO contact_identities (id, kind, value_norm, display_value, first_source, created_at, updated_at) VALUES (?, 'email', ?, ?, ?, ?, ?) ON CONFLICT(kind, value_norm) DO NOTHING`).bind(newId("cid"), key, p.email.trim(), p.source, at, at),
    db.prepare(`INSERT INTO email_outreach_enrollments (id, identity_id, campaign_key, status, lead_id, enrolled_by, source, created_at, updated_at)
        SELECT ?, id, ?, 'enrolled', ?, ?, ?, ?, ? FROM contact_identities WHERE kind = 'email' AND value_norm = ?
          AND NOT EXISTS (SELECT 1 FROM email_suppressions WHERE removed_at IS NULL AND lower(email) = ?)
        ON CONFLICT(identity_id, campaign_key) DO NOTHING`).bind(id, p.campaignKey, p.leadId ?? null, p.actorUserId ?? null, p.source, at, at, key, key),
  ]);
  if (res.meta.changes === 1) return { status: "enrolled", enrollmentId: id };
  return { status: "already_enrolled", detail: "this address is already enrolled in that campaign" };
}

