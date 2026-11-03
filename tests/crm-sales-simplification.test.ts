// Sales-facing simplification of the CRM and the research dashboard, and the wording of research summaries.
//
// These tests exist because the removals are easy to undo by accident and because the summary wording is a claim put
// in a salesperson's mouth: an automated check that did not find something must never be reported as proof the thing
// is absent. All data here is TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, type TestClient } from "./support/app.ts";
import { signEvidence } from "../src/readiness/ingest.ts";
import { randomToken } from "../src/lib/auth-crypto.ts";
import { conciseEvidence } from "../src/domain/research.ts";
import { runAutoPromotion } from "../src/services/research-promote.ts";
import type { ProspectInput } from "../src/domain/research.ts";
import type { SqliteDb } from "../dev/sqlite-d1.ts";

const SECRET = "test-research-secret";
const NOW = new Date().toISOString();
const raw = (db: unknown) => (db as SqliteDb).raw;

const prospect = (over: Partial<ProspectInput> & { businessKey: string }): ProspectInput => ({
  name: "Simplify Plumbing (TEST DATA)", category: "plumber", address: { line: "120 Main St", city: "Lansing", state: "MI", zip: "48933" },
  phones: ["(517) 555-7001"], emails: [], domains: ["simplify-plumbing.example"],
  sources: [{ source: "overture", sourceId: "s1", license: "CDLA-Permissive-2.0", release: "2026-10-21.0", retrievedAt: NOW }],
  website: { classification: "VERIFIED_WEBSITE_ISSUES", url: "https://simplify-plumbing.example/", confidence: 0.9, checkedAt: NOW, identitySignals: ["phone on page matches"], checks: [{ stage: "C", method: "HTTP GET", result: "200", at: NOW }] },
  findings: [
    { code: "no_viewport_meta", title: "No mobile viewport meta tag", severity: "high", confidence: 0.9, url: "https://simplify-plumbing.example/", method: "HTTP GET (no JS)", observedAt: NOW, evidence: "No <meta name=viewport> in the returned HTML" },
    { code: "images_without_alt", title: "Images without alt text", severity: "medium", confidence: 0.8, url: "https://simplify-plumbing.example/", method: "HTTP GET (no JS)", observedAt: NOW, evidence: "7 of 9 images had no alt attribute" },
  ],
  identityConfidence: 0.9, lastVerifiedAt: NOW, ...over,
} as ProspectInput);

async function researchLead() {
  const app = await createTestApp({ RESEARCH_RUNNER_SECRET: SECRET });
  await app.db.prepare(`UPDATE research_settings SET paused = 0 WHERE id = 1`).run();
  const payload = JSON.stringify({ batchId: `b_${randomToken(8)}`, runnerId: "ws-5090", prospects: [prospect({ businessKey: "overture:simp1" })], _nonce: randomToken(16) });
  const res = await app.client().request("POST", "/api/research/runner/batch", { body: payload, headers: { "content-type": "application/json", "x-crestmont-research-signature": await signEvidence(SECRET, payload) } });
  assert.equal(res.status, 200);
  assert.equal((await runAutoPromotion(app.db, { trigger: "owner" })).promoted, 1);
  const leadId = (raw(app.db).prepare(`SELECT id FROM leads WHERE origin = 'research_agent'`).get() as { id: string }).id;
  const owner = await createStaff(app.db, "owner");
  const c: TestClient = await app.client().login(owner.email, undefined, owner.secret);
  return { app, leadId, c };
}

test("[CRM-001] lead quick view shows the business and its website opportunity, and drops the activity timeline, attribution and assignment", async () => {
  const { leadId, c } = await researchLead();
  const page = await (await c.get(`/staff/crm/leads/${leadId}/quick`)).text();

  // Kept: what a salesperson needs in seconds.
  assert.match(page, /Website opportunity/);
  assert.match(page, /href="https:\/\/simplify-plumbing\.example\/"/, "the verified website is a clickable link");
  assert.match(page, /Research score/);
  assert.match(page, /Not released for automated calling/, "outreach eligibility is stated");
  assert.match(page, /No mobile viewport meta tag/, "the summary names what was observed");
  assert.match(page, /Next steps/);

  // Removed: the clutter.
  assert.doesNotMatch(page, /Recent activity/, "the activity timeline is gone from the drawer");
  assert.doesNotMatch(page, /data-attribution/, "campaign attribution is gone from the drawer");
  assert.doesNotMatch(page, /Assign to/, "no assignment control in the drawer");
  assert.doesNotMatch(page, /research_agent:promote:/, "no raw promotion identifier");
});

test("[CRM-001] the full lead shows a clickable website and a concise summary; the evidence dump and provenance move behind a disclosure", async () => {
  const { leadId, c } = await researchLead();
  const page = await (await c.get(`/staff/crm/leads/${leadId}`)).text();

  assert.match(page, /href="https:\/\/simplify-plumbing\.example\/"/);
  assert.match(page, /Website reviewed by automated inspection/, "the concise summary replaced the technical dump");
  assert.doesNotMatch(page, /<h3 style="font-size:1rem">Original message<\/h3>/, "the research evidence dump is not the lead's headline text");
  // Nothing was deleted: the full evidence and the compliance panel are one click away, not removed.
  assert.match(page, /<summary>Full research evidence<\/summary>/);
  assert.match(page, /<summary>Contact identity, provenance and duplicate protection<\/summary>/);
  assert.match(page, /data-identity/, "the identity panel still renders inside the disclosure");
  // Ownership is still visible and still changeable, just not as a primary card. An UNASSIGNED lead is the one case
  // where the picker must be reachable without opening anything: giving a new lead an owner is the next thing anyone
  // does with it, and hiding that control behind a click broke the staging journey that assigns a fresh lead.
  assert.match(page, /<dt>Owner<\/dt><dd>Unassigned<\/dd>/, "ownership is stated as a fact on the lead");
  assert.match(page, /<details class="card" open><summary>Assign an owner<\/summary>/, "an unassigned lead shows the picker without a click");
  assert.match(page, /name="owner"/, "the picker itself is on the page");
  // The sales workflows that must survive the cleanup.
  for (const kept of ["Stage", "Follow-up tasks", "Quotes", "Orders", "Projects", "Support tickets", "Activity"]) assert.ok(page.includes(kept), `removed too much: ${kept}`);
});

test("[CRM-001] once a lead has an owner the picker folds away again, and assignment still works through the real route", async () => {
  const { app, leadId, c } = await researchLead();
  const rep = await createStaff(app.db, "sales", "rep-assign@crestmont.test", "Rep Assigned");
  const res = await c.post(`/staff/crm/leads/${leadId}/assign`, { owner: rep.id });
  assert.equal(res.status, 303, "the assignment route is unchanged");
  const page = await (await c.get(`/staff/crm/leads/${leadId}`)).text();
  assert.match(page, /<dt>Owner<\/dt><dd>Rep Assigned<\/dd>/, "the new owner is stated as a fact");
  assert.match(page, /<details class="card"><summary>Change owner \(/, "an assigned lead folds the picker away again");
  assert.doesNotMatch(page, /<details class="card" open><summary>Assign an owner/);
});

test("[CRM-001] the sales dashboard no longer carries the detailed campaign attribution tables, and attribution is still stored", async () => {
  const { app, leadId, c } = await researchLead();
  const dash = await (await c.get("/staff/crm/sales")).text();
  assert.doesNotMatch(dash, /data-attribution-report/, "the detailed attribution tables are gone from the sales dashboard");
  assert.doesNotMatch(dash, /Campaign attribution/);
  // Storage is untouched, which is what "preserve attribution collection and storage" means: the promoted lead still
  // carries its UTM provenance, and crm.attributionReport can still read it.
  const row = raw(app.db).prepare(`SELECT utm_source, utm_medium, utm_campaign FROM leads WHERE id = ?`).get(leadId) as Record<string, string>;
  assert.deepEqual([row.utm_source, row.utm_medium, row.utm_campaign], ["crestmont-research", "research-agent", "verified_website_issues"]);
  assert.equal(typeof (await import("../src/services/crm.ts")).attributionReport, "function",
    "the attribution report remains available to backend reporting; only its tables left the sales page");
});

// ───────────── the wording itself ─────────────

test("[CRM-001] a summary never turns an automated check's limit into proof, and names the worst findings first", () => {
  const broken = conciseEvidence({ websiteClass: "VERIFIED_WEBSITE_BROKEN", score: 72, websiteUrl: "https://x.example/", findings: [] });
  assert.match(broken, /did not load when it was checked/);
  assert.match(broken, /Research score 72\/100\./);

  // The claim that matters most: absence of evidence is reported as such.
  const none = conciseEvidence({ websiteClass: "NO_OFFICIAL_WEBSITE_FOUND", score: 61, findings: [] });
  assert.match(none, /No official website was found/);
  assert.match(none, /not proof none exists/);
  assert.doesNotMatch(none, /has no website|does not have a website/);

  // An unverified site is not a bad site.
  const unverified = conciseEvidence({ websiteClass: "WEBSITE_UNVERIFIED", score: 0, findings: [] });
  assert.match(unverified, /could not be verified/);

  // High severity leads; low-confidence and minor findings are not quoted as observations.
  const issues = conciseEvidence({ websiteClass: "VERIFIED_WEBSITE_ISSUES", score: 65, websiteUrl: "https://x.example/", findings: [
    { title: "Images without alt text", severity: "medium", confidence: 0.8 },
    { title: "No mobile viewport meta tag", severity: "high", confidence: 0.9 },
    { title: "Tiny nit", severity: "low", confidence: 0.9 },
    { title: "Guessy claim", severity: "high", confidence: 0.2 },
  ] });
  assert.match(issues, /^Website reviewed by automated inspection\./);
  assert.ok(issues.indexOf("No mobile viewport meta tag") < issues.indexOf("Images without alt text"), "worst first");
  assert.doesNotMatch(issues, /Tiny nit/, "a low-severity finding is not quoted");
  assert.doesNotMatch(issues, /Guessy claim/, "a low-confidence finding is not quoted");

  // More than three material findings are counted, not listed forever.
  const many = conciseEvidence({ websiteClass: "VERIFIED_WEBSITE_ISSUES", score: 80, findings: Array.from({ length: 6 }, (_, i) => ({ title: `Problem ${i}`, severity: "high" as const, confidence: 0.9 })) });
  assert.match(many, /and 3 more/);
});
