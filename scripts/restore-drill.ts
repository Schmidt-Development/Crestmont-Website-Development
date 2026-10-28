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
  return countQueries(tables, Infinity)[0];
}
/** Counting queries for D1. D1 rejects compound SELECTs beyond a few terms ("too many terms in compound SELECT",
 *  code 7500, seen on staging), so each query is ONE row of scalar sub-selects — no UNION — one column per table,
 *  in batches to stay well under column limits. */
export function countQueries(tables: string[], batch = 20): string[] {
  const ok = tables.filter((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t) && !SKIP.test(t)).sort();
  if (!ok.length) throw new Error("no tables to count");
  const size = Number.isFinite(batch) ? batch : ok.length;
  const out: string[] = [];
  for (let i = 0; i < ok.length; i += size)
    out.push(`SELECT ${ok.slice(i, i + size).map((t) => `(SELECT COUNT(*) FROM "${t}") AS "${t}"`).join(", ")}`);
  return out;
}
/** {t, n} rows from several `wrangler d1 execute --json` outputs; accepts both the one-row-of-columns shape and {t, n} rows. */
export function rowsOfAll(outputs: string[]): Rows {
  return outputs.flatMap(rowsOf).flatMap((r) => ("t" in r && "n" in r ? [r] : Object.entries(r).map(([t, n]) => ({ t, n }))));
}

/** Prepares a `wrangler d1 export` dump for `d1 execute --file` per Cloudflare's import guide
 *  (developers.cloudflare.com/d1/best-practices/import-export-data): no BEGIN TRANSACTION/COMMIT, no reserved `_cf_*`
 *  tables, no writes to SQLite's internal sqlite_sequence. Line-based: D1 exports put each such statement on its own line. */
export function sanitizeExport(sql: string): { sql: string; removed: Record<string, number> } {
  const rules: [string, RegExp][] = [
    ["transaction", /^\s*(BEGIN( TRANSACTION)?|COMMIT|END( TRANSACTION)?)\s*;\s*$/i],
    ["_cf_ tables", /^\s*(CREATE TABLE( IF NOT EXISTS)?|INSERT INTO|DELETE FROM|DROP TABLE( IF EXISTS)?)\s+["`]?_cf_/i],
    ["sqlite_sequence", /^\s*(INSERT INTO|DELETE FROM|UPDATE)\s+["`]?sqlite_sequence/i],
  ];
  const removed: Record<string, number> = {};
  const kept = sql.split("\n").filter((line) => {
    const hit = rules.find(([, re]) => re.test(line));
    if (hit) removed[hit[0]] = (removed[hit[0]] ?? 0) + 1;
    return !hit;
  });
  return { sql: kept.join("\n"), removed };
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
  if (mode === "sanitize") {
    const r = sanitizeExport(readFileSync(a, "utf8"));
    writeFileSync(b, r.sql);
    console.log(`sanitized export: removed ${JSON.stringify(r.removed)}`);
  } else if (mode === "sql") process.stdout.write(countQueries(rowsOf(readFileSync(a, "utf8")).map((r) => String(r.name))).join("\n") + "\n");
  else if (mode === "compare") {
    // a / b: comma-separated lists of wrangler JSON outputs (one per counting batch).
    const r = compareCounts(rowsOfAll(a.split(",").map((f) => readFileSync(f, "utf8"))), rowsOfAll(b.split(",").map((f) => readFileSync(f, "utf8"))));
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
