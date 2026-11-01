// Lead research (proposed RESEARCH-001..006; tagged with existing inventory ids until the Founder extends the inventory).
// Drives the real pipeline: signed worker API → validation → CRM / do-not-call / cross-prospect duplicate checks →
// audited promotion into the CRM. Every record created here is TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, type TestClient } from "./support/app.ts";
import { signEvidence } from "../src/readiness/ingest.ts";
import { randomToken } from "../src/lib/auth-crypto.ts";
import {
  phoneE164, normEmail, normDomain, normName, validateProspect, qualify, recommendPackage, modelTextProblems, outboundEligibility,
  timeZoneForState, isCandidateOfficialDomain, type ProspectInput,
} from "../src/domain/research.ts";
import * as R from "../src/services/research.ts";
import { addDnc } from "../src/services/voice-outbound.ts";
import type { SqliteDb } from "../dev/sqlite-d1.ts";

const SECRET = "test-research-secret";
const NOW = new Date().toISOString();

function prospect(over: Partial<ProspectInput> & { businessKey: string }): ProspectInput {
  return {
    name: "Riverside Plumbing (TEST DATA)", category: "plumber", address: { line: "120 Main St", city: "Lansing", state: "MI", zip: "48933" },
    phones: ["(517) 555-2142"], emails: [], domains: ["riverside-plumbing.example"],
    sources: [{ source: "overture", sourceId: over.businessKey.split(":")[1], license: "CDLA-Permissive-2.0", release: "2026-10-21.0", retrievedAt: NOW }],
    website: { classification: "VERIFIED_WEBSITE_BROKEN", url: "https://riverside-plumbing.example/", confidence: 0.9, checkedAt: NOW, identitySignals: ["phone on page matches", "city matches"],
      checks: [{ stage: "C", method: "HTTP GET", result: "503 on 3 attempts over 2 days", at: NOW }] },
    findings: [{ code: "http_5xx", title: "Home page returns HTTP 503", severity: "critical", confidence: 0.95, url: "https://riverside-plumbing.example/", method: "HTTP GET (no JS), 3 attempts", observedAt: NOW, evidence: "Status 503 Service Unavailable on 3 of 3 attempts" }],
    identityConfidence: 0.9, lastVerifiedAt: NOW,
    ...over,
  } as ProspectInput;
}

async function setup() {
  const app = await createTestApp({ RESEARCH_RUNNER_SECRET: SECRET });
  // Research ships paused; tests resume it the way the Owner does (settings row).
  await app.db.prepare(`UPDATE research_settings SET paused = 0, pause_reason = NULL WHERE id = 1`).run();
  return app;
}

async function send(c: TestClient, path: "heartbeat" | "batch", body: Record<string, unknown>, opts: { secret?: string; nonce?: string | null } = {}) {
  const payload = JSON.stringify({ ...body, ...(opts.nonce === null ? {} : { _nonce: opts.nonce ?? randomToken(16) }) });
  return c.request("POST", `/api/research/runner/${path}`, { body: payload, headers: { "content-type": "application/json", "x-crestmont-research-signature": await signEvidence(opts.secret ?? SECRET, payload) } });
}
const batch = (prospects: unknown[], batchId = `b_${randomToken(8)}`) => ({ batchId, runnerId: "ws-5090", prospects });
const raw = (db: unknown) => (db as SqliteDb).raw;

// ───────────── Pure rules ─────────────

test("[SEC-001] research normalization: phone numbers to E.164, emails, domains and names; untrusted values become null, never guessed", () => {
  for (const p of ["(517) 555-2142", "517.555.2142", "+1 517 555 2142", "1-517-555-2142", "517-555-2142 ext. 12"]) assert.equal(phoneE164(p), "+15175552142", p);
  for (const p of ["555-2142", "+44 20 7946 0958", "(017) 555-2142", "517-155-2142", "212-555-0123", "call us", ""]) assert.equal(phoneE164(p), null, p);
  assert.equal(normEmail(" Info@Riverside.Example "), "info@riverside.example");
  assert.equal(normEmail("not-an-email"), null);
  assert.equal(normDomain("HTTPS://WWW.Riverside-Plumbing.example/contact?x=1"), "riverside-plumbing.example");
  assert.equal(normDomain("http://192.168.1.4/"), null);
  assert.equal(isCandidateOfficialDomain("facebook.com"), false);
  assert.equal(isCandidateOfficialDomain("m.facebook.com"), false);
  assert.equal(isCandidateOfficialDomain("riverside.example"), true);
  assert.equal(normName("The Riverside Plumbing Co., LLC"), "riverside plumbing");
  assert.equal(timeZoneForState("MI"), null, "Michigan spans two zones: never guessed");
  assert.equal(timeZoneForState("OH"), "America/New_York");
});

test("[SEC-001] research validation: findings need evidence, URL, method and timestamp; 'no website found' needs its documented checks", () => {
  const ok = validateProspect(prospect({ businessKey: "overture:a1" }));
  assert.ok(ok.ok);
  const noEvidence = prospect({ businessKey: "overture:a2" });
  (noEvidence.findings![0] as { evidence?: string }).evidence = "";
  const r1 = validateProspect(noEvidence);
  assert.ok(!r1.ok && r1.issues.some((i) => i.includes("missing evidence")));
  const r2 = validateProspect(prospect({ businessKey: "overture:a3", website: { classification: "NO_OFFICIAL_WEBSITE_FOUND", confidence: 0.8, checkedAt: NOW, checks: [] }, findings: [] }));
  assert.ok(!r2.ok && r2.issues.some((i) => i.includes("documented checks")));
  const r3 = validateProspect(prospect({ businessKey: "overture:a4", website: { classification: "VERIFIED_WEBSITE_ISSUES", confidence: 0.8, checkedAt: NOW, checks: [] } }));
  assert.ok(!r3.ok && r3.issues.some((i) => i.includes("verified url")));
  const r4 = validateProspect({ ...prospect({ businessKey: "bad key" }), sources: [] });
  assert.ok(!r4.ok && r4.issues.length >= 2);
});

test("[CRM-005] research qualification is deterministic and evidence-only: uncertain identity, unverified sites, verified-good sites and stale evidence never qualify", () => {
  const base = validateProspect(prospect({ businessKey: "overture:q1" }));
  assert.ok(base.ok);
  const q = qualify(base.value);
  assert.ok(q.qualified && q.score >= 60, JSON.stringify(q));
  assert.equal(q.recommendedPackage, "business");
  assert.deepEqual(qualify(base.value), q, "same evidence, same result");
  for (const cls of ["VERIFIED_OFFICIAL_WEBSITE", "WEBSITE_UNVERIFIED", "BUSINESS_IDENTITY_UNCERTAIN"] as const) {
    assert.equal(qualify({ ...base.value, website: { ...base.value.website, classification: cls } }).qualified, false, cls);
  }
  assert.equal(qualify({ ...base.value, identityConfidence: 0.5 }).qualified, false, "low identity confidence");
  assert.equal(qualify({ ...base.value, phones: [] }).qualified, false, "no phone");
  assert.equal(qualify({ ...base.value, lastVerifiedAt: new Date(Date.now() - 90 * 86400e3).toISOString() }).qualified, false, "stale evidence");
  const lowConf = { ...base.value, website: { ...base.value.website, classification: "VERIFIED_WEBSITE_ISSUES" as const }, findings: base.value.findings.map((f) => ({ ...f, severity: "medium" as const, confidence: 0.4 })) };
  assert.equal(qualify(lowConf).qualified, false, "low-confidence findings do not count");
  assert.equal(recommendPackage("NO_OFFICIAL_WEBSITE_FOUND", []), "starter");
  assert.equal(recommendPackage("VERIFIED_OFFICIAL_WEBSITE", []), null);
});

test("[AIOPS-002] local-model drafts are accepted only when they add no facts (no prices, percentages, guarantees, insults or unseen domains)", () => {
  const allowed = ["riverside-plumbing.example"];
  assert.deepEqual(modelTextProblems("The home page at riverside-plumbing.example returned an error during three checks.", allowed), []);
  assert.ok(modelTextProblems("A new site for $999 would fix it.", allowed).length);
  assert.ok(modelTextProblems("This will increase your sales by 40%.", allowed).length);
  assert.ok(modelTextProblems("We guarantee more calls.", allowed).length);
  assert.ok(modelTextProblems("Their website is terrible.", allowed).length);
  assert.ok(modelTextProblems("Their real site is riversideplumbingmi.com.", allowed).length);
});

test("[CRM-007] outbound eligibility gate is fail-closed: open-dataset numbers are never released for automated AI-voice dialing without approval, consent and known time zone", () => {
  const facts = { phoneE164: "+15175552142", timeZone: "America/New_York", onDnc: false, existingCrmRecord: false, sharedPhoneConflict: false, complianceApproval: null, marketingConsentEvidence: null, lineType: "unknown" as const };
  const g = outboundEligibility(facts);
  assert.equal(g.eligible, false);
  assert.ok(g.reasons.some((r) => r.includes("D-14")));
  const approved = { ...facts, complianceApproval: { approvedBy: "u", approvedAt: NOW, reference: "counsel memo" }, marketingConsentEvidence: "signed form", lineType: "landline" as const };
  assert.equal(outboundEligibility(approved).eligible, true, "only every condition together releases a number");
  for (const blocker of [{ onDnc: true }, { timeZone: null }, { sharedPhoneConflict: true }, { existingCrmRecord: true }, { marketingConsentEvidence: null }, { lineType: "unknown" as const }]) {
    assert.equal(outboundEligibility({ ...approved, ...blocker }).eligible, false, JSON.stringify(blocker));
  }
});

// ───────────── Signed worker API ─────────────

test("[SEC-002] research worker API: unsigned, wrongly signed, replayed and nonce-less requests are refused; without a secret no worker can connect", async () => {
  const { client, env } = await setup();
  const c = client();
  assert.equal((await c.request("POST", "/api/research/runner/heartbeat", { body: "{}", headers: { "content-type": "application/json" } })).status, 401);
  assert.equal((await send(c, "heartbeat", { runnerId: "ws" }, { secret: "wrong" })).status, 401);
  assert.equal((await send(c, "heartbeat", { runnerId: "ws" }, { nonce: null })).status, 400);
  const nonce = randomToken(16);
  assert.equal((await send(c, "heartbeat", { runnerId: "ws" }, { nonce })).status, 200);
  assert.equal((await send(c, "heartbeat", { runnerId: "ws" }, { nonce })).status, 409, "replayed nonce");
  delete (env as { RESEARCH_RUNNER_SECRET?: string }).RESEARCH_RUNNER_SECRET;
  assert.equal((await send(c, "heartbeat", { runnerId: "ws" })).status, 401);
});

test("[SEC-002] research worker API: the deploy-derived E2E key is accepted on staging only, alongside the Founder's worker key", async () => {
  const E2E = "deploy-derived-e2e-research-key";
  for (const environment of ["staging", "production", "development"] as const) {
    const { client } = await createTestApp({ RESEARCH_RUNNER_SECRET: SECRET, RESEARCH_E2E_RUNNER_SECRET: E2E, ENVIRONMENT: environment });
    const c = client();
    assert.equal((await send(c, "heartbeat", { runnerId: "ws" })).status, 200, `${environment}: Founder key always works`);
    assert.equal((await send(c, "heartbeat", { runnerId: "e2e" }, { secret: E2E })).status, environment === "staging" ? 200 : 401, `${environment}: E2E key`);
    assert.equal((await send(c, "heartbeat", { runnerId: "x" }, { secret: "wrong" })).status, 401, `${environment}: wrong key`);
  }
  // Staging with only the E2E key: the E2E authenticates; nothing else does.
  const { client } = await createTestApp({ RESEARCH_E2E_RUNNER_SECRET: E2E, ENVIRONMENT: "staging" });
  assert.equal((await send(client(), "heartbeat", { runnerId: "e2e" }, { secret: E2E })).status, 200);
  assert.equal((await send(client(), "heartbeat", { runnerId: "x" })).status, 401);
});

test("[OWN-003] research ships paused; the worker is told to hold, batches are refused with 409 until the Owner resumes", async () => {
  const { client, db } = await createTestApp({ RESEARCH_RUNNER_SECRET: SECRET });
  const c = client();
  const hb = await (await send(c, "heartbeat", { runnerId: "ws-5090", version: "0.1.0", status: { evaluated: 10 } })).json() as { paused: boolean; enabledSources: string[] };
  assert.equal(hb.paused, true);
  assert.deepEqual(hb.enabledSources.sort(), ["common_crawl", "overture"]);
  assert.equal((await send(c, "batch", batch([prospect({ businessKey: "overture:p1" })]))).status, 409);
  assert.equal((raw(db).prepare(`SELECT COUNT(*) AS n FROM research_prospects`).get() as { n: number }).n, 0);
});

test("[CRM-002] [DATA-001] batch ingest: valid records stored with provenance, a corrupt record is rejected alone, disabled sources are refused, retries are idempotent", async () => {
  const { client, db } = await setup();
  const c = client();
  const bad = { ...prospect({ businessKey: "overture:x2" }), website: { classification: "MADE_UP" } };
  const osm = prospect({ businessKey: "osm_geofabrik:n123", sources: [{ source: "osm_geofabrik", sourceId: "n123", license: "ODbL-1.0", retrievedAt: NOW }] });
  const b = batch([prospect({ businessKey: "overture:x1" }), bad, osm, "not an object"]);
  const r1 = await (await send(c, "batch", b)).json() as R.BatchResult;
  assert.equal(r1.created, 1);
  assert.equal(r1.rejected.length, 3);
  assert.ok(r1.rejected.some((x) => x.issues.some((i) => i.includes("osm_geofabrik"))), "disabled source refused");
  const r2 = await (await send(c, "batch", b)).json() as R.BatchResult;
  assert.equal(r2.replay, true, "same batchId answers with the stored result");
  assert.equal(r2.created, 1);
  const r3 = await (await send(c, "batch", batch([prospect({ businessKey: "overture:x1" })]))).json() as R.BatchResult;
  assert.equal(r3.unchanged, 1, "same evidence in a new batch changes nothing");
  const row = raw(db).prepare(`SELECT phone_e164, status, sources_json, qualified, eligibility, eligibility_json FROM research_prospects WHERE business_key = 'overture:x1'`).get() as Record<string, string | number>;
  assert.equal(row.phone_e164, "+15175552142");
  assert.equal(row.status, "qualified");
  assert.equal(row.eligibility, "blocked");
  assert.match(String(row.sources_json), /CDLA-Permissive-2.0/);
  assert.equal((raw(db).prepare(`SELECT COUNT(*) AS n FROM research_prospects`).get() as { n: number }).n, 1);
});

test("[CRM-002] concurrent retries of the same batch store it once", async () => {
  const { client, db } = await setup();
  const b = batch([prospect({ businessKey: "overture:c1" }), prospect({ businessKey: "overture:c2", phones: ["517-555-2143"] })]);
  const results = await Promise.all([send(client(), "batch", b), send(client(), "batch", b), send(client(), "batch", b)]);
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
  assert.equal((raw(db).prepare(`SELECT COUNT(*) AS n FROM research_batches`).get() as { n: number }).n, 1);
  assert.equal((raw(db).prepare(`SELECT COUNT(*) AS n FROM research_prospects`).get() as { n: number }).n, 2);
});

test("[CRM-005] duplicates: a number already on a CRM contact (any formatting) or email match never creates a second calling opportunity; DNC numbers are suppressed", async () => {
  const { client, db } = await setup();
  const owner = await createStaff(db, "owner");
  const o = await client().login(owner.email, undefined, owner.secret);
  assert.equal((await o.post("/staff/crm/new", { name: "Existing Customer", email: "owner@existing.example", phone: "517 555 2150", company: "Existing Co", website: "", interest: "business", message: "x", source: "referral" })).status, 303);
  await addDnc(db, "(517) 555-2151", "staff", "asked not to be called (TEST DATA)");
  const r = await (await send(client(), "batch", batch([
    prospect({ businessKey: "overture:d1", phones: ["+1 (517) 555-2150"] }),
    prospect({ businessKey: "overture:d2", phones: ["5175552199"], emails: ["OWNER@existing.example"] }),
    prospect({ businessKey: "fsq_like:d3".replace("fsq_like", "overture"), phones: ["517.555.2151"] }),
  ]))).json() as R.BatchResult;
  assert.equal(r.crmMatches, 2);
  assert.equal(r.duplicatesPrevented, 2);
  const st = (k: string) => (raw(db).prepare(`SELECT status, crm_lead_id, crm_contact_id FROM research_prospects WHERE business_key = ?`).get(k) as { status: string; crm_lead_id: string | null; crm_contact_id: string | null });
  assert.equal(st("overture:d1").status, "existing_crm");
  assert.ok(st("overture:d1").crm_lead_id, "linked to the existing CRM lead");
  assert.equal(st("overture:d2").status, "existing_crm", "email match");
  assert.equal(st("overture:d3").status, "suppressed");
  assert.equal((raw(db).prepare(`SELECT COUNT(*) AS n FROM leads`).get() as { n: number }).n, 1, "no lead was created by ingest");
});

test("[CRM-005] shared contact details: two distinct businesses with one phone number are both kept (never merged) and held for a person", async () => {
  const { client, db } = await setup();
  await send(client(), "batch", batch([prospect({ businessKey: "overture:s1", name: "Lansing Dental Suite A", phones: ["517-555-2160"] })]));
  await send(client(), "batch", batch([prospect({ businessKey: "overture:s2", name: "Lansing Ortho Suite B", phones: ["(517) 555-2160"] })]));
  const rows = raw(db).prepare(`SELECT business_key, name, status, shared_phone FROM research_prospects ORDER BY business_key`).all() as { business_key: string; status: string; shared_phone: number }[];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.business_key, r.status, r.shared_phone]), [["overture:s1", "review", 1], ["overture:s2", "review", 1]]);
});

test("[CRM-005] one business seen as several dataset records (same website, or same name and street, different numbers) never becomes two leads: the later record is held for a person", async () => {
  const { client, db } = await setup();
  await send(client(), "batch", batch([prospect({ businessKey: "overture:w1", name: "Lakeside Bakery", phones: ["517-555-2171"] })]));
  await send(client(), "batch", batch([
    prospect({ businessKey: "overture:w2", name: "Lakeside Bakery & Cafe", phones: ["517-555-2172"], address: { line: "9 Elm St", city: "Lansing", state: "MI", zip: "48933" } }), // same (dead) website
    prospect({ businessKey: "overture:w3", name: "Lakeside Bakery", phones: ["517-555-2173"], website: { ...prospect({ businessKey: "x:x" }).website, url: "https://other-bakery.example/" }, domains: ["other-bakery.example"] }), // same name and street
    prospect({ businessKey: "overture:w4", name: "Hillside Florist", phones: ["517-555-2174"], address: { line: "40 Oak Ave", city: "Lansing", state: "MI", zip: "48933" }, website: { ...prospect({ businessKey: "x:x" }).website, url: "https://hillside-florist.example/" }, domains: ["hillside-florist.example"] }),
  ]));
  const rows = raw(db).prepare(`SELECT business_key, status, status_detail FROM research_prospects ORDER BY business_key`).all() as { business_key: string; status: string; status_detail: string | null }[];
  assert.deepEqual(rows.map((r) => [r.business_key, r.status]), [["overture:w1", "qualified"], ["overture:w2", "review"], ["overture:w3", "review"], ["overture:w4", "qualified"]]);
  assert.match(rows[1].status_detail!, /Same website as another business record/);
  assert.match(rows[2].status_detail!, /Same name and street as another business record/);
});

test("[CRM-001] [CRM-002] promotion creates one CRM company, contact and lead with research attribution and evidence; never twice, and not after an opt-out", async () => {
  const { client, db } = await setup();
  const owner = await createStaff(db, "owner");
  const o = await client().login(owner.email, undefined, owner.secret);
  await send(client(), "batch", batch([prospect({ businessKey: "overture:m1" }), prospect({ businessKey: "overture:m2", phones: ["517-555-2170"] })]));
  const id = (k: string) => (raw(db).prepare(`SELECT id FROM research_prospects WHERE business_key = ?`).get(k) as { id: string }).id;
  const res = await o.post("/staff/research/promote", { prospect_id: id("overture:m1") });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location") ?? "", /^\/staff\/crm\/leads\/ld_/);
  const lead = raw(db).prepare(`SELECT l.source, l.stage, l.interest, l.utm_source, l.utm_medium, l.message, c.phone, c.phone_norm, co.name AS company FROM leads l JOIN contacts c ON c.id = l.contact_id JOIN companies co ON co.id = c.company_id`).get() as Record<string, string>;
  assert.deepEqual([lead.source, lead.stage, lead.interest, lead.utm_source, lead.utm_medium, lead.phone_norm], ["manual", "new", "business", "crestmont-research", "research-agent", "5175552142"]);
  assert.match(lead.message, /Home page returns HTTP 503/);
  assert.match(lead.message, /not released for automated calling/i);
  assert.ok(raw(db).prepare(`SELECT 1 FROM audit_logs WHERE action = 'research.prospect_promoted'`).get());
  // A second promotion of the same prospect is refused; no second lead.
  const again = await o.post("/staff/research/promote", { prospect_id: id("overture:m1") });
  assert.equal(again.status, 303);
  assert.equal((raw(db).prepare(`SELECT COUNT(*) AS n FROM leads`).get() as { n: number }).n, 1);
  // Opt-out recorded after ingest blocks promotion (suppression propagation).
  await addDnc(db, "517-555-2170", "caller_request", "TEST DATA");
  await o.post("/staff/research/promote", { prospect_id: id("overture:m2") });
  assert.equal((raw(db).prepare(`SELECT status FROM research_prospects WHERE id = ?`).get(id("overture:m2")) as { status: string }).status, "suppressed");
  assert.equal((raw(db).prepare(`SELECT COUNT(*) AS n FROM leads`).get() as { n: number }).n, 1);
  // Re-ingesting evidence for the promoted business keeps the decision and makes no new opportunity.
  await send(client(), "batch", batch([prospect({ businessKey: "overture:m1", findings: [] , website: { classification: "VERIFIED_WEBSITE_BROKEN", url: "https://riverside-plumbing.example/", confidence: 0.9, checkedAt: NOW, checks: [] } })]));
  assert.equal((raw(db).prepare(`SELECT status FROM research_prospects WHERE id = ?`).get(id("overture:m1")) as { status: string }).status, "promoted");
});

test("[CRM-002] concurrent promotions of one prospect create exactly one lead", async () => {
  const { client, db } = await setup();
  await send(client(), "batch", batch([prospect({ businessKey: "overture:k1" })]));
  const pid = (raw(db).prepare(`SELECT id FROM research_prospects`).get() as { id: string }).id;
  const owner = await createStaff(db, "owner");
  const actor = { kind: "user" as const, userId: owner.id, roles: [{ role: "owner" as const, organizationId: "org_crestmont" }], mfaVerified: true };
  const settled = await Promise.allSettled([R.promote(db, actor, pid), R.promote(db, actor, pid), R.promote(db, actor, pid)]);
  assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
  assert.equal((raw(db).prepare(`SELECT COUNT(*) AS n FROM leads`).get() as { n: number }).n, 1);
  assert.equal((raw(db).prepare(`SELECT COUNT(*) AS n FROM contacts`).get() as { n: number }).n, 1);
});

test("[OWN-002] research dashboard shows real counts (evaluated vs qualified vs callable kept separate), Owner controls, and is denied to sales", async () => {
  const { client, db } = await setup();
  const owner = await createStaff(db, "owner"), admin = await createStaff(db, "administrator"), sales = await createStaff(db, "sales");
  await send(client(), "heartbeat", { runnerId: "ws-5090", version: "0.1.0", status: { evaluated: 1234, websitesChecked: 400, failedJobs: 3, queueDepth: 77, recordsPerHour: 900, sources: { overture: { lastRefreshAt: NOW, release: "2026-10-21.0" } } } });
  await send(client(), "heartbeat", { runnerId: "ws-5090", status: { evaluated: 10 } });
  await send(client(), "batch", batch([prospect({ businessKey: "overture:v1" }), prospect({ businessKey: "overture:v2", phones: ["517-555-2181"], website: { classification: "BUSINESS_IDENTITY_UNCERTAIN", confidence: 0.3, checkedAt: NOW, checks: [] }, findings: [] })]));
  const o = await client().login(owner.email, undefined, owner.secret);
  const page = await (await o.get("/staff/research")).text();
  assert.match(page, /Candidates evaluated today<\/div><div class="kpi__value">1234/, "restart cannot lower the day's counter");
  assert.match(page, /Qualified today<\/div><div class="kpi__value">1</);
  assert.match(page, /Verified callable today<\/div><div class="kpi__value">0</);
  assert.match(page, /Riverside Plumbing/);
  assert.match(page, /Controls \(Owner\)/);
  assert.match(page, /2026-10-21.0/);
  const a = await client().login(admin.email, undefined, admin.secret);
  const adminPage = await (await a.get("/staff/research")).text();
  assert.doesNotMatch(adminPage, /Controls \(Owner\)/);
  assert.doesNotMatch(adminPage, /Create CRM lead/, "administrators cannot write all leads");
  assert.equal((await a.post("/staff/research/settings", { threshold: "10", max_batch: "100" })).status, 403);
  const s = await client().login(sales.email, undefined, sales.secret);
  assert.equal((await s.get("/staff/research")).status, 403);
  // Owner pauses; the worker is told on its next check-in.
  assert.equal((await o.post("/staff/research/settings", { paused: "1", reason: "Licence review", threshold: "70", max_batch: "150" })).status, 303);
  const hb = await (await send(client(), "heartbeat", { runnerId: "ws-5090" })).json() as { paused: boolean; qualifyThreshold: number; maxBatch: number };
  assert.deepEqual([hb.paused, hb.qualifyThreshold, hb.maxBatch], [true, 70, 150]);
});

test("[TEST-001] platform-side ingest benchmark: 10,000 prospects through the signed API in batches of 200 (in-memory SQLite; not a D1 or end-to-end figure)", async () => {
  const { client, db } = await setup();
  await db.prepare(`UPDATE research_settings SET max_batch = 200 WHERE id = 1`).run();
  const started = Date.now();
  let created = 0;
  for (let b = 0; b < 50; b++) {
    const items = Array.from({ length: 200 }, (_, i) => {
      const n = b * 200 + i;
      const line = String(1000 + (n % 9000)).padStart(4, "0");
      const area = ["517", "616", "313", "248", "734"][Math.floor(n / 9000) % 5];
      return prospect({ businessKey: `overture:bench${n}`, name: `Bench Business ${n} (TEST DATA)`, phones: [`${area}-${200 + (Math.floor(n / 9000) % 700)}-${line}`] });
    });
    const r = await (await send(client(), "batch", batch(items))).json() as R.BatchResult;
    created += r.created;
  }
  const ms = Date.now() - started;
  assert.equal(created, 10_000);
  console.log(`[benchmark] platform ingest: 10,000 prospects in ${ms} ms (${Math.round(10_000 / (ms / 3600e3))}/hour) on in-memory SQLite`);
  assert.equal((raw(db).prepare(`SELECT COUNT(*) AS n FROM research_prospects`).get() as { n: number }).n, 10_000);
});

test("[CRM-005] decisions made while a worker batch is in flight are never overwritten: dismissed stays dismissed, promoted keeps its CRM link", async () => {
  const { client, db } = await setup();
  await send(client(), "batch", batch([prospect({ businessKey: "overture:r1" }), prospect({ businessKey: "overture:r2", phones: ["517-555-2190"] })]));
  const pid = (k: string) => (raw(db).prepare(`SELECT id FROM research_prospects WHERE business_key = ?`).get(k) as { id: string }).id;
  const owner = await createStaff(db, "owner");
  const actor = { kind: "user" as const, userId: owner.id, roles: [{ role: "owner" as const, organizationId: "org_crestmont" }], mfaVerified: true };
  // Simulate the race: the batch read the prospects before these decisions, and writes after them.
  const realBatch = db.batch.bind(db);
  (db as { batch: typeof db.batch }).batch = async (stmts) => {
    (db as { batch: typeof db.batch }).batch = realBatch;
    await R.dismiss(db, actor, pid("overture:r1"), "Not a fit (TEST DATA)");
    await R.promote(db, actor, pid("overture:r2"));
    return realBatch(stmts);
  };
  const changed = (p: ProspectInput) => ({ ...p, findings: [{ ...p.findings![0], evidence: "Status 503 on 4 of 4 attempts" }] });
  await send(client(), "batch", batch([changed(prospect({ businessKey: "overture:r1" })), changed(prospect({ businessKey: "overture:r2", phones: ["517-555-2190"] }))]));
  const row = (k: string) => raw(db).prepare(`SELECT status, crm_lead_id FROM research_prospects WHERE business_key = ?`).get(k) as { status: string; crm_lead_id: string | null };
  assert.equal(row("overture:r1").status, "dismissed");
  assert.equal(row("overture:r2").status, "promoted");
  assert.ok(row("overture:r2").crm_lead_id, "CRM link kept");
  await assert.rejects(R.dismiss(db, actor, pid("overture:r2"), "too late"), /CRM lead/);
});

test("[SEC-001] an unparsable website URL rejects only its own record; opt-outs on a secondary number suppress the prospect", async () => {
  const { client, db } = await setup();
  const bad = prospect({ businessKey: "overture:u1" });
  bad.website = { ...bad.website, url: "http://%%%" };
  const r = await (await send(client(), "batch", batch([bad, prospect({ businessKey: "overture:u2", phones: ["517-555-2191", "517-555-2192"] })]))).json() as R.BatchResult;
  assert.equal(r.created, 1);
  assert.equal(r.rejected.length, 1);
  await addDnc(db, "517-555-2192", "staff", "TEST DATA");
  await R.applySuppressions(db);
  assert.equal((raw(db).prepare(`SELECT status FROM research_prospects WHERE business_key = 'overture:u2'`).get() as { status: string }).status, "suppressed");
});

test("[CRM-002] [CRM-005] promotion is an authoritative CRM intake decision (channel research_agent): origin and decision recorded; an existing CRM business is linked, never duplicated", async () => {
  const { client, db } = await setup();
  await send(client(), "batch", batch([prospect({ businessKey: "overture:i1" }), prospect({ businessKey: "overture:i2", name: "Lakeview Dental (TEST DATA)", phones: ["517-555-2195"] })]));
  const pid = (k: string) => (raw(db).prepare(`SELECT id FROM research_prospects WHERE business_key = ?`).get(k) as { id: string }).id;
  const owner = await createStaff(db, "owner");
  const actor = { kind: "user" as const, userId: owner.id, roles: [{ role: "owner" as const, organizationId: "org_crestmont" }], mfaVerified: true };
  const r = await R.promote(db, actor, pid("overture:i1"));
  assert.equal(r.outcome, "CREATED");
  const lead = raw(db).prepare(`SELECT origin, intake_decision_id, utm_source FROM leads WHERE id = ?`).get(r.leadId) as { origin: string; intake_decision_id: string; utm_source: string };
  assert.deepEqual([lead.origin, lead.utm_source], ["research_agent", "crestmont-research"]);
  assert.ok(raw(db).prepare(`SELECT 1 FROM crm_intake_decisions WHERE id = ?`).get(lead.intake_decision_id), "the CRM's decision record exists");
  // A contact for the second business is added to the CRM after ingest (another channel); promotion links, no second lead.
  const o = await client().login(owner.email, undefined, owner.secret);
  assert.equal((await o.post("/staff/crm/new", { name: "Front desk", email: "", phone: "(517) 555-2195", company: "Lakeview Dental (TEST DATA)", website: "", interest: "business", message: "x", source: "referral" })).status, 303);
  const leads0 = (raw(db).prepare(`SELECT COUNT(*) AS n FROM leads`).get() as { n: number }).n;
  await assert.rejects(R.promote(db, actor, pid("overture:i2")), /CRM contact|duplicate review/);
  assert.equal((raw(db).prepare(`SELECT COUNT(*) AS n FROM leads`).get() as { n: number }).n, leads0, "no second lead");
  assert.match((raw(db).prepare(`SELECT status FROM research_prospects WHERE id = ?`).get(pid("overture:i2")) as { status: string }).status, /existing_crm|review/);
});

test("[CRM-005] evidenced-problem sites qualify on supported severity (one high or two medium), not on a single medium or low finding", () => {
  const v = validateProspect(prospect({ businessKey: "overture:qs1", website: { classification: "VERIFIED_WEBSITE_ISSUES", url: "https://riverside-plumbing.example/", confidence: 0.9, checkedAt: NOW, checks: [] },
    findings: [{ code: "no_viewport_meta", title: "No mobile viewport", severity: "high", confidence: 0.8, url: "https://riverside-plumbing.example/", method: "HTTP GET", observedAt: NOW, evidence: "no viewport tag" }] }));
  assert.ok(v.ok);
  assert.equal(qualify(v.value).qualified, true, "one supported high-severity problem");
  const one = { ...v.value, findings: [{ ...v.value.findings[0], code: "images_without_alt", severity: "medium" as const }] };
  assert.equal(qualify(one).qualified, false, "one medium problem is not enough");
  assert.equal(qualify({ ...one, findings: [one.findings[0], { ...one.findings[0], code: "mixed_content" }] }).qualified, true, "two medium problems");
  assert.equal(qualify({ ...v.value, findings: [{ ...v.value.findings[0], confidence: 0.5 }] }).qualified, false, "low-confidence evidence never qualifies");
});

test("[CRM-005] 'no website found' qualifies only with independent corroboration of the business (online profile or two datasets)", () => {
  const mk = (signals: string[]) => { const v = validateProspect(prospect({ businessKey: "overture:nc1", findings: [], website: { classification: "NO_OFFICIAL_WEBSITE_FOUND", confidence: 0.7, checkedAt: NOW, identitySignals: signals, checks: [{ stage: "A", method: "m", result: "none", at: NOW }] } })); assert.ok(v.ok); return qualify(v.value); };
  const alone = mk(["record confidence 0.9"]);
  assert.equal(alone.qualified, false);
  assert.ok(alone.reasons.some((r) => /not independently corroborated/.test(r)));
  assert.equal(mk(["online profile: facebook.com"]).qualified, true);
  assert.equal(mk(["listed by 2 independent datasets: meta, foursquare"]).qualified, true);
});
