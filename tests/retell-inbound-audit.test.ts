// Read-only audit of the receptionist's live Retell configuration (src/services/retell-inbound-audit.ts).
// FIXTURES ONLY: a fake Retell API stands in for api.retellai.com; nothing here proves a live Retell configuration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { auditInboundRetell, RECEPTIONIST_TOOLS, REQUIRED_EVENTS } from "../src/services/retell-inbound-audit.ts";
import { functionContracts, createAgentConfig, activateAgentConfig, composePrompt, INBOUND_MASTER_INSTRUCTIONS } from "../src/services/voice.ts";
import { defaultVoiceConfig, saveVoiceConfig } from "../src/services/voice-settings.ts";
import { sign } from "../scripts/trigger-scheduler.ts";

const IN = "key_fixture_inbound_audit_0001";
const BASE = "http://crestmont.test";

function goodConfig(over: { agent?: Record<string, unknown>; llm?: Record<string, unknown>; tools?: (t: Record<string, unknown>[]) => Record<string, unknown>[]; numbers?: unknown[] } = {}) {
  const c = functionContracts();
  const custom = RECEPTIONIST_TOOLS.map((name) => ({ type: "custom", name, url: `${BASE}/api/webhooks/retell/functions`, method: "POST", timeout_ms: 10_000, max_retry: 1, args_at_root: false,
    parameters: { type: "object", properties: Object.fromEntries(c[name].fields.map((f) => [f, { type: "string" }])), required: c[name].required } }));
  const tools: Record<string, unknown>[] = [...custom, { type: "end_call", name: "end_call" }, { type: "transfer_call", name: "transfer_call", transfer_destination: { type: "predefined", number: "{{transfer_number}}" }, transfer_option: { type: "cold_transfer" } }];
  return {
    agent: { agent_id: "agent_rcpt01", webhook_url: `${BASE}/api/webhooks/retell`, webhook_events: [...REQUIRED_EVENTS], data_storage_setting: "basic_attributes_only", response_engine: { type: "retell-llm", llm_id: "llm_rcpt01" }, max_call_duration_ms: 900_000, ...over.agent },
    llm: { llm_id: "llm_rcpt01", start_speaker: "agent", begin_message: "Hello, you've reached Crestmont Website Development. I'm an AI assistant. How can I help you today?",
      general_tools: over.tools ? over.tools(tools) : tools, general_prompt: composePrompt(INBOUND_MASTER_INSTRUCTIONS),
      default_dynamic_variables: { receptionist_mode: "voicemail", transfer_available: "false", transfer_number: "", scheduling_available: "false", business_open_now: "false", business_hours: "not yet published" }, ...over.llm },
    numbers: over.numbers ?? [{ phone_number: "+15550109999", inbound_agents: [{ agent_id: "agent_rcpt01", weight: 1 }], inbound_webhook_url: `${BASE}/api/webhooks/retell/inbound` }],
  };
}

function fakeRetell(cfg: ReturnType<typeof goodConfig>, opts: { status?: number } = {}) {
  const calls: { method: string; path: string; auth: string | null }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? "GET", path: u.pathname, auth: new Headers(init.headers).get("authorization") });
    if (opts.status) return new Response(JSON.stringify({ status: "error", message: "Unauthorized" }), { status: opts.status });
    if (u.pathname === "/v2/list-agents") return new Response(JSON.stringify({ items: [{ agent_id: "agent_rcpt01", agent_name: "Crestmont Receptionist" }], has_more: false }));
    if (u.pathname === "/get-agent/agent_rcpt01") return new Response(JSON.stringify(cfg.agent));
    if (u.pathname === "/get-retell-llm/llm_rcpt01") return new Response(JSON.stringify(cfg.llm));
    if (u.pathname === "/v2/list-phone-numbers") return new Response(JSON.stringify(cfg.numbers));
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function setup(env: Partial<Env> = { RETELL_INBOUND_API_KEY: IN, RETELL_OUTBOUND_API_KEY: "key_fixture_outbound_audit_001" }, recordAgent = true) {
  const t = await createTestApp(env);
  const owner = await createStaff(t.db, "owner");
  const c = defaultVoiceConfig();
  if (recordAgent) c.inbound.agent_id = "agent_rcpt01";
  c.inbound.numbers = ["+15550109999"];
  await saveVoiceConfig(t.db, owner.id, c);
  const v = await createAgentConfig(t.db, owner.id, INBOUND_MASTER_INSTRUCTIONS, "master");
  await activateAgentConfig(t.db, owner.id, v.version);
  return t;
}

test("[VOICE-005] [VOICE-003] a correctly configured receptionist passes every check; only the inbound key is used and nothing is written", async () => {
  const t = await setup();
  const r = fakeRetell(goodConfig());
  const a = await auditInboundRetell({ db: t.db, env: t.env, fetch: r.f, baseUrl: BASE });
  assert.deepEqual(a.findings.filter((f) => !f.ok), [], "no failing checks");
  assert.equal(a.status, "ok");
  assert.equal(a.agentId, "agent_rcpt01");
  assert.equal(a.findings.filter((f) => f.check.startsWith("function ")).length, 17);
  assert.ok(r.calls.every((c) => c.auth === `Bearer ${IN}`), "inbound workspace key only");
  assert.ok(r.calls.every((c) => c.method === "GET" || c.path === "/v2/list-agents"), "read-only: no PATCH, no call creation");
  assert.ok(!JSON.stringify(a).includes(IN), "the key is never in the output");
  assert.ok(!JSON.stringify(a).includes("+15550109999"), "phone numbers are shown by last 4 digits only");
});

test("[VOICE-005] the audit reports each misconfiguration precisely", async () => {
  const t = await setup();
  const bad = goodConfig({
    agent: { webhook_url: "https://example.com/hook", webhook_events: ["call_started", "call_ended"], data_storage_setting: "everything" },
    llm: { general_prompt: "edited in the dashboard", default_dynamic_variables: {} },
    tools: (ts) => ts.filter((x) => x.name !== "escalate").map((x) => x.name === "crm_upsert_lead" ? { ...x, args_at_root: true } : x.name === "create_checkout_session" ? { ...x, parameters: { type: "object", properties: { package: {}, name: {} }, required: ["package"] } } : x.type === "transfer_call" ? { ...x, transfer_destination: { type: "predefined", number: "+15551234567" } } : x),
    numbers: [{ phone_number: "+15550109999", inbound_agents: [{ agent_id: "agent_rcpt01" }], inbound_webhook_url: null }],
  });
  const a = await auditInboundRetell({ db: t.db, env: t.env, fetch: fakeRetell(bad).f, baseUrl: BASE });
  const fail = (check: string) => a.findings.find((f) => f.check === check && !f.ok);
  assert.equal(a.status, "issues");
  assert.match(fail("agent webhook URL")!.detail, /example\.com/);
  assert.match(fail("webhook events")!.detail, /call_analyzed.*transfer_ended/);
  assert.match(fail("data storage")!.detail, /everything/);
  assert.match(fail("function escalate")!.detail, /not configured/);
  assert.match(fail("function crm_upsert_lead")!.detail, /args only/);
  assert.match(fail("function create_checkout_session")!.detail, /missing from the schema: email/);
  assert.ok(fail("Transfer Call tool"));
  assert.ok(fail("default dynamic variables"));
  assert.match(fail("prompt matches the active /staff/voice version")!.detail, /differs/);
  assert.match(fail("number …9999 inbound webhook")!.detail, /\(none\)/);
});

test("[VOICE-005] [SEC-002] without the inbound key nothing is sent; a key Retell rejects is reported", async () => {
  const none = await setup({ RETELL_OUTBOUND_API_KEY: "key_fixture_outbound_audit_001" });
  const r = fakeRetell(goodConfig());
  const a = await auditInboundRetell({ db: none.db, env: none.env, fetch: r.f, baseUrl: BASE });
  assert.equal(a.status, "not_configured");
  assert.equal(r.calls.length, 0, "never falls back to the outbound key");
  const t = await setup();
  const rejected = await auditInboundRetell({ db: t.db, env: t.env, fetch: fakeRetell(goodConfig(), { status: 401 }).f, baseUrl: BASE });
  assert.equal(rejected.status, "failed");
  assert.match(rejected.findings[0].detail, /key rejected by Retell/);
});

test("[VOICE-005] without a recorded agent id the audit finds the agent whose webhook points here and says the id is missing", async () => {
  const t = await setup(undefined, false);
  const a = await auditInboundRetell({ db: t.db, env: t.env, fetch: fakeRetell(goodConfig()).f, baseUrl: BASE });
  assert.equal(a.agentId, "agent_rcpt01");
  assert.match(a.findings.find((f) => f.check === "receptionist agent id recorded")!.detail, /agent_rcpt01/);
});

test("[VOICE-005] [SEC-002] POST /api/voice/retell-audit is a signed machine endpoint", async () => {
  const t = await setup({ RETELL_INBOUND_API_KEY: IN, SCHEDULER_TRIGGER_SECRET: "sched-fixture-secret" } as Partial<Env>);
  t.env.overrides = { ...t.env.overrides, fetch: fakeRetell(goodConfig()).f };
  const c = t.client();
  const body = JSON.stringify({ audit: "retell-inbound" });
  assert.equal((await c.request("POST", "/api/voice/retell-audit", { body })).status, 401, "unsigned");
  assert.equal((await c.request("POST", "/api/voice/retell-audit", { body, headers: { "x-crestmont-scheduler-signature": sign("wrong-secret", body) } })).status, 401, "wrong key");
  const ok = await c.request("POST", "/api/voice/retell-audit", { body, headers: { "x-crestmont-scheduler-signature": sign("sched-fixture-secret", body) } });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { status: string }).status, "ok");
  assert.equal((await t.db.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'voice.retell_audit'`).first<{ n: number }>())!.n, 1);
});
