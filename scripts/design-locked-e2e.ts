// Design-locked Artifact-to-Backend Builder — the joined-up end-to-end certification.
//
// WHAT THIS IS, AND WHY IT IS NOT MORE TESTS.
//
// The platform side of this architecture is already covered: tests/design-locked.test.ts proves artifact
// versioning, approval, immutability, rollback and every delivery gate (DEL-04: an artifact that is not clean is
// never delivered). tests/scanner-clamav.test.ts proves the scanner against a real daemon. The runner's modules
// each have their own tests. What none of them do is run the WHOLE chain with the real components joined together,
// and that is the one thing the architecture has never been certified on:
//
//   artifact upload -> REAL ClamAV scan -> import and measure in a REAL sandbox with REAL Chromium ->
//   a person approves the baseline -> the runner claims the job over its REAL signed protocol ->
//   REAL Model B writes the backend -> three independent gates -> bounded repair -> evidence
//
// `scripts/builder-staging-e2e.ts` certifies the RETIRED autonomous design-generation builder. It has no concept of
// a design lock, a baseline or an artifact, and its last run predates this architecture entirely. This is its
// replacement for the new one, not an extension of it.
//
// WHAT IS REAL HERE. The platform routes (src/app/app.ts handle) on an in-memory database with the real migrations;
// the real upload path, so the artifact gets a real `files` row at scan_status 'pending'; the real scanner code
// (scanner/src) against a real ClamAV daemon; the real sandbox (--network none, --read-only, --cap-drop ALL); the
// real browser instrument measuring three viewports; the real runner protocol, HMAC-signed, answered in-process by
// the Worker's own fetch handler; and the real local models on Node 1. Nothing here authors, reviews or repairs
// website code — runner/src/frontend does all of it.
//
// WHAT IS NOT REAL. There is no socket and no deployment: the control plane is in-process and the database is in
// memory. The project is seeded directly rather than bought, because provisioning from a purchase is certified
// elsewhere and is not what this is testing.
//
//   --stage scan      upload + REAL ClamAV + the refusal gates. No Docker, no models. Minutes.
//   --stage import    the above, then a REAL sandbox build and measurement, and an approved baseline. Needs Docker.
//   --stage full      the above, then REAL Model B writes the backend and the three gates judge it. Needs Ollama.
//
//   --fixture northgate-clinic | summit-haul   (an artifact directory may be given instead)
//
// Run it from OUTSIDE this repository — the runner's own isolation guard requires it:
//   cd C:\CrestmontRunner && node --no-warnings C:\Crestmont-Admin\scripts\design-locked-e2e.ts --stage full
//
// Exit 0 only when every check that RAN passed and nothing was skipped silently. A gate that could not be
// evaluated is reported as "undetermined" and fails the run: a check that did not happen is not a check that
// passed.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";

// ── platform (real) ──────────────────────────────────────────────────────────────────────────────────────────
import { createTestApp, createStaff, createCustomer, MemoryStorage } from "../tests/support/app.ts";
import { handle } from "../src/app/app.ts";
import * as DL from "../src/services/design-locked.ts";
import * as BW from "../src/services/build-workers.ts";
import { newId } from "../src/lib/db.ts";

// ── scanner (real) ───────────────────────────────────────────────────────────────────────────────────────────
import { platform as scannerPlatform } from "../scanner/src/platform.ts";
import { Scanner } from "../scanner/src/scanner.ts";
import { ping } from "../scanner/src/clamd.ts";

// ── runner (real) ────────────────────────────────────────────────────────────────────────────────────────────
import { loadConfig } from "../runner/src/config.ts";
import { ControlPlaneClient } from "../runner/src/control-plane.ts";
import { createLogger } from "../runner/src/log.ts";
import { capabilities } from "../runner/src/main.ts";
import { assertIsolation, createWorkspace } from "../runner/src/workspace.ts";
import { JobSandbox, cliDockerExecutor } from "../runner/src/sandbox.ts";
import { importFrontend } from "../runner/src/frontend/workflow.ts";
import { runDesignLockedJob, writeEvidence, MAX_REPAIR_CYCLES } from "../runner/src/frontend/design-locked-job.ts";
import { draftAndSubmitContract, CONTRACT_ATTEMPTS } from "../runner/src/frontend/contract-author.ts";
import { contractAuthorFor } from "../runner/src/main.ts";
import { collectSnapshot } from "../runner/src/orchestrator/snapshot.ts";
import { initRepo } from "../runner/src/git.ts";
import { LocalProvider } from "../runner/src/providers/local.ts";
import { RunTracker, StopSwitch } from "../runner/src/agent.ts";
import { validateManifest, completeness, describeContract } from "../runner/src/frontend/integration-manifest.ts";
import type { IntegrationManifest, ManifestContract } from "../runner/src/frontend/integration-manifest.ts";
import { zipDirectory, makeZip } from "../runner/test/fixtures/zip-writer.ts";

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const STAGE = opt("--stage", "scan") as "scan" | "import" | "full";
if (!["scan", "import", "full"].includes(STAGE)) { console.error(`--stage must be scan, import or full`); process.exit(2); }

const FIXTURES: Record<string, string> = {
  // A: one inert quote form. B: accounts, roles and two dashboards. C: a filtered collection, a multi-step
  // reservation and a two-sided message thread. Deliberately unalike, so a baseline comparison is not measuring
  // the same shapes three times.
  "summit-haul": "summit-haul-frontend",
  "northgate-clinic": "northgate-clinic-frontend",
  "riverbend-library": "riverbend-library-frontend",
};
const fixtureArg = opt("--fixture", "northgate-clinic");
const FIXTURE = path.isAbsolute(fixtureArg)
  ? fixtureArg
  : path.resolve(import.meta.dirname, "../runner/test/fixtures", FIXTURES[fixtureArg] ?? fixtureArg);
// A frontend is a package.json OR an HTML document. It used to be package.json alone, which quietly excluded the
// shape the Founder actually uploads -- one self-contained .html file, no manifest, no build -- so the static
// path was never once exercised end to end by this script. That is the same path whose rebuild was broken.
const hasPackage = existsSync(path.join(FIXTURE, "package.json"));
const hasHtml = existsSync(FIXTURE) && readdirSync(FIXTURE).some((n) => /[.]html?$/i.test(n));
if (!hasPackage && !hasHtml) {
  console.error(`no frontend artifact at ${FIXTURE}: expected a package.json or at least one .html document`);
  process.exit(2);
}

const CLAMD_PORT = Number(opt("--clamd-port", process.env.CLAMD_TEST_PORT ?? "3310"));
const MAX_TURNS = Number(opt("--turns", "60"));
const MAX_MINUTES = Number(opt("--minutes", "45"));
const OUT = path.resolve(opt("--out", path.join(process.cwd(), "design-locked-e2e", "evidence")));
const WORK = path.resolve(opt("--work", path.join(tmpdir(), "crestmont-design-locked-e2e")));

const BASE = "http://crestmont.test";
const RUNNER_SECRET = randomBytes(32).toString("hex");
const SCANNER_SECRET = randomBytes(24).toString("hex");
// The standard harmless antivirus test signature, assembled so the repository never holds it verbatim.
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");

mkdirSync(OUT, { recursive: true });
const log = (...a: unknown[]) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
const rule = (s: string) => console.log(`\n${"=".repeat(96)}\n${s}\n${"=".repeat(96)}`);

// ── the check ledger ─────────────────────────────────────────────────────────────────────────────────────────
//
// Three outcomes, not two. "undetermined" is for a check that could not be evaluated — the daemon was not there,
// the model produced no verifier — and it fails the run just as a failure does, because the directive's rule is
// that nothing may be claimed to have passed unless it actually ran and passed.
type Outcome = "pass" | "fail" | "undetermined";
const ledger: { id: string; outcome: Outcome; detail: string }[] = [];

function check(id: string, outcome: Outcome, detail: string): boolean {
  ledger.push({ id, outcome, detail });
  const mark = outcome === "pass" ? "PASS" : outcome === "fail" ? "FAIL" : "UNDETERMINED";
  console.log(`  [${mark}] ${id} — ${detail}`);
  if (outcome === "fail") console.log(`::error title=${id}::${detail}`);
  if (outcome === "undetermined") console.log(`::error title=${id} undetermined::${detail}`);
  return outcome === "pass";
}
const expect = (id: string, cond: boolean, pass: string, fail: string) => check(id, cond ? "pass" : "fail", cond ? pass : fail);

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function main(): Promise<number> {
  rule(`Design-locked builder E2E — stage "${STAGE}", artifact ${path.basename(FIXTURE)}`);

  // ── 1. the real platform, and a project to attach a frontend to ────────────────────────────────────────────
  const t = await createTestApp({
    BUILD_RUNNER_SECRET: RUNNER_SECRET,
    FILE_SCANNER_SECRET: SCANNER_SECRET,
    overrides: { storage: new MemoryStorage() },
  } as never);
  const owner = await createStaff(t.db, "owner", "owner@crestmont.test");
  const customer = await createCustomer(t.db, "practice@northgatedental.test", "Northgate Dental");

  const seedProject = async (name: string) => {
    const id = newId("prj");
    const at = new Date().toISOString();
    await t.db.prepare(
      `INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at)
       VALUES (?, ?, ?, 'development', 2, 'upfront', ?, ?)`,
    ).bind(id, customer.organizationId, name, at, at).run();
    return id;
  };
  const projectId = await seedProject("Northgate Dental website");
  log(`platform ready: project ${projectId}, owner ${owner.id}`);

  const staff = t.client();
  await staff.login("owner@crestmont.test");

  // ── 2. the artifact is uploaded through the real staff route ───────────────────────────────────────────────
  rule("1. the approved frontend is uploaded");
  // zipDirectory's own default skip is the right one and is anchored with (^|/), so it also excludes a TOP-LEVEL
  // node_modules. An override of the form /[\\/](node_modules|...)/ silently does not, because the paths it tests
  // are relative: the first run of this script shipped an 18 MB artifact with the installed tree inside it.
  const archive = zipDirectory(FIXTURE);
  log(`artifact: ${archive.length} bytes, sha256 ${sha256(archive).slice(0, 16)}…`);

  const upRes = await staff.post(`/staff/builds/frontends/${projectId}/artifact`, {
    artifact: new File([new Uint8Array(archive)], "frontend.zip", { type: "application/zip" }),
  });
  expect("UPLOAD-ACCEPTED", upRes.status === 303 || upRes.status === 302,
    `the staff route accepted the artifact (${upRes.status})`,
    `the upload was refused: ${upRes.status} ${(await upRes.clone().text()).slice(0, 300)}`);

  const artifact = await DL.latestArtifact(t.db, projectId);
  if (!artifact) { check("UPLOAD-RECORDED", "fail", "no frontend_artifacts row was written"); return finish(1); }
  expect("UPLOAD-RECORDED", artifact.sha256 === sha256(archive),
    `recorded as v${artifact.version}, framework ${artifact.framework ?? "unknown"}, sha matches the bytes uploaded`,
    `the recorded sha256 ${artifact.sha256.slice(0, 16)} is not the uploaded bytes' ${sha256(archive).slice(0, 16)}`);
  expect("UPLOAD-QUARANTINED", artifact.scan_status === "pending",
    "the artifact starts quarantined at scan_status 'pending'",
    `expected 'pending', got '${artifact.scan_status}'`);

  // The gate that matters before anything is scanned: there is nothing to deliver to a build.
  const noBaseline = await DL.deliverApprovedArtifact(t.db, (t.env as never as { overrides: { storage: unknown } }).overrides.storage as never,
    { id: "bld_probe", project_id: projectId, organization_id: customer.organizationId })
    .then(() => null).catch((e: Error) => e);
  expect("GATE-NO-BASELINE", noBaseline instanceof Error,
    "with no approved baseline the runner is given nothing",
    "an unapproved, unscanned artifact was delivered to a build");

  // ── 3. a REAL ClamAV daemon scans it ──────────────────────────────────────────────────────────────────────
  rule("2. a real ClamAV daemon scans the artifact");
  const clamd = { host: "127.0.0.1", port: CLAMD_PORT, timeoutMs: 180_000 };
  let daemonUp = false;
  try { daemonUp = await ping(clamd); } catch { daemonUp = false; }

  if (!daemonUp) {
    check("SCAN-CLEAN", "undetermined", `no ClamAV daemon answered on 127.0.0.1:${CLAMD_PORT}. Start it with scanner/docker-compose.yml, or pass --clamd-port. Nothing was scanned, so nothing may be called clean.`);
    return finish(1);
  }

  const appFetch = (async (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input as RequestInfo, init), t.env)) as unknown as typeof fetch;
  const scanApi = scannerPlatform({ url: BASE, secret: SCANNER_SECRET, timeoutMs: 60_000, fetch: appFetch, retryDelaysMs: [0, 0] });
  const scanner = new Scanner({ scannerId: "design-locked-e2e", batch: 20, maxBytes: 26_214_400, clamd }, scanApi);

  // An infected artifact on a project of its own, so proving the refusal cannot disturb the chain under test.
  const infectedProject = await seedProject("Infected upload (refusal proof)");
  const infectedZip = makeZip([
    { path: "package.json", body: JSON.stringify({ name: "x", private: true }) },
    { path: "index.html", body: "<!doctype html><html><body></body></html>" },
    { path: "src/notes.txt", body: EICAR },
  ]);
  await staff.post(`/staff/builds/frontends/${infectedProject}/artifact`, {
    artifact: new File([new Uint8Array(infectedZip)], "infected.zip", { type: "application/zip" }),
  });

  const cycle = await scanner.cycle();
  expect("SCAN-RAN", cycle.error === null && cycle.scanned >= 2,
    `the scanner reported ${cycle.scanned} verdict(s) from ${cycle.engine}: ${cycle.clean} clean, ${cycle.infected} infected, ${cycle.failed} failed`,
    `the scan cycle did not complete: ${cycle.error ?? `only ${cycle.scanned} verdict(s)`}`);

  const scanned = await DL.getArtifact(t.db, artifact.id);
  expect("SCAN-CLEAN", scanned?.scan_status === "clean",
    `the genuine artifact was confirmed clean by ${cycle.engine}`,
    `expected 'clean', got '${scanned?.scan_status}'`);

  const infectedArtifact = await DL.latestArtifact(t.db, infectedProject);
  expect("SCAN-INFECTED", infectedArtifact?.scan_status === "infected",
    "the artifact carrying the EICAR signature was quarantined as infected",
    `expected 'infected', got '${infectedArtifact?.scan_status}'`);

  const infectedDelivery = await DL.deliverApprovedArtifact(t.db, (t.env as never as { overrides: { storage: unknown } }).overrides.storage as never,
    { id: "bld_probe2", project_id: infectedProject, organization_id: customer.organizationId })
    .then(() => null).catch((e: Error) => e);
  expect("GATE-INFECTED", infectedDelivery instanceof Error,
    "an infected artifact can never reach backend generation",
    "an infected artifact was delivered to a build");

  // §13's quarantine state, which nothing used to enter: the project must say why it will never progress, not sit
  // in `validating_artifact` looking as though a scan were still pending.
  const infectedState = await DL.frontendState(t.db, infectedProject);
  expect("STATE-QUARANTINED", infectedState.state === "artifact_quarantined",
    "the infected upload moved its project to artifact_quarantined",
    `expected 'artifact_quarantined', got '${infectedState.state}'`);
  const cleanState = await DL.frontendState(t.db, projectId);
  expect("STATE-NOT-REGRESSED", cleanState.state !== "artifact_quarantined",
    `the clean artifact's project is in '${cleanState.state}', not quarantined`,
    "a clean artifact quarantined its own project");

  if (STAGE === "scan") return finish(ledger.some((l) => l.outcome !== "pass") ? 1 : 0);

  // ── 4. the runner imports and MEASURES the approved frontend in a real sandbox ─────────────────────────────
  rule("3. the frontend is built and measured in a real sandbox");

  process.env.RUNNER_WORKSPACES = process.env.RUNNER_WORKSPACES ?? path.join(WORK, "workspaces");
  process.env.CONTROL_PLANE_URL = BASE;
  process.env.BUILD_RUNNER_SECRET = RUNNER_SECRET;
  process.env.RUNNER_AGENT_PROVIDER = "local";
  process.env.RUNNER_ID = process.env.RUNNER_ID ?? "node1-design-locked-e2e";
  process.env.LOCAL_MODEL_BASE_URL = process.env.LOCAL_MODEL_BASE_URL ?? "http://127.0.0.1:11434/v1";
  process.env.LOCAL_MODEL_A = process.env.LOCAL_MODEL_A ?? "qwen3.8:27b-q4_K_M";
  process.env.LOCAL_MODEL_A_VISION = process.env.LOCAL_MODEL_A_VISION ?? "true";
  process.env.LOCAL_MODEL_B = process.env.LOCAL_MODEL_B ?? "qwen3.6:35b-a3b-q4_K_M";
  process.env.LOCAL_MODEL_B_VISION = process.env.LOCAL_MODEL_B_VISION ?? "true";
  // Mirrors compose/runner.env on Node 1, which is what the real runner runs with. The first run of this harness
  // omitted it and fell back to 32768: with a seven-page artifact and a seven-operation contract, Model B spent
  // its whole budget re-reading files after each context reset — 28 resets, 661k input tokens, nothing written.
  // Under-configuring the window does not test the model, it tests the window.
  process.env.LOCAL_MODEL_CONTEXT_TOKENS = process.env.LOCAL_MODEL_CONTEXT_TOKENS ?? "131072";
  // Mirrors runner.env on Node 1. The skills directory is required configuration even for a stage that only
  // builds and measures, because loadConfig validates the whole configuration at once.
  process.env.SKILLS_SOURCE_DIR = process.env.SKILLS_SOURCE_DIR ?? "C:\\CrestmontRunner\\skills";
  // Mirrors runner.env on Node 1 too, and this line used not to: it defaulted to a side tag,
  // `crestmont-build-sandbox:1-frontend-import`, that only this harness ever used. The measurement instrument was
  // in that image and NOT in `crestmont-build-sandbox:1`, which is the only image the installer installs and the
  // runner runs, so this harness passed while every real import on Node 1 died inside the sandbox with
  // `Cannot find module '/opt/crestmont/frontend-import.mjs'`. A harness that mirrors the node must mirror the
  // image; a one-off tag can still be given through the environment for an experiment.
  process.env.RUNNER_SANDBOX_IMAGE = process.env.RUNNER_SANDBOX_IMAGE ?? "crestmont-build-sandbox:1";
  process.env.RUNNER_INSTALL_NETWORK = process.env.RUNNER_INSTALL_NETWORK ?? "crestmont_install";
  delete process.env.RUNNER_SANDBOX_VOLUME;

  const cfg = loadConfig(process.env);
  await assertIsolation({ cwd: process.cwd(), workspacesRoot: cfg.workspacesRoot, platformRepoPatterns: cfg.platformRepoPatterns, pathEnv: cfg.agentPath });
  const logger = createLogger({ level: cfg.logLevel, base: { runnerId: cfg.runnerId } });

  const dockerEnvOnly: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) dockerEnvOnly[k] = v;
  const executor = cliDockerExecutor(cfg.jobSandbox.dockerBin, dockerEnvOnly);

  // The worker and the signed control-plane client are created HERE, before the import, because acquiring the
  // design's external assets is a control-plane call: the measurement container has no network, so the platform
  // fetches each permitted asset and the runner pins the bytes it is given. This used to sit after the claim, so
  // the import had no resolver, no asset was ever attempted, and a law firm design whose typography and four
  // photographs come from CDNs was measured in a fallback face with no images -- and approved, because the
  // approval gate only refuses assets it has a REFUSED row for and there were no rows at all.
  const worker = await BW.registerWorker({ db: t.db, userId: owner.id }, { label: "Node 1 (design-locked-e2e)", maxActiveProjects: 1 });
  const client = new ControlPlaneClient({
    baseUrl: BASE, secret: RUNNER_SECRET, runnerId: cfg.runnerId, fetchImpl: appFetch, logger,
    worker: { id: worker.id, key: worker.enrollmentKey },
  });

  // ONE resolver for the import AND the build, which is the whole point of pinning.
  //
  // The platform fetches a permitted asset once, during ingestion, and stores the bytes. Everything afterwards
  // asks for those same bytes: the measurement that becomes the approved baseline, Model B's workspace, and the
  // visual gate that compares the two. Giving the import a resolver and the BUILD none is what produced a visual
  // failure that named its own cause -- approved b2dd67f23666 against measured 5eaa292fbefd, which is this very
  // artifact's fingerprint WITHOUT its fonts and photographs. The gate was comparing unlike with unlike and
  // blaming the model for it.
  const resolveArtifactAssets = async (refs: readonly { url: string; kind: string; referencedBy?: string | null }[]) => {
    const out: { url: string; kind: string; status: string; why?: string | null; base64?: string | null; localPath?: string | null; contentType?: string | null }[] = [];
    for (let i = 0; i < refs.length; i += 10) {
      const answer = await client.resolveFrontendAssets({
        artifactId: artifact.id,
        assets: refs.slice(i, i + 10).map((r) => ({ url: r.url, kind: r.kind, referencedBy: r.referencedBy })),
      });
      if (!answer) break;
      out.push(...(answer.assets as typeof out));
    }
    return out as never;
  };
  const pre = await JobSandbox.preflight(cfg.jobSandbox, executor);
  if (pre.length) { check("SANDBOX-READY", "undetermined", `the sandbox is not usable: ${pre.join("; ")}`); return finish(1); }
  check("SANDBOX-READY", "pass", `sandbox image ${cfg.jobSandbox.image} is usable`);

  const importWs = createWorkspace(path.join(WORK, "import"), { id: "bld_dl_e2e_import", attempt: 1 });
  const importSandbox = new JobSandbox(cfg.jobSandbox, importWs, "bld_dl_e2e_import", executor, logger);
  let imported;
  try {
    imported = await importFrontend({
      archive, source: "customer-upload", repo: importWs.repo, sandbox: importSandbox,
      // The same resolver runner/src/job.ts gives the real build, pointed at this artifact.
      resolveAssets: resolveArtifactAssets,
      approvedBy: owner.id,
      // The real scan verdict from above, not an assumption: an 'upload' source requires a clean scan.
      scan: { status: "clean", scannedAt: new Date().toISOString(), engine: cycle.engine ?? "ClamAV", fileId: artifact.file_id },
      // No manifest here, deliberately. A plan must be written against the design that was actually measured, and
      // that fingerprint does not exist until this step produces it — so an import freezes the baseline first and
      // the contract is checked against it below. Passing the fixture's plan here failed exactly as it should:
      // "the plan was written against design 000000000000… but the approved baseline is 8d8ab93a300e…".
      buildTimeoutMs: 600_000, measureTimeoutMs: 600_000,
    });
  } finally {
    await importSandbox.close().catch(() => {});
  }

  if (!imported.ok || !imported.baseline || !imported.report) {
    check("IMPORT-MEASURED", "fail", `the import stopped at ${imported.failedAt ?? "an unknown step"}: ${imported.problems.join("; ").slice(0, 600)}`);
    return finish(1);
  }
  const baseline = imported.baseline;
  check("IMPORT-MEASURED", "pass",
    `${imported.report.routes.length} route(s), ${imported.report.interactions.length} interaction(s), ${baseline.signatures.length} signature(s); design fingerprint ${baseline.fingerprint.slice(0, 16)}…`);

  // THE DESIGN'S EXTERNAL VISUAL DEPENDENCIES (release-critical). A design whose typography and photographs come
  // from CDNs must be measured WITH them: the measurement container has no network, so the platform fetches each
  // permitted asset under its SSRF rules and the runner pins the bytes into the artifact. Nothing asserted this
  // before, and with no resolver wired the law firm artifact measured in a fallback face with no images -- and was
  // approved, because the approval gate only refuses assets it holds a REFUSED row for and there were none.
  const pin = imported.assets;
  if (!pin || !pin.assets.length) {
    check("ASSETS-ACQUIRED", "pass", "this design references no external assets: everything it needs is inside the archive");
  } else {
    const pinned = pin.assets.filter((a) => a.status === "pinned");
    const kb = Math.round(pinned.reduce((n, a) => n + (a.bytes ?? 0), 0) / 1024);
    expect("ASSETS-ACQUIRED", pin.missing.length === 0,
      `${pinned.length} of ${pin.assets.length} external asset(s) acquired and pinned into the artifact (${kb} KB, ${pin.rounds} round(s), ${pin.rewritten.length} file(s) rewritten), so the design is measured with them`,
      `${pin.missing.length} visual dependenc(ies) could not be acquired, so this baseline is materially incomplete: ` + pin.missing.map((m) => `${m.kind} ${m.url}: ${m.why}`).join("; "));
    check("ASSETS-KINDS", "pass", pin.assets.map((a) => `${a.kind} ${a.status} ${a.url.slice(0, 70)}`).join(" | ").slice(0, 900));
  }

  const needsBackend = imported.report.interactions.filter((i) => i.needsBackend).length;
  const undetermined = imported.report.interactions.filter((i) => i.undetermined === true).length;
  check("IMPORT-INVENTORY", needsBackend > 0 ? "pass" : "fail",
    `${needsBackend} interaction(s) need a backend, ${undetermined} undetermined — the inert forms were found`);

  // ── 5. a person approves the baseline ─────────────────────────────────────────────────────────────────────
  rule("4. a person approves the design");
  const draft = await DL.recordBaseline(t.db, artifact.id, {
    fingerprint: baseline.fingerprint,
    sourceFingerprint: baseline.sourceFingerprint,
    signatures: baseline.signatures as never[],
    screenshots: (baseline as never as { renders?: unknown[] }).renders ?? baseline.signatures as never[],
    routes: imported.report.routes as never[],
    interactions: imported.report.interactions as never[],
  });
  const approveRes = await staff.post(`/staff/builds/frontends/${projectId}/baselines/${draft.id}/approve`, { note: "design-locked E2E" });
  expect("APPROVAL-IS-A-PERSON", approveRes.status === 303 || approveRes.status === 302,
    `the owner approved baseline v${draft.version} through the staff route (${approveRes.status})`,
    `approval was refused: ${approveRes.status} ${(await approveRes.clone().text()).slice(0, 300)}`);

  const state = await DL.frontendState(t.db, projectId);
  expect("DESIGN-LOCKED", state.designLocked && !!state.activeBaselineId,
    `the project is design-locked on baseline ${state.activeBaselineId}`,
    `the project is not design-locked: ${JSON.stringify(state)}`);

  const allowed = await DL.designGenerationAllowed(t.db, projectId);
  expect("GATE-NO-AUTONOMOUS-DESIGN", allowed.allowed === false,
    `the retired autonomous design phase is refused: ${allowed.reason}`,
    "a design-locked project was allowed to generate its own design");

  // The manifest is a contract, and it is checked before any model is asked to satisfy it.
  // ── MODEL A WRITES THE CONTRACT ───────────────────────────────────────────────────────────────────────────
  //
  // The architecture is that Model A determines the backend requirements from the MEASURED design, the platform
  // validates that draft independently, and only then does Model B implement against it. This script used to read
  // a hand-written contract from beside the fixture, so the automatic authoring path -- the thing a customer
  // upload actually depends on -- was never exercised here, and an artifact with no fixture contract (which is
  // every real upload) could not be run at all.
  //
  // The validator is the platform's own, over the real signed channel, and it refuses a draft whose criteria
  // nothing can check. That refusal is fed back as corrections, up to CONTRACT_ATTEMPTS times.
  let manifest: IntegrationManifest & ManifestContract;
  const fixtureContract = path.join(FIXTURE, "integration-manifest.json");

  if (existsSync(fixtureContract)) {
    manifest = JSON.parse(readFileSync(fixtureContract, "utf8"));
    manifest.designFingerprint = baseline.fingerprint;
    manifest.artifactSha = artifact.sha256;
    const validated = validateManifest(manifest, { approvedPages: imported.report.routes.map((r) => r.page), designFingerprint: baseline.fingerprint, artifactSha: artifact.sha256 });
    expect("MANIFEST-VALID", validated.ok,
      `the fixture contract validates against the measured pages: ${manifest.operations.length} operation(s)`,
      `the fixture contract is not a valid contract: ${JSON.stringify(validated.problems).slice(0, 600)}`);
    check("CONTRACT-AUTHOR", "pass", "a fixture contract was supplied, so Model A was not asked to draft one");
  } else {
    const author = contractAuthorFor(cfg, null, logger)(importWs.repo);
    const drafted = await draftAndSubmitContract({
      author,
      input: {
        projectId, artifactSha: artifact.sha256, designFingerprint: baseline.fingerprint,
        routes: imported.report.routes, interactions: imported.report.interactions,
      },
      attempts: CONTRACT_ATTEMPTS,
      onAttempt: (r) => log(`the platform's validator refused the draft (attempt ${r.attempt}): ${r.problems.slice(0, 3).join(" | ").slice(0, 400)}`),
      submit: async (r) => (await client.submitFrontendContract({
        projectId, manifest: r.manifest, attempt: r.attempt, attemptsAllowed: r.attemptsAllowed,
        authorModel: cfg.models.mode === "dual" ? cfg.models.a.tag : cfg.local.model,
      })) ?? { recorded: false, problems: [] },
    });

    expect("CONTRACT-AUTHOR", drafted.recorded,
      `Model A drafted a contract the platform's own validator accepted, on attempt ${drafted.attempts} of ${CONTRACT_ATTEMPTS}`,
      `Model A could not produce a contract the validator would accept in ${drafted.attempts} attempt(s): ${drafted.problems.slice(0, 5).join(" | ").slice(0, 700)}`);
    if (!drafted.recorded) return finish(1);

    const recorded = await DL.activeContract(t.db, projectId);
    if (!recorded) { check("MANIFEST-VALID", "fail", "the platform reported the contract recorded but none is active"); return finish(1); }
    manifest = JSON.parse(recorded.manifest_json) as IntegrationManifest & ManifestContract;
    const probes = manifest.operations.reduce((n, op) => n + (op.acceptanceProbes ?? []).length, 0);
    const criteria = manifest.operations.reduce((n, op) => n + op.acceptance.length, 0);
    check("MANIFEST-VALID", "pass",
      `the contract Model A wrote was validated independently and recorded: ${manifest.operations.length} operation(s), ${criteria} acceptance criteria, ${probes} executable probe(s)`);
    writeFileSync(path.join(OUT, "model-a-contract.json"), JSON.stringify(manifest, null, 2));
  }
  const complete = completeness(manifest);
  expect("MANIFEST-COMPLETE", complete.ok,
    `every operation has what it needs; ${complete.missing.length} recorded gap(s)`,
    `the contract is incomplete: ${JSON.stringify(complete.blockers).slice(0, 400)}`);
  writeFileSync(path.join(OUT, "contract.txt"), describeContract(manifest));

  if (STAGE === "import") return finish(ledger.some((l) => l.outcome !== "pass") ? 1 : 0);

  // ── 6. the runner claims the job over its real signed protocol ────────────────────────────────────────────
  rule("5. the runner claims the build, and the platform hands it the approved design");
  const jobId = newId("bld");
  const at = new Date().toISOString();
  await t.db.prepare(
    `INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, strategy, package_id,
       trigger, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'first_build', 0, ?, 'queued', 'standard', 'business', 'payment', ?, ?, ?)`,
  ).bind(jobId, projectId, customer.organizationId, `first:${projectId}`, owner.id, at, at).run();
  const applied = await DL.applyDesignLock(t.db, jobId, projectId);
  expect("JOB-IS-DESIGN-LOCKED", applied.applied,
    `the queued build is a design-locked build (phase ${applied.phase}, baseline ${applied.baselineId})`,
    `the build was not marked design-locked: ${JSON.stringify(applied)}`);

  const claimed = await client.claim(capabilities(cfg));
  if (!claimed.job) { check("RUNNER-CLAIMED", "fail", `the runner claimed nothing: ${JSON.stringify(claimed).slice(0, 300)}`); return finish(1); }
  expect("RUNNER-CLAIMED", claimed.job.id === jobId && !!claimed.job.designLocked,
    `claimed ${claimed.job.id} carrying designLocked baseline ${claimed.job.designLocked?.fingerprint.slice(0, 12)}…`,
    `the claimed job is not a design-locked build: ${JSON.stringify({ id: claimed.job.id, designLocked: claimed.job.designLocked }).slice(0, 300)}`);

  writeFileSync(path.join(OUT, "claimed-job.json"), JSON.stringify(claimed.job, null, 2));

  // ── 7. Model B writes the backend, and three gates judge it ───────────────────────────────────────────────
  rule("6. Model B writes the backend against the frozen design");
  const buildWs = createWorkspace(cfg.workspacesRoot, { id: claimed.job.id, attempt: claimed.job.attempt });
  const buildSandbox = new JobSandbox(cfg.jobSandbox, buildWs, claimed.job.id, executor, logger);

  // The real runner initialises a repository in the build workspace (runner/src/job.ts), so this does too. It
  // holds no commits in either place -- the design-locked path never makes one -- and the difference that matters
  // is that git commands behave the same here as they do in production rather than failing differently.
  await initRepo({ repo: buildWs.repo, pathEnv: cfg.agentPath, home: buildWs.home },
    { name: cfg.gitAuthorName, email: cfg.gitAuthorEmail }, "main");
  const provider = new LocalProvider({ cfg, executor, log: logger });
  const tracker = new RunTracker();
  const stop = new StopSwitch();

  log(`model: ${cfg.models.mode === "dual" ? cfg.models.b.tag : cfg.local.model} at ${cfg.local.baseUrl}`);
  log(`budget: ${MAX_TURNS} turns, ${MAX_MINUTES} minutes, up to ${MAX_REPAIR_CYCLES} repair cycle(s)`);

  // The tracker buffers activity rather than pushing it; drain it on a timer so a long run is watchable.
  const ticker = setInterval(() => {
    for (const a of tracker.drainActivity()) console.log(`  · ${String((a as { message?: string }).message ?? "").slice(0, 160)}`);
  }, 10_000);

  let dl;
  const started = Date.now();
  try {
    await provider.prepare({ job: claimed.job, ws: buildWs, skillNames: [], referenceDomains: [], processEnv: process.env, systemPromptAppend: "" });
    dl = await runDesignLockedJob({
      job: claimed.job, ws: buildWs, sandbox: buildSandbox, provider, tracker, stop, log: logger,
      // The real signed delivery, exactly as runner/src/job.ts does it: the artifact comes back over the
      // control-plane channel and the runner checks its hash before opening it.
      fetchArtifact: () => client.approvedArtifact(claimed.job!),
      // The assets the APPROVED design was measured with, restored from the platform's own records so the
      // build renders the identical bytes and the visual gate compares like with like.
      resolveAssets: resolveArtifactAssets,
      manifest,
      maxTurns: MAX_TURNS,
      maxWallMs: MAX_MINUTES * 60_000,
    });
  } finally {
    clearInterval(ticker);
    for (const a of tracker.drainActivity()) console.log(`  · ${String((a as { message?: string }).message ?? "").slice(0, 160)}`);
    await buildSandbox.close().catch(() => {});
    await provider.close?.().catch(() => {});
  }
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  log(`Model B finished after ${minutes} minute(s) and ${dl.cycles.length} cycle(s)`);

  const evidencePath = writeEvidence(buildWs, dl);
  writeFileSync(path.join(OUT, "design-locked-result.json"), JSON.stringify(dl, null, 2));
  log(`runner evidence: ${evidencePath}`);

  check("MODEL-B-RAN", dl.cycles.length > 0 ? "pass" : "undetermined",
    dl.cycles.length > 0
      ? `${dl.cycles.length} cycle(s) ran; the model produced ${dl.cycles.reduce((n, c) => n + c.changedFiles, 0)} file change(s) in total`
      : `no cycle ran, so nothing was built: ${dl.problems.join("; ").slice(0, 400)}`);

  // The three gates, reported separately and honestly. "ran: false" is undetermined, never a pass: the whole
  // point of the architecture is that Model B does not certify its own work, so a gate that did not execute
  // tells us nothing about whether the work is good.
  const last = dl.cycles[dl.cycles.length - 1];
  if (!last) {
    check("GATE-CONFORMANCE", "undetermined", "no cycle to judge");
    check("GATE-FUNCTIONAL", "undetermined", "no cycle to judge");
    check("GATE-VISUAL", "undetermined", "no cycle to judge");
  } else {
    check("GATE-CONFORMANCE", last.conformance.ok ? "pass" : "fail",
      last.conformance.ok ? "the implementation matches the contract" : `contract violations: ${last.conformance.violations.join("; ").slice(0, 500)}`);
    check("GATE-FUNCTIONAL", !last.functional.ran ? "undetermined" : last.functional.ok ? "pass" : "fail",
      last.functional.ran ? last.functional.detail.slice(0, 500) : `the functional gate did not run, so nothing about the backend working has been established: ${last.functional.detail.slice(0, 300)}`);
    check("GATE-VISUAL", !last.visual.ran ? "undetermined" : last.visual.ok ? "pass" : "fail",
      last.visual.ran ? last.visual.detail.slice(0, 500) : `the visual gate did not run, so design fidelity is unverified: ${last.visual.detail.slice(0, 300)}`);
  }

  expect("REPAIR-BOUNDED", dl.cycles.length <= MAX_REPAIR_CYCLES + 1,
    `repair stayed within its limit: ${dl.cycles.length} of at most ${MAX_REPAIR_CYCLES + 1} cycle(s)`,
    `repair ran ${dl.cycles.length} cycles, beyond the ${MAX_REPAIR_CYCLES} allowed`);

  // Whatever the model did, the approved design must still be the approved design.
  const heldBaseline = await DL.getBaseline(t.db, state.activeBaselineId!);
  expect("BASELINE-IMMUTABLE", heldBaseline?.fingerprint === baseline.fingerprint,
    "the approved baseline is unchanged after the build",
    `the approved baseline moved: ${heldBaseline?.fingerprint?.slice(0, 16)} is not ${baseline.fingerprint.slice(0, 16)}`);

  check("BUILD-VERDICT", dl.ok ? "pass" : "fail",
    dl.ok ? `all three gates passed: ${dl.summary.slice(0, 400)}`
          : `the build did not pass its gates (stopped at ${dl.failedAt ?? "verification"}): ${dl.problems.join("; ").slice(0, 500)}`);


  // ── 8. the finished website reaches the customer who bought it ────────────────────────────────────────────
  //
  // Everything above proves a website was BUILT. The requirement is that a customer can OPEN it, and this script
  // has never gone that far: it called runDesignLockedJob directly and never told the platform the outcome, so no
  // revision was stored, the job never reached ready_for_review, and delivery -- which needs both -- was
  // unreachable. The two calls below are the same two signed endpoints runner/src/job.ts ends in, so the platform
  // learns about this build exactly as it would in production.
  rule("7. the finished website reaches the customer who bought it");

  if (!dl.ok) {
    check("DELIVER-REACHED", "undetermined",
      `the build did not pass its gates, so there is no finished website to deliver: ${dl.problems.join("; ").slice(0, 300)}`);
    return finish(1);
  }

  // The site is where the BUILD serves it from, not where the retired starter used to put it: the repo root for
  // a static document, dist for a bundled project. With the default this collected nothing and the platform
  // refused the revision as an empty file list.
  const siteRoot = dl.outputRoot ?? "";
  const snap = collectSnapshot(buildWs.repo, siteRoot);
  const storedRev = await client.storeRevision(claimed.job, {
    cycle: dl.cycles.length, phase: "final", commit: null, isBest: true, files: snap.files,
  });
  expect("DELIVER-REVISION-STORED", storedRev.stored > 0,
    `the finished website is stored as a revision: ${storedRev.stored} file(s), ${Math.round(snap.bytes / 1024)} KB`,
    `no website snapshot was stored, so there is nothing a customer could be shown: ${JSON.stringify(storedRev).slice(0, 200)}`);

  await client.complete(claimed.job, {
    outcome: "ready_for_review", runCostUsd: 0, turns: 0, sessionId: "design-locked-e2e",
    sourceRepo: "", sourceBranch: "", sourceCommit: "", previewUrl: null,
    report: dl.summary.slice(0, 2000),
  });
  const jobState = await t.db.prepare(`SELECT state FROM build_jobs WHERE id = ?`).bind(jobId).first<{ state: string }>();
  expect("DELIVER-READY-FOR-REVIEW", jobState?.state === "ready_for_review",
    `the build reached a real ready_for_review state over the signed channel`,
    `the build is in "${jobState?.state ?? "(missing)"}", not ready_for_review, so it is not a finished deliverable`);

  // An EXISTING purchased project of an EXISTING customer -- the website is assigned to it, never a new project.
  const buyer = await createCustomer(t.db, "owner@riverbendlaw.test", "Riverbend Law");
  const stranger = await createCustomer(t.db, "hello@unrelated.test", "Unrelated Ltd");
  const seedFor = async (orgId: string, name: string) => {
    const id = newId("prj");
    const at = new Date().toISOString();
    await t.db.prepare(
      `INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at)
       VALUES (?, ?, ?, 'development', 2, 'upfront', ?, ?)`,
    ).bind(id, orgId, name, at, at).run();
    return id;
  };
  const buyerProject = await seedFor(buyer.organizationId, "Riverbend Law website (purchased)");
  const strangerProject = await seedFor(stranger.organizationId, "Unrelated Ltd website");
  const projectsBefore = await t.db.prepare(`SELECT COUNT(*) AS n FROM projects`).first<{ n: number }>();

  const assignRes = await staff.post(`/staff/builds/${jobId}/deliver`, { projectId: buyerProject });
  expect("DELIVER-ASSIGNED", assignRes.status === 303 || assignRes.status === 302,
    `the staff route assigned the finished website to the existing project ${buyerProject} (${assignRes.status})`,
    `the assignment was refused: ${assignRes.status} ${(await assignRes.clone().text()).slice(0, 300)}`);

  const delivery = await t.db.prepare(
    `SELECT id, project_id, organization_id, status, visible_at FROM website_deliveries WHERE job_id = ? AND superseded_at IS NULL`,
  ).bind(jobId).first<{ id: string; project_id: string; organization_id: string; status: string; visible_at: string | null }>();
  expect("DELIVER-ON-RIGHT-PROJECT",
    !!delivery && delivery.project_id === buyerProject && delivery.organization_id === buyer.organizationId,
    `the delivery is recorded against the buyer's project and organisation`,
    `the delivery row is wrong: ${JSON.stringify(delivery)}`);

  const projectsAfter = await t.db.prepare(`SELECT COUNT(*) AS n FROM projects`).first<{ n: number }>();
  expect("DELIVER-NO-DUPLICATE-PROJECT", Number(projectsAfter?.n) === Number(projectsBefore?.n),
    `no project was created by delivering: still ${projectsAfter?.n}`,
    `delivery created ${Number(projectsAfter?.n) - Number(projectsBefore?.n)} project(s); it must assign to the existing one`);

  // Visibility is its own decision, so it is its own request.
  expect("DELIVER-NOT-YET-VISIBLE", !delivery?.visible_at,
    `assigning did not by itself show the website to the customer`,
    `the customer could see it the moment it was assigned, which is not a decision anybody made`);
  const visRes = await staff.post(`/staff/builds/${jobId}/deliver/${delivery?.id}/visible`, {});
  expect("DELIVER-MADE-VISIBLE", visRes.status === 303 || visRes.status === 302,
    `a second, separate decision made it visible to the customer (${visRes.status})`,
    `making it visible failed: ${visRes.status} ${(await visRes.clone().text()).slice(0, 300)}`);

  // ── the customer's own portal ─────────────────────────────────────────────────────────────────────────────
  const buyerClient = t.client();
  await buyerClient.login(buyer.email);
  const portal = await buyerClient.get(`/portal/projects/${buyerProject}`);
  const portalHtml = await portal.text();
  const hasPreview = portalHtml.includes("/build-preview/");
  expect("PORTAL-SHOWS-WEBSITE", portal.status === 200 && hasPreview,
    `the buyer's portal page offers the finished website`,
    `the portal did not show a website (${portal.status}): ${portalHtml.slice(0, 300)}`);

  // Not a screenshot, not a mock-up, not a localhost address: the real stored site, served and read back.
  const previewAt = portalHtml.indexOf("/build-preview/");
  let previewPath = "";
  if (previewAt >= 0) {
    const rest = portalHtml.slice(previewAt);
    const stop = rest.search(/["'\s>]/);
    previewPath = (stop > 0 ? rest.slice(0, stop) : rest).split("&amp;").join("&");
  }
  const served = previewPath ? await buyerClient.get(previewPath) : null;
  const servedBody = served ? await served.text() : "";
  expect("PORTAL-SERVES-REAL-WEBSITE", !!served && served.status === 200 && /<html/i.test(servedBody),
    `the portal's own link serves the real stored website (${served?.status}, ${servedBody.length} bytes from ${previewPath.slice(0, 60)})`,
    `the portal link did not serve a working website: ${served?.status ?? "no link found"} ${servedBody.slice(0, 200)}`);
  expect("PORTAL-IS-THE-APPROVED-DESIGN", /northgate/i.test(servedBody),
    `the served website is the approved frontend, not a placeholder`,
    `the served page does not look like the approved design: ${servedBody.slice(0, 300)}`);

  // And nobody else's.
  const strangerClient = t.client();
  await strangerClient.login(stranger.email);
  const theirOwn = await strangerClient.get(`/portal/projects/${strangerProject}`);
  const theirOwnHtml = await theirOwn.text();
  expect("PORTAL-ISOLATED-OWN-PAGE", theirOwn.status === 200 && !theirOwnHtml.includes("/build-preview/"),
    `an unrelated customer's own project shows no website`,
    `an unrelated customer was offered a website on their own project: ${theirOwnHtml.slice(0, 300)}`);
  const crossRead = await strangerClient.get(`/portal/projects/${buyerProject}`);
  expect("PORTAL-ISOLATED-CROSS-READ", crossRead.status === 403 || crossRead.status === 404,
    `an unrelated customer cannot open the buyer's project at all (${crossRead.status})`,
    `an unrelated customer could read the buyer's project: ${crossRead.status}`);

  writeFileSync(path.join(OUT, "delivery.json"), JSON.stringify({
    jobId, buyerProject, buyerOrganization: buyer.organizationId, deliveryId: delivery?.id,
    revision: { attempt: claimed.job.attempt, cycle: dl.cycles.length, files: storedRev.stored },
    previewPath, servedBytes: servedBody.length,
  }, null, 2));

  return finish(ledger.some((l) => l.outcome !== "pass") ? 1 : 0);
}

function finish(code: number): number {
  const counts = { pass: 0, fail: 0, undetermined: 0 };
  for (const l of ledger) counts[l.outcome]++;
  rule(`${counts.pass} passed, ${counts.fail} failed, ${counts.undetermined} undetermined`);
  for (const l of ledger) if (l.outcome !== "pass") console.log(`  ${l.outcome.toUpperCase()}  ${l.id}: ${l.detail}`);
  writeFileSync(path.join(OUT, "design-locked-e2e.json"), JSON.stringify({
    stage: STAGE, fixture: path.basename(FIXTURE), at: new Date().toISOString(), counts, checks: ledger,
  }, null, 2));
  console.log(`\nevidence: ${path.join(OUT, "design-locked-e2e.json")}`);
  // Undetermined fails the run: a check that did not happen is not a check that passed.
  return counts.fail || counts.undetermined ? 1 : code;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(String((e as Error)?.stack ?? e)); process.exit(2); });
