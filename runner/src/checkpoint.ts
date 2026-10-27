// Checkpoint archives (tar.gz ≤ 20 MB): meta.json + repo.bundle (git bundle --all) + the Agent SDK session
// transcripts under <job home>/.claude/projects/ that `resume` needs.
// Transcript location: https://code.claude.com/docs/en/agent-sdk/sessions ("Claude Code stores sessions under
// ~/.claude/projects/<encoded-cwd>/*.jsonl ... If you set CLAUDE_CONFIG_DIR, look under $CLAUDE_CONFIG_DIR/projects/";
// "Resume across hosts: Move the session file ... restore it inside any directory under ~/.claude/projects/").

import { mkdirSync, cpSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { run, baseEnv } from "./exec.ts";
import { createBundle, cloneFromBundle } from "./git.ts";
import type { GitCtx } from "./git.ts";
import type { Workspace } from "./workspace.ts";
import { LIMITS } from "./protocol.ts";

export interface CheckpointMeta {
  schema: "crestmont.runner-checkpoint/1";
  jobId: string;
  attempt: number;
  sessionId: string | null;
  /** Session total (USD estimate) at checkpoint time: the cost baseline when a later attempt resumes this session. */
  sessionTotalCostUsd: number;
  sourceBranch: string | null;
  sourceCommit: string | null;
  createdAt: string;
  contents: string[];
}

export interface BuiltCheckpoint { file: string; base64: string | null; bytes: number; contents: string[]; note: string | null }

let counter = 0;

export async function buildCheckpoint(ws: Workspace, git: GitCtx, meta: Omit<CheckpointMeta, "schema" | "createdAt" | "contents">, pathEnv: string, maxBytes = LIMITS.archiveBytes): Promise<BuiltCheckpoint> {
  const n = nextIndex(ws);
  const stage = path.join(ws.tmp, `ckpt-stage-${n}-${counter++}`);
  mkdirSync(stage, { recursive: true });
  const contents: string[] = [];
  const projects = path.join(ws.home, ".claude", "projects");
  if (existsSync(projects)) {
    cpSync(projects, path.join(stage, "claude-projects"), { recursive: true });
    contents.push("claude-projects");
  }
  if (await createBundle(git, path.join(stage, "repo.bundle"))) contents.push("repo.bundle");
  const full: CheckpointMeta = { schema: "crestmont.runner-checkpoint/1", createdAt: new Date().toISOString(), contents, ...meta };
  writeFileSync(path.join(stage, "meta.json"), JSON.stringify(full, null, 2));

  const file = path.join(ws.checkpoints, `ckpt-${n}.tgz`);
  await tarCreate(stage, file, pathEnv, ws.home);
  let bytes = statSync(file).size;
  let note: string | null = null;
  if (bytes > maxBytes && contents.includes("repo.bundle")) {
    // Git (pushed or local) is the primary file persistence: drop the bundle before dropping the transcript.
    rmSync(path.join(stage, "repo.bundle"));
    full.contents = contents.filter((c) => c !== "repo.bundle");
    writeFileSync(path.join(stage, "meta.json"), JSON.stringify(full, null, 2));
    await tarCreate(stage, file, pathEnv, ws.home);
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

async function tarCreate(dir: string, file: string, pathEnv: string, home: string): Promise<void> {
  const r = await run("tar", ["-czf", file, "-C", dir, "."], { env: baseEnv(pathEnv, home), timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`tar failed: ${r.stderr.slice(0, 300)}`);
}

export interface RestoreResult { meta: CheckpointMeta | null; repoRestored: boolean; sessionFileFound: boolean }

/**
 * Restore a checkpoint archive into a fresh workspace: the repository from repo.bundle (when present and the repo is
 * still empty) and the transcripts into <home>/.claude/projects/. Archive members are validated before extraction.
 */
export async function restoreCheckpoint(ws: Workspace, git: GitCtx, archive: Buffer, sessionId: string | null, pathEnv: string, branch: string | null): Promise<RestoreResult> {
  const dir = path.join(ws.tmp, `restore-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const archiveFile = path.join(dir, "..", `restore-${counter++}.tgz`);
  writeFileSync(archiveFile, archive);
  const env = baseEnv(pathEnv, ws.home);
  const list = await run("tar", ["-tzf", archiveFile], { env, timeoutMs: 60_000 });
  if (list.code !== 0) throw new Error("checkpoint archive is not a valid tar.gz");
  for (const member of list.stdout.split("\n").filter(Boolean)) {
    const norm = path.posix.normalize(member);
    if (norm.startsWith("/") || norm.startsWith("../") || norm === "..") throw new Error(`unsafe path in checkpoint archive: ${member}`);
  }
  const x = await run("tar", ["-xzf", archiveFile, "-C", dir, "--no-same-owner", "--no-same-permissions"], { env, timeoutMs: 120_000 });
  if (x.code !== 0) throw new Error(`could not extract checkpoint: ${x.stderr.slice(0, 300)}`);
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
  rmSync(dir, { recursive: true, force: true });
  rmSync(archiveFile, { force: true });
  return { meta, repoRestored, sessionFileFound: sessionId ? sessionFileExists(ws.home, sessionId) : false };
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
