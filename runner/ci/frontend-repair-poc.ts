// Can Model B repair a CONTRACT violation without touching the design?
//
//   node --no-warnings runner/ci/frontend-repair-poc.ts [--from <workspace>] [--turns 60] [--minutes 40]
//
// The first autonomous run produced working code that did not match the approved architecture: a JSON file
// where the contract named a `quote_requests` table, and the project's `dev` script quietly repointed. Every
// behavioural check passed. This asks the question that follows: given that finding, written as instructions,
// can the model put it right — and does the approved design survive the repair?
//
// It starts from the workspace the integration run left behind, so the thing being repaired is real output.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { JobSandbox } from "../src/sandbox.ts";
import { PocSandboxes, pocConfig } from "./poc-sandbox.ts";
import { LocalProvider } from "../src/providers/local.ts";
import { RunTracker, StopSwitch } from "../src/agent.ts";
import { createLogger } from "../src/log.ts";
import { createWorkspace } from "../src/workspace.ts";
import { readBaseline, verifyDesignHeld } from "../src/frontend/workflow.ts";
import { readImportReport, describeVerify } from "../src/frontend/import.ts";
import { checkConformance, describeConformance, repairBrief } from "../src/frontend/conformance.ts";
import { readIntegrationOutcome } from "../src/frontend/integrate.ts";
import type { Job } from "../src/protocol.ts";
import type { IntegrationManifest, ManifestContract } from "../src/frontend/integration-manifest.ts";

const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const maxTurns = Number(arg("--turns", "60"));
const maxMinutes = Number(arg("--minutes", "40"));
const FROM = path.resolve(arg("--from", ""));
const WORK = path.resolve(arg("--work", path.join(tmpdir(), "crestmont-repair-poc")));
const FIXTURE = path.resolve(import.meta.dirname, "../test/fixtures/summit-haul-frontend");

const log = createLogger({ sink: (line) => console.log(line) });
const rule = (s: string) => console.log(`\n${"=".repeat(78)}\n${s}\n${"=".repeat(78)}`);

const dockerEnv = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) out[k] = v;
  return out;
};

/** The contract the first run was measured against, now enforced. */
function contractFor(manifest: IntegrationManifest & ManifestContract): IntegrationManifest & ManifestContract {
  return {
    ...manifest,
    dataModels: [{ table: "quote_requests", fields: ["name", "phone", "email", "postcode", "load_size", "details", "created_at"], purpose: "quote requests from the website" }],
    persistence: { enforcement: "required" as const, technology: "sqlite" as const, durable: true },
    projectConfig: {
      scripts: { dev: "preserve" as const, build: "preserve" as const },
      allowedDependencies: ["express"],
      allowedNewScripts: ["start", "serve"],
    },
  };
}

async function main() {
  if (!FROM || !existsSync(path.join(FROM, "package.json"))) {
    console.error(`--from must point at the repo the integration run produced (got ${FROM || "nothing"})`);
    process.exit(2);
  }

  rmSync(WORK, { recursive: true, force: true });
  const ws = createWorkspace(WORK, { id: "bld_repair_poc", attempt: 1 });
  cpSync(FROM, ws.repo, { recursive: true, filter: (src) => !/[\\/](node_modules|dist|\.git)([\\/]|$)/.test(src) });

  const baseline = readBaseline(ws.repo)!;
  const report = readImportReport(path.join(ws.repo, ".crestmont", "import"));
  const manifest = contractFor(JSON.parse(readFileSync(path.join(WORK, "..", "crestmont-import-poc", "manifest.json"), "utf8")) as IntegrationManifest & ManifestContract);
  const approvedPackage = JSON.parse(readFileSync(path.join(FIXTURE, "package.json"), "utf8"));

  rule("the implementation as it stands");
  const before = checkConformance({ repo: ws.repo, manifest, baselinePackage: approvedPackage });
  console.log(describeConformance(before));
  if (before.ok) {
    console.log("\nnothing to repair: it already conforms.");
    process.exit(0);
  }

  const brief = repairBrief(before, { attempt: 1, maxAttempts: 3 });
  mkdirSync(path.join(WORK, "evidence"), { recursive: true });
  writeFileSync(path.join(WORK, "evidence", "repair-brief.md"), brief);

  const cfg = loadConfig(process.env);
  // Its own runner id, so `reapOwn()` collects what THIS script left and nothing else. Without it the
  // containers carry the real runner's id or a shared one, and no reaper is allowed to touch them.
  cfg.jobSandbox = pocConfig("repair-poc", { image: cfg.jobSandbox.image });
  const pocs = new PocSandboxes(cfg.jobSandbox, log);
  const removeHandlers = pocs.installExitHandlers();
  await pocs.reapOwn();
  const executor = pocs.executor;
  const pre = await JobSandbox.preflight(cfg.jobSandbox, executor);
  if (pre.length) { console.error(`cannot run: ${pre.join("; ")}`); process.exit(2); }

  const install = pocs.create(ws, "bld_repair_poc");
  console.log("\ninstalling dependencies...");
  const installed = await install.install();
  if (installed.code !== 0) { console.error(`install failed: ${(installed.stderr || installed.stdout).slice(0, 600)}`); process.exit(2); }

  const job = { id: "bld_repair_poc", projectId: "prj_repair_poc", attempt: 1, kind: "first_build", packageId: "business",
    instruction: null, requirements: null, strategy: "standard", leaseToken: "", leaseExpiresAt: "", workspaceRef: null,
    checkpointKey: null, sourceRepo: null, sourceBranch: null, sourceCommit: null, maxTurns, maxBudgetUsd: 0 } as unknown as Job;

  const provider = new LocalProvider({ cfg, executor, log });
  await provider.prepare({ job, ws, skillNames: [], referenceDomains: [], processEnv: process.env, systemPromptAppend: "" });

  const tracker = new RunTracker();
  const ticker = setInterval(() => {
    for (const a of tracker.drainActivity()) console.log(`  · ${String((a as { message?: string }).message ?? "").slice(0, 170)}`);
  }, 5_000);

  rule(`Model B is repairing ${before.findings.filter((f) => f.severity === "violation").length} contract violation(s)`);
  const started = Date.now();
  const result = await provider.run({
    phase: "repair", prompt: brief, maxTurns, maxBudgetUsd: 0, maxWallMs: maxMinutes * 60_000,
    resumeSessionId: null, tracker, stop: new StopSwitch(),
    model: cfg.models.mode === "dual" ? cfg.models.b.tag : cfg.local.model,
    task: "contract repair",
    memory: () => `The frontend is approved and design-locked (${baseline.fingerprint.slice(0, 12)}…). Repair the contract violations only. Do not change the design.`,
  });
  clearInterval(ticker);
  for (const a of tracker.drainActivity()) console.log(`  · ${String((a as { message?: string }).message ?? "").slice(0, 170)}`);

  rule("what it did");
  console.log(`status: ${result.status}${result.error ? ` — ${String(result.error).slice(0, 300)}` : ""}`);
  console.log(`${((Date.now() - started) / 60_000).toFixed(1)} minutes, ${tracker.turns()} turn(s)`);
  const outcome = readIntegrationOutcome(ws.repo);
  if (outcome.summary) console.log(`\nits summary:\n${outcome.summary.slice(0, 2000)}`);

  // ── the three questions ───────────────────────────────────────────────────────────────────────────────────
  const sandbox = pocs.create(ws, job.id);
  try {
    rule("1. does it conform now?");
    const after = checkConformance({ repo: ws.repo, manifest, baselinePackage: approvedPackage });
    console.log(describeConformance(after));
    const fixed = before.findings.filter((f) => f.severity === "violation").map((f) => f.code)
      .filter((c) => !after.findings.some((g) => g.code === c && g.severity === "violation"));
    console.log(`\nrepaired: ${fixed.join(", ") || "nothing"}`);
    console.log(`still failing: ${after.findings.filter((f) => f.severity === "violation").map((f) => f.code).join(", ") || "nothing"}`);

    rule("2. does it still build and look the same?");
    const built = await sandbox.argv(["npm", "run", "build"], 300_000, "npm run build");
    if (built.code !== 0) {
      console.error(`the project no longer builds (exit ${built.code}):\n${(built.stderr || built.stdout).slice(0, 1200)}`);
    } else {
      const v = await verifyDesignHeld({ repo: ws.repo, sandbox, outputRoot: "dist", manifest, before: report, out: ".crestmont/import-after-repair" });
      console.log(v.verify ? describeVerify(v.verify) : v.problems.join("\n"));
      console.log(v.ok ? "DESIGN: held." : "DESIGN: did NOT hold.");
    }

    rule("3. does it still work?");
    const proof = path.join(ws.repo, "verify-model-b.mjs");
    if (!existsSync(proof)) cpSync(path.resolve(import.meta.dirname, "verify-model-b.mjs"), proof);
    const start = JSON.parse(readFileSync(path.join(ws.repo, "package.json"), "utf8")).scripts?.start ?? "node server.js";
    const ran = await sandbox.argv(["node", "--no-warnings", "verify-model-b.mjs", "--start", start, "--port", "3200"], 300_000, "acceptance");
    console.log((ran.stdout || ran.stderr).slice(-2500));

    cpSync(path.join(ws.repo, ".crestmont"), path.join(WORK, "evidence", "crestmont"), { recursive: true });
    console.log(`\nevidence: ${path.join(WORK, "evidence")}\nworkspace: ${ws.repo}`);
  } finally {
    await pocs.closeAll();
    removeHandlers();
    await provider.close?.().catch(() => {});
  }
}

main().catch((e) => { console.error(String((e as Error)?.stack ?? e)); process.exit(2); });
