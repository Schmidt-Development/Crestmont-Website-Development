// Read-only audit of the outbound SALES agent's live Retell configuration (src/services/retell-outbound-audit.ts), plus the
// bidirectional prompt-overwrite isolation between the receptionist and the sales agent.
// FIXTURES ONLY: a fake Retell API stands in for api.retellai.com; nothing here proves a live Retell configuration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { auditOutboundRetell, SALES_REQUIRED_EVENTS, SALES_TRANSFER_EVENTS, SALES_DEFAULT_VARIABLES } from "../src/services/retell-outbound-audit.ts";
import { SALES_FUNCTIONS, outboundFunctionContracts } from "../src/services/sales-functions.ts";
import { composeSalesPrompt, baselineSalesInstructions } from "../src/domain/sales-opt/policy.ts";
import * as SO from "../src/services/sales-outbound.ts";
import * as reg from "../src/services/sales-opt/registry.ts";
import { defaultVoiceConfig, saveVoiceConfig } from "../src/services/voice-settings.ts";
import { signEvidence } from "../src/readiness/ingest.ts";

const OUT = "key_fixture_outbound_audit_0001";
const IN = "key_fixture_inbound_audit_00001";
const BASE = "http://crestmont.test";
const AGENT = "agent_sales01";

function goodConfig(over: { agent?: Record<string, unknown>; llm?: Record<string, unknown>; tools?: (t: Record<string, unknown>[]) => Record<string, unknown>[] } = {}) {
  const c = { ...outboundFunctionContracts(), record_consent: { fields: ["consent"], required: ["consent"] } } as Record<string, { fields: string[]; required: string[] }>;
  const custom = [...SALES_FUNCTIONS, "record_consent"].map((name) => ({ type: "custom", name,
    url: name === "record_consent" ? `${BASE}/api/webhooks/retell/functions` : `${BASE}/api/webhooks/retell/outbound/functions?lead_id={{lead_id}}`,
    method: "POST", timeout_ms: 10_000, max_retry: name === "record_do_not_call" ? 2 : 1, args_at_root: false,
    parameters: { type: "object", properties: Object.fromEntries(c[name].fields.map((f) => [f, { type: "string" }])), required: c[name].required } }));
  const tools: Record<string, unknown>[] = [...custom, { type: "end_call", name: "end_call" }, { type: "transfer_call", name: "transfer_call", transfer_option: { type: "warm_transfer" } }];
  return {
    agent: { agent_id: AGENT, webhook_url: `${BASE}/api/webhooks/retell`, webhook_events: [...SALES_REQUIRED_EVENTS, ...SALES_TRANSFER_EVENTS], data_storage_setting: "basic_attributes_only", response_engine: { type: "retell-llm", llm_id: "llm_sales01" }, ...over.agent },
    llm: { llm_id: "llm_sales01", start_speaker: "user", general_tools: over.tools ? over.tools(tools) : tools, general_prompt: composeSalesPrompt(baselineSalesInstructions()),
      default_dynamic_variables: Object.fromEntries(SALES_DEFAULT_VARIABLES.map((k) => [k, k === "website_status" ? "unknown" : k === "research_verified" ? "false" : ""])), ...over.llm },
    numbers: [{ phone_number: "+16145550100", outbound_agents: [{ agent_id: AGENT, weight: 1 }] }],
  };
}

function fakeRetell(cfg: ReturnType<typeof goodConfig>, opts: { status?: number } = {}) {
  const calls: { method: string; path: string; auth: string | null }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? "GET", path: u.pathname, auth: new Headers(init.headers).get("authorization") });
    if (opts.status) return new Response(JSON.stringify({ message: "Unauthorized" }), { status: opts.status });
    if (u.pathname === "/v2/list-agents") return new Response(JSON.stringify([{ agent_id: AGENT, agent_name: "Cimo — Crestmont Sales" }]));
    if (u.pathname === `/get-agent/${AGENT}`) return new Response(JSON.stringify(cfg.agent));
    if (u.pathname === "/get-retell-llm/llm_sales01") return new Response(JSON.stringify(cfg.llm));
    if (u.pathname === "/v2/list-phone-numbers") return new Response(JSON.stringify(cfg.numbers));
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function setup(env: Partial<Env> = { RETELL_INBOUND_API_KEY: IN, RETELL_OUTBOUND_API_KEY: OUT }) {
  const t = await createTestApp(env);
  const owner = await createStaff(t.db, "owner");
  return { ...t, owner };
}
async function configure(t: Awaited<ReturnType<typeof setup>>) {
  assert.deepEqual(await SO.saveSalesSettings(t.db, t.owner.id, { enabled: false, agentId: AGENT, fromNumber: "+16145550100", maxConcurrent: 1, maxPerRun: 1, maxPerDay: 1, maxAttempts: 2, retryAfterHours: 48 }), []);
  await reg.setTarget(t.db, t.owner.id, "staging", AGENT);
  await t.db.prepare(`UPDATE so_targets SET verified_at = ? WHERE stage = 'staging'`).bind(new Date().toISOString()).run();
}

test("[VOICE-005] [SEC-001] a correctly configured sales agent passes every check; only the outbound key is used and nothing is written", async () => {
  const t = await setup();
  await configure(t);
  const r = fakeRetell(goodConfig());
  const a = await auditOutboundRetell({ db: t.db, env: { ...t.env, ENVIRONMENT: "staging" }, fetch: r.f, baseUrl: BASE });
  assert.deepEqual(a.findings.filter((f) => !f.ok), [], "no failing checks");
  assert.equal(a.status, "ok");
  assert.equal(a.agentId, AGENT);
  assert.ok(r.calls.every((c) => c.auth === `Bearer ${OUT}`), "only the outbound key");
  assert.ok(r.calls.every((c) => c.method === "GET" || c.path === "/v2/list-agents"), "read-only: no create/update request");
  assert.ok(!r.calls.some((c) => /create-phone-call|update-/.test(c.path)), "never dials or updates");
  assert.ok(!JSON.stringify(a).includes(OUT) && !JSON.stringify(a).includes(IN), "no key in the output");
  assert.ok(!JSON.stringify(a).includes("6145550100"), "numbers shown by last 4 only");
});

test("[VOICE-005] the audit names each misconfiguration exactly", async () => {
  const t = await setup();
  await configure(t);
  const cfg = goodConfig({
    agent: { webhook_url: "https://elsewhere.test/hook", webhook_events: ["call_ended"] },
    llm: { general_prompt: "pasted something else", default_dynamic_variables: { lead_id: "lead_x", research_verified: "true" } },
    tools: (ts) => ts.filter((x) => x.name !== "record_do_not_call" && x.type !== "end_call").map((x) => x.name === "create_checkout_session" ? { ...x, args_at_root: true, url: `${BASE}/api/webhooks/retell/functions` } : x.name === "record_consent" ? { ...x, url: `${BASE}/api/webhooks/retell/outbound/functions` } : x),
  });
  const a = await auditOutboundRetell({ db: t.db, env: { ...t.env, ENVIRONMENT: "staging" }, fetch: fakeRetell(cfg).f, baseUrl: BASE });
  const bad = Object.fromEntries(a.findings.filter((f) => !f.ok).map((f) => [f.check, f.detail]));
  assert.equal(a.status, "issues");
  assert.match(bad["agent webhook URL"], /elsewhere/);
  assert.match(bad["webhook events"], /call_started, call_analyzed/);
  assert.match(bad["transfer webhook events"], /transfer_started/);
  assert.match(bad["function record_do_not_call"], /not configured/);
  assert.match(bad["function create_checkout_session"], /args only.*|url/);
  assert.match(bad["function create_checkout_session"], /args only/);
  assert.match(bad["function record_consent"], /expected http:\/\/crestmont\.test\/api\/webhooks\/retell\/functions/);
  assert.match(bad["End Call tool"], /missing/);
  assert.match(bad["default dynamic variables"], /lead_id has a default/);
  assert.match(bad["default dynamic variables"], /research_verified/);
  assert.match(bad["prompt matches"], /differs from the master prompt/);
});

test("[VOICE-005] missing key, identical keys and a rejected key are reported, never thrown", async () => {
  const none = await setup({ RETELL_INBOUND_API_KEY: IN });
  assert.equal((await auditOutboundRetell({ db: none.db, env: none.env, fetch: fakeRetell(goodConfig()).f, baseUrl: BASE })).status, "not_configured");
  const same = await setup({ RETELL_INBOUND_API_KEY: OUT, RETELL_OUTBOUND_API_KEY: OUT });
  const s = await auditOutboundRetell({ db: same.db, env: same.env, fetch: fakeRetell(goodConfig()).f, baseUrl: BASE });
  assert.equal(s.status, "failed");
  assert.match(s.findings.find((f) => f.check === "workspace keys distinct")!.detail, /identical/);
  const rej = await setup();
  const r = await auditOutboundRetell({ db: rej.db, env: rej.env, fetch: fakeRetell(goodConfig(), { status: 401 }).f, baseUrl: BASE });
  assert.equal(r.status, "failed");
  assert.match(r.findings.at(-1)!.detail, /key rejected by Retell/);
});

test("[VOICE-005] without a recorded agent the audit discovers it by webhook and asks for it to be saved; SIE target required", async () => {
  const t = await setup();
  const a = await auditOutboundRetell({ db: t.db, env: { ...t.env, ENVIRONMENT: "staging" }, fetch: fakeRetell(goodConfig()).f, baseUrl: BASE });
  assert.equal(a.agentId, AGENT);
  const bad = Object.fromEntries(a.findings.filter((f) => !f.ok).map((f) => [f.check, f.detail]));
  assert.match(bad["sales agent id recorded"], /agents whose webhook points here: agent_sales01/);
  assert.match(bad["SIE staging target registered and verified"], /register the sales agent/);
  assert.match(bad["caller number"], /no caller number/);
});

test("[VOICE-003] [SEC-001] prompt isolation both ways: the SIE cannot target a receptionist agent and the receptionist agents cannot be sales agents", async () => {
  const t = await setup();
  const c = defaultVoiceConfig();
  c.inbound.agent_id = "agent_rcpt01";
  await saveVoiceConfig(t.db, t.owner.id, c);
  // outbound → inbound: neither the SIE (which writes prompts to Retell) nor the dialler settings accept the receptionist.
  await assert.rejects(reg.setTarget(t.db, t.owner.id, "staging", "agent_rcpt01"), /receptionist/);
  assert.match((await SO.saveSalesSettings(t.db, t.owner.id, { enabled: false, agentId: "agent_rcpt01", fromNumber: "+16145550100", maxConcurrent: 1, maxPerRun: 1, maxPerDay: 1, maxAttempts: 1, retryAfterHours: 48 })).join(" "), /separate Retell agent/, "refused even while switched off");
  // The audit still flags an overlap that predates this check (a row written before the receptionist id was saved).
  await configure(t);
  await t.db.prepare(`UPDATE sales_outbound_settings SET agent_id = 'agent_rcpt01' WHERE id = 1`).run();
  const cfg = goodConfig();
  const f = (async (url: string, init: RequestInit = {}) => {
    const p = new URL(url).pathname;
    if (p === "/v2/list-agents") return new Response(JSON.stringify([{ agent_id: "agent_rcpt01", agent_name: "x" }]));
    if (p === "/get-agent/agent_rcpt01") return new Response(JSON.stringify({ ...cfg.agent, agent_id: "agent_rcpt01" }));
    return fakeRetell(cfg).f(url, init);
  }) as unknown as typeof fetch;
  const a = await auditOutboundRetell({ db: t.db, env: { ...t.env, ENVIRONMENT: "staging" }, fetch: f, baseUrl: BASE });
  assert.match(a.findings.find((x) => x.check === "sales agent is not a receptionist agent" && !x.ok)!.detail, /overwrite/);
  // inbound → outbound (receptionist prompt sync refusing a sales agent id) is tested in tests/voice-prompt-sync-isolation.test.ts (PR #72).
});

test("[SEC-001] POST /api/sales-outbound/retell-audit: scheduler-signed, rate-limited, audited, read-only", async () => {
  const post = (t: Awaited<ReturnType<typeof setup>>, body: string, sig: string | null) =>
    t.client().request("POST", "/api/sales-outbound/retell-audit", { body, headers: { "content-type": "application/json", ...(sig ? { "x-crestmont-scheduler-signature": sig } : {}) } });
  const off = await setup();
  assert.equal((await post(off, "{}", await signEvidence("k", "{}"))).status, 503);
  const r = fakeRetell(goodConfig());
  const t = await setup({ RETELL_INBOUND_API_KEY: IN, RETELL_OUTBOUND_API_KEY: OUT, SCHEDULER_TRIGGER_SECRET: "sched-key" } as never);
  t.env.overrides = { ...t.env.overrides, fetch: r.f };
  await configure(t);
  assert.equal((await post(t, "{}", null)).status, 401);
  assert.equal((await post(t, "{}", await signEvidence("wrong", "{}"))).status, 401);
  const ok = await post(t, "{}", await signEvidence("sched-key", "{}"));
  assert.equal(ok.status, 200);
  const body = await ok.json() as { key: string; agentId: string; findings: unknown[] };
  assert.equal(body.key, "outbound");
  assert.equal(body.agentId, AGENT);
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'sales_outbound.retell_audit'`).first());
  await post(t, "{}", await signEvidence("sched-key", "{}"));
  await post(t, "{}", await signEvidence("sched-key", "{}"));
  assert.equal((await post(t, "{}", await signEvidence("sched-key", "{}"))).status, 429);
});
