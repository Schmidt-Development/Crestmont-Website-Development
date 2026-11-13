// Automated database backup (Founder launch closeout, 2026-11-13, criterion 5). The GitHub production-backup workflow
// waits for a production-environment approval on every scheduled run, so in practice it never ran. This backup is
// written by the Worker itself, from its own daily Cron Trigger: no GitHub run, no approval.
//
// What it writes, to the Worker's own private bucket (R2 `crestmont-files-<env>`, never public):
//   _backups/daily/<YYYY-MM-DD>.sql            a complete SQL dump (schema, every row, then indexes/triggers/views),
//                                                restorable with `wrangler d1 execute <db> --remote --file <dump>`
//   _backups/daily/<YYYY-MM-DD>.manifest.json  sha256 of the dump, byte size, per-table row counts
//   _backups/daily/latest.json                  pointer to the newest manifest (what the restore drill reads)
// The bucket's lifecycle rule removes _backups/ objects after 30 days (docs/DEPLOYMENT.md §2).
//
// Every deploy (deploy-production.yml, "Restore drill") restores the latest dump into a throw-away D1 database and
// compares every table's row count with the manifest, then deletes the scratch database. Production is never written.
//
// Pages of 500 rows by rowid. It is not one snapshot transaction (D1 offers none to a Worker): a row written during the
// minute the dump takes may be in or out. D1 Time Travel (30-day point-in-time restore) remains the exact-to-the-minute
// fallback; this is the independent copy.
import type { Db } from "../lib/db.ts";
import type { StorageAdapter } from "../adapters/storage.ts";
import { sha256Hex } from "../lib/crypto.ts";

export const BACKUP_PREFIX = "_backups/daily/";
const PAGE = 500;
const MAX_BYTES = 200 * 1024 * 1024;

export interface BackupManifest {
  key: string;
  createdAt: string;
  sha256: string;
  bytes: number;
  tables: Record<string, number>;
  totalRows: number;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** One SQL literal for a value as D1 (or node:sqlite) returns it. */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v) || Array.isArray(v)) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : Array.isArray(v) ? Uint8Array.from(v as number[]) : new Uint8Array((v as ArrayBufferView).buffer, (v as ArrayBufferView).byteOffset, (v as ArrayBufferView).byteLength);
    return `X'${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

type MasterRow = { type: string; name: string; tbl_name: string; sql: string | null };

/** The complete dump as SQL text plus per-table row counts. Reads only. */
export async function dumpDatabase(db: Db): Promise<{ sql: string; tables: Record<string, number> }> {
  const master = (await db.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) <> '_cf_' ORDER BY rowid`,
  ).all<MasterRow>()).results;
  const parts: string[] = ["PRAGMA defer_foreign_keys=TRUE;\n"];
  let size = parts[0].length;
  const push = (s: string) => {
    size += s.length;
    if (size > MAX_BYTES) throw new Error(`Backup larger than ${MAX_BYTES} bytes; stopping instead of exhausting Worker memory.`);
    parts.push(s);
  };
  const tables: Record<string, number> = {};
  // Every table first: D1 enforces foreign keys, and an INSERT into a table whose parent table does not exist yet fails
  // even with checks deferred.
  const tableRows = master.filter((m) => m.type === "table");
  for (const t of tableRows) push(`${t.sql!.replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?/i, "CREATE TABLE IF NOT EXISTS ")};\n`);
  for (const t of tableRows) {
    const cols = (await db.prepare(`PRAGMA table_info(${ident(t.name)})`).all<{ name: string }>()).results.map((c) => c.name);
    if (!cols.length) { tables[t.name] = 0; continue; }
    const colList = cols.map(ident).join(",");
    const withoutRowid = /\)\s*WITHOUT\s+ROWID\s*;?\s*$/i.test(t.sql!);
    let count = 0, last: number | null = null, offset = 0;
    for (;;) {
      const rows: Record<string, unknown>[] = withoutRowid
        ? (await db.prepare(`SELECT ${colList} FROM ${ident(t.name)} LIMIT ? OFFSET ?`).bind(PAGE, offset).all<Record<string, unknown>>()).results
        : (await db.prepare(`SELECT rowid AS "__cm_rowid", ${colList} FROM ${ident(t.name)} WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(last ?? -9007199254740991, PAGE).all<Record<string, unknown>>()).results;
      for (const r of rows) push(`INSERT INTO ${ident(t.name)} (${colList}) VALUES(${cols.map((c) => sqlLiteral(r[c])).join(",")});\n`);
      count += rows.length;
      if (rows.length < PAGE) break;
      if (withoutRowid) offset += PAGE; else last = Number(rows[rows.length - 1].__cm_rowid);
    }
    tables[t.name] = count;
  }
  // Indexes, triggers and views after the data, so restoring does not fire triggers or rebuild indexes per row.
  for (const m of master.filter((x) => x.type !== "table")) {
    const sql = m.sql!.replace(/^CREATE\s+(UNIQUE\s+)?(INDEX|TRIGGER|VIEW)\s+(IF NOT EXISTS\s+)?/i, (_a, u, k) => `CREATE ${u ?? ""}${k.toUpperCase()} IF NOT EXISTS `);
    push(`${sql};\n`);
  }
  return { sql: parts.join(""), tables };
}

/** Writes today's dump, its manifest and the latest pointer. Overwrites a same-day backup (the later one wins). */
export async function runDatabaseBackup(deps: { db: Db; storage: StorageAdapter; now?: () => Date }): Promise<BackupManifest> {
  const at = (deps.now ?? (() => new Date()))();
  const { sql, tables } = await dumpDatabase(deps.db);
  const bytes = new TextEncoder().encode(sql);
  const day = at.toISOString().slice(0, 10);
  const key = `${BACKUP_PREFIX}${day}.sql`;
  const manifest: BackupManifest = {
    key, createdAt: at.toISOString(), sha256: await sha256Hex(bytes), bytes: bytes.length, tables,
    totalRows: Object.values(tables).reduce((a, b) => a + b, 0),
  };
  await deps.storage.put(key, bytes, "application/sql");
  const m = new TextEncoder().encode(JSON.stringify(manifest, null, 1));
  await deps.storage.put(`${BACKUP_PREFIX}${day}.manifest.json`, m, "application/json");
  await deps.storage.put(`${BACKUP_PREFIX}latest.json`, m, "application/json");
  return manifest;
}
