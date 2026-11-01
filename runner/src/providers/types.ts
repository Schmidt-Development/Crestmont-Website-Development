// Provider-independent agent interface. A provider runs one build phase at a time inside the job's workspace,
// streams events into the shared RunTracker (session id, turns, cost, tokens, activity), honours the job's StopSwitch
// and can be interrupted. Two implementations:
//   - providers/local.ts             (DEFAULT) in-house tool-using agent against a self-hosted OpenAI-compatible model
//   - providers/claude-agent-sdk.ts  (OPTIONAL, paid; recommended for removal under Founder V4) the original Claude Agent
//                                    SDK adapter; refuses to start unless RUNNER_ALLOW_PAID_PROVIDER=true and the platform
//                                    also allows paid providers. There is never an automatic fallback to it.

import type { RunTracker, StopSwitch } from "../agent.ts";
import type { Job } from "../protocol.ts";
import type { Phase } from "../prompt.ts";
import type { Workspace } from "../workspace.ts";
import type { Logger } from "../log.ts";

export type ProviderId = "local" | "claude-agent-sdk";

export interface PhaseRequest {
  phase: Phase;
  /** Runner-authored phase instruction (never customer text). */
  prompt: string;
  maxTurns: number;
  /** Only meaningful for paid providers; local inference costs 0. */
  maxBudgetUsd: number;
  maxWallMs: number;
  /** Provider session to continue (from this attempt's earlier phase or a restored checkpoint). */
  resumeSessionId: string | null;
  tracker: RunTracker;
  stop: StopSwitch;
  /** V4: model chosen by the router for this phase (local provider); default Model B. */
  model?: string;
  /** V4: routed task (architecture, frontend, debugging, repeated_failure, ...), for the GPU queue and the logs. */
  task?: string;
  /** Durable project memory digest (runner-written), bounded to maxChars; part of every fresh context. */
  memory?: (maxChars: number) => string;
  /** Called after each context reset (the job checkpoints there). A LeaseLostError thrown here ends the phase. */
  onCompaction?: (info: { compactions: number; phase: string; before: number; after: number; window: number; reason: string }) => Promise<void>;
}

export type PhaseStatus =
  | "success"
  | "max_turns"
  | "max_budget"
  | "max_time"
  | "max_output_tokens"
  | "loop"
  | "error"
  | "stopped";

export interface PhaseResult {
  status: PhaseStatus;
  /** Set when the phase ended without a usable result (provider/model failure). */
  error: string | null;
  /** The StopSwitch reason when the phase was stopped from outside. */
  stoppedBy: string | null;
  /** The model's own finish summary (model-reported; recorded as such, never as fact). */
  summary?: string | null;
  /** Context resets of the provider session so far (local provider). */
  compactions?: number;
}

export interface PrepareContext {
  job: Job;
  ws: Workspace;
  skillNames: string[];
  referenceDomains: string[];
  processEnv: Record<string, string | undefined>;
  systemPromptAppend: string;
}

export interface ProviderPreflight { errors: string[]; warnings: string[] }

export interface AgentProvider {
  readonly id: ProviderId;
  /** True for providers billed per token. Paid providers are opt-in only. */
  readonly paid: boolean;
  /** Capabilities announced in `claim`. */
  readonly capabilities: string[];
  /** Model actually used (the local provider ignores the claim's Claude model name). */
  model(job: Job): string;
  /** Provider-specific readiness (model reachable, sandbox image present, ...). */
  preflight(log: Logger): Promise<ProviderPreflight>;
  /** Per-job setup before the first phase (configuration files, session directories, sandbox). */
  prepare(ctx: PrepareContext): Promise<void>;
  run(req: PhaseRequest): Promise<PhaseResult>;
  /** Stop the running phase as soon as possible (the job also signals through the StopSwitch). */
  interrupt(reason: string): Promise<void>;
  /** Whether a resumable session transcript for `sessionId` exists in this workspace. */
  hasSession(ws: Workspace, sessionId: string): boolean;
  /** Release per-job resources (containers). Must be safe to call more than once. */
  close(): Promise<void>;
}

export class PaidProviderRefusedError extends Error {
  constructor(message: string) { super(message); this.name = "PaidProviderRefusedError"; }
}
