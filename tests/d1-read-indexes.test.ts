// Staging deploy 42523964359 (2026-11-08): with the earlier overloads fixed, D1 still answered "Too many resources
// consumed within a 10 second window" during the browser journeys. D1's own analytics (run 42528453491) named the
// readers: the /staff/research summary and census (each a scan of ~48,500 wide research_prospects rows) and the
// Audit logs filter the refund journey polls (a walk of ~122,000 audit rows per request). Migration 0101 adds two
// read indexes; these tests pin the plans so a later change cannot quietly bring the scans back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff } from "./support/app.ts";
import { censusSql } from "../src/services/research-promote.ts";
import { nowIso } from "../src/lib/db.ts";

const plan = async (db: { prepare(sql: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results: T[] }> } } }, sql: string, ...b: unknown[]) =>
  (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...b).all<{ detail: string }>()).results.map((r) => r.detail).join(" | ");

test("[INFRA-006] /staff/research counts read the covering summary index, never the wide prospect rows", async () => {
  const t = await createTestApp({});
  const summary = `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN qualified = 1 AND first_seen_at >= ?1 THEN 1 ELSE 0 END), 0) AS a,
      COALESCE(SUM(CASE WHEN status IN ('qualified','review') THEN 1 ELSE 0 END), 0) AS b, COALESCE(SUM(CASE WHEN eligibility = 'eligible' AND updated_at >= ?1 THEN 1 ELSE 0 END), 0) AS c,
      COALESCE(SUM(CASE WHEN website_class IN ('WEBSITE_UNVERIFIED','BUSINESS_IDENTITY_UNCERTAIN') THEN 1 ELSE 0 END), 0) AS d FROM research_prospects`;
  for (const [what, sql, binds] of [["dashboard summary", summary, ["2026-11-08T00:00:00.000Z"]], ["eligibility census", censusSql(60), []]] as const) {
    const p = await plan(t.db, sql, ...binds);
    assert.match(p, /USING COVERING INDEX idx_research_prospects_summary/, `${what}: ${p}`);
  }
  for (const col of ["website_class", "status"]) {
    const p = await plan(t.db, `SELECT ${col} AS k, COUNT(*) AS n FROM research_prospects GROUP BY ${col}`);
    assert.match(p, /USING COVERING INDEX/, `group by ${col}: ${p}`);
  }
});

test("[SEC-005] audit 'event name starts with' and 'record type or id' filters use indexes and return exactly the matching entries", async () => {
  const t = await createTestApp({});
  const sql = `SELECT a.id FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.action >= ? AND a.action <= ? AND a.action LIKE ? ESCAPE '\\' AND (a.subject_type = ? OR a.subject_id = ?) ORDER BY a.id DESC LIMIT ? OFFSET ?`;
  const p = await plan(t.db, sql, "payment.refunded", "payment.refunded\u{10FFFF}", "payment.refunded%", "pi_x", "pi_x", 26, 0);
  assert.doesNotMatch(p, /SCAN a\b(?! USING)/, `no walk of the whole audit log: ${p}`);
  assert.match(p, /idx_e_audit_logs_action|idx_audit_subject_id/, `answered from an index: ${p}`);

  // Behaviour through the real route: same results as the LIKE-only filter gave.
  const owner = await createStaff(t.db, "owner");
  const at = nowIso();
  const add = (action: string, subjectType: string, subjectId: string) => t.db.prepare(`INSERT INTO audit_logs (actor_kind, action, subject_type, subject_id, created_at) VALUES ('webhook', ?, ?, ?, ?)`)
    .bind(action, subjectType, subjectId, at).run();
  await add("payment.refunded", "payment", "pi_match_1");
  await add("payment.refunded", "payment", "pi_other");
  await add("payment.refund_failed", "payment", "pi_match_1");
  await add("payments.export", "report", "pi_match_1");
  const c = await t.client().login(owner.email);
  const page = await (await c.get("/staff/audit?action=payment.refunded&subject=pi_match_1")).text();
  assert.equal((page.match(/<li class="audit-entry"/g) ?? []).length, 1, "only the refunded entry of that payment");
  const prefix = await (await c.get("/staff/audit?action=payment.refund&subject=pi_match_1")).text();
  assert.equal((prefix.match(/<li class="audit-entry"/g) ?? []).length, 2, "a prefix still matches both payment.refund* entries, and not payments.export");
});
