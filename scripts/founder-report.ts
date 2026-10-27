// Generates the §77 final status report (DOC-003) as Markdown FROM readiness records — the same
// buildFounderReport() that renders /staff/readiness/founder-report. No number is written by hand.
//
//   Local database:  node --no-warnings scripts/founder-report.ts --db .dev/crestmont.db > docs/reports/status.md
//   From evidence:   node --no-warnings scripts/founder-report.ts [evidence/ci-evidence.json …]
//                    (fresh in-memory DB: inventory + implementation records + discovery blockers + the
//                     given evidence files; same inputs as scripts/readiness-snapshot.ts)
//   Deployed env:    sign in as staff and download /staff/readiness/founder-report.md
import { readFileSync, existsSync } from "node:fs";
import { openDb } from "../dev/sqlite-d1.ts";
import { syncRequirements, ingestEvidence } from "../src/readiness/ingest.ts";
import { applySeedBlockerLinks } from "../src/services/readiness-admin.ts";
import { buildFounderReport } from "../src/routes/ops.ts";

const args = process.argv.slice(2);
const dbIdx = args.indexOf("--db");
const db = openDb(dbIdx >= 0 ? args[dbIdx + 1] : ":memory:");
await syncRequirements(db);
await applySeedBlockerLinks(db);
if (dbIdx < 0) {
  const files = args.length ? args : ["evidence/ci-evidence.json", "evidence/e2e-evidence.json"].filter((f) => existsSync(f));
  for (const f of files) await ingestEvidence(db, readFileSync(f, "utf8"));
}
const report = await buildFounderReport({ db, now: () => new Date() });
process.stdout.write(report.markdown);
