import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./support/sqlite-d1.ts";
import { censusQueries, eligibilityCensus } from "../src/services/research-promote.ts";
import { dashboard } from "../src/services/research.ts";
import type { Db } from "../src/lib/db.ts";

// Deploy 42340671949: /staff/research ran ~17 full scans of research_prospects per load (12 census counts, five
// dashboard counts) plus a json_each over every row. On staging's data volume that exhausted D1's per-database
// 10-second budget ("D1 DB is overloaded") and four unrelated Owner pages answered HTTP 500 in the same window.

const STATUSES = ["qualified", "not_qualified", "review", "promoted", "existing_crm", "suppressed", "dismissed"];
const CLASSES = ["VERIFIED_OFFICIAL_WEBSITE", "NO_OFFICIAL_WEBSITE_FOUND", "WEBSITE_UNVERIFIED", "BUSINESS_IDENTITY_UNCERTAIN"];

function seeded() {
  const t = createTestDb();
  const now = new Date().toISOString();
  for (let i = 0; i < 60; i++) {
    t.raw.prepare(`INSERT INTO research_prospects (id, business_key, name, name_norm, sources_json, website_class, website_json, identity_confidence, score, qualified, status, content_hash, last_verified_at, first_seen_at, updated_at, eligibility, promote_attempts)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`rp_${i}`, `overture:${i}`, `Biz ${i}`, `biz ${i}`, JSON.stringify([{ source: i % 3 ? "overture" : "common_crawl" }]),
      CLASSES[i % CLASSES.length], "{}", 0.9, (i * 7) % 100, i % 2, STATUSES[i % STATUSES.length], `h${i}`, now, i % 5 ? now : "2020-01-01T00:00:00.000Z", now,
      i % 4 ? "blocked" : "eligible", i % 6);
  }
  return t;
}

/** Counts statements that read research_prospects, by wrapping prepare(). Like the per-request retry wrapper
 *  (src/lib/db.ts), each spy is a NEW object that names the real binding behind it. */
function counting(db: Db) {
  const seen: string[] = [];
  const spy = { [Symbol.for("crestmont.db.rawDatabase")]: db, prepare: (sql: string) => { if (/research_prospects/.test(sql)) seen.push(sql); return db.prepare(sql); }, batch: db.batch.bind(db) } as unknown as Db;
  return { spy, seen };
}

test("[RESEARCH] /staff/research load: the census is ONE scan and returns exactly the per-statement counts", async () => {
  const t = seeded();
  const db = t as unknown as Db;
  const { spy, seen } = counting(db);
  const census = await eligibilityCensus(spy);
  assert.equal(seen.length, 1, "one statement over research_prospects");
  const { loadSettings } = await import("../src/services/research.ts");
  const q = censusQueries((await loadSettings(db)).qualify_threshold);
  for (const [k, sql] of Object.entries(q)) {
    const want = Number((await db.prepare(sql).first<{ n: number }>())!.n);
    assert.equal(census[k as keyof typeof census], want, k);
  }
  assert.equal(census.totalOnRecord, 60);
});

test("[RESEARCH] /staff/research load: dashboard counts are one scan, and per-source coverage is reused within five minutes", async () => {
  const t = seeded();
  const db = t as unknown as Db;
  const now = new Date();
  const first = counting(db);
  const d1 = await dashboard(first.spy, now);
  const scans1 = first.seen.length;
  assert.ok(first.seen.some((s) => /json_each/.test(s)), "coverage computed the first time");
  const second = counting(db);
  const d2 = await dashboard(second.spy, new Date(now.getTime() + 60_000));
  assert.equal(second.seen.filter((s) => /json_each/.test(s)).length, 0, "coverage reused a minute later");
  assert.ok(second.seen.length < scans1);
  assert.deepEqual(d2, { ...d1 }, "same numbers");
  const third = counting(db);
  await dashboard(third.spy, new Date(now.getTime() + 6 * 60_000));
  assert.equal(third.seen.filter((s) => /json_each/.test(s)).length, 1, "recomputed after five minutes");
  assert.ok(first.seen.length <= 6, `research_prospects statements per load: ${first.seen.length}`);
});
