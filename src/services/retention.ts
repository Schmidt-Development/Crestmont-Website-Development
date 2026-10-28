// Data retention (SEC-006, §65–§66). See docs/RETENTION-SCHEDULE.md.
//
// Two tiers:
//  1. ALWAYS: non-controversial expired operational data that no person or process can use any more
//     (expired/revoked sessions, finished rate-limit windows, used/expired single-use auth tokens).
//  2. CONFIGURED: personal-data periods that are PROPOSED pending Founder/attorney approval. They run
//     only when staff set the matching business_settings key (`retention.<category>_days`). Default off.
//
// Never touched, whatever is configured: audit_logs (append-only, enforced by triggers), financial
// records (orders, invoices, payments, refunds, receipts, disputes, subscriptions), agreements and
// agreement acceptances, privacy requests, readiness evidence and release records.
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import type { StorageAdapter } from "../adapters/storage.ts";

const DAY = 86_400_000;

export interface AlwaysRule { category: string; label: string; description: string }
export const ALWAYS_RULES: AlwaysRule[] = [
  { category: "sessions", label: "Sessions", description: "Sessions that expired or were revoked more than 30 days ago (they can never authenticate again)." },
  { category: "rate_limits", label: "Rate-limit windows", description: "Rate-limit counters whose window started more than 2 days ago (the longest window is 1 hour)." },
  { category: "auth_tokens", label: "Email verification / password reset tokens", description: "Single-use tokens used or expired more than 7 days ago (only their hashes are stored)." },
  { category: "env_metrics", label: "Request metrics", description: "Hourly request/error/latency buckets older than 90 days (no personal data; used for the 24-hour and recent views)." },
];

export interface ConfigurableRule { category: string; key: string; label: string; proposedDays: number; minDays: number; maxDays: number; description: string }
export const CONFIGURABLE_RULES: ConfigurableRule[] = [
  { category: "security_events", key: "retention.security_events_days", label: "Security events", proposedDays: 365, minDays: 90, maxDays: 3650,
    description: "Failed logins, lockouts, rate-limit hits (contain email addresses and IPs). Rows older than the period are deleted." },
  { category: "email_bodies", key: "retention.email_bodies_days", label: "Email message bodies", proposedDays: 730, minDays: 90, maxDays: 3650,
    description: "Rendered subject/HTML/text of sent emails. Delivery log rows (template, recipient, status) are kept; only the stored body is deleted." },
  { category: "app_errors", key: "retention.app_errors_days", label: "Server error log", proposedDays: 90, minDays: 30, maxDays: 3650,
    description: "Unhandled server errors (may contain paths and fragments of input). Rows older than the period are deleted." },
  { category: "voice_transcripts", key: "retention.voice_transcripts_days", label: "Call transcripts and recording links", proposedDays: 90, minDays: 30, maxDays: 3650,
    description: "Transcript text and recording URL of consented calls are cleared after the period. The call record, outcome, summary and CRM lead are kept." },
  { category: "deleted_files", key: "retention.deleted_files_days", label: "Soft-deleted files", proposedDays: 30, minDays: 14, maxDays: 3650,
    description: "Bytes of files deleted in the portal are removed from object storage after the period. The metadata row stays (other records reference it) and is marked purged. Files referenced by handoffs or portfolio entries are never purged." },
];

export interface RetentionResult { category: string; mode: "always" | "configured" | "skipped"; affected: number; cutoff: string | null; detail: string }

/** Parses a staff-set retention period. Returns null when unset; a string error when invalid. */
export function configuredDays(settings: Record<string, string>, rule: ConfigurableRule): number | null | string {
  const raw = settings[rule.key];
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < rule.minDays || n > rule.maxDays) return `invalid value "${raw}" (whole days ${rule.minDays}–${rule.maxDays})`;
  return n;
}

async function loadSettings(db: Db): Promise<Record<string, string>> {
  const rows = (await db.prepare(`SELECT key, value FROM business_settings WHERE key LIKE 'retention.%'`).all<{ key: string; value: string }>()).results;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function runRetention(deps: { db: Db; storage: StorageAdapter | null; now?: () => Date }): Promise<RetentionResult[]> {
  const db = deps.db;
  const now = (deps.now ?? (() => new Date()))();
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  const results: RetentionResult[] = [];

  // ── Tier 1: always ──
  const sessCut = iso(30 * DAY);
  const s = await db.prepare(`DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?`).bind(sessCut, sessCut).run();
  results.push({ category: "sessions", mode: "always", affected: s.meta.changes, cutoff: sessCut, detail: "expired or revoked before cutoff" });

  const rlCutSeconds = Math.floor((now.getTime() - 2 * DAY) / 1000);
  const rl = await db.prepare(`DELETE FROM rate_limits WHERE window_start < ?`).bind(rlCutSeconds).run();
  results.push({ category: "rate_limits", mode: "always", affected: rl.meta.changes, cutoff: new Date(rlCutSeconds * 1000).toISOString(), detail: "windows started before cutoff" });

  const tokCut = iso(7 * DAY);
  const t = await db.prepare(`DELETE FROM auth_tokens WHERE (used_at IS NOT NULL AND used_at < ?) OR expires_at < ?`).bind(tokCut, tokCut).run();
  results.push({ category: "auth_tokens", mode: "always", affected: t.meta.changes, cutoff: tokCut, detail: "used or expired before cutoff" });

  const mCut = iso(90 * DAY).slice(0, 13); // env_metrics.hour is 'YYYY-MM-DDTHH'
  const m = await db.prepare(`DELETE FROM env_metrics WHERE hour < ?`).bind(mCut).run().catch(() => ({ meta: { changes: 0 } }));
  results.push({ category: "env_metrics", mode: "always", affected: m.meta.changes, cutoff: `${mCut}:00:00.000Z`, detail: "hour buckets before cutoff" });

  // ── Tier 2: only when staff configured the period ──
  const settings = await loadSettings(db);
  for (const rule of CONFIGURABLE_RULES) {
    const days = configuredDays(settings, rule);
    if (days === null) { results.push({ category: rule.category, mode: "skipped", affected: 0, cutoff: null, detail: `not configured (${rule.key} unset; proposed ${rule.proposedDays} days pending Founder/attorney approval)` }); continue; }
    if (typeof days === "string") { results.push({ category: rule.category, mode: "skipped", affected: 0, cutoff: null, detail: `${rule.key}: ${days}` }); continue; }
    const cut = iso(days * DAY);
    let affected = 0, detail = `${days} days`;
    switch (rule.category) {
      case "security_events":
        affected = (await db.prepare(`DELETE FROM security_events WHERE created_at < ?`).bind(cut).run()).meta.changes; break;
      case "email_bodies":
        affected = (await db.prepare(`DELETE FROM email_messages WHERE delivery_id IN (SELECT id FROM email_deliveries WHERE created_at < ?)`).bind(cut).run()).meta.changes; break;
      case "app_errors":
        affected = (await db.prepare(`DELETE FROM app_errors WHERE created_at < ?`).bind(cut).run()).meta.changes; break;
      case "voice_transcripts":
        affected = (await db.prepare(`UPDATE calls SET transcript = NULL, recording_url = NULL WHERE COALESCE(ended_at, started_at) < ? AND (transcript IS NOT NULL OR recording_url IS NOT NULL)`).bind(cut).run()).meta.changes; break;
      case "deleted_files": {
        const due = (await db.prepare(`SELECT id, r2_key FROM files f WHERE deleted_at IS NOT NULL AND deleted_at < ? AND purged_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM handoffs h WHERE h.documentation_file_id = f.id)
            AND NOT EXISTS (SELECT 1 FROM portfolio_projects p WHERE p.desktop_screenshot_file_id = f.id OR p.mobile_screenshot_file_id = f.id)
            LIMIT 200`).bind(cut).all<{ id: string; r2_key: string }>()).results; // 2 calls per file; the daily job set shares one invocation's budget (D1 Paid: 1,000 queries)
        if (!deps.storage) { detail += `; ${due.length} due but no object storage is bound — nothing purged`; break; }
        let failed = 0;
        for (const f of due) {
          try {
            await deps.storage.delete(f.r2_key);
            affected += (await db.prepare(`UPDATE files SET purged_at = ? WHERE id = ? AND purged_at IS NULL`).bind(nowIso(), f.id).run()).meta.changes;
          } catch { failed++; }
        }
        if (failed) detail += `; ${failed} object deletions failed and will be retried`;
        break;
      }
    }
    results.push({ category: rule.category, mode: "configured", affected, cutoff: cut, detail });
  }

  const runId = `ret_${now.getTime()}`;
  const at = nowIso();
  await db.batch(results.map((r) => db.prepare(`INSERT INTO retention_runs (run_id, ran_at, category, mode, cutoff, affected, detail) VALUES (?,?,?,?,?,?,?)`)
    .bind(runId, at, r.category, r.mode, r.cutoff, r.affected, r.detail.slice(0, 500))));
  return results;
}

export async function retentionHistory(db: Db, limit = 60) {
  return (await db.prepare(`SELECT run_id, ran_at, category, mode, cutoff, affected, detail FROM retention_runs ORDER BY id DESC LIMIT ?`).bind(limit)
    .all<{ run_id: string; ran_at: string; category: string; mode: string; cutoff: string | null; affected: number; detail: string | null }>()).results;
}
