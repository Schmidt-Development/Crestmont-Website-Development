// GitHub readiness data source (READY-005, §36, §40). Uses the documented GitHub REST API with a
// token from the GITHUB_TOKEN secret. Every attempt is stored in github_sync and reflected in
// ingestion_status('github'); a failed sync is shown as failing and the previous payload is
// shown as stale, never as current (§40 "never silently reuse old data as current").
// When GITHUB_TOKEN / GITHUB_REPO are not set, snapshots pushed by GitHub Actions (POST
// /api/readiness/github-snapshot, see "Push path" below) are the source; with neither, the source is
// reported "not configured".
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import type { AppContext } from "../app/context.ts";
import { audit } from "./security.ts";
import { parse, v, ValidationError, type Check } from "../lib/validate.ts";
import { redact } from "./monitoring.ts";

const API = "https://api.github.com";
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const GITHUB_STALE_HOURS = 24;

export interface GithubRun {
  id: number; name: string | null; branch: string | null; headSha: string; event: string | null; status: string | null; conclusion: string | null;
  url: string | null; createdAt: string; updatedAt: string | null; attempt: number | null;
  /** Derived: succeeded | failed | not_started | in_progress | cancelled | other */
  outcome: string;
  /** Reason GitHub gave when jobs did not start (e.g. billing / spending limit), if available. */
  reason: string | null;
}

export interface GithubSnapshot {
  repo: string; htmlUrl: string | null; private: boolean | null; defaultBranch: string;
  head: { sha: string; message: string; author: string | null; date: string | null; url: string | null } | null;
  commits: { sha: string; message: string; author: string | null; date: string | null; url: string | null }[];
  pulls: { number: number; title: string; author: string | null; draft: boolean; url: string | null; createdAt: string; headRef: string | null }[];
  runs: GithubRun[];
  latestSuccess: GithubRun | null;
  latestFailure: GithubRun | null;
  tags: { name: string; sha: string }[];
  codeScanning: { available: boolean; openAlerts: number | null; detail: string };
}

export function githubConfig(env: { GITHUB_TOKEN?: string; GITHUB_REPO?: string }): { token: string; repo: string } | null {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return null;
  if (!REPO_RE.test(env.GITHUB_REPO)) return null;
  return { token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO };
}

class GithubApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const firstLine = (s: string | null | undefined) => (s ?? "").split("\n")[0].slice(0, 300);

function outcomeOf(status: string | null, conclusion: string | null): string {
  if (status && status !== "completed") return status === "queued" || status === "waiting" || status === "pending" || status === "requested" ? "queued" : "in_progress";
  switch (conclusion) {
    case "success": return "succeeded";
    case "failure": case "timed_out": case "startup_failure": return "failed";
    case "cancelled": return "cancelled";
    case "skipped": case "neutral": case "action_required": case "stale": return conclusion;
    default: return "other";
  }
}

/** Fetches the readiness snapshot. Throws GithubApiError for failures of the core repository calls. */
export async function fetchGithubSnapshot(cfg: { token: string; repo: string }, fetchImpl: typeof fetch = fetch): Promise<GithubSnapshot> {
  const get = async <T>(path: string): Promise<T> => {
    const r = await fetchImpl(`${API}/repos/${cfg.repo}${path}`, {
      headers: { authorization: `Bearer ${cfg.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "crestmont-readiness" },
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { message?: string };
      throw new GithubApiError(r.status, `GitHub ${r.status} on ${path.split("?")[0] || "/"}: ${body.message ?? r.statusText ?? "error"}`);
    }
    return (await r.json()) as T;
  };

  type RepoJson = { default_branch: string; html_url?: string; private?: boolean };
  type CommitJson = { sha: string; html_url?: string; commit: { message: string; author?: { name?: string; date?: string } }; author?: { login?: string } | null };
  const repo = await get<RepoJson>("");
  const branch = repo.default_branch;
  const commits = await get<CommitJson[]>(`/commits?sha=${encodeURIComponent(branch)}&per_page=10`);
  const pulls = await get<{ number: number; title: string; draft?: boolean; html_url?: string; created_at: string; user?: { login?: string }; head?: { ref?: string } }[]>(`/pulls?state=open&per_page=30`);
  const runsJson = await get<{ workflow_runs: { id: number; name?: string; head_branch?: string; head_sha: string; event?: string; status?: string; conclusion?: string | null; html_url?: string; created_at: string; updated_at?: string; run_attempt?: number }[] }>(`/actions/runs?per_page=20`);
  const tags = await get<{ name: string; commit: { sha: string } }[]>(`/tags?per_page=20`);

  const runs: GithubRun[] = (runsJson.workflow_runs ?? []).map((w) => ({
    id: w.id, name: w.name ?? null, branch: w.head_branch ?? null, headSha: w.head_sha, event: w.event ?? null, status: w.status ?? null, conclusion: w.conclusion ?? null,
    url: w.html_url ?? null, createdAt: w.created_at, updatedAt: w.updated_at ?? null, attempt: w.run_attempt ?? null, outcome: outcomeOf(w.status ?? null, w.conclusion ?? null), reason: null,
  }));

  // For the most recent failed runs, find out whether jobs ran at all. Jobs refused before starting
  // (e.g. billing / spending limit) have no steps; GitHub puts the reason in the check-run annotations.
  for (const run of runs.filter((x) => x.outcome === "failed").slice(0, 3)) {
    try {
      const jobs = await get<{ jobs: { id: number; steps?: unknown[]; started_at?: string | null; conclusion?: string | null }[] }>(`/actions/runs/${run.id}/jobs?per_page=20`);
      const notStarted = jobs.jobs.length > 0 && jobs.jobs.every((j) => !j.steps || j.steps.length === 0);
      if (notStarted) run.outcome = "not_started";
      for (const j of jobs.jobs.slice(0, 2)) {
        const ann = await get<{ message?: string; annotation_level?: string }[]>(`/check-runs/${j.id}/annotations`).catch(() => [] as { message?: string }[]);
        const msg = ann.map((a) => a.message).find((m) => !!m);
        if (msg) { run.reason = msg.slice(0, 500); break; }
      }
    } catch { /* jobs detail unavailable; keep the run's own conclusion */ }
  }

  let codeScanning: GithubSnapshot["codeScanning"];
  try {
    const alerts = await get<unknown[]>(`/code-scanning/alerts?state=open&per_page=100`);
    codeScanning = { available: true, openAlerts: alerts.length, detail: alerts.length >= 100 ? "100 or more open alerts (first page)" : `${alerts.length} open alerts` };
  } catch (e) {
    codeScanning = { available: false, openAlerts: null, detail: `Unavailable: ${(e as Error).message}` };
  }

  const mapCommit = (c: CommitJson) => ({ sha: c.sha, message: firstLine(c.commit.message), author: c.author?.login ?? c.commit.author?.name ?? null, date: c.commit.author?.date ?? null, url: c.html_url ?? null });
  const completed = runs.filter((x) => x.status === "completed" || x.outcome !== "in_progress");
  return {
    repo: cfg.repo, htmlUrl: repo.html_url ?? null, private: repo.private ?? null, defaultBranch: branch,
    head: commits[0] ? mapCommit(commits[0]) : null,
    commits: commits.map(mapCommit),
    pulls: pulls.map((p) => ({ number: p.number, title: p.title.slice(0, 300), author: p.user?.login ?? null, draft: !!p.draft, url: p.html_url ?? null, createdAt: p.created_at, headRef: p.head?.ref ?? null })),
    runs,
    latestSuccess: completed.find((x) => x.outcome === "succeeded") ?? null,
    latestFailure: completed.find((x) => x.outcome === "failed" || x.outcome === "not_started") ?? null,
    tags: tags.map((t) => ({ name: t.name, sha: t.commit.sha })),
    codeScanning,
  };
}

async function recordGithubIngestion(db: Db, at: string, error: string | null): Promise<void> {
  await db.prepare(`INSERT INTO ingestion_status (source, last_success_at, last_attempt_at, last_error) VALUES ('github', ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
      last_success_at = COALESCE(excluded.last_success_at, ingestion_status.last_success_at)`).bind(error ? null : at, at, error).run();
}

async function recordIntegration(db: Db, status: "verified" | "failing" | "not_configured", detail: string, at: string, env: string): Promise<void> {
  const environment = env === "production" || env === "staging" ? env : "development";
  await db.prepare(`INSERT INTO integration_health (integration, environment, status, detail, checked_at) VALUES ('github', ?, ?, ?, ?)
    ON CONFLICT(integration, environment) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at`).bind(environment, status, detail.slice(0, 500), at).run();
}

// ───────────── Push path: snapshots posted by GitHub Actions (READY-005) ─────────────
// scripts/post-github-snapshot.ts runs inside the deploy workflow with the workflow's own read-only
// GITHUB_TOKEN, builds the same GithubSnapshot with fetchGithubSnapshot() and POSTs it, HMAC-signed
// with EVIDENCE_INGEST_SECRET, to POST /api/readiness/github-snapshot. The Worker needs no PAT.

type C<T> = Check<T>;
const isoish = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z?$/;
const fail = (issues: string[], path: string, msg: string) => { issues.push(`${path} ${msg}`); return undefined; };
const pStr = (max: number, pattern?: RegExp, min = 0): C<string> => ((x, path, issues) =>
  typeof x !== "string" ? fail(issues, path, "must be a string") : x.length > max || x.length < min ? fail(issues, path, `must be ${min}–${max} characters`) : pattern && !pattern.test(x) ? fail(issues, path, "has an invalid format") : x) as C<string>;
const pNull = <T>(c: C<T>): C<T | null> => ((x, path, issues) => (x === null || x === undefined ? null : c(x, path, issues))) as C<T | null>;
const pBool: C<boolean> = ((x, path, issues) => (typeof x === "boolean" ? x : fail(issues, path, "must be a boolean"))) as C<boolean>;
const SHA = /^[0-9a-f]{7,40}$/;
const HTTPS = /^https:\/\/[^\s]+$/;
const commitCheck = v.object({ sha: pStr(40, SHA), message: pStr(500), author: pNull(pStr(200)), date: pNull(pStr(40, isoish)), url: pNull(pStr(500, HTTPS)) });
const RUN_OUTCOMES = ["succeeded", "failed", "not_started", "in_progress", "queued", "cancelled", "skipped", "neutral", "action_required", "stale", "other"] as const;
const runCheck = v.object({
  id: v.int({ min: 0 }), name: pNull(pStr(200)), branch: pNull(pStr(255)), headSha: pStr(40, SHA), event: pNull(pStr(50)), status: pNull(pStr(50)), conclusion: pNull(pStr(50)),
  url: pNull(pStr(500, HTTPS)), createdAt: pStr(40, isoish), updatedAt: pNull(pStr(40, isoish)), attempt: pNull(v.int({ min: 0, max: 1000 })), outcome: v.enumOf(RUN_OUTCOMES), reason: pNull(pStr(500)),
});
const snapshotCheck = v.object({
  repo: pStr(201, REPO_RE), htmlUrl: pNull(pStr(500, HTTPS)), private: pNull(pBool), defaultBranch: pStr(255, undefined, 1),
  head: pNull(commitCheck), commits: v.array(commitCheck, { max: 100 }),
  pulls: v.array(v.object({ number: v.int({ min: 1 }), title: pStr(500), author: pNull(pStr(200)), draft: pBool, url: pNull(pStr(500, HTTPS)), createdAt: pStr(40, isoish), headRef: pNull(pStr(255)) }), { max: 200 }),
  runs: v.array(runCheck, { max: 100 }), latestSuccess: pNull(runCheck), latestFailure: pNull(runCheck),
  tags: v.array(v.object({ name: pStr(255, undefined, 1), sha: pStr(40, SHA) }), { max: 100 }),
  codeScanning: v.object({ available: pBool, openAlerts: pNull(v.int({ min: 0, max: 1_000_000 })), detail: pStr(500) }),
});
const pushedCheck = v.object({
  snapshotId: v.string({ min: 1, max: 200, pattern: /^[A-Za-z0-9._:-]+$/ }),
  repo: v.string({ max: 201, pattern: REPO_RE }),
  generatedAt: v.string({ pattern: /^\d{4}-\d{2}-\d{2}T/ }),
  runUrl: v.string({ optional: true, max: 500, pattern: /^https:\/\// }),
  ok: pBool,
  error: v.string({ optional: true, max: 1000 }),
  snapshot: pNull(snapshotCheck),
});

export interface PushedSnapshotDoc { snapshotId: string; repo: string; generatedAt: string; runUrl?: string; ok: boolean; error?: string; snapshot: GithubSnapshot | null }

export function parsePushedSnapshot(json: unknown): PushedSnapshotDoc {
  const doc = parse(pushedCheck, json) as PushedSnapshotDoc;
  const issues: string[] = [];
  if (doc.ok && !doc.snapshot) issues.push("snapshot is required when ok is true");
  if (!doc.ok && !doc.error) issues.push("error is required when ok is false");
  if (doc.snapshot && doc.snapshot.repo !== doc.repo) issues.push("snapshot.repo must equal repo");
  if (issues.length) throw new ValidationError(issues);
  // Honesty rule: unavailable code scanning is never a count (not zero, not anything).
  if (doc.snapshot && !doc.snapshot.codeScanning.available) doc.snapshot.codeScanning.openAlerts = null;
  return doc;
}

export class GithubPushError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}

/** Stores a pushed snapshot (idempotent per snapshotId). Signature verification happens in the route. */
export async function ingestPushedSnapshot(ctx: Pick<AppContext, "db" | "env" | "now">, rawBody: string): Promise<{ status: "ingested" | "duplicate"; id: string; ok: boolean }> {
  const doc = parsePushedSnapshot(JSON.parse(rawBody));
  if (ctx.env.GITHUB_REPO && ctx.env.GITHUB_REPO.toLowerCase() !== doc.repo.toLowerCase()) throw new GithubPushError(`Snapshot repository ${doc.repo} does not match GITHUB_REPO`);
  const id = `ghp_${doc.snapshotId}`;
  const at = nowIso(ctx.now);
  if (await ctx.db.prepare(`SELECT 1 FROM github_sync WHERE id = ?`).bind(id).first()) return { status: "duplicate", id, ok: doc.ok };
  const error = doc.ok ? null : `Pushed snapshot failed: ${doc.error ?? "unknown error"}`.slice(0, 1000);
  await ctx.db.prepare(`INSERT INTO github_sync (id, repo, fetched_at, ok, payload_json, error, requested_by, source, run_url) VALUES (?,?,?,?,?,?,NULL,'push',?)`)
    .bind(id, doc.repo, at, doc.ok ? 1 : 0, doc.ok ? JSON.stringify(doc.snapshot) : null, error, doc.runUrl ?? null).run();
  await recordGithubIngestion(ctx.db, at, error);
  const snap = doc.snapshot;
  await recordIntegration(ctx.db, doc.ok ? "verified" : "failing", doc.ok && snap ? `Snapshot of ${doc.repo} pushed by GitHub Actions (${snap.defaultBranch} @ ${snap.head?.sha.slice(0, 7) ?? "no commits"})` : error!, at, ctx.env.ENVIRONMENT);
  await audit(ctx.db, { actorKind: "system", action: doc.ok ? "readiness.github_snapshot_pushed" : "readiness.github_snapshot_push_failed", subjectType: "github_sync", subjectId: id, details: { repo: doc.repo, generatedAt: doc.generatedAt, runUrl: doc.runUrl ?? null } });
  return { status: "ingested", id, ok: doc.ok };
}

/** Builds the document scripts/post-github-snapshot.ts posts. A failing core GitHub call yields ok:false with GitHub's reason. */
export async function buildPushedSnapshot(cfg: { token: string; repo: string; snapshotId: string; runUrl?: string }, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<PushedSnapshotDoc> {
  const base = { snapshotId: cfg.snapshotId, repo: cfg.repo, generatedAt: now.toISOString(), ...(cfg.runUrl ? { runUrl: cfg.runUrl } : {}) };
  try {
    return { ...base, ok: true, snapshot: await fetchGithubSnapshot({ token: cfg.token, repo: cfg.repo }, fetchImpl) };
  } catch (e) {
    return { ...base, ok: false, error: redact((e as Error).message).slice(0, 1000), snapshot: null };
  }
}

export type SyncResult = { status: "not_configured" } | { status: "ok"; id: string; snapshot: GithubSnapshot } | { status: "failed"; id: string; error: string };

export async function syncGithub(ctx: Pick<AppContext, "db" | "env" | "now">, requestedBy: string | null, fetchImpl: typeof fetch = fetch): Promise<SyncResult> {
  const cfg = githubConfig(ctx.env);
  const at = nowIso(ctx.now);
  if (!cfg) {
    // A snapshot pushed by GitHub Actions is the active source: do not overwrite its health record.
    if (await hasPushedSnapshot(ctx.db)) return { status: "not_configured" };
    await recordIntegration(ctx.db, "not_configured", ctx.env.GITHUB_REPO && !REPO_RE.test(ctx.env.GITHUB_REPO) ? "GITHUB_REPO is not in owner/name form" : "GITHUB_TOKEN and GITHUB_REPO are not set", at, ctx.env.ENVIRONMENT);
    return { status: "not_configured" };
  }
  const id = newId("ghs");
  try {
    const snapshot = await fetchGithubSnapshot(cfg, fetchImpl);
    await ctx.db.prepare(`INSERT INTO github_sync (id, repo, fetched_at, ok, payload_json, error, requested_by) VALUES (?,?,?,1,?,NULL,?)`).bind(id, cfg.repo, at, JSON.stringify(snapshot), requestedBy).run();
    await recordGithubIngestion(ctx.db, at, null);
    await recordIntegration(ctx.db, "verified", `Synced ${cfg.repo} (${snapshot.defaultBranch} @ ${snapshot.head?.sha.slice(0, 7) ?? "no commits"})`, at, ctx.env.ENVIRONMENT);
    await audit(ctx.db, { actorUserId: requestedBy, actorKind: requestedBy ? "user" : "system", action: "readiness.github_synced", subjectType: "github_sync", subjectId: id });
    return { status: "ok", id, snapshot };
  } catch (e) {
    const error = (e as Error).message.slice(0, 1000);
    await ctx.db.prepare(`INSERT INTO github_sync (id, repo, fetched_at, ok, payload_json, error, requested_by) VALUES (?,?,?,0,NULL,?,?)`).bind(id, cfg.repo, at, error, requestedBy).run();
    await recordGithubIngestion(ctx.db, at, error);
    await recordIntegration(ctx.db, "failing", error, at, ctx.env.ENVIRONMENT);
    await audit(ctx.db, { actorUserId: requestedBy, actorKind: requestedBy ? "user" : "system", action: "readiness.github_sync_failed", subjectType: "github_sync", subjectId: id, details: { error } });
    return { status: "failed", id, error };
  }
}

export interface GithubSyncRow { id: string; repo: string; fetched_at: string; ok: number; payload_json: string | null; error: string | null; source?: "pull" | "push"; run_url?: string | null }

export async function hasPushedSnapshot(db: Db): Promise<boolean> {
  try { return !!(await db.prepare(`SELECT 1 FROM github_sync WHERE source = 'push' LIMIT 1`).first()); } catch { return false; }
}

/** Latest attempt plus the latest successful snapshot (which may be older, and is then flagged stale). */
export async function latestGithubSync(db: Db): Promise<{ latest: GithubSyncRow | null; lastGood: (GithubSyncRow & { snapshot: GithubSnapshot }) | null }> {
  try {
    const latest = await db.prepare(`SELECT * FROM github_sync ORDER BY fetched_at DESC, rowid DESC LIMIT 1`).first<GithubSyncRow>();
    const good = await db.prepare(`SELECT * FROM github_sync WHERE ok = 1 ORDER BY fetched_at DESC, rowid DESC LIMIT 1`).first<GithubSyncRow>();
    return { latest, lastGood: good && good.payload_json ? { ...good, snapshot: JSON.parse(good.payload_json) as GithubSnapshot } : null };
  } catch { return { latest: null, lastGood: null }; }
}

export async function githubFeedStatus(ctx: Pick<AppContext, "db" | "env" | "now">) {
  const base = { source: "github", required: false };
  const pull = !!githubConfig(ctx.env);
  if (!pull && !(await hasPushedSnapshot(ctx.db))) return { ...base, status: "not_configured" as const, detail: "GitHub source not configured (GITHUB_TOKEN / GITHUB_REPO not set) and no snapshot has been pushed by GitHub Actions", lastSuccessAt: null, lastAttemptAt: null };
  const { latest, lastGood } = await latestGithubSync(ctx.db);
  if (!latest) return { ...base, status: "unavailable" as const, detail: "Configured but never synced", lastSuccessAt: null, lastAttemptAt: null };
  if (!latest.ok) return { ...base, status: "failing" as const, detail: `Last sync failed: ${latest.error}`, lastSuccessAt: lastGood?.fetched_at ?? null, lastAttemptAt: latest.fetched_at };
  if (ctx.now().getTime() - Date.parse(latest.fetched_at) > GITHUB_STALE_HOURS * 3_600_000)
    return { ...base, status: "stale" as const, detail: `Last successful sync ${latest.fetched_at} is older than ${GITHUB_STALE_HOURS} h`, lastSuccessAt: latest.fetched_at, lastAttemptAt: latest.fetched_at };
  return { ...base, status: "healthy" as const, detail: `Last successful ${latest.source === "push" ? "snapshot pushed by GitHub Actions" : "sync"} ${latest.fetched_at}`, lastSuccessAt: latest.fetched_at, lastAttemptAt: latest.fetched_at };
}
