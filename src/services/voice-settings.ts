// Receptionist operating configuration (VOICE-003..005): business hours and holidays, human transfer,
// inbound number binding, consultation scheduling and outbound calling. Stored as one validated JSON row
// (voice_settings, migration 0040) per environment database, so staging and production can never share it.
//
// Every default is "unconfigured": no hours, no transfer number, scheduling off, outbound off. Nothing here
// invents a phone number, staffed hours or a calendar. Callers of these helpers must treat "not configured"
// as "offer a callback", never as "open".
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export interface Window { open: string; close: string }

export const OUTBOUND_PURPOSES = ["callback", "consultation_reminder", "support_followup"] as const;
export type OutboundPurpose = (typeof OUTBOUND_PURPOSES)[number];

export interface VoiceConfig {
  /** IANA zone the hours and holidays are expressed in. null = hours not configured. */
  timezone: string | null;
  hours: Record<Weekday, Window[]>;
  /** Local dates (YYYY-MM-DD, business time zone) when the business is closed all day. */
  holidays: string[];
  inbound: {
    /** "reject" is the emergency stop: Retell hangs up before any agent runs. */
    mode: "answer" | "reject";
    /** E.164 numbers bound to THIS environment. Once one is listed, calls to any other number are rejected. */
    numbers: string[];
    /** Optional agent override returned on call_inbound (Retell agent id). */
    agent_id: string | null;
  };
  transfer: {
    enabled: boolean;
    /** E.164 destination approved by the Founder. null = unconfigured: the agent offers a callback instead. */
    number: string | null;
  };
  scheduling: {
    enabled: boolean;
    duration_minutes: number;
    min_notice_hours: number;
    horizon_days: number;
    /** false (default): phone bookings are "requested" and hold the slot until staff confirm them. */
    auto_confirm: boolean;
  };
  outbound: {
    /** Second switch; outbound also needs RETELL_OUTBOUND=on in the environment. */
    enabled: boolean;
    agent_id: string | null;
    from_number: string | null;
    /** Calling window in the RECIPIENT's local time (HH:MM, 24h). */
    window_start: string;
    window_end: string;
    max_per_number_per_day: number;
    max_per_number_per_week: number;
  };
}

const closedWeek = (): Record<Weekday, Window[]> => ({ sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] });

export function defaultVoiceConfig(): VoiceConfig {
  return {
    timezone: null,
    hours: closedWeek(),
    holidays: [],
    inbound: { mode: "answer", numbers: [], agent_id: null },
    transfer: { enabled: false, number: null },
    scheduling: { enabled: false, duration_minutes: 30, min_notice_hours: 24, horizon_days: 21, auto_confirm: false },
    outbound: { enabled: false, agent_id: null, from_number: null, window_start: "09:00", window_end: "20:00", max_per_number_per_day: 1, max_per_number_per_week: 3 },
  };
}

// ───────────── Validation ─────────────

export const E164 = /^\+[1-9]\d{7,14}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const AGENT_ID = /^[A-Za-z0-9_-]{4,80}$/;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function validTimeZone(tz: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** Normalises a spoken / typed US or international number to E.164, or null when it cannot be trusted. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!/^[+0-9 ().-]{7,40}$/.test(s)) return null;
  const d = s.replace(/\D/g, "");
  if (s.startsWith("+")) return E164.test(`+${d}`) ? `+${d}` : null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

/** Problems with a candidate configuration (empty = valid). The only writer validates first. */
export function voiceConfigProblems(c: VoiceConfig): string[] {
  const p: string[] = [];
  const anyHours = WEEKDAYS.some((d) => c.hours[d]?.length);
  if (c.timezone !== null && !validTimeZone(c.timezone)) p.push("Time zone must be a valid IANA zone such as America/Detroit.");
  if (anyHours && !c.timezone) p.push("Set the time zone the business hours are expressed in.");
  for (const d of WEEKDAYS) {
    const ws = c.hours[d] ?? [];
    if (ws.length > 3) p.push(`At most three opening windows per day (${d}).`);
    let last = -1;
    for (const w of [...ws].sort((a, b) => a.open.localeCompare(b.open))) {
      if (!HHMM.test(w.open) || !HHMM.test(w.close)) { p.push(`Opening hours for ${d} must use HH:MM (24-hour).`); continue; }
      if (minutesOf(w.close) <= minutesOf(w.open)) p.push(`On ${d}, closing time must be after opening time.`);
      if (minutesOf(w.open) < last) p.push(`Opening windows on ${d} overlap.`);
      last = minutesOf(w.close);
    }
  }
  if (c.holidays.length > 60) p.push("At most 60 holiday dates.");
  for (const h of c.holidays) if (!/^\d{4}-\d{2}-\d{2}$/.test(h) || Number.isNaN(Date.parse(`${h}T00:00:00Z`))) p.push(`Holiday "${h}" must be a date (YYYY-MM-DD).`);
  if (c.inbound.numbers.length > 10) p.push("At most 10 receptionist numbers per environment.");
  for (const n of c.inbound.numbers) if (!E164.test(n)) p.push(`Receptionist number ${n} must be in E.164 format (+15551234567).`);
  if (c.inbound.agent_id !== null && !AGENT_ID.test(c.inbound.agent_id)) p.push("Inbound agent id has an unexpected format.");
  if (c.transfer.number !== null && !E164.test(c.transfer.number)) p.push("Transfer number must be in E.164 format (+15551234567).");
  if (c.transfer.enabled && !c.transfer.number) p.push("Live transfer cannot be enabled without an approved transfer number.");
  if (c.transfer.enabled && !anyHours) p.push("Live transfer needs business hours: transfers are only offered while the business is open.");
  const s = c.scheduling;
  if (![15, 20, 30, 45, 60, 90].includes(s.duration_minutes)) p.push("Consultation length must be 15, 20, 30, 45, 60 or 90 minutes.");
  if (!Number.isInteger(s.min_notice_hours) || s.min_notice_hours < 1 || s.min_notice_hours > 336) p.push("Minimum booking notice must be 1–336 hours.");
  if (!Number.isInteger(s.horizon_days) || s.horizon_days < 1 || s.horizon_days > 90) p.push("Booking horizon must be 1–90 days.");
  if (s.enabled && !anyHours) p.push("Phone scheduling needs business hours: consultations are offered inside them.");
  const o = c.outbound;
  if (!HHMM.test(o.window_start) || !HHMM.test(o.window_end)) p.push("Outbound calling window must use HH:MM (24-hour).");
  else {
    if (minutesOf(o.window_start) < 8 * 60 || minutesOf(o.window_end) > 21 * 60) p.push("Outbound calls must stay within 08:00–21:00 recipient local time.");
    if (minutesOf(o.window_end) <= minutesOf(o.window_start)) p.push("Outbound window end must be after its start.");
    // Without a known recipient zone the window must hold from Hawaii to Eastern time at once (up to 6 hours
    // apart); a shorter window could never be met and every approved call would be blocked.
    else if (minutesOf(o.window_end) - minutesOf(o.window_start) < 8 * 60) p.push("Outbound calling window must be at least 8 hours long, so it can be met in every US time zone.");
  }
  if (!Number.isInteger(o.max_per_number_per_day) || o.max_per_number_per_day < 1 || o.max_per_number_per_day > 3) p.push("Outbound limit per number per day must be 1–3.");
  if (!Number.isInteger(o.max_per_number_per_week) || o.max_per_number_per_week < o.max_per_number_per_day || o.max_per_number_per_week > 7) p.push("Outbound limit per number per week must be between the daily limit and 7.");
  if (o.from_number !== null && !E164.test(o.from_number)) p.push("Outbound caller number must be in E.164 format.");
  if (o.agent_id !== null && !AGENT_ID.test(o.agent_id)) p.push("Outbound agent id has an unexpected format.");
  if (o.enabled && (!o.from_number || !o.agent_id)) p.push("Outbound calling cannot be enabled without an approved caller number and outbound agent id.");
  if (o.enabled && o.from_number && !c.inbound.numbers.includes(o.from_number)) p.push("The outbound caller number must also be one of this environment's receptionist numbers, so return calls reach the receptionist.");
  return p;
}

/** Merges stored JSON over defaults so new fields added later always have a safe value. */
function normalise(raw: unknown): VoiceConfig {
  const d = defaultVoiceConfig();
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<VoiceConfig>;
  const hours = closedWeek();
  for (const day of WEEKDAYS) {
    const ws = (o.hours as Record<string, unknown> | undefined)?.[day];
    hours[day] = Array.isArray(ws) ? ws.filter((w): w is Window => !!w && typeof (w as Window).open === "string" && typeof (w as Window).close === "string").map((w) => ({ open: w.open, close: w.close })) : [];
  }
  return {
    timezone: typeof o.timezone === "string" ? o.timezone : null,
    hours,
    holidays: Array.isArray(o.holidays) ? o.holidays.filter((h): h is string => typeof h === "string") : [],
    inbound: { ...d.inbound, ...(o.inbound ?? {}), numbers: Array.isArray(o.inbound?.numbers) ? o.inbound!.numbers.filter((n): n is string => typeof n === "string") : [] },
    transfer: { ...d.transfer, ...(o.transfer ?? {}) },
    scheduling: { ...d.scheduling, ...(o.scheduling ?? {}) },
    outbound: { ...d.outbound, ...(o.outbound ?? {}) },
  };
}

export async function loadVoiceConfig(db: Db): Promise<VoiceConfig> {
  const row = await db.prepare(`SELECT config_json FROM voice_settings WHERE id = 1`).first<{ config_json: string }>();
  if (!row) return defaultVoiceConfig();
  try { return normalise(JSON.parse(row.config_json)); } catch { return defaultVoiceConfig(); }
}

export class VoiceConfigError extends Error {
  problems: string[];
  constructor(problems: string[]) { super(problems.join(" ")); this.problems = problems; }
}

export async function saveVoiceConfig(db: Db, userId: string, next: VoiceConfig): Promise<{ changed: string[] }> {
  const c = normalise(next);
  c.holidays = [...new Set(c.holidays)].sort();
  c.inbound.numbers = [...new Set(c.inbound.numbers)];
  const problems = voiceConfigProblems(c);
  if (problems.length) throw new VoiceConfigError(problems);
  const prev = await loadVoiceConfig(db);
  const changed = (Object.keys(c) as (keyof VoiceConfig)[]).filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(c[k]));
  await db.prepare(`INSERT INTO voice_settings (id, config_json, updated_by, updated_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(JSON.stringify(c), userId, nowIso()).run();
  // Phone numbers are business numbers, not personal data, but only field names go into the audit log.
  await audit(db, { actorUserId: userId, action: "voice.settings_updated", subjectType: "voice_settings", subjectId: "1", details: { changed } });
  return { changed };
}

// ───────────── Time-zone arithmetic (Intl only; Workers have no tz database otherwise) ─────────────

export interface LocalParts { date: string; weekday: Weekday; minutes: number; y: number; m: number; d: number }

export function localParts(at: Date, tz: string): LocalParts {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
    .formatToParts(at).map((p) => [p.type, p.value]));
  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  return { y, m, d, date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday.toLowerCase().slice(0, 3) as Weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** UTC instant of a wall-clock time in a zone (handles DST: re-checks the offset at the candidate instant). */
export function zonedToUtc(date: string, minutes: number, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const offsetAt = (ms: number) => { const p = localParts(new Date(ms), tz); return Date.UTC(p.y, p.m - 1, p.d, Math.floor(p.minutes / 60), p.minutes % 60) - ms; };
  let guess = naive - offsetAt(naive);
  guess = naive - offsetAt(guess);
  return new Date(guess);
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (date: string) => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];

// ───────────── Business hours ─────────────

export interface HoursStatus {
  configured: boolean;
  open: boolean;
  /** Spoken-friendly description the agent may read out. */
  summary: string;
  nextOpenAt: string | null;
  timezone: string | null;
}

const fmtTime = (mins: number) => { const h = Math.floor(mins / 60), m = mins % 60; return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`; };

export function describeHours(c: VoiceConfig): string {
  if (!c.timezone || !WEEKDAYS.some((d) => c.hours[d].length)) return "Business hours have not been published yet.";
  const names: Record<Weekday, string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };
  const order: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const parts = order.map((d) => `${names[d]}: ${c.hours[d].length ? c.hours[d].map((w) => `${fmtTime(minutesOf(w.open))}–${fmtTime(minutesOf(w.close))}`).join(", ") : "closed"}`);
  return `${parts.join("; ")} (${c.timezone}).`;
}

export function hoursStatus(c: VoiceConfig, at: Date): HoursStatus {
  if (!c.timezone || !WEEKDAYS.some((d) => c.hours[d].length)) {
    return { configured: false, open: false, summary: describeHours(c), nextOpenAt: null, timezone: c.timezone };
  }
  const tz = c.timezone;
  const now = localParts(at, tz);
  const holiday = new Set(c.holidays);
  const openNow = !holiday.has(now.date) && c.hours[now.weekday].some((w) => now.minutes >= minutesOf(w.open) && now.minutes < minutesOf(w.close));
  let nextOpenAt: string | null = null;
  if (!openNow) {
    for (let i = 0; i <= 14 && !nextOpenAt; i++) {
      const date = addDays(now.date, i);
      if (holiday.has(date)) continue;
      for (const w of [...c.hours[weekdayOf(date)]].sort((a, b) => a.open.localeCompare(b.open))) {
        if (i === 0 && minutesOf(w.open) <= now.minutes) continue;
        nextOpenAt = zonedToUtc(date, minutesOf(w.open), tz).toISOString();
        break;
      }
    }
  }
  return { configured: true, open: openNow, summary: describeHours(c), nextOpenAt, timezone: tz };
}

/** Live transfer is offered only when it is configured, a number is approved and the business is open now. */
export function transferAvailability(c: VoiceConfig, at: Date): { available: boolean; reason: "not_configured" | "closed" | "open" } {
  if (!c.transfer.enabled || !c.transfer.number) return { available: false, reason: "not_configured" };
  return hoursStatus(c, at).open ? { available: true, reason: "open" } : { available: false, reason: "closed" };
}

// ───────────── Outbound calling window (recipient local time) ─────────────

/**
 * Without a known recipient time zone, the window must hold in every US zone at once (Eastern through
 * Hawaii), which is the conservative reading of quiet-hours rules. Outbound is limited to +1 numbers.
 */
export const CONSERVATIVE_US_ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"] as const;

export function withinCallingWindow(c: VoiceConfig, at: Date, recipientTz: string | null): boolean {
  const zones = recipientTz ? [recipientTz] : [...CONSERVATIVE_US_ZONES];
  const start = minutesOf(c.outbound.window_start), end = minutesOf(c.outbound.window_end);
  return zones.every((tz) => { const m = localParts(at, tz).minutes; return m >= start && m < end; });
}

/** Next instant (searching forward in 15-minute steps, up to 3 days) when the calling window is open. */
export function nextCallingWindow(c: VoiceConfig, from: Date, recipientTz: string | null): Date | null {
  const step = 15 * 60_000;
  let t = Math.ceil(from.getTime() / step) * step;
  for (let i = 0; i < 4 * 24 * 3; i++, t += step) if (withinCallingWindow(c, new Date(t), recipientTz)) return new Date(t);
  return null;
}

// ───────────── Consultation slots ─────────────

export interface Slot { startsAt: string; endsAt: string; label: string }

export function slotLabel(startsAt: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(startsAt));
}

/**
 * Candidate slots inside business hours, aligned to the consultation length, honouring minimum notice,
 * horizon and holidays, minus `busy` intervals (existing bookings and any connected calendar).
 */
export function candidateSlots(c: VoiceConfig, at: Date, busy: { start: number; end: number }[], opts: { fromDate?: string; limit?: number } = {}): Slot[] {
  if (!c.timezone) return [];
  const tz = c.timezone, len = c.scheduling.duration_minutes;
  const earliest = at.getTime() + c.scheduling.min_notice_hours * 3_600_000;
  const lastDay = addDays(localParts(at, tz).date, c.scheduling.horizon_days);
  let date = localParts(at, tz).date;
  if (opts.fromDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.fromDate) && opts.fromDate > date) date = opts.fromDate;
  const holiday = new Set(c.holidays);
  const out: Slot[] = [];
  const limit = opts.limit ?? 6;
  for (; date <= lastDay && out.length < limit; date = addDays(date, 1)) {
    if (holiday.has(date)) continue;
    for (const w of [...c.hours[weekdayOf(date)]].sort((a, b) => a.open.localeCompare(b.open))) {
      for (let m = minutesOf(w.open); m + len <= minutesOf(w.close) && out.length < limit; m += len) {
        const s = zonedToUtc(date, m, tz).getTime(), e = s + len * 60_000;
        if (s < earliest) continue;
        if (busy.some((b) => s < b.end && e > b.start)) continue;
        const startsAt = new Date(s).toISOString();
        if (out.some((x) => x.startsAt === startsAt)) continue; // the skipped hour on the spring-forward day
        out.push({ startsAt, endsAt: new Date(e).toISOString(), label: slotLabel(startsAt, tz) });
      }
    }
  }
  return out;
}

/** True when `startsAt` is exactly one of the slots the rules would offer (ignoring other bookings). */
export function isOfferableSlot(c: VoiceConfig, at: Date, startsAt: string): boolean {
  if (!c.timezone) return false;
  const t = Date.parse(startsAt);
  if (!Number.isFinite(t)) return false;
  const local = localParts(new Date(t), c.timezone);
  const slots = candidateSlots(c, at, [], { fromDate: local.date, limit: 200 });
  return slots.some((s) => Date.parse(s.startsAt) === t);
}
