// Rate limiting and suspicious-activity logging (AUTH-005).
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";

export async function rateLimit(db: Db, key: string, limit: number, windowSeconds: number, now = Date.now()): Promise<{ allowed: boolean; remaining: number }> {
  const windowStart = Math.floor(now / 1000 / windowSeconds) * windowSeconds;
  const row = await db.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
  ).bind(key, windowStart).first<{ count: number }>();
  const count = row?.count ?? 1;
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
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

export async function audit(db: Db, e: { actorUserId?: string | null; actorKind?: "user" | "system" | "ai" | "webhook"; action: string; subjectType: string; subjectId?: string | null; organizationId?: string | null; details?: unknown; ip?: string | null }): Promise<void> {
  await db.prepare(
    `INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, organization_id, details_json, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(e.actorUserId ?? null, e.actorKind ?? "user", e.action, e.subjectType, e.subjectId ?? null, e.organizationId ?? null,
    e.details === undefined ? null : JSON.stringify(e.details), e.ip ?? null, nowIso()).run();
}
