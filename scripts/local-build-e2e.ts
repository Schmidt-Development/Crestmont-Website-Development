// Local-only Node 1 AI website build harness (Founder Option A, 2026-11-01).
//
// WHAT THIS IS: a test interface, NOT a second builder. It drives the REAL runner (runner/src/job.ts runJob) with the
// REAL local Ollama models (Model A architect/reviewer, Model B builder) and the REAL per-build Docker sandbox,
// against the REAL platform routes (src/app/app.ts handle) on an in-memory SQLite database. Nothing in this file
// authors, reviews or repairs website code: the existing orchestrator, reviewer and repair loop do all of that.
//
//   node --no-warnings scripts/local-build-e2e.ts [--prepare-only] [--out <dir>]
//
// LOCAL ONLY. It opens no socket and exposes no endpoint: the runner's ControlPlaneClient is given a fetchImpl that
// calls the Worker's own fetch handler in-process, so every request is really HMAC-signed by the runner and really
// authorized by the platform's runner routes. Nothing touches staging, production, Stripe or Headquarters.
//
// The payment is the existing test-only simulation adapter against the in-memory database (ENVIRONMENT=development),
// exactly as tests/e2e-simulated-purchase.test.ts already does. No real payment provider is configured or called.
//
// Run it from OUTSIDE this repository (the runner's own isolation check requires it), e.g.:
//   cd C:\CrestmontRunner && node --no-warnings C:\...\scripts\local-build-e2e.ts
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { randomBytes } from "node:crypto";

// -- platform (real) --
import { createTestApp, createStaff, createCustomer, MemoryStorage } from "../tests/support/app.ts";
import { handle } from "../src/app/app.ts";
import { createPackageOrder } from "../src/services/commerce.ts";
import * as SIM from "../src/services/payment-simulation.ts";
import * as B from "../src/services/builds.ts";
import * as W from "../src/services/build-workers.ts";
import { JUNK_IN_THE_TRUNK } from "../tests/fixtures/junk-in-the-trunk.ts";
import { JUNK_IN_THE_TRUNK_PREMIUM } from "../tests/fixtures/junk-in-the-trunk-premium.ts";

// -- runner (real) --
import { loadConfig } from "../runner/src/config.ts";
import { ControlPlaneClient } from "../runner/src/control-plane.ts";
import { runJob } from "../runner/src/job.ts";
import { loadManifest } from "../runner/src/skills.ts";
import { createLogger } from "../runner/src/log.ts";
import { createScheduler, capabilities } from "../runner/src/main.ts";
import { assertIsolation } from "../runner/src/workspace.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const PACKAGE = "business" as const;          // Founder requirement 1: Business $2,499.00, 100% upfront.
// --intake premium: the same customer, package and seven pages with the Founder's premium design direction added to
// the brief (2026-11-02). The default stays the original intake so the 8.16/10 baseline remains reproducible.
const JT = opt("--intake", "original") === "premium" ? JUNK_IN_THE_TRUNK_PREMIUM : JUNK_IN_THE_TRUNK;
const EXPECTED_CENTS = 249_900;
const BASE = "http://crestmont.test";
const RUNNER_SECRET = randomBytes(32).toString("hex");
const OUT = path.resolve(opt("--out", path.join(process.cwd(), "local-build", "evidence")));
mkdirSync(OUT, { recursive: true });

const log = (...a: unknown[]) => console.log(`[harness ${new Date().toISOString()}]`, ...a);
const one = async <R>(db: any, sql: string, ...b: unknown[]): Promise<R> => (await db.prepare(sql).bind(...b).first<R>())!;

async function main(): Promise<number> {
  // ===== Phase 1: the real platform workflow, in memory =====
  log(`phase 1: platform workflow (${PACKAGE} package, in-memory SQLite, ENVIRONMENT=development)`);
  const t = await createTestApp({ BUILD_RUNNER_SECRET: RUNNER_SECRET, PAYMENT_SIMULATION_ENABLED: "true", overrides: { storage: new MemoryStorage() } });
  const env = t.env;
  const owner = await createStaff(t.db, "owner", "owner@crestmont.test");
  const customer = await createCustomer(t.db, JT.email, JT.business);

  // Real catalog purchase of the Business package (the checkout route's own service function).
  const order = await createPackageOrder(t.db, customer.organizationId, PACKAGE, customer.id);
  const inv = await one<{ amount_cents: number; status: string; milestone_kind: string }>(t.db, `SELECT amount_cents, status, milestone_kind FROM invoices WHERE id = ?`, order.invoiceId);
  assert.equal(inv.amount_cents, EXPECTED_CENTS, `Business package must be $2,499.00 (got ${inv.amount_cents} cents)`);
  log(`  invoice ${order.invoiceId}: ${inv.amount_cents} cents, ${inv.milestone_kind}, ${inv.status}`);

  // Test-only simulated payment (in-memory DB). Marks the fictional org first, exactly as the Owner page does.
  await SIM.markTestOrganization({ db: t.db, env }, owner.id, customer.organizationId, true, JT.business);
  const ev = await SIM.createSimulatedEvent(t.db, env, order.invoiceId, { correlationId: "corr_local_build_e2e" });
  const delivered = await SIM.deliverSimulatedEvent({ db: t.db, env, email: undefined as never, baseUrl: BASE }, owner.id, ev);
  assert.equal(delivered.outcome, "applied", `simulated payment not applied: ${delivered.reason ?? ""}`);
  const project = await one<{ id: string; status: string }>(t.db, `SELECT id, status FROM projects WHERE order_id = (SELECT order_id FROM invoices WHERE id = ?)`, order.invoiceId);
  log(`  payment applied; project ${project.id} provisioned (${project.status})`);

  // Real onboarding form submission by the customer -> real validation.
  const cust = t.client();
  await cust.login(JT.email);
  const intakeRes = await cust.post(`/portal/projects/${project.id}/onboarding`, { ...JT.intake, functionality: [...JT.intake.functionality] });
  assert.equal(intakeRes.status, 303, `onboarding rejected: ${(await intakeRes.clone().text()).slice(0, 400)}`);
  const ob = await one<{ completed_at: string | null }>(t.db, `SELECT completed_at FROM onboarding_responses WHERE project_id = ?`, project.id);
  assert.ok(ob.completed_at, "onboarding did not pass validation");
  log("  intake submitted and validated by the real onboarding form");

  // Real eligibility -> exactly one queued build, with the real brief.
  const jobs = (await t.db.prepare(`SELECT * FROM build_jobs WHERE project_id = ?`).bind(project.id).all<any>()).results;
  assert.equal(jobs.length, 1, `expected exactly one build, got ${jobs.length}`);
  const bj = jobs[0];
  assert.equal(bj.state, "queued", `build is ${bj.state}, not queued`);
  assert.equal(bj.strategy, "standard", `strategy is ${bj.strategy}; the Business package must use the standard starter pipeline`);
  const brief = JSON.parse((await one<{ content_json: string }>(t.db, `SELECT content_json FROM build_briefs WHERE id = ?`, bj.brief_id)).content_json);
  assert.deepEqual(brief.customerData.pages, [...JT.requiredPages], "brief must carry all seven pages");
  assert.deepEqual(brief.customerData.pagesOverLimit, [], "no page may exceed the Business 12-page limit");
  assert.equal(brief.package.id, PACKAGE);
  assert.equal(brief.package.pageLimit, 12);
  const reqs = (await t.db.prepare(`SELECT key FROM build_requirements WHERE job_id = ?`).bind(bj.id).all<{ key: string }>()).results.map((r) => r.key);
  assert.equal(reqs.filter((k) => k.startsWith("page:")).length, 7, "seven page requirements");
  assert.deepEqual(B.decideEligibility(await B.projectFacts(t.db, project.id)), { verdict: "queued", reasons: ["verified payment and submitted intake"] });
  log(`  build ${bj.id} queued: strategy=${bj.strategy} package=${brief.package.id} pages=${brief.customerData.pages.length} requirements=${reqs.length}`);

  // ===== Phase 2: the real runner claims and builds it =====
  const worker = await W.registerWorker({ db: t.db, userId: owner.id }, { label: "Node 1 (local-build-e2e)", maxActiveProjects: 1 });

  // In-process transport: the runner's real signed requests go to the Worker's real fetch handler. No socket.
  const appFetch: typeof fetch = async (input, init) => handle(new Request(input as RequestInfo, init), env);

  process.env.CONTROL_PLANE_URL = BASE;
  process.env.BUILD_RUNNER_SECRET = RUNNER_SECRET;
  process.env.RUNNER_AGENT_PROVIDER = "local";
  process.env.RUNNER_ID = process.env.RUNNER_ID ?? "node1-local-build-e2e";
  process.env.RUNNER_WORKSPACES = process.env.RUNNER_WORKSPACES ?? path.join(process.cwd(), "local-build", "workspaces");
  process.env.SKILLS_SOURCE_DIR = process.env.SKILLS_SOURCE_DIR ?? "C:\\CrestmontRunner\\skills";
  process.env.LOCAL_MODEL_BASE_URL = process.env.LOCAL_MODEL_BASE_URL ?? "http://127.0.0.1:11434/v1";
  process.env.LOCAL_MODEL_A = process.env.LOCAL_MODEL_A ?? "qwen3.8:27b-q4_K_M";
  // Mirrors compose/runner.env. Without it the reviewer is handed screenshot FILENAMES instead of the images and
  // cannot judge how the site looks — which is how seven local builds were reviewed blind.
  process.env.LOCAL_MODEL_A_VISION = process.env.LOCAL_MODEL_A_VISION ?? "true";
  process.env.LOCAL_MODEL_B = process.env.LOCAL_MODEL_B ?? "qwen3.6:35b-a3b-q4_K_M";
  process.env.LOCAL_MODEL_CONTEXT_TOKENS = process.env.LOCAL_MODEL_CONTEXT_TOKENS ?? "49152";
  process.env.RUNNER_SANDBOX_IMAGE = process.env.RUNNER_SANDBOX_IMAGE ?? "crestmont-build-sandbox:1";
  process.env.RUNNER_INSTALL_NETWORK = process.env.RUNNER_INSTALL_NETWORK ?? "crestmont_install";
  delete process.env.RUNNER_SANDBOX_VOLUME;   // host run: the sandbox bind-mounts this job's repo/home

  const cfg = loadConfig();
  // The runner's real isolation guard: refuses to run inside a platform checkout, or with workspaces in a repository.
  await assertIsolation({ cwd: process.cwd(), workspacesRoot: cfg.workspacesRoot, platformRepoPatterns: cfg.platformRepoPatterns, pathEnv: cfg.agentPath });

  const logger = createLogger({ level: cfg.logLevel, base: { runnerId: cfg.runnerId } });
  const manifest = loadManifest(cfg.skillsManifestPath);
  const client = new ControlPlaneClient({ baseUrl: BASE, secret: RUNNER_SECRET, runnerId: cfg.runnerId, fetchImpl: appFetch, logger, worker: { id: worker.id, key: worker.enrollmentKey } });

  // -- optional: run a REVISION of an earlier local build instead of a first build --
  // The earlier build's workspace is still on disk, so the runner's own resume path (findLocalWorkspace ->
  // latestCheckpointFile -> restoreCheckpoint) restores its git source. We record that finished build through the
  // real runner protocol (checkpoint + complete), then queue the revision through the real owner revision path.
  const revisionFile = opt("--revise", "");
  if (revisionFile) {
    const instruction = readFileSync(revisionFile, "utf8").trim();
    const wsRef = opt("--from-workspace", "");
    assert.ok(wsRef, "--revise requires --from-workspace <workspaceRef>");
    const prevRepo = path.join(cfg.workspacesRoot, wsRef, "repo");
    assert.ok(existsSync(prevRepo), `previous workspace repo not found: ${prevRepo}`);
    const git = (...a: string[]) => execFileSync("git", ["-C", prevRepo, ...a], { encoding: "utf8" }).trim();
    const commit = git("rev-parse", "HEAD");
    const prevBranch = git("rev-parse", "--abbrev-ref", "HEAD");
    const srcRepo = `runner-local:${cfg.runnerId}/${wsRef}`;
    const first = await client.claim(capabilities(cfg));
    assert.ok(first.job, `no first build to record: ${JSON.stringify(first)}`);
    const sessionId = `local-build-${wsRef}`;
    await client.checkpoint(first.job, { sessionId, workspaceRef: wsRef, sourceRepo: srcRepo, sourceBranch: prevBranch, sourceCommit: commit });
    await client.complete(first.job, { outcome: "ready_for_review", runCostUsd: 0, turns: 0, sessionId, sourceRepo: srcRepo, sourceBranch: prevBranch, sourceCommit: commit, previewUrl: null,
      report: `Recorded from the completed local build in workspace ${wsRef} (${commit}). See build.log for that run.` });
    const revId = await B.submitRevision({ db: t.db, userId: owner.id }, project.id, instruction);
    log(`  recorded first build ${first.job.id} -> ready_for_review; queued revision ${revId} from ${wsRef}@${commit.slice(0, 7)} on ${prevBranch}`);
  }

  const claimed = await client.claim(capabilities(cfg));
  assert.ok(claimed.job, `runner claimed no job: ${JSON.stringify(claimed)}`);
  const job = claimed.job;
  if (!revisionFile) assert.equal(job.id, bj.id);
  else assert.equal(job.kind, "revision", `expected to claim the revision, got ${job.kind}`);
  assert.equal(job.brief.content.schema, "crestmont.build-brief/1");
  log(`  claimed job ${job.id} attempt ${job.attempt}: strategy=${job.strategy} package=${job.packageId} starter=${job.starter?.name ?? "(none)"}@${job.starter?.version ?? "-"}`);
  log(`  limits: maxTurns=${job.limits.maxTurns} maxRuntimeMinutes=${job.limits.maxRuntimeMinutes} model=${job.limits.model}`);

  const prepared = {
    at: new Date().toISOString(), package: PACKAGE, invoiceCents: inv.amount_cents, projectId: project.id, jobId: job.id,
    strategy: job.strategy, starter: job.starter, pages: brief.customerData.pages, requirements: reqs,
    models: { architect: cfg.models.a.tag, builder: cfg.models.b.tag, mode: cfg.models.mode },
    maxCycles: cfg.advisor.maxCycles, workspacesRoot: cfg.workspacesRoot,
  };
  writeFileSync(path.join(OUT, "prepared.json"), JSON.stringify(prepared, null, 2));
  log(`  wrote ${path.join(OUT, "prepared.json")}`);

  if (flag("--prepare-only")) { log("--prepare-only: stopping before inference"); return 0; }

  // -- the real build: real models, real sandbox, real review and repair loops --
  log(`phase 2: runJob (A=${cfg.models.a.tag} B=${cfg.models.b.tag}, maxCycles=${cfg.advisor.maxCycles}) - this takes a long time`);
  const scheduler = createScheduler(cfg, logger);
  const startedAt = Date.now();
  let summary: any;
  try {
    summary = await runJob(job, { cfg, client, manifest, logger, scheduler });
  } finally {
    scheduler?.close();
  }
  const durationMs = Date.now() - startedAt;

  // -- what the platform recorded --
  const finalJob = await B.getJob(t.db, job.id);
  const events = (await t.db.prepare(`SELECT kind, message, at FROM build_events WHERE job_id = ? ORDER BY id`).bind(job.id).all<any>()).results;
  // evidence_json and proposed_decision are what make an overruled / ESCALATED verdict diagnosable afterwards:
  // the platform overrules a "ready" decision when any criterion is outstanding or a viewport screenshot is missing.
  const cycles = (await t.db.prepare(`SELECT cycle, proposed_decision, decision, decision_reason, score, builder_model, reviewer_model, reviewer_provider, routing_json, findings_json, evidence_json FROM build_cycles WHERE job_id = ? ORDER BY cycle`).bind(job.id).all<any>()).results;
  const requirements = (await t.db.prepare(`SELECT key, status, evidence FROM build_requirements WHERE job_id = ?`).bind(job.id).all<any>()).results;
  const run = await t.db.prepare(`SELECT attempt, runner_id, started_at, ended_at, outcome, cost_micro, turns, session_id, error FROM build_runs WHERE job_id = ? ORDER BY attempt DESC LIMIT 1`).bind(job.id).first<any>();

  const evidence = {
    harness: "scripts/local-build-e2e.ts", at: new Date().toISOString(), durationMs,
    durationHuman: `${Math.floor(durationMs / 60000)}m ${Math.round((durationMs % 60000) / 1000)}s`,
    package: PACKAGE, invoiceCents: inv.amount_cents, projectId: project.id, jobId: job.id,
    models: { architect: cfg.models.a.tag, builder: cfg.models.b.tag, mode: cfg.models.mode, baseUrl: cfg.local.baseUrl },
    outcome: summary?.outcome ?? null, complete: summary?.complete ?? null, checks: summary?.checks ?? null,
    platformState: finalJob?.state ?? null, aiAcceptance: (finalJob as any)?.ai_acceptance ?? null,
    cycles, requirements, events: events.map((e: any) => ({ kind: e.kind, message: e.message, at: e.at })),
    run: run ? { attempt: run.attempt, runnerId: run.runner_id, startedAt: run.started_at, endedAt: run.ended_at, outcome: run.outcome, costUsd: (run.cost_micro ?? 0) / 1e6, turns: run.turns, sessionId: run.session_id, error: run.error } : null,
    // Repo/branch/commit/preview come from the runner's own completion payload, which is authoritative for them.
    source: summary?.complete ? { repo: summary.complete.sourceRepo ?? null, branch: summary.complete.sourceBranch ?? null, commit: summary.complete.sourceCommit ?? null, previewUrl: summary.complete.previewUrl ?? null } : null,
    workspacesRoot: cfg.workspacesRoot,
  };
  writeFileSync(path.join(OUT, "build-evidence.json"), JSON.stringify(evidence, null, 2));
  if (summary?.complete?.report) writeFileSync(path.join(OUT, "agent-report.md"), String(summary.complete.report));

  log("");
  log(`outcome:        ${evidence.outcome}`);
  log(`platform state: ${evidence.platformState} (acceptance: ${evidence.aiAcceptance ?? "n/a"})`);
  log(`duration:       ${evidence.durationHuman}`);
  log(`turns / cost:   ${evidence.run?.turns ?? "?"} turns, $${(evidence.run?.costUsd ?? 0).toFixed(2)}`);
  log(`commit:         ${evidence.source?.commit ?? "(none)"} on ${evidence.source?.branch ?? "(none)"}`);
  log(`review cycles:  ${cycles.length}`);
  for (const c of cycles) log(`  cycle ${c.cycle}: ${c.decision} (${c.decision_reason ?? "-"}) builder=${c.builder_model ?? "-"} reviewer=${c.reviewer_model ?? c.reviewer_provider ?? "-"}`);
  log(`checks:         ${(summary?.checks ?? []).map((c: any) => `${c.id}=${c.ok ? "PASS" : "FAIL"}`).join(" ") || "(none)"}`);
  log(`requirements:   ${requirements.filter((r: any) => r.status === "verified").length}/${requirements.length} verified`);
  log(`evidence:       ${OUT}`);
  log(`workspace:      ${cfg.workspacesRoot}`);
  return summary?.outcome === "ready_for_review" ? 0 : 2;
}

main().then((c) => process.exit(c), (err) => { console.error("harness failed:", err); process.exit(1); });
