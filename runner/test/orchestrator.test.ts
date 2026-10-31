// Founder V4 (2026-10-28, local dual-model) orchestrator, SIMULATED: a FAKE OpenAI-compatible model server plays
// Model A ("test-arch:27b") and Model B ("test-coder:30b"), a fake docker runs the sandbox commands on the test host,
// and a fake control plane records what the platform receives. These tests prove the orchestration (Model A architect
// → Model B build → runner checks → fresh read-only Model A review → routed corrections → repeat), the GPU queue and
// model switching inside a real job, and the $0 policy. They do not prove model quality or anything on Node 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { runJob, type JobDeps } from "../src/job.ts";
import { ControlPlaneClient } from "../src/control-plane.ts";
import { silentLogger } from "../src/log.ts";
import type { ModelProfile, RunnerConfig } from "../src/config.ts";
import { DeterministicReviewer } from "../src/orchestrator/advisors.ts";
import { assertNoMeteredEnv, meteredVariables, SpendPolicyError } from "../src/orchestrator/cost-guard.ts";
import { layers, groupLayer, runCoordinatedSessions } from "../src/orchestrator/sessions.ts";
import type { CycleEvidence } from "../src/orchestrator/contracts.ts";
import { InferenceScheduler } from "../src/inference/scheduler.ts";
import type { LoadedModel, Residency } from "../src/inference/ollama.ts";
import {
  startFakeControlPlane, startFakeModel, fakeDocker, makeJob, makeConfig, makeSkillsDir, testManifest, claimFrom, tmp, POLLUTED_ENV, SECRET,
  type FakeModelReply, type FakeModelRequest,
} from "./helpers.ts";

const manifest = testManifest();
const MODEL_A = "test-arch:27b", MODEL_B = "test-coder:30b";
const prof = (tag: string, role: ModelProfile["role"], vramMb: number): ModelProfile => ({ tag, role, contextTokens: 32_768, vramMb, quantization: "Q4_K_M", reasoning: null, vision: false, license: "Apache-2.0" });
const MODELS = { a: prof(MODEL_A, "architect_reviewer", 18000), b: prof(MODEL_B, "builder", 24000), mode: "dual" as const };

const SPEC = {
  schema: "crestmont.master-spec/1", projectSpec: "Plumbing website", designSpec: "Clean, trustworthy", technicalArchitecture: "Static assets Worker",
  tasks: [{ id: "t-pages", title: "Pages", workstream: "frontend", paths: ["public/"], dependsOn: [] }],
  acceptanceCriteria: [{ id: "ac-pages", text: "All pages exist", verification: "screenshot" }, { id: "ac-contact", text: "Contact details correct", verification: "automated" }],
  integrations: [{ key: "stripe", name: "Stripe", purpose: "Payments" }], securityRequirements: [], testingRequirements: [], assumptions: ["Draft copy"], referenceImages: [], masterPrompt: "Build the plumbing website exactly as specified.",
};

const call = (name: string, args: Record<string, unknown>): FakeModelReply => ({ toolCalls: [{ name, arguments: args }] });
const sys = (r: FakeModelRequest) => String(r.messages[0]?.content ?? "");
const lastUser = (r: FakeModelRequest) => String([...r.messages].reverse().find((m) => m.role === "user")?.content ?? "");
/** Assistant turns since the latest user instruction (the step inside the current phase or session). */
const step = (r: FakeModelRequest) => { let n = 0; for (let i = r.messages.length - 1; i >= 0 && r.messages[i].role !== "user"; i--) if (r.messages[i].role === "assistant") n++; return n; };

/** Scripted Model A + Model B. `verdict(n)` decides the n-th review. */
function scripted(verdict: (n: number, r: FakeModelRequest) => Record<string, unknown>) {
  let reviews = 0;
  return (r: FakeModelRequest): FakeModelReply => {
    if (r.model === MODEL_A && /architect session/.test(sys(r))) {
      // The architect looks at the brief with a read-only tool first, then answers.
      return step(r) === 0 ? call("read_file", { path: "BRIEF.json", max_lines: 20 }) : { content: "```json\n" + JSON.stringify(SPEC) + "\n```" };
    }
    if (r.model === MODEL_A && /independent review session/.test(sys(r))) {
      // A reviewer that tries to change a file is refused (never executed); then it reads, then it answers.
      const s = step(r);
      if (s === 0) return call("write_file", { path: "public/index.html", content: "reviewer must not write" });
      if (s === 1) return call("read_file", { path: "public/index.html", max_lines: 5 });
      return { content: JSON.stringify(verdict(++reviews, r)) };
    }
    // Model B (builder): build/verify phases, then corrective prompts.
    const u = lastUser(r);
    const s = step(r);
    if (/Fix the contact details/.test(u)) {
      const fix = [call("write_file", { path: ".crestmont/acceptance.json", content: JSON.stringify([{ id: "ac-pages", status: "passed" }, { id: "ac-contact", status: "passed" }]) }), call("finish", { summary: "fixed" })];
      return fix[Math.min(s, fix.length - 1)];
    }
    if (/Phase 3/.test(u)) {
      const verify = [call("run_command", { command: "npm run -s check -- --package starter" }), call("write_file", { path: ".crestmont/needs-information.json", content: "[]" }), call("finish", { summary: "verified" })];
      return verify[Math.min(s, verify.length - 1)];
    }
    const build = [
      call("run_command", { command: "grep -rl STARTER-PLACEHOLDER public | xargs sed -i -e 's/STARTER-PLACEHOLDER Business name/Acme Plumbing ZX-41/g' -e 's/STARTER-PLACEHOLDER public email/hello@acme.example/g' -e 's/STARTER-PLACEHOLDER public phone/+1 555 0100/g' -e 's/STARTER-PLACEHOLDER \\?//g'" }),
      call("write_file", { path: ".crestmont/acceptance.json", content: JSON.stringify([{ id: "ac-pages", status: "passed" }, { id: "ac-contact", status: "failed" }]) }),
      call("write_file", { path: ".crestmont/integrations.json", content: JSON.stringify([{ key: "stripe", codeStatus: "implemented", mockStatus: "passed", needs: "Stripe live keys" }]) }),
      call("write_file", { path: ".crestmont/screenshots/index-desktop.png", content: "png" }),
      call("write_file", { path: ".crestmont/screenshots/index-mobile.png", content: "png" }),
      call("finish", { summary: "built" }),
    ];
    return build[Math.min(s, build.length - 1)];
  };
}

async function rig(handler: (r: FakeModelRequest) => FakeModelReply, cfgOver: Partial<RunnerConfig> = {}) {
  const submitted: Record<string, unknown>[] = [];
  const cp = await startFakeControlPlane({ jobs: [makeJob({ worker: { id: "wkr_1", label: "Node 1", maxActiveProjects: 2 } })], extraRoutes: {
    "pipeline/spec": () => ({ specVersion: 1 }),
    "cycles/submit": (b) => { submitted.push(b); const cont = ["CONTINUE_BUILDING", "FIX_DEFECTS", "RUN_MORE_TESTS"].includes(String(b.decision)); return { cycle: b.cycle, decision: b.decision, reason: "fake platform", continue: cont, prompt: cont ? b.nextPrompt : null }; },
    "integrations/report": () => ({ updated: 1 }), "approvals/request": () => ({ id: "apv_1", status: "pending" }), "workers/status": () => ({ ok: true }),
  } });
  const model = await startFakeModel(handler, [MODEL_A, MODEL_B]);
  const docker = fakeDocker();
  const base = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: "x" });
  const cfg = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: makeSkillsDir(manifest), local: { ...base.local, baseUrl: model.url, model: MODEL_B }, models: MODELS,
    advisor: { architect: "local", reviewer: "local", maxTurns: 10, maxCycles: 5 }, ...cfgOver });
  const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: cfg.runnerId, sleep: async () => {}, retry: { attempts: 2, baseMs: 1 } });
  return { cp, model, docker, cfg, client, submitted, job: await claimFrom(cp) };
}
type Rig = Awaited<ReturnType<typeof rig>>;
const deps = (r: Rig, extra: Partial<JobDeps> = {}): JobDeps => ({ cfg: r.cfg, client: r.client, manifest, logger: silentLogger, heartbeatMs: 25, interruptGraceMs: 200, processEnv: { ...POLLUTED_ENV, ANTHROPIC_API_KEY: "sk-ant-api-should-never-be-used-000", OPENAI_API_KEY: "sk-proj-never-used-0000" }, dockerExecutor: r.docker.executor, ...extra });

/** Residency that holds one model at a time (the 32 GB case) and logs every load/unload. */
function oneAtATime(initial: string | null = null) {
  const log: string[] = [];
  let loaded: LoadedModel[] = initial ? [{ model: initial, vramMb: 24000 }] : [];
  const r: Residency = {
    async loaded() { return loaded.map((m) => ({ ...m })); },
    async load(m) { log.push(`load ${m}`); loaded = [...loaded, { model: m, vramMb: m === MODEL_A ? 19500 : 25100 }]; },
    async unload(m) { log.push(`unload ${m}`); loaded = loaded.filter((x) => x.model !== m); },
  };
  return { r, log };
}

test("[AIB-013] Proof (SIMULATED dual-model): Model A architect → Model B build → runner checks → fresh read-only Model A review → corrective prompt to Model B → second review → ready; models recorded; GPU switches between A and B", async () => {
  const r = await rig(scripted((n) => n === 1
    ? { decision: "FIX_DEFECTS", addresses: ["criterion:ac-contact"], findings: ["contact page shows the wrong phone"], nextPrompt: "Fix the contact details on every page." }
    : { decision: "READY_FOR_INTERNAL_APPROVAL", addresses: [], findings: [], nextPrompt: null }));
  const res = oneAtATime(MODEL_B);
  const scheduler = new InferenceScheduler({ models: [MODELS.a, MODELS.b], maxConcurrent: 1, vramTotalMb: 32607, vramReserveMb: 4096, switchTimeoutMs: 5000, maxWaitBeforeSwitchMs: 50, minDwellMs: 0, idleGraceMs: 5, keepAlive: "30m", residency: res.r });
  try {
    const s = await runJob(r.job, deps(r, { scheduler }));
    assert.equal(s.outcome, "ready_for_review", String(s.complete?.error) + String(s.complete?.report));
    const reqs = r.model.requests;
    const arch = reqs.filter((q) => q.model === MODEL_A && /architect session/.test(sys(q)));
    const reviews = reqs.filter((q) => q.model === MODEL_A && /independent review session/.test(sys(q)));
    const builder = reqs.filter((q) => q.model === MODEL_B);
    assert.ok(arch.length >= 2 && reviews.length >= 6 && builder.length >= 8, "architect and reviewer on Model A, the build on Model B");
    // A. The specification was stored and handed to the builder.
    assert.equal(r.cp.byPath("pipeline/spec").length, 1);
    assert.equal((r.cp.byPath("pipeline/spec")[0].body as Record<string, unknown>).provider, `local:${MODEL_A}`);
    assert.ok(existsSync(path.join(s.workspace!, "repo", "SPEC.json")));
    assert.ok(builder.some((q) => /SPEC\.json holds the architect's master specification/.test(lastUser(q))));
    // Architect and reviewer sessions have read-only tools only; the review is a fresh session (no builder history).
    for (const q of [...arch, ...reviews]) assert.deepEqual((q.tools ?? []).map((t) => t.function.name).sort(), ["list_dir", "read_file", "search"]);
    for (const q of reviews) assert.ok(!q.messages.some((m) => /Phase \d|Acme Plumbing ZX-41 built/.test(String(m.content)) && m.role === "user"), "fresh context: no builder conversation");
    const refused = reviews.flatMap((q) => q.messages.filter((m) => m.role === "tool")).find((m) => /write_file is not available in a read-only session/.test(String(m.content)));
    assert.ok(refused, "the reviewer's write attempt was refused, not executed");
    // Two cycles: the corrective prompt reached Model B; the platform got the models and the routing reason.
    assert.deepEqual(r.submitted.map((b) => b.decision), ["FIX_DEFECTS", "READY_FOR_INTERNAL_APPROVAL"]);
    assert.equal(r.submitted[0].builderModel, MODEL_B);
    assert.equal(r.submitted[0].reviewerModel, MODEL_A);
    assert.equal((r.submitted[0].routing as Record<string, unknown>).builder, "B");
    assert.equal(r.submitted[1].promptSource, "reviewer");
    assert.equal((r.submitted[1].routing as Record<string, unknown>).reason, "ordinary defects → Model B");
    assert.ok(builder.some((q) => /Fix the contact details/.test(lastUser(q))), "corrective prompt dispatched to Model B");
    // The GPU held one model at a time: B was unloaded before A loaded, and back.
    assert.ok(res.log.includes(`unload ${MODEL_B}`) && res.log.includes(`load ${MODEL_A}`) && res.log.includes(`load ${MODEL_B}`), res.log.join(", "));
    const st = scheduler.status();
    assert.ok(st.switches.count >= 3 && st.switches.failures === 0);
    assert.ok(st.perModel[MODEL_A].requests >= 8 && st.perModel[MODEL_B].requests >= 8);
    // The scheduler view reached the platform with every heartbeat.
    const orch = r.cp.byPath("heartbeat").map((h) => h.body.orchestration as { activity: string; model: string | null; task: string | null });
    assert.ok(orch.every((o) => o && typeof o.activity === "string"));
    assert.ok(orch.some((o) => o.model === MODEL_A) || orch.some((o) => o.model === MODEL_B));
    // $0: no metered key ever reached a model request; no paid host; zero cost.
    const all = JSON.stringify(reqs);
    for (const v of ["sk-ant-api-should-never-be-used-000", "sk-proj-never-used-0000", ...Object.values(POLLUTED_ENV).filter((x) => x.length > 12 && !x.includes("/"))]) assert.ok(!all.includes(v));
    assert.equal(s.complete?.runCostUsd, 0);
  } finally { scheduler.close(); await r.cp.close(); await r.model.close(); }
});

test("[AIB-015] routing (SIMULATED): the same failures twice → the correction goes to Model A; a difficult customer revision is built by Model A", async () => {
  // The fix never lands: the corrective sessions only call finish, so the same criterion fails again.
  const stuck = scripted(() => ({ decision: "FIX_DEFECTS", addresses: ["criterion:ac-contact"], findings: ["phone still wrong"], nextPrompt: "Fix the contact details on every page." }));
  const r = await rig((q) => /Fix the contact details/.test(lastUser(q)) && !/review session/.test(sys(q)) ? call("finish", { summary: "tried" }) : stuck(q), { advisor: { architect: "local", reviewer: "local", maxTurns: 10, maxCycles: 3 } });
  try {
    const s = await runJob(r.job, deps(r));
    assert.ok(["failed", "ready_for_review"].includes(s.outcome));
    const routes = r.submitted.map((b) => (b.routing as Record<string, string>));
    assert.equal(routes[0].builder, "B");
    assert.equal(routes[2].builder, "A", "after the same failure twice the repair is routed to Model A");
    assert.match(routes[2].reason, /repeated 2 times → Model A/);
    assert.equal(r.submitted[2].builderModel, MODEL_A);
    assert.ok(r.model.requests.some((q) => q.model === MODEL_A && /Fix the contact details/.test(lastUser(q))), "Model A received the corrective prompt");
  } finally { await r.cp.close(); await r.model.close(); }
  // Revision routing.
  const r2 = await rig(scripted(() => ({ decision: "READY_FOR_INTERNAL_APPROVAL", addresses: [], findings: [], nextPrompt: null })));
  try {
    const job = { ...r2.job, kind: "revision" as const, revision: 1, instruction: "Add a Stripe checkout for gift cards", spec: { version: 1, content: SPEC } };
    await runJob(job, deps(r2));
    const firstBuild = r2.model.requests.find((q) => /Phase 2/.test(lastUser(q)) || /revision/i.test(lastUser(q)));
    assert.equal(firstBuild?.model, MODEL_A, "difficult revision → Model A");
  } finally { await r2.cp.close(); await r2.model.close(); }
});

test("[AIB-015] model unavailable (SIMULATED): when a model cannot be loaded the build is checkpointed and released without spending an attempt; nothing falls back to a paid API", async () => {
  const r = await rig(scripted(() => ({ decision: "READY_FOR_INTERNAL_APPROVAL", addresses: [], findings: [], nextPrompt: null })));
  const res = oneAtATime(MODEL_A);
  const failing: Residency = { ...res.r, load: async (m) => { if (m === MODEL_B) throw new Error("CUDA error: out of memory"); return res.r.load(m, "30m"); } };
  const scheduler = new InferenceScheduler({ models: [MODELS.a, MODELS.b], maxConcurrent: 1, vramTotalMb: 32607, vramReserveMb: 4096, switchTimeoutMs: 2000, maxWaitBeforeSwitchMs: 20, minDwellMs: 0, idleGraceMs: 5, keepAlive: "30m", residency: failing });
  try {
    const s = await runJob(r.job, deps(r, { scheduler }));
    assert.equal(s.outcome, "released", String(s.complete?.error));
    assert.match(String(s.complete?.error), /could not be loaded.*no paid fallback/);
    assert.ok(s.complete?.notBefore && Date.parse(s.complete.notBefore) > Date.now());
    assert.ok(r.cp.byPath("checkpoint").length >= 1, "checkpointed");
    assert.ok(r.model.requests.every((q) => q.model === MODEL_A), "no request reached the unloaded model");
  } finally { scheduler.close(); await r.cp.close(); await r.model.close(); }
});

test("[AIB-015] $0 policy: metered variables are detected and refused; the deterministic reviewer never says ready without screenshots or with failing checks", async () => {
  assert.throws(() => assertNoMeteredEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "x" }), SpendPolicyError);
  assert.throws(() => assertNoMeteredEnv({ OPENAI_API_KEY: "x" }), SpendPolicyError);
  assert.doesNotThrow(() => assertNoMeteredEnv({ PATH: "/bin", LOCAL_MODEL: "x", HTTPS_PROXY: "http://p:3128" }));
  assert.deepEqual(meteredVariables({ OPENROUTER_API_KEY: "a", PATH: "/bin", GEMINI_API_KEY: "b", EMPTY_API_KEY: "" }), ["GEMINI_API_KEY", "OPENROUTER_API_KEY"]);
  const base: CycleEvidence = { summary: "", changedFiles: [], commits: [], checks: [{ id: "c", ok: true }], screenshots: [], criteria: [], defects: [], integrationBlockers: [], securityFindings: [], recommendedNext: [] };
  assert.equal((await new DeterministicReviewer().review(null, base)).decision, "RUN_MORE_TESTS");
  assert.equal((await new DeterministicReviewer().review(null, { ...base, checks: [{ id: "c", ok: false }] })).decision, "FIX_DEFECTS");
  assert.equal((await new DeterministicReviewer().review(null, { ...base, screenshots: [{ path: "a", viewport: "desktop", page: "i" }, { path: "b", viewport: "mobile", page: "i" }] })).decision, "READY_FOR_FINAL_QA");
});

test("[AIB-013] coordinated sessions module (kept, provider-independent; not used for local models): disjoint paths in worktrees, out-of-bounds or conflicting work re-run serially", async () => {
  const tasks = [
    { id: "a", title: "Pages", workstream: "frontend", paths: ["public/pages"], dependsOn: [] },
    { id: "b", title: "API", workstream: "backend", paths: ["src/api"], dependsOn: [] },
    { id: "c", title: "Styles", workstream: "design", paths: ["public/css"], dependsOn: [] },
    { id: "d", title: "Tests", workstream: "testing", paths: ["tests"], dependsOn: ["a", "b"] },
  ];
  assert.deepEqual(layers(tasks).map((l) => l.map((t) => t.id)), [["a", "b", "c"], ["d"]]);
  assert.equal(groupLayer([{ ...tasks[0] }, { ...tasks[0], id: "a2", paths: ["public/pages/x"] }], 3).length, 1, "overlapping paths share one session");
  const repo = tmp("aib-sessions-");
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: repo } });
  g("init", "-q"); g("config", "user.email", "t@t.invalid"); g("config", "user.name", "t");
  writeFileSync(path.join(repo, "README.md"), "x\n"); writeFileSync(path.join(repo, "BRIEF.json"), "{}"); g("add", "README.md"); g("commit", "-qm", "init");
  const recs = await runCoordinatedSessions({ git: { repo, pathEnv: process.env.PATH ?? "", home: repo }, workDir: tmp("aib-wt-"), tasks: tasks.slice(0, 3), maxSessions: 3, shouldStop: () => false,
    runSession: async (s) => {
      const t = s.tasks[0];
      if (t.id === "c" && s.cwd !== repo) { mkdirSync(path.join(s.cwd, "src/api"), { recursive: true }); writeFileSync(path.join(s.cwd, "src/api/hack.js"), "x"); }
      const dir = path.join(s.cwd, t.paths[0]); mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, `${t.id}.txt`), t.id);
      return { ok: true };
    } });
  assert.equal(recs.filter((x) => x.tasks.includes("c"))[0].status, "rerun_serially");
  assert.ok(!existsSync(path.join(repo, "src/api/hack.js")), "the out-of-bounds change was not merged");
});
