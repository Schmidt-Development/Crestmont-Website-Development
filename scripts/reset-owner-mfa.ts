// Owner break-glass: clears the Owner's two-factor authentication when the Owner has lost both the authenticator
// and every recovery code (AUTH-002; procedure in docs/RUNBOOK.md §4a). Operator-run with database access, in the
// style of scripts/bootstrap-owner.ts. It:
//   - clears the authenticator, any pending enrolment and all recovery codes (the Owner must enrol again),
//   - revokes every Owner session,
//   - writes a security event and an audit_logs entry (actor_kind "system", with operator name and reason).
// It never changes the password, never creates an account and never touches anyone but the named Owner.
//
//   Local DB:    node --no-warnings scripts/reset-owner-mfa.ts --email founder@example.com --operator "Name" \
//                  --reason "Lost phone; identity confirmed by video call" --confirm-owner-break-glass --db .dev/crestmont.db
//   D1 (remote): node --no-warnings scripts/reset-owner-mfa.ts … --confirm-owner-break-glass --print-sql > reset.sql
//                wrangler d1 execute crestmont-production --remote --env production --file reset.sql
//
// Refuses unless --email, --operator, a --reason of at least 15 characters and --confirm-owner-break-glass are all
// given. In local mode it also refuses when the email is not the Owner. In --print-sql mode every statement is
// guarded by "this email holds the owner role", so the SQL is a no-op for any other account.

import { fileURLToPath } from "node:url";

export interface ResetArgs { email: string; operator: string; reason: string }

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function parseArgs(argv: string[]): { ok: true; value: ResetArgs & { db?: string; printSql: boolean } } | { ok: false; error: string } {
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const email = get("--email")?.trim().toLowerCase() ?? "";
  const operator = get("--operator")?.trim() ?? "";
  const reason = get("--reason")?.trim() ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, error: "--email <Owner email> is required" };
  if (operator.length < 2) return { ok: false, error: "--operator <your name> is required (recorded in the audit log)" };
  if (reason.length < 15) return { ok: false, error: "--reason is required (at least 15 characters: why, and how the Owner's identity was confirmed)" };
  if (!argv.includes("--confirm-owner-break-glass")) return { ok: false, error: "--confirm-owner-break-glass is required: this removes the Owner's two-factor authentication" };
  const printSql = argv.includes("--print-sql");
  const db = get("--db");
  if (!printSql && !db) return { ok: false, error: "choose --db <path> (local) or --print-sql (for wrangler d1 execute)" };
  return { ok: true, value: { email, operator: operator.slice(0, 120), reason: reason.slice(0, 500), db, printSql } };
}

/** SQL for the reset; every statement applies only if `email` belongs to an Owner. */
export function resetSql(a: ResetArgs, now = new Date().toISOString()): string {
  const owner = `(SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.email = ${q(a.email)} AND m.role_id = 'owner')`;
  const details = JSON.stringify({ operator: a.operator, reason: a.reason, via: "scripts/reset-owner-mfa.ts" });
  return [
    `INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, organization_id, details_json, ip, created_at)
     SELECT NULL, 'system', 'owner.mfa_break_glass_reset', 'user', u.id, m.organization_id, ${q(details)}, NULL, ${q(now)}
       FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.email = ${q(a.email)} AND m.role_id = 'owner';`,
    `INSERT INTO security_events (kind, user_id, email, ip, detail, created_at)
     SELECT 'mfa_reset_break_glass', u.id, u.email, NULL, ${q(`operator ${a.operator}`)}, ${q(now)} FROM users u WHERE u.id IN ${owner};`,
    `UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_last_step = NULL, mfa_enabled = 0 WHERE id IN ${owner};`,
    `DELETE FROM mfa_recovery_codes WHERE user_id IN ${owner};`,
    `UPDATE sessions SET revoked_at = ${q(now)} WHERE revoked_at IS NULL AND user_id IN ${owner};`,
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`Refused: ${parsed.error}.\nUsage: --email <owner> --operator <name> --reason <text> --confirm-owner-break-glass (--db <path> | --print-sql)`);
    process.exit(2);
  }
  const a = parsed.value;
  const sql = resetSql(a);
  if (a.printSql) {
    console.log(sql);
    console.error(`\nOwner MFA break-glass SQL for ${a.email} printed. Apply it with wrangler d1 execute … --file, then ask the Owner to sign in and enrol a new authenticator.`);
  } else {
    const { openDb } = await import("../dev/sqlite-d1.ts");
    const db = openDb(a.db!);
    const row = db.raw.prepare(`SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.email = ? AND m.role_id = 'owner'`).get(a.email) as { id: string } | undefined;
    if (!row) { console.error(`Refused: ${a.email} is not the Owner account. This procedure is only for the Owner; staff are reset by an administrator at /staff/employees.`); process.exit(1); }
    db.raw.exec("BEGIN");
    try { db.raw.exec(sql); db.raw.exec("COMMIT"); } catch (e) { db.raw.exec("ROLLBACK"); throw e; }
    console.log(`Owner two-factor authentication cleared for ${a.email}; all Owner sessions revoked; recorded in audit_logs (owner.mfa_break_glass_reset). The Owner must enrol a new authenticator at next sign-in.`);
  }
}
