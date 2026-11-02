// Staging restore drill (TEST-004, INFRA-006, DOC-002). Used by .github/workflows/staging-restore-drill.yml:
//   node --no-warnings scripts/restore-drill.ts sql   <tables.json>                 → prints one SELECT that counts every table
//   node --no-warnings scripts/restore-drill.ts export-counts <export.sql>          → the export's own row counts (source side)
//   node --no-warnings scripts/restore-drill.ts compare <source.json> <restored.json> --commit <sha> --run-id <id> --out <evidence.json>
// tables.json / source.json / restored.json are `wrangler d1 execute --json` outputs. The comparison is the evidence:
// identical table set and identical row counts after restoring the export into a scratch database. The source side
// is the export itself (exportCounts), not a later count of the live database, which keeps changing.
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

/** Splits SQL into statements on `;` outside string literals, quoted identifiers and comments. A CREATE TRIGGER
 *  statement runs to its closing `END;` (its body contains `;`). Each statement keeps its trailing `;`. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "", i = 0;
  const flush = () => { const s = cur.trim(); if (s) out.push(s); cur = ""; };
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === close) { if (close !== "]" && sql[j + 1] === close) { j += 2; continue; } break; }
        j++;
      }
      cur += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === "-" && sql[i + 1] === "-") { const j = sql.indexOf("\n", i); i = j < 0 ? sql.length : j + 1; cur += "\n"; continue; }
    if (c === "/" && sql[i + 1] === "*") { const j = sql.indexOf("*/", i + 2); i = j < 0 ? sql.length : j + 2; cur += " "; continue; }
    cur += c; i++;
    if (c === ";") {
      const trigger = /^\s*CREATE\s+(TEMP(ORARY)?\s+)?TRIGGER\b/i.test(cur);
      if (!trigger || /\bEND\s*;$/i.test(cur.trimEnd())) flush();
    }
  }
  flush();
  return out;
}

const IDENT = String.raw`(?:"((?:[^"]|"")+)"|\x60([^\x60]+)\x60|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_$]*))`;
const ident = (m: RegExpMatchArray, k: number) => (m[k] ?? m[k + 1] ?? m[k + 2] ?? m[k + 3] ?? "").replace(/""/g, '"');
const CREATE_TABLE = new RegExp(String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:main\.)?${IDENT}`, "i");
const INSERT = new RegExp(String.raw`^(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+(?:main\.)?${IDENT}`, "i");
const REFERENCES = new RegExp(String.raw`\bREFERENCES\s+(?:main\.)?${IDENT}`, "gi");

/** Prepares a `wrangler d1 export` dump for `d1 execute --file`.
 *  1. Removes what Cloudflare's import guide (developers.cloudflare.com/d1/best-practices/import-export-data) says D1
 *     rejects: BEGIN TRANSACTION/COMMIT, reserved `_cf_*` tables, and writes to SQLite's internal tables
 *     (sqlite_sequence, sqlite_stat*) plus the `ANALYZE sqlite_schema` that precedes stat rows.
 *  2. Re-orders it so it can be replayed: a D1 export lists tables in creation order, and a table created early can
 *     reference one created later (invoices → projects on staging). Inserting a child row before its parent table
 *     exists fails with "no such table" even with defer_foreign_keys — the import then aborts (D1_RESET_DO).
 *     Output: PRAGMAs, every CREATE TABLE, then each table's rows with parents before children, then everything
 *     else (indexes, triggers, views) in export order. Statements are parsed, so data containing `;` or newlines is safe. */
export function sanitizeExport(sql: string): { sql: string; removed: Record<string, number> } {
  const rules: [string, RegExp][] = [
    ["transaction", /^(BEGIN(\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(\s+TRANSACTION)?|COMMIT(\s+TRANSACTION)?|END(\s+TRANSACTION)?)\s*;$/i],
    ["_cf_ tables", /^(CREATE\s+TABLE(\s+IF\s+NOT\s+EXISTS)?|INSERT(\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE|DROP\s+TABLE(\s+IF\s+EXISTS)?)\s+["`[]?_cf_/i],
    ["sqlite internal", /^((INSERT(\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE)\s+["`[]?sqlite_(sequence|stat\d)|ANALYZE\s+["`[]?sqlite_(schema|master))\b/i],
  ];
  const removed: Record<string, number> = {};
  const pragmas: string[] = [], creates = new Map<string, string>(), rows = new Map<string, string[]>(), rest: string[] = [];
  const deps = new Map<string, Set<string>>();
  for (const s of splitStatements(sql)) {
    const hit = rules.find(([, re]) => re.test(s));
    if (hit) { removed[hit[0]] = (removed[hit[0]] ?? 0) + 1; continue; }
    let m: RegExpMatchArray | null;
    if (/^PRAGMA\b/i.test(s)) pragmas.push(s);
    else if ((m = s.match(CREATE_TABLE))) {
      const t = ident(m, 1).toLowerCase();
      creates.set(t, s);
      deps.set(t, new Set([...s.matchAll(REFERENCES)].map((r) => ident(r, 1).toLowerCase()).filter((p) => p !== t)));
    } else if ((m = s.match(INSERT))) {
      const t = ident(m, 1).toLowerCase();
      if (!rows.has(t)) rows.set(t, []);
      rows.get(t)!.push(s);
    } else rest.push(s);
  }
  // Parents before children; export order breaks ties and cycles (rows of a cycle rely on defer_foreign_keys).
  const order: string[] = [], state = new Map<string, number>();
  const visit = (t: string) => {
    if (state.get(t)) return;            // 1 = in progress (cycle), 2 = done
    state.set(t, 1);
    for (const p of deps.get(t) ?? []) if (creates.has(p)) visit(p);
    state.set(t, 2); order.push(t);
  };
  for (const t of [...creates.keys(), ...rows.keys()]) visit(t);
  const data = order.flatMap((t) => rows.get(t) ?? []);
  const out = [...pragmas, ...creates.values(), ...data, ...rest];
  return { sql: out.join("\n") + (out.length ? "\n" : ""), removed };
}

/** A failure reason is built from wrangler's error output and ends up on the public /api/readiness/health feed.
 *  D1 errors can quote the failing SQL, so row data (string literals, blobs, email addresses) and anything
 *  token-like are removed; the error class, code and SQL keywords that explain the failure are kept. */
export function redactReason(s: string): string {
  return s
    .replace(/X'[0-9A-Fa-f]*'/g, "X'…'")
    .replace(/'(?:[^']|'')*'/g, "'…'")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[email]")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, "[redacted]")   // tokens/ids mix letters and digits; long table names do not
    .slice(0, 500);
}

/**
 * Row counts of the EXPORT itself ({t, n} rows, the shape compareCounts reads): one per CREATE TABLE, counting that
 * table's INSERT statements (Wrangler's d1 export writes one row per INSERT). These are the source side of the drill.
 * Counting the live database instead raced with live traffic: rows written or pruned between the export and the count
 * (rate_limits on staging, 2026-11-02) failed a restore that was in fact exact.
 */
export function exportCounts(sql: string): Rows {
  const counts = new Map<string, number>();
  for (const st of splitStatements(sql)) {
    let m: RegExpMatchArray | null;
    if ((m = st.match(CREATE_TABLE))) { const t = ident(m, 1); if (!SKIP.test(t) && !counts.has(t)) counts.set(t, 0); }
    else if ((m = st.match(INSERT))) { const t = ident(m, 1); if (!SKIP.test(t)) counts.set(t, (counts.get(t) ?? 0) + 1); }
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => ({ t, n }));
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
  } else if (mode === "export-counts") process.stdout.write(JSON.stringify([{ results: exportCounts(readFileSync(a, "utf8")) }]) + "\n");
  else if (mode === "sql") process.stdout.write(countQueries(rowsOf(readFileSync(a, "utf8")).map((r) => String(r.name))).join("\n") + "\n");
  else if (mode === "compare") {
    // a / b: comma-separated lists of wrangler JSON outputs (one per counting batch).
    const r = compareCounts(rowsOfAll(a.split(",").map((f) => readFileSync(f, "utf8"))), rowsOfAll(b.split(",").map((f) => readFileSync(f, "utf8"))));
    writeFileSync(arg("--out") ?? "evidence/restore-drill.json", JSON.stringify(drillEvidence(r, { commit: arg("--commit") ?? "0000000", runId: arg("--run-id") ?? `local-drill-${Date.now()}`, startedAt: arg("--started") ?? new Date().toISOString() })));
    console.log(`${r.passed ? "PASSED" : "FAILED"}: ${r.tables} tables, ${r.rows} rows${r.problems.length ? `; ${r.problems.join("; ")}` : ""}`);
    if (!r.passed) process.exit(1);
  } else if (mode === "fail") {
    // A step before the comparison failed (export, scratch database, import): record a failed drill with the reason,
    // so the recovery:restore feed shows it instead of the drill silently leaving no evidence.
    const reason = redactReason(arg("--reason") || "restore drill failed before the comparison");
    writeFileSync(arg("--out") ?? "evidence/restore-drill.json", JSON.stringify(drillEvidence({ passed: false, tables: 0, rows: 0, problems: [reason] }, { commit: arg("--commit") ?? "0000000", runId: arg("--run-id") ?? `local-drill-${Date.now()}`, startedAt: arg("--started") ?? new Date().toISOString() })));
  } else { console.error("usage: restore-drill.ts sql <tables.json> | compare <source.json> <restored.json> [--commit --run-id --out --started]"); process.exit(2); }
}
