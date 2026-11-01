// Read-only audit of the receptionist's REAL Retell configuration, run by the staging Worker with its own inbound key
// (RETELL_INBOUND_API_KEY). Nothing is written to Retell and no call is placed.
//
// Expectations follow the Founder's decisions of 2026-10-31 (docs/voice/RETELL-INBOUND-FUNCTION-REGISTER.md §Founder
// decisions): AI receptionist answers 24/7 in full-service mode; max call 60 minutes; WARM transfer only; ZERO default
// dynamic variables (per-call variables come from the inbound webhook, never from defaults); the master prompt is the
// Founder's Retell-native single prompt (V4) maintained in the Retell dashboard; 17 custom functions + transfer_call +
// end_call; inbound and outbound in separate workspaces.
//
// Retell API (checked 2026-10-31): POST /v2/list-agents · GET /get-agent/{id} · GET /get-retell-llm/{id} ·
// GET /v2/list-phone-numbers (→ { items, has_more }). Bearer auth with the inbound workspace key.
//
// The repository is public, so this output is too: ids, URLs, setting values and booleans only. Phone numbers are shown by
// their last 4 digits; the prompt itself is never printed (only its length, hash prefix and what it references).
import type { Db } from "../lib/db.ts";
import type { Env } from "../app/context.ts";
import { RETELL_API_BASE } from "../adapters/retell.ts";
import { retellKey } from "../adapters/retell-workspaces.ts";
import { loadVoiceConfig } from "./voice-settings.ts";
import { INBOUND_FUNCTIONS, VOICE_FUNCTIONS, VOICE_GUARDRAILS, functionContracts } from "./voice.ts";
import { sha256Hex } from "../lib/crypto.ts";

export const REQUIRED_EVENTS = ["call_started", "call_ended", "call_analyzed", "transfer_started", "transfer_bridged", "transfer_cancelled", "transfer_ended"] as const;
/** The 17 custom functions the receptionist uses (register order). */
export const RECEPTIONIST_TOOLS = [...INBOUND_FUNCTIONS, "record_consent", "request_callback", "escalate", "check_transfer_availability",
  "get_business_hours", "record_opt_out", "lookup_consultation", "reschedule_consultation", "cancel_consultation"] as const;
/** Per-call variables the inbound-call webhook supplies (adapters/retell.ts translateRetellInbound). Not defaults. */
export const WEBHOOK_VARIABLES = ["crestmont_env", "receptionist_mode", "business_open_now", "business_hours_configured", "business_hours", "transfer_available", "transfer_number", "scheduling_available"] as const;
/** Variables Retell itself fills on every call (docs: dynamic variables → system variables). */
const SYSTEM_VARIABLE = /^(current_time|current_calendar|direction|user_number|agent_number|call_id|call_type|session_duration|session_type|current_agent_state|previous_agent_state)(_.*)?$/;
export const MAX_CALL_MS = 3_600_000; // Founder decision: 60 minutes

export type FindingStatus = "pass" | "fail" | "info";
export interface AuditFinding { check: string; ok: boolean; status: FindingStatus; detail: string }
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
/** Retell list endpoints return { items: [...] } (v2); a bare array is accepted too. */
const items = (x: unknown): unknown[] => (Array.isArray(x) ? x : arr(obj(x).items));
const s = (x: unknown) => (typeof x === "string" ? x : null);
const digits = (n: string) => n.replace(/\D/g, "");
export const last4 = (n: unknown) => (typeof n === "string" && digits(n).length >= 4 ? `…${digits(n).slice(-4)}` : typeof n === "string" ? n : "?");
const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

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
  const add = (check: string, status: FindingStatus | boolean, detail: string) => {
    const st: FindingStatus = typeof status === "boolean" ? (status ? "pass" : "fail") : status;
    findings.push({ check, ok: st !== "fail", status: st, detail: detail.slice(0, 400) });
  };
  const out = (status: InboundAudit["status"], extra: Partial<InboundAudit> = {}): InboundAudit => ({ status, key: "inbound", agents: [], agentId: null, llmId: null, findings, ...extra });
  const key = retellKey(d.env, "inbound");
  if (!key) { add("inbound key", false, "RETELL_INBOUND_API_KEY is not set on this Worker"); return out("not_configured"); }
  const base = d.baseUrl.replace(/\/$/, "");
  const want = { events: `${base}/api/webhooks/retell`, functions: `${base}/api/webhooks/retell/functions`, inbound: `${base}/api/webhooks/retell/inbound` };

  // 1. The key works against the live Retell API.
  const list = await call(key, d.fetch, "POST", "/v2/list-agents?limit=100", {});
  if (!list.ok) { add("inbound key works with Retell", false, `list-agents failed: ${list.error}${list.status === 401 ? " (key rejected by Retell)" : ""}`); return out("failed"); }
  const agents = items(list.json).map((a) => ({ id: s(obj(a).agent_id) ?? "?", name: s(obj(a).agent_name) }));
  add("inbound key works with Retell", true, `list-agents OK: ${agents.length} agent(s) in the inbound workspace`);

  // 2. Which agent is the receptionist.
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
  add("agent version", "info", `latest version ${n(agent.version) ?? "?"} · ${agent.is_published === true ? "published" : "not published (draft)"}`);
  const ms = n(agent.max_call_duration_ms);
  add("max call duration", ms !== null && ms <= MAX_CALL_MS, `${ms === null ? "unset" : `${Math.round(ms / 60_000)} minutes`}; Founder decision: at most 60`);
  // Data storage is a privacy decision awaiting legal review (PROVIDER-EVALUATION.md §6 condition 4): reported, not judged.
  add("data storage (legal review)", "info", `data_storage_setting = ${s(agent.data_storage_setting) ?? "(unset)"}. The platform keeps transcripts and recordings only after record_consent, whatever this is; whether Retell may keep them is the pending privacy/legal review.`);
  const lang = Array.isArray(agent.language) ? agent.language.join("+") : s(agent.language) ?? "en-US (default)";
  add("voice and language", "info", `voice_id = ${s(agent.voice_id) ?? "?"} · language = ${lang}`);
  add("interruption and silence", "info", `interruption_sensitivity = ${n(agent.interruption_sensitivity) ?? "default"} · responsiveness = ${n(agent.responsiveness) ?? "default"} · end_call_after_silence_ms = ${n(agent.end_call_after_silence_ms) ?? "default (600000)"}`);
  add("post-call analysis", "info", `${arr(agent.post_call_analysis_data).length} custom extraction field(s); summary stored by the platform only with consent`);
  add("voicemail detection", "info", agent.voicemail_option ? `on (action ${s(obj(obj(agent.voicemail_option).action).type) ?? "set"})` : "off");
  const engine = obj(agent.response_engine);
  const llmId = s(engine.llm_id);
  add("response engine", s(engine.type) === "retell-llm" && !!llmId, `type = ${s(engine.type) ?? "?"}${llmId ? `, llm ${llmId}` : ""}; a single-prompt Retell LLM agent`);
  if (!llmId) return out("issues", { agents, agentId });

  // 4. The LLM.
  const llmRes = await call(key, d.fetch, "GET", `/get-retell-llm/${encodeURIComponent(llmId)}`);
  if (!llmRes.ok) { add("get-retell-llm", false, `could not read LLM ${llmId}: ${llmRes.error}`); return out("failed", { agents, agentId, llmId }); }
  const llm = obj(llmRes.json);
  add("single prompt (no states)", arr(llm.states).length === 0, arr(llm.states).length ? `${arr(llm.states).length} state(s) configured: a multi-prompt agent` : "native single prompt");
  add("begin message", (s(llm.begin_message) ?? "").trim().length > 0 && s(llm.start_speaker) === "agent", `start_speaker = ${s(llm.start_speaker) ?? "?"}; begin message ${(s(llm.begin_message) ?? "").trim() ? "set" : "empty"}`);
  const model = s(obj(obj(llm.model_config).primary).model) ?? s(obj(llm.model_config).primary) ?? s(llm.model);
  add("model and knowledge base", "info", `model = ${model ?? "?"} · knowledge bases attached: ${arr(llm.knowledge_base_ids).length}`);
  const dv = Object.keys(obj(llm.default_dynamic_variables));
  add("default dynamic variables", "info", dv.length ? `${dv.length} set (${dv.join(", ")}); the Founder's decision is none` : "none (Founder decision); per-call values come from the inbound webhook");

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
    if (!(s(t.description) ?? "").trim()) problems.push("no description");
    if (Object.keys(obj(t.headers)).length) problems.push(`custom headers ${Object.keys(obj(t.headers)).join(", ")} (none are needed; Retell signs the request)`);
    if (Object.keys(obj(t.query_params)).length) problems.push(`query parameters ${Object.keys(obj(t.query_params)).join(", ")} (none are expected)`);
    const props = Object.keys(obj(obj(t.parameters).properties));
    const req = arr(obj(t.parameters).required).filter((x): x is string => typeof x === "string");
    const c = contracts[name];
    const unknown = props.filter((p) => !c.fields.includes(p));
    const missingReq = c.required.filter((r) => !props.includes(r));
    const extraReq = req.filter((r) => !c.required.includes(r));
    if (unknown.length) problems.push(`parameters the backend ignores: ${unknown.join(", ")}`);
    if (missingReq.length) problems.push(`required by the backend but missing from the schema: ${missingReq.join(", ")}`);
    if (extraReq.length) problems.push(`marked required in Retell but optional in the backend: ${extraReq.join(", ")}`);
    const exec = `timeout ${n(t.timeout_ms) ?? "default"} ms, retries ${n(t.max_retry) ?? "default"}, speak during ${t.speak_during_execution === true ? "on" : "off"}, typing sound ${t.enable_typing_sound === true ? "on" : "off"}`;
    add(`function ${name}`, problems.length === 0, problems.length ? `${problems.join("; ")} (${exec})` : `matches the backend (${exec})`);
  }
  const strays = tools.filter((x) => s(x.type) === "custom" && !(RECEPTIONIST_TOOLS as readonly string[]).includes(s(x.name) ?? ""));
  if (strays.length) add("unexpected custom functions", false, strays.map((x) => `${s(x.name)} → ${s(x.url) ?? "?"}`).join("; "));
  add("End Call tool", tools.some((x) => s(x.type) === "end_call"), tools.some((x) => s(x.type) === "end_call") ? "present" : "missing");

  // 5. Phone numbers in the inbound workspace (needed before the transfer check, to detect loops).
  const nums = await call(key, d.fetch, "GET", "/v2/list-phone-numbers");
  const numbers = nums.ok ? items(nums.json).map(obj) : [];
  const ownNumbers = new Set(numbers.map((x) => digits(s(x.phone_number) ?? "")).filter(Boolean));

  // 6. Warm transfer (Founder decision). Destination: {{transfer_number}} (filled per call by the inbound webhook only when
  //    a Founder-approved number is enabled and staff are on hours) or a fixed number equal to the approved one.
  const transfers = tools.filter((x) => s(x.type) === "transfer_call");
  if (!transfers.length) add("Transfer Call tool", false, "missing");
  for (const t of transfers) {
    const opt = s(obj(t.transfer_option).type);
    add(`Transfer Call ${s(t.name) ?? ""}: warm`, opt === "warm_transfer" || opt === "agentic_warm_transfer", `transfer_option = ${opt ?? "?"}; Founder decision: warm transfer`);
    const dest = obj(t.transfer_destination);
    const num = s(dest.number);
    const approved = cfg.transfer.enabled ? cfg.transfer.number : null;
    if (s(dest.type) === "inferred") add(`Transfer Call ${s(t.name) ?? ""}: destination`, false, "inferred destination: the model chooses the number; use a predefined destination");
    else if (num === "{{transfer_number}}") add(`Transfer Call ${s(t.name) ?? ""}: destination`, true, "{{transfer_number}}: filled per call by the inbound webhook only when transfer is enabled and staff are on hours (server-gated)");
    else if (num && ownNumbers.has(digits(num))) add(`Transfer Call ${s(t.name) ?? ""}: destination`, false, `${last4(num)} is one of this workspace's own numbers: a transfer would loop back to the receptionist`);
    else if (num && approved && digits(num) === digits(approved)) add(`Transfer Call ${s(t.name) ?? ""}: destination`, true, `fixed ${last4(num)} = the approved transfer number in /staff/voice/operations. Staffing is enforced by check_transfer_availability in the prompt, not by the tool`);
    else add(`Transfer Call ${s(t.name) ?? ""}: destination`, false, `fixed ${last4(num)} ${approved ? `differs from the approved number ${last4(approved)}` : "but no transfer number is approved and enabled in /staff/voice/operations"}`);
  }

  // 7. Prompt (the Founder's live V4 is authoritative). Never printed; only what it references is checked.
  const prompt = s(llm.general_prompt) ?? "";
  add("prompt", prompt.trim().length > 0, `${prompt.length} characters, sha256 ${(await sha256Hex(prompt)).slice(0, 12)}${prompt.startsWith(VOICE_GUARDRAILS) ? ", begins with the platform guardrails" : ", does not begin with the platform guardrails block"}`);
  const named = new Set([...prompt.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)].map((m) => m[1]));
  // Whole-word match per function (names such as "escalate" have no underscore).
  const absent = RECEPTIONIST_TOOLS.filter((t) => !new RegExp(`(^|[^A-Za-z0-9_])${t}([^A-Za-z0-9_]|$)`).test(prompt));
  add("prompt names all 17 functions", absent.length === 0, absent.length ? `not mentioned: ${absent.join(", ")}` : "all 17 named");
  const legacy = [...named].filter((t) => (VOICE_FUNCTIONS as readonly string[]).includes(t) && !(RECEPTIONIST_TOOLS as readonly string[]).includes(t));
  if (legacy.length) add("prompt names functions not on the agent", false, `${legacy.join(", ")} exist in the backend but are not configured on this agent`);
  const vars = [...new Set([...prompt.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))];
  const fromWebhook = vars.filter((v) => (WEBHOOK_VARIABLES as readonly string[]).includes(v));
  const unknownVars = vars.filter((v) => !(WEBHOOK_VARIABLES as readonly string[]).includes(v) && !SYSTEM_VARIABLE.test(v));
  add("prompt variables", unknownVars.length === 0, `${vars.length ? `uses ${vars.map((v) => `{{${v}}}`).join(", ")}` : "uses no variables"}${unknownVars.length ? `; nothing supplies ${unknownVars.join(", ")} (no defaults exist)` : ""}${fromWebhook.length ? `; ${fromWebhook.join(", ")} come only from the inbound webhook` : ""}`);
  const active = await d.db.prepare(`SELECT version, prompt_text FROM voice_agent_configs WHERE active = 1`).first<{ version: number; prompt_text: string }>();
  if (!active) add("platform prompt version", "info", "no active /staff/voice version: the platform pushes nothing, so the Retell prompt stays as the Founder set it. Use 'Adopt the live Retell prompt' to record it.");
  else add("platform prompt version", active.prompt_text === prompt, active.prompt_text === prompt ? `active v${active.version} = the live prompt` : `active v${active.version} differs from the live prompt: pushing would overwrite it (the drift guard refuses unless confirmed). Adopt the live prompt to reconcile.`);

  // 8. Phone number routing.
  if (!nums.ok) add("phone numbers", false, `list-phone-numbers failed: ${nums.error}`);
  else {
    add("phone numbers in the inbound workspace", numbers.length > 0, numbers.length ? numbers.map((x) => `${last4(x.phone_number)} → ${arr(x.inbound_agents).map((a) => `${s(obj(a).agent_id) ?? "?"}${obj(a).agent_version !== undefined ? ` v${String(obj(a).agent_version)}` : ""}`).join(", ") || "no inbound agent"}`).join("; ") : "none");
    const mine = numbers.filter((x) => arr(x.inbound_agents).some((a) => s(obj(a).agent_id) === agentId));
    if (!mine.length) add("phone number → receptionist", false, "no number in the inbound workspace routes inbound calls to this agent");
    for (const x of mine) {
      const l4 = last4(x.phone_number);
      add(`number ${l4} → receptionist`, true, `inbound calls route to ${agentId}`);
      add(`number ${l4} inbound webhook`, s(x.inbound_webhook_url) === want.inbound, `inbound_webhook_url = ${s(x.inbound_webhook_url) ?? "(none)"}; expected ${want.inbound}. Without it no per-call variables, environment stamp or number binding apply`);
      const bound = cfg.inbound.numbers.some((b) => digits(b) === digits(s(x.phone_number) ?? ""));
      add(`number ${l4} registered in /staff/voice/operations`, bound, bound ? "listed as a receptionist number for this environment" : "not listed under receptionist numbers");
    }
  }
  return out(findings.every((f) => f.ok) ? "ok" : "issues", { agents, agentId, llmId });
}
