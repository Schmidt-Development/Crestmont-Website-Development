// Local stand-in for Cloudflare D1 over node:sqlite (Node 22), used by the acceptance gates and tests offline.
// Same surface the website uses: prepare().bind().first()/all()/run(), batch() (atomic), exec(). The real
// migrations in migrations/ are applied in order, exactly as `wrangler d1 migrations apply` would.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : typeof a === "boolean" ? (a ? 1 : 0) : a))); }
  #s() { return this.db.prepare(this.sql); }
  async first(col) { const r = this.#s().get(...this.args); if (!r) return null; const o = { ...r }; return col ? o[col] : o; }
  async all() { return { results: this.#s().all(...this.args).map((r) => ({ ...r })), success: true, meta: {} }; }
  async run() { const r = this.#s().run(...this.args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
  runSync() { const r = this.#s().run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; }
  allSync() { return this.#s().all(...this.args).map((r) => ({ ...r })); }
}

export class LocalD1 {
  constructor(file = ":memory:") {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys = ON;");
  }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec("BEGIN");
    try {
      const out = stmts.map((s) => (/^\s*(select|with)\b/i.test(s.sql) ? { results: s.allSync(), meta: {} } : s.runSync()));
      this.db.exec("COMMIT");
      return out;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  async exec(sql) { this.db.exec(sql); return { count: 1 }; }
  close() { this.db.close(); }
}

/** Fresh database with every migration applied in file-name order. Returns { db, applied }. */
export function migratedDb(root, file = ":memory:") {
  const d1 = new LocalD1(file);
  const dir = path.join(root, "migrations");
  const files = readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  for (const f of files) d1.db.exec(readFileSync(path.join(dir, f), "utf8"));
  return { db: d1, applied: files };
}
