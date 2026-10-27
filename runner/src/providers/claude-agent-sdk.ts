// OPTIONAL, PAID adapter: the original Claude Agent SDK implementation, moved here unchanged in behaviour.
// It is never used unless RUNNER_AGENT_PROVIDER=claude-agent-sdk AND RUNNER_ALLOW_PAID_PROVIDER=true, and the runner
// never falls back to it when the local provider fails.
//
// One agent phase = one query() call in streaming-input mode (so interrupt() is available), resuming the job's
// session between phases. Tracks session id, turns and cost, and stops the agent on request.
//
// Docs relied on (https://code.claude.com/docs/en/agent-sdk/...):
//  - typescript#query-object: interrupt() "Only available in streaming input mode"; close() terminates the process.
//  - agent-loop#handle-the-result: every result carries total_cost_usd, num_turns, session_id; subtypes
//    success | error_max_turns | error_max_budget_usd | error_during_execution | ...
//  - cost-tracking: total_cost_usd is a client-side estimate; a resumed call's result includes the session's earlier
//    spend; maxBudgetUsd counts only the call's own spend.

import type { Options, Query, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunTracker, StopSwitch } from "../agent.ts";
import type { RunnerConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import type { Job } from "../protocol.ts";
import type { Workspace } from "../workspace.ts";
import { agentPermissions, buildAgentEnv, writeAgentConfig } from "../workspace.ts";
import { sessionFileExists } from "../checkpoint.ts";
import type { AgentProvider, PhaseRequest, PhaseResult, PrepareContext, ProviderPreflight } from "./types.ts";
import { PaidProviderRefusedError } from "./types.ts";

export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

export interface SdkPhaseResult {
  result: SDKResultMessage | null;
  error: string | null;
  stoppedBy: string | null;
}

function describeTool(block: { name?: string; input?: Record<string, unknown> }): string {
  const input = block.input ?? {};
  const target = typeof input.file_path === "string" ? input.file_path
    : typeof input.path === "string" ? input.path
    : typeof input.skill === "string" ? input.skill
    : typeof input.command === "string" ? String(input.command).split(/\s+/).slice(0, 3).join(" ")
    : "";
  return `${block.name ?? "tool"}${target ? ` ${target}` : ""}`.slice(0, 200);
}

export async function runPhase(opts: {
  queryFn: QueryFn;
  prompt: string;
  options: Options;
  tracker: RunTracker;
  stop: StopSwitch;
  interruptGraceMs?: number;
}): Promise<SdkPhaseResult> {
  const { tracker, stop } = opts;
  const abort = new AbortController();
  let releaseInput: () => void = () => {};
  const inputDone = new Promise<void>((r) => { releaseInput = r; });

  // Streaming input: one user message, then keep stdin open until the result (or a stop) so interrupt() works.
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: opts.prompt }, parent_tool_use_id: null };
    await inputDone;
  }

  if (stop.reason) return { result: null, error: null, stoppedBy: stop.reason };
  const q = opts.queryFn({ prompt: input(), options: { ...opts.options, abortController: abort } });
  const seenToolMessages = new Set<string>();
  let result: SDKResultMessage | null = null;
  let error: string | null = null;
  let stoppedBy: string | null = null;
  let killTimer: NodeJS.Timeout | null = null;

  const unsubscribe = stop.onStop(async (reason) => {
    stoppedBy = reason;
    tracker.note({ kind: "step", message: `stopping agent: ${reason}` });
    try {
      await Promise.race([q.interrupt(), new Promise((r) => setTimeout(r, 15_000))]);
    } catch { /* interrupt is best effort; the abort below is the backstop */ }
    releaseInput();
    killTimer = setTimeout(() => { abort.abort(); try { q.close(); } catch { /* already closed */ } }, opts.interruptGraceMs ?? 20_000);
  });

  try {
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
        tracker.sessionId = msg.session_id;
      } else if (msg.type === "assistant" && "message" in msg) {
        const tools = msg.message.content.filter((b) => b.type === "tool_use");
        if (tools.length && !msg.parent_tool_use_id && !seenToolMessages.has(msg.message.id)) {
          seenToolMessages.add(msg.message.id);
          tracker.liveTurns++;
        }
        for (const t of tools) tracker.note({ kind: "tool", message: describeTool(t) });
      } else if (msg.type === "result") {
        result = msg as SDKResultMessage;
        tracker.sessionId = result.session_id || tracker.sessionId;
        tracker.applyResult(result);
        tracker.turnsCompleted += Number.isFinite(result.num_turns) ? result.num_turns : tracker.liveTurns;
        tracker.liveTurns = 0;
        releaseInput();
      }
    }
  } catch (err) {
    // A query that ends on an error result throws after yielding it (agent-loop docs); keep the result we saw.
    if (!result && !stoppedBy) error = err instanceof Error ? err.message : String(err);
  } finally {
    unsubscribe();
    releaseInput();
    if (killTimer) clearTimeout(killTimer);
  }
  if (!result) {
    tracker.turnsCompleted += tracker.liveTurns;
    tracker.liveTurns = 0;
    if (!stoppedBy) tracker.costUnknownPhases.push(error ?? "no result message");
  }
  return { result, error, stoppedBy };
}

/** Wraps runPhase behind the provider interface. Options are built exactly as the runner built them before. */
export class ClaudeAgentSdkProvider implements AgentProvider {
  readonly id = "claude-agent-sdk" as const;
  readonly paid = true;
  readonly capabilities = ["agent-sdk"];
  private baseOptions: Options | null = null;
  private currentStop: StopSwitch | null = null;

  private readonly deps: { cfg: RunnerConfig; queryFn: QueryFn; log: Logger; interruptGraceMs?: number };

  constructor(deps: { cfg: RunnerConfig; queryFn: QueryFn; log: Logger; interruptGraceMs?: number }) {
    this.deps = deps;
    // Defense in depth: the factory checks this too.
    if (!deps.cfg.allowPaidProvider) {
      throw new PaidProviderRefusedError("The Claude Agent SDK adapter is a paid provider and RUNNER_ALLOW_PAID_PROVIDER is not \"true\"; refusing to start it.");
    }
  }

  model(job: Job): string { return job.limits.model; }

  async preflight(): Promise<ProviderPreflight> {
    return { errors: this.deps.cfg.anthropicApiKey ? [] : ["ANTHROPIC_API_KEY is not configured for the Claude Agent SDK adapter"], warnings: [] };
  }

  async prepare(ctx: PrepareContext): Promise<void> {
    const { cfg, log } = this.deps;
    const permInput = {
      secretsDir: cfg.secretsDir, allowedDomains: cfg.allowedDomains, referenceDomains: ctx.referenceDomains,
      fetchReferences: cfg.fetchReferences, sandbox: cfg.sandbox,
    };
    writeAgentConfig(ctx.ws, permInput);
    const perms = agentPermissions({ ...permInput, repo: ctx.ws.repo });
    this.baseOptions = {
      cwd: ctx.ws.repo,
      env: buildAgentEnv(cfg, ctx.ws, ctx.processEnv),
      model: ctx.job.limits.model,
      permissionMode: "dontAsk",
      allowedTools: perms.allow,
      disallowedTools: perms.deny,
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code", append: ctx.systemPromptAppend },
      skills: ctx.skillNames,
      additionalDirectories: [],
      persistSession: true,
      stderr: (d: string) => log.debug("agent stderr", { line: d.slice(0, 500) }),
    };
  }

  async run(req: PhaseRequest): Promise<PhaseResult> {
    if (!this.baseOptions) throw new Error("ClaudeAgentSdkProvider.prepare() was not called");
    this.currentStop = req.stop;
    const res = await runPhase({
      queryFn: this.deps.queryFn,
      prompt: req.prompt,
      options: { ...this.baseOptions, maxTurns: req.maxTurns, maxBudgetUsd: Math.round(req.maxBudgetUsd * 100) / 100, ...(req.resumeSessionId ? { resume: req.resumeSessionId } : {}) },
      tracker: req.tracker, stop: req.stop, interruptGraceMs: this.deps.interruptGraceMs,
    });
    this.currentStop = null;
    const sub = res.result?.subtype;
    const status = res.stoppedBy ? "stopped"
      : sub === "error_max_budget_usd" ? "max_budget"
      : sub === "error_max_turns" ? "max_turns"
      : res.result ? "success" : "error";
    return { status, error: res.result ? null : res.error, stoppedBy: res.stoppedBy };
  }

  async interrupt(reason: string): Promise<void> { this.currentStop?.request(reason); }

  hasSession(ws: Workspace, sessionId: string): boolean { return sessionFileExists(ws.home, sessionId); }

  async close(): Promise<void> {}
}
