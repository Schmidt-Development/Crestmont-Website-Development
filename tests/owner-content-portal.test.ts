// Website CMS version workflow and customer-portal team/maintenance modules, exercised through the
// real request pipeline. All records are TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD } from "./support/app.ts";
import { newId, nowIso, type Db } from "../src/lib/db.ts";
import { hashPassword } from "../src/lib/auth-crypto.ts";

const one = async <T>(db: Db, sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;
const hero = (heading: string) => ({ eyebrow: "Crestmont", heading, lede: "A lead paragraph for the homepage hero section.", primary_label: "See packages", quote_label: "Get a quote" });

test("[CMS-001] CMS: compare a revision with the live page, discard a draft (kept as archived), restore an old revision as a new draft", async () => {
  const t = await createTestApp();
  const s = await createStaff(t.db, "administrator");
  const c = await t.client().login(s.email, TEST_PASSWORD, s.secret);
  assert.equal((await c.post("/staff/cms/home.hero", hero("First published heading."))).status, 303);
  const first = await one<{ id: string }>(t.db, `SELECT id FROM cms_revisions ORDER BY rowid DESC LIMIT 1`);
  assert.equal((await c.post(`/staff/cms/revisions/${first.id}/publish`)).status, 303);
  assert.equal((await c.post("/staff/cms/home.hero", hero("Draft heading under review."))).status, 303);
  const draft = await one<{ id: string }>(t.db, `SELECT id FROM cms_revisions WHERE status = 'draft' ORDER BY rowid DESC LIMIT 1`);

  const cmp = await (await c.get(`/staff/cms/revisions/${draft.id}/compare`)).text();
  assert.match(cmp, /- First published heading\./);
  assert.match(cmp, /\+ Draft heading under review\./);
  assert.doesNotMatch(cmp, /<h3 class="h4">Lead paragraph<\/h3>/, "unchanged fields are not listed");
  assert.match(await (await c.get(`/staff/cms/revisions/${first.id}/compare`)).text(), /identical to what the live page shows/);

  assert.equal((await c.post(`/staff/cms/revisions/${draft.id}/discard`)).status, 303);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM cms_revisions WHERE id = ?`, draft.id)).status, "archived");
  assert.equal((await c.post(`/staff/cms/revisions/${draft.id}/discard`)).status, 409, "only unpublished drafts can be discarded");
  assert.equal((await c.post(`/staff/cms/revisions/${first.id}/discard`)).status, 409, "the live revision cannot be discarded");
  assert.match(await (await t.client().get("/")).text(), /First published heading\./, "discarding never changes the live page");

  assert.equal((await c.post(`/staff/cms/revisions/${draft.id}/restore`)).status, 303);
  const restored = await one<{ id: string; status: string; note: string; body_json: string }>(t.db, `SELECT id, status, note, body_json FROM cms_revisions ORDER BY rowid DESC LIMIT 1`);
  assert.equal(restored.status, "draft");
  assert.match(restored.note, new RegExp(`Restored from revision .*${draft.id}`));
  assert.equal(JSON.parse(restored.body_json).heading, "Draft heading under review.");
  assert.match(await (await t.client().get("/")).text(), /First published heading\./, "restoring creates a draft; the live page is unchanged until publish");
  for (const a of ["cms.draft_discarded", "cms.revision_restored"]) assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?`, a)).n, 1, a);

  const dev = await createStaff(t.db, "developer");
  const d = await t.client().login(dev.email, TEST_PASSWORD, dev.secret);
  assert.equal((await d.post(`/staff/cms/revisions/${restored.id}/discard`)).status, 403);
  assert.equal((await d.get(`/staff/cms/revisions/${restored.id}/compare`)).status, 403);
});

async function addMember(db: Db, orgId: string, email: string, role: "customer_admin" | "customer_member", name = "Team Mate") {
  const id = newId("usr");
  await db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, created_at) VALUES (?,?,?,?,?,?)`).bind(id, email, name, await hashPassword(TEST_PASSWORD), nowIso(), nowIso()).run();
  await db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?,?,?)`).bind(newId("mbr"), id, orgId, role, nowIso()).run();
  return id;
}

test("[AUTH-008] customer team permissions: admins change roles, remove members and revoke invitations within their own organization only; one admin always remains", async () => {
  const t = await createTestApp();
  const owner = await createCustomer(t.db, "boss@team.example", "Team Co");
  const memberId = await addMember(t.db, owner.organizationId, "mate@team.example", "customer_member", "Mia Mate");
  const other = await createCustomer(t.db, "boss@other.example", "Other Co");
  const outsiderId = await addMember(t.db, other.organizationId, "x@other.example", "customer_member");
  const admin = await t.client().login(owner.email);
  const mate = await t.client().login("mate@team.example");

  // Members cannot manage the team.
  assert.equal((await mate.post(`/portal/team/members/${owner.id}/role`, { role: "customer_member" })).status, 403);
  assert.equal((await mate.post("/portal/team", { email: "new@team.example" })).status, 403);

  // Invite as administrator; a duplicate pending invite is refused; revoke works and is scoped.
  assert.equal((await admin.post("/portal/team", { email: "lead@team.example", role: "customer_admin" })).status, 303);
  const inv = await one<{ id: string; role_id: string }>(t.db, `SELECT id, role_id FROM invitations WHERE email = 'lead@team.example'`);
  assert.equal(inv.role_id, "customer_admin");
  assert.equal((await admin.post("/portal/team", { email: "lead@team.example" })).status, 422);
  const otherAdmin = await t.client().login(other.email);
  assert.equal((await otherAdmin.post(`/portal/team/invitations/${inv.id}/revoke`)).status, 404, "cannot revoke another organization's invitation");
  assert.equal((await admin.post(`/portal/team/invitations/${inv.id}/revoke`)).status, 303);
  assert.doesNotMatch(await (await admin.get("/portal/team")).text(), /lead@team\.example/);

  // Role changes: never self, never the last admin; scoped to the organization.
  assert.equal((await admin.post(`/portal/team/members/${owner.id}/role`, { role: "customer_member" })).status, 409);
  assert.equal((await admin.post(`/portal/team/members/${outsiderId}/role`, { role: "customer_admin" })).status, 404);
  assert.equal((await admin.post(`/portal/team/members/${memberId}/role`, { role: "customer_admin" })).status, 303);
  assert.equal((await one<{ role_id: string }>(t.db, `SELECT role_id FROM memberships WHERE user_id = ?`, memberId)).role_id, "customer_admin");
  // Now two admins: the promoted member may demote the original admin, but not leave the org without one.
  const mate2 = await t.client().login("mate@team.example");
  assert.equal((await mate2.post(`/portal/team/members/${owner.id}/role`, { role: "customer_member" })).status, 303);
  assert.equal((await admin.post(`/portal/team/members/${memberId}/remove`)).status, 403, "the demoted user is no longer an admin");
  assert.equal((await mate2.post(`/portal/team/members/${memberId}/remove`)).status, 409, "cannot remove yourself");

  // Removal revokes access and sessions immediately.
  assert.equal((await mate2.post(`/portal/team/members/${owner.id}/remove`)).status, 303);
  assert.equal((await admin.get("/portal")).status, 303, "the removed member is signed out");
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND organization_id = ?`, owner.id, owner.organizationId)).n, 0);
  for (const a of ["customer.member_role_changed", "customer.member_removed", "customer.invitation_revoked"]) assert.ok((await one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?`, a)).n >= 1, a);
  assert.ok(await one(t.db, `SELECT 1 AS ok FROM memberships WHERE user_id = ?`, outsiderId), "other organizations are untouched");
});

test("[PORTAL-001] maintenance view shows the org's plan with entitlements labelled as proposed, sites under care and maintenance requests — scoped to the organization", async () => {
  const t = await createTestApp();
  const cust = await createCustomer(t.db, "care@maint.example", "Care Co");
  const other = await createCustomer(t.db, "other@maint.example", "Other Co");
  const c = await t.client().login(cust.email);
  const none = await (await c.get("/portal/maintenance")).text();
  assert.match(none, /No active maintenance plan/);
  assert.match(none, /href="\/hosting-maintenance"/);

  await t.db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, status, current_period_end, created_at, updated_at) VALUES (?,?, 'professional', 'active', '2026-11-30T00:00:00.000Z', ?, ?)`).bind(newId("sub"), cust.organizationId, nowIso(), nowIso()).run();
  const pid = newId("prj");
  await t.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, live_url, completed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(pid, cust.organizationId, "Care Co site", "maintenance", 3, "upfront", "https://care.example", "2026-10-01T00:00:00.000Z", nowIso(), nowIso()).run();
  await t.db.prepare(`INSERT INTO tickets (id, organization_id, subject, category, priority, status, opened_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind("tk_care", cust.organizationId, "Update opening hours", "content_change", "normal", "open", cust.id, nowIso(), nowIso()).run();
  await t.db.prepare(`INSERT INTO tickets (id, organization_id, subject, category, priority, status, opened_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind("tk_other", other.organizationId, "Other org secret request", "content_change", "normal", "open", other.id, nowIso(), nowIso()).run();

  const page = await (await c.get("/portal/maintenance")).text();
  assert.match(page, /Professional plan/);
  assert.match(page, /awaiting Founder approval/);
  assert.match(page, /Up to 2\.5 hours\/month maintenance labor/);
  assert.match(page, /https:\/\/care\.example/);
  assert.match(page, /Update opening hours/);
  assert.doesNotMatch(page, /Other org secret request/);
  assert.match(page, /Content changes this month<\/div><div class="kpi__value">1/);
  assert.match(page, /href="\/portal\/support\/new\?category=content_change"/);
  const form = await (await c.get("/portal/support/new?category=content_change")).text();
  assert.match(form, /<option value="content_change" selected/);
  const staff = await createStaff(t.db, "support");
  assert.equal((await (await t.client().login(staff.email, TEST_PASSWORD, staff.secret)).get("/portal/maintenance")).status, 403);
});
