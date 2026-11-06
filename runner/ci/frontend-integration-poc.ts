// Model B, autonomously making an approved frontend work — for real, on the local models.
//
//   node --no-warnings runner/ci/frontend-integration-poc.ts [--turns 60] [--minutes 45]
//
// It starts from the workspace `frontend-import-poc.ts --stage baseline` left behind: a real Vite build, a
// frozen design baseline and an integration manifest. The quote form is inert. Model B is given the manifest,
// the inventory and the design-lock rules, and nothing else — no hints about files, no scaffold, no answer.
//
// Then the site is rebuilt, re-measured against the baseline, and the manifest's own acceptance criteria are
// run against the real application. Both have to pass, which is the point: a site that works but looks
// different fails, and so does one that looks right and does nothing.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { JobSandbox, cliDockerExecutor } from "../src/sandbox.ts";
import { LocalProvider } from "../src/providers/local.ts";
import { RunTracker, StopSwitch } from "../src/agent.ts";
import { createLogger } from "../src/log.ts";
import { createWorkspace } from "../src/workspace.ts";
import { readBaseline, verifyDesignHeld } from "../src/frontend/workflow.ts";
import { readImportReport, describeVerify } from "../src/frontend/import.ts";
import { integrationMemory, integrationPrompt, readIntegrationOutcome } from "../src/frontend/integrate.ts";
import type { Job } from "../src/protocol.ts";

const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const maxTurns = Number(arg("--turns", "60"));
const maxMinutes = Number(arg("--minutes", "45"));

const IMPORT_WS = path.resolve(arg("--from", path.join(tmpdir(), "crestmont-import-poc", "ws")));
const WORK = path.resolve(arg("--work", path.join(tmpdir(), "crestmont-integration-poc")));
const FIXTURE = path.resolve(import.meta.dirname, "../test/fixtures/summit-haul-frontend");

const log = createLogger({ sink: (line) => console.log(line) });
const rule = (s: string) => console.log(`\n${"=".repeat(78)}\n${s}\n${"=".repeat(78)}`);

const dockerEnv = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) out[k] = v;
  return out;
};

function job(): Job {
  return {
    id: "bld_integration_poc", projectId: "prj_integration_poc", attempt: 1, kind: "first_build",
    packageId: "business", instruction: null, requirements: null, strategy: "standard",
    leaseToken: "", leaseExpiresAt: "", workspaceRef: null, checkpointKey: null,
    sourceRepo: null, sourceBranch: null, sourceCommit: null, maxTurns, maxBudgetUsd: 0,
  } as unknown as Job;
}

async function main() {
  if (!existsSync(path.join(IMPORT_WS, "repo", ".crestmont", "design-baseline.json"))) {
    console.error(`no frozen baseline under ${IMPORT_WS}. Run: node --no-warnings runner/ci/frontend-import-poc.ts --stage baseline`);
    process.exit(2);
  }

  // A fresh workspace, seeded from the imported project but with the frontend reset to its APPROVED state, so
  // Model B starts from the inert form and has to do the work itself.
  rmSync(WORK, { recursive: true, force: true });
  const ws = createWorkspace(WORK, { id: "bld_integration_poc", attempt: 1 });
  console.log(`seeding ${ws.repo} from ${IMPORT_WS}`);

  // node_modules is NOT copied. `cpSync` recursing through an installed dependency tree crashes Node on Windows
  // with a stack-buffer overrun (0xC0000409) and no output at all, which is a miserable thing to debug. The
  // dependencies are reinstalled in the sandbox from the lockfile instead, which is also more honest: Model B
  // gets the tree the lockfile describes, not whatever an earlier run left lying about.
  cpSync(path.join(IMPORT_WS, "repo"), ws.repo, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|dist|\.git)([\\/]|$)/.test(src),
  });
  cpSync(path.join(FIXTURE, "src"), path.join(ws.repo, "src"), { recursive: true });
  rmSync(path.join(ws.repo, "server"), { recursive: true, force: true });
  rmSync(path.join(ws.repo, ".crestmont", "import-verify"), { recursive: true, force: true });
  rmSync(path.join(ws.repo, ".crestmont", "import-drift"), { recursive: true, force: true });
  console.log("seeded (dependencies are installed in the sandbox below)");

  const baseline = readBaseline(ws.repo)!;
  const report = readImportReport(path.join(ws.repo, ".crestmont", "import"));
  const manifest = JSON.parse(readFileSync(path.join(IMPORT_WS, "..", "manifest.json"), "utf8"));

  const prompt = integrationPrompt({ manifest, baseline, report, outputRoot: "dist", framework: "vite" });
  mkdirSync(path.join(WORK, "evidence"), { recursive: true });
  writeFileSync(path.join(WORK, "evidence", "integration-prompt.md"), prompt);

  rule("what Model B is being asked to do");
  console.log(`baseline ${baseline.fingerprint.slice(0, 16)}… approved by ${baseline.approvedBy}`);
  console.log(`${manifest.operations.length} operation(s); prompt is ${prompt.length} characters`);
  console.log(`workspace: ${ws.repo}`);
  console.log(`budget: ${maxTurns} turns, ${maxMinutes} minutes`);

  const cfg = loadConfig(process.env);
  const executor = cliDockerExecutor(cfg.jobSandbox.dockerBin, dockerEnv());
  const pre = await JobSandbox.preflight(cfg.jobSandbox, executor);
  if (pre.length) { console.error(`cannot run: ${pre.join("; ")}`); process.exit(2); }
  console.log(`model: ${cfg.models.mode === "dual" ? cfg.models.b.tag : cfg.local.model} at ${cfg.local.baseUrl}`);

  const installSandbox = new JobSandbox(cfg.jobSandbox, ws, "bld_integration_poc", executor, log);
  console.log("installing dependencies from the lockfile...");
  const installed = await installSandbox.install();
  if (installed.code !== 0) {
    console.error(`dependencies did not install (exit ${installed.code}): ${(installed.stderr || installed.stdout).slice(0, 800)}`);
    process.exit(2);
  }
  await installSandbox.close().catch(() => {});
  console.log("dependencies installed");

  const provider = new LocalProvider({ cfg, executor, log });
  const j = job();
  await provider.prepare({ job: j, ws, skillNames: [], referenceDomains: [], processEnv: process.env, systemPromptAppend: "" });

  const tracker = new RunTracker();
  const stop = new StopSwitch();
  // The tracker buffers activity rather than pushing it; drain it on a timer so a long run is watchable.
  const ticker = setInterval(() => {
    for (const a of tracker.drainActivity()) console.log(`  · ${String((a as { message?: string }).message ?? "").slice(0, 180)}`);
  }, 5_000);

  rule("Model B is working");
  const started = Date.now();
  const result = await provider.run({
    phase: "build",
    prompt,
    maxTurns,
    maxBudgetUsd: 0,
    maxWallMs: maxMinutes * 60_000,
    resumeSessionId: null,
    tracker,
    stop,
    model: cfg.models.mode === "dual" ? cfg.models.b.tag : cfg.local.model,
    task: "backend integration",
    memory: () => integrationMemory(report, baseline),
  });
  clearInterval(ticker);
  for (const a of tracker.drainActivity()) console.log(`  · ${String((a as { message?: string }).message ?? "").slice(0, 180)}`);
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);

  rule("what Model B did");
  console.log(`status: ${result.status}${result.error ? ` — ${String(result.error).slice(0, 300)}` : ""}`);
  console.log(`${minutes} minutes, ${tracker.turns()} turn(s)`);
  const outcome = readIntegrationOutcome(ws.repo);
  if (outcome.summary) console.log(`\nits own summary:\n${outcome.summary.slice(0, 2500)}`);
  if (outcome.exceptionRequest) console.log(`\nit asked for a design exception instead of taking one:\n${outcome.exceptionRequest.slice(0, 1200)}`);

  // ── did the design survive it? ────────────────────────────────────────────────────────────────────────────
  const sandbox = new JobSandbox(cfg.jobSandbox, ws, j.id, executor, log);
  try {
    rule("rebuilding and re-measuring");
    const rebuilt = await sandbox.argv(["npm", "run", "build"], 300_000, "npm run build");
    if (rebuilt.code !== 0) {
      console.error(`the project no longer builds (exit ${rebuilt.code}):\n${(rebuilt.stderr || rebuilt.stdout).slice(0, 1500)}`);
      process.exit(1);
    }
    const v = await verifyDesignHeld({ repo: ws.repo, sandbox, outputRoot: "dist", manifest, before: report, out: ".crestmont/import-after-modelb" });
    console.log(v.verify ? describeVerify(v.verify) : v.problems.join("\n"));
    console.log(v.ok ? "\nDESIGN: held." : "\nDESIGN: did NOT hold.");

    rule("does it actually work?");
    const proof = path.join(ws.repo, "server", "verify-backend.mjs");
    if (!existsSync(proof)) {
      console.log("Model B did not produce a server/verify-backend.mjs; running the manifest's acceptance criteria is not possible automatically.");
      console.log("acceptance criteria that would have been checked:");
      for (const op of manifest.operations) for (const a of op.acceptance) console.log(`  - ${a}`);
    } else {
      const ran = await sandbox.argv(["node", "--no-warnings", "server/verify-backend.mjs", "--root", "dist"], 300_000, "acceptance");
      console.log(ran.stdout.slice(-3000) || ran.stderr.slice(-2000));
      console.log(ran.code === 0 ? "FUNCTIONAL: all acceptance checks passed." : `FUNCTIONAL: ${ran.code === 1 ? "some checks failed" : `could not run (exit ${ran.code})`}.`);
    }

    cpSync(path.join(ws.repo, ".crestmont"), path.join(WORK, "evidence", "crestmont"), { recursive: true });
    console.log(`\nevidence kept at ${path.join(WORK, "evidence")}`);
    console.log(`workspace kept at ${ws.repo}`);
  } finally {
    await sandbox.close().catch(() => {});
    await provider.close?.().catch(() => {});
  }
}

main().catch((e) => { console.error(String((e as Error)?.stack ?? e)); process.exit(2); });
