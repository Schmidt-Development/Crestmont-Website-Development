// Dual internal calendars (Founder requirement; src/domain/calendars.ts, migration 0065): Calendar A "AI Follow-Up" for
// routine AI callbacks/follow-ups/consultations, Calendar B "Founder Callback" ONLY when the caller explicitly asked for
// the Founder (or a Founder-approved escalation rule applies; none are approved). FIXTURES ONLY: every voice request is
// an HMAC-signed fixture through the real router into an in-memory D1; no Retell account, number or call is involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { signRetell } from "../src/adapters/retell.ts";
import { defaultVoiceConfig, saveVoiceConfig, type VoiceConfig } from "../src/services/voice-settings.ts";
import { functionContracts } from "../src/services/voice.ts";
import { outboundFunctionContracts, OUTBOUND_FUNCTION_ENUMS } from "../src/services/sales-functions.ts";
import { routeCalendar, APPROVED_ESCALATION_RULES, type EscalationRule, type RoutingContext } from "../src/domain/calendars.ts";
import * as R from "../src/services/research.ts";
import * as SO from "../src/services/sales-outbound.ts";
import { newId, nowIso } from "../src/lib/db.ts";

type Db = Env["DB"];
const count = async (db: Db, sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())!.n;

// ───────────── Pure routing rules ─────────────

const CTX: RoutingContext = { channel: "inbound_receptionist", fn: "request_callback", kind: "callback" };

test("[VOICE-003] routing: only an explicit wants_founder=true goes to the Founder calendar; missing, false and ambiguous values go to AI Follow-Up", () => {
  assert.deepEqual(routeCalendar({ wantsFounder: true, context: CTX }), { calendar: "founder_callback", founderReason: "customer_requested_founder" });
  assert.deepEqual(routeCalendar({ wantsFounder: "true", context: CTX }), { calendar: "founder_callback", founderReason: "customer_requested_founder" });
  for (const v of [undefined, null, false, "false", "", "yes", "maybe", 1, "TRUE ", "the owner", {}, []]) {
    assert.deepEqual(routeCalendar({ wantsFounder: v, context: CTX }), { calendar: "ai_follow_up", founderReason: null }, `wants_founder=${JSON.stringify(v)}`);
  }
  assert.equal(APPROVED_ESCALATION_RULES.length, 0, "no escalation rule is approved until the Founder decides one");
});

test("[VOICE-003] routing: escalation rules apply only when approved and well-formed; a throwing rule never routes to the Founder", () => {
  const rule = (over: Partial<EscalationRule>): EscalationRule => ({ id: "urgentoutage", description: "test", approvedBy: "founder", approvedAt: "2026-11-01", applies: (c) => c.kind === "escalation", ...over });
  const esc: RoutingContext = { ...CTX, fn: "escalate", kind: "escalation" };
  assert.deepEqual(routeCalendar({ context: esc }, [rule({})]), { calendar: "founder_callback", founderReason: "rule:urgentoutage" });
  assert.equal(routeCalendar({ context: CTX }, [rule({})]).calendar, "ai_follow_up", "rule does not apply to a routine callback");
  assert.equal(routeCalendar({ context: esc }, [rule({ approvedBy: "" })]).calendar, "ai_follow_up", "unapproved rule ignored");
  assert.equal(routeCalendar({ context: esc }, [rule({ id: "Bad Id!" })]).calendar, "ai_follow_up", "malformed id ignored");
  assert.equal(routeCalendar({ context: esc }, [rule({ applies: () => { throw new Error("x"); } })]).calendar, "ai_follow_up");
  assert.equal(routeCalendar({ wantsFounder: true, context: esc }, [rule({})]).founderReason, "customer_requested_founder", "an explicit request wins");
});

test("[VOICE-003] [DATA-002] database: a Founder entry without a reason, an AI entry with a reason, or an unknown calendar is rejected", async () => {
  const t = await createTestApp({});
  const db = t.db;
  const at = nowIso(), ct = newId("ct"), ld = newId("ld");
  await db.prepare(`INSERT INTO contacts (id, name, created_at) VALUES (?,?,?)`).bind(ct, "Constraint Test", at).run();
  await db.prepare(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES (?,?,'ai_receptionist','new',?,?)`).bind(ld, ct, at, at).run();
  const cb = (calendar: string, reason: string | null) => db.prepare(`INSERT INTO calendar_callbacks (id, calendar, founder_reason, kind, source, lead_id, created_at) VALUES (?,?,?,'callback','ai_receptionist',?,?)`).bind(newId("cal"), calendar, reason, ld, at).run();
  await assert.rejects(cb("founder_callback", null), /CHECK/);
  await assert.rejects(cb("ai_follow_up", "customer_requested_founder"), /CHECK/);
  await assert.rejects(cb("founder_callback", "because I said so"), /CHECK/);
  await assert.rejects(cb("somebody_else", null), /CHECK/);
  await cb("founder_callback", "customer_requested_founder");
  await cb("founder_callback", "rule:urgentoutage");
  await cb("ai_follow_up", null);
  const cons = (calendar: string, reason: string | null, start: string) => db.prepare(`INSERT INTO consultations (id, name, starts_at, duration_minutes, timezone, status, confirmation_code, source, calendar, founder_reason, created_at, updated_at)
      VALUES (?,?,?,30,'America/Detroit','requested',?,'staff',?,?,?,?)`).bind(newId("cns"), "X", start, newId("c").slice(-6), calendar, reason, at, at).run();
  await assert.rejects(cons("founder_callback", null, "2026-12-01T15:00:00.000Z"), /CHECK/);
  await cons("founder_callback", "customer_requested_founder", "2026-12-01T15:00:00.000Z");
  await db.prepare(`INSERT INTO consultations (id, name, starts_at, duration_minutes, timezone, status, confirmation_code, source, created_at, updated_at) VALUES (?,?,?,30,'America/Detroit','requested','ZZZZZZ','staff',?,?)`)
    .bind(newId("cns"), "Legacy", "2026-12-02T15:00:00.000Z", at, at).run();
  assert.equal((await db.prepare(`SELECT calendar, founder_reason FROM consultations WHERE confirmation_code = 'ZZZZZZ'`).first<{ calendar: string; founder_reason: string | null }>())!.calendar, "ai_follow_up", "existing/default rows are AI Follow-Up");
});

test("[VOICE-003] Retell contracts expose the optional wants_founder argument (never required: missing = AI Follow-Up)", () => {
  const c = functionContracts();
  for (const fn of ["request_callback", "escalate", "book_consultation", "schedule_consultation"]) {
    assert.ok(c[fn].fields.includes("wants_founder"), fn);
    assert.ok(!c[fn].required.includes("wants_founder"), fn);
  }
  const o = outboundFunctionContracts();
  assert.ok(o.schedule_sales_followup.fields.includes("wants_founder"));
  assert.ok(!o.schedule_sales_followup.required.includes("wants_founder"));
  assert.deepEqual([...OUTBOUND_FUNCTION_ENUMS.schedule_sales_followup.wants_founder], ["true", "false"]);
});

// ───────────── Inbound receptionist (signed Retell fixtures) ─────────────

const KEY = "key_fixture_dual_calendars_0001";
const MON_9AM = new Date("2026-11-02T14:00:00Z"); // Monday 09:00 America/Detroit
const URL_FN = "/api/webhooks/retell/functions";

function configured(scheduling: boolean): VoiceConfig {
  const c = defaultVoiceConfig();
  c.timezone = "America/Detroit";
  for (const d of ["mon", "tue", "wed", "thu", "fri"] as const) c.hours[d] = [{ open: "09:00", close: "17:00" }];
  c.scheduling.enabled = scheduling;
  return c;
}

async function inbound() {
  const t = await createTestApp({ RETELL_INBOUND_API_KEY: KEY });
  t.env.overrides = { storage: t.storage, now: () => MON_9AM };
  const owner = await createStaff(t.db, "owner", "owner@crestmontwebsitedevelopment.com");
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('voice.monthly_budget_usd', '50', ?)`).bind(nowIso()).run();
  const c = t.client();
  const call = async (callId: string, name: string, args: Record<string, unknown>, from = "+15550100123") => {
    const body = JSON.stringify({ name, call: { call_id: callId, call_type: "phone_call", from_number: from, to_number: "+15550109999", direction: "inbound" }, args });
    const res = await c.request("POST", URL_FN, { body, headers: { "content-type": "application/json", "x-retell-signature": await signRetell(KEY, body) } });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { ...t, owner, call };
}

const entries = (db: Db, calendar: string) => db.prepare(`SELECT e.kind, e.founder_reason, e.source, a.body FROM calendar_callbacks e LEFT JOIN crm_activities a ON a.id = e.task_activity_id WHERE e.calendar = ? ORDER BY e.created_at`).bind(calendar)
  .all<{ kind: string; founder_reason: string | null; source: string; body: string | null }>().then((r) => r.results);

test("[VOICE-003] inbound: an explicit request for the Founder lands on the Founder Callback calendar with its reason", async () => {
  const t = await inbound();
  const r = await t.call("c_f1", "request_callback", { name: "Fran Founderfan", phone: "+15550100123", reason: "Wants to talk to the owner about a partnership", wants_founder: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.callbackRequested, true);
  assert.equal(r.json.calendar, "founder_callback");
  const f = await entries(t.db, "founder_callback");
  assert.equal(f.length, 1);
  assert.equal(f[0].founder_reason, "customer_requested_founder");
  assert.match(f[0].body!, /^\[FOUNDER CALLBACK\] Call back Fran/);
  assert.equal((await entries(t.db, "ai_follow_up")).length, 0);
  const esc = await t.call("c_f2", "escalate", { reason: "Asked for the Founder about a complaint", name: "Esme", phone: "+15550100124", wants_founder: true }, "+15550100124");
  assert.equal(esc.json.escalated, true);
  assert.equal((await entries(t.db, "founder_callback")).filter((e) => e.kind === "escalation").length, 1);
});

test("[VOICE-003] inbound: routine callback, qualification, reminder and support callbacks land on AI Follow-Up; ambiguous values never reach the Founder", async () => {
  const t = await inbound();
  // Routine callback (no new argument at all: backwards compatible).
  assert.equal((await t.call("c_a1", "request_callback", { name: "Rory Routine", phone: "+15550100123", reason: "Question about hosting" })).json.calendar, "ai_follow_up");
  // Qualification follow-up / reminder phrased as callbacks, explicit false.
  await t.call("c_a2", "request_callback", { name: "Quinn Qualify", phone: "+15550100125", reason: "Qualification follow-up about budget", wants_founder: false }, "+15550100125");
  await t.call("c_a3", "request_callback", { name: "Remy Remind", phone: "+15550100126", reason: "Reminder call before deciding", preferred_time: "tomorrow" }, "+15550100126");
  // Ambiguous: a free-text mention of the owner, or a non-boolean value, is not an explicit request.
  await t.call("c_a4", "request_callback", { name: "Amy Ambiguous", phone: "+15550100127", reason: "Maybe the owner or someone could call", wants_founder: "maybe" }, "+15550100127");
  await t.call("c_a5", "request_callback", { name: "Abe Ambiguous", phone: "+15550100128", reason: "Call me", wants_founder: "yes" }, "+15550100128");
  // Support callback for an unmatched caller.
  await t.call("c_a6", "create_support_ticket", { name: "Sue Support", email: "sue@example.com", phone: "+15550100129", summary: "My site form is broken" }, "+15550100129");
  // Escalation without the flag.
  await t.call("c_a7", "escalate", { reason: "Urgent outage", name: "Ed", phone: "+15550100130" }, "+15550100130");
  const ai = await entries(t.db, "ai_follow_up");
  assert.equal(ai.length, 7);
  assert.deepEqual([...new Set(ai.map((e) => e.kind))].sort(), ["callback", "escalation", "support_callback"]);
  assert.ok(ai.every((e) => e.founder_reason === null && !/FOUNDER/.test(e.body ?? "")));
  assert.equal((await entries(t.db, "founder_callback")).length, 0, "nothing reached the Founder calendar");
});

test("[VOICE-003] inbound: consultations carry their calendar; a Founder request books on the Founder calendar; reschedule keeps it", async () => {
  const t = await inbound();
  await saveVoiceConfig(t.db, t.owner.id, configured(true));
  const slots = (await t.call("c_b0", "schedule_consultation", { preferred_date: "2026-11-03" })).json.slots;
  const ai = await t.call("c_b1", "schedule_consultation", { name: "Bo Booker", phone: "+15550100123", topic: "New website", start_time: slots[0].start_time });
  assert.equal(ai.json.booked, true);
  assert.equal(ai.json.calendar, "ai_follow_up");
  const f = await t.call("c_b2", "schedule_consultation", { name: "Fae Founder", phone: "+15550100131", topic: "Speak with the Founder", start_time: slots[1].start_time, wants_founder: true }, "+15550100131");
  assert.equal(f.json.booked, true);
  assert.equal(f.json.calendar, "founder_callback");
  const row = (await t.db.prepare(`SELECT calendar, founder_reason FROM consultations WHERE confirmation_code = ?`).bind(f.json.confirmation_code).first<{ calendar: string; founder_reason: string }>())!;
  assert.deepEqual({ ...row }, { calendar: "founder_callback", founder_reason: "customer_requested_founder" });
  const moved = await t.call("c_b2", "reschedule_consultation", { confirmation_code: f.json.confirmation_code, phone: "+15550100131", new_start_time: slots[2].start_time }, "+15550100131");
  assert.equal(moved.json.rescheduled, true);
  assert.equal((await t.db.prepare(`SELECT calendar FROM consultations WHERE confirmation_code = ?`).bind(moved.json.confirmation_code).first<{ calendar: string }>())!.calendar, "founder_callback");
});

test("[VOICE-003] inbound: the agent is never told a booking or callback exists when the database did not record it (unique conflict, failed insert)", async () => {
  const t = await inbound();
  await saveVoiceConfig(t.db, t.owner.id, configured(true));
  const start = (await t.call("c_x0", "schedule_consultation", { preferred_date: "2026-11-03" })).json.slots[0].start_time;
  assert.equal((await t.call("c_x1", "schedule_consultation", { name: "First", phone: "+15550100123", topic: "Website", start_time: start })).json.booked, true);
  // Same slot, Founder request: the unique active-slot index refuses it, so nothing is claimed on either calendar.
  const clash = await t.call("c_x2", "schedule_consultation", { name: "Second", phone: "+15550100140", topic: "Founder please", start_time: start, wants_founder: true }, "+15550100140");
  assert.equal(clash.json.booked, false);
  assert.equal(clash.json.calendar, undefined);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM consultations WHERE calendar = 'founder_callback'`), 0);
  // Simulated database failure on the calendar write: the callback is NOT confirmed and its task is rolled back.
  await t.db.prepare(`CREATE TRIGGER test_fail_calendar BEFORE INSERT ON calendar_callbacks BEGIN SELECT RAISE(ABORT, 'simulated calendar write failure'); END`).run();
  const tasksBefore = await count(t.db, `SELECT COUNT(*) n FROM crm_activities WHERE kind = 'task'`);
  const r = await t.call("c_x3", "request_callback", { name: "Fail Case", phone: "+15550100141", reason: "Please call me", wants_founder: true }, "+15550100141");
  assert.notEqual(r.status, 200);
  assert.match(r.json.error, /couldn't complete that/, "the agent hears that it failed");
  assert.equal(r.json.callbackRequested, undefined, "no callback claimed");
  assert.doesNotMatch(JSON.stringify(r.json), /will call you back/);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM crm_activities WHERE kind = 'task'`), tasksBefore, "the task rolled back with the calendar entry");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM calendar_callbacks`), 0);
});

// ───────────── Outbound sales agent (signed Retell fixtures) ─────────────

const OUT_KEY = "key_test_dual_cal_outbound_0001";
const TUE_10AM_ET = new Date("2026-11-03T15:00:00Z");
const FN = "/api/webhooks/retell/outbound/functions";

async function outbound() {
  const now = TUE_10AM_ET;
  const t = await createTestApp({ RETELL_OUTBOUND_API_KEY: OUT_KEY });
  let n = 0;
  const fetchImpl = (async () => new Response(JSON.stringify({ call_id: `call_dc_${++n}`, call_status: "registered" }), { status: 201 })) as unknown as typeof fetch;
  t.env.overrides = { storage: t.storage, now: () => now, fetch: fetchImpl } as Env["overrides"];
  const c = t.client();
  const owner = await createStaff(t.db, "owner");
  const actor = { kind: "user" as const, userId: owner.id, roles: [{ role: "owner" as const, organizationId: "org_crestmont" }], mfaVerified: true };
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('voice.monthly_budget_usd', '50', ?)`).bind(now.toISOString()).run();
  await t.db.prepare(`UPDATE research_settings SET paused = 0, pause_reason = NULL WHERE id = 1`).run();
  const at = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  await R.ingestBatch(t.db, { batchId: "b_dualcal", runnerId: "ws-test", prospects: [{
    businessKey: "overture:dc1", name: "Calendar Cafe (TEST DATA)", category: "cafe", address: { line: "1 High St", city: "Columbus", state: "OH", zip: "43215" },
    phones: ["(614) 555-2142"], emails: [], domains: ["calendar-cafe.example"],
    sources: [{ source: "overture", sourceId: "dc1", license: "CDLA-Permissive-2.0", release: "2026-10-21.0", retrievedAt: at }],
    website: { classification: "VERIFIED_WEBSITE_BROKEN", url: "https://calendar-cafe.example/", confidence: 0.9, checkedAt: at, identitySignals: ["phone on page matches"], checks: [{ stage: "C", method: "HTTP GET", result: "503 x3", at }] },
    findings: [{ code: "http_5xx", title: "Home page returns HTTP 503", severity: "critical", confidence: 0.95, url: "https://calendar-cafe.example/", method: "HTTP GET", observedAt: at, evidence: "503" }],
    identityConfidence: 0.9, lastVerifiedAt: at,
  }] } as never, now);
  const pid = (await t.db.prepare(`SELECT id FROM research_prospects WHERE business_key = 'overture:dc1'`).first<{ id: string }>())!.id;
  const leadId = (await R.promote(t.db, actor, pid)).leadId;
  const phone = "+16145552142";
  await SO.recordComplianceApproval(t.db, owner.id, "TEST-COUNSEL-MEMO-001", "Test approval");
  await SO.recordSalesConsent(t.db, owner.id, { phone, leadId, lineType: "landline", signerName: "Cal Cafe", evidenceRef: "form-TEST-1",
    disclosureText: "I agree that Crestmont may call this number about website services using an AI (artificial) voice. Consent is not a condition of purchase.", capturedAt: new Date(now.getTime() - 5 * 86_400_000).toISOString() }, now);
  await SO.recordDncScrub(t.db, owner.id, { phone, registry: "national", result: "clear", sourceRef: "SAN-TEST-1", checkedAt: new Date(now.getTime() - 3 * 86_400_000).toISOString() }, now);
  await SO.saveSalesSettings(t.db, owner.id, { enabled: true, agentId: "agent_sales_test", fromNumber: "+16145550100", maxConcurrent: 2, maxPerRun: 3, maxPerDay: 25, maxAttempts: 2, retryAfterHours: 48 });
  const row = await SO.enqueueSalesCall(t.db, leadId, { requestedBy: owner.id, now });
  const r = await SO.processSalesQueue({ db: t.db, env: { RETELL_OUTBOUND_API_KEY: OUT_KEY, RETELL_SALES_OUTBOUND: "on", ENVIRONMENT: "development" }, fetch: fetchImpl, now: () => now, sleep: async () => {} } as never);
  assert.equal(r.dialled, 1, r.detail);
  const callId = (await SO.getSalesCall(t.db, row.id))!.provider_call_id!;
  const post = async (name: string, args: Record<string, unknown>) => {
    const raw = JSON.stringify({ name, call: { call_id: callId, call_type: "phone_call", direction: "outbound", from_number: "+16145550100", to_number: phone, agent_id: "agent_sales_test",
      metadata: { crestmont_env: "development", crestmont_sales_call_id: row.id, crestmont_test: "true" } }, args });
    const res = await c.request("POST", FN, { body: raw, headers: { "content-type": "application/json", "x-retell-signature": await signRetell(OUT_KEY, raw) } });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { ...t, owner, leadId, post };
}

test("[VOICE-003] [VOICE-005] outbound: a routine staff callback and an AI follow-up call land on AI Follow-Up", async () => {
  const t = await outbound();
  const cb = await t.post("schedule_sales_followup", { followup_type: "staff_callback", preferred_date: "2026-11-05", preferred_time: "morning", topic: "Pricing questions", prospect_agreed: true });
  assert.equal(cb.json.scheduled, true, JSON.stringify(cb.json));
  assert.equal(cb.json.calendar, "ai_follow_up");
  const fu = await t.post("schedule_sales_followup", { followup_type: "ai_follow_up_call", preferred_date: "2026-11-10", prospect_agreed: true });
  assert.equal(fu.json.scheduled, true, JSON.stringify(fu.json));
  assert.equal(fu.json.calendar, "ai_follow_up");
  const ai = await entries(t.db, "ai_follow_up");
  assert.deepEqual(ai.map((e) => e.kind).sort(), ["sales_ai_follow_up", "sales_staff_callback"]);
  assert.ok(ai.every((e) => e.source === "ai_sales" && e.founder_reason === null));
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM calendar_callbacks e JOIN sales_followups f ON f.id = e.sales_followup_id`), 2, "each entry points at its real follow-up");
  assert.equal((await entries(t.db, "founder_callback")).length, 0);
});

test("[VOICE-003] [VOICE-005] outbound: an explicit request for the Founder lands on the Founder calendar (an AI follow-up call becomes a Founder staff callback)", async () => {
  const t = await outbound();
  const r = await t.post("schedule_sales_followup", { followup_type: "ai_follow_up_call", topic: "Wants the owner", prospect_agreed: true, wants_founder: true });
  assert.equal(r.json.scheduled, true, JSON.stringify(r.json));
  assert.equal(r.json.calendar, "founder_callback");
  assert.equal(r.json.followup_type, "staff_callback", "no automated call pretends to be the Founder");
  const f = await entries(t.db, "founder_callback");
  assert.equal(f.length, 1);
  assert.equal(f[0].founder_reason, "customer_requested_founder");
  assert.equal(f[0].kind, "sales_staff_callback");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM sales_followups WHERE kind = 'ai_follow_up_call'`), 0);
});

test("[VOICE-003] [VOICE-005] outbound: a failed calendar write is never reported as scheduled and leaves no follow-up behind", async () => {
  const t = await outbound();
  await t.db.prepare(`CREATE TRIGGER test_fail_calendar BEFORE INSERT ON calendar_callbacks BEGIN SELECT RAISE(ABORT, 'simulated calendar write failure'); END`).run();
  const r = await t.post("schedule_sales_followup", { followup_type: "staff_callback", preferred_date: "2026-11-05", prospect_agreed: true, wants_founder: true });
  assert.equal(r.status, 500);
  assert.notEqual(r.json.scheduled, true);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM sales_followups`), 0, "rolled back with the calendar entry");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM crm_activities WHERE kind = 'task' AND body LIKE '%as agreed on AI sales call%'`), 0);
});

// ───────────── Staff views ─────────────

test("[VOICE-003] [SEC-002] staff calendar views: each lists only its own calendar; customers, anonymous users and staff without the permission are refused", async () => {
  const t = await inbound();
  await t.call("c_v1", "request_callback", { name: "Alma Routine", phone: "+15550100123", reason: "Routine question" });
  await t.call("c_v2", "request_callback", { name: "Felix Founder", phone: "+15550100150", reason: "Asked for the Founder", wants_founder: true }, "+15550100150");
  const owner = await t.client().login(t.owner.email, TEST_PASSWORD, t.owner.secret);
  const ai = await owner.get("/staff/calendars/ai-follow-up");
  assert.equal(ai.status, 200);
  const aiHtml = await ai.text();
  assert.match(aiHtml, /Alma Routine/);
  assert.doesNotMatch(aiHtml, /Felix Founder/);
  const fc = await owner.get("/staff/calendars/founder-callback");
  assert.equal(fc.status, 200);
  const fcHtml = await fc.text();
  assert.match(fcHtml, /Felix Founder/);
  assert.match(fcHtml, /Customer asked for the Founder/);
  assert.doesNotMatch(fcHtml, /Alma Routine/);
  const dash = await (await owner.get("/staff/owner")).text();
  assert.match(dash, /href="\/staff\/calendars\/founder-callback"/, "Owner dashboard links the Founder calendar");

  const anon = t.client();
  for (const p of ["/staff/calendars/ai-follow-up", "/staff/calendars/founder-callback"]) {
    const r = await anon.get(p);
    assert.ok(r.status === 303 || r.status === 401, `${p}: anonymous ${r.status}`);
    assert.doesNotMatch(await r.text(), /Felix|Alma/);
  }
  const cust = await createCustomer(t.db, "cal.customer@example.com");
  const cc = await t.client().login(cust.email, TEST_PASSWORD);
  for (const p of ["/staff/calendars/ai-follow-up", "/staff/calendars/founder-callback"]) {
    const r = await cc.get(p);
    assert.equal(r.status, 403, `${p}: customer`);
    assert.doesNotMatch(await r.text(), /Felix|Alma/);
  }
  const dev = await createStaff(t.db, "developer");
  const dc = await t.client().login(dev.email, TEST_PASSWORD, dev.secret);
  assert.equal((await dc.get("/staff/calendars/ai-follow-up")).status, 403, "developer lacks lead.read_all");
  const admin = await createStaff(t.db, "administrator");
  const ac = await t.client().login(admin.email, TEST_PASSWORD, admin.secret);
  assert.equal((await ac.get("/staff/calendars/ai-follow-up")).status, 200, "administrator sees AI Follow-Up");
  assert.equal((await ac.get("/staff/calendars/founder-callback")).status, 403, "only the Owner sees the Founder calendar");
});
