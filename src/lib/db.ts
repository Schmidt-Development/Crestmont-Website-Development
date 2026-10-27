// Minimal database interface matching the Cloudflare D1 API surface we use.
// Production binds a real D1Database; tests bind a node:sqlite adapter
// (tests/support/sqlite-d1.ts) that runs the same SQL migrations.

export interface DbResult<T> { results: T[] }
export interface DbRunResult { meta: { changes: number; last_row_id?: number } }

export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  all<T = Record<string, unknown>>(): Promise<DbResult<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<DbRunResult>;
}

export interface Db {
  prepare(sql: string): DbStatement;
  batch(statements: DbStatement[]): Promise<DbRunResult[]>;
}

export function nowIso(clock: () => Date = () => new Date()): string {
  return clock().toISOString();
}

export function newId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}
