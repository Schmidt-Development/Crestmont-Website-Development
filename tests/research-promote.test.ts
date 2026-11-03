// Automatic research → CRM promotion and backlog reconciliation (migration 0073).
//
// What these tests are really defending: the CRM gets every eligible qualified business WITHOUT a per-lead click,
// and without any of the protections that used to sit behind that click being lost. So each test either proves a
// lead now arrives on its own, or proves a record that must NOT become a lead still does not.
// Every business, number and domain here is TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, type TestClient } from "./support/app.ts";
import { signEvidence } from "../src/readiness/ingest.ts";
import { randomToken } from "../src/lib/auth-crypto.ts";
import type { ProspectInput } from "../src/domain/research.ts";
import * as R from "../src/services/research.ts";
import { addDnc } from "../src/services/voice-outbound.ts";
import { runAutoPromotion, eligibilityCensus, dueCount, MAX_PROMOTE_ATTEMPTS, RESEARCH_AUTOMATION } from "../src/services/research-promote.ts";
import { runJobs } from "../src/app/scheduled.ts";
import type { SqliteDb } from "../dev/sqlite-d1.ts";

const SECRET = "test-research-secret";
const NOW = new Date().toISOString();
const raw = (db: unknown) => (db as SqliteDb).raw;

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

/** A distinct business per index, so each becomes its own prospect rather than a shared-number review case. */
const nth = (i: number, over: Partial<ProspectInput> = {}) => prospect({
  businessKey: `overture:ap${i}`, name: `Auto Promote ${i} (TEST DATA)`,
  phones: [`(517) 555-${String(3000 + i).padStart(4, "0")}`],
  domains: [`auto-promote-${i}.example`],
  website: { classification: "VERIFIED_WEBSITE_BROKEN", url: `https://auto-promote-${i}.example/`, confidence: 0.9, checkedAt: NOW, identitySignals: ["phone on page matches"], checks: [{ stage: "C", method: "HTTP GET", result: "503", at: NOW }] },
  ...over,
});

async function setup() {
  const app = await createTestApp({ RESEARCH_RUNNER_SECRET: SECRET });
  await app.db.prepare(`UPDATE research_settings SET paused = 0, pause_reason = NULL WHERE id = 1`).run();
  return app;
}
async function send(c: TestClient, path: "heartbeat" | "batch", body: Record<string, unknown>) {
  const payload = JSON.stringify({ ...body, _nonce: randomToken(16) });
  return c.request("POST", `/api/research/runner/${path}`, { body: payload, headers: { "content-type": "application/json", "x-crestmont-research-signature": await signEvidence(SECRET, payload) } });
}
const ingest = (c: TestClient, prospects: unknown[]) => send(c, "batch", { batchId: `b_${randomToken(8)}`, runnerId: "ws-5090", prospects });
const leadCount = (db: unknown) => (raw(db).prepare(`SELECT COUNT(*) AS n FROM leads WHERE origin = 'research_agent'`).get() as { n: number }).n;
const statusOf = (db: unknown, key: string) => (raw(db).prepare(`SELECT status FROM research_prospects WHERE business_key = ?`).get(key) as { status: string } | undefined)?.status;

// ───────────── the core: eligible qualified prospects reach the CRM with no per-lead click ─────────────

test("[CRM-005] every eligible qualified prospect becomes a CRM lead automatically, in the New stage, with its website, score and evidence", async () => {
  const t = await setup();
  const c = t.client();
  await ingest(c, [nth(1), nth(2), nth(3)]);
  assert.equal(leadCount(t.db), 0, "nothing is promoted until a promotion run happens");

  const r = await runAutoPromotion(t.db, { trigger: "owner" });
  assert.equal(r.examined, 3);
  assert.equal(r.promoted, 3);
  assert.equal(r.remaining, 0);
  assert.equal(r.stoppedReason, "drained");
  assert.equal(leadCount(t.db), 3, "three CRM leads, with no Owner clicking three times");

  // Research qualification is not sales qualification: the lead lands in New.
  const lead = raw(t.db).prepare(`SELECT l.stage, l.origin, l.source, l.utm_source, l.message, l.interest, l.intake_decision_id, c.phone_norm
      FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.origin = 'research_agent' LIMIT 1`).get() as Record<string, string>;
  assert.equal(lead.stage, "new");
  assert.equal(lead.origin, "research_agent");
  assert.equal(lead.utm_source, "crestmont-research");
  assert.ok(lead.intake_decision_id, "went through the CRM intake engine, so its decision is recorded");
  assert.ok(lead.phone_norm, "the contact carries the research phone number");
  // The evidence a salesperson needs is on the lead: the verified URL, the score and the finding.
  assert.match(lead.message, /auto-promote-1\.example|auto-promote-2\.example|auto-promote-3\.example/);
  assert.match(lead.message, /\b(5[0-9]|[6-9][0-9]|100)\b/, "the research score is recorded");

  // The research record points at its lead and is no longer offered for promotion.
  const p = raw(t.db).prepare(`SELECT status, crm_lead_id FROM research_prospects WHERE business_key = 'overture:ap1'`).get() as { status: string; crm_lead_id: string | null };
  assert.equal(p.status, "promoted");
  assert.ok(p.crm_lead_id);
  // Promotion is audited per prospect and the run itself is audited once.
  const audits = raw(t.db).prepare(`SELECT action, COUNT(*) AS n FROM audit_logs WHERE action IN ('research.prospect_promoted','research.auto_promotion_run') GROUP BY action`).all() as { action: string; n: number }[];
  assert.equal(audits.find((a) => a.action === "research.prospect_promoted")?.n, 3);
  assert.equal(audits.find((a) => a.action === "research.auto_promotion_run")?.n, 1);
});

test("[CRM-005] re-running promotion creates no second lead, and two overlapping runs do not double-create", async () => {
  const t = await setup();
  await ingest(t.client(), [nth(10), nth(11)]);
  assert.equal((await runAutoPromotion(t.db, { trigger: "owner" })).promoted, 2);
  const after = leadCount(t.db);

  // Repeat: the prospects are no longer 'qualified', so nothing is even attempted.
  const again = await runAutoPromotion(t.db, { trigger: "owner" });
  assert.equal(again.examined, 0);
  assert.equal(leadCount(t.db), after, "a repeated run is a no-op, not a duplicate");

  // Overlapping runs over a fresh backlog: both read the same due batch, and the intake engine's idempotency key
  // means the second attempt on a prospect returns the first decision instead of a second lead.
  await ingest(t.client(), [nth(12), nth(13)]);
  const [a, b] = await Promise.all([runAutoPromotion(t.db, { trigger: "owner" }), runAutoPromotion(t.db, { trigger: "scheduled", limit: 50 })]);
  assert.equal(leadCount(t.db), after + 2, "two concurrent runs created exactly two leads");
  assert.ok(a.promoted + b.promoted >= 2);
  assert.equal(await dueCount(t.db, new Date()), 0);
});

// ───────────── records that must NOT be promoted automatically ─────────────

test("[CRM-005] a shared number, a do-not-call number, an existing CRM contact and an unqualified record are never promoted automatically", async () => {
  const t = await setup();
  const c = t.client();
  // Two businesses sharing one number: a person must decide who it reaches.
  await ingest(c, [
    nth(20, { phones: ["(517) 555-4100"] }),
    prospect({ businessKey: "overture:ap21", name: "Shared Number Co (TEST DATA)", phones: ["(517) 555-4100"], domains: ["shared-21.example"],
      website: { classification: "VERIFIED_WEBSITE_BROKEN", url: "https://shared-21.example/", confidence: 0.9, checkedAt: NOW, identitySignals: ["phone on page matches"], checks: [{ stage: "C", method: "HTTP GET", result: "503", at: NOW }] } }),
  ]);
  // A do-not-call number.
  await addDnc(t.db, "+15175554200", "caller_request", "TEST DATA opt-out");
  await ingest(c, [nth(22, { phones: ["(517) 555-4200"] })]);
  // A record with no evidenced opportunity at all.
  await ingest(c, [nth(23, { website: { classification: "VERIFIED_OFFICIAL_WEBSITE", url: "https://auto-promote-23.example/", confidence: 0.9, checkedAt: NOW, identitySignals: ["phone on page matches"], checks: [] }, findings: [] })]);

  const r = await runAutoPromotion(t.db, { trigger: "owner" });
  assert.equal(r.promoted, 0, "none of these may become a lead on their own");
  assert.equal(leadCount(t.db), 0);
  assert.equal(statusOf(t.db, "overture:ap20"), "review");
  assert.equal(statusOf(t.db, "overture:ap21"), "review");
  assert.equal(statusOf(t.db, "overture:ap22"), "suppressed");
  assert.equal(statusOf(t.db, "overture:ap23"), "not_qualified");

  // They are reported as such, not hidden: the census accounts for every record with a stated reason.
  const census = await eligibilityCensus(t.db);
  assert.equal(census.eligibleNow, 0);
  assert.equal(census.needsPerson, 2);
  assert.equal(census.suppressed, 1);
  assert.equal(census.notQualified, 1);
  assert.equal(census.totalOnRecord, 4);
});

test("[CRM-005] raising the qualification threshold takes prospects out of the eligible population instead of promoting them", async () => {
  const t = await setup();
  await ingest(t.client(), [nth(30)]);
  await t.db.prepare(`UPDATE research_settings SET qualify_threshold = 100 WHERE id = 1`).run();
  const r = await runAutoPromotion(t.db, { trigger: "owner" });
  assert.equal(r.examined, 0, "a prospect below the live threshold is not eligible");
  assert.equal(leadCount(t.db), 0);
  const census = await eligibilityCensus(t.db);
  assert.equal(census.eligibleNow, 0);
  assert.equal(census.belowThreshold, 1);
});

// ───────────── the backlog: bounded, resumable, fully accounted for ─────────────

test("[CRM-005] a backlog is drained in bounded resumable batches, and every record is accounted for", async () => {
  const t = await setup();
  const c = t.client();
  for (let b = 0; b < 2; b++) await ingest(c, Array.from({ length: 12 }, (_, i) => nth(100 + b * 12 + i)));
  assert.equal(await dueCount(t.db, new Date()), 24);

  // The Owner's cap bounds one run; what is left is reported so the drain can continue.
  await t.db.prepare(`UPDATE research_settings SET auto_promote = 1, auto_promote_max_per_run = 10 WHERE id = 1`).run();
  const first = await runAutoPromotion(t.db, { trigger: "scheduled" });
  assert.equal(first.examined, 10);
  assert.equal(first.promoted, 10);
  assert.equal(first.remaining, 14);
  assert.equal(first.stoppedReason, "cap");

  let guard = 0;
  while ((await dueCount(t.db, new Date())) > 0 && guard++ < 10) await runAutoPromotion(t.db, { trigger: "scheduled" });
  assert.equal(leadCount(t.db), 24, "the whole backlog reached the CRM across several bounded runs");

  // Numerical reconciliation: nothing eligible is left stranded, and the run history records what happened.
  const census = await eligibilityCensus(t.db);
  assert.equal(census.eligibleNow, 0);
  assert.equal(census.alreadyPromoted, 24);
  assert.equal(census.uniqueQualified, 24);
  const runs = raw(t.db).prepare(`SELECT COALESCE(SUM(promoted),0) AS p, COALESCE(SUM(examined),0) AS e FROM research_promotion_runs`).get() as { p: number; e: number };
  assert.equal(runs.p, 24, "the recorded runs account for exactly the leads created");
  assert.equal(runs.e, 24);
});

test("[CRM-005] a pause stops new research but never strands the existing backlog", async () => {
  const t = await setup();
  await ingest(t.client(), [nth(40), nth(41)]);
  // The Owner pauses research the supported way.
  const owner = await createStaff(t.db, "owner");
  const actor = { kind: "user" as const, userId: owner.id, roles: [{ role: "owner" as const, organizationId: "org_crestmont" }], mfaVerified: true };
  assert.deepEqual(await R.saveSettings(t.db, actor, { paused: true, reason: "Reconciliation in progress", threshold: 60, maxBatch: 200 }), []);
  assert.equal((await R.loadSettings(t.db)).paused, 1);

  // New research is refused...
  const refused = await ingest(t.client(), [nth(42)]);
  assert.equal(refused.status, 409);
  // ...while the backlog still reaches the CRM. These are different things.
  const r = await runAutoPromotion(t.db, { trigger: "owner" });
  assert.equal(r.promoted, 2);
  assert.equal(leadCount(t.db), 2);
  assert.equal((await R.loadSettings(t.db)).paused, 1, "reconciling does not resume research");
});

// ───────────── the Owner's decision, and retry behaviour ─────────────

test("[OWN-002] the scheduled job does nothing until the Owner turns automatic promotion on; an Owner-triggered run always works", async () => {
  const t = await setup();
  await ingest(t.client(), [nth(50)]);
  assert.equal((await R.loadSettings(t.db)).auto_promote, 0, "automatic promotion ships off, so a deploy cannot start creating leads by surprise");

  const off = await runAutoPromotion(t.db, { trigger: "scheduled" });
  assert.equal(off.stoppedReason, "disabled");
  assert.equal(off.examined, 0);
  assert.equal(off.remaining, 1, "it still reports what is waiting");
  assert.equal(leadCount(t.db), 0);

  // An Owner asking is itself the decision.
  assert.equal((await runAutoPromotion(t.db, { trigger: "owner" })).promoted, 1);

  // Once enabled, the scheduled job promotes on its own, and is registered in the 15-minute set.
  await ingest(t.client(), [nth(51)]);
  await t.db.prepare(`UPDATE research_settings SET auto_promote = 1 WHERE id = 1`).run();
  const on = await runAutoPromotion(t.db, { trigger: "scheduled" });
  assert.equal(on.promoted, 1);
  assert.equal(leadCount(t.db), 2);
});

test("[OWN-002] research_promote runs as a recorded scheduled job", async () => {
  const t = await setup();
  await ingest(t.client(), [nth(60)]);
  await t.db.prepare(`UPDATE research_settings SET auto_promote = 1 WHERE id = 1`).run();
  const results = await runJobs(t.env, ["research_promote"]);
  const r = results["research_promote"]!;
  assert.ok(r, "the job is registered by name");
  assert.equal(r.ok, true, r.detail);
  assert.match(r.detail, /1 new CRM leads/);
  assert.equal(leadCount(t.db), 1);
});

test("[CRM-005] a record the CRM keeps refusing is retried with backoff and then reported, not attempted forever", async () => {
  const t = await setup();
  await ingest(t.client(), [nth(70)]);
  const id = (raw(t.db).prepare(`SELECT id FROM research_prospects WHERE business_key = 'overture:ap70'`).get() as { id: string }).id;
  // Force the shape of a record the intake engine will not accept as a lead: no usable contact identity at all.
  // (Reached directly because validation stops such a record at ingest, which is itself the first line of defence.)
  raw(t.db).prepare(`UPDATE research_prospects SET phone_e164 = NULL, phone_norm = NULL, phones_json = '[]', email = NULL, emails_json = '[]' WHERE id = ?`).run(id);

  const first = await runAutoPromotion(t.db, { trigger: "owner" });
  assert.equal(first.promoted, 0);
  assert.equal(first.examined, 1);
  assert.equal(first.rejected, 1, "classified as an intake rejection, not as a mystery failure");
  assert.equal(leadCount(t.db), 0);
  const afterOne = raw(t.db).prepare(`SELECT promote_attempts AS a, promote_next_at AS next, promote_last_error AS err FROM research_prospects WHERE id = ?`).get(id) as { a: number; next: string | null; err: string | null };
  assert.equal(afterOne.a, 1);
  assert.ok(afterOne.next, "backed off rather than retried immediately");
  assert.ok(afterOne.err);
  // It is not due again yet, so the next run leaves it alone instead of hammering the intake engine.
  assert.equal((await runAutoPromotion(t.db, { trigger: "owner" })).examined, 0);

  // Out of attempts: it drops out of the eligible population and is reported as unresolved.
  raw(t.db).prepare(`UPDATE research_prospects SET promote_attempts = ?, promote_next_at = NULL WHERE id = ?`).run(MAX_PROMOTE_ATTEMPTS, id);
  assert.equal(await dueCount(t.db, new Date()), 0);
  const census = await eligibilityCensus(t.db);
  assert.equal(census.eligibleNow, 0);
  assert.equal(census.outOfAttempts, 1);
});

// ───────────── compliance: a CRM lead is not permission to contact anyone ─────────────

test("[VOICE-002] automatic promotion never releases anyone for calling and queues no call, SMS or email", async () => {
  const t = await setup();
  await ingest(t.client(), [nth(80), nth(81)]);
  const before = (raw(t.db).prepare(`SELECT COUNT(*) AS n FROM email_deliveries`).get() as { n: number }).n;
  assert.equal((await runAutoPromotion(t.db, { trigger: "owner" })).promoted, 2);

  assert.equal((raw(t.db).prepare(`SELECT COUNT(*) AS n FROM research_prospects WHERE eligibility = 'eligible'`).get() as { n: number }).n, 0,
    "the outbound gate stays fail-closed for every promoted prospect");
  assert.equal((raw(t.db).prepare(`SELECT COUNT(*) AS n FROM voice_outbound_requests`).get() as { n: number }).n, 0, "no call was queued");
  assert.equal((raw(t.db).prepare(`SELECT COUNT(*) AS n FROM email_deliveries`).get() as { n: number }).n, before, "no email was sent to the business");
  // The lead itself says so in writing, for whoever works it.
  const msg = (raw(t.db).prepare(`SELECT message FROM leads WHERE origin = 'research_agent' LIMIT 1`).get() as { message: string }).message;
  assert.match(msg, /not released for automated calling/i);
});

test("[CRM-005] the automatic promoter is a system actor: it can create a lead and cannot touch Founder-protected powers", async () => {
  const { can } = await import("../src/domain/authz.ts");
  assert.equal(RESEARCH_AUTOMATION.kind, "system");
  assert.equal(can(RESEARCH_AUTOMATION, "lead.write_all"), true, "it must be able to create CRM leads");
  for (const p of ["pricing.change", "release.deploy_production", "refund.issue", "payments.simulate"] as const)
    assert.equal(can(RESEARCH_AUTOMATION, p), false, `automation must never hold ${p}`);
});
