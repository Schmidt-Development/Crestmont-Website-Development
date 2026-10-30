// Privacy erasure for the sales-optimization tables (PR #49, migrations/0047_sales_optimization.sql). Audit result:
//   so_findings.evidence_quote / label   redacted transcript quote / model paraphrase of the caller  → scrubbed
//   so_proposal_jobs.evidence_json        copies of those quotes and labels                           → scrubbed
//   ai_job_inputs of queued analyses      the (redacted) transcript sent to the local model           → deleted
//   so_analyses (queued)                  would re-read the transcript                                → skipped
//   so_call_facts, so_attributions, so_analyses.detail, so_webhook_receipts: ids, flags, counts and payment links only
//   (no direct identifiers) → kept for reporting, like call outcomes. so_versions holds finding ids/categories only;
//   its AI-written rationale is immutable by design (documented residual risk, RUNBOOK §5a).
// Used by caller erasure (calls of a phone number) and CRM identity erasure (calls of the erased contacts' leads), in
// the same batch as the transcript erasure. scrubOrphanedProposalEvidence() is also run by the sales job's retention
// purge, so quotes copied into proposal jobs go when the transcript goes.
import type { Db, DbStatement } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";

const ph = (n: number) => Array.from({ length: n }, () => "?").join(",");
interface EvidenceItem { id?: string; category?: string; label?: string; quote?: string | null }

function scrubEvidenceJson(json: string, drop: (id: string) => boolean): string | null {
  try {
    const ctx = JSON.parse(json) as { evidence?: EvidenceItem[] };
    if (!Array.isArray(ctx.evidence)) return null;
    let changed = false;
    for (const e of ctx.evidence) if (e.id && drop(e.id) && (e.quote || (e.label && e.label !== e.category))) { e.quote = null; e.label = e.category ?? ""; changed = true; }
    return changed ? JSON.stringify(ctx) : null;
  } catch { return null; }
}

export async function salesOptErasureStatements(db: Db, callIds: string[]): Promise<{ stmts: DbStatement[]; findings: number }> {
  const stmts: DbStatement[] = [];
  if (!callIds.length) return { stmts, findings: 0 };
  const findingIds: string[] = [], jobIds: string[] = [];
  for (let i = 0; i < callIds.length; i += 80) {
    const c = callIds.slice(i, i + 80);
    findingIds.push(...(await db.prepare(`SELECT id FROM so_findings WHERE call_id IN (${ph(c.length)})`).bind(...c).all<{ id: string }>()).results.map((r) => r.id));
    jobIds.push(...(await db.prepare(`SELECT ai_job_id AS id FROM so_analyses WHERE call_id IN (${ph(c.length)}) AND ai_job_id IS NOT NULL`).bind(...c).all<{ id: string }>()).results.map((r) => r.id));
    stmts.push(db.prepare(`UPDATE so_findings SET evidence_quote = NULL, label = category WHERE call_id IN (${ph(c.length)})`).bind(...c));
    stmts.push(db.prepare(`UPDATE so_analyses SET status = 'skipped', detail = 'transcript erased at the person''s request', completed_at = COALESCE(completed_at, ?) WHERE call_id IN (${ph(c.length)}) AND status = 'queued'`).bind(nowIso(), ...c));
  }
  for (let i = 0; i < jobIds.length; i += 80) {
    const j = jobIds.slice(i, i + 80);
    stmts.push(db.prepare(`DELETE FROM ai_job_inputs WHERE job_id IN (${ph(j.length)})`).bind(...j));
    stmts.push(db.prepare(`UPDATE ai_jobs SET output_ref = NULL, updated_at = ? WHERE id IN (${ph(j.length)})`).bind(nowIso(), ...j));
  }
  if (findingIds.length) {
    const ids = new Set(findingIds);
    const jobs = (await db.prepare(`SELECT ai_job_id, evidence_json FROM so_proposal_jobs WHERE evidence_json <> '[]'`).all<{ ai_job_id: string; evidence_json: string }>()).results;
    for (const r of jobs) { const next = scrubEvidenceJson(r.evidence_json, (id) => ids.has(id)); if (next) stmts.push(db.prepare(`UPDATE so_proposal_jobs SET evidence_json = ? WHERE ai_job_id = ?`).bind(next, r.ai_job_id)); }
  }
  return { stmts, findings: findingIds.length };
}

/** Retention companion: evidence copied into proposal jobs loses its quote once the finding's quote is purged. */
export async function scrubOrphanedProposalEvidence(db: Db): Promise<number> {
  const jobs = (await db.prepare(`SELECT ai_job_id, evidence_json FROM so_proposal_jobs WHERE evidence_json <> '[]'`).all<{ ai_job_id: string; evidence_json: string }>()).results;
  if (!jobs.length) return 0;
  const live = new Set((await db.prepare(`SELECT id FROM so_findings WHERE evidence_quote IS NOT NULL`).all<{ id: string }>()).results.map((r) => r.id));
  let n = 0;
  for (const r of jobs) {
    const next = scrubEvidenceJson(r.evidence_json, (id) => !live.has(id));
    if (next) { await db.prepare(`UPDATE so_proposal_jobs SET evidence_json = ? WHERE ai_job_id = ?`).bind(next, r.ai_job_id).run(); n++; }
  }
  return n;
}
