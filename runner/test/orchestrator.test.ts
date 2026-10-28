// Founder V3 (2026-10-28, Claude-only) — local orchestrator, SIMULATED: the Claude Code CLI is replaced by a fake
// process (no Claude account, no network, no model). These tests prove the orchestration (architect → build →
// evidence → separate review → corrective prompt → second build), the $0 environment, read-only review sessions,
// multi-session coordination and usage-limit handling. They do not prove that real Claude Code works on Node 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { runJob, type JobDeps } from "../src/job.ts";
import { ControlPlaneClient } from "../src/control-plane.ts";
import { silentLogger } from "../src/log.ts";
import type { RunnerConfig } from "../src/config.ts";
import { ClaudeCodeAdvisor, DeterministicReviewer } from "../src/orchestrator/advisors.ts";
import { assertNoMeteredEnv, limitReached, SpendPolicyError } from "../src/orchestrator/cost-guard.ts";
import { layers, groupLayer, runCoordinatedSessions } from "../src/orchestrator/sessions.ts";
import type { CycleEvidence } from "../src/orchestrator/contracts.ts";
import type { ExecResult } from "../src/exec.ts";
import type { Spawner } from "../src/providers/claude-code-cli.ts";
import { makeConfig, makeJob, makeSkillsDir, startFakeControlPlane, claimFrom, fillStarterFromBrief, tmp, POLLUTED_ENV, SECRET, testManifest } from "./helpers.ts";

const manifest = testManifest();

const SPEC = {
  schema: "crestmont.master-spec/1", projectSpec: "Bakery website", designSpec: "Warm, premium", technicalArchitecture: "Static assets Worker",
  tasks: [{ id: "t-pages", title: "Pages", workstream: "frontend", paths: ["public/"], dependsOn: [] }],
  acceptanceCriteria: [{ id: "ac-pages", text: "All pages exist", verification: "screenshot" }, { id: "ac-contact", text: "Contact details correct", verification: "automated" }],
  integrations: [{ key: "stripe", name: "Stripe", purpose: "Payments" }], securityRequirements: [], testingRequirements: [], assumptions: ["Draft copy"], referenceImages: [], masterPrompt: "Build the bakery website exactly as specified.",
};

/** Fake `claude` process for builder sessions (stream-json). `act` runs in the session's cwd. */
function fakeClaude(calls: { argv: string[]; cwd: string; env: Record<string, string>; prompt: string }[], act: (cwd: string, prompt: string, n: number) => { result?: string; limited?: boolean } | void): Spawner {
  return ((bin: string, argv: string[], opts: { cwd: string; env: Record<string, string> }) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => void };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    let prompt = "";
    child.stdin.on("data", (d) => { prompt += String(d); });
    child.stdin.on("end", () => {
      calls.push({ argv, cwd: opts.cwd, env: opts.env, prompt });
      const out = act(opts.cwd, prompt, calls.length) ?? {};
      setImmediate(() => {
        child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-cc-1" }) + "\n");
        child.stdout.write(JSON.stringify({ type: "assistant", session_id: "sess-cc-1", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "public/index.html" } }] } }) + "\n");
        child.stdout.write(JSON.stringify(out.limited ? { type: "result", subtype: "error_during_execution", is_error: true, result: "Claude usage limit reached. Your limit will reset at 2099-01-01T05:00:00Z", session_id: "sess-cc-1" } : { type: "result", subtype: "success", is_error: false, num_turns: 3, result: out.result ?? "done", session_id: "sess-cc-1", total_cost_usd: 0.42 }) + "\n");
        child.stdout.end(); child.stderr.end();
        child.emit("close", out.limited ? 1 : 0);
      });
    });
    return child;
  }) as unknown as Spawner;
}

/** Fake `run` for the separate architect/review sessions (`claude -p --output-format json`). */
function fakeAdvisorRun(calls: { argv: string[]; env: Record<string, string>; input: string }[], answer: (role: string, input: string, n: number) => unknown) {
  return (async (_bin: string, argv: string[], opts: { env: Record<string, string>; input?: string }): Promise<ExecResult> => {
    calls.push({ argv, env: opts.env, input: opts.input ?? "" });
    const role = (opts.input ?? "").includes("website architect") ? "architect" : "reviewer";
    return { code: 0, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "```json\n" + JSON.stringify(answer(role, opts.input ?? "", calls.length)) + "\n```" }), stderr: "", timedOut: false, notFound: false };
  }) as never;
}

async function setup(cfgOver: Partial<RunnerConfig> = {}, routes: Record<string, (b: Record<string, unknown>) => unknown> = {}) {
  const submitted: Record<string, unknown>[] = [];
  const cp = await startFakeControlPlane({ jobs: [makeJob({ worker: { id: "wkr_1", label: "Claude 1", maxSessions: 1 } })], extraRoutes: {
    "pipeline/spec": () => ({ specVersion: 1 }),
    "cycles/submit": (b) => { submitted.push(b); const cont = ["CONTINUE_BUILDING", "FIX_DEFECTS", "RUN_MORE_TESTS"].includes(String(b.decision)); return { cycle: b.cycle, decision: b.decision, reason: "fake platform", continue: cont, prompt: cont ? b.nextPrompt : null }; },
    "integrations/report": () => ({ updated: 1 }), "approvals/request": () => ({ id: "apv_1", status: "pending" }), "workers/status": () => ({ ok: true }),
    ...routes,
  } });
  const configDir = tmp("aib-claude-cfg-");
  const cfg = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: makeSkillsDir(manifest), agentProvider: "claude-code", allowPaidProvider: false, anthropicApiKey: "",
    claudeCode: { bin: "claude", configDir, model: null }, advisor: { architect: "claude-code", reviewer: "claude-code", timeoutMs: 60_000, maxTurns: 30, maxCycles: 5 }, ...cfgOver });
  const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: cfg.runnerId, sleep: async () => {}, retry: { attempts: 2, baseMs: 1 } });
  const job = await claimFrom(cp);
  return { cp, cfg, client, job, submitted, configDir };
}

const advisor = (cfg: RunnerConfig, run: ReturnType<typeof fakeAdvisorRun>, cwd = "/nonexistent") => new ClaudeCodeAdvisor({ bin: "claude", cwd, env: { PATH: process.env.PATH ?? "", CLAUDE_CONFIG_DIR: cfg.claudeCode!.configDir }, model: null, timeoutMs: 1000, maxTurns: 10, runner: run });

test("[AIB-013] Proof 4 (SIMULATED): architect session → builder → evidence → separate review session → corrective prompt → second build → accepted", async () => {
  const { cp, cfg, client, job, submitted, configDir } = await setup();
  try {
    const builderCalls: Parameters<typeof fakeClaude>[0] = [];
    const spawner = fakeClaude(builderCalls, (cwd, prompt) => {
      mkdirSync(path.join(cwd, ".crestmont"), { recursive: true });
      if (!prompt.includes("Fix the contact details")) {
        // First build: pages done, contact criterion not yet; Stripe adapter with mocks; one sensitive request.
        fillStarterFromBrief(cwd);
        writeFileSync(path.join(cwd, ".crestmont", "acceptance.json"), JSON.stringify([{ id: "ac-pages", status: "passed" }, { id: "ac-contact", status: "failed" }]));
        writeFileSync(path.join(cwd, ".crestmont", "integrations.json"), JSON.stringify([{ key: "stripe", codeStatus: "implemented", mockStatus: "passed", needs: "Stripe live keys" }]));
        writeFileSync(path.join(cwd, ".crestmont", "approval-requests.json"), JSON.stringify([{ kind: "credential_request", summary: "Stripe live secret key for the customer's payments" }]));
      } else {
        writeFileSync(path.join(cwd, ".crestmont", "acceptance.json"), JSON.stringify([{ id: "ac-pages", status: "passed" }, { id: "ac-contact", status: "passed" }]));
      }
      // Fake browser screenshots (the real ones come from the sandbox browser check).
      mkdirSync(path.join(cwd, ".crestmont", "screenshots"), { recursive: true });
      for (const v of ["desktop", "mobile"]) writeFileSync(path.join(cwd, ".crestmont", "screenshots", `index-${v}.png`), "png");
    });
    const advisorCalls: Parameters<typeof fakeAdvisorRun>[0] = [];
    const run = fakeAdvisorRun(advisorCalls, (role, input) => role === "architect" ? SPEC
      : input.includes("\"ac-contact\",\n          \"status\": \"failed\"") || /"id": "ac-contact",\s*"status": "failed"/.test(input)
        ? { decision: "FIX_DEFECTS", addresses: ["criterion:ac-contact"], findings: ["contact page shows the wrong phone"], nextPrompt: "Fix the contact details on every page." }
        : { decision: "READY_FOR_FINAL_QA", addresses: [], findings: [], nextPrompt: null });
    const deps: JobDeps = { cfg, client, manifest, logger: silentLogger, heartbeatMs: 25, interruptGraceMs: 200, processEnv: { ...POLLUTED_ENV, ANTHROPIC_API_KEY: "sk-ant-api-should-never-be-used-000", CLAUDE_CODE_USE_BEDROCK: "1" }, spawner, architect: advisor(cfg, run), reviewer: advisor(cfg, run) };
    const s = await runJob(job, deps);
    assert.equal(s.outcome, "ready_for_review", String(s.complete?.error));
    // A. The architect's specification was stored and given to the builder.
    assert.equal(cp.byPath("pipeline/spec").length, 1);
    assert.ok(existsSync(path.join(s.workspace!, "repo", "SPEC.json")));
    assert.match(builderCalls[0].prompt, /SPEC\.json holds the architect's master specification/);
    // B → C → D: two review cycles, the second after the corrective prompt reached the same builder session.
    assert.deepEqual(submitted.map((b) => b.decision), ["FIX_DEFECTS", "READY_FOR_FINAL_QA"]);
    assert.equal(submitted[0].promptSource, "architect");
    assert.equal(submitted[1].promptSource, "reviewer");
    assert.equal(submitted[1].prompt, "Fix the contact details on every page.");
    const repair = builderCalls.find((c) => c.prompt.includes("Fix the contact details"))!;
    assert.ok(repair, "corrective prompt dispatched automatically");
    assert.ok(repair.argv.includes("--resume"), "the same builder session continues");
    // The review is a separate, read-only session that sees evidence, not the builder's session.
    const reviews = advisorCalls.filter((c) => c.input.includes("independent quality reviewer"));
    assert.equal(reviews.length, 2);
    for (const r of reviews) {
      assert.ok(!r.argv.includes("--resume"), "fresh context");
      const allowed = r.argv.slice(r.argv.indexOf("--allowedTools") + 1, r.argv.indexOf("--disallowedTools"));
      assert.deepEqual(allowed, ["Read", "Glob", "Grep"]);
      for (const t of ["Edit", "Write", "Bash"]) assert.ok(r.argv.includes(t), `${t} disallowed`);
    }
    const ev = submitted[0].evidence as CycleEvidence;
    assert.deepEqual(ev.criteria, [{ id: "ac-pages", status: "passed" }, { id: "ac-contact", status: "failed" }]);
    assert.ok(ev.screenshots.some((x) => x.viewport === "mobile") && ev.checks.length > 0 && ev.commits.length > 0);
    // Integrations and approvals reached the platform; the build did not wait for them.
    assert.equal(cp.byPath("integrations/report").length >= 1, true);
    assert.equal((cp.byPath("approvals/request")[0].body as Record<string, unknown>).kind, "credential_request");
    // $0: the builder ran with this worker's config directory and without any metered-billing variable.
    for (const c of builderCalls) {
      assert.equal(c.env.CLAUDE_CONFIG_DIR, configDir);
      for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "BUILD_RUNNER_SECRET", "STRIPE_SECRET_KEY", "GITHUB_TOKEN", "CLOUDFLARE_API_TOKEN"]) assert.ok(!(k in c.env), `${k} not passed`);
      assert.ok(c.argv.includes("-p") && c.argv.includes("--permission-mode") && c.argv[c.argv.indexOf("--permission-mode") + 1] === "dontAsk", "pre-authorized routine tools, everything else denied");
      assert.ok(!c.argv.includes("--dangerously-skip-permissions"));
    }
    assert.equal(s.complete?.runCostUsd, 0, "the CLI's API-price estimate is not a charge under a subscription");
    // Project settings grant routine development and deny the rest.
    const settings = JSON.parse(readFileSync(path.join(s.workspace!, "repo", ".claude", "settings.json"), "utf8"));
    assert.ok(settings.permissions.deny.includes("WebSearch"));
    assert.equal(settings.permissions.disableBypassPermissionsMode, "disable");
  } finally { await cp.close(); }
});

test("[AIB-012] usage limit (SIMULATED): the build checkpoints and is released until the account's capacity returns; nothing falls back to a paid API", async () => {
  const { cp, cfg, client, job } = await setup();
  try {
    const calls: Parameters<typeof fakeClaude>[0] = [];
    const spawner = fakeClaude(calls, () => ({ limited: true }));
    const run = fakeAdvisorRun([], () => SPEC);
    const s = await runJob(job, { cfg, client, manifest, logger: silentLogger, heartbeatMs: 25, interruptGraceMs: 200, processEnv: POLLUTED_ENV, spawner, architect: advisor(cfg, run), reviewer: new DeterministicReviewer() });
    assert.equal(s.outcome, "released", String(s.complete?.error));
    assert.equal(s.complete?.notBefore, "2099-01-01T05:00:00.000Z");
    assert.match(String(s.complete?.error), /plan usage limit/);
    assert.ok(cp.byPath("checkpoint").length >= 1, "checkpointed");
    assert.equal(calls.length, 1, "no retry, no other provider");
  } finally { await cp.close(); }
});

test("[AIB-015] $0 enforcement: metered variables are refused; limit messages are recognised; review sessions are read-only", async () => {
  assert.throws(() => assertNoMeteredEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "x" }), SpendPolicyError);
  assert.throws(() => assertNoMeteredEnv({ CLAUDE_CODE_USE_VERTEX: "1" }), SpendPolicyError);
  assert.doesNotThrow(() => assertNoMeteredEnv({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/x", HTTPS_PROXY: "http://p:3128" }));
  assert.deepEqual(limitReached("5-hour limit reached ∙ resets 2026-10-29T03:00:00Z"), { limited: true, resetAt: "2026-10-29T03:00:00.000Z" });
  assert.deepEqual(limitReached("all good"), { limited: false, resetAt: null });
  const cfg = makeConfig({ controlPlaneUrl: "http://x", skillsSourceDir: "x", claudeCode: { bin: "claude", configDir: "/cfg", model: null } });
  const a = advisor(cfg, fakeAdvisorRun([], () => ({})));
  await assert.rejects(new ClaudeCodeAdvisor({ bin: "claude", cwd: "/", env: { ANTHROPIC_API_KEY: "k" }, model: null, timeoutMs: 1, maxTurns: 1, runner: fakeAdvisorRun([], () => ({})) }).review(null, { summary: "", changedFiles: [], commits: [], checks: [], screenshots: [], criteria: [], defects: [], integrationBlockers: [], securityFindings: [], recommendedNext: [] }, 1), SpendPolicyError);
  assert.ok(a.argv("reviewer").includes("--disallowedTools"));
  // The deterministic reviewer never says "ready" without screenshots or with failing checks.
  const base: CycleEvidence = { summary: "", changedFiles: [], commits: [], checks: [{ id: "c", ok: true }], screenshots: [], criteria: [], defects: [], integrationBlockers: [], securityFindings: [], recommendedNext: [] };
  assert.equal((await new DeterministicReviewer().review(null, base)).decision, "RUN_MORE_TESTS");
  assert.equal((await new DeterministicReviewer().review(null, { ...base, checks: [{ id: "c", ok: false }] })).decision, "FIX_DEFECTS");
  assert.equal((await new DeterministicReviewer().review(null, { ...base, screenshots: [{ path: "a", viewport: "desktop", page: "i" }, { path: "b", viewport: "mobile", page: "i" }] })).decision, "READY_FOR_FINAL_QA");
});

test("[AIB-013] multi-session (SIMULATED): parallel sessions in isolated worktrees on disjoint paths; a session that leaves its paths or conflicts is re-run serially; every session is recorded", async () => {
  const tasks = [
    { id: "a", title: "Pages", workstream: "frontend", paths: ["public/pages"], dependsOn: [] },
    { id: "b", title: "API", workstream: "backend", paths: ["src/api"], dependsOn: [] },
    { id: "c", title: "Styles", workstream: "design", paths: ["public/css"], dependsOn: [] },
    { id: "d", title: "Tests", workstream: "testing", paths: ["tests"], dependsOn: ["a", "b"] },
  ];
  assert.deepEqual(layers(tasks).map((l) => l.map((t) => t.id)), [["a", "b", "c"], ["d"]]);
  assert.deepEqual(groupLayer(tasks.slice(0, 3), 2).map((g) => g.map((t) => t.id)), [["a", "c"], ["b"]].sort((x, y) => y.length - x.length));
  assert.equal(groupLayer([{ ...tasks[0] }, { ...tasks[0], id: "a2", paths: ["public/pages/x"] }], 3).length, 1, "overlapping paths share one session");
  const repo = tmp("aib-sessions-");
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: repo } });
  g("init", "-q"); g("config", "user.email", "t@t.invalid"); g("config", "user.name", "t");
  writeFileSync(path.join(repo, "README.md"), "x\n"); writeFileSync(path.join(repo, "BRIEF.json"), "{}"); g("add", "README.md"); g("commit", "-qm", "init");
  const seen: { id: string; cwd: string; tasks: string[] }[] = [];
  const recs = await runCoordinatedSessions({ git: { repo, pathEnv: process.env.PATH ?? "", home: repo }, workDir: tmp("aib-wt-"), tasks: tasks.slice(0, 3), maxSessions: 3, shouldStop: () => false,
    runSession: async (s) => {
      seen.push({ id: s.id, cwd: s.cwd, tasks: s.tasks.map((t) => t.id) });
      assert.ok(existsSync(path.join(s.cwd, "BRIEF.json")), "runner files provisioned in every worktree");
      const t = s.tasks[0];
      if (t.id === "c" && s.cwd !== repo) { mkdirSync(path.join(s.cwd, "src/api"), { recursive: true }); writeFileSync(path.join(s.cwd, "src/api/hack.js"), "x"); } // leaves its paths
      const dir = path.join(s.cwd, t.paths[0]); mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, `${t.id}.txt`), t.id);
      return { ok: true };
    } });
  const byTask = (id: string) => recs.filter((r) => r.tasks.includes(id));
  assert.equal(byTask("a")[0].mode, "parallel");
  assert.equal(byTask("a")[0].status, "merged");
  assert.equal(byTask("b")[0].status, "merged");
  assert.equal(byTask("c")[0].status, "rerun_serially");
  assert.match(String(byTask("c")[0].note), /outside its owned paths/);
  assert.equal(byTask("c")[1].mode, "serial");
  assert.ok(seen.filter((x) => x.cwd !== repo).length === 3 && new Set(seen.map((x) => x.cwd)).size >= 3, "isolated worktrees");
  assert.ok(existsSync(path.join(repo, "public/pages/a.txt")) && existsSync(path.join(repo, "src/api/b.txt")) && existsSync(path.join(repo, "public/css/c.txt")));
  assert.ok(!existsSync(path.join(repo, "src/api/hack.js")), "the out-of-bounds change was not merged");
  assert.equal(g("worktree", "list").trim().split("\n").length, 1, "worktrees cleaned up");
});
