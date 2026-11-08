// Phase 2.3 / 2.4: audit events in plain English on the Audit Logs page and the employee's Recent activity, with the
// original technical record kept (never rewritten) under Details, and filters by employee, action, date, customer or
// project, and result. TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD } from "./support/app.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import { describeAudit, resolveAuditNames } from "../src/services/audit-describe.ts";
import type { Env } from "../src/app/context.ts";

async function ev(db: Env["DB"], o: { actor?: string | null; kind?: string; action: string; type: string; id?: string | null; org?: string | null; details?: unknown; at?: string }) {
  await db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, organization_id, details_json, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(o.actor ?? null, o.kind ?? (o.actor ? "user" : "system"), o.action, o.type, o.id ?? null, o.org ?? null, o.details === undefined ? null : JSON.stringify(o.details), o.at ?? nowIso()).run();
}

test("[SEC-005] [EMP-003] audit events are described in plain English; names come only from the database; unknown events get a safe generic description", async () => {
  const t = await createTestApp({});
  const cu = await createCustomer(t.db, "a@bakery.example", "Sunrise Bakery (TEST)");
  const pid = newId("prj");
  await t.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES (?,?, 'Sunrise website', 'development', 2, 'upfront', ?, ?)`).bind(pid, cu.organizationId, nowIso(), nowIso()).run();
  const rows = [
    { action: "session.created", actor_kind: "user", actor_name: "Olive Owner", subject_type: "session", subject_id: "ses_x" },
    { action: "website_delivery.status_changed", actor_kind: "user", actor_name: "Pam Manager", subject_type: "project", subject_id: pid, organization_id: cu.organizationId },
    { action: "task.created", actor_kind: "user", actor_name: "Dev Eloper", subject_type: "task", subject_id: "tsk_1" },
    { action: "builds.site_release_failed", actor_kind: "system", subject_type: "project", subject_id: "prj_missing" },
    { action: "salesopt.cycle_run", actor_kind: "system", subject_type: "so_control", subject_id: "1" },
    { action: "zzz.quantum_flux", actor_kind: "webhook", subject_type: "thing", subject_id: "t1" },
  ];
  const names = await resolveAuditNames(t.db, rows);
  const d = rows.map((r) => describeAudit(r, names));
  assert.deepEqual([d[0].title, d[0].sentence], ["Signed in", "Olive Owner signed in to Crestmont."]);
  assert.deepEqual([d[1].title, d[1].sentence, d[1].record], ["Website delivery updated", "Pam Manager updated a customer's website delivery status.", "Project: Sunrise website"]);
  assert.deepEqual([d[2].title, d[2].sentence], ["Created task", "Dev Eloper created a task."]);
  assert.equal(d[3].outcome, "failed");
  assert.equal(d[3].record, null, "a record that no longer exists is not given an invented name");
  assert.equal(d[4].translated, false, "not confidently translatable");
  assert.equal(d[4].sentence, "The platform recorded activity on the sales script.");
  assert.deepEqual([d[5].title, d[5].sentence], ["System activity", "An automated provider event recorded a technical event."]);
});

test("[SEC-005] [EMP-003] Audit Logs: readable timeline, original record under Details, filters by employee, action, date, customer or project, and result", async () => {
  const t = await createTestApp({});
  const owner = await createStaff(t.db, "owner", "owner@crestmont.test", "Olive Owner");
  const pm = await createStaff(t.db, "project_manager", "pm@crestmont.test", "Pam Manager");
  const cu = await createCustomer(t.db, "a@bakery.example", "Sunrise Bakery (TEST)");
  const other = await createCustomer(t.db, "b@florist.example", "Petal Florist (TEST)");
  const pid = newId("prj");
  await t.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES (?,?, 'Sunrise website', 'development', 2, 'upfront', ?, ?)`).bind(pid, cu.organizationId, nowIso(), nowIso()).run();
  await ev(t.db, { actor: pm.id, action: "website_delivery.status_changed", type: "project", id: pid, org: cu.organizationId, details: { to: "delivered" } });
  await ev(t.db, { actor: pm.id, action: "ticket.staff_reply", type: "ticket", id: "tkt_1", org: other.organizationId });
  await ev(t.db, { action: "builds.site_release_failed", type: "project", id: pid, org: cu.organizationId, details: { reason: "runner offline" } });
  await ev(t.db, { actor: owner.id, action: "lead.assigned", type: "lead", id: "ld_1", at: "2001-02-03T10:00:00.000Z" });

  const c = t.client(); await c.login(owner.email, TEST_PASSWORD, owner.secret);
  const page = async (qs: string) => (await (await c.get(`/staff/audit${qs}`)).text());
  const titles = (h: string) => [...h.matchAll(/<li class="audit-entry"[^>]*><div[^>]*><strong>([^<]+)<\/strong>/g)].map((m) => m[1]);

  const all = await page("");
  assert.match(all, /<strong>Website delivery updated<\/strong>/);
  assert.match(all, /Pam Manager updated a customer&#39;s website delivery status\. <span class="muted">— Project: Sunrise website<\/span>|Pam Manager updated a customer's website delivery status\. <span class="muted">— Project: Sunrise website<\/span>/);
  assert.match(all, /Failed or refused/);
  assert.match(all, /<details><summary class="faint">Details<\/summary><dl class="dl"><dt>Event<\/dt><dd><code>website_delivery\.status_changed<\/code>/, "the original event is kept, under Details");
  const timeline = /<ol class="timeline audit-timeline"[\s\S]*?<\/ol>/.exec(all)![0];
  assert.doesNotMatch(timeline.replace(/<details>[\s\S]*?<\/details>/g, ""), /website_delivery\.status_changed|usr_|prj_|org_/, "no raw event names or ids in the primary display");

  assert.deepEqual(titles(await page(`?employee=${pm.id}`)).sort(), ["Replied to a support request", "Website delivery updated"]);
  assert.deepEqual(titles(await page("?group=support")), ["Replied to a support request"]);
  assert.deepEqual(titles(await page("?record=Sunrise")).sort(), ["Problem with a website build", "Website delivery updated"], "customer or project filter; the other customer's reply is excluded");
  assert.deepEqual(titles(await page("?outcome=failed")), ["Problem with a website build"]);
  assert.ok(!titles(await page("?outcome=succeeded")).includes("Problem with a website build"));
  assert.deepEqual(titles(await page("?from=2001-02-01&to=2001-02-28")), ["Lead assigned"]);
  // The technical filters still work (and the export uses the same query).
  assert.deepEqual(titles(await page("?action=ticket.")), ["Replied to a support request"]);

  // The employee page shows the same readable timeline and links to their full history.
  const emp = await (await c.get(`/staff/employees/${pm.id}`)).text();
  assert.match(emp, /data-activity-timeline/);
  assert.match(emp, /<strong>Replied to a support request<\/strong>/);
  assert.match(emp, new RegExp(`/staff/audit\\?employee=${pm.id}`));
});
