// Founder decision D5 (2026-10-28): customer production delivery, runner side. Controlled fixtures only: the deploy
// command is a local stand-in for `wrangler deploy` and the "live site" is a fake fetch. Nothing is deployed anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { planSiteRelease, runSiteDeployment, serveOneDeployment } from "../src/delivery.ts";
import { loadConfig } from "../src/config.ts";
import { run } from "../src/exec.ts";
import type { GitCtx } from "../src/git.ts";
import type { SiteDeployment } from "../src/protocol.ts";
import { silentLogger } from "../src/log.ts";
import { makeConfig, tmp, POLLUTED_ENV, SECRET } from "./helpers.ts";

const STARTER = path.join(import.meta.dirname, "..", "starters", "brochure-v1");
const REPO = { owner: "crestmont-builds", ownerType: "org" as const, token: "github_pat_test_repo_token_000000", host: "github.com", apiBase: "https://api.github.com", prefix: "crestmont-build-" };
const PROJECT = "prj_alpha1";
const REPO_URL = `https://github.com/crestmont-builds/crestmont-build-prj_alpha1.git`;

async function sourceRepo(): Promise<{ dir: string; commit: string }> {
  const dir = tmp("aib-rel-src-");
  cpSync(STARTER, dir, { recursive: true });
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" };
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-qm", "site"]]) assert.equal((await run("git", args, { cwd: dir, env })).code, 0, args.join(" "));
  return { dir, commit: (await run("git", ["rev-parse", "HEAD"], { cwd: dir, env })).stdout.trim() };
}

/** Local stand-in for fetching the project repository (same checkout steps, from a local directory). */
const localClone = (src: string) => async (git: GitCtx, url: string, commit: string) => {
  assert.equal(url, REPO_URL);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: git.home, GIT_CONFIG_NOSYSTEM: "1" };
  for (const args of [["init", "-q"], ["fetch", "-q", src, "+refs/heads/*:refs/remotes/origin/*"], ["checkout", "-q", "-B", "main", commit]]) {
    const r = await run("git", args, { cwd: git.repo, env });
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  }
};

function deployment(over: Partial<SiteDeployment> = {}): SiteDeployment {
  return { id: "sd_test1", leaseToken: "a".repeat(64), kind: "release", version: 3, projectId: PROJECT, workerName: "cm-site-prj-alpha1", hostname: "www.harbor.example", sourceRepo: REPO_URL, sourceCommit: "0".repeat(40), ...over };
}

// Stands in for `wrangler deploy`: records what it was given; the dump path arrives through PRODUCTION_DEPLOY_ENV.
const DEPLOY_CMD = `node -e "const fs=require('fs');fs.writeFileSync(process.env.PROD_TEST_DUMP,JSON.stringify({env:process.env,cwd:process.cwd(),files:fs.readdirSync('.'),config:JSON.parse(fs.readFileSync('wrangler.json','utf8'))}));console.log('Uploaded');console.log('SITE_URL=https://'+process.env.CRESTMONT_SITE_WORKER+'.hosting.workers.dev')"`;

test("[AIB-006] D5: the release config is the site's own, under its customer Worker name; a domain is attached only when authorized; previews, Crestmont and shared domains are refused", () => {
  const dir = tmp("aib-rel-plan-");
  cpSync(STARTER, dir, { recursive: true });
  const p = planSiteRelease(dir, "cm-site-prj-alpha1", "www.harbor.example");
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.config, {
    name: "cm-site-prj-alpha1", main: "src/worker.js", compatibility_date: "2025-09-01", workers_dev: true, preview_urls: false,
    assets: { directory: "./public", binding: "ASSETS", not_found_handling: "404-page", run_worker_first: ["/api/*"] },
    vars: { CONTACT_MAIL_PROVIDER: "" }, routes: [{ pattern: "www.harbor.example", custom_domain: true }],
  });
  assert.ok(p.indexFile?.endsWith(path.join("public", "index.html")));
  assert.ok(!("routes" in planSiteRelease(dir, "cm-site-prj-alpha1", null).config!), "no domain unless authorized");
  for (const name of ["cm-prv-prj-alpha1-b0", "crestmont-website", "cm-site-crestmont-main", "CM-SITE-X"]) assert.match(planSiteRelease(dir, name, null).problems.join(), /not a customer site Worker name/, name);
  for (const host of ["app.crestmontwebsites.com", "x.acct.workers.dev", "x.pages.dev", "localhost", "bad host.example"]) assert.match(planSiteRelease(dir, "cm-site-a1", host).problems.join(), /not an authorizable customer hostname/, host);
  // The site may not add bindings the customer target was not set up with.
  writeFileSync(path.join(dir, "wrangler.jsonc"), `{ "main": "src/worker.js", "kv_namespaces": [{ "binding": "X" }] }`);
  assert.match(planSiteRelease(dir, "cm-site-a1", null).problems.join(), /kv_namespaces/);
});

test("[AIB-006] D5: the runner deploys the authorized commit of the project's own repository with production credentials only it holds, then verifies the live content", async () => {
  const src = await sourceRepo();
  const dump = path.join(tmp("aib-rel-dump-"), "dump.json");
  const cfg = makeConfig({ controlPlaneUrl: "http://127.0.0.1:9", skillsSourceDir: "x", repo: REPO, delivery: { command: DEPLOY_CMD, envNames: ["SITE_CF_TOKEN", "PROD_TEST_DUMP"], timeoutMs: 30_000, verifyAttempts: 3, verifyDelayMs: 0 } });
  const index = readFileSync(path.join(STARTER, "public", "index.html"));
  const fetched: string[] = [];
  let served: Uint8Array = index;
  const fetchImpl = (async (u: string) => { fetched.push(String(u)); return new Response(served, { status: 200 }); }) as unknown as typeof fetch;
  const env = { ...POLLUTED_ENV, SITE_CF_TOKEN: "site-hosting-token-0000000000", PROD_TEST_DUMP: dump };
  const r = await runSiteDeployment(cfg, deployment({ sourceCommit: src.commit }), { logger: silentLogger, processEnv: env, fetchImpl, clone: localClone(src.dir), sleep: async () => {} });
  assert.equal(r.result, "deployed", String(r.error));
  assert.equal(r.error, undefined);
  assert.equal(r.deployedUrl, "https://cm-site-prj-alpha1.hosting.workers.dev");
  const sha = createHash("sha256").update(index).digest("hex");
  assert.equal(r.contentSha256, sha);
  assert.deepEqual(r.verification, { url: "https://www.harbor.example/", httpStatus: 200, expectedSha256: sha, actualSha256: sha, matched: true, attempts: 1 });
  const seen = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string>; cwd: string; files: string[]; config: Record<string, unknown> };
  assert.equal(seen.env.SITE_CF_TOKEN, "site-hosting-token-0000000000", "the deploy command gets the customer-hosting credential");
  for (const k of ["BUILD_RUNNER_SECRET", "STRIPE_SECRET_KEY", "CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN", "PROJECT_REPO_TOKEN", "DATABASE_URL"]) assert.ok(!(k in seen.env), `${k} is not passed to the deploy`);
  assert.equal(seen.env.CRESTMONT_SITE_WORKER, "cm-site-prj-alpha1");
  assert.equal(seen.config.name, "cm-site-prj-alpha1");
  assert.deepEqual(seen.config.routes, [{ pattern: "www.harbor.example", custom_domain: true }]);
  assert.ok(seen.files.includes("public") && seen.files.includes("wrangler.json") && !seen.files.includes("wrangler.jsonc") && !seen.files.includes(".git"));

  // The live site does not serve the release: reported, never claimed as verified.
  served = new TextEncoder().encode("<h1>old site</h1>");
  const bad = await runSiteDeployment(cfg, deployment({ sourceCommit: src.commit }), { logger: silentLogger, processEnv: env, fetchImpl, clone: localClone(src.dir), sleep: async () => {} });
  assert.equal(bad.result, "deployed");
  assert.equal(bad.verification?.matched, false);
  assert.equal(bad.verification?.attempts, 3);
  assert.match(String(bad.error), /verification failed/);
});

test("[AIB-006] D5: refusals: another repository, an unknown commit, a preview or Crestmont Worker, a runner without delivery configured", async () => {
  const src = await sourceRepo();
  const cfg = makeConfig({ controlPlaneUrl: "http://127.0.0.1:9", skillsSourceDir: "x", repo: REPO, delivery: { command: "echo should-not-run; exit 9", envNames: [], timeoutMs: 10_000, verifyAttempts: 1, verifyDelayMs: 0 } });
  const deps = { logger: silentLogger, processEnv: POLLUTED_ENV, clone: localClone(src.dir), fetchImpl: (async () => { throw new Error("no fetch expected"); }) as unknown as typeof fetch };
  assert.match(String((await runSiteDeployment(cfg, deployment({ sourceRepo: "https://github.com/attacker/x.git", sourceCommit: src.commit }), deps)).error), /not this project's repository/);
  assert.match(String((await runSiteDeployment(cfg, deployment({ sourceCommit: "f".repeat(40) }), deps)).error), /could not fetch the release source|is not the authorized/);
  assert.match(String((await runSiteDeployment(cfg, deployment({ workerName: "cm-prv-prj-alpha1-b0", sourceCommit: src.commit }), deps)).error), /not a customer site Worker name/);
  assert.match(String((await runSiteDeployment(cfg, deployment({ sourceCommit: "not-a-commit" }), deps)).error), /invalid source commit/);
  assert.match(String((await runSiteDeployment({ ...cfg, delivery: null }, deployment(), deps)).error), /not configured/);
  // A failing deploy command is reported as failed; the platform keeps the live version.
  const failed = await runSiteDeployment(cfg, deployment({ sourceCommit: src.commit }), deps);
  assert.equal(failed.result, "failed");
  assert.match(String(failed.error), /deploy command failed \(exit 9\)/);
  // The idle loop: claims one, runs it, reports it; an older platform is detected.
  const reports: unknown[] = [];
  const client = { claimDeployment: async () => deployment({ sourceCommit: src.commit }), completeDeployment: async (x: unknown) => { reports.push(x); return {}; } };
  assert.equal(await serveOneDeployment(cfg, client, ["production-deploy"], deps), "done");
  assert.equal((reports[0] as { result: string }).result, "failed");
  assert.equal(await serveOneDeployment(cfg, { ...client, claimDeployment: async () => "unsupported" as const }, [], deps), "unsupported");
  assert.equal(await serveOneDeployment(cfg, { ...client, claimDeployment: async () => null }, [], deps), "none");
});

test("[AIB-006] D5: production and preview credentials must be separate; delivery needs the project repositories", () => {
  const base = { LOCAL_MODEL: "qwen3-coder:30b", RUNNER_WORKSPACES: tmp("aib-rel-ws-"), SKILLS_SOURCE_DIR: tmp("aib-rel-skills-"), BUILD_RUNNER_SECRET: SECRET, CONTROL_PLANE_URL: "https://platform.example", AGENT_PROVIDER: "local", PROJECT_REPO_OWNER: "crestmont-builds", PROJECT_REPO_TOKEN: "github_pat_x_000000000000000000",
    PREVIEW_DEPLOY_COMMAND: "true", PREVIEW_DEPLOY_ENV: "CLOUDFLARE_API_TOKEN", CLOUDFLARE_API_TOKEN: "preview-token-0000000000" };
  assert.throws(() => loadConfig({ ...base, PRODUCTION_DEPLOY_COMMAND: "true", PRODUCTION_DEPLOY_ENV: "CLOUDFLARE_API_TOKEN" }), /must not reuse the preview credentials/);
  assert.throws(() => loadConfig({ ...base, PRODUCTION_DEPLOY_COMMAND: "true", PRODUCTION_DEPLOY_ENV: "SITE_CF_TOKEN", SITE_CF_TOKEN: "preview-token-0000000000" }), /same value as a preview credential/);
  assert.throws(() => loadConfig({ ...base, PROJECT_REPO_TOKEN: "", PRODUCTION_DEPLOY_COMMAND: "true" }), /needs the project repositories/);
  const ok = loadConfig({ ...base, PRODUCTION_DEPLOY_COMMAND: "true", PRODUCTION_DEPLOY_ENV: "SITE_CF_TOKEN", SITE_CF_TOKEN: "site-token-0000000000" });
  assert.deepEqual(ok.delivery?.envNames, ["SITE_CF_TOKEN"]);
  assert.equal(loadConfig(base).delivery, null, "unset by default: this runner never deploys a customer site");
});
