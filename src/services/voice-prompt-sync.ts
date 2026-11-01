// Prompt synchronisation with Retell (CREST-GAP-053; VOICE-004/005).
//
// The platform's active configuration version (guardrails + instructions, src/services/voice.ts#composePrompt)
// is the source of truth. "push" writes it to the Retell LLM behind this environment's agent
// (update-retell-llm general_prompt) and reads it back; "check" only reads it back. Either way the read-back
// is compared with the composed prompt and the result is recorded in voice_prompt_syncs:
//   in_sync        the Retell LLM's general_prompt equals the active version exactly
//   drift          it differs (someone edited it in the Retell dashboard, or a push did not stick)
//   failed         a Retell call failed (status and sanitised message recorded)
//   not_configured nothing was sent: RETELL_INBOUND_API_KEY not set, no agent id recorded, or no active version
// No outcome is ever reported as success unless Retell's own read-back matches. Drift and failures notify
// the Owners and appear on /staff/voice and the monitoring page.
import { VOICE_GUARDRAILS } from "./voice.ts";
import { retellKey } from "../adapters/retell-workspaces.ts";
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { sha256Hex } from "../lib/crypto.ts";
import type { Env } from "../app/context.ts";
import { getRetellAgent, getRetellLlm, updateRetellLlmPrompt } from "../adapters/retell.ts";
import { loadVoiceConfig, salesAgentIds } from "./voice-settings.ts";
import { audit } from "./security.ts";
import { notifyOwners } from "./voice-common.ts";

export type PromptSyncStatus = "in_sync" | "drift" | "failed" | "not_configured";
export interface PromptSyncResult { status: PromptSyncStatus; detail: string; version: number | null }
export interface PromptSyncRow { status: PromptSyncStatus; mode: "push" | "check"; detail: string; config_version: number | null; agent_id: string | null; llm_id: string | null; llm_version: number | null; created_at: string }

export const PROVIDER_NOT_CONFIGURED = "Retell provider not configured: RETELL_INBOUND_API_KEY is not set in this environment (the receptionist workspace key). Nothing was sent to Retell.";

const short = async (s: string) => (await sha256Hex(s)).slice(0, 16);

/**
 * push           write the active version, unless Retell's prompt was edited in the dashboard since the platform last
 *                synced it (then nothing is written and the result is "drift")
 * push_overwrite the Owner confirmed replacing a dashboard-edited prompt with the active version
 * check          read only
 * adopt          record Retell's live prompt as a new, active platform version WITHOUT writing to Retell (the Founder
 *                maintains the prompt in the Retell dashboard; Founder decision 2026-10-31)
 */
export type SyncMode = "push" | "push_overwrite" | "check" | "adopt";
/** voice_prompt_syncs.mode allows push | check (migration 0042): an overwrite is a push, an adoption is read-only. */
const storedMode = (m: SyncMode): "push" | "check" => (m === "push" || m === "push_overwrite" ? "push" : "check");

export async function syncPrompt(d: { db: Db; env: Pick<Env, "RETELL_INBOUND_API_KEY" | "ENVIRONMENT">; fetch: typeof fetch; userId: string | null; mode: SyncMode }): Promise<PromptSyncResult> {
  const active = await d.db.prepare(`SELECT version, prompt_text FROM voice_agent_configs WHERE active = 1`).first<{ version: number; prompt_text: string }>();
  const cfg = await loadVoiceConfig(d.db);
  const agentId = cfg.inbound.agent_id ?? cfg.outbound.agent_id;
  const record = async (status: PromptSyncStatus, detail: string, extra: { llmId?: string | null; llmVersion?: number | null; expected?: string | null; remote?: string | null } = {}): Promise<PromptSyncResult> => {
    await d.db.prepare(`INSERT INTO voice_prompt_syncs (id, config_version, mode, status, detail, agent_id, llm_id, llm_version, expected_sha256, remote_sha256, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(newId("vps"), active?.version ?? null, storedMode(d.mode), status, detail.slice(0, 1000), agentId, extra.llmId ?? null, extra.llmVersion ?? null, extra.expected ?? null, extra.remote ?? null, d.userId, nowIso()).run();
    await audit(d.db, { actorUserId: d.userId, actorKind: d.userId ? "user" : "system", action: "voice.prompt_sync", subjectType: "voice_agent_config", subjectId: active ? String(active.version) : null, details: { mode: d.mode, status, environment: d.env.ENVIRONMENT } });
    if (status === "drift" || status === "failed") {
      await notifyOwners(d.db, `voice_prompt_${status}`, status === "drift"
        ? `The Retell agent's prompt does not match active configuration v${active?.version}. Push it again from the AI receptionist page or review the change made in Retell.`
        : `Pushing or checking the AI receptionist prompt in Retell failed: ${detail.slice(0, 200)}`, "voice_agent_config", String(active?.version ?? ""));
    }
    return { status, detail, version: active?.version ?? null };
  };
  // The receptionist agent lives in the inbound workspace: only that key is ever used here (retell-workspaces.ts).
  const key = retellKey(d.env, "inbound");
  if (!key) return record("not_configured", PROVIDER_NOT_CONFIGURED);
  if (!active && d.mode !== "adopt") return record("not_configured", "No configuration version is active. Activate one first, or adopt the live Retell prompt; nothing was sent to Retell.");
  if (!agentId) return record("not_configured", "No Retell agent id is recorded for this environment (Operations → inbound agent id). Nothing was sent to Retell.");
  // Isolation: the receptionist prompt (VOICE_GUARDRAILS names receptionist-only functions like route_support) is never
  // written to a sales agent, even if a sales agent id was stored in a receptionist field before this check existed.
  if ((await salesAgentIds(d.db)).has(agentId)) return record("failed", `Agent ${agentId} is registered as a sales agent (sales optimizer or outbound sales). The receptionist prompt is never written to a sales agent; nothing was sent to Retell. Set the receptionist's own agent id in Operations.`);
  const expected = active ? await short(active.prompt_text) : null;
  const agent = await getRetellAgent({ apiKey: key, fetch: d.fetch, agentId });
  if (!agent.ok) return record("failed", `Reading agent ${agentId}: ${agent.error}`, { expected });
  const engine = agent.body.response_engine ?? {};
  if (engine.type !== "retell-llm" || !engine.llm_id) return record("failed", `Agent ${agentId} does not use a Retell LLM response engine (type ${String(engine.type ?? "unknown").slice(0, 30)}); the prompt cannot be synchronised.`, { expected });
  const llmId = engine.llm_id;
  if (d.mode === "adopt") return adopt(d, record, key, agentId, llmId);
  if (!active) return record("not_configured", "No configuration version is active.");
  if (d.mode === "push") {
    // Drift guard: never silently replace a prompt the Founder edited in the Retell dashboard. The last prompt the platform
    // knows to be in Retell is the remote hash of the latest in_sync record for this LLM.
    const before = await getRetellLlm({ apiKey: key, fetch: d.fetch, llmId });
    if (!before.ok) return record("failed", `Reading LLM ${llmId} before writing: ${before.error}`, { llmId, expected });
    const live = typeof before.body.general_prompt === "string" ? before.body.general_prompt : "";
    if (live.trim() && live !== active.prompt_text) {
      const known = await d.db.prepare(`SELECT remote_sha256 FROM voice_prompt_syncs WHERE llm_id = ? AND status = 'in_sync' AND remote_sha256 IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(llmId).first<{ remote_sha256: string }>();
      const liveSha = await short(live);
      if (!known || known.remote_sha256 !== liveSha) {
        return record("drift", `Not written: the Retell prompt on LLM ${llmId} (${liveSha}) was set or edited in the Retell dashboard and is not a version this platform pushed. To keep it, adopt the live Retell prompt; to replace it with v${active.version}, choose "Overwrite Retell with the active version".`, { llmId, expected, remote: liveSha });
      }
    }
  }
  if (d.mode === "push" || d.mode === "push_overwrite") {
    const up = await updateRetellLlmPrompt({ apiKey: key, fetch: d.fetch, llmId, generalPrompt: active.prompt_text });
    if (!up.ok) return record("failed", `Updating LLM ${llmId}: ${up.error}`, { llmId, expected });
  }
  const back = await getRetellLlm({ apiKey: key, fetch: d.fetch, llmId });
  if (!back.ok) return record("failed", `Reading back LLM ${llmId}: ${back.error}`, { llmId, expected });
  const remoteText = typeof back.body.general_prompt === "string" ? back.body.general_prompt : "";
  const remote = await short(remoteText);
  const llmVersion = typeof back.body.version === "number" ? back.body.version : null;
  const published = back.body.is_published === true ? "published" : "draft (not published)";
  if (remoteText === active.prompt_text) {
    return record("in_sync", `Retell LLM ${llmId} (version ${llmVersion ?? "unknown"}, ${published}) matches configuration v${active.version}.`, { llmId, llmVersion, expected, remote });
  }
  return record("drift", `Retell LLM ${llmId} (version ${llmVersion ?? "unknown"}) does not match configuration v${active.version} (expected ${expected}, Retell has ${remote}).`, { llmId, llmVersion, expected, remote });
}

export async function latestPromptSync(db: Db): Promise<PromptSyncRow | null> {
  return db.prepare(`SELECT status, mode, detail, config_version, agent_id, llm_id, llm_version, created_at FROM voice_prompt_syncs ORDER BY created_at DESC, rowid DESC LIMIT 1`).first<PromptSyncRow>();
}


type Recorder = (status: PromptSyncStatus, detail: string, extra?: { llmId?: string | null; llmVersion?: number | null; expected?: string | null; remote?: string | null }) => Promise<PromptSyncResult>;

/** Records Retell's live prompt as the active platform version. Reads only; never writes to Retell. */
async function adopt(d: { db: Db; fetch: typeof fetch; userId: string | null }, record: Recorder, key: string, agentId: string, llmId: string): Promise<PromptSyncResult> {
  if (!d.userId) return record("failed", "Adopting the live prompt is an Owner action.");
  const llm = await getRetellLlm({ apiKey: key, fetch: d.fetch, llmId });
  if (!llm.ok) return record("failed", `Reading LLM ${llmId}: ${llm.error}`, { llmId });
  const text = typeof llm.body.general_prompt === "string" ? llm.body.general_prompt : "";
  if (!text.trim()) return record("failed", `LLM ${llmId} has no prompt to adopt.`, { llmId });
  const sha = await short(text);
  const current = await d.db.prepare(`SELECT version, prompt_text FROM voice_agent_configs WHERE active = 1`).first<{ version: number; prompt_text: string }>();
  const llmVersion = typeof llm.body.version === "number" ? llm.body.version : null;
  if (current?.prompt_text === text) return record("in_sync", `The live Retell prompt is already active configuration v${current.version}.`, { llmId, llmVersion, expected: sha, remote: sha });
  const next = ((await d.db.prepare(`SELECT MAX(version) AS v FROM voice_agent_configs`).first<{ v: number | null }>())?.v ?? 0) + 1;
  const at = nowIso();
  const guard = text.startsWith(VOICE_GUARDRAILS) ? "includes the platform guardrails" : "does not begin with the platform guardrails block (the guardrails are still enforced by every function)";
  await d.db.batch([
    d.db.prepare(`UPDATE voice_agent_configs SET active = 0 WHERE active = 1`),
    d.db.prepare(`INSERT INTO voice_agent_configs (id, version, prompt_text, change_note, created_by, created_at, active, activated_by, activated_at) VALUES (?,?,?,?,?,?,1,?,?)`)
      .bind(newId("vac"), next, text, `Adopted the live Retell prompt from agent ${agentId}, LLM ${llmId}${llmVersion !== null ? ` v${llmVersion}` : ""} (${sha}); ${guard}.`.slice(0, 300), d.userId, at, d.userId, at),
  ]);
  return record("in_sync", `Adopted the live Retell prompt (${sha}) as active configuration v${next}. Nothing was written to Retell. It ${guard}.`, { llmId, llmVersion, expected: sha, remote: sha });
}
