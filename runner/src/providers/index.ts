// Provider selection. RUNNER_AGENT_PROVIDER=local (default) | claude-agent-sdk.
// The paid adapter is refused unless RUNNER_ALLOW_PAID_PROVIDER=true, and there is NO automatic fallback: when the
// local provider fails, the job fails (or is released) honestly; it is never retried on a paid API.

import type { RunnerConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import type { DockerExecutor } from "../sandbox.ts";
import { cliDockerExecutor } from "../sandbox.ts";
import type { AgentProvider } from "./types.ts";
import { PaidProviderRefusedError } from "./types.ts";
import { LocalProvider } from "./local.ts";
import type { LocalLimits } from "./local.ts";
import { ClaudeAgentSdkProvider } from "./claude-agent-sdk.ts";
import type { QueryFn } from "./claude-agent-sdk.ts";

export interface ProviderDeps {
  log: Logger;
  /** Only for the paid adapter (the real SDK's query, or a test fake). */
  queryFn?: QueryFn;
  dockerExecutor?: DockerExecutor;
  fetchImpl?: typeof fetch;
  interruptGraceMs?: number;
  localLimits?: Partial<LocalLimits>;
  clientRetries?: number;
  clientSleep?: (ms: number) => Promise<void>;
}

export function assertProviderAllowed(cfg: Pick<RunnerConfig, "agentProvider" | "allowPaidProvider">): void {
  if (cfg.agentProvider === "claude-agent-sdk" && !cfg.allowPaidProvider) {
    throw new PaidProviderRefusedError("RUNNER_AGENT_PROVIDER=claude-agent-sdk is a paid provider; set RUNNER_ALLOW_PAID_PROVIDER=true to enable it explicitly. The runner does not fall back to it automatically.");
  }
}

export function createProvider(cfg: RunnerConfig, deps: ProviderDeps): AgentProvider {
  assertProviderAllowed(cfg);
  if (cfg.agentProvider === "claude-agent-sdk") {
    if (!deps.queryFn) throw new Error("The Claude Agent SDK adapter needs the SDK's query function");
    return new ClaudeAgentSdkProvider({ cfg, queryFn: deps.queryFn, log: deps.log, interruptGraceMs: deps.interruptGraceMs });
  }
  return new LocalProvider({
    cfg, log: deps.log, fetchImpl: deps.fetchImpl, limits: deps.localLimits,
    // The docker CLI gets a minimal environment (no runner secrets); DOCKER_HOST only if the operator set one.
    executor: deps.dockerExecutor ?? cliDockerExecutor(cfg.jobSandbox.dockerBin, {
      PATH: cfg.agentPath, HOME: "/tmp", LANG: "C.UTF-8", ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    }),
    clientRetries: deps.clientRetries, clientSleep: deps.clientSleep,
  });
}

export { PaidProviderRefusedError } from "./types.ts";
export type { AgentProvider } from "./types.ts";
