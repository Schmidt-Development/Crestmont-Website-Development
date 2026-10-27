// Bounded AI workflows (AIOPS-001..003). Every call is an ai_jobs row with provider, model, status,
// input/output references, cost and retries. AI output is always a DRAFT that a human approves;
// AI can never execute refunds, contracts, pricing changes or releases (enforced in authz.ts).
// Provider: Anthropic Messages API when ANTHROPIC_API_KEY is configured; otherwise jobs fail
// with "not_configured" — nothing is fabricated.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";

export const AI_WORKFLOWS = ["lead_qualification", "quote_draft", "content_draft", "requirement_analysis", "task_generation",
  "support_reply", "project_summary", "customer_update", "documentation", "qa_summary"] as const;
export type AiWorkflow = (typeof AI_WORKFLOWS)[number];

/** Actions an AI job is never allowed to request, whatever its prompt says. */
export const AI_FORBIDDEN = ["refund", "contract", "agreement execution", "production release", "price change"] as const;

export interface AiProvider { readonly name: string; readonly model: string; complete(system: string, prompt: string): Promise<{ text: string; inputTokens: number; outputTokens: number }> }

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly model: string;
  private key: string; private fetchImpl: typeof fetch;
  constructor(key: string, model = "claude-sonnet-5-5", fetchImpl: typeof fetch = fetch) { this.key = key; this.model = model; this.fetchImpl = fetchImpl; }
  async complete(system: string, prompt: string) {
    const r = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": this.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, max_tokens: 1500, system, messages: [{ role: "user", content: prompt }] }),
    });
    const body = (await r.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens: number; output_tokens: number }; error?: { message: string } };
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${body.error?.message ?? "error"}`);
    return { text: (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n"), inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 };
  }
}

const SYSTEM_BASE = `You draft text for Crestmont Website Development staff. Your output is a draft that a human will review before anything is sent or saved.
Rules: never invent prices, discounts, delivery dates, guarantees, customer facts or project status; use only the facts provided.
Never approve or promise refunds, never agree to contracts, never authorise releases. If the request needs one of those, say a staff member will follow up.`;

export interface AiDraftRequest { workflow: AiWorkflow; inputRef: string; prompt: string; requestedBy: string | null }

export async function requestAiDraft(db: Db, provider: AiProvider | null, req: AiDraftRequest): Promise<{ jobId: string; status: "awaiting_approval" | "failed"; text: string | null; error: string | null }> {
  if (!(AI_WORKFLOWS as readonly string[]).includes(req.workflow)) throw new Error("Unknown AI workflow");
  const jobId = newId("ai");
  const at = nowIso();
  await db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, created_at, updated_at) VALUES (?,?,?,?, 'running', ?, ?, ?)`)
    .bind(jobId, req.workflow, provider?.name ?? "none", provider?.model ?? "none", req.inputRef, at, at).run();
  if (!provider) {
    await db.prepare(`UPDATE ai_jobs SET status='failed', error='not_configured: no AI provider key is set', updated_at=? WHERE id=?`).bind(nowIso(), jobId).run();
    return { jobId, status: "failed", text: null, error: "AI drafting is not configured (no provider API key)." };
  }
  try {
    const out = await provider.complete(SYSTEM_BASE, req.prompt.slice(0, 20_000));
    // Rough cost, recorded in micro-USD; NULL when the model's price is not known to the platform.
    const cost = provider.model.startsWith("claude-sonnet") ? Math.round(out.inputTokens * 3 + out.outputTokens * 15) : null;
    await db.prepare(`UPDATE ai_jobs SET status='awaiting_approval', output_ref=?, cost_microusd=?, updated_at=? WHERE id=?`).bind(out.text, cost, nowIso(), jobId).run();
    await audit(db, { actorUserId: req.requestedBy, actorKind: "ai", action: "ai.draft_created", subjectType: "ai_job", subjectId: jobId, details: { workflow: req.workflow } });
    return { jobId, status: "awaiting_approval", text: out.text, error: null };
  } catch (e) {
    await db.prepare(`UPDATE ai_jobs SET status='failed', error=?, retries=retries+1, updated_at=? WHERE id=?`).bind((e as Error).message.slice(0, 1000), nowIso(), jobId).run();
    return { jobId, status: "failed", text: null, error: (e as Error).message };
  }
}

/** A human approves (optionally edited) AI output before it is used. */
export async function decideAiJob(db: Db, jobId: string, userId: string, decision: "approved" | "rejected", finalText?: string) {
  const res = await db.prepare(`UPDATE ai_jobs SET status=?, approved_by=?, output_ref=COALESCE(?, output_ref), updated_at=? WHERE id=? AND status='awaiting_approval'`)
    .bind(decision, userId, finalText ?? null, nowIso(), jobId).run();
  if (res.meta.changes !== 1) throw new Error("AI job is not awaiting approval");
  await audit(db, { actorUserId: userId, action: `ai.draft_${decision}`, subjectType: "ai_job", subjectId: jobId });
}

export function aiProviderFromEnv(env: { ANTHROPIC_API_KEY?: string; AI_MODEL?: string }): AiProvider | null {
  return env.ANTHROPIC_API_KEY ? new AnthropicProvider(env.ANTHROPIC_API_KEY, env.AI_MODEL) : null;
}
