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

export async function syncPrompt(d: { db: Db; env: Pick<Env, "RETELL_INBOUND_API_KEY" | "ENVIRONMENT">; fetch: typeof fetch; userId: string | null; mode: "push" | "check" }): Promise<PromptSyncResult> {
  const active = await d.db.prepare(`SELECT version, prompt_text FROM voice_agent_configs WHERE active = 1`).first<{ version: number; prompt_text: string }>();
  const cfg = await loadVoiceConfig(d.db);
  const agentId = cfg.inbound.agent_id ?? cfg.outbound.agent_id;
  const record = async (status: PromptSyncStatus, detail: string, extra: { llmId?: string | null; llmVersion?: number | null; expected?: string | null; remote?: string | null } = {}): Promise<PromptSyncResult> => {
    await d.db.prepare(`INSERT INTO voice_prompt_syncs (id, config_version, mode, status, detail, agent_id, llm_id, llm_version, expected_sha256, remote_sha256, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(newId("vps"), active?.version ?? null, d.mode, status, detail.slice(0, 1000), agentId, extra.llmId ?? null, extra.llmVersion ?? null, extra.expected ?? null, extra.remote ?? null, d.userId, nowIso()).run();
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
  if (!active) return record("not_configured", "No configuration version is active. Activate one first; nothing was sent to Retell.");
  if (!agentId) return record("not_configured", "No Retell agent id is recorded for this environment (Operations → inbound agent id). Nothing was sent to Retell.");
  // Isolation: the receptionist prompt (VOICE_GUARDRAILS names receptionist-only functions like route_support) is never
  // written to a sales agent, even if a sales agent id was stored in a receptionist field before this check existed.
  if ((await salesAgentIds(d.db)).has(agentId)) return record("failed", `Agent ${agentId} is registered as a sales agent (sales optimizer or outbound sales). The receptionist prompt is never written to a sales agent; nothing was sent to Retell. Set the receptionist's own agent id in Operations.`);
  const expected = await short(active.prompt_text);
  const agent = await getRetellAgent({ apiKey: key, fetch: d.fetch, agentId });
  if (!agent.ok) return record("failed", `Reading agent ${agentId}: ${agent.error}`, { expected });
  const engine = agent.body.response_engine ?? {};
  if (engine.type !== "retell-llm" || !engine.llm_id) return record("failed", `Agent ${agentId} does not use a Retell LLM response engine (type ${String(engine.type ?? "unknown").slice(0, 30)}); the prompt cannot be synchronised.`, { expected });
  const llmId = engine.llm_id;
  if (d.mode === "push") {
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
