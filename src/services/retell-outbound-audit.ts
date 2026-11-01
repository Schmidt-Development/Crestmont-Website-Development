// Read-only audit of the outbound SALES agent's REAL Retell configuration, run by the staging Worker with its own outbound
// key (RETELL_OUTBOUND_API_KEY). Nothing is written to Retell and no call is placed.
//
// Expected values follow the Founder's decisions of 2026-11-01 (they override older documentation):
//  - prompt: the Founder's Retell Native Single Prompt (V17) is authoritative. It is never compared with the repository's
//    master prompt; instead the audit proves it is usable: every {{variable}} it uses is sent per call by the dialler (or is
//    a Retell system variable), it names all nine custom functions plus transfer_call and end_call, and no function that
//    does not exist. The SIE must have adopted it as the current version (so no older version can overwrite it).
//  - Default Dynamic Variables: NONE (intentionally removed). Per-call variables carry the CRM lead.
//  - nine custom functions (the 8 sales functions on the outbound endpoint + record_consent on the shared endpoint).
//  - warm transfer, an approved voicemail message, 60-minute maximum call duration.
//
// Retell API (docs.retellai.com, checked 2026-11-01): POST /v2/list-agents · GET /get-agent/{id} ·
// GET /get-agent-versions/{id} · GET /get-retell-llm/{id} · GET /v2/list-phone-numbers ({ items, has_more }) ·
// GET /get-concurrency.
//
// Output is safe to print in a public CI log: ids, URLs, setting values, counts, hashes and booleans. Never a key, never
// prompt or voicemail text (only hashes, lengths, the prompt's title line and what it references), phone numbers by their
// last 4 digits.
import type { Db } from "../lib/db.ts";
import type { Env } from "../app/context.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { RETELL_API_BASE } from "../adapters/retell.ts";
import { retellKey, keysAmbiguous } from "../adapters/retell-workspaces.ts";
import { loadSalesSettings } from "./sales-outbound.ts";
import { SALES_FUNCTIONS, outboundFunctionContracts, OUTBOUND_FUNCTION_ENUMS } from "./sales-functions.ts";
import { listTargets, receptionistAgentIds, deployedVersion, promptOf, type Stage } from "./sales-opt/registry.ts";
import { functionContracts as receptionistContracts, VOICE_FUNCTIONS } from "./voice.ts";
import { PER_CALL_VARIABLES } from "../domain/sales-eligibility.ts";

export const SALES_REQUIRED_EVENTS = ["call_started", "call_ended", "call_analyzed"] as const;
export const SALES_TRANSFER_EVENTS = ["transfer_started", "transfer_bridged", "transfer_cancelled", "transfer_ended"] as const;
export const EXPECTED_CUSTOM_FUNCTIONS = [...SALES_FUNCTIONS, "record_consent"] as const;
export const MAX_CALL_DURATION_MS = 3_600_000; // Founder decision: 60 minutes
export const RECORD_CONSENT_DESCRIPTION = "Record whether the person agreed to the call being recorded and transcribed. Call once, right after asking.";
/** Retell system variables (docs.retellai.com/build/dynamic-variables) usable in a prompt without any default. */
const SYSTEM_VARIABLES = new Set(["current_time", "current_calendar", "agent_number", "user_number", "call_id", "direction", "session_type", "session_duration", "current_agent_state", "previous_agent_state"]);

export type AuditState = "PASS" | "FAIL" | "UNVERIFIED" | "INFO";
export interface AuditFinding { check: string; ok: boolean; detail: string; state?: AuditState; observed?: string; expected?: string }
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
/** Retell's v2 list endpoints return { items, has_more }; older ones a bare array. */
const items = (x: unknown): unknown[] => (Array.isArray(x) ? x : arr(obj(x).items));
const s = (x: unknown) => (typeof x === "string" ? x : null);
const n = (x: unknown) => (typeof x === "number" ? x : null);
const last4 = (v: unknown) => (typeof v === "string" ? `…${v.replace(/\D/g, "").slice(-4)}` : "?");
const e164 = (v: string | null | undefined) => (v ? `+${v.replace(/\D/g, "")}` : null);

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

/** What a prompt references, without revealing its text. */
export function analysePrompt(text: string, toolNames: readonly string[]) {
  const vars = [...new Set([...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))];
  const perCall = new Set<string>(PER_CALL_VARIABLES);
  const unsupplied = vars.filter((v) => !perCall.has(v) && !SYSTEM_VARIABLES.has(v) && !/^current_time_/.test(v));
  const mentions = (name: string) => new RegExp(`\\b${name}\\b`).test(text);
  const missingTools = toolNames.filter((t) => !mentions(t));
  // Tool-like snake_case names the prompt tells the agent to call that the agent does not have.
  const claimed = new Set<string>();
  for (const m of text.matchAll(/\b(?:[Cc]all|[Uu]se|[Rr]un|[Ii]nvoke|[Tt]rigger)\s+(?:the\s+)?`?([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`?/g)) claimed.add(m[1]);
  for (const m of text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) claimed.add(m[1]);
  const known = new Set<string>([...toolNames, ...PER_CALL_VARIABLES, "transfer_call", "end_call"]);
  const unknownTools = [...claimed].filter((t) => !known.has(t) && ((VOICE_FUNCTIONS as readonly string[]).includes(t) || /^(get|update|create|check|send|schedule|record|lookup|book|cancel|reschedule|request|escalate|crm)_/.test(t)));
  const title = (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 120);
  return { vars, unsupplied, missingTools, unknownTools, title, v17: /\bV\s?17\b/i.test(text) };
}

export async function auditOutboundRetell(d: { db: Db; env: Env; fetch: typeof fetch; baseUrl: string; expectedCallerNumber?: string | null }): Promise<OutboundAudit> {
  const findings: AuditFinding[] = [];
  const add = (check: string, state: AuditState, detail: string, observed?: string, expected?: string) =>
    findings.push({ check, ok: state !== "FAIL", state, detail: detail.slice(0, 400), ...(observed !== undefined ? { observed: observed.slice(0, 160) } : {}), ...(expected !== undefined ? { expected: expected.slice(0, 160) } : {}) });
  const pf = (check: string, ok: boolean, detail: string, observed?: string, expected?: string) => add(check, ok ? "PASS" : "FAIL", detail, observed, expected);
  const out = (status: OutboundAudit["status"], extra: Partial<OutboundAudit> = {}): OutboundAudit => ({ status, key: "outbound", agents: [], agentId: null, llmId: null, findings, ...extra });
  const key = retellKey(d.env, "outbound");
  if (!key) { pf("outbound key on this Worker", false, "RETELL_OUTBOUND_API_KEY is not set on this Worker"); return out("not_configured"); }
  pf("outbound key on this Worker", true, "RETELL_OUTBOUND_API_KEY is set (value not shown)");
  if (keysAmbiguous(d.env)) { pf("workspace keys distinct", false, "RETELL_INBOUND_API_KEY and RETELL_OUTBOUND_API_KEY are identical: the workspace cannot be determined and every webhook is refused"); return out("failed"); }
  pf("workspace keys distinct", true, "inbound and outbound keys differ");
  const base = d.baseUrl.replace(/\/$/, "");
  const want = { events: `${base}/api/webhooks/retell`, functions: `${base}/api/webhooks/retell/outbound/functions`, consent: `${base}/api/webhooks/retell/functions` };
  const stage: Stage = d.env.ENVIRONMENT === "production" ? "production" : "staging";

  // 1. The key works against the live Retell API.
  const list = await call(key, d.fetch, "POST", "/v2/list-agents?limit=100", {});
  if (!list.ok) { pf("outbound key works with Retell", false, `list-agents failed: ${list.error}${list.status === 401 ? " (key rejected by Retell)" : ""}`); return out("failed"); }
  const agents = items(list.json).map((a) => ({ id: s(obj(a).agent_id) ?? "?", name: s(obj(a).agent_name) }));
  pf("outbound key works with Retell", true, `list-agents OK: ${agents.length} agent(s) in the outbound workspace`);

  // 2. Which agent is the sales agent.
  const settings = await loadSalesSettings(d.db);
  const target = (await listTargets(d.db))[stage];
  const receptionist = await receptionistAgentIds(d.db);
  const details = new Map<string, Obj>();
  const getAgent = async (id: string) => { if (!details.has(id)) { const r = await call(key, d.fetch, "GET", `/get-agent/${encodeURIComponent(id)}`); if (r.ok) details.set(id, obj(r.json)); } return details.get(id) ?? null; };
  let agentId = settings.agent_id ?? target?.agent_id ?? null;
  if (settings.agent_id) pf("sales agent id recorded", true, `agent id ${settings.agent_id} is set in /staff/sales-outbound`, settings.agent_id);
  else {
    const matches: string[] = [];
    if (!target) for (const a of agents.slice(0, 20)) if (s((await getAgent(a.id))?.webhook_url) === want.events) matches.push(a.id);
    pf("sales agent id recorded", false, target ? `not set in /staff/sales-outbound (SIE ${stage} target is ${target.agent_id}); save it there` : `no sales agent id in /staff/sales-outbound or the SIE; agents whose webhook points here: ${matches.join(", ") || "none"}`, "(none)", "the outbound agent id");
    if (!target && matches.length === 1) agentId = matches[0];
  }
  if (!agentId) return out("issues", { agents });
  if (!agents.some((a) => a.id === agentId)) pf("sales agent is in the outbound workspace", false, `agent ${agentId} is not visible to the outbound key (wrong workspace or deleted)`);
  pf("sales agent is not a receptionist agent", !receptionist.has(agentId), receptionist.has(agentId) ? "this id is also recorded as a receptionist agent in /staff/voice/operations: prompt syncs would overwrite each other" : "isolated from the receptionist (neither prompt sync can write to the other)");
  const agent = await getAgent(agentId);
  if (!agent) { pf("get-agent", false, `could not read agent ${agentId}`); return out("failed", { agents, agentId }); }

  // 3. Agent-level settings.
  pf("agent webhook URL", s(agent.webhook_url) === want.events, "record_call_outcome is the agent webhook", s(agent.webhook_url) ?? "(none)", want.events);
  const events = arr(agent.webhook_events).filter((e): e is string => typeof e === "string");
  const effective = events.length ? events : [...SALES_REQUIRED_EVENTS]; // Retell's default when unset
  const missing = SALES_REQUIRED_EVENTS.filter((e) => !effective.includes(e));
  pf("webhook events", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `call events selected${events.length ? "" : " (Retell defaults)"}`, effective.join(","), SALES_REQUIRED_EVENTS.join(","));
  const missingTransfer = SALES_TRANSFER_EVENTS.filter((e) => !effective.includes(e));
  pf("transfer webhook events", missingTransfer.length === 0, missingTransfer.length ? `missing: ${missingTransfer.join(", ")} (a failed warm transfer would not create a callback task)` : "all 4 transfer events selected");
  const maxDur = n(agent.max_call_duration_ms) ?? 3_600_000; // Retell default 3600000
  pf("maximum call duration", maxDur === MAX_CALL_DURATION_MS, `Founder decision: 60 minutes${n(agent.max_call_duration_ms) === null ? " (Retell default)" : ""}`, `${Math.round(maxDur / 60_000)} min`, "60 min");
  const vm = agent.voicemail_option === null || agent.voicemail_option === undefined ? null : obj(agent.voicemail_option);
  const vmAction = vm ? obj(vm.action) : null;
  const vmType = vmAction ? s(vmAction.type) : null;
  const vmText = vmAction ? s(vmAction.text) ?? "" : "";
  if (!vm) pf("voicemail", false, "voicemail detection is off (voicemail_option unset): the agent would talk to answering machines", "off", "detection on + approved message");
  else if (vmType === "hangup") pf("voicemail", false, "detection on but the action is hang up; the Founder decided to leave an approved voicemail", "hangup", "static_text or prompt");
  else if (vmType === "static_text" || vmType === "prompt") {
    const ident = /crestmont/i.test(vmText), number = /\{\{\s*agent_number\s*\}\}|\+?1?[\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{4}/.test(vmText), ai = /\b(ai|artificial|automated|virtual assistant)\b/i.test(vmText);
    pf("voicemail", true, `approved ${vmType === "static_text" ? "fixed" : "generated"} message, ${vmText.length} characters (sha ${(await sha256Hex(vmText)).slice(0, 12)})`, vmType, "static_text or prompt");
    add("voicemail message content", ident && number && ai ? "PASS" : "FAIL", `identifies Crestmont: ${ident}; gives a callback number: ${number}; discloses AI: ${ai} (47 CFR 64.1200(b) identification and number; AI voices are artificial voices)`);
  } else add("voicemail", "UNVERIFIED", `voicemail_option present with action ${vmType ?? "unknown"}`);
  add("voice and language", "INFO", `voice ${s(agent.voice_id) ?? "?"}; language ${Array.isArray(agent.language) ? (agent.language as unknown[]).join("/") : s(agent.language) ?? "en-US (default)"}`);
  add("silence and interruption", "INFO", `end call after silence ${n(agent.end_call_after_silence_ms) ?? 600000} ms; reminder after ${n(agent.reminder_trigger_ms) ?? 10000} ms; interruption sensitivity ${n(agent.interruption_sensitivity) ?? 1}; responsiveness ${n(agent.responsiveness) ?? 1}; backchannel ${agent.enable_backchannel === true}; ring ${n(agent.ring_duration_ms) ?? 30000} ms; denoising ${s(agent.denoising_mode) ?? "default"}`);
  add("data storage", "INFO", `data_storage_setting = ${s(agent.data_storage_setting) ?? "everything (default)"}; PII redaction ${obj(agent.pii_config).mode ? `${s(obj(agent.pii_config).mode)} (${arr(obj(agent.pii_config).categories).length} categories)` : "off"}. The platform keeps transcripts only after record_consent; Retell's own retention is this setting (privacy decision for counsel)`);
  const pca = arr(agent.post_call_analysis_data).map(obj);
  const so = pca.find((x) => s(x.name) === "sales_outcome");
  add("post-call analysis", "INFO", pca.length ? `${pca.length} field(s): ${pca.map((x) => `${s(x.name)}:${s(x.type)}`).join(", ").slice(0, 300)}${so ? `; sales_outcome choices ${arr(so.choices).join("/")}` : "; no sales_outcome field (optional fallback)"}` : "none configured (optional)");
  const engine = obj(agent.response_engine);
  const llmId = s(engine.llm_id);
  pf("response engine", s(engine.type) === "retell-llm" && !!llmId, "the SIE manages prompts only on a retell-llm agent", `${s(engine.type) ?? "?"}${llmId ? ` ${llmId}` : ""}`, "retell-llm");
  if (!llmId) return out("issues", { agents, agentId });

  // 4. Published version (what real calls use) vs the draft.
  const versions = await call(key, d.fetch, "GET", `/get-agent-versions/${encodeURIComponent(agentId)}`);
  let publishedLlmVersion: number | null = null;
  if (!versions.ok) add("published agent version", "UNVERIFIED", `get-agent-versions: ${versions.error}`);
  else {
    const vs = items(versions.json).map(obj);
    const pub = vs.filter((v) => v.is_published === true).sort((a, b) => (n(b.version) ?? 0) - (n(a.version) ?? 0))[0];
    publishedLlmVersion = pub ? n(obj(pub.response_engine).version) : null;
    pf("published agent version", !!pub, pub ? `version ${n(pub.version)}${s(pub.version_title) ? ` "${s(pub.version_title)}"` : ""} is published (draft is version ${n(agent.version) ?? "?"})${publishedLlmVersion !== null ? `; it uses LLM version ${publishedLlmVersion}` : ""}` : "no published version: calls would use an unpublished draft", pub ? `v${n(pub.version)}` : "none", "a published version");
  }

  // 5. The LLM (published version when known): tools, default variables, prompt.
  const llmRes = await call(key, d.fetch, "GET", `/get-retell-llm/${encodeURIComponent(llmId)}${publishedLlmVersion !== null ? `?version=${publishedLlmVersion}` : ""}`);
  if (!llmRes.ok) { pf("get-retell-llm", false, `could not read LLM ${llmId}: ${llmRes.error}`); return out("failed", { agents, agentId, llmId }); }
  const llm = obj(llmRes.json);
  const tools = arr(llm.general_tools).map(obj);
  const contracts: Record<string, { fields: string[]; required: string[] }> = { ...outboundFunctionContracts(), record_consent: receptionistContracts().record_consent };
  const expected = [...EXPECTED_CUSTOM_FUNCTIONS] as string[];
  for (const name of expected) {
    const t = tools.find((x) => s(x.type) === "custom" && s(x.name) === name);
    if (!t) { pf(`function ${name}`, false, "not configured on the agent", "missing", "configured"); continue; }
    const problems: string[] = [];
    const rawUrl = s(t.url) ?? "";
    const url = rawUrl.split("?")[0];
    const wantUrl = name === "record_consent" ? want.consent : want.functions;
    if (url !== wantUrl) problems.push(`url ${rawUrl || "(none)"} (expected ${wantUrl})`);
    if ((s(t.method) ?? "POST") !== "POST") problems.push(`method ${s(t.method)}`);
    if (t.args_at_root === true) problems.push("'Payload: args only' is on (must be off: the signed call metadata binds the lead)");
    const timeout = n(t.timeout_ms) ?? 120_000;
    if (timeout < 5_000 || timeout > 30_000) problems.push(`timeout ${timeout} ms (use 10000)`);
    const retries = n(t.max_retry) ?? 0;
    if (retries > 2) problems.push(`max_retry ${retries} (use 1; 2 for record_do_not_call)`);
    const headers = Object.keys(obj(t.headers));
    if (headers.length) problems.push(`custom headers ${headers.join(", ")} (none are needed: Retell signs every request)`);
    const query = [...Object.keys(obj(t.query_params)), ...(rawUrl.includes("?") ? [...new URLSearchParams(rawUrl.split("?")[1]).keys()] : [])];
    const badQuery = query.filter((q) => q !== "lead_id" || name === "record_consent");
    if (badQuery.length) problems.push(`query parameters ${badQuery.join(", ")} (only lead_id={{lead_id}} is read, and not by record_consent)`);
    const params = obj(t.parameters), props = obj(params.properties);
    const req = arr(params.required).filter((x): x is string => typeof x === "string");
    const c = contracts[name];
    const unknown = Object.keys(props).filter((p) => !c.fields.includes(p));
    const missingReq = c.required.filter((r) => !(r in props));
    const extraReq = req.filter((r) => !c.required.includes(r));
    if (unknown.length) problems.push(`parameters the backend ignores: ${unknown.join(", ")}`);
    if (missingReq.length) problems.push(`required by the backend but missing from the schema: ${missingReq.join(", ")}`);
    if (extraReq.length) problems.push(`marked required in Retell but optional in the backend: ${extraReq.join(", ")}`);
    for (const [field, allowed] of Object.entries(OUTBOUND_FUNCTION_ENUMS[name] ?? {})) {
      const p = obj(props[field]);
      const offered = arr(p.enum ?? obj(p.items).enum).filter((x): x is string => typeof x === "string");
      const bad = offered.filter((x) => !allowed.includes(x));
      if (bad.length) problems.push(`${field} offers values the backend refuses: ${bad.join(", ")}`);
    }
    if (name === "record_consent" && s(obj(props.consent).type) !== "boolean") problems.push(`consent must be type boolean (is ${s(obj(props.consent).type) ?? "unset"}); the backend refuses anything else`);
    if (!(s(t.description) ?? "").trim()) problems.push("no description (the model decides when to call it from the description)");
    const exec = `timeout ${timeout} ms, retries ${retries}, speak during execution ${t.speak_during_execution === true}, typing sound ${t.enable_typing_sound === true}`;
    pf(`function ${name}`, problems.length === 0, problems.length ? problems.join("; ") : `matches the backend (${exec})`);
    if (name === "record_consent") {
      add("record_consent settings", t.speak_during_execution === true || t.enable_typing_sound === true || (s(t.description) ?? "").trim() !== RECORD_CONSENT_DESCRIPTION ? "FAIL" : "PASS",
        `Founder register: description exact, talk while waiting OFF, typing sound OFF. description ${(s(t.description) ?? "").trim() === RECORD_CONSENT_DESCRIPTION ? "exact" : "differs"}; ${exec}`);
    }
  }
  const strays = tools.filter((x) => s(x.type) === "custom" && !expected.includes(s(x.name) ?? ""));
  if (strays.length) pf("unexpected custom functions", false, strays.map((x) => `${s(x.name)} → ${s(x.url) ?? "?"}`).join("; "));
  pf("End Call tool", tools.some((x) => s(x.type) === "end_call"), "built-in end_call", tools.some((x) => s(x.type) === "end_call") ? "present" : "missing", "present");
  const transfer = tools.find((x) => s(x.type) === "transfer_call");
  if (!transfer) pf("Warm Transfer", false, "transfer_call is missing", "missing", "warm_transfer");
  else {
    const opt = obj(transfer.transfer_option), dest = obj(transfer.transfer_destination);
    const destType = s(dest.type), num = s(dest.number);
    const destLabel = destType === "predefined" ? (num && /\{\{/.test(num) ? `dynamic ${num}` : `number ${last4(num)}`) : destType === "inferred" ? "inferred from a prompt" : "unknown";
    const selfDest = destType === "predefined" && num && settings.from_number && e164(num) === e164(settings.from_number);
    pf("Warm Transfer", s(opt.type) === "warm_transfer" && !selfDest && (destType === "inferred" || !!num),
      `type ${s(opt.type) ?? "?"}; destination ${destLabel}${selfDest ? " (the agent's own caller number!)" : ""}; whisper to staff ${opt.private_handoff_option ? "set" : "none"}; caller handoff ${opt.public_handoff_option ? "set" : "none"}; ring ${n(opt.transfer_ring_duration_ms) ?? "default"} ms. A cancelled transfer creates an urgent CRM callback task (transfer_cancelled)`, s(opt.type) ?? "?", "warm_transfer");
  }
  const dv = obj(llm.default_dynamic_variables);
  const dvKeys = Object.keys(dv);
  pf("Default Dynamic Variables", dvKeys.length === 0, dvKeys.length ? `Founder decision is NONE; found ${dvKeys.join(", ")}` : "none (Founder decision); the dialler sends the lead's variables on every call", String(dvKeys.length), "0");
  add("knowledge base", "INFO", `${arr(llm.knowledge_base_ids).length} knowledge base(s) attached${obj(llm.kb_config).top_k ? `; top_k ${n(obj(llm.kb_config).top_k)}` : ""}`);
  add("speak first", "INFO", `start_speaker = ${s(llm.start_speaker) ?? "?"}; begin message ${llm.begin_message === "" ? "empty string (waits for the person)" : s(llm.begin_message) ? `set (${(s(llm.begin_message) ?? "").length} characters)` : "unset (generated)"}; begin_after_user_silence_ms ${n(llm.begin_after_user_silence_ms) ?? "unset"}; model ${s(obj(llm.model_config).primary) ?? s(llm.model) ?? "?"}`);
  add("LLM published flag", llm.is_published === true ? "PASS" : llm.is_published === false ? "FAIL" : "UNVERIFIED", `LLM version ${n(llm.version) ?? "?"} read${publishedLlmVersion !== null ? " (the published agent's version)" : " (draft)"}; is_published ${String(llm.is_published)}`);

  // Prompt (Founder V17 authoritative): usable, consistent with the tools and per-call variables, adopted by the SIE.
  const prompt = s(llm.general_prompt) ?? "";
  const sha = await sha256Hex(prompt);
  const a = analysePrompt(prompt, expected);
  add("prompt identity", prompt.trim() ? "PASS" : "FAIL", `"${a.title}" — ${prompt.length} characters, sha ${sha.slice(0, 16)}; V17 marker ${a.v17 ? "present" : "absent"}`, a.v17 ? "V17" : "no V17 marker", "V17");
  pf("prompt variables supplied per call", a.unsupplied.length === 0, a.unsupplied.length ? `{{${a.unsupplied.join("}}, {{")}}} are not sent by the dialler and have no default: Retell would speak them literally` : `uses ${a.vars.length} variable(s), all sent per call or Retell system variables: ${a.vars.join(", ") || "none"}`);
  pf("prompt names every function", a.missingTools.length === 0 && /\btransfer_call\b/.test(prompt) && /\bend_call\b/.test(prompt),
    `${a.missingTools.length ? `not mentioned: ${a.missingTools.join(", ")}; ` : "all nine custom functions mentioned; "}transfer_call ${/\btransfer_call\b/.test(prompt) ? "mentioned" : "NOT mentioned"}; end_call ${/\bend_call\b/.test(prompt) ? "mentioned" : "NOT mentioned"}`);
  pf("prompt names no missing function", a.unknownTools.length === 0, a.unknownTools.length ? `refers to functions this agent does not have: ${a.unknownTools.join(", ")}` : "no reference to a function or MCP the agent lacks");
  const deployed = await deployedVersion(d.db, stage);
  if (!target) pf("SIE target registered", false, `register ${agentId} as the ${stage} target on /staff/sales-optimization, then Verify with Retell (verification adopts the live prompt)`, "none", agentId);
  else if (target.agent_id !== agentId) pf("SIE target registered", false, `SIE ${stage} target ${target.agent_id} differs from the sales agent ${agentId}`, target.agent_id, agentId);
  else pf("SIE target registered", !!target.verified_at, target.verified_at ? `verified ${target.verified_at}` : "registered but not verified (press Verify with Retell)");
  if (target && target.agent_id === agentId) {
    const cur = deployed ? promptOf(deployed) : null;
    pf("SIE current version = live prompt", !!deployed && cur === prompt,
      !deployed ? "the SIE has no current version for this agent: Verify with Retell adopts the live prompt so no older version can replace it"
        : cur === prompt ? `live prompt is SIE v${deployed.seq}${deployed.prompt_mode === "external" ? " (Founder prompt, adopted verbatim)" : ""}` : `live prompt differs from SIE v${deployed.seq}: press "Adopt live prompt" on /staff/sales-optimization (the engine refuses to deploy over it until then)`,
      deployed ? `v${deployed.seq}` : "none", "the live prompt");
  }

  // 6. Caller number and capacity.
  const nums = await call(key, d.fetch, "GET", "/v2/list-phone-numbers?limit=100");
  if (!nums.ok) add("caller number", "UNVERIFIED", `list-phone-numbers failed: ${nums.error}`);
  else {
    const all = items(nums.json).map(obj);
    const wantNumber = e164(settings.from_number) ?? e164(d.expectedCallerNumber ?? null);
    const found = wantNumber ? all.find((x) => e164(s(x.phone_number)) === wantNumber) : null;
    add("phone numbers in the outbound workspace", "INFO", all.length ? all.map((x) => `${last4(x.phone_number)} (outbound agents: ${arr(x.outbound_agents).map((o) => s(obj(o).agent_id)).join("/") || "none"}; inbound agents: ${arr(x.inbound_agents).map((o) => s(obj(o).agent_id)).join("/") || "none"}; inbound webhook ${s(x.inbound_webhook_url) ? "set" : "none"})`).join("; ") : "none");
    if (!wantNumber) pf("caller number", false, "no caller number in /staff/sales-outbound and none expected", "(none)", "the outbound number");
    else {
      pf(`caller number ${last4(wantNumber)} in the outbound workspace`, !!found, found ? `present (${s(found.phone_number_type) ?? "?"})` : "not found in the outbound workspace (create-phone-call would fail)");
      if (found) {
        const bound = arr(found.outbound_agents).some((o) => s(obj(o).agent_id) === agentId);
        add(`caller number ${last4(wantNumber)} outbound agent`, "INFO", bound ? "bound to the sales agent" : "not bound to the sales agent (not required: the dialler sets override_agent_id on every call)");
      }
      pf("caller number recorded", !!settings.from_number && e164(settings.from_number) === wantNumber, settings.from_number ? `/staff/sales-outbound uses ${last4(settings.from_number)}` : `save ${last4(wantNumber)} in /staff/sales-outbound`, settings.from_number ? last4(settings.from_number) : "(none)", last4(wantNumber));
    }
  }
  const conc = await call(key, d.fetch, "GET", "/get-concurrency");
  if (conc.ok) {
    const lim = n(obj(conc.json).concurrency_limit), curC = n(obj(conc.json).current_concurrency);
    add("concurrency", "INFO", `Retell limit ${lim ?? "?"} (in use ${curC ?? "?"}); platform cap max_concurrent ${settings.max_concurrent}; Founder target 20${lim !== null && lim < 20 ? ` — the account allows only ${lim}` : ""}`);
  } else add("concurrency", "UNVERIFIED", `get-concurrency: ${conc.error}`);
  return out(findings.every((f) => f.ok) ? "ok" : "issues", { agents, agentId, llmId });
}
