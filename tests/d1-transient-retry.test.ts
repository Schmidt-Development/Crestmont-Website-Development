// Deploys #150 and #151 failed on Cloudflare's own transient D1 faults, not on anything in this codebase.
// The deploy's error-log step read back seven distinct `D1_ERROR: internal error; reference = …` faults in
// 90 minutes, each with a Cloudflare reference id, in code paths with nothing in common: a runner heartbeat,
// claimSignatureOnce in runner authentication, recordRunUsage, leased, and getBuildSettings inside a page
// assembling thirteen queries with Promise.all. #150 verified all 32 Owner modules and then found three 500s
// in the browser journeys; #151 failed verification on Integrations, Monitoring, Security and Audit logs —
// the four query-heaviest pages. Different modules each time, which is what a platform fault looks like, and
// what the earlier unreproducible "six modules at 500" was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTransientRetry, isTransientDbError, DB_READ_ATTEMPTS, type Db, type DbStatement } from "../src/lib/db.ts";

const D1_INTERNAL = "D1_ERROR: internal error; reference = rajoo34nrapthv2028vlgprv";

/** A database that throws `error` on the first `failures` calls of each operation, then succeeds. */
function flaky(failures: number, error: string) {
  const calls = { all: 0, first: 0, run: 0, batch: 0, prepared: [] as string[], bound: [] as unknown[][] };
  const attempt = (kind: "all" | "first" | "run" | "batch") => {
    calls[kind]++;
    if (calls[kind] <= failures) throw new Error(error);
  };
  const stmt = (): DbStatement => ({
    bind: (...v: unknown[]) => { calls.bound.push(v); return stmt(); },
    all: async <T,>() => { attempt("all"); return { results: [{ ok: 1 }] as unknown as T[] }; },
    first: async <T,>() => { attempt("first"); return { ok: 1 } as unknown as T; },
    run: async () => { attempt("run"); return { meta: { changes: 1 } }; },
  });
  const db: Db = {
    prepare: (sql: string) => { calls.prepared.push(sql); return stmt(); },
    batch: async () => { attempt("batch"); return [{ meta: { changes: 1 } }]; },
  };
  return { db, calls };
}

const noSleep = { sleep: async () => {} };

test("[INFRA-006] a read survives a transient Cloudflare D1 fault instead of taking out the page", async () => {
  for (const kind of ["all", "first"] as const) {
    const f = flaky(DB_READ_ATTEMPTS - 1, D1_INTERNAL);
    const db = withTransientRetry(f.db, noSleep);
    const stmt = db.prepare("SELECT 1").bind("x");
    const got = kind === "all" ? await stmt.all() : await stmt.first();
    assert.ok(got, `${kind} eventually succeeded`);
    assert.equal(f.calls[kind], DB_READ_ATTEMPTS, `${kind} was attempted ${DB_READ_ATTEMPTS} times`);
  }
});

test("[INFRA-006] when every attempt fails the original error is thrown, so nothing is hidden", async () => {
  const f = flaky(Infinity, D1_INTERNAL);
  const db = withTransientRetry(f.db, noSleep);
  await assert.rejects(() => db.prepare("SELECT 1").all(), /D1_ERROR: internal error; reference = rajoo34nrapthv2028vlgprv/,
    "recordAppError must still see the real fault, reference id and all");
  assert.equal(f.calls.all, DB_READ_ATTEMPTS, "bounded: it does not retry forever");
});

test("[INFRA-006] a deterministic error fails on the first attempt and is not retried", async () => {
  // Retrying any of these would turn a clear failure into a slow one and hide nothing useful. The LIKE
  // pattern limit and the compound-SELECT limit are both real D1 errors this repository has already hit.
  for (const msg of [
    "LIKE or GLOB pattern too complex: SQLITE_ERROR [code: 7500]",
    "too many terms in compound SELECT",
    "UNIQUE constraint failed: users.email",
    "no such column: count",
    "D1_ERROR: no such table: evidence_results",
  ]) {
    assert.equal(isTransientDbError(new Error(msg)), false, `${msg} is not transient`);
    const f = flaky(1, msg);
    const db = withTransientRetry(f.db, noSleep);
    await assert.rejects(() => db.prepare("SELECT 1").all(), new RegExp(msg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(f.calls.all, 1, `${msg} was attempted once`);
  }
});

test("[INFRA-006] a write is never retried: it may already have applied", async () => {
  // run() and batch() can fail after the write landed, so repeating one could double-apply it. A write that
  // hits a transient fault still fails, exactly as before.
  for (const kind of ["run", "batch"] as const) {
    const f = flaky(1, D1_INTERNAL);
    const db = withTransientRetry(f.db, noSleep);
    await assert.rejects(() => (kind === "run" ? db.prepare("INSERT INTO t VALUES (1)").run() : db.batch([f.db.prepare("INSERT INTO t VALUES (1)")])),
      /D1_ERROR: internal error/);
    assert.equal(f.calls[kind], 1, `${kind} was attempted once`);
  }
});

test("[INFRA-006] the transient signatures are the platform's, and binding survives the wrapper", async () => {
  for (const msg of ["D1_ERROR: internal error; reference = x", "Network connection lost", "D1_RESET_DO", "storage operation exceeded timeout"]) {
    assert.equal(isTransientDbError(new Error(msg)), true, msg);
  }
  assert.equal(isTransientDbError(undefined), false);
  assert.equal(isTransientDbError("D1_ERROR: internal error"), true, "a thrown string is still read");

  // bind() returns a wrapped statement, so a retry applies to a bound query too — and the values reach through.
  const f = flaky(1, D1_INTERNAL);
  const db = withTransientRetry(f.db, noSleep);
  await db.prepare("SELECT ? , ?").bind("a", 2).all();
  assert.deepEqual(f.calls.bound, [["a", 2]]);
  assert.deepEqual(f.calls.prepared, ["SELECT ? , ?"]);
});

test("[INFRA-006] the request and cron entry points both apply it, so no caller has to remember", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["src/app/app.ts", "src/app/scheduled.ts"]) {
    assert.match(readFileSync(file, "utf8"), /env = \{ \.\.\.env, DB: withTransientRetry\(env\.DB\) \}/,
      `${file} wraps the binding at its entry point`);
  }
});

test("[INFRA-006] batch() hands the real statements back, not the wrappers", async () => {
  // D1 and the node:sqlite adapter both take their OWN statement objects in batch(): the adapter casts to
  // its class and calls runSync(). Passing a wrapper through broke every batched write in the suite — 291
  // tests — so the wrapper carries the real statement and batch() unwraps it.
  const seen: DbStatement[] = [];
  const raw = { bind: () => raw, all: async () => ({ results: [] }), first: async () => null, run: async () => ({ meta: { changes: 0 } }) } as unknown as DbStatement;
  const inner: Db = { prepare: () => raw, batch: async (s) => { seen.push(...s); return []; } };

  const db = withTransientRetry(inner, noSleep);
  const wrapped = db.prepare("INSERT INTO t VALUES (?)").bind(1);
  assert.notEqual(wrapped, raw, "prepare returns a wrapper");
  await db.batch([wrapped]);
  assert.deepEqual(seen, [raw], "batch received the underlying statement");

  // A statement that was never wrapped passes through untouched, so mixing sources is safe.
  seen.length = 0;
  await db.batch([raw]);
  assert.deepEqual(seen, [raw]);
});

test("[INFRA-006] a real batched write still works end to end through the wrapper", async () => {
  // The unit test above proves the unwrapping; this proves the whole path against the real adapter, which
  // is what the 291 failures were.
  const { createTestDb } = await import("./support/sqlite-d1.ts");
  const inner = createTestDb();
  try {
    const db = withTransientRetry(inner);
    await db.batch([
      db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES (?, ?, ?)`).bind("retry.probe.a", "1", "2026-11-05T00:00:00Z"),
      db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES (?, ?, ?)`).bind("retry.probe.b", "2", "2026-11-05T00:00:00Z"),
    ]);
    const rows = (await db.prepare(`SELECT key, value FROM business_settings WHERE key LIKE 'retry.probe.%' ORDER BY key`)
      .all<{ key: string; value: string }>()).results;
    assert.deepEqual(rows.map((r) => [r.key, r.value]), [["retry.probe.a", "1"], ["retry.probe.b", "2"]]);
  } finally { (inner as unknown as { raw: { close(): void } }).raw.close(); }
});

test("[INFRA-006] when the error log itself cannot be written, the loss is reported, not swallowed", async () => {
  // recordAppError writes to D1 and used to swallow its own failure entirely. A D1 fault therefore took out
  // the INSERT and the record of the original error together — which is what deploys #150 to #152 ran into:
  // four Owner modules answered 500 and app_errors held nothing for them, so the deploy's error-log step
  // reported "no application errors" and the pages read as healthy.
  const { recordAppError } = await import("../src/services/monitoring.ts");
  const dead: Db = {
    prepare: () => ({ bind: () => ({ run: async () => { throw new Error(D1_INTERNAL); } }) }) as unknown as DbStatement,
    batch: async () => [],
  };
  const lines: string[] = [];
  const realError = console.error;
  console.error = (m?: unknown) => { lines.push(String(m)); };
  try {
    // It must still not throw: a failing error log cannot be allowed to replace the real response.
    await recordAppError(dead, { path: "/staff/security", message: "original failure", stack: "at x", environment: "staging" });
  } finally { console.error = realError; }

  assert.equal(lines.length, 1, "exactly one line, not a stack-trace storm");
  const logged = JSON.parse(lines[0]) as { message: string; reason: string; path: string; original: string };
  assert.match(logged.message, /app_errors write failed/);
  assert.match(logged.reason, /D1_ERROR: internal error/, "why the record was lost");
  assert.equal(logged.path, "/staff/security");
  assert.equal(logged.original, "original failure", "and what was lost");
});

test("[SEC-007] the lost-record line is redacted like every other stored error", async () => {
  // It carries the original message, so it goes through the same redaction: a line in the Worker log is as
  // readable as a row in app_errors.
  const { recordAppError } = await import("../src/services/monitoring.ts");
  const dead: Db = {
    prepare: () => ({ bind: () => ({ run: async () => { throw new Error(D1_INTERNAL); } }) }) as unknown as DbStatement,
    batch: async () => [],
  };
  const lines: string[] = [];
  const realError = console.error;
  console.error = (m?: unknown) => { lines.push(String(m)); };
  try {
    await recordAppError(dead, { path: "/api/webhooks/stripe", message: "refused key sk_test_abcdef0123456789 for dana@example.com", environment: "staging" });
  } finally { console.error = realError; }
  const logged = JSON.parse(lines[0]) as { original: string };
  assert.ok(!logged.original.includes("sk_test_abcdef0123456789"), "the key is redacted");
  assert.match(logged.original, /sk_test_\[redacted\]/);
});
