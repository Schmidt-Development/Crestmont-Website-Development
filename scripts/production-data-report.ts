// Read-only production data report for the deploy summary (Founder audit, 2026-11-12). SELECTs only; no personal data
// (no names, addresses, emails or payloads): the portfolio order, Stripe webhook events by type and outcome, orders by
// state, and email deliveries by template and outcome over the last 7 days.
//   WRANGLER="npx --yes wrangler@4.149.0" node scripts/production-data-report.ts
import { execFileSync } from "node:child_process";

const [cmd, ...base] = (process.env.WRANGLER ?? "npx --yes wrangler@4.149.0").split(" ").filter(Boolean);
const q = (sql: string): Record<string, unknown>[] => {
  const out = execFileSync(cmd, [...base, "d1", "execute", "crestmont-production", "--remote", "--env", "production", "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  return (JSON.parse(out.slice(out.indexOf("["))) as { results?: Record<string, unknown>[] }[]).flatMap((r) => r.results ?? []);
};
const table = (title: string, rows: Record<string, unknown>[]) => {
  console.log(`\n#### ${title}`);
  if (!rows.length) { console.log("(none)"); return; }
  const cols = Object.keys(rows[0]);
  console.log(`| ${cols.join(" | ")} |\n|${cols.map(() => "---").join("|")}|`);
  for (const r of rows) console.log(`| ${cols.map((c) => String(r[c] ?? "")).join(" | ")} |`);
};

console.log("### Production data (read-only)");
table("Portfolio (all entries, by position)", q(`SELECT position, id, name, published, CASE WHEN archived_at IS NULL THEN 'no' ELSE 'yes' END AS archived, live_url FROM portfolio_projects ORDER BY position, name`));
// Native availability — its own health signal, separate from ordinary uptime (Owner, 2026-11-19).
table("Portfolio native readiness (one native-first standard)", q(`SELECT position, name, native_state, display_mode, COALESCE(embed_status, '—') AS embed, COALESCE(substr(native_verified_at, 1, 16), 'never') AS verified, COALESCE(json_extract(native_diagnosis, '$.codes'), '[]') AS diagnosis, CASE WHEN native_migrated_at IS NULL THEN 'no' ELSE 'yes' END AS converted FROM portfolio_projects WHERE archived_at IS NULL ORDER BY position, name`));
table("Portfolio native regressions and repairs (last 7 days)", q(`SELECT action, COUNT(*) AS n, MAX(created_at) AS last FROM audit_logs WHERE action IN ('portfolio.native_regression', 'portfolio.native_verification', 'portfolio.native_first_migration') AND created_at >= datetime('now', '-7 days') GROUP BY action ORDER BY action`));
table("Stripe webhook events received (by type and outcome)", q(`SELECT type, status, COUNT(*) AS n, MAX(received_at) AS last FROM stripe_events GROUP BY type, status ORDER BY last DESC LIMIT 40`));
table("Orders by state", q(`SELECT status, COUNT(*) AS n, MAX(created_at) AS last FROM orders GROUP BY status`));
table("Email deliveries, last 7 days (by template and outcome)", q(`SELECT template, status, COUNT(*) AS n FROM email_deliveries WHERE created_at >= datetime('now', '-7 days') GROUP BY template, status ORDER BY template`));
