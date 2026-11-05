// scripts/d1-analytics.ts must state its coverage: a token that cannot read analytics, a refused query shape and an
// empty window are each reported as such, never as an idle database; statements are shown with their literals masked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyse, render, maskSql } from "../scripts/d1-analytics.ts";

const DB = "11111111-2222-3333-4444-555555555555";
const base = { token: "t", account: "acct", database: DB, from: "2026-11-05T21:30:00Z", to: "2026-11-05T22:10:00Z" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stub = (...answers: (Response | Error)[]) => {
  const calls: { url: string; body: string }[] = [];
  const f = (async (url: string, init?: RequestInit) => { calls.push({ url, body: String(init?.body ?? "") }); const a = answers.shift()!; if (a instanceof Error) throw a; return a; }) as unknown as typeof fetch;
  return { f, calls };
};
const group = (query: string, ms: number, read: number) => ({ count: 3, sum: { queryDurationMs: ms, rowsRead: read, rowsWritten: 0 }, dimensions: { query } });

test("[INFRA-006] D1 analytics: the top statements and the per-minute view, with literals masked", async () => {
  const { f, calls } = stub(
    json({ data: { viewer: { accounts: [{ byDuration: [group("SELECT * FROM leads WHERE email = 'ann@example.com' AND n > 42", 900, 5000)], byRowsRead: [group("SELECT 1", 1, 1)] }] } } }),
    json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { readQueries: 10, writeQueries: 2, rowsRead: 900, rowsWritten: 4 }, dimensions: { datetimeMinute: "2026-11-05T22:01:00Z" } }] }] } } }),
  );
  const r = await analyse({ ...base, fetch: f });
  assert.equal(r.state, "ok");
  const out = render(r, base.from, base.to);
  assert.match(out, /COVERAGE: ok/);
  assert.match(out, /SELECT \* FROM leads WHERE email = '\?' AND n > \?/);
  assert.doesNotMatch(out, /ann@example\.com|42/);
  assert.match(out, /2026-11-05T22:01:00Z {2}10 \/ 2 \/ 900 \/ 4/);
  assert.equal(JSON.parse(calls[0].body).variables.db, DB);
});

test("[INFRA-006] D1 analytics: a token without analytics access says it cannot read, not that D1 was idle", async () => {
  const r = await analyse({ ...base, fetch: stub(json({ data: null, errors: [{ message: "not authorized for that account" }] })).f });
  assert.equal(r.state, "cannot_read");
  assert.match(render(r, base.from, base.to), /says nothing about what consumed the budget/);
  assert.equal((await analyse({ ...base, fetch: stub(new Error("ECONNRESET")).f })).state, "cannot_read");
  assert.equal((await analyse({ ...base, fetch: stub(json({}, 403)).f })).state, "cannot_read");
});

test("[INFRA-006] D1 analytics: a refused query shape is printed, and an empty window is not called idle", async () => {
  const bad = await analyse({ ...base, fetch: stub(json({ data: null, errors: [{ message: "unknown field \"d1QueriesAdaptiveGroups\"" }] })).f });
  assert.equal(bad.state, "schema_error");
  assert.match(render(bad, base.from, base.to), /unknown field/);
  const empty = await analyse({ ...base, fetch: stub(json({ data: { viewer: { accounts: [{ byDuration: [], byRowsRead: [] }] } } })).f });
  assert.equal(empty.state, "empty");
  assert.match(render(empty, base.from, base.to), /NOT evidence that D1 was idle/);
});

test("[INFRA-006] D1 analytics: the database is resolved by name, and a failed per-minute view never hides the statements", async () => {
  const { f, calls } = stub(
    json({ result: [{ name: "crestmont-staging", uuid: DB }] }),
    json({ data: { viewer: { accounts: [{ byDuration: [group("SELECT 1", 5, 1)], byRowsRead: [] }] } } }),
    json({ data: null, errors: [{ message: "unknown field datetimeMinute_geq" }] }),
  );
  const r = await analyse({ ...base, database: "crestmont-staging", fetch: f });
  assert.match(calls[0].url, /d1\/database\?name=crestmont-staging/);
  assert.equal(r.state, "ok");
  assert.match(render(r, base.from, base.to), /per-minute view unavailable: unknown field datetimeMinute_geq[\s\S]*SELECT \?/);
  assert.equal((await analyse({ ...base, database: "crestmont-staging", fetch: stub(json({ result: [] })).f })).state, "cannot_read");
});

test("[INFRA-006] maskSql masks literals but keeps identifiers and placeholders", () => {
  assert.equal(maskSql("SELECT t2.id FROM t2 WHERE x = 'it''s' AND y IN (1, 2.5) AND z = ?1"), "SELECT t2.id FROM t2 WHERE x = '?' AND y IN (?, ?) AND z = ?1");
});
