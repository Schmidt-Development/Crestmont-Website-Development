// Builds a readiness snapshot from real records: the requirements inventory, the blocker
// register (seeds/blockers.sql) and the evidence file produced by `npm test`.
// Usage: node --no-warnings scripts/readiness-snapshot.ts [evidence.json] > snapshot.json
// Writes evidence/readiness.csv alongside. Uses an in-memory DB; production reads D1.
import { readFileSync, writeFileSync } from "node:fs";
import { createTestDb } from "../tests/support/sqlite-d1.ts";
import { syncRequirements, ingestEvidence } from "../src/readiness/ingest.ts";
import { buildReport, loadReadinessInput, requirementsCsv } from "../src/readiness/report.ts";

const db = createTestDb();
await syncRequirements(db);
db.raw.exec(readFileSync("seeds/blockers.sql", "utf8"));
await ingestEvidence(db, readFileSync(process.argv[2] ?? "evidence/ci-evidence.json", "utf8"));
const report = await buildReport(await loadReadinessInput(db));
writeFileSync("evidence/readiness.csv", requirementsCsv(report));
const { requirements, ...summary } = report;
const byState: Record<string, number> = {};
for (const r of requirements) byState[r.state] = (byState[r.state] ?? 0) + 1;
console.log(JSON.stringify({ ...summary, byState }, null, 2));
