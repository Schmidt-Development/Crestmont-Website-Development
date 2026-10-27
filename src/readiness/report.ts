// Loads readiness records from the database and produces the authoritative report.
// The JSON API, CSV export and evidence packet all call buildReport() (§48).
import type { Db } from "../lib/db.ts";
import { sha256Hex } from "../lib/crypto.ts";
import {
  computeGates, computeRequirementStatuses, computeScores, evidenceSetHash, ingestionHealth, launchDecision,
  type ApprovalRow, type BlockerRow, type EvidenceRow, type FindingRow, type IngestionRow, type IntegrationRow, type ReadinessInput, type RequirementRow,
} from "./engine.ts";

export async function loadReadinessInput(db: Db, now = new Date()): Promise<ReadinessInput> {
  const all = async <T>(sql: string) => (await db.prepare(sql).all<T>()).results;
  const blockers = await all<Omit<BlockerRow, "requirement_ids"> & { req_ids: string | null }>(
    `SELECT b.id, b.category, b.status, b.severity, GROUP_CONCAT(br.requirement_id) AS req_ids
     FROM blockers b LEFT JOIN blocker_requirements br ON br.blocker_id = b.id GROUP BY b.id`);
  const rc = await db.prepare(`SELECT commit_sha, config_sha256 FROM releases ORDER BY created_at DESC LIMIT 1`).first<{ commit_sha: string; config_sha256: string }>();
  const prod = await db.prepare(`SELECT commit_sha FROM deployments WHERE environment='production' AND status='succeeded' ORDER BY deployed_at DESC LIMIT 1`).first<{ commit_sha: string }>();
  const approvals = await all<Omit<ApprovalRow, "approver_is_owner"> & { approver_is_owner: number }>(
    `SELECT a.*, EXISTS(SELECT 1 FROM memberships m WHERE m.user_id = a.approver_user_id AND m.role_id = 'owner') AS approver_is_owner
     FROM release_approvals a`);
  return {
    requirements: await all<RequirementRow>(`SELECT * FROM requirements ORDER BY id`),
    evidence: await all<EvidenceRow>(
      `SELECT te.requirement_id, te.outcome, te.test_name, te.run_id, er.environment, er.source, er.commit_sha, er.finished_at
       FROM test_evidence te JOIN evidence_runs er ON er.id = te.run_id`),
    blockers: blockers.map((b) => ({ ...b, requirement_ids: b.req_ids ? b.req_ids.split(",") : [] })),
    findings: await all<FindingRow>(`SELECT id, severity, release_blocking, status FROM security_findings`),
    ingestion: await all<IngestionRow>(`SELECT * FROM ingestion_status`),
    approvals: approvals.map((a) => ({ ...a, approver_is_owner: !!a.approver_is_owner })),
    integrations: await all<IntegrationRow>(`SELECT * FROM integration_health`),
    releaseCandidate: rc ?? null,
    productionDeployment: prod ?? null,
    now,
  };
}

export async function buildReport(input: ReadinessInput) {
  const requirements = computeRequirementStatuses(input);
  const evidenceSet = await sha256Hex(evidenceSetHash(requirements));
  const gates = computeGates(input, requirements, evidenceSet);
  return {
    generatedAt: input.now.toISOString(),
    selfHealth: { feeds: ingestionHealth(input.ingestion, input.now) },
    scores: computeScores(requirements),
    gates,
    decision: launchDecision(gates),
    evidenceSetSha256: evidenceSet,
    integrations: input.integrations,
    blockers: input.blockers,
    requirements,
  };
}

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function requirementsCsv(report: Awaited<ReturnType<typeof buildReport>>): string {
  const header = ["id", "subsystem", "title", "priority", "category", "disposition", "implementation", "dev", "staging", "production", "state", "last_verified_at", "stale", "blockers", "evidence_runs"];
  const rows = report.requirements.map((r) => [r.id, r.subsystem, r.title, r.priority, r.category, r.disposition, r.implementation,
    r.verification.development, r.verification.staging, r.verification.production, r.state, r.lastVerifiedAt, r.stale, r.blockers.join(" "), r.evidenceRunIds.join(" ")]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}
