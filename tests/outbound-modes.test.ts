// Founder directive 2026-11-06 (final master prompt parts 2–9, test plan part 14): two independent calling modes with
// their own Owner switches, the 15 + 5 concurrency allocation, capacity-aware callbacks, the cold-outreach ramp, the
// five-per-slot AI Outbound Calendar and the 24/7 receptionist. TEST DATA only; Retell is a local fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { signRetell } from "../src/adapters/retell.ts";
import { captureLead } from "../src/services/leads.ts";
import * as SO from "../src/services/sales-outbound.ts";
import { capacityPlan, allocationShortfall, stageLimitProblems, callbackEligibility, COLD_MAX_CONCURRENT } from "../src/domain/outbound-capacity.ts";
import { defaultVoiceConfig, saveVoiceConfig, candidateSlots, calendarView, type VoiceConfig } from "../src/services/voice-settings.ts";
import * as sched from "../src/services/voice-scheduling.ts";
import { recordCallConsent } from "../src/services/voice-outbound.ts";
import { syncAppointmentCallback } from "../src/services/appointment-callbacks.ts";
import { INBOUND_MASTER_INSTRUCTIONS } from "../src/services/voice.ts";

const OUT = "key_test_outbound_modes_0001";
const IN = "key_test_inbound_modes_00001";
const TUE_2PM_ET = new Date("2026-11-03T19:00:00Z");
const STAGES = { launch: 0, pilot: 10, stage_2: 25, stage_3: 50, stage_4: 100, stage_5: 200 };

function voiceCfg(): VoiceConfig {
  const c = defaultVoiceConfig();
  c.timezone = "America/New_York";
  for (const d of ["mon", "tue", "wed", "thu", "fri"] as const) c.hours[d] = [{ open: "09:00", close: "17:00" }];
  c.scheduling.enabled = true;
  return c;
}

async function app(now = TUE_2PM_ET) {
  const t = await createTestApp({ RETELL_OUTBOUND_API_KEY: OUT, RETELL_INBOUND_API_KEY: IN });
  let n = 0;
  const dials: Record<string, any>[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => { dials.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ call_id: `call_m_${++n}`, call_status: "registered" }), { status: 201 }); }) as unknown as typeof fetch;
  let clock = now;
  t.env.overrides = { storage: t.storage, now: () => clock, fetch: fetchImpl } as Env["overrides"];
  const owner = await createStaff(t.db, "owner");
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('voice.monthly_budget_usd', '50', ?)`).bind(now.toISOString()).run();
  await saveVoiceConfig(t.db, owner.id, voiceCfg());
  await SO.saveSalesSettings(t.db, owner.id, { enabled: false, agentId: "agent_sales_modes", fromNumber: "+16145550100", maxConcurrent: 15, maxPerRun: 20, maxPerDay: 25, maxAttempts: 2, retryAfterHours: 48 });
  let k = 0;
  /** A lead whose number asked for a callback (the receptionist recorded the request as consent). */
  const callbackLead = async (opts: { consent?: boolean } = {}) => {
    const i = ++k, phone = `+1614555${String(3000 + i).padStart(4, "0")}`;
    const { leadId } = await captureLead(t.db, { name: `Callback Person ${i}`, email: `cb${i}@example.com`, phone, interest: "business", message: "[TEST DATA] wants a callback about a website", source: "web_form" });
    if (opts.consent !== false) await recordCallConsent(t.db, phone, "callback", "caller_request", `call:test_${i}`);
    return { leadId, phone };
  };
  /** A cold-outreach lead with documented written consent and a fresh DNC check (what the cold gate needs). */
  const coldLead = async () => {
    const i = ++k, phone = `+1614555${String(3000 + i).padStart(4, "0")}`;
    const { leadId } = await captureLead(t.db, { name: `Cold Person ${i}`, email: `cold${i}@example.com`, phone, company: `Cold Co ${i}`, interest: "business", message: "[TEST DATA] research lead for outreach", source: "web_form" });
    await t.db.prepare(`UPDATE companies SET location_norm = 'columbus|oh' WHERE id = (SELECT company_id FROM contacts WHERE id = (SELECT contact_id FROM leads WHERE id = ?))`).bind(leadId).run();
    await SO.recordSalesConsent(t.db, owner.id, { phone, leadId, lineType: "landline", signerName: `Cold Person ${i}`, evidenceRef: `form-TEST-${i}`,
      disclosureText: "I agree that Crestmont may call this number about website services using an AI (artificial) voice. Consent is not a condition of purchase.", capturedAt: new Date(now.getTime() - 5 * 86_400_000).toISOString() }, now);
    await SO.recordDncScrub(t.db, owner.id, { phone, registry: "national", result: "clear", sourceRef: "SAN-TEST", checkedAt: new Date(now.getTime() - 86_400_000).toISOString() }, now);
    return { leadId, phone };
  };
  const coldReady = async () => {
    if (!await SO.activeComplianceApproval(t.db)) await SO.recordComplianceApproval(t.db, owner.id, "TEST-COUNSEL-MEMO-002", "Test approval");
    assert.deepEqual(await SO.saveColdStage(t.db, owner.id, { stage: "pilot", limits: STAGES, confirmIncrease: true }), []);
  };
  const env = (o: Partial<Record<string, string | undefined>> = {}) => ({ db: t.db, env: { RETELL_OUTBOUND_API_KEY: OUT, RETELL_INBOUND_API_KEY: IN, RETELL_SALES_OUTBOUND: "on", ENVIRONMENT: "development" as const, ...o },
    fetch: fetchImpl, now: () => clock, sleep: async () => {} });
  const setClock = (d: Date) => { clock = d; };
  return { ...t, owner, dials, callbackLead, coldLead, coldReady, env, setClock, now: () => clock };
}
const count = async (db: { prepare(s: string): { bind(...a: unknown[]): { first<T>(): Promise<T | null> } } }, sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())!.n;

// ───────────── Capacity rules (pure) ─────────────

test("[VOICE-005] capacity: cold ≤ 15, 5 reserved for callbacks that cold never borrows (even idle), shared inbound shrinks outbound first", () => {
  const base = { providerLimit: 20, inboundSharesCapacity: false, activeInbound: 0, inboundHeadroom: 0, coldMax: 15, callbackReserved: 5, activeCold: 0, activeCallback: 0 };
  assert.deepEqual(capacityPlan(base).limit, { cold: 15, callback: 5 });
  assert.equal(capacityPlan({ ...base, activeCold: 15 }).free.cold, 0, "a 16th cold call has no room");
  assert.equal(capacityPlan({ ...base, activeCold: 15 }).free.callback, 5, "callbacks keep their five while cold outreach is full");
  assert.equal(capacityPlan({ ...base, activeCallback: 5 }).free.callback, 0, "a sixth callback has no room");
  assert.equal(capacityPlan({ ...base, coldMax: 99 }).limit.cold, COLD_MAX_CONCURRENT, "15 is a hard ceiling");
  // Shared provider: 8 inbound calls + 2 kept free leave 10 outbound; 5 stay reserved, so cold gets 5.
  const shared = capacityPlan({ ...base, inboundSharesCapacity: true, activeInbound: 8, inboundHeadroom: 2 });
  assert.equal(shared.outboundRoom, 10);
  assert.deepEqual(shared.limit, { cold: 5, callback: 5 });
  // Saturated: inbound takes everything, nothing is dialled (never oversubscribe the provider).
  assert.deepEqual(capacityPlan({ ...base, inboundSharesCapacity: true, activeInbound: 19, inboundHeadroom: 2 }).limit, { cold: 0, callback: 0 });
  // Cold calls already on the line are never interrupted; callbacks get what is left of the room.
  assert.equal(capacityPlan({ ...base, inboundSharesCapacity: true, activeInbound: 4, inboundHeadroom: 0, activeCold: 14 }).limit.callback, 2);
  assert.match(allocationShortfall(18, true, 2, 15, 5)!, /below/);
  assert.equal(allocationShortfall(20, false, 0, 15, 5), null);
});

test("[VOICE-005] ramp stages: launch is 0, stages never decrease, and an increase needs the Founder's authorisation", async () => {
  assert.deepEqual(stageLimitProblems(STAGES), []);
  assert.ok(stageLimitProblems({ ...STAGES, launch: 5 }).some((p) => /Launch stage is always 0/.test(p)));
  assert.ok(stageLimitProblems({ ...STAGES, stage_3: 20 }).some((p) => /lower than the stage before/.test(p)));
  const t = await app();
  assert.equal((await SO.loadSalesSettings(t.db)).cold_stage, "launch");
  assert.equal(SO.coldDailyLimit(await SO.loadSalesSettings(t.db)), 0, "launch = 0 cold calls a day");
  assert.ok((await SO.saveColdStage(t.db, t.owner.id, { stage: "pilot", limits: STAGES, confirmIncrease: false })).some((p) => /Founder's confirmation/.test(p)));
  assert.deepEqual(await SO.saveColdStage(t.db, t.owner.id, { stage: "pilot", limits: STAGES, confirmIncrease: true }), []);
  assert.deepEqual(await SO.saveColdStage(t.db, t.owner.id, { stage: "launch", limits: STAGES, confirmIncrease: false }), [], "going down never needs confirmation");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE action IN ('sales_outbound.ramp_increased','sales_outbound.ramp_updated')`), 2);
});

// ───────────── Switch matrix ─────────────

async function matrix(callbacks: boolean, cold: boolean) {
  const t = await app();
  await t.coldReady();
  assert.deepEqual(await SO.saveOutboundModes(t.db, t.owner.id, { callbacks, cold }), []);
  const cb = await t.callbackLead();
  const cbRow = await SO.enqueueSalesCall(t.db, cb.leadId, { requestedBy: null, mode: "callback", notBefore: t.now().toISOString(), now: t.now(), context: { reason: "Asked for a callback" } });
  assert.equal(cbRow.status, "queued", cbRow.status_detail ?? "");
  const c1 = await t.coldLead();
  const coldRow = await SO.enqueueSalesCall(t.db, c1.leadId, { requestedBy: t.owner.id, now: t.now() });
  assert.equal(coldRow.status, "queued", coldRow.status_detail ?? "");
  const r = await SO.processSalesQueue(t.env());
  return { t, r, cbRow, coldRow };
}

test("[VOICE-005] switch matrix: OFF/OFF dials nothing; ON/OFF callbacks only; OFF/ON cold only; ON/ON both within their own limits", async () => {
  const none = await matrix(false, false);
  assert.equal(none.r.dialled, 0);
  assert.equal(none.t.dials.length, 0);
  const cbOnly = await matrix(true, false);
  assert.deepEqual(cbOnly.r.byMode, { callback: 1, cold: 0 }, cbOnly.r.detail);
  assert.equal(cbOnly.t.dials[0].metadata.crestmont_call_mode, "callback");
  assert.equal(cbOnly.t.dials[0].retell_llm_dynamic_variables.call_mode, "scheduled_callback");
  assert.equal(cbOnly.t.dials[0].retell_llm_dynamic_variables.callback_reason, "Asked for a callback", "the agent gets the earlier context");
  const coldOnly = await matrix(false, true);
  assert.deepEqual(coldOnly.r.byMode, { callback: 0, cold: 1 }, coldOnly.r.detail);
  const both = await matrix(true, true);
  assert.deepEqual(both.r.byMode, { callback: 1, cold: 1 }, both.r.detail);
  // Callbacks work with cold outreach entirely closed at the environment level and without any compliance approval.
  const t = await app();
  const cb = await t.callbackLead();
  await SO.enqueueSalesCall(t.db, cb.leadId, { requestedBy: null, mode: "callback", notBefore: t.now().toISOString(), now: t.now() });
  const r = await SO.processSalesQueue(t.env({ RETELL_SALES_OUTBOUND: undefined }));
  assert.deepEqual(r.byMode, { callback: 1, cold: 0 }, r.detail);
  assert.match(r.detail, /AI Cold Outreach not dialling/);
  // The environment kill switch stops callbacks whatever the Owner switch says.
  const k = await app();
  const kb = await k.callbackLead();
  await SO.enqueueSalesCall(k.db, kb.leadId, { requestedBy: null, mode: "callback", notBefore: k.now().toISOString(), now: k.now() });
  assert.equal((await SO.processSalesQueue(k.env({ RETELL_SALES_CALLBACKS: "off" }))).dialled, 0);
});

test("[VOICE-005] a callback without the person's own request on record is never dialled; cold outreach needs its approval and written consent", async () => {
  const g = callbackEligibility({ phoneE164: "+16145550199", onDnc: false, suppressedInCrm: false, leadMerged: false, consentEvidence: null, timeZone: "America/New_York", attemptsSoFar: 0, maxAttempts: 2 }, TUE_2PM_ET);
  assert.equal(g.eligible, false);
  assert.ok(g.reasons.some((x) => /No recorded request/.test(x)));
  assert.equal(callbackEligibility({ phoneE164: "+16145550199", onDnc: false, suppressedInCrm: false, leadMerged: false, consentEvidence: "call:x", timeZone: "America/New_York", attemptsSoFar: 0, maxAttempts: 2 }, new Date("2026-11-04T02:30:00Z")).eligible, false, "never at 9:30 p.m. local");
  const t = await app();
  const cb = await t.callbackLead({ consent: false });
  const row = await SO.enqueueSalesCall(t.db, cb.leadId, { requestedBy: null, mode: "callback", notBefore: t.now().toISOString(), now: t.now() });
  assert.equal(row.status, "blocked");
  const c = await t.coldLead();
  assert.deepEqual(await SO.saveOutboundModes(t.db, t.owner.id, { callbacks: true, cold: true }), []);
  const coldRow = await SO.enqueueSalesCall(t.db, c.leadId, { requestedBy: t.owner.id, now: t.now() });
  assert.equal(coldRow.status, "blocked", "no counsel-referenced approval yet");
  assert.match(coldRow.status_detail!, /D-14/);
  assert.equal((await SO.processSalesQueue(t.env())).dialled, 0);
});

// ───────────── Concurrency, reservations and daily limits ─────────────

test("[VOICE-005] reservations are atomic: 20 simultaneous claims → exactly 15 cold; a 6th callback claim fails; cold cannot take a callback slot", async () => {
  const t = await app();
  const now = t.now();
  const cold = await Promise.all(Array.from({ length: 20 }, (_, i) => SO.claimSlot(t.db, "cold", `scall_c${i}`, 15, now)));
  assert.equal(cold.filter(Boolean).length, 15);
  const cbs = await Promise.all(Array.from({ length: 6 }, (_, i) => SO.claimSlot(t.db, "callback", `scall_b${i}`, 5, now)));
  assert.equal(cbs.filter(Boolean).length, 5);
  assert.deepEqual(await SO.heldSlots(t.db, now), { cold: 15, callback: 5 });
  assert.equal(await SO.claimSlot(t.db, "cold", "scall_c99", 15, now), false);
  // Releasing one cold slot frees exactly one; an expired reservation (lost webhook) is reclaimable.
  await SO.releaseSlot(t.db, "scall_c0");
  assert.equal(await SO.claimSlot(t.db, "cold", "scall_c99", 15, now), true);
  const later = new Date(now.getTime() + SO.SALES_LEASE_MS + 60_000);
  assert.equal(await SO.claimSlot(t.db, "callback", "scall_b99", 5, later), true, "a stale reservation never wedges capacity");
  assert.equal(await SO.claimSlot(t.db, "cold", "scall_c99", 15, now), false, "one reservation per call");
});

test("[VOICE-005] overlapping scheduler runs never double-dial or exceed the cold limit; call_ended frees the reservation; switching OFF stops new dials only", async () => {
  const t = await app();
  await t.coldReady();
  assert.deepEqual(await SO.saveCapacitySettings(t.db, t.owner.id, { coldMax: 2, callbackReserved: 5, providerLimit: 20, inboundShares: false, inboundHeadroom: 0, callbackMaxPerDay: 200 }), []);
  assert.deepEqual(await SO.saveOutboundModes(t.db, t.owner.id, { callbacks: true, cold: true }), []);
  const rows = [];
  for (let i = 0; i < 4; i++) { const l = await t.coldLead(); rows.push(await SO.enqueueSalesCall(t.db, l.leadId, { requestedBy: t.owner.id, now: t.now() })); }
  const [a, b] = await Promise.all([SO.processSalesQueue(t.env()), SO.processSalesQueue(t.env())]);
  assert.equal(a.dialled + b.dialled, 2, `${a.detail} | ${b.detail}`);
  assert.equal(t.dials.length, 2, "Retell received exactly two calls");
  assert.equal(new Set(t.dials.map((d) => d.idempotency_key)).size, 2);
  assert.equal((await SO.heldSlots(t.db, t.now())).cold, 2);
  // Switching cold OFF while calls are active: no new dial; the active ones continue.
  assert.deepEqual(await SO.saveOutboundModes(t.db, t.owner.id, { callbacks: true, cold: false }), []);
  assert.equal((await SO.processSalesQueue(t.env())).dialled, 0);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM sales_calls WHERE status = 'dialing'`), 2);
  // A finished call releases its reservation.
  const dialling = (await t.db.prepare(`SELECT id, provider_call_id FROM sales_calls WHERE status = 'dialing' LIMIT 1`).first<{ id: string; provider_call_id: string }>())!;
  const ev = JSON.stringify({ event: "call_ended", call: { call_id: dialling.provider_call_id, call_status: "ended", disconnection_reason: "user_hangup", transcript: "Agent: hi", metadata: { crestmont_env: "development", crestmont_sales_call_id: dialling.id } } });
  await SO.applySalesCallEvent(t.db, ev, { environment: "development", now: () => t.now() });
  assert.equal((await SO.heldSlots(t.db, t.now())).cold, 1);
});

test("[VOICE-005] daily limits are enforced at claim time: the Pilot stage allows 10 cold dials a day and no 11th", async () => {
  const t = await app();
  await t.coldReady();
  assert.deepEqual(await SO.saveOutboundModes(t.db, t.owner.id, { callbacks: false, cold: true }), []);
  for (let i = 0; i < 12; i++) { const l = await t.coldLead(); await SO.enqueueSalesCall(t.db, l.leadId, { requestedBy: t.owner.id, now: t.now() }); }
  let total = 0;
  for (let run = 0; run < 3; run++) {
    total += (await SO.processSalesQueue(t.env())).dialled;
    // Free the lines between runs so only the daily limit can stop dialling.
    await t.db.prepare(`UPDATE sales_calls SET status = 'completed', finalized_at = ? WHERE status = 'dialing'`).bind(t.now().toISOString()).run();
  }
  assert.equal(total, 10);
  assert.equal((await SO.dialsToday(t.db, t.now())).cold, 10);
});

test("[VOICE-005] cold outreach picks eligible Approved-CRM leads itself; nobody has to ask for a callback first", async () => {
  const t = await app();
  await t.coldReady();
  assert.deepEqual(await SO.saveOutboundModes(t.db, t.owner.id, { callbacks: false, cold: true }), []);
  const l = await t.coldLead();
  const r = await SO.processSalesQueue(t.env());
  assert.equal(r.byMode!.cold, 1, r.detail);
  assert.equal((await t.db.prepare(`SELECT mode, requested_by FROM sales_calls WHERE lead_id = ?`).bind(l.leadId).first<{ mode: string; requested_by: string | null }>())!.mode, "cold");
  // Each candidate is queued once: a second run does not queue the same lead again.
  await SO.processSalesQueue(t.env());
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM sales_calls WHERE lead_id = ?`, l.leadId), 1);
});

// ───────────── Scheduled callbacks and the AI Outbound Calendar ─────────────

test("[VOICE-005] [VOICE-003] callbacks paused: bookings are kept; on restart a callback more than 30 minutes late is marked missed, never dialled late", async () => {
  const t = await app();
  assert.deepEqual(await SO.saveOutboundModes(t.db, t.owner.id, { callbacks: false, cold: false }), []);
  const cb = await t.callbackLead();
  const row = await SO.enqueueSalesCall(t.db, cb.leadId, { requestedBy: null, mode: "callback", notBefore: t.now().toISOString(), now: t.now() });
  assert.equal((await SO.processSalesQueue(t.env())).dialled, 0);
  assert.equal((await SO.getSalesCall(t.db, row.id))!.status, "queued", "nothing is deleted while paused");
  t.setClock(new Date(t.now().getTime() + 45 * 60_000));
  assert.deepEqual(await SO.saveOutboundModes(t.db, t.owner.id, { callbacks: true, cold: false }), []);
  const r = await SO.processSalesQueue(t.env());
  assert.equal(r.dialled, 0, r.detail);
  const after = (await SO.getSalesCall(t.db, row.id))!;
  assert.ok(after.missed_at);
  assert.equal(after.status, "blocked");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM crm_activities WHERE lead_id = ? AND kind = 'task' AND body LIKE '%MISSED scheduled AI callback%'`, cb.leadId), 1);
  const c = t.client(); await c.login(t.owner.email, TEST_PASSWORD, t.owner.secret);
  assert.match(await (await c.get("/staff/sales-outbound")).text(), /Missed \(last 14 days\)/);
});

test("[VOICE-003] AI Outbound Calendar: 30-minute appointments, five per slot under concurrent booking, the sixth refused; Founder slots exclusive and separate", async () => {
  const t = await app(new Date("2026-11-02T14:00:00Z"));
  const cfg = voiceCfg();
  const at = t.now();
  const start = "2026-11-03T15:00:00.000Z"; // Tuesday 10:00 ET
  const tries = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => sched.book(t.db, cfg, at, sched.NO_CALENDAR, { name: `P${i}`, phone: `+1614555${4000 + i}`, startsAt: start, leadId: null, callId: null, isTest: true, source: "ai_receptionist" })));
  assert.equal(tries.filter((r) => r.status === "fulfilled").length, 5, "exactly five bookings in one slot");
  assert.ok(tries.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof sched.SlotUnavailableError));
  const rows = (await t.db.prepare(`SELECT duration_minutes, status FROM consultations WHERE starts_at = ?`).bind(start).all<{ duration_minutes: number; status: string }>()).results;
  assert.ok(rows.every((r) => r.duration_minutes === 30 && r.status === "confirmed"));
  // A full slot is not offered; a slot with four bookings still is.
  const av = await sched.availability(t.db, cfg, at, sched.NO_CALENDAR, { fromDate: "2026-11-03", limit: 48 });
  assert.ok(av.available && !av.slots.some((s) => s.startsAt === start));
  await t.db.prepare(`UPDATE consultations SET status = 'cancelled' WHERE id = (SELECT id FROM consultations WHERE starts_at = ? LIMIT 1)`).bind(start).run();
  const av2 = await sched.availability(t.db, cfg, at, sched.NO_CALENDAR, { fromDate: "2026-11-03", limit: 48 });
  assert.ok(av2.available && av2.slots.some((s) => s.startsAt === start), "four of five: still bookable");
  // Founder: the same time is free on the Founder Calendar (separate), and exclusive there.
  const route = { calendar: "founder_callback" as const, founderReason: "customer_requested_founder" as const };
  const f1 = await sched.book(t.db, cfg, at, sched.NO_CALENDAR, { name: "F1", phone: "+16145554100", startsAt: start, leadId: null, callId: null, isTest: true, source: "ai_receptionist", calendar: route });
  assert.equal(f1.booking.status, "requested", "held until the Founder confirms");
  await assert.rejects(sched.book(t.db, cfg, at, sched.NO_CALENDAR, { name: "F2", phone: "+16145554101", startsAt: start, leadId: null, callId: null, isTest: true, source: "ai_receptionist", calendar: route }), sched.SlotUnavailableError);
  // The same person cannot hold two bookings at the same time on one calendar.
  const dup = { name: "Dup", phone: "+16145554200", startsAt: "2026-11-03T16:00:00.000Z", leadId: null, callId: null, isTest: true, source: "ai_receptionist" as const, checkExisting: false };
  await sched.book(t.db, cfg, at, sched.NO_CALENDAR, dup);
  await assert.rejects(sched.book(t.db, cfg, at, sched.NO_CALENDAR, dup), sched.SlotUnavailableError, "the database refuses a duplicate booking even without the code check");
});

test("[VOICE-003] calendar windows: AI callbacks follow their own hours (default every day 09:00–20:00) and DST; Founder windows when set", () => {
  const c = voiceCfg();
  const ai = calendarView(c, "ai_follow_up");
  // Saturday is not a business day, but AI callbacks run every day.
  const sat = candidateSlots(ai, new Date("2026-11-07T12:00:00Z"), [], { limit: 3 });
  assert.equal(sat[0].startsAt, "2026-11-07T14:00:00.000Z", "Saturday 09:00 EST (after 60 minutes' notice)");
  // Spring-forward day (2027-03-14): 09:00 EDT = 13:00Z; no duplicated or skipped-hour slot.
  const dst = candidateSlots(ai, new Date("2027-03-14T05:00:00Z"), [], { limit: 30 });
  assert.equal(dst[0].startsAt, "2027-03-14T13:00:00.000Z");
  assert.equal(new Set(dst.map((s) => s.startsAt)).size, dst.length);
  c.scheduling.founder_hours.wed = [{ open: "13:00", close: "14:00" }];
  const founder = candidateSlots(calendarView(c, "founder_callback"), new Date("2026-11-02T14:00:00Z"), [], { limit: 4 });
  assert.deepEqual(founder.map((s) => s.startsAt), ["2026-11-04T18:00:00.000Z", "2026-11-04T18:30:00.000Z", "2026-11-11T18:00:00.000Z", "2026-11-11T18:30:00.000Z"]);
});

test("[VOICE-005] an AI Outbound Calendar booking queues one callback at its time; rescheduling moves it; cancelling cancels it", async () => {
  const t = await app(new Date("2026-11-02T14:00:00Z"));
  const cfg = voiceCfg();
  const cb = await t.callbackLead();
  const { booking } = await sched.book(t.db, cfg, t.now(), sched.NO_CALENDAR, { name: "Cal Back", phone: cb.phone, startsAt: "2026-11-03T15:00:00.000Z", leadId: cb.leadId, callId: null, isTest: true, source: "ai_receptionist" });
  const q = await syncAppointmentCallback(t.db, booking.id, { now: t.now(), reason: "Pricing for a bakery site" });
  assert.equal(q!.status, "queued");
  assert.equal(q!.not_before, "2026-11-03T15:00:00.000Z");
  const moved = await sched.reschedule(t.db, cfg, t.now(), sched.NO_CALENDAR, booking, "2026-11-04T16:00:00.000Z", { kind: "ai" });
  await syncAppointmentCallback(t.db, moved.id, { now: t.now() });
  const series = (await t.db.prepare(`SELECT status, not_before, appointment_id FROM sales_calls WHERE lead_id = ?`).bind(cb.leadId).all<{ status: string; not_before: string; appointment_id: string }>()).results;
  assert.deepEqual(series.map((x) => ({ ...x })), [{ status: "queued", not_before: "2026-11-04T16:00:00.000Z", appointment_id: moved.id }], "one series, moved — never a second call");
  await sched.cancel(t.db, moved, "test", { kind: "ai" });
  await syncAppointmentCallback(t.db, moved.id);
  assert.equal((await t.db.prepare(`SELECT status FROM sales_calls WHERE lead_id = ?`).bind(cb.leadId).first<{ status: string }>())!.status, "cancelled");
});

// ───────────── Owner dashboard ─────────────

test("[OWN-002] [SEC-005] one Owner page shows both calling switches, live capacity by mode and the ramp; only the Owner can change them; changes are audited", async () => {
  const t = await app();
  const c = t.client(); await c.login(t.owner.email, TEST_PASSWORD, t.owner.secret);
  const page = await (await c.get("/staff/sales-outbound")).text();
  assert.match(page, /data-calling-modes/);
  assert.match(page, /Scheduled AI Callbacks/);
  assert.match(page, /AI Cold Outreach/);
  assert.match(page, /name="callbacks"[^>]*checked/, "launch state: callbacks ON");
  assert.doesNotMatch(page, /name="cold"[^>]*checked/, "launch state: cold outreach OFF");
  assert.match(page, /Active 0\/5/);
  assert.match(page, /Cold-outreach ramp/);
  assert.equal((await c.post("/staff/sales-outbound/modes", { callbacks: "1" })).status, 303);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'sales_outbound.modes_updated'`), 1);
  assert.equal((await c.post("/staff/sales-outbound/ramp", { stage: "stage_2", "limit.launch": "0", "limit.pilot": "10", "limit.stage_2": "25", "limit.stage_3": "50", "limit.stage_4": "100", "limit.stage_5": "200" })).status, 422, "an increase without the Founder's authorisation is refused");
  assert.equal((await c.post("/staff/sales-outbound/capacity", { cold_max: "16", callback_reserved: "5", provider_limit: "20", inbound_headroom: "2", callback_max_per_day: "200" })).status, 422, "never more than 15 cold");
  const sales = await createStaff(t.db, "sales", "sales-modes@crestmont.test");
  const s = t.client(); await s.login(sales.email, TEST_PASSWORD, sales.secret);
  for (const path of ["/staff/sales-outbound/modes", "/staff/sales-outbound/ramp", "/staff/sales-outbound/capacity"]) assert.equal((await s.post(path, { cold: "1" })).status, 403, path);
});

// ───────────── Inbound receptionist: always selling ─────────────

test("[VOICE-004] the receptionist sells 24/7: at 9 a.m., 6 p.m., 11 p.m., 2 a.m., Sunday and a holiday it gives full answers; only live transfer follows staffed hours", async () => {
  assert.match(INBOUND_MASTER_INSTRUCTIONS, /You work 24\/7/);
  assert.doesNotMatch(INBOUND_MASTER_INSTRUCTIONS, /not available around the clock/);
  assert.match(INBOUND_MASTER_INSTRUCTIONS, /Never suggest the Founder yourself/);
  const t = await app();
  const cfg = voiceCfg(); cfg.holidays = ["2026-11-26"];
  await saveVoiceConfig(t.db, t.owner.id, cfg);
  const c = t.client();
  const call = async (id: string, name: string, args: Record<string, unknown> = {}) => {
    const body = JSON.stringify({ name, call: { call_id: id, call_type: "phone_call", from_number: "+16145557000", to_number: "+16145550199", direction: "inbound" }, args });
    const res = await c.request("POST", "/api/webhooks/retell/functions", { body, headers: { "content-type": "application/json", "x-retell-signature": await signRetell(IN, body) } });
    return (await res.json()) as Record<string, any>;
  };
  const moments: [string, string][] = [["9am", "2026-11-03T14:00:00Z"], ["6pm", "2026-11-03T23:00:00Z"], ["11pm", "2026-11-04T04:00:00Z"], ["2am", "2026-11-04T07:00:00Z"], ["sunday", "2026-11-08T17:00:00Z"], ["holiday", "2026-11-26T17:00:00Z"]];
  for (const [label, iso] of moments) {
    t.setClock(new Date(iso));
    const pricing = await call(`c_${label}`, "get_packages_pricing");
    assert.ok(Array.isArray(pricing.pricing?.packages) && pricing.pricing.packages.length >= 3, `${label}: full pricing ${JSON.stringify(pricing).slice(0, 200)}`);
    const lead = await call(`c_${label}`, "crm_upsert_lead", { name: `Night Owl ${label}`, phone: "+16145557000", email: `owl-${label}@example.com`, interest: "business", requirements: "A five-page site for my bakery with online ordering" });
    assert.equal(lead.lead_saved, true, `${label}: lead captured`);
    const hours = await call(`c_${label}`, "get_business_hours");
    assert.equal(hours.ai_available, true, `${label}: the AI is always available`);
    const transfer = await call(`c_${label}`, "check_transfer_availability");
    if (!transfer.transfer_available) assert.match(transfer.message, /Keep helping the caller yourself/, `${label}: no message-taking fallback`);
    for (const r of [pricing, lead, hours, transfer]) assert.doesNotMatch(JSON.stringify(r), /we('| a)re closed|take a message/i, label);
  }
  // Night and Sunday call starts are full-service: receptionist_mode is "full" whenever the budget is open.
  t.setClock(new Date("2026-11-08T07:00:00Z"));
  const inboundBody = JSON.stringify({ event: "call_inbound", call_inbound: { call_id: "in_night", from_number: "+16145557000", to_number: "+16145550199" } });
  const res = await c.request("POST", "/api/webhooks/retell/inbound", { body: inboundBody, headers: { "content-type": "application/json", "x-retell-signature": await signRetell(IN, inboundBody) } });
  const vars = ((await res.json()) as { call_inbound: { dynamic_variables: Record<string, string> } }).call_inbound.dynamic_variables;
  assert.equal(vars.receptionist_mode, "full");
  assert.equal(vars.transfer_number, "", "no live transfer outside staffed hours");
});
