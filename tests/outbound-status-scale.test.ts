// The D1 overload of staging deploy 42514825859 (2026-11-08): /staff/sales computed the outbound-calling counts by
// joining every open lead to every consent through a CORRELATED research_prospects subquery -- ~8.6 s of database time
// at staging scale (36,780 leads, 120 consents) -- which exhausted D1's 10-second resource window, so Sales and the
// twelve Owner modules requested after it answered 500. The counts are now driven from the consents. This pins both
// halves: the right leads are counted (both consent routes), and the query plan has no correlated subquery, so the
// per-lead form cannot come back unnoticed.
//
// Second staging run (deploy 42518473036): with the correlated subquery gone, one /staff/sales request still read
// ~1.06M rows in a minute whose idle baseline is ~25k, and Sales alone answered 500. The uncorrelated form let SQLite
// walk every unmerged lead (idx_leads_merged) and every research record that has a lead (idx_research_prospects_lead),
// filtering by the consent list afterwards. The plan is now pinned to the small side: consents -> research records by
// phone -> leads by primary key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff } from "./support/app.ts";
import { nowIso } from "../src/lib/db.ts";
import { outboundStatus } from "../src/services/outbound-status.ts";
import { CONSENTED_OPEN_WHERE } from "../src/services/sales-outbound.ts";
import type { Env } from "../src/app/context.ts";

async function seed(db: Env["DB"], ownerId: string) {
  const at = nowIso();
  await db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400) INSERT INTO contacts (id, name, created_at) SELECT 'ct_' || i, 'Contact ' || i, ? FROM n`).bind(at).run();
  await db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400) INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) SELECT 'ld_' || i, 'ct_' || i, 'manual', CASE WHEN i = 7 THEN 'lost' ELSE 'new' END, ?, ? FROM n`).bind(at, at).run();
  await db.prepare(`UPDATE leads SET merged_into_lead_id = 'ld_1' WHERE id = 'ld_9'`).run();
  // Research records carry the phone numbers of leads 1..200.
  await db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
    INSERT INTO research_prospects (id, business_key, name, name_norm, sources_json, website_class, website_json, identity_confidence, score, qualified, status, content_hash, last_verified_at, first_seen_at, updated_at, crm_lead_id, phone_e164)
    SELECT 'rp_' || i, 'k:' || i, 'Biz ' || i, 'biz ' || i, '[]', 'NO_OFFICIAL_WEBSITE_FOUND', '{}', 0.9, 50, 1, 'promoted', 'h' || i, ?, ?, ?, 'ld_' || i, '+1614555' || substr('0000' || i, -4) FROM n`).bind(at, at, at).run();
  const consent = (id: string, phone: string, leadId: string | null, revoked = false) => db.prepare(`INSERT INTO sales_call_consents (id, phone_e164, lead_id, consent_type, covers_ai_voice, line_type, signer_name, evidence_ref, disclosure_text, captured_at, recorded_by, recorded_at, revoked_at)
    VALUES (?,?,?, 'prior_express_written', 1, 'landline', 'Signer (TEST)', 'ev', 'disclosure', ?, ?, ?, ?)`).bind(id, phone, leadId, at, ownerId, at, revoked ? at : null).run();
  await consent("scc_a", "+15175550301", "ld_301");          // consent recorded on the lead itself
  await consent("scc_b", "+16145550005", null);              // consent on the number lead 5's research record carries
  await consent("scc_c", "+16145550007", null);              // lead 7 is lost: not counted
  await consent("scc_d", "+16145550009", null);              // lead 9 is merged: not counted
  await consent("scc_e", "+16145550011", null, true);        // revoked: not counted
  await consent("scc_f", "+15175559999", null);              // matches no lead
  await db.prepare(`INSERT INTO sales_calls (id, lead_id, phone_e164, status, attempts, idempotency_key, is_test, created_at, updated_at, mode) VALUES ('scall_x', 'ld_5', '+16145550005', 'completed', 1, 'k-x', 0, ?, ?, 'cold')`).bind(at, at).run();
}

test("[VOICE-005] outbound counts: both consent routes counted, lost/merged/revoked excluded, already-called leads are not candidates", async () => {
  const t = await createTestApp({});
  const owner = await createStaff(t.db, "owner");
  await seed(t.db, owner.id);
  const s = await outboundStatus(t.db, t.env, new Date());
  // Consented open leads: 301 (on the lead) and 5 (through its research phone). Lead 5 already had a cold call.
  assert.equal(s.counts.eligible, 1, "only lead 301 is still a candidate");
  assert.equal(s.counts.noConsent, 398 - 2, "398 open, unmerged leads; 2 have consent");
  assert.deepEqual(s.candidates.map((c) => c.leadId), ["ld_301"]);
});

test("[VOICE-005] outbound counts never use a correlated subquery over leads (the cause of the staging D1 overload)", async () => {
  const t = await createTestApp({});
  const owner = await createStaff(t.db, "owner");
  await seed(t.db, owner.id);
  const sql = `SELECT COUNT(*) FROM leads l WHERE ${CONSENTED_OPEN_WHERE}`;
  const plan = (await t.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()).results.map((r) => r.detail);
  assert.ok(!plan.some((d) => /CORRELATED/i.test(d)), `no correlated subquery: ${plan.join(" | ")}`);
  // The consented set is a LIST SUBQUERY built once (not per lead), and consents are read through their index.
  assert.ok(plan.some((d) => /^LIST SUBQUERY/i.test(d)), `the consented lead set is materialised once: ${plan.join(" | ")}`);
  assert.ok(plan.some((d) => /sc USING INDEX idx_sales_call_consents_phone/.test(d)), `consents are read through their index: ${plan.join(" | ")}`);
});

test("[VOICE-005] outbound counts start from the consents: research records by phone, leads by primary key, no pass over all leads", async () => {
  const t = await createTestApp({});
  const sql = `SELECT COUNT(*) FROM leads l WHERE ${CONSENTED_OPEN_WHERE}`;
  const plan = (await t.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()).results.map((r) => r.detail);
  const all = plan.join(" | ");
  assert.ok(plan.some((d) => /^SEARCH l USING INDEX sqlite_autoindex_leads_1 \(id=\?\)/.test(d)), `leads are fetched by primary key from the consent list: ${all}`);
  assert.ok(plan.some((d) => /^SEARCH rp USING INDEX idx_research_prospects_phone \(phone_e164=\?\)/.test(d)), `research records are found from each consent's phone: ${all}`);
  assert.ok(!/idx_leads_merged|idx_leads_stage|SCAN l\b/.test(all), `no pass over every unmerged or open lead: ${all}`);
  assert.ok(!/idx_research_prospects_lead|SCAN rp\b/.test(all), `no pass over every research record that has a lead: ${all}`);
});
