// Provider-neutral run state shared by the job orchestration, the heartbeat loop and the agent providers.
// The Claude Agent SDK phase runner moved to providers/claude-agent-sdk.ts (unchanged behaviour); it is re-exported
// here for callers that imported it from this module.

import type { Activity } from "./protocol.ts";

/** Shared, mutable run state read by the heartbeat loop. */
export class RunTracker {
  sessionId: string | null = null;
  /** Cost attributed to this attempt (USD). Always 0 for local inference. */
  attemptCostUsd = 0;
  /** Last session total seen (includes spend restored from earlier attempts when resuming). */
  lastSessionTotalUsd = 0;
  turnsCompleted = 0;
  liveTurns = 0;
  activity: Activity[] = [];
  costUnknownPhases: string[] = [];
  /** Model token usage this attempt (reported by the model server; 0 when unknown). */
  inputTokens = 0;
  outputTokens = 0;
  /** Wall time spent waiting for model responses this attempt. */
  modelWallMs = 0;
  modelCalls = 0;

  turns(): number { return this.turnsCompleted + this.liveTurns; }

  note(a: Activity): void {
    this.activity.push(a);
    if (this.activity.length > 200) this.activity.splice(0, this.activity.length - 200);
  }

  drainActivity(): Activity[] {
    return this.activity.splice(0, this.activity.length);
  }

  /** Attribute an Agent SDK result's cost to this attempt. total_cost_usd is a running session total. */
  applyResult(r: { total_cost_usd: number; subtype: string }): void {
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

export { runPhase } from "./providers/claude-agent-sdk.ts";
export type { QueryFn, SdkPhaseResult as PhaseResult } from "./providers/claude-agent-sdk.ts";
