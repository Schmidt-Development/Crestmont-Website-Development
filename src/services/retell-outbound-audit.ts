// Read-only audit of the outbound SALES agent's REAL Retell configuration, run by the staging Worker with its own outbound
// key (RETELL_OUTBOUND_API_KEY). Nothing is written to Retell and no call is placed. It answers: is the outbound key on this
// Worker and accepted by Retell, which agent is the sales agent, and do its webhook, events, the 8 sales functions,
// record_consent, End/Transfer Call, default variables and prompt match what this backend expects? It also checks that
// the sales agent is never one of the receptionist's agents (prompt-overwrite isolation) and that the SIE target and the
// caller number are registered.
//
// Separate from the receptionist's audit on purpose (ownership boundary: no inbound code is touched).
// Retell API: POST /v2/list-agents · GET /get-agent/{id} · GET /get-retell-llm/{id} · GET /v2/list-phone-numbers.
//
// Output is safe to print in a public CI log: ids, URLs, setting values and booleans only. No keys, no prompt text (only
// whether it matches), phone numbers by their last 4 digits.
import type { Db } from "../lib/db.ts";
import type { Env } from "../app/context.ts";
import { RETELL_API_BASE } from "../adapters/retell.ts";
import { retellKey, keysAmbiguous } from "../adapters/retell-workspaces.ts";
import { loadSalesSettings } from "./sales-outbound.ts";
import { SALES_FUNCTIONS, outboundFunctionContracts } from "./sales-functions.ts";
import { listTargets, receptionistAgentIds, deployedVersion, type Stage } from "./sales-opt/registry.ts";
import { composeSalesPrompt, baselineSalesInstructions } from "../domain/sales-opt/policy.ts";
import { functionContracts as receptionistContracts } from "./voice.ts";

export const SALES_REQUIRED_EVENTS = ["call_started", "call_ended", "call_analyzed"] as const;
export const SALES_TRANSFER_EVENTS = ["transfer_started", "transfer_bridged", "transfer_cancelled", "transfer_ended"] as const;
/** Defaults that keep an unset variable from being spoken as "{{name}}". lead_id must NOT have one. */
export const SALES_DEFAULT_VARIABLES = ["business_name", "first_name", "industry", "website_url", "website_status", "verified_issue", "recommended_service", "research_verified", "crestmont_env"] as const;

export interface AuditFinding { check: string; ok: boolean; detail: string }
export interface OutboundAudit {
  status: "ok" | "issues" | "not_configured" | "failed";
  key: "outbound";
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
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json, error: r.status >= 200 && r.status < 300 ? undefined : `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, status: null, json: null, error: (e as Error).name === "AbortError" ? "timed out" : (e as Error).message.slice(0, 120) };
  } finally { clearTimeout(timer); }
}

export async function auditOutboundRetell(d: { db: Db; env: Env; fetch: typeof fetch; baseUrl: string }): Promise<OutboundAudit> {
  const findings: AuditFinding[] = [];
  const add = (check: string, ok: boolean, detail: string) => findings.push({ check, ok, detail: detail.slice(0, 300) });
  const out = (status: OutboundAudit["status"], extra: Partial<OutboundAudit> = {}): OutboundAudit => ({ status, key: "outbound", agents: [], agentId: null, llmId: null, findings, ...extra });
  const key = retellKey(d.env, "outbound");
  if (!key) { add("outbound key on this Worker", false, "RETELL_OUTBOUND_API_KEY is not set on this Worker"); return out("not_configured"); }
  add("outbound key on this Worker", true, "RETELL_OUTBOUND_API_KEY is set (value not shown)");
  if (keysAmbiguous(d.env)) { add("workspace keys distinct", false, "RETELL_INBOUND_API_KEY and RETELL_OUTBOUND_API_KEY are identical: the workspace cannot be determined and every webhook is refused"); return out("failed"); }
  add("workspace keys distinct", true, "inbound and outbound keys differ");
  const base = d.baseUrl.replace(/\/$/, "");
  const want = { events: `${base}/api/webhooks/retell`, functions: `${base}/api/webhooks/retell/outbound/functions`, consent: `${base}/api/webhooks/retell/functions` };
  const stage: Stage = d.env.ENVIRONMENT === "production" ? "production" : "staging";

  // 1. The key works against the live Retell API.
  const list = await call(key, d.fetch, "POST", "/v2/list-agents?limit=100", {});
  if (!list.ok) { add("outbound key works with Retell", false, `list-agents failed: ${list.error}${list.status === 401 ? " (key rejected by Retell)" : ""}`); return out("failed"); }
  const agents = arr(obj(list.json).items ?? list.json).map((a) => ({ id: s(obj(a).agent_id) ?? "?", name: s(obj(a).agent_name) }));
  add("outbound key works with Retell", true, `list-agents OK: ${agents.length} agent(s) in the outbound workspace`);

  // 2. Which agent is the sales agent: /staff/sales-outbound, else the SIE target for this stage, else discovery by tools.
  const settings = await loadSalesSettings(d.db);
  const target = (await listTargets(d.db))[stage];
  const receptionist = await receptionistAgentIds(d.db);
  const details = new Map<string, Obj>();
  const getAgent = async (id: string) => { if (!details.has(id)) { const r = await call(key, d.fetch, "GET", `/get-agent/${encodeURIComponent(id)}`); if (r.ok) details.set(id, obj(r.json)); } return details.get(id) ?? null; };
  let agentId = settings.agent_id ?? target?.agent_id ?? null;
  if (settings.agent_id) add("sales agent id recorded", true, `agent id ${settings.agent_id} is set in /staff/sales-outbound`);
  else if (target) add("sales agent id recorded", false, `not set in /staff/sales-outbound (using the SIE ${stage} target ${target.agent_id}); save it there`);
  else {
    const matches: string[] = [];
    for (const a of agents.slice(0, 20)) if (s((await getAgent(a.id))?.webhook_url) === want.events) matches.push(a.id);
    add("sales agent id recorded", false, `no sales agent id in /staff/sales-outbound or the SIE; agents whose webhook points here: ${matches.join(", ") || "none"}`);
    if (matches.length === 1) agentId = matches[0];
  }
  if (!agentId) return out("issues", { agents });
  if (!agents.some((a) => a.id === agentId)) add("sales agent is in the outbound workspace", false, `agent ${agentId} is not visible to the outbound key (wrong workspace or deleted)`);
  add("sales agent is not a receptionist agent", !receptionist.has(agentId), receptionist.has(agentId) ? "this id is also recorded as a receptionist agent in /staff/voice/operations: prompt syncs would overwrite each other" : "isolated from the receptionist (neither prompt sync can write to the other)");
  if (settings.agent_id && target && target.agent_id !== settings.agent_id) add("SIE target matches the sales agent", false, `SIE ${stage} target ${target.agent_id} differs from /staff/sales-outbound ${settings.agent_id}`);
  else add(`SIE ${stage} target registered and verified`, !!target && !!target.verified_at, !target ? `register the sales agent as the ${stage} target on /staff/sales-optimization` : target.verified_at ? `verified ${target.verified_at}` : "registered but not verified (press Verify with Retell)");
  const agent = await getAgent(agentId);
  if (!agent) { add("get-agent", false, `could not read agent ${agentId}`); return out("failed", { agents, agentId }); }

  // 3. Agent-level settings (record_call_outcome is the agent webhook).
  add("agent webhook URL", s(agent.webhook_url) === want.events, `webhook_url = ${s(agent.webhook_url) ?? "(none)"}; expected ${want.events}`);
  const events = arr(agent.webhook_events).filter((e): e is string => typeof e === "string");
  // Retell sends call_started/ended/analyzed when webhook_events is unset.
  const effective = events.length ? events : [...SALES_REQUIRED_EVENTS];
  const missing = SALES_REQUIRED_EVENTS.filter((e) => !effective.includes(e));
  add("webhook events", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `call events selected${events.length ? "" : " (Retell defaults)"}`);
  const missingTransfer = SALES_TRANSFER_EVENTS.filter((e) => !effective.includes(e));
  add("transfer webhook events", missingTransfer.length === 0, missingTransfer.length ? `missing: ${missingTransfer.join(", ")} (a failed warm transfer will not create a callback task)` : "all 4 transfer events selected");
  add("data storage", true, `data_storage_setting = ${s(agent.data_storage_setting) ?? "(unset)"} (informational; the platform stores transcripts only after record_consent)`);
  const engine = obj(agent.response_engine);
  const llmId = s(engine.llm_id);
  add("response engine", s(engine.type) === "retell-llm" && !!llmId, `type = ${s(engine.type) ?? "?"}${llmId ? `, llm ${llmId}` : ""}; the SIE deploys prompts only to a retell-llm agent`);
  if (!llmId) return out("issues", { agents, agentId });

  // 4. The LLM: tools, default variables, prompt.
  const llmRes = await call(key, d.fetch, "GET", `/get-retell-llm/${encodeURIComponent(llmId)}`);
  if (!llmRes.ok) { add("get-retell-llm", false, `could not read LLM ${llmId}: ${llmRes.error}`); return out("failed", { agents, agentId, llmId }); }
  const llm = obj(llmRes.json);
  const tools = arr(llm.general_tools).map(obj);
  const contracts: Record<string, { fields: string[]; required: string[] }> = { ...outboundFunctionContracts(), record_consent: receptionistContracts().record_consent };
  const expected = [...SALES_FUNCTIONS, "record_consent"];
  for (const name of expected) {
    const t = tools.find((x) => s(x.type) === "custom" && s(x.name) === name);
    if (!t) { add(`function ${name}`, false, "not configured on the agent"); continue; }
    const problems: string[] = [];
    const url = (s(t.url) ?? "").split("?")[0];
    const wantUrl = name === "record_consent" ? want.consent : want.functions;
    if (url !== wantUrl) problems.push(`url ${s(t.url) ?? "(none)"} (expected ${wantUrl})`);
    if ((s(t.method) ?? "POST") !== "POST") problems.push(`method ${s(t.method)}`);
    if (t.args_at_root === true) problems.push("'Payload: args only' is on (must be off: the signed call metadata binds the lead)");
    if (typeof t.timeout_ms === "number" && (t.timeout_ms < 5_000 || t.timeout_ms > 30_000)) problems.push(`timeout ${t.timeout_ms} ms (use 10000)`);
    if (typeof t.max_retry === "number" && t.max_retry > 2) problems.push(`max_retry ${t.max_retry} (use 1; 2 for record_do_not_call)`);
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
  const strays = tools.filter((x) => s(x.type) === "custom" && !expected.includes(s(x.name) ?? ""));
  if (strays.length) add("unexpected custom functions", false, strays.map((x) => `${s(x.name)} → ${s(x.url) ?? "?"}`).join("; "));
  add("End Call tool", tools.some((x) => s(x.type) === "end_call"), tools.some((x) => s(x.type) === "end_call") ? "present" : "missing");
  const transfer = tools.find((x) => s(x.type) === "transfer_call");
  add("Transfer Call tool", !!transfer, transfer ? `present (${s(obj(transfer.transfer_option).type) ?? "transfer"})` : "missing (the policy offers a transfer to a person)");
  const dv = obj(llm.default_dynamic_variables);
  const missingDv = SALES_DEFAULT_VARIABLES.filter((k) => typeof dv[k] !== "string");
  const badDefaults: string[] = [];
  if (typeof dv.research_verified === "string" && dv.research_verified !== "false") badDefaults.push(`research_verified = "${dv.research_verified}" (must be "false")`);
  if (typeof dv.website_status === "string" && dv.website_status !== "unknown") badDefaults.push(`website_status = "${dv.website_status}" (must be "unknown")`);
  if ("lead_id" in dv) badDefaults.push("lead_id has a default (remove it: never a fabricated lead id)");
  add("default dynamic variables", missingDv.length === 0 && badDefaults.length === 0, [missingDv.length ? `missing: ${missingDv.join(", ")}` : "", ...badDefaults].filter(Boolean).join("; ") || "all 9 defaults set; no lead_id default");
  const deployed = await deployedVersion(d.db, stage);
  const expectedPrompt = composeSalesPrompt(deployed ? deployed.instructions : baselineSalesInstructions());
  const label = deployed ? `SIE v${deployed.seq} (verified deployment)` : "the master prompt (docs/voice/outbound-sales-agent-prompt.txt = SIE v1)";
  add("prompt matches", s(llm.general_prompt) === expectedPrompt, s(llm.general_prompt) === expectedPrompt ? `in sync with ${label}` : `differs from ${label}`);
  add("begin message", s(llm.start_speaker) === "agent" || s(llm.start_speaker) === "user", `start_speaker = ${s(llm.start_speaker) ?? "?"}; begin message ${(s(llm.begin_message) ?? "").trim() ? "set" : "empty (the prompt's opening is used)"}`);

  // 5. The caller number used by the dialler.
  const nums = await call(key, d.fetch, "GET", "/v2/list-phone-numbers");
  if (!nums.ok) add("caller number", false, `list-phone-numbers failed: ${nums.error}`);
  else if (!settings.from_number) add("caller number", false, `no caller number in /staff/sales-outbound; ${arr(nums.json).length} number(s) in the outbound workspace`);
  else {
    const n = arr(nums.json).map(obj).find((x) => s(x.phone_number) === settings.from_number);
    add(`caller number ${last4(settings.from_number)}`, !!n, n ? "present in the outbound workspace" : "not found in the outbound workspace (create-phone-call would fail)");
  }
  return out(findings.every((f) => f.ok) ? "ok" : "issues", { agents, agentId, llmId });
}
