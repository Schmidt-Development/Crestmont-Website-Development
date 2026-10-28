// READ-ONLY forensic snapshot of staging D1, taken by the deploy BEFORE a credential rotation deletes the evidence
// (rotation removes demo sessions, one-time tokens and recovery codes). Incident: staging access notes were published
// as plaintext artifacts of this public repository (2026-10-27 07:30 UTC → 2026-10-28); D1 exports were published
// 2026-10-27 06:55–08:10 UTC.
//
// Output:
//   --out <file.json>  full rows (emails, IPs, user agents, audit actions): SEALED by the workflow with the Founder's
//                      ACCESS_ARTIFACT_PASSPHRASE (scripts/seal.ts) before upload, then deleted. Never printed.
//   stdout / step summary: COUNTS ONLY, no identifiers. They are indicators for the Founder's review, not verdicts:
//                      missing rows never prove that nothing happened (sessions expire, logs are bounded).
//
//   node --no-warnings scripts/staging-forensics.ts --out forensics/snapshot.json [--since <iso>] [--export-cutoff <iso>]
//   env: WRANGLER (staging only: wranglerOps() addresses crestmont-staging --env staging)
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wranglerOps, DEMO_DOMAIN, type D1Ops } from "./staging-access.ts";

export const SINCE = "2026-10-27T00:00:00Z";
export const EXPORT_CUTOFF = "2026-10-27T08:15:00Z";
const DEMO = `(SELECT id FROM users WHERE email LIKE '%@${DEMO_DOMAIN}')`;
// Addresses that cannot belong to a real person or customer (seed data uses only the demo domain).
const TEST_EMAIL = (col: string) => `(${col} IS NULL OR ${col} LIKE '%@${DEMO_DOMAIN}' OR ${col} LIKE '%.test' OR ${col} LIKE '%.invalid' OR ${col} LIKE '%.example' OR ${col} LIKE '%@example.com' OR ${col} LIKE '%@example.org' OR ${col} LIKE '%@example.net')`;
const PRIVILEGED = ["%role%", "%member%", "%invit%", "user.%", "%setting%", "%secret%", "%password%", "%mfa%", "%api%", "%key%", "%token%", "%owner%", "%export%", "%delete%"];
const AUTOMATION_UA = /(HeadlessChrome|Playwright|node|undici|crestmont-|curl|python|Go-http-client)/i;

export function queries(since: string, cutoff: string): Record<string, string> {
  const s = `'${since}'`, c = `'${cutoff}'`;
  return {
    demo_sessions: `SELECT u.email, s.ip, s.user_agent, COUNT(*) AS n, MIN(s.created_at) AS first, MAX(s.created_at) AS last, SUM(s.revoked_at IS NULL AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS active
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.user_id IN ${DEMO} AND s.created_at >= ${s} GROUP BY u.email, s.ip, s.user_agent ORDER BY last DESC`,
    other_sessions: `SELECT u.email, s.ip, s.user_agent, COUNT(*) AS n, MAX(s.created_at) AS last
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.user_id NOT IN ${DEMO} AND s.created_at >= ${s} GROUP BY u.email, s.ip, s.user_agent ORDER BY last DESC`,
    demo_audit: `SELECT u.email, a.action, a.subject_type, a.ip, COUNT(*) AS n, MIN(a.created_at) AS first, MAX(a.created_at) AS last
      FROM audit_logs a JOIN users u ON u.id = a.actor_user_id WHERE a.actor_user_id IN ${DEMO} AND a.created_at >= ${s} GROUP BY u.email, a.action, a.subject_type, a.ip ORDER BY n DESC`,
    privileged_audit: `SELECT COALESCE(u.email, a.actor_kind) AS actor, a.action, a.subject_type, a.subject_id, a.ip, a.created_at
      FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.created_at >= ${s} AND (${PRIVILEGED.map((p) => `a.action LIKE '${p}'`).join(" OR ")}) ORDER BY a.created_at`,
    security_events: `SELECT kind, email, ip, COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM security_events WHERE created_at >= ${s} GROUP BY kind, email, ip ORDER BY last DESC`,
    users_created: `SELECT id, email, created_at, disabled_at, mfa_enabled FROM users WHERE created_at >= ${s} ORDER BY created_at`,
    memberships_created: `SELECT m.user_id, u.email, m.organization_id, m.role_id, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.created_at >= ${s} ORDER BY m.created_at`,
    owners: `SELECT u.email, u.disabled_at, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id = 'owner' ORDER BY m.created_at`,
    demo_invitations: `SELECT i.id, i.email, i.role_id, i.expires_at, i.accepted_at, u.email AS invited_by FROM invitations i JOIN users u ON u.id = i.invited_by WHERE i.invited_by IN ${DEMO}`,
    demo_recovery_codes: `SELECT u.email, COUNT(*) AS total, SUM(rc.used_at IS NOT NULL) AS used, MAX(rc.created_at) AS last FROM mfa_recovery_codes rc JOIN users u ON u.id = rc.user_id WHERE rc.user_id IN ${DEMO} GROUP BY u.email`,
    mfa_baseline: `SELECT SUM(totp_secret LIKE 'v1:%') AS encrypted, SUM(totp_secret IS NOT NULL AND totp_secret NOT LIKE 'v1:%') AS plaintext, COUNT(*) AS users FROM users WHERE email NOT LIKE '%@${DEMO_DOMAIN}'`,
    // Was real data in staging when the D1 exports were public? Rows that existed by the cutoff with a non-test address.
    export_real_emails: [
      ["users", "email"], ["contacts", "email"], ["email_deliveries", "to_email"], ["email_suppressions", "email"], ["security_events", "email"],
    ].map(([t, col]) => `SELECT '${t}' AS tbl, substr(${col}, instr(${col}, '@') + 1) AS domain, COUNT(*) AS n FROM ${t} WHERE created_at < ${c} AND NOT ${TEST_EMAIL(col)} GROUP BY domain`).join(" UNION ALL "),
  };
}

export interface Indicators {
  window_start: string;
  demo_sessions: number; demo_sessions_active: number; demo_session_ips: number; demo_sessions_interactive_clients: number;
  demo_privileged_actions: number; users_created_outside_demo: number; owners_outside_demo: number;
  pending_demo_invitations: number; demo_recovery_codes: number;
  real_looking_emails_at_export: number; real_looking_email_domains_at_export: number;
}

export async function snapshot(ops: D1Ops, since = SINCE, cutoff = EXPORT_CUTOFF): Promise<{ rows: Record<string, unknown[]>; indicators: Indicators; errors: string[] }> {
  const rows: Record<string, Record<string, unknown>[]> = {}, errors: string[] = [];
  for (const [name, sql] of Object.entries(queries(since, cutoff))) {
    try { rows[name] = await ops.query(sql); } catch (e) { rows[name] = []; errors.push(`${name}: ${String((e as Error).message).split("\n")[0].slice(0, 160)}`); }
  }
  const sum = (r: Record<string, unknown>[], k: string) => r.reduce((a, x) => a + Number(x[k] ?? 0), 0);
  const now = new Date().toISOString();
  const demoPriv = rows.privileged_audit.filter((r) => String(r.actor).endsWith(`@${DEMO_DOMAIN}`));
  return {
    rows, errors,
    indicators: {
      window_start: since,
      demo_sessions: sum(rows.demo_sessions, "n"),
      demo_sessions_active: sum(rows.demo_sessions, "active"),
      demo_session_ips: new Set(rows.demo_sessions.map((r) => r.ip)).size,
      demo_sessions_interactive_clients: sum(rows.demo_sessions.filter((r) => !AUTOMATION_UA.test(String(r.user_agent ?? ""))), "n"),
      demo_privileged_actions: demoPriv.length,
      users_created_outside_demo: rows.users_created.filter((r) => !String(r.email).endsWith(`@${DEMO_DOMAIN}`)).length,
      owners_outside_demo: rows.owners.filter((r) => !String(r.email).endsWith(`@${DEMO_DOMAIN}`)).length,
      pending_demo_invitations: rows.demo_invitations.filter((r) => !r.accepted_at && String(r.expires_at) > now).length,
      demo_recovery_codes: sum(rows.demo_recovery_codes, "total"),
      real_looking_emails_at_export: sum(rows.export_real_emails, "n"),
      real_looking_email_domains_at_export: new Set(rows.export_real_emails.map((r) => r.domain)).size,
    },
  };
}

export function summary(i: Indicators, errors: string[]): string {
  const line = (label: string, v: number) => `| ${label} | ${v} |`;
  return [
    `### Pre-rotation forensic snapshot (counts only; full rows are in the sealed artifact)`, "",
    `Window from ${i.window_start}. Indicators for review, not verdicts; an absence of rows does not prove that nothing happened.`, "",
    "| Indicator | Count |", "|---|---|",
    line("Demo-account sessions created in the window", i.demo_sessions),
    line("…still active before rotation", i.demo_sessions_active),
    line("…distinct client IPs", i.demo_session_ips),
    line("…from interactive (non-automation) clients — includes the Founder's own", i.demo_sessions_interactive_clients),
    line("Privileged actions by demo accounts (roles, members, invitations, settings, secrets, MFA, exports, deletes)", i.demo_privileged_actions),
    line("Users created in the window outside the demo domain", i.users_created_outside_demo),
    line("Owner-role holders outside the demo domain", i.owners_outside_demo),
    line("Pending invitations issued by demo accounts", i.pending_demo_invitations),
    line("Demo recovery codes", i.demo_recovery_codes),
    line("Rows with real-looking email addresses that existed when D1 exports were public", i.real_looking_emails_at_export),
    line("…distinct email domains", i.real_looking_email_domains_at_export),
    ...(errors.length ? ["", `Queries that failed: ${errors.map((e) => e.split(":")[0]).join(", ")}`] : []),
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const out = arg("--out");
  try {
    if (!out) throw new Error("--out is required");
    const snap = await snapshot(wranglerOps(), arg("--since") ?? SINCE, arg("--export-cutoff") ?? EXPORT_CUTOFF);
    writeFileSync(out, JSON.stringify({ taken_at: new Date().toISOString(), run: process.env.GITHUB_RUN_ID ?? null, commit: process.env.GITHUB_SHA ?? null, ...snap }, null, 1), { mode: 0o600 });
    const text = summary(snap.indicators, snap.errors);
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n\n");
  } catch (e) {
    console.error(`::error::Forensic snapshot failed: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    process.exit(1);
  }
}
