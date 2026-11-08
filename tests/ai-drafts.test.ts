// AI draft replies for staff (Founder directive, Phase 5): one shared drafting service (src/services/ai-drafts.ts) used by
// support tickets and general customer conversations. CONTROLLED FIXTURE: the self-hosted "runner" is this test making
// signed HTTP calls with canned text, and the paid provider is a faked fetch — no model runs. Proves the responsive
// flow's server contract: start returns a job, repeated clicks join it, the status endpoint delivers the draft into an
// editable field, nothing is ever sent by drafting, failures offer a retry, and context/permissions stay scoped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, TestClient } from "./support/app.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { requestAiDraft, LOCAL_RUNNER } from "../src/services/ai.ts";
import { conversationContext, draftStatus } from "../src/services/ai-drafts.ts";
import type { Env } from "../src/app/context.ts";

const SECRET = "ai-drafts-runner-secret";
const LOCAL: Partial<Env> = { AI_PROVIDER: "local-runner", BUILD_RUNNER_SECRET: SECRET };
type App = Awaited<ReturnType<typeof createTestApp>>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function setup(extra: Partial<Env> = LOCAL) {
  const app = await createTestApp(extra);
  const custA = await createCustomer(app.db, "alice@drafts.example", "Alpha Bakery");
  const custB = await createCustomer(app.db, "bob@drafts.example", "Beta Garage");
  const agent = await createStaff(app.db, "support", "agent@crestmont.test", "Sam Support");
  const pm = await createStaff(app.db, "project_manager", "pm@crestmont.test", "Pat PM");
  const dev = await createStaff(app.db, "developer", "dev@crestmont.test", "Dee Dev");
  const a = await app.client().login(custA.email);
  const b = await app.client().login(custB.email);
  const s = await app.client().login(agent.email);
  return { ...app, custA, custB, agent, pm, dev, a, b, s };
}

/** What app.js sends: the start form as multipart FormData, asking for JSON. */
async function startJson(c: TestClient, path: string): Promise<{ status: number; json: Json; type: string }> {
  if (!c.cookies.has("cm_csrf")) await c.get("/login");
  const fd = new FormData();
  fd.set("_csrf", c.cookies.get("cm_csrf")!);
  const res = await c.request("POST", path, { body: fd, headers: { origin: "http://crestmont.test", accept: "application/json" } });
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, type, json: type.includes("json") ? await res.json() as Json : {} };
}
async function statusJson(c: TestClient, path: string): Promise<{ status: number; json: Json }> {
  const res = await c.get(path);
  return { status: res.status, json: (res.headers.get("content-type") ?? "").includes("json") ? await res.json() as Json : {} };
}
async function runner(t: App, path: string, body: unknown) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const res = await t.client().request("POST", `/api/builds/runner/${path}`, { body: raw, headers: { "content-type": "application/json", "x-crestmont-runner-signature": `t=${ts},v1=${await hmacSha256Hex(SECRET, `${ts}.${raw}`)}` } });
  return await res.json() as Json;
}
/** The runner claims the next queued draft and answers it (text or an error). Returns the prompt it was given. */
async function runnerAnswers(t: App, answer: { text?: string; error?: string }): Promise<{ jobId: string; prompt: string }> {
  const c = await runner(t, "ai/claim", { runnerId: "rig-test" });
  assert.ok(c.job, "a queued draft was handed to the runner");
  await runner(t, "ai/complete", { jobId: c.job.id, leaseToken: c.job.leaseToken, model: "test-model", ...answer });
  return { jobId: c.job.id, prompt: c.job.prompt };
}
const count = async (db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())!.n;

async function openTicket(c: TestClient, fields: Record<string, string> = {}) {
  const res = await c.post("/portal/support/new", { subject: "Contact form not sending", category: "technical", description: "The contact form on /contact shows an error when submitted.", ...fields });
  assert.equal(res.status, 303);
  return res.headers.get("location")!.split("/").pop()!;
}

test("[SUP-004] ticket AI draft: click starts a job at once, repeated clicks join it, the draft arrives via the status endpoint into the editable reply field, and nothing is sent", async () => {
  const t = await setup();
  const { db, a, s, custA } = t;
  const id = await openTicket(a);
  assert.equal((await s.post(`/staff/support/${id}/note`, { body: "INTERNAL-ONLY: customer is on a payment plan" })).status, 303);
  const page0 = await (await s.get(`/staff/support/${id}`)).text();
  assert.match(page0, /data-ai-draft data-ai-draft-status-base="\/staff\/support\/[^"]+\/draft\/" data-ai-draft-target="#reply"/);
  assert.match(page0, /<form method="post" action="\/staff\/support\/[^"]+\/draft" data-ai-draft-start>/);
  assert.doesNotMatch(page0, /reload this page in a minute/i, "no more 'wait a minute and refresh'");
  const mailsBefore = await count(db, `SELECT COUNT(*) AS n FROM email_deliveries WHERE to_email = ?`, custA.email);
  const msgsBefore = await count(db, `SELECT COUNT(*) AS n FROM ticket_messages WHERE ticket_id = ?`, id);

  // Click: the job starts immediately and reports "pending" (the self-hosted model answers later).
  const first = await startJson(s, `/staff/support/${id}/draft`);
  assert.equal(first.status, 200);
  assert.match(first.type, /application\/json/);
  assert.equal(first.json.state, "pending");
  assert.match(first.json.jobId, /^ai_[0-9a-f]{24}$/);
  assert.equal(first.json.statusUrl, `/staff/support/${id}/draft/${first.json.jobId}`);
  // Repeated clicks while it is pending return the same job: no duplicate drafts.
  const second = await startJson(s, `/staff/support/${id}/draft`);
  const third = await startJson(s, `/staff/support/${id}/draft`);
  assert.deepEqual([second.json.jobId, third.json.jobId], [first.json.jobId, first.json.jobId]);
  assert.equal(second.json.reused, true);
  assert.equal(await count(db, `SELECT COUNT(*) AS n FROM ai_jobs WHERE workflow = 'support_reply' AND input_ref = ?`, `ticket:${id}`), 1);
  assert.equal((await statusJson(s, first.json.statusUrl)).json.state, "pending");

  // The runner finishes; the next poll returns the draft. Context excluded the internal note.
  const done = await runnerAnswers(t, { text: "Thanks for reporting this. Could you tell us which browser you used?" });
  assert.equal(done.jobId, first.json.jobId);
  assert.match(done.prompt, /contact form on \/contact shows an error/);
  assert.doesNotMatch(done.prompt, /INTERNAL-ONLY|payment plan/, "internal notes never reach the model");
  const ready = await statusJson(s, first.json.statusUrl);
  assert.equal(ready.status, 200);
  assert.deepEqual([ready.json.state, ready.json.draft, ready.json.sensitive], ["ready", "Thanks for reporting this. Could you tell us which browser you used?", false]);

  // Drafting created no reply, no message and no email; the ticket still has no first response.
  assert.equal(await count(db, `SELECT COUNT(*) AS n FROM ticket_messages WHERE ticket_id = ?`, id), msgsBefore);
  assert.equal(await count(db, `SELECT COUNT(*) AS n FROM email_deliveries WHERE to_email = ?`, custA.email), mailsBefore);
  assert.equal((await db.prepare(`SELECT first_response_at FROM tickets WHERE id = ?`).bind(id).first<{ first_response_at: string | null }>())!.first_response_at, null);

  // The no-JS page shows the same draft in the editable textarea, with the job linked; the conversation is preserved.
  const page = await (await s.get(`/staff/support/${id}?draft=${first.json.jobId}`)).text();
  assert.match(page, /<textarea class="textarea" id="f-body" name="body" rows="8" required maxlength="10000">Thanks for reporting this\. Could you tell us which browser you used\?<\/textarea>/);
  assert.doesNotMatch(page, /<textarea[^>]*(readonly|disabled)[^>]*name="body"/);
  assert.match(page, new RegExp(`name="ai_job_id" value="${first.json.jobId}" data-ai-draft-job`));
  assert.match(page, /contact form on \/contact shows an error/);
  assert.match(page, /INTERNAL-ONLY/, "staff still see their own internal note in the thread");

  // The employee revises and sends explicitly; only then a reply exists, linked to the draft.
  const sent = await s.post(`/staff/support/${id}/reply`, { body: "Thanks for reporting this. Which browser and device were you using? (edited)", ai_job_id: first.json.jobId });
  assert.equal(sent.status, 303);
  const msg = await db.prepare(`SELECT body FROM ticket_messages WHERE ai_draft_job_id = ?`).bind(first.json.jobId).first<{ body: string }>();
  assert.match(msg!.body, /\(edited\)/);
  assert.equal((await statusJson(s, first.json.statusUrl)).json.state, "used");
  // A later click starts a fresh draft (the previous one is no longer pending).
  const again = await startJson(s, `/staff/support/${id}/draft`);
  assert.notEqual(again.json.jobId, first.json.jobId);
});

test("[SUP-004] paid provider answers within the click: the draft comes back ready; sensitive tickets are flagged for explicit approval", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ content: [{ type: "text", text: "We are reviewing the duplicate charge on your invoice." }], usage: { input_tokens: 10, output_tokens: 12 } }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const t = await setup({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test-fake" });
    await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('ai.monthly_budget_usd', '5', ?)`).bind(new Date().toISOString()).run();
    const id = await openTicket(t.a, { subject: "Charged twice", category: "billing", description: "My card was charged twice." });
    const r = await startJson(t.s, `/staff/support/${id}/draft`);
    assert.deepEqual([r.status, r.json.state, r.json.draft, r.json.sensitive], [200, "ready", "We are reviewing the duplicate charge on your invoice.", true]);
    // The approval checkbox is on the page (revealed by app.js for a sensitive draft) and the server still enforces it.
    assert.match(await (await t.s.get(`/staff/support/${id}`)).text(), /data-ai-draft-sensitive hidden>[\s\S]*I have reviewed this AI-assisted reply and approve sending it/);
    assert.equal((await t.s.post(`/staff/support/${id}/reply`, { body: r.json.draft, ai_job_id: r.json.jobId })).status, 422);
    assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM ticket_messages WHERE ai_draft_job_id = ?`, r.json.jobId), 0);
  } finally { globalThis.fetch = realFetch; }
});

test("[SUP-004] drafting failures report a useful error with a retry; retry starts a new job; the no-JS path shows progress, then the draft", async () => {
  // Not configured: fails at once, honestly.
  const off = await setup({});
  const id0 = await openTicket(off.a);
  const f = await startJson(off.s, `/staff/support/${id0}/draft`);
  assert.equal(f.json.state, "failed");
  assert.match(f.json.error, /not configured/);
  const failedPage = await (await off.s.get(`/staff/support/${id0}?draft=${f.json.jobId}`)).text();
  assert.match(failedPage, /data-state="failed">AI draft unavailable: AI drafting is not configured/);
  assert.match(failedPage, /data-ai-draft-button>Retry AI draft<\/button>/);

  // Self-hosted model errors on every attempt → failed with the reason; Retry creates a new job.
  const t = await setup();
  const id = await openTicket(t.a);
  const r1 = await startJson(t.s, `/staff/support/${id}/draft`);
  for (let i = 0; i < 3; i++) await runnerAnswers(t, { error: "model out of memory" });
  const failed = await statusJson(t.s, `/staff/support/${id}/draft/${r1.json.jobId}`);
  assert.equal(failed.json.state, "failed");
  assert.match(failed.json.error, /could not produce a draft \(model out of memory\)/);
  const retry = await startJson(t.s, `/staff/support/${id}/draft`);
  assert.equal(retry.json.state, "pending");
  assert.notEqual(retry.json.jobId, r1.json.jobId);
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM ai_jobs WHERE input_ref = ?`, `ticket:${id}`), 2);

  // No JavaScript: the form post redirects to the page, which shows the pending state (and tells app.js to poll).
  const plain = await t.s.post(`/staff/support/${id}/draft`);
  assert.equal(plain.status, 303);
  assert.equal(plain.headers.get("location"), `/staff/support/${id}?draft=${retry.json.jobId}#reply`, "a repeated no-JS click joins the pending job");
  const pending = await (await t.s.get(`/staff/support/${id}?draft=${retry.json.jobId}`)).text();
  assert.match(pending, new RegExp(`data-ai-draft-pending="${retry.json.jobId}"`));
  assert.match(pending, /Drafting a reply… The draft will appear in the reply box as soon as it is ready\./);
  await runnerAnswers(t, { text: "Here is the fix we applied." });
  assert.match(await (await t.s.get(`/staff/support/${id}?draft=${retry.json.jobId}`)).text(), />Here is the fix we applied\.<\/textarea>/);
});

test("[SUP-004] ticket drafts are permission-checked: other roles, customers, other tickets' jobs and anonymous callers are refused", async () => {
  const t = await setup();
  const idA = await openTicket(t.a);
  const idB = await openTicket(t.b, { subject: "Beta issue", description: "BETA-PRIVATE details of the garage booking form." });
  const jobA = (await startJson(t.s, `/staff/support/${idA}/draft`)).json.jobId as string;
  const jobB = (await startJson(t.s, `/staff/support/${idB}/draft`)).json.jobId as string;
  const pm = await t.client().login(t.pm.email);
  assert.equal((await startJson(pm, `/staff/support/${idA}/draft`)).status, 403, "support.access without ticket.manage cannot draft");
  assert.equal((await statusJson(pm, `/staff/support/${idA}/draft/${jobA}`)).status, 403);
  assert.equal((await startJson(t.a, `/staff/support/${idA}/draft`)).status, 403, "customers cannot draft");
  assert.equal((await statusJson(t.a, `/staff/support/${idA}/draft/${jobA}`)).status, 403);
  // Guessing another ticket's job id through this ticket's address reveals nothing.
  const cross = await t.s.get(`/staff/support/${idA}/draft/${jobB}`);
  assert.equal(cross.status, 404);
  assert.doesNotMatch(await cross.text(), /BETA-PRIVATE/);
  assert.equal((await t.s.get(`/staff/support/${idA}/draft/ai_${"0".repeat(24)}`)).status, 404);
  assert.equal((await t.s.get(`/staff/support/${idA}/draft/not-a-job`)).status, 404);
  const anon = await t.client().get(`/staff/support/${idA}/draft/${jobA}`);
  assert.equal(anon.status, 303);
  assert.match(anon.headers.get("location") ?? "", /^\/login/);
  // A job from another ticket cannot be sent as this ticket's AI draft.
  await runnerAnswers(t, { text: "Draft for A" });
  await runnerAnswers(t, { text: "Draft for B" });
  assert.equal((await t.s.post(`/staff/support/${idA}/reply`, { body: "Draft for B", ai_job_id: jobB })).status, 400);
  // Refused requests created no extra jobs.
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM ai_jobs WHERE workflow = 'support_reply'`), 2);
});

test("[PORTAL-005] conversation AI draft: same flow on /staff/conversations/:orgId, context is only that customer's visible messages, idempotent, never auto-sent", async () => {
  const t = await setup();
  const { db, a, b, s, custA, custB } = t;
  assert.equal((await a.post("/portal/messages/general", { body: "Can you add our new opening hours to the website?" })).status, 303);
  assert.equal((await b.post("/portal/messages/general", { body: "BETA-SECRET: our alarm code is 4321" })).status, 303);
  assert.equal((await s.post(`/staff/conversations/${custA.organizationId}`, { body: "STAFF-INTERNAL: they owe a balance", internal: "1" })).status, 303);
  const page0 = await (await s.get(`/staff/conversations/${custA.organizationId}`)).text();
  assert.match(page0, /<form method="post" action="\/staff\/conversations\/[^"]+\/draft" data-ai-draft-start>/);
  assert.match(page0, /id="reply"/);
  const msgsBefore = await count(db, `SELECT COUNT(*) AS n FROM messages`);

  const first = await startJson(s, `/staff/conversations/${custA.organizationId}/draft`);
  assert.deepEqual([first.status, first.json.state], [200, "pending"]);
  assert.equal((await startJson(s, `/staff/conversations/${custA.organizationId}/draft`)).json.jobId, first.json.jobId, "a second click returns the same job");
  assert.equal(await count(db, `SELECT COUNT(*) AS n FROM ai_jobs WHERE input_ref = ?`, `conversation:${custA.organizationId}`), 1);

  const done = await runnerAnswers(t, { text: "Happy to help: please send the new hours and we will update the site." });
  assert.match(done.prompt, /new opening hours/);
  assert.match(done.prompt, /Alpha Bakery/);
  assert.doesNotMatch(done.prompt, /STAFF-INTERNAL|owe a balance/, "internal notes are excluded");
  assert.doesNotMatch(done.prompt, /BETA-SECRET|alarm code|Beta Garage/, "no other customer's data");
  const ready = await statusJson(s, first.json.statusUrl);
  assert.deepEqual([ready.json.state, ready.json.draft], ["ready", "Happy to help: please send the new hours and we will update the site."]);
  assert.equal(await count(db, `SELECT COUNT(*) AS n FROM messages`), msgsBefore, "drafting posted no message");

  // No-JS page: draft in the editable message box, job linked.
  const page = await (await s.get(`/staff/conversations/${custA.organizationId}?draft=${first.json.jobId}`)).text();
  assert.match(page, />Happy to help: please send the new hours and we will update the site\.<\/textarea>/);
  assert.match(page, new RegExp(`name="ai_job_id" value="${first.json.jobId}"`));

  // Cross-customer: A's job is not visible through B's conversation; customers and roles without customers.read are refused.
  assert.equal((await s.get(`/staff/conversations/${custB.organizationId}/draft/${first.json.jobId}`)).status, 404);
  assert.equal((await statusJson(a, first.json.statusUrl)).status, 403);
  assert.equal((await startJson(a, `/staff/conversations/${custA.organizationId}/draft`)).status, 403);
  const dev = await t.client().login(t.dev.email);
  assert.equal((await startJson(dev, `/staff/conversations/${custA.organizationId}/draft`)).status, 403);
  assert.equal((await statusJson(dev, first.json.statusUrl)).status, 403);
  assert.equal((await s.get(`/staff/conversations/org_does_not_exist/draft/${first.json.jobId}`)).status, 404);

  // The employee edits and sends explicitly: the message is posted and the draft marked approved by them; reuse is refused.
  const sent = await s.post(`/staff/conversations/${custA.organizationId}`, { body: "Happy to help — please send the new hours. (edited)", ai_job_id: first.json.jobId });
  assert.equal(sent.status, 303);
  assert.equal(await count(db, `SELECT COUNT(*) AS n FROM messages WHERE organization_id = ? AND body LIKE '%(edited)%' AND internal = 0`, custA.organizationId), 1);
  const job = await db.prepare(`SELECT status, approved_by FROM ai_jobs WHERE id = ?`).bind(first.json.jobId).first<{ status: string; approved_by: string }>();
  assert.deepEqual([job?.status, job?.approved_by], ["approved", t.agent.id]);
  const reuse = await s.post(`/staff/conversations/${custA.organizationId}`, { body: "Again", ai_job_id: first.json.jobId });
  assert.equal(reuse.status, 409);
  // Another customer's draft cannot be attached to this conversation's message.
  const jobB = (await startJson(s, `/staff/conversations/${custB.organizationId}/draft`)).json.jobId as string;
  await runnerAnswers(t, { text: "Draft for Beta" });
  const smuggled = await s.post(`/staff/conversations/${custA.organizationId}`, { body: "Draft for Beta", ai_job_id: jobB });
  assert.equal(smuggled.status, 400);
  assert.equal(await count(db, `SELECT COUNT(*) AS n FROM messages WHERE body = 'Draft for Beta'`), 0);
});

test("[PORTAL-005] conversation drafting needs a customer message to answer; failures are reported with a retry", async () => {
  const t = await setup({});
  const empty = await startJson(t.s, `/staff/conversations/${t.custA.organizationId}/draft`);
  assert.equal(empty.status, 422);
  assert.match(empty.json.error, /no customer message to reply to/);
  const plain = await t.s.post(`/staff/conversations/${t.custA.organizationId}/draft`);
  assert.equal(plain.status, 303);
  assert.match(decodeURIComponent(t.s.cookies.get("cm_flash") ?? ""), /no customer message to reply to.*Nothing was sent/);
  await t.a.post("/portal/messages/general", { body: "Hello, a question about our site." });
  const off = await startJson(t.s, `/staff/conversations/${t.custA.organizationId}/draft`);
  assert.deepEqual([off.status, off.json.state], [200, "failed"]);
  assert.match(off.json.error, /not configured/);
  const page = await (await t.s.get(`/staff/conversations/${t.custA.organizationId}?draft=${off.json.jobId}`)).text();
  assert.match(page, /Retry AI draft/);
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM messages WHERE organization_id = ? AND author_user_id = ?`, t.custA.organizationId, t.agent.id), 0);
});

test("[AIOPS-002] single-flight drafts: concurrent requests for the same input create one job; a stale queued job is superseded", async () => {
  const t = await createTestApp(LOCAL);
  const req = { workflow: "support_reply" as const, inputRef: "ticket:tkt_concurrent", prompt: "p", requestedBy: null, singleFlight: true };
  const results = await Promise.all([requestAiDraft(t.db, LOCAL_RUNNER, req), requestAiDraft(t.db, LOCAL_RUNNER, req), requestAiDraft(t.db, LOCAL_RUNNER, req)]);
  assert.equal(new Set(results.map((r) => r.jobId)).size, 1);
  assert.equal(results.filter((r) => r.reused).length, 2);
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM ai_jobs WHERE input_ref = 'ticket:tkt_concurrent'`), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM ai_job_inputs WHERE job_id = ?`, results[0].jobId), 1);
  // Without singleFlight the old behaviour (a new job each call) is unchanged.
  const plain = await requestAiDraft(t.db, LOCAL_RUNNER, { ...req, singleFlight: false });
  assert.notEqual(plain.jobId, results[0].jobId);
  // A queued job nobody picked up for longer than the window no longer blocks a new request.
  const old = new Date(Date.now() - 20 * 60_000).toISOString();
  await t.db.prepare(`UPDATE ai_jobs SET created_at = ? WHERE input_ref = 'ticket:tkt_concurrent'`).bind(old).run();
  const fresh = await requestAiDraft(t.db, LOCAL_RUNNER, req);
  assert.ok(!fresh.reused);
  assert.equal((await t.db.prepare(`SELECT status, error FROM ai_jobs WHERE id = ?`).bind(results[0].jobId).first<{ status: string; error: string }>())!.status, "failed");
  // A job stuck "running" past the window is reported as failed (with a retry), not as pending forever.
  await t.db.prepare(`UPDATE ai_jobs SET status = 'running', created_at = ? WHERE id = ?`).bind(old, fresh.jobId).run();
  const stuck = await draftStatus(t.db, { kind: "ticket", id: "tkt_concurrent", organizationId: "org_x" }, fresh.jobId);
  assert.equal(stuck?.state, "failed");
  assert.match(stuck!.error!, /did not finish in time/);
  assert.equal(await draftStatus(t.db, { kind: "conversation", organizationId: "org_x" }, fresh.jobId), null, "a ticket's job is not a conversation's job");
});

test("[PORTAL-005] conversation context helper reads only customer-visible general messages of one organization", async () => {
  const t = await setup({});
  await t.a.post("/portal/messages/general", { body: "Visible question from Alpha" });
  await t.s.post(`/staff/conversations/${t.custA.organizationId}`, { body: "Internal remark", internal: "1" });
  await t.s.post(`/staff/conversations/${t.custA.organizationId}`, { body: "Visible staff answer" });
  await t.b.post("/portal/messages/general", { body: "Beta private question" });
  const ctx = (await conversationContext(t.db, t.custA.organizationId))!;
  assert.deepEqual(ctx.messages, [{ fromStaff: false, body: "Visible question from Alpha" }, { fromStaff: true, body: "Visible staff answer" }]);
  assert.equal(await conversationContext(t.db, "org_crestmont"), null, "internal (non-customer) organizations have no conversation context");
});
