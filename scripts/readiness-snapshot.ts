// Builds a readiness snapshot from real records: the requirements inventory, the blocker
// register (created by migration 0008) and the evidence files produced by `npm test` and `npm run e2e`.
// Usage: node --no-warnings scripts/readiness-snapshot.ts [evidence.json] > snapshot.json
// Writes evidence/readiness.csv alongside. Uses an in-memory DB; production reads D1.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { applySeedBlockerLinks } from "../src/services/readiness-admin.ts";
import { createTestDb } from "../tests/support/sqlite-d1.ts";
import { syncRequirements, ingestEvidence } from "../src/readiness/ingest.ts";
import { buildReport, loadReadinessInput, requirementsCsv } from "../src/readiness/report.ts";

const db = createTestDb();
await syncRequirements(db);
await applySeedBlockerLinks(db);
const files = process.argv.length > 2 ? process.argv.slice(2) : ["evidence/ci-evidence.json", "evidence/e2e-evidence.json"].filter((f) => existsSync(f));
for (const f of files) await ingestEvidence(db, readFileSync(f, "utf8"));
const report = await buildReport(await loadReadinessInput(db));
writeFileSync("evidence/readiness.csv", requirementsCsv(report));
const { requirements, ...summary } = report;
const byState: Record<string, number> = {};
for (const r of requirements) byState[r.state] = (byState[r.state] ?? 0) + 1;
console.log(JSON.stringify({ ...summary, byState }, null, 2));
