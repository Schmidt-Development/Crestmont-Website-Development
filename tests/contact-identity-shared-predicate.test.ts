// Equivalence proof for migration 0082's change to contacts_identity_ai / _au.
//
// Both triggers ended with a statement that marked an identity `shared = 1` when the contacts linked to it
// span more than one business. It read contact_identity_business_count_v — a GROUP BY over every link joined
// to every contact — so SQLite computed business counts for the WHOLE database on every contact write:
// 110 calls, 5.4 million rows read, ~455 ms per insert in staging deploy #160's window.
//
// 0082 counts only the identities linked to the row being written. `shared` decides whether an identity may
// merge contacts, so marking one identity too few or too many is a duplicate-protection defect, not a
// performance detail. The two predicates are therefore compared directly on randomized data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./support/sqlite-d1.ts";
import type { Db } from "../src/lib/db.ts";

/** The predicate as it was: identities of NEW.id, scored through the whole-table view. */
const OLD = `SELECT id FROM contact_identities WHERE shared = 0 AND id IN (
  SELECT b.identity_id FROM contact_identity_business_count_v b
  JOIN contact_identity_links l ON l.identity_id = b.identity_id
  WHERE l.contact_id = ? AND b.businesses > 1)`;

/** The predicate as 0082 writes it: the same identities, counted one at a time. */
const NEW = `SELECT id FROM contact_identities WHERE shared = 0
  AND id IN (SELECT l.identity_id FROM contact_identity_links l WHERE l.contact_id = ?)
  AND (SELECT COUNT(DISTINCT COALESCE(c.company_id, 'contact:' || c.id)) FROM contact_identity_links l2
         JOIN contacts c ON c.id = l2.contact_id WHERE l2.identity_id = contact_identities.id AND l2.removed_at IS NULL) > 1`;

const ids = async (db: Db, sql: string, contactId: string) =>
  (await db.prepare(sql).bind(contactId).all<{ id: string }>()).results.map((r) => r.id).sort();

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

test("[CRM-002] the shared-marking predicate is unchanged by migration 0082", async () => {
  for (const seed of [1, 2, 3, 5, 7, 11, 13, 17, 19, 23]) {
    const db = createTestDb();
    try {
      const r = rng(seed);
      const companies = ["co_a", "co_b", "co_c"];
      for (const id of companies) {
        await db.prepare(`INSERT INTO companies (id, name, created_at) VALUES (?,?,'2026-01-01T00:00:00Z')`).bind(id, id.toUpperCase()).run();
      }
      // Contacts, some sharing a company, some with none (so COALESCE's 'contact:'||id branch is exercised).
      const contactIds: string[] = [];
      for (let i = 0; i < 18; i++) {
        const id = `ctc_${seed}_${i}`;
        contactIds.push(id);
        const co = r() < 0.75 ? companies[Math.floor(r() * companies.length)] : null;
        await db.prepare(`INSERT INTO contacts (id, name, company_id, created_at) VALUES (?,?,?,'2026-01-01T00:00:00Z')`)
          .bind(id, `Person ${i}`, co).run();
      }
      // Identities, some already shared (excluded by `shared = 0` in both forms).
      const identityIds: string[] = [];
      for (let i = 0; i < 8; i++) {
        const id = `cid_${seed}_${i}`;
        identityIds.push(id);
        await db.prepare(`INSERT INTO contact_identities (id, kind, value_norm, display_value, first_source, shared, created_at, updated_at)
          VALUES (?,?,?,?,'contact_write',?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`)
          .bind(id, i % 2 ? "email" : "phone", `v${seed}_${i}`, `v${seed}_${i}`, r() < 0.25 ? 1 : 0).run();
      }
      // Links, a quarter of them REMOVED — the case where the two forms could diverge, because the view
      // filters removed links on the counting side while the NEW.id side never did.
      for (const cid of identityIds) {
        for (const ctc of contactIds) {
          if (r() > 0.3) continue;
          await db.prepare(`INSERT INTO contact_identity_links (id, identity_id, contact_id, role, original_value, source, created_at, last_seen_at, removed_at)
            VALUES (?,?,?,'primary','v','contact_write','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',?)`)
            .bind(`lnk_${cid}_${ctc}`, cid, ctc, r() < 0.25 ? "2026-02-01T00:00:00Z" : null).run();
        }
      }
      for (const ctc of contactIds) {
        assert.deepEqual(await ids(db, NEW, ctc), await ids(db, OLD, ctc), `seed ${seed}, contact ${ctc}`);
      }
    } finally { (db as unknown as { raw: { close(): void } }).raw.close(); }
  }
});

test("[CRM-002] an identity whose links are all removed is excluded by both forms", async () => {
  // The old form could not see it (the view has no row for it); the new form counts 0. Same answer, and
  // worth pinning because it is the one case where "no row" and "zero" could have diverged.
  const db = createTestDb();
  try {
    await db.prepare(`INSERT INTO companies (id, name, created_at) VALUES ('co_a','A','2026-01-01T00:00:00Z'), ('co_b','B','2026-01-01T00:00:00Z')`).run();
    await db.prepare(`INSERT INTO contacts (id, name, company_id, created_at) VALUES ('ctc_1','One','co_a','2026-01-01T00:00:00Z'), ('ctc_2','Two','co_b','2026-01-01T00:00:00Z')`).run();
    await db.prepare(`INSERT INTO contact_identities (id, kind, value_norm, display_value, first_source, shared, created_at, updated_at) VALUES ('cid_1','email','a@b.test','a@b.test','contact_write',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run();
    for (const c of ["ctc_1", "ctc_2"]) {
      await db.prepare(`INSERT INTO contact_identity_links (id, identity_id, contact_id, role, original_value, source, created_at, last_seen_at, removed_at)
        VALUES (?, 'cid_1',?,'primary','a@b.test','contact_write','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-02-01T00:00:00Z')`).bind(`lnk_${c}`, c).run();
    }
    assert.deepEqual(await ids(db, OLD, "ctc_1"), [], "all links removed: nothing to mark");
    assert.deepEqual(await ids(db, NEW, "ctc_1"), []);

    // Restore one link: one business only, so still not shared, in both forms.
    await db.prepare(`UPDATE contact_identity_links SET removed_at = NULL WHERE contact_id = 'ctc_1'`).run();
    assert.deepEqual(await ids(db, NEW, "ctc_1"), await ids(db, OLD, "ctc_1"));
    assert.deepEqual(await ids(db, NEW, "ctc_1"), []);

    // Restore the second, spanning two companies: now shared, in both forms.
    await db.prepare(`UPDATE contact_identity_links SET removed_at = NULL WHERE contact_id = 'ctc_2'`).run();
    assert.deepEqual(await ids(db, NEW, "ctc_1"), ["cid_1"]);
    assert.deepEqual(await ids(db, NEW, "ctc_1"), await ids(db, OLD, "ctc_1"));
  } finally { (db as unknown as { raw: { close(): void } }).raw.close(); }
});

test("[CRM-002] [DATA-001] the recreated triggers still exist and no longer read the whole-table view", async () => {
  const db = createTestDb();
  try {
    const rows = (await db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('contacts_identity_ai','contacts_identity_au') ORDER BY name`)
      .all<{ name: string; sql: string }>()).results;
    assert.deepEqual(rows.map((r) => r.name), ["contacts_identity_ai", "contacts_identity_au"]);
    for (const r of rows) {
      // Comments are stripped first: SQLite stores a trigger's text verbatim, and 0082's comment names the
      // view it stopped reading. Asserting on the raw text fails on the explanation rather than the code —
      // which is exactly how the first version of this test "caught" a migration that was already correct.
      const code = r.sql.replace(/--[^\n]*/g, "");
      assert.doesNotMatch(code, /contact_identity_business_count_v/, `${r.name} must not materialize the whole-table view`);
      assert.match(code, /COUNT\(DISTINCT COALESCE\(c\.company_id/, `${r.name} counts businesses inline`);
    }
    // The view itself stays: contact-identity.ts and 0048's backfill read it.
    assert.ok(await db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'contact_identity_business_count_v'`).first());
  } finally { (db as unknown as { raw: { close(): void } }).raw.close(); }
});
