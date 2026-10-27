// MOCK/unit tests of the LOCAL provider's agent loop, tools, sandbox flags and safety limits.
// The model is a FAKE OpenAI-compatible HTTP server in this process and Docker is a FAKE executor that records the
// exact CLI flags. No real model, Docker daemon or paid API is contacted; these tests do not demonstrate a real build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LocalProvider, assertLocalEndpoint, repairHistory, loadTranscript } from "../src/providers/local.ts";
import { confine, validateArgs, PathDenied, executeTool } from "../src/providers/local-tools.ts";
import { parseArguments, parseTextToolCalls } from "../src/providers/local-parse.ts";
import { JobSandbox, validatePackageSpec } from "../src/sandbox.ts";
import { RunTracker, StopSwitch } from "../src/agent.ts";
import { createWorkspace } from "../src/workspace.ts";
import type { Workspace } from "../src/workspace.ts";
import { writeBriefFiles } from "../src/prompt.ts";
import { silentLogger } from "../src/log.ts";
import { PaidProviderRefusedError } from "../src/providers/types.ts";
import type { PhaseRequest } from "../src/providers/types.ts";
import type { RunnerConfig } from "../src/config.ts";
import { BRIEF_RULES } from "../src/protocol.ts";
import { makeConfig, makeJob, tmp, startFakeModel, fakeDocker, INJECTION, delay } from "./helpers.ts";
import type { FakeModelReply, FakeModelRequest, FakeDocker } from "./helpers.ts";

const finish = (summary = "done"): FakeModelReply => ({ toolCalls: [{ name: "finish", arguments: { summary } }] });

async function setup(handler: (req: FakeModelRequest, n: number, sig: { aborted: boolean }) => FakeModelReply | Promise<FakeModelReply>, over: Partial<RunnerConfig> = {}) {
  const model = await startFakeModel(handler);
  const docker = fakeDocker();
  const base = makeConfig({ controlPlaneUrl: "http://cp.invalid", skillsSourceDir: tmp() });
  const cfg = makeConfig({ controlPlaneUrl: "http://cp.invalid", skillsSourceDir: tmp(), ...over, local: { ...(over.local ?? base.local), baseUrl: model.url } });
  const ws = createWorkspace(tmp("aib-ws-"), { id: "bld_unit", attempt: 1 });
  mkdirSync(path.join(ws.repo, "public"), { recursive: true });
  writeFileSync(path.join(ws.repo, "public", "index.html"), "<h1>Hello</h1>\n");
  const job = makeJob();
  writeBriefFiles(ws.repo, job, job.requirements);
  const provider = new LocalProvider({ cfg, executor: docker.executor, log: silentLogger, clientRetries: 0 });
  await provider.prepare({ job, ws, skillNames: ["frontend-design"], referenceDomains: [], processEnv: {}, systemPromptAppend: "" });
  return { model, docker, cfg, ws, job, provider };
}

function req(over: Partial<PhaseRequest> = {}): PhaseRequest {
  return { phase: "build", prompt: "Phase 2 of 3: build.", maxTurns: 30, maxBudgetUsd: 0, maxWallMs: 30_000, resumeSessionId: null, tracker: new RunTracker(), stop: new StopSwitch(), ...over };
}

const lastToolText = (r: FakeModelRequest) => r.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");

test("[AIB-RUNNER] local loop happy path: tool calls write and edit files, tokens/turns tracked, cost stays 0 [fake model]", async () => {
  const { model, ws, provider } = await setup((_r, n) => [
    { toolCalls: [{ name: "list_dir", arguments: { path: "." } }] },
    { toolCalls: [{ name: "write_file", arguments: { path: "public/about.html", content: "<h1>About</h1>\n" } }, { name: "read_file", arguments: { path: "public/index.html" } }] },
    { toolCalls: [{ name: "edit_file", arguments: { path: "public/index.html", old_string: "Hello", new_string: "Acme" } }] },
    { toolCalls: [{ name: "report_requirement", arguments: { key: "page:home", status: "verified" } }] },
    finish("built"),
  ][n - 1] ?? finish());
  try {
    const r = req();
    const res = await provider.run(r);
    assert.equal(res.status, "success");
    assert.equal(readFileSync(path.join(ws.repo, "public", "about.html"), "utf8"), "<h1>About</h1>\n");
    assert.equal(readFileSync(path.join(ws.repo, "public", "index.html"), "utf8"), "<h1>Acme</h1>\n");
    const reqs = JSON.parse(readFileSync(path.join(ws.repo, ".crestmont", "requirements.json"), "utf8"));
    assert.deepEqual(reqs, [{ key: "page:home", status: "implemented_unverified" }], "verified without evidence is downgraded");
    assert.equal(r.tracker.turns(), 5);
    assert.equal(r.tracker.inputTokens, 5000);
    assert.equal(r.tracker.outputTokens, 500);
    assert.equal(r.tracker.attemptCostUsd, 0);
    assert.match(r.tracker.sessionId!, /^local-[0-9a-f]{16}$/);
    // Tools are offered; the system prompt carries the fixed rules; the read result went back to the model.
    const first = model.requests[0];
    assert.deepEqual(first.tools!.map((t) => t.function.name), ["list_dir", "read_file", "write_file", "edit_file", "search", "run_command", "install_packages", "report_requirement", "finish"]);
    assert.equal(first.messages[0].role, "system");
    for (const rule of BRIEF_RULES) assert.ok(first.messages[0].content!.includes(rule));
    assert.match(lastToolText(model.requests[2]), /1  <h1>Hello<\/h1>/);
    assert.ok(loadTranscript(ws, r.tracker.sessionId!), "transcript persisted outside the repository");
    assert.ok(!existsSync(path.join(ws.repo, "agent")));
  } finally { await model.close(); }
});

test("[AIB-RUNNER] customer brief reaches the local model only inside the delimited UNTRUSTED block, never in the system prompt [fake model]", async () => {
  const { model, provider } = await setup(() => finish());
  try {
    await provider.run(req());
    const r = model.requests[0];
    assert.ok(!r.messages[0].content!.includes(INJECTION), "system prompt has no customer text");
    const pinned = r.messages[1].content!;
    const begin = pinned.indexOf("<<BEGIN UNTRUSTED CUSTOMER DATA: brief.");
    const end = pinned.indexOf("<<END UNTRUSTED CUSTOMER DATA: brief>>");
    const at = pinned.indexOf(INJECTION.slice(0, 30));
    assert.ok(begin > 0 && at > begin && at < end, "injection text only between the markers");
    assert.match(pinned, /Repository file tree/);
    assert.match(pinned, /public\/index\.html/);
  } finally { await model.close(); }
});

test("[AIB-RUNNER] malformed tool JSON and schema violations get corrective feedback; the corrected call runs [fake model]", async () => {
  const { model, ws, provider } = await setup((_r, n) => [
    { toolCalls: [{ name: "write_file", arguments: "{\"path\": \"a.txt\", \"content\": \"hi\"" }] },
    { toolCalls: [{ name: "write_file", arguments: { path: "a.txt" } }] },
    { toolCalls: [{ name: "write_file", arguments: { path: "a.txt", content: "hi", mode: "x" } }] },
    { toolCalls: [{ name: "write_file", arguments: "```json\n{\"path\": \"a.txt\", \"content\": \"fixed\",}\n```" }] },
    finish(),
  ][n - 1] ?? finish());
  try {
    const res = await provider.run(req());
    assert.equal(res.status, "success");
    assert.equal(readFileSync(path.join(ws.repo, "a.txt"), "utf8"), "fixed", "fenced JSON with a trailing comma is repaired");
    assert.match(lastToolText(model.requests[1]), /invalid call to write_file: arguments are not valid JSON[\s\S]*Expected JSON arguments matching this schema/);
    assert.match(lastToolText(model.requests[2]), /missing required property "content"/);
    assert.match(lastToolText(model.requests[3]), /unknown property "mode"/);
  } finally { await model.close(); }
});

test("[AIB-RUNNER] bounded retries: a model that only emits invalid calls ends the phase with an error [fake model]", async () => {
  const { model, provider } = await setup(() => ({ toolCalls: [{ name: "write_file", arguments: "not json at all" }] }));
  try {
    const res = await provider.run(req());
    assert.equal(res.status, "error");
    assert.match(String(res.error), /invalid tool calls 5 times in a row/);
    assert.equal(model.requests.length, 5);
  } finally { await model.close(); }
});

test("[AIB-RUNNER] tool calls printed as text (<tool_call>, ```json, bare JSON) are parsed; prose JSON is not executed [fake model]", async () => {
  const { model, ws, provider } = await setup((_r, n) => [
    { content: "I will write it.\n<tool_call>\n{\"name\": \"write_file\", \"arguments\": {\"path\": \"b.txt\", \"content\": \"from text\"}}\n</tool_call>" },
    { content: "```json\n{\"name\": \"edit_file\", \"arguments\": {\"path\": \"b.txt\", \"old_string\": \"text\", \"new_string\": \"TEXT\"}}\n```" },
    { content: "{\"name\": \"finish\", \"arguments\": {\"summary\": \"ok\"}}" },
  ][n - 1] ?? finish());
  try {
    const res = await provider.run(req());
    assert.equal(res.status, "success");
    assert.equal(readFileSync(path.join(ws.repo, "b.txt"), "utf8"), "from TEXT");
    // The text calls were recorded as structured calls with results in the transcript sent back.
    assert.ok(model.requests[1].messages.some((m) => m.role === "assistant" && m.tool_calls?.[0]?.function.name === "write_file"));
  } finally { await model.close(); }
  assert.deepEqual(parseTextToolCalls("Config looks like {\"name\": \"vite\", \"version\": 5}", ["write_file"]), []);
  assert.deepEqual(parseArguments({ a: 1 }).args, { a: 1 });
  assert.deepEqual(parseArguments("\"{\\\"path\\\":\\\"x\\\"}\"").args, { path: "x" }, "double-encoded JSON");
});

test("[AIB-RUNNER] path confinement: traversal, absolute paths, symlink escapes and .git internals are refused", async () => {
  const ws = createWorkspace(tmp(), { id: "bld_paths", attempt: 1 });
  mkdirSync(path.join(ws.repo, ".git"), { recursive: true });
  writeFileSync(path.join(ws.repo, ".git", "config"), "[core]\n");
  writeFileSync(path.join(ws.dir, "outside.txt"), "secret");
  symlinkSync(path.join(ws.dir, "outside.txt"), path.join(ws.repo, "link.txt"));
  symlinkSync(ws.dir, path.join(ws.repo, "dirlink"));
  for (const [p, mode] of [["../outside.txt", "r"], ["../../etc/passwd", "r"], ["/etc/passwd", "r"], ["link.txt", "r"], ["dirlink/outside.txt", "w"], ["dirlink/new.txt", "w"], [".git/config", "r"], ["sub/.git/hooks/pre-commit", "w"], [".claude/settings.json", "w"], ["", "r"]] as const) {
    assert.throws(() => confine(ws.repo, p, mode), PathDenied, `${p} (${mode}) must be refused`);
  }
  assert.equal(confine(ws.repo, "public/index.html", "w").rel, "public/index.html");
  assert.equal(confine(ws.repo, "/workspace/repo/public/x.css", "w").rel, "public/x.css", "container spelling of a repo path is accepted");
  const sandbox = new JobSandbox(makeConfig({ controlPlaneUrl: "x", skillsSourceDir: "x" }).jobSandbox, ws, "bld_paths", fakeDocker().executor);
  const out = await executeTool("read_file", { path: "../outside.txt" }, { repo: ws.repo, sandbox, defaultTimeoutMs: 1000 });
  assert.equal(out.ok, false);
  assert.match(out.output, /^ERROR: .*outside the project repository/);
  const w = await executeTool("write_file", { path: "dirlink/evil.txt", content: "x" }, { repo: ws.repo, sandbox, defaultTimeoutMs: 1000 });
  assert.match(w.output, /resolves outside the project repository/);
  assert.ok(!existsSync(path.join(ws.dir, "evil.txt")));
  assert.deepEqual(validateArgs("nope", {}), ["unknown tool \"nope\". Available tools: list_dir, read_file, write_file, edit_file, search, run_command, install_packages, report_requirement, finish"]);
});

function flagValue(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === flag) out.push(args[i + 1]); });
  return out;
}

function assertHardened(args: string[], network: string, ws: Workspace) {
  assert.deepEqual(flagValue(args, "--network"), [network]);
  assert.deepEqual(flagValue(args, "--user"), ["10001:10001"], "non-root");
  assert.deepEqual(flagValue(args, "--cap-drop"), ["ALL"]);
  assert.deepEqual(flagValue(args, "--security-opt"), ["no-new-privileges"]);
  assert.ok(args.includes("--read-only"));
  assert.deepEqual(flagValue(args, "--cpus"), ["2"]);
  assert.deepEqual(flagValue(args, "--memory"), ["4g"]);
  assert.deepEqual(flagValue(args, "--pids-limit"), ["512"]);
  assert.match(flagValue(args, "--tmpfs")[0], /^\/tmp:rw,nosuid,nodev,size=\d+m$/);
  assert.deepEqual(flagValue(args, "--mount"), [`type=bind,src=${ws.repo},dst=/workspace/repo`, `type=bind,src=${ws.home},dst=/home/builder`], "only this job's repo and home");
  const joined = args.join(" ");
  for (const bad of ["docker.sock", "--privileged", "-v", "/run/secrets", "--network host", "ANTHROPIC", "BUILD_RUNNER_SECRET"]) assert.ok(!flagValue(args, bad).length && !joined.includes(bad === "-v" ? " -v " : bad), `no ${bad}`);
}

test("[AIB-RUNNER] run_command always runs in the per-job container: network none, limits, read-only, cap-drop, no socket mount [fake docker]", async () => {
  const { model, docker, ws, provider } = await setup((_r, n) => [
    { toolCalls: [{ name: "run_command", arguments: { command: "echo built > out.txt && cat out.txt", timeout_seconds: 30 } }] },
    finish(),
  ][n - 1] ?? finish());
  try {
    await provider.run(req());
    const start = docker.calls.find((c) => c[0] === "run" && c.includes("-d"))!;
    assert.ok(start, "job container started");
    assertHardened(start, "none", ws);
    assert.ok(start.includes("--init"));
    assert.deepEqual(start.slice(-3), ["crestmont-build-sandbox:test", "sleep", "infinity"]);
    const exec = docker.calls.find((c) => c[0] === "exec")!;
    assert.deepEqual(exec.slice(0, 4), ["exec", "--workdir", "/workspace/repo", start[start.indexOf("--name") + 1]]);
    assert.deepEqual(exec.slice(4), ["timeout", "-k", "5", "30", "bash", "-c", "echo built > out.txt && cat out.txt"]);
    assert.match(lastToolText(model.requests[1]), /exit code: 0[\s\S]*built/);
    assert.ok(docker.calls.every((c) => c[0] !== "exec" || c.includes("timeout")), "every exec is wrapped in the in-container timeout");
    await provider.close();
    assert.ok(docker.calls.some((c) => c[0] === "rm" && c[1] === "-f"), "container removed on close");
  } finally { await model.close(); }
});

test("[AIB-RUNNER] install_packages uses the proxy-only install network with --ignore-scripts; URLs/git specs are refused [fake docker]", async () => {
  const { model, docker, ws, provider } = await setup((_r, n) => [
    { toolCalls: [{ name: "install_packages", arguments: { packages: ["vite@5.4.10", "@astrojs/check"], dev: true } }] },
    { toolCalls: [{ name: "install_packages", arguments: { packages: ["git+https://evil.example/x.git"] } }] },
    finish(),
  ][n - 1] ?? finish());
  try {
    await provider.run(req());
    const installs = docker.calls.filter((c) => c[0] === "run" && c.includes("--rm"));
    assert.equal(installs.length, 1, "the refused spec never reached docker");
    const a = installs[0];
    assertHardened(a, "crestmont_install", ws);
    const envs = flagValue(a, "--env");
    assert.ok(envs.includes("npm_config_proxy=http://egress-proxy:3128") && envs.includes("npm_config_https_proxy=http://egress-proxy:3128"));
    assert.ok(envs.includes("npm_config_ignore_scripts=true"));
    assert.deepEqual(a.slice(a.indexOf("npm")), ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--save-dev", "--", "vite@5.4.10", "@astrojs/check"]);
    assert.match(lastToolText(model.requests[2]), /not an allowed package spec/);
  } finally { await model.close(); }
  for (const bad of ["https://x/y.tgz", "file:../x", "-g", "a;rm -rf /", "../x", "github:user/repo"]) assert.ok(validatePackageSpec(bad), bad);
  for (const good of ["react", "react@18.3.1", "@scope/pkg@^1.2.0"]) assert.equal(validatePackageSpec(good), null, good);
  // Lockfile present and no packages: npm ci; approved build scripts run offline afterwards.
  const docker2 = fakeDocker();
  const ws2 = createWorkspace(tmp(), { id: "bld_ci", attempt: 1 });
  writeFileSync(path.join(ws2.repo, "package-lock.json"), "{}");
  mkdirSync(path.join(ws2.repo, "node_modules", "esbuild"), { recursive: true });
  const sb = new JobSandbox({ ...makeConfig({ controlPlaneUrl: "x", skillsSourceDir: "x" }).jobSandbox, allowedBuildScripts: ["esbuild", "sharp"] }, ws2, "bld_ci", docker2.executor);
  await sb.install();
  const ci = docker2.calls.find((c) => c.includes("--rm"))!;
  assert.deepEqual(ci.slice(ci.indexOf("npm")), ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  const rebuild = docker2.calls.find((c) => c[0] === "exec")!;
  assert.deepEqual(rebuild.slice(-4), ["npm", "rebuild", "--foreground-scripts", "esbuild"], "only approved and installed packages run build scripts, offline");
});

test("[AIB-RUNNER] loop detection: a model repeating the same call is warned once, then the phase stops [fake model]", async () => {
  const { model, provider } = await setup(() => ({ toolCalls: [{ name: "read_file", arguments: { path: "public/index.html" } }] }));
  try {
    const r = req();
    const res = await provider.run(r);
    assert.equal(res.status, "loop");
    assert.match(String(res.error), /repeated the same read_file call 4 times/);
    assert.equal(model.requests.length, 4);
    assert.match(lastToolText(model.requests[3]), /WARNING from the runner: you have made this exact read_file call 3 times/);
  } finally { await model.close(); }
});

test("[AIB-RUNNER] max turns, max wall time and the output-token cap end a phase [fake model]", async () => {
  let i = 0;
  const { model, provider } = await setup(async () => ({ toolCalls: [{ name: "run_command", arguments: { command: `echo ${i++}` } }] }));
  try {
    const t = await provider.run(req({ maxTurns: 3 }));
    assert.equal(t.status, "max_turns");
    assert.equal(model.requests.length, 3);
  } finally { await model.close(); }
  const slow = await setup(async (_r, _n, sig) => { for (let k = 0; k < 50 && !sig.aborted; k++) await delay(20); return finish(); });
  try {
    const started = Date.now();
    const res = await slow.provider.run(req({ maxWallMs: 300 }));
    assert.equal(res.status, "max_time");
    assert.ok(Date.now() - started < 3000, "the in-flight request was aborted at the deadline");
  } finally { await slow.model.close(); }
  const base = makeConfig({ controlPlaneUrl: "x", skillsSourceDir: "x" });
  const capped = await setup(() => ({ toolCalls: [{ name: "list_dir", arguments: { depth: 1 } }], usage: { prompt_tokens: 10, completion_tokens: 600 } }), { local: { ...base.local, maxOutputTokensTotal: 1000 } } as Partial<RunnerConfig>);
  try {
    const res = await capped.provider.run(req());
    assert.equal(res.status, "max_output_tokens");
    assert.equal(capped.model.requests[1].max_tokens, 400, "per-call max_tokens shrinks to the remaining budget");
  } finally { await capped.model.close(); }
});

test("[AIB-RUNNER] interrupt: a stop aborts the in-flight model request and kills the job container [fake model]", async () => {
  const { model, docker, provider } = await setup(async (_r, n, sig) => {
    if (n === 1) return { toolCalls: [{ name: "run_command", arguments: { command: "true" } }] };
    while (!sig.aborted) await delay(10);
    return finish();
  });
  try {
    const stop = new StopSwitch();
    const p = provider.run(req({ stop }));
    while (model.requests.length < 2) await delay(10);
    stop.request("server:canceled");
    const res = await p;
    assert.equal(res.status, "stopped");
    assert.equal(res.stoppedBy, "server:canceled");
    await delay(50);
    assert.ok(model.aborted >= 1, "HTTP request aborted");
    assert.ok(docker.calls.some((c) => c[0] === "rm" && c[1] === "-f"), "container killed");
  } finally { await model.close(); }
});

test("[AIB-RUNNER] the local provider refuses hosted/paid endpoints and Ollama cloud models", () => {
  assert.throws(() => assertLocalEndpoint("https://api.anthropic.com/v1", "x"), PaidProviderRefusedError);
  assert.throws(() => assertLocalEndpoint("https://api.openai.com/v1", "x"), PaidProviderRefusedError);
  assert.throws(() => assertLocalEndpoint("https://ollama.com/v1", "x"), PaidProviderRefusedError);
  assert.throws(() => assertLocalEndpoint("http://host.docker.internal:11434/v1", "qwen3-coder:480b-cloud"), PaidProviderRefusedError);
  assertLocalEndpoint("http://host.docker.internal:11434/v1", "qwen3-coder:30b");
  // Dangling tool calls (phase ended mid-batch) are answered before the transcript is sent again.
  const fixed = repairHistory([{ role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "list_dir", arguments: "{}" } }, { id: "b", type: "function", function: { name: "finish", arguments: "{}" } }] }, { role: "tool", tool_call_id: "a", content: "x" }]);
  assert.deepEqual(fixed.map((m) => m.role), ["assistant", "tool", "tool"]);
});

test("[AIB-RUNNER] preflight: model must be pulled on the local server and the sandbox image present [fake model, fake docker]", async () => {
  const { model, provider } = await setup(() => finish());
  try {
    assert.deepEqual((await provider.preflight()).errors, []);
  } finally { await model.close(); }
  const other = await startFakeModel(() => finish(), ["llama3:8b"]);
  const docker: FakeDocker = fakeDocker({ override: (a) => (a[0] === "image" ? { code: 1, stdout: "", stderr: "No such image", timedOut: false, notFound: false } : undefined) });
  const base = makeConfig({ controlPlaneUrl: "x", skillsSourceDir: "x" });
  const p2 = new LocalProvider({ cfg: makeConfig({ controlPlaneUrl: "x", skillsSourceDir: "x", local: { ...base.local, baseUrl: other.url } }), executor: docker.executor, log: silentLogger });
  try {
    const errs = (await p2.preflight()).errors.join(" | ");
    assert.match(errs, /Local model test-coder:30b is not available .* \(available: llama3:8b\)/);
    assert.match(errs, /Build sandbox image crestmont-build-sandbox:test is not present/);
  } finally { await other.close(); }
});
