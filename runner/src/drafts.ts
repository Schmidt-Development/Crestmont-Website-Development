// AI drafts: short platform text jobs (support reply drafts, lead qualification notes, ... - table ai_jobs) served
// by the SELF-HOSTED model while the runner is idle between builds. One draft at a time, never during a build, so the
// machine's configured concurrency (one build or one draft) is never exceeded.
//
// The model call has NO tools: system message exactly as the platform gave it, user message exactly as given (it is
// untrusted data; nothing in it is executed - there is nothing to execute), low temperature, max tokens from the job.
// No cost is reported: the platform records $0 per-token cost for local inference. Drafts land in owner approval
// on the platform side; the runner never sends anything to customers.
// The paid path (RUNNER_AI_DRAFTS_PROVIDER=claude) is not implemented in the runner: it is refused unless
// RUNNER_ALLOW_PAID_PROVIDER=true, and even then drafts stay disabled with a log line saying so.

import type { ControlPlaneClient } from "./control-plane.ts";
import { ControlPlaneError, LeaseLostError } from "./control-plane.ts";
import type { RunnerConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import { errorMessage } from "./log.ts";
import { OpenAICompatClient } from "./providers/openai-client.ts";
import { assertLocalEndpoint } from "./providers/local.ts";

export type DraftOutcome = "none" | "completed" | "failed" | "lease_lost" | "unsupported";

export interface DraftsDeps {
  client: ControlPlaneClient;
  model: OpenAICompatClient;
  modelName: string;
  log: Logger;
  temperature?: number;
  now?: () => number;
}

/** Decide whether this runner serves drafts, and with what. Returns null (with the reason logged) when it must not. */
export function draftsServer(cfg: RunnerConfig, log: Logger, fetchImpl?: typeof fetch): { model: OpenAICompatClient; modelName: string } | null {
  if (!cfg.aiDrafts.enabled) return null;
  if (cfg.aiDrafts.provider === "claude") {
    log.warn(cfg.allowPaidProvider
      ? "RUNNER_AI_DRAFTS_PROVIDER=claude: the runner has no paid drafts adapter; AI drafts are not served by this runner"
      : "RUNNER_AI_DRAFTS_PROVIDER=claude refused: paid providers need RUNNER_ALLOW_PAID_PROVIDER=true; AI drafts are not served");
    return null;
  }
  if (!cfg.local.model) { log.warn("AI drafts need LOCAL_MODEL; not served"); return null; }
  try { assertLocalEndpoint(cfg.local.baseUrl, cfg.local.model); } catch (err) { log.warn("AI drafts refused", { error: errorMessage(err) }); return null; }
  return {
    modelName: cfg.local.model,
    model: new OpenAICompatClient({ baseUrl: cfg.local.baseUrl, apiKey: cfg.local.apiKey, timeoutMs: 240_000, fetchImpl, retries: 1 }),
  };
}

/** Claim and serve at most one draft job. */
export async function serveOneDraft(d: DraftsDeps): Promise<DraftOutcome> {
  let claimed;
  try {
    claimed = await d.client.aiClaim();
  } catch (err) {
    if (err instanceof ControlPlaneError && (err.status === 404 || err.status === 405)) return "unsupported";
    d.log.warn("AI draft claim failed", { error: errorMessage(err) });
    return "none";
  }
  const job = claimed.job;
  if (!job) return "none";
  const log = d.log.child({ aiJobId: job.id, workflow: job.workflow });
  // Finish well inside the 5-minute lease so the completion is not rejected as lease_lost.
  const now = (d.now ?? Date.now)();
  const leaseMs = Date.parse(job.leaseExpiresAt) - now;
  const budgetMs = Math.max(10_000, Math.min(240_000, (Number.isFinite(leaseMs) ? leaseMs : 300_000) - 30_000));
  const maxTokens = Math.max(16, Math.min(Number(job.maxOutputTokens) || 1500, 4000));
  let text: string | undefined;
  let error: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const res = await d.model.chat({
      model: d.modelName,
      messages: [{ role: "system", content: String(job.system ?? "") }, { role: "user", content: String(job.prompt ?? "") }],
      temperature: d.temperature ?? 0.2,
      max_tokens: maxTokens,
    }, AbortSignal.timeout(budgetMs));
    inputTokens = res.promptTokens;
    outputTokens = res.completionTokens;
    const out = (res.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (out) text = out; else error = "the local model returned an empty draft";
  } catch (err) {
    error = `local model request failed: ${errorMessage(err).slice(0, 300)}`;
  }
  try {
    const r = await d.client.aiComplete(job, { ...(text !== undefined ? { text } : {}), ...(error ? { error } : {}), model: d.modelName, inputTokens, outputTokens });
    log.info("AI draft completed", { ok: !error, status: r.status, inputTokens, outputTokens });
    return error ? "failed" : "completed";
  } catch (err) {
    if (err instanceof LeaseLostError) { log.warn("AI draft lease lost; the platform requeues it"); return "lease_lost"; }
    log.warn("AI draft completion failed", { error: errorMessage(err) });
    return "failed";
  }
}
