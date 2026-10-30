// CRM identity privacy erasure (src/services/identity-erasure.ts, migration 0049) through all three entry points:
// the Owner's CRM erasure, receptionist caller erasure, and account deletion. All records are TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type SqliteDb } from "../dev/sqlite-d1.ts";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD } from "./support/app.ts";
import { intake, type IntakeOptions } from "../src/services/contact-identity.ts";
import { eraseIdentityData } from "../src/services/identity-erasure.ts";
import { eraseCallerData } from "../src/services/voice-ops.ts";
import { addDnc } from "../src/services/voice-outbound.ts";
import { reservePhone, enrollEmailCampaign } from "../src/services/outreach-ledger.ts";
import { runImport, IMPORT_API_VERSION } from "../src/services/crm-import.ts";
import { requestDeletion, processDeletion } from "../src/services/privacy.ts";
import { newId, nowIso } from "../src/lib/db.ts";

const n = async (db: SqliteDb, sql: string, ...b: unknown[]) => Number((await db.prepare(sql).bind(...b).first<{ n: number }>())!.n);
const research = (id: string): IntakeOptions => ({ channel: "research_agent", idempotencyKey: `research_agent:test:${id}`, sourceRef: id, lead: { source: "manual", interest: "other", message: "Research prospect" } });
const mentions = (db: SqliteDb, digits: string, email: string) => n(db, `SELECT
  (SELECT COUNT(*) FROM contacts WHERE replace(replace(replace(replace(COALESCE(phone,''),'-',''),' ',''),'(',''),')','') LIKE '%' || ? || '%' OR lower(COALESCE(email,'')) = ?) +
  (SELECT COUNT(*) FROM contact_identities WHERE value_norm LIKE '%' || ? || '%' OR value_norm = ?) +
  (SELECT COUNT(*) FROM contact_identity_links WHERE replace(replace(replace(replace(original_value,'-',''),' ',''),'(',''),')','') LIKE '%' || ? || '%' OR lower(original_value) = ?) +
  (SELECT COUNT(*) FROM crm_identity_reviews WHERE replace(replace(replace(replace(lower(COALESCE(candidate_json,'') || COALESCE(proposed_value,'') || COALESCE(current_value,'')),'-',''),' ',''),'(',''),')','') LIKE '%' || ? || '%'
     OR lower(COALESCE(candidate_json,'') || COALESCE(proposed_value,'') || COALESCE(current_value,'')) LIKE '%' || ? || '%') +
  (SELECT COUNT(*) FROM crm_field_changes WHERE replace(replace(replace(replace(lower(COALESCE(old_value,'') || COALESCE(new_value,'')),'-',''),' ',''),'(',''),')','') LIKE '%' || ? || '%'
     OR lower(COALESCE(old_value,'') || COALESCE(new_value,'')) LIKE '%' || ? || '%') AS n`, digits, email, digits, email, digits, email, digits, email, digits, email);

/** A person who exists only as research data: a prospect contact plus held research candidates (no contact id). */
async function seedPerson(db: SqliteDb) {
  const p = await intake(db, { contactName: "Pat Solo", businessName: "Solo Repairs", phones: [{ value: "313-555-0161" }], emails: [{ value: "Pat@Solo.example" }] }, research("p1"));
  // Same phone, different website → held as possible duplicate (candidate_json carries the phone).
  await intake(db, { contactName: "Pat Solo", businessName: "Solo Repairs", website: "https://solo-repair.example", phones: [{ value: "(313) 555-0161" }] }, research("p2"));
  return p;
}

test("[CRM-002] erasure of a contact linked to review items and field history removes every trace; the decision record keeps no raw value", async () => {
  const db = openDb();
  const p = await seedPerson(db);
  await intake(db, { contactName: "Pat Solo", businessName: "Solo Hardware & Repair", phones: [{ value: "313.555.0161" }] }, research("p3")); // held review attached to Pat's contact
  await db.prepare(`INSERT INTO crm_field_changes (id, contact_id, field, old_value, new_value, source, rule, created_at) VALUES (?,?,?,?,?,'research_agent','additional_identifier',?)`).bind(newId("fch"), p.contactId, "phone", null, "313.555.0161", nowIso()).run();
  assert.ok(await n(db, `SELECT COUNT(*) AS n FROM crm_identity_reviews WHERE contact_id = ?`, p.contactId) >= 1);
  assert.ok(await mentions(db, "3135550161", "pat@solo.example") > 0);
  const r = await eraseIdentityData(db, null, { contactIds: [p.contactId!], blockReimport: true });
  assert.equal(r.contacts, 1);
  assert.equal(await mentions(db, "3135550161", "pat@solo.example"), 0, "no contact, identity, link, review or history value left");
  assert.equal((await db.prepare(`SELECT name FROM contacts WHERE id = ?`).bind(p.contactId).first<{ name: string }>())!.name, "Deleted contact");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM leads WHERE contact_id = ? AND message <> 'Details erased at the person''s request'`, p.contactId), 0);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM crm_intake_decisions WHERE evidence_json LIKE '%0161%' OR evidence_json LIKE '%solo.example%' OR idempotency_key LIKE '%0161%'`), 0);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'crm.identity_erased' AND (details_json LIKE '%0161%' OR details_json LIKE '%solo%')`), 0, "audit holds counts only");
});

test("[CRM-002] an unlinked research candidate is found by normalized phone/email (any formatting or case) and deleted; several items for one identity all go; items on another business are scrubbed, not deleted", async () => {
  const db = openDb();
  const at = nowIso();
  const held = (id: string, phone: string, email: string) => db.prepare(`INSERT INTO crm_identity_reviews (id, kind, reason, candidate_json, dedupe_key, created_at) VALUES (?, 'customer_match', 'held', ?, ?, ?)`)
    .bind(id, JSON.stringify({ candidate: { contactName: "Held Person", businessName: "Held Co", phones: [{ value: phone }], emails: [{ value: email }] }, channel: "research_agent" }), `t:${id}`, at);
  await db.batch([held("rev_h1", "313-555-0162", "held@person.example"), held("rev_h2", "(313) 555 0162", "HELD@Person.example"), held("rev_h3", "+1.313.555.0162", "someone@else.example"),
    held("rev_other", "248-555-0100", "info@other.example")]);
  // A legitimate business record with a proposal that carries the person's email.
  const biz = await intake(db, { businessName: "Ridge Cafe", website: "https://ridge.example", phones: [{ value: "248-555-0111" }] }, research("biz"));
  await db.prepare(`INSERT INTO crm_identity_reviews (id, kind, contact_id, field, current_value, proposed_value, reason, dedupe_key, created_at) VALUES ('rev_biz','field_conflict',?, 'email', NULL, 'Held@Person.example', 'proposal', 't:biz', ?)`).bind(biz.contactId, at).run();
  const r = await eraseIdentityData(db, null, { phones: ["3135550162"], emails: [" HELD@person.EXAMPLE "], blockReimport: true });
  assert.equal(r.reviewsDeleted, 3, JSON.stringify(r));
  assert.equal(r.reviewsScrubbed, 1);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM crm_identity_reviews WHERE id IN ('rev_h1','rev_h2','rev_h3')`), 0);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM crm_identity_reviews WHERE id = 'rev_other'`), 1, "another person's held item stays");
  const scrubbed = (await db.prepare(`SELECT status, proposed_value, contact_id FROM crm_identity_reviews WHERE id = 'rev_biz'`).first<{ status: string; proposed_value: string; contact_id: string }>())!;
  assert.deepEqual({ ...scrubbed }, { status: "rejected", proposed_value: "[erased]", contact_id: biz.contactId });
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM contacts WHERE id = ? AND phone = '248-555-0111'`, biz.contactId), 1, "the business itself is untouched");
  assert.equal(await mentions(db, "3135550162", "held@person.example"), 0);
});

test("[CRM-002] shared phone numbers belonging to different businesses are never erased from those businesses", async () => {
  const db = openDb();
  await intake(db, { businessName: "Lakeside Dental", website: "https://lakeside-dental.example", phones: [{ value: "734-555-0101" }] }, research("s1"));
  await intake(db, { businessName: "Maple Orthodontics", website: "https://maple-ortho.example", phones: [{ value: "(734) 555-0101" }] }, research("s2"));
  const r = await eraseIdentityData(db, null, { phones: ["+17345550101"], blockReimport: true });
  assert.equal(r.contacts, 0);
  assert.equal(r.sharedKept, 1);
  assert.equal(r.tombstones, 0, "a shared line stays importable for the businesses that own it");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM contacts WHERE phone IS NOT NULL`), 2);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM contact_identity_links WHERE removed_at IS NULL`), 2);
  // A third business on the same line can still be researched.
  const again = await intake(db, { businessName: "Birch Pediatrics", website: "https://birch.example", phones: [{ value: "734-555-0101" }] }, research("s3"));
  assert.equal(again.outcome, "CREATED");
});

test("[VOICE-005] suppressed contacts after erasure: do-not-call and email suppressions are kept, re-import is refused, the ledger keeps the number for call limits", async () => {
  const db = openDb();
  const p = await seedPerson(db);
  await addDnc(db, "313-555-0161", "staff", "Asked not to be called");
  await db.prepare(`INSERT INTO email_suppressions (id, email, reason, created_at) VALUES ('sup_e','pat@solo.example','complaint',?)`).bind(nowIso()).run();
  await enrollEmailCampaign(db, { email: "other@solo2.example", campaignKey: "c1", source: "manual" });
  const lease = await reservePhone(db, "313-555-0199", { type: "voice_outbound_request", id: "vob_z" }, "callback", 60_000);
  assert.equal(lease.ok, true);
  await db.prepare(`INSERT INTO phone_outreach_ledger (phone_e164, attempts, created_at, updated_at) VALUES ('+13135550161', 2, ?, ?) ON CONFLICT DO NOTHING`).bind(nowIso(), nowIso()).run();
  await eraseIdentityData(db, null, { contactIds: [p.contactId!], blockReimport: false });
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM voice_dnc WHERE phone_e164 = '+13135550161'`), 1);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM email_suppressions WHERE email = 'pat@solo.example' AND removed_at IS NULL`), 1);
  assert.equal(await n(db, `SELECT attempts AS n FROM phone_outreach_ledger WHERE phone_e164 = '+13135550161'`), 2);
  // Even without a tombstone, the opt-outs alone keep research from re-adding the person.
  const re = await intake(db, { businessName: "Solo Repairs", phones: [{ value: "313-555-0161" }] }, research("sx"));
  assert.equal(re.outcome, "SUPPRESSED");
  const reE = await intake(db, { businessName: "Solo Repairs", emails: [{ value: "pat@solo.example" }] }, research("sy"));
  assert.equal(reE.outcome, "SUPPRESSED");
});

test("[CRM-002] repeated erasure requests are safe: the second run changes nothing and leaves one tombstone", async () => {
  const db = openDb();
  await seedPerson(db);
  const first = await eraseIdentityData(db, null, { phones: ["313-555-0161"], blockReimport: true });
  assert.ok(first.contacts >= 1);
  const snapshot = async () => JSON.stringify(await Promise.all(["contacts", "contact_identities", "contact_identity_links", "crm_identity_reviews", "crm_field_changes", "crm_erasure_tombstones", "leads"].map((t) => n(db, `SELECT COUNT(*) AS n FROM ${t}`))));
  const before = await snapshot();
  const second = await eraseIdentityData(db, null, { phones: ["(313) 555-0161"], blockReimport: true });
  assert.equal(second.contacts, 0);
  assert.equal(second.reviewsDeleted + second.reviewsScrubbed + second.fieldChangesScrubbed + second.identitiesDeleted, 0);
  assert.equal(await snapshot(), before);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM crm_erasure_tombstones`), 2, "phone and email, once each");
});

test("[CRM-002] concurrent imports during an erasure never leave the person's data behind", async () => {
  for (let round = 0; round < 3; round++) {
    const db = openDb();
    await seedPerson(db);
    const imports = [0, 1, 2, 3].map((i) => intake(db, { contactName: "Pat Solo", businessName: "Solo Repairs", phones: [{ value: i % 2 ? "313 555 0161" : "+13135550161" }], emails: [{ value: "pat@solo.example" }] }, research(`c${round}-${i}`)).catch((e) => e));
    const [erased] = await Promise.all([eraseIdentityData(db, null, { phones: ["313-555-0161"], emails: ["pat@solo.example"], blockReimport: true }), ...imports]);
    assert.ok(erased.tombstones >= 1);
    // Whatever interleaving happened, imports that committed before the erasure were erased with it, and imports
    // after it were refused by the tombstone.
    assert.equal(await mentions(db, "3135550161", "pat@solo.example"), 0, `round ${round}`);
    const late = await intake(db, { businessName: "Solo Repairs", phones: [{ value: "313-555-0161" }] }, research(`late-${round}`));
    assert.equal(late.outcome, "SUPPRESSED");
    assert.ok(late.reasons.includes("erased_at_request"));
  }
});

test("[CRM-007] research re-import after an authorized erasure is refused (batch API too); with re-import allowed it is created again; the person can still contact Crestmont", async () => {
  const db = openDb();
  await seedPerson(db);
  await eraseIdentityData(db, null, { phones: ["313-555-0161"], blockReimport: true });
  const res = await runImport(db, JSON.stringify({ apiVersion: IMPORT_API_VERSION, records: [{ externalId: "osm:node/1", business: { name: "Solo Repairs" }, phones: [{ value: "+1 313-555-0161" }] }, { externalId: "osm:node/2", business: { name: "Solo Repairs" }, emails: [{ value: "PAT@solo.example" }] }] }), { client: "research-agent", idempotencyKey: "after-erasure-01" });
  assert.deepEqual(res.results.map((r) => r.outcome), ["SUPPRESSED", "SUPPRESSED"]);
  assert.ok(res.results.every((r) => r.suppressed?.erased));
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM contacts WHERE name <> 'Deleted contact'`), 0);
  // The tombstone holds no raw identifier.
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM crm_erasure_tombstones WHERE key_hash LIKE '%0161%' OR key_hash LIKE '%solo%'`), 0);
  // The person writing in themselves is not blocked (they chose to contact us).
  const inbound = await intake(db, { contactName: "Pat Solo", emails: [{ value: "pat@solo.example" }] }, { channel: "web_form", lead: { source: "web_form", interest: "other", message: "Hi again, I'd like a quote." } });
  assert.equal(inbound.outcome, "CREATED");
  // Without a tombstone, a public listing may be imported again.
  const db2 = openDb();
  await seedPerson(db2);
  await eraseIdentityData(db2, null, { phones: ["313-555-0161"], blockReimport: false });
  assert.equal((await intake(db2, { businessName: "Solo Repairs", phones: [{ value: "313-555-0161" }] }, research("again"))).outcome, "CREATED");
});

test("[CRM-002] unrelated business, customer, payment and contract records are retained; a customer sharing the identifier is not erased", async () => {
  const db = openDb();
  await seedPerson(db);
  const cust = await createCustomer(db, "billing@acme.example", "Acme Plumbing");
  const at = nowIso();
  await db.batch([
    db.prepare(`INSERT INTO companies (id, name, organization_id, created_at) VALUES ('co_acme','Acme Plumbing',?,?)`).bind(cust.organizationId, at),
    // The customer's office uses the same email the person gives (an inbox they share).
    db.prepare(`INSERT INTO contacts (id, company_id, name, email, phone, user_id, created_at) VALUES ('ct_acme','co_acme','Acme Office','pat@solo.example','248-555-0177',?,?)`).bind(cust.id, at),
    db.prepare(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES ('ld_acme','ct_acme','checkout','converted',?,?)`).bind(at, at),
  ]);
  await intake(db, { businessName: "Unrelated Bakery", website: "https://bakery.example", phones: [{ value: "313-555-0190" }] }, research("u1"));
  const counts = async () => JSON.stringify(await Promise.all(["organizations", "memberships", "orders", "invoices", "payments", "quotes"].map((t) => n(db, `SELECT COUNT(*) AS n FROM ${t}`))));
  const before = await counts();
  const r = await eraseIdentityData(db, null, { phones: ["313-555-0161"], emails: ["pat@solo.example"], blockReimport: true });
  assert.equal(await counts(), before);
  assert.equal((await db.prepare(`SELECT email FROM contacts WHERE id = 'ct_acme'`).first<{ email: string }>())!.email, "pat@solo.example", "the customer's record is kept");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM contacts WHERE phone = '313-555-0190'`), 1, "unrelated business kept");
  assert.ok(r.sharedKept >= 1);
});

test("[CRM-002] entry points: caller erasure and account deletion both run CRM identity erasure", async () => {
  // Receptionist caller erasure now also covers research-created contacts and held candidates for the number.
  const db = openDb();
  const s = await createStaff(db, "owner");
  await seedPerson(db);
  await eraseCallerData(db, s.id, "+13135550161", "Caller asked on the phone to erase their data");
  assert.equal(await mentions(db, "3135550161", "pat@solo.example"), 0);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'voice.caller_crm_identity_erased'`), 1);
  // Account deletion erases the account email everywhere in the CRM, including a held research candidate.
  const db2 = openDb();
  const admin = await createStaff(db2, "administrator");
  const cust = await createCustomer(db2, "rhea@rhea-studio.example", "Rhea Studio");
  await intake(db2, { contactName: "Rhea", businessName: "Rhea Studio", emails: [{ value: "Rhea@Rhea-Studio.example" }] }, research("acct1"));
  // A held research candidate for the account email (customer_match, no CRM contact).
  const held = await intake(db2, { contactName: "R. Studio", businessName: "Rhea Design", emails: [{ value: "RHEA@rhea-studio.example" }], phones: [{ value: "313-555-0163" }] }, research("acct2"));
  assert.ok(held.reviewIds.length >= 1);
  const reqId = await requestDeletion(db2, cust.id, "Please delete my account");
  await processDeletion(db2, admin.id, reqId, "complete", "");
  assert.equal(await mentions(db2, "no-phone-xx", "rhea@rhea-studio.example"), 0);
  assert.equal(await n(db2, `SELECT COUNT(*) AS n FROM crm_erasure_tombstones WHERE kind = 'email'`), 1);
});

test("[AUTH-007] CRM identity erasure is Owner-only, audited, and validated", async () => {
  const t = await createTestApp();
  const db = t.db as SqliteDb;
  await seedPerson(db);
  const anon = await t.client().post("/staff/crm/identity-erasure", { emails: "pat@solo.example", note: "attempt" });
  assert.ok([302, 303, 401, 403].includes(anon.status) && anon.status !== 200);
  for (const role of ["administrator", "sales", "support"] as const) {
    const st = await createStaff(t.db, role, `${role}-er@crestmont.test`);
    const c = t.client(); await c.login(st.email, TEST_PASSWORD, st.secret);
    const res = await c.post("/staff/crm/identity-erasure", { emails: "pat@solo.example", note: "Not allowed to do this" });
    assert.equal(res.status, 403, role);
  }
  assert.ok(await mentions(db, "3135550161", "pat@solo.example") > 0, "nothing erased by refused attempts");
  const o = await createStaff(t.db, "owner");
  const oc = t.client(); await oc.login(o.email, TEST_PASSWORD, o.secret);
  const short = await oc.post("/staff/crm/identity-erasure", { emails: "pat@solo.example", note: "x" });
  assert.equal(short.status, 303);
  assert.ok(await mentions(db, "3135550161", "pat@solo.example") > 0, "a reason is required");
  const ok = await oc.post("/staff/crm/identity-erasure", { emails: "Pat@Solo.example", note: "Pat emailed asking to be removed" });
  assert.equal(ok.status, 303);
  assert.equal(await mentions(db, "3135550161", "pat@solo.example"), 0);
  const a = (await db.prepare(`SELECT actor_user_id, details_json FROM audit_logs WHERE action = 'crm.identity_erased'`).first<{ actor_user_id: string; details_json: string }>())!;
  assert.equal(a.actor_user_id, o.id);
  assert.doesNotMatch(a.details_json, /solo\.example|0161/);
  const page = await (await oc.get("/staff/crm/duplicates?view=review")).text();
  assert.match(page, /data-identity-erasure/);
  void newId;
});

test("[AUTH-007] assigned-only sales reps cannot read the duplicate review queue (names and proposed contact values of other leads)", async () => {
  const t = await createTestApp();
  await intake(t.db, { contactName: "Quinn Private", businessName: "Private Co", website: "https://private.example", phones: [{ value: "313-555-0171" }] }, research("rq1"));
  await intake(t.db, { contactName: "Quinn Private", businessName: "Private Co", website: "https://private-co.example", phones: [{ value: "313-555-0171" }] }, research("rq2"));
  assert.ok(await n(t.db as SqliteDb, `SELECT COUNT(*) AS n FROM crm_identity_reviews WHERE status = 'open'`) >= 1);
  const rep = await createStaff(t.db, "sales", "rep-rq@crestmont.test");
  const c = t.client(); await c.login(rep.email, TEST_PASSWORD, rep.secret);
  const h = await (await c.get("/staff/crm/duplicates?view=review")).text();
  assert.doesNotMatch(h, /Quinn Private|Private Co|555-0171/);
  assert.match(h, /Handled by the Owner/);
  const o = await createStaff(t.db, "owner");
  const oc = t.client(); await oc.login(o.email, TEST_PASSWORD, o.secret);
  assert.match(await (await oc.get("/staff/crm/duplicates?view=review")).text(), /Quinn Private/);
});

test("[CRM-002] migrations 0048 + 0049 on a representative pre-0048 database (duplicates, then unlinked research candidates); erasure; both rollbacks keep every original row and referential integrity", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { MIGRATIONS_DIR } = await import("../dev/sqlite-d1.ts");
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec(`CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL)`);
  const apply = (f: string) => { raw.exec("BEGIN"); raw.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8")); raw.prepare(`INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)`).run(f, nowIso()); raw.exec("COMMIT"); };
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && f < "0048").sort()) apply(f);
  const at = nowIso();
  raw.exec(`INSERT INTO companies (id, name, website, created_at) VALUES ('co1','Harbor Coffee','https://harbor.example','${at}'), ('co2','Harbor Coffee LLC','https://www.harbor.example','${at}'), ('co3','Lakeside Dental','https://lakeside.example','${at}');
    INSERT INTO contacts (id, company_id, name, email, phone, created_at) VALUES ('c1','co1','Morgan Reyes','morgan@harbor.example','(313) 555-0142','${at}'), ('c2','co2','Morgan Reyes','Morgan@Harbor.example','313-555-0142','${at}'), ('c3','co3','Front Desk',NULL,'+1 734 555 0101','${at}');
    INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES ('l1','c1','web_form','new','${at}','${at}'), ('l2','c2','manual','qualified','${at}','${at}'), ('l3','c3','web_form','new','${at}','${at}');`);
  const original = () => JSON.stringify([["companies", "name"], ["contacts", "name"], ["leads", "stage"]].map(([t, c]) => raw.prepare(`SELECT id, ${c} AS v FROM ${t} ORDER BY id`).all()));
  const before = original();
  apply("0048_contact_identity.sql");
  apply("0049_crm_identity_erasure.sql");
  assert.equal(original(), before);
  // Unlinked research candidates and an erasure, through the real services on this database.
  const db: SqliteDb = { raw, prepare: (sql) => { const st = raw.prepare(sql); let v: unknown[] = []; const o = { bind: (...x: unknown[]) => { v = x.map((y) => y === undefined ? null : y); return o; }, all: async () => ({ results: st.all(...(v as never[])) }), first: async () => (st.get(...(v as never[])) ?? null), run: async () => { const r = st.run(...(v as never[])); return { meta: { changes: Number(r.changes) } }; }, runSync: () => { const r = st.run(...(v as never[])); return { meta: { changes: Number(r.changes) } }; } }; return o as never; },
    batch: async (s) => { raw.exec("BEGIN"); try { const out = (s as unknown as { runSync: () => { meta: { changes: number } } }[]).map((x) => x.runSync()); raw.exec("COMMIT"); return out; } catch (e) { raw.exec("ROLLBACK"); throw e; } } } as SqliteDb;
  const held = await intake(db, { businessName: "Harbor Coffee", website: "https://harbor.example", emails: [{ value: "morgan@harbor.example" }] }, research("mig1"));
  assert.equal(held.outcome, "POSSIBLE_DUPLICATE_REVIEW", "historical duplicates → held, no third copy");
  await intake(db, { contactName: "Sam Lone", businessName: "Lone Co", phones: [{ value: "586-555-0181" }] }, research("mig2"));
  await eraseIdentityData(db, null, { phones: ["586-555-0181"], blockReimport: true });
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal((raw.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
  // Rollbacks in reverse order.
  raw.exec(readFileSync(join(import.meta.dirname, "../docs/crm-identity/rollback-0049.sql"), "utf8"));
  assert.equal(raw.prepare(`SELECT name FROM sqlite_master WHERE name = 'crm_erasure_tombstones'`).get(), undefined);
  raw.exec(readFileSync(join(import.meta.dirname, "../docs/crm-identity/rollback-0048.sql"), "utf8"));
  const after = JSON.parse(original()) as { id: string }[][];
  for (const [i, t] of (JSON.parse(before) as { id: string }[][]).entries()) for (const row of t) assert.ok(after[i].some((r) => r.id === row.id), `original row ${row.id} kept`);
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal((raw.prepare(`SELECT COUNT(*) n FROM d1_migrations WHERE name >= '0048'`).get() as { n: number }).n, 0);
  apply("0048_contact_identity.sql"); apply("0049_crm_identity_erasure.sql");
  assert.ok((raw.prepare(`SELECT COUNT(*) n FROM contact_identities`).get() as { n: number }).n >= 2, "both can be re-applied");
});
