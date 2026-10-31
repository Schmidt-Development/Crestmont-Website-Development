// Checkpoint archives (tar.gz ≤ 20 MB): meta.json + repo.bundle (git bundle --all) + the provider's session
// transcripts that `resume` needs: the Agent SDK's under <job home>/.claude/projects/ ("claude-projects") and the
// local provider's under <job dir>/agent/ ("local-agent").
// Transcript location: https://code.claude.com/docs/en/agent-sdk/sessions ("Claude Code stores sessions under
// ~/.claude/projects/<encoded-cwd>/*.jsonl ... If you set CLAUDE_CONFIG_DIR, look under $CLAUDE_CONFIG_DIR/projects/";
// "Resume across hosts: Move the session file ... restore it inside any directory under ~/.claude/projects/").

import { mkdirSync, cpSync, existsSync, readFileSync, writeFileSync, statSync, lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { run, baseEnv } from "./exec.ts";
import { createBundle, cloneFromBundle } from "./git.ts";
import type { GitCtx } from "./git.ts";
import type { Workspace } from "./workspace.ts";
import { LIMITS } from "./protocol.ts";
import { resolveWithin } from "./paths.ts";

export interface CheckpointMeta {
  schema: "crestmont.runner-checkpoint/1";
  jobId: string;
  attempt: number;
  sessionId: string | null;
  /** Session total (USD estimate) at checkpoint time: the cost baseline when a later attempt resumes this session. */
  sessionTotalCostUsd: number;
  sourceBranch: string | null;
  sourceCommit: string | null;
  /** Agent provider that owns sessionId ("local" | "claude-agent-sdk"); absent in checkpoints from runner 1.0. */
  provider?: string;
  createdAt: string;
  contents: string[];
}

export interface BuiltCheckpoint { file: string; base64: string | null; bytes: number; contents: string[]; note: string | null }

let counter = 0;

/** cpSync filter: copy directories and regular files only (symlinks and special files are left out of checkpoints). */
function regularOnly(src: string): boolean {
  try { const st = lstatSync(src); return st.isDirectory() || st.isFile(); } catch { return false; }
}

export async function buildCheckpoint(ws: Workspace, git: GitCtx, meta: Omit<CheckpointMeta, "schema" | "createdAt" | "contents">, pathEnv: string, maxBytes = LIMITS.archiveBytes): Promise<BuiltCheckpoint> {
  const n = nextIndex(ws);
  const stage = path.join(ws.tmp, `ckpt-stage-${n}-${counter++}`);
  mkdirSync(stage, { recursive: true });
  const contents: string[] = [];
  const projects = path.join(ws.home, ".claude", "projects");
  if (existsSync(projects)) {
    cpSync(projects, path.join(stage, "claude-projects"), { recursive: true, filter: regularOnly });
    contents.push("claude-projects");
  }
  // The local provider's transcript (<job dir>/agent/, outside the agent's repository).
  const localAgent = path.join(ws.dir, "agent");
  if (existsSync(localAgent)) {
    cpSync(localAgent, path.join(stage, "local-agent"), { recursive: true, filter: regularOnly });
    contents.push("local-agent");
  }
  if (await createBundle(git, path.join(stage, "repo.bundle"))) contents.push("repo.bundle");
  const full: CheckpointMeta = { schema: "crestmont.runner-checkpoint/1", createdAt: new Date().toISOString(), contents, ...meta };
  writeFileSync(path.join(stage, "meta.json"), JSON.stringify(full, null, 2));

  const file = path.join(ws.checkpoints, `ckpt-${n}.tgz`);
  await tarCreate(ws, stage, file, pathEnv);
  let bytes = statSync(file).size;
  let note: string | null = null;
  if (bytes > maxBytes && contents.includes("repo.bundle")) {
    // Git (pushed or local) is the primary file persistence: drop the bundle before dropping the transcript.
    rmSync(path.join(stage, "repo.bundle"));
    full.contents = contents.filter((c) => c !== "repo.bundle");
    writeFileSync(path.join(stage, "meta.json"), JSON.stringify(full, null, 2));
    await tarCreate(ws, stage, file, pathEnv);
    bytes = statSync(file).size;
    note = "checkpoint archive exceeded 20 MB; the git bundle was left out (source is in git)";
  }
  rmSync(stage, { recursive: true, force: true });
  if (bytes > maxBytes) {
    return { file, base64: null, bytes, contents: full.contents, note: "checkpoint archive exceeds 20 MB even without the git bundle; kept on the runner host only" };
  }
  return { file, base64: readFileSync(file).toString("base64"), bytes, contents: full.contents, note };
}

function nextIndex(ws: Workspace): number {
  if (!existsSync(ws.checkpoints)) return 1;
  const nums = readdirSync(ws.checkpoints).map((f) => /^ckpt-(\d+)\.tgz$/.exec(f)).filter(Boolean).map((m) => Number(m![1]));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

/** Both paths must be inside the job's workspace (absolute, so tar can never read them as options). */
async function tarCreate(ws: Workspace, dir: string, file: string, pathEnv: string): Promise<void> {
  const src = resolveWithin(ws.dir, dir), out = resolveWithin(ws.dir, file);
  const r = await run("tar", ["-czf", out, "-C", src, "."], { env: baseEnv(pathEnv, ws.home), timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`tar failed: ${r.stderr.slice(0, 300)}`);
}

export interface RestoreResult { meta: CheckpointMeta | null; repoRestored: boolean; sessionFileFound: boolean }

/**
 * Restore a checkpoint archive into a fresh workspace: the repository from repo.bundle (when present and the repo is
 * still empty) and the transcripts into <home>/.claude/projects/. Archive members are validated before extraction.
 */
export async function restoreCheckpoint(ws: Workspace, git: GitCtx, archive: Buffer, sessionId: string | null, pathEnv: string, branch: string | null): Promise<RestoreResult> {
  const dir = resolveWithin(ws.dir, path.join(ws.tmp, `restore-${counter++}`));
  mkdirSync(dir, { recursive: true });
  const archiveFile = resolveWithin(ws.dir, path.join(ws.tmp, `restore-${counter++}.tgz`));
  writeFileSync(archiveFile, archive);
  const env = baseEnv(pathEnv, ws.home);
  const list = await run("tar", ["-tzf", archiveFile], { env, timeoutMs: 60_000 });
  if (list.code !== 0) throw new Error("checkpoint archive is not a valid tar.gz");
  for (const member of list.stdout.split("\n").filter(Boolean)) {
    const norm = path.posix.normalize(member);
    if (norm.startsWith("/") || norm.startsWith("../") || norm === "..") throw new Error(`unsafe path in checkpoint archive: ${member}`);
  }
  // Only regular files and directories: a symlink or hard link (e.g. a transcript pointing at /run/secrets/...) would
  // be copied into the workspace and later read back into the model context or a checkpoint upload.
  const verbose = await run("tar", ["-tvzf", archiveFile], { env, timeoutMs: 60_000 });
  if (verbose.code !== 0) throw new Error("checkpoint archive is not a valid tar.gz");
  for (const line of verbose.stdout.split("\n").filter(Boolean)) {
    if (!"-d".includes(line[0])) throw new Error(`checkpoint archive contains a link or special file (${line[0]}): ${line.slice(0, 200)}`);
  }
  const x = await run("tar", ["-xzf", archiveFile, "-C", dir, "--no-same-owner", "--no-same-permissions"], { env, timeoutMs: 120_000 });
  if (x.code !== 0) throw new Error(`could not extract checkpoint: ${x.stderr.slice(0, 300)}`);
  const linked = findLinks(dir);
  if (linked) { rmSync(dir, { recursive: true, force: true }); rmSync(archiveFile, { force: true }); throw new Error(`checkpoint archive contains a link: ${path.relative(dir, linked)}`); }
  let meta: CheckpointMeta | null = null;
  try { meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) as CheckpointMeta; } catch { meta = null; }
  let repoRestored = false;
  const bundle = path.join(dir, "repo.bundle");
  if (existsSync(bundle) && readdirSync(ws.repo).length === 0) {
    await cloneFromBundle(git, bundle, branch ?? meta?.sourceBranch ?? null);
    repoRestored = true;
  }
  const projects = path.join(dir, "claude-projects");
  if (existsSync(projects)) {
    mkdirSync(path.join(ws.home, ".claude"), { recursive: true });
    cpSync(projects, path.join(ws.home, ".claude", "projects"), { recursive: true });
  }
  const localAgent = path.join(dir, "local-agent");
  if (existsSync(localAgent)) cpSync(localAgent, path.join(ws.dir, "agent"), { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  rmSync(archiveFile, { force: true });
  return { meta, repoRestored, sessionFileFound: sessionId ? sessionFileExists(ws.home, sessionId) : false };
}

/** First symlink (or non-regular, non-directory entry) below `dir`, or null. */
function findLinks(dir: string, depth = 0): string | null {
  if (depth > 50) return dir;
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    const st = lstatSync(p);
    if (st.isDirectory()) { const f = findLinks(p, depth + 1); if (f) return f; }
    else if (!st.isFile()) return p;
  }
  return null;
}

export function sessionFileExists(home: string, sessionId: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) return false;
  const projects = path.join(home, ".claude", "projects");
  if (!existsSync(projects)) return false;
  for (const d of readdirSync(projects)) {
    if (existsSync(path.join(projects, d, `${sessionId}.jsonl`))) return true;
  }
  return false;
}
