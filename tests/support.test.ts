import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, lastEmail, TestClient } from "./support/app.ts";
import { runSupportEscalationSweep, type TicketRow } from "../src/services/support.ts";
import type { Env } from "../src/app/context.ts";
import { OutboxEmail } from "../src/adapters/email.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function setup(extra: Partial<Env> = {}) {
  const app = await createTestApp(extra);
  const custA = await createCustomer(app.db, "alice@a.example", "Alpha Bakery");
  const custB = await createCustomer(app.db, "bob@b.example", "Beta Garage");
  const agent = await createStaff(app.db, "support", "agent@crestmont.test", "Sam Support");
  const owner = await createStaff(app.db, "owner", "owner@crestmont.test", "Olivia Owner");
  const a = await app.client().login(custA.email);
  const b = await app.client().login(custB.email);
  const s = await app.client().login(agent.email, undefined, agent.secret);
  return { ...app, custA, custB, agent, owner, a, b, s };
}

async function openTicket(c: TestClient, fields: Record<string, string | File> = {}) {
  const res = await c.post("/portal/support/new", { subject: "Contact form not sending", category: "technical", description: "The contact form on /contact shows an error when submitted.", ...fields });
  assert.equal(res.status, 303, await res.clone().text().then((t) => t.slice(0, 400)));
  return res.headers.get("location")!.split("/").pop()!;
}

const ticket = (db: Env["DB"], id: string) => db.prepare(`SELECT * FROM tickets WHERE id = ?`).bind(id).first<TicketRow>();

test("[SUP-001] customer submits a ticket with category and attachment; confirmation email is recorded", async () => {
  const { db, a, custA, storage } = await setup();
  const id = await openTicket(a, { attachments: new File([PNG], "screenshot.png", { type: "image/png" }) });
  const t = (await ticket(db, id))!;
  assert.equal(t.organization_id, custA.organizationId);
  assert.equal(t.category, "technical");
  assert.equal(t.status, "open");
  const file = await db.prepare(`SELECT f.* FROM ticket_messages tm JOIN files f ON f.id = tm.attachment_file_id WHERE tm.ticket_id = ?`).bind(id).first<{ id: string; organization_id: string; filename: string; r2_key: string }>();
  assert.equal(file?.organization_id, custA.organizationId);
  assert.equal(file?.filename, "screenshot.png");
  assert.ok(storage.objects.has(file!.r2_key), "bytes stored through ctx.storage");
  const page = await (await a.get(`/portal/support/${id}`)).text();
  assert.match(page, new RegExp(`/files/${file!.id}`));
  const mail = await lastEmail(db, custA.email);
  assert.equal(mail?.template, "support_ticket");
  assert.match(mail!.text_body, /intake is open 24\/7/);
  // A disallowed attachment is refused and nothing is created.
  const before = (await db.prepare(`SELECT COUNT(*) AS n FROM tickets`).first<{ n: number }>())!.n;
  const bad = await a.post("/portal/support/new", { subject: "Another issue", category: "other", description: "Something else is broken here.", attachments: new File(["<html><script>x</script>"], "evil.txt", { type: "text/plain" }) });
  assert.equal(bad.status, 422);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM tickets`).first<{ n: number }>())!.n, before);
  const badCat = await a.post("/portal/support/new", { subject: "Bad category", category: "hacking", description: "Category is not in the allowed list." });
  assert.equal(badCat.status, 422);
});

test("[SUP-001] attachments are refused honestly when storage is not configured", async () => {
  const app = await createTestApp();
  app.env.overrides = { ...app.env.overrides, storage: null };
  const cust = await createCustomer(app.db, "nostore@example.com");
  const c = await app.client().login(cust.email);
  assert.match(await (await c.get("/portal/support/new")).text(), /Attachments are unavailable/);
  const res = await c.post("/portal/support/new", { subject: "With file", category: "technical", description: "This has a file attached to it.", attachments: new File([PNG], "a.png") });
  assert.equal(res.status, 422);
  assert.match(await res.text(), /Attachments are unavailable/);
});

test("[AUTH-008] a customer cannot see or act on another organization's tickets", async () => {
  const { db, a, b } = await setup();
  const id = await openTicket(a);
  assert.equal((await b.get(`/portal/support/${id}`)).status, 404);
  assert.equal((await b.post(`/portal/support/${id}/reply`, { body: "hijack" })).status, 404);
  assert.equal((await b.post(`/portal/support/${id}/reopen`)).status, 404);
  assert.doesNotMatch(await (await b.get("/portal/support")).text(), /Contact form not sending/);
  assert.match(await (await a.get("/portal/support")).text(), /Contact form not sending/);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ticket_messages WHERE ticket_id = ? AND body = 'hijack'`).bind(id).first<{ n: number }>())!.n, 0);
  // Project selection is tenant-scoped too.
  await db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES ('prj_a', (SELECT organization_id FROM tickets WHERE id = ?), 'Alpha site', 'design', 2, 'upfront', 'x', 'x')`).bind(id).run();
  const cross = await b.post("/portal/support/new", { subject: "Other org project", category: "technical", description: "Pointing at someone else's project.", project_id: "prj_a" });
  assert.equal(cross.status, 422);
  assert.doesNotMatch(await (await b.get("/portal/support/new")).text(), /Alpha site/);
  assert.match(await (await a.get("/portal/support/new")).text(), /Alpha site/);
  // Customers cannot reach the staff queue.
  assert.equal((await a.get(`/staff/support/${id}`)).status, 403);
});

test("[SUP-002] internal notes are never shown to customers; staff can assign, triage, escalate, resolve and reopen", async () => {
  const { db, a, s, agent, owner } = await setup();
  const id = await openTicket(a);
  assert.equal((await s.post(`/staff/support/${id}/note`, { body: "INTERNAL: customer is on legacy plan, check DNS first" })).status, 303);
  const custView = await (await a.get(`/portal/support/${id}`)).text();
  assert.doesNotMatch(custView, /INTERNAL: customer is on legacy plan/);
  const staffView = await (await s.get(`/staff/support/${id}`)).text();
  assert.match(staffView, /INTERNAL: customer is on legacy plan/);
  assert.match(staffView, /Internal note — not visible to the customer/);

  assert.equal((await s.post(`/staff/support/${id}/assign`, { assignee: owner.id })).status, 303);
  const asg = await db.prepare(`SELECT user_id FROM assignments WHERE subject_type = 'ticket' AND subject_id = ? AND ended_at IS NULL`).bind(id).first<{ user_id: string }>();
  assert.equal(asg?.user_id, owner.id);
  assert.equal((await lastEmail(db, owner.email))?.subject.startsWith("Ticket assigned to you"), true);
  assert.ok(await db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'ticket_assigned'`).bind(owner.id).first());

  assert.equal((await s.post(`/staff/support/${id}/triage`, { priority: "urgent", category: "technical" })).status, 303);
  assert.equal((await ticket(db, id))!.priority, "urgent");
  assert.equal((await s.post(`/staff/support/${id}/escalate`, { reason: "Site down for customer" })).status, 303);
  assert.equal((await ticket(db, id))!.status, "escalated");
  assert.match(await (await a.get(`/portal/support/${id}`)).text(), /Escalated/i, "status badge is visible");
  assert.doesNotMatch(await (await a.get(`/portal/support/${id}`)).text(), /Site down for customer/, "escalation reason is internal");

  assert.equal((await s.post(`/staff/support/${id}/status`, { status: "resolved" })).status, 303);
  assert.ok((await ticket(db, id))!.resolved_at);
  // Invalid transition: resolved → pending_customer
  assert.equal((await s.post(`/staff/support/${id}/status`, { status: "pending_customer" })).status, 409);
  // Customer cannot reply to a resolved ticket but can reopen it.
  assert.equal((await a.post(`/portal/support/${id}/reply`, { body: "still broken" })).status, 409);
  assert.equal((await a.post(`/portal/support/${id}/reopen`)).status, 303);
  const t = (await ticket(db, id))!;
  assert.equal(t.status, "open");
  assert.ok(t.reopened_at);
  assert.equal(t.resolved_at, null);
  // Audit trail exists for every change.
  const actions = (await db.prepare(`SELECT action FROM audit_logs WHERE subject_type = 'ticket' AND subject_id = ?`).bind(id).all<{ action: string }>()).results.map((x) => x.action);
  for (const act of ["ticket.created", "ticket.internal_note", "ticket.assigned", "ticket.triaged", "ticket.status_changed"]) assert.ok(actions.includes(act), act);
  // Queue filters and search
  assert.match(await (await s.get("/staff/support?priority=urgent&q=Contact")).text(), /Contact form not sending/);
  assert.doesNotMatch(await (await s.get("/staff/support?priority=low")).text(), /Contact form not sending/);
  assert.match(await (await s.get(`/staff/support?assignee=${owner.id}`)).text(), /Contact form not sending/);
  void agent;
});

test("[SUP-002] roles without support access are refused; project managers can note but not change tickets", async () => {
  const { db, client, a } = await setup();
  const id = await openTicket(a);
  const dev = await createStaff(db, "developer");
  const d = await client().login(dev.email, undefined, dev.secret);
  assert.equal((await d.get("/staff/support")).status, 403);
  const pm = await createStaff(db, "project_manager");
  const p = await client().login(pm.email, undefined, pm.secret);
  assert.equal((await p.get(`/staff/support/${id}`)).status, 200);
  assert.equal((await p.post(`/staff/support/${id}/note`, { body: "PM note" })).status, 303);
  assert.equal((await p.post(`/staff/support/${id}/reply`, { body: "PM reply" })).status, 403);
});

test("[SUP-003] first response time is recorded on the first staff reply only and the customer is notified", async () => {
  const { db, a, s, custA } = await setup();
  const id = await openTicket(a);
  assert.equal((await ticket(db, id))!.first_response_at, null);
  await s.post(`/staff/support/${id}/note`, { body: "note does not count as a response" });
  assert.equal((await ticket(db, id))!.first_response_at, null);
  assert.equal((await s.post(`/staff/support/${id}/reply`, { body: "Thanks — we are looking at the form handler now." })).status, 303);
  const first = (await ticket(db, id))!.first_response_at;
  assert.ok(first);
  assert.equal((await ticket(db, id))!.status, "pending_customer");
  const mail = await lastEmail(db, custA.email);
  assert.equal(mail?.template, "support_reply");
  assert.doesNotMatch(mail!.text_body, /form handler/, "email links to the portal instead of repeating content");
  await a.post(`/portal/support/${id}/reply`, { body: "Thanks!" });
  assert.equal((await ticket(db, id))!.status, "pending_staff");
  await s.post(`/staff/support/${id}/reply`, { body: "Second reply" });
  assert.equal((await ticket(db, id))!.first_response_at, first, "first response is not overwritten");
  assert.match(await (await s.get(`/staff/support/${id}`)).text(), /Response time/);
});

test("[SUP-003] escalation sweep flags first-response breaches once (idempotent) and reminds staff", async () => {
  const { db, env, a, owner } = await setup();
  await db.prepare(`INSERT INTO support_settings (id, staffed_hours, first_response_target_hours, updated_at) VALUES (1, 'Mon–Fri 9:00–17:00 Eastern', 4, 'x')`).run();
  const late = await openTicket(a);
  const fresh = await openTicket(a, { subject: "Fresh ticket" });
  await db.prepare(`UPDATE tickets SET created_at = ? WHERE id = ?`).bind(new Date(Date.now() - 6 * 3_600_000).toISOString(), late).run();
  const ctx = { db, email: new OutboxEmail(db), baseUrl: "http://crestmont.test", settings: {}, now: () => new Date() };
  const r1 = await runSupportEscalationSweep(ctx);
  assert.equal(r1.flagged, 1);
  const r2 = await runSupportEscalationSweep(ctx);
  assert.equal(r2.flagged, 0, "second sweep does not re-flag");
  assert.ok((await ticket(db, late))!.sla_breached_at);
  assert.equal((await ticket(db, fresh))!.sla_breached_at, null);
  const reminders = (await db.prepare(`SELECT COUNT(*) AS n FROM email_deliveries WHERE idempotency_key LIKE ?`).bind(`sla:${late}:%`).first<{ n: number }>())!.n;
  assert.ok(reminders >= 1);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ticket.sla_breached' AND subject_id = ?`).bind(late).first<{ n: number }>())!.n, 1);
  // Manual trigger route works and stays idempotent.
  const o = await new TestClient(env).login(owner.email, undefined, owner.secret);
  assert.equal((await o.post("/staff/support/sweep")).status, 303);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ticket.sla_breached' AND subject_id = ?`).bind(late).first<{ n: number }>())!.n, 1);
  assert.match(await (await o.get("/staff/support?breached=1")).text(), /Contact form not sending/);
});

test("[SUP-004] AI draft fails honestly when no provider is configured and nothing is sent", async () => {
  const { db, a, s, custA } = await setup();
  const id = await openTicket(a);
  const mailsBefore = (await db.prepare(`SELECT COUNT(*) AS n FROM email_deliveries WHERE to_email = ?`).bind(custA.email).first<{ n: number }>())!.n;
  const res = await s.post(`/staff/support/${id}/draft`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), `/staff/support/${id}`);
  assert.match(decodeURIComponent(s.cookies.get("cm_flash") ?? ""), /not configured.*Nothing was sent/);
  const job = await db.prepare(`SELECT status, error FROM ai_jobs WHERE workflow = 'support_reply' AND input_ref = ?`).bind(`ticket:${id}`).first<{ status: string; error: string }>();
  assert.equal(job?.status, "failed");
  assert.match(job!.error, /not_configured/);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ticket_messages WHERE ticket_id = ? AND author_user_id <> (SELECT opened_by FROM tickets WHERE id = ?)`).bind(id, id).first<{ n: number }>())!.n, 0);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM email_deliveries WHERE to_email = ?`).bind(custA.email).first<{ n: number }>())!.n, mailsBefore);
  assert.equal((await ticket(db, id))!.first_response_at, null);
});

test("[SUP-004] AI-drafted replies on sensitive tickets require explicit human approval; drafts are never auto-sent", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    assert.match(String(url), /api\.anthropic\.com/);
    return new Response(JSON.stringify({ content: [{ type: "text", text: "We have received your billing question and will review the invoice." }], usage: { input_tokens: 10, output_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const { db, a, s, agent, custA } = await setup({ ANTHROPIC_API_KEY: "sk-test-fake" });
    const id = await openTicket(a, { subject: "Charged twice", category: "billing", description: "My card was charged twice for the deposit invoice." });
    const res = await s.post(`/staff/support/${id}/draft`);
    const loc = res.headers.get("location")!;
    assert.match(loc, /\?draft=ai_[0-9a-f]{24}/);
    const jobId = /draft=(ai_[0-9a-f]{24})/.exec(loc)![1];
    // Draft exists but nothing reached the customer.
    assert.equal((await db.prepare(`SELECT status FROM ai_jobs WHERE id = ?`).bind(jobId).first<{ status: string }>())!.status, "awaiting_approval");
    assert.equal((await ticket(db, id))!.first_response_at, null);
    assert.notEqual((await lastEmail(db, custA.email))?.template, "support_reply");
    const page = await (await s.get(loc)).text();
    assert.match(page, /We have received your billing question/);
    assert.match(page, /I have reviewed this AI-assisted reply and approve sending it/);
    // Sending without the approval tick is refused.
    const refused = await s.post(`/staff/support/${id}/reply`, { body: "We have received your billing question and will review the invoice. (edited)", ai_job_id: jobId });
    assert.equal(refused.status, 422);
    assert.match(await refused.text(), /sensitive ticket/);
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ticket_messages WHERE ai_draft_job_id = ?`).bind(jobId).first<{ n: number }>())!.n, 0);
    // With explicit approval the human-edited text is sent and approval is recorded on message and job.
    const ok = await s.post(`/staff/support/${id}/reply`, { body: "We have received your billing question and will review the invoice. (edited)", ai_job_id: jobId, approve_sensitive: "1" });
    assert.equal(ok.status, 303);
    const msg = await db.prepare(`SELECT body, approved_by FROM ticket_messages WHERE ai_draft_job_id = ?`).bind(jobId).first<{ body: string; approved_by: string }>();
    assert.equal(msg?.approved_by, agent.id);
    assert.match(msg!.body, /\(edited\)/);
    const job = await db.prepare(`SELECT status, approved_by, output_ref FROM ai_jobs WHERE id = ?`).bind(jobId).first<{ status: string; approved_by: string; output_ref: string }>();
    assert.deepEqual([job?.status, job?.approved_by], ["approved", agent.id]);
    assert.match(job!.output_ref, /\(edited\)/);
    assert.equal((await lastEmail(db, custA.email))?.template, "support_reply");
    // A used draft cannot be sent again.
    assert.equal((await s.post(`/staff/support/${id}/reply`, { body: "again", ai_job_id: jobId, approve_sensitive: "1" })).status, 409);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("[SUP-005] staffed hours are disclosed honestly and cannot claim 24/7 human coverage", async () => {
  const { a, owner, env } = await setup();
  const before = await (await a.get("/portal/support")).text();
  assert.match(before, /has not yet published its staffed support hours/);
  assert.doesNotMatch(before, /24\/7 (human|staff|support team)/i);
  const o = await new TestClient(env).login(owner.email, undefined, owner.secret);
  const bad = await o.post("/staff/support/settings", { staffed_hours: "24/7 live support", target_hours: "4" });
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /may not claim 24\/7/);
  assert.equal((await o.post("/staff/support/settings", { staffed_hours: "Mon–Fri 9:00–17:00 Eastern", target_hours: "8" })).status, 303);
  const after = await (await a.get("/portal/support/new")).text();
  assert.match(after, /Our team responds during staffed hours: Mon–Fri 9:00–17:00 Eastern/);
});
