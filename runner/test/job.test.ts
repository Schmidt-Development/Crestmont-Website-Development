// MOCK tests of the job orchestration: fake control plane (local HTTP) + FAKE Agent SDK query(). The fake agent
// scripts messages and edits files; no Claude model runs and the Anthropic API is never called. These tests do not
// demonstrate a real Claude build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runJob } from "../src/job.ts";
import type { JobDeps } from "../src/job.ts";
import { ControlPlaneClient } from "../src/control-plane.ts";
import { silentLogger } from "../src/log.ts";
import { BRIEF_RULES } from "../src/protocol.ts";
import type { Job } from "../src/protocol.ts";
import { FORBIDDEN_ENV } from "../src/workspace.ts";
import type { RunnerConfig } from "../src/config.ts";
import {
  startFakeControlPlane, makeJob, claimFrom, fakeSdk, happyAgent, makeSkillsDir, testManifest, makeConfig, SECRET,
  POLLUTED_ENV, delay, initMsg, toolMsg, resultMsg, writeFakeTranscript, tmp,
} from "./helpers.ts";
import type { FakeCP, FakeSdk } from "./helpers.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const manifest = testManifest();

async function setup(o: { job?: Partial<Job>; cfg?: Partial<RunnerConfig>; cp?: Parameters<typeof startFakeControlPlane>[0]; omitSkills?: string[] } = {}) {
  const cp = await startFakeControlPlane({ jobs: [makeJob(o.job)], ...(o.cp ?? {}) });
  const cfg = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: makeSkillsDir(manifest, o.omitSkills), ...(o.cfg ?? {}) });
  const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: cfg.runnerId, sleep: async () => {}, retry: { attempts: 2, baseMs: 1 } });
  const job = await claimFrom(cp);
  return { cp, cfg, client, job };
}

function deps(cfg: RunnerConfig, client: ControlPlaneClient, sdk: FakeSdk, extra: Partial<JobDeps> = {}): JobDeps {
  return { cfg, client, queryFn: sdk.queryFn, manifest, logger: silentLogger, heartbeatMs: 25, interruptGraceMs: 200, processEnv: POLLUTED_ENV, ...extra };
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

test("[AIB-RUNNER] happy path: claim -> heartbeat -> requirements -> checkpoint -> complete(ready_for_review) [mock SDK]", async () => {
  const { cp, cfg, client, job } = await setup();
  try {
    const sdk = fakeSdk(happyAgent({ stepDelayMs: 60 }));
    const s = await runJob(job, deps(cfg, client, sdk));
    assert.equal(s.outcome, "ready_for_review", String(s.complete?.error));
    // Protocol sequence.
    const order = cp.calls.map((c) => c.path.split("/").pop());
    assert.equal(order[0], "claim");
    assert.equal(order[order.length - 1], "complete");
    assert.ok(cp.byPath("heartbeat").length >= 1, "heartbeats sent");
    assert.ok(cp.byPath("requirements").length >= 3, "requirements reported per phase");
    const ckpts = cp.byPath("checkpoint");
    assert.ok(ckpts.length >= 4, "checkpoint after each phase and at the end");
    assert.ok(ckpts.every((c) => typeof c.body.archiveBase64 === "string"), "archives uploaded");
    assert.equal(ckpts[ckpts.length - 1].body.sessionId, "sess-happy-1");
    for (const c of cp.calls.slice(1)) assert.equal(c.body.leaseToken, job.leaseToken);
    // Phases: plan, build, verify; the later phases resume the same session.
    assert.equal(sdk.calls.length, 3);
    assert.ok(sdk.calls[0].prompt.includes("Phase 1 of 3"));
    assert.equal(sdk.calls[0].options.resume, undefined);
    assert.equal(sdk.calls[1].options.resume, "sess-happy-1");
    assert.equal(sdk.calls[2].options.resume, "sess-happy-1");
    // Options.
    const o = sdk.calls[0].options;
    assert.equal(o.cwd, path.join(s.workspace!, "repo"));
    assert.deepEqual(o.settingSources, ["project"]);
    assert.equal(o.permissionMode, "dontAsk");
    assert.equal(o.model, "claude-test-model");
    assert.ok(o.maxTurns! <= 200 && o.maxBudgetUsd! <= 25);
    assert.deepEqual([...(o.skills as string[])].sort(), Object.keys(manifest.skills).filter((n) => manifest.workflows["standard-brochure"].skills.some((s) => s.name === n)).sort());
    const sp = o.systemPrompt as { type: string; preset: string; append: string };
    assert.equal(sp.preset, "claude_code");
    for (const rule of BRIEF_RULES) assert.ok(sp.append.includes(rule), `system prompt states rule: ${rule.slice(0, 40)}`);
    assert.ok(o.disallowedTools!.includes("Bash(curl *)") && o.disallowedTools!.includes("Bash(git push *)") && o.disallowedTools!.includes("WebFetch"));
    // Final cost/turns: three phases at $0.50 each (cumulative session totals), 2 turns each.
    const done = cp.byPath("complete")[0].body;
    assert.equal(done.runCostUsd, 1.5);
    assert.equal(done.turns, 6);
    assert.equal(done.previewUrl, null);
    assert.match(String(done.report), /Preview unavailable: PREVIEW_DEPLOY_COMMAND is not configured/);
    assert.match(String(done.sourceRepo), /^runner-local:/);
    // Requirements: seed + agent + runner checks; verified without evidence was downgraded.
    const lastReq = cp.byPath("requirements").pop()!.body.items as { key: string; status: string; evidence?: string }[];
    const byKey = Object.fromEntries(lastReq.map((r) => [r.key, r]));
    assert.equal(byKey["page:home"].status, "verified");
    assert.equal(byKey["page:contact"].status, "implemented_unverified");
    assert.equal(byKey["check:static-check"].status, "verified");
    assert.match(byKey["check:static-check"].evidence!, /npm run -s check -- --package starter/);
    // Workspace: isolated repo with commits, runner config, provisioned skills, brief files kept out of git.
    const repo = path.join(s.workspace!, "repo");
    assert.ok(Number(git(repo, "rev-list", "--count", "HEAD")) >= 2);
    assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "ai-build/first-build");
    assert.equal(git(repo, "ls-files", "BRIEF.json", ".claude", ".crestmont"), "");
    const settings = JSON.parse(readFileSync(path.join(repo, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.permissions.defaultMode, "dontAsk");
    assert.ok(settings.permissions.deny.includes("Edit(.git/**)"));
    assert.ok(settings.permissions.deny.includes("Read(//run/secrets/**)"));
    assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
    assert.ok(existsSync(path.join(repo, ".claude", "skills", "frontend-design", "SKILL.md")));
  } finally { await cp.close(); }
});

test("[AIB-RUNNER] the agent environment is built from an allowlist: no runner secret, platform or payment credentials [mock SDK]", async () => {
  const { cp, cfg, client, job } = await setup();
  try {
    const sdk = fakeSdk(happyAgent());
    const s = await runJob(job, deps(cfg, client, sdk));
    for (const call of sdk.calls) {
      const env = call.options.env!;
      for (const k of Object.keys(env)) assert.ok(!FORBIDDEN_ENV.test(k), `forbidden variable ${k}`);
      for (const v of Object.values(POLLUTED_ENV).filter((x) => x.length > 12 && !x.includes("/"))) {
        assert.ok(!Object.values(env).includes(v), "no secret value leaked under another name");
      }
      assert.equal(env.HOME, path.join(s.workspace!, "home"));
      assert.equal(env.CLAUDE_CONFIG_DIR, path.join(s.workspace!, "home", ".claude"));
      assert.equal(env.ANTHROPIC_API_KEY, cfg.anthropicApiKey);
      assert.ok(!("BUILD_RUNNER_SECRET" in env) && !("CLOUDFLARE_API_TOKEN" in env) && !("STRIPE_SECRET_KEY" in env));
    }
  } finally { await cp.close(); }
});

for (const reason of ["canceled", "paused", "budget"] as const) {
  test(`[AIB-RUNNER] server stop (${reason}) interrupts the agent, checkpoints and completes as stopped [mock SDK]`, async () => {
    let stopNow = false;
    const { cp, cfg, client, job } = await setup({ cp: { heartbeat: () => (stopNow ? { continue: false, reason } : { continue: true, leaseExpiresAt: "x" }) } });
    try {
      const sdk = fakeSdk(async function* (ctx): AsyncGenerator<SDKMessage> {
        const sid = ctx.options.resume ?? "sess-stop";
        writeFakeTranscript(ctx.options, sid);
        yield initMsg(sid);
        if (ctx.prompt.includes("Phase 1 of 3")) { yield resultMsg(sid, 0.4, 1); return; }
        yield toolMsg("b1", "Edit", { file_path: "public/index.html" }, sid);
        stopNow = true;
        await ctx.waitInterrupt; // a long build step, ended by interrupt()
        yield resultMsg(sid, 0.9, 3, "error_during_execution");
      });
      const s = await runJob(job, deps(cfg, client, sdk));
      assert.equal(s.outcome, "stopped");
      assert.equal(sdk.interrupts, 1, "interrupt() called");
      assert.equal(sdk.calls.length, 2, "no further phases after the stop");
      const ckpts = cp.byPath("checkpoint");
      assert.ok(ckpts.length >= 2, "checkpoint before stopping");
      assert.equal(ckpts[ckpts.length - 1].body.sessionId, "sess-stop");
      const done = cp.byPath("complete")[0].body;
      assert.equal(done.outcome, "stopped");
      assert.equal(done.runCostUsd, 0.9);
      assert.match(String(done.report), new RegExp(`control plane requested stop \\(${reason}\\)`));
    } finally { await cp.close(); }
  });
}

test("[AIB-RUNNER] lease_lost stops the agent and never completes; the workspace is preserved [mock SDK]", async () => {
  let lose = false;
  const { cp, cfg, client, job } = await setup({ cp: { heartbeat: () => (lose ? "lease_lost" : { continue: true, leaseExpiresAt: "x" }) } });
  try {
    const sdk = fakeSdk(async function* (ctx): AsyncGenerator<SDKMessage> {
      yield initMsg("sess-lease");
      lose = true;
      await ctx.waitInterrupt;
      yield resultMsg("sess-lease", 0.2, 1, "error_during_execution");
    });
    const s = await runJob(job, deps(cfg, client, sdk));
    assert.equal(s.outcome, "lease_lost");
    assert.equal(sdk.interrupts, 1);
    assert.equal(cp.byPath("complete").length, 0, "complete is never called after lease loss");
    assert.equal(cp.byPath("checkpoint").length, 0, "no checkpoint after lease loss");
    assert.ok(s.workspace && existsSync(path.join(s.workspace, "repo", "public", "index.html")), "workspace kept");
  } finally { await cp.close(); }
});

test("[AIB-RUNNER] local budget cap: maxBudgetUsd never exceeds the stricter limit; reaching it stops the build [mock SDK]", async () => {
  const { cp, cfg, client, job } = await setup({ job: { limits: { model: "m", maxTurns: 200, maxRuntimeMinutes: 120, runBudgetUsd: 3, projectBudgetRemainingUsd: 1.25 } } });
  try {
    const sdk = fakeSdk(async function* (ctx): AsyncGenerator<SDKMessage> {
      yield initMsg("sess-b");
      yield resultMsg("sess-b", 1.3, 4, "error_max_budget_usd");
    });
    const s = await runJob(job, deps(cfg, client, sdk));
    assert.equal(sdk.calls.length, 1);
    assert.equal(sdk.calls[0].options.maxBudgetUsd, 1.25, "project remaining budget is the stricter cap");
    assert.equal(s.outcome, "failed");
    assert.match(String(s.complete?.error), /Local safety limit reached \(budget\)/);
    assert.equal(s.complete?.runCostUsd, 1.3);
    assert.ok(cp.byPath("checkpoint").length >= 1);
  } finally { await cp.close(); }
});

test("[AIB-RUNNER] local turn cap interrupts a runaway session that ignores maxTurns [mock SDK]", async () => {
  const { cp, cfg, client, job } = await setup({
    job: { limits: { model: "m", maxTurns: 3, maxRuntimeMinutes: 120, runBudgetUsd: 25, projectBudgetRemainingUsd: 60 } },
  });
  try {
    const sdk = fakeSdk(async function* (ctx): AsyncGenerator<SDKMessage> {
      yield initMsg("sess-t");
      for (let i = 0; i < 50 && !ctx.interrupted(); i++) { yield toolMsg(`t${i}`, "Bash", { command: "ls" }, "sess-t"); await delay(15); }
      yield resultMsg("sess-t", 0.7, 6, "error_during_execution");
    });
    const s = await runJob(job, deps(cfg, client, sdk));
    assert.ok(sdk.calls[0].options.maxTurns! <= 3, "maxTurns passed to the SDK respects the cap");
    assert.equal(sdk.interrupts, 1, "runaway session interrupted locally");
    assert.equal(s.outcome, "failed");
    assert.match(String(s.complete?.error), /Local safety limit reached \(turns\)/);
  } finally { await cp.close(); }
});

test("[AIB-RUNNER] local runtime cap stops the agent; a server 'runtime' answer completes as stopped [mock SDK]", async () => {
  let ask = false;
  const { cp, cfg, client, job } = await setup({ cp: { heartbeat: () => (ask ? { continue: false, reason: "runtime" } : { continue: true, leaseExpiresAt: "x" }) } });
  try {
    const sdk = fakeSdk(async function* (ctx): AsyncGenerator<SDKMessage> {
      yield initMsg("sess-r");
      await ctx.waitInterrupt;
      ask = true;
      yield resultMsg("sess-r", 0.1, 1, "error_during_execution");
    });
    const s = await runJob(job, deps(cfg, client, sdk, { runtimeMs: 1500, heartbeatMs: 10_000 }));
    assert.equal(sdk.interrupts, 1);
    assert.equal(s.outcome, "stopped");
    assert.match(String(s.complete?.report), /requested stop \(runtime\)/);
  } finally { await cp.close(); }
});

test("[AIB-RUNNER] preflight fails the job when a required skill is missing; the agent never starts [mock SDK]", async () => {
  const { cp, cfg, client, job } = await setup({ omitSkills: ["webapp-testing", "image-to-code"] });
  try {
    const sdk = fakeSdk(happyAgent());
    const s = await runJob(job, deps(cfg, client, sdk));
    assert.equal(s.outcome, "failed");
    assert.equal(sdk.calls.length, 0);
    assert.match(String(s.complete?.error), /Preflight failed: Required skill "Webapp Testing" \(webapp-testing\): not found/);
    assert.doesNotMatch(String(s.complete?.error), /image-to-code/, "optional skills do not fail preflight");
  } finally { await cp.close(); }
});

test("[AIB-RUNNER] preflight fails the job when a required tool is missing [mock SDK]", async () => {
  const m = testManifest();
  m.tools.chromium = { command: ["definitely-not-installed-browser-xyz", "--version"], hint: "install chromium" };
  m.workflows["standard-brochure"].tools.push("chromium");
  const { cp, cfg, client, job } = await setup();
  try {
    const sdk = fakeSdk(happyAgent());
    const s = await runJob(job, { ...deps(cfg, client, sdk), manifest: m });
    assert.equal(s.outcome, "failed");
    assert.match(String(s.complete?.error), /Required tool chromium: not installed/);
    assert.equal(sdk.calls.length, 0);
  } finally { await cp.close(); }
});

async function firstAttempt(cp: FakeCP, cfg: RunnerConfig, client: ControlPlaneClient, job: Job, stopAfterPlan: boolean) {
  const sdk = fakeSdk(async function* (ctx): AsyncGenerator<SDKMessage> {
    const sid = "sess-resume-1";
    writeFakeTranscript(ctx.options, sid);
    yield initMsg(sid);
    writeFileSync(path.join(String(ctx.options.cwd), "public", "attempt1.txt"), "work from attempt 1\n");
    yield resultMsg(sid, 0.8, 2, stopAfterPlan ? "error_max_budget_usd" : "success");
  });
  return runJob(job, deps(cfg, client, sdk));
}

test("[AIB-RUNNER] resume restores the checkpoint (git bundle + transcript) and passes resume: sessionId [mock SDK]", async () => {
  const j1 = makeJob({ limits: { model: "m", maxTurns: 200, maxRuntimeMinutes: 120, runBudgetUsd: 25, projectBudgetRemainingUsd: 0.5 } });
  const cp = await startFakeControlPlane({ jobs: [j1] });
  const cfg = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: makeSkillsDir(manifest) });
  const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: cfg.runnerId, sleep: async () => {} });
  try {
    const s1 = await firstAttempt(cp, cfg, client, await claimFrom(cp), true);
    assert.equal(s1.outcome, "failed");
    const lastCk = cp.byPath("checkpoint").pop()!.body;
    const j2 = makeJob({
      id: j1.id, attempt: 2, leaseToken: "b".repeat(64),
      resume: { sessionId: "sess-resume-1", workspaceRef: String(lastCk.workspaceRef), checkpointKey: "builds/x/ckpt-9.tgz", sourceRepo: String(lastCk.sourceRepo), sourceBranch: "ai-build/first-build", sourceCommit: String(lastCk.sourceCommit) },
    });
    cp.jobs.push(j2);
    const job2 = await claimFrom(cp);
    let sawTranscript = false;
    const sdk = fakeSdk(async function* (ctx): AsyncGenerator<SDKMessage> {
      const home = String(ctx.options.env?.HOME);
      sawTranscript ||= readdirSync(path.join(home, ".claude", "projects")).some((d) => existsSync(path.join(home, ".claude", "projects", d, "sess-resume-1.jsonl")));
      yield* resumed(ctx);
    });
    const resumed = happyAgent({ startTotal: 0.8 });
    const s2 = await runJob(job2, deps(cfg, client, sdk));
    assert.notEqual(s2.workspace, s1.workspace, "a new isolated workspace per attempt");
    assert.equal(sdk.calls[0].options.resume, "sess-resume-1", "resume passed on the first phase");
    assert.ok(sdk.calls[0].prompt.includes("continuing from an earlier attempt"));
    assert.ok(sawTranscript, "session transcript restored under the job's CLAUDE_CONFIG_DIR");
    assert.ok(existsSync(path.join(s2.workspace!, "repo", "public", "attempt1.txt")), "source restored from the git bundle");
    assert.equal(s2.outcome, "ready_for_review", String(s2.complete?.error));
    // Cost baseline from the checkpoint: the session total was 0.8 before this attempt.
    // Session totals 1.3 / 1.8 / 2.3 include 0.8 restored from attempt 1, which is not charged to this attempt.
    assert.ok(Math.abs(Number(s2.complete?.runCostUsd) - 1.5) < 1e-9, String(s2.complete?.runCostUsd));
    assert.match(String(s2.complete?.report), /Resumed Agent SDK session sess-resume-1/);
  } finally { await cp.close(); }
});

test("[AIB-RUNNER] resume on another host fetches the archive (proposed endpoint) or falls back to a new session and says so [mock SDK]", async () => {
  const j1 = makeJob({ limits: { model: "m", maxTurns: 200, maxRuntimeMinutes: 120, runBudgetUsd: 25, projectBudgetRemainingUsd: 0.5 } });
  for (const serve of [true, false]) {
    const cp = await startFakeControlPlane({ jobs: [{ ...j1, id: `${j1.id}${serve}` }], serveCheckpointFetch: serve });
    const cfg1 = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: makeSkillsDir(manifest) });
    const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: "r", sleep: async () => {} });
    try {
      await firstAttempt(cp, cfg1, client, await claimFrom(cp), true);
      const ck = cp.byPath("checkpoint").filter((c) => c.body.archiveBase64).length;
      const key = `builds/${j1.id}${serve}/ckpt-${cp.byPath("checkpoint").length}.tgz`;
      assert.ok(ck >= 1 && cp.archives.has(key));
      cp.jobs.push(makeJob({ id: `${j1.id}${serve}`, attempt: 2, leaseToken: "c".repeat(64), resume: { sessionId: "sess-resume-1", workspaceRef: "gone-on-this-host", checkpointKey: key } }));
      const cfg2 = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: cfg1.skillsSourceDir, workspacesRoot: tmp("aib-host2-") });
      const sdk = fakeSdk(happyAgent({ sessionId: "sess-new-2" }));
      const s2 = await runJob(await claimFrom(cp), deps(cfg2, client, sdk));
      if (serve) {
        assert.equal(sdk.calls[0].options.resume, "sess-resume-1");
        assert.ok(existsSync(path.join(s2.workspace!, "repo", "public", "attempt1.txt")));
      } else {
        assert.equal(sdk.calls[0].options.resume, undefined, "no resume without the transcript");
        assert.match(String(s2.complete?.report), /could not be restored; continued from the git source with a new session/);
        assert.match(String(s2.complete?.report), /does not serve checkpoint archives/);
        assert.ok(sdk.calls[0].prompt.includes("Runner note: The previous Agent SDK session"));
      }
      assert.equal(s2.outcome, "ready_for_review", String(s2.complete?.error));
    } finally { await cp.close(); }
  }
});

test("[AIB-RUNNER] failing acceptance checks get one repair round, then fail honestly [mock SDK]", async () => {
  const { cp, cfg, client, job } = await setup();
  try {
    const sdk = fakeSdk(async function* (ctx): AsyncGenerator<SDKMessage> {
      yield initMsg("sess-c");
      yield resultMsg("sess-c", 0.1 * ctx.call, 1); // never replaces the starter placeholders
    });
    const s = await runJob(job, deps(cfg, client, sdk));
    assert.equal(sdk.calls.length, 4, "plan, build, verify, repair");
    assert.ok(sdk.calls[3].prompt.startsWith("Repair"));
    assert.ok(existsSync(path.join(s.workspace!, "repo", ".crestmont", "runner-checks.json")));
    assert.equal(s.outcome, "failed");
    assert.match(String(s.complete?.error), /Acceptance checks failed: static-check/);
    assert.match(String(s.complete?.report), /FAIL `npm run -s check -- --package starter`/);
    assert.match(String(s.complete?.report), /STARTER-PLACEHOLDER/);
    assert.equal(s.complete?.previewUrl, null);
  } finally { await cp.close(); }
});

test("[AIB-RUNNER] preview deploy runs the configured command with preview credentials the agent never had [mock SDK]", async () => {
  const envDump = path.join(tmp("aib-prev-"), "env.json");
  const cmd = `node -e "require('fs').writeFileSync('${envDump}', JSON.stringify(process.env)); console.log('Deployed'); console.log('PREVIEW_URL=https://' + process.env.CRESTMONT_PREVIEW_NAME + '.preview.workers.dev')"`;
  const { cp, cfg, client, job } = await setup({ cfg: { preview: { command: cmd, envNames: ["CLOUDFLARE_API_TOKEN"], timeoutMs: 30_000 } } });
  try {
    const sdk = fakeSdk(happyAgent());
    const s = await runJob(job, deps(cfg, client, sdk));
    assert.equal(s.outcome, "ready_for_review", String(s.complete?.error));
    assert.equal(s.complete?.previewUrl, "https://cm-prv-prj-test1.preview.workers.dev");
    const seen = JSON.parse(readFileSync(envDump, "utf8")) as Record<string, string>;
    assert.equal(seen.CLOUDFLARE_API_TOKEN, POLLUTED_ENV.CLOUDFLARE_API_TOKEN, "preview command gets its credential");
    assert.ok(!("BUILD_RUNNER_SECRET" in seen) && !("STRIPE_SECRET_KEY" in seen) && !("ANTHROPIC_API_KEY" in seen));
    assert.ok(!("CLOUDFLARE_API_TOKEN" in sdk.calls[0].options.env!), "agent never had it");
  } finally { await cp.close(); }
});

test("[AIB-RUNNER] preview deploy is refused when the agent added a custom build command or routes [mock SDK]", async () => {
  const { cp, cfg, client, job } = await setup({ cfg: { preview: { command: "echo PREVIEW_URL=https://x.workers.dev", envNames: [], timeoutMs: 10_000 } } });
  try {
    const sdk = fakeSdk(async function* (ctx): AsyncGenerator<SDKMessage> {
      if (ctx.prompt.includes("Phase 2 of 3")) {
        const f = path.join(String(ctx.options.cwd), "wrangler.jsonc");
        writeFileSync(f, readFileSync(f, "utf8").replace('"main"', '"build": { "command": "curl evil" },\n  "main"'));
      }
      yield* happyAgent()(ctx);
    });
    const s = await runJob(job, deps(cfg, client, sdk));
    assert.equal(s.complete?.previewUrl, null);
    assert.match(String(s.complete?.report), /refused to deploy: wrangler.jsonc defines a custom build command/);
  } finally { await cp.close(); }
});

test("[AIB-RUNNER] needs_information when the agent records blocking gaps and blocked requirements [mock SDK]", async () => {
  const { cp, cfg, client, job } = await setup();
  try {
    const sdk = fakeSdk(async function* (ctx): AsyncGenerator<SDKMessage> {
      yield* happyAgent()(ctx);
      if (ctx.prompt.includes("Phase 3 of 3")) writeFileSync(path.join(String(ctx.options.cwd), ".crestmont", "needs-information.json"), JSON.stringify(["Business license number for the footer"]));
    });
    const s = await runJob(job, deps(cfg, client, sdk));
    assert.equal(s.outcome, "needs_information");
    assert.deepEqual(s.complete?.missingInformation, ["Business license number for the footer"]);
  } finally { await cp.close(); }
});

test("[AIB-RUNNER] custom strategy uses no starter and asks for a requirements map, architecture and remaining-work list [mock SDK]", async () => {
  const { cp, cfg, client, job } = await setup({ job: { strategy: "custom", packageId: null, starter: null } });
  try {
    const sdk = fakeSdk(async function* (ctx): AsyncGenerator<SDKMessage> {
      yield initMsg("sess-custom");
      yield resultMsg("sess-custom", 0.2 * ctx.call, 1);
    });
    const s = await runJob(job, deps(cfg, client, sdk));
    assert.ok(!existsSync(path.join(s.workspace!, "repo", "public")), "no starter copied");
    assert.match(sdk.calls[0].prompt, /requirements-map\.md/);
    assert.match(sdk.calls[0].prompt, /ARCHITECTURE\.md/);
    assert.match(sdk.calls[2].prompt, /REMAINING-WORK\.md/);
    assert.equal(s.outcome, "ready_for_review");
    assert.match(String(s.complete?.report), /No automated acceptance checks were run/);
  } finally { await cp.close(); }
});
