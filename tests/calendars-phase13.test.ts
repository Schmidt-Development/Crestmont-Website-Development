// Phase 13 (Founder directive 2026-11-08): both internal calendars and the Retell appointment automation, end to end.
//  13.1  appointments booked through the SAME code path Retell's function webhook uses (HMAC-signed fixtures through
//        the real router), on the right calendar, in the business time zone, tied to the CRM lead; duplicates refused;
//        reschedule, cancel, call scheduling, completion, staff visibility and access.
//  13.2  one internal email per appointment event, to the internal mailbox only, with the facts needed to act.
//  13.3  the outbound agent knows the appointment (dynamic variables + get_outbound_lead_context) and the dialler never
//        calls early, twice, after an opt-out or after a cancellation, and never misses a scheduled callback.
// FIXTURES ONLY: an in-memory D1, a local fake for Retell's create-phone-call; nothing is dialled or emailed for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { signRetell } from "../src/adapters/retell.ts";
import { defaultVoiceConfig, saveVoiceConfig, slotLabel, type VoiceConfig } from "../src/services/voice-settings.ts";
import * as SO from "../src/services/sales-outbound.ts";
import * as sched from "../src/services/voice-scheduling.ts";
import * as outbound from "../src/services/voice-outbound.ts";
import { captureLead } from "../src/services/leads.ts";
import { syncAppointmentCallback, cancelAppointmentCallback } from "../src/services/appointment-callbacks.ts";
import { INTERNAL_NOTIFY_EMAIL } from "../src/services/internal-notify.ts";

const IN = "key_fixture_phase13_inbound_001";
const OUT = "key_fixture_phase13_outbound_01";
const TZ = "America/Chicago";
const MON_9AM_CT = new Date("2026-11-02T15:00:00Z");
const CALLER = "+13125550142";
const FOUNDER_ROUTE = { calendar: "founder_callback" as const, founderReason: "customer_requested_founder" as const };

function cfg(): VoiceConfig {
  const c = defaultVoiceConfig();
  c.timezone = TZ;
  for (const d of ["mon", "tue", "wed", "thu", "fri"] as const) c.hours[d] = [{ open: "09:00", close: "17:00" }];
  c.scheduling.enabled = true;
  c.scheduling.founder_hours.tue = [{ open: "10:00", close: "12:00" }];
  return c;
}

type Row = Record<string, any>;

async function world(start = MON_9AM_CT) {
  const t = await createTestApp({ RETELL_INBOUND_API_KEY: IN, RETELL_OUTBOUND_API_KEY: OUT } as Partial<Env>);
  let clock = start, n = 0;
  const dials: Row[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => { dials.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ call_id: `call_p13_${++n}`, call_status: "registered" }), { status: 201 }); }) as unknown as typeof fetch;
  t.env.overrides = { storage: t.storage, now: () => clock, fetch: fetchImpl } as Env["overrides"];
  const owner = await createStaff(t.db, "owner");
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('voice.monthly_budget_usd', '50', ?)`).bind(start.toISOString()).run();
  await saveVoiceConfig(t.db, owner.id, cfg());
  // Scheduled AI Callbacks are ON at launch; cold outreach stays OFF. No RETELL_SALES_OUTBOUND, no compliance approval.
  await SO.saveSalesSettings(t.db, owner.id, { enabled: false, agentId: "agent_sales_phase13", fromNumber: "+13125550100", maxConcurrent: 15, maxPerRun: 20, maxPerDay: 25, maxAttempts: 2, retryAfterHours: 48 });
  const c = t.client();
  const signed = async (path: string, key: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    const res = await c.request("POST", path, { body, headers: { "content-type": "application/json", "x-retell-signature": await signRetell(key, body) } });
    return { status: res.status, json: (await res.json()) as Row };
  };
  /** The receptionist's custom-function webhook, exactly as Retell calls it. */
  const inbound = async (callId: string, name: string, args: Row, from = CALLER) =>
    (await signed("/api/webhooks/retell/functions", IN, { name, call: { call_id: callId, call_type: "phone_call", from_number: from, to_number: "+13125559999", direction: "inbound" }, args })).json;
  const salesCall = (callId: string, salesId: string, to: string) => ({ call_id: callId, call_type: "phone_call", direction: "outbound", from_number: "+13125550100", to_number: to, agent_id: "agent_sales_phase13",
    metadata: { crestmont_env: "development", crestmont_sales_call_id: salesId, crestmont_test: "true" } });
  /** The outbound sales agent's custom-function webhook. */
  const salesFn = async (callId: string, salesId: string, to: string, name: string, args: Row = {}) =>
    signed("/api/webhooks/retell/outbound/functions", OUT, { name, call: salesCall(callId, salesId, to), args });
  /** Retell's call event webhook, signed by the sales (outbound) workspace. */
  const event = async (payload: Row) => signed("/api/webhooks/retell", OUT, payload);
  const queue = () => SO.processSalesQueue({ db: t.db, env: { RETELL_OUTBOUND_API_KEY: OUT, RETELL_INBOUND_API_KEY: IN, ENVIRONMENT: "development" }, fetch: fetchImpl, now: () => clock, sleep: async () => {} } as never);
  const internal = async () => (await t.db.prepare(`SELECT d.template, d.to_email, d.idempotency_key, m.subject, m.text_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id
      WHERE d.idempotency_key LIKE 'internal:%' ORDER BY d.created_at, d.rowid`).all<{ template: string; to_email: string; idempotency_key: string; subject: string; text_body: string }>()).results;
  const one = <T = Row>(sql: string, ...b: unknown[]) => t.db.prepare(sql).bind(...b).first<T>() as Promise<T>;
  const count = async (sql: string, ...b: unknown[]) => (await t.db.prepare(sql).bind(...b).first<{ n: number }>())!.n;
  const ownerClient = await t.client().login(owner.email, TEST_PASSWORD, owner.secret);
  /** Books an AI Follow-Up appointment the way the receptionist does: real slots first, then the caller's choice. */
  const bookAi = async (callId: string, from: string, name: string, topic: string, preferred?: string) => {
    const av = await inbound(callId, "check_consultation_availability", preferred ? { preferred_date: preferred } : {}, from);
    assert.equal(av.available, true, JSON.stringify(av));
    const b = await inbound(callId, "book_consultation", { name, phone: from, start_time: av.slots[0].start_time, topic }, from);
    assert.equal(b.booked, true, JSON.stringify(b));
    const row = await one<Row>(`SELECT * FROM consultations WHERE confirmation_code = ?`, b.confirmation_code);
    return { av, b, row };
  };
  return { ...t, owner, inbound, salesFn, event, queue, internal, one, count, ownerClient, bookAi, dials, setClock: (d: Date) => { clock = d; }, now: () => clock };
}

const ctLabel = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));

// ───────────── 13.1 + 13.2: AI Follow-Up calendar ─────────────

test("[VOICE-003] [EMAIL-002] AI Follow-Up appointment via the signed Retell webhook: calendar, time zone, lead, duplicates, reschedule, cancel; one internal email per event", async () => {
  const t = await world();
  const { av, b, row } = await t.bookAi("c13_1", CALLER, "Dana Prospect", "Wants a quote for a five-page bakery site");
  // Calendar selection and date/time/time zone: offered and stored in the business zone, kept as UTC.
  assert.equal(av.calendar, "ai_follow_up");
  assert.equal(av.timezone, TZ);
  assert.match(av.slots[0].label, /CST/, "slots are labelled in the business time zone");
  assert.equal(b.calendar, "ai_follow_up");
  assert.equal(b.status, "confirmed", "an AI follow-up is confirmed when booked");
  assert.equal(b.when, slotLabel(row.starts_at, TZ));
  assert.equal(row.starts_at, new Date(av.slots[0].start_time).toISOString());
  assert.equal(row.calendar, "ai_follow_up");
  assert.equal(row.founder_reason, null);
  assert.equal(row.timezone, TZ);
  assert.equal(row.duration_minutes, 30);
  assert.equal(row.source, "ai_receptionist");
  // Customer and lead association: the booking points at the CRM lead whose contact is the caller.
  assert.ok(row.lead_id);
  const contact = await t.one<Row>(`SELECT c.name, c.phone FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.id = ?`, row.lead_id);
  assert.equal(contact.name, "Dana Prospect");
  assert.equal(String(contact.phone).replace(/\D/g, "").slice(-10), "3125550142");
  assert.equal(await t.count(`SELECT COUNT(*) n FROM crm_activities WHERE lead_id = ? AND body LIKE '%calendar: AI Follow-Up%'`, row.lead_id), 1, "the CRM record notes the booking");
  // Call scheduling: one AI callback queued at the appointment time with the conversation context.
  const cb = await t.one<Row>(`SELECT * FROM sales_calls WHERE appointment_id = ?`, row.id);
  assert.equal(cb.mode, "callback");
  assert.equal(cb.status, "queued", cb.status_detail);
  assert.equal(cb.not_before, row.starts_at);
  assert.equal(JSON.parse(cb.context_json).reason, "Wants a quote for a five-page bakery site");
  // 13.2: exactly one internal email, to the internal mailbox, with what is needed to act and nothing more.
  let mails = await t.internal();
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to_email, INTERNAL_NOTIFY_EMAIL);
  assert.equal(mails[0].template, "internal_alert");
  assert.equal(mails[0].idempotency_key, `internal:appointment:${row.id}:booked`);
  for (const must of ["Dana Prospect", CALLER, "AI follow-up call", b.when, TZ, "Wants a quote for a five-page bakery site", `/staff/crm/leads/${row.lead_id}`, "Next action:", row.confirmation_code]) {
    assert.ok(mails[0].text_body.includes(must) || mails[0].subject.includes(must), `email mentions ${must}`);
  }
  assert.equal(await t.count(`SELECT COUNT(*) n FROM email_deliveries WHERE to_email = 'noahschmidt10@gmail.com'`), 0);
  // Duplicate prevention: Retell retrying the same request replays the stored result; a second booking is refused.
  const again = await t.inbound("c13_1", "book_consultation", { name: "Dana Prospect", phone: CALLER, start_time: av.slots[0].start_time, topic: "Wants a quote for a five-page bakery site" });
  assert.equal(again.confirmation_code, b.confirmation_code);
  const second = await t.inbound("c13_2", "book_consultation", { name: "Dana Prospect", phone: CALLER, start_time: av.slots[1].start_time, topic: "Another time" });
  assert.equal(second.already_booked, true, JSON.stringify(second));
  assert.equal(await t.count(`SELECT COUNT(*) n FROM consultations`), 1);
  assert.equal(await t.count(`SELECT COUNT(*) n FROM sales_calls`), 1);
  assert.equal((await t.internal()).length, 1, "no second email for a replay or a refused duplicate");
  // Visibility: on the AI Follow-Up calendar, in the business time zone; never on the Founder calendar.
  const page = await (await t.ownerClient.get("/staff/calendars/ai-follow-up")).text();
  assert.match(page, /Dana Prospect/);
  assert.ok(page.includes(ctLabel(row.starts_at)), `calendar shows ${ctLabel(row.starts_at)} (business time zone)`);
  assert.doesNotMatch(await (await t.ownerClient.get("/staff/calendars/founder-callback")).text(), /Dana Prospect/);
  // Reschedule (reference + phone): a new booking, the old slot freed, the one queued call moved, one email.
  const av2 = await t.inbound("c13_3", "check_consultation_availability", { preferred_date: "2026-11-04" });
  const moved = await t.inbound("c13_3", "reschedule_consultation", { confirmation_code: b.confirmation_code, phone: CALLER, new_start_time: av2.slots[0].start_time });
  assert.equal(moved.rescheduled, true, JSON.stringify(moved));
  const next = await t.one<Row>(`SELECT * FROM consultations WHERE confirmation_code = ?`, moved.confirmation_code);
  assert.equal(next.rescheduled_from, row.id);
  assert.equal(next.lead_id, row.lead_id);
  assert.equal(next.calendar, "ai_follow_up");
  assert.deepEqual({ ...(await t.one<Row>(`SELECT status, cancel_reason FROM consultations WHERE id = ?`, row.id)) }, { status: "cancelled", cancel_reason: "rescheduled" });
  const series = (await t.db.prepare(`SELECT status, not_before, appointment_id FROM sales_calls`).all<Row>()).results;
  assert.deepEqual(series.map((x) => ({ ...x })), [{ status: "queued", not_before: next.starts_at, appointment_id: next.id }], "one call series, moved with its appointment");
  mails = await t.internal();
  assert.equal(mails.length, 2);
  assert.equal(mails[1].idempotency_key, `internal:appointment:${next.id}:rescheduled`);
  assert.match(mails[1].text_body, /Previously:/);
  // Cancellation: the appointment, its queued call and the calendar entry all go; one email.
  const cx = await t.inbound("c13_4", "cancel_consultation", { confirmation_code: moved.confirmation_code, phone: CALLER });
  assert.equal(cx.cancelled, true);
  assert.equal((await t.one<Row>(`SELECT status FROM consultations WHERE id = ?`, next.id)).status, "cancelled");
  assert.equal((await t.one<Row>(`SELECT status FROM sales_calls`)).status, "cancelled");
  mails = await t.internal();
  assert.equal(mails.length, 3);
  assert.equal(mails[2].idempotency_key, `internal:appointment:${next.id}:cancelled`);
  assert.match(mails[2].text_body, /nobody will be dialled/);
  assert.ok(mails.every((m) => m.to_email === INTERNAL_NOTIFY_EMAIL));
  assert.doesNotMatch(await (await t.ownerClient.get("/staff/calendars/ai-follow-up")).text(), /Dana Prospect/, "a cancelled appointment leaves the calendar");
});

// ───────────── 13.1 + 13.2: Founder Callback calendar ─────────────

test("[VOICE-003] [EMAIL-002] [SEC-002] Founder Callback calendar: explicit request only, never dialled by the AI, one detailed email to the internal mailbox, Owner-only view", async () => {
  const t = await world();
  const ask = await t.inbound("f13_1", "check_consultation_availability", { wants_founder: true });
  assert.equal(ask.calendar, "founder_callback");
  assert.equal(ask.slots[0].start_time, "2026-11-03T16:00:00.000Z", "Tuesday 10:00 CST, the Founder's window");
  const b = await t.inbound("f13_1", "book_consultation", { name: "Fay Prospect", phone: CALLER, email: "fay@example.com", start_time: ask.slots[0].start_time, topic: "Wants to discuss a partnership with the Founder", wants_founder: true });
  assert.equal(b.booked, true, JSON.stringify(b));
  assert.equal(b.calendar, "founder_callback");
  assert.equal(b.status, "requested", "held until the Founder confirms");
  const row = await t.one<Row>(`SELECT * FROM consultations WHERE confirmation_code = ?`, b.confirmation_code);
  assert.equal(row.founder_reason, "customer_requested_founder");
  assert.ok(row.lead_id, "linked to the CRM lead");
  assert.equal(await t.count(`SELECT COUNT(*) n FROM sales_calls`), 0, "the AI never dials a Founder appointment");
  // 13.2: one email for the event, the detailed Founder template, to the internal mailbox (not the Founder's own).
  let mails = await t.internal();
  assert.equal(mails.length, 1, "one email per event: no extra internal_alert");
  assert.equal(mails[0].template, "founder_appointment");
  assert.equal(mails[0].to_email, INTERNAL_NOTIFY_EMAIL);
  assert.equal(mails[0].idempotency_key, `internal:founder_callback:${row.id}:booked`);
  for (const must of ["Fay Prospect", CALLER, b.when, TZ, "partnership", `/staff/crm/leads/${row.lead_id}`, "To prepare:", "Confirm or decline"]) assert.ok(mails[0].text_body.includes(must) || mails[0].subject.includes(must), `email mentions ${must}`);
  assert.equal(await t.count(`SELECT COUNT(*) n FROM email_deliveries WHERE to_email = 'noahschmidt10@gmail.com'`), 0);
  // Visibility: on the Founder calendar with its reason, not on AI Follow-Up.
  const fc = await (await t.ownerClient.get("/staff/calendars/founder-callback")).text();
  assert.match(fc, /Fay Prospect/);
  assert.match(fc, /Customer asked for the Founder/);
  assert.ok(fc.includes(ctLabel(row.starts_at)));
  assert.doesNotMatch(await (await t.ownerClient.get("/staff/calendars/ai-follow-up")).text(), /Fay Prospect/);
  // Access permissions.
  const admin = await createStaff(t.db, "administrator");
  const ac = await t.client().login(admin.email, TEST_PASSWORD, admin.secret);
  assert.equal((await ac.get("/staff/calendars/ai-follow-up")).status, 200);
  assert.equal((await ac.get("/staff/calendars/founder-callback")).status, 403);
  const cust = await createCustomer(t.db, "p13.customer@example.com");
  const cc = await t.client().login(cust.email, TEST_PASSWORD);
  for (const p of ["/staff/calendars/ai-follow-up", "/staff/calendars/founder-callback"]) {
    const r = await cc.get(p);
    assert.equal(r.status, 403, p);
    assert.doesNotMatch(await r.text(), /Fay Prospect/);
    const anon = await t.client().get(p);
    assert.ok(anon.status === 303 || anon.status === 401, `${p}: anonymous ${anon.status}`);
  }
  // A Founder callback request (no time agreed) is one internal_alert; a routine callback request sends none.
  await t.inbound("f13_2", "request_callback", { name: "Felix Founder", phone: "+13125550150", reason: "Wants the Founder about a partnership", wants_founder: true }, "+13125550150");
  await t.inbound("f13_3", "request_callback", { name: "Rita Routine", phone: "+13125550151", reason: "Routine pricing question" }, "+13125550151");
  mails = await t.internal();
  assert.equal(mails.length, 2);
  assert.equal(mails[1].template, "internal_alert");
  assert.match(mails[1].idempotency_key, /^internal:founder_callback:cal_/);
  for (const must of ["Felix Founder", "+13125550150", "Wants the Founder about a partnership", "Founder callback requested"]) assert.ok(mails[1].text_body.includes(must) || mails[1].subject.includes(must), must);
  // Staff cancel the Founder appointment: one cancellation email, still to the internal mailbox.
  assert.equal((await t.ownerClient.post(`/staff/voice/consultations/${row.id}/decide`, { decision: "cancel", note: "Founder unavailable" })).status, 303);
  mails = await t.internal();
  assert.equal(mails.length, 3);
  assert.equal(mails[2].idempotency_key, `internal:founder_callback:${row.id}:cancelled`);
  assert.ok(mails.every((m) => m.to_email === INTERNAL_NOTIFY_EMAIL));
});

// ───────────── 13.1 + 13.3: the scheduled call, the agent's context and completion ─────────────

test("[VOICE-005] [VOICE-003] a booked AI appointment is dialled at its time (not before), with the appointment in the agent's context, and completes from the signed call webhook", async () => {
  const t = await world();
  const { b, row } = await t.bookAi("s13_1", CALLER, "Sam Scheduled", "Follow up on the bakery quote");
  const at = new Date(row.starts_at);
  t.setClock(new Date(at.getTime() - 60_000));
  assert.equal((await t.queue()).dialled, 0, "never early");
  t.setClock(at);
  const r = await t.queue();
  assert.equal(r.dialled, 1, r.detail);
  assert.equal(t.dials.length, 1);
  const dial = t.dials[0];
  assert.equal(dial.to_number, CALLER);
  assert.equal(dial.metadata.crestmont_call_mode, "callback");
  assert.equal(dial.retell_llm_dynamic_variables.call_mode, "scheduled_callback");
  assert.equal(dial.retell_llm_dynamic_variables.callback_appointment, b.when, "the agent knows the appointment time (with its zone)");
  assert.equal(dial.retell_llm_dynamic_variables.callback_reason, "Follow up on the bakery quote");
  assert.equal((await t.queue()).dialled, 0, "never twice");
  const sc = await t.one<Row>(`SELECT * FROM sales_calls WHERE appointment_id = ?`, row.id);
  // The agent's authenticated CRM function lists the appointment.
  const ctx = await t.salesFn(sc.provider_call_id, sc.id, CALLER, "get_outbound_lead_context");
  assert.equal(ctx.status, 200, JSON.stringify(ctx.json));
  assert.deepEqual(ctx.json.scheduled_appointments, [{ when: b.when, type: "scheduled AI follow-up call", status: "confirmed", reason: "Follow up on the bakery quote" }]);
  assert.match(ctx.json.instructions, /do not book another/);
  // Completion: Retell's signed call_ended closes the call and the appointment; it leaves the calendar.
  const ended = await t.event({ event: "call_ended", call: { call_id: sc.provider_call_id, call_type: "phone_call", direction: "outbound", from_number: "+13125550100", to_number: CALLER, agent_id: "agent_sales_phase13",
    call_status: "ended", disconnection_reason: "user_hangup", transcript: "Agent: Hi Sam, calling back as arranged.\nUser: Great.", start_timestamp: at.getTime(), end_timestamp: at.getTime() + 300_000,
    metadata: { crestmont_env: "development", crestmont_sales_call_id: sc.id, crestmont_test: "true" } } });
  assert.ok(ended.status < 300, JSON.stringify(ended.json));
  assert.equal((await t.one<Row>(`SELECT status FROM sales_calls WHERE id = ?`, sc.id)).status, "completed");
  assert.equal((await t.one<Row>(`SELECT status FROM consultations WHERE id = ?`, row.id)).status, "completed");
  assert.doesNotMatch(await (await t.ownerClient.get("/staff/calendars/ai-follow-up")).text(), /Sam Scheduled/);
});

// ───────────── 13.3: dialler safety around appointments ─────────────

test("[VOICE-005] a moved appointment whose call was not moved is never dialled at the old time: the call follows the appointment", async () => {
  const t = await world();
  const { row } = await t.bookAi("m13_1", CALLER, "Mo Moved", "Moved appointment");
  // A path that moves the booking but fails to move its queued call (simulated: reschedule without the queue sync).
  const later = new Date(Date.parse(row.starts_at) + 2 * 86_400_000).toISOString();
  const next = await sched.reschedule(t.db, cfg(), t.now(), sched.NO_CALENDAR, row as sched.ConsultationRow, later, { kind: "ai" });
  assert.equal((await t.one<Row>(`SELECT not_before FROM sales_calls`)).not_before, row.starts_at, "precondition: the queue still holds the old time");
  t.setClock(new Date(row.starts_at));
  const r = await t.queue();
  assert.equal(r.dialled, 0, r.detail);
  const moved = await t.one<Row>(`SELECT status, not_before, appointment_id, context_json FROM sales_calls`);
  assert.deepEqual({ status: moved.status, not_before: moved.not_before, appointment_id: moved.appointment_id }, { status: "queued", not_before: next.starts_at, appointment_id: next.id });
  assert.equal(JSON.parse(moved.context_json).appointment_label, slotLabel(next.starts_at, TZ));
  t.setClock(new Date(next.starts_at));
  assert.equal((await t.queue()).dialled, 1);
  assert.equal(t.dials[0].retell_llm_dynamic_variables.callback_appointment, slotLabel(next.starts_at, TZ));
});

test("[VOICE-005] a cancelled appointment is never dialled, even when its queued call was not cancelled", async () => {
  const t = await world();
  const { row } = await t.bookAi("x13_1", CALLER, "Cass Cancelled", "Cancelled appointment");
  await sched.cancel(t.db, row as sched.ConsultationRow, "cancelled by a path that forgot the queue", { kind: "user" });
  assert.equal((await t.one<Row>(`SELECT status FROM sales_calls`)).status, "queued", "precondition: the call is still queued");
  t.setClock(new Date(row.starts_at));
  assert.equal((await t.queue()).dialled, 0);
  assert.equal(t.dials.length, 0);
  const s = await t.one<Row>(`SELECT status, status_detail FROM sales_calls`);
  assert.equal(s.status, "cancelled");
  assert.match(s.status_detail, /Appointment cancelled/);
  // Nor is a receptionist follow-up call about that appointment (e.g. a reminder).
  const req = await outbound.requestOutbound(t.db, { purpose: "consultation_reminder", phone: CALLER, name: "Cass", reason: "Reminder for the appointment", consultationId: row.id, consentEvidence: "Caller asked for a reminder on call x13_1", requestedBy: t.owner.id });
  await outbound.decideOutbound(t.db, t.owner.id, req.id, "approve");
  const el = await outbound.eligibility(t.db, cfg(), (await outbound.getOutbound(t.db, req.id))!, new Date(row.starts_at));
  assert.equal(el.eligible, false);
  assert.match((el as { reason: string }).reason, /cancelled or has ended/);
  await cancelAppointmentCallback(t.db, row.id, "Appointment cancelled");
  assert.equal((await outbound.getOutbound(t.db, req.id))!.status, "cancelled");
});

test("[VOICE-005] a lead who opted out after booking is never called at the appointment time", async () => {
  const t = await world();
  const { row } = await t.bookAi("o13_1", CALLER, "Olive Optout", "Opted out later");
  const opt = await t.inbound("o13_2", "record_opt_out", {});
  assert.equal(opt.recorded, true);
  t.setClock(new Date(row.starts_at));
  assert.equal((await t.queue()).dialled, 0);
  assert.equal(t.dials.length, 0);
  const s = await t.one<Row>(`SELECT status, status_detail FROM sales_calls`);
  assert.notEqual(s.status, "dialing");
  assert.match(s.status_detail, /do-not-call/);
});

test("[VOICE-005] an AI appointment whose callback was never queued is queued and dialled at its time, once", async () => {
  const t = await world();
  const phone = "+13125550177";
  const { leadId } = await captureLead(t.db, { name: "Max Missing", email: "max@example.com", phone, interest: "business", message: "[TEST DATA] callback appointment", source: "web_form" });
  await outbound.recordCallConsent(t.db, phone, "callback", "caller_request", "call:test_missing");
  const av = await sched.availability(t.db, cfg(), t.now(), sched.NO_CALENDAR, { calendar: "ai_follow_up" });
  assert.ok(av.available);
  // Booked without queuing its callback (as if the queue write had failed at booking time).
  const { booking } = await sched.book(t.db, cfg(), t.now(), sched.NO_CALENDAR, { name: "Max Missing", phone, startsAt: av.slots[0].startsAt, topic: "Missed queue", leadId, callId: null, isTest: true, source: "ai_receptionist" });
  assert.equal(await t.count(`SELECT COUNT(*) n FROM sales_calls`), 0);
  // Before its time the dispatcher queues it (never dialling early) ...
  assert.equal((await t.queue()).dialled, 0);
  const q = await t.one<Row>(`SELECT status, not_before, appointment_id FROM sales_calls`);
  assert.deepEqual({ ...q }, { status: "queued", not_before: booking.starts_at, appointment_id: booking.id });
  // ... and at its time it is dialled exactly once.
  t.setClock(new Date(booking.starts_at));
  assert.equal((await t.queue()).dialled, 1);
  assert.equal((await t.queue()).dialled, 0);
  assert.equal(await t.count(`SELECT COUNT(*) n FROM sales_calls`), 1);
  assert.equal(await t.count(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'sales_outbound.callback_reconciled'`), 1, "each appointment is reconciled once");
});

test("[VOICE-005] one callback request never becomes two calls: a booked time supersedes the open callback request; re-syncing never adds a second call", async () => {
  const t = await world();
  const req = await t.inbound("d13_1", "request_callback", { name: "Dee Duplicate", phone: CALLER, reason: "Wants a callback about pricing" });
  assert.equal(req.callbackRequested, true);
  const open = await t.one<Row>(`SELECT id, status FROM voice_outbound_requests WHERE phone_e164 = ?`, CALLER);
  assert.equal(open.status, "pending_approval");
  const av = await t.inbound("d13_1", "check_consultation_availability", {});
  const b = await t.inbound("d13_1", "book_consultation", { name: "Dee Duplicate", phone: CALLER, start_time: av.slots[0].start_time, topic: "Pricing callback" });
  assert.equal(b.booked, true, JSON.stringify(b));
  const after = await t.one<Row>(`SELECT status, status_detail FROM voice_outbound_requests WHERE id = ?`, open.id);
  assert.equal(after.status, "cancelled");
  assert.match(after.status_detail, /Superseded by the scheduled AI callback/);
  const row = await t.one<Row>(`SELECT id FROM consultations WHERE confirmation_code = ?`, b.confirmation_code);
  await syncAppointmentCallback(t.db, row.id, { now: t.now() });
  await syncAppointmentCallback(t.db, row.id, { now: t.now() });
  assert.equal(await t.count(`SELECT COUNT(*) n FROM sales_calls WHERE mode = 'callback'`), 1);
});

test("[VOICE-005] cold outreach never calls a prospect who already has an appointment on either calendar", async () => {
  const TUE_1PM_CT = new Date("2026-11-03T19:00:00Z");
  const t = await world(TUE_1PM_CT);
  const phone = "+16145553999";
  const { leadId } = await captureLead(t.db, { name: "Cole Prospect", email: "cole@example.com", phone, company: "Cole Co", interest: "business", message: "[TEST DATA] research lead", source: "web_form" });
  await t.db.prepare(`UPDATE companies SET location_norm = 'columbus|oh' WHERE id = (SELECT company_id FROM contacts WHERE id = (SELECT contact_id FROM leads WHERE id = ?))`).bind(leadId).run();
  await SO.recordComplianceApproval(t.db, t.owner.id, "TEST-COUNSEL-MEMO-P13", "Test approval");
  await SO.recordSalesConsent(t.db, t.owner.id, { phone, leadId, lineType: "landline", signerName: "Cole Prospect", evidenceRef: "form-TEST-P13",
    disclosureText: "I agree that Crestmont may call this number about website services using an AI (artificial) voice. Consent is not a condition of purchase.", capturedAt: new Date(TUE_1PM_CT.getTime() - 5 * 86_400_000).toISOString() }, TUE_1PM_CT);
  await SO.recordDncScrub(t.db, t.owner.id, { phone, registry: "national", result: "clear", sourceRef: "SAN-TEST-P13", checkedAt: new Date(TUE_1PM_CT.getTime() - 86_400_000).toISOString() }, TUE_1PM_CT);
  assert.deepEqual(await SO.saveColdStage(t.db, t.owner.id, { stage: "pilot", limits: { launch: 0, pilot: 10, stage_2: 25, stage_3: 50, stage_4: 100, stage_5: 200 }, confirmIncrease: true }), []);
  assert.deepEqual(await SO.saveOutboundModes(t.db, t.owner.id, { callbacks: true, cold: true }), []);
  // The prospect has an appointment with the Founder next week (Founder calendar: no AI callback is queued for it).
  await sched.book(t.db, cfg(), TUE_1PM_CT, sched.NO_CALENDAR, { name: "Cole Prospect", phone, startsAt: "2026-11-10T16:00:00.000Z", topic: "Founder meeting", leadId, callId: null, isTest: true, source: "staff", calendar: FOUNDER_ROUTE });
  const cold = await SO.enqueueSalesCall(t.db, leadId, { requestedBy: t.owner.id, now: TUE_1PM_CT });
  assert.equal(cold.status, "queued", cold.status_detail ?? "");
  const r = await SO.processSalesQueue({ db: t.db, env: { RETELL_OUTBOUND_API_KEY: OUT, RETELL_INBOUND_API_KEY: IN, RETELL_SALES_OUTBOUND: "on", ENVIRONMENT: "development" }, fetch: (async () => { throw new Error("must not dial"); }) as unknown as typeof fetch, now: () => TUE_1PM_CT, sleep: async () => {} } as never);
  assert.equal(r.dialled, 0, r.detail);
  const s = await t.one<Row>(`SELECT status, status_detail FROM sales_calls WHERE id = ?`, cold.id);
  assert.equal(s.status, "cancelled");
  assert.match(s.status_detail, /Superseded by a scheduled appointment/);
});
