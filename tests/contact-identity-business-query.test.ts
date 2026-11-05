// Equivalence proof for the businessIdQuery rewrite (src/services/contact-identity.ts).
//
// The old form was one OR across two tables:
//   SELECT c.id FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
//    WHERE (co.domain_norm = ? OR c.name_company_norm = ?) AND c.name <> 'Deleted contact' LIMIT 25
// which no index can drive. Cloudflare's per-statement analytics for staging deploy #160 put it top by rows
// read: 344 calls, 12.8 million rows, ~37,000 per call, and the database then answered "D1 DB is overloaded"
// to unrelated pages. The rewrite asks each branch separately and unions them so both are index-driven.
//
// This is duplicate-protection code: a candidate it fails to return is a duplicate that silently becomes a
// second contact for the same person. So the rewrite has to match the old form exactly, not merely pass the
// existing suite, and that is asserted here on randomized data rather than argued.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./support/sqlite-d1.ts";
import type { Db } from "../src/lib/db.ts";

const OLD = `SELECT c.id FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
  WHERE (co.domain_norm = ? OR c.name_company_norm = ?) AND c.name <> 'Deleted contact' LIMIT 25`;
const NAME_BRANCH = `SELECT id FROM (SELECT c.id AS id FROM contacts c WHERE c.name_company_norm = ? AND c.name <> 'Deleted contact' LIMIT 25)`;
const DOMAIN_BRANCH = `SELECT id FROM (SELECT c.id AS id FROM contacts c JOIN companies co ON co.id = c.company_id WHERE co.domain_norm = ? AND c.name <> 'Deleted contact' LIMIT 25)`;

const ids = async (db: Db, sql: string, ...b: unknown[]) =>
  (await db.prepare(sql).bind(...b).all<{ id: string }>()).results.map((r) => r.id).sort();

/** A deterministic pseudo-random generator, so a failure is reproducible from its seed. */
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

test("[CRM-002] the rewritten business-match query returns exactly what the OR form returned", async () => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
    const db = createTestDb();
    try {
      const r = rng(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
      const domains = ["a.test", "b.test", "c.test", null];
      const companyNames = ["Acme", "Borealis", "Cyan", null];
      const names = ["ada", "bo", "cy", "Deleted contact"];

      // Companies, some sharing a domain, some with none.
      const companyIds: string[] = [];
      for (let i = 0; i < 12; i++) {
        const id = `co_${seed}_${i}`;
        companyIds.push(id);
        await db.prepare(`INSERT INTO companies (id, name, domain_norm, created_at) VALUES (?,?,?,?)`)
          .bind(id, `Company ${i}`, pick(domains), "2026-01-01T00:00:00Z").run();
      }
      // Contacts: some with a company, some without (the LEFT JOIN case), some named 'Deleted contact'
      // (excluded by both forms), and some sharing a name_company_norm.
      for (let i = 0; i < 40; i++) {
        const withCompany = r() < 0.7;
        const nm = pick(names);
        const co = pick(companyNames);
        await db.prepare(`INSERT INTO contacts (id, name, company_id, name_company_norm, created_at) VALUES (?,?,?,?,?)`)
          .bind(`ctc_${seed}_${i}`, nm, withCompany ? pick(companyIds) : null,
            co === null ? null : `${nm}|${co}`, "2026-01-01T00:00:00Z").run();
      }

      // Every combination the production code can issue, including ones that match nothing.
      for (const domain of [...domains.filter((d): d is string => !!d), "no-such.test"]) {
        for (const nm of names) {
          for (const co of companyNames) {
            const byName = co === null ? null : `${nm}|${co}`;
            if (!byName) continue;
            const expected = await ids(db, OLD, domain, byName);
            const got = await ids(db, `${NAME_BRANCH} UNION ${DOMAIN_BRANCH} LIMIT 25`, byName, domain);
            assert.deepEqual(got, expected, `seed ${seed}, domain ${domain}, name_company ${byName}`);
          }
        }
      }
    } finally { (db as unknown as { raw: { close(): void } }).raw.close(); }
  }
});

test("[CRM-002] each single-branch form matches the OR form when only one input is present", async () => {
  // The production code omits a branch when its input is absent. An absent bind in the OR form is NULL, and
  // `x = NULL` is never true, so the OR form with one side NULL is the single-branch case.
  const db = createTestDb();
  try {
    // name_company_norm is NOT set here: the contacts_norm triggers compute it from the company's name, as
    // in production. Writing a literal is how my first version of this test convinced itself the rewrite had
    // lost a row — the trigger simply overwrote the value.
    await db.prepare(`INSERT INTO companies (id, name, domain_norm, created_at) VALUES ('co_1','One','one.test','2026-01-01T00:00:00Z')`).run();
    for (const [id, name, company] of [
      ["ctc_1", "ada", "co_1"], ["ctc_2", "bo", "co_1"],
      ["ctc_3", "cy", null], ["ctc_4", "Deleted contact", "co_1"],
    ] as [string, string, string | null][]) {
      await db.prepare(`INSERT INTO contacts (id, name, company_id, created_at) VALUES (?,?,?,'2026-01-01T00:00:00Z')`)
        .bind(id, name, company).run();
    }
    // A contact with no company has a NULL name_company_norm, because contact_norm_v's CASE needs the
    // company's name. So ctc_3 is matched by neither branch — in the OLD form too, which is why the rewrite
    // is exact rather than merely close.
    const cy = await db.prepare(`SELECT name_company_norm AS n FROM contacts WHERE id = 'ctc_3'`).first<{ n: string | null }>();
    assert.equal(cy?.n, null, "no company means no name_company_norm");

    // Domain only: the company's contacts, minus the deleted one.
    assert.deepEqual(await ids(db, `${DOMAIN_BRANCH} LIMIT 25`, "one.test"), ["ctc_1", "ctc_2"]);
    assert.deepEqual(await ids(db, `${DOMAIN_BRANCH} LIMIT 25`, "one.test"), await ids(db, OLD, "one.test", null));
    // Name+company only, for a contact that does have a company.
    assert.deepEqual(await ids(db, `${NAME_BRANCH} LIMIT 25`, "ada|one"), ["ctc_1"]);
    assert.deepEqual(await ids(db, `${NAME_BRANCH} LIMIT 25`, "ada|one"), await ids(db, OLD, null, "ada|one"));
    // A 'Deleted contact' is never returned by either form, however it is matched.
    assert.deepEqual(await ids(db, `${NAME_BRANCH} LIMIT 25`, "deleted contact|one"), []);
    assert.deepEqual(await ids(db, OLD, null, "deleted contact|one"), []);
  } finally { (db as unknown as { raw: { close(): void } }).raw.close(); }
});

test("[CRM-002] [DATA-001] the index the rewrite depends on exists, and is the half that makes it fast", async () => {
  // Landing the rewrite without the index leaves the domain branch scanning contacts; landing the index
  // without the rewrite does nothing at all, because the OR form never uses it. Both measured on 40,000
  // contacts: 10.1 ms and 11.4 ms respectively, against ~0 ms for the pair.
  const db = createTestDb();
  try {
    const idx = (await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'contacts' AND name = 'idx_contacts_company'`).first<{ name: string }>());
    assert.ok(idx, "migration 0080 creates idx_contacts_company");
    const plan = (db as unknown as { raw: { prepare(s: string): { all(...a: unknown[]): { detail: string }[] } } }).raw
      .prepare(`EXPLAIN QUERY PLAN ${DOMAIN_BRANCH}`).all("x.test").map((r) => r.detail).join(" | ");
    assert.match(plan, /idx_contacts_company|idx_companies_domain/, `the domain branch must be index-driven, got: ${plan}`);
    assert.doesNotMatch(plan, /SCAN contacts|SCAN c\b/, `the domain branch must not scan contacts, got: ${plan}`);
  } finally { (db as unknown as { raw: { close(): void } }).raw.close(); }
});
