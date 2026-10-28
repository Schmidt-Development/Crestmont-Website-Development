// Claude Code builder through the official CLI, signed in with the worker's own Claude plan (Founder redirect §3).
//
// Each builder worker is one Claude account, signed in once by the Founder with `claude` → /login, with its own
// CLAUDE_CONFIG_DIR (credentials and sessions isolated per account; nothing is copied between accounts). The runner
// runs `claude -p` (non-interactive print mode) in the job's workspace with:
//   - the runner-written project settings (.claude/settings.json: routine development allowed, everything else denied,
//     Claude Code's own sandbox when RUNNER_SANDBOX=on) — the same permission scope as the earlier SDK adapter;
//   - an environment built from an allow-list with every metered-billing variable removed (ANTHROPIC_API_KEY,
//     ANTHROPIC_AUTH_TOKEN, Bedrock/Vertex switches…), so the CLI can only use the subscription sign-in;
//   - stream-json output, parsed for the session id, turns and the result; `--resume` continues the session.
// No password, cookie or token is read, copied or rotated by Crestmont. If the account hits its plan limit, the phase
// ends and the worker is reported as rate-limited; there is never a fallback to a paid API.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { RunnerConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import type { Job } from "../protocol.ts";
import type { Workspace } from "../workspace.ts";
import { FORBIDDEN_ENV, writeAgentConfig } from "../workspace.ts";
import { proxyEnv } from "../exec.ts";
import { assertNoMeteredEnv, limitReached } from "../orchestrator/cost-guard.ts";
import type { AgentProvider, PhaseRequest, PhaseResult, PrepareContext, ProviderPreflight } from "./types.ts";

export type Spawner = typeof spawn;

export class ClaudeCodeCliProvider implements AgentProvider {
  readonly id = "claude-code" as const;
  /** Subscription-backed: no per-token charge to Crestmont (the plan's own limits apply). */
  readonly paid = false;
  readonly capabilities = ["claude-code", "subscription-included"];
  /** Set when the last phase ended on the account's usage limit (the loop reports the worker as rate-limited). */
  rateLimit: { limited: boolean; resetAt: string | null } = { limited: false, resetAt: null };
  private readonly cfg: RunnerConfig;
  private readonly log: Logger;
  private readonly spawner: Spawner;
  private ws: Workspace | null = null;
  private env: Record<string, string> | null = null;
  private appendPrompt = "";
  private child: ReturnType<Spawner> | null = null;

  constructor(deps: { cfg: RunnerConfig; log: Logger; spawner?: Spawner }) {
    this.cfg = deps.cfg; this.log = deps.log; this.spawner = deps.spawner ?? spawn;
    if (!deps.cfg.claudeCode) throw new Error("claude-code provider without CLAUDE_CODE_CONFIG_DIR");
  }

  model(job: Job): string { return this.cfg.claudeCode?.model ?? job.limits.model; }

  async preflight(): Promise<ProviderPreflight> {
    const errors: string[] = [], warnings: string[] = [];
    const dir = this.cfg.claudeCode!.configDir;
    if (!existsSync(dir)) errors.push(`CLAUDE_CODE_CONFIG_DIR ${dir} does not exist: sign this worker's Claude account in with \`CLAUDE_CONFIG_DIR=${dir} claude\` → /login`);
    if (this.cfg.anthropicApiKey) warnings.push("ANTHROPIC_API_KEY is configured on the runner; it is never passed to Claude Code (subscription sign-in only)");
    return { errors, warnings };
  }

  async prepare(ctx: PrepareContext): Promise<void> {
    this.ws = ctx.ws;
    writeAgentConfig(ctx.ws, { secretsDir: this.cfg.secretsDir, allowedDomains: this.cfg.allowedDomains, referenceDomains: ctx.referenceDomains, fetchReferences: this.cfg.fetchReferences, sandbox: this.cfg.sandbox, privateDirs: [this.cfg.claudeCode!.configDir] });
    const env: Record<string, string> = {
      PATH: this.cfg.agentPath, HOME: ctx.ws.home, TMPDIR: ctx.ws.tmp, LANG: "C.UTF-8", CI: "1", NO_COLOR: "1",
      CLAUDE_CONFIG_DIR: this.cfg.claudeCode!.configDir,
      NPM_CONFIG_CACHE: path.join(ctx.ws.home, ".npm"), NPM_CONFIG_UPDATE_NOTIFIER: "false", NPM_CONFIG_FUND: "false", GIT_TERMINAL_PROMPT: "0",
      DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ...proxyEnv(ctx.processEnv),
    };
    for (const k of Object.keys(env)) if (FORBIDDEN_ENV.test(k)) throw new Error(`Refusing to start Claude Code: forbidden variable ${k}`);
    assertNoMeteredEnv(env);
    this.env = env;
    this.appendPrompt = ctx.systemPromptAppend;
  }

  /** The prepared environment (for the separate architect/review sessions on the same account). */
  sessionEnv(): Record<string, string> | null { return this.env ? { ...this.env } : null; }

  argv(req: PhaseRequest): string[] {
    return ["-p", "--output-format", "stream-json", "--verbose", "--max-turns", String(Math.max(1, req.maxTurns)), "--setting-sources", "project",
      "--permission-mode", "dontAsk", ...(this.cfg.claudeCode!.model ? ["--model", this.cfg.claudeCode!.model] : []),
      ...(this.appendPrompt ? ["--append-system-prompt", this.appendPrompt] : []), ...(req.resumeSessionId ? ["--resume", req.resumeSessionId] : [])];
  }

  run(req: PhaseRequest): Promise<PhaseResult> {
    if (!this.ws || !this.env) throw new Error("ClaudeCodeCliProvider.prepare() was not called");
    this.rateLimit = { limited: false, resetAt: null };
    if (req.stop.reason) return Promise.resolve({ status: "stopped", error: null, stoppedBy: req.stop.reason });
    return new Promise((resolve) => {
      const child = this.spawner(this.cfg.claudeCode!.bin, this.argv(req), { cwd: this.ws!.repo, env: this.env!, stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      let buf = "", errTail = "", result: Record<string, unknown> | null = null, stoppedBy: string | null = null, timedOut = false;
      const onLine = (line: string) => {
        let m: Record<string, unknown>;
        try { m = JSON.parse(line); } catch { return; }
        if (typeof m.session_id === "string") req.tracker.sessionId = m.session_id;
        if (m.type === "assistant") {
          req.tracker.liveTurns++;
          const content = ((m.message as { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] } | undefined)?.content ?? []);
          for (const b of content) if (b.type === "tool_use") req.tracker.note({ kind: "tool", message: `${b.name ?? "tool"} ${String(b.input?.file_path ?? b.input?.command ?? "").slice(0, 120)}`.trim() });
        }
        if (m.type === "result") result = m;
      };
      child.stdout!.on("data", (d: Buffer) => { buf += d.toString("utf8"); let i; while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
      child.stderr!.on("data", (d: Buffer) => { errTail = (errTail + d.toString("utf8")).slice(-4000); });
      const kill = () => { try { child.kill("SIGINT"); } catch { /* gone */ } setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 15_000).unref(); };
      const unsub = req.stop.onStop((reason) => { stoppedBy = reason; kill(); });
      const timer = setTimeout(() => { timedOut = true; kill(); }, req.maxWallMs);
      child.on("error", (err) => { errTail += String(err); });
      child.on("close", (code) => {
        clearTimeout(timer); unsub(); this.child = null;
        if (buf.trim()) onLine(buf.trim());
        req.tracker.turnsCompleted += req.tracker.liveTurns; req.tracker.liveTurns = 0;
        const r = result as Record<string, unknown> | null;
        if (r && typeof r.num_turns === "number") req.tracker.note({ kind: "step", message: `claude-code result ${String(r.subtype)} after ${r.num_turns} turns` });
        // Subscription: no per-token charge to Crestmont. The CLI's cost field is an API-price estimate; it is logged, not billed.
        if (r && typeof r.total_cost_usd === "number") this.log.debug("claude-code estimate (not billed under a subscription)", { usd: r.total_cost_usd });
        const text = `${typeof r?.result === "string" ? r.result : ""}\n${errTail}`;
        this.rateLimit = limitReached(text);
        if (stoppedBy) return resolve({ status: "stopped", error: null, stoppedBy });
        if (timedOut) return resolve({ status: "max_time", error: null, stoppedBy: null });
        if (r?.subtype === "success" && r.is_error !== true) return resolve({ status: "success", error: null, stoppedBy: null });
        if (r?.subtype === "error_max_turns") return resolve({ status: "max_turns", error: null, stoppedBy: null });
        resolve({ status: "error", error: this.rateLimit.limited ? "Claude plan usage limit reached for this worker" : `claude exited ${code}${errTail ? `: ${errTail.slice(-300)}` : ""}`, stoppedBy: null });
      });
      child.stdin!.end(req.prompt);
    });
  }

  async interrupt(): Promise<void> { try { this.child?.kill("SIGINT"); } catch { /* gone */ } }

  /** Sessions live in the worker's own config directory (projects/<cwd-slug>/<session>.jsonl). */
  hasSession(_ws: Workspace, sessionId: string): boolean {
    const root = path.join(this.cfg.claudeCode!.configDir, "projects");
    if (!existsSync(root) || !/^[A-Za-z0-9-]{8,80}$/.test(sessionId)) return false;
    try { return readdirSync(root).some((d) => existsSync(path.join(root, d, `${sessionId}.jsonl`))); } catch { return false; }
  }

  async close(): Promise<void> { await this.interrupt(); }
}
