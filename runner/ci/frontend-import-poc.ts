// A real, end-to-end run of the design-locked import, against real Docker.
//
//   node --no-warnings runner/ci/frontend-import-poc.ts [--keep] [--stage baseline|verify|drift]
//
// Not a unit test. It zips the Summit Haul fixture, puts it through `importFrontend` exactly as the runner
// would, and reports what actually happened: the scan gate, the verdict, a real npm install through the registry
// proxy, a real Vite build with no network, a real Chromium measuring three viewports, and a frozen baseline.
//
// `--stage verify` then applies the backend integration and re-measures, which is the question the whole
// architecture exists to answer: did making the site work change how it looks?
// `--stage drift` deliberately restyles one colour, to show the lock is not vacuous.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JobSandbox, cliDockerExecutor } from "../src/sandbox.ts";
import type { JobSandboxConfig } from "../src/config.ts";
import { importFrontend, readBaseline, verifyDesignHeld } from "../src/frontend/workflow.ts";
import { describeOutcome } from "../src/frontend/workflow.ts";
import { describeImport, describeVerify, inventoryOf, readImportReport } from "../src/frontend/import.ts";
import { coverage, describeManifest, describeManifestProblems, validateManifest } from "../src/frontend/integration-manifest.ts";
import { zipDirectory } from "../test/fixtures/zip-writer.ts";
import type { Workspace } from "../src/workspace.ts";

const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const stage = arg("--stage", "baseline");
const keep = args.includes("--keep");

const FIXTURE = path.resolve(import.meta.dirname, "../test/fixtures/summit-haul-frontend");
const INTEGRATION = path.resolve(import.meta.dirname, "../test/fixtures/summit-haul-integration");
const WORK = path.resolve(arg("--work", path.join(tmpdir(), "crestmont-import-poc")));

/**
 * The environment handed to docker.
 *
 * Filtered on purpose: this Windows host has a variable literally named `3DVPATH`, and the runner's execution
 * policy refuses an environment containing a name that is not a valid identifier -- correctly, since that is how
 * odd names get smuggled into a child process. The policy is not loosened; the environment is cleaned.
 */
const dockerEnv = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) out[k] = v;
  }
  return out;
};

const log = (s: string) => console.log(s);
const rule = (s: string) => console.log(`\n${"=".repeat(78)}\n${s}\n${"=".repeat(78)}`);

function sandboxConfig(): JobSandboxConfig {
  const env = process.env;
  return {
    dockerBin: env.RUNNER_DOCKER_BIN ?? "docker",
    image: env.RUNNER_SANDBOX_IMAGE ?? "crestmont-build-sandbox:1",
    runnerId: "import-poc",
    volume: "",
    cpus: env.RUNNER_JOB_CPUS ?? "8",
    memory: env.RUNNER_JOB_MEMORY ?? "8g",
    pidsLimit: 512,
    tmpfsMb: 512,
    commandTimeoutMs: 600_000,
    installTimeoutMs: 900_000,
    installNetwork: env.RUNNER_INSTALL_NETWORK ?? "crestmont_install",
    installProxy: env.RUNNER_INSTALL_PROXY ?? "http://egress-proxy:3128",
    registry: env.RUNNER_NPM_REGISTRY ?? "https://registry.npmjs.org/",
    diskQuotaMb: 4096,
    uid: Number(env.RUNNER_JOB_UID ?? 10001),
    allowedBuildScripts: [],
    browserCheck: true,
  };
}

function workspace(dir: string): Workspace {
  const ws: Workspace = {
    dir,
    ref: path.basename(dir),
    home: path.join(dir, "home"),
    repo: path.join(dir, "repo"),
    tmp: path.join(dir, "tmp"),
    checkpoints: path.join(dir, "checkpoints"),
  };
  for (const d of [ws.home, ws.repo, ws.tmp, ws.checkpoints]) mkdirSync(d, { recursive: true });
  return ws;
}

/** The plan for Summit Haul, written against the frozen design. Filled in with the real fingerprints. */
function manifest(artifactSha: string, designFingerprint: string) {
  return {
    schema: "crestmont.integration-manifest/1",
    artifactSha,
    designFingerprint,
    operations: [
      {
        id: "quote-request-submit",
        page: "quote",
        element: "form#quote-request",
        kind: "form-submit",
        behaviour: "Persist a quote request and show the visitor a confirmation in the form's own style.",
        expectChange: "content",
        acceptance: [
          "a submitted request is stored as a row in quote_requests",
          "a request missing a required field is refused with 422 and nothing is stored",
          "a storage failure shows an error in the form rather than a false confirmation",
        ],
        dataModel: [{ table: "quote_requests", fields: ["name", "phone", "email", "postcode", "load_size", "details"] }],
      },
    ],
    outOfScope: ["No payment is taken. No email is sent. Nothing goes live without a person releasing it."],
  };
}

async function main() {
  if (!existsSync(FIXTURE)) throw new Error(`the fixture is missing: ${FIXTURE}`);

  rule(`stage: ${stage}`);
  const cfg = sandboxConfig();
  const pre = await JobSandbox.preflight(cfg, cliDockerExecutor(cfg.dockerBin, dockerEnv()));
  if (pre.length) {
    console.error(`cannot run: ${pre.join("; ")}`);
    process.exit(2);
  }
  log(`docker ready, image ${cfg.image}`);

  if (stage === "baseline") rmSync(WORK, { recursive: true, force: true });
  const ws = workspace(path.join(WORK, "ws"));
  const sandbox = new JobSandbox(cfg, ws, "import-poc", cliDockerExecutor(cfg.dockerBin, dockerEnv()));

  try {
    if (stage === "baseline") {
      // The Founder's archive, built from the fixture exactly as an upload would arrive: one top-level folder.
      const archive = zipDirectory(FIXTURE, { prefix: "summit-haul-frontend" });
      writeFileSync(path.join(WORK, "summit-haul-frontend.zip"), archive);
      log(`archive: ${(archive.length / 1024).toFixed(1)} KB`);

      const outcome = await importFrontend({
        archive,
        source: "internal-fixture",      // a repository fixture, NOT a customer upload: it skips the scan gate
        repo: ws.repo,
        sandbox,
        approvedBy: "Founder (proof of concept)",
      });

      rule("import outcome");
      log(describeOutcome(outcome));
      if (!outcome.ok) process.exit(1);

      // The plan is written against the fingerprints this run produced, then checked against the real baseline
      // and the real interaction inventory.
      const m = manifest(outcome.ingest!.artifactSha, outcome.baseline!.fingerprint);
      writeFileSync(path.join(WORK, "manifest.json"), JSON.stringify(m, null, 2));

      const approvedPages = [...new Set(outcome.report!.signatures.map((s) => s.page))];
      const checked = validateManifest(m, {
        approvedPages,
        designFingerprint: outcome.baseline!.fingerprint,
        artifactSha: outcome.ingest!.artifactSha,
      });
      rule("the integration plan, checked against the real import");
      log(checked.ok ? "the plan validates against this artifact and this design" : describeManifestProblems(checked.problems));
      if (!checked.ok) process.exit(1);

      const cov = coverage(checked.manifest!, inventoryOf(outcome.report!));
      log(describeManifest(checked.manifest!, cov));
      if (cov.uncovered.length) {
        console.error("the plan leaves an interaction needing a backend uncovered");
        process.exit(1);
      }

      cpSync(path.join(ws.repo, ".crestmont"), path.join(WORK, "baseline-evidence"), { recursive: true });
      log(`\nbaseline and screenshots kept at ${path.join(WORK, "baseline-evidence")}`);
      log(`workspace kept at ${ws.repo}`);
      return;
    }

    // ── verify / drift ────────────────────────────────────────────────────────────────────────────────────────
    const baseline = readBaseline(ws.repo);
    if (!baseline) throw new Error(`no baseline in ${ws.repo}; run with --stage baseline first`);
    log(`baseline ${baseline.fingerprint.slice(0, 16)}… approved by ${baseline.approvedBy}, ${baseline.signatures.length} page views`);

    const before = readImportReport(path.join(ws.repo, ".crestmont/import"));

    if (stage === "drift") {
      // One colour, changed. Nothing else. This is the smallest possible restyle.
      const css = path.join(ws.repo, "src/styles.css");
      const body = readFileSync(css, "utf8").replace("--amber: #d98324;", "--amber: #007aff;");
      writeFileSync(css, body);
      log("changed one CSS custom property: --amber #d98324 -> #007aff");
    } else {
      if (!existsSync(INTEGRATION)) throw new Error(`the integration overlay is missing: ${INTEGRATION}`);
      cpSync(INTEGRATION, ws.repo, { recursive: true });
      log(`applied the backend integration from ${INTEGRATION}`);
    }

    const rebuilt = await sandbox.argv(["npm", "run", "build"], 300_000, "npm run build");
    if (rebuilt.code !== 0) throw new Error(`rebuild failed: ${(rebuilt.stderr || rebuilt.stdout).slice(0, 600)}`);
    log("rebuilt");

    const m = JSON.parse(readFileSync(path.join(WORK, "manifest.json"), "utf8"));
    const v = await verifyDesignHeld({
      repo: ws.repo, sandbox, outputRoot: "dist",
      manifest: stage === "verify" ? m : undefined,
      before,
      out: `.crestmont/import-${stage}`,
    });

    rule(`design check after ${stage === "drift" ? "a deliberate restyle" : "the backend integration"}`);
    if (v.report) log(describeImport(v.report));
    log("");
    log(v.verify ? describeVerify(v.verify) : v.problems.join("\n"));
    log("");
    log(v.ok ? "RESULT: the approved design held." : "RESULT: the approved design did NOT hold.");

    // The drift stage is supposed to fail; the verify stage is supposed to pass.
    const expected = stage === "drift" ? false : true;
    if (v.ok !== expected) {
      console.error(`\nUNEXPECTED: stage ${stage} expected ok=${expected}, got ok=${v.ok}`);
      process.exit(1);
    }
    log(`as expected for stage ${stage}.`);
  } finally {
    await sandbox.close().catch(() => {});
    if (!keep && stage !== "baseline") log(`\n(workspace left at ${WORK} for inspection)`);
  }
}

main().catch((e) => { console.error(String((e as Error)?.stack ?? e)); process.exit(2); });
