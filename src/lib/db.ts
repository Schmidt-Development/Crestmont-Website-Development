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

/**
 * D1's LIKE/GLOB pattern limit. A longer pattern is refused with
 * "LIKE or GLOB pattern too complex: SQLITE_ERROR [code: 7500]" — observed on staging when a 56-byte
 * pattern in migration 0068 failed to apply. Local SQLite's limit is 50000, so nothing reproduces it off D1.
 */
export const LIKE_PATTERN_LIMIT = 50;

/**
 * A `%needle%` pattern safe to send to D1: special characters escaped for `ESCAPE '\'` and the whole
 * pattern truncated to LIKE_PATTERN_LIMIT bytes without ever splitting an escape pair or a UTF-8
 * sequence. A search long enough to be truncated matches a prefix of itself, which still returns the
 * rows the user is looking for — far better than a 500. Every LIKE pattern built from user input goes
 * through here; a literal pattern in SQL must be kept short by hand (tests/ops-closeout.test.ts).
 */
export function likeContains(needle: string): string {
  return `%${capBytes(escapeLike(needle), LIKE_PATTERN_LIMIT - 2)}%`;
}

/** As likeContains, but anchored at the start: `needle%`. */
export function likePrefix(needle: string): string {
  return `${capBytes(escapeLike(needle), LIKE_PATTERN_LIMIT - 1)}%`;
}

/** Escape the LIKE wildcards and the escape character itself, for use with `ESCAPE '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Truncate to at most `maxBytes` UTF-8 bytes, never splitting a character or a `\x` escape pair. */
function capBytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  let out = "";
  for (const ch of s) {
    const next = out + ch;
    if (enc.encode(next).length > maxBytes) break;
    out = next;
  }
  // A trailing lone backslash would escape the closing '%' and change the meaning of the pattern.
  const trailing = /\\+$/.exec(out)?.[0].length ?? 0;
  return trailing % 2 === 1 ? out.slice(0, -1) : out;
}
