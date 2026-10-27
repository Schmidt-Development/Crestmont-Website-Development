import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD } from "./support/app.ts";
import { signVoiceEvent, publishedPricing, inventedPrices, VOICE_GUARDRAILS, lineDiff, configProblems } from "../src/services/voice.ts";
import { PACKAGES, MAINTENANCE_PLANS } from "../src/domain/catalog.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { newId, nowIso } from "../src/lib/db.ts";

const SECRET = "voice-test-secret";

async function setup() {
  const app = await createTestApp({ VOICE_WEBHOOK_SECRET: SECRET });
  const c = app.client();
  const send = async (body: Record<string, unknown>, opts: { sig?: string | null; secret?: string } = {}) => {
    const raw = JSON.stringify({ provider: "testprov", ...body });
    const sig = opts.sig === undefined ? await signVoiceEvent(opts.secret ?? SECRET, raw) : opts.sig;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (sig !== null) headers["x-crestmont-voice-signature"] = sig;
    const res = await c.request("POST", "/api/webhooks/voice", { body: raw, headers });
    return { res, json: (await res.json()) as Record<string, any> };
  };
  return { ...app, send };
}

test("[VOICE-003] webhook rejects missing, malformed, wrong and stale signatures, and fails closed without a secret", async () => {
  const { send, db } = await setup();
  const ev = { event: "call_started", call_id: "c1" };
  assert.equal((await send(ev, { sig: null })).res.status, 401);
  assert.equal((await send(ev, { sig: "t=1,v1=abc" })).res.status, 401);
  assert.equal((await send(ev, { secret: "wrong" })).res.status, 401);
  const raw = JSON.stringify({ provider: "testprov", ...ev });
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.equal((await send(ev, { sig: `t=${old},v1=${await hmacSha256Hex(SECRET, `${old}.${raw}`)}` })).res.status, 401);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM calls`).first<{ n: number }>())!.n, 0);
  // No secret configured → every request refused, even a well-formed one.
  const app2 = await createTestApp();
  const res = await app2.client().request("POST", "/api/webhooks/voice", { body: raw, headers: { "x-crestmont-voice-signature": await signVoiceEvent("anything", raw) } });
  assert.equal(res.status, 401);
  assert.match(((await res.json()) as { error: string }).error, /not configured/);
});

test("[VOICE-003] call events are idempotent per provider call id and function event id", async () => {
  const { send, db } = await setup();
  assert.equal((await send({ event: "call_started", call_id: "c-idem", from_number: "+1 555 0101" })).res.status, 200);
  const dup = await send({ event: "call_started", call_id: "c-idem" });
  assert.equal(dup.json.duplicate, true);
  const lead = { event: "function_call", call_id: "c-idem", event_id: "fn-1", function: { name: "create_lead", arguments: { name: "Riley Jones", phone: "+1 555 0101", email: "riley@example.com", interest: "business", requirements: "Ten page site for a dental office" } } };
  const first = await send(lead);
  assert.equal(first.json.result.leadCreated, true);
  const again = await send(lead);
  assert.equal(again.json.duplicate, true);
  assert.deepEqual(again.json.result, first.json.result);
  assert.equal((await send({ event: "call_ended", call_id: "c-idem", outcome: "lead_captured" })).res.status, 200);
  assert.equal((await send({ event: "call_ended", call_id: "c-idem", outcome: "abandoned" })).json.duplicate, true);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM calls`).first<{ n: number }>())!.n, 1);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM leads`).first<{ n: number }>())!.n, 1);
  assert.equal((await db.prepare(`SELECT outcome FROM calls`).first<{ outcome: string }>())!.outcome, "lead_captured");
});

test("[VOICE-003] create_lead creates an ai_receptionist contact + lead linked to the call; callbacks become CRM tasks", async () => {
  const { send, db } = await setup();
  await send({ event: "call_started", call_id: "c-lead" });
  await send({ event: "function_call", call_id: "c-lead", event_id: "e1", function: { name: "create_lead", arguments: { name: "Sam Lee", email: "sam@example.com", company: "Lee Dental", interest: "premium", requirements: "Booking system and 20 pages" } } });
  await send({ event: "function_call", call_id: "c-lead", event_id: "e2", function: { name: "request_callback", arguments: { name: "Sam Lee", phone: "+1 555 0102", reason: "Wants to discuss timeline", preferred_time: "mornings" } } });
  const row = await db.prepare(`SELECT l.id, l.source, l.stage, l.interest, c.email, c.name, k.lead_id FROM leads l JOIN contacts c ON c.id = l.contact_id JOIN calls k ON k.lead_id = l.id`).first<Record<string, string>>();
  assert.equal(row!.source, "ai_receptionist");
  assert.equal(row!.stage, "new");
  assert.equal(row!.interest, "premium");
  assert.equal(row!.email, "sam@example.com");
  const task = await db.prepare(`SELECT body, due_at FROM crm_activities WHERE lead_id = ? AND kind = 'task'`).bind(row!.id).first<{ body: string; due_at: string }>();
  assert.match(task!.body, /Call back Sam Lee at \+1 555 0102/);
  assert.ok(task!.due_at);
  const bad = await send({ event: "function_call", call_id: "c-lead", event_id: "e3", function: { name: "create_lead", arguments: { name: "X" } } });
  assert.equal(bad.res.status, 422);
  const unknown = await send({ event: "function_call", call_id: "c-lead", event_id: "e4", function: { name: "issue_refund", arguments: {} } });
  assert.equal(unknown.res.status, 422, "no refund function exists");
});

test("[VOICE-004] get_published_pricing returns exactly the catalog prices and nothing about maintenance entitlements", async () => {
  const { send } = await setup();
  await send({ event: "call_started", call_id: "c-price" });
  const r = await send({ event: "function_call", call_id: "c-price", event_id: "p1", function: { name: "get_published_pricing", arguments: {} } });
  const p = r.json.result.pricing;
  assert.deepEqual(p.packages.map((x: { name: string; priceCents: number }) => [x.name, x.priceCents]), Object.values(PACKAGES).map((x) => [x.name, x.basePriceCents]));
  assert.deepEqual(p.packages.map((x: { price: string }) => x.price), ["$999", "$2,499", "$4,999+"]);
  assert.deepEqual(p.maintenance.map((x: { monthlyCents: number }) => x.monthlyCents), Object.values(MAINTENANCE_PLANS).map((m) => m.monthlyCents));
  const text = JSON.stringify(r.json);
  for (const m of Object.values(MAINTENANCE_PLANS)) for (const v of Object.values(m.proposedEntitlements)) assert.ok(!text.includes(v), `leaked entitlement: ${v}`);
  assert.doesNotMatch(text, /proposedEntitlements|\$9[05]\/hour|\$85\/hour|backups|retention/i);
  assert.deepEqual(publishedPricing(), p);
});

test("[VOICE-004] guardrails: immutable prefix, invented prices and contradictions rejected, versions diffable", async () => {
  assert.deepEqual(inventedPrices("Starter is $999, Business $2,499 and maintenance $99"), []);
  assert.deepEqual(inventedPrices("We can do it for $1,500 or $49.99"), ["$1,500", "$49.99"]);
  assert.ok(configProblems("Tell callers we guarantee launch in two weeks and the price is $750 for everything.").length >= 2);
  assert.match(VOICE_GUARDRAILS, /AI assistant/);
  for (const re of [/published pricing/i, /delivery dates/i, /agreement/i, /refunds/i, /customer's information/i, /status of any project/i]) assert.match(VOICE_GUARDRAILS, re);
  const app = await createTestApp();
  const owner = await createStaff(app.db, "owner");
  const c = await app.client().login(owner.email, TEST_PASSWORD, owner.secret);
  const base = "Greet the caller warmly, state you are an AI assistant, and help with questions about services and packages.";
  assert.equal((await c.post("/staff/voice/configs", { instructions: base, note: "Initial" })).status, 303);
  assert.equal((await c.post("/staff/voice/configs", { instructions: base + "\nOffer a discount of $500.", note: "Bad" })).status, 422);
  assert.equal((await c.post("/staff/voice/configs", { instructions: base + "\nAlways offer a callback.", note: "Callback" })).status, 303);
  const rows = (await app.db.prepare(`SELECT version, prompt_text, active FROM voice_agent_configs ORDER BY version`).all<{ version: number; prompt_text: string; active: number }>()).results;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.prompt_text.startsWith(VOICE_GUARDRAILS) && r.active === 0));
  assert.equal((await c.post("/staff/voice/configs/2/activate")).status, 303);
  assert.equal((await c.post("/staff/voice/configs/1/activate")).status, 303);
  const active = (await app.db.prepare(`SELECT version FROM voice_agent_configs WHERE active = 1`).all<{ version: number }>()).results;
  assert.deepEqual(active.map((r) => r.version), [1], "exactly one active version");
  const diff = await (await c.get("/staff/voice/configs/diff?a=1&b=2")).text();
  assert.match(diff, /diff__add">\+ Always offer a callback\./);
  assert.deepEqual(lineDiff("a\nb", "a\nc").map((d) => d.op + d.text), [" a", "-b", "+c"]);
  assert.ok(await app.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'voice.config_activated'`).first());
});

test("[VOICE-004] route_support never leaks customer data and only opens a ticket for a verified email+phone match", async () => {
  const { send, db } = await setup();
  const cust = await createCustomer(db, "owner@acme.example", "Acme Plumbing");
  await db.prepare(`INSERT INTO contacts (id, name, email, phone, user_id, created_at) VALUES (?,?,?,?,?,?)`).bind(newId("ct"), "Pat", "owner@acme.example", "(517) 555-0199", cust.id, nowIso()).run();
  await db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES (?,?,'Acme Secret Project','design',2,'upfront',?,?)`).bind(newId("prj"), cust.organizationId, nowIso(), nowIso()).run();
  const call = async (id: string, args: Record<string, string>) => {
    await send({ event: "call_started", call_id: id });
    return send({ event: "function_call", call_id: id, event_id: "s1", function: { name: "route_support", arguments: { name: "Pat", summary: "My contact form stopped working", ...args } } });
  };
  const wrongPhone = await call("s-wrong-phone", { email: "owner@acme.example", phone: "+1 517 555 0000" });
  const stranger = await call("s-stranger", { email: "nobody@example.com", phone: "+1 517 555 0199" });
  const matched = await call("s-match", { email: "OWNER@acme.example", phone: "+1 (517) 555-0199" });
  for (const r of [wrongPhone, stranger, matched]) {
    const t = JSON.stringify(r.json);
    assert.doesNotMatch(t, /Acme|Plumbing|Secret Project|owner@acme|org_|usr_|tkt_/i);
  }
  assert.deepEqual(wrongPhone.json.result, matched.json.result, "identical response whether or not matched");
  assert.deepEqual(stranger.json.result, matched.json.result);
  const tickets = (await db.prepare(`SELECT organization_id, opened_by FROM tickets`).all<{ organization_id: string; opened_by: string }>()).results;
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].organization_id, cust.organizationId);
  const callbacks = (await db.prepare(`SELECT body FROM crm_activities WHERE kind = 'task'`).all<{ body: string }>()).results;
  assert.equal(callbacks.length, 2);
  assert.ok(callbacks.every((c) => /verify identity/.test(c.body)));
  // Unverified email never matches.
  await db.prepare(`UPDATE users SET email_verified_at = NULL WHERE id = ?`).bind(cust.id).run();
  await call("s-unverified", { email: "owner@acme.example", phone: "+1 517 555 0199" });
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM tickets`).first<{ n: number }>())!.n, 1);
});

test("[VOICE-006] transcripts, summaries and recordings are stored only with recording consent", async () => {
  const { send, db } = await setup();
  await send({ event: "call_started", call_id: "no-consent", recording_consent: false });
  await send({ event: "call_ended", call_id: "no-consent", outcome: "info_only", transcript: "Caller: my card number is 4242", summary: "Asked about pricing", recording_url: "https://provider.example/rec/1", cost_microusd: 41000 });
  await send({ event: "call_started", call_id: "consent", recording_consent: true });
  await send({ event: "call_ended", call_id: "consent", outcome: "info_only", transcript: "Caller: hello", summary: "Greeting", recording_url: "https://provider.example/rec/2" });
  const rows = (await db.prepare(`SELECT provider_call_id, recording_consent, transcript, summary, recording_url, cost_microusd FROM calls ORDER BY provider_call_id`).all<Record<string, unknown>>()).results;
  const nc = rows.find((r) => r.provider_call_id === "no-consent")!;
  const yc = rows.find((r) => r.provider_call_id === "consent")!;
  assert.deepEqual([nc.recording_consent, nc.transcript, nc.summary, nc.recording_url, nc.cost_microusd], [0, null, null, null, 41000]);
  assert.deepEqual([yc.recording_consent, yc.transcript, yc.summary, yc.recording_url, yc.cost_microusd], [1, "Caller: hello", "Greeting", "https://provider.example/rec/2", null]);
  const ev = await db.prepare(`SELECT e.detail FROM voice_events e JOIN calls c ON c.id = e.call_id WHERE c.provider_call_id = 'no-consent' AND e.kind = 'call_ended'`).first<{ detail: string }>();
  assert.match(ev!.detail, /discarded: no recording consent/);
});

test("[VOICE-005] voice admin shows not-configured provider, no number, costs Unknown, and separates test calls", async () => {
  const { send, db, client } = await setup();
  const owner = await createStaff(db, "owner");
  await send({ event: "call_started", call_id: "real-1", from_number: "+1 555 0110" });
  await send({ event: "function_call", call_id: "real-1", event_id: "x", function: { name: "escalate", arguments: { reason: "Asked about changing a contract", phone: "+1 555 0110" } } });
  await send({ event: "call_ended", call_id: "real-1", outcome: "escalated" });
  await send({ event: "call_started", call_id: "test-1", test: true });
  await send({ event: "call_ended", call_id: "test-1", outcome: "info_only", cost_microusd: 5000 });
  const c = await client().login(owner.email, TEST_PASSWORD, owner.secret);
  const html = await (await c.get("/staff/voice")).text();
  assert.match(html, /None purchased/);
  assert.match(html, /Purchasing a number requires Founder approval/);
  assert.match(html, /PROVIDER-EVALUATION\.md/);
  assert.match(html, /1 test calls excluded/);
  assert.match(html, /1 calls with unknown cost/);
  assert.match(html, /\+1 555 0110/);
  assert.doesNotMatch(html, /test-1/);
  const tests = await (await c.get("/staff/voice?test=1")).text();
  assert.match(tests, />Test</);
  const ntf = await db.prepare(`SELECT body FROM notifications WHERE user_id = ? AND kind = 'voice_escalation'`).bind(owner.id).first<{ body: string }>();
  assert.match(ntf!.body, /escalated a call/);
  const callId = (await db.prepare(`SELECT id FROM calls WHERE provider_call_id = 'real-1'`).first<{ id: string }>())!.id;
  const detail = await (await c.get(`/staff/voice/calls/${callId}`)).text();
  assert.match(detail, /did not consent to recording/);
  const a = await createStaff(db, "administrator");
  const admin = await client().login(a.email, TEST_PASSWORD, a.secret);
  assert.equal((await admin.get("/staff/voice")).status, 403, "voice.manage is Owner-only");
});

test("[VOICE-005] development test-event tool signs events through the webhook and labels the call as test", async () => {
  const { db, client } = await setup();
  const owner = await createStaff(db, "owner");
  const c = await client().login(owner.email, TEST_PASSWORD, owner.secret);
  const res = await c.post("/staff/voice/test-event", { scenario: "lead" });
  assert.equal(res.status, 303);
  const call = await db.prepare(`SELECT is_test, outcome, lead_id FROM calls`).first<{ is_test: number; outcome: string; lead_id: string }>();
  assert.equal(call!.is_test, 1);
  assert.equal(call!.outcome, "lead_captured");
  const lead = await db.prepare(`SELECT source, message FROM leads WHERE id = ?`).bind(call!.lead_id).first<{ source: string; message: string }>();
  assert.equal(lead!.source, "ai_receptionist");
  assert.match(lead!.message, /^\[TEST CALL\]/);
  // Not available outside development.
  const staging = await createTestApp({ VOICE_WEBHOOK_SECRET: SECRET, ENVIRONMENT: "staging" });
  const o2 = await createStaff(staging.db, "owner");
  const c2 = await staging.client().login(o2.email, TEST_PASSWORD, o2.secret);
  assert.equal((await c2.post("/staff/voice/test-event", { scenario: "lead" })).status, 403);
});
