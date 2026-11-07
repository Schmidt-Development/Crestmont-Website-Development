// Staging restore drill (TEST-004, INFRA-006, DOC-002). Used by .github/workflows/staging-restore-drill.yml:
//   node --no-warnings scripts/restore-drill.ts sql   <tables.json>                 → prints one SELECT that counts every table
//   node --no-warnings scripts/restore-drill.ts export-counts <export.sql>          → the export's own row counts (source side)
//   node --no-warnings scripts/restore-drill.ts compare <source.json> <restored.json> --commit <sha> --run-id <id> --out <evidence.json>
// tables.json / source.json / restored.json are `wrangler d1 execute --json` outputs. The comparison is the evidence:
// identical table set and identical row counts after restoring the export into a scratch database. The source side
// is the export itself (exportCounts), not a later count of the live database, which keeps changing.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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

/** Statements a D1 import rejects (see sanitizeExport): transactions, reserved `_cf_*` tables, SQLite internals. */
export const EXPORT_RULES: [string, RegExp][] = [
  ["transaction", /^(BEGIN(\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(\s+TRANSACTION)?|COMMIT(\s+TRANSACTION)?|END(\s+TRANSACTION)?)\s*;$/i],
  ["_cf_ tables", /^(CREATE\s+TABLE(\s+IF\s+NOT\s+EXISTS)?|INSERT(\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE|DROP\s+TABLE(\s+IF\s+EXISTS)?)\s+["`[]?_cf_/i],
  ["sqlite internal", /^((INSERT(\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE)\s+["`[]?sqlite_(sequence|stat\d)|ANALYZE\s+["`[]?sqlite_(schema|master))\b/i],
];

/** Prepares a `wrangler d1 export` dump for `d1 execute --file`.
 *  1. Removes what Cloudflare's import guide (developers.cloudflare.com/d1/best-practices/import-export-data) says D1
 *     rejects: BEGIN TRANSACTION/COMMIT, reserved `_cf_*` tables, and writes to SQLite's internal tables
 *     (sqlite_sequence, sqlite_stat*) plus the `ANALYZE sqlite_schema` that precedes stat rows.
 *  2. Re-orders it so it can be replayed: a D1 export lists tables in creation order, and a table created early can
 *     reference one created later (invoices → projects on staging). Inserting a child row before its parent table
 *     exists fails with "no such table" even with defer_foreign_keys — the import then aborts (D1_RESET_DO).
 *     Output: PRAGMAs, every CREATE TABLE, then each table's rows with parents before children, then everything
 *     else (indexes, triggers, views) in export order. Statements are parsed, so data containing `;` or newlines is safe.
 *  3. Never relies on defer_foreign_keys: D1 applies an import in batches, so a reference that points forward fails
 *     at a batch boundary (SQLITE_CONSTRAINT_FOREIGNKEY, staging drill 42321793218). Tables are ordered by their
 *     REQUIRED (NOT NULL) references only, so a cycle closed by a nullable column (projects.active_baseline_id →
 *     design_baselines → projects, 0088) cannot put a child table first. A nullable reference that still points
 *     forward, or into its own table (design_baselines.superseded_by), is inserted as NULL and set by an UPDATE once
 *     every row exists — before triggers are re-created. Foreign keys stay enforced throughout. */
export function sanitizeExport(sql: string): { sql: string; removed: Record<string, number>; deferred: number } {
  const rules = EXPORT_RULES;
  const removed: Record<string, number> = {};
  const pragmas: string[] = [], creates = new Map<string, string>(), rows = new Map<string, string[]>(), rest: string[] = [];
  const shapes = new Map<string, TableShape>();
  for (const s of splitStatements(sql)) {
    const hit = rules.find(([, re]) => re.test(s));
    if (hit) { removed[hit[0]] = (removed[hit[0]] ?? 0) + 1; continue; }
    let m: RegExpMatchArray | null;
    if (/^PRAGMA\b/i.test(s)) pragmas.push(s);
    else if ((m = s.match(CREATE_TABLE))) {
      const t = ident(m, 1).toLowerCase();
      creates.set(t, s);
      shapes.set(t, tableShape(s));
    } else if ((m = s.match(INSERT))) {
      const t = ident(m, 1).toLowerCase();
      if (!rows.has(t)) rows.set(t, []);
      rows.get(t)!.push(s);
    } else rest.push(s);
  }
  // Parents before children; export order breaks ties. Required references always order. A nullable reference orders
  // too, unless following it would reach a table already being visited through required references (a cycle that
  // only a nullable column closes) — that reference is deferred below instead.
  const order: string[] = [], state = new Map<string, number>();
  const hardParents = (t: string) => (shapes.get(t)?.fks ?? []).filter((f) => f.required && f.parent !== t && creates.has(f.parent)).map((f) => f.parent);
  const reachesActive = (p: string) => {
    const seen = new Set<string>(), stack = [p];
    while (stack.length) { const x = stack.pop()!; if (state.get(x) === 1) return true; if (seen.has(x)) continue; seen.add(x); stack.push(...hardParents(x)); }
    return false;
  };
  const visit = (t: string) => {
    if (state.get(t)) return;            // 1 = in progress, 2 = done
    state.set(t, 1);
    for (const p of hardParents(t)) visit(p);
    for (const f of shapes.get(t)?.fks ?? []) if (!f.required && f.parent !== t && creates.has(f.parent) && !state.get(f.parent) && !reachesActive(f.parent)) visit(f.parent);
    state.set(t, 2); order.push(t);
  };
  for (const t of [...creates.keys(), ...rows.keys()]) visit(t);
  const pos = new Map(order.map((t, i) => [t, i]));
  const data: string[] = [], fixups: string[] = [];
  let deferred = 0;
  for (const t of order) {
    const shape = shapes.get(t);
    // Nullable references that would point at rows not yet inserted: a later table, or this table itself.
    const late = new Set((shape?.fks ?? []).filter((f) => !f.required && (f.parent === t || (pos.get(f.parent) ?? -1) > (pos.get(t) ?? -1))).map((f) => f.column));
    (rows.get(t) ?? []).forEach((st, i) => {
      const r = late.size && shape ? deferColumns(st, shape, late, i + 1) : null;
      if (r) { data.push(r.insert); fixups.push(r.update); deferred++; } else data.push(st);
    });
  }
  const out = [...pragmas, ...creates.values(), ...data, ...fixups, ...rest];
  return { sql: out.join("\n") + (out.length ? "\n" : ""), removed, deferred };
}

interface TableShape { name: string; columns: { name: string; notNull: boolean; pk: boolean }[]; pk: string[]; withoutRowid: boolean; fks: { column: string; parent: string; required: boolean }[] }

/** Splits on `sep` at nesting depth 0, outside quotes. */
function splitTop(s: string, sep = ","): string[] {
  const out: string[] = []; let depth = 0, cur = "", i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c; let j = i + 1;
      while (j < s.length) { if (s[j] === close) { if (close !== "]" && s[j + 1] === close) { j += 2; continue; } break; } j++; }
      cur += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === "(") depth++; else if (c === ")") depth--;
    if (c === sep && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const LEAD_IDENT = new RegExp(String.raw`^${IDENT}`);
const unq = (s: string) => { const m = s.trim().match(LEAD_IDENT); return m ? ident(m, 1).toLowerCase() : s.trim().toLowerCase(); };

/** Columns, primary key and foreign keys of a CREATE TABLE statement (as SQLite stores it, ALTER-added columns included). */
export function tableShape(create: string): TableShape {
  const m = create.match(CREATE_TABLE)!;
  const name = ident(m, 1).toLowerCase();
  const open = create.indexOf("(", m[0].length), close = create.lastIndexOf(")");
  const parts = splitTop(create.slice(open + 1, close));
  const columns: TableShape["columns"] = [], pk: string[] = [], fks: { column: string; parent: string; required: boolean }[] = [];
  const tableFks: { cols: string[]; parent: string }[] = [];
  for (const p of parts) {
    const c = p.replace(/^CONSTRAINT\s+\S+\s+/i, "");
    let k: RegExpMatchArray | null;
    if ((k = c.match(/^PRIMARY\s+KEY\s*\(([^)]*)\)/i))) { pk.push(...k[1].split(",").map((x) => unq(x.replace(/\s+(ASC|DESC)\s*$/i, "")))); continue; }
    if ((k = c.match(new RegExp(String.raw`^FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+(?:main\.)?${IDENT}`, "i")))) { tableFks.push({ cols: k[1].split(",").map(unq), parent: ident(k, 2).toLowerCase() }); continue; }
    if (/^(UNIQUE|CHECK)\b/i.test(c)) continue;
    const col = unq(c);
    const isPk = /\bPRIMARY\s+KEY\b/i.test(c);
    columns.push({ name: col, notNull: /\bNOT\s+NULL\b/i.test(c) || isPk, pk: isPk });
    if (isPk) pk.push(col);
    const r = c.match(new RegExp(String.raw`\bREFERENCES\s+(?:main\.)?${IDENT}`, "i"));
    if (r) fks.push({ column: col, parent: ident(r, 1).toLowerCase(), required: /\bNOT\s+NULL\b/i.test(c) || isPk });
  }
  for (const f of tableFks) for (const col of f.cols) {
    const def = columns.find((c) => c.name === col);
    fks.push({ column: col, parent: f.parent, required: !def || def.notNull || pk.includes(col) });
  }
  return { name, columns, pk, withoutRowid: /\)\s*WITHOUT\s+ROWID\s*;?\s*$/i.test(create), fks };
}

/** Rewrites one INSERT so the given columns are NULL, returning the UPDATE that restores them; null if not needed or
 *  if the row cannot be addressed safely (then the original statement is kept). `ordinal` is the row's position in its
 *  table's inserts, which is its rowid in the freshly created table when the table has no declared primary key. */
export function deferColumns(insert: string, shape: TableShape, cols: Set<string>, ordinal: number): { insert: string; update: string } | null {
  const m = insert.match(new RegExp(String.raw`^((?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+(?:main\.)?${IDENT}\s*)(\(([^)]*)\)\s*)?VALUES\s*\(`, "i"));
  if (!m) return null;
  const valuesStart = m[0].length, end = insert.lastIndexOf(")");
  if (end < valuesStart) return null;
  const vals = splitTop(insert.slice(valuesStart, end));
  const names = m[7] ? splitTop(m[7]).map(unq) : shape.columns.map((c) => c.name);
  if (names.length !== vals.length) return null;
  const sets: string[] = [];
  const out = vals.map((v, i) => { if (cols.has(names[i]) && !/^NULL$/i.test(v)) { sets.push(`"${names[i]}" = ${v}`); return "NULL"; } return v; });
  if (!sets.length) return null;
  let where: string;
  if (shape.pk.length) {
    const idx = shape.pk.map((k) => names.indexOf(k));
    if (idx.some((i) => i < 0 || cols.has(names[i]))) return null;
    where = shape.pk.map((k, j) => `"${k}" = ${vals[idx[j]]}`).join(" AND ");
  } else if (!shape.withoutRowid) where = `rowid = ${ordinal}`;
  else return null;
  return { insert: `${insert.slice(0, valuesStart)}${out.join(",")}${insert.slice(end)}`, update: `UPDATE "${shape.name}" SET ${sets.join(", ")} WHERE ${where};` };
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

export interface DrillResult { passed: boolean; tables: number; rows: number; problems: string[]; integrity?: { objects: number; criticalTables: number; foreignKeyViolations: number } }
export function compareCounts(source: Rows, restored: Rows): DrillResult {
  const a = new Map(source.map((r) => [String(r.t), Number(r.n)]));
  const b = new Map(restored.map((r) => [String(r.t), Number(r.n)]));
  const problems: string[] = [];
  for (const [t, n] of a) if (!b.has(t)) problems.push(`${t}: missing after restore`); else if (b.get(t) !== n) problems.push(`${t}: ${n} rows before, ${b.get(t)} after`);
  for (const t of b.keys()) if (!a.has(t)) problems.push(`${t}: unexpected table after restore`);
  return { passed: problems.length === 0 && a.size > 0, tables: a.size, rows: [...a.values()].reduce((x, y) => x + y, 0), problems };
}

export function drillEvidence(r: DrillResult, o: { commit: string; runId: string; startedAt: string }) {
  const proof = r.integrity ? `; foreign_key_check clean, ${r.integrity.objects} schema objects and ${r.integrity.criticalTables} critical tables' content identical` : "";
  const name = `staging D1 export restored into a scratch database: ${r.tables} tables, ${r.rows} rows${r.passed ? ` identical${proof}` : ""}`;
  const msg = r.problems.slice(0, 20).join("; ").slice(0, 1000);
  return {
    runId: o.runId, source: "ci", environment: "staging", commitSha: o.commit, startedAt: o.startedAt, finishedAt: new Date().toISOString(),
    results: [
      { requirementId: "TEST-004", testName: name, outcome: r.passed ? "passed" : "failed", ...(r.passed ? {} : { message: msg }) },
      { requirementId: "INFRA-006", testName: `restore drill: ${name}`, outcome: r.passed ? "passed" : "failed", ...(r.passed ? {} : { message: msg }) },
    ],
  };
}

// ───────────── Integrity proof (beyond row counts) ─────────────

/** Tables whose rows are compared value by value between the export and the restored scratch database. */
export const CRITICAL_TABLES = ["organizations", "users", "memberships", "projects", "orders", "invoices", "payments", "refunds", "subscriptions",
  "agreements", "agreement_acceptances", "quote_versions", "consultations", "files", "frontend_artifacts", "design_baselines"];

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
/** Schema objects (tables, indexes, triggers, views) as `type:name`, the same query on both sides. */
export const OBJECTS_SQL = `SELECT type || ':' || name AS o FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY 1`;
/** One string per row, built by SQLite's own quote() on both sides, so the two engines produce identical text. */
export function rowsSql(db: DatabaseSync, table: string): string {
  const cols = (db.prepare(`PRAGMA table_info(${qi(table)})`).all() as { name: string }[]).map((c) => c.name);
  return `SELECT ${cols.map((c) => `quote(${qi(c)})`).join(" || char(31) || ")} AS r FROM ${qi(table)}`;
}
const digestRows = (rows: string[]) => createHash("sha256").update([...rows].sort().join("\n")).digest("hex");
const tableNames = (db: DatabaseSync) => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
const contentOf = (db: DatabaseSync, t: string) => (db.prepare(rowsSql(db, t)).all() as { r: string }[]).map((x) => String(x.r));
/** Keyword and table of a statement, never its data. */
const label = (s: string) => (s.match(/^(INSERT|REPLACE|UPDATE|CREATE\s+\w+(?:\s+\w+)?)\b[^"`[\w]*(?:INTO\s+)?(?:main\.)?["`[]?([\w$]+)/i) ?? []).slice(1).join(" ") || s.slice(0, 20);

export interface Reference { objects: string[]; content: Record<string, { sql: string; rows: number; sha256: string }> }
export interface Rehearsal { problems: string[]; deferred: number; reference: Reference }

/**
 * Local proof before the D1 import (node:sqlite, the same engine):
 *  - reference: the export exactly as exported, loaded with foreign keys OFF — a copy to compare against, never the
 *    restore — and its own foreign_key_check, which separates bad SOURCE data from a bad restore;
 *  - rehearsal: the sanitized import replayed one statement at a time with foreign keys ENFORCED and no deferral,
 *    which is stricter than any batching D1 can apply; then integrity_check, foreign_key_check, schema objects and
 *    the content of EVERY table compared with the reference.
 */
export function rehearse(exportText: string, importText: string, critical = CRITICAL_TABLES): Rehearsal {
  const problems: string[] = [];
  const ref = new DatabaseSync(":memory:");
  ref.exec("PRAGMA foreign_keys=OFF");
  for (const s of splitStatements(exportText)) if (!/^PRAGMA\b/i.test(s) && !EXPORT_RULES.some(([, re]) => re.test(s))) ref.exec(s);
  const srcViolations = ref.prepare("PRAGMA foreign_key_check").all() as { table: string; parent: string }[];
  if (srcViolations.length) {
    const by = new Map<string, number>();
    for (const v of srcViolations) by.set(`${v.table} → ${v.parent}`, (by.get(`${v.table} → ${v.parent}`) ?? 0) + 1);
    problems.push(`source export has ${srcViolations.length} foreign-key violation(s): ${[...by].map(([k, n]) => `${k} (${n})`).join(", ")}`);
  }
  const rep = new DatabaseSync(":memory:");
  rep.exec("PRAGMA foreign_keys=ON");
  let replayed = true;
  for (const s of splitStatements(importText)) {
    if (/^PRAGMA\b/i.test(s)) continue;
    try { rep.exec(s); } catch (e) { problems.push(`local rehearsal stopped at ${label(s)}: ${(e as Error).message}`); replayed = false; break; }
  }
  if (replayed) {
    const ic = (rep.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    if (ic !== "ok") problems.push(`local rehearsal integrity_check: ${ic}`);
    const fk = rep.prepare("PRAGMA foreign_key_check").all();
    if (fk.length) problems.push(`local rehearsal foreign_key_check: ${fk.length} violation(s)`);
    const a = (ref.prepare(OBJECTS_SQL).all() as { o: string }[]).map((r) => r.o), b = new Set((rep.prepare(OBJECTS_SQL).all() as { o: string }[]).map((r) => r.o));
    for (const o of a) if (!b.has(o)) problems.push(`local rehearsal: ${o} missing`);
    for (const t of tableNames(ref)) if (b.has(`table:${t}`) && digestRows(contentOf(ref, t)) !== digestRows(contentOf(rep, t))) problems.push(`local rehearsal: ${t} content differs from the export`);
  }
  const present = new Set(tableNames(ref));
  const content: Reference["content"] = {};
  for (const t of critical.filter((t) => present.has(t))) { const rows = contentOf(ref, t); content[t] = { sql: rowsSql(ref, t), rows: rows.length, sha256: digestRows(rows) }; }
  return { problems, deferred: sanitizeExport(exportText).deferred, reference: { objects: (ref.prepare(OBJECTS_SQL).all() as { o: string }[]).map((r) => r.o), content } };
}

/** Compares the restored scratch database (wrangler JSON outputs) with the reference from rehearse(). */
export function verifyRestored(reference: Reference, d1: { objects: Rows; fk: Rows; content: Record<string, Rows> }): string[] {
  const problems: string[] = [];
  if (d1.fk.length) problems.push(`restored foreign_key_check: ${d1.fk.length} violation(s)`);
  const got = new Set(d1.objects.map((r) => String(r.o)));
  for (const o of reference.objects) if (!got.has(o)) problems.push(`restored: ${o} missing`);
  for (const o of got) if (!reference.objects.includes(o)) problems.push(`restored: unexpected ${o}`);
  for (const [t, want] of Object.entries(reference.content)) {
    const rows = d1.content[t];
    if (!rows) { problems.push(`restored: ${t} content not read`); continue; }
    const r = rows.map((x) => String(x.r));
    if (r.length !== want.rows || digestRows(r) !== want.sha256) problems.push(`restored: ${t} content differs from the export (${want.rows} rows expected, ${r.length} read)`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, a, b] = process.argv.slice(2);
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  if (mode === "sanitize") {
    const r = sanitizeExport(readFileSync(a, "utf8"));
    writeFileSync(b, r.sql);
    console.log(`sanitized export: removed ${JSON.stringify(r.removed)}; ${r.deferred} row(s) with a forward nullable reference set after load`);
  } else if (mode === "rehearse") {
    // a = the export, b = the sanitized import; writes the reference used by `compare --reference`.
    const r = rehearse(readFileSync(a, "utf8"), readFileSync(b, "utf8"));
    writeFileSync(process.argv[5] ?? "drill/reference.json", JSON.stringify(r.reference));
    if (r.problems.length) { for (const p of r.problems) console.error(`error: ${redactReason(p)}`); process.exit(1); }
    console.log(`local rehearsal PASSED: replayed with foreign keys enforced on every statement; integrity_check ok; foreign_key_check clean; every table's content equals the export (${Object.keys(r.reference.content).length} critical tables fingerprinted for the scratch comparison)`);
  } else if (mode === "content-sql") {
    const ref = JSON.parse(readFileSync(a, "utf8")) as Reference;
    process.stdout.write(Object.keys(ref.content).map((t) => `${t}\t${ref.content[t].sql}`).join("\n") + "\n");
  } else if (mode === "objects-sql") process.stdout.write(OBJECTS_SQL + "\n");
  else if (mode === "export-counts") process.stdout.write(JSON.stringify([{ results: exportCounts(readFileSync(a, "utf8")) }]) + "\n");
  else if (mode === "sql") process.stdout.write(countQueries(rowsOf(readFileSync(a, "utf8")).map((r) => String(r.name))).join("\n") + "\n");
  else if (mode === "compare") {
    // a / b: comma-separated lists of wrangler JSON outputs (one per counting batch).
    const r = compareCounts(rowsOfAll(a.split(",").map((f) => readFileSync(f, "utf8"))), rowsOfAll(b.split(",").map((f) => readFileSync(f, "utf8"))));
    // --reference/--objects/--fk/--content: the integrity proof on the restored scratch database itself.
    const refPath = arg("--reference");
    if (refPath) {
      const ref = JSON.parse(readFileSync(refPath, "utf8")) as Reference;
      const content: Record<string, Rows> = {};
      for (const pair of (arg("--content") ?? "").split(",").filter(Boolean)) { const [t, f] = pair.split("="); content[t] = rowsOf(readFileSync(f, "utf8")); }
      const extra = verifyRestored(ref, { objects: rowsOf(readFileSync(arg("--objects")!, "utf8")), fk: rowsOf(readFileSync(arg("--fk")!, "utf8")), content });
      r.problems.push(...extra);
      r.passed = r.passed && extra.length === 0;
      r.integrity = { objects: ref.objects.length, criticalTables: Object.keys(ref.content).length, foreignKeyViolations: 0 };
    }
    writeFileSync(arg("--out") ?? "evidence/restore-drill.json", JSON.stringify(drillEvidence(r, { commit: arg("--commit") ?? "0000000", runId: arg("--run-id") ?? `local-drill-${Date.now()}`, startedAt: arg("--started") ?? new Date().toISOString() })));
    console.log(`${r.passed ? "PASSED" : "FAILED"}: ${r.tables} tables, ${r.rows} rows${r.problems.length ? `; ${r.problems.join("; ")}` : ""}`);
    if (!r.passed) process.exit(1);
  } else if (mode === "fail") {
    // A step before the comparison failed (export, scratch database, import): record a failed drill with the reason,
    // so the recovery:restore feed shows it instead of the drill silently leaving no evidence.
    const reason = redactReason(arg("--reason") || "restore drill failed before the comparison");
    writeFileSync(arg("--out") ?? "evidence/restore-drill.json", JSON.stringify(drillEvidence({ passed: false, tables: 0, rows: 0, problems: [reason] }, { commit: arg("--commit") ?? "0000000", runId: arg("--run-id") ?? `local-drill-${Date.now()}`, startedAt: arg("--started") ?? new Date().toISOString() })));
  } else { console.error("usage: restore-drill.ts sql <tables.json> | sanitize <export> <import> | rehearse <export> <import> <reference.json> | content-sql <reference.json> | objects-sql | compare <source.json> <restored.json> [--reference --objects --fk --content t=f,… --commit --run-id --out --started]"); process.exit(2); }
}
