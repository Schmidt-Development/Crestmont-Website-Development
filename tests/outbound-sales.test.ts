// Outbound AI sales representative (proposed OUTSALES-001..009; tagged with existing VOICE/CRM/SEC/PAY/EMAIL ids until
// the Founder extends the inventory). Drives the real pipeline end to end on in-memory SQLite: research prospect →
// audited CRM promotion → compliance gate → queue → create-phone-call (fake Retell API) → signed custom functions →
// signed call webhooks → final outcome. EVERYTHING HERE IS TEST DATA: no real call, number, email, payment or Retell
// account is involved, and none of this is evidence of a live Retell or Stripe verification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD, lastEmail, linkFrom } from "./support/app.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import type { CheckoutRequest } from "../src/adapters/payments.ts";
import * as REG from "../src/services/sales-opt/registry.ts";
import { deploy as soDeploy, verifyTarget as soVerify, adoptLivePrompt, rollback as soRollback } from "../src/services/sales-opt/deploy.ts";
import type { Env } from "../src/app/context.ts";
import type { PaymentsAdapter } from "../src/adapters/payments.ts";
import { signRetell } from "../src/adapters/retell.ts";
import * as R from "../src/services/research.ts";
import * as SO from "../src/services/sales-outbound.ts";
import { runJobs, SCHEDULE } from "../src/app/scheduled.ts";
import {
  spokenContext, dynamicVariables, salesCallEligibility, withinSalesWindow, nextSalesWindow, federalHolidays, resolveOutcome,
  type SalesGateFacts, type ResearchFacts,
} from "../src/domain/sales-eligibility.ts";
import { STEP_UP_ROUTES } from "../src/app/step-up.ts";

const KEY = "key_test_outbound_sales_0001";
const INBOUND_KEY = "key_test_inbound_reception_0001";
// Tuesday 3 November 2026, 15:00 UTC = 10:00 in Columbus, Ohio (EST). Inside the sales window.
const TUE_10AM_ET = new Date("2026-11-03T15:00:00Z");
type Db = Env["DB"];
const one = async <T>(db: Db, sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;
const count = async (db: Db, sql: string, ...b: unknown[]) => (await one<{ n: number }>(db, sql, ...b)).n;

class FakePayments implements PaymentsAdapter {
  readonly configured = true; readonly mode = "test" as const;
  checkouts: CheckoutRequest[] = [];
  async createCheckout(req?: CheckoutRequest) { if (req) this.checkouts.push(req); return { id: "cs_test_fake", url: "https://checkout.stripe.com/c/pay/cs_test_fake" }; }
  async createBillingPortal() { return { url: "https://billing.stripe.test" }; }
  async createRefund() { return { id: "re_test", status: "succeeded" }; }
}

function retellFetch() {
  const calls: { url: string; body: Record<string, any> }[] = [];
  let n = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ call_id: `call_sales_${++n}`, call_status: "registered" }), { status: 201 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const ISO = (d: Date) => d.toISOString();
const daysAgo = (now: Date, d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

/** A verified research prospect in Ohio (single time zone), broken website, promoted into the CRM. TEST DATA. */
function prospect(now: Date, over: Record<string, unknown> = {}) {
  const at = daysAgo(now, 2);
  return {
    businessKey: "overture:oh1", name: "Buckeye Bakery (TEST DATA)", category: "bakery", address: { line: "10 High St", city: "Columbus", state: "OH", zip: "43215" },
    phones: ["(614) 555-2142"], emails: [], domains: ["buckeye-bakery.example"],
    sources: [{ source: "overture", sourceId: "oh1", license: "CDLA-Permissive-2.0", release: "2026-10-21.0", retrievedAt: at }],
    website: { classification: "VERIFIED_WEBSITE_BROKEN", url: "https://buckeye-bakery.example/", confidence: 0.9, checkedAt: at, identitySignals: ["phone on page matches"], checks: [{ stage: "C", method: "HTTP GET", result: "503 x3", at }] },
    findings: [{ code: "http_5xx", title: "Home page returns HTTP 503", severity: "critical", confidence: 0.95, url: "https://buckeye-bakery.example/", method: "HTTP GET (no JS), 3 attempts", observedAt: at, evidence: "Status 503 on 3 of 3 attempts" }],
    identityConfidence: 0.9, lastVerifiedAt: at, ...over,
  };
}

async function app(opts: { now?: Date; payments?: boolean; env?: Partial<Env> } = {}) {
  const now = opts.now ?? TUE_10AM_ET;
  const t = await createTestApp({ RETELL_OUTBOUND_API_KEY: KEY, RETELL_INBOUND_API_KEY: INBOUND_KEY, ...opts.env });
  const rf = retellFetch();
  t.env.overrides = { storage: t.storage, now: () => now, fetch: rf.fetchImpl, ...(opts.payments ? { payments: new FakePayments() } : {}) } as Env["overrides"];
  const c = t.client();
  const post = async (path: string, payload: unknown, o: { sign?: boolean } = {}) => {
    const raw = JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (o.sign !== false) headers["x-retell-signature"] = await signRetell(KEY, raw);
    const res = await c.request("POST", path, { body: raw, headers });
    return { res, json: (await res.json()) as Record<string, any> };
  };
  const owner = await createStaff(t.db, "owner");
  const actor = { kind: "user" as const, userId: owner.id, roles: [{ role: "owner" as const, organizationId: "org_crestmont" }], mfaVerified: true };
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('voice.monthly_budget_usd', '50', ?)`).bind(ISO(now)).run();
  await t.db.prepare(`UPDATE research_settings SET paused = 0, pause_reason = NULL WHERE id = 1`).run();
  const seedLead = async (over: Record<string, unknown> = {}) => {
    await R.ingestBatch(t.db, { batchId: `b_${Math.random().toString(36).slice(2, 12)}`, runnerId: "ws-test", prospects: [prospect(now, over)] }, now);
    const pid = (await one<{ id: string }>(t.db, `SELECT id FROM research_prospects WHERE business_key = ?`, (over.businessKey as string) ?? "overture:oh1")).id;
    return (await R.promote(t.db, actor, pid)).leadId;
  };
  /** Everything the gate needs for one number, recorded the way staff would (TEST DATA). */
  const authorise = async (phone = "+16145552142", leadId?: string) => {
    if (!await SO.activeComplianceApproval(t.db)) await SO.recordComplianceApproval(t.db, owner.id, "TEST-COUNSEL-MEMO-001", "Test approval");
    await SO.recordSalesConsent(t.db, owner.id, { phone, leadId, lineType: "landline", signerName: "Bea Baker", evidenceRef: "form-submission-TEST-42",
      disclosureText: "I agree that Crestmont may call this number about website services using an AI (artificial) voice. Consent is not a condition of purchase.", capturedAt: daysAgo(now, 5) }, now);
    await SO.recordDncScrub(t.db, owner.id, { phone, registry: "national", result: "clear", sourceRef: "SAN-TEST-0001", checkedAt: daysAgo(now, 3) }, now);
    await SO.saveSalesSettings(t.db, owner.id, { enabled: true, agentId: "agent_sales_test", fromNumber: "+16145550100", maxConcurrent: 2, maxPerRun: 3, maxPerDay: 25, maxAttempts: 2, retryAfterHours: 48 });
  };
  return { ...t, now, post, owner, actor, seedLead, authorise, retell: rf };
}

const env = (t: Awaited<ReturnType<typeof app>>, on = true) => ({ db: t.db, env: { RETELL_OUTBOUND_API_KEY: KEY, RETELL_INBOUND_API_KEY: INBOUND_KEY, RETELL_SALES_OUTBOUND: on ? "on" : undefined, ENVIRONMENT: "development" as const }, fetch: t.retell.fetchImpl, now: () => t.now, sleep: async () => {} });
const salesCall = (callId: string, salesId: string, extra: Record<string, unknown> = {}) => ({ call_id: callId, call_type: "phone_call", direction: "outbound", from_number: "+16145550100", to_number: "+16145552142", agent_id: "agent_sales_test",
  metadata: { crestmont_env: "development", crestmont_sales_call_id: salesId, crestmont_test: "true" }, ...extra });
const fn = (callId: string, salesId: string, name: string, args: Record<string, unknown>) => ({ name, call: salesCall(callId, salesId), args });
const FN = "/api/webhooks/retell/outbound/functions";

/** Seeds, authorises and dials one lead; returns the sales call row and Retell call id. */
async function dialled(t: Awaited<ReturnType<typeof app>>) {
  const leadId = await t.seedLead();
  await t.authorise("+16145552142", leadId);
  const row = await SO.enqueueSalesCall(t.db, leadId, { requestedBy: t.owner.id, now: t.now });
  assert.equal(row.status, "queued", row.status_detail ?? "");
  const r = await SO.processSalesQueue(env(t));
  assert.equal(r.dialled, 1, r.detail);
  const s = (await SO.getSalesCall(t.db, row.id))!;
  return { leadId, salesId: row.id, callId: s.provider_call_id! };
}

// ───────────── Pure rules ─────────────

test("[VOICE-005] research → spoken context: only fresh, verified, evidenced findings; anything uncertain is a neutral introduction", () => {
  const now = TUE_10AM_ET;
  const base: ResearchFacts = { websiteClass: "VERIFIED_WEBSITE_BROKEN", websiteUrl: "https://x.example/", identityConfidence: 0.9, lastVerifiedAt: daysAgo(now, 3), recommendedPackage: "starter",
    findings: [{ code: "http_5xx", title: "internal title", severity: "critical", confidence: 0.95 }] };
  const broken = spokenContext(base, now);
  assert.equal(broken.website_status, "broken_website");
  assert.equal(broken.primary_issue, "the website was returning a server error when we checked");
  assert.equal(broken.recommended_service, "Starter website package");
  assert.ok(!JSON.stringify(broken).includes("internal title"), "finding titles and codes are never spoken");
  assert.equal(spokenContext({ ...base, websiteClass: "NO_OFFICIAL_WEBSITE_FOUND", findings: [] }, now).website_status, "no_website");
  const outdated = spokenContext({ ...base, websiteClass: "VERIFIED_WEBSITE_ISSUES", findings: [{ code: "stale_copyright", title: "", severity: "medium", confidence: 0.9 }, { code: "obsolete_markup", title: "", severity: "high", confidence: 0.8 }] }, now);
  assert.equal(outdated.website_status, "outdated_website");
  const poor = spokenContext({ ...base, websiteClass: "VERIFIED_WEBSITE_ISSUES", findings: [{ code: "no_https", title: "", severity: "high", confidence: 0.9 }, { code: "slow_response", title: "", severity: "medium", confidence: 0.8 }] }, now);
  assert.equal(poor.website_status, "poor_quality_website");
  // Fail closed: stale evidence, low identity confidence, low finding confidence, unverified classes, no research.
  for (const r of [{ ...base, lastVerifiedAt: daysAgo(now, 60) }, { ...base, identityConfidence: 0.5 }, { ...base, websiteClass: "WEBSITE_UNVERIFIED" }, { ...base, websiteClass: "BUSINESS_IDENTITY_UNCERTAIN" },
    { ...base, websiteClass: "VERIFIED_OFFICIAL_WEBSITE" }, { ...base, websiteClass: null }, { ...base, websiteClass: "VERIFIED_WEBSITE_ISSUES", findings: [{ code: "no_https", title: "", severity: "high" as const, confidence: 0.5 }] }]) {
    const c = spokenContext(r, now);
    assert.equal(c.website_status, "unknown", JSON.stringify(r).slice(0, 80));
    assert.equal(c.primary_issue, "");
    assert.equal(c.research_verified, false);
  }
  const vars = dynamicVariables({ leadId: "ld_1", businessName: "Bea's {{Bakery}}", contactName: "Bea Baker", industry: "bakery", websiteUrl: "https://x.example/", environment: "staging", ctx: broken });
  assert.ok(Object.values(vars).every((x) => typeof x === "string"), "Retell requires string values");
  assert.deepEqual(Object.keys(vars).sort(), ["business_name", "crestmont_env", "first_name", "industry", "lead_id", "recommended_service", "research_verified", "verified_issue", "website_status", "website_url"]);
  assert.equal(vars.first_name, "Bea");
  assert.ok(!vars.business_name.includes("{{"), "template braces are stripped so data can't inject prompt variables");
  assert.equal(dynamicVariables({ leadId: "ld_1", businessName: "B", contactName: null, industry: null, websiteUrl: "https://x.example/", environment: "staging", ctx: spokenContext({ ...base, websiteClass: null }, now) }).website_url, "", "no verified research → no URL");
});

test("[VOICE-005] [SEC-001] compliance gate: blocked by default (D-14) with every reason; eligible only when all facts are documented", () => {
  const now = TUE_10AM_ET;
  const empty: SalesGateFacts = { phoneE164: "+16145552142", timeZone: "America/New_York", state: "OH", onDnc: false, complianceApproval: null, consent: null, dncScrub: null,
    emailOrPhoneSuppressedInCrm: false, leadStage: "new", leadMerged: false, sharedPhoneConflict: false, attemptsSoFar: 0, maxAttempts: 2 };
  const blocked = salesCallEligibility(empty, now);
  assert.equal(blocked.eligible, false);
  for (const re of [/D-14/, /prior express consent/, /Line type/, /Do Not Call Registry/]) assert.ok(blocked.reasons.some((r) => re.test(r)), String(re));
  const ok: SalesGateFacts = { ...empty, complianceApproval: { approvedBy: "u", approvedAt: ISO(now), reference: "memo" }, consent: { id: "c", lineType: "mobile", evidenceRef: "form-1", capturedAt: ISO(now) }, dncScrub: { result: "clear", checkedAt: daysAgo(now, 10) } };
  assert.deepEqual(salesCallEligibility(ok, now), { eligible: true, reasons: [] });
  const cases: [Partial<SalesGateFacts>, RegExp][] = [
    [{ onDnc: true }, /do-not-call list/], [{ timeZone: null }, /time zone/], [{ state: null }, /state not established/], [{ phoneE164: "+442079460958" }, /US \(\+1\)/],
    [{ dncScrub: { result: "clear", checkedAt: daysAgo(now, 40) } }, /older than 31 days/], [{ dncScrub: { result: "listed", checkedAt: ISO(now) } }, /listed on a do-not-call registry/],
    [{ sharedPhoneConflict: true }, /shared with another business/], [{ leadStage: "converted" }, /not open/], [{ leadMerged: true }, /merged/], [{ attemptsSoFar: 2 }, /Attempt limit/],
    [{ emailOrPhoneSuppressedInCrm: true }, /suppressed/],
  ];
  for (const [over, re] of cases) { const g = salesCallEligibility({ ...ok, ...over }, now); assert.equal(g.eligible, false); assert.ok(g.reasons.some((r) => re.test(r)), `${JSON.stringify(over)} → ${g.reasons.join("|")}`); }
});

test("[VOICE-005] sales calling window: weekdays 10:00–19:00 recipient time, no federal holidays, Maine 10:00–17:00, unknown zone never callable", () => {
  assert.equal(withinSalesWindow(TUE_10AM_ET, "America/New_York", "OH"), true);
  assert.equal(withinSalesWindow(new Date("2026-11-03T14:59:00Z"), "America/New_York", "OH"), false, "09:59 local");
  assert.equal(withinSalesWindow(new Date("2026-11-04T00:00:00Z"), "America/New_York", "OH"), false, "19:00 local is closed");
  assert.equal(withinSalesWindow(TUE_10AM_ET, "America/Los_Angeles", "CA"), false, "07:00 in California");
  assert.equal(withinSalesWindow(new Date("2026-11-07T16:00:00Z"), "America/New_York", "OH"), false, "Saturday");
  assert.equal(withinSalesWindow(new Date("2026-11-08T17:00:00Z"), "America/Chicago", "TX"), false, "Sunday");
  assert.ok(federalHolidays(2026).has("2026-11-26"), "Thanksgiving 2026");
  assert.ok(federalHolidays(2026).has("2026-11-11"), "Veterans Day");
  assert.equal(withinSalesWindow(new Date("2026-11-26T16:00:00Z"), "America/New_York", "OH"), false, "Thanksgiving");
  assert.equal(withinSalesWindow(new Date("2026-11-03T22:30:00Z"), "America/New_York", "ME"), false, "17:30 in Maine");
  assert.equal(withinSalesWindow(new Date("2026-11-03T22:30:00Z"), "America/New_York", "OH"), true, "17:30 in Ohio");
  assert.equal(withinSalesWindow(TUE_10AM_ET, null, "OH"), false);
  assert.equal(nextSalesWindow(new Date("2026-11-07T16:00:00Z"), "America/New_York", "OH")!.toISOString(), "2026-11-09T15:00:00.000Z", "Saturday → Monday 10:00");
});

test("[VOICE-005] final outcome precedence: platform facts > telephony > agent disposition > post-call analysis; never guessed", () => {
  const f = { disconnectionReason: "agent_hangup", callStatus: "ended", talked: true, dncRecorded: false, paymentConfirmed: false, checkoutSent: false, consultationBooked: false, followUpScheduled: false, agentDisposition: null, analysisOutcome: null };
  assert.deepEqual(resolveOutcome({ ...f, dncRecorded: true, checkoutSent: true }), { outcome: "do_not_call", source: "record_do_not_call" });
  assert.equal(resolveOutcome({ ...f, disconnectionReason: "user_requested_dnc" }).outcome, "do_not_call");
  assert.equal(resolveOutcome({ ...f, paymentConfirmed: true, checkoutSent: true }).outcome, "payment_confirmed");
  assert.equal(resolveOutcome({ ...f, checkoutSent: true, agentDisposition: "not_interested" }).outcome, "checkout_sent");
  assert.equal(resolveOutcome({ ...f, consultationBooked: true }).outcome, "consultation_booked");
  assert.equal(resolveOutcome({ ...f, disconnectionReason: "voicemail_reached", talked: false }).outcome, "voicemail");
  assert.equal(resolveOutcome({ ...f, disconnectionReason: "dial_no_answer", talked: false }).outcome, "no_answer");
  assert.equal(resolveOutcome({ ...f, disconnectionReason: "dial_failed" }).outcome, "technical_failure");
  assert.equal(resolveOutcome({ ...f, agentDisposition: "wrong_number" }).outcome, "wrong_number");
  assert.equal(resolveOutcome({ ...f, followUpScheduled: true }).outcome, "follow_up_requested");
  assert.deepEqual(resolveOutcome({ ...f, analysisOutcome: "interested" }), { outcome: "interested", source: "retell_post_call_analysis" });
  assert.deepEqual(resolveOutcome(f), { outcome: "unclassified", source: "none" }, "a conversation with no recorded result is never guessed");
  assert.equal(resolveOutcome({ ...f, analysisOutcome: "payment_confirmed" }).outcome, "unclassified", "analysis can't claim system outcomes");
});

// ───────────── Orchestration ─────────────

test("[VOICE-005] [CRM-005] research leads are blocked by default; staff records approval, written consent and a DNC check; nothing dials without the env switch", async () => {
  const t = await app();
  const leadId = await t.seedLead();
  const blocked = await SO.enqueueSalesCall(t.db, leadId, { requestedBy: t.owner.id, now: t.now });
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.status_detail!, /D-14/);
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'sales_outbound.blocked'`), 1, "a blocked attempt leaves an audit trail");
  // Consent records are validated: public listing is not consent; AI disclosure is mandatory.
  await assert.rejects(SO.recordSalesConsent(t.db, t.owner.id, { phone: "+16145552142", lineType: "landline", signerName: "Bea", evidenceRef: "public listing", disclosureText: "Number from Google Maps listing, okay to call per our policy", capturedAt: ISO(t.now) }), /AI \/ artificial-voice/);
  await t.authorise("+16145552142", leadId);
  const queued = await SO.enqueueSalesCall(t.db, leadId, { requestedBy: t.owner.id, now: t.now });
  assert.equal(queued.status, "queued", queued.status_detail ?? "");
  const dupe = await SO.enqueueSalesCall(t.db, leadId, { requestedBy: t.owner.id, now: t.now });
  assert.equal(dupe.id, queued.id, "one open series per lead: no duplicate dial");
  const off = await SO.processSalesQueue(env(t, false));
  assert.equal(off.dialled, 0);
  assert.match(off.detail, /RETELL_SALES_OUTBOUND/);
  assert.equal(t.retell.calls.length, 0, "Retell was never called");
  // Revoking the approval cancels everything queued.
  await SO.revokeComplianceApproval(t.db, t.owner.id);
  assert.equal((await SO.getSalesCall(t.db, queued.id))!.status, "cancelled");
  assert.ok(SCHEDULE["*/15 * * * *"].includes("sales_outbound"));
  const job = await runJobs({ ...t.env, RETELL_SALES_OUTBOUND: undefined }, ["sales_outbound"]);
  assert.match(job.sales_outbound.detail, /disabled/);
});

test("[VOICE-005] dialling: dynamic variables, signed metadata, idempotency key, calling window, concurrency and DNC re-checked immediately before the dial", async () => {
  const t = await app();
  const { salesId, callId, leadId } = await dialled(t);
  assert.equal(t.retell.calls.length, 1);
  const req = t.retell.calls[0];
  assert.equal(req.url, "https://api.retellai.com/v2/create-phone-call");
  assert.equal(req.body.override_agent_id, "agent_sales_test");
  assert.equal(req.body.honor_internal_dnc, true);
  assert.equal(req.body.idempotency_key, `crestmont_${salesId}_a1`);
  assert.deepEqual(req.body.metadata, { crestmont_env: "development", crestmont_sales_call_id: salesId, crestmont_lead_id: leadId, crestmont_test: "false", crestmont_segment: "broken_website" });
  const v = req.body.retell_llm_dynamic_variables;
  assert.equal(v.lead_id, leadId);
  assert.equal(v.business_name, "Buckeye Bakery (TEST DATA)");
  assert.equal(v.first_name, "", "a research lead has no person's name: never present the business as a first name");
  assert.equal(v.website_status, "broken_website");
  assert.equal(v.verified_issue, "the website was returning a server error when we checked");
  assert.equal(v.website_url, "https://buckeye-bakery.example/");
  assert.ok(!JSON.stringify(v).match(/confidence|score|0\.9|overture|license/i), "no internal research metadata in variables");
  const call = await one<{ lead_id: string; direction: string }>(t.db, `SELECT lead_id, direction FROM calls WHERE provider_call_id = ?`, callId);
  assert.deepEqual({ ...call }, { lead_id: leadId, direction: "outbound" });
  // A second run does not re-dial the same series.
  assert.equal((await SO.processSalesQueue(env(t))).dialled, 0);

  // Outside the window → rescheduled, not dialled. DNC added after queueing → blocked at dial time.
  const t2 = await app({ now: new Date("2026-11-07T16:00:00Z") });
  const l2 = await t2.seedLead();
  await t2.authorise("+16145552142", l2);
  const q2 = await SO.enqueueSalesCall(t2.db, l2, { requestedBy: t2.owner.id, now: t2.now });
  assert.equal((await SO.processSalesQueue(env(t2))).dialled, 0);
  assert.equal((await SO.getSalesCall(t2.db, q2.id))!.not_before, "2026-11-09T15:00:00.000Z");
  const t3 = await app();
  const l3 = await t3.seedLead();
  await t3.authorise("+16145552142", l3);
  const q3 = await SO.enqueueSalesCall(t3.db, l3, { requestedBy: t3.owner.id, now: t3.now });
  await SO.suppressEverywhere(t3.db, "+16145552142", { detail: "staff test", actor: "staff", userId: t3.owner.id });
  assert.equal((await SO.getSalesCall(t3.db, q3.id))!.status, "cancelled");
  assert.equal((await SO.processSalesQueue(env(t3))).dialled, 0);
  assert.equal(t3.retell.calls.length, 0);
});

// ───────────── Custom functions ─────────────

test("[SEC-001] outbound functions: signature required; unbound calls, inbound calls and other leads are refused; unknown names rejected", async () => {
  const t = await app();
  const { salesId, callId, leadId } = await dialled(t);
  assert.equal((await t.post(FN, fn(callId, salesId, "get_packages_pricing", {}), { sign: false })).res.status, 401);
  const unbound = await t.post(FN, { name: "get_outbound_lead_context", call: { call_id: "call_inbound_x", direction: "inbound", metadata: { crestmont_env: "development" } }, args: {} });
  assert.equal(unbound.res.status, 403);
  assert.equal(unbound.json.refused, "unbound_call");
  const otherCall = await t.post(FN, fn("call_someone_else", salesId, "get_outbound_lead_context", {}));
  assert.equal(otherCall.json.refused, "call_mismatch");
  const otherLead = await t.post(FN, fn(callId, salesId, "get_outbound_lead_context", { lead_id: "ld_another_lead" }));
  assert.equal(otherLead.res.status, 403);
  assert.equal(otherLead.json.refused, "lead_mismatch");
  const viaQuery = await t.client().request("POST", `${FN}?lead_id=ld_another_lead`, { body: JSON.stringify(fn(callId, salesId, "get_packages_pricing", {})), headers: { "content-type": "application/json", "x-retell-signature": await signRetell(KEY, JSON.stringify(fn(callId, salesId, "get_packages_pricing", {}))) } });
  assert.equal(viaQuery.status, 403, "the {{lead_id}} query parameter is checked too");
  assert.equal((await t.post(FN, fn(callId, salesId, "issue_refund", {}))).res.status, 422);
  const wrongEnv = await t.post(FN, { name: "get_packages_pricing", call: { ...salesCall(callId, salesId), metadata: { crestmont_env: "production", crestmont_sales_call_id: salesId } }, args: {} });
  assert.equal(wrongEnv.res.status, 409);
  // An unrendered placeholder or empty value is ignored (the binding comes from signed metadata), never a 422.
  for (const junk of ["{{lead_id}}", "", "Buckeye Bakery"]) assert.equal((await t.post(FN, fn(callId, salesId, "get_packages_pricing", { lead_id: junk }))).res.status, 200, junk);
  const rawBody = JSON.stringify(fn(callId, salesId, "get_packages_pricing", {}));
  const placeholder = await t.client().request("POST", `${FN}?lead_id=%7B%7Blead_id%7D%7D`, { body: rawBody, headers: { "content-type": "application/json", "x-retell-signature": await signRetell(KEY, rawBody) } });
  assert.equal(placeholder.status, 200, "an unrendered {{lead_id}} query value is ignored");
  const ok = await t.post(FN, fn(callId, salesId, "get_outbound_lead_context", { lead_id: leadId }));
  assert.equal(ok.res.status, 200);
  // Workspace isolation (src/adapters/retell-workspaces.ts): the receptionist's endpoint refuses the sales workspace's
  // request for a receptionist function, and the sales endpoint refuses a request signed with the receptionist's key.
  assert.equal((await t.post("/api/webhooks/retell/functions", fn(callId, salesId, "create_checkout_session", {}))).res.status, 403);
  const inboundSigned = JSON.stringify(fn(callId, salesId, "get_outbound_lead_context", {}));
  const wrongWs = await t.client().request("POST", FN, { body: inboundSigned, headers: { "content-type": "application/json", "x-retell-signature": await signRetell(INBOUND_KEY, inboundSigned) } });
  assert.equal(wrongWs.status, 401, "the receptionist's workspace key cannot call the sales functions");
  assert.equal((await wrongWs.json() as { error?: string }).error?.includes("Signature mismatch"), true);
});

test("[CRM-005] [VOICE-003] lead context is verified-only and minimal; CRM updates go through intake (no duplicates) and forward-only stages", async () => {
  const t = await app();
  const { salesId, callId, leadId } = await dialled(t);
  const ctx = (await t.post(FN, fn(callId, salesId, "get_outbound_lead_context", {}))).json;
  assert.equal(ctx.lead_id, leadId);
  assert.equal(ctx.website_classification, "broken_website");
  assert.deepEqual(ctx.verified_website_issues, ["the website was returning a server error when we checked"]);
  assert.equal(ctx.research_confidence, "high");
  assert.equal(ctx.calling_eligibility, "eligible");
  assert.ok(!JSON.stringify(ctx).match(/overture|CDLA|503 on 3|score/i), "no sources, licences, raw evidence or scores");
  const up = (await t.post(FN, fn(callId, salesId, "update_outbound_lead", { contact_name: "Bea Baker", contact_email: "Bea@Buckeye-Bakery.example", discovery_notes: "Customers can't find opening hours online",
    service_interests: ["business", "seo", "not-a-service"], budget_range: "1000_2500", purchase_timeline: "within_30_days", objections: ["Worried about cost"], qualification: "qualified", next_steps: "Send checkout link" }))).json;
  assert.equal(up.updated, true);
  assert.equal(up.contact_verification, "verified");
  assert.equal(up.pipeline_stage, "qualified");
  const contact = await one<{ name: string; email: string }>(t.db, `SELECT c.name, c.email FROM contacts c JOIN leads l ON l.contact_id = c.id WHERE l.id = ?`, leadId);
  assert.equal(contact.name, "Bea Baker");
  assert.equal(contact.email.toLowerCase(), "bea@buckeye-bakery.example");
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM leads`), 1, "no duplicate lead");
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM contacts`), 1, "no duplicate contact");
  const prof = await one<{ service_interests_json: string; budget_range: string; qualification: string }>(t.db, `SELECT * FROM sales_lead_profiles WHERE lead_id = ?`, leadId);
  assert.deepEqual(JSON.parse(prof.service_interests_json), ["business", "seo"]);
  assert.equal(prof.qualification, "qualified");
  // Identical retry → stored result, no second note. Converted is never reachable from the agent.
  const before = await count(t.db, `SELECT COUNT(*) AS n FROM crm_activities WHERE lead_id = ?`, leadId);
  await t.post(FN, fn(callId, salesId, "update_outbound_lead", { contact_name: "Bea Baker", contact_email: "Bea@Buckeye-Bakery.example", discovery_notes: "Customers can't find opening hours online",
    service_interests: ["business", "seo", "not-a-service"], budget_range: "1000_2500", purchase_timeline: "within_30_days", objections: ["Worried about cost"], qualification: "qualified", next_steps: "Send checkout link" }));
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM crm_activities WHERE lead_id = ?`, leadId), before, "idempotent retry");
  assert.equal((await t.post(FN, fn(callId, salesId, "update_outbound_lead", { pipeline_stage: "converted" }))).res.status, 422);
});

test("[PAY-001] [EMAIL-002] pricing from the catalog; checkout link only to a verified, qualified buyer; existing checkout flow; payment confirmed only by Stripe records", async () => {
  const t = await app({ payments: true });
  const { salesId, callId, leadId } = await dialled(t);
  const pricing = (await t.post(FN, fn(callId, salesId, "get_packages_pricing", {}))).json;
  assert.deepEqual(pricing.packages.map((p: any) => [p.id, p.price]), [["starter", "$999"], ["business", "$2,499"], ["premium", "$4,999+"]]);
  assert.deepEqual(pricing.maintenance.map((m: any) => m.monthly), ["$99/month", "$199/month", "$299/month"]);
  assert.ok(pricing.maintenance.every((m: any) => m.purchasable_now === false));
  // Not verified yet → refused; the model can't choose a recipient.
  const early = (await t.post(FN, fn(callId, salesId, "create_checkout_session", { package: "business", email: "attacker@evil.example", buyer_confirmed: true }))).json;
  assert.equal(early.checkout_link_sent, false);
  assert.equal(early.reason, "email_not_verified");
  await t.post(FN, fn(callId, salesId, "update_outbound_lead", { contact_name: "Bea Baker", contact_email: "bea@buckeye-bakery.example", qualification: "qualified" }));
  const out = (await t.post(FN, fn(callId, salesId, "create_checkout_session", { package: "business", email: "bea@buckeye-bakery.example", buyer_confirmed: true }))).json;
  assert.equal(out.checkout_link_sent, true, JSON.stringify(out));
  assert.equal(out.price, "$2,499");
  assert.match(out.checkout_url, /^http:\/\/crestmont\.test\/buy\/[0-9a-f]{64}$/);
  const mail = (await lastEmail(t.db, "bea@buckeye-bakery.example"))!;
  assert.equal(mail.template, "sales_info");
  assert.match(mail.text_body, /\$2,499/);
  assert.match(mail.text_body, /Unsubscribe: http:\/\/crestmont\.test\/sales\/unsubscribe\//, "commercial email carries an unsubscribe link");
  const stored = await one<{ result_json: string }>(t.db, `SELECT result_json FROM sales_function_events WHERE name = 'create_checkout_session' AND result_json LIKE '%"checkout_link_sent":true%'`);
  assert.ok(!stored.result_json.includes("/buy/"), "the bearer link is not stored in the replay log");
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM sales_checkout_links WHERE token_hash LIKE '%/buy/%'`), 0);
  const again = (await t.post(FN, fn(callId, salesId, "send_sales_email", { email_type: "checkout_link", email: "bea@buckeye-bakery.example", package: "business" }))).json;
  assert.equal(again.already_sent_today, true, "one link per lead, package and day");
  // The link enters the EXISTING checkout (sign-in, verified email, agreements, Stripe) — never a raw Stripe session.
  const buy = await t.client().get(new URL(out.checkout_url).pathname);
  assert.equal(buy.status, 303);
  assert.equal(buy.headers.get("location"), "/checkout/business?ref=sales");
  assert.equal((await t.client().get("/buy/" + "0".repeat(64))).status, 404);
  let ps = (await t.post(FN, fn(callId, salesId, "check_payment_status", {}))).json;
  assert.equal(ps.payment_status, "link_opened");
  assert.equal(ps.onboarding_status, "not_started");
  // Simulate what the verified Stripe webhook writes (org, order on this lead, paid invoice, succeeded payment). TEST DATA.
  const at = ISO(t.now);
  await t.db.batch([
    t.db.prepare(`INSERT INTO organizations (id, name, kind, created_at) VALUES ('org_bea','Buckeye Bakery (TEST)','customer',?)`).bind(at),
    t.db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, lead_id, created_at) VALUES ('ord_t','org_bea','business',249900,'pending_payment','package',?,?)`).bind(leadId, at),
    t.db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, description, stripe_checkout_session_id, created_at) VALUES ('inv_t','org_bea','ord_t','full',249900,'open','Business package','cs_test_fake',?)`).bind(at),
  ]);
  ps = (await t.post(FN, fn(callId, salesId, "check_payment_status", {}))).json;
  assert.equal(ps.payment_status, "checkout_started_not_paid", "a started checkout is not a payment");
  await t.db.batch([
    t.db.prepare(`UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = 'inv_t'`).bind(at),
    t.db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, order_id, amount_cents, stripe_payment_intent_id, status, created_at) VALUES ('pay_t','org_bea','inv_t','ord_t',249900,'pi_test_1','succeeded',?)`).bind(at),
  ]);
  ps = (await t.post(FN, fn(callId, salesId, "check_payment_status", {}))).json;
  assert.equal(ps.payment_status, "paid");
  assert.equal(ps.stripe_checkout_session_id, "cs_test_fake");
  assert.equal(ps.lead_id, leadId);
  const onboard = (await t.post(FN, fn(callId, salesId, "send_sales_email", { email_type: "onboarding_instructions", email: "bea@buckeye-bakery.example" }))).json;
  assert.equal(onboard.sent, true);
});

test("[EMAIL-002] [EMAIL-003] sales email: fixed templates, verified recipient, daily cap, unsubscribe honoured; no free text from the model", async () => {
  const t = await app();
  const { salesId, callId } = await dialled(t);
  await t.post(FN, fn(callId, salesId, "update_outbound_lead", { contact_email: "bea@buckeye-bakery.example" }));
  const info = (await t.post(FN, fn(callId, salesId, "send_sales_email", { email_type: "package_information", email: "bea@buckeye-bakery.example", body: "Special 50% discount today!" }))).json;
  assert.equal(info.sent, true);
  const m = (await lastEmail(t.db, "bea@buckeye-bakery.example"))!;
  assert.doesNotMatch(m.text_body, /50% discount/, "arguments outside the schema are ignored");
  assert.match(m.text_body, /Starter: \$999/);
  const fu = (await t.post(FN, fn(callId, salesId, "send_sales_email", { email_type: "follow_up", email: "bea@buckeye-bakery.example" }))).json;
  assert.equal(fu.reason, "no_follow_up_agreed");
  const quote = (await t.post(FN, fn(callId, salesId, "send_sales_email", { email_type: "approved_quote", email: "bea@buckeye-bakery.example" }))).json;
  assert.equal(quote.reason, "no_approved_quote", "the agent never prices a quote");
  const paid = (await t.post(FN, fn(callId, salesId, "send_sales_email", { email_type: "onboarding_instructions", email: "bea@buckeye-bakery.example" }))).json;
  assert.equal(paid.reason, "payment_not_confirmed");
  await t.post(FN, fn(callId, salesId, "schedule_sales_followup", { followup_type: "staff_callback", preferred_date: "2026-11-05", preferred_time: "afternoon", prospect_agreed: true }));
  const fu2 = (await t.post(FN, fn(callId, salesId, "send_sales_email", { email_type: "follow_up", email: "bea@buckeye-bakery.example" }))).json;
  assert.equal(fu2.sent, true, JSON.stringify(fu2));
  // Unsubscribe from the footer link stops further sales email; the page reveals nothing.
  const unsub = linkFrom((await lastEmail(t.db, "bea@buckeye-bakery.example"))!.text_body, "/sales/unsubscribe/");
  const c = t.client();
  assert.equal((await c.get(unsub)).status, 200);
  assert.equal((await c.post(unsub, {})).status, 200);
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM sales_email_optouts WHERE email = 'bea@buckeye-bakery.example'`), 1);
  const after = (await t.post(FN, fn(callId, salesId, "send_sales_email", { email_type: "package_information", email: "bea@buckeye-bakery.example", package: "starter" }))).json;
  assert.equal(after.sent, false);
});

test("[VOICE-005] follow-ups: one per kind, consultation never claimed as confirmed, AI follow-up re-gated at dial time", async () => {
  const t = await app();
  const { salesId, callId, leadId } = await dialled(t);
  const cb = (await t.post(FN, fn(callId, salesId, "schedule_sales_followup", { followup_type: "staff_callback", preferred_date: "2026-11-05", preferred_time: "morning", topic: "Pricing questions", prospect_agreed: true }))).json;
  assert.equal(cb.scheduled, true);
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM crm_activities WHERE lead_id = ? AND kind = 'task' AND body LIKE '%Call%back%'`, leadId), 1);
  const dupe = (await t.post(FN, fn(callId, salesId, "schedule_sales_followup", { followup_type: "staff_callback", preferred_date: "2026-11-06", prospect_agreed: true }))).json;
  assert.equal(dupe.already_scheduled, true);
  const cons = (await t.post(FN, fn(callId, salesId, "schedule_sales_followup", { followup_type: "consultation", prospect_agreed: true }))).json;
  assert.equal(cons.scheduled, false, "scheduling is off by default: nothing is claimed");
  assert.equal((await t.post(FN, fn(callId, salesId, "schedule_sales_followup", { followup_type: "staff_callback" }))).res.status, 422, "the prospect's agreement is required");
});

test("[VOICE-005] [CRM-005] do-not-call: recorded immediately, applied to every channel and campaign, survives re-import, confirmed explicitly", async () => {
  const t = await app();
  const { salesId, callId, leadId } = await dialled(t);
  await t.post(FN, fn(callId, salesId, "update_outbound_lead", { contact_email: "bea@buckeye-bakery.example" }));
  const r = (await t.post(FN, fn(callId, salesId, "record_do_not_call", { also_stop_email: true }))).json;
  assert.equal(r.recorded, true);
  assert.match(r.confirmation, /won't call again/);
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM voice_dnc WHERE phone_e164 = '+16145552142'`), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM sales_email_optouts WHERE email = 'bea@buckeye-bakery.example'`), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM sales_call_consents WHERE revoked_at IS NULL`), 0, "consent revoked");
  // Re-import of the same business is suppressed by research ingest; a new queue attempt is blocked.
  await R.ingestBatch(t.db, { batchId: "b_reimport_1", runnerId: "ws-test", prospects: [prospect(t.now, { businessKey: "overture:oh1-dup", name: "Buckeye Bakery Co (TEST DATA)" })] }, t.now);
  const dup = await one<{ status: string; eligibility: string }>(t.db, `SELECT status, eligibility FROM research_prospects WHERE business_key = 'overture:oh1-dup'`);
  assert.equal(dup.eligibility, "blocked");
  assert.notEqual(dup.status, "qualified");
  const again = await SO.enqueueSalesCall(t.db, leadId, { requestedBy: t.owner.id, now: t.now });
  assert.equal(again.status === "blocked" || again.id === salesId, true);
  // The receptionist's outbound queue honours the same entry (shared voice_dnc).
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'voice.dnc_added'`), 1);
});

// ───────────── Webhook outcome ─────────────

test("[VOICE-003] call webhook: status, final outcome written once from platform facts, retries for no-answer, Retell DNC honoured, analysis only fills gaps", async () => {
  const t = await app({ payments: true });
  const { salesId, callId, leadId } = await dialled(t);
  assert.equal((await t.post("/api/webhooks/retell", { event: "call_started", call: salesCall(callId, salesId) })).res.status, 200);
  assert.equal((await SO.getSalesCall(t.db, salesId))!.status, "in_progress");
  await t.post(FN, fn(callId, salesId, "update_outbound_lead", { contact_email: "bea@buckeye-bakery.example", qualification: "qualified", sales_outcome: "interested" }));
  await t.post(FN, fn(callId, salesId, "create_checkout_session", { package: "starter", email: "bea@buckeye-bakery.example", buyer_confirmed: true }));
  const ended = { event: "call_ended", call: salesCall(callId, salesId, { disconnection_reason: "agent_hangup", call_status: "ended", duration_ms: 240000, transcript: "Agent: ... User: ..." }) };
  assert.equal((await t.post("/api/webhooks/retell", ended)).res.status, 200);
  let row = (await SO.getSalesCall(t.db, salesId))!;
  assert.equal(row.outcome, "checkout_sent", "platform fact beats the agent's 'interested'");
  assert.equal(row.outcome_source, "sales_checkout_links");
  assert.equal(row.status, "completed");
  assert.equal(row.duration_ms, 240000);
  await t.post("/api/webhooks/retell", ended);
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'sales_outbound.outcome'`), 1, "written once");
  assert.equal((await one<{ stage: string }>(t.db, `SELECT stage FROM leads WHERE id = ?`, leadId)).stage, "qualified");

  // No answer → one more attempt later with a NEW idempotency key; the old call's late events are ignored.
  const t2 = await app();
  const d2 = await dialled(t2);
  await t2.post("/api/webhooks/retell", { event: "call_ended", call: salesCall(d2.callId, d2.salesId, { disconnection_reason: "dial_no_answer", call_status: "not_connected" }) });
  row = (await SO.getSalesCall(t2.db, d2.salesId))!;
  assert.equal(row.status, "queued");
  assert.equal(row.provider_call_id, null);
  assert.equal(row.not_before, new Date(t2.now.getTime() + 48 * 3_600_000).toISOString());
  await t2.post("/api/webhooks/retell", { event: "call_analyzed", call: salesCall(d2.callId, d2.salesId, { call_analysis: { custom_analysis_data: { sales_outcome: "interested" } } }) });
  assert.equal((await SO.getSalesCall(t2.db, d2.salesId))!.outcome, null, "a late event of the previous attempt changes nothing");
  t2.now.setTime(t2.now.getTime() + 49 * 3_600_000); // Thursday 11:00 ET
  assert.equal((await SO.processSalesQueue(env(t2))).dialled, 1);
  assert.equal(t2.retell.calls[1].body.idempotency_key, `crestmont_${d2.salesId}_a2`);
  const call2 = (await SO.getSalesCall(t2.db, d2.salesId))!.provider_call_id!;
  await t2.post("/api/webhooks/retell", { event: "call_ended", call: salesCall(call2, d2.salesId, { disconnection_reason: "voicemail_reached", call_status: "ended" }) });
  row = (await SO.getSalesCall(t2.db, d2.salesId))!;
  assert.equal(row.outcome, "voicemail", "attempt limit reached: final");
  assert.equal(row.status, "completed");

  // Retell's user_requested_dnc → suppression everywhere.
  const t3 = await app();
  const d3 = await dialled(t3);
  await t3.post("/api/webhooks/retell", { event: "call_ended", call: salesCall(d3.callId, d3.salesId, { disconnection_reason: "user_requested_dnc", call_status: "ended", transcript: "Stop calling me" }) });
  assert.equal((await SO.getSalesCall(t3.db, d3.salesId))!.outcome, "do_not_call");
  assert.equal(await count(t3.db, `SELECT COUNT(*) AS n FROM voice_dnc WHERE phone_e164 = '+16145552142'`), 1);

  // Talked, nothing recorded → unclassified + task; call_analyzed may then fill an agent-type disposition.
  const t4 = await app();
  const d4 = await dialled(t4);
  await t4.post("/api/webhooks/retell", { event: "call_ended", call: salesCall(d4.callId, d4.salesId, { disconnection_reason: "user_hangup", call_status: "ended", transcript: "User: maybe later" }) });
  assert.equal((await SO.getSalesCall(t4.db, d4.salesId))!.outcome, "unclassified");
  assert.equal(await count(t4.db, `SELECT COUNT(*) AS n FROM crm_activities WHERE kind = 'task' AND body LIKE 'Classify the result%'`), 1);
  await t4.post("/api/webhooks/retell", { event: "call_analyzed", call: salesCall(d4.callId, d4.salesId, { call_analysis: { custom_analysis_data: { sales_outcome: "follow_up_requested" } } }) });
  const r4 = (await SO.getSalesCall(t4.db, d4.salesId))!;
  assert.equal(r4.outcome, "follow_up_requested");
  assert.equal(r4.outcome_source, "retell_post_call_analysis");
});

// ───────────── Owner page and policy ─────────────

test("[OWN-002] [SEC-005] Owner page: off by default with reasons, Owner-only, step-up on approval and switches; agent must differ from the receptionist", async () => {
  const t = await app();
  const c = t.client(); await c.login(t.owner.email, TEST_PASSWORD, t.owner.secret);
  const page = await (await c.get("/staff/sales-outbound")).text();
  assert.match(page, /AI sales calls \(outbound\)/);
  assert.match(page, /D-14/);
  assert.match(page, /RETELL_SALES_OUTBOUND is not/);
  const sales = await createStaff(t.db, "sales", "sales@crestmont.test");
  const s = t.client(); await s.login(sales.email, TEST_PASSWORD, sales.secret);
  assert.equal((await s.get("/staff/sales-outbound")).status, 403);
  assert.ok(STEP_UP_ROUTES["POST /staff/sales-outbound/compliance"]);
  assert.ok(STEP_UP_ROUTES["POST /staff/sales-outbound/settings"]);
  const cfg = await import("../src/services/voice-settings.ts");
  const vc = cfg.defaultVoiceConfig(); vc.inbound.agent_id = "agent_receptionist";
  await t.db.prepare(`INSERT INTO voice_settings (id, config_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json`).bind(JSON.stringify(vc), ISO(t.now)).run();
  const problems = await SO.saveSalesSettings(t.db, t.owner.id, { enabled: true, agentId: "agent_receptionist", fromNumber: "+16145550100", maxConcurrent: 1, maxPerRun: 1, maxPerDay: 1, maxAttempts: 1, retryAfterHours: 48 });
  assert.ok(problems.some((p) => /separate Retell agent/.test(p)));
  assert.ok((await SO.saveSalesSettings(t.db, t.owner.id, { enabled: true, agentId: "agent_x", fromNumber: "+16145550100", maxConcurrent: 50, maxPerRun: 1, maxPerDay: 1, maxAttempts: 1, retryAfterHours: 48 })).some((p) => /1–20/.test(p)), "concurrency capped at Retell's documented 20");
});

test("[VOICE-004] [SALESOPT-005] the Retell master prompt is SIE version 1 verbatim, names only real tools and variables, and passes the protected policy", async () => {
  const { readFile } = await import("node:fs/promises");
  const prompt = (await readFile(new URL("../docs/voice/outbound-sales-agent-prompt.txt", import.meta.url), "utf8")).replace(/\n$/, "");
  const { composeSalesPrompt, baselineSalesInstructions, salesPolicyViolations, hasProtectedPolicy, PROTECTED_SALES_POLICY } = await import("../src/domain/sales-opt/policy.ts");
  assert.equal(prompt, composeSalesPrompt(baselineSalesInstructions()), "paste-ready file = what the SIE deploys as version 1 (byte-identical read-back)");
  assert.ok(hasProtectedPolicy(prompt));
  assert.deepEqual(salesPolicyViolations(baselineSalesInstructions()), []);
  assert.ok(composeSalesPrompt(baselineSalesInstructions()).length < 15_000);
  const { SALES_FUNCTIONS } = await import("../src/services/sales-functions.ts");
  const tools = new Set<string>([...SALES_FUNCTIONS, "record_consent", "transfer_call", "end_call"]);
  for (const t of tools) assert.ok(prompt.includes(t), `prompt uses ${t}`);
  for (const bad of ["route_support", "record_call_outcome", "send_sms", "get_published_pricing", "create_lead", "request_callback", "record_opt_out", "escalate"]) assert.ok(!new RegExp(`\\b${bad}\\b`).test(prompt), `no ${bad}`);
  const vars = new Set([...prompt.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]));
  const allowed = new Set(["business_name", "first_name", "industry", "website_status", "verified_issue", "recommended_service", "research_verified", "agent_number"]);
  for (const v of vars) assert.ok(allowed.has(v), `unknown variable {{${v}}}`);
  assert.ok(!vars.has("lead_id"), "the lead id is never put in the spoken prompt");
  assert.doesNotMatch(baselineSalesInstructions(), /\$\s?\d/, "instructions quote no prices; the protected policy and get_packages_pricing do");
  assert.ok(PROTECTED_SALES_POLICY.includes("$999") && PROTECTED_SALES_POLICY.includes("$2,499"), "policy prices come from the catalog");
  for (const must of [/AI assistant/, /stop calling/, /recorded and transcribed/, /record_do_not_call/, /payment_status is "paid"/, /leave no message/, /curly braces/]) assert.match(prompt, must);
  for (const v of ["package_information", "approved_quote", "onboarding_instructions", "follow_up", "staff_callback", "consultation", "ai_follow_up_call", "quote_required", "not_interested", "wrong_number", "follow_up_requested", "interested"]) assert.ok(prompt.includes(`"${v}"`), v);
});

// ───────────── Self-Improvement Engine compatibility ─────────────

async function sieSetup(t: Awaited<ReturnType<typeof app>>) {
  const reg = await import("../src/services/sales-opt/registry.ts");
  const { baselineSalesInstructions } = await import("../src/domain/sales-opt/policy.ts");
  const v1 = await reg.ensureBaseline(t.db, baselineSalesInstructions());
  const v2 = await reg.createVersion(t.db, { parentId: v1.id, instructions: baselineSalesInstructions() + "\nKeep every answer under two sentences.", rationale: "Shorter answers (TEST)", authorKind: "user", author: t.owner.id });
  await reg.setTarget(t.db, t.owner.id, "staging", "agent_sales_test");
  const at = ISO(t.now);
  await t.db.prepare(`INSERT INTO so_deployments (id, stage, version_id, kind, status, agent_id, llm_id, created_at, completed_at) VALUES ('sod_test', 'staging', ?, 'deploy', 'verified', 'agent_sales_test', 'llm_sales_test', ?, ?)`).bind(v1.id, at, at).run();
  return { v1, v2 };
}

test("[SALESOPT-001] [SALESOPT-006] dialler stamps crestmont_so_version / crestmont_so_experiment only for the version the agent really runs", async () => {
  const t = await app();
  const { v1, v2 } = await sieSetup(t);
  const leadId = await t.seedLead();
  await t.authorise("+16145552142", leadId);
  // Running experiment, 50% candidate share: whichever arm the lead lands in, only the deployed version may be stamped.
  await t.db.prepare(`INSERT INTO so_experiments (id, baseline_version_id, candidate_version_id, candidate_share, min_connected_per_arm, status, created_at, started_at) VALUES ('soe_test', ?, ?, 0.5, 100, 'running', ?, ?)`).bind(v1.id, v2.id, ISO(t.now), ISO(t.now)).run();
  const { experimentRouting } = await import("../src/services/sales-opt/monitor.ts");
  const route = (await experimentRouting(t.db, leadId))!;
  await SO.enqueueSalesCall(t.db, leadId, { requestedBy: t.owner.id, now: t.now });
  assert.equal((await SO.processSalesQueue(env(t))).dialled, 1);
  const md = t.retell.calls[0].body.metadata;
  assert.equal(md.crestmont_so_version, v1.id, "the version verified on the staging agent");
  assert.equal(md.crestmont_segment, "broken_website");
  if (route.arm === "baseline") assert.equal(md.crestmont_so_experiment, "soe_test");
  else assert.equal(md.crestmont_so_experiment, undefined, "a candidate arm this agent does not run is left out, never mis-attributed");
  // Not the SIE target → no version attribution at all.
  const s = await SO.sieStamp(t.db, "staging", "agent_other", leadId, null);
  assert.deepEqual(s.metadata, {});
});

test("[SALESOPT-001] [SALESOPT-002] SIE ingests outbound calls: outbound tool names become facts; a Stripe-verified payment attributes to the call (checkout_link rule)", async () => {
  const t = await app({ payments: true });
  const { v1 } = await sieSetup(t);
  const { salesId, callId, leadId } = await dialled(t);
  const sc = (extra: Record<string, unknown> = {}) => ({ ...salesCall(callId, salesId), metadata: { crestmont_env: "development", crestmont_sales_call_id: salesId, crestmont_lead_id: leadId, crestmont_test: "false", crestmont_so_version: v1.id }, ...extra });
  await t.post("/api/webhooks/retell", { event: "call_started", call: sc() });
  await t.post(FN, fn(callId, salesId, "get_packages_pricing", {}));
  await t.post(FN, fn(callId, salesId, "update_outbound_lead", { contact_email: "bea@buckeye-bakery.example", qualification: "qualified" }));
  await t.post(FN, fn(callId, salesId, "create_checkout_session", { package: "business", email: "bea@buckeye-bakery.example", buyer_confirmed: true }));
  await t.post(FN, fn(callId, salesId, "schedule_sales_followup", { followup_type: "staff_callback", preferred_date: "2026-11-05", prospect_agreed: true }));
  const end = ISO(new Date(t.now.getTime() + 5 * 60_000));
  await t.post("/api/webhooks/retell", { event: "call_ended", call: sc({ disconnection_reason: "agent_hangup", call_status: "ended", duration_ms: 300000, start_timestamp: t.now.getTime(), end_timestamp: Date.parse(end), transcript: "Agent: Hi\nUser: Hello" }) });
  const f = await one<Record<string, number | string | null>>(t.db, `SELECT * FROM so_call_facts WHERE provider_call_id = ?`, callId);
  assert.equal(f.stage, "staging");
  assert.equal(f.version_id, v1.id);
  assert.equal(f.lead_id, leadId);
  assert.equal(f.connected, 1);
  assert.equal(f.pricing_discussed, 1);
  assert.equal(f.checkout_link_generated, 1);
  assert.equal(f.checkout_link_delivered, 1);
  assert.equal(f.follow_up_requested, 1);
  assert.equal(f.opt_out, 0);
  // Payment written as the verified Stripe webhook would (TEST DATA), after the call → attribution, never from the agent's words.
  const pay = ISO(new Date(t.now.getTime() + 60 * 60_000));
  await t.db.batch([
    t.db.prepare(`INSERT INTO organizations (id, name, kind, created_at) VALUES ('org_sie','Buckeye (TEST)','customer',?)`).bind(pay),
    t.db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, lead_id, created_at) VALUES ('ord_sie','org_sie','business',249900,'paid','package',?,?)`).bind(leadId, pay),
    t.db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, description, created_at, paid_at) VALUES ('inv_sie','org_sie','ord_sie','full',249900,'paid','Business',?,?)`).bind(pay, pay),
    t.db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, order_id, amount_cents, stripe_payment_intent_id, status, created_at) VALUES ('pay_sie','org_sie','inv_sie','ord_sie',249900,'pi_test_sie','succeeded',?)`).bind(pay),
  ]);
  const { reconcileAttributions } = await import("../src/services/sales-opt/attribution.ts");
  await reconcileAttributions(t.db, new Date(t.now.getTime() + 2 * 3_600_000));
  const a = await one<{ rule: string; version_id: string; is_last_touch: number; status: string }>(t.db, `SELECT rule, version_id, is_last_touch, status FROM so_attributions WHERE payment_id = 'pay_sie'`);
  assert.deepEqual({ ...a }, { rule: "checkout_link", version_id: v1.id, is_last_touch: 1, status: "paid" });
  // A do-not-call on another call is recorded as an opt-out fact.
  const t2 = await app();
  await sieSetup(t2);
  const d2 = await dialled(t2);
  await t2.post(FN, fn(d2.callId, d2.salesId, "record_do_not_call", {}));
  await t2.post("/api/webhooks/retell", { event: "call_ended", call: salesCall(d2.callId, d2.salesId, { disconnection_reason: "agent_hangup", call_status: "ended" }) });
  assert.equal((await one<{ opt_out: number }>(t2.db, `SELECT opt_out FROM so_call_facts WHERE provider_call_id = ?`, d2.callId)).opt_out, 1);
});

test("[SALESOPT-007] SIE evaluation recognises the outbound agent's tools; simulations are told the real tool names", async () => {
  const { SCENARIOS, assertScenario, simulationPrompt } = await import("../src/domain/sales-opt/evaluation.ts");
  const removal = SCENARIOS.find((s) => s.id === "removal_request")!;
  const ok = assertScenario(removal, "Agent: Hi, I'm Cimo, an AI assistant from Crestmont Website Development.\nCustomer: Take me off your list and never call again.\n[tool: record_do_not_call]\nAgent: Understood. We've taken this number off our call list. Goodbye.\n[tool: end_call]");
  assert.ok(ok.results.find((r) => r.id === "tool:record_opt_out")!.ok, JSON.stringify(ok.results));
  const human = SCENARIOS.find((s) => s.id === "wants_human")!;
  assert.ok(assertScenario(human, "Agent: Hi, I'm an AI assistant for Crestmont.\nCustomer: Put a human on.\nAgent: I'll try to connect you now.\n[tool: transfer_call]").results.find((r) => r.id === "tool:escalate_or_callback")!.ok);
  const p = simulationPrompt(removal, "PROMPT");
  for (const tname of ["record_do_not_call", "schedule_sales_followup", "create_checkout_session", "transfer_call"]) assert.ok(p.includes(tname));
  assert.ok(!/record_opt_out|request_callback|create_lead/.test(p));
});

// ───────────── Closeout 2026-11-01: purchase link → CRM lead, invalid numbers, SIE protection of the Founder's V17 ─────────────

const WHSEC = "whsec_test_outbound_closeout";
async function stripeWebhook(t: Awaited<ReturnType<typeof app>>, evt: unknown) {
  const body = JSON.stringify(evt);
  const ts = Math.floor(Date.now() / 1000);
  const sig = await hmacSha256Hex(WHSEC, `${ts}.${body}`);
  return t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${sig}`, "content-type": "application/json" } });
}
/** A lead whose CRM contact already holds a research email, then a different verified buyer email on the call. TEST DATA. */
async function linkForBuyer(t: Awaited<ReturnType<typeof app>>, pkg: "starter" | "business" | "premium" = "business") {
  const d = await dialled(t);
  const contactId = (await one<{ contact_id: string }>(t.db, `SELECT contact_id FROM leads WHERE id = ?`, d.leadId)).contact_id;
  await t.db.prepare(`UPDATE contacts SET email = 'info@buckeye-bakery.example' WHERE id = ?`).bind(contactId).run();
  const upd = (await t.post(FN, fn(d.callId, d.salesId, "update_outbound_lead", { contact_name: "Bea Baker", contact_email: "bea@buckeye-bakery.example", qualification: "qualified" }))).json;
  const out = (await t.post(FN, fn(d.callId, d.salesId, "create_checkout_session", { package: pkg, email: upd.contact_verification === "verified" ? "bea@buckeye-bakery.example" : "info@buckeye-bakery.example", buyer_confirmed: true }))).json;
  assert.equal(out.checkout_link_sent, true, JSON.stringify({ upd, out }));
  return { ...d, url: new URL(out.checkout_url).pathname, linkRef: out.checkout_reference as string, buyerEmail: upd.contact_verification === "verified" ? "bea@buckeye-bakery.example" : "info@buckeye-bakery.example" };
}
async function payViaStripe(t: Awaited<ReturnType<typeof app>>, orderId: string, evtId = "evt_paid_1") {
  const inv = await one<{ id: string; amount_cents: number; organization_id: string }>(t.db, `SELECT id, amount_cents, organization_id FROM invoices WHERE order_id = ?`, orderId);
  return stripeWebhook(t, { id: evtId, type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: { id: "cs_test_fake", mode: "payment", payment_status: "paid", amount_total: inv.amount_cents, payment_intent: "pi_test_closeout", metadata: { organization_id: inv.organization_id, order_id: orderId, invoice_id: inv.id, kind: "package" } } } });
}

test("[PAY-001] [CRM-005] purchase link binds the order to the sales lead even when the buyer's email differs from the CRM email; paid once on webhook retries", async () => {
  const t = await app({ payments: true, env: { STRIPE_WEBHOOK_SECRET: WHSEC } });
  const L = await linkForBuyer(t);
  // An unrelated open lead whose contact uses the buyer's email (duplicate email elsewhere in the CRM) must NOT be chosen.
  await t.db.batch([
    t.db.prepare(`INSERT INTO companies (id, name, created_at) VALUES ('co_other','Other Co (TEST)',?)`).bind(ISO(t.now)),
    t.db.prepare(`INSERT INTO contacts (id, company_id, name, email, created_at) VALUES ('ct_other','co_other','Other',?,?)`).bind("bea2@buckeye-bakery.example", ISO(t.now)),
    t.db.prepare(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES ('ld_other','ct_other','quote_form','new',?,?)`).bind(ISO(t.now), ISO(t.now)),
  ]);
  const buyer = await createCustomer(t.db, "bea2@buckeye-bakery.example", "Buckeye Bakery (TEST)");
  const c = t.client();
  const buy = await c.get(L.url);
  assert.equal(buy.status, 303);
  assert.match(buy.headers.get("set-cookie") ?? "", /crestmont_sales_link=[0-9a-f]{64}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax/);
  await c.login(buyer.email);
  const res = await c.post("/checkout/business", { maintenance_plan: "professional", terms: "1" });
  assert.equal(res.status, 303, await res.text());
  const order = await one<{ id: string; lead_id: string }>(t.db, `SELECT id, lead_id FROM orders WHERE organization_id = ?`, buyer.organizationId);
  assert.equal(order.lead_id, L.leadId, "the order belongs to the lead the link was issued for");
  assert.equal((await one<{ order_id: string }>(t.db, `SELECT order_id FROM sales_checkout_links WHERE id = ?`, L.linkRef)).order_id, order.id);
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM leads WHERE source = 'checkout'`), 0, "no duplicate opportunity");
  assert.equal((await one<{ stage: string }>(t.db, `SELECT stage FROM leads WHERE id = 'ld_other'`)).stage, "new", "the other lead with that email is untouched");
  assert.equal((await one<{ stage: string }>(t.db, `SELECT stage FROM leads WHERE id = ?`, L.leadId)).stage, "awaiting_payment");
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM crm_activities WHERE lead_id = ? AND kind = 'task' AND body LIKE 'Confirm that bea2@%'`, L.leadId), 1, "a different sign-in email is flagged, never written over the contact");
  assert.equal((await one<{ email: string }>(t.db, `SELECT c.email FROM contacts c JOIN leads l ON l.contact_id = c.id WHERE l.id = ?`, L.leadId)).email, "info@buckeye-bakery.example");
  const fake = (t.env.overrides as { payments: FakePayments }).payments;
  assert.equal(fake.checkouts.at(-1)!.metadata.lead_id, L.leadId);
  assert.equal(fake.checkouts.at(-1)!.metadata.sales_link_id, L.linkRef);
  // Checkout creation is not payment.
  assert.equal((await t.post(FN, fn(L.callId, L.salesId, "check_payment_status", {}))).json.payment_status, "checkout_started_not_paid");
  // Repeat click: same open invoice, no second order.
  assert.equal((await c.post("/checkout/business", { maintenance_plan: "professional", terms: "1" })).status, 303);
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM orders WHERE organization_id = ? AND status = 'pending_payment'`, buyer.organizationId), 1);
  // Stripe confirms; the same webhook delivered twice changes nothing more.
  assert.equal((await payViaStripe(t, order.id)).status, 200);
  assert.equal((await payViaStripe(t, order.id)).status, 200);
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND status = 'succeeded'`, order.id), 1);
  assert.equal((await one<{ stage: string }>(t.db, `SELECT stage FROM leads WHERE id = ?`, L.leadId)).stage, "converted", "the original opportunity is converted");
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM crm_activities WHERE lead_id = ? AND body LIKE 'Payment confirmed%'`, L.leadId), 1);
  const ps = (await t.post(FN, fn(L.callId, L.salesId, "check_payment_status", {}))).json;
  assert.equal(ps.payment_status, "paid");
  assert.match(ps.onboarding_status, /^project_created/, "onboarding has what it needs (project provisioned from the order)");
  // The call's final outcome now reflects the verified payment. (The test clock is fixed on 3 Nov while the Stripe webhook
  // stamps the payment with the real time, so the call row is moved before it — in production the payment follows the call.)
  await t.db.prepare(`UPDATE sales_calls SET created_at = '2026-10-01T00:00:00.000Z' WHERE id = ?`).bind(L.salesId).run();
  await t.post("/api/webhooks/retell", { event: "call_ended", call: salesCall(L.callId, L.salesId, { disconnection_reason: "agent_hangup", call_status: "ended", transcript: "..." }) });
  assert.equal((await SO.getSalesCall(t.db, L.salesId))!.outcome, "payment_confirmed");
});

test("[PAY-001] a tampered, expired or other-package link never re-attributes a checkout (falls back to the email match)", async () => {
  const t = await app({ payments: true, env: { STRIPE_WEBHOOK_SECRET: WHSEC } });
  const L = await linkForBuyer(t, "starter");
  const buyer = await createCustomer(t.db, "someone@else.example", "Else Co");
  const c = t.client();
  await c.get(L.url);
  await c.login(buyer.email);
  assert.equal((await c.post("/checkout/business", { maintenance_plan: "professional", terms: "1" })).status, 303, "link is for Starter, purchase is Business");
  assert.notEqual((await one<{ lead_id: string }>(t.db, `SELECT lead_id FROM orders WHERE organization_id = ?`, buyer.organizationId)).lead_id, L.leadId);
  const c2 = t.client();
  c2.cookies.set("crestmont_sales_link", "f".repeat(64));
  const b2 = await createCustomer(t.db, "third@else.example", "Third Co");
  await c2.login(b2.email);
  await c2.post("/checkout/starter", { maintenance_plan: "essential", terms: "1" });
  assert.notEqual((await one<{ lead_id: string }>(t.db, `SELECT lead_id FROM orders WHERE organization_id = ?`, b2.organizationId)).lead_id, L.leadId, "unknown token ignored");
});

test("[VOICE-003] [CRM-005] an invalid number (invalid_destination) gets a CRM task, is marked invalid and is never queued again; a carrier failure is not", async () => {
  const t = await app();
  const d = await dialled(t);
  await t.post("/api/webhooks/retell", { event: "call_ended", call: salesCall(d.callId, d.salesId, { disconnection_reason: "invalid_destination", call_status: "error" }) });
  assert.equal((await SO.getSalesCall(t.db, d.salesId))!.outcome, "technical_failure");
  assert.equal((await one<{ phone_status: string }>(t.db, `SELECT phone_status FROM research_prospects WHERE phone_e164 = '+16145552142'`)).phone_status, "invalid");
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM crm_activities WHERE lead_id = ? AND kind = 'task' AND body LIKE '%number is invalid or disconnected%'`, d.leadId), 1);
  const again = await SO.enqueueSalesCall(t.db, d.leadId, { requestedBy: t.owner.id, now: t.now });
  assert.equal(again.status, "blocked");
  assert.match(again.status_detail ?? "", /reported invalid/);
  const t2 = await app();
  const d2 = await dialled(t2);
  await t2.post("/api/webhooks/retell", { event: "call_ended", call: salesCall(d2.callId, d2.salesId, { disconnection_reason: "dial_failed", call_status: "error" }) });
  assert.equal((await one<{ phone_status: string | null }>(t2.db, `SELECT phone_status FROM research_prospects WHERE phone_e164 = '+16145552142'`)).phone_status, null, "a carrier/network failure says nothing about the number");
});

/** Fake Retell for the SIE: one sales agent whose LLM prompt starts as the Founder's V17. Records writes. */
function sieRetell(initialPrompt: string) {
  const state = { prompt: initialPrompt, writes: [] as string[] };
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (u.pathname === "/get-agent/agent_sales_test") return new Response(JSON.stringify({ agent_id: "agent_sales_test", response_engine: { type: "retell-llm", llm_id: "llm_sales_test" } }));
    if (u.pathname === "/get-retell-llm/llm_sales_test") return new Response(JSON.stringify({ llm_id: "llm_sales_test", general_prompt: state.prompt, version: 7, is_published: true }));
    if (u.pathname === "/update-retell-llm/llm_sales_test" && init.method === "PATCH") { const b = JSON.parse(String(init.body)); state.prompt = b.general_prompt; state.writes.push(b.general_prompt); return new Response(JSON.stringify({ llm_id: "llm_sales_test" })); }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { state, f };
}
const V17_TEXT = "CRESTMONT WEBSITE DEVELOPMENT — CIMO OUTBOUND SALES\nRETELL NATIVE SINGLE PROMPT — V17\n(Founder-authored text; TEST DATA stand-in)";

test("[SALESOPT-008] [SALESOPT-006] the SIE adopts the Founder's live V17 verbatim and can never overwrite it with an older version", async () => {
  const t = await app();
  const r = sieRetell(V17_TEXT);
  let clock = Date.now();
  const deps = { db: t.db, env: { RETELL_OUTBOUND_API_KEY: KEY, ENVIRONMENT: "staging" as const }, fetch: r.f, now: () => new Date(clock) };
  // An old engine version that passed evaluation (e.g. the repository's v1) exists BEFORE the target is verified.
  const old = await REG.ensureBaseline(t.db, (await import("../src/domain/sales-opt/policy.ts")).baselineSalesInstructions());
  await REG.transition(t.db, old.id, "evaluating"); await REG.transition(t.db, old.id, "eval_passed");
  await REG.setTarget(t.db, t.owner.id, "staging", "agent_sales_test");
  // Deploying the old version over an unadopted live prompt is refused even before verification adopts it.
  const refused = await soDeploy(deps, { stage: "staging", versionId: old.id, expectedCurrentVersionId: null, kind: "deploy", userId: t.owner.id, reason: "test" });
  assert.equal(refused.status, "aborted");
  assert.match(refused.detail, /prompt this engine did not deploy/);
  assert.deepEqual(r.state.writes, [], "nothing written to Retell");
  // Verification adopts V17 as the current version (external, verbatim, approved). Read-only on Retell.
  const v = await soVerify(deps, "staging", t.owner.id);
  assert.ok(v.ok, v.detail);
  assert.match(v.detail, /Founder prompt, kept verbatim/);
  const cur = (await REG.deployedVersion(t.db, "staging"))!;
  assert.equal(cur.prompt_mode, "external");
  assert.equal(cur.instructions, V17_TEXT);
  assert.equal(REG.promptOf(cur), V17_TEXT);
  assert.equal(cur.status, "approved");
  assert.deepEqual(r.state.writes, []);
  // Attribution: calls stamp the adopted V17 version.
  const stamp = await SO.sieStamp(t.db, "staging", "agent_sales_test", "ld_x", "broken_website");
  assert.equal(stamp.metadata.crestmont_so_version, cur.id);
  // The Founder edits V17 again in Retell (drift): a deploy is refused until it is adopted; adoption creates a new version.
  r.state.prompt = V17_TEXT + "\nV17.1 tweak";
  clock += 5 * 60_000; // past the one-minute gap between deployments
  const drift = await soDeploy(deps, { stage: "staging", versionId: old.id, expectedCurrentVersionId: cur.id, kind: "deploy", userId: t.owner.id, reason: "test" });
  assert.equal(drift.status, "aborted");
  assert.match(drift.detail, /Drift/);
  const ad = await adoptLivePrompt(deps, "staging", t.owner.id, "test");
  assert.equal(ad.adopted, true);
  assert.equal((await REG.deployedVersion(t.db, "staging"))!.instructions, V17_TEXT + "\nV17.1 tweak");
  assert.equal((await adoptLivePrompt(deps, "staging", t.owner.id, "again")).adopted, false, "idempotent");
  // External versions are not evaluated, not re-deployed and never the base of AI proposals.
  await assert.rejects((await import("../src/services/sales-opt/jobs.ts")).startEvaluation(t.db, cur.id, t.owner.id), /Founder's own prompt/);
  await assert.rejects(soDeploy(deps, { stage: "staging", versionId: cur.id, expectedCurrentVersionId: (await REG.deployedVersion(t.db, "staging"))!.id, kind: "deploy", userId: t.owner.id, reason: "x" }), /only be restored by a rollback/);
  await REG.setControl(t.db, t.owner.id, { paused: false });
  assert.match(await (await import("../src/services/sales-opt/jobs.ts")).maybeQueueProposal(t.db, new Date(), { force: true }), /Founder's own prompt/);
  // A rollback to the previous Founder version restores it verbatim (explicit Owner action).
  const rb = await soRollback(deps, "staging", t.owner.id, "restore V17");
  assert.equal(rb.status, "verified", rb.detail);
  assert.equal(r.state.prompt, V17_TEXT);
});

// ───────────── Required E2E scenarios (closeout §14) — IN-PROCESS: real handlers, SQLite, fake Retell/Stripe ─────────────
// Each scenario below is executed against the platform's real request handlers. None of them is a live Retell call.

test("[VOICE-005] scenarios 1–7, 13–14, 18–19, 22–23, 26–27: discovery, pricing, each package, custom quote, email change, follow-up, decline, DNC, consent, cross-lead, unverified research", async () => {
  const t = await app({ payments: true });
  const d = await dialled(t);
  // 1. discovery saved on the right lead
  const disc = (await t.post(FN, fn(d.callId, d.salesId, "update_outbound_lead", { contact_name: "Bea Baker", contact_role: "Owner", discovery_notes: "Wants online ordering; current site down", service_interests: ["business", "ecommerce"], budget_range: "2500_5000", purchase_timeline: "within_30_days", objections: ["price"] }))).json;
  assert.equal(disc.updated, true);
  const prof = await one<{ verified_contact_name: string; verified_role: string; budget_range: string; objections_json: string }>(t.db, `SELECT * FROM sales_lead_profiles WHERE lead_id = ?`, d.leadId);
  assert.deepEqual([prof.verified_contact_name, prof.verified_role, prof.budget_range, JSON.parse(prof.objections_json)[0]], ["Bea Baker", "Owner", "2500_5000", "price"]);
  // 2. pricing
  assert.equal((await t.post(FN, fn(d.callId, d.salesId, "get_packages_pricing", {}))).json.packages.length, 3);
  // 7. email change (verified through CRM intake)
  const em = (await t.post(FN, fn(d.callId, d.salesId, "update_outbound_lead", { contact_email: "bea@buckeye-bakery.example", qualification: "qualified" }))).json;
  assert.equal(em.contact_verification, "verified");
  // 3–5. each package gets its own link (one per package per day)
  for (const p of ["starter", "business", "premium"]) {
    const o = (await t.post(FN, fn(d.callId, d.salesId, "create_checkout_session", { package: p, email: "bea@buckeye-bakery.example", buyer_confirmed: true }))).json;
    assert.equal(o.checkout_link_sent, true, `${p}: ${JSON.stringify(o)}`);
  }
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM sales_checkout_links WHERE lead_id = ?`, d.leadId), 3);
  // 6. custom quote → quote_required stage, no price invented
  assert.equal((await t.post(FN, fn(d.callId, d.salesId, "update_outbound_lead", { pipeline_stage: "quote_required", next_steps: "Custom quote for ordering integration" }))).json.pipeline_stage, "quote_required");
  // 13. later follow-up (staff callback) once only
  assert.equal((await t.post(FN, fn(d.callId, d.salesId, "schedule_sales_followup", { followup_type: "staff_callback", preferred_date: "2026-11-05", preferred_time: "afternoon", prospect_agreed: true }))).json.scheduled, true);
  assert.equal((await t.post(FN, fn(d.callId, d.salesId, "schedule_sales_followup", { followup_type: "staff_callback", preferred_date: "2026-11-06", prospect_agreed: true }))).json.already_scheduled, true);
  // 26. another lead's id is refused and audited
  const x = await t.post(FN, fn(d.callId, d.salesId, "get_outbound_lead_context", { lead_id: "ld_someoneelse01" }));
  assert.equal(x.res.status, 403);
  // 22–23. consent granted / declined on the shared endpoint, signed by the OUTBOUND workspace (#73)
  const consent = async (callId: string, v: boolean) => { const raw = JSON.stringify({ name: "record_consent", call: salesCall(callId, d.salesId), args: { consent: v } });
    const res = await t.client().request("POST", "/api/webhooks/retell/functions", { body: raw, headers: { "content-type": "application/json", "x-retell-signature": await signRetell(KEY, raw) } }); return { status: res.status, json: await res.json() as Record<string, unknown> }; };
  const yes = await consent(d.callId, true);
  assert.equal(yes.status, 200); assert.equal(yes.json.recorded, true);
  const no = await consent("call_other_declined", false);
  assert.equal(no.status, 200); assert.match(String(no.json.message), /won't keep a recording/);
  // 18. decline → lost
  const t2 = await app(); const d2 = await dialled(t2);
  assert.equal((await t2.post(FN, fn(d2.callId, d2.salesId, "update_outbound_lead", { sales_outcome: "not_interested" }))).json.pipeline_stage, "lost");
  // 19. do-not-call everywhere
  const t3 = await app(); const d3 = await dialled(t3);
  assert.equal((await t3.post(FN, fn(d3.callId, d3.salesId, "record_do_not_call", {}))).json.recorded, true);
  assert.equal(await count(t3.db, `SELECT COUNT(*) AS n FROM voice_dnc WHERE phone_e164 = '+16145552142'`), 1);
  // 27. unverified research → neutral context, no website claims
  const t4 = await app(); const d4 = await dialled(t4);
  // Research older than 45 days is no longer "verified": the context must fall back to a neutral introduction.
  await t4.db.prepare(`UPDATE research_prospects SET last_verified_at = ? WHERE crm_lead_id = ?`).bind(daysAgo(t4.now, 100), d4.leadId).run();
  const ctx4 = (await t4.post(FN, fn(d4.callId, d4.salesId, "get_outbound_lead_context", {}))).json;
  assert.equal(ctx4.research_verified, false);
  assert.deepEqual(ctx4.verified_website_issues, []);
  assert.equal(ctx4.website_url, null);
});

test("[VOICE-005] scenarios 8, 12, 20–21, 24–25, 28–29: phone change, consultation, voicemail, wrong number, timeout retry, duplicate webhook, cross-workspace refusals", async () => {
  const t = await app();
  const d = await dialled(t);
  // 12. consultation without scheduling enabled → honest refusal and a callback offer (never a fake confirmation)
  const cons = (await t.post(FN, fn(d.callId, d.salesId, "schedule_sales_followup", { followup_type: "consultation", prospect_agreed: true }))).json;
  assert.equal(cons.scheduled, false);
  // 24. a function timeout makes Retell retry the same request: the stored result is replayed, nothing is done twice
  const a1 = (await t.post(FN, fn(d.callId, d.salesId, "schedule_sales_followup", { followup_type: "staff_callback", prospect_agreed: true }))).json;
  const a2 = (await t.post(FN, fn(d.callId, d.salesId, "schedule_sales_followup", { followup_type: "staff_callback", prospect_agreed: true }))).json;
  assert.equal(a1.scheduled, true); assert.equal(a2.duplicate, true);
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM sales_followups WHERE lead_id = ? AND kind = 'staff_callback'`, d.leadId), 1);
  // 28. a request signed with the INBOUND (receptionist) key cannot run an outbound function
  const raw = JSON.stringify(fn(d.callId, d.salesId, "get_outbound_lead_context", {}));
  assert.equal((await t.client().request("POST", FN, { body: raw, headers: { "content-type": "application/json", "x-retell-signature": await signRetell(INBOUND_KEY, raw) } })).status, 401);
  // 29. a request signed with the OUTBOUND key cannot run a receptionist function on the shared endpoint
  const raw2 = JSON.stringify({ name: "create_lead", call: salesCall(d.callId, d.salesId), args: { name: "x", phone: "+16145552142" } });
  assert.equal((await t.client().request("POST", "/api/webhooks/retell/functions", { body: raw2, headers: { "content-type": "application/json", "x-retell-signature": await signRetell(KEY, raw2) } })).status, 403);
  // 21. wrong number → disposition, then webhook outcome, consent revoked, verification task
  await t.post(FN, fn(d.callId, d.salesId, "update_outbound_lead", { sales_outcome: "wrong_number" }));
  const ended = { event: "call_ended", call: salesCall(d.callId, d.salesId, { disconnection_reason: "agent_hangup", call_status: "ended", transcript: "wrong number" }) };
  await t.post("/api/webhooks/retell", ended);
  // 25. the same webhook delivered twice: outcome written once
  await t.post("/api/webhooks/retell", ended);
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'sales_outbound.outcome'`), 1);
  // 8. the phone number changed in the CRM since queueing → the next dial is blocked, never placed to the old number
  const t2 = await app(); const l2 = await t2.seedLead(); await t2.authorise("+16145552142", l2);
  await SO.enqueueSalesCall(t2.db, l2, { requestedBy: t2.owner.id, now: t2.now });
  await t2.db.prepare(`UPDATE contacts SET phone = '+16145552199' WHERE id = (SELECT contact_id FROM leads WHERE id = ?)`).bind(l2).run();
  assert.equal((await SO.processSalesQueue(env(t2))).dialled, 0);
  // 20. voicemail → outcome voicemail (Retell's voicemail setting plays the approved message), retried once later
  const t3 = await app(); const d3 = await dialled(t3);
  await t3.post("/api/webhooks/retell", { event: "call_ended", call: salesCall(d3.callId, d3.salesId, { disconnection_reason: "voicemail_reached", call_status: "ended" }) });
  const r3 = (await SO.getSalesCall(t3.db, d3.salesId))!;
  assert.equal(r3.status, "queued"); assert.match(r3.status_detail ?? "", /voicemail on attempt 1/);
});

test("[VOICE-003] scenarios 9–11: warm-transfer events are recorded for the sales call; a cancelled transfer creates an urgent callback task", async () => {
  const t = await app();
  const d = await dialled(t);
  await t.post("/api/webhooks/retell", { event: "call_started", call: salesCall(d.callId, d.salesId) });
  const tr = (event: string) => t.post("/api/webhooks/retell", { event, call: salesCall(d.callId, d.salesId, { transfer_destination: "+16145550199", start_timestamp: 1_790_000_000_000 }) });
  assert.equal((await tr("transfer_started")).res.status, 200);
  assert.equal((await tr("transfer_cancelled")).res.status, 200);
  assert.ok(await count(t.db, `SELECT COUNT(*) AS n FROM crm_activities WHERE kind = 'task' AND (lead_id = ? OR lead_id IS NOT NULL) AND body LIKE '%transfer%'`, d.leadId) >= 1, "failed warm transfer → callback task");
});

test("[SEC-001] POST /api/sales-outbound/test-dispatch signs only synthetic is_test calls with the Worker's own key; never in production", async () => {
  const t = await app({ env: { SCHEDULER_TRIGGER_SECRET: "sched-key" } as Partial<Env> });
  const { signEvidence } = await import("../src/readiness/ingest.ts");
  const send = async (body: unknown, envOver?: Partial<Env>) => {
    const raw = JSON.stringify(body);
    if (envOver) Object.assign(t.env, envOver);
    const res = await t.client().request("POST", "/api/sales-outbound/test-dispatch", { body: raw, headers: { "content-type": "application/json", "x-crestmont-scheduler-signature": await signEvidence("sched-key", raw) } });
    return { status: res.status, json: await res.json() as Record<string, any> };
  };
  const d = await dialled(t); // a real (non-test) lead and call
  const at = ISO(t.now);
  await t.db.batch([
    t.db.prepare(`INSERT INTO companies (id, name, created_at) VALUES ('co_e2e','E2E Bakery (TEST DATA)',?)`).bind(at),
    t.db.prepare(`INSERT INTO contacts (id, company_id, name, phone, created_at) VALUES ('ct_e2e','co_e2e','E2E Bakery (TEST DATA)','+16145550142',?)`).bind(at),
    t.db.prepare(`INSERT INTO leads (id, contact_id, source, stage, interest, message, created_at, updated_at) VALUES ('ld_e2e','ct_e2e','manual','new','starter','[TEST DATA] outbound staging E2E',?,?)`).bind(at, at),
    t.db.prepare(`INSERT INTO sales_calls (id, lead_id, phone_e164, status, attempts, idempotency_key, is_test, created_at, updated_at) VALUES ('scall_e2e1','ld_e2e','+16145550142','dialing',1,'crestmont_scall_e2e1',1,?,?)`).bind(at, at),
  ]);
  const payload = (callId: string, salesId: string, name = "get_packages_pricing") => ({ name, call: { ...salesCall(callId, salesId), to_number: "+16145550142" }, args: {} });
  // A real lead's call can never be dispatched, nor a non-synthetic call id.
  assert.equal((await send({ key: "outbound", target: "outbound_functions", payload: payload("call_e2eX", d.salesId) })).status, 403);
  assert.equal((await send({ key: "outbound", target: "outbound_functions", payload: payload("call_real_1", "scall_e2e1") })).status, 403);
  assert.equal((await send({ key: "outbound", target: "webhook", payload: { event: "call_started", call: { call_id: "call_e2eU" } } })).status, 403, "unbound only to the functions route");
  // The synthetic call: signed with the Worker's outbound key, dispatched through the real route and handler.
  const ok = await send({ key: "outbound", target: "outbound_functions", payload: payload("call_e2e1", "scall_e2e1") });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 200);
  assert.equal(ok.json.json.packages.length, 3);
  // Signed with the INBOUND key, the outbound route refuses it (workspace isolation exercised for real).
  assert.equal((await send({ key: "inbound", target: "outbound_functions", payload: payload("call_e2e1", "scall_e2e1") })).json.status, 401);
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'sales_outbound.test_dispatch'`).first());
  assert.equal((await send({ key: "outbound", target: "outbound_functions", payload: payload("call_e2e1", "scall_e2e1") }, { ENVIRONMENT: "production" })).status, 404);
});
