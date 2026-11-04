// Rate limiting and suspicious-activity logging (AUTH-005).
import type { Db, DbStatement } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";

export async function rateLimit(db: Db, key: string, limit: number, windowSeconds: number, now = Date.now()): Promise<{ allowed: boolean; remaining: number }> {
  const windowStart = Math.floor(now / 1000 / windowSeconds) * windowSeconds;
  const row = await db.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
  ).bind(key, windowStart).first<{ count: number }>();
  const count = row?.count ?? 1;
  // Sliding-window approximation (CREST-GAP-102): the previous window still counts in proportion to how much of it
  // overlaps the last `windowSeconds`, so a client cannot burst to twice the limit across a window boundary.
  const prev = await db.prepare(`SELECT count FROM rate_limits WHERE key = ? AND window_start = ?`).bind(key, windowStart - windowSeconds).first<{ count: number }>();
  const effective = rateLimitEffective(count, prev?.count ?? 0, now, windowSeconds);
  return { allowed: effective <= limit, remaining: Math.max(0, Math.floor(limit - effective)) };
}

/** The sliding-window count rateLimit compares with its limit: this window's count plus the previous window's count in
 *  proportion to its overlap with the last `windowSeconds`. Pure, so read-only callers (deploy checks) use the same rule. */
export function rateLimitEffective(count: number, prevCount: number, now: number, windowSeconds: number): number {
  const windowStart = Math.floor(now / 1000 / windowSeconds) * windowSeconds;
  const overlap = 1 - (now / 1000 - windowStart) / windowSeconds;
  return count + prevCount * overlap;
}

/** Current count of a fixed-window counter without incrementing it (0 when no event happened in this window). */
export async function peekRateLimit(db: Db, key: string, windowSeconds: number, now = Date.now()): Promise<number> {
  const windowStart = Math.floor(now / 1000 / windowSeconds) * windowSeconds;
  const row = await db.prepare(`SELECT count FROM rate_limits WHERE key = ? AND window_start = ?`).bind(key, windowStart).first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Replay protection for signed machine requests (CREST-GAP-087): true the first time a signature is seen within its
 * validity window, false for any repeat. Signatures are valid for ±600 s, so a 1200 s fixed window plus a look at
 * the previous window covers every moment a replay could still pass the timestamp check.
 */
export async function claimSignatureOnce(db: Db, signatureHex: string, ttlSeconds = 1200, now = Date.now()): Promise<boolean> {
  const key = `sig:${signatureHex}`;
  const windowStart = Math.floor(now / 1000 / ttlSeconds) * ttlSeconds;
  const prev = await db.prepare(`SELECT 1 AS x FROM rate_limits WHERE key = ? AND window_start = ?`).bind(key, windowStart - ttlSeconds).first();
  const row = await db.prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count`)
    .bind(key, windowStart).first<{ count: number }>();
  return !prev && (row?.count ?? 1) === 1;
}

export async function securityEvent(db: Db, kind: string, data: { userId?: string | null; email?: string | null; ip?: string | null; detail?: string }): Promise<void> {
  await db.prepare(`INSERT INTO security_events (kind, user_id, email, ip, detail, created_at) VALUES (?,?,?,?,?,?)`)
    .bind(kind, data.userId ?? null, data.email ?? null, data.ip ?? null, data.detail ?? null, nowIso()).run();
}

export interface AuditEvent {
  actorUserId?: string | null; actorKind?: "user" | "system" | "ai" | "webhook"; action: string; subjectType: string;
  subjectId?: string | null; organizationId?: string | null; details?: unknown; ip?: string | null;
}

/**
 * The same audit row as `audit`, prepared but NOT executed, so a caller can put it in a `db.batch()` alongside the
 * write it records. That matters on a hot path: a batch is atomic and counts as one query against D1's
 * 1,000-per-invocation limit, so the record can no longer be written without its change (or the change without its
 * record), and three round trips become one. `audit` is the right call everywhere else.
 */
export function auditStatement(db: Db, e: AuditEvent): DbStatement {
  return db.prepare(
    `INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, organization_id, details_json, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(e.actorUserId ?? null, e.actorKind ?? "user", e.action, e.subjectType, e.subjectId ?? null, e.organizationId ?? null,
    e.details === undefined ? null : JSON.stringify(e.details), e.ip ?? null, nowIso());
}

export async function audit(db: Db, e: AuditEvent): Promise<void> {
  await auditStatement(db, e).run();
}
