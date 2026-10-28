// MOCK tests of failure handling: model server down / slow / erroring / returning garbage or a context overflow,
// cancellation during retry backoff, lease loss when the control plane goes silent, unsafe checkpoint archives, and
// the health endpoint's model reachability and last-error reporting. Fake model server, fake control plane, fake
// docker executor; no real model, Docker daemon or paid API is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { LocalProvider } from "../src/providers/local.ts";
import { OpenAICompatClient, ModelServerError, isContextOverflow } from "../src/providers/openai-client.ts";
import { RunTracker, StopSwitch } from "../src/agent.ts";
import { createWorkspace } from "../src/workspace.ts";
import { writeBriefFiles } from "../src/prompt.ts";
import { silentLogger, registerSecret } from "../src/log.ts";
import { runJob, leaseWindowFrom } from "../src/job.ts";
import { runLoop } from "../src/main.ts";
import { ControlPlaneClient } from "../src/control-plane.ts";
import { buildCheckpoint, restoreCheckpoint } from "../src/checkpoint.ts";
import { run } from "../src/exec.ts";
import { initRepo } from "../src/git.ts";
import { newHealthState, startHealthServer, healthStatus, healthText } from "../src/health.ts";
import { serveOneDraft } from "../src/drafts.ts";
import type { PhaseRequest } from "../src/providers/types.ts";
import type { RunnerConfig } from "../src/config.ts";
import {
  makeConfig, makeJob, tmp, startFakeModel, fakeDocker, delay, startFakeControlPlane, claimFrom, makeSkillsDir,
  testManifest, SECRET, POLLUTED_ENV,
} from "./helpers.ts";
import type { FakeModelReply, FakeModelRequest } from "./helpers.ts";

const finish = (summary = "done"): FakeModelReply => ({ toolCalls: [{ name: "finish", arguments: { summary } }] });
const listDir = (p = "."): FakeModelReply => ({ toolCalls: [{ name: "list_dir", arguments: { path: p } }] });

async function provider(baseUrl: string, o: { retries?: number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; local?: Partial<RunnerConfig["local"]> } = {}) {
  const base = makeConfig({ controlPlaneUrl: "http://cp.invalid", skillsSourceDir: tmp() });
  const cfg = makeConfig({ controlPlaneUrl: "http://cp.invalid", skillsSourceDir: tmp(), local: { ...base.local, baseUrl, requestTimeoutMs: o.timeoutMs ?? 30_000, ...(o.local ?? {}) } });
  const ws = createWorkspace(tmp("aib-ws-"), { id: "bld_res", attempt: 1 });
  mkdirSync(path.join(ws.repo, "public"), { recursive: true });
  writeFileSync(path.join(ws.repo, "public", "index.html"), "<h1>Hello</h1>\n");
  const job = makeJob();
  writeBriefFiles(ws.repo, job, job.requirements);
  const p = new LocalProvider({ cfg, executor: fakeDocker().executor, log: silentLogger, clientRetries: o.retries ?? 0, clientSleep: o.sleep ?? (async () => {}) });
  await p.prepare({ job, ws, skillNames: [], referenceDomains: [], processEnv: {}, systemPromptAppend: "" });
  return { p, ws, cfg };
}

function req(over: Partial<PhaseRequest> = {}): PhaseRequest {
  return { phase: "build", prompt: "Phase 2 of 3: build.", maxTurns: 40, maxBudgetUsd: 0, maxWallMs: 30_000, resumeSessionId: null, tracker: new RunTracker(), stop: new StopSwitch(), ...over };
}

async function closedPortUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}/v1`;
}

test("[AIB-RUNNER] model server down (connection refused): bounded retries, then the phase ends with an honest error [fake]", async () => {
  const url = await closedPortUrl();
  const sleeps: number[] = [];
  const { p } = await provider(url, { retries: 3, sleep: async (ms) => { sleeps.push(ms); } });
  const res = await p.run(req());
  assert.equal(res.status, "error");
  assert.match(String(res.error), /^local model request failed: /);
  assert.deepEqual(sleeps, [1000, 2000, 4000], "3 retries with exponential backoff, then give up");
  const pre = await p.preflight();
  assert.ok(pre.errors.some((e) => /is not reachable/.test(e)), "preflight names the unreachable model server");
});

test("[AIB-RUNNER] model server 500/503/429 are retried and recover; 400 is not retried [fake model]", async () => {
  const m = await startFakeModel((_r, n) => (n === 1 ? { status: 500, body: "{\"error\":\"llama runner process has terminated\"}" } : n === 2 ? { status: 503, body: "busy" } : n === 3 ? { status: 429, body: "slow down" } : finish()));
  try {
    const { p } = await provider(m.url, { retries: 3 });
    const res = await p.run(req());
    assert.equal(res.status, "success");
    assert.equal(m.requests.length, 4);
  } finally { await m.close(); }
  const bad = await startFakeModel(() => ({ status: 400, body: "{\"error\":\"invalid tool schema\"}" }));
  try {
    const { p } = await provider(bad.url, { retries: 3 });
    const res = await p.run(req());
    assert.equal(res.status, "error");
    assert.match(String(res.error), /answered 400: .*invalid tool schema/);
    assert.equal(bad.requests.length, 1, "a client error is not retried");
  } finally { await bad.close(); }
});

test("[AIB-RUNNER] model request timeout is retried once, then the phase fails (no endless 15-minute waits) [fake model]", async () => {
  const m = await startFakeModel(async (_r, _n, sig) => { while (!sig.aborted) await delay(10); return finish(); });
  try {
    const { p } = await provider(m.url, { retries: 3, timeoutMs: 150 });
    const t0 = Date.now();
    const res = await p.run(req());
    assert.equal(res.status, "error");
    assert.match(String(res.error), /timeout|aborted/i);
    assert.equal(m.requests.length, 2, "one retry after the first timeout, none after the second");
    assert.ok(Date.now() - t0 < 10_000);
  } finally { await m.close(); }
});

test("[AIB-RUNNER] malformed model responses: non-JSON body fails without retry; empty choices are retried [fake]", async () => {
  // A raw HTTP server: the fake model helper always sends valid JSON.
  let hits = 0;
  let mode: "html" | "nochoices" = "html";
  const srv = createServer((q, s) => {
    hits++;
    q.resume();
    q.on("end", () => {
      s.writeHead(200, { "content-type": mode === "html" ? "text/html" : "application/json" });
      s.end(mode === "html" ? "<html>proxy error</html>" : JSON.stringify({ choices: [] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
  try {
    const client = new OpenAICompatClient({ baseUrl: url, apiKey: "ollama", timeoutMs: 5000, retries: 2, sleep: async () => {} });
    await assert.rejects(client.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }), SyntaxError);
    assert.equal(hits, 1, "unparseable body: no retry");
    mode = "nochoices"; hits = 0;
    await assert.rejects(client.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }), (e: unknown) => e instanceof ModelServerError && /no choices/.test(e.message));
    assert.equal(hits, 3, "empty choices: treated as a server fault and retried");
  } finally { srv.close(); }
});

test("[AIB-RUNNER] malformed tool calls: unknown tool, array/number arguments, missing name get corrective feedback; the loop recovers [fake model]", async () => {
  const m = await startFakeModel((_r, n) => [
    { toolCalls: [{ name: "delete_everything", arguments: { path: "/" } }] },
    { toolCalls: [{ name: "read_file", arguments: "[\"public/index.html\"]" }] },
    { toolCalls: [{ name: "read_file", arguments: "42" }] },
    { toolCalls: [{ name: "", arguments: { path: "x" } }] },
    { toolCalls: [{ name: "read_file", arguments: { path: "public/index.html" } }] },
    finish(),
  ][n - 1] ?? finish());
  try {
    const { p } = await provider(m.url, { local: { contextTokens: 32_768 } });
    const r = req();
    const res = await p.run(r);
    assert.equal(res.status, "success", String(res.error));
    const toolMsgs = m.requests.at(-1)!.messages.filter((x) => x.role === "tool").map((x) => String(x.content));
    assert.match(toolMsgs[0], /ERROR: invalid call to delete_everything/);
    assert.match(toolMsgs[1], /ERROR: invalid call to read_file/);
    assert.match(toolMsgs[2], /ERROR: invalid call to read_file/);
    assert.match(toolMsgs[3], /ERROR: invalid call to \(no tool name\)/);
    assert.match(toolMsgs[4], /Hello/);
  } finally { await m.close(); }
});

test("[AIB-RUNNER] context overflow (400 'exceeds the context size'): the loop compacts and retries; repeated overflow fails the phase [fake model]", async () => {
  assert.ok(isContextOverflow(new ModelServerError("model server answered 400: {\"error\":\"the request exceeds the available context size, try increasing it\"}", 400, false)));
  assert.ok(isContextOverflow(new ModelServerError("model server answered 400: This model's maximum context length is 32768 tokens", 400, false)));
  assert.ok(!isContextOverflow(new ModelServerError("model server answered 400: invalid tool schema", 400, false)));
  assert.ok(!isContextOverflow(new Error("context length exceeded")), "only model server answers count");
  let overflowAt = 0;
  const m = await startFakeModel((r, n) => {
    if (n <= 10) return { toolCalls: [{ name: "write_file", arguments: { path: `public/p${n}.html`, content: `<p>${String(n).repeat(1500)}</p>\n` } }] };
    if (n === 11) { overflowAt = r.messages.length; return { status: 400, body: "{\"error\":\"the request exceeds the available context size (n_ctx 8192)\"}" }; }
    return finish();
  });
  try {
    // ~15k characters of history fit the runner's own estimate for an 8K context, but the server says otherwise.
    const { p } = await provider(m.url, { local: { contextTokens: 8192, maxOutputTokensPerCall: 512 } });
    const r = req();
    const res = await p.run(r);
    assert.equal(res.status, "success", String(res.error));
    const after = m.requests[11];
    assert.ok(after.messages.length < overflowAt, `history compacted after the overflow (${after.messages.length} < ${overflowAt})`);
    assert.match(String(after.messages[1].content), /Summary of earlier work/);
    assert.ok(r.tracker.activity.some((a) => /context overflow; compacting/.test(a.message)));
  } finally { await m.close(); }
  const always = await startFakeModel(() => ({ status: 400, body: "{\"error\":\"prompt is too long\"}" }));
  try {
    const { p } = await provider(always.url);
    const res = await p.run(req());
    assert.equal(res.status, "error");
    assert.match(String(res.error), /prompt is too long/);
    assert.equal(always.requests.length, 3, "two compaction retries, then an honest failure");
  } finally { await always.close(); }
});

test("[AIB-RUNNER] cancellation during retry backoff stops the phase at once (backoff sleep is abortable) [fake model]", async () => {
  const m = await startFakeModel(() => ({ status: 503, body: "loading model" }));
  try {
    const { p } = await provider(m.url, { retries: 5, sleep: async (ms) => { await delay(ms * 10); } });
    const r = req();
    setTimeout(() => r.stop.request("server:canceled"), 150);
    const t0 = Date.now();
    const res = await p.run(r);
    assert.equal(res.status, "stopped");
    assert.equal(res.stoppedBy, "server:canceled");
    assert.ok(Date.now() - t0 < 3000, `stopped promptly (${Date.now() - t0} ms), not after the 10 s backoff`);
  } finally { await m.close(); }
});

test("[AIB-RUNNER] lease watchdog: when heartbeats fail for longer than the lease window the runner stops without completing [fake]", async () => {
  assert.equal(leaseWindowFrom(new Date(Date.now() + 180_000).toISOString()) > 170_000, true);
  assert.equal(leaseWindowFrom("not a date"), 180_000);
  assert.equal(leaseWindowFrom(new Date(Date.now() - 3_600_000).toISOString()), 30_000, "clamped (clock skew)");
  assert.equal(leaseWindowFrom(new Date(Date.now() + 86_400_000).toISOString()), 600_000);
  const manifest = testManifest();
  const cp = await startFakeControlPlane({ jobs: [makeJob()], heartbeat: () => "unavailable" });
  // The agent must still be working when the lease window runs out. Each turn makes a DIFFERENT, productive call:
  // repeating one identical call would trip the runner's loop detector (local provider, loopRepeats) and end the run
  // as a legitimate "failed" before the window elapsed on a fast machine — a race, not a lease-handling defect.
  const progress = (n: number): FakeModelReply => ({ toolCalls: [{ name: "write_file", arguments: { path: `.crestmont/progress-${n}.md`, content: `step ${n}\n` } }] });
  const model = await startFakeModel(async (_r, n, sig) => { await delay(30); return sig.aborted ? finish() : progress(n); });
  const base = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: "x" });
  const cfg = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: makeSkillsDir(manifest), local: { ...base.local, baseUrl: model.url } });
  const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: cfg.runnerId, sleep: async () => {}, retry: { attempts: 1, baseMs: 1 } });
  try {
    const job = await claimFrom(cp);
    const t0 = Date.now();
    const s = await runJob(job, { cfg, client, manifest, logger: silentLogger, heartbeatMs: 25, leaseWindowMs: 300, processEnv: POLLUTED_ENV, dockerExecutor: fakeDocker().executor });
    assert.equal(s.outcome, "lease_lost", `stopped for ${s.stopReason ?? "no recorded reason"}`);
    assert.equal(s.complete, null);
    assert.equal(cp.byPath("complete").length, 0, "never completes a job it may no longer own");
    assert.ok(s.workspace && existsSync(s.workspace), "workspace preserved for the next attempt");
    assert.ok(Date.now() - t0 < 20_000);
  } finally { await cp.close(); await model.close(); }
});

test("[AIB-RUNNER] checkpoints never carry links: symlinks are left out when building and archives with links are refused on restore", async () => {
  const ws = createWorkspace(tmp("aib-ws-"), { id: "bld_ck", attempt: 1 });
  const git = { repo: ws.repo, pathEnv: process.env.PATH ?? "/usr/bin:/bin", home: ws.home };
  await initRepo(git, { name: "t", email: "t@t.invalid" }, "ai-build/first-build");
  writeFileSync(path.join(ws.repo, "index.html"), "x");
  mkdirSync(path.join(ws.dir, "agent"), { recursive: true });
  writeFileSync(path.join(ws.dir, "agent", "local-abcd1234.json"), "{}");
  symlinkSync("/etc/passwd", path.join(ws.dir, "agent", "leak.json"));
  mkdirSync(path.join(ws.home, ".claude", "projects", "p"), { recursive: true });
  symlinkSync("/etc/hostname", path.join(ws.home, ".claude", "projects", "p", "s.jsonl"));
  const built = await buildCheckpoint(ws, git, { jobId: "bld_ck", attempt: 1, sessionId: null, sessionTotalCostUsd: 0, sourceBranch: null, sourceCommit: null }, git.pathEnv);
  const listing = await run("tar", ["-tvzf", built.file], { env: { PATH: git.pathEnv }, timeoutMs: 30_000 });
  assert.ok(listing.stdout.includes("local-agent/local-abcd1234.json"));
  assert.doesNotMatch(listing.stdout, /leak\.json|s\.jsonl/, "symlinks are not archived");
  assert.ok(listing.stdout.split("\n").filter(Boolean).every((l) => "-d".includes(l[0])));

  // A crafted archive (e.g. tampered with in storage) holding a symlink is refused before anything is copied.
  const evil = tmp("aib-evil-");
  mkdirSync(path.join(evil, "local-agent"), { recursive: true });
  symlinkSync("/run/secrets/build_runner_secret", path.join(evil, "local-agent", "local-abcd1234.json"));
  writeFileSync(path.join(evil, "meta.json"), "{}");
  const archive = path.join(tmp("aib-evil-out-"), "evil.tgz");
  assert.equal((await run("tar", ["-czf", archive, "-C", evil, "."], { env: { PATH: git.pathEnv }, timeoutMs: 30_000 })).code, 0);
  const ws2 = createWorkspace(tmp("aib-ws-"), { id: "bld_ck2", attempt: 2 });
  const { readFileSync } = await import("node:fs");
  await assert.rejects(restoreCheckpoint(ws2, { ...git, repo: ws2.repo, home: ws2.home }, readFileSync(archive), "local-abcd1234", git.pathEnv, null), /link or special file/);
  assert.equal(existsSync(path.join(ws2.dir, "agent")), false, "nothing restored");
  assert.deepEqual(readdirSync(ws2.repo), []);
});

test("[AIB-RUNNER] health: model probe failure stops claiming, reports reachability and the last error without secrets; recovery resumes claims", async () => {
  const leakyKey = "sk-ant-api03-thisisnotarealkeybutlookslikeone0000";
  registerSecret("super-secret-runner-value-123456");
  const cp = await startFakeControlPlane({ jobs: [] });
  const cfg = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: tmp() });
  const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: cfg.runnerId, sleep: async () => {}, retry: { attempts: 1, baseMs: 1 } });
  const health = newHealthState({ runnerId: "r1", version: "1.1.0", provider: "local", model: "qwen3-coder:30b" });
  let up = false;
  let probes = 0;
  const check = async () => {
    probes++;
    return up ? { ok: true } : { ok: false, error: `model server not reachable: fetch failed http://user:pw@host.docker.internal:11434/v1/models?token=abc super-secret-runner-value-123456 ${leakyKey}` };
  };
  let loops = 0;
  const server = await startHealthServer(health, "127.0.0.1", 0);
  try {
    await runLoop({ cfg, client, manifest: testManifest(), logger: silentLogger, health, modelProbe: { check, intervalMs: 60_000 },
      shouldStop: () => loops >= 3, sleep: async () => { loops++; } });
    assert.equal(cp.byPath("claim").length, 0, "no claims while the model server is down (no build attempts burnt)");
    assert.equal(probes, 3);
    assert.equal(health.modelReachable, false);
    const st = healthStatus(health);
    assert.equal(st.ok, false);
    assert.match(st.reason, /^model server not reachable/);
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`);
    assert.equal(res.status, 503);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.equal(body.modelReachable, false);
    assert.ok(body.modelCheckedAt);
    for (const leak of ["super-secret-runner-value-123456", leakyKey, "user:pw@", "token=abc", SECRET]) assert.ok(!text.includes(leak), `health JSON must not contain ${leak}`);
    assert.match(String(body.lastModelError), /\[redacted\]/);

    up = true; loops = 0;
    await runLoop({ cfg, client, manifest: testManifest(), logger: silentLogger, health, modelProbe: { check, intervalMs: 60_000 },
      shouldStop: () => loops >= 2, sleep: async () => { loops++; } });
    assert.ok(cp.byPath("claim").length >= 1, "claims resume once the model answers");
    assert.equal(health.modelReachable, true);
    assert.equal(healthStatus(health).ok, true);
    assert.ok(health.lastModelError, "the last error stays visible for diagnosis");
  } finally { server.close(); await cp.close(); }
  assert.equal(healthText("a\nb\tc"), "a b c");
  assert.equal(healthText("x".repeat(500))!.length, 303);
  assert.equal(healthText(null), null);
});

test("[AIB-RUNNER] health records a failed build's error and a failed draft's model error [fake model]", async () => {
  const manifest = testManifest();
  const cp = await startFakeControlPlane({ jobs: [makeJob()] });
  const model = await startFakeModel(() => ({ status: 500, body: "{\"error\":\"CUDA error: out of memory\"}" }));
  const base = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: "x" });
  const cfg = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: makeSkillsDir(manifest), local: { ...base.local, baseUrl: model.url } });
  const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: cfg.runnerId, sleep: async () => {}, retry: { attempts: 2, baseMs: 1 } });
  const health = newHealthState({ runnerId: "r1", version: "1.1.0", provider: "local", model: "test-coder:30b" });
  try {
    await runLoop({ cfg, client, manifest, logger: silentLogger, health, once: true, shouldStop: () => false, sleep: async () => {},
      jobDeps: { dockerExecutor: fakeDocker().executor, processEnv: POLLUTED_ENV, heartbeatMs: 25, localLimits: {} } });
    assert.equal(health.jobsRun, 1);
    assert.equal(health.lastJobOutcome, "failed");
    assert.match(String(health.lastJobError), /local model request failed: model server answered 500/);
    assert.match(String(health.lastModelError), /CUDA error: out of memory/);
    assert.ok(health.lastJobAt);
  } finally { await cp.close(); await model.close(); }

  const errors: string[] = [];
  const cp2 = await startFakeControlPlane({ aiJobs: [{ id: "aij_1", workflow: "support_reply", system: "s", prompt: "p", leaseToken: "e".repeat(64), leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), maxOutputTokens: 100 }] });
  const down = await closedPortUrl();
  try {
    const c2 = new ControlPlaneClient({ baseUrl: cp2.url, secret: SECRET, runnerId: "r", sleep: async () => {}, retry: { attempts: 1, baseMs: 1 } });
    const out = await serveOneDraft({ client: c2, model: new OpenAICompatClient({ baseUrl: down, apiKey: "ollama", timeoutMs: 2000, retries: 0 }), modelName: "m", log: silentLogger, onError: (e) => errors.push(e) });
    assert.equal(out, "failed");
    assert.match(errors[0], /^local model request failed/);
    assert.match(String(cp2.byPath("ai/complete")[0].body.error), /local model request failed/, "the platform gets an honest error, no paid fallback");
  } finally { await cp2.close(); }
});
