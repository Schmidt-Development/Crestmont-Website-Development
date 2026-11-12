// Website Delivery tab: externally hosted websites on existing customer projects, end to end through the real
// request pipeline (sessions, CSRF, permissions, portal) on real migrations.
//
// The workflow under test is the Founder's: staff open Website Delivery, choose an existing customer and project,
// paste a hosted HTTPS address and Save & Share; the customer opens their existing project, clicks View Website,
// and approves or asks for changes; staff see that decision. No AI builder is involved anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestApp, createStaff, createCustomer, lastEmail, type TestClient } from "./support/app.ts";
import { validateExternalUrl } from "../src/domain/external-url.ts";
import * as WD from "../src/services/website-delivery.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import { staffNav } from "../src/routes/nav.ts";

type App = Awaited<ReturnType<typeof createTestApp>>;

async function project(t: App, orgId: string, name: string, status = "development"): Promise<string> {
  const id = newId("prj");
  const at = nowIso();
  await t.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at)
    VALUES (?, ?, ?, ?, 2, 'upfront', ?, ?)`).bind(id, orgId, name, status, at, at).run();
  return id;
}

async function world() {
  // A preview secret, so an AI-build delivery can mint its signed capability exactly as staging does.
  const t = await createTestApp({ BUILD_PREVIEW_FILE_SECRET: "test-preview-secret-0123456789abcdef" } as never);
  const owner = await createStaff(t.db, "owner", "owner@crestmont.test", "Olive Owner");
  const pm = await createStaff(t.db, "project_manager", "pm@crestmont.test", "Pat Manager");
  const a = await createCustomer(t.db, "alice@harbor.example", "Harbor Dental");
  const b = await createCustomer(t.db, "bob@lakeside.example", "Lakeside Law");
  const projectA = await project(t, a.organizationId, "Harbor Dental website");
  const projectB = await project(t, b.organizationId, "Lakeside Law website");
  const staff = await t.client().login(owner.email);
  const custA = await t.client().login(a.email);
  const custB = await t.client().login(b.email);
  return { t, owner, pm, a, b, projectA, projectB, staff, custA, custB };
}

const loc = (r: Response) => r.headers.get("location") ?? "";
const flash = (r: Response) => {
  // The last non-empty flash cookie: a response may first clear the previous page's flash, then set its own.
  const c = r.headers.getSetCookie().filter((x) => x.startsWith("cm_flash=") && !x.startsWith("cm_flash=;")).at(-1);
  if (!c) return null;
  try { return JSON.parse(decodeURIComponent(c.slice("cm_flash=".length).split(";")[0])) as { kind: string; text: string }; } catch { return null; }
};
const rows = async (t: App, projectId: string) =>
  (await t.db.prepare(`SELECT * FROM website_deliveries WHERE project_id = ? ORDER BY version`).bind(projectId).all<WD.DeliveryRow>()).results;

async function addWebsite(c: TestClient, o: { org: string; project: string; url: string; name?: string; share: boolean; note?: string }) {
  return c.post("/staff/website-delivery", {
    organizationId: o.org, projectId: o.project, websiteName: o.name ?? "Harbor Dental website", websiteUrl: o.url,
    note: o.note ?? "", intent: o.share ? "share" : "draft",
  });
}

test("[WDX-01] external URL validation: https public websites only", () => {
  for (const ok of ["https://customer-website.pages.dev", "https://customer-website.vercel.app/", "https://customer-domain.com/about?x=1#top",
    "https://www.example.com", "https://sub.domain.co.uk:443/path", "https://xn--bcher-kva.example.org"]) {
    const r = validateExternalUrl(ok);
    assert.ok(r.ok, `${ok} should be accepted: ${!r.ok ? r.error : ""}`);
  }
  const bad: [string, RegExp][] = [
    ["", /full address/], ["customer-domain.com", /https:\/\//], ["http://customer-domain.com", /secure https/],
    ["javascript:alert(1)", /secure https/], ["data:text/html,hi", /secure https/], ["ftp://files.example.com", /secure https/],
    ["https://user:pass@customer-domain.com", /username or password/], ["https://user@customer-domain.com", /username or password/],
    ["https://localhost", /public website domain|private/], ["https://localhost:8443", /port/], ["https://app.localhost", /private or internal/],
    ["https://127.0.0.1", /IP address/], ["https://10.0.0.5", /IP address/], ["https://192.168.1.1", /IP address/], ["https://169.254.169.254/latest", /IP address/],
    ["https://0x7f000001", /IP address/], ["https://2130706433", /IP address/], ["https://[::1]", /IP address/], ["https://[::ffff:10.0.0.1]", /IP address/],
    ["https://printer.local", /private or internal/], ["https://db.internal", /private or internal/], ["https://site.test", /private or internal/],
    ["https://intranet", /public website domain/], ["https://exa mple.com", /spaces/], ["https://bad_host.com", /not valid/],
    ["https://customer-domain.com:8080", /port/], ["https://" + "a".repeat(2050) + ".com", /too long/], ["https://-bad.com", /not valid/],
  ];
  for (const [u, why] of bad) {
    const r = validateExternalUrl(u);
    assert.equal(r.ok, false, `${u} must be rejected`);
    assert.match(!r.ok ? r.error : "", why, `${u}: ${!r.ok ? r.error : ""}`);
  }
  // Normalised, so what is stored is exactly what the browser will open.
  const n = validateExternalUrl("  HTTPS://Customer-Domain.COM/Page  ");
  assert.ok(n.ok);
  assert.equal(n.ok && n.url, "https://customer-domain.com/Page");
});

test("[WDX-02] Website Delivery is its own Staff Dashboard tab, visible and usable only by authorized staff", async () => {
  const w = await world();
  try {
    // Its own navigation entry at /staff/website-delivery, not inside the AI section.
    const groups = staffNav({} as never);
    const entry = groups.flatMap((g) => g.items.map((i) => ({ group: g.label, ...i }))).find((i) => i.href === "/staff/website-delivery");
    assert.ok(entry, "the navigation has a Website Delivery entry");
    assert.equal(entry.label, "Website Delivery");
    assert.equal(entry.group, "Delivery", "it sits with Customer Projects, not buried in AI Builds");

    const home = await (await w.staff.get("/staff")).text();
    assert.match(home, /href="\/staff\/website-delivery"[^>]*>(<span>)?Website Delivery</, "the owner sees the tab");
    const page = await w.staff.get("/staff/website-delivery");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<h1>Website Delivery<\/h1>/);
    assert.match(html, /\+ Add Website/);

    // Project managers and administrators may use it too.
    for (const role of ["project_manager", "administrator"] as const) {
      const s = await createStaff(w.t.db, role, `${role}2@crestmont.test`);
      const c = await w.t.client().login(s.email);
      assert.equal((await c.get("/staff/website-delivery")).status, 200, `${role} may open it`);
    }
    // Other staff roles see neither the tab nor the page, and cannot act.
    for (const role of ["sales", "developer", "support"] as const) {
      const s = await createStaff(w.t.db, role, `${role}2@crestmont.test`);
      const c = await w.t.client().login(s.email);
      assert.doesNotMatch(await (await c.get("/staff")).text(), /href="\/staff\/website-delivery"/, `${role} has no tab`);
      assert.equal((await c.get("/staff/website-delivery")).status, 403, `${role} is refused the page`);
      const r = await addWebsite(c, { org: w.a.organizationId, project: w.projectA, url: "https://harbor-dental.pages.dev", share: true });
      assert.equal(r.status, 403, `${role} is refused the action`);
    }
    assert.equal((await rows(w.t, w.projectA)).length, 0, "and nothing was created by a refused request");

    // Customers and anonymous visitors cannot reach any of it.
    assert.equal((await w.custA.get("/staff/website-delivery")).status, 403);
    const anon = await w.t.client().get("/staff/website-delivery");
    assert.equal(anon.status, 303);
    assert.match(loc(anon), /^\/login/);

    // It works with the AI builders switched off entirely: no build tables are read on this path.
    await w.t.db.prepare(`DELETE FROM build_jobs`).run();
    assert.equal((await w.staff.get("/staff/website-delivery/new")).status, 200);
  } finally { w.t.close(); }
});

test("[WDX-03] staff add a hosted website as a draft, share it, and the right customer opens the exact URL", async () => {
  const w = await world();
  try {
    // Step 1: search and select the EXISTING customer. Crestmont's internal organisation is never offered.
    const search = await (await w.staff.get("/staff/website-delivery/new?q=harbor")).text();
    assert.match(search, /Harbor Dental/);
    assert.doesNotMatch(search, /Lakeside Law/);
    assert.doesNotMatch(search, new RegExp(`org=${w.owner.organizationId}`), "Crestmont's internal organisation is not offered");
    // Step 2: that customer's own projects only.
    const form = await (await w.staff.get(`/staff/website-delivery/new?org=${w.a.organizationId}`)).text();
    assert.match(form, new RegExp(`value="${w.projectA}"`));
    assert.doesNotMatch(form, new RegExp(w.projectB), "another customer's project is not offered");
    for (const label of ["Website name", "Website URL", "Internal notes", "Save Draft", "Save &amp; Share with Customer", "Cancel"]) assert.match(form, new RegExp(label));

    // Starting from a known project preselects its own customer and the project; another customer's org is not implied.
    const pre = await (await w.staff.get(`/staff/website-delivery/new?project=${w.projectA}`)).text();
    assert.match(pre, /<strong>Harbor Dental<\/strong>/);
    assert.match(pre, new RegExp(`<option value="${w.projectA}" selected>`));

    // Save Draft: version 1, staff only. No build, artifact, revision or contract is involved.
    const url = "https://harbor-dental.pages.dev/";
    const res = await addWebsite(w.staff, { org: w.a.organizationId, project: w.projectA, url, share: false, note: "STAFF-ONLY-NOTE paid in full" });
    assert.equal(res.status, 303, await res.text());
    const [v1] = await rows(w.t, w.projectA);
    assert.equal(v1.source, "external_url");
    assert.equal(v1.version, 1);
    assert.equal(v1.website_url, url);
    assert.equal(v1.organization_id, w.a.organizationId, "the customer is read from the project");
    assert.equal(v1.job_id, null);
    assert.equal(v1.revision_attempt, null);
    assert.equal(v1.artifact_id, null);
    assert.equal(v1.visible_at, null, "a draft is not visible");
    assert.equal(v1.assigned_by, w.owner.id);
    assert.equal(loc(res), `/staff/website-delivery/${v1.id}`);
    assert.equal((await w.t.db.prepare(`SELECT COUNT(*) AS n FROM projects`).first<{ n: number }>())!.n, 2, "no project was created");
    assert.equal((await w.t.db.prepare(`SELECT COUNT(*) AS n FROM organizations WHERE kind = 'customer'`).first<{ n: number }>())!.n, 2, "no customer was created");

    // The draft is not in the portal.
    assert.doesNotMatch(await (await w.custA.get(`/portal/projects/${w.projectA}`)).text(), /Your website/);

    // The dashboard lists it with every column.
    const dash = await (await w.staff.get("/staff/website-delivery")).text();
    for (const s of ["Harbor Dental", "Harbor Dental website", "harbor-dental.pages.dev", "v1", "Draft", "Not shared yet", "Olive Owner"]) assert.match(dash, new RegExp(s), s);

    // Share it.
    const shared = await w.staff.post(`/staff/website-delivery/${v1.id}/share`, {});
    assert.equal(shared.status, 303);
    assert.ok((await WD.byId(w.t.db, v1.id))!.visible_at);
    const audit = await w.t.db.prepare(`SELECT action FROM audit_logs WHERE subject_id = ? AND action LIKE 'website_delivery.%' ORDER BY id`).bind(w.projectA).all<{ action: string }>();
    assert.deepEqual(audit.results.map((r) => r.action), ["website_delivery.created", "website_delivery.made_visible"]);
    // The customer is told by email (and in the portal) that the website is ready for review — once.
    const told = await lastEmail(w.t.db, w.a.email);
    assert.equal(told?.template, "project_update");
    assert.match(told!.text_body, /\/portal\/projects\//);
    await w.staff.post(`/staff/website-delivery/${v1.id}/share`, {});
    assert.equal((await w.t.db.prepare(`SELECT COUNT(*) AS n FROM email_deliveries WHERE to_email = ? AND template = 'project_update'`).bind(w.a.email).first<{ n: number }>())!.n, 1, "sharing again sends nothing");
    assert.equal((await w.t.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND subject_id = ?`).bind(w.a.id, w.projectA).first<{ n: number }>())!.n, 1, "one portal notice");

    // The customer sees it on their EXISTING project page, with a View Website link to the exact URL, in a new tab.
    const portal = await (await w.custA.get(`/portal/projects/${w.projectA}`)).text();
    assert.match(portal, /Your website/);
    assert.match(portal, /Harbor Dental website/);
    assert.match(portal, /Version 1/);
    assert.match(portal, /Date shared/);
    assert.match(portal, /Last updated/);
    const link = /<a[^>]*data-website-link[^>]*>View website<\/a>/.exec(portal)?.[0] ?? "";
    assert.ok(link, "a View website link is rendered");
    assert.match(link, /href="https:\/\/harbor-dental\.pages\.dev\/"/, "it opens the stored address exactly");
    assert.match(link, /target="_blank"/);
    assert.match(link, /rel="noopener noreferrer"/);
    assert.doesNotMatch(portal, /<iframe/i, "never framed");
    assert.doesNotMatch(portal, /build-preview/, "never proxied through Crestmont");
    assert.match(portal, /Approve Website/);
    assert.match(portal, /Request Changes/);
    // Staff-only notes never reach the customer.
    assert.doesNotMatch(portal, /STAFF-ONLY-NOTE/);

    // The other customer sees nothing of it.
    assert.doesNotMatch(await (await w.custB.get(`/portal/projects/${w.projectB}`)).text(), /harbor-dental|Your website/);
  } finally { w.t.close(); }
});

test("[WDX-04] invalid input is refused with understandable errors and creates nothing", async () => {
  const w = await world();
  try {
    const cases: [Record<string, string>, RegExp][] = [
      [{ websiteUrl: "http://harbor-dental.pages.dev" }, /secure https/],
      [{ websiteUrl: "https://admin:secret@harbor-dental.pages.dev" }, /username or password/],
      [{ websiteUrl: "https://localhost" }, /public website domain|private/],
      [{ websiteUrl: "https://10.1.2.3" }, /IP address/],
      [{ websiteUrl: "javascript:alert(document.cookie)" }, /secure https/],
      [{ websiteUrl: "not a url" }, /spaces|https/],
      [{ websiteName: "" }, /Give the website a name/],
      [{ projectId: "" }, /Choose the customer/],
      // Project ownership: customer B's project submitted under customer A.
      [{ projectId: "PROJECT_B" }, /does not belong to this customer/],
    ];
    for (const [over, why] of cases) {
      const fields = { organizationId: w.a.organizationId, projectId: w.projectA, websiteName: "Harbor", websiteUrl: "https://harbor-dental.pages.dev", intent: "share", ...over };
      if (fields.projectId === "PROJECT_B") fields.projectId = w.projectB;
      const r = await w.staff.post("/staff/website-delivery", fields);
      assert.equal(r.status, 422, JSON.stringify(over));
      const body = await r.text();
      assert.match(body.replace(/&#39;|&quot;/g, "'"), why, `${JSON.stringify(over)} -> ${why}`);
    }
    // A cancelled project, an internal Crestmont project, and an unknown customer are all refused.
    const cancelled = await project(w.t, w.a.organizationId, "Old project", "cancelled");
    assert.equal((await addWebsite(w.staff, { org: w.a.organizationId, project: cancelled, url: "https://harbor-dental.pages.dev", share: true })).status, 422);
    assert.equal((await addWebsite(w.staff, { org: w.owner.organizationId, project: w.projectA, url: "https://harbor-dental.pages.dev", share: true })).status, 422);
    assert.equal((await addWebsite(w.staff, { org: "org_nope", project: w.projectA, url: "https://harbor-dental.pages.dev", share: true })).status, 422);
    // CSRF: a forged cross-site form post does nothing.
    const forged = await w.staff.post("/staff/website-delivery", { organizationId: w.a.organizationId, projectId: w.projectA, websiteName: "x", websiteUrl: "https://harbor-dental.pages.dev", intent: "share" }, { csrf: false });
    assert.equal(forged.status, 403);
    assert.equal((await w.t.db.prepare(`SELECT COUNT(*) AS n FROM website_deliveries`).first<{ n: number }>())!.n, 0, "nothing was stored");
    // The database refuses an external row that is not https, whatever the application does.
    await assert.rejects(w.t.db.prepare(`INSERT INTO website_deliveries (id, project_id, organization_id, source, version, website_name, website_url, status, assigned_by, assigned_at, created_at, updated_at)
      VALUES ('wdl_x', ?, ?, 'external_url', 1, 'x', 'http://x.com', 'assigned', ?, ?, ?, ?)`).bind(w.projectA, w.a.organizationId, w.owner.id, nowIso(), nowIso(), nowIso()).run());
  } finally { w.t.close(); }
});

test("[WDX-05] the customer approves or requests changes; staff see the decision and the feedback", async () => {
  const w = await world();
  try {
    await addWebsite(w.staff, { org: w.a.organizationId, project: w.projectA, url: "https://harbor-dental.pages.dev", share: true });
    const [v1] = await rows(w.t, w.projectA);

    // "Request changes" needs written feedback.
    const empty = await w.custA.post(`/portal/projects/${w.projectA}/website/decision`, { decision: "revision_requested", note: "  " });
    assert.equal(empty.status, 303);
    assert.equal(flash(empty)?.kind, "error");
    assert.match(flash(empty)!.text, /describe the changes/);
    assert.equal((await WD.byId(w.t.db, v1.id))!.customer_decision, null);

    const asked = await w.custA.post(`/portal/projects/${w.projectA}/website/decision`, { decision: "revision_requested", note: "Please use the new logo on the home page" });
    assert.equal(asked.status, 303);
    assert.equal(flash(asked)?.kind, "success", JSON.stringify(flash(asked)));
    const d = (await WD.byId(w.t.db, v1.id))!;
    assert.equal(d.customer_decision, "revision_requested");
    assert.equal(d.customer_note, "Please use the new logo on the home page");
    assert.equal(d.customer_decided_by, w.a.id, "attributed to the customer who decided");
    assert.equal(d.version, 1, "against the right version");
    const said = await w.t.db.prepare(`SELECT actor_user_id FROM audit_logs WHERE action = 'website_delivery.customer_decision' AND subject_id = ?`).bind(w.projectA).first<{ actor_user_id: string }>();
    assert.equal(said?.actor_user_id, w.a.id);
    // "Your project team has been told" is true: the team (the Owner/PM fallback here) gets the decision by email.
    const team = await lastEmail(w.t.db, w.owner.email);
    assert.equal(team?.template, "project_update");
    assert.match(team!.text_body, /Please use the new logo on the home page|changes/i);

    // A decision on a version is not silently overwritten.
    const again = await w.custA.post(`/portal/projects/${w.projectA}/website/decision`, { decision: "approved" });
    assert.equal(flash(again)?.kind, "error");
    assert.equal((await WD.byId(w.t.db, v1.id))!.customer_decision, "revision_requested");

    // Staff see it, on the dashboard and on the delivery's page, with the feedback.
    const dash = await (await w.staff.get("/staff/website-delivery?approval=revision_requested")).text();
    assert.match(dash, /Harbor Dental website/);
    assert.match(dash, /Changes requested/);
    const detail = await (await w.staff.get(`/staff/website-delivery/${v1.id}`)).text();
    assert.match(detail, /The customer asked for changes/);
    assert.match(detail, /Please use the new logo on the home page/);
    assert.match(detail, /Pat Customer/);
    // The filters narrow correctly.
    assert.doesNotMatch(await (await w.staff.get("/staff/website-delivery?approval=approved")).text(), /harbor-dental\.pages\.dev/);
  } finally { w.t.close(); }
});

test("[WDX-06] versions: replacing adds a version with its own approval; history is kept; restoring makes a new version", async () => {
  const w = await world();
  try {
    await addWebsite(w.staff, { org: w.a.organizationId, project: w.projectA, url: "https://harbor-v1.pages.dev", share: true, note: "first cut" });
    const [v1] = await rows(w.t, w.projectA);
    await w.custA.post(`/portal/projects/${w.projectA}/website/decision`, { decision: "approved" });
    const v1Before = (await WD.byId(w.t.db, v1.id))!;
    assert.equal(v1Before.customer_decision, "approved");

    // Replace with a revised URL and share it.
    const rep = await w.staff.post(`/staff/website-delivery/${v1.id}/replace`, { websiteUrl: "https://harbor-v2.vercel.app", websiteName: "Harbor Dental website", note: "logo fixed", intent: "share" });
    assert.equal(rep.status, 303);
    const all = await rows(w.t, w.projectA);
    assert.equal(all.length, 2);
    const v2 = all[1];
    assert.equal(v2.version, 2);
    assert.equal(v2.website_url, "https://harbor-v2.vercel.app/");
    assert.equal(v2.customer_decision, null, "approval of version 1 does not approve version 2");
    assert.ok(v2.visible_at);
    // Version 1 is history, untouched apart from being superseded.
    const v1After = (await WD.byId(w.t.db, v1.id))!;
    assert.equal(v1After.website_url, "https://harbor-v1.pages.dev/");
    assert.equal(v1After.customer_decision, "approved");
    assert.equal(v1After.note, "first cut");
    assert.equal(v1After.superseded_by, v2.id);
    assert.equal(v1After.status, "superseded");

    // The customer now sees version 2, and is asked to decide again.
    const portal = await (await w.custA.get(`/portal/projects/${w.projectA}`)).text();
    assert.match(portal, /href="https:\/\/harbor-v2\.vercel\.app\/"/);
    assert.doesNotMatch(portal, /harbor-v1/);
    assert.match(portal, /Version 2/);
    assert.match(portal, /Approve Website/);

    // Editing details changes the current version only, and never its address.
    const ed = await w.staff.post(`/staff/website-delivery/${v2.id}/edit`, { websiteName: "Harbor Dental — final", assignedTo: w.pm.id, note: "assigned to Pat" });
    assert.equal(ed.status, 303);
    const v2e = (await WD.byId(w.t.db, v2.id))!;
    assert.equal(v2e.website_name, "Harbor Dental — final");
    assert.equal(v2e.assigned_to, w.pm.id);
    assert.equal(v2e.website_url, "https://harbor-v2.vercel.app/");
    assert.equal((await w.staff.post(`/staff/website-delivery/${v1.id}/edit`, { websiteName: "rewrite history" })).status, 303);
    assert.equal((await WD.byId(w.t.db, v1.id))!.website_name, "Harbor Dental website", "a historical version is not edited");
    assert.equal(flash(await w.staff.post(`/staff/website-delivery/${v1.id}/replace`, { websiteUrl: "https://x.pages.dev", intent: "share" }))?.kind, "error", "only the current version is replaced");
    // Assigning a non-staff user is refused.
    assert.equal(flash(await w.staff.post(`/staff/website-delivery/${v2.id}/edit`, { assignedTo: w.a.id }))?.kind, "error");

    // The history page shows every version with its own decision and notes.
    const detail = await (await w.staff.get(`/staff/website-delivery/${v2.id}`)).text();
    assert.match(detail, /Version history/);
    assert.match(detail, /harbor-v1\.pages\.dev/);
    assert.match(detail, /harbor-v2\.vercel\.app/);
    assert.match(detail, /first cut/);
    assert.match(detail, /Restore as draft/);

    // Restore version 1 and share it: a NEW version 3 with version 1's address and no decision.
    const back = await w.staff.post(`/staff/website-delivery/${v1.id}/restore`, { share: "yes" });
    assert.equal(back.status, 303);
    const v3 = (await rows(w.t, w.projectA))[2];
    assert.equal(v3.version, 3);
    assert.equal(v3.website_url, "https://harbor-v1.pages.dev/");
    assert.equal(v3.restored_from, v1.id);
    assert.equal(v3.customer_decision, null);
    assert.ok(v3.visible_at);
    assert.equal((await WD.byId(w.t.db, v1.id))!.customer_decision, "approved", "the old row keeps its own decision");
    assert.match(await (await w.custA.get(`/portal/projects/${w.projectA}`)).text(), /href="https:\/\/harbor-v1\.pages\.dev\/"/);

    // Every step was audited.
    const actions = (await w.t.db.prepare(`SELECT action FROM audit_logs WHERE subject_id = ? AND action LIKE 'website_delivery.%' ORDER BY id`).bind(w.projectA).all<{ action: string }>()).results.map((r) => r.action);
    assert.deepEqual(actions, ["website_delivery.created", "website_delivery.customer_decision", "website_delivery.replaced", "website_delivery.updated", "website_delivery.rolled_back"]);
  } finally { w.t.close(); }
});

test("[WDX-07] archive withdraws the website from the customer and keeps it restorable", async () => {
  const w = await world();
  try {
    await addWebsite(w.staff, { org: w.a.organizationId, project: w.projectA, url: "https://harbor-dental.pages.dev", share: true });
    const [v1] = await rows(w.t, w.projectA);
    const ar = await w.staff.post(`/staff/website-delivery/${v1.id}/archive`, { back: "list" });
    assert.equal(ar.status, 303);
    assert.equal(loc(ar), "/staff/website-delivery");
    const d = (await WD.byId(w.t.db, v1.id))!;
    assert.equal(d.status, "archived");
    assert.ok(d.archived_at && d.superseded_at);
    assert.doesNotMatch(await (await w.custA.get(`/portal/projects/${w.projectA}`)).text(), /Your website/);
    assert.match(await (await w.staff.get("/staff/website-delivery?status=archived")).text(), /harbor-dental\.pages\.dev/);
    assert.doesNotMatch(await (await w.staff.get("/staff/website-delivery?status=shared")).text(), /harbor-dental\.pages\.dev/);
    assert.equal(flash(await w.staff.post(`/staff/website-delivery/${v1.id}/archive`, {}))?.kind, "error", "archiving twice is refused");

    // A new website can be added to the same project afterwards: it is version 2.
    await addWebsite(w.staff, { org: w.a.organizationId, project: w.projectA, url: "https://harbor-new.pages.dev", share: false });
    assert.deepEqual((await rows(w.t, w.projectA)).map((r) => r.version), [1, 2]);
  } finally { w.t.close(); }
});

test("[WDX-08] customers are isolated from each other and from every management endpoint", async () => {
  const w = await world();
  try {
    await addWebsite(w.staff, { org: w.a.organizationId, project: w.projectA, url: "https://harbor-secret.pages.dev", share: true, note: "INTERNAL" });
    const [v1] = await rows(w.t, w.projectA);

    // Customer B can neither open A's project nor decide on A's website.
    const view = await w.custB.get(`/portal/projects/${w.projectA}`);
    assert.equal(view.status, 404);
    assert.doesNotMatch(await view.text(), /harbor-secret/);
    const dec = await w.custB.post(`/portal/projects/${w.projectA}/website/decision`, { decision: "approved" });
    assert.equal(dec.status, 404);
    assert.equal((await WD.byId(w.t.db, v1.id))!.customer_decision, null);
    // B's own portal pages never include A's URL.
    for (const path of ["/portal", "/portal/projects", `/portal/projects/${w.projectB}`]) {
      assert.doesNotMatch(await (await w.custB.get(path)).text(), /harbor-secret/, path);
    }

    // No customer can reach a staff endpoint, or change the stored URL by any route.
    const before = JSON.stringify(await rows(w.t, w.projectA));
    for (const [path, fields] of [
      ["/staff/website-delivery", { organizationId: w.a.organizationId, projectId: w.projectA, websiteName: "x", websiteUrl: "https://evil.example.com", intent: "share" }],
      [`/staff/website-delivery/${v1.id}/replace`, { websiteUrl: "https://evil.example.com", intent: "share" }],
      [`/staff/website-delivery/${v1.id}/edit`, { websiteName: "pwned" }],
      [`/staff/website-delivery/${v1.id}/share`, {}],
      [`/staff/website-delivery/${v1.id}/archive`, {}],
      [`/staff/website-delivery/${v1.id}/restore`, { share: "yes" }],
    ] as const) {
      for (const c of [w.custA, w.custB]) assert.equal((await c.post(path, fields as Record<string, string>)).status, 403, path);
    }
    for (const path of ["/staff/website-delivery", `/staff/website-delivery/${v1.id}`, "/staff/website-delivery/new"]) {
      assert.equal((await w.custA.get(path)).status, 403, path);
    }
    assert.equal(JSON.stringify(await rows(w.t, w.projectA)), before, "nothing changed");
    // The portal decision form cannot carry a URL either: extra fields are ignored.
    await w.custA.post(`/portal/projects/${w.projectA}/website/decision`, { decision: "approved", website_url: "https://evil.example.com", websiteUrl: "https://evil.example.com" });
    assert.equal((await WD.byId(w.t.db, v1.id))!.website_url, "https://harbor-secret.pages.dev/");
    // An unknown delivery id is a 404, not an error page.
    assert.equal((await w.staff.get("/staff/website-delivery/wdl_doesnotexist")).status, 404);
  } finally { w.t.close(); }
});

test("[WDX-09] AI-build delivery keeps working beside external websites (regression)", async () => {
  const w = await world();
  try {
    // A finished AI build assigned the existing way, through the build's own deliver page.
    const made = await (await import("../src/services/design-locked.ts")).createTestProject(w.t.db, { name: "Builder project", actorId: w.owner.id });
    const jobId = newId("bld");
    const at = nowIso();
    await w.t.db.prepare(`INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, strategy, package_id, trigger, created_at, updated_at)
      VALUES (?, ?, ?, 'first_build', 0, ?, 'ready_for_review', 'standard', 'business', 'sweep', ?, ?)`).bind(jobId, made.projectId, made.organizationId, `${made.projectId}:first`, at, at).run();
    await w.t.db.prepare(`INSERT INTO build_revisions (id, job_id, project_id, cycle, attempt, phase, score, decision, is_best, reverted, file_count, total_bytes, created_at)
      VALUES (?, ?, ?, 0, 1, 'build', 9, 'ACCEPT', 1, 0, 1, 80, ?)`).bind(newId("brev"), jobId, made.projectId, at).run();
    const res = await w.staff.post(`/staff/builds/${jobId}/deliver`, { projectId: w.projectB, visible: "yes" });
    assert.equal(res.status, 303, await res.text());
    const [ai] = await rows(w.t, w.projectB);
    assert.equal(ai.source, "ai_build");
    assert.equal(ai.version, 1);
    assert.equal(ai.job_id, jobId);

    // The customer still opens it through the signed build-preview capability, not an external link.
    const portal = await (await w.custB.get(`/portal/projects/${w.projectB}`)).text();
    assert.match(portal, new RegExp(`href="/build-preview/${jobId}/1-0/[^"]+/"`));
    // And it is listed in Website Delivery beside external websites, where staff can archive and restore it.
    await addWebsite(w.staff, { org: w.a.organizationId, project: w.projectA, url: "https://harbor-dental.pages.dev", share: true });
    const dash = await (await w.staff.get("/staff/website-delivery")).text();
    assert.match(dash, /AI build preview/);
    assert.match(dash, /harbor-dental\.pages\.dev/);
    assert.equal((await w.staff.post(`/staff/website-delivery/${ai.id}/archive`, {})).status, 303);
    assert.equal((await w.staff.post(`/staff/website-delivery/${ai.id}/restore`, { share: "yes" })).status, 303);
    const after = await rows(w.t, w.projectB);
    assert.deepEqual(after.map((r) => [r.version, r.source, r.job_id]), [[1, "ai_build", jobId], [2, "ai_build", jobId]]);
    assert.match(await (await w.custB.get(`/portal/projects/${w.projectB}`)).text(), /\/build-preview\//);
    // The old rollback route still works too.
    await w.staff.post(`/staff/website-delivery/${after[1].id}/replace`, { websiteUrl: "https://lakeside-law.pages.dev", websiteName: "Lakeside", intent: "share" });
    const rb = await w.staff.post(`/staff/projects/${w.projectB}/deliver/rollback`, { deliveryId: after[1].id });
    assert.equal(rb.status, 303);
    assert.deepEqual((await rows(w.t, w.projectB)).map((r) => r.source), ["ai_build", "ai_build", "external_url", "ai_build"]);
  } finally { w.t.close(); }
});

test("[WDX-10] migration 0097 keeps every existing delivery and its behaviour", () => {
  const dir = join(import.meta.dirname, "../migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const apply = (f: string) => { db.exec("BEGIN"); db.exec(readFileSync(join(dir, f), "utf8")); db.exec("COMMIT"); };
  for (const f of files.filter((f) => f < "0097")) apply(f);

  // Legacy rows exactly as 0096 stored them: a project with a superseded and a live delivery, and a rollback chain.
  const now = "2026-11-01T00:00:00.000Z";
  db.exec(`INSERT INTO organizations (id, name, kind, created_at) VALUES ('org_c','Harbor','customer','${now}'), ('org_i','Crestmont','internal','${now}');
    INSERT INTO users (id, email, display_name, created_at) VALUES ('usr_s','s@crestmont.test','Staff','${now}');
    INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES
      ('prj_c','org_c','Site','development',2,'upfront','${now}','${now}'), ('prj_i','org_i','Builder','development',2,'upfront','${now}','${now}');
    INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, strategy, package_id, trigger, created_at, updated_at)
      VALUES ('bld_1','prj_i','org_i','first_build',0,'k','ready_for_review','standard','business','sweep','${now}','${now}');
    INSERT INTO website_deliveries (id, project_id, organization_id, job_id, source_project_id, revision_attempt, revision_cycle, status, assigned_by, assigned_at, visible_at, visible_by, customer_reviewed_at, customer_decision, customer_note, superseded_by, superseded_at, note, created_at)
      VALUES ('wdl_b','prj_c','org_c','bld_1','prj_i',2,0,'customer_visible','usr_s','2026-11-03T00:00:00.000Z','2026-11-03T01:00:00.000Z','usr_s',NULL,NULL,NULL,NULL,NULL,NULL,'2026-11-03T00:00:00.000Z');
    INSERT INTO website_deliveries (id, project_id, organization_id, job_id, source_project_id, revision_attempt, revision_cycle, status, assigned_by, assigned_at, visible_at, visible_by, customer_reviewed_at, customer_decision, customer_note, superseded_by, superseded_at, note, created_at)
      VALUES ('wdl_a','prj_c','org_c','bld_1','prj_i',1,0,'superseded','usr_s','2026-11-02T00:00:00.000Z','2026-11-02T01:00:00.000Z','usr_s','2026-11-02T02:00:00.000Z','revision_requested','change it','wdl_b','2026-11-03T00:00:00.000Z','first','2026-11-02T00:00:00.000Z');`);
  apply("0097_website_delivery_external.sql");
  assert.deepEqual(files.filter((f) => f >= "0097").slice(0, 1), ["0097_website_delivery_external.sql"]);

  const got = db.prepare(`SELECT id, source, version, job_id, revision_attempt, status, customer_decision, customer_note, superseded_by, note, assigned_to, updated_at FROM website_deliveries ORDER BY version`).all();
  assert.deepEqual(got.map((r) => ({ ...r })), [
    { id: "wdl_a", source: "ai_build", version: 1, job_id: "bld_1", revision_attempt: 1, status: "superseded", customer_decision: "revision_requested", customer_note: "change it", superseded_by: "wdl_b", note: "first", assigned_to: "usr_s", updated_at: "2026-11-03T00:00:00.000Z" },
    { id: "wdl_b", source: "ai_build", version: 2, job_id: "bld_1", revision_attempt: 2, status: "customer_visible", customer_decision: null, customer_note: null, superseded_by: null, note: null, assigned_to: "usr_s", updated_at: "2026-11-03T01:00:00.000Z" },
  ]);
  assert.deepEqual(db.prepare(`PRAGMA foreign_key_check`).all(), [], "no dangling references after the rebuild");
  // The rules still hold: one live delivery per project, unique versions, and each source keeps to its own columns.
  const ins = (sql: string) => () => db.exec(sql);
  assert.throws(ins(`INSERT INTO website_deliveries (id, project_id, organization_id, source, version, job_id, source_project_id, revision_attempt, revision_cycle, status, assigned_by, assigned_at, created_at, updated_at)
    VALUES ('wdl_c','prj_c','org_c','ai_build',3,'bld_1','prj_i',1,0,'assigned','usr_s','${now}','${now}','${now}')`), /UNIQUE/, "a second live delivery");
  assert.throws(ins(`INSERT INTO website_deliveries (id, project_id, organization_id, source, version, website_name, website_url, status, assigned_by, assigned_at, superseded_at, created_at, updated_at)
    VALUES ('wdl_d','prj_c','org_c','external_url',2,'x','https://x.com','superseded','usr_s','${now}','${now}','${now}','${now}')`), /UNIQUE/, "a reused version number");
  assert.throws(ins(`INSERT INTO website_deliveries (id, project_id, organization_id, source, version, website_name, status, assigned_by, assigned_at, superseded_at, created_at, updated_at)
    VALUES ('wdl_e','prj_c','org_c','external_url',5,'x','superseded','usr_s','${now}','${now}','${now}','${now}')`), /CHECK/, "an external website with no URL");
  assert.throws(ins(`INSERT INTO website_deliveries (id, project_id, organization_id, source, version, website_name, website_url, job_id, source_project_id, revision_attempt, revision_cycle, status, assigned_by, assigned_at, superseded_at, created_at, updated_at)
    VALUES ('wdl_f','prj_c','org_c','external_url',6,'x','https://x.com','bld_1','prj_i',1,0,'superseded','usr_s','${now}','${now}','${now}','${now}')`), /CHECK/, "an external website pretending to be a build");
  assert.throws(ins(`INSERT INTO website_deliveries (id, project_id, organization_id, source, version, status, assigned_by, assigned_at, superseded_at, created_at, updated_at)
    VALUES ('wdl_g','prj_c','org_c','ai_build',7,'superseded','usr_s','${now}','${now}','${now}','${now}')`), /CHECK/, "an AI build with no build");
  db.close();
});
