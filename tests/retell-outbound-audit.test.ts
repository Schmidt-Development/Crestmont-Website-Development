// Read-only audit of the outbound SALES agent's live Retell configuration (src/services/retell-outbound-audit.ts) against
// the Founder's decisions of 2026-11-01 (V17 prompt authoritative, no Default Dynamic Variables, nine custom functions,
// warm transfer, approved voicemail, 60-minute calls), plus bidirectional prompt isolation.
// FIXTURES ONLY: a fake Retell API stands in for api.retellai.com; nothing here proves a live Retell configuration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { auditOutboundRetell, analysePrompt, SALES_REQUIRED_EVENTS, SALES_TRANSFER_EVENTS, EXPECTED_CUSTOM_FUNCTIONS, RECORD_CONSENT_DESCRIPTION } from "../src/services/retell-outbound-audit.ts";
import { outboundFunctionContracts, OUTBOUND_FUNCTION_ENUMS } from "../src/services/sales-functions.ts";
import * as SO from "../src/services/sales-outbound.ts";
import * as reg from "../src/services/sales-opt/registry.ts";
import { verifyTarget } from "../src/services/sales-opt/deploy.ts";
import { defaultVoiceConfig, saveVoiceConfig } from "../src/services/voice-settings.ts";
import { signEvidence } from "../src/readiness/ingest.ts";

const OUT = "key_fixture_outbound_audit_0001";
const IN = "key_fixture_inbound_audit_00001";
const BASE = "http://crestmont.test";
const AGENT = "agent_sales01";
const NUMBER = "+15173007764";

/** A stand-in for the Founder's V17: references the nine functions, both built-ins and only per-call variables. */
export const V17 = `CRESTMONT WEBSITE DEVELOPMENT — CIMO OUTBOUND SALES
RETELL NATIVE SINGLE PROMPT — V17
You are Cimo. Lead: {{business_name}} ({{first_name}}), research verified {{research_verified}}, issue {{verified_issue}}.
Ask consent and call record_consent. Call get_outbound_lead_context once. Save details with update_outbound_lead.
Quote only from get_packages_pricing. Create one link with create_checkout_session; confirm with check_payment_status.
Email with send_sales_email; book with schedule_sales_followup; opt-outs with record_do_not_call.
Use transfer_call for a person (warm). End with end_call. Our number is {{agent_number}}.`;

function goodConfig(over: { agent?: Record<string, unknown>; llm?: Record<string, unknown>; tools?: (t: Record<string, unknown>[]) => Record<string, unknown>[]; numbers?: unknown; versions?: unknown } = {}) {
  const c = { ...outboundFunctionContracts(), record_consent: { fields: ["consent"], required: ["consent"] } } as Record<string, { fields: string[]; required: string[] }>;
  const custom = EXPECTED_CUSTOM_FUNCTIONS.map((name) => ({ type: "custom", name,
    description: name === "record_consent" ? RECORD_CONSENT_DESCRIPTION : `Crestmont ${name}`,
    url: name === "record_consent" ? `${BASE}/api/webhooks/retell/functions` : `${BASE}/api/webhooks/retell/outbound/functions?lead_id={{lead_id}}`,
    method: "POST", timeout_ms: 10_000, max_retry: name === "record_do_not_call" ? 2 : 1, args_at_root: false, speak_during_execution: false, enable_typing_sound: false,
    parameters: { type: "object", properties: Object.fromEntries(c[name].fields.map((f) => [f, name === "record_consent" ? { type: "boolean" } : OUTBOUND_FUNCTION_ENUMS[name]?.[f] ? { type: "string", enum: [...OUTBOUND_FUNCTION_ENUMS[name][f]] } : { type: "string" }])), required: c[name].required } }));
  const tools: Record<string, unknown>[] = [...custom, { type: "end_call", name: "end_call" },
    { type: "transfer_call", name: "transfer_call", transfer_destination: { type: "predefined", number: "+16145550199" }, transfer_option: { type: "warm_transfer", private_handoff_option: { type: "prompt", prompt: "brief" } } }];
  return {
    agent: { agent_id: AGENT, version: 3, webhook_url: `${BASE}/api/webhooks/retell`, webhook_events: [...SALES_REQUIRED_EVENTS, ...SALES_TRANSFER_EVENTS], data_storage_setting: "everything_except_pii",
      response_engine: { type: "retell-llm", llm_id: "llm_sales01", version: 2 }, max_call_duration_ms: 3_600_000, voice_id: "retell-Cimo", language: "en-US",
      voicemail_option: { action: { type: "static_text", text: "Hi, this is Cimo, an AI assistant with Crestmont Website Development. Please call us back at {{agent_number}}." } }, ...over.agent },
    llm: { llm_id: "llm_sales01", version: 2, is_published: true, start_speaker: "user", begin_message: "", general_tools: over.tools ? over.tools(tools) : tools, general_prompt: V17, default_dynamic_variables: null, knowledge_base_ids: ["kb1", "kb2"], ...over.llm },
    numbers: over.numbers ?? { items: [{ phone_number: NUMBER, phone_number_type: "retell-twilio", outbound_agents: [{ agent_id: AGENT, weight: 1 }] }], has_more: false },
    versions: over.versions ?? [{ agent_id: AGENT, version: 2, is_published: true, response_engine: { type: "retell-llm", llm_id: "llm_sales01", version: 2 } }, { agent_id: AGENT, version: 3, is_published: false }],
  };
}

function fakeRetell(cfg: ReturnType<typeof goodConfig>, opts: { status?: number } = {}) {
  const calls: { method: string; path: string; auth: string | null }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? "GET", path: u.pathname, auth: new Headers(init.headers).get("authorization") });
    if (opts.status) return new Response(JSON.stringify({ message: "Unauthorized" }), { status: opts.status });
    if (u.pathname === "/v2/list-agents") return new Response(JSON.stringify({ items: [{ agent_id: AGENT, agent_name: "Cimo — Crestmont Sales" }], has_more: false }));
    if (u.pathname === `/get-agent/${AGENT}`) return new Response(JSON.stringify(cfg.agent));
    if (u.pathname === `/get-agent-versions/${AGENT}`) return new Response(JSON.stringify(cfg.versions));
    if (u.pathname === "/get-retell-llm/llm_sales01") return new Response(JSON.stringify(cfg.llm));
    if (u.pathname === "/v2/list-phone-numbers") return new Response(JSON.stringify(cfg.numbers));
    if (u.pathname === "/get-concurrency") return new Response(JSON.stringify({ current_concurrency: 0, concurrency_limit: 20 }));
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function setup(env: Partial<Env> = { RETELL_INBOUND_API_KEY: IN, RETELL_OUTBOUND_API_KEY: OUT }) {
  const t = await createTestApp({ ENVIRONMENT: "staging", ...env } as Partial<Env>);
  const owner = await createStaff(t.db, "owner");
  return { ...t, owner };
}
/** What the Founder does: save the agent + number, register the SIE target and verify it (which adopts V17). */
async function configure(t: Awaited<ReturnType<typeof setup>>, f: typeof fetch) {
  assert.deepEqual(await SO.saveSalesSettings(t.db, t.owner.id, { enabled: false, agentId: AGENT, fromNumber: NUMBER, maxConcurrent: 20, maxPerRun: 20, maxPerDay: 200, maxAttempts: 2, retryAfterHours: 48 }), []);
  await reg.setTarget(t.db, t.owner.id, "staging", AGENT);
  const v = await verifyTarget({ db: t.db, env: t.env, fetch: f }, "staging", t.owner.id);
  assert.ok(v.ok, v.detail);
  return v;
}
const failing = (a: { findings: { check: string; ok: boolean; detail: string }[] }) => Object.fromEntries(a.findings.filter((f) => !f.ok).map((f) => [f.check, f.detail]));

test("[VOICE-005] [SEC-001] the Founder's configuration passes every check; only the outbound key is used and nothing is written", async () => {
  const t = await setup();
  const r = fakeRetell(goodConfig());
  const v = await configure(t, r.f);
  assert.match(v.detail, /Adopted the live prompt as v1 \(Founder prompt, kept verbatim\)/);
  const a = await auditOutboundRetell({ db: t.db, env: t.env, fetch: r.f, baseUrl: BASE, expectedCallerNumber: NUMBER });
  assert.deepEqual(failing(a), {}, "no failing checks");
  assert.equal(a.status, "ok");
  const byCheck = Object.fromEntries(a.findings.map((f) => [f.check, f]));
  assert.equal(byCheck["Default Dynamic Variables"].state, "PASS");
  assert.match(byCheck["prompt identity"].detail, /V17 marker present/);
  assert.match(byCheck["SIE current version = live prompt"].detail, /Founder prompt, adopted verbatim/);
  assert.match(byCheck["Warm Transfer"].detail, /warm_transfer; destination number …0199/);
  assert.match(byCheck["published agent version"].detail, /version 2 is published/);
  assert.match(byCheck["caller number …7764 in the outbound workspace"].detail, /present/);
  assert.match(byCheck["concurrency"].detail, /Retell limit 20/);
  assert.ok(r.calls.every((c) => c.auth === `Bearer ${OUT}`), "only the outbound key");
  assert.ok(r.calls.every((c) => c.method === "GET" || c.path === "/v2/list-agents"), "read-only: no create/update request");
  const text = JSON.stringify(a);
  assert.ok(!text.includes(OUT) && !text.includes(IN), "no key in the output");
  assert.ok(!text.includes("5173007764") && !text.includes("Please call us back"), "numbers by last 4 only; no voicemail or prompt text");
});

test("[VOICE-005] the audit names each deviation from the Founder's decisions", async () => {
  const t = await setup();
  await configure(t, fakeRetell(goodConfig()).f);
  const cfg = goodConfig({
    agent: { webhook_url: "https://elsewhere.test/hook", webhook_events: ["call_ended"], max_call_duration_ms: 900_000, voicemail_option: { action: { type: "hangup" } } },
    llm: { general_prompt: `${V17}\nAlso call book_consultation. Mention {{city}}.`, default_dynamic_variables: { business_name: "" } },
    tools: (ts) => ts.filter((x) => x.name !== "record_do_not_call" && x.type !== "end_call").map((x) =>
      x.name === "create_checkout_session" ? { ...x, args_at_root: true, url: `${BASE}/api/webhooks/retell/functions` }
      : x.name === "record_consent" ? { ...x, url: `${BASE}/api/webhooks/retell/outbound/functions`, speak_during_execution: true, parameters: { type: "object", properties: { consent: { type: "string" } }, required: ["consent"] } }
      : x.name === "send_sales_email" ? { ...x, parameters: { type: "object", properties: { email_type: { type: "string", enum: ["package_information", "discount_offer"] }, email: { type: "string" } }, required: ["email_type", "email"] } }
      : x.type === "transfer_call" ? { ...x, transfer_option: { type: "cold_transfer" } } : x),
  });
  const a = await auditOutboundRetell({ db: t.db, env: t.env, fetch: fakeRetell(cfg).f, baseUrl: BASE });
  const bad = failing(a);
  assert.equal(a.status, "issues");
  assert.match(bad["agent webhook URL"], /agent webhook/);
  assert.match(bad["webhook events"], /call_started, call_analyzed/);
  assert.match(bad["maximum call duration"], /60 minutes/);
  assert.match(bad["voicemail"], /hang up; the Founder decided to leave an approved voicemail/);
  assert.match(bad["function record_do_not_call"], /not configured/);
  assert.match(bad["function create_checkout_session"], /args only/);
  assert.match(bad["function record_consent"], /consent must be type boolean/);
  assert.match(bad["record_consent settings"], /speak during execution true/);
  assert.match(bad["function send_sales_email"], /email_type offers values the backend refuses: discount_offer/);
  assert.match(bad["End Call tool"], /end_call/);
  assert.match(bad["Warm Transfer"], /type cold_transfer/);
  assert.match(bad["Default Dynamic Variables"], /Founder decision is NONE; found business_name/);
  assert.match(bad["prompt variables supplied per call"], /\{\{city\}\}/);
  assert.match(bad["prompt names no missing function"], /book_consultation/);
  assert.match(bad["SIE current version = live prompt"], /Adopt live prompt/);
});

test("[VOICE-005] missing key, identical keys, a rejected key, no published version and the old phone-list bug are reported", async () => {
  const none = await setup({ RETELL_INBOUND_API_KEY: IN });
  assert.equal((await auditOutboundRetell({ db: none.db, env: none.env, fetch: fakeRetell(goodConfig()).f, baseUrl: BASE })).status, "not_configured");
  const same = await setup({ RETELL_INBOUND_API_KEY: OUT, RETELL_OUTBOUND_API_KEY: OUT });
  assert.equal((await auditOutboundRetell({ db: same.db, env: same.env, fetch: fakeRetell(goodConfig()).f, baseUrl: BASE })).status, "failed");
  const rej = await setup();
  const r = await auditOutboundRetell({ db: rej.db, env: rej.env, fetch: fakeRetell(goodConfig(), { status: 401 }).f, baseUrl: BASE });
  assert.match(r.findings.at(-1)!.detail, /key rejected by Retell/);
  // Retell's /v2/list-phone-numbers returns { items }: the number is found (the first audit read the envelope as empty).
  const t = await setup();
  const a = await auditOutboundRetell({ db: t.db, env: t.env, fetch: fakeRetell(goodConfig({ versions: [{ agent_id: AGENT, version: 3, is_published: false }] })).f, baseUrl: BASE, expectedCallerNumber: NUMBER });
  const bad = failing(a);
  assert.match(bad["published agent version"], /no published version/);
  assert.match(bad["caller number recorded"], /save …7764/);
  assert.ok(a.findings.some((f) => f.check === "caller number …7764 in the outbound workspace" && f.ok));
});

test("[VOICE-005] prompt analysis: per-call variables and system variables need no default; unknown tools are named; text is never returned", () => {
  const a = analysePrompt(V17, [...EXPECTED_CUSTOM_FUNCTIONS]);
  assert.deepEqual(a.unsupplied, []);
  assert.deepEqual(a.missingTools, []);
  assert.deepEqual(a.unknownTools, []);
  assert.equal(a.v17, true);
  assert.equal(a.title, "CRESTMONT WEBSITE DEVELOPMENT — CIMO OUTBOUND SALES");
  const b = analysePrompt("Call lookup_customer, use `crm_customer_lookup`. Hello {{current_time_America/New_York}} {{nickname}}", ["get_outbound_lead_context"]);
  assert.deepEqual(b.unknownTools.sort(), ["crm_customer_lookup", "lookup_customer"]);
  assert.deepEqual(b.unsupplied, ["nickname"]);
  assert.deepEqual(b.missingTools, ["get_outbound_lead_context"]);
});

test("[VOICE-003] [SEC-001] prompt isolation both ways: the SIE cannot target a receptionist agent and the receptionist agents cannot be sales agents", async () => {
  const t = await setup();
  const c = defaultVoiceConfig();
  c.inbound.agent_id = "agent_rcpt01";
  await saveVoiceConfig(t.db, t.owner.id, c);
  await assert.rejects(reg.setTarget(t.db, t.owner.id, "staging", "agent_rcpt01"), /receptionist/);
  assert.match((await SO.saveSalesSettings(t.db, t.owner.id, { enabled: false, agentId: "agent_rcpt01", fromNumber: NUMBER, maxConcurrent: 1, maxPerRun: 1, maxPerDay: 1, maxAttempts: 1, retryAfterHours: 48 })).join(" "), /separate Retell agent/, "refused even while switched off");
  // inbound → outbound (receptionist prompt sync refusing a sales agent id) is tested in tests/voice-prompt-sync-isolation.test.ts.
});

test("[SEC-001] POST /api/sales-outbound/retell-audit: scheduler-signed, rate-limited, audited, read-only, takes the expected number", async () => {
  const post = (t: Awaited<ReturnType<typeof setup>>, body: string, sig: string | null) =>
    t.client().request("POST", "/api/sales-outbound/retell-audit", { body, headers: { "content-type": "application/json", ...(sig ? { "x-crestmont-scheduler-signature": sig } : {}) } });
  const off = await setup();
  assert.equal((await post(off, "{}", await signEvidence("k", "{}"))).status, 503);
  const r = fakeRetell(goodConfig());
  const t = await setup({ RETELL_INBOUND_API_KEY: IN, RETELL_OUTBOUND_API_KEY: OUT, SCHEDULER_TRIGGER_SECRET: "sched-key" } as never);
  t.env.overrides = { ...t.env.overrides, fetch: r.f };
  assert.equal((await post(t, "{}", null)).status, 401);
  assert.equal((await post(t, "{}", await signEvidence("wrong", "{}"))).status, 401);
  const body = JSON.stringify({ expected_caller_number: NUMBER });
  const ok = await post(t, body, await signEvidence("sched-key", body));
  assert.equal(ok.status, 200);
  const res = await ok.json() as { key: string; agentId: string; findings: { check: string; ok: boolean }[] };
  assert.equal(res.key, "outbound");
  assert.equal(res.agentId, AGENT, "discovered by webhook URL");
  assert.ok(res.findings.some((f) => f.check === "caller number …7764 in the outbound workspace" && f.ok));
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'sales_outbound.retell_audit'`).first());
  await post(t, "{}", await signEvidence("sched-key", "{}"));
  await post(t, "{}", await signEvidence("sched-key", "{}"));
  assert.equal((await post(t, "{}", await signEvidence("sched-key", "{}"))).status, 429);
});
