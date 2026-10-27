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
import type { Activity } from "./protocol.ts";

export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

/** Shared, mutable run state read by the heartbeat loop. */
export class RunTracker {
  sessionId: string | null = null;
  /** Cost attributed to this attempt (USD, client-side estimate). */
  attemptCostUsd = 0;
  /** Last session total seen (includes spend restored from earlier attempts when resuming). */
  lastSessionTotalUsd = 0;
  turnsCompleted = 0;
  liveTurns = 0;
  activity: Activity[] = [];
  costUnknownPhases: string[] = [];

  turns(): number { return this.turnsCompleted + this.liveTurns; }

  note(a: Activity): void {
    this.activity.push(a);
    if (this.activity.length > 200) this.activity.splice(0, this.activity.length - 200);
  }

  drainActivity(): Activity[] {
    return this.activity.splice(0, this.activity.length);
  }

  /** Attribute a result's cost to this attempt. total_cost_usd is a running session total (cost-tracking docs). */
  applyResult(r: SDKResultMessage): void {
    const total = Number.isFinite(r.total_cost_usd) ? r.total_cost_usd : 0;
    if (total === 0 && r.subtype === "error_during_execution") {
      // Crash results may carry zeroed cost fields (cost-tracking#recover-totals-after-a-session-crash).
      return;
    }
    const own = total >= this.lastSessionTotalUsd ? total - this.lastSessionTotalUsd : total;
    this.attemptCostUsd += own;
    this.lastSessionTotalUsd = total;
  }
}

export class StopSwitch {
  reason: string | null = null;
  private listeners: ((reason: string) => void)[] = [];
  request(reason: string): void {
    if (this.reason) return;
    this.reason = reason;
    for (const l of this.listeners.splice(0)) l(reason);
  }
  /** Returns an unsubscribe function. */
  onStop(fn: (reason: string) => void): () => void {
    if (this.reason) { fn(this.reason); return () => {}; }
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((l) => l !== fn); };
  }
}

export interface PhaseResult {
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
}): Promise<PhaseResult> {
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
