// Runner-side git: init/commit/bundle in the job repository, and (when PROJECT_REPO_* is configured) per-project
// repository creation and push. The push credential is passed to git through GIT_CONFIG_* environment variables for
// that one command only: it is never written to .git/config and never visible to the agent.

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { run, baseEnv, proxyEnv } from "./exec.ts";
import type { ExecResult } from "./exec.ts";

export interface GitCtx { repo: string; pathEnv: string; home: string }

async function git(ctx: GitCtx, args: string[], extraEnv: Record<string, string> = {}, timeoutMs = 120_000): Promise<ExecResult> {
  return run("git", args, { cwd: ctx.repo, env: { ...baseEnv(ctx.pathEnv, ctx.home), ...proxyEnv(), ...extraEnv }, timeoutMs });
}

async function gitOk(ctx: GitCtx, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const r = await git(ctx, args, extraEnv);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}): ${(r.stderr || r.stdout).slice(0, 500)}`);
  return r.stdout.trim();
}

export const GITIGNORE_LINES = [
  "node_modules/", ".wrangler/", ".dev.vars", ".env", ".env.*",
  "# Runner-provisioned files (not part of the customer's project)",
  ".claude/", ".crestmont/", "BRIEF.json", "BRIEF.md", "REVISION-REQUEST.md", "customer-files/",
];

export async function initRepo(ctx: GitCtx, identity: { name: string; email: string }, branch: string): Promise<void> {
  await gitOk(ctx, ["init", "-q", "-b", branch]);
  await configureRepo(ctx, identity);
}

export async function configureRepo(ctx: GitCtx, identity: { name: string; email: string }): Promise<void> {
  await gitOk(ctx, ["config", "user.name", identity.name]);
  await gitOk(ctx, ["config", "user.email", identity.email]);
  await gitOk(ctx, ["config", "commit.gpgsign", "false"]);
  await gitOk(ctx, ["config", "core.hooksPath", "/dev/null"]);
  ensureGitignore(ctx.repo);
}

export function ensureGitignore(repo: string): void {
  const file = path.join(repo, ".gitignore");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const missing = GITIGNORE_LINES.filter((l) => !existing.split("\n").includes(l));
  if (missing.length) writeFileSync(file, (existing && !existing.endsWith("\n") ? existing + "\n" : existing) + missing.join("\n") + "\n");
}

/** Commit everything (respecting .gitignore). Returns the HEAD commit, or null if the repository has no commits. */
export async function commitAll(ctx: GitCtx, message: string): Promise<string | null> {
  await gitOk(ctx, ["add", "-A"]);
  const status = await git(ctx, ["status", "--porcelain"]);
  if (status.stdout.trim()) await gitOk(ctx, ["commit", "-q", "--no-verify", "-m", message]);
  return headCommit(ctx);
}

export async function headCommit(ctx: GitCtx): Promise<string | null> {
  const r = await git(ctx, ["rev-parse", "--verify", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function currentBranch(ctx: GitCtx): Promise<string> {
  const r = await git(ctx, ["symbolic-ref", "--short", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : "main";
}

export async function createBundle(ctx: GitCtx, file: string): Promise<boolean> {
  if (!(await headCommit(ctx))) return false;
  const r = await git(ctx, ["bundle", "create", file, "--all"]);
  return r.code === 0;
}

/** Restore a repository from a bundle into ctx.repo (which must be empty). */
export async function cloneFromBundle(ctx: GitCtx, bundle: string, branch: string | null): Promise<void> {
  await gitOk(ctx, ["init", "-q"]);
  await gitOk(ctx, ["fetch", "-q", bundle, "+refs/heads/*:refs/remotes/bundle/*"]);
  const refs = (await gitOk(ctx, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/bundle/"])).split("\n").filter(Boolean);
  const pick = (branch && refs.find((r) => r === `bundle/${branch}`)) || refs[0];
  if (!pick) throw new Error("bundle has no branches");
  const local = pick.replace(/^bundle\//, "");
  await gitOk(ctx, ["checkout", "-q", "-B", local, pick]);
}

// ── Project repository (optional) ──

export interface RepoTarget { owner: string; ownerType: "org" | "user"; token: string; host: string; apiBase: string; prefix: string }

export function projectRepoName(t: RepoTarget, projectId: string): string {
  return (t.prefix + projectId).toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 100);
}

export function projectRepoUrl(t: RepoTarget, projectId: string): string {
  return `https://${t.host}/${t.owner}/${projectRepoName(t, projectId)}.git`;
}

function authEnv(t: RepoTarget): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${t.token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.https://${t.host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/** Create the per-project private repository if it does not exist (GitHub REST API). */
export async function ensureProjectRepo(t: RepoTarget, projectId: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const name = projectRepoName(t, projectId);
  const headers = { authorization: `Bearer ${t.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" };
  const get = await fetchImpl(`${t.apiBase}/repos/${t.owner}/${name}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (get.ok) return projectRepoUrl(t, projectId);
  const createPath = t.ownerType === "org" ? `/orgs/${t.owner}/repos` : "/user/repos";
  const res = await fetchImpl(`${t.apiBase}${createPath}`, {
    method: "POST", headers, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ name, private: true, auto_init: false, has_issues: false, has_wiki: false, description: `Crestmont AI build for project ${projectId}` }),
  });
  if (!res.ok && res.status !== 422) throw new Error(`creating repository ${name} failed: HTTP ${res.status}`);
  return projectRepoUrl(t, projectId);
}

export async function pushBranch(ctx: GitCtx, t: RepoTarget, url: string, branch: string): Promise<void> {
  // Store the credential-free URL as origin so `git` in the workspace shows where the work lives.
  const has = await git(ctx, ["remote", "get-url", "origin"]);
  if (has.code !== 0) await gitOk(ctx, ["remote", "add", "origin", url]);
  else if (has.stdout.trim() !== url) await gitOk(ctx, ["remote", "set-url", "origin", url]);
  await gitOk(ctx, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`], authEnv(t));
}

export async function cloneProjectRepo(ctx: GitCtx, t: RepoTarget, url: string, branch: string | null, commit: string | null): Promise<void> {
  await gitOk(ctx, ["init", "-q"]);
  await gitOk(ctx, ["remote", "add", "origin", url]);
  await gitOk(ctx, ["fetch", "-q", "origin", branch ? `+refs/heads/${branch}:refs/remotes/origin/${branch}` : "+refs/heads/*:refs/remotes/origin/*"], authEnv(t));
  const target = commit || (branch ? `origin/${branch}` : "FETCH_HEAD");
  await gitOk(ctx, ["checkout", "-q", "-B", branch || "main", target]);
}
