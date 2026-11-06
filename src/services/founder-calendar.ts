// Founder Calendar ↔ Google Calendar (Founder directive 2026-11-06, priority 1).
//
// The internal Founder Calendar stays the booking record (consultations, calendar = 'founder_callback': request-only,
// exclusive, held until the Founder confirms). Google Calendar adds two things:
//   1. REAL AVAILABILITY — free/busy of the Founder's primary calendar and the dedicated calendar blocks Founder slots.
//      If Google cannot be read, no Founder time is offered at all: availability is never claimed without the check.
//   2. VISIBILITY — every Founder appointment is mirrored to "Crestmont — Founder Appointments" (stable event id per
//      appointment: retries update, never duplicate; tentative until confirmed; cancelled when cancelled), and the
//      Founder is emailed for every new, rescheduled, confirmed and cancelled appointment through the platform mailer
//      (one email per appointment and event: idempotency key). Delivery is whatever the mail provider reports.
// Connected once by the Founder (Owner) on /staff/calendars/founder-callback/google with Google's consent screen.
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import type { Env } from "../app/context.ts";
import { audit } from "./security.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { sealWithKey, openWithKey } from "../lib/totp-secrets.ts";
import { sendMail, type MailerCtx } from "./mailer.ts";
import { notifyOwners } from "./voice-common.ts";
import { slotLabel } from "./voice-settings.ts";
import type { CalendarAdapter, BusyInterval } from "./voice-scheduling.ts";
import * as G from "../adapters/google-calendar.ts";

export type FounderEvent = "booked" | "rescheduled" | "confirmed" | "cancelled";
type GEnv = Pick<Env, "GOOGLE_OAUTH_CLIENT_ID" | "GOOGLE_OAUTH_CLIENT_SECRET" | "MFA_ENCRYPTION_KEY" | "FOUNDER_EMAIL">;
const SEAL_CONTEXT = "google-calendar:founder";
export const STATE_TTL_MS = 10 * 60_000;
export const MAX_SYNC_ATTEMPTS = 8;

export class FounderCalendarError extends Error {}

export interface Connection { account_email: string; refresh_token_sealed: string; scopes: string; calendar_id: string | null; calendar_created: number; connected_by: string | null; connected_at: string; last_check_at: string | null; last_check_ok: number | null; last_check_detail: string | null }

export async function loadConnection(db: Db): Promise<Connection | null> {
  return db.prepare(`SELECT * FROM google_calendar_connection WHERE id = 1`).first<Connection>();
}

/** What is missing before the Owner can connect (shown on the page, never a secret value). */
export function setupProblems(env: GEnv): string[] {
  const p: string[] = [];
  if (!env.GOOGLE_OAUTH_CLIENT_ID) p.push("GOOGLE_OAUTH_CLIENT_ID is not set on this Worker");
  if (!env.GOOGLE_OAUTH_CLIENT_SECRET) p.push("GOOGLE_OAUTH_CLIENT_SECRET is not set on this Worker");
  if (!env.MFA_ENCRYPTION_KEY) p.push("MFA_ENCRYPTION_KEY is not set (the stored Google authorisation is encrypted with it)");
  return p;
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomB64 = (n: number) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return b64url(b); };

export async function startConnect(db: Db, env: GEnv, userId: string, redirectUri: string, loginHint: string | null, now = new Date()): Promise<string> {
  const p = setupProblems(env);
  if (p.length) throw new FounderCalendarError(p.join("; "));
  const state = randomB64(24), verifier = randomB64(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  await db.prepare(`DELETE FROM google_oauth_states WHERE expires_at < ?`).bind(now.toISOString()).run();
  await db.prepare(`INSERT INTO google_oauth_states (state, user_id, code_verifier, created_at, expires_at) VALUES (?,?,?,?,?)`)
    .bind(state, userId, verifier, now.toISOString(), new Date(now.getTime() + STATE_TTL_MS).toISOString()).run();
  return G.authorizationUrl({ clientId: env.GOOGLE_OAUTH_CLIENT_ID!, redirectUri, state, codeChallenge: challenge, loginHint });
}

/**
 * Finishes Google's consent: the state must be one this Owner started, unexpired and unused. Stores the encrypted
 * refresh token, then reuses the dedicated calendar if it already exists or creates it, then runs the live check.
 */
export async function completeConnect(db: Db, env: GEnv, f: typeof fetch, i: { userId: string; state: string; code: string; redirectUri: string; timeZone: string; expectedAccount: string | null; now?: Date }): Promise<Connection> {
  const now = i.now ?? new Date();
  const st = await db.prepare(`DELETE FROM google_oauth_states WHERE state = ? RETURNING user_id, code_verifier, expires_at`).bind(i.state).first<{ user_id: string; code_verifier: string; expires_at: string }>();
  if (!st || st.user_id !== i.userId || st.expires_at < now.toISOString()) throw new FounderCalendarError("This Google sign-in link is not valid (expired, already used or started by someone else). Start the connection again.");
  const t = await G.exchangeCode(f, { clientId: env.GOOGLE_OAUTH_CLIENT_ID!, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET!, redirectUri: i.redirectUri, code: i.code, codeVerifier: st.code_verifier });
  const missing = G.GOOGLE_SCOPES.filter((s) => s.startsWith("https://") && !t.scope.split(/\s+/).includes(s));
  if (missing.length) throw new FounderCalendarError(`Google did not grant every permission the Founder Calendar needs (${missing.map((m) => m.split("/").pop()).join(", ")}). Connect again and allow all of them.`);
  if (!t.refreshToken) throw new FounderCalendarError("Google returned no long-lived authorisation. Remove Crestmont's access in your Google account's security settings, then connect again.");
  if (!t.email) throw new FounderCalendarError("Google did not confirm which account was connected (verified email). Connect again.");
  if (i.expectedAccount && t.email !== i.expectedAccount.toLowerCase()) {
    await G.revoke(f, t.refreshToken);
    throw new FounderCalendarError(`The Google account ${t.email} was connected, but the Founder Calendar must belong to ${i.expectedAccount}. Sign in with that account and connect again.`);
  }
  // Reuse a dedicated calendar if one already exists in the account, otherwise create it (never a duplicate).
  const existing = await G.findCalendarByName(f, t.accessToken, G.FOUNDER_CALENDAR_NAME);
  const calendarId = existing && existing.accessRole === "owner" ? existing.id : await G.createCalendar(f, t.accessToken, G.FOUNDER_CALENDAR_NAME, i.timeZone);
  const sealed = await sealWithKey(env.MFA_ENCRYPTION_KEY!, SEAL_CONTEXT, t.refreshToken);
  await db.prepare(`INSERT INTO google_calendar_connection (id, account_email, refresh_token_sealed, scopes, calendar_id, calendar_created, connected_by, connected_at) VALUES (1,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET account_email = excluded.account_email, refresh_token_sealed = excluded.refresh_token_sealed, scopes = excluded.scopes, calendar_id = excluded.calendar_id,
        calendar_created = excluded.calendar_created, connected_by = excluded.connected_by, connected_at = excluded.connected_at, last_check_at = NULL, last_check_ok = NULL, last_check_detail = NULL`)
    .bind(t.email, sealed, t.scope, calendarId, existing && existing.accessRole === "owner" ? 0 : 1, i.userId, now.toISOString()).run();
  await audit(db, { actorUserId: i.userId, action: "founder_calendar.connected", subjectType: "google_calendar", subjectId: calendarId, details: { account: t.email, reused: !!(existing && existing.accessRole === "owner") } });
  await checkConnection(db, env, f, now);
  // Appointments booked before the connection get their Google events now.
  await db.prepare(`UPDATE consultations SET google_sync_status = 'pending' WHERE calendar = 'founder_callback' AND status IN ('requested','confirmed') AND (google_sync_status IS NULL OR google_sync_status = 'not_connected')`).run();
  return (await loadConnection(db))!;
}

export async function disconnect(db: Db, env: GEnv, f: typeof fetch, userId: string): Promise<void> {
  const c = await loadConnection(db);
  if (c) {
    try { if (env.MFA_ENCRYPTION_KEY) await G.revoke(f, await openWithKey(env.MFA_ENCRYPTION_KEY, SEAL_CONTEXT, c.refresh_token_sealed)); } catch { /* revoke is best effort */ }
    await db.prepare(`DELETE FROM google_calendar_connection WHERE id = 1`).run();
  }
  await audit(db, { actorUserId: userId, action: "founder_calendar.disconnected", subjectType: "google_calendar", subjectId: c?.calendar_id ?? "none", details: { account: c?.account_email ?? null, wasConnected: !!c } });
}

async function accessToken(db: Db, env: GEnv, f: typeof fetch, c: Connection): Promise<string> {
  if (setupProblems(env).length) throw new G.GoogleCalendarError(setupProblems(env).join("; "));
  const refresh = await openWithKey(env.MFA_ENCRYPTION_KEY!, SEAL_CONTEXT, c.refresh_token_sealed);
  return G.refreshAccessToken(f, { clientId: env.GOOGLE_OAUTH_CLIENT_ID!, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET!, refreshToken: refresh });
}

/** The live check: the calendar exists and free/busy works for both calendars. Records the result for the page. */
export async function checkConnection(db: Db, env: GEnv, f: typeof fetch, now = new Date()): Promise<{ ok: boolean; detail: string }> {
  const c = await loadConnection(db);
  if (!c) return { ok: false, detail: "Not connected" };
  let ok = false, detail: string;
  try {
    const token = await accessToken(db, env, f, c);
    const cal = c.calendar_id ? await G.getCalendar(f, token, c.calendar_id) : null;
    if (!cal) throw new G.GoogleCalendarError("The dedicated calendar no longer exists in the Google account; connect again to recreate it");
    const busy = await G.freeBusy(f, token, ["primary", cal.id], now.getTime(), now.getTime() + 7 * 86_400_000);
    ok = true;
    detail = `Calendar "${cal.summary ?? G.FOUNDER_CALENDAR_NAME}" (${cal.timeZone ?? "time zone ?"}) readable; free/busy OK: ${busy.length} busy interval(s) in the next 7 days`;
  } catch (e) { detail = (e as Error).message.slice(0, 300); }
  await db.prepare(`UPDATE google_calendar_connection SET last_check_at = ?, last_check_ok = ?, last_check_detail = ? WHERE id = 1`).bind(now.toISOString(), ok ? 1 : 0, detail).run();
  return { ok, detail };
}

/** Busy times for Founder availability. connected=false when no connection exists; busy() THROWS when Google fails. */
export async function founderAdapter(db: Db, env: GEnv, f: typeof fetch): Promise<CalendarAdapter> {
  const c = await loadConnection(db);
  if (!c || !c.calendar_id) return { kind: "none", connected: false, busy: async () => [] };
  let token: string | null = null;
  return {
    kind: "google", connected: true,
    async busy(fromMs: number, toMs: number): Promise<BusyInterval[]> {
      token ??= await accessToken(db, env, f, c);
      return G.freeBusy(f, token, ["primary", c.calendar_id!], fromMs, toMs);
    },
  };
}

// ───────────── Mirroring and notifications ─────────────

export interface FounderDeps { db: Db; env: GEnv; fetch: typeof fetch; mail?: MailerCtx; baseUrl?: string }

interface Appt { id: string; lead_id: string | null; name: string; phone: string | null; email: string | null; starts_at: string; duration_minutes: number; timezone: string; status: string; topic: string | null; calendar: string; is_test: number; confirmation_code: string; rescheduled_from: string | null; google_sync_attempts: number }

export const googleEventId = async (consultationId: string) => `crestmont${(await sha256Hex(consultationId)).slice(0, 32)}`;

async function context(db: Db, a: Appt) {
  const lead = a.lead_id ? await db.prepare(`SELECT l.interest, l.message, co.name AS company FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN companies co ON co.id = c.company_id WHERE l.id = ?`).bind(a.lead_id)
    .first<{ interest: string | null; message: string | null; company: string | null }>() : null;
  const note = a.lead_id ? await db.prepare(`SELECT body FROM crm_activities WHERE lead_id = ? AND kind IN ('note','call') ORDER BY created_at DESC LIMIT 1`).bind(a.lead_id).first<{ body: string }>() : null;
  return { business: lead?.company ?? null, salesContext: [lead?.interest ? `Interest: ${lead.interest}` : null, (note?.body ?? lead?.message ?? "").replace(/\s+/g, " ").slice(0, 400) || null].filter(Boolean).join(" · ") || null };
}

/**
 * Brings Google in line with one Founder appointment and emails the Founder about `event`. Never throws to the caller:
 * a Google failure marks the appointment 'failed' for the scheduled retry and alerts the Owner; the booking stands.
 */
export async function founderAppointmentChanged(d: FounderDeps, consultationId: string, event: FounderEvent): Promise<void> {
  const a = await d.db.prepare(`SELECT * FROM consultations WHERE id = ?`).bind(consultationId).first<Appt>();
  if (!a || a.calendar !== "founder_callback") return;
  const c = await loadConnection(d.db);
  await syncOne(d, a, c);
  // The Founder's email (connected account; FOUNDER_EMAIL until connected). Same appointment + event = one email.
  const to = c?.account_email ?? d.env.FOUNDER_EMAIL ?? null;
  if (!to || !d.mail) return;
  const ctx = await context(d.db, a);
  try {
    await sendMail(d.mail, { template: "founder_appointment", to, idempotencyKey: `founder-appt:${a.id}:${event}`, data: {
      event, prospect: a.name, business: ctx.business, when: slotLabel(a.starts_at, a.timezone), timeZone: a.timezone, durationMinutes: a.duration_minutes,
      contact: [a.phone, a.email].filter(Boolean).join(" · ") || "—", reason: a.topic ?? "—", salesContext: ctx.salesContext, status: a.status, reference: a.confirmation_code,
      crmUrl: a.lead_id && d.baseUrl ? `${d.baseUrl.replace(/\/$/, "")}/staff/crm/leads/${a.lead_id}` : null, test: !!a.is_test,
    } });
  } catch { /* the delivery log records provider failures */ }
}

async function syncOne(d: FounderDeps, a: Appt, c: Connection | null): Promise<void> {
  if (!c || !c.calendar_id) { await d.db.prepare(`UPDATE consultations SET google_sync_status = 'not_connected' WHERE id = ?`).bind(a.id).run(); return; }
  const at = nowIso();
  try {
    const token = await accessToken(d.db, d.env, d.fetch, c);
    const id = await googleEventId(a.id);
    const ctx = await context(d.db, a);
    const status = a.status === "confirmed" ? "confirmed" : a.status === "requested" ? "tentative" : "cancelled";
    const start = new Date(Date.parse(a.starts_at)), end = new Date(start.getTime() + a.duration_minutes * 60_000);
    await G.upsertEvent(d.fetch, token, c.calendar_id, { id, status, timeZone: a.timezone, start: start.toISOString(), end: end.toISOString(),
      summary: `${a.is_test ? "[TEST] " : ""}${status === "tentative" ? "Requested: " : ""}${a.name}${ctx.business ? ` (${ctx.business})` : ""} — Crestmont`,
      description: [`Appointment requested with the Founder (ref ${a.confirmation_code}).`, `Contact: ${[a.phone, a.email].filter(Boolean).join(" · ") || "—"}`, `Reason: ${a.topic ?? "—"}`,
        ctx.salesContext ? `Context: ${ctx.salesContext}` : null, a.lead_id && d.baseUrl ? `CRM: ${d.baseUrl.replace(/\/$/, "")}/staff/crm/leads/${a.lead_id}` : null,
        status === "tentative" ? "Confirm or decline it on /staff/voice/operations." : null].filter(Boolean).join("\n") });
    // A rescheduled appointment's predecessor is cancelled on Google too (its own stable id).
    if (a.rescheduled_from) {
      const prev = await d.db.prepare(`SELECT * FROM consultations WHERE id = ?`).bind(a.rescheduled_from).first<Appt>();
      if (prev) await syncOne(d, prev, c);
    }
    await d.db.prepare(`UPDATE consultations SET google_event_id = ?, google_sync_status = 'synced', google_sync_error = NULL, google_synced_at = ?, google_sync_attempts = google_sync_attempts + 1 WHERE id = ?`).bind(id, at, a.id).run();
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await d.db.prepare(`UPDATE consultations SET google_sync_status = 'failed', google_sync_error = ?, google_sync_attempts = google_sync_attempts + 1 WHERE id = ?`).bind(msg, a.id).run();
    if (a.google_sync_attempts === 0) await notifyOwners(d.db, "founder_calendar", `The Founder appointment ${a.confirmation_code} could not be written to Google Calendar (${msg}). It is retried automatically.`, "consultation", a.id);
  }
}

/** Scheduled retry: appointments whose Google event is pending or failed (bounded attempts). */
export async function retryFounderSync(d: FounderDeps, limit = 20): Promise<{ detail: string }> {
  const c = await loadConnection(d.db);
  if (!c) return { detail: "skipped: Founder Calendar not connected to Google" };
  const rows = (await d.db.prepare(`SELECT * FROM consultations WHERE calendar = 'founder_callback' AND google_sync_status IN ('pending','failed') AND google_sync_attempts < ? ORDER BY starts_at LIMIT ?`)
    .bind(MAX_SYNC_ATTEMPTS, limit).all<Appt>()).results;
  for (const a of rows) await syncOne(d, a, c);
  return { detail: `${rows.length} Founder appointment(s) synced or retried` };
}
