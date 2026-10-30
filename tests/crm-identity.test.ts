// CRM duplicate protection and canonical contact identity (migrations/0047, src/services/contact-identity.ts,
// src/services/outreach-ledger.ts, src/services/crm-import.ts). Covers the 20 required scenarios plus the HTTP surfaces.
// All records are TEST DATA: names are invented, domains use .example, phone numbers use the 555-01xx fiction range.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, MIGRATIONS_DIR, type SqliteDb } from "../dev/sqlite-d1.ts";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD } from "./support/app.ts";
import { intake, previewMatches, phoneKey, emailKey, domainKey, companyKey, resolveReview, IntakeError, type Candidate, type IntakeOptions } from "../src/services/contact-identity.ts";
import { reservePhone, releasePhone, recoverExpiredLeases, enrollEmailCampaign, phoneLedgerStatus } from "../src/services/outreach-ledger.ts";
import { runImport, IMPORT_API_VERSION, MAX_RECORDS } from "../src/services/crm-import.ts";
import { requestOutbound, addDnc } from "../src/services/voice-outbound.ts";
import { createManualLead } from "../src/services/crm.ts";
import { auditDatabase } from "../scripts/crm-duplicate-audit.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import type { Actor } from "../src/domain/authz.ts";

const n = async (db: SqliteDb, sql: string, ...b: unknown[]) => Number((await db.prepare(sql).bind(...b).first<{ n: number }>())!.n);
const research = (externalId: string, extra: Partial<IntakeOptions> = {}): IntakeOptions => ({
  channel: "research_agent", idempotencyKey: `research_agent:test:${externalId}`, sourceRef: externalId, lead: { source: "manual", interest: "other", message: "Research prospect" }, ...extra,
});
const owner = async (db: SqliteDb): Promise<Actor> => { const s = await createStaff(db, "owner", `owner-${newId("x")}@crestmont.test`); return { kind: "user", userId: s.id, roles: [{ role: "owner", organizationId: s.organizationId }], mfaVerified: true }; };
const admin = async (db: SqliteDb): Promise<Actor> => { const s = await createStaff(db, "administrator", `admin-${newId("x")}@crestmont.test`); return { kind: "user", userId: s.id, roles: [{ role: "administrator", organizationId: s.organizationId }], mfaVerified: true }; };
const leadsFor = (db: SqliteDb, phone: string) => n(db, `SELECT COUNT(DISTINCT l.id) AS n FROM leads l JOIN contact_identity_links k ON k.contact_id = l.contact_id AND k.removed_at IS NULL JOIN contact_identities ci ON ci.id = k.identity_id WHERE ci.kind = 'phone' AND ci.value_norm = ?`, phone);
const harbor = (over: Partial<Candidate> = {}): Candidate => ({ contactName: "Morgan Reyes", businessName: "Harbor Coffee", website: "https://harbor.example", phones: [{ value: "(313) 555-0142" }], ...over });

test("[CRM-002] normalization: E.164 phones, conservative email (no Gmail dot / +tag rewriting), domains, company names; SQL and TypeScript agree", async () => {
  assert.equal(phoneKey("(313) 555-0142"), "+13135550142");
  assert.equal(phoneKey("313.555.0142"), "+13135550142");
  assert.equal(phoneKey("+1 313 555 0142"), "+13135550142");
  assert.equal(phoneKey("1-313-555-0142"), "+13135550142");
  assert.equal(phoneKey("+44 20 7946 0958"), "+442079460958");
  assert.equal(phoneKey("555-0142"), null, "7 digits has no area code");
  assert.equal(phoneKey("313-555-0142 ext 4"), null, "extensions are not silently dropped");
  assert.equal(emailKey("  Morgan.Reyes+Leads@Gmail.com "), "morgan.reyes+leads@gmail.com");
  assert.notEqual(emailKey("morgan.reyes@gmail.com"), emailKey("morganreyes@gmail.com"), "dots are kept");
  assert.equal(emailKey("not an email"), null);
  assert.equal(domainKey("https://www.Harbor.example/menu?x=1"), "harbor.example");
  assert.equal(companyKey("The Harbor Coffee Co., LLC"), "harbor coffee");
  // The SQL view used by the triggers produces the same keys as the TypeScript normalizers.
  const db = openDb();
  const samples = ["(313) 555-0142", "+1 313 555 0142", "313.555.0142", "+44 20 7946 0958", "555-0142", "+0 123 4567 8901", "1-313-555-0142", "12345"];
  for (const [i, p] of samples.entries()) db.raw.prepare(`INSERT INTO contacts (id, name, phone, email, created_at) VALUES (?,?,?,?,?)`).run(`c${i}`, "X", p, i === 0 ? " Mixed.Case@Example.COM " : null, nowIso());
  for (const [i, p] of samples.entries()) assert.equal((db.raw.prepare(`SELECT phone_key FROM contact_identity_norm_v WHERE id = ?`).get(`c${i}`) as { phone_key: string | null }).phone_key, phoneKey(p), p);
  assert.equal((db.raw.prepare(`SELECT email_key FROM contact_identity_norm_v WHERE id = 'c0'`).get() as { email_key: string }).email_key, emailKey(" Mixed.Case@Example.COM "));
});

test("[CRM-002] cases 1–3: same phone (identical and differently formatted) and same email in different capitalization resolve to one identity and one lead", async () => {
  const db = openDb();
  const a = await intake(db, harbor(), research("r1"));
  assert.equal(a.outcome, "CREATED");
  assert.equal(a.outreachEligible, false, "duplicate protection never grants calling permission");
  // 1. identical formatting
  const b = await intake(db, harbor(), research("r2"));
  assert.equal(b.outcome, "NO_CHANGE");
  assert.equal(b.leadId, a.leadId);
  // 2. different formatting
  const c = await intake(db, harbor({ phones: [{ value: "+1 313-555-0142" }] }), research("r3"));
  assert.equal(c.leadId, a.leadId);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM contact_identities WHERE kind = 'phone'`), 1);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM leads`), 1);
  // Original formatting is preserved for display.
  assert.equal((await db.prepare(`SELECT original_value FROM contact_identity_links WHERE contact_id = ?`).bind(a.contactId).first<{ original_value: string }>())!.original_value, "(313) 555-0142");
  // 3. email capitalization (inbound form, then a research record with different case)
  const d = await intake(db, { contactName: "Avery Stone", emails: [{ value: "Avery.Stone@Northwind.example" }] }, { channel: "web_form", lead: { source: "web_form", interest: "custom", message: "Hello there, need a site" } });
  const e = await intake(db, { contactName: "Avery Stone", businessName: "Northwind", emails: [{ value: "avery.stone@NORTHWIND.example" }] }, research("r4"));
  assert.equal(e.contactId, d.contactId);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM contact_identities WHERE kind = 'email'`), 1);
  assert.equal((await db.prepare(`SELECT original_value FROM contact_identity_links WHERE contact_id = ? AND identity_id IN (SELECT id FROM contact_identities WHERE kind = 'email')`).bind(d.contactId).first<{ original_value: string }>())!.original_value, "Avery.Stone@Northwind.example");
  // Every decision is recorded with its outcome and idempotency key.
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM crm_intake_decisions`), 5);
});

test("[CRM-002] case 4: a receptionist shared by two separate businesses never merges them; one canonical identity, flagged shared, one outbound ledger row", async () => {
  const db = openDb();
  const a = await intake(db, { businessName: "Lakeside Dental", website: "https://lakeside-dental.example", phones: [{ value: "(734) 555-0101", label: "shared_line" }] }, research("d1"));
  const b = await intake(db, { businessName: "Maple Orthodontics", website: "https://maple-ortho.example", phones: [{ value: "734-555-0101" }] }, research("d2"));
  assert.equal(a.outcome, "CREATED");
  assert.equal(b.outcome, "CREATED");
  assert.notEqual(a.contactId, b.contactId);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM companies`), 2);
  const ident = (await db.prepare(`SELECT id, shared FROM contact_identities WHERE kind = 'phone'`).all<{ id: string; shared: number }>()).results;
  assert.equal(ident.length, 1);
  assert.equal(ident[0].shared, 1);
  assert.ok(b.reviewIds.length >= 1, "a person confirms the businesses are different");
  // One number = one ledger row = one reservation at a time, no matter how many businesses share it.
  const r1 = await reservePhone(db, "+17345550101", { type: "voice_outbound_request", id: "vob_a" }, "callback", 60_000);
  const r2 = await reservePhone(db, "(734) 555-0101", { type: "voice_outbound_request", id: "vob_b" }, "callback", 60_000);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM phone_outreach_ledger`), 1);
  assert.equal(await leadsFor(db, "+17345550101"), 2, "the ledger knows both associated leads");
});

test("[CRM-002] cases 5–6: franchise locations sharing a corporate phone, and a multi-location business with distinct contacts, become separate location records", async () => {
  const db = openDb();
  // 5. Franchise: same domain and corporate phone, different locations.
  const hq = { businessName: "Brightside Fitness", website: "https://brightside.example", phones: [{ value: "800-555-0199", label: "main" as const }] };
  const f1 = await intake(db, { ...hq, location: { city: "Ann Arbor", region: "MI", postalCode: "48104" } }, research("f1"));
  const f2 = await intake(db, { ...hq, location: { city: "Ypsilanti", region: "MI", postalCode: "48197" } }, research("f2"));
  assert.equal(f1.outcome, "CREATED");
  assert.equal(f2.outcome, "CREATED");
  assert.notEqual(f1.contactId, f2.contactId);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM contact_identities WHERE kind = 'phone'`), 1);
  assert.equal(await n(db, `SELECT shared AS n FROM contact_identities WHERE kind = 'phone'`), 1);
  // Same franchise location again (same domain + location) is the same record.
  const again = await intake(db, { ...hq, location: { city: "Ann Arbor", region: "MI", postalCode: "48104" } }, research("f3"));
  assert.equal(again.contactId, f1.contactId);
  // 6. Multi-location business with distinct contacts per location.
  const m1 = await intake(db, { contactName: "Jordan Pike", businessName: "Riverbend Plumbing", website: "https://riverbend.example", location: { city: "Detroit", region: "MI" }, phones: [{ value: "313-555-0111" }], emails: [{ value: "detroit@riverbend.example" }] }, research("m1"));
  const m2 = await intake(db, { contactName: "Casey Lin", businessName: "Riverbend Plumbing", website: "https://riverbend.example", location: { city: "Toledo", region: "OH" }, phones: [{ value: "419-555-0122" }], emails: [{ value: "toledo@riverbend.example" }] }, research("m2"));
  assert.equal(m1.outcome, "CREATED");
  assert.equal(m2.outcome, "CREATED");
  assert.equal(m2.reviewIds.length, 0, "distinct contacts at a distinct location need no review");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM companies WHERE domain_norm = 'riverbend.example'`), 2);
});

test("[CRM-007] case 7: an existing paying customer found by research is never a competing prospect; customer data is not overwritten; changes go to the Owner", async () => {
  const db = openDb();
  const cust = await createCustomer(db, "pat@acme-plumbing.example", "Acme Plumbing");
  const at = nowIso();
  await db.batch([
    db.prepare(`INSERT INTO companies (id, name, website, organization_id, created_at) VALUES ('co_acme','Acme Plumbing','https://acme-plumbing.example',?,?)`).bind(cust.organizationId, at),
    db.prepare(`INSERT INTO contacts (id, company_id, name, email, phone, user_id, created_at) VALUES ('ct_acme','co_acme','Pat Customer','pat@acme-plumbing.example','(248) 555-0177',?,?)`).bind(cust.id, at),
    db.prepare(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES ('ld_acme','ct_acme','checkout','converted',?,?)`).bind(at, at),
  ]);
  const before = await db.prepare(`SELECT name, email, phone FROM contacts WHERE id = 'ct_acme'`).first();
  const r = await intake(db, { contactName: "P. Customer", businessName: "Acme Plumbing & Heating", website: "https://acme-plumbing.example", phones: [{ value: "248-555-0177" }, { value: "248-555-0178" }] }, research("c1"));
  assert.equal(r.outcome, "EXISTING_CONTACT_LINKED");
  assert.equal(r.leadId, "ld_acme");
  assert.equal(r.leadCreated, false);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM leads`), 1, "no competing prospect");
  assert.deepEqual(await db.prepare(`SELECT name, email, phone FROM contacts WHERE id = 'ct_acme'`).first(), before, "customer-supplied details unchanged");
  assert.ok(r.reviewIds.length >= 1);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM contact_identity_links WHERE contact_id = 'ct_acme' AND role = 'additional'`), 0, "even a new number is only proposed");
  // Only the Owner may apply a change to a customer's record; an administrator may only reject.
  const rev = (await db.prepare(`SELECT id FROM crm_identity_reviews WHERE contact_id = 'ct_acme' AND field = 'phone'`).first<{ id: string }>())!.id;
  // Administrators cannot resolve review items at all (only lead.write_all, i.e. the Owner, can).
  await assert.rejects(resolveReview(db, await admin(db), rev, "apply"), (e: unknown) => e instanceof IntakeError && e.status === 403);
  await resolveReview(db, await owner(db), rev, "apply");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM contact_identity_links WHERE contact_id = 'ct_acme' AND role = 'additional'`), 1);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM crm_field_changes WHERE contact_id = 'ct_acme' AND rule = 'review_applied'`), 1);
  // Another location of the customer (same domain, different city) is not imported as a cold prospect either.
  const loc = await intake(db, { businessName: "Acme Plumbing", website: "https://acme-plumbing.example", location: { city: "Flint", region: "MI" }, phones: [{ value: "810-555-0190" }] }, research("c2"));
  assert.equal(loc.outcome, "EXISTING_CONTACT_LINKED");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM leads`), 1);
});

test("[VOICE-005] case 8: a previously opted-out phone or suppressed email re-imported by research is SUPPRESSED; nothing is created or reactivated", async () => {
  const db = openDb();
  await addDnc(db, "(586) 555-0133", "staff", "Asked us never to call");
  await db.prepare(`INSERT INTO email_suppressions (id, email, reason, created_at) VALUES ('sup1','bounced@gone.example','hard_bounce',?)`).bind(nowIso()).run();
  const a = await intake(db, { businessName: "Quiet Co", phones: [{ value: "586-555-0133" }] }, research("s1"));
  const b = await intake(db, { businessName: "Gone Co", emails: [{ value: "Bounced@gone.example" }] }, research("s2"));
  assert.equal(a.outcome, "SUPPRESSED");
  assert.equal(b.outcome, "SUPPRESSED");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM leads`), 0);
  // Someone who opted out of calls can still write to us themselves (inbound), but the suppression is kept and shown.
  const inbound = await intake(db, { contactName: "Quinn Quiet", phones: [{ value: "586-555-0133" }], emails: [{ value: "quinn@quiet.example" }] }, { channel: "web_form", lead: { source: "web_form", interest: "other", message: "Please email me only." } });
  assert.equal(inbound.outcome, "CREATED");
  assert.equal(inbound.suppressed.phone, true);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM voice_dnc`), 1, "opt-out unchanged");
  const r = await reservePhone(db, "586-555-0133", { type: "voice_outbound_request", id: "vob_x" }, "callback", 60_000);
  assert.deepEqual([r.ok, !r.ok && r.reason], [false, "do_not_call"]);
});

test("[CRM-002] case 9 + 18: simultaneous imports of the same number (direct and through the import API) produce exactly one contact and lead", async () => {
  const db = openDb();
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => intake(db, harbor({ phones: [{ value: i % 2 ? "313 555 0142" : "+13135550142" }] }), research(`race${i}`))));
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM contacts`), 1);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM leads`), 1);
  assert.equal(results.filter((r) => r.outcome === "CREATED").length, 1);
  assert.equal(new Set(results.map((r) => r.leadId)).size, 1);
  // Two concurrent API batches with different keys carrying the same business.
  const db2 = openDb();
  const batch = (key: string, id: string) => runImport(db2, JSON.stringify({ apiVersion: IMPORT_API_VERSION, records: [{ externalId: id, business: { name: "Harbor Coffee", website: "https://harbor.example" }, phones: [{ value: "(313) 555-0142" }] }] }), { client: "research-agent", idempotencyKey: key });
  const [x, y] = await Promise.all([batch("batch-aaaa-0001", "ext-1"), batch("batch-bbbb-0002", "ext-2")]);
  assert.equal(await n(db2, `SELECT COUNT(*) AS n FROM leads`), 1);
  assert.deepEqual([x.results[0].outcome, y.results[0].outcome].sort(), ["CREATED", "NO_CHANGE"]);
});

test("[VOICE-005] case 10: simultaneous outbound reservations — exactly one worker gets the number; open requests are deduplicated", async () => {
  const db = openDb();
  const res = await Promise.all(Array.from({ length: 8 }, (_, i) => reservePhone(db, "(313) 555-0150", { type: "voice_outbound_request", id: `vob_${i}` }, "callback", 60_000)));
  assert.equal(res.filter((r) => r.ok).length, 1);
  assert.equal(res.filter((r) => !r.ok && r.reason === "reserved").length, 7);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM phone_outreach_events WHERE event = 'denied'`), 7);
  // The holder releases; a no-answer retry policy keeps everyone off the number until the retry time.
  const holder = res.findIndex((r) => r.ok);
  await releasePhone(db, "+13135550150", { type: "voice_outbound_request", id: `vob_${holder}` }, "no_answer", { retryAfter: new Date(Date.now() + 3_600_000).toISOString() });
  const blocked = await reservePhone(db, "+13135550150", { type: "voice_outbound_request", id: "vob_new" }, "callback", 60_000);
  assert.deepEqual([blocked.ok, !blocked.ok && blocked.reason], [false, "retry_after"]);
  // Two simultaneous requests for one number: one open request.
  const reqs = await Promise.all([1, 2, 3].map((i) => requestOutbound(db, { purpose: "callback", phone: "+13135550160", reason: `Callback ${i}`, requestedBy: null })));
  assert.equal(new Set(reqs.map((r) => r.id)).size, 1);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM voice_outbound_requests WHERE phone_e164 = '+13135550160'`), 1);
  const st = await phoneLedgerStatus(db, "313-555-0150");
  assert.equal(st!.callState, "idle");
  assert.ok(st!.history.length >= 9);
});

test("[CRM-007] case 11: a failed import retried with the same idempotency key replays; reusing a key for a different request is refused", async () => {
  const db = openDb();
  const first = await intake(db, harbor(), research("idem-1"));
  const replay = await intake(db, harbor(), research("idem-1"));
  assert.equal(replay.replayed, true);
  assert.equal(replay.decisionId, first.decisionId);
  assert.equal(replay.leadId, first.leadId);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM crm_intake_decisions`), 1);
  await assert.rejects(intake(db, harbor({ businessName: "Different" }), research("idem-1")), (e: unknown) => e instanceof IntakeError && e.status === 409);
  // Batch level: same key + same body replays, same key + different body is 409.
  const body = JSON.stringify({ apiVersion: IMPORT_API_VERSION, records: [{ externalId: "b-1", business: { name: "Elm Bakery" }, emails: [{ value: "hello@elm-bakery.example" }] }] });
  const b1 = await runImport(db, body, { client: "research-agent", idempotencyKey: "batch-key-0001" });
  const b2 = await runImport(db, body, { client: "research-agent", idempotencyKey: "batch-key-0001" });
  assert.equal(b2.replayed, true);
  assert.equal(b2.batchId, b1.batchId);
  assert.equal(b2.results[0].leadId, b1.results[0].leadId);
  assert.equal(b2.results[0].replayed, true);
  await assert.rejects(runImport(db, body.replace("Elm Bakery", "Oak Bakery"), { client: "research-agent", idempotencyKey: "batch-key-0001" }), /different request body/);
});

test("[CRM-007] case 12: partial batch failure — invalid and failing records are reported, the rest commit; retrying the batch completes only what failed", async () => {
  const db = openDb();
  // Make the first write for one record fail once (simulated D1 outage), then recover.
  let failOnce = true;
  const flaky: SqliteDb = { ...db, batch: async (stmts) => {
    if (failOnce && stmts.some((s) => JSON.stringify((s as unknown as { values: unknown[] }).values ?? []).includes("ext-flaky"))) { failOnce = false; throw new Error("D1_ERROR: simulated network failure"); }
    return db.batch(stmts);
  } };
  const records = [
    { externalId: "ext-ok-1", business: { name: "Cedar Salon", website: "https://cedar.example" }, phones: [{ value: "313-555-0171" }] },
    { externalId: "ext-bad", business: { name: "" }, phones: [{ value: "not a phone" }] },
    { externalId: "ext-flaky", business: { name: "Birch Tavern" }, phones: [{ value: "313-555-0172" }] },
    { externalId: "ext-ok-2", business: { name: "Pine Studio" }, emails: [{ value: "hi@pine.example" }], evidence: { sourceUrl: "https://pine.example/contact", observedAt: "2026-10-29" } },
  ];
  const body = JSON.stringify({ apiVersion: IMPORT_API_VERSION, records });
  const r1 = await runImport(flaky, body, { client: "research-agent", idempotencyKey: "partial-batch-01" });
  assert.deepEqual(r1.results.map((r) => r.outcome), ["CREATED", "REJECTED_INVALID", "ERROR", "CREATED"]);
  assert.equal(r1.results[2].retryable, true);
  assert.ok(!JSON.stringify(r1.results[1]).includes("not a phone"), "errors never echo submitted values");
  assert.equal((await db.prepare(`SELECT status FROM crm_import_batches WHERE id = ?`).bind(r1.batchId).first<{ status: string }>())!.status, "partial");
  const r2 = await runImport(flaky, body, { client: "research-agent", idempotencyKey: "partial-batch-01" });
  assert.deepEqual(r2.results.map((r) => r.outcome), ["CREATED", "REJECTED_INVALID", "CREATED", "CREATED"]);
  assert.deepEqual([r2.results[0].replayed, r2.results[2].replayed, r2.results[3].replayed], [true, false, true]);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM leads`), 3);
  assert.equal((await db.prepare(`SELECT status FROM crm_import_batches WHERE id = ?`).bind(r1.batchId).first<{ status: string }>())!.status, "completed");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM leads WHERE origin = 'research_agent'`), 3);
  // Batch-level validation.
  await assert.rejects(runImport(db, JSON.stringify({ apiVersion: "2020-01-01", records }), { client: "research-agent", idempotencyKey: "partial-batch-02" }), /apiVersion/);
  await assert.rejects(runImport(db, JSON.stringify({ apiVersion: IMPORT_API_VERSION, records: Array.from({ length: MAX_RECORDS + 1 }, (_, i) => ({ ...records[0], externalId: `x${i}` })) }), { client: "research-agent", idempotencyKey: "partial-batch-03" }), /At most/);
});

test("[CRM-002] case 13: identifiers that point at two different records are held for review; nothing is created or merged", async () => {
  const db = openDb();
  const a = await intake(db, { contactName: "Rae Fox", businessName: "Fox Legal", website: "https://foxlegal.example", emails: [{ value: "rae@foxlegal.example" }] }, research("x1"));
  const b = await intake(db, { contactName: "Sol Hart", businessName: "Hart Accounting", website: "https://hart.example", phones: [{ value: "313-555-0181" }] }, research("x2"));
  const c = await intake(db, { contactName: "Rae Fox", emails: [{ value: "rae@foxlegal.example" }], phones: [{ value: "313-555-0181" }] }, research("x3"));
  assert.equal(c.outcome, "POSSIBLE_DUPLICATE_REVIEW");
  assert.equal(c.leadId, null);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM leads`), 2);
  const rev = (await db.prepare(`SELECT id, candidate_json FROM crm_identity_reviews WHERE kind = 'possible_duplicate' AND decision_id = ?`).bind(c.decisionId).first<{ id: string; candidate_json: string }>())!;
  assert.ok(rev.candidate_json, "the held record can be created or linked later");
  assert.ok(a.leadId && b.leadId);
  // A person links it to Rae Fox's record: no new lead, the phone becomes an additional identifier there.
  await resolveReview(db, await owner(db), rev.id, "link");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM leads`), 2);
});

test("[CRM-002] case 14: an existing contact with a newly discovered website is updated (blank filled, audited); verified data replaces unverified research data; manual edits are protected", async () => {
  const db = openDb();
  const first = await intake(db, { contactName: "Lee Moss", businessName: "Moss Landscaping", phones: [{ value: "313-555-0191" }] }, research("w1"));
  const upd = await intake(db, { contactName: "Lee Moss", businessName: "Moss Landscaping", website: "https://moss-landscaping.example", phones: [{ value: "313-555-0191" }] }, research("w2"));
  assert.equal(upd.outcome, "EXISTING_BUSINESS_UPDATED");
  assert.equal(upd.leadId, first.leadId);
  assert.equal((await db.prepare(`SELECT website FROM companies`).first<{ website: string }>())!.website, "https://moss-landscaping.example");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM crm_field_changes WHERE field = 'website' AND rule = 'fill_blank'`), 1);
  // A verified business name corrects an unverified research value.
  const ver = await intake(db, { businessName: "Moss Landscaping & Design", website: "https://moss-landscaping.example", phones: [{ value: "313-555-0191" }], verifiedFields: ["business_name"] }, research("w3"));
  assert.equal(ver.outcome, "VERIFIED_DATA_MERGED");
  assert.equal((await db.prepare(`SELECT name FROM companies`).first<{ name: string }>())!.name, "Moss Landscaping & Design");
  // After a person edits the record, even verified research data only goes to review.
  await db.prepare(`INSERT INTO crm_field_changes (id, contact_id, field, old_value, new_value, source, rule, actor_user_id, created_at) VALUES (?,?,?,?,?,'contact_edit','manual_edit',?,?)`)
    .bind(newId("fch"), first.contactId, "company_name", "x", "y", (await owner(db)).userId, nowIso()).run();
  const prot = await intake(db, { businessName: "Moss Group", website: "https://moss-landscaping.example", phones: [{ value: "313-555-0191" }], verifiedFields: ["business_name"] }, research("w4"));
  assert.equal(prot.outcome, "EXISTING_CONTACT_LINKED");
  assert.equal((await db.prepare(`SELECT name FROM companies`).first<{ name: string }>())!.name, "Moss Landscaping & Design");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM crm_identity_reviews WHERE field = 'company_name' AND status = 'open'`), 1);
  // A second phone for the business becomes an additional identifier (multiple numbers per business), not a replacement.
  await intake(db, { businessName: "Moss Landscaping & Design", website: "https://moss-landscaping.example", phones: [{ value: "313-555-0191" }, { value: "313-555-0192", label: "mobile" }] }, research("w5"));
  assert.equal((await db.prepare(`SELECT phone FROM contacts`).first<{ phone: string }>())!.phone, "313-555-0191");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM contact_identity_links WHERE role = 'additional'`), 1);
});

test("[CRM-007] case 15: duplicate customer records (two customer organizations sharing an email, e.g. duplicated Stripe customers) are flagged for the Owner, never merged", async () => {
  const db = openDb();
  const c1 = await createCustomer(db, "billing@twinpeaks.example", "Twin Peaks Cafe");
  const org2 = newId("org");
  const at = nowIso();
  await db.batch([
    db.prepare(`UPDATE organizations SET stripe_customer_id = 'cus_TEST_A' WHERE id = ?`).bind(c1.organizationId),
    db.prepare(`INSERT INTO organizations (id, name, kind, stripe_customer_id, created_at) VALUES (?, 'Twin Peaks Cafe (duplicate)', 'customer', 'cus_TEST_B', ?)`).bind(org2, at),
    db.prepare(`INSERT INTO companies (id, name, organization_id, created_at) VALUES ('co_t1','Twin Peaks Cafe',?,?), ('co_t2','Twin Peaks Cafe',?,?)`).bind(c1.organizationId, at, org2, at),
    db.prepare(`INSERT INTO contacts (id, company_id, name, email, created_at) VALUES ('ct_t1','co_t1','Billing','billing@twinpeaks.example',?), ('ct_t2','co_t2','Billing','billing@twinpeaks.example',?)`).bind(at, at),
    db.prepare(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES ('ld_t1','ct_t1','checkout','converted',?,?), ('ld_t2','ct_t2','checkout','converted',?,?)`).bind(at, at, at, at),
  ]);
  const r = await intake(db, { businessName: "Twin Peaks Cafe", emails: [{ value: "billing@twinpeaks.example" }] }, research("t1"));
  assert.ok(["EXISTING_CONTACT_LINKED", "POSSIBLE_DUPLICATE_REVIEW"].includes(r.outcome));
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM leads`), 2, "no prospect created");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM organizations WHERE kind = 'customer'`), 2, "nothing merged");
  assert.ok(await n(db, `SELECT COUNT(*) AS n FROM crm_identity_reviews WHERE status = 'open'`) >= 1);
  // The historical audit classifies the pair as a customer conflict.
  const report = auditDatabase(db.raw);
  assert.ok(report.groupsDetail.some((g) => g.klass === "existing_customer_conflict" && g.contacts.includes("ct_t1") && g.contacts.includes("ct_t2")));
});

test("[EMAIL-003] case 16: duplicate email campaign enrollment — concurrent enrollments of one address (any capitalization) create one; suppressed addresses are refused", async () => {
  const db = openDb();
  const res = await Promise.all(["Sam@Elm.example", "sam@elm.example", "SAM@ELM.EXAMPLE", "sam@elm.example"].map((email) => enrollEmailCampaign(db, { email, campaignKey: "website-audit-2026", source: "research_agent" })));
  assert.equal(res.filter((r) => r.status === "enrolled").length, 1);
  assert.equal(res.filter((r) => r.status === "already_enrolled").length, 3);
  assert.equal((await enrollEmailCampaign(db, { email: "sam@elm.example", campaignKey: "another-campaign", source: "manual" })).status, "enrolled");
  assert.notEqual((await enrollEmailCampaign(db, { email: "s.a.m@elm.example", campaignKey: "website-audit-2026", source: "manual" })).status, "already_enrolled", "dots are a different mailbox");
  await db.prepare(`INSERT INTO email_suppressions (id, email, reason, created_at) VALUES ('sup2','complained@elm.example','complaint',?)`).bind(nowIso()).run();
  assert.equal((await enrollEmailCampaign(db, { email: "Complained@elm.example", campaignKey: "website-audit-2026", source: "manual" })).status, "suppressed");
});

test("[CRM-005] case 17: CRM manual creation race — two staff saving the same new lead at once produce one lead; the second sees the duplicate warning", async () => {
  const db = openDb();
  const actor = await owner(db);
  const input = { name: "Dana Wolfe", email: "dana@wolfe-design.example", phone: "313-555-0199", company: "Wolfe Design", website: "", interest: "custom", message: "", source: "manual" };
  const [a, b] = await Promise.all([createManualLead(db, actor, input), createManualLead(db, actor, input)]);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM leads`), 1);
  const oks = [a, b].filter((r) => r.ok), warned = [a, b].filter((r) => !r.ok && r.duplicates);
  assert.equal(oks.length, 1);
  assert.equal(warned.length, 1);
  // The person chooses: add to the existing contact (no new contact) or create separately (audited override).
  const contactId = (await db.prepare(`SELECT id FROM contacts`).first<{ id: string }>())!.id;
  const linked = await createManualLead(db, actor, { ...input, message: "Second project", resolution: `link:${contactId}` });
  assert.equal(linked.ok && linked.linked, true);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM contacts`), 1);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM leads`), 2);
  const sep = await createManualLead(db, actor, { ...input, name: "Dana Wolfe (agency)", resolution: "create_new" });
  assert.equal(sep.ok, true);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM contact_identities WHERE kind = 'email'`), 1, "still one canonical email identity");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM crm_intake_decisions WHERE evidence_json LIKE '%manual_create_despite_match%'`), 1);
});

test("[VOICE-005] case 19: an expired lease is recovered (crash recovery) and the history records it; only the lease holder can release", async () => {
  const db = openDb();
  const t0 = new Date("2026-11-02T15:00:00Z");
  const a = await reservePhone(db, "313-555-0155", { type: "voice_outbound_request", id: "vob_crashed" }, "callback", 10 * 60_000, t0);
  assert.equal(a.ok, true);
  // Another request cannot take it while the lease is live, nor release it.
  assert.equal((await reservePhone(db, "313-555-0155", { type: "voice_outbound_request", id: "vob_other" }, "callback", 60_000, new Date(t0.getTime() + 5 * 60_000))).ok, false);
  assert.equal(await releasePhone(db, "313-555-0155", { type: "voice_outbound_request", id: "vob_other" }, "completed"), false);
  // After expiry the scheduled recovery frees it…
  const rec = await recoverExpiredLeases(db, new Date(t0.getTime() + 11 * 60_000));
  assert.deepEqual(rec, [{ phone: "+13135550155", ref: "vob_crashed" }]);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM phone_outreach_events WHERE event = 'expired'`), 1);
  // …and a new reservation can also take over an expired lease directly.
  const b = await reservePhone(db, "313-555-0155", { type: "voice_outbound_request", id: "vob_next" }, "callback", 60_000, new Date(t0.getTime() + 12 * 60_000));
  assert.equal(b.ok, true);
  const c = await reservePhone(db, "313-555-0155", { type: "voice_outbound_request", id: "vob_later" }, "callback", 60_000, new Date(t0.getTime() + 20 * 60_000));
  assert.deepEqual([c.ok, c.ok && c.recoveredExpired], [true, true]);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM phone_outreach_events WHERE event = 'expired'`), 2);
});

test("[CRM-002] case 20: historical migration — 0047 backfills identities on existing data without deleting or merging anything; the audit is read-only; the rollback restores the prior schema with data intact", async () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec(`CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL)`);
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const apply = (f: string) => { raw.exec("BEGIN"); raw.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8")); raw.prepare(`INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)`).run(f, nowIso()); raw.exec("COMMIT"); };
  for (const f of files.filter((f) => f < "0047")) apply(f);
  // Pre-existing (historical) duplicates, written before identities existed.
  const at = nowIso();
  raw.exec(`INSERT INTO companies (id, name, website, created_at) VALUES ('co1','Harbor Coffee','https://harbor.example','${at}'), ('co2','Harbor Coffee LLC','https://www.harbor.example','${at}'), ('co3','Lakeside Dental','https://lakeside.example','${at}')`);
  raw.exec(`INSERT INTO contacts (id, company_id, name, email, phone, created_at) VALUES
    ('c1','co1','Morgan Reyes','morgan@harbor.example','(313) 555-0142','${at}'), ('c2','co2','Morgan Reyes','Morgan@Harbor.example','313-555-0142','${at}'),
    ('c3','co3','Front Desk',NULL,'+1 313 555 0142','${at}'), ('c4',NULL,'No Phone Person','solo@example.com','555-0100','${at}')`);
  raw.exec(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES ('l1','c1','web_form','new','${at}','${at}'), ('l2','c2','manual','qualified','${at}','${at}'), ('l3','c3','web_form','new','${at}','${at}'), ('l4','c4','web_form','new','${at}','${at}')`);
  const snapshot = () => JSON.stringify(["contacts", "companies", "leads"].map((t) => raw.prepare(`SELECT * FROM ${t} ORDER BY id`).all().map((r) => Object.fromEntries(Object.entries(r as object).filter(([k]) => !["email_norm", "phone_norm", "name_company_norm", "domain_norm", "location", "location_norm", "origin", "intake_decision_id"].includes(k))))));
  const before = snapshot();
  apply("0047_contact_identity.sql");
  assert.equal(snapshot(), before, "no existing row changed, deleted or merged");
  assert.equal((raw.prepare(`SELECT COUNT(*) n FROM contact_identities WHERE kind = 'phone'`).get() as { n: number }).n, 1);
  assert.equal((raw.prepare(`SELECT COUNT(*) n FROM contact_identities WHERE kind = 'email'`).get() as { n: number }).n, 2);
  assert.equal((raw.prepare(`SELECT shared n FROM contact_identities WHERE kind = 'phone'`).get() as { n: number }).n, 1, "three contacts at two businesses share the phone");
  assert.equal((raw.prepare(`SELECT COUNT(*) n FROM contact_identity_links WHERE source = 'backfill'`).get() as { n: number }).n, 6, "c1–c3 phone, c1/c2/c4 email");
  assert.equal((raw.prepare(`SELECT COUNT(*) n FROM contact_identity_links WHERE contact_id = 'c4'`).get() as { n: number }).n, 1, "c4's 7-digit phone is not an identity");
  assert.equal((raw.prepare(`SELECT domain_norm n FROM companies WHERE id = 'co2'`).get() as { n: string }).n, "harbor.example");
  // Read-only audit classifies the historical data.
  const report = auditDatabase(raw);
  assert.equal(report.byClass.safe_exact_duplicate, 1);
  assert.equal(report.byClass.shared_contact_identity, 1);
  assert.equal(report.invalidIdentifiers.phones, 1);
  assert.equal(snapshot(), before);
  // Rollback safeguard: the documented rollback restores the 0046 schema and leaves every original row intact.
  raw.exec(readFileSync(join(import.meta.dirname, "../docs/crm-identity/rollback-0047.sql"), "utf8"));
  assert.equal(raw.prepare(`SELECT name FROM sqlite_master WHERE name = 'contact_identities'`).get(), undefined);
  assert.equal(snapshot(), before);
  assert.equal((raw.prepare(`SELECT COUNT(*) n FROM d1_migrations WHERE name = '0047_contact_identity.sql'`).get() as { n: number }).n, 0);
  // And 0047 can be applied again after a rollback.
  apply("0047_contact_identity.sql");
  assert.equal((raw.prepare(`SELECT COUNT(*) n FROM contact_identities`).get() as { n: number }).n, 3);
});

test("[CRM-002] contact edits and privacy erasure keep identities accurate: edits close old links with history and flag collisions; erasure removes identifiers but keeps the opt-out", async () => {
  const t = await createTestApp();
  const s = await createStaff(t.db, "owner");
  const c = t.client(); await c.login(s.email, TEST_PASSWORD, s.secret);
  const a = await intake(t.db, { contactName: "Ivy Chen", businessName: "Ivy Florals", phones: [{ value: "313-555-0131" }] }, { channel: "web_form", lead: { source: "web_form", interest: "custom", message: "Need a shop site" } });
  const b = await intake(t.db, { contactName: "Oli Park", businessName: "Park Bikes", phones: [{ value: "313-555-0132" }] }, { channel: "web_form", lead: { source: "web_form", interest: "custom", message: "Need a site too" } });
  const res = await c.post(`/staff/crm/leads/${a.leadId}/contact`, { name: "Ivy Chen", email: "", phone: "313-555-0132", company: "Ivy Florals", website: "", qualification_notes: "" });
  assert.equal(res.status, 303);
  const links = (await t.db.prepare(`SELECT ci.value_norm, l.removed_at FROM contact_identity_links l JOIN contact_identities ci ON ci.id = l.identity_id WHERE l.contact_id = ?`).bind(a.contactId).all<{ value_norm: string; removed_at: string | null }>()).results;
  assert.ok(links.some((l) => l.value_norm === "+13135550131" && l.removed_at), "old number kept as history");
  assert.ok(links.some((l) => l.value_norm === "+13135550132" && !l.removed_at));
  assert.equal(await n(t.db as SqliteDb, `SELECT COUNT(*) AS n FROM crm_identity_reviews WHERE kind = 'possible_duplicate' AND contact_id = ?`, a.contactId), 1, "edit collision goes to review");
  assert.equal(await n(t.db as SqliteDb, `SELECT COUNT(*) AS n FROM crm_field_changes WHERE contact_id = ? AND rule = 'manual_edit' AND field = 'phone'`, a.contactId), 1);
  // Erasure (same statement the privacy and receptionist erasure paths use).
  await addDnc(t.db, "313-555-0132", "staff", "opted out");
  await t.db.prepare(`UPDATE contacts SET name = 'Deleted contact', email = NULL, phone = NULL WHERE id IN (?, ?)`).bind(a.contactId, b.contactId).run();
  assert.equal(await n(t.db as SqliteDb, `SELECT COUNT(*) AS n FROM contact_identity_links WHERE contact_id IN (?, ?)`, a.contactId, b.contactId), 0);
  assert.equal(await n(t.db as SqliteDb, `SELECT COUNT(*) AS n FROM contact_identities`), 0);
  assert.equal(await n(t.db as SqliteDb, `SELECT COUNT(*) AS n FROM voice_dnc`), 1, "the opt-out itself is remembered");
});

test("[CRM-005] staff UI: Add-lead shows matching records before saving, live hint endpoint, link choice; review queue resolves; identity panel and analytics render", async () => {
  const t = await createTestApp();
  const s = await createStaff(t.db, "owner");
  const c = t.client(); await c.login(s.email, TEST_PASSWORD, s.secret);
  const form = { name: "Noor Haddad", email: "noor@cedar-studio.example", phone: "(313) 555-0144", company: "Cedar Studio", website: "", interest: "custom", message: "", source: "manual" };
  assert.equal((await c.post("/staff/crm/new", form)).status, 303);
  const hint = await (await c.get("/staff/crm/new/matches?phone=313-555-0144")).text();
  assert.match(hint, /data-dup-hint/);
  assert.match(hint, /1 possible match/);
  const warn = await c.post("/staff/crm/new", { ...form, name: "N. Haddad", email: "NOOR@cedar-studio.example" });
  assert.equal(warn.status, 409);
  const h = await warn.text();
  assert.match(h, /data-duplicate-warning/);
  assert.match(h, /Nothing has been saved yet/);
  assert.equal(await n(t.db as SqliteDb, `SELECT COUNT(*) AS n FROM leads`), 1);
  const contactId = (await t.db.prepare(`SELECT id FROM contacts`).first<{ id: string }>())!.id;
  const linked = await c.post("/staff/crm/new", { ...form, resolution: `link:${contactId}` });
  assert.equal(linked.status, 303);
  assert.equal(await n(t.db as SqliteDb, `SELECT COUNT(*) AS n FROM contacts`), 1);
  const leadId = (await t.db.prepare(`SELECT id FROM leads ORDER BY created_at LIMIT 1`).first<{ id: string }>())!.id;
  const detail = await (await c.get(`/staff/crm/leads/${leadId}`)).text();
  assert.match(detail, /data-identity/);
  assert.match(detail, /\+13135550144/);
  assert.match(detail, /Duplicate protection never makes a number callable/);
  // Review queue: research conflict → resolve from the UI.
  await intake(t.db, { contactName: "Noor Haddad", businessName: "Cedar Studio Collective", phones: [{ value: "313-555-0144" }] }, research("ui-1"));
  const q = await (await c.get("/staff/crm/duplicates?view=review")).text();
  assert.match(q, /Duplicate review queue/);
  assert.match(q, /Possible duplicate/, "a different company name with the same phone is a possibly different business");
  const rev = (await t.db.prepare(`SELECT id FROM crm_identity_reviews WHERE status = 'open' LIMIT 1`).first<{ id: string }>())!.id;
  assert.equal((await c.post("/staff/crm/identity-reviews/resolve", { id: rev, decision: "reject", back: "/staff/crm/duplicates?view=review" })).status, 303);
  assert.equal((await t.db.prepare(`SELECT status FROM crm_identity_reviews WHERE id = ?`).bind(rev).first<{ status: string }>())!.status, "rejected");
  assert.equal(await n(t.db as SqliteDb, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'crm.identity_review_resolved'`), 1);
  const an = await (await c.get("/staff/crm/duplicates?view=analytics")).text();
  assert.match(an, /Duplicates prevented/);
  // A sales rep cannot resolve review items.
  const rep = await createStaff(t.db, "sales", "rep@crestmont.test");
  const rc = t.client(); await rc.login(rep.email, TEST_PASSWORD, rep.secret);
  assert.equal((await rc.post("/staff/crm/identity-reviews/resolve", { id: rev, decision: "reject" })).status, 403);
});

test("[CRM-007] import API over HTTP: 503 until configured, 401 without a valid signature, per-client rate limit, signed batch returns machine-readable outcomes", async () => {
  const off = await createTestApp();
  assert.equal((await off.client().request("POST", "/api/crm/v1/imports", { body: "{}", headers: { "content-type": "application/json" } })).status, 503);
  const secret = "crm-import-test-secret-not-real";
  const t = await createTestApp({ CRM_IMPORT_SECRET: secret });
  const c = t.client();
  const body = JSON.stringify({ apiVersion: IMPORT_API_VERSION, records: [{ externalId: "http-1", business: { name: "Willow Yoga", website: "https://willow.example" }, phones: [{ value: "313-555-0166" }], confidence: 55 }] });
  const sign = async (b: string) => { const ts = Math.floor(Date.now() / 1000); return `t=${ts},v1=${await hmacSha256Hex(secret, `${ts}.${b}`)}`; };
  assert.equal((await c.request("POST", "/api/crm/v1/imports", { body, headers: { "content-type": "application/json", "idempotency-key": "http-batch-0001" } })).status, 401);
  assert.equal((await c.request("POST", "/api/crm/v1/imports", { body, headers: { "content-type": "application/json", "idempotency-key": "http-batch-0001", "x-crestmont-signature": "t=1,v1=" + "0".repeat(64) } })).status, 401);
  const ok = await c.request("POST", "/api/crm/v1/imports", { body, headers: { "content-type": "application/json", "idempotency-key": "http-batch-0001", "x-crestmont-signature": await sign(body) } });
  assert.equal(ok.status, 200);
  const j = await ok.json() as { counts: Record<string, number>; results: { outcome: string; leadId: string }[]; apiVersion: string };
  assert.equal(j.apiVersion, IMPORT_API_VERSION);
  assert.equal(j.results[0].outcome, "CREATED");
  assert.deepEqual(j.counts, { CREATED: 1 });
  assert.equal((await t.db.prepare(`SELECT origin FROM leads WHERE id = ?`).bind(j.results[0].leadId).first<{ origin: string }>())!.origin, "research_agent");
  assert.equal(await n(t.db as SqliteDb, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'crm.import_batch'`), 1);
  const noKey = await c.request("POST", "/api/crm/v1/imports", { body, headers: { "content-type": "application/json", "x-crestmont-signature": await sign(body) } });
  assert.equal(noKey.status, 400);
  // Dry run predicts without writing.
  const dry = JSON.stringify({ apiVersion: IMPORT_API_VERSION, dryRun: true, records: [{ externalId: "http-2", business: { name: "Willow Yoga" }, phones: [{ value: "(313) 555-0166" }] }] });
  const d = await (await c.request("POST", "/api/crm/v1/imports", { body: dry, headers: { "content-type": "application/json", "idempotency-key": "http-batch-0002", "x-crestmont-signature": await sign(dry) } })).json() as { dryRun: boolean; results: { outcome: string }[] };
  assert.equal(d.dryRun, true);
  assert.equal(d.results[0].outcome, "POSSIBLE_DUPLICATE_REVIEW");
  assert.equal(await n(t.db as SqliteDb, `SELECT COUNT(*) AS n FROM crm_intake_decisions`), 1);
});

test("[CRM-001] inbound channels: a returning web visitor and a returning caller continue their open lead; research data never reaches the public site", async () => {
  const t = await createTestApp();
  const v = t.client();
  const post = (over: Record<string, string> = {}) => v.request("POST", "/api/leads", { body: JSON.stringify({ name: "Morgan Reyes", email: "morgan@harbor.example", company: "Harbor Coffee", interest: "custom", message: "We need online ordering and a loyalty portal.", source: "quote_form", ...over }), headers: { "content-type": "application/json" } });
  const a = await (await post()).json() as { leadId: string };
  const b = await (await post({ email: "MORGAN@harbor.example", message: "Following up on my request from last week." })).json() as { leadId: string };
  assert.equal(b.leadId, a.leadId);
  assert.equal(await n(t.db as SqliteDb, `SELECT COUNT(*) AS n FROM leads`), 1);
  assert.equal(await n(t.db as SqliteDb, `SELECT COUNT(*) AS n FROM crm_activities WHERE lead_id = ? AND kind = 'task'`, a.leadId), 1, "a reply task is due");
  // Lost lead + new inquiry → a new lead on the SAME contact.
  await t.db.prepare(`UPDATE leads SET stage = 'lost', lost_reason = 'budget' WHERE id = ?`).bind(a.leadId).run();
  const c = await (await post({ message: "Budget is approved now, can we restart?" })).json() as { leadId: string };
  assert.notEqual(c.leadId, a.leadId);
  assert.equal(await n(t.db as SqliteDb, `SELECT COUNT(DISTINCT contact_id) AS n FROM leads`), 1);
  const pv = await previewMatches(t.db, { emails: [{ value: "morgan@harbor.example" }] });
  assert.equal(pv.matches.length, 1);
});

test("[CRM-002] historical duplicates already in the CRM (same email on two company rows) never lead to a third copy: new data for that business is held for review", async () => {
  const db = openDb();
  const at = nowIso();
  await db.batch([
    db.prepare(`INSERT INTO companies (id, name, website, created_at) VALUES ('co_h1','Harbor Coffee','https://harbor.example',?), ('co_h2','Harbor Coffee LLC','https://www.harbor.example',?)`).bind(at, at),
    db.prepare(`INSERT INTO contacts (id, company_id, name, email, created_at) VALUES ('ct_h1','co_h1','Morgan Reyes','morgan@harbor.example',?), ('ct_h2','co_h2','Morgan Reyes','Morgan@Harbor.example',?)`).bind(at, at),
    db.prepare(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES ('ld_h1','ct_h1','web_form','new',?,?), ('ld_h2','ct_h2','manual','new',?,?)`).bind(at, at, at, at),
  ]);
  assert.equal(await n(db, `SELECT shared AS n FROM contact_identities WHERE kind = 'email'`), 1, "two company rows use the address");
  const r = await intake(db, { businessName: "Harbor Coffee", website: "https://harbor.example", emails: [{ value: "morgan@harbor.example" }] }, research("h1"));
  assert.equal(r.outcome, "POSSIBLE_DUPLICATE_REVIEW");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM leads`), 2);
});

test("[CRM-002] backups: a D1-style export with identity data restores through the restore drill with identical row counts (triggers replay after the data)", async () => {
  const { sanitizeExport, splitStatements } = await import("../scripts/restore-drill.ts");
  const db = openDb();
  await intake(db, harbor(), research("bk1"));
  await intake(db, { businessName: "Lakeside Dental", website: "https://lakeside.example", phones: [{ value: "313-555-0142" }], emails: [{ value: "Front.Desk@Lakeside.example" }] }, research("bk2"));
  await reservePhone(db, "313-555-0142", { type: "voice_outbound_request", id: "vob_bk" }, "callback", 60_000);
  const master = db.raw.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { type: string; name: string; sql: string }[];
  const lit = (v: unknown) => v === null ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  const out = ["PRAGMA defer_foreign_keys=TRUE;"];
  for (const m of master.filter((m) => m.type === "table")) { out.push(`${m.sql};`); for (const row of db.raw.prepare(`SELECT * FROM "${m.name}"`).all()) out.push(`INSERT INTO "${m.name}" VALUES(${Object.values(row as object).map(lit).join(",")});`); }
  for (const m of master.filter((m) => m.type !== "table")) out.push(`${m.sql};`);
  const restored = new DatabaseSync(":memory:");
  restored.exec("PRAGMA foreign_keys=ON");
  for (const s of splitStatements(sanitizeExport(out.join("\n")).sql)) restored.exec(s);
  for (const t of ["contacts", "contact_identities", "contact_identity_links", "phone_outreach_ledger", "crm_intake_decisions", "leads"]) {
    assert.equal((restored.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n, await n(db, `SELECT COUNT(*) AS n FROM ${t}`), t);
  }
  assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal((restored.prepare("SELECT original_value FROM contact_identity_links WHERE original_value LIKE 'Front%'").get() as { original_value: string }).original_value, "Front.Desk@Lakeside.example");
});

test("[CRM-002] review regressions: inbound never duplicates or fails on near-matches; ambiguous automated data is held; >100 shared links stay within D1 limits; paid customers without an org are protected", async () => {
  const db = openDb();
  const web = (name: string, email: string, company: string, phone?: string) => intake(db, { contactName: name, businessName: company, emails: [{ value: email }], phones: phone ? [{ value: phone }] : [] }, { channel: "web_form", lead: { source: "web_form", interest: "custom", message: "Hello, we need a website" } });
  // 1. Same email, slightly different company name: same lead, review item, no second lead.
  const a = await web("Lee Park", "lee@harbor.example", "Harbor Coffee");
  const b = await web("Lee Park", "lee@harbor.example", "Harbor Coffee Roasters");
  assert.equal(b.leadId, a.leadId);
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM leads`), 1);
  // Automated: same unshared phone, different website → held, not created.
  await intake(db, { businessName: "Pine Studio", website: "https://pine.example", phones: [{ value: "313-555-0121" }] }, research("rg1"));
  const amb = await intake(db, { businessName: "Pine Studio", website: "https://pinestudio.example", phones: [{ value: "313-555-0121" }] }, research("rg2"));
  assert.equal(amb.outcome, "POSSIBLE_DUPLICATE_REVIEW");
  // 2. Historical duplicates (two company-less contacts with one email): inbound continues one of them.
  const at = nowIso();
  await db.batch([
    db.prepare(`INSERT INTO contacts (id, name, email, created_at) VALUES ('ct_s1','Sam Y','sam@y.example',?), ('ct_s2','Sam Y','sam@y.example',?)`).bind(at, at),
    db.prepare(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES ('ld_s1','ct_s1','web_form','new',?,?), ('ld_s2','ct_s2','web_form','lost',?,?)`).bind(at, at, at, at),
  ]);
  const s = await intake(db, { contactName: "Sam Y", emails: [{ value: "sam@y.example" }] }, { channel: "web_form", lead: { source: "web_form", interest: "other", message: "Me again, any update?" } });
  assert.equal(s.leadId, "ld_s1", "the record with the open lead");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM contacts WHERE email = 'sam@y.example'`), 2);
  // 3. Email on one record, phone on another, through the public lead path: saved (no 422), linked, reviewed.
  const { captureLead } = await import("../src/services/leads.ts");
  await web("Ana Ruiz", "ana@ruiz.example", "Ruiz Law");
  await web("Ben Ode", "ben@ode.example", "Ode Tax", "313-555-0124");
  const cap = await captureLead(db, { name: "Ana Ruiz", email: "ana@ruiz.example", phone: "313-555-0124", interest: "other", message: "Following up on my consultation.", source: "web_form" });
  assert.ok(cap.leadId);
  assert.equal(cap.created, false);
  // 4. More than 100 contacts on one shared number (franchise/receptionist): no D1 parameter-limit failure.
  const stmts = [];
  for (let i = 0; i < 110; i++) stmts.push(db.prepare(`INSERT INTO contacts (id, name, phone, created_at) VALUES (?,?,?,?)`).bind(`ct_f${i}`, `Location ${i}`, "800-555-0177", at));
  await db.batch(stmts);
  const big = await intake(db, { businessName: "Some Franchisee", website: "https://franchisee.example", phones: [{ value: "800-555-0177" }] }, research("rg4"));
  assert.ok(big.decisionId);
  // 5. A paying customer with no organization (converted lead) sharing a phone: no prospect created.
  await db.batch([
    db.prepare(`INSERT INTO companies (id, name, created_at) VALUES ('co_j','Joes Plumbing',?)`).bind(at),
    db.prepare(`INSERT INTO contacts (id, company_id, name, phone, created_at) VALUES ('ct_j','co_j','Joe','313-555-0125',?)`).bind(at),
    db.prepare(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES ('ld_j','ct_j','manual','converted',?,?)`).bind(at, at),
  ]);
  const before = await n(db, `SELECT COUNT(*) AS n FROM leads`);
  const j = await intake(db, { businessName: "Joe's Plumbing & Heating Services", website: "https://joesplumbing.example", phones: [{ value: "313-555-0125" }] }, research("rg5"));
  assert.notEqual(j.outcome, "CREATED");
  assert.equal(await n(db, `SELECT COUNT(*) AS n FROM leads`), before);
  // 10. Corrected data under the same externalId is a new decision against the existing record, not a 409.
  const body = (website?: string) => JSON.stringify({ apiVersion: IMPORT_API_VERSION, records: [{ externalId: "osm:node/9", business: { name: "Elm Bakery", ...(website ? { website } : {}) }, phones: [{ value: "313-555-0126" }] }] });
  await runImport(db, body(), { client: "research-agent", idempotencyKey: "corr-batch-0001" });
  const corr = await runImport(db, body("https://elm-bakery.example"), { client: "research-agent", idempotencyKey: "corr-batch-0002" });
  assert.equal(corr.results[0].outcome, "EXISTING_BUSINESS_UPDATED");
});

test("[CRM-005] assigned-only reps see matching records they cannot open only as 'owned by someone else'", async () => {
  const t = await createTestApp();
  const o = await createStaff(t.db, "owner");
  const oc = t.client(); await oc.login(o.email, TEST_PASSWORD, o.secret);
  await oc.post("/staff/crm/new", { name: "Hidden Person", email: "hidden@secret.example", phone: "", company: "Secret Co", website: "", interest: "custom", message: "", source: "manual" });
  const rep = await createStaff(t.db, "sales", "rep2@crestmont.test");
  const rc = t.client(); await rc.login(rep.email, TEST_PASSWORD, rep.secret);
  const hint = await (await rc.get("/staff/crm/new/matches?email=hidden@secret.example")).text();
  assert.doesNotMatch(hint, /Hidden Person|Secret Co/);
  assert.match(hint, /owned by someone else/);
  const warn = await rc.post("/staff/crm/new", { name: "Xavier Doe", email: "hidden@secret.example", phone: "", company: "", website: "", interest: "custom", message: "", source: "manual" });
  const h = await warn.text();
  assert.equal(warn.status, 409);
  assert.doesNotMatch(h, /Hidden Person|Secret Co/);
  assert.doesNotMatch(h, /value="link:/, "cannot link to a record they cannot see");
});
