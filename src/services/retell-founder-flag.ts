// Adds the optional `wants_founder` flag to the receptionist's two calendar-choosing tools in Retell (Founder directive
// 2026-11-06): schedule_consultation and request_callback. The backend routes wants_founder=true to the internal
// Founder Calendar and anything else (false, omitted, ambiguous) to the AI Outbound Calendar (src/domain/calendars.ts).
//
// Narrow by construction:
//   • only the receptionist agent recorded in /staff/voice/operations, in the inbound workspace; never a sales agent;
//   • read → modify ONE property on two tools → PATCH general_tools only (never the prompt or any other field) →
//     read back, and the result is accepted only when the two tools carry the flag and EVERY other tool, the prompt and
//     every other LLM setting are byte-for-byte what they were;
//   • the flag is optional (never added to `required`) and typed exactly as the platform documents its Retell booleans:
//     string enum "true"/"false" (wantsFounderArg also accepts a JSON boolean);
//   • idempotent: a tool that already has the flag is left untouched; `dryRun` reports the change without writing.
// Retell edits the draft: callers keep the PUBLISHED version until the Founder publishes the agent in Retell.
import type { Db } from "../lib/db.ts";
import type { Env } from "../app/context.ts";
import { RETELL_API_BASE } from "../adapters/retell.ts";
import { retellKey } from "../adapters/retell-workspaces.ts";
import { loadVoiceConfig, salesAgentIds } from "./voice-settings.ts";

export const FOUNDER_FLAG_TOOLS = ["schedule_consultation", "request_callback"] as const;
export const WANTS_FOUNDER_PROPERTY = {
  type: "string",
  enum: ["true", "false"],
  description: "\"true\" ONLY when the caller explicitly asks to speak with or meet the Founder (or the owner). Omit it, or \"false\", for every other booking or callback: those go to the AI Outbound Calendar.",
} as const;

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const s = (x: unknown) => (typeof x === "string" ? x : null);
const stable = (x: unknown): string => JSON.stringify(x, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

export interface FounderFlagResult {
  status: "updated" | "already_configured" | "would_update" | "refused" | "failed";
  agentId: string | null; llmId: string | null;
  tools: { name: string; before: "missing" | "present" | "not_on_agent"; after: "present" | "missing" | "unchanged" | "not_on_agent" }[];
  detail: string;
}

async function call(key: string, f: typeof fetch, method: "GET" | "PATCH", path: string, body?: unknown): Promise<{ ok: boolean; status: number | null; json: Obj; error?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const r = await f(`${RETELL_API_BASE}${path}`, { method, signal: ac.signal, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    let json: Obj = {};
    try { json = obj(JSON.parse(text)); } catch { /* not JSON */ }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json, error: r.ok ? undefined : `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, status: null, json: {}, error: (e as Error).name === "AbortError" ? "timed out" : "network error" };
  } finally { clearTimeout(timer); }
}

export async function addFounderFlag(d: { db: Db; env: Env; fetch: typeof fetch; dryRun: boolean }): Promise<FounderFlagResult> {
  const out = (status: FounderFlagResult["status"], detail: string, extra: Partial<FounderFlagResult> = {}): FounderFlagResult => ({ status, agentId: null, llmId: null, tools: [], detail, ...extra });
  const key = retellKey(d.env, "inbound");
  if (!key) return out("refused", "RETELL_INBOUND_API_KEY is not set on this Worker");
  const agentId = (await loadVoiceConfig(d.db)).inbound.agent_id;
  if (!agentId) return out("refused", "No receptionist agent id is recorded in /staff/voice/operations");
  if ((await salesAgentIds(d.db)).has(agentId)) return out("refused", "The recorded agent is registered as a sales agent; nothing was changed", { agentId });
  const agent = await call(key, d.fetch, "GET", `/get-agent/${encodeURIComponent(agentId)}`);
  if (!agent.ok) return out("failed", `could not read agent ${agentId}: ${agent.error}`, { agentId });
  const engine = obj(agent.json.response_engine);
  const llmId = s(engine.llm_id);
  if (s(engine.type) !== "retell-llm" || !llmId) return out("refused", "The receptionist is not a single-prompt Retell LLM agent; nothing was changed", { agentId });
  const before = await call(key, d.fetch, "GET", `/get-retell-llm/${encodeURIComponent(llmId)}`);
  if (!before.ok) return out("failed", `could not read LLM ${llmId}: ${before.error}`, { agentId, llmId });
  const tools = arr(before.json.general_tools).map(obj);
  const report: FounderFlagResult["tools"] = [];
  let changed = false;
  const next = tools.map((t) => {
    const name = s(t.name);
    if (s(t.type) !== "custom" || !name || !(FOUNDER_FLAG_TOOLS as readonly string[]).includes(name)) return t;
    const params = obj(t.parameters);
    const props = obj(params.properties);
    if (props.wants_founder) { report.push({ name, before: "present", after: "unchanged" }); return t; }
    changed = true;
    report.push({ name, before: "missing", after: "present" });
    // Only the one property is added; required (if any) is kept exactly as it was, so the flag stays optional.
    return { ...t, parameters: { ...params, type: s(params.type) ?? "object", properties: { ...props, wants_founder: { ...WANTS_FOUNDER_PROPERTY, enum: [...WANTS_FOUNDER_PROPERTY.enum] } } } };
  });
  for (const name of FOUNDER_FLAG_TOOLS) if (!report.some((r) => r.name === name)) report.push({ name, before: "not_on_agent", after: "not_on_agent" });
  if (!changed) return out("already_configured", report.some((r) => r.before === "not_on_agent") ? "nothing to add (a tool is not on the agent)" : "both tools already carry wants_founder", { agentId, llmId, tools: report });
  if (d.dryRun) return out("would_update", "dry run: nothing was written", { agentId, llmId, tools: report });
  const patch = await call(key, d.fetch, "PATCH", `/update-retell-llm/${encodeURIComponent(llmId)}`, { general_tools: next });
  if (!patch.ok) return out("failed", `Retell refused the update (${patch.error}); nothing is claimed as changed`, { agentId, llmId, tools: report });
  // Read back: the two tools carry the flag; everything else is unchanged.
  const after = await call(key, d.fetch, "GET", `/get-retell-llm/${encodeURIComponent(llmId)}`);
  if (!after.ok) return out("failed", `the update was sent but could not be read back (${after.error}); verify in Retell`, { agentId, llmId, tools: report });
  const afterTools = arr(after.json.general_tools).map(obj);
  const problems: string[] = [];
  for (const name of FOUNDER_FLAG_TOOLS) {
    const t = afterTools.find((x) => s(x.type) === "custom" && s(x.name) === name);
    const r = report.find((x) => x.name === name)!;
    if (r.before === "not_on_agent") continue;
    const p = obj(obj(obj(t?.parameters).properties).wants_founder);
    if (s(p.type) !== "string" || !arr(p.enum).includes("true")) { problems.push(`${name}: wants_founder not present after the update`); r.after = "missing"; }
    if (arr(obj(t?.parameters).required).includes("wants_founder")) problems.push(`${name}: wants_founder became required`);
    // The rest of the tool is unchanged.
    const was = tools.find((x) => s(x.name) === name)!;
    const strip = (x: Obj) => { const params = obj(x.parameters); const { wants_founder: _w, ...rest } = obj(params.properties); return { ...x, parameters: { ...params, properties: rest } }; };
    if (t && stable(strip(t)) !== stable(strip(was))) problems.push(`${name}: another field of the tool changed`);
  }
  const others = (xs: Obj[]) => xs.filter((x) => !(FOUNDER_FLAG_TOOLS as readonly string[]).includes(s(x.name) ?? ""));
  if (stable(others(afterTools)) !== stable(others(tools))) problems.push("another tool changed");
  if (s(after.json.general_prompt) !== s(before.json.general_prompt)) problems.push("the prompt changed");
  const { general_tools: _a, last_modification_timestamp: _ta, version: _va, ...restAfter } = after.json;
  const { general_tools: _b, last_modification_timestamp: _tb, version: _vb, ...restBefore } = before.json;
  if (stable(restAfter) !== stable(restBefore)) problems.push("another LLM setting changed");
  if (problems.length) return out("failed", `read-back mismatch: ${problems.join("; ")}`, { agentId, llmId, tools: report });
  return out("updated", "read-back confirms wants_founder on both tools; every other tool, the prompt and every other setting are unchanged. Retell saved this to the draft: publish the agent in Retell for callers to get it.", { agentId, llmId, tools: report });
}
