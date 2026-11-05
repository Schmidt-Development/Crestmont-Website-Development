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

/**
 * Cloudflare's own transient failures, as opposed to anything this application did wrong.
 *
 * Staging deploys #150 and #151 failed on these. The deploy's error-log step read back seven distinct
 * `D1_ERROR: internal error; reference = …` faults in 90 minutes, each with a Cloudflare reference id, in
 * code paths with nothing in common: a runner heartbeat, `claimSignatureOnce` in runner authentication,
 * `recordRunUsage`, `leased`, and `getBuildSettings` inside a page assembling thirteen queries with
 * Promise.all. Different modules failed in each deploy — #150 verified all 32 Owner modules and then found
 * three 500s in the browser journeys; #151 failed verification on Integrations, Monitoring, Security and
 * Audit logs, the four query-heaviest pages. That is a platform fault, and it is also what the earlier
 * "six modules at 500" was: it could never be reproduced because there was nothing in the code to find.
 *
 * A page that issues dozens of independent queries should not be taken out by one of them hitting a
 * transient platform error, so a read is retried a bounded number of times.
 *
 * Deliberately narrow. A deterministic error must fail on the first attempt and be seen: a constraint
 * violation, a missing column, "LIKE or GLOB pattern too complex", "too many terms in compound SELECT".
 * Retrying those would only turn a clear failure into a slow one.
 */
export function isTransientDbError(e: unknown): boolean {
  const m = String((e as { message?: unknown })?.message ?? e);
  return /D1_ERROR:\s*internal error/i.test(m)
    || /Network connection lost/i.test(m)
    || /D1_RESET_DO/i.test(m)
    || /storage operation exceeded timeout/i.test(m);
}

/** How many times a read is attempted in total (one try plus two retries). */
export const DB_READ_ATTEMPTS = 3;

/**
 * Wraps a database so READS retry on a transient platform error. Writes are never retried: `run` and
 * `batch` may already have applied when the error surfaced, and repeating one could double-apply it. A
 * write that hits a transient error still fails, loudly, exactly as before.
 *
 * If every attempt fails the last error is thrown unchanged, so nothing is hidden and recordAppError still
 * sees it.
 */
export function withTransientRetry(
  db: Db,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Db {
  const attempts = Math.max(1, opts.attempts ?? DB_READ_ATTEMPTS);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function read<T>(op: () => Promise<T>): Promise<T> {
    for (let i = 1; ; i++) {
      try { return await op(); }
      catch (e) {
        if (i >= attempts || !isTransientDbError(e)) throw e;
        await sleep(25 * i * i); // 25ms, then 100ms: short enough to stay well inside a request
      }
    }
  }

  // The underlying statement, kept on the wrapper so batch() can hand the real one back. D1 and the
  // node:sqlite adapter both take their OWN statement objects in batch() — the adapter casts to its class
  // and calls runSync() — so passing a wrapper through would break every batched write.
  const wrapStatement = (stmt: DbStatement): DbStatement => ({
    [RAW]: stmt,
    bind: (...values: unknown[]) => wrapStatement(stmt.bind(...values)),
    all: <T = Record<string, unknown>>() => read(() => stmt.all<T>()),
    first: <T = Record<string, unknown>>() => read(() => stmt.first<T>()),
    run: () => stmt.run(),
  } as DbStatement);

  return {
    prepare: (sql: string) => wrapStatement(db.prepare(sql)),
    batch: (statements: DbStatement[]) => db.batch(statements.map(unwrapStatement)),
  };
}

/** Marks the real statement carried by a wrapper, so batch() can unwrap it. */
const RAW = Symbol.for("crestmont.db.rawStatement");

/** The underlying statement of a wrapped one, or the statement itself when it was never wrapped. */
export function unwrapStatement(stmt: DbStatement): DbStatement {
  return (stmt as unknown as Record<symbol, DbStatement | undefined>)[RAW] ?? stmt;
}
