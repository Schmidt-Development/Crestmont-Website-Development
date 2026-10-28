// Launch Readiness Command Center write paths and read models (READY-001..012, §36–§50).
// Everything is derived from stored records via buildReport(); nothing here keeps a manual
// percentage. Founder approval is recorded only by the Owner (isOwner + release.approve_production).
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import type { AppContext } from "../app/context.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { buildReport, loadReadinessInput } from "../readiness/report.ts";
import { approvalValidity, ingestionHealth, type ReadinessInput } from "../readiness/engine.ts";
import { can, isOwner, type Actor } from "../domain/authz.ts";
import { audit } from "./security.ts";
import { githubFeedStatus, latestGithubSync } from "./github.ts";

export type Report = Awaited<ReturnType<typeof buildReport>>;

export class ReadinessError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}

export const BLOCKER_CATEGORIES = ["engineering", "external_account", "security", "legal", "founder_approval", "production_incident"] as const;
export const BLOCKER_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const ENVIRONMENTS = ["development", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

const SHA_COMMIT = /^[0-9a-f]{7,40}$/;
const SHA_256 = /^[0-9a-f]{64}$/;

/**
 * Applies the discovery register's requirement links (migration 0008 blocker_seed_links) once the
 * requirement rows exist. One-time per link (applied_at), so a link removed later stays removed.
 */
export async function applySeedBlockerLinks(db: Db): Promise<number> {
  try {
    const pending = (await db.prepare(`SELECT s.blocker_id, s.requirement_id FROM blocker_seed_links s
      JOIN blockers b ON b.id = s.blocker_id JOIN requirements r ON r.id = s.requirement_id WHERE s.applied_at IS NULL`).all<{ blocker_id: string; requirement_id: string }>()).results;
    if (!pending.length) return 0;
    const at = nowIso();
    await db.batch(pending.flatMap((p) => [
      db.prepare(`INSERT INTO blocker_requirements (blocker_id, requirement_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).bind(p.blocker_id, p.requirement_id),
      db.prepare(`UPDATE blocker_seed_links SET applied_at = ? WHERE blocker_id = ? AND requirement_id = ?`).bind(at, p.blocker_id, p.requirement_id),
    ]));
    return pending.length;
  } catch { return 0; } // table absent in databases without migration 0008
}

export async function loadReport(ctx: Pick<AppContext, "db" | "now">): Promise<{ input: ReadinessInput; report: Report }> {
  await applySeedBlockerLinks(ctx.db);
  const input = await loadReadinessInput(ctx.db, ctx.now());
  return { input, report: await buildReport(input) };
}

// ───────────── Self-monitoring (READY-012, §50) ─────────────

export interface FeedStatus { source: string; status: "healthy" | "stale" | "failing" | "unavailable" | "not_configured"; detail: string; required: boolean; lastSuccessAt: string | null; lastAttemptAt: string | null }

export async function feedStatuses(ctx: Pick<AppContext, "db" | "env" | "now">, input: ReadinessInput): Promise<FeedStatus[]> {
  const now = ctx.now();
  const required = ingestionHealth(input.ingestion, now).map((f) => {
    const row = input.ingestion.find((r) => r.source === f.source);
    return { source: f.source, status: f.status, detail: f.detail, required: true, lastSuccessAt: row?.last_success_at ?? null, lastAttemptAt: row?.last_attempt_at ?? null } as FeedStatus;
  });
  const requiredIds = new Set(required.map((r) => r.source));
  const others: FeedStatus[] = input.ingestion.filter((r) => !requiredIds.has(r.source) && r.source !== "github").map((r) => {
    const failing = !!(r.last_error && r.last_attempt_at && (!r.last_success_at || r.last_attempt_at > r.last_success_at));
    const stale = !failing && r.last_success_at !== null && now.getTime() - Date.parse(r.last_success_at) > 72 * 3_600_000;
    return { source: r.source, status: failing ? "failing" : !r.last_success_at ? "unavailable" : stale ? "stale" : "healthy",
      detail: failing ? `Last attempt failed: ${r.last_error}` : r.last_success_at ? `Last success ${r.last_success_at}` : "No successful ingestion recorded",
      required: false, lastSuccessAt: r.last_success_at, lastAttemptAt: r.last_attempt_at };
  });
  const gh = await githubFeedStatus(ctx);
  const cron = await scheduledJobsFeed(ctx, input);
  return [...required, gh, ...(cron ? [cron] : []), ...others];
}

/** Cron triggers that never fire are otherwise silent: every job feed simply never appears. On a deployed environment
 *  (staging/production) that has been live for over an hour, the scheduler must have run its 15-minute jobs within
 *  45 minutes and its daily jobs within 26 hours; this is a REQUIRED feed, so /api/readiness/health answers 503 and the
 *  external monitor alerts when it is not met. Development has no scheduler and is exempt. */
export async function scheduledJobsFeed(ctx: Pick<AppContext, "db" | "env" | "now">, input: ReadinessInput): Promise<FeedStatus | null> {
  const env = ctx.env.ENVIRONMENT;
  if (env !== "staging" && env !== "production") return null;
  const now = ctx.now().getTime();
  const firstDeploy = await ctx.db.prepare(`SELECT MIN(deployed_at) AS at FROM deployments WHERE environment = ? AND status = 'succeeded'`).bind(env).first<{ at: string | null }>().catch(() => null);
  const liveSince = firstDeploy?.at ? Date.parse(firstDeploy.at) : null;
  const row = (src: string) => input.ingestion.find((r) => r.source === src);
  const frequent = row("job:build_sweep"), daily = row("job:requirements");
  const lastSuccessAt = [frequent?.last_success_at, daily?.last_success_at].filter(Boolean).sort().pop() ?? null;
  const lastAttemptAt = [frequent?.last_attempt_at, daily?.last_attempt_at].filter(Boolean).sort().pop() ?? null;
  const age = (r?: { last_success_at: string | null }) => (r?.last_success_at ? now - Date.parse(r.last_success_at) : Infinity);
  const grace = liveSince === null || now - liveSince < 60 * 60_000;
  const problems: string[] = [];
  // 75 minutes: Cron Triggers run every 15 minutes; the external scheduler (POST /api/scheduled/run from the staging
  // health monitor) every 30, and GitHub may delay a scheduled workflow by several minutes.
  if (age(frequent) > 75 * 60_000) problems.push(frequent?.last_success_at ? `15-minute jobs last ran ${frequent.last_success_at}` : "15-minute jobs have never run");
  // A daily job that has never run is only a failure while the 15-minute jobs are failing too: after the triggers are
  // (re)registered, the first daily run can be up to 24 h away, and alerting every 30 minutes until then is noise.
  const dailyNeverRan = !daily?.last_success_at;
  if (age(daily) > 26 * 3_600_000 && (liveSince === null || now - liveSince > 26 * 3_600_000) && !(dailyNeverRan && !problems.length)) problems.push(daily?.last_success_at ? `daily jobs last ran ${daily.last_success_at}` : "daily jobs have never run");
  if (!problems.length) return { source: "scheduler", status: "healthy", detail: dailyNeverRan ? "15-minute jobs are running; the daily jobs have not run yet" : "Cron-triggered jobs are running on schedule", required: true, lastSuccessAt, lastAttemptAt };
  if (grace) return { source: "scheduler", status: "healthy", detail: `Within the first hour after the first deployment: ${problems.join("; ")}`, required: true, lastSuccessAt, lastAttemptAt };
  return { source: "scheduler", status: lastSuccessAt ? "stale" : "unavailable", detail: `${problems.join("; ")} — check the Worker's cron triggers (docs/RUNBOOK.md §2)`, required: true, lastSuccessAt, lastAttemptAt };
}

/** Overall health of the readiness system's own inputs. Unhealthy whenever a required feed is not healthy, or a configured source is failing. */
export function overallFeedHealth(feeds: FeedStatus[]): { ok: boolean; reason: string } {
  const bad = feeds.filter((f) => (f.required && f.status !== "healthy") || (!f.required && f.status === "failing"));
  return bad.length ? { ok: false, reason: bad.map((f) => `${f.source}: ${f.status} (${f.detail})`).join("; ") } : { ok: true, reason: "All required evidence feeds are healthy" };
}

// ───────────── Requirements matrix (READY-001) ─────────────

export async function requirementLocations(db: Db): Promise<Map<string, { location: string | null; owner: string | null; section: string; blocked_reason: string | null; updated_at: string }>> {
  const rows = (await db.prepare(`SELECT id, implementation_location AS location, owner, section, blocked_reason, updated_at FROM requirements`).all<{ id: string; location: string | null; owner: string | null; section: string; blocked_reason: string | null; updated_at: string }>()).results;
  return new Map(rows.map((r) => [r.id, r]));
}

export async function requirementDetail(db: Db, id: string) {
  const req = await db.prepare(`SELECT * FROM requirements WHERE id = ?`).bind(id).first<Record<string, string | number | null>>();
  if (!req) return null;
  const evidence = (await db.prepare(`SELECT te.test_name, te.outcome, te.duration_ms, te.message, er.id AS run_id, er.source, er.environment, er.commit_sha, er.branch, er.run_url, er.finished_at
     FROM test_evidence te JOIN evidence_runs er ON er.id = te.run_id WHERE te.requirement_id = ? ORDER BY er.finished_at DESC, te.id DESC LIMIT 300`).bind(id)
    .all<{ test_name: string; outcome: string; duration_ms: number | null; message: string | null; run_id: string; source: string; environment: string; commit_sha: string; branch: string | null; run_url: string | null; finished_at: string }>()).results;
  const dependsOn = (await db.prepare(`SELECT r.id, r.title, r.implementation_status FROM requirement_dependencies d JOIN requirements r ON r.id = d.depends_on_id WHERE d.requirement_id = ? ORDER BY r.id`).bind(id).all<{ id: string; title: string; implementation_status: string }>()).results;
  const dependents = (await db.prepare(`SELECT r.id, r.title, r.implementation_status FROM requirement_dependencies d JOIN requirements r ON r.id = d.requirement_id WHERE d.depends_on_id = ? ORDER BY r.id`).bind(id).all<{ id: string; title: string; implementation_status: string }>()).results;
  const blockers = (await db.prepare(`SELECT b.* FROM blockers b JOIN blocker_requirements br ON br.blocker_id = b.id WHERE br.requirement_id = ? ORDER BY b.status, b.id`).bind(id).all<BlockerRecord>()).results;
  return { req, evidence, dependsOn, dependents, blockers };
}

export async function evidenceRun(db: Db, id: string) {
  const run = await db.prepare(`SELECT * FROM evidence_runs WHERE id = ?`).bind(id).first<EvidenceRunRecord>();
  if (!run) return null;
  const results = (await db.prepare(`SELECT requirement_id, test_name, outcome, duration_ms, message FROM test_evidence WHERE run_id = ? ORDER BY outcome = 'failed' DESC, requirement_id, test_name`).bind(id)
    .all<{ requirement_id: string; test_name: string; outcome: string; duration_ms: number | null; message: string | null }>()).results;
  return { run, results };
}

export interface EvidenceRunRecord { id: string; source: string; environment: Environment; commit_sha: string; branch: string | null; run_url: string | null; started_at: string; finished_at: string; received_at: string; payload_sha256: string }
export interface RunSummary extends EvidenceRunRecord { passed: number; failed: number; skipped: number }

export async function runSummaries(db: Db, opts: { environment?: Environment; source?: string; limit?: number } = {}): Promise<RunSummary[]> {
  const where: string[] = []; const binds: unknown[] = [];
  if (opts.environment) { where.push(`er.environment = ?`); binds.push(opts.environment); }
  if (opts.source) { where.push(`er.source = ?`); binds.push(opts.source); }
  return (await db.prepare(`SELECT er.*, COALESCE(SUM(te.outcome='passed'),0) AS passed, COALESCE(SUM(te.outcome='failed'),0) AS failed, COALESCE(SUM(te.outcome='skipped'),0) AS skipped
     FROM evidence_runs er LEFT JOIN test_evidence te ON te.run_id = er.id ${where.length ? "WHERE " + where.join(" AND ") : ""}
     GROUP BY er.id ORDER BY er.finished_at DESC LIMIT ?`).bind(...binds, opts.limit ?? 20).all<RunSummary>()).results;
}

export async function failedTestsOfRun(db: Db, runId: string) {
  return (await db.prepare(`SELECT requirement_id, test_name, message FROM test_evidence WHERE run_id = ? AND outcome = 'failed' ORDER BY requirement_id`).bind(runId)
    .all<{ requirement_id: string; test_name: string; message: string | null }>()).results;
}

// ───────────── Deployments, integrations, environments (READY-006) ─────────────

export interface DeploymentRecord { id: string; environment: Environment; commit_sha: string; release_id: string | null; url: string | null; initiated_by: string; status: string; rollback_target_deployment_id: string | null; deployed_at: string; ci_run_id: string | null; verification_status: string | null; incident_blocker_id: string | null; notes: string | null }

export async function deployments(db: Db, environment?: Environment, limit = 50): Promise<DeploymentRecord[]> {
  return (await db.prepare(`SELECT * FROM deployments ${environment ? "WHERE environment = ?" : ""} ORDER BY deployed_at DESC LIMIT ?`).bind(...(environment ? [environment] : []), limit).all<DeploymentRecord>()).results;
}

export async function integrationRows(db: Db, environment?: Environment) {
  return (await db.prepare(`SELECT * FROM integration_health ${environment ? "WHERE environment = ?" : ""} ORDER BY integration, environment`).bind(...(environment ? [environment] : []))
    .all<{ integration: string; environment: Environment; status: string; detail: string | null; checked_at: string }>()).results;
}

export async function migrationStatus(db: Db): Promise<{ applied: { name: string; applied_at: string }[] } | null> {
  try { return { applied: (await db.prepare(`SELECT name, applied_at FROM d1_migrations ORDER BY id`).all<{ name: string; applied_at: string }>()).results }; }
  catch { return null; }
}

// ───────────── Blockers (READY-010, §47) ─────────────

export interface BlockerRecord { id: string; category: string; description: string; severity: string; subsystem: string; owner: string; required_action: string; dependency: string | null; status: "open" | "resolved"; created_at: string; resolved_at: string | null; resolution_evidence: string | null; resolved_by?: string | null; updated_at?: string | null }

export async function listBlockers(db: Db): Promise<(BlockerRecord & { requirement_ids: string[] })[]> {
  const rows = (await db.prepare(`SELECT b.*, GROUP_CONCAT(br.requirement_id) AS req_ids FROM blockers b LEFT JOIN blocker_requirements br ON br.blocker_id = b.id
     GROUP BY b.id ORDER BY b.status = 'resolved', CASE b.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, b.id`).all<BlockerRecord & { req_ids: string | null }>()).results;
  return rows.map((r) => ({ ...r, requirement_ids: r.req_ids ? r.req_ids.split(",").sort() : [] }));
}

export async function getBlocker(db: Db, id: string) {
  const b = await db.prepare(`SELECT * FROM blockers WHERE id = ?`).bind(id).first<BlockerRecord>();
  if (!b) return null;
  const reqs = (await db.prepare(`SELECT requirement_id FROM blocker_requirements WHERE blocker_id = ? ORDER BY requirement_id`).bind(id).all<{ requirement_id: string }>()).results.map((r) => r.requirement_id);
  return { ...b, requirement_ids: reqs };
}

export interface BlockerInput { category: string; description: string; severity: string; subsystem: string; owner: string; required_action: string; dependency: string; requirement_ids: string }

async function validateBlocker(db: Db, v: BlockerInput): Promise<string[]> {
  const errors: string[] = [];
  if (!(BLOCKER_CATEGORIES as readonly string[]).includes(v.category)) errors.push("Choose a category");
  if (!(BLOCKER_SEVERITIES as readonly string[]).includes(v.severity)) errors.push("Choose a severity");
  if (v.description.length < 10 || v.description.length > 2000) errors.push("Description must be 10–2,000 characters");
  if (v.subsystem.length < 2 || v.subsystem.length > 100) errors.push("Affected subsystem is required");
  if (v.owner.length < 2 || v.owner.length > 100) errors.push("Owner is required");
  if (v.required_action.length < 5 || v.required_action.length > 2000) errors.push("Required action must be 5–2,000 characters");
  if (v.dependency.length > 300) errors.push("Dependency is too long");
  const ids = parseIds(v.requirement_ids);
  if (ids.length) {
    const known = new Set((await db.prepare(`SELECT id FROM requirements`).all<{ id: string }>()).results.map((r) => r.id));
    const unknown = ids.filter((i) => !known.has(i));
    if (unknown.length) errors.push(`Unknown requirement ids: ${unknown.join(", ")}`);
  }
  return errors;
}

export const parseIds = (s: string) => [...new Set(s.toUpperCase().split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];

export async function nextBlockerId(db: Db): Promise<string> {
  const rows = (await db.prepare(`SELECT id FROM blockers WHERE id LIKE 'BLK-%'`).all<{ id: string }>()).results;
  const max = rows.reduce((m, r) => Math.max(m, parseInt(r.id.slice(4), 10) || 0), 0);
  return `BLK-${String(max + 1).padStart(3, "0")}`;
}

export async function createBlocker(db: Db, userId: string, v: BlockerInput): Promise<string> {
  const errors = await validateBlocker(db, v);
  if (errors.length) throw new ReadinessError(errors.join(". "));
  const id = await nextBlockerId(db);
  const at = nowIso();
  await db.batch([
    db.prepare(`INSERT INTO blockers (id, category, description, severity, subsystem, owner, required_action, dependency, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?, 'open', ?, ?)`)
      .bind(id, v.category, v.description, v.severity, v.subsystem, v.owner, v.required_action, v.dependency || null, at, at),
    ...parseIds(v.requirement_ids).map((r) => db.prepare(`INSERT INTO blocker_requirements (blocker_id, requirement_id) VALUES (?, ?)`).bind(id, r)),
  ]);
  await audit(db, { actorUserId: userId, action: "blocker.created", subjectType: "blocker", subjectId: id, details: { category: v.category, severity: v.severity } });
  return id;
}

export async function updateBlocker(db: Db, userId: string, id: string, v: BlockerInput): Promise<void> {
  const existing = await getBlocker(db, id);
  if (!existing) throw new ReadinessError("Blocker not found", 404);
  const errors = await validateBlocker(db, v);
  if (errors.length) throw new ReadinessError(errors.join(". "));
  await db.batch([
    db.prepare(`UPDATE blockers SET category=?, description=?, severity=?, subsystem=?, owner=?, required_action=?, dependency=?, updated_at=? WHERE id = ?`)
      .bind(v.category, v.description, v.severity, v.subsystem, v.owner, v.required_action, v.dependency || null, nowIso(), id),
    db.prepare(`DELETE FROM blocker_requirements WHERE blocker_id = ?`).bind(id),
    ...parseIds(v.requirement_ids).map((r) => db.prepare(`INSERT INTO blocker_requirements (blocker_id, requirement_id) VALUES (?, ?)`).bind(id, r)),
  ]);
  await audit(db, { actorUserId: userId, action: "blocker.updated", subjectType: "blocker", subjectId: id, details: { before: { ...existing }, requirementIds: parseIds(v.requirement_ids) } });
}

/** Resolution evidence is mandatory (§47): what changed and where it can be verified. */
export async function resolveBlocker(db: Db, userId: string, id: string, evidence: string): Promise<void> {
  const e = evidence.trim();
  if (e.length < 15) throw new ReadinessError("Resolution evidence is required (at least 15 characters): describe what changed and where it can be verified.");
  if (e.length > 4000) throw new ReadinessError("Resolution evidence is too long (4,000 characters maximum).");
  const at = nowIso();
  const res = await db.prepare(`UPDATE blockers SET status='resolved', resolved_at=?, resolution_evidence=?, resolved_by=?, updated_at=? WHERE id = ? AND status = 'open'`).bind(at, e, userId, at, id).run();
  if (res.meta.changes !== 1) throw new ReadinessError("Blocker not found or already resolved", 409);
  await audit(db, { actorUserId: userId, action: "blocker.resolved", subjectType: "blocker", subjectId: id, details: { evidence: e } });
}

export async function reopenBlocker(db: Db, userId: string, id: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new ReadinessError("Give a reason for reopening (at least 5 characters).");
  const res = await db.prepare(`UPDATE blockers SET status='open', resolved_at=NULL, updated_at=? WHERE id = ? AND status = 'resolved'`).bind(nowIso(), id).run();
  if (res.meta.changes !== 1) throw new ReadinessError("Blocker not found or not resolved", 409);
  await audit(db, { actorUserId: userId, action: "blocker.reopened", subjectType: "blocker", subjectId: id, details: { reason: reason.trim() } });
}

// ───────────── Security findings (§64, Gate C) ─────────────

export interface FindingRecord { id: string; title: string; severity: string; release_blocking: number; source: string; status: string; resolution_evidence: string | null; opened_at: string; resolved_at: string | null; detail: string | null; created_by: string | null; resolved_by: string | null }

export async function listFindings(db: Db): Promise<FindingRecord[]> {
  return (await db.prepare(`SELECT * FROM security_findings ORDER BY status <> 'open', CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, opened_at DESC`).all<FindingRecord>()).results;
}

export async function addFinding(db: Db, userId: string, v: { title: string; severity: string; release_blocking: boolean; source: string; detail: string }): Promise<string> {
  const errors: string[] = [];
  if (v.title.length < 5 || v.title.length > 300) errors.push("Title must be 5–300 characters");
  if (!(FINDING_SEVERITIES as readonly string[]).includes(v.severity)) errors.push("Choose a severity");
  if (v.source.length < 2 || v.source.length > 200) errors.push("Source is required (e.g. CodeQL, ASVS review, pen test)");
  if (v.detail.length > 4000) errors.push("Detail is too long");
  if (errors.length) throw new ReadinessError(errors.join(". "));
  const id = newId("sf");
  // Critical and high findings always block release; they cannot be downgraded at entry.
  const blocking = v.release_blocking || v.severity === "critical" || v.severity === "high";
  await db.prepare(`INSERT INTO security_findings (id, title, severity, release_blocking, source, status, opened_at, detail, created_by) VALUES (?,?,?,?,?, 'open', ?, ?, ?)`)
    .bind(id, v.title, v.severity, blocking ? 1 : 0, v.source, nowIso(), v.detail || null, userId).run();
  await audit(db, { actorUserId: userId, action: "security_finding.opened", subjectType: "security_finding", subjectId: id, details: { severity: v.severity, releaseBlocking: blocking } });
  return id;
}

export async function resolveFinding(db: Db, actor: Actor, userId: string, id: string, outcome: string, evidence: string): Promise<void> {
  const e = evidence.trim();
  if (outcome !== "resolved" && outcome !== "accepted_risk") throw new ReadinessError("Choose resolved or accepted risk");
  if (e.length < 15) throw new ReadinessError("Resolution evidence is required (at least 15 characters).");
  const f = await db.prepare(`SELECT * FROM security_findings WHERE id = ?`).bind(id).first<FindingRecord>();
  if (!f || f.status !== "open") throw new ReadinessError("Finding not found or not open", 409);
  if (outcome === "accepted_risk") {
    // Accepting a security risk is a Founder-protected security exception (AIOPS-003 / §8).
    if (!isOwner(actor) || !can(actor, "security.exception")) throw new ReadinessError("Only the Owner can accept a security risk.", 403);
  }
  const at = nowIso();
  const stmts = [db.prepare(`UPDATE security_findings SET status=?, resolution_evidence=?, resolved_at=?, resolved_by=? WHERE id = ? AND status = 'open'`).bind(outcome, e, at, userId, id)];
  if (outcome === "accepted_risk") stmts.push(db.prepare(`INSERT INTO release_approvals (id, kind, approver_user_id, decision, notes, created_at) VALUES (?, 'security_exception', ?, 'approved', ?, ?)`).bind(newId("rap"), userId, `Finding ${id}: ${e}`, at));
  await db.batch(stmts);
  await audit(db, { actorUserId: userId, action: `security_finding.${outcome}`, subjectType: "security_finding", subjectId: id, details: { evidence: e } });
}

// ───────────── Releases & Founder approval (READY-008, READY-009, §45–§46) ─────────────

export interface ReleaseRecord { id: string; commit_sha: string; config_sha256: string; notes: string; rollback_plan: string; created_at: string; created_by: string | null }
export interface ApprovalRecord { id: string; release_id: string | null; kind: string; approver_user_id: string; commit_sha: string | null; config_sha256: string | null; evidence_set_sha256: string | null; decision: string; notes: string | null; invalidated_at: string | null; invalidated_reason: string | null; created_at: string; approver_name?: string | null; approver_is_owner?: number }

export async function listReleases(db: Db): Promise<(ReleaseRecord & { creator_name: string | null })[]> {
  return (await db.prepare(`SELECT r.*, u.display_name AS creator_name FROM releases r LEFT JOIN users u ON u.id = r.created_by ORDER BY r.created_at DESC`).all<ReleaseRecord & { creator_name: string | null }>()).results;
}

export async function currentReleaseCandidate(db: Db): Promise<ReleaseRecord | null> {
  return db.prepare(`SELECT * FROM releases ORDER BY created_at DESC, rowid DESC LIMIT 1`).first<ReleaseRecord>();
}

export async function listApprovals(db: Db, kind?: string): Promise<ApprovalRecord[]> {
  return (await db.prepare(`SELECT a.*, u.display_name AS approver_name,
      EXISTS(SELECT 1 FROM memberships m WHERE m.user_id = a.approver_user_id AND m.role_id = 'owner') AS approver_is_owner
    FROM release_approvals a LEFT JOIN users u ON u.id = a.approver_user_id ${kind ? "WHERE a.kind = ?" : ""} ORDER BY a.created_at DESC`).bind(...(kind ? [kind] : [])).all<ApprovalRecord>()).results;
}

export function validityOf(a: ApprovalRecord, rc: ReleaseRecord | null, evidenceSet: string) {
  return approvalValidity({ ...a, decision: a.decision as "approved" | "rejected", approver_is_owner: !!a.approver_is_owner }, rc ? { commit_sha: rc.commit_sha, config_sha256: rc.config_sha256 } : null, evidenceSet);
}

export async function createReleaseCandidate(db: Db, userId: string, v: { commit_sha: string; config_sha256: string; notes: string; rollback_plan: string }): Promise<string> {
  const errors: string[] = [];
  const commit = v.commit_sha.toLowerCase();
  const cfg = v.config_sha256.toLowerCase();
  if (!SHA_COMMIT.test(commit)) errors.push("Commit must be a 7–40 character hexadecimal git SHA");
  if (!SHA_256.test(cfg)) errors.push("Configuration digest must be a 64-character SHA-256 hex value");
  if (v.notes.length < 10 || v.notes.length > 10_000) errors.push("Release notes must be 10–10,000 characters");
  if (v.rollback_plan.length < 10 || v.rollback_plan.length > 5000) errors.push("Rollback plan must be 10–5,000 characters");
  if (errors.length) throw new ReadinessError(errors.join(". "));
  const id = newId("rel");
  const at = nowIso();
  // A new candidate supersedes every outstanding launch approval (§45: change after approval requires re-evaluation).
  await db.batch([
    db.prepare(`INSERT INTO releases (id, commit_sha, config_sha256, notes, rollback_plan, created_at, created_by) VALUES (?,?,?,?,?,?,?)`).bind(id, commit, cfg, v.notes, v.rollback_plan, at, userId),
    db.prepare(`UPDATE release_approvals SET invalidated_at = ?, invalidated_reason = ? WHERE kind = 'production_launch' AND invalidated_at IS NULL AND (release_id IS NULL OR release_id <> ?)`)
      .bind(at, `Superseded by release candidate ${id} (${commit.slice(0, 12)})`, id),
  ]);
  await audit(db, { actorUserId: userId, action: "release.candidate_created", subjectType: "release", subjectId: id, details: { commit, config: cfg } });
  return id;
}

/**
 * Records the Founder's launch decision bound to the current release candidate commit, config and
 * evidence set. Only the Owner, with MFA, in a user session (never AI/automation) may do this.
 */
export async function recordFounderDecision(ctx: Pick<AppContext, "db" | "now" | "ip">, actor: Actor, userId: string, v: { decision: string; notes: string; confirmCommit: string; expectedEvidenceSet: string }): Promise<string> {
  if (actor.kind !== "user" || !isOwner(actor) || !can(actor, "release.approve_production")) throw new ReadinessError("Only the Owner can record a production launch decision.", 403);
  if (v.decision !== "approved" && v.decision !== "rejected") throw new ReadinessError("Choose approve or reject");
  const rc = await currentReleaseCandidate(ctx.db);
  if (!rc) throw new ReadinessError("There is no release candidate to decide on.", 409);
  if (v.confirmCommit.trim().toLowerCase() !== rc.commit_sha) throw new ReadinessError("Type the release candidate commit exactly to confirm which build you are deciding on.");
  const { report } = await loadReport(ctx);
  if (v.expectedEvidenceSet !== report.evidenceSetSha256) throw new ReadinessError("The evidence set changed while you were reviewing. Review the updated evidence and decide again.", 409);
  if (v.notes.length > 4000) throw new ReadinessError("Notes are too long");
  const id = newId("rap");
  await ctx.db.prepare(`INSERT INTO release_approvals (id, release_id, kind, approver_user_id, commit_sha, config_sha256, evidence_set_sha256, decision, notes, created_at) VALUES (?,?, 'production_launch', ?,?,?,?,?,?,?)`)
    .bind(id, rc.id, userId, rc.commit_sha, rc.config_sha256, report.evidenceSetSha256, v.decision, v.notes || null, nowIso(ctx.now)).run();
  await audit(ctx.db, { actorUserId: userId, action: `release.founder_${v.decision}`, subjectType: "release", subjectId: rc.id, ip: ctx.ip,
    details: { approvalId: id, commit: rc.commit_sha, config: rc.config_sha256, evidenceSet: report.evidenceSetSha256, gates: report.gates.map((g) => `${g.id}:${g.status}`) } });
  return id;
}

export interface TimelineEvent { at: string; kind: "release" | "approval" | "deployment" | "invalidation"; title: string; detail: string; status: string; ref: string }

export async function releaseTimeline(db: Db): Promise<TimelineEvent[]> {
  const events: TimelineEvent[] = [];
  for (const r of await listReleases(db)) events.push({ at: r.created_at, kind: "release", title: `Release candidate ${r.id}`, detail: `Commit ${r.commit_sha} · config ${r.config_sha256.slice(0, 12)}… · by ${r.creator_name ?? "unknown"}`, status: "draft", ref: r.id });
  for (const a of await listApprovals(db)) {
    events.push({ at: a.created_at, kind: "approval", title: `${a.kind === "production_launch" ? "Founder launch decision" : a.kind === "security_exception" ? "Security exception" : "Scope disposition"}: ${a.decision}`,
      detail: `${a.approver_name ?? a.approver_user_id}${a.approver_is_owner ? " (Owner)" : " (NOT Owner)"}${a.commit_sha ? ` · commit ${a.commit_sha}` : ""}${a.evidence_set_sha256 ? ` · evidence ${a.evidence_set_sha256.slice(0, 12)}…` : ""}`, status: a.decision, ref: a.id });
    if (a.invalidated_at) events.push({ at: a.invalidated_at, kind: "invalidation", title: `Approval ${a.id} invalidated`, detail: a.invalidated_reason ?? "", status: "stale", ref: a.id });
  }
  for (const d of await deployments(db)) events.push({ at: d.deployed_at, kind: "deployment", title: `${d.environment} deployment ${d.id}`,
    detail: `Commit ${d.commit_sha} · by ${d.initiated_by}${d.release_id ? ` · release ${d.release_id}` : ""}${d.ci_run_id ? ` · CI ${d.ci_run_id}` : ""} · verification ${d.verification_status ?? "not recorded"}${d.rollback_target_deployment_id ? ` · rollback target ${d.rollback_target_deployment_id}` : ""}${d.incident_blocker_id ? ` · incident ${d.incident_blocker_id}` : ""}`,
    status: d.status, ref: d.id });
  return events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

// ───────────── Snapshots & evidence packet (READY-011, §48) ─────────────

export function reportSummary(report: Report) {
  const byState: Record<string, number> = {};
  for (const r of report.requirements) byState[r.state] = (byState[r.state] ?? 0) + 1;
  return {
    generatedAt: report.generatedAt, evidenceSetSha256: report.evidenceSetSha256, scores: report.scores,
    gates: report.gates.map((g) => ({ id: g.id, name: g.name, status: g.status, currentEvidence: g.currentEvidence, blockers: g.blockers })),
    decision: report.decision, selfHealth: report.selfHealth, byState,
    openBlockers: report.blockers.filter((b) => b.status === "open").length,
  };
}
export type ReportSummary = ReturnType<typeof reportSummary>;

export async function saveSnapshot(ctx: Pick<AppContext, "db" | "now">, userId: string): Promise<string> {
  const { report } = await loadReport(ctx);
  const id = newId("snap");
  const inv = (await ctx.db.prepare(`SELECT inventory_version FROM requirements LIMIT 1`).first<{ inventory_version: string }>())?.inventory_version ?? "unknown";
  await ctx.db.prepare(`INSERT INTO readiness_snapshots (id, taken_at, inventory_version, summary_json, taken_by) VALUES (?,?,?,?,?)`).bind(id, report.generatedAt, inv, JSON.stringify(reportSummary(report)), userId).run();
  await audit(ctx.db, { actorUserId: userId, action: "readiness.snapshot_saved", subjectType: "readiness_snapshot", subjectId: id });
  return id;
}

export async function listSnapshots(db: Db) {
  return (await db.prepare(`SELECT s.id, s.taken_at, s.inventory_version, s.summary_json, u.display_name AS taken_by_name FROM readiness_snapshots s LEFT JOIN users u ON u.id = s.taken_by ORDER BY s.taken_at DESC LIMIT 200`)
    .all<{ id: string; taken_at: string; inventory_version: string; summary_json: string; taken_by_name: string | null }>()).results
    .map((s) => ({ ...s, summary: JSON.parse(s.summary_json) as ReportSummary }));
}

export async function getSnapshot(db: Db, id: string) {
  const s = await db.prepare(`SELECT s.*, u.display_name AS taken_by_name FROM readiness_snapshots s LEFT JOIN users u ON u.id = s.taken_by WHERE s.id = ?`).bind(id)
    .first<{ id: string; taken_at: string; inventory_version: string; summary_json: string; taken_by_name: string | null }>();
  return s ? { ...s, summary: JSON.parse(s.summary_json) as ReportSummary } : null;
}

/** Release evidence packet: the authoritative report plus the raw records it was derived from, hashed. */
export async function evidencePacket(ctx: Pick<AppContext, "db" | "now" | "env">): Promise<{ body: string; sha256: string; generatedAt: string }> {
  const { report } = await loadReport(ctx);
  const all = async <T>(sql: string) => (await ctx.db.prepare(sql).all<T>()).results;
  const gh = await latestGithubSync(ctx.db);
  const packet = {
    packetVersion: 1,
    environment: ctx.env.ENVIRONMENT,
    generatedAt: report.generatedAt,
    report,
    evidenceRuns: await all(`SELECT * FROM evidence_runs ORDER BY finished_at`),
    testEvidence: await all(`SELECT run_id, requirement_id, test_name, outcome, duration_ms, message FROM test_evidence ORDER BY run_id, requirement_id, test_name`),
    blockers: await listBlockers(ctx.db),
    securityFindings: await listFindings(ctx.db),
    releases: await listReleases(ctx.db),
    approvals: await listApprovals(ctx.db),
    deployments: await deployments(ctx.db, undefined, 1000),
    integrationHealth: await integrationRows(ctx.db),
    ingestionStatus: await all(`SELECT * FROM ingestion_status ORDER BY source`),
    github: gh.latest ? { fetchedAt: gh.latest.fetched_at, ok: !!gh.latest.ok, error: gh.latest.error } : null,
  };
  const packetJson = JSON.stringify(packet);
  const sha256 = await sha256Hex(packetJson);
  return { body: `{"sha256":"${sha256}","algorithm":"SHA-256 over the UTF-8 JSON text of \\"packet\\" exactly as serialised here","packet":${packetJson}}`, sha256, generatedAt: report.generatedAt };
}

/** Last verification timestamp per gate, from the records each gate is evaluated on. */
export async function gateLastVerification(db: Db): Promise<Record<string, string | null>> {
  const one = async (sql: string) => (await db.prepare(sql).first<{ at: string | null }>())?.at ?? null;
  const reqSync = await one(`SELECT MAX(updated_at) AS at FROM requirements`);
  const ci = await one(`SELECT MAX(finished_at) AS at FROM evidence_runs WHERE source = 'ci'`);
  const staging = await one(`SELECT MAX(finished_at) AS at FROM evidence_runs WHERE environment = 'staging'`);
  const sec = await one(`SELECT MAX(COALESCE(resolved_at, opened_at)) AS at FROM security_findings`);
  const approval = await one(`SELECT MAX(created_at) AS at FROM release_approvals WHERE kind = 'production_launch'`);
  const prod = await one(`SELECT MAX(finished_at) AS at FROM evidence_runs WHERE environment = 'production' AND source = 'production_check'`);
  const max = (...xs: (string | null)[]) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;
  return { A: reqSync, B: ci, C: max(sec, staging), D: staging, E: staging, F: reqSync, G: approval, H: prod };
}
