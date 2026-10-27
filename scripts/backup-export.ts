// Full logical SQL export of a SQLite / D1 database (TEST-004, INFRA-006, BACKUP-RECOVERY §3.2).
//
// Output format follows `wrangler d1 export`: `PRAGMA defer_foreign_keys=TRUE;`, then for each table
// its CREATE TABLE statement and one INSERT per row, then indexes, views and triggers (triggers last so
// that append-only guards such as audit_logs_no_update are re-created AFTER the data is loaded).
// The d1_migrations bookkeeping table is included, so a restored database knows which migrations ran.
//
//   Local:  node --no-warnings scripts/backup-export.ts --db .dev/crestmont.db --out backups/dev-YYYYMMDD.sql
//   D1:     wrangler d1 export crestmont-staging --remote --output backups/staging.sql   (same format)
//
// Prints the SHA-256 and byte size of the export so they can be recorded at /staff/backups.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString("hex")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

interface SchemaRow { type: string; name: string; tbl_name: string; sql: string | null }

/** Tables SQLite manages itself; never exported (sqlite_sequence is re-derived from AUTOINCREMENT ids on insert). */
const INTERNAL = (name: string) => name.startsWith("sqlite_") || name.startsWith("_cf_");

export function exportSql(db: DatabaseSync): string {
  const schema = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, rowid`).all() as unknown as SchemaRow[];
  const out: string[] = ["PRAGMA defer_foreign_keys=TRUE;"];
  for (const t of schema.filter((s) => s.type === "table" && !INTERNAL(s.name))) {
    out.push(`${t.sql};`);
    const cols = (db.prepare(`PRAGMA table_info(${quoteIdent(t.name)})`).all() as { name: string }[]).map((c) => c.name);
    const rows = db.prepare(`SELECT ${cols.map(quoteIdent).join(", ")} FROM ${quoteIdent(t.name)} ORDER BY rowid`).all() as Record<string, unknown>[];
    for (const r of rows) out.push(`INSERT INTO ${quoteIdent(t.name)} (${cols.map(quoteIdent).join(",")}) VALUES(${cols.map((c) => literal(r[c])).join(",")});`);
  }
  for (const s of schema.filter((x) => x.type !== "table" && !INTERNAL(x.name))) out.push(`${s.sql};`);
  return out.join("\n") + "\n";
}

export function digest(sql: string): { sha256: string; bytes: number } {
  return { sha256: createHash("sha256").update(sql, "utf8").digest("hex"), bytes: Buffer.byteLength(sql, "utf8") };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dbPath = get("--db");
  const outPath = get("--out");
  if (!dbPath || !outPath) { console.error("Usage: --db <sqlite file> --out <export.sql>"); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const sql = exportSql(db);
  db.close();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, sql, { mode: 0o600 }); // contains personal and financial data
  const d = digest(sql);
  console.log(JSON.stringify({ export: outPath, sha256: d.sha256, bytes: d.bytes, takenAt: new Date().toISOString() }));
}
