// MOCK/unit tests of long-running autonomous execution: context measurement, unlimited context resets, durable
// project memory, crash-recovery records, idempotent runner state in checkpoints, credential scanning.
// The model is a FAKE OpenAI-compatible server and token counts are DETERMINISTIC COUNTERS reported by that fake: the
// "10 million token" run below exercises the runner's bookkeeping and context management, it is NOT GPU evidence and
// says nothing about a real model's quality. The real-model compaction test is in NODE1-E2E (run on Node 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LocalProvider, estimateTokens, loadTranscript } from "../src/providers/local.ts";
import { toolSpecs } from "../src/providers/local-tools.ts";
import { RunTracker, StopSwitch } from "../src/agent.ts";
import { createWorkspace } from "../src/workspace.ts";
import { writeBriefFiles } from "../src/prompt.ts";
import { silentLogger, registerSecret } from "../src/log.ts";
import { buildCheckpoint, restoreCheckpoint } from "../src/checkpoint.ts";
import { initRepo } from "../src/git.ts";
import { credentialScan } from "../src/checks.ts";
import { runIntegrationOperations } from "../src/integrations/broker.ts";
import { loadMemory, memoryDigest, memoryPath, newMemory, remember, saveMemory, scrub, ineffectiveRepairs, MEMORY_SCHEMA } from "../src/memory.ts";
import type { PhaseRequest } from "../src/providers/types.ts";
import type { RunnerConfig } from "../src/config.ts";
import type { ChatMessage } from "../src/providers/openai-client.ts";
import { makeConfig, makeJob, tmp, startFakeModel, fakeDocker } from "./helpers.ts";
import type { FakeModelReply, FakeModelRequest } from "./helpers.ts";

const ID = { projectId: "prj_alpha", jobId: "bld_alpha", kind: "first_build", revision: 0 };
/** Credential-shaped FAKE values, assembled at runtime so no key-shaped literal is committed (GitHub push protection). */
const fake = (prefix: string, body: string) => prefix + body;
const SK_LIVE = fake("sk_" + "live_", "51HqLyjWDarjtT1zdp7dcXYZ");
const SK_LIVE_2 = fake("sk_" + "live_", "ABCDEFGHIJKLMNOP");
const WHSEC = fake("whs" + "ec_", "0123456789abcdefghij");
const RE_KEY = fake("re" + "_", "AbCdEf12_ZyXwVu98tSrQ");

async function setup(handler: (r: FakeModelRequest, n: number) => FakeModelReply, local: Partial<RunnerConfig["local"]> = {}) {
  const model = await startFakeModel(handler);
  const base = makeConfig({ controlPlaneUrl: "http://cp.invalid", skillsSourceDir: tmp() });
  const cfg = makeConfig({ controlPlaneUrl: "http://cp.invalid", skillsSourceDir: tmp(), local: { ...base.local, ...local, baseUrl: model.url } });
  const ws = createWorkspace(tmp("aib-ws-"), { id: "bld_cont", attempt: 1 });
  mkdirSync(path.join(ws.repo, "public"), { recursive: true });
  const job = makeJob();
  writeBriefFiles(ws.repo, job, job.requirements);
  const provider = new LocalProvider({ cfg, executor: fakeDocker().executor, log: silentLogger, clientRetries: 0 });
  await provider.prepare({ job, ws, skillNames: [], referenceDomains: [], processEnv: {}, systemPromptAppend: "" });
  return { model, ws, provider, cfg };
}
const req = (over: Partial<PhaseRequest> = {}): PhaseRequest => ({ phase: "build", prompt: "Phase 2 of 3: build. INSTRUCTION-MARKER-7Q.", maxTurns: 2000, maxBudgetUsd: 0, maxWallMs: 600_000, resumeSessionId: null, tracker: new RunTracker(), stop: new StopSwitch(), ...over });
/** The runner's own estimate of a request's prompt (chars/3.5 over every message + the tool schemas). */
const promptEstimate = (r: FakeModelRequest) => r.messages.reduce((n, m) => n + estimateTokens(JSON.stringify(m.content ?? "") + JSON.stringify(m.tool_calls ?? "")) + 8, 0) + estimateTokens(JSON.stringify(r.tools ?? []));

test("[AIB-CONTINUITY] context usage is measured per request: system, workspace context, history, tool schemas and reserved output, against the model's window", async () => {
  const { model, provider } = await setup(() => ({ toolCalls: [{ name: "finish", arguments: { summary: "x" } }] }));
  try {
    const messages: ChatMessage[] = [{ role: "system", content: "S".repeat(3500) }, { role: "user", content: "P".repeat(7000) }, { role: "user", content: "H".repeat(350) }];
    const u = provider.measure("test-coder:30b", messages, toolSpecs(), 4096, 32768);
    assert.equal(u.system, 1000 + 8);
    assert.equal(u.pinned, 2000 + 8);
    assert.equal(u.history, 100 + 8);
    assert.ok(u.tools > 500, "tool schemas are counted");
    assert.equal(u.reservedOutput, 4096);
    assert.equal(u.total, u.system + u.pinned + u.history + u.tools + 4096);
    assert.equal(u.window, 32768);
    assert.equal(u.calibration, 1);
  } finally { await model.close(); }
});

test("[AIB-CONTINUITY] 10,000,000 simulated tokens in one session: unlimited fresh-context resets, every request fits the window, instruction and memory survive, state intact [fake model; deterministic token counters, not GPU evidence]", async () => {
  const WINDOW = 16_384;
  const CALLS = 400;
  let biggest = 0;
  const { model, ws, provider } = await setup((r, n) => {
    biggest = Math.max(biggest, promptEstimate(r));
    if (n > CALLS) return { toolCalls: [{ name: "finish", arguments: { summary: `wrote ${CALLS} modules` } }], usage: { prompt_tokens: 9000, completion_tokens: 25_000 } };
    // Each call writes a ~2.5 KB module: the history grows ~700 tokens per call, so the window fills every ~12 calls.
    return { toolCalls: [{ name: "write_file", arguments: { path: `src/m${n}.js`, content: `// module ${n}\nexport const v${n} = ${n};\n` + "x".repeat(2500) + "\n" } }], usage: { prompt_tokens: 9000, completion_tokens: 25_000 } };
  }, { contextTokens: WINDOW, maxOutputTokensPerCall: 2048, maxOutputTokensTotal: 1e12 });
  const compactions: number[] = [];
  try {
    const memory = newMemory(ID);
    remember.requirements(memory, [{ key: "page:home", label: "Home page", status: "remaining" }]);
    const r = req({
      memory: (max) => memoryDigest(memory, max),
      onCompaction: async (i) => { compactions.push(i.compactions); },
    });
    const res = await provider.run(r);
    assert.equal(res.status, "success", String(res.error));
    const total = r.tracker.inputTokens + r.tracker.outputTokens;
    assert.ok(total >= 10_000_000, `≥ 10M cumulative tokens counted (${total})`);
    assert.equal(r.tracker.modelCalls, CALLS + 1);
    // Unlimited successive resets, each reported (the job checkpoints there), each a fresh context.
    assert.ok(compactions.length >= 20, `many context resets (${compactions.length})`);
    assert.deepEqual(compactions, compactions.map((_, i) => i + 1), "resets are numbered 1..n, none skipped");
    assert.equal(res.compactions, compactions.length);
    // Every request stayed inside the window (estimate incl. tool schemas + reserved output).
    assert.ok(biggest + 2048 <= WINDOW, `largest request ${biggest} + 2048 reserved ≤ ${WINDOW}`);
    // The last request: fixed system prompt, refreshed workspace context with the durable memory, the instruction verbatim.
    const last = model.requests.at(-1)!;
    assert.equal(last.messages[0].role, "system");
    assert.match(String(last.messages[1].content), /DURABLE PROJECT MEMORY/);
    assert.match(String(last.messages[1].content), /page:home \(remaining\)/);
    assert.match(String(last.messages[2].content), /^CONTEXT RESET #\d+ by the runner/);
    assert.ok(String(last.messages[2].content).includes("INSTRUCTION-MARKER-7Q"), "phase instruction restated verbatim after the reset");
    assert.ok(last.messages.length < 40, "old turns are not carried along");
    // Project state is intact: every module the model wrote is on disk (the repository is the source of truth).
    const files = readdirSync(path.join(ws.repo, "src")).filter((f) => /^m\d+\.js$/.test(f));
    assert.equal(files.length, CALLS);
    // The transcript on disk is the current (fresh) context, valid and resumable.
    const t = loadTranscript(ws, r.tracker.sessionId!)!;
    assert.equal(t.compactions, compactions.length);
    assert.equal(t.instruction?.prompt, r.prompt);
    assert.ok(t.history.every((m, i) => m.role !== "tool" || i > 0), "no dangling tool result");
  } finally { await model.close(); }
});

test("[AIB-CONTINUITY] the token estimate is calibrated from the server's prompt_tokens (only upward), so a denser tokenizer resets earlier", async () => {
  let n = 0;
  const { model, provider } = await setup((r) => {
    n++;
    // The server counts 2x the runner's estimate.
    return n > 30 ? { toolCalls: [{ name: "finish", arguments: { summary: "ok" } }] } : { toolCalls: [{ name: "write_file", arguments: { path: `p${n}.txt`, content: "y".repeat(1200) } }], usage: { prompt_tokens: promptEstimate(r) * 2, completion_tokens: 50 } };
  }, { contextTokens: 16_384, maxOutputTokensPerCall: 1024 });
  try {
    const res = await provider.run(req());
    assert.equal(res.status, "success");
    const u = provider.measure("test-coder:30b", [{ role: "system", content: "x".repeat(350) }], null, 0, 16_384);
    assert.ok(u.calibration > 1.5 && u.calibration <= 3, `calibration learned (${u.calibration})`);
    // With the calibration, the real (server-counted) prompt never came close to the window.
    for (const q of model.requests) assert.ok(promptEstimate(q) * 2 <= 16_384, "calibrated requests fit the real window");
  } finally { await model.close(); }
});

test("[AIB-CONTINUITY] a prompt that fills the window (Ollama truncates silently) forces a reset before the next call", async () => {
  const { model, provider } = await setup((_r, n) => n === 1
    ? { toolCalls: [{ name: "list_dir", arguments: { path: "." } }], usage: { prompt_tokens: 16_380, completion_tokens: 10 } }
    : { toolCalls: [{ name: "finish", arguments: { summary: "ok" } }] }, { contextTokens: 16_384, maxOutputTokensPerCall: 1024 });
  try {
    const r = req();
    assert.equal((await provider.run(r)).status, "success");
    assert.match(String(model.requests[1].messages[2].content), /^CONTEXT RESET #1/);
    assert.ok(r.tracker.activity.some((a) => /may have truncated it/.test(a.message)));
  } finally { await model.close(); }
});

test("[AIB-CONTINUITY] a window too small for the fixed context fails honestly instead of looping", async () => {
  const { model, provider } = await setup(() => ({ toolCalls: [{ name: "list_dir", arguments: { path: "." } }] }), { contextTokens: 3000, maxOutputTokensPerCall: 1024 });
  try {
    const res = await provider.run(req());
    assert.equal(res.status, "error");
    assert.match(String(res.error), /fixed context .* raise LOCAL_MODEL_\*_CONTEXT_TOKENS/);
    assert.ok(model.requests.length <= 1);
  } finally { await model.close(); }
});

test("[AIB-CONTINUITY] project memory: atomic save/load, survives a new process, bound to one project and build (tenant isolation), never stores credentials", () => {
  const dir = tmp("aib-mem-");
  registerSecret("registered-secret-value-123456");
  const m = newMemory({ ...ID, brief: { id: "brf_1", version: 2, sha256: "a".repeat(64), content: { customerData: { business: { name: "Junk in the Trunk" } } } }, packageId: "business" });
  remember.segmentStart(m, 1, "c1");
  remember.phase(m, "plan", "success", `planned with key ${SK_LIVE_2} and registered-secret-value-123456 and ${WHSEC}`);
  remember.requirements(m, [{ key: "feature:booking", label: "Booking", status: "implemented_unverified" }]);
  saveMemory(dir, m);
  assert.ok(!existsSync(path.join(dir, "agent", ".project-memory.json.tmp")), "atomic: no temp file left");
  const raw = readFileSync(memoryPath(dir), "utf8");
  for (const s of [SK_LIVE_2, "registered-secret-value-123456", WHSEC]) assert.ok(!raw.includes(s), `no credential stored (${s.slice(0, 8)}…)`);
  const back = loadMemory(dir, { ...ID });
  assert.equal(back.status, "loaded");
  assert.equal(back.memory.schema, MEMORY_SCHEMA);
  assert.deepEqual(back.memory.phasesCompleted, ["plan"]);
  assert.equal(back.memory.brief.business, "Junk in the Trunk");
  assert.equal(back.memory.notes[0].source, "model-reported");
  // Another tenant's (or another build's) file is never used.
  assert.equal(loadMemory(dir, { ...ID, projectId: "prj_other" }).status, "foreign");
  assert.deepEqual(loadMemory(dir, { ...ID, projectId: "prj_other" }).memory.phasesCompleted, []);
  assert.equal(loadMemory(dir, { ...ID, jobId: "bld_other" }).status, "foreign");
  assert.equal(loadMemory(dir, { ...ID, kind: "revision", revision: 1 }).status, "foreign");
  writeFileSync(memoryPath(dir), "{not json");
  assert.equal(loadMemory(dir, ID).status, "corrupt");
  assert.equal(scrub("Bearer abc " + "Z".repeat(50)), "Bearer abc [redacted]");
});

test("[AIB-CONTINUITY] crash recovery records: an unclosed segment or in-flight step is detected on the next start; progress and stall accounting", () => {
  const m = newMemory(ID);
  assert.equal(remember.segmentStart(m, 1, "c0"), null, "first start: nothing to recover");
  remember.begin(m, "phase", "build (model-b)");
  // The runner dies here. Next start:
  const rec = remember.segmentStart(m, 1, "c0");
  assert.ok(rec && rec.interrupted?.kind === "phase");
  assert.match(rec!.note, /stopped during phase \(build \(model-b\)\)/);
  assert.equal(m.segments[0].end, "interrupted");
  assert.equal(m.inFlight, null);
  // A segment that ends at its limit with a new commit is progress; two idle ones in a row trip the guard.
  assert.equal(remember.segmentEnd(m, "continuation", "c1", { modelCalls: 5, inputTokens: 10, outputTokens: 5 }, false), true);
  assert.equal(m.idleSegments, 0);
  remember.segmentStart(m, 1, "c1");
  assert.equal(remember.segmentEnd(m, "continuation", "c1", { modelCalls: 5, inputTokens: 10, outputTokens: 5 }, false), false);
  remember.segmentStart(m, 1, "c1");
  remember.segmentEnd(m, "continuation", "c1", { modelCalls: 5, inputTokens: 10, outputTokens: 5 }, false);
  assert.equal(m.idleSegments, 2);
  assert.equal(m.totals.continuations, 3);
  // Thrashing: commits but no milestone keep counting; a milestone resets it.
  remember.segmentStart(m, 1, "c1");
  remember.segmentEnd(m, "continuation", "c2", { modelCalls: 1, inputTokens: 1, outputTokens: 1 }, false);
  assert.equal(m.idleSegments, 0);
  assert.equal(m.segmentsSinceMilestone, 4);
  remember.segmentStart(m, 1, "c2");
  remember.segmentEnd(m, "continuation", "c3", { modelCalls: 1, inputTokens: 1, outputTokens: 1 }, true);
  assert.equal(m.segmentsSinceMilestone, 0);
});

test("[AIB-CONTINUITY] defect history is per outstanding item: an unrelated item changing never resets a persistent failure; ineffective repairs accumulate; resolved items close their repair; the digest warns", () => {
  const m = newMemory(ID);
  const cyc = (n: number, outstanding: string[]) => remember.cycle(m, { cycle: n, decision: "REVISION_REQUIRED", outstanding, reviewer: "local:model-a" });
  let r = cyc(1, ["check:booking-api", "check:lint"]);
  remember.repair(m, r.open, { cycle: 1, model: "model-b", task: "debugging", commitBefore: "c1" });
  // Review finding 3: {build, lint} → {build} used to look like a brand-new defect and reset the count.
  r = cyc(2, ["check:booking-api"]);
  assert.equal(r.resolved, 1, "lint really was fixed (a milestone)");
  assert.equal(m.defects.find((d) => d.summary[0] === "check:lint")!.repairs.at(-1)!.resolved, true, "the repair that fixed lint is credited");
  const booking = r.open[0];
  assert.equal(booking.occurrences, 2);
  assert.equal(ineffectiveRepairs(r.open), 1, "the booking failure survived one repair");
  remember.repair(m, r.open, { cycle: 2, model: "model-a", task: "repeated_failure", commitBefore: "c2" });
  r = cyc(3, ["check:booking-api", "check:seo"]);
  assert.equal(r.resolved, 0);
  assert.equal(ineffectiveRepairs(r.open), 2, "a new unrelated item does not hide the persistent one");
  remember.repair(m, r.open, { cycle: 3, model: "model-a", task: "repeated_failure", commitBefore: "c3" });
  r = cyc(4, ["check:booking-api"]);
  assert.equal(ineffectiveRepairs(r.open), 3, "reaches MAX_INEFFECTIVE_REPAIRS");
  assert.match(memoryDigest(m, 10_000), /check:booking-api \(seen in 4 cycle\(s\) since cycle 1; 3 earlier repair\(s\) did NOT fix it: use a different approach\)/);
  assert.equal(m.cyclesCompleted, 4);
  assert.ok(memoryDigest(m, 400).length <= 430, "digest is bounded");
});

test("[AIB-CONTINUITY] milestones cannot be farmed: requirement statuses count only above their best-ever level; a plan phase that used its turn share counts as done", () => {
  const m = newMemory(ID);
  const set = (status: string) => remember.requirements(m, [{ key: "feature:booking", label: "Booking", status }]);
  assert.equal(set("remaining"), false);
  assert.equal(set("implemented_unverified"), true, "first time implemented: a milestone");
  assert.equal(set("remaining"), false);
  assert.equal(set("implemented_unverified"), false, "flipping back and forth is not progress (review finding 2)");
  assert.equal(set("verified"), true);
  assert.equal(set("implemented_unverified"), false, "a downgrade is not progress");
  assert.equal(remember.requirements(m, [{ key: "feature:booking", status: "verified" }, { key: "new:item", status: "blocked" }]), false);
  remember.phase(m, "plan", "max_turns", null);
  remember.phase(m, "build", "max_turns", null);
  assert.deepEqual(m.phasesCompleted, ["plan"], "plan is best-effort; an unfinished build is not done (review finding 7)");
});

test("[AIB-CONTINUITY] an older or partial memory file loads with safe defaults (no NaN switches a guard off)", () => {
  const dir = tmp("aib-mem-old-");
  mkdirSync(path.join(dir, "agent"), { recursive: true });
  writeFileSync(memoryPath(dir), JSON.stringify({ schema: MEMORY_SCHEMA, ...ID, segments: [], phasesCompleted: ["plan"] }));
  const { memory, status } = loadMemory(dir, ID);
  assert.equal(status, "loaded");
  assert.deepEqual(memory.phasesCompleted, ["plan"]);
  remember.segmentStart(memory, 1, "a");
  remember.segmentEnd(memory, "continuation", "a", { modelCalls: 1, inputTokens: 1, outputTokens: 1 }, false);
  assert.equal(memory.idleSegments, 1);
  assert.equal(memory.totals.continuations, 1);
  assert.equal(memory.segmentsSinceMilestone, 1);
  remember.usage(memory, { inputTokens: 5 });
  assert.equal(memory.totals.inputTokens, 5);
  assert.ok(memoryDigest(memory, 2000).includes("Phases completed: plan."));
});

test("[AIB-CONTINUITY] checkpoints carry the project memory and the runner's operation records: a resumed attempt never repeats an approved external operation", async () => {
  const ws = createWorkspace(tmp("aib-ws-"), { id: "bld_idem", attempt: 1 });
  const git = { repo: ws.repo, pathEnv: process.env.PATH ?? "/usr/bin:/bin", home: ws.home };
  await initRepo(git, { name: "t", email: "t@t.invalid" }, "ai-build/first-build");
  writeFileSync(path.join(ws.repo, "index.html"), "x");
  mkdirSync(path.join(ws.repo, ".crestmont"), { recursive: true });
  writeFileSync(path.join(ws.repo, ".crestmont", "integration-operations.json"), JSON.stringify([{ operation: "stripe.verify_test_key", summary: "check" }]));
  const secretsRoot = tmp("aib-sec-");
  mkdirSync(path.join(secretsRoot, "prj_idem"), { recursive: true });
  writeFileSync(path.join(secretsRoot, "prj_idem", "STRIPE_TEST_SECRET_KEY"), "sk_test_" + "a".repeat(24));
  let stripeCalls = 0;
  const fetchImpl = (async () => { stripeCalls++; return new Response(JSON.stringify({ livemode: false }), { status: 200 }); }) as unknown as typeof fetch;
  const approved = async () => [{ id: "apr_1", kind: "integration_operation", operation: "stripe.verify_test_key", status: "approved" }];
  const ops = (w: typeof ws) => runIntegrationOperations({ repo: w.repo, jobDir: w.dir, projectId: "prj_idem", secretsRoot, approvals: approved as never, requestApproval: async () => {}, report: async () => {}, fetchImpl });
  assert.equal((await ops(ws))[0].status, "passed");
  assert.equal(stripeCalls, 1);
  const { commitAll } = await import("../src/git.ts");
  await commitAll(git, "agent work incl. the operation request");
  const m = newMemory({ ...ID, projectId: "prj_idem", jobId: "bld_idem" });
  remember.phase(m, "plan", "success", null);
  saveMemory(ws.dir, m);
  const built = await buildCheckpoint(ws, git, { jobId: "bld_idem", attempt: 1, sessionId: null, sessionTotalCostUsd: 0, sourceBranch: "ai-build/first-build", sourceCommit: null }, git.pathEnv);
  assert.ok(built.contents.includes("runner-state") && built.contents.includes("local-agent"));
  // Another host: a fresh workspace restored from the archive.
  const ws2 = createWorkspace(tmp("aib-ws2-"), { id: "bld_idem", attempt: 2 });
  await restoreCheckpoint(ws2, { ...git, repo: ws2.repo, home: ws2.home }, readFileSync(built.file), null, git.pathEnv, "ai-build/first-build");
  assert.deepEqual(loadMemory(ws2.dir, { ...ID, projectId: "prj_idem", jobId: "bld_idem" }).memory.phasesCompleted, ["plan"]);
  assert.equal((await ops(ws2))[0].status, "passed", "the recorded outcome is reused");
  assert.equal(stripeCalls, 1, "the external operation is not run a second time after the resume");
});

test("[AIB-CONTINUITY] credential scan: real-looking customer keys and local secret files fail the build; placeholders, publishable keys and templates pass; values are never echoed", () => {
  const repo = tmp("aib-scan-");
  const put = (rel: string, body: string) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), body); };
  put("src/pay.js", "const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);\nconst pk = 'pk_live_51Habcdefghijklmnop';\n");
  put("test/pay.test.js", "const key = 'sk_test_fake_0000000000000000';\n");
  put(".env.example", "STRIPE_SECRET_KEY=\nRESEND_API_KEY=your-key-here\n");
  const clean = credentialScan(repo, ["src/pay.js", "test/pay.test.js", ".env.example"]);
  assert.equal(clean.ok, true, clean.outputTail);
  put("src/config.js", `export const KEY = '${SK_LIVE}';\n`);
  put(".dev.vars", `RESEND_API_KEY=${RE_KEY}\n`);
  put(".env.production", "SITE_URL=https://junk.example\nX=1\n");
  put("server/mail.js", `const k = '${RE_KEY}';\n`);
  const bad = credentialScan(repo, ["src/pay.js", "src/config.js", ".dev.vars", ".env.production", "server/mail.js", "node_modules/x/index.js"]);
  assert.doesNotMatch(bad.outputTail, /\.env\.production/, "non-secret configuration is not a finding");
  assert.equal(bad.ok, false);
  assert.match(bad.outputTail, /src\/config\.js:1: Stripe secret or restricted key \(value not shown\)/);
  assert.match(bad.outputTail, /\.dev\.vars: local secrets file with 1 value/);
  assert.match(bad.outputTail, /server\/mail\.js:1: Resend API key/);
  assert.ok(!bad.outputTail.includes(SK_LIVE) && !bad.outputTail.includes(RE_KEY), "values are not echoed");
  // A real key next to a comment that mentions a placeholder is still a real key (review finding 8).
  put("src/late.js", `const key = '${SK_LIVE}'; // replace placeholder before launch\n`);
  assert.match(credentialScan(repo, ["src/late.js"]).outputTail, /src\/late\.js:1: Stripe secret or restricted key/);
});
