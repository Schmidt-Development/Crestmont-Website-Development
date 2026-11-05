// FD-13 (Founder decision, 2026-11): a website appears as portfolio work only after the owner's explicit, recorded
// opt-in; withdrawal unpublishes it. TEST DATA only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff } from "./support/app.ts";
import { nowIso } from "../src/lib/db.ts";
import { publishBlockers, recordPortfolioConsent, withdrawPortfolioConsent, setPublished, type PortfolioProject } from "../src/services/portfolio.ts";
import type { Actor } from "../src/domain/authz.ts";

const ready = (extra: Partial<PortfolioProject> = {}) => ({
  desktop_screenshot_file_id: "f1", mobile_screenshot_file_id: "f2", relationship: "Client website built by Crestmont",
  relationship_documented_at: "2026-10-01T00:00:00.000Z", link_verified_at: "2026-10-02T00:00:00.000Z", ...extra,
}) as PortfolioProject;

test("[PORT-005] [PORT-007] FD-13: publishing is blocked until the owner's opt-in is recorded, and again after it is withdrawn", () => {
  assert.match(publishBlockers(ready()).join(" "), /explicit opt-in to portfolio display has not been recorded/);
  assert.deepEqual(publishBlockers(ready({ portfolio_consent_at: "2026-10-03T00:00:00.000Z" })), []);
  assert.equal(publishBlockers(ready({ portfolio_consent_at: "2026-10-03T00:00:00.000Z", portfolio_consent_withdrawn_at: "2026-10-20T00:00:00.000Z" })).length, 1);
});

test("[PORT-005] [PORT-007] FD-13: the Founder's own businesses keep their recorded written authorization as consent (migration backfill); others get none", async () => {
  const t = await createTestApp();
  const rows = (await t.db.prepare(`SELECT id, relationship, portfolio_consent_at, portfolio_consent_method FROM portfolio_projects`).all<{ id: string; relationship: string; portfolio_consent_at: string | null; portfolio_consent_method: string | null }>()).results;
  for (const r of rows) {
    if (/^Founder-owned business/.test(r.relationship)) assert.equal(r.portfolio_consent_method, "written", r.id);
    else assert.equal(r.portfolio_consent_at, null, `${r.id}: no consent invented`);
  }
});

test("[PORT-005] [PORT-007] FD-13: staff record consent with who/how/when/evidence; withdrawal unpublishes immediately and blocks republishing", async () => {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner");
  const actor: Actor = { kind: "user", userId: owner.id, roles: [{ role: "owner", organizationId: owner.organizationId }], mfaVerified: true };
  const id = "pf_consent_fixture";
  await t.db.prepare(`INSERT INTO portfolio_projects (id, slug, name, industry, live_url, relationship, description, verified_features_json, position, published, updated_at, created_at,
      desktop_screenshot_file_id, mobile_screenshot_file_id, relationship_documented_at, link_verified_at, poster_desktop_asset, poster_mobile_asset)
      VALUES (?, 'consent-fixture', 'Consent Fixture Co', 'Testing', 'https://consent.fixture.example', 'Client website built by Crestmont', 'TEST DATA', '[]', 99, 0, ?, ?, NULL, NULL, ?, ?, '/assets/portfolio/fixture-desktop.webp', '/assets/portfolio/fixture-mobile.webp')`)
    .bind(id, nowIso(), nowIso(), nowIso(), nowIso()).run();
  await assert.rejects(setPublished(t.db, actor, id, true), /cannot be published yet/);
  await assert.rejects(recordPortfolioConsent(t.db, actor, id, { givenBy: "x", method: "phone", givenOn: "2999-01-01", evidence: "short" }), (e: { issues?: string[] }) => (e.issues ?? []).length === 4);
  await recordPortfolioConsent(t.db, actor, id, { givenBy: "Pat Owner, owner", method: "written", givenOn: "2026-10-30", evidence: "Signed consent form, stored in the project folder" });
  await setPublished(t.db, actor, id, true);
  assert.equal((await t.db.prepare(`SELECT published FROM portfolio_projects WHERE id = ?`).bind(id).first<{ published: number }>())!.published, 1);
  await withdrawPortfolioConsent(t.db, actor, id, "Owner asked by email to remove it");
  assert.equal((await t.db.prepare(`SELECT published FROM portfolio_projects WHERE id = ?`).bind(id).first<{ published: number }>())!.published, 0);
  await assert.rejects(setPublished(t.db, actor, id, true), /cannot be published yet/);
  const actions = (await t.db.prepare(`SELECT action FROM audit_logs WHERE subject_id = ? ORDER BY id`).bind(id).all<{ action: string }>()).results.map((r) => r.action);
  assert.deepEqual(actions, ["portfolio.consent_recorded", "portfolio.published", "portfolio.consent_withdrawn"]);
});
