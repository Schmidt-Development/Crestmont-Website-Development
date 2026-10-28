// node:sqlite adapter implementing the D1 subset used by the platform (development + tests only).
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db, DbStatement } from "../src/lib/db.ts";

export const D1_MAX_BOUND_PARAMETERS = 100;

class Stmt implements DbStatement {
  private values: unknown[] = [];
  private readonly db: DatabaseSync;
  readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...values: unknown[]): DbStatement {
    // Cloudflare D1 rejects a query with more than 100 bound parameters (developers.cloudflare.com/d1/platform/limits);
    // SQLite allows 32766, so without this check such a query passes every local test and fails only when deployed.
    if (values.length > D1_MAX_BOUND_PARAMETERS) throw new Error(`D1 limit: ${values.length} bound parameters (maximum ${D1_MAX_BOUND_PARAMETERS}) in: ${this.sql.replace(/\s+/g, " ").slice(0, 120)}`);
    const s = new Stmt(this.db, this.sql); s.values = values.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v)); return s;
  }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...(this.values as never[])) as T[] }; }
  async first<T>() { return (this.db.prepare(this.sql).get(...(this.values as never[])) as T) ?? null; }
  async run() { return this.runSync(); }
  runSync() { const r = this.db.prepare(this.sql).run(...(this.values as never[])); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
}

export type SqliteDb = Db & { raw: DatabaseSync };

export const MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");

/** Applies migrations not yet recorded in d1_migrations (same bookkeeping table name Wrangler uses). */
export function migrate(raw: DatabaseSync): string[] {
  raw.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL)`);
  const done = new Set((raw.prepare(`SELECT name FROM d1_migrations`).all() as { name: string }[]).map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    raw.exec("BEGIN");
    try {
      raw.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      raw.prepare(`INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)`).run(f, new Date().toISOString());
      raw.exec("COMMIT");
      applied.push(f);
    } catch (e) { raw.exec("ROLLBACK"); throw new Error(`Migration ${f} failed: ${(e as Error).message}`); }
  }
  return applied;
}

export function openDb(path = ":memory:"): SqliteDb {
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  migrate(raw);
  return {
    raw,
    prepare: (sql: string) => new Stmt(raw, sql),
    async batch(stmts: DbStatement[]) {
      raw.exec("BEGIN");
      try {
        const out = stmts.map((s) => (s as Stmt).runSync());
        raw.exec("COMMIT");
        return out;
      } catch (e) { raw.exec("ROLLBACK"); throw e; }
    },
  };
}
