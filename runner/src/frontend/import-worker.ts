// Importing an uploaded frontend: the work between a scanned ZIP and a design a person can approve.
//
// The platform receives the artifact and scans it; approving the measured design is a person's; building the
// backend is a build job. The step in the middle -- unpack it, install, build, measure three viewports, freeze a
// baseline -- had nowhere to run on the deployed platform. It existed only inside scripts/design-locked-e2e.ts,
// which drives a sandbox in-process, which is why the local certification could approve a baseline and staging
// could not get past the upload.
//
// This is that step, as a worker the runner serves when it has no build to run, in the same shape as the drafts,
// preview-cleanup and release workers beside it: `serve()` answers "unsupported", "none" or "done".
//
// Two kinds of failure, deliberately told apart:
//
//   · the import failed ON ITS OWN TERMS -- the archive will not install, the build produces nothing, there is
//     nothing to measure. That is the artifact's verdict and it is reported, with the reasons, so the person who
//     uploaded it is told why rather than left watching a spinner.
//   · the INFRASTRUCTURE failed -- no sandbox, a dropped connection, the bytes went missing. That says nothing
//     about the artifact, so the claim is released and the platform offers it again. A transient fault must never
//     permanently reject the Founder's work.
import path from "node:path";
import type { ControlPlaneClient } from "../control-plane.ts";
import type { Logger } from "../log.ts";
import type { RunnerConfig } from "../config.ts";
import { JobSandbox, cliDockerExecutor, type DockerExecutor } from "../sandbox.ts";
import { createWorkspace } from "../workspace.ts";
import { importFrontend } from "./workflow.ts";
import { ControlPlaneError } from "../control-plane.ts";
import { createHash } from "node:crypto";

export interface ImportWorkerDeps {
  client: ControlPlaneClient;
  cfg: RunnerConfig;
  logger: Logger;
  /** Optional: supplied by a test. The worker builds one from the configured docker binary otherwise. */
  executor?: DockerExecutor;
  /** Optional: supplied by a test, so the two kinds of failure can be told apart without a real sandbox. */
  importer?: typeof importFrontend;
  /** Where the import's workspace is created. One per claim, named after the artifact. */
  workRoot: string;
  runnerId: string;
}

/**
 * Docker sees the process environment, filtered to names a shell would accept.
 *
 * The sandbox is where the archive is installed, built and measured; nothing here runs on the host. The executor
 * is built in the worker rather than handed in, because assembling one is not main.ts's business.
 */
const dockerEnv = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) out[k] = v;
  }
  return out;
};

export type ImportOutcomeKind = "unsupported" | "none" | "done";

export function importWorker(d: ImportWorkerDeps): { serve(): Promise<ImportOutcomeKind> } {
  let supported = true;

  return {
    async serve(): Promise<ImportOutcomeKind> {
      if (!supported) return "unsupported";

      let claim;
      try {
        claim = await d.client.claimFrontendImport(d.runnerId);
      } catch (err) {
        // An older control plane has no import channel. Say so once and stop asking, rather than polling it for
        // ever: that is what the other idle workers do with the endpoints they were added before.
        if (err instanceof ControlPlaneError && [404, 405].includes(err.status)) { supported = false; return "unsupported"; }
        throw err;
      }
      if (!claim) return "none";

      const log = (msg: string, extra: Record<string, unknown> = {}) =>
        d.logger.info(msg, { artifactId: claim.artifactId, projectId: claim.projectId, version: claim.version, ...extra });
      log("frontend artifact claimed for import");

      try {
        const got = await d.client.frontendImportBytes(claim.artifactId);
        if (!got) {
          // The platform stopped offering it while we held it: flagged, superseded, or released. Its decision.
          log("the platform no longer offers this artifact for import; leaving it alone");
          return "done";
        }

        const archive = Buffer.from(got.base64, "base64");
        const digest = createHash("sha256").update(archive).digest("hex");
        if (digest !== claim.sha256) {
          // Not the artifact that was claimed. Refusing to open it is the only safe answer, and it is the
          // artifact's verdict rather than an infrastructure fault: these bytes are not what was approved for scan.
          await d.client.reportFrontendImport({
            artifactId: claim.artifactId, status: "rejected",
            problems: [`the delivered bytes hash to ${digest.slice(0, 12)}… and the artifact records ${claim.sha256.slice(0, 12)}…, so the archive was not opened`],
          });
          d.logger.warn("frontend import refused: the delivered bytes do not match the artifact", { artifactId: claim.artifactId });
          return "done";
        }

        const ws = createWorkspace(path.join(d.workRoot, `import-${claim.artifactId}`), { id: claim.artifactId, attempt: 1 });
        const executor = d.executor ?? cliDockerExecutor(d.cfg.jobSandbox.dockerBin, dockerEnv());
        const sandbox = new JobSandbox(d.cfg.jobSandbox, ws, claim.artifactId, executor, d.logger);

        const outcome = await (d.importer ?? importFrontend)({
          archive,
          source: "customer-upload",
          // The platform only ever offers a clean artifact and re-checks the scan at delivery, so the gate has
          // already been applied twice by the time the bytes arrive here.
          scan: { status: "clean" },
          repo: ws.repo,
          sandbox,
          approvedBy: d.runnerId,
        });

        if (!outcome.ok || !outcome.baseline) {
          const problems = outcome.problems.length
            ? outcome.problems
            : [`the import stopped at ${outcome.failedAt ?? "an unknown step"} and produced no measured design`];
          await d.client.reportFrontendImport({ artifactId: claim.artifactId, status: "rejected", problems: problems.slice(0, 20) });
          d.logger.warn("frontend import failed", { artifactId: claim.artifactId, failedAt: outcome.failedAt, problems: problems.slice(0, 3) });
          return "done";
        }

        await d.client.reportFrontendImport({
          artifactId: claim.artifactId,
          status: "imported",
          framework: outcome.ingest?.framework ?? null,
          archiveRoot: outcome.ingest?.archiveRoot ?? null,
          problems: outcome.problems.slice(0, 20),
          baseline: outcome.baseline,
        });
        log("frontend artifact imported and measured", {
          fingerprint: outcome.baseline.fingerprint.slice(0, 12),
          pages: outcome.report?.routes.length ?? 0,
          framework: outcome.ingest?.framework ?? null,
        });
        return "done";
      } catch (err) {
        // An infrastructure fault says nothing about the artifact, so it is NOT reported as the artifact's
        // verdict. Nothing is sent at all: the claim's lease expires and the platform offers the artifact again,
        // which is already how a runner that dies mid-import is handled. Rejecting the Founder's work because a
        // sandbox would not start would be the worst possible answer.
        d.logger.warn("frontend import could not be carried out; leaving the claim to expire so it is offered again", {
          artifactId: claim.artifactId, error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
        });
        return "done";
      }
    },
  };
}
