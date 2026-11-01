// Read-only audit of the receptionist's live Retell configuration (src/services/retell-inbound-audit.ts).
// FIXTURES ONLY: a fake Retell API stands in for api.retellai.com; nothing here proves a live Retell configuration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { auditInboundRetell, RECEPTIONIST_TOOLS, REQUIRED_EVENTS } from "../src/services/retell-inbound-audit.ts";
import { functionContracts, createAgentConfig, activateAgentConfig, INBOUND_MASTER_INSTRUCTIONS } from "../src/services/voice.ts";
import { defaultVoiceConfig, saveVoiceConfig } from "../src/services/voice-settings.ts";
import { sign } from "../scripts/trigger-scheduler.ts";

const IN = "key_fixture_inbound_audit_0001";
const BASE = "http://crestmont.test";
/** Stand-in for the Founder's Retell-native V4 prompt: names all 17 functions, uses only per-call/system variables. */
const V4 = `You are Cimo, Crestmont Website Development's AI receptionist, available 24/7. Human staff keep their own hours.
Ask for consent and call record_consent. New enquiries: crm_customer_lookup, then crm_upsert_lead. Prices: get_packages_pricing.
Buying: create_checkout_session, then check_payment_status. Consultations: schedule_consultation, lookup_consultation,
reschedule_consultation, cancel_consultation. Support: create_support_ticket. Email: send_customer_email. A person:
check_transfer_availability then the warm transfer, else request_callback; sensitive issues: escalate. Hours: get_business_hours.
Opt-out: record_opt_out. The caller is {{user_number}}.`;

function goodConfig(over: { agent?: Record<string, unknown>; llm?: Record<string, unknown>; tools?: (t: Record<string, unknown>[]) => Record<string, unknown>[]; numbers?: unknown[] } = {}) {
  const c = functionContracts();
  const custom = RECEPTIONIST_TOOLS.map((name) => ({ type: "custom", name, description: `Fixture description for ${name}.`, url: `${BASE}/api/webhooks/retell/functions`, method: "POST", timeout_ms: 10_000, max_retry: 1, args_at_root: false,
    parameters: { type: "object", properties: Object.fromEntries(c[name].fields.map((f) => [f, { type: "string" }])), required: c[name].required } }));
  const tools: Record<string, unknown>[] = [...custom, { type: "end_call", name: "end_call" }, { type: "transfer_call", name: "transfer_call", transfer_destination: { type: "predefined", number: "+15550104242" }, transfer_option: { type: "warm_transfer" } }];
  return {
    agent: { agent_id: "agent_rcpt01", webhook_url: `${BASE}/api/webhooks/retell`, webhook_events: [...REQUIRED_EVENTS], data_storage_setting: "basic_attributes_only", response_engine: { type: "retell-llm", llm_id: "llm_rcpt01" }, max_call_duration_ms: 3_600_000, ...over.agent },
    llm: { llm_id: "llm_rcpt01", start_speaker: "agent", begin_message: "Hello, you've reached Crestmont Website Development. I'm an AI assistant. How can I help you today?",
      general_tools: over.tools ? over.tools(tools) : tools, general_prompt: V4, ...over.llm },
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
    if (u.pathname === "/v2/list-phone-numbers") return new Response(JSON.stringify({ items: cfg.numbers, has_more: false }));
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function setup(env: Partial<Env> = { RETELL_INBOUND_API_KEY: IN, RETELL_OUTBOUND_API_KEY: "key_fixture_outbound_audit_001" }, recordAgent = true, activateRepoPrompt = false) {
  const t = await createTestApp(env);
  const owner = await createStaff(t.db, "owner");
  const c = defaultVoiceConfig();
  if (recordAgent) c.inbound.agent_id = "agent_rcpt01";
  c.inbound.numbers = ["+15550109999"];
  c.timezone = "America/Detroit";
  for (const d of ["mon", "tue", "wed", "thu", "fri"] as const) c.hours[d] = [{ open: "09:00", close: "17:00" }];
  c.transfer = { enabled: true, number: "+15550104242" };
  await saveVoiceConfig(t.db, owner.id, c);
  if (activateRepoPrompt) {
    const v = await createAgentConfig(t.db, owner.id, INBOUND_MASTER_INSTRUCTIONS, "master");
    await activateAgentConfig(t.db, owner.id, v.version);
  }
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
  const t = await setup(undefined, true, true);
  const bad = goodConfig({
    agent: { webhook_url: "https://example.com/hook", webhook_events: ["call_started", "call_ended"], max_call_duration_ms: 7_200_000 },
    llm: { general_prompt: V4.replace("record_opt_out", "opt-out tool") + " Also use route_support and {{caller_tier}}." },
    tools: (ts) => ts.filter((x) => x.name !== "escalate").map((x) => x.name === "crm_upsert_lead" ? { ...x, args_at_root: true } : x.name === "create_checkout_session" ? { ...x, parameters: { type: "object", properties: { package: {}, name: {} }, required: ["package"] } } : x.type === "transfer_call" ? { ...x, transfer_option: { type: "cold_transfer" }, transfer_destination: { type: "predefined", number: "+15551234567" } } : x),
    numbers: [{ phone_number: "+15550109999", inbound_agents: [{ agent_id: "agent_rcpt01", weight: 1 }], inbound_webhook_url: null }],
  });
  const a = await auditInboundRetell({ db: t.db, env: t.env, fetch: fakeRetell(bad).f, baseUrl: BASE });
  const fail = (check: string) => a.findings.find((f) => f.check === check && !f.ok);
  assert.equal(a.status, "issues");
  assert.match(fail("agent webhook URL")!.detail, /example\.com/);
  assert.match(fail("webhook events")!.detail, /call_analyzed.*transfer_ended/);
  assert.match(fail("max call duration")!.detail, /120 minutes/);
  assert.match(fail("function escalate")!.detail, /not configured/);
  assert.match(fail("function crm_upsert_lead")!.detail, /args only/);
  assert.match(fail("function create_checkout_session")!.detail, /missing from the schema: email/);
  assert.match(fail("Transfer Call transfer_call: warm")!.detail, /cold_transfer/);
  assert.match(fail("Transfer Call transfer_call: destination")!.detail, /…4567 differs from the approved number …4242/);
  assert.match(fail("prompt names all 17 functions")!.detail, /record_opt_out/);
  assert.match(fail("prompt names functions not on the agent")!.detail, /route_support/);
  assert.match(fail("prompt variables")!.detail, /caller_tier/);
  assert.match(fail("platform prompt version")!.detail, /differs from the live prompt/);
  assert.match(fail("number …9999 inbound webhook")!.detail, /\(none\)/);
  assert.ok(!JSON.stringify(a).includes("+15551234567"), "transfer numbers are masked (public CI output)");
});

test("[VOICE-005] Founder decisions are not failures: zero default variables, 60-minute calls, any data-storage setting (legal review)", async () => {
  const t = await setup();
  const a = await auditInboundRetell({ db: t.db, env: t.env, fetch: fakeRetell(goodConfig({ agent: { data_storage_setting: "everything" } })).f, baseUrl: BASE });
  assert.deepEqual(a.findings.filter((f) => !f.ok), []);
  assert.equal(a.findings.find((f) => f.check === "default dynamic variables")!.status, "info");
  assert.equal(a.findings.find((f) => f.check === "data storage (legal review)")!.status, "info");
  assert.equal(a.findings.find((f) => f.check === "max call duration")!.status, "pass");
  assert.equal(a.findings.find((f) => f.check === "platform prompt version")!.status, "info", "no active version: nothing will overwrite the live prompt");
});

test("[VOICE-005] a transfer destination that is the receptionist's own number is reported as a loop; {{transfer_number}} passes as server-gated", async () => {
  const t = await setup();
  const loop = goodConfig({ tools: (ts) => ts.map((x) => x.type === "transfer_call" ? { ...x, transfer_destination: { type: "predefined", number: "+15550109999" } } : x) });
  const a = await auditInboundRetell({ db: t.db, env: t.env, fetch: fakeRetell(loop).f, baseUrl: BASE });
  assert.match(a.findings.find((f) => f.check === "Transfer Call transfer_call: destination")!.detail, /loop back/);
  const gated = goodConfig({ tools: (ts) => ts.map((x) => x.type === "transfer_call" ? { ...x, transfer_destination: { type: "predefined", number: "{{transfer_number}}" } } : x) });
  const b = await auditInboundRetell({ db: t.db, env: t.env, fetch: fakeRetell(gated).f, baseUrl: BASE });
  assert.equal(b.findings.find((f) => f.check === "Transfer Call transfer_call: destination")!.status, "pass");
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

test("[VOICE-005] the deploy prints all audit findings in at most four annotations (GitHub keeps 10 per level per step)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("scripts/trigger-scheduler.ts", "utf8");
  const fn = src.slice(src.indexOf("async function retellAudit"), src.indexOf("if (process.argv[1]"));
  assert.doesNotMatch(fn, /for \(const f of a\.findings\) console\.log/, "no per-finding annotations");
  const ok = fn.slice(fn.indexOf("const a = JSON.parse"));
  assert.equal((ok.match(/console\.log\(`::(notice|warning)/g) ?? []).length, 4, "success path: summary + TODO + OK + INFO lists");
});
