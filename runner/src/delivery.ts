// Customer production delivery (Founder decision D5, 2026-10-28).
//
// The runner deploys a release only after the Owner explicitly authorized it on the platform. It deploys the
// project's committed source from the versioned project repository (never the agent's live workspace), as a clean
// export with a runner-generated Wrangler config, to that customer's own Worker (cm-site-*) on the customer-hosting
// account, with credentials that exist only in this process (never in the agent, the build sandbox or the site's
// code). It then verifies the live site serves exactly the released index page and reports evidence.
//
// Guarantees enforced here (in addition to the platform's authorization, tenant and version checks):
//  - Worker names must match cm-site-*: never a preview (cm-prv-*), never Crestmont's own Worker.
//  - The source repository must be this project's own repository on the configured host and owner.
//  - The checked-out commit must be the one the Owner authorized.
//  - The site's config may not add routes, bindings or build commands; only an Owner-authorized hostname is attached.
//  - Production credentials are separate variables (and values) from the preview credentials (config.ts).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunnerConfig } from "./config.ts";
import { readSecret } from "./config.ts";
import type { DeploymentCompleteRequest, DeploymentVerification, SiteDeployment } from "./protocol.ts";
import { run, proxyEnv } from "./exec.ts";
import { cloneProjectRepo, headCommit, projectRepoUrl, type GitCtx } from "./git.ts";
import { previewConfigProblems } from "./checks.ts";
import { readSiteConfig } from "./preview-gate.ts";
import { stripForPreview } from "./job.ts";
import type { Logger } from "./log.ts";
import { errorMessage } from "./log.ts";

export const SITE_WORKER = /^cm-site-[a-z0-9][a-z0-9-]{1,55}$/;
export const SITE_HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

/** The generated production config: the site's own settings, its Worker name, and (only if authorized) its domain. */
export function planSiteRelease(exportDir: string, workerName: string, hostname: string | null): { config: Record<string, unknown> | null; indexFile: string | null; problems: string[] } {
  if (!SITE_WORKER.test(workerName) || /crestmont/i.test(workerName)) return { config: null, indexFile: null, problems: [`refused: ${workerName} is not a customer site Worker name`] };
  if (hostname !== null && (!SITE_HOSTNAME.test(hostname) || /(^|\.)(crestmont[a-z0-9-]*\.[a-z.]+|workers\.dev|pages\.dev)$/i.test(hostname))) return { config: null, indexFile: null, problems: [`refused: ${hostname} is not an authorizable customer hostname`] };
  const { site, problems } = readSiteConfig(exportDir);
  if (!site) return { config: null, indexFile: null, problems };
  const config: Record<string, unknown> = {
    name: workerName,
    ...(site.main ? { main: site.main } : {}),
    compatibility_date: site.compatibilityDate,
    ...(site.compatibilityFlags.length ? { compatibility_flags: site.compatibilityFlags } : {}),
    workers_dev: true,
    preview_urls: false,
    ...(site.assets ? { assets: { ...site.assets, ...(site.workerFirst !== false ? { run_worker_first: site.workerFirst } : {}) } } : {}),
    ...(Object.keys(site.vars).length ? { vars: site.vars } : {}),
    ...(hostname ? { routes: [{ pattern: hostname, custom_domain: true }] } : {}),
  };
  const indexFile = site.assets ? path.join(exportDir, site.assets.directory, "index.html") : null;
  return { config, indexFile: indexFile && existsSync(indexFile) ? indexFile : null, problems: [] };
}

export interface DeliveryDeps {
  processEnv?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
  /** Fetch the release source (default: the project repository with the runner's repo token). Test seam. */
  clone?: (git: GitCtx, url: string, commit: string) => Promise<void>;
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** Deploy and verify one authorized release. Never throws: every outcome is reported to the platform. */
export async function runSiteDeployment(cfg: RunnerConfig, d: SiteDeployment, deps: DeliveryDeps): Promise<DeploymentCompleteRequest> {
  const base = { deploymentId: d.id, leaseToken: d.leaseToken };
  const failed = (error: string): DeploymentCompleteRequest => ({ ...base, result: "failed", deployedUrl: null, contentSha256: null, verification: null, error });
  if (!cfg.delivery || !cfg.repo) return failed("PRODUCTION_DEPLOY_COMMAND / project repositories are not configured on this runner");
  if (!SITE_WORKER.test(d.workerName) || /crestmont/i.test(d.workerName)) return failed(`refused: ${d.workerName} is not a customer site Worker name`);
  if (!COMMIT.test(d.sourceCommit)) return failed("refused: invalid source commit");
  const expectedRepo = projectRepoUrl(cfg.repo, d.projectId);
  if (d.sourceRepo !== expectedRepo) return failed(`refused: the release source is not this project's repository (${expectedRepo})`);
  const processEnv = deps.processEnv ?? process.env;
  const dir = mkdtempSync(path.join(cfg.workspacesRoot, `deploy-${d.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}-`));
  try {
    const repoDir = path.join(dir, "src"), home = path.join(dir, "home"), exportDir = path.join(dir, "release");
    for (const p of [repoDir, home, exportDir]) mkdirSync(p, { recursive: true });
    const git: GitCtx = { repo: repoDir, pathEnv: cfg.agentPath, home };
    try {
      if (deps.clone) await deps.clone(git, expectedRepo, d.sourceCommit);
      else await cloneProjectRepo(git, cfg.repo, expectedRepo, null, d.sourceCommit);
    } catch (err) { return failed(`could not fetch the release source: ${errorMessage(err).slice(0, 300)}`); }
    const head = await headCommit(git);
    if (!head || !head.startsWith(d.sourceCommit)) return failed(`refused: checked-out commit ${head ?? "none"} is not the authorized ${d.sourceCommit}`);
    const a = await run("git", ["archive", "--format=tar", "-o", "../release.tar", "HEAD"], { cwd: repoDir, env: { PATH: cfg.agentPath, HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, timeoutMs: 120_000 });
    if (a.code !== 0) return failed(`release export failed (git archive exit ${a.code})`);
    const x = await run("tar", ["-xf", "../release.tar", "--no-same-owner", "--no-same-permissions"], { cwd: exportDir, env: { PATH: cfg.agentPath }, timeoutMs: 120_000 });
    if (x.code !== 0) return failed(`release export failed (tar exit ${x.code})`);
    stripForPreview(exportDir, 0);
    const problems = previewConfigProblems(exportDir);
    const plan = planSiteRelease(exportDir, d.workerName, d.hostname);
    if (problems.length || !plan.config) return failed(`refused to deploy: ${[...problems, ...plan.problems].join("; ")}`);
    const expected = plan.indexFile ? sha256(readFileSync(plan.indexFile)) : null;
    for (const f of ["wrangler.json", "wrangler.jsonc", "wrangler.toml"]) rmSync(path.join(exportDir, f), { force: true });
    writeFileSync(path.join(exportDir, "wrangler.json"), JSON.stringify(plan.config, null, 2) + "\n");

    const env: Record<string, string> = {
      PATH: cfg.agentPath, HOME: home, LANG: "C.UTF-8", ...proxyEnv(processEnv),
      CRESTMONT_SITE_WORKER: d.workerName, CRESTMONT_DEPLOYMENT_ID: d.id, CRESTMONT_SITE_VERSION: String(d.version),
    };
    for (const n of cfg.delivery.envNames) { const v = readSecret(processEnv, n); if (v) env[n] = v; }
    const r = await run("sh", ["-c", cfg.delivery.command], { cwd: exportDir, env, timeoutMs: cfg.delivery.timeoutMs });
    if (r.code !== 0) {
      deps.logger.warn("production deploy command failed", { deploymentId: d.id, code: r.code });
      // A failed command may still have changed the live site (e.g. a timeout after upload): say so.
      return { ...failed(`deploy command failed (exit ${r.code}${r.timedOut ? ", timed out" : ""}); verify the live site before preparing another release`), result: r.timedOut ? "deployed" : "failed" };
    }
    const out = r.stdout + "\n" + r.stderr;
    const explicit = /^SITE_URL=(https:\/\/\S+)\s*$/m.exec(out);
    const workers = out.match(/https:\/\/[A-Za-z0-9.-]+\.workers\.dev\S*/g);
    const deployedUrl = explicit?.[1] ?? workers?.[workers.length - 1] ?? null;
    const verifyUrl = d.hostname ? `https://${d.hostname}/` : deployedUrl ? new URL("/", deployedUrl).href : null;
    const verification = await verify(verifyUrl, expected, cfg.delivery, deps);
    return { ...base, result: "deployed", deployedUrl, contentSha256: expected, verification, ...(verification.matched === false || !verification.httpStatus || verification.httpStatus >= 400 ? { error: "post-deployment verification failed" } : {}) };
  } catch (err) {
    return failed(`release failed: ${errorMessage(err).slice(0, 300)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function verify(url: string | null, expected: string | null, opts: { verifyAttempts: number; verifyDelayMs: number }, deps: DeliveryDeps): Promise<DeploymentVerification> {
  const v: DeploymentVerification = { url, httpStatus: null, expectedSha256: expected, actualSha256: null, matched: null, attempts: 0 };
  if (!url) return v;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  for (let i = 0; i < opts.verifyAttempts; i++) {
    if (i > 0) await sleep(opts.verifyDelayMs);
    v.attempts = i + 1;
    try {
      const res = await fetchImpl(url, { redirect: "follow", headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(20_000) });
      v.httpStatus = res.status;
      const body = new Uint8Array(await res.arrayBuffer());
      v.actualSha256 = sha256(body);
      v.matched = expected ? v.actualSha256 === expected : null;
      if (res.status === 200 && (v.matched === null || v.matched)) return v;
    } catch { v.httpStatus = null; }
  }
  if (expected && v.matched === null) v.matched = false;
  return v;
}

/** Idle work: claim at most one authorized release and run it. */
export async function serveOneDeployment(cfg: RunnerConfig, client: { claimDeployment(c: string[]): Promise<SiteDeployment | null | "unsupported">; completeDeployment(r: DeploymentCompleteRequest): Promise<unknown> }, capabilities: string[], deps: DeliveryDeps): Promise<"unsupported" | "none" | "done"> {
  const d = await client.claimDeployment(capabilities);
  if (d === "unsupported") return "unsupported";
  if (!d) return "none";
  deps.logger.info("customer release authorized; deploying", { deploymentId: d.id, worker: d.workerName, version: d.version });
  const result = await runSiteDeployment(cfg, d, deps);
  await client.completeDeployment(result);
  deps.logger.info("customer release reported", { deploymentId: d.id, result: result.result, verified: result.verification?.matched ?? null });
  return "done";
}
