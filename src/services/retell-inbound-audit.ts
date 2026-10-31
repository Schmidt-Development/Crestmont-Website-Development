// Read-only audit of the receptionist's REAL Retell configuration, run by the staging Worker with its own inbound key
// (RETELL_INBOUND_API_KEY). Nothing is written to Retell and no call is placed. It answers: does the key work against the
// live Retell API, which agent is the receptionist, and do its webhook, events, data storage, tools (all 17 custom
// functions + Transfer Call + End Call), default variables, begin message and prompt match what this backend expects?
//
// Retell API (checked 2026-10-31): POST /v2/list-agents · GET /get-agent/{id} · GET /get-retell-llm/{id} ·
// GET /v2/list-phone-numbers. Bearer auth with the workspace key.
//
// Output is safe to print in CI: ids, names, URLs, setting values and booleans only. No keys, no prompts (only whether the
// prompt matches the active version), phone numbers shown by their last 4 digits only.
import type { Db } from "../lib/db.ts";
import type { Env } from "../app/context.ts";
import { RETELL_API_BASE } from "../adapters/retell.ts";
import { retellKey } from "../adapters/retell-workspaces.ts";
import { loadVoiceConfig } from "./voice-settings.ts";
import { INBOUND_FUNCTIONS, functionContracts } from "./voice.ts";

export const REQUIRED_EVENTS = ["call_started", "call_ended", "call_analyzed", "transfer_started", "transfer_bridged", "transfer_cancelled", "transfer_ended"] as const;
/** The 17 custom functions the receptionist prompt uses (register order). */
export const RECEPTIONIST_TOOLS = [...INBOUND_FUNCTIONS, "record_consent", "request_callback", "escalate", "check_transfer_availability",
  "get_business_hours", "record_opt_out", "lookup_consultation", "reschedule_consultation", "cancel_consultation"] as const;
export const DEFAULT_VARIABLES = ["receptionist_mode", "transfer_available", "transfer_number", "scheduling_available", "business_open_now", "business_hours"] as const;

export interface AuditFinding { check: string; ok: boolean; detail: string }
export interface InboundAudit {
  status: "ok" | "issues" | "not_configured" | "failed";
  key: "inbound";
  agents: { id: string; name: string | null }[];
  agentId: string | null;
  llmId: string | null;
  findings: AuditFinding[];
}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const s = (x: unknown) => (typeof x === "string" ? x : null);
const last4 = (n: unknown) => (typeof n === "string" ? `…${n.replace(/\D/g, "").slice(-4)}` : "?");

async function call(key: string, f: typeof fetch, method: "GET" | "POST", path: string, body?: unknown): Promise<{ ok: boolean; status: number | null; json: unknown; error?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const r = await f(`${RETELL_API_BASE}${path}`, { method, signal: ac.signal, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json, error: r.ok ? undefined : `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, status: null, json: null, error: (e as Error).name === "AbortError" ? "timed out" : (e as Error).message.slice(0, 120) };
  } finally { clearTimeout(timer); }
}

export async function auditInboundRetell(d: { db: Db; env: Env; fetch: typeof fetch; baseUrl: string }): Promise<InboundAudit> {
  const findings: AuditFinding[] = [];
  const add = (check: string, ok: boolean, detail: string) => findings.push({ check, ok, detail: detail.slice(0, 300) });
  const out = (status: InboundAudit["status"], extra: Partial<InboundAudit> = {}): InboundAudit => ({ status, key: "inbound", agents: [], agentId: null, llmId: null, findings, ...extra });
  const key = retellKey(d.env, "inbound");
  if (!key) { add("inbound key", false, "RETELL_INBOUND_API_KEY is not set on this Worker"); return out("not_configured"); }
  const base = d.baseUrl.replace(/\/$/, "");
  const want = { events: `${base}/api/webhooks/retell`, functions: `${base}/api/webhooks/retell/functions`, inbound: `${base}/api/webhooks/retell/inbound` };

  // 1. The key works against the live Retell API (and only this workspace's agents are visible to it).
  const list = await call(key, d.fetch, "POST", "/v2/list-agents?limit=100", {});
  if (!list.ok) { add("inbound key works with Retell", false, `list-agents failed: ${list.error}${list.status === 401 ? " (key rejected by Retell)" : ""}`); return out("failed"); }
  const agents = arr(obj(list.json).items ?? list.json).map((a) => ({ id: s(obj(a).agent_id) ?? "?", name: s(obj(a).agent_name) }));
  add("inbound key works with Retell", true, `list-agents OK: ${agents.length} agent(s) in the inbound workspace`);

  // 2. Which agent is the receptionist: the id recorded in /staff/voice/operations, else the one whose webhook points here.
  const cfg = await loadVoiceConfig(d.db);
  let agentId = cfg.inbound.agent_id ?? null;
  const details = new Map<string, Obj>();
  const getAgent = async (id: string) => { if (!details.has(id)) { const r = await call(key, d.fetch, "GET", `/get-agent/${encodeURIComponent(id)}`); if (r.ok) details.set(id, obj(r.json)); } return details.get(id) ?? null; };
  if (agentId) {
    add("receptionist agent id recorded", true, `inbound agent id ${agentId} is set in /staff/voice/operations`);
    if (!agents.some((a) => a.id === agentId)) add("receptionist agent is in the inbound workspace", false, `agent ${agentId} is not visible to the inbound key (wrong workspace or deleted)`);
  } else {
    const matches: string[] = [];
    for (const a of agents.slice(0, 20)) if (s((await getAgent(a.id))?.webhook_url) === want.events) matches.push(a.id);
    add("receptionist agent id recorded", false, `no inbound agent id in /staff/voice/operations; agents whose webhook points here: ${matches.join(", ") || "none"}`);
    if (matches.length === 1) agentId = matches[0];
  }
  if (!agentId) return out("issues", { agents });
  const agent = await getAgent(agentId);
  if (!agent) { add("get-agent", false, `could not read agent ${agentId}`); return out("failed", { agents, agentId }); }

  // 3. Agent-level settings.
  add("agent webhook URL", s(agent.webhook_url) === want.events, `webhook_url = ${s(agent.webhook_url) ?? "(none)"}; expected ${want.events}`);
  const events = arr(agent.webhook_events).filter((e): e is string => typeof e === "string");
  const missing = REQUIRED_EVENTS.filter((e) => !events.includes(e));
  add("webhook events", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : "all 7 required events selected");
  add("data storage", s(agent.data_storage_setting) === "basic_attributes_only", `data_storage_setting = ${s(agent.data_storage_setting) ?? "(unset)"}; expected basic_attributes_only`);
  const engine = obj(agent.response_engine);
  const llmId = s(engine.llm_id);
  add("response engine", s(engine.type) === "retell-llm" && !!llmId, `type = ${s(engine.type) ?? "?"}${llmId ? `, llm ${llmId}` : ""}; the platform syncs the prompt of a retell-llm agent`);
  if (typeof agent.max_call_duration_ms === "number") add("max call duration", agent.max_call_duration_ms <= 900_000, `${Math.round(agent.max_call_duration_ms / 60_000)} minutes (recommended at most 15)`);
  if (!llmId) return out("issues", { agents, agentId });

  // 4. The LLM: tools, begin message, default variables, prompt.
  const llmRes = await call(key, d.fetch, "GET", `/get-retell-llm/${encodeURIComponent(llmId)}`);
  if (!llmRes.ok) { add("get-retell-llm", false, `could not read LLM ${llmId}: ${llmRes.error}`); return out("failed", { agents, agentId, llmId }); }
  const llm = obj(llmRes.json);
  add("begin message", (s(llm.begin_message) ?? "").trim().length > 0 && s(llm.start_speaker) === "agent", `start_speaker = ${s(llm.start_speaker) ?? "?"}; begin message ${(s(llm.begin_message) ?? "").trim() ? "set" : "empty"}`);
  const tools = arr(llm.general_tools).map(obj);
  const contracts = functionContracts();
  for (const name of RECEPTIONIST_TOOLS) {
    const t = tools.find((x) => s(x.type) === "custom" && s(x.name) === name);
    if (!t) { add(`function ${name}`, false, "not configured on the agent"); continue; }
    const problems: string[] = [];
    if (s(t.url) !== want.functions) problems.push(`url ${s(t.url) ?? "(none)"}`);
    if ((s(t.method) ?? "POST") !== "POST") problems.push(`method ${s(t.method)}`);
    if (t.args_at_root === true) problems.push("'Payload: args only' is on (must be off)");
    if (typeof t.timeout_ms === "number" && (t.timeout_ms < 5_000 || t.timeout_ms > 30_000)) problems.push(`timeout ${t.timeout_ms} ms (use 10000)`);
    if (typeof t.max_retry === "number" && t.max_retry > 2) problems.push(`max_retry ${t.max_retry} (use 1)`);
    const props = Object.keys(obj(obj(t.parameters).properties));
    const req = arr(obj(t.parameters).required).filter((x): x is string => typeof x === "string");
    const c = contracts[name];
    const unknown = props.filter((p) => !c.fields.includes(p));
    const missingReq = c.required.filter((r) => !props.includes(r));
    const extraReq = req.filter((r) => !c.required.includes(r));
    if (unknown.length) problems.push(`parameters the backend ignores: ${unknown.join(", ")}`);
    if (missingReq.length) problems.push(`required by the backend but missing from the schema: ${missingReq.join(", ")}`);
    if (extraReq.length) problems.push(`marked required in Retell but optional in the backend: ${extraReq.join(", ")}`);
    add(`function ${name}`, problems.length === 0, problems.length ? problems.join("; ") : "matches the backend");
  }
  const strays = tools.filter((x) => s(x.type) === "custom" && !(RECEPTIONIST_TOOLS as readonly string[]).includes(s(x.name) ?? ""));
  if (strays.length) add("unexpected custom functions", false, strays.map((x) => `${s(x.name)} → ${s(x.url) ?? "?"}`).join("; "));
  add("End Call tool", tools.some((x) => s(x.type) === "end_call"), tools.some((x) => s(x.type) === "end_call") ? "present" : "missing");
  const transfer = tools.find((x) => s(x.type) === "transfer_call");
  const dest = s(obj(transfer?.transfer_destination).number);
  add("Transfer Call tool", !!transfer && dest === "{{transfer_number}}", transfer ? `destination ${dest ?? s(obj(transfer.transfer_destination).type) ?? "?"}; expected {{transfer_number}}` : "missing");
  const dv = obj(llm.default_dynamic_variables);
  const missingDv = DEFAULT_VARIABLES.filter((k) => typeof dv[k] !== "string");
  add("default dynamic variables", missingDv.length === 0 && dv.receptionist_mode === "voicemail", missingDv.length ? `missing: ${missingDv.join(", ")}` : `receptionist_mode default = ${String(dv.receptionist_mode)}`);
  const active = await d.db.prepare(`SELECT version, prompt_text FROM voice_agent_configs WHERE active = 1`).first<{ version: number; prompt_text: string }>();
  add("prompt matches the active /staff/voice version", !!active && s(llm.general_prompt) === active.prompt_text,
    !active ? "no active version in /staff/voice yet" : s(llm.general_prompt) === active.prompt_text ? `in sync with v${active.version}` : `differs from active v${active.version} (activate or push from /staff/voice)`);

  // 5. Phone number routing (inbound workspace).
  const nums = await call(key, d.fetch, "GET", "/v2/list-phone-numbers");
  if (!nums.ok) add("phone numbers", false, `list-phone-numbers failed: ${nums.error}`);
  else {
    const mine = arr(nums.json).map(obj).filter((n) => arr(n.inbound_agents).some((a) => s(obj(a).agent_id) === agentId) || s(n.inbound_agent_id) === agentId);
    if (!mine.length) add("phone number → receptionist", false, "no number in the inbound workspace routes inbound calls to this agent");
    for (const n of mine) {
      add(`number ${last4(n.phone_number)} inbound webhook`, s(n.inbound_webhook_url) === want.inbound, `inbound_webhook_url = ${s(n.inbound_webhook_url) ?? "(none)"}; expected ${want.inbound}`);
      const bound = cfg.inbound.numbers.includes(s(n.phone_number) ?? "");
      add(`number ${last4(n.phone_number)} bound in /staff/voice/operations`, bound, bound ? "listed as a receptionist number for this environment" : "not listed under receptionist numbers (calls are still answered until a list exists)");
    }
  }
  return out(findings.every((f) => f.ok) ? "ok" : "issues", { agents, agentId, llmId });
}
