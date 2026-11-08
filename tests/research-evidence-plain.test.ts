// Phase 2.1: Lead Research evidence in plain English for an employee with no engineering knowledge. The record comes in
// through the real signed runner API; the page answers which business, why, website found, does it work, the evidence
// and how sure we are, when, ready for outreach, and what to do next. Speculative findings are labelled as such; the raw
// technical evidence is kept, hidden under "Technical details". TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, type TestClient } from "./support/app.ts";
import { signEvidence } from "../src/readiness/ingest.ts";
import { randomToken } from "../src/lib/auth-crypto.ts";

const SECRET = "test-research-secret";
const NOW = new Date().toISOString();
async function send(c: TestClient, body: Record<string, unknown>) {
  const payload = JSON.stringify({ ...body, _nonce: randomToken(16) });
  return c.request("POST", "/api/research/runner/batch", { body: payload, headers: { "content-type": "application/json", "x-crestmont-research-signature": await signEvidence(SECRET, payload) } });
}

test("[CRM-004] Lead Research evidence reads in plain English; speculation is labelled; raw evidence is hidden but kept", async () => {
  const t = await createTestApp({ RESEARCH_RUNNER_SECRET: SECRET });
  await t.db.prepare(`UPDATE research_settings SET paused = 0, pause_reason = NULL WHERE id = 1`).run();
  const owner = await createStaff(t.db, "owner");
  const res = await send(t.client(), { batchId: `b_${randomToken(8)}`, runnerId: "ws-5090", prospects: [{
    businessKey: "overture:plain1", name: "Riverside Plumbing (TEST DATA)", category: "plumber", address: { line: "120 Main St", city: "Lansing", state: "MI", zip: "48933" },
    phones: ["(517) 555-2142"], emails: [], domains: ["riverside-plumbing.example"],
    sources: [{ source: "overture", sourceId: "plain1", license: "CDLA-Permissive-2.0", release: "2026-10-21.0", retrievedAt: NOW }],
    website: { classification: "VERIFIED_WEBSITE_BROKEN", url: "https://riverside-plumbing.example/", confidence: 0.9, checkedAt: NOW, identitySignals: ["phone on page matches", "city matches"],
      checks: [{ stage: "C", method: "HTTP GET", result: "503 on 3 attempts over 2 days", at: NOW }] },
    findings: [
      { code: "http_5xx", title: "Home page returns HTTP 503", severity: "critical", confidence: 0.95, url: "https://riverside-plumbing.example/", method: "HTTP GET (no JS), 3 attempts", observedAt: NOW, evidence: "Status 503 on 3 of 3 attempts" },
      { code: "stale_copyright", title: "Footer copyright 2017", severity: "low", confidence: 0.5, url: "https://riverside-plumbing.example/", method: "HTML scan", observedAt: NOW, evidence: "© 2017 in footer" },
    ],
    identityConfidence: 0.9, lastVerifiedAt: NOW,
  }] });
  assert.equal(res.status, 200);
  await t.db.prepare(`UPDATE research_prospects SET status = 'review' WHERE business_key = 'overture:plain1'`).run();

  const c = await t.client().login(owner.email, undefined, owner.secret);
  const page = await (await c.get("/staff/research")).text();
  const panel = /<details class="research-detail" data-evidence-plain>[\s\S]*?<details class="research-technical">/.exec(page)?.[0];
  assert.ok(panel, "the plain panel is shown, with the technical details after it");
  for (const re of [
    /<summary>What we found<\/summary>/,
    /<dt>Business<\/dt>\s*<dd><strong>Riverside Plumbing \(TEST DATA\)<\/strong>/,
    /Why it was identified<\/dt>\s*<dd>Their website appears to be broken, so they may need a new one\./,
    /Website found\?<\/dt>\s*<dd>Yes — we found the business&#39;s own website\.|Website found\?<\/dt>\s*<dd>Yes — we found the business's own website\./,
    /Does the website work\?<\/dt>\s*<dd>No — the website could not be opened properly when we checked\./,
    /How reliable is this\?[\s\S]*?>High</,
    /When we checked<\/dt>\s*<dd>[^<]+<span class="faint">\(today\)<\/span>/,
    /Ready for outreach\?<\/dt>\s*<dd>Not yet — a person needs to check it first\./,
    /What to do next<\/dt>\s*<dd><strong>Look at the evidence and either create a CRM lead or dismiss it with a reason\./,
    />Checked<\/span> The website was returning a server error when we checked\./,
    />Possible — not confirmed<\/span> The website&#39;s copyright date looks several years out of date\.|>Possible — not confirmed<\/span> The website's copyright date looks several years out of date\./,
  ]) assert.match(panel!, re);
  // No raw technical labels in the plain part.
  assert.doesNotMatch(panel!, /HTTP 503|VERIFIED_WEBSITE_BROKEN|confidence \d+%|CDLA|overture plain1/);
  // The technical evidence and provenance are all still there, under Technical details.
  const tech = /<details class="research-technical">[\s\S]*?<\/details>/.exec(page)![0];
  for (const re of [/Home page returns HTTP 503/, /503 on 3 attempts over 2 days/, /CDLA-Permissive-2\.0/, /confidence 90%/, /Provenance/]) assert.match(tech, re);
  assert.match(page, /value="Create CRM lead"|>Create CRM lead</);
});
