// Evidence ingestion (READY-004, §49). CI posts a JSON evidence document signed with
// HMAC-SHA256 over `${timestamp}.${body}` in header `X-Crestmont-Signature: t=..,v1=..`.
// Re-delivery of the same run id is idempotent. Failures are recorded in ingestion_status
// so the dashboard can show "failing" instead of silently trusting old data (§50).
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { hmacSha256Hex, sha256Hex, timingSafeEqualHex } from "../lib/crypto.ts";
import { parse, v, ValidationError, type Check } from "../lib/validate.ts";
import { REQUIREMENTS, type RequirementDef } from "../../requirements/inventory.ts";
import { IMPLEMENTATION, type ImplementationRecord } from "../../requirements/status.ts";

export const INVENTORY_VERSION = "2026-10-directive-v1";

const evidenceSchema = v.object({
  runId: v.string({ min: 1, max: 200, pattern: /^[A-Za-z0-9._:-]+$/ }),
  source: v.enumOf(["ci", "staging_e2e", "production_check", "manual_review", "integration_probe"] as const),
  environment: v.enumOf(["development", "staging", "production"] as const),
  commitSha: v.string({ pattern: /^[0-9a-f]{7,40}$/ }),
  branch: v.string({ optional: true, max: 200 }),
  runUrl: v.string({ optional: true, max: 500, pattern: /^https:\/\// }),
  startedAt: v.string({ pattern: /^\d{4}-\d{2}-\d{2}T/ }),
  finishedAt: v.string({ pattern: /^\d{4}-\d{2}-\d{2}T/ }),
  results: v.array(v.object({
    requirementId: v.string({ pattern: /^[A-Z]+-\d{3}$/ }),
    testName: v.string({ min: 1, max: 500 }),
    outcome: v.enumOf(["passed", "failed", "skipped"] as const),
    durationMs: v.int({ min: 0, optional: true }),
    message: v.string({ optional: true, max: 2000 }),
  }), { max: 20_000 }),
  // READY-006: optional external response-time samples (scripts/production-checks.ts), stored in env_latency.
  timings: optional(v.array(v.object({
    page: v.string({ min: 1, max: 200, pattern: /^\/[A-Za-z0-9/_.-]*$/ }),
    samples: v.int({ min: 1, max: 1000 }),
    failed: v.int({ min: 0, max: 1000 }),
    p50Ms: v.int({ min: 0, max: 600_000, optional: true }),
    p95Ms: v.int({ min: 0, max: 600_000, optional: true }),
    maxMs: v.int({ min: 0, max: 600_000, optional: true }),
  }), { max: 50 })),
});

function optional<T>(check: Check<T>): Check<T | undefined> {
  return ((value, path, issues) => (value === undefined || value === null ? undefined : check(value, path, issues))) as Check<T | undefined>;
}

export type EvidenceDoc = ReturnType<typeof parseEvidence>;
export function parseEvidence(json: unknown) {
  const doc = parse(evidenceSchema, json);
  const issues: string[] = [];
  const pages = new Set<string>();
  for (const [i, t] of (doc.timings ?? []).entries()) {
    if (t.failed > t.samples) issues.push(`timings[${i}].failed must be ≤ samples`);
    if (pages.has(t.page)) issues.push(`timings[${i}].page is duplicated`);
    pages.add(t.page);
  }
  if (issues.length) throw new ValidationError(issues);
  return doc;
}

export class IngestAuthError extends Error {}

export async function signEvidence(secret: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`;
}

export async function verifyEvidenceSignature(secret: string | undefined, body: string, header: string | null, nowSeconds = Math.floor(Date.now() / 1000)): Promise<void> {
  if (!secret) throw new IngestAuthError("Evidence ingestion secret not configured");
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) throw new IngestAuthError("Missing or malformed signature");
  if (Math.abs(nowSeconds - Number(m[1])) > 600) throw new IngestAuthError("Signature timestamp outside tolerance");
  if (!timingSafeEqualHex(m[2], await hmacSha256Hex(secret, `${m[1]}.${body}`))) throw new IngestAuthError("Signature mismatch");
}

export interface IngestResult { status: "ingested" | "duplicate"; runId: string; accepted: number; unknownRequirements: string[] }

export async function ingestEvidence(db: Db, rawBody: string): Promise<IngestResult> {
  const attemptAt = nowIso();
  let doc: EvidenceDoc;
  try {
    doc = parseEvidence(JSON.parse(rawBody));
  } catch (err) {
    await recordIngestion(db, "unknown", attemptAt, (err as Error).message);
    throw err;
  }
  try {
    const exists = await db.prepare(`SELECT id FROM evidence_runs WHERE id = ?`).bind(doc.runId).first();
    if (exists) {
      await recordIngestion(db, doc.source, attemptAt, null);
      return { status: "duplicate", runId: doc.runId, accepted: 0, unknownRequirements: [] };
    }
    const known = new Set((await db.prepare(`SELECT id FROM requirements`).all<{ id: string }>()).results.map((r) => r.id));
    const unknown = [...new Set(doc.results.map((r) => r.requirementId).filter((id) => !known.has(id)))];
    const accepted = doc.results.filter((r) => known.has(r.requirementId));
    const stmts = [
      db.prepare(`INSERT INTO evidence_runs (id, source, environment, commit_sha, branch, run_url, started_at, finished_at, received_at, payload_sha256)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(doc.runId, doc.source, doc.environment, doc.commitSha, doc.branch ?? null, doc.runUrl ?? null, doc.startedAt, doc.finishedAt, attemptAt, await sha256Hex(rawBody)),
      ...accepted.map((r) => db.prepare(
        `INSERT INTO test_evidence (run_id, requirement_id, test_name, outcome, duration_ms, message) VALUES (?,?,?,?,?,?)
         ON CONFLICT(run_id, requirement_id, test_name) DO NOTHING`,
      ).bind(doc.runId, r.requirementId, r.testName, r.outcome, r.durationMs ?? null, r.message ?? null)),
      ...(doc.timings ?? []).map((t) => db.prepare(
        `INSERT INTO env_latency (run_id, environment, page, samples, failed_samples, p50_ms, p95_ms, max_ms, measured_at) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(run_id, page) DO NOTHING`,
      ).bind(doc.runId, doc.environment, t.page, t.samples, t.failed, t.p50Ms ?? null, t.p95Ms ?? null, t.maxMs ?? null, doc.finishedAt)),
    ];
    await db.batch(stmts); // atomic in D1
    await recordIngestion(db, doc.source, attemptAt, unknown.length ? `Unknown requirement ids: ${unknown.join(", ")}` : null, true);
    return { status: "ingested", runId: doc.runId, accepted: accepted.length, unknownRequirements: unknown };
  } catch (err) {
    await recordIngestion(db, doc.source, attemptAt, (err as Error).message);
    throw err;
  }
}

async function recordIngestion(db: Db, source: string, at: string, error: string | null, success = error === null): Promise<void> {
  await db.prepare(
    `INSERT INTO ingestion_status (source, last_success_at, last_attempt_at, last_error) VALUES (?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET
       last_attempt_at = excluded.last_attempt_at,
       last_error = excluded.last_error,
       last_success_at = COALESCE(excluded.last_success_at, ingestion_status.last_success_at)`,
  ).bind(source, success ? at : null, at, error).run();
}

/** Upserts the approved inventory. Never deletes: removed items must be dispositioned instead. */
export async function syncRequirements(db: Db, defs: RequirementDef[] = REQUIREMENTS,
  records: Record<string, ImplementationRecord> = IMPLEMENTATION): Promise<{ upserted: number }> {
  const at = nowIso();
  const stmts = defs.map((r) => db.prepare(
    `INSERT INTO requirements (id, subsystem, section, title, priority, category, requires_founder_approval, inventory_version, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET subsystem=excluded.subsystem, section=excluded.section, title=excluded.title,
       priority=excluded.priority, category=excluded.category, requires_founder_approval=excluded.requires_founder_approval,
       inventory_version=excluded.inventory_version, updated_at=excluded.updated_at`,
  ).bind(r.id, r.subsystem, r.section, r.title, r.priority, r.category, r.category === "founder" ? 1 : 0, INVENTORY_VERSION, at));
  await db.batch(stmts);
  const deps = defs.flatMap((r) => (r.dependsOn ?? []).map((d) => db.prepare(
    `INSERT INTO requirement_dependencies (requirement_id, depends_on_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).bind(r.id, d)));
  if (deps.length) await db.batch(deps);
  const known = new Set(defs.map((d) => d.id));
  const impl = Object.entries(records).filter(([id]) => known.has(id)).map(([id, rec]) => db.prepare(
    `UPDATE requirements SET implementation_status = ?, implementation_location = ?, owner = ?, updated_at = ? WHERE id = ?`,
  ).bind(rec.status, rec.missing ? `${rec.location} (missing: ${rec.missing})` : rec.location, rec.owner, at, id));
  if (impl.length) await db.batch(impl);
  return { upserted: defs.length };
}
