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

/** Optional per-call settings (backward compatible): a multi-turn conversation instead of a single prompt, a smaller
 *  output budget and a shorter timeout — used by the public website assistant (services/assistant.ts). */
export interface AiCallOptions { messages?: { role: "user" | "assistant"; content: string }[]; maxTokens?: number; timeoutMs?: number }
export interface AiProvider { readonly name: string; readonly model: string; complete(system: string, prompt: string, opts?: AiCallOptions): Promise<{ text: string; inputTokens: number; outputTokens: number }> }

/** Per-million-token prices in USD for models whose price the platform knows. A paid model not listed here is refused,
 *  because the monthly budget could not be enforced for it (unknown ≠ zero). */
export const MODEL_PRICES_USD_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-sonnet-5-5": { input: 3, output: 15 },
};
export const priceKnown = (model: string) => Object.prototype.hasOwnProperty.call(MODEL_PRICES_USD_PER_MTOK, model);
/** micro-USD for a call (1 token at $X/MTok = X micro-USD). */
export const costMicroUsd = (model: string, inputTokens: number, outputTokens: number) => {
  const p = MODEL_PRICES_USD_PER_MTOK[model];
  return p ? Math.round(inputTokens * p.input + outputTokens * p.output) : null;
};

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly model: string;
  private key: string; private fetchImpl: typeof fetch; private sleep: (ms: number) => Promise<void>;
  constructor(key: string, model = "claude-sonnet-5-5", fetchImpl: typeof fetch = fetch, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
    if (!/^[a-z0-9][a-z0-9.-]{2,63}$/.test(model)) throw new Error("AI_MODEL is not a valid model id");
    this.key = key; this.model = model; this.fetchImpl = fetchImpl; this.sleep = sleep;
  }
  async complete(system: string, prompt: string, opts: AiCallOptions = {}) {
    // One retry for rate limits, overload and transient errors, honouring retry-after up to 10 s; 60 s timeout per call.
    for (let attempt = 1; ; attempt++) {
      let r: Response;
      try {
        r = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": this.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: this.model, max_tokens: opts.maxTokens ?? 1500, system, messages: opts.messages ?? [{ role: "user", content: prompt }] }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
        });
      } catch (e) {
        if (attempt < 2 && !opts.timeoutMs) { await this.sleep(2_000); continue; }
        throw new Error(`Anthropic request failed: ${(e as Error).name === "TimeoutError" ? `timed out after ${Math.round((opts.timeoutMs ?? 60_000) / 1000)} s` : (e as Error).message}`);
      }
      const body = (await r.json().catch(() => ({}))) as { content?: { type: string; text?: string }[]; usage?: { input_tokens: number; output_tokens: number }; error?: { message: string } };
      if (!r.ok) {
        if (attempt < 2 && RETRYABLE.has(r.status) && !opts.timeoutMs) { await this.sleep(Math.min(10_000, Math.max(1_000, Number(r.headers.get("retry-after") ?? 2) * 1000))); continue; }
        throw new Error(`Anthropic ${r.status}: ${body.error?.message ?? "error"}`);
      }
      return { text: (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n"), inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 };
    }
  }
}

/** Owner-set monthly cap for paid AI drafting, in USD (business setting `ai.monthly_budget_usd`). Paid calls are refused
 *  when it is unset (fail closed) or when this calendar month's recorded spend has reached it. */
export async function paidAiBudget(db: Db, now = new Date()): Promise<{ budgetMicro: number | null; spentMicro: number }> {
  const row = await db.prepare(`SELECT value FROM business_settings WHERE key = 'ai.monthly_budget_usd'`).first<{ value: string }>().catch(() => null);
  const n = row ? Number(row.value) : NaN;
  const month = now.toISOString().slice(0, 7);
  const spent = await db.prepare(`SELECT COALESCE(SUM(cost_microusd), 0) AS s FROM ai_jobs WHERE provider = 'anthropic' AND substr(created_at, 1, 7) = ?`).bind(month).first<{ s: number }>();
  return { budgetMicro: Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000) : null, spentMicro: spent?.s ?? 0 };
}

const SYSTEM_BASE = `You draft text for Crestmont Website Development staff. Your output is a draft that a human will review before anything is sent or saved.
Rules: never invent prices, discounts, delivery dates, guarantees, customer facts or project status; use only the facts provided.
Never approve or promise refunds, never agree to contracts, never authorise releases. If the request needs one of those, say a staff member will follow up.`;

export interface AiDraftRequest { workflow: AiWorkflow; inputRef: string; prompt: string; requestedBy: string | null }

/** The self-hosted model behind the build runner (no per-token fee). Jobs are queued and leased to the runner. */
export const LOCAL_RUNNER = "local-runner" as const;
export type AiBackend = AiProvider | typeof LOCAL_RUNNER | null;
export const AI_SYSTEM_PROMPT = SYSTEM_BASE;

export async function requestAiDraft(db: Db, provider: AiBackend, req: AiDraftRequest): Promise<{ jobId: string; status: "awaiting_approval" | "failed" | "queued"; text: string | null; error: string | null }> {
  if (!(AI_WORKFLOWS as readonly string[]).includes(req.workflow)) throw new Error("Unknown AI workflow");
  const jobId = newId("ai");
  const at = nowIso();
  if (provider === LOCAL_RUNNER) {
    await db.batch([
      db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, created_at, updated_at) VALUES (?,?, 'local-runner', 'self-hosted', 'queued', ?, ?, ?)`).bind(jobId, req.workflow, req.inputRef, at, at),
      db.prepare(`INSERT INTO ai_job_inputs (job_id, prompt, created_at) VALUES (?,?,?) ON CONFLICT(job_id) DO NOTHING`).bind(jobId, req.prompt.slice(0, 20_000), at),
    ]);
    await audit(db, { actorUserId: req.requestedBy, actorKind: "ai", action: "ai.draft_queued", subjectType: "ai_job", subjectId: jobId, details: { workflow: req.workflow, backend: LOCAL_RUNNER } });
    return { jobId, status: "queued", text: null, error: null };
  }
  await db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, created_at, updated_at) VALUES (?,?,?,?, 'running', ?, ?, ?)`)
    .bind(jobId, req.workflow, provider?.name ?? "none", provider?.model ?? "none", req.inputRef, at, at).run();
  if (!provider) {
    await db.prepare(`UPDATE ai_jobs SET status='failed', error='not_configured: no AI provider key is set', updated_at=? WHERE id=?`).bind(nowIso(), jobId).run();
    return { jobId, status: "failed", text: null, error: "AI drafting is not configured (no provider API key)." };
  }
  if (provider.name === "anthropic") {
    const refuse = async (error: string, msg: string) => {
      await db.prepare(`UPDATE ai_jobs SET status='failed', error=?, updated_at=? WHERE id=?`).bind(error, nowIso(), jobId).run();
      return { jobId, status: "failed" as const, text: null, error: msg };
    };
    if (!priceKnown(provider.model)) return refuse(`not_configured: price of model ${provider.model} is unknown, so the budget cannot be enforced`, "This AI model's price is unknown to the platform, so paid drafting is refused.");
    const b = await paidAiBudget(db);
    if (b.budgetMicro === null) return refuse("not_configured: no monthly AI budget is set (ai.monthly_budget_usd)", "Paid AI drafting needs a monthly budget set by the Owner on the AI operations page.");
    if (b.spentMicro >= b.budgetMicro) return refuse("budget_exhausted: this month's AI budget is used up", "This month's AI budget is used up. The Owner can raise it on the AI operations page.");
  }
  try {
    const out = await provider.complete(SYSTEM_BASE, req.prompt.slice(0, 20_000));
    // Cost in micro-USD from the known price table; NULL when the model's price is not known to the platform.
    const cost = costMicroUsd(provider.model, out.inputTokens, out.outputTokens);
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

/**
 * The AI backend is chosen explicitly — a paid provider is never switched on just because a key exists:
 *   AI_PROVIDER = "local-runner" → self-hosted model via the build runner (needs BUILD_RUNNER_SECRET); no paid fallback.
 *   AI_PROVIDER = "anthropic"    → Anthropic Messages API (needs ANTHROPIC_API_KEY; calls also need an Owner budget).
 *   unset / anything else        → AI drafting off.
 */
export function aiProviderFromEnv(env: { ANTHROPIC_API_KEY?: string; AI_MODEL?: string; AI_PROVIDER?: string; BUILD_RUNNER_SECRET?: string }): AiBackend {
  if (env.AI_PROVIDER === LOCAL_RUNNER) return env.BUILD_RUNNER_SECRET ? LOCAL_RUNNER : null;
  if (env.AI_PROVIDER === "anthropic" && env.ANTHROPIC_API_KEY) {
    try { return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.AI_MODEL); } catch { return null; } // invalid AI_MODEL → off
  }
  return null;
}
