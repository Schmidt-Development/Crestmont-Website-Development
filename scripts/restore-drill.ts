// Staging restore drill (TEST-004, INFRA-006, DOC-002). Used by .github/workflows/staging-restore-drill.yml:
//   node --no-warnings scripts/restore-drill.ts sql   <tables.json>                 → prints one SELECT that counts every table
//   node --no-warnings scripts/restore-drill.ts compare <source.json> <restored.json> --commit <sha> --run-id <id> --out <evidence.json>
// tables.json / source.json / restored.json are `wrangler d1 execute --json` outputs. The comparison is the evidence:
// identical table set and identical row counts after restoring the export into a scratch database.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Rows = Record<string, unknown>[];
export function rowsOf(wranglerJson: string): Rows {
  const j = JSON.parse(wranglerJson.slice(wranglerJson.indexOf("[")));
  return (j[0]?.results ?? []) as Rows;
}

const SKIP = /^(sqlite_|_cf_|d1_migrations$)/;
export function countSql(tables: string[]): string {
  const ok = tables.filter((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t) && !SKIP.test(t)).sort();
  if (!ok.length) throw new Error("no tables to count");
  return ok.map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM "${t}"`).join(" UNION ALL ");
}

export interface DrillResult { passed: boolean; tables: number; rows: number; problems: string[] }
export function compareCounts(source: Rows, restored: Rows): DrillResult {
  const a = new Map(source.map((r) => [String(r.t), Number(r.n)]));
  const b = new Map(restored.map((r) => [String(r.t), Number(r.n)]));
  const problems: string[] = [];
  for (const [t, n] of a) if (!b.has(t)) problems.push(`${t}: missing after restore`); else if (b.get(t) !== n) problems.push(`${t}: ${n} rows before, ${b.get(t)} after`);
  for (const t of b.keys()) if (!a.has(t)) problems.push(`${t}: unexpected table after restore`);
  return { passed: problems.length === 0 && a.size > 0, tables: a.size, rows: [...a.values()].reduce((x, y) => x + y, 0), problems };
}

export function drillEvidence(r: DrillResult, o: { commit: string; runId: string; startedAt: string }) {
  const name = `staging D1 export restored into a scratch database: ${r.tables} tables, ${r.rows} rows${r.passed ? " identical" : ""}`;
  const msg = r.problems.slice(0, 20).join("; ").slice(0, 1000);
  return {
    runId: o.runId, source: "ci", environment: "staging", commitSha: o.commit, startedAt: o.startedAt, finishedAt: new Date().toISOString(),
    results: [
      { requirementId: "TEST-004", testName: name, outcome: r.passed ? "passed" : "failed", ...(r.passed ? {} : { message: msg }) },
      { requirementId: "INFRA-006", testName: `restore drill: ${name}`, outcome: r.passed ? "passed" : "failed", ...(r.passed ? {} : { message: msg }) },
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, a, b] = process.argv.slice(2);
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  if (mode === "sql") process.stdout.write(countSql(rowsOf(readFileSync(a, "utf8")).map((r) => String(r.name))));
  else if (mode === "compare") {
    const r = compareCounts(rowsOf(readFileSync(a, "utf8")), rowsOf(readFileSync(b, "utf8")));
    writeFileSync(arg("--out") ?? "evidence/restore-drill.json", JSON.stringify(drillEvidence(r, { commit: arg("--commit") ?? "0000000", runId: arg("--run-id") ?? `local-drill-${Date.now()}`, startedAt: arg("--started") ?? new Date().toISOString() })));
    console.log(`${r.passed ? "PASSED" : "FAILED"}: ${r.tables} tables, ${r.rows} rows${r.problems.length ? `; ${r.problems.join("; ")}` : ""}`);
    if (!r.passed) process.exit(1);
  } else if (mode === "fail") {
    // A step before the comparison failed (export, scratch database, import): record a failed drill with the reason,
    // so the recovery:restore feed shows it instead of the drill silently leaving no evidence.
    const reason = (arg("--reason") || "restore drill failed before the comparison").slice(0, 500);
    writeFileSync(arg("--out") ?? "evidence/restore-drill.json", JSON.stringify(drillEvidence({ passed: false, tables: 0, rows: 0, problems: [reason] }, { commit: arg("--commit") ?? "0000000", runId: arg("--run-id") ?? `local-drill-${Date.now()}`, startedAt: arg("--started") ?? new Date().toISOString() })));
  } else { console.error("usage: restore-drill.ts sql <tables.json> | compare <source.json> <restored.json> [--commit --run-id --out --started]"); process.exit(2); }
}
