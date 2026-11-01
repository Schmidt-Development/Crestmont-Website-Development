// Crestmont's own AI receptionist on Retell — closeout (CREST-GAP-053, CREST-GAP-100): prompt synchronisation,
// environment isolation, the Owner voice budget, escalation routing and https-only recording links.
// FIXTURES ONLY: every Retell request and webhook here is simulated (HMAC-signed fixture payloads and a fake
// fetch that records requests). No Retell account, agent, phone number or call is involved, and nothing here
// is evidence of a live Retell connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { signRetell, translateRetellEvent, translateRetellFunction, VOICEMAIL_GREETING } from "../src/adapters/retell.ts";
import { defaultVoiceConfig, saveVoiceConfig, type VoiceConfig } from "../src/services/voice-settings.ts";
import { composePrompt } from "../src/services/voice.ts";
import { voiceBudget } from "../src/services/voice-budget.ts";
import { processOutboundQueue } from "../src/services/voice-outbound.ts";
import { serviceChecks } from "../src/services/monitoring.ts";
import { safeHttpsUrl } from "../src/lib/html.ts";

const KEY = "key_fixture_retell_closeout_0001";
// Monday 2 November 2026, 09:00 in Detroit (EST) — inside the fixture business hours.
const MON_9AM = new Date("2026-11-02T14:00:00Z");
// Same Monday, 20:00 in Detroit — outside them.
const MON_8PM = new Date("2026-11-03T01:00:00Z");
const INSTRUCTIONS = "Greet the caller warmly, state you are an AI assistant, and help with questions about services and packages.";

type Db = Env["DB"];
const count = async (db: Db, sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())!.n;

/** Fake Retell REST API (fixture). Records every request; `remotePrompt` simulates what Retell stores. */
function fakeRetell(opts: { agentEngine?: Record<string, unknown>; status?: number; ignorePatch?: boolean } = {}) {
  const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
  const state = { remotePrompt: "Prompt edited in the Retell dashboard" };
  const f = (async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", url, body, auth: new Headers(init.headers).get("authorization") });
    if (opts.status) return new Response(JSON.stringify({ status: "error", message: "Unauthorized fixture" }), { status: opts.status });
    if (url.includes("/get-agent/")) return new Response(JSON.stringify({ agent_id: "agent_fixture01", version: 3, is_published: true, response_engine: opts.agentEngine ?? { type: "retell-llm", llm_id: "llm_fixture01", version: 3 } }), { status: 200 });
    if (url.includes("/update-retell-llm/")) {
      if (!opts.ignorePatch) state.remotePrompt = (body as { general_prompt: string }).general_prompt;
      return new Response(JSON.stringify({ llm_id: "llm_fixture01", version: 4, is_published: false, general_prompt: state.remotePrompt }), { status: 200 });
    }
    if (url.includes("/get-retell-llm/")) return new Response(JSON.stringify({ llm_id: "llm_fixture01", version: 4, is_published: false, general_prompt: state.remotePrompt }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls, state };
}

function configured(over: Partial<VoiceConfig> = {}): VoiceConfig {
  const c = defaultVoiceConfig();
  c.timezone = "America/Detroit";
  for (const d of ["mon", "tue", "wed", "thu", "fri"] as const) c.hours[d] = [{ open: "09:00", close: "17:00" }];
  return { ...c, ...over };
}

async function app(extra: Partial<Env> = {}, opts: { now?: Date; budget?: string | null; fetch?: typeof fetch } = {}) {
  const t = await createTestApp({ RETELL_INBOUND_API_KEY: KEY, ...extra });
  t.env.overrides = { storage: t.storage, ...(opts.now ? { now: () => opts.now! } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) };
  const c = t.client();
  const post = async (path: string, payload: unknown, key = KEY) => {
    const raw = JSON.stringify(payload);
    const res = await c.request("POST", path, { body: raw, headers: { "content-type": "application/json", "x-retell-signature": await signRetell(key, raw) } });
    return { res, json: (await res.json()) as Record<string, any> };
  };
  const owner = await createStaff(t.db, "owner", "owner@crestmontwebsitedevelopment.com");
  if (opts.budget !== null) await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('voice.monthly_budget_usd', ?, ?)`).bind(opts.budget ?? "50", new Date().toISOString()).run();
  const staff = async () => t.client().login(owner.email, TEST_PASSWORD, owner.secret);
  return { ...t, post, owner, staff };
}

const phoneCall = (id: string, extra: Record<string, unknown> = {}) => ({ call_id: id, call_type: "phone_call", from_number: "+15550100123", to_number: "+15550109999", direction: "inbound", ...extra });
const inbound = (id: string) => ({ event: "call_inbound", call_inbound: { call_id: id, from_number: "+15550100123", to_number: "+15550109999" } });
const fn = (id: string, name: string, args: Record<string, unknown>) => ({ name, call: phoneCall(id), args });

// ───────────── Prompt synchronisation ─────────────

test("[VOICE-004] [VOICE-005] prompt sync without RETELL_INBOUND_API_KEY is refused as 'provider not configured' and sends nothing (fixture)", async () => {
  const r = fakeRetell();
  const t = await app({ RETELL_INBOUND_API_KEY: undefined }, { fetch: r.f });
  await saveVoiceConfig(t.db, t.owner.id, configured({ inbound: { mode: "answer", numbers: [], agent_id: "agent_fixture01" } }));
  const c = await t.staff();
  assert.equal((await c.post("/staff/voice/configs", { instructions: INSTRUCTIONS, note: "Initial" })).status, 303);
  const act = await c.post("/staff/voice/configs/1/activate");
  assert.equal(act.status, 303);
  assert.match(decodeURIComponent(c.cookies.get("cm_flash") ?? ""), /Not pushed to Retell\. Retell provider not configured/);
  const push = await c.post("/staff/voice/prompt-sync", { mode: "push" });
  assert.equal(push.status, 303);
  assert.match(decodeURIComponent(c.cookies.get("cm_flash") ?? ""), /"kind":"error"/, "never shown as success");
  assert.equal(r.calls.length, 0, "no request reaches Retell without a key");
  const rows = (await t.db.prepare(`SELECT status, detail FROM voice_prompt_syncs`).all<{ status: string; detail: string }>()).results;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.status === "not_configured" && /RETELL_INBOUND_API_KEY is not set/.test(x.detail)));
  const page = await (await c.get("/staff/voice")).text();
  assert.match(page, /Provider not configured: RETELL_INBOUND_API_KEY is not set/);
  assert.doesNotMatch(page, /badge--[a-z]+">In Sync/);
});

test("[VOICE-004] [VOICE-005] activating a version pushes the composed prompt to the Retell LLM, reads it back and records in_sync (fake fetch)", async () => {
  const r = fakeRetell();
  r.state.remotePrompt = ""; // a fresh Retell LLM with no prompt yet: nothing to protect
  const t = await app({}, { fetch: r.f });
  await saveVoiceConfig(t.db, t.owner.id, configured({ inbound: { mode: "answer", numbers: [], agent_id: "agent_fixture01" } }));
  const c = await t.staff();
  await c.post("/staff/voice/configs", { instructions: INSTRUCTIONS, note: "Initial" });
  assert.equal((await c.post("/staff/voice/configs/1/activate")).status, 303);
  assert.deepEqual(r.calls.map((x) => `${x.method} ${new URL(x.url).pathname}`), ["GET /get-agent/agent_fixture01", "GET /get-retell-llm/llm_fixture01", "PATCH /update-retell-llm/llm_fixture01", "GET /get-retell-llm/llm_fixture01"], "reads the live prompt before writing (drift guard)");
  assert.ok(r.calls.every((x) => x.url.startsWith("https://api.retellai.com/") && x.auth === `Bearer ${KEY}`));
  assert.deepEqual(r.calls[2].body, { general_prompt: composePrompt(INSTRUCTIONS) }, "only general_prompt is written: guardrails + instructions");
  assert.ok(!r.calls.some((x) => /publish/.test(x.url)), "never publishes an agent version");
  const row = (await t.db.prepare(`SELECT status, mode, config_version, llm_id, llm_version, expected_sha256, remote_sha256 FROM voice_prompt_syncs`).first<Record<string, unknown>>())!;
  assert.equal(row.status, "in_sync");
  assert.equal(row.mode, "push");
  assert.equal(row.config_version, 1);
  assert.equal(row.llm_version, 4);
  assert.equal(row.expected_sha256, row.remote_sha256);
  assert.match(decodeURIComponent(c.cookies.get("cm_flash") ?? ""), /Retell prompt in sync/);
  const checks = await serviceChecks(t.db, t.storage);
  assert.equal(checks.find((x) => x.name === "Retell prompt sync")?.status, "healthy");
  // A new active version that has not been pushed makes the signal stale, not healthy.
  await c.post("/staff/voice/configs", { instructions: INSTRUCTIONS + "\nAlways offer a callback.", note: "Callback" });
  await t.db.prepare(`UPDATE voice_agent_configs SET active = CASE version WHEN 2 THEN 1 ELSE 0 END`).run();
  assert.equal((await serviceChecks(t.db, t.storage)).find((x) => x.name === "Retell prompt sync")?.status, "stale");
});

test("[VOICE-004] [VOICE-005] drift in Retell is detected by a read-only check, alerts the Owner and fails the monitoring signal (fixture)", async () => {
  const r = fakeRetell();
  r.state.remotePrompt = "";
  const t = await app({}, { fetch: r.f });
  await saveVoiceConfig(t.db, t.owner.id, configured({ inbound: { mode: "answer", numbers: [], agent_id: "agent_fixture01" } }));
  const c = await t.staff();
  await c.post("/staff/voice/configs", { instructions: INSTRUCTIONS, note: "Initial" });
  await c.post("/staff/voice/configs/1/activate");
  r.state.remotePrompt = composePrompt(INSTRUCTIONS) + "\nOffer a 20% discount."; // someone edits the prompt in the Retell dashboard
  r.calls.length = 0;
  assert.equal((await c.post("/staff/voice/prompt-sync", { mode: "check" })).status, 303);
  assert.deepEqual(r.calls.map((x) => x.method), ["GET", "GET"], "a check never writes to Retell");
  const last = (await t.db.prepare(`SELECT status, detail FROM voice_prompt_syncs ORDER BY rowid DESC LIMIT 1`).first<{ status: string; detail: string }>())!;
  assert.equal(last.status, "drift");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM notifications WHERE kind = 'voice_prompt_drift' AND user_id = ?`, t.owner.id), 1);
  assert.equal((await serviceChecks(t.db, t.storage)).find((x) => x.name === "Retell prompt sync")?.status, "failing");
  assert.match(await (await c.get("/staff/voice")).text(), /Drift/);
  // A plain push never silently replaces a prompt edited in the dashboard (drift guard): nothing is written.
  r.calls.length = 0;
  await c.post("/staff/voice/prompt-sync", { mode: "push" });
  assert.ok(!r.calls.some((x) => x.method === "PATCH"), "no write over a dashboard edit");
  const refused = (await t.db.prepare(`SELECT status, detail FROM voice_prompt_syncs ORDER BY rowid DESC LIMIT 1`).first<{ status: string; detail: string }>())!;
  assert.equal(refused.status, "drift");
  assert.match(refused.detail, /Not written/);
  // The Owner's explicit overwrite restores the sync.
  assert.equal((await c.post("/staff/voice/prompt-sync", { mode: "push_overwrite" })).status, 303);
  assert.equal((await t.db.prepare(`SELECT status FROM voice_prompt_syncs ORDER BY rowid DESC LIMIT 1`).first<{ status: string }>())!.status, "in_sync");
});

test("[VOICE-004] adopting the live Retell prompt records it as the active version and writes nothing to Retell; later pushes cannot silently restore an older version (fixture)", async () => {
  const r = fakeRetell();
  r.state.remotePrompt = "Founder V4: native single prompt maintained in the Retell dashboard.";
  const t = await app({}, { fetch: r.f });
  await saveVoiceConfig(t.db, t.owner.id, configured({ inbound: { mode: "answer", numbers: [], agent_id: "agent_fixture01" } }));
  const c = await t.staff();
  // An older repository version is saved and activated: activation must NOT overwrite V4.
  await c.post("/staff/voice/configs", { instructions: INSTRUCTIONS, note: "Old repository prompt" });
  await c.post("/staff/voice/configs/1/activate");
  assert.ok(!r.calls.some((x) => x.method === "PATCH"), "activation did not overwrite the dashboard prompt");
  assert.equal(r.state.remotePrompt, "Founder V4: native single prompt maintained in the Retell dashboard.");
  r.calls.length = 0;
  assert.equal((await c.post("/staff/voice/prompt-sync", { mode: "adopt" })).status, 303);
  assert.ok(r.calls.every((x) => x.method === "GET"), "adopt only reads");
  const v = (await t.db.prepare(`SELECT version, prompt_text, change_note FROM voice_agent_configs WHERE active = 1`).first<{ version: number; prompt_text: string; change_note: string }>())!;
  assert.equal(v.version, 2);
  assert.equal(v.prompt_text, r.state.remotePrompt);
  assert.match(v.change_note, /Adopted the live Retell prompt/);
  assert.equal((await t.db.prepare(`SELECT status FROM voice_prompt_syncs ORDER BY rowid DESC LIMIT 1`).first<{ status: string }>())!.status, "in_sync");
  await c.post("/staff/voice/prompt-sync", { mode: "check" });
  assert.equal((await t.db.prepare(`SELECT status FROM voice_prompt_syncs ORDER BY rowid DESC LIMIT 1`).first<{ status: string }>())!.status, "in_sync", "the adopted version matches Retell");
});

test("[VOICE-005] a push that Retell does not apply is drift, and provider errors are recorded as failed — never success (fixture)", async () => {
  const ignored = fakeRetell({ ignorePatch: true });
  const t = await app({}, { fetch: ignored.f });
  await saveVoiceConfig(t.db, t.owner.id, configured({ inbound: { mode: "answer", numbers: [], agent_id: "agent_fixture01" } }));
  const c = await t.staff();
  await c.post("/staff/voice/configs", { instructions: INSTRUCTIONS, note: "Initial" });
  await c.post("/staff/voice/configs/1/activate");
  assert.equal((await t.db.prepare(`SELECT status FROM voice_prompt_syncs`).first<{ status: string }>())!.status, "drift");

  const denied = fakeRetell({ status: 401 });
  const t2 = await app({}, { fetch: denied.f });
  await saveVoiceConfig(t2.db, t2.owner.id, configured({ inbound: { mode: "answer", numbers: [], agent_id: "agent_fixture01" } }));
  const c2 = await t2.staff();
  await c2.post("/staff/voice/configs", { instructions: INSTRUCTIONS, note: "Initial" });
  await c2.post("/staff/voice/configs/1/activate");
  const f = (await t2.db.prepare(`SELECT status, detail FROM voice_prompt_syncs`).first<{ status: string; detail: string }>())!;
  assert.equal(f.status, "failed");
  assert.match(f.detail, /Retell 401: Unauthorized fixture/);
  assert.doesNotMatch(f.detail, new RegExp(KEY), "the API key is never recorded");

  const flow = fakeRetell({ agentEngine: { type: "conversation-flow", conversation_flow_id: "cf_1" } });
  const t3 = await app({}, { fetch: flow.f });
  await saveVoiceConfig(t3.db, t3.owner.id, configured({ inbound: { mode: "answer", numbers: [], agent_id: "agent_fixture01" } }));
  const c3 = await t3.staff();
  await c3.post("/staff/voice/configs", { instructions: INSTRUCTIONS, note: "Initial" });
  await c3.post("/staff/voice/configs/1/activate");
  assert.match((await t3.db.prepare(`SELECT detail FROM voice_prompt_syncs`).first<{ detail: string }>())!.detail, /does not use a Retell LLM/);
  assert.ok(!flow.calls.some((x) => x.method === "PATCH"));
});

// ───────────── Environment isolation ─────────────

test("[VOICE-003] [INFRA-002] staging and production never accept each other's Retell events (env stamp + per-workspace key)", async () => {
  const s = await app({ ENVIRONMENT: "staging" });
  const prodStamp = { metadata: { crestmont_env: "production" } };
  const ev = await s.post("/api/webhooks/retell", { event: "call_started", call: phoneCall("x_prod", prodStamp) });
  assert.deepEqual(ev.json, { ok: true, ignored: "environment_mismatch" });
  const f = await s.post("/api/webhooks/retell/functions", { name: "create_lead", call: phoneCall("x_prod", prodStamp), args: { name: "Pat", phone: "+15550100124", interest: "business", requirements: "A website" } });
  assert.equal(f.res.status, 409);
  assert.equal(await count(s.db, `SELECT COUNT(*) n FROM calls`), 0);
  assert.equal(await count(s.db, `SELECT COUNT(*) n FROM leads`), 0);
  // The staging inbound webhook stamps calls as staging.
  const inb = await s.post("/api/webhooks/retell/inbound", inbound("x_stg"));
  assert.deepEqual(inb.json.call_inbound.metadata, { crestmont_env: "staging" });
  assert.equal(inb.json.call_inbound.dynamic_variables.crestmont_env, "staging");
  // A production workspace signs with a different API key: staging rejects it before reading the body.
  const other = await s.post("/api/webhooks/retell", { event: "call_started", call: phoneCall("x_other") }, "key_fixture_production_workspace");
  assert.equal(other.res.status, 401);
  // Mirror: production refuses a staging-stamped event and function call (adapter level, fixture DB).
  const p = await createTestApp();
  const stg = JSON.stringify({ event: "call_ended", call: phoneCall("y_stg", { metadata: { crestmont_env: "staging" } }) });
  assert.deepEqual((await translateRetellEvent(p.db, stg, { environment: "production" })), { kind: "ack", body: { ok: true, ignored: "environment_mismatch" } });
  const fstg = JSON.stringify({ name: "escalate", call: phoneCall("y_stg", { metadata: { crestmont_env: "staging" } }), args: { reason: "help" } });
  assert.equal((await translateRetellFunction(p.db, fstg, { environment: "production" })).kind, "ack");
  assert.equal(await count(p.db, `SELECT COUNT(*) n FROM calls`), 0);
});

test("[VOICE-003] [SEC-002] Retell webhooks fail closed without RETELL_INBOUND_API_KEY, even with a valid-looking signature (fixture)", async () => {
  const t = await app({ RETELL_INBOUND_API_KEY: undefined });
  for (const path of ["/api/webhooks/retell", "/api/webhooks/retell/functions", "/api/webhooks/retell/inbound"]) {
    assert.equal((await t.post(path, inbound("z_1"))).res.status, 401, path);
  }
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM calls`), 0);
});

// ───────────── Cost controls ─────────────

test("[VOICE-005] no Owner voice budget → inbound answers in voicemail-only mode; only message-taking functions run (fixture)", async () => {
  const t = await app({}, { now: MON_9AM, budget: null });
  await saveVoiceConfig(t.db, t.owner.id, configured({ transfer: { enabled: true, number: "+15550107777" }, scheduling: { ...defaultVoiceConfig().scheduling, enabled: true } }));
  const r = await t.post("/api/webhooks/retell/inbound", inbound("b_1"));
  const ci = r.json.call_inbound;
  assert.equal(ci.dynamic_variables.receptionist_mode, "voicemail");
  assert.equal(ci.dynamic_variables.transfer_available, "false");
  assert.equal(ci.dynamic_variables.transfer_number, "", "no transfer while closed, even inside hours");
  assert.equal(ci.dynamic_variables.scheduling_available, "false");
  assert.deepEqual(ci.agent_override, { agent: { max_call_duration_ms: 180000 }, retell_llm: { begin_message: VOICEMAIL_GREETING } });
  for (const v of Object.values(ci.dynamic_variables)) assert.equal(typeof v, "string");
  const lead = await t.post("/api/webhooks/retell/functions", fn("b_1", "create_lead", { name: "Pat", phone: "+15550100123", interest: "business", requirements: "A new website" }));
  assert.equal(lead.json.refused, "voicemail_mode");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM leads`), 0, "refused in code, not only in the prompt");
  const cb = await t.post("/api/webhooks/retell/functions", fn("b_1", "request_callback", { name: "Pat", phone: "+15550100123", reason: "Wants a website quote" }));
  assert.equal(cb.json.callbackRequested, true);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM crm_activities WHERE kind = 'task'`), 1, "message becomes a callback task");
  assert.equal((await voiceBudget(t.db)).state, "not_set");
  assert.equal((await serviceChecks(t.db, t.storage)).find((x) => x.name === "AI receptionist budget")?.status, "not_configured");
});

test("[VOICE-005] voice budget: costs are recorded per call, the month's spend closes the line when reached, Owners are told once, outbound stops (fixture)", async () => {
  // Real clock here: the month's spend is keyed on each call's started_at.
  const t = await app({ RETELL_OUTBOUND: "on" }, { budget: "1" });
  const ob = configured({ inbound: { mode: "answer", numbers: ["+15550109999"], agent_id: null } });
  ob.outbound = { ...ob.outbound, enabled: true, agent_id: "agent_fixture01", from_number: "+15550109999" };
  await saveVoiceConfig(t.db, t.owner.id, ob);
  const c = await t.staff();
  // Owner sets the budget through /staff/voice (Owner-only route).
  assert.equal((await c.post("/staff/voice/budget", { monthly_budget_usd: "1.50" })).status, 303);
  assert.equal((await voiceBudget(t.db)).budgetMicro, 1_500_000);
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'voice.budget_updated'`).first());
  const open = await t.post("/api/webhooks/retell/inbound", inbound("k_1"));
  assert.equal(open.json.call_inbound.dynamic_variables.receptionist_mode, "full");
  assert.equal(open.json.call_inbound.agent_override, undefined);
  // Retell reports combined_cost in cents: 120 cents = $1.20 → 80% warning.
  await t.post("/api/webhooks/retell", { event: "call_ended", call: phoneCall("k_1", { call_cost: { combined_cost: 120 }, disconnection_reason: "user_hangup", transcript: "Caller: hi" }) });
  assert.equal((await t.db.prepare(`SELECT cost_microusd FROM calls WHERE provider_call_id = 'k_1'`).first<{ cost_microusd: number }>())!.cost_microusd, 1_200_000);
  assert.equal((await voiceBudget(t.db)).state, "warning");
  // Second call's cost arrives with call_analyzed and crosses the budget.
  await t.post("/api/webhooks/retell/inbound", inbound("k_2"));
  await t.post("/api/webhooks/retell", { event: "call_ended", call: phoneCall("k_2", { disconnection_reason: "user_hangup", transcript: "Caller: hello" }) });
  await t.post("/api/webhooks/retell", { event: "call_analyzed", call: phoneCall("k_2", { call_cost: { combined_cost: 45.5 } }) });
  const b = await voiceBudget(t.db);
  assert.equal(b.spentMicro, 1_655_000);
  assert.equal(b.state, "exhausted");
  const closed = await t.post("/api/webhooks/retell/inbound", inbound("k_3"));
  assert.equal(closed.json.call_inbound.dynamic_variables.receptionist_mode, "voicemail");
  await t.post("/api/webhooks/retell/inbound", inbound("k_4"));
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM notifications WHERE kind = 'voice_budget_exhausted' AND user_id = ?`, t.owner.id), 1, "Owners are notified once per month");
  assert.equal((await serviceChecks(t.db, t.storage)).find((x) => x.name === "AI receptionist budget")?.status, "failing");
  const page = await (await c.get("/staff/voice")).text();
  assert.match(page, /\$1\.66 of \$1\.50 used/);
  assert.match(page, /Budget reached/);
  const q = await processOutboundQueue({ db: t.db, env: { ...t.env, RETELL_OUTBOUND: "on" }, fetch: (() => { throw new Error("must not dial"); }) as unknown as typeof fetch });
  assert.equal(q.detail, "skipped: voice budget reached");
  // Only Owners may change it.
  const admin = await createStaff(t.db, "administrator", "admin@crestmont.test");
  const ac = await t.client().login(admin.email, TEST_PASSWORD, admin.secret);
  assert.equal((await ac.post("/staff/voice/budget", { monthly_budget_usd: "1000" })).status, 403);
  assert.equal((await c.post("/staff/voice/budget", { monthly_budget_usd: "-5" })).status, 303);
  assert.equal((await voiceBudget(t.db)).budgetMicro, 1_500_000, "invalid input changes nothing");
});

// ───────────── Escalation ─────────────

test("[VOICE-003] escalation in staffed hours with a transfer number returns transfer variables; no email, no number given to the model (fixture)", async () => {
  const t = await app({}, { now: MON_9AM });
  await saveVoiceConfig(t.db, t.owner.id, configured({ transfer: { enabled: true, number: "+15550107777" } }));
  await t.post("/api/webhooks/retell/inbound", inbound("e_1"));
  const r = await t.post("/api/webhooks/retell/functions", fn("e_1", "escalate", { reason: "Wants to talk to a person about a contract", phone: "+15550100123" }));
  assert.equal(r.json.transfer, true);
  assert.equal(r.json.transfer_available, true);
  assert.doesNotMatch(JSON.stringify(r.json), /5550107777/, "the destination is never returned to the model");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE template = 'voice_escalation'`), 0);
  assert.ok(await t.db.prepare(`SELECT 1 FROM calls WHERE provider_call_id = 'e_1' AND escalated_at IS NOT NULL`).first());
});

test("[VOICE-003] escalation outside staffed hours (or with no transfer number) emails the Owners and creates a CRM task (fixture)", async () => {
  const t = await app({}, { now: MON_8PM });
  await saveVoiceConfig(t.db, t.owner.id, configured({ transfer: { enabled: true, number: "+15550107777" } }));
  await t.post("/api/webhooks/retell/inbound", inbound("e_2"));
  const r = await t.post("/api/webhooks/retell/functions", fn("e_2", "escalate", { reason: "Urgent: website is down", name: "Sam" }));
  assert.equal(r.json.escalated, true);
  assert.equal(r.json.transfer, false);
  const task = await t.db.prepare(`SELECT a.body, a.due_at FROM crm_activities a JOIN calls c ON c.lead_id = a.lead_id WHERE c.provider_call_id = 'e_2' AND a.kind = 'task'`).first<{ body: string; due_at: string }>();
  assert.match(task!.body, /ESCALATION from AI receptionist: Urgent: website is down — call back \+15550100123/);
  const mail = await t.db.prepare(`SELECT d.to_email, m.subject, m.text_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.template = 'voice_escalation'`).first<{ to_email: string; subject: string; text_body: string }>();
  assert.equal(mail!.to_email, t.owner.email);
  assert.match(mail!.subject, /escalation/);
  assert.match(mail!.text_body, /outside staffed hours/);
  assert.match(mail!.text_body, /\/staff\/voice\/calls\/call_/);
  // A retried function request (same args → same idempotency key) does not email or task twice.
  await t.post("/api/webhooks/retell/functions", fn("e_2", "escalate", { reason: "Urgent: website is down", name: "Sam" }));
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE template = 'voice_escalation'`), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM crm_activities WHERE kind = 'task'`), 1);
  // No transfer number configured, inside hours → also task + email.
  const t2 = await app({}, { now: MON_9AM });
  await saveVoiceConfig(t2.db, t2.owner.id, configured());
  const r2 = await t2.post("/api/webhooks/retell/functions", fn("e_3", "escalate", { reason: "Asked for a person" }));
  assert.equal(r2.json.transfer, false);
  assert.match((await t2.db.prepare(`SELECT m.text_body FROM email_messages m JOIN email_deliveries d ON d.id = m.delivery_id WHERE d.template = 'voice_escalation'`).first<{ text_body: string }>())!.text_body, /No live-transfer number/);
});

// ───────────── Redaction and consent stay intact ─────────────

test("[VOICE-006] card numbers are redacted and transcripts need consent on the Retell path (fixture)", async () => {
  const t = await app({}, { now: MON_9AM });
  await t.post("/api/webhooks/retell/inbound", inbound("r_1"));
  await t.post("/api/webhooks/retell/functions", fn("r_1", "request_callback", { name: "Pat", phone: "+15550100123", reason: "My card is 4242 4242 4242 4242, please call" }));
  const body = (await t.db.prepare(`SELECT body FROM crm_activities WHERE kind = 'task'`).first<{ body: string }>())!.body;
  assert.match(body, /\[card number removed\]/);
  assert.doesNotMatch(body, /4242 4242/);
  await t.post("/api/webhooks/retell", { event: "call_ended", call: phoneCall("r_1", { transcript: "Caller: hi", recording_url: "https://recordings.example/r_1.wav" }) });
  const row = (await t.db.prepare(`SELECT transcript, recording_url FROM calls WHERE provider_call_id = 'r_1'`).first<{ transcript: string | null; recording_url: string | null }>())!;
  assert.deepEqual({ ...row }, { transcript: null, recording_url: null }, "no consent → nothing stored");
});

// ───────────── CREST-GAP-100: recording links are https-only ─────────────

test("[VOICE-006] [SEC-002] a provider-supplied recording URL renders only when https; javascript: renders as # (CREST-GAP-100)", async () => {
  assert.equal(safeHttpsUrl("javascript:alert(1)"), "#");
  assert.equal(safeHttpsUrl(" JaVaScRiPt:alert(1)"), "#");
  assert.equal(safeHttpsUrl("data:text/html,<script>alert(1)</script>"), "#");
  assert.equal(safeHttpsUrl("http://recordings.example/a.wav"), "#");
  assert.equal(safeHttpsUrl("//recordings.example/a.wav"), "#");
  assert.equal(safeHttpsUrl("https://user:pw@recordings.example/a.wav"), "#");
  assert.equal(safeHttpsUrl("https://recordings.example/a.wav"), "https://recordings.example/a.wav");
  const t = await app({}, { now: MON_9AM });
  // Webhook path: with consent, a javascript: URL is still never stored.
  await t.post("/api/webhooks/retell", { event: "call_started", call: phoneCall("g_1") });
  await t.post("/api/webhooks/retell/functions", fn("g_1", "record_consent", { consent: true }));
  await t.post("/api/webhooks/retell", { event: "call_ended", call: phoneCall("g_1", { transcript: "Caller: hi", recording_url: "javascript:alert(document.cookie)" }) });
  assert.equal((await t.db.prepare(`SELECT recording_url FROM calls WHERE provider_call_id = 'g_1'`).first<{ recording_url: string | null }>())!.recording_url, null);
  // Rendering path: a row written before validation existed (or by any other writer) renders as "#".
  await t.db.prepare(`UPDATE calls SET recording_consent = 1, recording_url = 'javascript:alert(document.cookie)' WHERE provider_call_id = 'g_1'`).run();
  const id = (await t.db.prepare(`SELECT id FROM calls WHERE provider_call_id = 'g_1'`).first<{ id: string }>())!.id;
  const c = await t.staff();
  const page = await (await c.get(`/staff/voice/calls/${id}`)).text();
  assert.doesNotMatch(page, /href="javascript:/i);
  assert.match(page, /<a href="#" rel="noopener noreferrer">Recording link withheld \(not an https URL\)<\/a>/);
  await t.db.prepare(`UPDATE calls SET recording_url = 'https://recordings.example/g_1.wav' WHERE id = ?`).bind(id).run();
  assert.match(await (await c.get(`/staff/voice/calls/${id}`)).text(), /<a href="https:\/\/recordings\.example\/g_1\.wav" rel="noopener noreferrer">Recording \(provider-hosted\)<\/a>/);
});
