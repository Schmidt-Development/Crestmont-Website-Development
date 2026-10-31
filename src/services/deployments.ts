// Deployment recorder, release authorization, release-candidate intake and environment probes
// (INFRA-005, READY-006, READY-009, LAUNCH-002, LAUNCH-003, §43, §46, §79).
//
// Everything here is either written by signed automation (GitHub Actions → HMAC with
// EVIDENCE_INGEST_SECRET, the same scheme as /api/readiness/evidence) or read-only. Nothing here can
// grant a Founder approval: release authorization only REPORTS whether a valid Owner approval exists
// for exactly the requested commit, using the same approvalValidity() that drives Gate G.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import type { AppContext } from "../app/context.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { parse, v } from "../lib/validate.ts";
import { approvalValidity } from "../readiness/engine.ts";
import { ingestEvidence } from "../readiness/ingest.ts";
import { audit } from "./security.ts";
import { allowEgressHost } from "../lib/egress.ts";
import * as ra from "./readiness-admin.ts";

export class DeploymentError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}

const FULL_SHA = /^[0-9a-f]{40}$/;

// ───────────── Deployment recorder (READY-009) ─────────────

const deploymentSchema = v.object({
  deploymentId: v.string({ min: 3, max: 120, pattern: /^[A-Za-z0-9._:-]+$/ }),
  environment: v.enumOf(["development", "staging", "production"] as const),
  commitSha: v.string({ pattern: /^[0-9a-fA-F]{7,40}$/ }),
  url: v.string({ optional: true, max: 300, pattern: /^https:\/\/[^\s/?#]+(\/[^\s]*)?$/ }),
  status: v.enumOf(["started", "succeeded", "failed", "rolled_back"] as const),
  initiatedBy: v.string({ min: 1, max: 200 }),
  releaseId: v.string({ optional: true, max: 120, pattern: /^[A-Za-z0-9_.-]+$/ }),
  rollbackTargetDeploymentId: v.string({ optional: true, max: 120, pattern: /^[A-Za-z0-9._:-]+$/ }),
  ciRunId: v.string({ optional: true, max: 200, pattern: /^[A-Za-z0-9._:-]+$/ }),
  runUrl: v.string({ optional: true, max: 500, pattern: /^https:\/\// }),
  verificationStatus: v.enumOf(["not_verified", "passed", "failed"] as const, { optional: true }),
  notes: v.string({ optional: true, max: 2000 }),
  deployedAt: v.string({ optional: true, pattern: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/ }),
});
export type DeploymentDoc = ReturnType<typeof parseDeployment>;
export function parseDeployment(json: unknown) { return parse(deploymentSchema, json); }

// Allowed status changes for an existing record. A deployment never goes back to "started", and a
// rolled-back deployment is final.
const NEXT: Record<string, string[]> = {
  started: ["started", "succeeded", "failed", "rolled_back"],
  succeeded: ["succeeded", "rolled_back"],
  failed: ["failed", "rolled_back"],
  rolled_back: ["rolled_back"],
};

export interface ReleaseCheck { result: "matches_approved_release" | "mismatch" | "not_applicable"; detail: string; approvedCommit: string | null }

/** The release candidate bound to the latest Owner-approved, non-invalidated production launch approval. */
async function approvedRelease(db: Db): Promise<{ approvalId: string; releaseId: string | null; commit: string; evidenceSet: string | null } | null> {
  const a = (await ra.listApprovals(db, "production_launch")).find((x) => x.decision === "approved" && !x.invalidated_at && !!x.approver_is_owner && x.commit_sha);
  return a ? { approvalId: a.id, releaseId: a.release_id, commit: a.commit_sha!, evidenceSet: a.evidence_set_sha256 } : null;
}

/**
 * LAUNCH-002: does this production deployment's commit equal the commit of the release candidate
 * the Founder approved? Evidence-set drift is reported in the detail but does not by itself make
 * the deployment a mismatch (the deploy workflow refuses to run without full validity).
 */
export async function releaseCheckFor(ctx: Pick<AppContext, "db" | "now">, environment: string, commit: string): Promise<ReleaseCheck> {
  if (environment !== "production") return { result: "not_applicable", detail: "Only production deployments are bound to a Founder-approved release candidate.", approvedCommit: null };
  const approved = await approvedRelease(ctx.db);
  if (!approved) return { result: "mismatch", detail: "No valid Founder production approval exists, so no commit is approved for production.", approvedCommit: null };
  if (approved.commit.toLowerCase() !== commit.toLowerCase()) {
    return { result: "mismatch", detail: `Deployed commit ${commit} differs from the approved release candidate commit ${approved.commit} (approval ${approved.approvalId}).`, approvedCommit: approved.commit };
  }
  const { report } = await ra.loadReport(ctx);
  const drift = approved.evidenceSet && approved.evidenceSet !== report.evidenceSetSha256 ? " The evidence set has changed since approval; affected gates need re-evaluation." : "";
  return { result: "matches_approved_release", detail: `Commit matches the approved release candidate (approval ${approved.approvalId}).${drift}`, approvedCommit: approved.commit };
}

export interface RecordResult { status: "recorded" | "updated"; deploymentId: string; releaseCheck: ReleaseCheck["result"] | null; incidentBlockerId: string | null; rollbackTargetDeploymentId: string | null }

export async function recordDeployment(ctx: Pick<AppContext, "db" | "now">, rawBody: string): Promise<RecordResult> {
  const doc = parseDeployment(JSON.parse(rawBody));
  const db = ctx.db;
  const commit = doc.commitSha.toLowerCase();
  if (doc.environment === "production" && !FULL_SHA.test(commit)) throw new DeploymentError("Production deployments must be recorded with the full 40-character commit SHA.");
  if (doc.releaseId && !(await db.prepare(`SELECT 1 FROM releases WHERE id = ?`).bind(doc.releaseId).first())) throw new DeploymentError(`Unknown release ${doc.releaseId}`);

  const existing = await db.prepare(`SELECT * FROM deployments WHERE id = ?`).bind(doc.deploymentId).first<ra.DeploymentRecord>();
  const at = nowIso(ctx.now);

  let rollbackTarget = doc.rollbackTargetDeploymentId ?? null;
  if (rollbackTarget) {
    if (rollbackTarget === doc.deploymentId) throw new DeploymentError("A deployment cannot be its own rollback target.");
    const t = await db.prepare(`SELECT environment, status FROM deployments WHERE id = ?`).bind(rollbackTarget).first<{ environment: string; status: string }>();
    if (!t) throw new DeploymentError(`Rollback target ${rollbackTarget} is not a recorded deployment.`);
    if (t.environment !== doc.environment) throw new DeploymentError(`Rollback target ${rollbackTarget} is a ${t.environment} deployment, not ${doc.environment}.`);
    if (t.status !== "succeeded") throw new DeploymentError(`Rollback target ${rollbackTarget} did not succeed (${t.status}).`);
  }

  if (existing) {
    if (existing.environment !== doc.environment || existing.commit_sha !== commit) throw new DeploymentError(`Deployment ${doc.deploymentId} is already recorded for ${existing.environment} @ ${existing.commit_sha}; ids cannot be reused.`, 409);
    if (!NEXT[existing.status].includes(doc.status)) throw new DeploymentError(`Deployment ${doc.deploymentId} cannot change from ${existing.status} to ${doc.status}.`, 409);
    await db.prepare(`UPDATE deployments SET status = ?, verification_status = COALESCE(?, verification_status), url = COALESCE(?, url),
        rollback_target_deployment_id = COALESCE(?, rollback_target_deployment_id), notes = COALESCE(?, notes), run_url = COALESCE(?, run_url), updated_at = ? WHERE id = ?`)
      .bind(doc.status, doc.verificationStatus ?? null, doc.url ?? null, rollbackTarget, doc.notes ?? null, doc.runUrl ?? null, at, doc.deploymentId).run();
    await audit(db, { actorKind: "system", action: "deployment.updated", subjectType: "deployment", subjectId: doc.deploymentId,
      details: { from: existing.status, to: doc.status, verification: doc.verificationStatus ?? null, by: doc.initiatedBy } });
    return { status: "updated", deploymentId: doc.deploymentId, releaseCheck: (existing as { release_check?: ReleaseCheck["result"] }).release_check ?? null, incidentBlockerId: existing.incident_blocker_id, rollbackTargetDeploymentId: rollbackTarget ?? existing.rollback_target_deployment_id };
  }

  // Default rollback target: the most recent earlier successful deployment in the same environment.
  if (!rollbackTarget) {
    rollbackTarget = (await db.prepare(`SELECT id FROM deployments WHERE environment = ? AND status = 'succeeded' ORDER BY deployed_at DESC LIMIT 1`).bind(doc.environment).first<{ id: string }>())?.id ?? null;
  }

  const check = await releaseCheckFor(ctx, doc.environment, commit);
  let incident: string | null = null;
  const stmts = [db.prepare(`INSERT INTO deployments (id, environment, commit_sha, release_id, url, initiated_by, status, rollback_target_deployment_id, deployed_at, ci_run_id, verification_status, notes, release_check, release_check_detail, run_url, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(doc.deploymentId, doc.environment, commit, doc.releaseId ?? null, doc.url ?? null, doc.initiatedBy, doc.status, rollbackTarget, doc.deployedAt ?? at,
      doc.ciRunId ?? null, doc.verificationStatus ?? (doc.status === "succeeded" ? "not_verified" : null), doc.notes ?? null, check.result, check.detail, doc.runUrl ?? null, at)];
  if (check.result === "mismatch" && doc.status !== "failed") {
    // §79: the production deployment must match the approved release candidate. A mismatch is a
    // production incident: it blocks Gate H and appears in the production view's blocker list.
    incident = await ra.nextBlockerId(db);
    stmts.unshift(db.prepare(`INSERT INTO blockers (id, category, description, severity, subsystem, owner, required_action, dependency, status, created_at, updated_at) VALUES (?, 'production_incident', ?, 'critical', 'Launch', 'Founder', ?, NULL, 'open', ?, ?)`)
      .bind(incident, `Production deployment ${doc.deploymentId} (commit ${commit}) does not match the Founder-approved release candidate. ${check.detail}`.slice(0, 2000),
        "Roll back to the approved release (wrangler rollback) or obtain a new Founder approval for this exact commit, then resolve this blocker with evidence.", at, at));
    stmts.push(db.prepare(`INSERT INTO blocker_requirements (blocker_id, requirement_id) SELECT ?, 'LAUNCH-002' WHERE EXISTS (SELECT 1 FROM requirements WHERE id = 'LAUNCH-002')`).bind(incident));
    stmts.push(db.prepare(`UPDATE deployments SET incident_blocker_id = ? WHERE id = ?`).bind(incident, doc.deploymentId));
  }
  await db.batch(stmts);
  await audit(db, { actorKind: "system", action: "deployment.recorded", subjectType: "deployment", subjectId: doc.deploymentId,
    details: { environment: doc.environment, commit, status: doc.status, by: doc.initiatedBy, releaseCheck: check.result, incident, rollbackTarget } });
  return { status: "recorded", deploymentId: doc.deploymentId, releaseCheck: check.result, incidentBlockerId: incident, rollbackTargetDeploymentId: rollbackTarget };
}

export interface DeploymentView extends ra.DeploymentRecord { release_check: string | null; release_check_detail: string | null; run_url: string | null; updated_at: string | null }

export async function listDeployments(db: Db, environment?: string, limit = 100): Promise<DeploymentView[]> {
  return (await db.prepare(`SELECT * FROM deployments ${environment ? "WHERE environment = ?" : ""} ORDER BY deployed_at DESC LIMIT ?`).bind(...(environment ? [environment] : []), limit).all<DeploymentView>()).results;
}

// ───────────── Release authorization (LAUNCH-002, read-only) ─────────────

export interface Authorization {
  authorized: boolean; commit: string; reason: string;
  releaseCandidate: { id: string; commit: string; createdAt: string } | null;
  approval: { id: string; decidedAt: string; evidenceSetSha256: string | null } | null;
  currentEvidenceSetSha256: string; gates: { id: string; status: string }[]; checkedAt: string;
}

/**
 * Whether a valid Founder production approval exists for EXACTLY this commit and the current
 * evidence set. Never writes anything and never grants anything.
 */
export async function releaseAuthorization(ctx: Pick<AppContext, "db" | "now"> & { env?: Pick<AppContext["env"], "FOUNDER_EMAIL"> }, commitRaw: string): Promise<Authorization> {
  const commit = commitRaw.trim().toLowerCase();
  const { report } = await ra.loadReport(ctx);
  const rc = await ra.currentReleaseCandidate(ctx.db);
  const latest = (await ra.listApprovals(ctx.db, "production_launch"))[0];
  const base = {
    commit, currentEvidenceSetSha256: report.evidenceSetSha256, gates: report.gates.map((g) => ({ id: g.id, status: g.status })), checkedAt: report.generatedAt,
    releaseCandidate: rc ? { id: rc.id, commit: rc.commit_sha, createdAt: rc.created_at } : null,
    approval: latest ? { id: latest.id, decidedAt: latest.created_at, evidenceSetSha256: latest.evidence_set_sha256 } : null,
  };
  const no = (reason: string): Authorization => ({ ...base, authorized: false, reason });
  if (!FULL_SHA.test(commit)) return no("A full 40-character commit SHA is required.");
  if (!rc) return no("There is no release candidate.");
  if (!FULL_SHA.test(rc.commit_sha)) return no("The current release candidate was not created with a full 40-character commit SHA; create it again with the full SHA.");
  if (rc.commit_sha !== commit) return no(`Commit ${commit} is not the current release candidate (${rc.commit_sha}).`);
  if (!latest) return no("No Founder production approval has been recorded.");
  if (latest.release_id !== rc.id) return no("The latest Founder decision is not for the current release candidate.");
  // CREST-GAP-020: an approval by a demo Owner account, or by anyone other than FOUNDER_EMAIL when it is set, never authorizes.
  const notFounder = ra.founderProblem(await ra.approverEmail(ctx.db, latest.approver_user_id), ctx.env?.FOUNDER_EMAIL);
  if (notFounder) return no(`The latest launch approval was refused: ${notFounder}.`);
  const valid = approvalValidity({ ...latest, decision: latest.decision as "approved" | "rejected", approver_is_owner: !!latest.approver_is_owner },
    { commit_sha: rc.commit_sha, config_sha256: rc.config_sha256 }, report.evidenceSetSha256);
  return valid.valid ? { ...base, authorized: true, reason: valid.reason } : no(valid.reason);
}

// ───────────── Release candidates from tags (INFRA-005) ─────────────

const candidateSchema = v.object({
  tag: v.string({ min: 2, max: 100, pattern: /^v[0-9A-Za-z._-]+$/ }),
  commitSha: v.string({ pattern: /^[0-9a-f]{40}$/ }),
  configSha256: v.string({ pattern: /^[0-9a-f]{64}$/ }),
  notes: v.string({ min: 10, max: 10_000 }),
  rollbackPlan: v.string({ min: 10, max: 5000 }),
  runUrl: v.string({ optional: true, max: 500, pattern: /^https:\/\// }),
});

/**
 * Creates a release candidate from a release tag (signed automation). Idempotent: if the current
 * candidate already has this commit and configuration, it is returned unchanged, so re-running the
 * release workflow never invalidates a Founder approval for the same build. A different build
 * supersedes outstanding approvals exactly like the staff form does (§45).
 */
export async function createCandidateFromTag(ctx: Pick<AppContext, "db" | "now">, rawBody: string): Promise<{ status: "created" | "unchanged"; releaseId: string }> {
  const d = parse(candidateSchema, JSON.parse(rawBody));
  const rc = await ra.currentReleaseCandidate(ctx.db);
  if (rc && rc.commit_sha === d.commitSha && rc.config_sha256 === d.configSha256) return { status: "unchanged", releaseId: rc.id };
  const id = newId("rel");
  const at = nowIso(ctx.now);
  await ctx.db.batch([
    ctx.db.prepare(`INSERT INTO releases (id, commit_sha, config_sha256, notes, rollback_plan, created_at, created_by) VALUES (?,?,?,?,?,?, NULL)`)
      .bind(id, d.commitSha, d.configSha256, `Tag ${d.tag}\n\n${d.notes}`, d.rollbackPlan, at),
    ctx.db.prepare(`UPDATE release_approvals SET invalidated_at = ?, invalidated_reason = ? WHERE kind = 'production_launch' AND invalidated_at IS NULL AND (release_id IS NULL OR release_id <> ?)`)
      .bind(at, `Superseded by release candidate ${id} (${d.tag}, ${d.commitSha.slice(0, 12)})`, id),
  ]);
  await audit(ctx.db, { actorKind: "system", action: "release.candidate_created", subjectType: "release", subjectId: id, details: { tag: d.tag, commit: d.commitSha, config: d.configSha256, runUrl: d.runUrl ?? null } });
  return { status: "created", releaseId: id };
}

// ───────────── Environment probe (READY-006, §43) ─────────────

export const PROBE_ENVIRONMENTS = ["staging", "production"] as const;
export const envUrlKey = (env: string) => `env.${env}.url`;

/** Environment URLs must be public https hosts (staff-set; SSRF guard against internal targets). */
export function validEnvUrl(u: string): string | null {
  let url: URL;
  try { url = new URL(u); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const h = url.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return null;
  if (/^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return null; // IP literals
  return `${url.protocol}//${url.host}`;
}

export interface ProbeOutcome { environment: string; ran: boolean; detail: string; dns?: string; health?: string; evidenceRunId?: string | null }

async function writeHealth(db: Db, integration: string, env: string, status: string, detail: string) {
  await db.prepare(`INSERT INTO integration_health (integration, environment, status, detail, checked_at) VALUES (?,?,?,?,?)
    ON CONFLICT(integration, environment) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at, config_fingerprint = NULL, verified_at = NULL`)
    .bind(integration, env, status, detail.slice(0, 1000), nowIso()).run();
}

/**
 * Probes each configured environment URL: DNS resolution (DNS-over-HTTPS), TLS (an HTTPS request
 * that completes certificate validation) and service health (/api/health). Writes integration_health
 * rows 'dns' and 'monitoring' for that environment. For production, a production_check evidence run
 * is recorded only when the probe ran AND (the deployed commit is new to the probe or the outcome
 * changed), so routine probes do not churn the approval evidence set. Unconfigured environments are
 * skipped and nothing is written for them.
 */
export async function probeEnvironments(ctx: Pick<AppContext, "db" | "settings" | "now">, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<ProbeOutcome[]> {
  const out: ProbeOutcome[] = [];
  for (const env of PROBE_ENVIRONMENTS) {
    const configured = ctx.settings[envUrlKey(env)];
    if (!configured) { out.push({ environment: env, ran: false, detail: `skipped: ${envUrlKey(env)} not set` }); continue; }
    const origin = validEnvUrl(configured);
    if (!origin) { out.push({ environment: env, ran: false, detail: `skipped: ${envUrlKey(env)} is not a public https URL` }); continue; }
    const host = new URL(origin).hostname;
    const checkedAt = nowIso(ctx.now);
    let dnsOk = false, dnsDetail = "", healthOk = false, tlsOk = false, healthDetail = "";
    const releaseHost = allowEgressHost(host); // validated public https URL configured by the Owner (F-11)
    try {

    // DNS
    try {
      const r = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs) });
      const b = (await r.json().catch(() => null)) as { Status?: number; Answer?: { data?: string }[] } | null;
      const answers = (b?.Answer ?? []).map((a) => a.data).filter(Boolean);
      dnsOk = r.ok && b?.Status === 0 && answers.length > 0;
      dnsDetail = dnsOk ? `${host} resolves (${answers.slice(0, 4).join(", ")})` : `${host} did not resolve (HTTP ${r.status}, DNS status ${String(b?.Status)})`;
    } catch (e) { dnsDetail = `DNS lookup for ${host} failed: ${(e as Error).message.slice(0, 200)}`; }

    // TLS + health
    const started = Date.now();
    try {
      const r = await fetchImpl(`${origin}/api/health`, { headers: { accept: "application/json", "user-agent": "crestmont-env-probe" }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      tlsOk = true; // the HTTPS request completed, so the certificate validated for this host
      const b = (await r.json().catch(() => null)) as { status?: string; environment?: string } | null;
      healthOk = r.status === 200 && b?.status === "ok" && b?.environment === env;
      healthDetail = healthOk ? `/api/health 200 ok (${env}) in ${Date.now() - started} ms`
        : `/api/health returned HTTP ${r.status}${b?.environment && b.environment !== env ? ` for environment "${b.environment}" (expected ${env})` : ""}${b?.status ? `, status ${b.status}` : ""}`;
    } catch (e) { healthDetail = `HTTPS request to ${origin} failed (TLS, connection or timeout): ${(e as Error).message.slice(0, 200)}`; }
    } finally { releaseHost(); }

    await writeHealth(ctx.db, "dns", env, dnsOk && tlsOk ? "configured_unverified" : "failing",
      `${dnsDetail}; TLS ${tlsOk ? "valid (HTTPS request completed)" : "not confirmed"}. Probed ${checkedAt}. DNS zone control is not verified by this probe.`);
    await writeHealth(ctx.db, "monitoring", env, healthOk ? "configured_unverified" : "failing",
      `In-platform scheduled probe: ${healthDetail}. No external alert routing is configured; nobody is paged automatically.`);

    let evidenceRunId: string | null = null;
    if (env === "production") evidenceRunId = await recordProbeEvidence(ctx, origin, dnsOk && tlsOk, healthOk, dnsDetail, healthDetail, checkedAt);
    out.push({ environment: env, ran: true, detail: `${dnsOk ? "dns ok" : "dns failing"}, ${tlsOk ? "tls ok" : "tls failing"}, ${healthOk ? "health ok" : "health failing"}`, dns: dnsDetail, health: healthDetail, evidenceRunId });
  }
  return out;
}

async function recordProbeEvidence(ctx: Pick<AppContext, "db">, origin: string, domainOk: boolean, healthOk: boolean, dnsDetail: string, healthDetail: string, at: string): Promise<string | null> {
  const dep = await ctx.db.prepare(`SELECT commit_sha FROM deployments WHERE environment = 'production' AND status = 'succeeded' ORDER BY deployed_at DESC LIMIT 1`).first<{ commit_sha: string }>();
  if (!dep) return null; // evidence must name the deployed commit; without a recorded deployment there is none
  const outcome = `${domainOk ? "p" : "f"}${healthOk ? "p" : "f"}`;
  const last = await ctx.db.prepare(`SELECT id, commit_sha FROM evidence_runs WHERE id LIKE 'probe-production-%' ORDER BY finished_at DESC LIMIT 1`).first<{ id: string; commit_sha: string }>();
  if (last && last.commit_sha === dep.commit_sha) {
    const rows = (await ctx.db.prepare(`SELECT requirement_id, outcome FROM test_evidence WHERE run_id = ?`).bind(last.id).all<{ requirement_id: string; outcome: string }>()).results;
    const was = `${rows.find((r) => r.requirement_id === "READY-006")?.outcome === "passed" ? "p" : "f"}${rows.find((r) => r.requirement_id === "INFRA-006")?.outcome === "passed" ? "p" : "f"}`;
    if (was === outcome) return null; // unchanged for the same deployed commit: no evidence churn
  }
  const runId = `probe-production-${at.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const body = JSON.stringify({
    runId, source: "production_check", environment: "production", commitSha: dep.commit_sha, startedAt: at, finishedAt: nowIso(),
    results: [
      { requirementId: "READY-006", testName: `scheduled production domain/TLS probe of ${origin}`, outcome: domainOk ? "passed" : "failed", ...(domainOk ? {} : { message: dnsDetail.slice(0, 1000) }) },
      { requirementId: "INFRA-006", testName: `scheduled production health probe ${origin}/api/health`, outcome: healthOk ? "passed" : "failed", ...(healthOk ? {} : { message: healthDetail.slice(0, 1000) }) },
    ],
  });
  const r = await ingestEvidence(ctx.db, body);
  return r.status === "ingested" ? runId : null;
}

/** Environment URLs and the latest probe-written health rows, for the ops page. */
export async function environmentStatus(db: Db, settings: Record<string, string>) {
  const rows = (await db.prepare(`SELECT integration, environment, status, detail, checked_at FROM integration_health WHERE integration IN ('dns','monitoring') AND environment IN ('staging','production')`)
    .all<{ integration: string; environment: string; status: string; detail: string | null; checked_at: string }>()).results;
  return PROBE_ENVIRONMENTS.map((env) => ({ environment: env, url: settings[envUrlKey(env)] ?? null, rows: rows.filter((r) => r.environment === env) }));
}

export async function saveEnvUrl(db: Db, userId: string, env: string, value: string): Promise<void> {
  if (!(PROBE_ENVIRONMENTS as readonly string[]).includes(env)) throw new DeploymentError("Unknown environment");
  const key = envUrlKey(env);
  if (!value) {
    await db.prepare(`DELETE FROM business_settings WHERE key = ?`).bind(key).run();
  } else {
    const origin = validEnvUrl(value);
    if (!origin) throw new DeploymentError("Enter a public https URL (no IP addresses, ports, credentials or internal hostnames).");
    await db.prepare(`INSERT INTO business_settings (key, value, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(key, origin, userId, nowIso()).run();
  }
  await audit(db, { actorUserId: userId, action: "settings.updated", subjectType: "business_settings", subjectId: key, details: { value: value ? validEnvUrl(value) : null } });
}

/** Hash used by scripts and tests to bind a release candidate to the deployment configuration. */
export async function configDigest(wranglerToml: string): Promise<string> {
  return sha256Hex(wranglerToml.replace(/\r\n/g, "\n"));
}
