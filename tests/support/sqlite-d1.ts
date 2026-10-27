// node:sqlite adapter implementing the D1 subset in src/lib/db.ts, so tests run the
// real migrations and real SQL. D1 is SQLite, so constraint behaviour matches.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db, DbStatement } from "../../src/lib/db.ts";

class Stmt implements DbStatement {
  private values: unknown[] = [];
  private readonly db: DatabaseSync;
  readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...values: unknown[]): DbStatement { const s = new Stmt(this.db, this.sql); s.values = values.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v)); return s; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...(this.values as never[])) as T[] }; }
  async first<T>() { return (this.db.prepare(this.sql).get(...(this.values as never[])) as T) ?? null; }
  async run() { const r = this.db.prepare(this.sql).run(...(this.values as never[])); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
  runSync() { const r = this.db.prepare(this.sql).run(...(this.values as never[])); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
}

export function createTestDb(): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON;");
  const dir = join(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) raw.exec(readFileSync(join(dir, f), "utf8"));
  return {
    raw,
    prepare: (sql: string) => new Stmt(raw, sql),
    async batch(stmts: DbStatement[]) {
      // D1 batches are transactional: all succeed or all roll back.
      raw.exec("BEGIN");
      try {
        const out = stmts.map((s) => (s as Stmt).runSync());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
