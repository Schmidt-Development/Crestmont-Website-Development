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
import { CONTRACT_ATTEMPTS, draftAndSubmitContract, type ContractAuthor } from "./contract-author.ts";
import type { ImportInteraction, ImportRoute } from "./import.ts";

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
  /**
   * Drafts the integration contract for the design this import measured, in a fresh Model A session with
   * read-only tools over the unpacked artifact.
   *
   * Null when this runner cannot plan -- no local model, or the paid adapter, whose model is not ours. The import
   * then does exactly what it did before: it reports the measured design and leaves the contract to a person.
   * Taking `repo` rather than closing over one keeps the session pointed at THIS claim's workspace.
   */
  contractAuthor?: ((repo: string) => ContractAuthor) | null;
  /** The model tag that drafts it, recorded on the contract as provenance. A tag, never a prompt. */
  authorModel?: string | null;
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

/**
 * The platform's own reason out of a refusal body, for the artifact's verdict.
 *
 * The body is JSON `{"error":"..."}` from the Worker; anything else is passed through, bounded. The point is that
 * the Founder reads what the platform objected to, not an HTTP status.
 */
function refusalReason(e: ControlPlaneError): string {
  try {
    const j = JSON.parse(e.body) as { error?: unknown };
    if (typeof j.error === "string" && j.error.trim()) return j.error.slice(0, 300);
  } catch { /* not JSON */ }
  return (e.body || e.message).slice(0, 300);
}

/**
 * Draft the integration contract for a design the platform has just approved, and submit it.
 *
 * Separate from `serve()` because it is a separate job with its own failure modes, none of which may reach the
 * import's own outcome: by the time this runs the measured design is recorded and approved, and nothing here is
 * allowed to turn that into a rejection. Every exit is a log line and a return.
 */
async function authorTheContract(
  d: ImportWorkerDeps,
  m: {
    projectId: string;
    artifactSha: string;
    designFingerprint: string;
    /** The platform's own answer: a build is waiting for a contract. */
    awaiting: boolean;
    repo: string;
    routes: readonly ImportRoute[];
    interactions: readonly ImportInteraction[];
  },
  log: (msg: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  // Not waiting for one: either this platform predates the contract channel, or a contract for this exact design
  // is already recorded. Both mean there is nothing to draft.
  if (!m.awaiting) return;
  if (!d.contractAuthor) {
    log("the platform is waiting for an integration contract and this runner cannot draft one (no local planning model); leaving it for a person");
    return;
  }
  if (!m.routes.length) {
    log("no measured pages came back with the import, so there is nothing to write a contract about");
    return;
  }

  const author = d.contractAuthor(m.repo);
  try {
    const result = await draftAndSubmitContract({
      author,
      input: {
        projectId: m.projectId, artifactSha: m.artifactSha, designFingerprint: m.designFingerprint,
        routes: m.routes, interactions: m.interactions,
      },
      attempts: CONTRACT_ATTEMPTS,
      onAttempt: (r) => d.logger.warn("the platform's validator refused the drafted contract; correcting it", {
        projectId: m.projectId, attempt: r.attempt, of: CONTRACT_ATTEMPTS, problems: r.problems.slice(0, 5),
      }),
      submit: async (r) => {
        const answer = await d.client.submitFrontendContract({
          projectId: m.projectId, manifest: r.manifest, attempt: r.attempt, attemptsAllowed: r.attemptsAllowed,
          authorModel: d.authorModel ?? null,
        });
        // A platform with no contract channel is not a refusal of the draft. Reported as recorded:false with no
        // problems, which stops the loop rather than redrafting against nothing.
        return answer ?? { recorded: false, problems: [] };
      },
    });

    if (result.recorded) {
      log("integration contract drafted and accepted", {
        projectId: m.projectId, attempts: result.attempts, version: result.submission?.version ?? null,
        queued: result.submission?.queued ?? null,
        queueRefusal: result.submission?.queueRefusal ?? null,
        reviewFlags: (result.submission?.reviewFlags ?? []).map((f) => f.what).slice(0, 5),
      });
      return;
    }
    d.logger.warn("no integration contract could be drafted that the platform would accept; the design stays approved and the project waits for a person", {
      projectId: m.projectId, attempts: result.attempts, problems: result.problems.slice(0, 5),
    });
  } catch (err) {
    // Authoring is the only thing that failed. The import's outcome is already recorded, so this is a warning and
    // nothing else; the project waits for a contract exactly as it does when a draft is refused.
    d.logger.warn("the integration contract could not be drafted", {
      projectId: m.projectId, error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
  }
}

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

      // Every sandbox this import starts, closed in the `finally` below however it ends.
      const sandboxesToClose: JobSandbox[] = [];
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

        // Directly under the work root, NOT in a per-artifact subdirectory.
        //
        // A workspace ref is one path segment under the workspaces root, and `JobSandbox` relies on exactly that:
        // when the runner itself runs in a container it mounts `volume-subpath=<ref>/repo` on the shared
        // workspaces volume. Nesting the workspace one level deeper left that mount pointing at a path that does
        // not exist, so every import on a containerised runner died at
        //
        //   cannot access path /var/lib/docker/volumes/crestmont-workspaces/_data/<ref>/repo: no such file
        //
        // which the worker correctly treated as an infrastructure fault and retried for ever, leaving a created
        // container behind on each attempt. The artifact id is folded into the job id instead, so the ref is
        // still one per claim and still says what it is.
        const ws = createWorkspace(d.workRoot, { id: `import-${claim.artifactId}`, attempt: 1 });
        const executor = d.executor ?? cliDockerExecutor(d.cfg.jobSandbox.dockerBin, dockerEnv());
        const sandbox = new JobSandbox(d.cfg.jobSandbox, ws, claim.artifactId, executor, d.logger);
        // Closed however this ends. Nothing closed it before, and a sandbox is started detached: thirteen of them
        // were left running on Node 1, each holding its 6-CPU and 8 GB caps, one per import since the channel
        // started working. The build path closes its own through the provider; the import lane had no such owner.
        sandboxesToClose.push(sandbox);

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

        let reported: Awaited<ReturnType<typeof d.client.reportFrontendImport>> = null;
        try {
          reported = await d.client.reportFrontendImport({
            artifactId: claim.artifactId,
            status: "imported",
            framework: outcome.ingest?.framework ?? null,
            archiveRoot: outcome.ingest?.archiveRoot ?? null,
            problems: outcome.problems.slice(0, 20),
            baseline: outcome.baseline,
            // The same measurement's inventory. Without it the platform records a design with zero routes and
            // zero interactions and the Artifact Builder screen says so, which is wrong about a measured frontend.
            // Each array is read defensively. A missing one would throw here, inside the reporting path, and a
            // throw there loses the import entirely: nothing is reported, the lease expires and the whole
            // measurement runs again. Evidence this good is not worth risking on a shape assumption.
            measurement: outcome.report
              ? {
                routes: outcome.report.routes ?? [],
                interactions: outcome.report.interactions ?? [],
                states: (outcome.report.states ?? []).map((x) => ({ page: x.page, viewport: x.viewport, state: x.state, sha: x.sha })),
                viewports: [...new Set((outcome.report.renders ?? []).map((x) => x.viewport))],
              }
              : null,
          });
        } catch (err) {
          // A 4xx on this report is the platform REFUSING what was measured, not a fault in reaching it. The
          // measured design it would not take is the only one this import produced, so sending it again cannot
          // work: retrying leaves the artifact looping on the lease for ever and holding the import lane, which
          // is what happened to three artifacts on Node 1 whose baseline carried no screenshot.
          //
          // So it becomes the artifact's verdict, in the platform's own words. A 5xx, a timeout or a network
          // error is still infrastructure and still falls through to the outer catch, which reports nothing.
          const status = err instanceof ControlPlaneError ? err.status : 0;
          if (status < 400 || status >= 500) throw err;
          const why = refusalReason(err as ControlPlaneError);
          await d.client.reportFrontendImport({
            artifactId: claim.artifactId,
            status: "rejected",
            problems: [`the platform would not accept the measured design: ${why}`, ...outcome.problems.slice(0, 19)],
          });
          d.logger.warn("the platform refused the measured design; reported as the artifact's verdict rather than retried", {
            artifactId: claim.artifactId, status, why,
          });
          return "done";
        }
        log("frontend artifact imported and measured", {
          fingerprint: outcome.baseline.fingerprint.slice(0, 12),
          pages: outcome.report?.routes.length ?? 0,
          framework: outcome.ingest?.framework ?? null,
        });

        // The contract. The platform has recorded and approved the measured design and told us whether a build
        // can be queued yet: `awaitingContract` means it cannot, because a design-locked build is judged against
        // an integration contract and stops at once without one.
        //
        // So the draft is written here, in this claim, while the measurement and the unpacked artifact are both
        // still in hand -- the two things the draft has to be written from. Everything that decides whether it is
        // ACCEPTED happens on the platform: this sends a draft and reads the verdict.
        //
        // A failure to produce an accepted contract is not the artifact's verdict. The design is measured and
        // approved either way; what is missing is the plan, and the project waits visibly with the validator's
        // reasons in the audit log rather than being rejected or retried for ever.
        await authorTheContract(d, {
          projectId: reported?.projectId ?? claim.projectId,
          artifactSha: claim.sha256,
          designFingerprint: reported?.designFingerprint ?? outcome.baseline.fingerprint,
          awaiting: reported?.awaitingContract === true,
          repo: ws.repo,
          routes: outcome.report?.routes ?? [],
          interactions: outcome.report?.interactions ?? [],
        }, log);
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
      } finally {
        // A failure to close is logged, not thrown: the import's own outcome has already been decided and
        // reported, and losing it to a cleanup error would be the wrong trade. The startup reaper is the backstop.
        for (const sandbox of sandboxesToClose) {
          try { await sandbox.close(); }
          catch (err) {
            d.logger.warn("the import sandbox could not be closed; it is left for the startup reaper", {
              artifactId: claim.artifactId, error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
            });
          }
        }
      }
    },
  };
}
