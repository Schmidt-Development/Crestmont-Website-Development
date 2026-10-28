// Retell backend completion: inbound webhook, environment separation, business hours, transfers, phone
// scheduling, outbound calling (consent, DNC, windows, caps, retries), analytics, redaction and caller erasure.
// Everything here is TEST DATA: Retell is simulated with signed payloads and a fake fetch. No real call,
// number, email or Retell account is involved, and none of this is evidence of a live Retell verification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { signRetell, createRetellPhoneCall } from "../src/adapters/retell.ts";
import {
  defaultVoiceConfig, saveVoiceConfig, loadVoiceConfig, voiceConfigProblems, zonedToUtc, hoursStatus, candidateSlots,
  withinCallingWindow, toE164, type VoiceConfig,
} from "../src/services/voice-settings.ts";
import { processOutboundQueue, decideOutbound, requestOutbound, recordCallConsent, addDnc, outboundGate } from "../src/services/voice-outbound.ts";
import { voiceAnalytics, eraseCallerData } from "../src/services/voice-ops.ts";
import { redactSensitive } from "../src/services/voice-common.ts";
import { runJobs } from "../src/app/scheduled.ts";

const KEY = "key_test_retell_backend_0001";
// Monday 2 November 2026, 09:00 in Detroit (EST, UTC-5, the day after DST ends).
const MON_9AM = new Date("2026-11-02T14:00:00Z");

type Db = Env["DB"];
const one = async <T>(db: Db, sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;
const count = async (db: Db, sql: string, ...b: unknown[]) => (await one<{ n: number }>(db, sql, ...b)).n;

async function app(extra: Partial<Env> = {}, now?: Date) {
  const t = await createTestApp({ RETELL_API_KEY: KEY, ...extra, overrides: { ...(now ? { now: () => now } : {}), ...(extra.overrides ?? {}) } as Env["overrides"] });
  // createTestApp puts storage in overrides; keep it when we add a clock.
  t.env.overrides = { storage: t.storage, ...(t.env.overrides ?? {}), ...(now ? { now: () => now } : {}) };
  const c = t.client();
  const post = async (path: string, payload: unknown, opts: { sign?: boolean } = {}) => {
    const raw = JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.sign !== false) headers["x-retell-signature"] = await signRetell(KEY, raw);
    const res = await c.request("POST", path, { body: raw, headers });
    return { res, json: (await res.json()) as Record<string, any> };
  };
  const owner = await createStaff(t.db, "owner");
  return { ...t, post, owner };
}

const phoneCall = (id: string, extra: Record<string, unknown> = {}) => ({ call_id: id, call_type: "phone_call", from_number: "+15550100123", to_number: "+15550109999", direction: "inbound", agent_id: "agent_test", ...extra });
const fn = (id: string, name: string, args: Record<string, unknown>, call: Record<string, unknown> = {}) => ({ name, call: phoneCall(id, call), args });

function configured(over: Partial<VoiceConfig> = {}): VoiceConfig {
  const c = defaultVoiceConfig();
  c.timezone = "America/Detroit";
  for (const d of ["mon", "tue", "wed", "thu", "fri"] as const) c.hours[d] = [{ open: "09:00", close: "17:00" }];
  return { ...c, ...over };
}

// ───────────── Configuration and time ─────────────

test("[VOICE-005] receptionist settings default to unconfigured and refuse unsafe combinations", async () => {
  const t = await app();
  const d = await loadVoiceConfig(t.db);
  assert.equal(d.timezone, null);
  assert.equal(d.transfer.number, null, "no transfer number is ever invented");
  assert.equal(d.scheduling.enabled, false);
  assert.equal(d.outbound.enabled, false, "outbound is off by default");
  const bad = configured({ transfer: { enabled: true, number: null } });
  assert.ok(voiceConfigProblems(bad).some((p) => /transfer number/i.test(p)));
  const late = configured(); late.outbound.window_end = "22:00";
  assert.ok(voiceConfigProblems(late).some((p) => /08:00–21:00/.test(p)));
  const ob = configured(); ob.outbound.enabled = true;
  assert.ok(voiceConfigProblems(ob).some((p) => /caller number and outbound agent/i.test(p)));
  const tz = configured({ timezone: "Mars/Olympus" });
  assert.ok(voiceConfigProblems(tz).some((p) => /IANA/.test(p)));
  assert.deepEqual(voiceConfigProblems(configured()), []);
  await saveVoiceConfig(t.db, t.owner.id, configured());
  assert.equal((await loadVoiceConfig(t.db)).timezone, "America/Detroit");
  const log = await one<{ details_json: string }>(t.db, `SELECT details_json FROM audit_logs WHERE action = 'voice.settings_updated'`);
  assert.doesNotMatch(log.details_json, /\+1555/, "audit records which fields changed, not values");
});

test("[VOICE-005] time-zone arithmetic: DST, business hours, holidays and the conservative US calling window", () => {
  assert.equal(zonedToUtc("2026-10-28", 9 * 60, "America/Detroit").toISOString(), "2026-10-28T13:00:00.000Z", "EDT is UTC-4");
  assert.equal(zonedToUtc("2026-11-02", 9 * 60, "America/Detroit").toISOString(), "2026-11-02T14:00:00.000Z", "EST is UTC-5");
  const c = configured();
  assert.equal(hoursStatus(c, MON_9AM).open, true);
  assert.equal(hoursStatus(c, new Date("2026-11-02T13:59:00Z")).open, false, "08:59 is before opening");
  const closed = hoursStatus(c, new Date("2026-11-01T15:00:00Z"));
  assert.equal(closed.open, false, "Sunday");
  assert.equal(closed.nextOpenAt, "2026-11-02T14:00:00.000Z");
  assert.equal(hoursStatus({ ...c, holidays: ["2026-11-02"] }, MON_9AM).open, false, "holiday");
  assert.equal(hoursStatus(defaultVoiceConfig(), MON_9AM).configured, false);
  // 09:00 ET is 06:00 PT: outside a 09:00–20:00 window somewhere in the US.
  assert.equal(withinCallingWindow(c, MON_9AM, null), false);
  assert.equal(withinCallingWindow(c, MON_9AM, "America/New_York"), true);
  assert.equal(withinCallingWindow(c, new Date("2026-12-07T17:00:00Z"), null), false, "12:00 ET but 07:00 in Honolulu, 08:00 in Anchorage");
  assert.equal(withinCallingWindow(c, new Date("2026-11-02T19:00:00Z"), null), true, "14:00 ET / 09:00 HST");
  const short = configured(); short.outbound.window_start = "10:00"; short.outbound.window_end = "12:00";
  assert.ok(voiceConfigProblems(short).some((p) => /at least 8 hours/.test(p)), "a window that can never be met in every zone is refused");
  assert.equal(toE164("(555) 010-0123"), "+15550100123");
  assert.equal(toE164("not a number"), null);
});

// ───────────── Inbound webhook and environment separation ─────────────

test("[VOICE-003] [SEC-002] inbound call webhook: signed, string dynamic variables, env stamp, emergency stop and number binding", async () => {
  const t = await app({}, MON_9AM);
  const inbound = (id: string, to = "+15550109999") => ({ event: "call_inbound", call_inbound: { call_id: id, from_number: "+15550100123", to_number: to } });
  assert.equal((await t.post("/api/webhooks/retell/inbound", inbound("in_0"), { sign: false })).res.status, 401);
  const r = await t.post("/api/webhooks/retell/inbound", inbound("in_1"));
  assert.equal(r.res.status, 200);
  const vars = r.json.call_inbound.dynamic_variables as Record<string, unknown>;
  for (const v of Object.values(vars)) assert.equal(typeof v, "string", "Retell requires string dynamic variables");
  assert.equal(vars.transfer_number, "", "no transfer number until one is approved");
  assert.equal(vars.business_hours_configured, "false");
  assert.deepEqual(r.json.call_inbound.metadata, { crestmont_env: "development" });
  const row = await one<{ to_number: string; environment: string; direction: string }>(t.db, `SELECT to_number, environment, direction FROM calls WHERE provider_call_id = 'in_1'`);
  assert.deepEqual({ ...row }, { to_number: "+15550109999", environment: "development", direction: "inbound" });

  // Transfer becomes available only with an approved number AND open hours.
  await saveVoiceConfig(t.db, t.owner.id, configured({ transfer: { enabled: true, number: "+15550107777" }, inbound: { mode: "answer", numbers: ["+15550109999"], agent_id: null } }));
  const open = await t.post("/api/webhooks/retell/inbound", inbound("in_2"));
  assert.equal(open.json.call_inbound.dynamic_variables.transfer_number, "+15550107777");
  assert.equal(open.json.call_inbound.dynamic_variables.business_open_now, "true");
  // A number from another business / workspace is rejected once this environment's numbers are bound.
  assert.deepEqual((await t.post("/api/webhooks/retell/inbound", inbound("in_3", "+15550108888"))).json, { call_inbound: { reject: true } });
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM calls WHERE provider_call_id = 'in_3'`), 0, "rejected calls create no call record");
  // Emergency stop.
  const paused = configured(); paused.inbound.mode = "reject";
  await saveVoiceConfig(t.db, t.owner.id, paused);
  assert.deepEqual((await t.post("/api/webhooks/retell/inbound", inbound("in_4"))).json, { call_inbound: { reject: true } });
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'voice.inbound_rejected'`), 2);
});

test("[VOICE-003] [SEC-002] a call stamped for another environment is refused before any business logic runs", async () => {
  const t = await app();
  const prod = { metadata: { crestmont_env: "production" } };
  const ev = await t.post("/api/webhooks/retell", { event: "call_started", call: phoneCall("c_prod", prod) });
  assert.deepEqual(ev.json, { ok: true, ignored: "environment_mismatch" });
  const f = await t.post("/api/webhooks/retell/functions", fn("c_prod", "create_lead", { name: "Pat Prod", phone: "+15550100124", interest: "business", requirements: "A website for my shop" }, prod));
  assert.equal(f.res.status, 409);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM calls`), 0);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM leads`), 0);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'voice.environment_mismatch'`), 2);
  // The same call stamped for this environment is processed normally.
  const dev = { metadata: { crestmont_env: "development" } };
  assert.equal((await t.post("/api/webhooks/retell", { event: "call_started", call: phoneCall("c_dev", dev) })).json.ok, true);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM calls WHERE environment = 'development'`), 1);
});

test("[VOICE-003] out-of-order and repeated events: call_ended before call_started, retries, cost never double-counted", async () => {
  const t = await app();
  const ended = { event: "call_ended", call: phoneCall("c_ooo", { call_status: "ended", disconnection_reason: "user_hangup", transcript: "Agent: hello", duration_ms: 61_000, call_cost: { combined_cost: 10 } }) };
  assert.equal((await t.post("/api/webhooks/retell", ended)).json.outcome, "info_only");
  assert.equal((await t.post("/api/webhooks/retell", { event: "call_started", call: phoneCall("c_ooo") })).json.ok, true, "late call_started is accepted");
  assert.equal((await t.post("/api/webhooks/retell", ended)).json.duplicate, true, "retry is a duplicate");
  await t.post("/api/webhooks/retell", { event: "call_analyzed", call: phoneCall("c_ooo", { call_cost: { combined_cost: 99 } }) });
  const row = await one<{ outcome: string; ended_at: string; duration_ms: number; disconnection_reason: string; cost_microusd: number }>(t.db, `SELECT outcome, ended_at, duration_ms, disconnection_reason, cost_microusd FROM calls WHERE provider_call_id = 'c_ooo'`);
  assert.equal(row.outcome, "info_only");
  assert.ok(row.ended_at);
  assert.equal(row.duration_ms, 61_000);
  assert.equal(row.disconnection_reason, "user_hangup");
  assert.equal(row.cost_microusd, 100_000, "first reported cost is kept; analysis does not overwrite it");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM calls`), 1);
});

// ───────────── Hours, transfers, missed calls ─────────────

test("[VOICE-003] business hours and transfer availability functions never invent hours or a number", async () => {
  const t = await app({}, MON_9AM);
  await t.post("/api/webhooks/retell", { event: "call_started", call: phoneCall("c_h") });
  const unconf = await t.post("/api/webhooks/retell/functions", fn("c_h", "get_business_hours", {}));
  assert.equal(unconf.json.configured, false);
  const noTransfer = await t.post("/api/webhooks/retell/functions", fn("c_h", "check_transfer_availability", {}));
  assert.equal(noTransfer.json.transfer_available, false);
  assert.equal(noTransfer.json.reason, "not_configured");
  await saveVoiceConfig(t.db, t.owner.id, configured({ transfer: { enabled: true, number: "+15550107777" } }));
  const hours = await t.post("/api/webhooks/retell/functions", fn("c_h2", "get_business_hours", {}));
  assert.equal(hours.json.open_now, true);
  assert.match(hours.json.hours, /Monday: 9 AM–5 PM/);
  const yes = await t.post("/api/webhooks/retell/functions", fn("c_h2", "check_transfer_availability", {}));
  assert.equal(yes.json.transfer_available, true);
  assert.doesNotMatch(JSON.stringify(yes.json), /7777/, "the destination number is never given to the model");
});

test("[VOICE-003] failed transfers become an urgent callback task and an Owner alert, once per attempt", async () => {
  const t = await app();
  await t.post("/api/webhooks/retell", { event: "call_started", call: phoneCall("c_tx") });
  await t.post("/api/webhooks/retell/functions", fn("c_tx", "create_lead", { name: "Tess Transfer", phone: "+15550100125", interest: "business", requirements: "Needs a quote today" }));
  const cancelled = { event: "transfer_cancelled", call: phoneCall("c_tx", { start_timestamp: 1_700_000_000_000, transfer_destination: { number: "+15550107777" } }) };
  assert.equal((await t.post("/api/webhooks/retell", { event: "transfer_started", call: cancelled.call })).json.recorded, "transfer_started");
  assert.equal((await t.post("/api/webhooks/retell", cancelled)).json.recorded, "transfer_cancelled");
  assert.equal((await t.post("/api/webhooks/retell", cancelled)).json.duplicate, true);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM crm_activities WHERE kind = 'task' AND body LIKE '%live transfer%'`), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM notifications WHERE kind = 'voice_transfer_failed' AND user_id = ?`, t.owner.id), 1);
  assert.equal((await voiceAnalytics(t.db, new Date(0))).transferFailures, 1);
});

test("[VOICE-003] a missed inbound call alerts Owners but never dials anyone automatically", async () => {
  const fetches: string[] = [];
  const t = await app({ overrides: { fetch: (async (u: string) => { fetches.push(String(u)); return new Response("{}"); }) as unknown as typeof fetch } as Env["overrides"] });
  await t.post("/api/webhooks/retell", { event: "call_started", call: phoneCall("c_miss") });
  await t.post("/api/webhooks/retell", { event: "call_ended", call: phoneCall("c_miss", { disconnection_reason: "user_hangup" }) });
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM notifications WHERE kind = 'voice_missed_call'`), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM voice_outbound_requests`), 0);
  assert.equal(fetches.length, 0);
  // Test (web) calls never raise missed-call alerts.
  await t.post("/api/webhooks/retell", { event: "call_ended", call: phoneCall("c_miss_test", { call_type: "web_call" }) });
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM notifications WHERE kind = 'voice_missed_call'`), 1);
});

// ───────────── Consultation scheduling ─────────────

async function schedulingApp() {
  const t = await app({}, MON_9AM);
  const c = configured(); c.scheduling.enabled = true;
  await saveVoiceConfig(t.db, t.owner.id, c);
  return t;
}

test("[VOICE-003] consultation availability honours hours, minimum notice, alignment and the off switch", async () => {
  const t = await app({}, MON_9AM);
  await t.post("/api/webhooks/retell", { event: "call_started", call: phoneCall("c_av") });
  const off = await t.post("/api/webhooks/retell/functions", fn("c_av", "check_consultation_availability", {}));
  assert.equal(off.json.available, false);
  assert.equal(off.json.reason, "scheduling_disabled");
  const c = configured(); c.scheduling.enabled = true;
  await saveVoiceConfig(t.db, t.owner.id, c);
  const on = await t.post("/api/webhooks/retell/functions", fn("c_av2", "check_consultation_availability", {}));
  assert.equal(on.json.available, true);
  // 24 h notice from Monday 09:00 → first slot Tuesday 09:00 EST (14:00Z), every 30 minutes.
  assert.deepEqual(on.json.slots.slice(0, 2).map((s: { start_time: string }) => s.start_time), ["2026-11-03T14:00:00.000Z", "2026-11-03T14:30:00.000Z"]);
  assert.match(on.json.slots[0].label, /Tuesday, November 3.*9:00 AM EST/);
  const fromFri = await t.post("/api/webhooks/retell/functions", fn("c_av2", "check_consultation_availability", { preferred_date: "2026-11-06" }));
  assert.equal(fromFri.json.slots[0].start_time, "2026-11-06T14:00:00.000Z");
  // Slots are pure functions of the rules: a holiday removes the whole day.
  const h = candidateSlots({ ...c, holidays: ["2026-11-03"] }, MON_9AM, []);
  assert.equal(h[0].startsAt, "2026-11-04T14:00:00.000Z");
});

test("[VOICE-003] booking: CRM lead, held slot, reference, email via the platform mailer, no duplicates, no double booking", async () => {
  const t = await schedulingApp();
  await t.post("/api/webhooks/retell", { event: "call_started", call: phoneCall("c_b1", { from_number: "+15550100126" }) });
  const args = { name: "Bea Booker", phone: "+1 (555) 010-0126", email: "bea@example.com", start_time: "2026-11-03T14:00:00.000Z", topic: "New site for a bakery", reminder_call_ok: true };
  const own = { from_number: "+15550100126" };
  const b = await t.post("/api/webhooks/retell/functions", fn("c_b1", "book_consultation", args, own));
  assert.equal(b.json.booked, true);
  assert.equal(b.json.status, "requested", "no calendar connected: held until staff confirm");
  assert.match(b.json.confirmation_code, /^[A-HJ-NP-Z2-9]{6}$/);
  const row = await one<{ lead_id: string; phone: string; status: string; call_id: string }>(t.db, `SELECT lead_id, phone, status, call_id FROM consultations`);
  assert.ok(row.lead_id && row.call_id);
  assert.equal(row.phone, "+15550100126", "stored normalised");
  assert.equal((await one<{ source: string }>(t.db, `SELECT source FROM leads WHERE id = ?`, row.lead_id)).source, "ai_receptionist");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM crm_activities WHERE lead_id = ? AND kind = 'task' AND body LIKE 'Confirm or decline%'`, row.lead_id), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE template = 'consultation' AND to_email = 'bea@example.com'`), 1, "sent through the dev outbox, never a real provider");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM notifications WHERE kind = 'voice_consultation'`), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM voice_call_consents WHERE purpose = 'consultation_reminder'`), 1, "reminder consent only because the caller agreed");
  // Retell retry of the identical request returns the stored result (no second booking).
  assert.deepEqual((await t.post("/api/webhooks/retell/functions", fn("c_b1", "book_consultation", args, own))).json, b.json);
  // The same caller on a new call gets their existing booking back.
  const again = await t.post("/api/webhooks/retell/functions", fn("c_b2", "book_consultation", { ...args, start_time: "2026-11-03T15:00:00.000Z" }, own));
  assert.equal(again.json.already_booked, true);
  // Another caller cannot take the same slot; alternatives are offered instead.
  const clash = await t.post("/api/webhooks/retell/functions", fn("c_b3", "book_consultation", { ...args, name: "Other Person", phone: "+15550100127", email: undefined }, { from_number: "+15550100127" }));
  assert.equal(clash.json.booked, false);
  assert.ok(clash.json.slots.length > 0);
  assert.ok(!clash.json.slots.some((s: { start_time: string }) => s.start_time === args.start_time));
  // A time outside the rules (3 AM) or inside the notice period is never bookable.
  const night = await t.post("/api/webhooks/retell/functions", fn("c_b4", "book_consultation", { ...args, phone: "+15550100128", start_time: "2026-11-04T08:00:00.000Z" }, { from_number: "+15550100128" }));
  assert.equal(night.json.booked, false);
  const soon = await t.post("/api/webhooks/retell/functions", fn("c_b5", "book_consultation", { ...args, phone: "+15550100129", start_time: "2026-11-02T16:00:00.000Z" }, { from_number: "+15550100129" }));
  assert.equal(soon.json.booked, false);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM consultations WHERE status IN ('requested','confirmed')`), 1);
  // The database itself refuses a second active booking at the same start.
  await assert.rejects(t.db.prepare(`INSERT INTO consultations (id, name, starts_at, duration_minutes, timezone, status, confirmation_code, source, created_at, updated_at) VALUES ('x','x','2026-11-03T14:00:00.000Z',30,'America/Detroit','requested','ZZZZZZ','staff','t','t')`).run(), /UNIQUE/);
});

test("[VOICE-003] [VOICE-004] changing a booking needs reference AND phone; answers never reveal which part was wrong; lockout after 3 failures", async () => {
  const t = await schedulingApp();
  const b = await t.post("/api/webhooks/retell/functions", fn("c_v1", "book_consultation", { name: "Val Verify", phone: "+15550100130", start_time: "2026-11-03T14:00:00.000Z", topic: "Redesign" }));
  const code = b.json.confirmation_code as string;
  const wrongPhone = await t.post("/api/webhooks/retell/functions", fn("c_v2", "lookup_consultation", { confirmation_code: code, phone: "+15550100999" }));
  const wrongCode = await t.post("/api/webhooks/retell/functions", fn("c_v2", "lookup_consultation", { confirmation_code: "AAAAAA", phone: "+15550100130" }));
  assert.deepEqual(wrongPhone.json, wrongCode.json, "identical answer: no booking enumeration");
  assert.equal(wrongPhone.json.verified, false);
  assert.doesNotMatch(JSON.stringify(wrongPhone.json), /Val|Redesign|November/);
  const ok = await t.post("/api/webhooks/retell/functions", fn("c_v3", "lookup_consultation", { confirmation_code: code.toLowerCase(), phone: "(555) 010-0130" }));
  assert.equal(ok.json.verified, true);
  assert.equal(ok.json.status, "awaiting confirmation");
  // Third failure on the same call locks further attempts on that call, even with correct details.
  await t.post("/api/webhooks/retell/functions", fn("c_v2", "cancel_consultation", { confirmation_code: "BBBBBB", phone: "+15550100130" }));
  const locked = await t.post("/api/webhooks/retell/functions", fn("c_v2", "cancel_consultation", { confirmation_code: code, phone: "+15550100130" }));
  assert.equal(locked.json.locked, true);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM consultations WHERE status = 'requested'`), 1, "nothing was cancelled");
});

test("[VOICE-003] reschedule issues a new reference and frees the old slot; cancel frees it; staff confirm through the Owner page", async () => {
  const t = await schedulingApp();
  const b = await t.post("/api/webhooks/retell/functions", fn("c_r1", "book_consultation", { name: "Rae Move", phone: "+15550100131", email: "rae@example.com", start_time: "2026-11-03T14:00:00.000Z", topic: "Landing page" }));
  const r = await t.post("/api/webhooks/retell/functions", fn("c_r2", "reschedule_consultation", { confirmation_code: b.json.confirmation_code, phone: "+15550100131", new_start_time: "2026-11-04T15:00:00.000Z" }));
  assert.equal(r.json.rescheduled, true);
  assert.notEqual(r.json.confirmation_code, b.json.confirmation_code);
  const rows = (await t.db.prepare(`SELECT status, starts_at, rescheduled_from FROM consultations ORDER BY created_at`).all<{ status: string; starts_at: string; rescheduled_from: string | null }>()).results;
  assert.deepEqual(rows.map((x) => x.status), ["cancelled", "requested"]);
  assert.ok(rows[1].rescheduled_from);
  // The freed slot is bookable again by someone else.
  const other = await t.post("/api/webhooks/retell/functions", fn("c_r3", "book_consultation", { name: "Next Caller", phone: "+15550100132", start_time: "2026-11-03T14:00:00.000Z", topic: "Shop" }, { from_number: "+15550100132" }));
  assert.equal(other.json.booked, true);
  // A move onto a taken slot leaves the original booking untouched.
  const blocked = await t.post("/api/webhooks/retell/functions", fn("c_r4", "reschedule_consultation", { confirmation_code: r.json.confirmation_code, phone: "+15550100131", new_start_time: "2026-11-03T14:00:00.000Z" }));
  assert.equal(blocked.json.rescheduled, false);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM consultations WHERE status = 'requested' AND starts_at = '2026-11-04T15:00:00.000Z'`), 1);
  // Owner confirms the rescheduled booking from the operations page; the caller is emailed through the platform mailer.
  const c = t.client(); await c.login(t.owner.email, TEST_PASSWORD, t.owner.secret);
  const id = (await one<{ id: string }>(t.db, `SELECT id FROM consultations WHERE starts_at = '2026-11-04T15:00:00.000Z' AND status = 'requested'`)).id;
  assert.equal((await c.post(`/staff/voice/consultations/${id}/decide`, { decision: "confirm" })).status, 303);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM consultations WHERE id = ?`, id)).status, "confirmed");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE template = 'consultation' AND to_email = 'rae@example.com'`), 3, "requested, rescheduled, confirmed");
  // Caller cancels by phone.
  const cx = await t.post("/api/webhooks/retell/functions", fn("c_r5", "cancel_consultation", { confirmation_code: r.json.confirmation_code, phone: "+15550100131" }));
  assert.equal(cx.json.cancelled, true);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM consultations WHERE id = ?`, id)).status, "cancelled");
});

// ───────────── Outbound calling ─────────────

interface FakeCall { url: string; headers: Record<string, string>; body: Record<string, any> }
function fakeRetell(responses: { status: number; body?: unknown }[]) {
  const calls: FakeCall[] = [];
  let i = 0;
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()), body: JSON.parse(String(init.body)) });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function outboundApp(fetchResponses: { status: number; body?: unknown }[], at: Date, envOn = true) {
  const fake = fakeRetell(fetchResponses);
  const t = await app({ RETELL_OUTBOUND: envOn ? "on" : undefined }, at);
  const c = configured();
  c.inbound.numbers = ["+15550109999"];
  c.outbound = { ...c.outbound, enabled: true, from_number: "+15550109999", agent_id: "agent_outbound_1" };
  await saveVoiceConfig(t.db, t.owner.id, c);
  const run = () => processOutboundQueue({ db: t.db, env: t.env, fetch: fake.f, now: () => at, sleep: async () => {} });
  return { ...t, fake, run };
}
// 14:00 ET on Monday = 09:00 in Hawaii: inside 09:00–20:00 in every US zone.
const MON_2PM = new Date("2026-11-02T19:00:00Z");

test("[VOICE-003] [SEC-002] outbound is off by default: two independent switches, and the scheduled job dials nothing", async () => {
  const fake = fakeRetell([{ status: 201, body: { call_id: "never" } }]);
  const t = await app({ overrides: { fetch: fake.f } as Env["overrides"] });
  assert.equal(outboundGate(t.env, await loadVoiceConfig(t.db)).enabled, false);
  const res = await runJobs(t.env, ["voice_outbound"]);
  assert.match(res.voice_outbound.detail, /^skipped: outbound disabled/);
  // Owner setting on but environment switch off → still disabled.
  const off = await outboundApp([{ status: 201, body: { call_id: "never" } }], MON_2PM, false);
  const row = await requestOutbound(off.db, { purpose: "callback", phone: "+15550100140", reason: "Asked for a callback", consentEvidence: "Caller asked on call c_x", requestedBy: off.owner.id });
  await decideOutbound(off.db, off.owner.id, row.id, "approve");
  assert.match((await off.run()).detail, /RETELL_OUTBOUND is not "on"/);
  assert.equal(off.fake.calls.length, 0);
});

test("[VOICE-003] callback requests become consented outbound requests that still wait for approval", async () => {
  const t = await outboundApp([{ status: 201, body: { call_id: "call_out_1" } }], MON_2PM);
  await t.post("/api/webhooks/retell/functions", fn("c_cb", "request_callback", { name: "Cal Back", phone: "555-010-0141", reason: "Wants to talk about a store", preferred_time: "afternoons" }, { from_number: "+15550100141" }));
  const req = await one<{ id: string; status: string; consent_id: string; purpose: string; phone_e164: string; lead_id: string }>(t.db, `SELECT * FROM voice_outbound_requests`);
  assert.equal(req.status, "pending_approval");
  assert.equal(req.purpose, "callback");
  assert.equal(req.phone_e164, "+15550100141");
  assert.ok(req.consent_id && req.lead_id);
  assert.equal((await t.run()).dialled, 0, "nothing dials before approval");
  await decideOutbound(t.db, t.owner.id, req.id, "approve");
  assert.equal((await t.run()).dialled, 1);
  const sent = t.fake.calls[0];
  assert.equal(sent.url, "https://api.retellai.com/v2/create-phone-call");
  assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
  assert.equal(sent.body.to_number, "+15550100141");
  assert.equal(sent.body.from_number, "+15550109999");
  assert.equal(sent.body.override_agent_id, "agent_outbound_1");
  assert.equal(sent.body.honor_internal_dnc, true);
  assert.match(sent.body.idempotency_key, /^crestmont_vob_[A-Za-z0-9_-]+_a1$/);
  assert.deepEqual(sent.body.metadata, { crestmont_env: "development", crestmont_outbound_request_id: req.id, crestmont_test: "false" });
  for (const v of Object.values(sent.body.retell_llm_dynamic_variables)) assert.equal(typeof v, "string");
  assert.doesNotMatch(JSON.stringify(sent.body), /store|afternoons/, "internal reasons are never sent to Retell");
  assert.doesNotMatch(JSON.stringify(sent.body), new RegExp(KEY), "the API key is only in the Authorization header");
  const call = await one<{ direction: string; to_number: string; outbound_request_id: string; environment: string }>(t.db, `SELECT direction, to_number, outbound_request_id, environment FROM calls WHERE provider_call_id = 'call_out_1'`);
  assert.deepEqual({ ...call }, { direction: "outbound", to_number: "+15550100141", outbound_request_id: req.id, environment: "development" });
  // A second run does not dial the same request again.
  assert.equal((await t.run()).dialled, 0);
  assert.equal(t.fake.calls.length, 1);
  // Retell reports the result through call_ended.
  await t.post("/api/webhooks/retell", { event: "call_ended", call: { ...phoneCall("call_out_1"), direction: "outbound", from_number: "+15550109999", to_number: "+15550100141", disconnection_reason: "agent_hangup", transcript: "Agent: hi", call_cost: { combined_cost: 5 }, metadata: { crestmont_env: "development" } } });
  assert.equal((await one<{ status: string; cost_microusd: number }>(t.db, `SELECT status, cost_microusd FROM voice_outbound_requests WHERE id = ?`, req.id)).status, "completed");
  const a = await voiceAnalytics(t.db, new Date(0));
  assert.equal(a.outbound, 1);
  assert.equal(a.outboundCompleted, 1);
});

test("[VOICE-003] outbound eligibility: consent required, DNC and opt-out enforced, quiet hours and per-number caps", async () => {
  const t = await outboundApp([{ status: 201, body: { call_id: "call_e1" } }, { status: 201, body: { call_id: "call_e2" } }], MON_2PM);
  // No consent → approval refused.
  const noConsent = await requestOutbound(t.db, { purpose: "support_followup", phone: "+15550100150", reason: "Follow up on ticket", requestedBy: t.owner.id });
  await assert.rejects(decideOutbound(t.db, t.owner.id, noConsent.id, "approve"), /No recorded consent/);
  // Consent for a different purpose does not count.
  await recordCallConsent(t.db, "+15550100150", "callback", "staff_recorded", "Asked by email", t.owner.id);
  await assert.rejects(decideOutbound(t.db, t.owner.id, noConsent.id, "approve"), /No recorded consent/);
  // DNC blocks at creation and cancels anything pending.
  await addDnc(t.db, "+15550100151", "staff", "Asked us to stop", t.owner.id);
  const dnc = await requestOutbound(t.db, { purpose: "callback", phone: "+15550100151", reason: "x x x", consentEvidence: "said yes earlier", requestedBy: t.owner.id });
  assert.equal(dnc.status, "blocked");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM voice_call_consents WHERE phone_e164 = '+15550100151'`), 0, "no consent can be recorded for a DNC number");
  // Approved, then the person opts out by phone before the dial: the request is cancelled and never dialled.
  const r = await requestOutbound(t.db, { purpose: "callback", phone: "+15550100152", reason: "Callback", consentEvidence: "Caller asked on a call", requestedBy: t.owner.id });
  await decideOutbound(t.db, t.owner.id, r.id, "approve");
  await t.post("/api/webhooks/retell/functions", fn("c_opt", "record_opt_out", {}, { from_number: "+15550100152" }));
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM voice_outbound_requests WHERE id = ?`, r.id)).status, "cancelled");
  assert.equal((await t.run()).dialled, 0);
  // Quiet hours: 09:00 ET is 06:00 PT, so the request waits for the window (no dial, no failure).
  const early = await outboundApp([{ status: 201, body: { call_id: "call_e3" } }], MON_9AM);
  const r2 = await requestOutbound(early.db, { purpose: "callback", phone: "+15550100153", reason: "Callback", consentEvidence: "Caller asked on a call", requestedBy: early.owner.id });
  await decideOutbound(early.db, early.owner.id, r2.id, "approve");
  assert.equal((await early.run()).dialled, 0);
  const waiting = await one<{ status: string; next_attempt_at: string }>(early.db, `SELECT status, next_attempt_at FROM voice_outbound_requests WHERE id = ?`, r2.id);
  assert.equal(waiting.status, "approved");
  assert.equal(waiting.next_attempt_at, "2026-11-02T19:00:00.000Z", "09:00 in Hawaii, the last US zone to reach the window");
  assert.equal(early.fake.calls.length, 0);
  // Daily cap: one call per number per day.
  const r3 = await requestOutbound(t.db, { purpose: "callback", phone: "+15550100154", reason: "Callback", consentEvidence: "Caller asked on a call", requestedBy: t.owner.id });
  await decideOutbound(t.db, t.owner.id, r3.id, "approve");
  assert.equal((await t.run()).dialled, 1);
  const r4 = await requestOutbound(t.db, { purpose: "callback", phone: "+15550100154", reason: "Second callback", consentEvidence: "Caller asked again", requestedBy: t.owner.id });
  await decideOutbound(t.db, t.owner.id, r4.id, "approve");
  assert.equal((await t.run()).dialled, 0);
  assert.match((await one<{ status_detail: string }>(t.db, `SELECT status_detail FROM voice_outbound_requests WHERE id = ?`, r4.id)).status_detail, /daily call limit/);
});

test("[VOICE-003] outbound failures: bounded retries with the same idempotency key, no-answer retry then human review, provider DNC", async () => {
  // 429 then 500 then 201: retried inside one attempt with an identical idempotency key.
  const t = await outboundApp([{ status: 429 }, { status: 500 }, { status: 201, body: { call_id: "call_f1" } }], MON_2PM);
  const r = await requestOutbound(t.db, { purpose: "callback", phone: "+15550100160", reason: "Callback", consentEvidence: "Caller asked on a call", requestedBy: t.owner.id });
  await decideOutbound(t.db, t.owner.id, r.id, "approve");
  assert.equal((await t.run()).dialled, 1);
  assert.equal(t.fake.calls.length, 3);
  assert.equal(new Set(t.fake.calls.map((c) => c.body.idempotency_key)).size, 1);
  // No answer: one more attempt later (back to approved), then a human task.
  const ended = (id: string, reason: string) => t.post("/api/webhooks/retell", { event: "call_ended", call: { ...phoneCall(id), direction: "outbound", to_number: "+15550100160", from_number: "+15550109999", disconnection_reason: reason } });
  await ended("call_f1", "dial_no_answer");
  const after = await one<{ status: string; next_attempt_at: string }>(t.db, `SELECT status, next_attempt_at FROM voice_outbound_requests WHERE id = ?`, r.id);
  assert.equal(after.status, "approved");
  assert.ok(after.next_attempt_at);
  await ended("call_f1", "dial_no_answer");
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM voice_outbound_requests WHERE id = ?`, r.id)).status, "approved", "a retried webhook does not consume another attempt");
  await t.db.prepare(`UPDATE voice_outbound_requests SET status = 'dialing', attempts = 2 WHERE id = ?`).bind(r.id).run();
  await t.db.prepare(`INSERT INTO calls (id, provider, provider_call_id, direction, to_number, started_at, outbound_request_id) VALUES ('call_row_f2','retell','call_f2','outbound','+15550100160',?,?)`).bind(new Date().toISOString(), r.id).run();
  await ended("call_f2", "voicemail_reached");
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM voice_outbound_requests WHERE id = ?`, r.id)).status, "no_answer");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM notifications WHERE kind = 'voice_outbound'`), 1);
  // Non-retryable provider error → failed and escalated to a person, without retrying.
  const t2 = await outboundApp([{ status: 402, body: { error: "payment required" } }], MON_2PM);
  const r2 = await requestOutbound(t2.db, { purpose: "callback", phone: "+15550100161", reason: "Callback", consentEvidence: "Caller asked on a call", requestedBy: t2.owner.id });
  await decideOutbound(t2.db, t2.owner.id, r2.id, "approve");
  await t2.run();
  assert.equal(t2.fake.calls.length, 1);
  assert.equal((await one<{ status: string }>(t2.db, `SELECT status FROM voice_outbound_requests WHERE id = ?`, r2.id)).status, "failed");
  // The recipient tells the agent not to call again → Retell user_requested_dnc → DNC list.
  const t3 = await outboundApp([{ status: 201, body: { call_id: "call_f3" } }], MON_2PM);
  const r3 = await requestOutbound(t3.db, { purpose: "callback", phone: "+15550100162", reason: "Callback", consentEvidence: "Caller asked on a call", requestedBy: t3.owner.id });
  await decideOutbound(t3.db, t3.owner.id, r3.id, "approve");
  await t3.run();
  await t3.post("/api/webhooks/retell", { event: "call_ended", call: { ...phoneCall("call_f3"), direction: "outbound", to_number: "+15550100162", disconnection_reason: "user_requested_dnc" } });
  assert.equal(await count(t3.db, `SELECT COUNT(*) n FROM voice_dnc WHERE phone_e164 = '+15550100162' AND source = 'provider_dnc'`), 1);
});

test("[VOICE-003] Retell API client: timeouts and network errors are retryable and bounded; credentials are never echoed", async () => {
  const neverKey = await createRetellPhoneCall({ apiKey: undefined, fetch: (async () => new Response()) as unknown as typeof fetch, body: { from_number: "+1", to_number: "+1", idempotency_key: "abcde" } });
  assert.deepEqual([neverKey.ok, neverKey.attempts], [false, 0]);
  let n = 0;
  const flaky = (async () => { n++; throw new TypeError("network down"); }) as unknown as typeof fetch;
  const res = await createRetellPhoneCall({ apiKey: KEY, fetch: flaky, sleep: async () => {}, maxRetries: 2, body: { from_number: "+15550109999", to_number: "+15550100170", idempotency_key: "crestmont_test_1" } });
  assert.equal(res.ok, false);
  assert.equal(n, 3, "1 attempt + 2 retries, never unbounded");
  const echo = (async () => new Response(`bad key ${KEY}`, { status: 401 })) as unknown as typeof fetch;
  const r401 = await createRetellPhoneCall({ apiKey: KEY, fetch: echo, sleep: async () => {}, body: { from_number: "+15550109999", to_number: "+15550100170", idempotency_key: "crestmont_test_2" } });
  assert.equal(r401.ok, false);
  assert.equal((r401 as { retryable: boolean }).retryable, false);
});

// ───────────── Privacy, redaction, analytics ─────────────

test("[VOICE-006] [SEC-006] card numbers and SSNs are removed from function arguments and consented transcripts", async () => {
  assert.equal(redactSensitive("card 4111 1111 1111 1111 exp"), "card [card number removed] exp");
  assert.equal(redactSensitive("call +1 555 010 0123"), "call +1 555 010 0123", "phone numbers are not card numbers");
  assert.equal(redactSensitive("ssn 123-45-6789"), "ssn [SSN removed]");
  const t = await app();
  await t.post("/api/webhooks/retell", { event: "call_started", call: phoneCall("c_red") });
  await t.post("/api/webhooks/retell/functions", fn("c_red", "record_consent", { consent: true }));
  await t.post("/api/webhooks/retell/functions", fn("c_red", "create_lead", { name: "Rex Redact", phone: "+15550100180", interest: "business", requirements: "Pay deposit with 4111-1111-1111-1111 please" }));
  await t.post("/api/webhooks/retell", { event: "call_ended", call: phoneCall("c_red", { transcript: "User: my card is 4111 1111 1111 1111" }) });
  const dump = JSON.stringify([
    (await t.db.prepare(`SELECT message FROM leads`).all()).results, (await t.db.prepare(`SELECT transcript FROM calls`).all()).results,
    (await t.db.prepare(`SELECT result_json, detail FROM voice_events`).all()).results,
  ]);
  assert.doesNotMatch(dump, /4111/);
  assert.match(dump, /card number removed/);
});

test("[VOICE-005] analytics: answered vs missed, durations, consultations, test calls excluded, unknown cost never priced", async () => {
  const t = await schedulingApp();
  const end = (id: string, extra: Record<string, unknown>) => t.post("/api/webhooks/retell", { event: "call_ended", call: phoneCall(id, extra) });
  await t.post("/api/webhooks/retell/functions", fn("c_a1", "book_consultation", { name: "Ana Lytics", phone: "+15550100190", start_time: "2026-11-03T14:00:00.000Z", topic: "Website" }));
  await end("c_a1", { transcript: "x", duration_ms: 120_000, call_cost: { combined_cost: 20 } });
  await end("c_a2", { duration_ms: 4_000, disconnection_reason: "user_hangup" }); // missed: no conversation
  await end("c_a3", { call_type: "web_call", duration_ms: 50_000, transcript: "x" }); // test call
  await end("c_a4", { transcript: "x", disconnection_reason: "error_asr", call_status: "error" }); // failed, cost unknown
  const a = await voiceAnalytics(t.db, new Date(0));
  assert.equal(a.inbound, 3);
  assert.equal(a.answered, 1);
  assert.equal(a.missed, 1);
  assert.equal(a.failed, 1);
  assert.equal(a.consultationsBooked, 1);
  assert.equal(a.leadsCaptured, 1);
  assert.equal(a.testCallsExcluded, 1);
  assert.equal(a.averageDurationSeconds, 62);
  assert.equal(a.costKnownMicroUsd, 200_000);
  assert.equal(a.costUnknownCalls, 2);
  // The Owner page renders the same figures.
  const c = t.client(); await c.login(t.owner.email, TEST_PASSWORD, t.owner.secret);
  const page = await (await c.get("/staff/voice/operations")).text();
  assert.match(page, /Consultations booked/);
  assert.match(page, /Ana Lytics/);
});

test("[VOICE-006] [SEC-006] caller erasure clears receptionist data for a number but keeps the do-not-call entry", async () => {
  const t = await schedulingApp();
  const from = { from_number: "+15550100195" };
  await t.post("/api/webhooks/retell/functions", fn("c_er", "record_consent", { consent: true }, from));
  await t.post("/api/webhooks/retell/functions", fn("c_er", "book_consultation", { name: "Erin Erase", phone: "+15550100195", email: "erin@example.com", start_time: "2026-11-03T14:00:00.000Z", topic: "Private details" }, from));
  await t.post("/api/webhooks/retell/functions", fn("c_er", "request_callback", { name: "Erin Erase", phone: "+15550100195", reason: "Private" }, from));
  await t.post("/api/webhooks/retell", { event: "call_ended", call: phoneCall("c_er", { ...from, transcript: "User: private words" }) });
  await addDnc(t.db, "+15550100195", "caller_request", "asked", null);
  await assert.rejects(eraseCallerData(t.db, t.owner.id, "+15550100195", "x"), /Describe the request/);
  const n = await eraseCallerData(t.db, t.owner.id, "(555) 010-0195", "Caller emailed asking for deletion");
  assert.deepEqual(n, { calls: 1, consultations: 1, contacts: 1 });
  const dump = JSON.stringify([
    (await t.db.prepare(`SELECT from_number, transcript, summary FROM calls`).all()).results,
    (await t.db.prepare(`SELECT name, phone, email, topic FROM consultations`).all()).results,
    (await t.db.prepare(`SELECT name, email, phone FROM contacts`).all()).results,
    (await t.db.prepare(`SELECT * FROM voice_call_consents`).all()).results,
    (await t.db.prepare(`SELECT * FROM voice_outbound_requests`).all()).results,
  ]);
  assert.doesNotMatch(dump, /Erin|erin@|0195|private/i);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM voice_dnc WHERE phone_e164 = '+15550100195'`), 1, "opt-out still honoured");
  const log = await one<{ subject_id: string; details_json: string }>(t.db, `SELECT subject_id, details_json FROM audit_logs WHERE action = 'voice.caller_data_erased'`);
  assert.equal(log.subject_id, "…0195");
});

test("[VOICE-005] [SEC-001] Owner operations page: settings round-trip with validation; secrets never rendered", async () => {
  const t = await app({}, MON_9AM);
  const c = t.client(); await c.login(t.owner.email, TEST_PASSWORD, t.owner.secret);
  const bad = await c.post("/staff/voice/operations/settings", { timezone: "America/Detroit", "hours.mon": "9am to 5", "inbound.mode": "answer" });
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /write hours like 09:00-17:00/);
  const noNumber = await c.post("/staff/voice/operations/settings", { timezone: "America/Detroit", "hours.mon": "09:00-17:00", "transfer.enabled": "1", "inbound.mode": "answer" });
  assert.equal(noNumber.status, 422);
  const ok = await c.post("/staff/voice/operations/settings", { timezone: "America/Detroit", "hours.mon": "09:00-12:00, 13:00-17:00", holidays: "2026-12-25", "inbound.mode": "answer",
    "scheduling.enabled": "1", "scheduling.duration_minutes": "45", "scheduling.min_notice_hours": "24", "scheduling.horizon_days": "14",
    "outbound.window_start": "10:00", "outbound.window_end": "19:00", "outbound.max_per_number_per_day": "1", "outbound.max_per_number_per_week": "2" });
  assert.equal(ok.status, 303);
  const cfg = await loadVoiceConfig(t.db);
  assert.deepEqual(cfg.hours.mon, [{ open: "09:00", close: "12:00" }, { open: "13:00", close: "17:00" }]);
  assert.equal(cfg.scheduling.duration_minutes, 45);
  assert.deepEqual(cfg.holidays, ["2026-12-25"]);
  const page = await (await c.get("/staff/voice/operations")).text();
  assert.doesNotMatch(page, new RegExp(KEY));
  assert.match(page, /Outbound calling: <span[^>]*>Disabled/);
  // Non-owner staff cannot reach it.
  const admin = await createStaff(t.db, "administrator");
  const a = t.client(); await a.login(admin.email, TEST_PASSWORD, admin.secret);
  assert.equal((await a.get("/staff/voice/operations")).status, 403);
});


// ───────────── Regressions from the independent review ─────────────

test("[VOICE-003] [SEC-002] a caller cannot record call consent for someone else's number", async () => {
  const t = await schedulingApp();
  await t.post("/api/webhooks/retell/functions", fn("c_c1", "request_callback", { name: "Mal Icious", phone: "+15550100777", reason: "Call my neighbour" }, { from_number: "+15550100123" }));
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM voice_call_consents`), 0);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM voice_outbound_requests`), 0, "a task for a person is created, never a consented call request");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM crm_activities WHERE kind = 'task'`), 1);
  await t.post("/api/webhooks/retell/functions", fn("c_c2", "book_consultation", { name: "Mal Icious", phone: "+15550100778", start_time: "2026-11-03T14:00:00.000Z", topic: "x y z", reminder_call_ok: true }));
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM voice_call_consents`), 0);
});

test("[VOICE-004] booking for a different number never reveals whether that number has a booking; no lead when scheduling is off", async () => {
  const off = await app({}, MON_9AM);
  const r = await off.post("/api/webhooks/retell/functions", fn("c_off", "book_consultation", { name: "Nora Off", phone: "+15550100200", start_time: "2026-11-03T14:00:00.000Z", topic: "Site" }));
  assert.equal(r.json.booked, false);
  assert.equal(await count(off.db, `SELECT COUNT(*) n FROM leads`), 0);
  const t = await schedulingApp();
  await t.post("/api/webhooks/retell/functions", fn("c_e1", "book_consultation", { name: "Owen Own", phone: "+15550100201", start_time: "2026-11-03T14:00:00.000Z", topic: "Site" }, { from_number: "+15550100201" }));
  const probe = await t.post("/api/webhooks/retell/functions", fn("c_e2", "book_consultation", { name: "Pry", phone: "+15550100201", start_time: "2026-11-03T15:00:00.000Z", topic: "Probe" }, { from_number: "+15550100999" }));
  assert.notEqual(probe.json.already_booked, true);
  const own = await t.post("/api/webhooks/retell/functions", fn("c_e3", "book_consultation", { name: "Owen Own", phone: "+15550100201", start_time: "2026-11-03T16:00:00.000Z", topic: "Again" }, { from_number: "+15550100201" }));
  assert.equal(own.json.already_booked, true, "the caller's own number still gets their booking back");
});

test("[VOICE-003] read-only answers are fresh on repeat; a failed attempt is retried, not replayed", async () => {
  const t = await schedulingApp();
  const first = await t.post("/api/webhooks/retell/functions", fn("c_ro", "check_consultation_availability", {}));
  await t.post("/api/webhooks/retell/functions", fn("c_ro2", "book_consultation", { name: "Taker", phone: "+15550100210", start_time: first.json.slots[0].start_time, topic: "Site" }, { from_number: "+15550100210" }));
  const again = await t.post("/api/webhooks/retell/functions", fn("c_ro", "check_consultation_availability", {}));
  assert.notEqual(again.json.slots[0].start_time, first.json.slots[0].start_time, "identical request on the same call sees the new booking");
  // Simulate a stored failed attempt for a write function: the retry runs again instead of returning the error.
  const args = { name: "Retry Ray", phone: "+15550100211", interest: "business", requirements: "A website please" };
  const ok1 = await t.post("/api/webhooks/retell/functions", fn("c_rt", "create_lead", args));
  assert.equal(ok1.json.leadCreated, true);
  await t.db.prepare(`UPDATE voice_events SET status = 'error', result_json = '{"error":"x"}' WHERE kind = 'fn:create_lead'`).run();
  await t.db.prepare(`DELETE FROM crm_activities`).run();
  await t.db.prepare(`UPDATE calls SET lead_id = NULL`).run();
  const ok2 = await t.post("/api/webhooks/retell/functions", fn("c_rt", "create_lead", args));
  assert.equal(ok2.json.leadCreated, true);
});

test("[VOICE-003] outbound recovery: webhook-first call rows are linked; lost results are swept to a person; timeouts reuse the key", async () => {
  // call_started (with Retell metadata) arrives before create-phone-call returns.
  let tRef: Awaited<ReturnType<typeof outboundApp>> | null = null;
  const fake = { calls: [] as FakeCall[] };
  const t = await outboundApp([{ status: 201, body: { call_id: "call_w1" } }], MON_2PM);
  tRef = t;
  const r = await requestOutbound(t.db, { purpose: "callback", phone: "+15550100220", reason: "Callback", consentEvidence: "Caller asked on a call", requestedBy: t.owner.id });
  await decideOutbound(t.db, t.owner.id, r.id, "approve");
  await t.post("/api/webhooks/retell", { event: "call_started", call: { ...phoneCall("call_w1"), direction: "outbound", from_number: "+15550109999", to_number: "+15550100220", metadata: { crestmont_env: "development", crestmont_outbound_request_id: r.id, crestmont_test: "true" } } });
  assert.equal(await count(tRef.db, `SELECT COUNT(*) n FROM calls WHERE provider_call_id = 'call_w1' AND outbound_request_id = ? AND is_test = 1`, r.id), 1, "metadata links the row and the string test flag is honoured");
  await t.run();
  await t.post("/api/webhooks/retell", { event: "call_ended", call: { ...phoneCall("call_w1"), direction: "outbound", to_number: "+15550100220", disconnection_reason: "agent_hangup", metadata: { crestmont_env: "development", crestmont_outbound_request_id: r.id } } });
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM voice_outbound_requests WHERE id = ?`, r.id)).status, "completed");
  void fake;

  // Lost result: stuck in 'dialing' past the threshold → failed + human notification, never re-dialled.
  const r2 = await requestOutbound(t.db, { purpose: "callback", phone: "+15550100221", reason: "Callback", consentEvidence: "Caller asked on a call", requestedBy: t.owner.id });
  await t.db.prepare(`UPDATE voice_outbound_requests SET status = 'dialing', approved_by = ?, updated_at = '2026-11-02T10:00:00.000Z' WHERE id = ?`).bind(t.owner.id, r2.id).run();
  const before = t.fake.calls.length;
  await t.run();
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM voice_outbound_requests WHERE id = ?`, r2.id)).status, "failed");
  assert.equal(t.fake.calls.length, before);

  // Timeouts: every run reuses the same idempotency key, and the request is bounded.
  const slow = await outboundApp([{ status: 503 }], MON_2PM);
  const r3 = await requestOutbound(slow.db, { purpose: "callback", phone: "+15550100222", reason: "Callback", consentEvidence: "Caller asked on a call", requestedBy: slow.owner.id });
  await decideOutbound(slow.db, slow.owner.id, r3.id, "approve");
  for (let i = 0; i < 4; i++) { await slow.db.prepare(`UPDATE voice_outbound_requests SET next_attempt_at = NULL WHERE id = ?`).bind(r3.id).run(); await slow.run(); }
  assert.equal(new Set(slow.fake.calls.map((c) => c.body.idempotency_key)).size, 1, "never a second key while the first outcome is unknown");
  assert.equal(slow.fake.calls.length, 9, "3 runs × (1 + 2 in-run retries), then handed to a person");
  assert.equal((await one<{ status: string }>(slow.db, `SELECT status FROM voice_outbound_requests WHERE id = ?`, r3.id)).status, "failed");
  await assert.rejects(requestOutbound(slow.db, { purpose: "callback", phone: "+442071234567", reason: "Callback", requestedBy: slow.owner.id }), /\+1/);
});

test("[VOICE-006] call_analyzed summaries are redacted; erasure scrubs CRM notes, lead text and notifications", async () => {
  const t = await app();
  const from = { from_number: "+15550100230" };
  await t.post("/api/webhooks/retell/functions", fn("c_s1", "record_consent", { consent: true }, from));
  await t.post("/api/webhooks/retell/functions", fn("c_s1", "request_callback", { name: "Sam Scrub", phone: "+15550100230", reason: "Talk about card 4111 1111 1111 1111" }, from));
  await t.post("/api/webhooks/retell", { event: "call_ended", call: phoneCall("c_s1", { ...from, transcript: "hi" }) });
  await t.post("/api/webhooks/retell", { event: "call_analyzed", call: phoneCall("c_s1", { ...from, call_analysis: { call_summary: "Caller read card 4111 1111 1111 1111" } }) });
  assert.doesNotMatch((await one<{ summary: string }>(t.db, `SELECT summary FROM calls`)).summary, /4111/);
  await t.post("/api/webhooks/retell", { event: "call_ended", call: phoneCall("c_s2", { from_number: "+15550100230" }) }); // missed call notification
  await eraseCallerData(t.db, t.owner.id, "+15550100230", "Caller asked by email");
  const dump = JSON.stringify([
    (await t.db.prepare(`SELECT body FROM crm_activities`).all()).results, (await t.db.prepare(`SELECT message FROM leads`).all()).results,
    (await t.db.prepare(`SELECT body FROM notifications`).all()).results,
  ]);
  assert.doesNotMatch(dump, /Sam|0230/);
});
