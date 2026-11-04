// Owner command-center modules: workflows behind the non-finance module pages, exercised through the
// real request pipeline. All records created here are TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { businessDate } from "../src/lib/business-time.ts";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import type { Env } from "../src/app/context.ts";

type App = Awaited<ReturnType<typeof createTestApp>>;

async function staffClient(t: App, role: Parameters<typeof createStaff>[1], email?: string) {
  const s = await createStaff(t.db, role, email);
  const c = await t.client().login(s.email, TEST_PASSWORD, s.secret);
  return { ...s, c };
}

async function apiLead(c: TestClient, over: Record<string, string> = {}) {
  const res = await c.request("POST", "/api/leads", { body: JSON.stringify({ name: "Morgan Reyes", email: "morgan@harborcoffee.example", company: "Harbor Coffee", interest: "custom", message: "We need online ordering.", source: "quote_form", ...over }), headers: { "content-type": "application/json" } });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { leadId: string }).leadId;
}

const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;
// Quote validity is counted in Eastern business dates and capped at 30 days (FD-24, CREST-GAP-094).
const future = (days = 30) => new Date(Date.parse(`${businessDate(new Date())}T12:00:00Z`) + days * 86400e3).toISOString().slice(0, 10);

// ───────────── CRM ─────────────
test("[CRM-002] duplicate detection groups leads by email/phone/name+company; merge moves history, archives the duplicate and is audited", async () => {
  const t = await createTestApp();
  const v = t.client();
  // Historical duplicates (written before intake duplicate protection existed): the public API now continues the
  // existing lead instead of creating these, so they are inserted directly to exercise the after-the-fact merge tool.
  void v;
  const legacy = async (name: string, email: string, company: string, phone: string | null = null) => {
    const co = newId("co"), ct = newId("ct"), ld = newId("ld"), at = new Date().toISOString();
    await t.db.batch([
      t.db.prepare(`INSERT INTO companies (id, name, created_at) VALUES (?,?,?)`).bind(co, company, at),
      t.db.prepare(`INSERT INTO contacts (id, company_id, name, email, phone, created_at) VALUES (?,?,?,?,?,?)`).bind(ct, co, name, email.toLowerCase(), phone, at),
      t.db.prepare(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES (?,?,'quote_form','new',?,?)`).bind(ld, ct, at, at),
    ]);
    return ld;
  };
  const a = await legacy("Dana Fox", "dana@foxdesign.example", "Fox Design", "+1 (517) 555-0142");
  const b = await legacy("D. Fox", "DANA@FoxDesign.example", "Fox Design Studio");
  const c = await legacy("Unrelated Person", "other@else.example", "Else Co");
  const d = await legacy("Phone Match", "pm@one.example", "One", "517-555-0142");
  const owner = await staffClient(t, "owner");

  const page = await (await owner.c.get("/staff/crm/duplicates")).text();
  assert.match(page, /Dana Fox/);
  assert.match(page, /D\. Fox/);
  assert.match(page, /Phone Match/, "phone digits match across formats and the US country code");
  assert.doesNotMatch(page, /Unrelated Person/);
  assert.match(page, /matched on Email, Phone/);

  const detail = await (await owner.c.get(`/staff/crm/leads/${a}`)).text();
  assert.match(detail, /Possible duplicates \(2\)/);

  assert.equal((await owner.c.post(`/staff/crm/leads/${b}/note`, { body: "Called back about the second request", kind: "call" })).status, 303);
  const res = await owner.c.post(`/staff/crm/leads/${b}/merge`, { into: a });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), `/staff/crm/leads/${a}`);
  const merged = await one<{ stage: string; merged_into_lead_id: string; lost_reason: string }>(t.db, `SELECT stage, merged_into_lead_id, lost_reason FROM leads WHERE id = ?`, b);
  assert.deepEqual({ ...merged }, { stage: "archived", merged_into_lead_id: a, lost_reason: `Merged into ${a}` });
  const moved = await one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM crm_activities WHERE lead_id = ? AND body = 'Called back about the second request'`, a);
  assert.equal(moved.n, 1, "the duplicate's activities now belong to the survivor");
  const auditRow = await one<{ details_json: string }>(t.db, `SELECT details_json FROM audit_logs WHERE action = 'lead.merged' AND subject_id = ?`, a);
  assert.equal(JSON.parse(auditRow.details_json).merged, b);

  // The merged lead is read-only, hidden from the pipeline and cannot be merged twice.
  assert.equal((await owner.c.post(`/staff/crm/leads/${b}/note`, { body: "late note" })).status, 409);
  assert.equal((await owner.c.post(`/staff/crm/leads/${b}/stage`, { to: "qualified" })).status, 409);
  const again = await owner.c.post(`/staff/crm/leads/${b}/merge`, { into: a });
  assert.equal(again.status, 303);
  assert.equal(again.headers.get("location"), `/staff/crm/leads/${b}`);
  assert.match(await (await owner.c.get(`/staff/crm/leads/${b}`)).text(), /was merged into/);
  const list = await (await owner.c.get("/staff/crm?view=list")).text();
  assert.doesNotMatch(list, /D\. Fox/);
  assert.match(await (await owner.c.get("/staff/crm?view=list&stage=archived")).text(), /D\. Fox/);
  assert.equal((await owner.c.post(`/staff/crm/leads/${a}/merge`, { into: a })).status, 303, "self-merge is refused with a message");
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM leads WHERE merged_into_lead_id IS NOT NULL`)).n, 1);

  // "Not a duplicate" removes the pairing from detection.
  assert.equal((await owner.c.post("/staff/crm/duplicates/dismiss", { a, b: d, back: "/staff/crm/duplicates" })).status, 303);
  const after = await (await owner.c.get("/staff/crm/duplicates")).text();
  assert.doesNotMatch(after, /Phone Match/);
  assert.match(after, /No duplicates found/);
  assert.ok(c);

  // A sales rep cannot merge leads they cannot see, and developers have no CRM access.
  const rep = await staffClient(t, "sales", "rep@crestmont.test");
  assert.equal((await rep.c.post(`/staff/crm/leads/${d}/merge`, { into: a })).status, 404);
  const dev = await staffClient(t, "developer");
  assert.equal((await dev.c.get("/staff/crm/duplicates")).status, 403);
});

test("[CRM-002] customers list searches member emails, filters active/inactive and exports CSV (audited)", async () => {
  const t = await createTestApp();
  const active = await createCustomer(t.db, "buyer@activeco.example", "ActiveCo");
  await createCustomer(t.db, "idle@quietco.example", "QuietCo");
  await t.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(newId("prj"), active.organizationId, "ActiveCo site", "design", 3, "upfront", nowIso(), nowIso()).run();
  const owner = await staffClient(t, "owner");
  const byEmail = await (await owner.c.get("/staff/customers?q=idle%40quietco")).text();
  assert.match(byEmail, /QuietCo/);
  assert.doesNotMatch(byEmail, /ActiveCo/);
  const act = await (await owner.c.get("/staff/customers?status=active")).text();
  assert.match(act, /ActiveCo/);
  assert.doesNotMatch(act, /QuietCo/);
  assert.match(await (await owner.c.get("/staff/customers?status=inactive")).text(), /QuietCo/);
  const csv = await owner.c.get("/staff/customers/export.csv?status=active");
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  const text = await csv.text();
  assert.match(text, /^organization_id,name,customer_since/);
  assert.match(text, /ActiveCo/);
  assert.doesNotMatch(text, /QuietCo/);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer.exported'`)).n, 1);
  const dev = await staffClient(t, "developer");
  assert.equal((await dev.c.get("/staff/customers/export.csv")).status, 403);
});

test("[SALES-002] quotes: search, lapsed filter, CSV export, and withdraw/decline with a reason that stops sending and acceptance", async () => {
  const t = await createTestApp();
  const leadId = await apiLead(t.client(), { name: "Quinn Baker", email: "quinn@bakery.example", company: "Quinn Bakery" });
  const other = await apiLead(t.client(), { name: "Riley Smith", email: "riley@smith.example", company: "Smith Hardware" });
  const owner = await staffClient(t, "owner");
  const scope = "Starter package website with five pages and a contact form.";
  assert.equal((await owner.c.post(`/staff/quotes/new?lead=${leadId}`, { package: "starter", scope, valid_until: future() })).status, 303);
  assert.equal((await owner.c.post(`/staff/quotes/new?lead=${other}`, { package: "business", scope: "Business package website with twelve pages.", valid_until: future() })).status, 303);
  const qid = (await one<{ id: string }>(t.db, `SELECT id FROM quotes WHERE lead_id = ?`, leadId)).id;

  const search = await (await owner.c.get("/staff/quotes?q=bakery")).text();
  assert.match(search, /Quinn Baker/);
  assert.doesNotMatch(search, /Riley Smith/);
  assert.match(await (await owner.c.get("/staff/quotes?q=nobody-here")).text(), /No quotes match/);

  await t.db.prepare(`UPDATE quote_versions SET valid_until = '2020-01-01' WHERE quote_id = ?`).bind(qid).run();
  const lapsed = await (await owner.c.get("/staff/quotes?status=lapsed")).text();
  assert.match(lapsed, /Quinn Baker/);
  assert.doesNotMatch(lapsed, /Riley Smith/);
  await t.db.prepare(`UPDATE quote_versions SET valid_until = ? WHERE quote_id = ?`).bind(future(), qid).run();

  const csv = await (await owner.c.get("/staff/quotes/export.csv")).text();
  assert.match(csv, /^quote_id,created_date,status/);
  assert.match(csv, new RegExp(qid));
  assert.match(csv, /Smith Hardware/);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'quote.exported'`)).n, 1);

  assert.equal((await owner.c.post(`/staff/quotes/${qid}/close`, { kind: "withdrawn", reason: "no" })).status, 422);
  assert.equal((await owner.c.post(`/staff/quotes/${qid}/close`, { kind: "withdrawn", reason: "Customer chose to delay the project." })).status, 303);
  const q = await one<{ status: string; closed_reason: string; closed_by: string }>(t.db, `SELECT status, closed_reason, closed_by FROM quotes WHERE id = ?`, qid);
  assert.equal(q.status, "rejected");
  assert.equal(q.closed_reason, "withdrawn: Customer chose to delay the project.");
  assert.equal(q.closed_by, owner.id);
  assert.equal((await owner.c.post(`/staff/quotes/${qid}/send`)).status, 409, "a withdrawn quote must be revised before it is sent again");
  assert.equal((await owner.c.post(`/staff/quotes/${qid}/close`, { kind: "declined", reason: "Second attempt to close." })).status, 409);
  assert.match(await (await owner.c.get(`/staff/quotes/${qid}`)).text(), /Withdrawn/);
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'quote.withdrawn' AND subject_id = ?`, qid)).n, 1);
  // Revising reopens it as a draft.
  assert.equal((await owner.c.post(`/staff/quotes/${qid}`, { package: "starter", scope, valid_until: future() })).status, 303);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM quotes WHERE id = ?`, qid)).status, "draft");
});
