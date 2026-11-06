// Internal Founder Calendar (Founder directive 2026-11-06): the authoritative scheduling system — request-only, real
// availability from the Founder's configured windows and existing bookings, no overlaps, the Founder's confirmation
// step, and one Resend notification per new, rescheduled and cancelled appointment. No external calendar is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { signRetell } from "../src/adapters/retell.ts";
import { defaultVoiceConfig, saveVoiceConfig, type VoiceConfig } from "../src/services/voice-settings.ts";
import * as sched from "../src/services/voice-scheduling.ts";
import { founderAppointmentChanged, founderNotifyEmail, DEFAULT_FOUNDER_NOTIFY_EMAIL, type FounderDeps } from "../src/services/founder-notifications.ts";
import { promptBehaviourFindings } from "../src/services/retell-inbound-audit.ts";
import { OutboxEmail } from "../src/adapters/email.ts";
import { routeCalendar } from "../src/domain/calendars.ts";

const KEY = "key_test_founder_cal_inbound_01";
const NOW = new Date("2026-11-02T14:00:00Z"); // Monday 09:00 ET
const ROUTE = { calendar: "founder_callback" as const, founderReason: "customer_requested_founder" as const };

function cfg(): VoiceConfig {
  const c = defaultVoiceConfig();
  c.timezone = "America/New_York";
  for (const d of ["mon", "tue", "wed", "thu", "fri"] as const) c.hours[d] = [{ open: "09:00", close: "17:00" }];
  c.scheduling.enabled = true;
  c.scheduling.founder_hours.tue = [{ open: "10:00", close: "12:00" }];
  return c;
}

async function app() {
  const t = await createTestApp({ RETELL_INBOUND_API_KEY: KEY } as Partial<Env>);
  t.env.overrides = { storage: t.storage, now: () => NOW } as Env["overrides"];
  const owner = await createStaff(t.db, "owner");
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('voice.monthly_budget_usd', '50', ?)`).bind(NOW.toISOString()).run();
  await saveVoiceConfig(t.db, owner.id, cfg());
  const deps: FounderDeps = { db: t.db, env: {}, mail: { email: new OutboxEmail(t.db), db: t.db, settings: {} }, baseUrl: "https://crestmont.test" };
  const mails = async (event?: string) => (await t.db.prepare(`SELECT COUNT(*) AS n FROM email_deliveries WHERE template = 'founder_appointment' AND to_email = ?${event ? " AND idempotency_key LIKE ?" : ""}`)
    .bind(DEFAULT_FOUNDER_NOTIFY_EMAIL, ...(event ? [`%:${event}`] : [])).first<{ n: number }>())!.n;
  const c = t.client();
  const call = async (id: string, name: string, args: Record<string, unknown>, from = "+16145559001") => {
    const body = JSON.stringify({ name, call: { call_id: id, call_type: "phone_call", from_number: from, to_number: "+16145559999", direction: "inbound" }, args });
    const res = await c.request("POST", "/api/webhooks/retell/functions", { body, headers: { "content-type": "application/json", "x-retell-signature": await signRetell(KEY, body) } });
    return (await res.json()) as Record<string, any>;
  };
  return { ...t, owner, deps, mails, call };
}

test("[VOICE-003] request-only: only an explicit request reaches the Founder Calendar; real availability is the Founder windows minus existing Founder bookings", async () => {
  assert.equal(routeCalendar({ wantsFounder: undefined, context: { channel: "inbound_receptionist", fn: "schedule_consultation", kind: "consultation" } }).calendar, "ai_follow_up");
  assert.equal(routeCalendar({ wantsFounder: "maybe", context: { channel: "inbound_receptionist", fn: "schedule_consultation", kind: "consultation" } }).calendar, "ai_follow_up");
  assert.equal(routeCalendar({ wantsFounder: true, context: { channel: "inbound_receptionist", fn: "schedule_consultation", kind: "consultation" } }).calendar, "founder_callback");
  const t = await app();
  const av = await sched.availability(t.db, cfg(), NOW, sched.NO_CALENDAR, { calendar: "founder_callback", limit: 10 });
  assert.ok(av.available);
  assert.deepEqual(av.slots.slice(0, 4).map((s) => s.startsAt), ["2026-11-03T15:00:00.000Z", "2026-11-03T15:30:00.000Z", "2026-11-03T16:00:00.000Z", "2026-11-03T16:30:00.000Z"], "Tuesday 10:00–12:00 ET only");
  await sched.book(t.db, cfg(), NOW, sched.NO_CALENDAR, { name: "Ann", phone: "+16145550201", startsAt: "2026-11-03T15:00:00.000Z", leadId: null, callId: null, isTest: true, source: "ai_receptionist", calendar: ROUTE });
  const after = await sched.availability(t.db, cfg(), NOW, sched.NO_CALENDAR, { calendar: "founder_callback", limit: 10 });
  assert.ok(after.available && !after.slots.some((s) => s.startsAt === "2026-11-03T15:00:00.000Z"), "a booked Founder slot is no longer offered");
  // AI callbacks at the same time are a separate calendar and do not consume the Founder's slot (or vice versa).
  const ai = await sched.availability(t.db, cfg(), NOW, sched.NO_CALENDAR, { calendar: "ai_follow_up", fromDate: "2026-11-03", limit: 48 });
  assert.ok(ai.available && ai.slots.some((s) => s.startsAt === "2026-11-03T15:00:00.000Z"));
});

test("[VOICE-003] no overlapping Founder appointments, even under concurrent booking; the Founder's confirmation step is kept", async () => {
  const t = await app();
  const tries = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => sched.book(t.db, cfg(), NOW, sched.NO_CALENDAR, { name: `P${i}`, phone: `+1614555030${i}`, startsAt: "2026-11-03T16:00:00.000Z", leadId: null, callId: null, isTest: true, source: "ai_receptionist", calendar: ROUTE })));
  assert.equal(tries.filter((r) => r.status === "fulfilled").length, 1, "exactly one Founder booking per slot");
  const row = (await t.db.prepare(`SELECT id, status FROM consultations WHERE calendar = 'founder_callback'`).first<{ id: string; status: string }>())!;
  assert.equal(row.status, "requested", "held until the Founder confirms");
  const c = t.client(); await c.login(t.owner.email, TEST_PASSWORD, t.owner.secret);
  assert.equal((await c.post(`/staff/voice/consultations/${row.id}/decide`, { decision: "confirm" })).status, 303);
  assert.equal((await t.db.prepare(`SELECT status FROM consultations WHERE id = ?`).bind(row.id).first<{ status: string }>())!.status, "confirmed");
  // A time outside the Founder windows is never bookable.
  await assert.rejects(sched.book(t.db, cfg(), NOW, sched.NO_CALENDAR, { name: "Late", phone: "+16145550399", startsAt: "2026-11-03T20:00:00.000Z", leadId: null, callId: null, isTest: true, source: "ai_receptionist", calendar: ROUTE }), sched.SlotUnavailableError);
});

test("[VOICE-003] [EMAIL-002] the Founder is emailed once per new, rescheduled and cancelled appointment, with prospect, business, time, contact, reason and CRM context", async () => {
  const t = await app();
  // The receptionist books a Founder appointment because the caller asked for the Founder.
  const ask = await t.call("c_f1", "schedule_consultation", { wants_founder: true });
  assert.equal(ask.calendar, "founder_callback");
  const start = ask.slots[0].start_time;
  const b = await t.call("c_f1", "schedule_consultation", { name: "Fay Prospect", phone: "+16145559001", email: "fay@example.com", topic: "Wants to discuss a custom portal with the Founder", start_time: start, wants_founder: true });
  assert.equal(b.booked, true, JSON.stringify(b));
  assert.equal(b.status, "requested");
  assert.equal(await t.mails("booked"), 1);
  // Retell retries the same request: the stored result is replayed; no second email.
  await t.call("c_f1", "schedule_consultation", { name: "Fay Prospect", phone: "+16145559001", email: "fay@example.com", topic: "Wants to discuss a custom portal with the Founder", start_time: start, wants_founder: true });
  const row = (await t.db.prepare(`SELECT id, lead_id FROM consultations WHERE calendar = 'founder_callback' AND status = 'requested'`).first<{ id: string; lead_id: string }>())!;
  await founderAppointmentChanged(t.deps, row.id, "booked");
  assert.equal(await t.mails("booked"), 1, "idempotent: one email per appointment and event");
  // Reschedule and cancel by phone (reference + phone), each emailed once.
  const moved = await t.call("c_f2", "reschedule_consultation", { confirmation_code: b.confirmation_code, phone: "+16145559001", new_start_time: "2026-11-10T15:30:00.000Z" });
  assert.equal(moved.rescheduled, true, JSON.stringify(moved));
  assert.equal(await t.mails("rescheduled"), 1);
  const cx = await t.call("c_f3", "cancel_consultation", { confirmation_code: moved.confirmation_code, phone: "+16145559001" });
  assert.equal(cx.cancelled, true);
  assert.equal(await t.mails("cancelled"), 1);
  assert.equal(await t.mails(), 3);
  // Content: rendered from the template with the required fields.
  const { renderTemplate } = await import("../src/services/mailer.ts");
  const r = renderTemplate("founder_appointment", { event: "booked", prospect: "Fay Prospect", business: "Fay's Bakery", when: "Tuesday, November 3 at 10:00 AM EST", timeZone: "America/New_York", durationMinutes: 30,
    contact: "+16145559001 · fay@example.com", reason: "Custom portal", salesContext: "Interest: custom", status: "requested", reference: "K7MP4Q", crmUrl: "https://crestmont.test/staff/crm/leads/ld_x", test: false } as never, { brand: "Crestmont" } as never);
  for (const must of ["Fay Prospect", "Fay's Bakery", "November 3", "America/New_York", "+16145559001", "fay@example.com", "Custom portal", "Interest: custom", "/staff/crm/leads/ld_x"]) assert.ok(r.text.includes(must) || r.html.includes(must), must);
});

test("[VOICE-003] AI Outbound Calendar appointments never email the Founder; the notification address defaults to the Founder's and can be overridden", async () => {
  const t = await app();
  const { booking } = await sched.book(t.db, cfg(), NOW, sched.NO_CALENDAR, { name: "AI cb", phone: "+16145550401", startsAt: "2026-11-03T18:00:00.000Z", leadId: null, callId: null, isTest: true, source: "ai_receptionist" });
  await founderAppointmentChanged(t.deps, booking.id, "booked");
  assert.equal(await t.mails(), 0);
  assert.equal(founderNotifyEmail({}), DEFAULT_FOUNDER_NOTIFY_EMAIL);
  assert.equal(founderNotifyEmail({ FOUNDER_NOTIFY_EMAIL: " Other@Example.com " }), "other@example.com");
});

test("[VOICE-004] Retell prompt audit: 24/7 selling, after-hours conflicts, intake and Founder-on-request are judged from the live text", () => {
  const good = "You are available 24/7. Buying starts with our project intake form. Book callbacks with schedule_consultation. Only if the caller specifically asks for the Founder, pass wants_founder true.";
  assert.ok(promptBehaviourFindings(good).every((f) => f.status === "pass"), JSON.stringify(promptBehaviourFindings(good)));
  const bad = "Outside business hours only take a message. Tell callers we are closed. {{business_open_now}}";
  const f = Object.fromEntries(promptBehaviourFindings(bad).map((x) => [x.check, x]));
  assert.equal(f["prompt: sells 24/7"].status, "fail");
  assert.equal(f["prompt: no after-hours limits"].status, "fail");
  assert.match(f["prompt: no after-hours limits"].detail, /says Crestmont is closed \(1\).*branches on business_open_now/);
  assert.doesNotMatch(JSON.stringify(promptBehaviourFindings(bad)), /Tell callers/, "the prompt text is never echoed");
});
