// Provider webhooks (Retell, Resend), automatic cost import and Stripe-side reconciliation.
// Everything here is TEST DATA: providers are local fakes (signed with test secrets, fake fetch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { signRetell } from "../src/adapters/retell.ts";
import { publishedPricing } from "../src/services/voice.ts";
import { signSvix } from "../src/services/email-events.ts";
import { sendMail } from "../src/services/mailer.ts";
import { OutboxEmail, ResendEmail } from "../src/adapters/email.ts";
import { runJobs, SCHEDULE } from "../src/app/scheduled.ts";
import { runCostImport } from "../src/services/cost-import.ts";
import { runStripeReconciliation } from "../src/services/stripe-reconcile.ts";
import { refreshIntegrationHealth, secretPresence } from "../src/services/integrations.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";

const RETELL_KEY = "key_test_retell_webhook_0001";
// Svix-format test secret: "whsec_" + base64 of 32 bytes.
const WHSEC = `whsec_${btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)))}`;

const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => ({ ...(await db.prepare(sql).bind(...b).first<T>())! }) as T;
const count = async (db: Env["DB"], sql: string, ...b: unknown[]) => (await one<{ n: number }>(db, sql, ...b)).n;

async function staffClient(t: { db: Env["DB"]; client: () => TestClient }, role: Parameters<typeof createStaff>[1]) {
  const s = await createStaff(t.db, role);
  const c = t.client(); await c.login(s.email, TEST_PASSWORD, s.secret);
  return { ...s, c };
}

// ───────────── Retell (VOICE-003) ─────────────

async function retellApp(extra: Partial<Env> = {}) {
  const t = await createTestApp({ RETELL_API_KEY: RETELL_KEY, ...extra });
  const c = t.client();
  const post = async (path: string, payload: unknown, opts: { header?: string | null; key?: string; ms?: number } = {}) => {
    const raw = JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json" };
    const h = opts.header === undefined ? await signRetell(opts.key ?? RETELL_KEY, raw, opts.ms) : opts.header;
    if (h !== null) headers["x-retell-signature"] = h;
    const res = await c.request("POST", path, { body: raw, headers });
    return { res, json: (await res.json()) as Record<string, any> };
  };
  return { ...t, post };
}
const phoneCall = (id: string, extra: Record<string, unknown> = {}) => ({ call_id: id, call_type: "phone_call", from_number: "+15550100123", direction: "inbound", agent_id: "agent_test", ...extra });
const fnCall = (id: string, name: string, args: Record<string, unknown>) => ({ name, call: phoneCall(id), args });

test("[VOICE-003] [SEC-002] Retell endpoints verify X-Retell-Signature exactly as documented and fail closed", async () => {
  const t = await retellApp();
  const ev = { event: "call_started", call: phoneCall("call_sig") };
  for (const path of ["/api/webhooks/retell", "/api/webhooks/retell/functions"]) {
    assert.equal((await t.post(path, ev, { header: null })).res.status, 401, `${path} missing`);
    assert.equal((await t.post(path, ev, { header: "v=123,d=zz" })).res.status, 401, `${path} malformed`);
    assert.equal((await t.post(path, ev, { key: "key_other_workspace" })).res.status, 401, `${path} wrong key`);
    assert.equal((await t.post(path, ev, { ms: Date.now() - 6 * 60_000 })).res.status, 401, `${path} stale (>5 min)`);
  }
  // Signed string is raw body + timestamp (body first), HMAC-SHA256 hex keyed by the API key.
  const raw = JSON.stringify(ev), ms = Date.now();
  const manual = `v=${ms},d=${await hmacSha256Hex(RETELL_KEY, raw + String(ms))}`;
  assert.equal(manual, await signRetell(RETELL_KEY, raw, ms));
  const swapped = `v=${ms},d=${await hmacSha256Hex(RETELL_KEY, String(ms) + raw)}`;
  assert.equal((await t.post("/api/webhooks/retell", ev, { header: swapped })).res.status, 401, "timestamp-first signing is rejected");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM calls`), 0);
  assert.equal((await t.post("/api/webhooks/retell", ev, { header: manual })).res.status, 200);
  // No key configured → refused even when correctly signed with some key.
  const t2 = await createTestApp();
  const res = await t2.client().request("POST", "/api/webhooks/retell", { body: raw, headers: { "x-retell-signature": await signRetell("anything", raw) } });
  assert.equal(res.status, 401);
  assert.match(((await res.json()) as { error: string }).error, /not configured/);
});

test("[VOICE-003] Retell call + function events map into the voice service: idempotent, ai_receptionist lead, catalog-only pricing", async () => {
  const t = await retellApp();
  const id = "call_retell_1";
  assert.equal((await t.post("/api/webhooks/retell", { event: "call_started", call: phoneCall(id) })).res.status, 200);
  assert.equal((await t.post("/api/webhooks/retell", { event: "call_started", call: phoneCall(id) })).json.duplicate, true, "Retell retry is a duplicate");
  // Pricing function returns exactly the platform's published pricing (catalog only).
  const pricing = await t.post("/api/webhooks/retell/functions", fnCall(id, "get_published_pricing", {}));
  assert.equal(pricing.res.status, 200);
  assert.deepEqual(pricing.json.pricing, JSON.parse(JSON.stringify(publishedPricing())));
  assert.doesNotMatch(JSON.stringify(pricing.json), /entitlement/i);
  // create_lead → lead with source ai_receptionist; Retell's retry (same args) does not create a second one.
  const args = { name: "Riley Test", phone: "+1 555 0100", email: "riley@example.com", interest: "business", requirements: "TEST: ten page site for a dental office" };
  const lead = await t.post("/api/webhooks/retell/functions", fnCall(id, "create_lead", args));
  assert.equal(lead.json.leadCreated, true);
  assert.equal(typeof lead.json.message, "string");
  const retry = await t.post("/api/webhooks/retell/functions", fnCall(id, "create_lead", args));
  assert.equal(retry.res.status, 200);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM leads`), 1);
  assert.equal((await one<{ source: string }>(t.db, `SELECT source FROM leads`)).source, "ai_receptionist");
  // Callback becomes a CRM task on the same lead.
  await t.post("/api/webhooks/retell/functions", fnCall(id, "request_callback", { name: "Riley Test", phone: "+1 555 0100", reason: "TEST: wants to talk to a person" }));
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM crm_activities WHERE kind = 'task'`), 1);
  // Unknown / forbidden functions are rejected by the voice service, not executed.
  assert.equal((await t.post("/api/webhooks/retell/functions", fnCall(id, "approve_refund", { amount: 100 }))).res.status, 422);
  // call_ended: outcome derived from what happened; combined_cost (cents) → micro-USD.
  const ended = await t.post("/api/webhooks/retell", { event: "call_ended", call: phoneCall(id, { call_status: "ended", disconnection_reason: "user_hangup", transcript: "Agent: hi", call_cost: { combined_cost: 12.5 } }) });
  assert.equal(ended.json.outcome, "lead_captured");
  const call = await one<{ provider: string; outcome: string; cost_microusd: number; transcript: string | null; is_test: number }>(t.db, `SELECT provider, outcome, cost_microusd, transcript, is_test FROM calls`);
  assert.deepEqual(call, { provider: "retell", outcome: "lead_captured", cost_microusd: 125_000, transcript: null, is_test: 0 });
  assert.equal((await t.post("/api/webhooks/retell", { event: "call_ended", call: phoneCall(id, { call_status: "ended" }) })).json.duplicate, true);
  // Events the platform does not use are acknowledged and ignored.
  assert.equal((await t.post("/api/webhooks/retell", { event: "transcript_updated", call: phoneCall(id) })).json.ignored, "transcript_updated");
  assert.equal((await t.post("/api/webhooks/retell", { event: "call_started", call: { call_id: "bad id!" } })).res.status, 422);
});

test("[VOICE-006] Retell transcripts and summaries are stored only after record_consent; support routing discloses nothing", async () => {
  const t = await retellApp();
  // No consent: transcript, recording and analysis summary are discarded.
  await t.post("/api/webhooks/retell", { event: "call_started", call: phoneCall("c_noconsent") });
  await t.post("/api/webhooks/retell", { event: "call_ended", call: phoneCall("c_noconsent", { transcript: "secret words", recording_url: "https://example.com/r.wav" }) });
  await t.post("/api/webhooks/retell", { event: "call_analyzed", call: phoneCall("c_noconsent", { call_analysis: { call_summary: "caller said secret words" } }) });
  const a = await one<{ transcript: string | null; recording_url: string | null; summary: string | null; outcome: string }>(t.db, `SELECT transcript, recording_url, summary, outcome FROM calls WHERE provider_call_id = 'c_noconsent'`);
  assert.deepEqual(a, { transcript: null, recording_url: null, summary: null, outcome: "info_only" });
  // Consent recorded through the custom function: kept.
  await t.post("/api/webhooks/retell", { event: "call_started", call: phoneCall("c_consent") });
  const rc = await t.post("/api/webhooks/retell/functions", fnCall("c_consent", "record_consent", { consent: true }));
  assert.equal(rc.json.recorded, true);
  await t.post("/api/webhooks/retell/functions", fnCall("c_consent", "record_consent", { consent: false })); // cannot revoke silently
  await t.post("/api/webhooks/retell", { event: "call_ended", call: phoneCall("c_consent", { transcript: "Agent: hello", recording_url: "https://example.com/r2.wav" }) });
  await t.post("/api/webhooks/retell", { event: "call_analyzed", call: phoneCall("c_consent", { call_analysis: { call_summary: "Asked about pricing." } }) });
  const b = await one<{ transcript: string; recording_url: string; summary: string; recording_consent: number }>(t.db, `SELECT transcript, recording_url, summary, recording_consent FROM calls WHERE provider_call_id = 'c_consent'`);
  assert.deepEqual(b, { transcript: "Agent: hello", recording_url: "https://example.com/r2.wav", summary: "Asked about pricing.", recording_consent: 1 });
  // route_support: identical response for unknown and known callers.
  const cust = await createCustomer(t.db, "known@example.com");
  await t.db.prepare(`INSERT INTO contacts (id, user_id, name, email, phone, created_at) VALUES ('ct_known', ?, 'Known', 'known@example.com', '+1 555 0199', ?)`).bind(cust.id, new Date().toISOString()).run();
  const unknown = await t.post("/api/webhooks/retell/functions", fnCall("c_consent", "route_support", { name: "Someone", email: "nobody@example.com", phone: "+1 555 0111", summary: "TEST: site is down" }));
  const known = await t.post("/api/webhooks/retell/functions", fnCall("c_consent", "route_support", { name: "Known", email: "known@example.com", phone: "+1 555 0199", summary: "TEST: site is down" }));
  assert.deepEqual(unknown.json, known.json);
  assert.doesNotMatch(JSON.stringify(known.json), /Acme|ticket|known@/i);
});

// ───────────── Resend delivery events (EMAIL-003) ─────────────

async function resendApp(extra: Partial<Env> = {}) {
  const t = await createTestApp({ RESEND_WEBHOOK_SECRET: WHSEC, ...extra });
  const c = t.client();
  let n = 0;
  const post = async (payload: unknown, opts: { headers?: Record<string, string> | null; secret?: string; ts?: number; id?: string } = {}) => {
    const raw = JSON.stringify(payload);
    const id = opts.id ?? `msg_test_${++n}`;
    const h = opts.headers === undefined ? await signSvix(opts.secret ?? WHSEC, id, raw, opts.ts) : opts.headers ?? {};
    const res = await c.request("POST", "/api/webhooks/resend", { body: raw, headers: { "content-type": "application/json", ...h } });
    return { res, json: (await res.json()) as Record<string, any> };
  };
  return { ...t, post };
}
async function seedDelivery(db: Env["DB"], to: string, providerId: string, status = "sent") {
  const id = `em_${providerId}`, at = new Date().toISOString();
  await db.prepare(`INSERT INTO email_deliveries (id, template, to_email, idempotency_key, provider_message_id, status, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)`)
    .bind(id, "project_update", to, `test:${providerId}`, providerId, status, at, at).run();
  return id;
}
const evt = (type: string, emailId: string, to: string, extra: Record<string, unknown> = {}) => ({ type, created_at: new Date().toISOString(), data: { email_id: emailId, to: [to], from: "Crestmont <support@crestmontwebsitedevelopment.com>", subject: "Test", ...extra } });

test("[EMAIL-003] [SEC-002] Resend webhook verifies Svix signatures and fails closed", async () => {
  const t = await resendApp();
  const body = evt("email.delivered", "re_1", "a@example.com");
  assert.equal((await t.post(body, { headers: null })).res.status, 401, "no headers");
  assert.equal((await t.post(body, { secret: `whsec_${btoa("another-secret-another-secret!!")}` })).res.status, 401, "wrong secret");
  assert.equal((await t.post(body, { ts: Math.floor(Date.now() / 1000) - 600 })).res.status, 401, "stale timestamp");
  const raw = JSON.stringify(body);
  const good = await signSvix(WHSEC, "msg_x", raw);
  const res = await t.client().request("POST", "/api/webhooks/resend", { body: raw.replace("a@example", "b@example"), headers: good });
  assert.equal(res.status, 401, "body changed after signing");
  // Multiple space-delimited signatures: one valid v1 is enough.
  const multi = { ...good, "svix-signature": `v1,AAAA ${good["svix-signature"]}` };
  assert.equal((await t.client().request("POST", "/api/webhooks/resend", { body: raw, headers: multi })).status, 200);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_webhook_events`), 1);
  const t2 = await createTestApp();
  const r2 = await t2.client().request("POST", "/api/webhooks/resend", { body: raw, headers: good });
  assert.equal(r2.status, 401);
  assert.match(((await r2.json()) as { error: string }).error, /not configured/);
});

test("[EMAIL-003] delivery events update status idempotently per svix-id and never downgrade", async () => {
  const t = await resendApp();
  const d = await seedDelivery(t.db, "pat@example.com", "re_100");
  const delivered = evt("email.delivered", "re_100", "pat@example.com");
  assert.equal((await t.post(delivered, { id: "msg_a" })).json.outcome, "applied");
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM email_deliveries WHERE id = ?`, d)).status, "delivered");
  assert.equal((await t.post(delivered, { id: "msg_a" })).json.duplicate, true);
  await t.post(evt("email.sent", "re_100", "pat@example.com"), { id: "msg_b" }); // late "sent" after delivered
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM email_deliveries WHERE id = ?`, d)).status, "delivered");
  const d2 = await seedDelivery(t.db, "slow@example.com", "re_101");
  await t.post(evt("email.delivery_delayed", "re_101", "slow@example.com"));
  const r = await one<{ status: string; last_error: string }>(t.db, `SELECT status, last_error FROM email_deliveries WHERE id = ?`, d2);
  assert.equal(r.status, "sent");
  assert.match(r.last_error, /delayed/);
  assert.equal((await t.post(evt("email.delivered", "re_unknown", "x@example.com"))).json.outcome, "unmatched");
  assert.equal((await t.post(evt("email.opened", "re_100", "pat@example.com"))).json.outcome, "ignored");
  // Temporary bounce: failed, no suppression.
  const d3 = await seedDelivery(t.db, "full@example.com", "re_102");
  await t.post(evt("email.bounced", "re_102", "full@example.com", { bounce: { type: "Temporary", subType: "MailboxFull", message: "full" } }));
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM email_deliveries WHERE id = ?`, d3)).status, "failed");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_suppressions`), 0);
});

test("[EMAIL-003] hard bounce and complaint suppress the recipient; the next send is skipped (never sent) and staff can remove it", async () => {
  const t = await resendApp();
  const d = await seedDelivery(t.db, "Gone@Example.com", "re_200");
  const out = await t.post(evt("email.bounced", "re_200", "Gone@Example.com", { bounce: { type: "Permanent", subType: "General", message: "mailbox does not exist" } }));
  assert.deepEqual(out.json.suppressed, ["gone@example.com"]);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM email_deliveries WHERE id = ?`, d)).status, "bounced");
  await t.post(evt("email.complained", "re_unmatched", "spam@example.com"));
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_suppressions WHERE removed_at IS NULL`), 2);
  // Next send through the real Resend adapter: never reaches the provider, recorded as suppressed with the reason.
  const calls: string[] = [];
  const fakeFetch = (async (u: string | URL | Request) => { calls.push(String(u)); return new Response(JSON.stringify({ id: "re_new" }), { status: 200 }); }) as typeof fetch;
  const resend = new ResendEmail(t.db, "re_test_key", "Crestmont <support@crestmontwebsitedevelopment.com>", fakeFetch);
  const mail = { template: "security_notification" as const, to: "gone@example.com", subject: "Security notice", heading: "Security", paragraphs: ["TEST"], idempotencyKey: "sec:1" };
  const r = await sendMail({ email: resend }, mail);
  assert.equal(r.status, "suppressed");
  assert.deepEqual(calls, [], "provider was not called");
  const row = await one<{ status: string; last_error: string }>(t.db, `SELECT status, last_error FROM email_deliveries WHERE idempotency_key = 'sec:1'`);
  assert.equal(row.status, "suppressed");
  assert.match(row.last_error, /hard bounce/);
  // Development outbox respects suppression too; other recipients are unaffected.
  assert.equal((await sendMail({ email: new OutboxEmail(t.db) }, { ...mail, to: "spam@example.com", idempotencyKey: "sec:2" })).status, "suppressed");
  assert.equal((await sendMail({ email: resend }, { ...mail, to: "fine@example.com", idempotencyKey: "sec:3" })).status, "sent");
  // Staff view + removal (settings.operational), audited; sales is refused.
  const { c: sales } = await staffClient(t, "sales");
  assert.equal((await sales.get("/staff/email-suppressions")).status, 403);
  const { c: admin } = await staffClient(t, "administrator");
  const page = await (await admin.get("/staff/email-suppressions")).text();
  assert.match(page, /gone@example\.com/);
  assert.match(page, /mailbox does not exist/);
  const sup = await one<{ id: string }>(t.db, `SELECT id FROM email_suppressions WHERE email = 'gone@example.com'`);
  assert.equal((await admin.post(`/staff/email-suppressions/${sup.id}/remove`, { note: "x" })).status, 422);
  assert.equal((await admin.post(`/staff/email-suppressions/${sup.id}/remove`, { note: "Customer confirmed the new mailbox works" })).status, 303);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'email.suppression_removed'`), 1);
  assert.equal((await sendMail({ email: resend }, { ...mail, idempotencyKey: "sec:4" })).status, "sent");
  assert.equal((await admin.post(`/staff/email-suppressions/${sup.id}/remove`, { note: "again please" })).status, 422);
});

// ───────────── Cost import (FIN-002) ─────────────

async function seedProject(db: Env["DB"], orgId: string, id: string) {
  const at = new Date().toISOString();
  await db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES (?,?,?, 'design', 2, 'upfront', ?, ?)`).bind(id, orgId, `TEST project ${id}`, at, at).run();
}
async function seedAiJob(db: Env["DB"], id: string, inputRef: string, cost: number | null, o: { provider?: string; status?: string } = {}) {
  const at = new Date().toISOString();
  await db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, cost_microusd, created_at, updated_at) VALUES (?, 'project_summary', ?, 'test-model', ?, ?, ?, ?, ?)`)
    .bind(id, o.provider ?? "anthropic", o.status ?? "awaiting_approval", inputRef, cost, at, at).run();
}
async function seedPayment(db: Env["DB"], orgId: string, o: { projectId?: string | null; pi: string; fee?: number | null; amount?: number; invoiceStatus?: string; payment?: boolean; at?: string }) {
  const s = Math.random().toString(16).slice(2, 10), at = o.at ?? new Date().toISOString(), amount = o.amount ?? 99_900;
  const inv = `inv_${s}`, pay = `pay_${s}`;
  await db.prepare(`INSERT INTO invoices (id, organization_id, project_id, milestone_kind, amount_cents, status, created_at, paid_at) VALUES (?,?,?, 'change_order', ?, ?, ?, ?)`)
    .bind(inv, orgId, o.projectId ?? null, amount, o.invoiceStatus ?? "paid", at, (o.invoiceStatus ?? "paid") === "paid" ? at : null).run();
  if (o.payment !== false) {
    await db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, amount_cents, fee_cents, stripe_payment_intent_id, status, created_at) VALUES (?,?,?,?,?,?, 'succeeded', ?)`)
      .bind(pay, orgId, inv, amount, o.fee === undefined ? null : o.fee, o.pi, at).run();
  }
  return { inv, pay };
}

test("[FIN-002] AI usage costs import once per job, attributed by input_ref; unknown stays NULL", async () => {
  const t = await createTestApp();
  const cust = await createCustomer(t.db);
  await seedProject(t.db, cust.organizationId, "prj_cost");
  await seedAiJob(t.db, "ai_p1", "project:prj_cost:summary", 123_456);   // → 12 cents on the project
  await seedAiJob(t.db, "ai_p2", "project:prj_cost", null);              // → Unknown on the project
  await seedAiJob(t.db, "ai_lead", "lead:ld_x", 40_000);                 // → unattributed (project_id NULL)
  await seedAiJob(t.db, "ai_none", "project:prj_cost", null, { provider: "none", status: "failed" }); // no usage → skipped
  await seedAiJob(t.db, "ai_run", "project:prj_cost", 5, { status: "running" }); // not finished → later
  const r1 = await runCostImport(t.db, t.env);
  assert.equal(r1.aiImported, 3);
  assert.equal(r1.aiUnattributed, 1);
  assert.equal(r1.aiUnknown, 1);
  assert.equal(r1.aiSkipped, 1);
  assert.match(r1.stripe, /skipped: payments not configured/);
  const rows = (await t.db.prepare(`SELECT project_id, category, amount_cents FROM project_costs ORDER BY description`).all<{ project_id: string | null; category: string; amount_cents: number | null }>()).results;
  assert.deepEqual(rows.map((r) => [r.project_id, r.category, r.amount_cents]).sort(), [[null, "ai_usage", 4], ["prj_cost", "ai_usage", 12], ["prj_cost", "ai_usage", null]].sort());
  // Idempotent: a second run imports nothing new.
  const r2 = await runCostImport(t.db, t.env);
  assert.equal(r2.aiImported + r2.aiSkipped, 0);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM project_costs`), 3);
  // Profitability now shows the project as incomplete (unknown AI cost), never as $0.
  const { projectProfitability } = await import("../src/services/finance.ts");
  const p = (await projectProfitability(t.db, "prj_cost"))[0];
  assert.equal(p.knownCostCents, 12);
  assert.equal(p.profitCents, null);
});

test("[FIN-002] Stripe fees are read (GET only) for payments missing fee_cents, stored once and imported as project payment_fee costs", async () => {
  const calls: { url: string; method: string }[] = [];
  const fees: Record<string, unknown> = {
    pi_test_settled: { id: "pi_test_settled", status: "succeeded", latest_charge: { id: "ch_1", balance_transaction: { id: "txn_1", fee: 2927, currency: "usd" } } },
    pi_test_pending: { id: "pi_test_pending", status: "succeeded", latest_charge: { id: "ch_2", balance_transaction: null } },
  };
  const fake = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(u));
    calls.push({ url: url.pathname + url.search, method: init?.method ?? "GET" });
    const id = url.pathname.split("/").pop()!;
    return new Response(JSON.stringify(fees[id] ?? { error: { message: "No such payment_intent" } }), { status: fees[id] ? 200 : 404 });
  }) as typeof fetch;
  const t = await createTestApp({ STRIPE_SECRET_KEY: "sk_test_fake", overrides: { fetch: fake } });
  const cust = await createCustomer(t.db);
  await seedProject(t.db, cust.organizationId, "prj_fee");
  const a = await seedPayment(t.db, cust.organizationId, { projectId: "prj_fee", pi: "pi_test_settled" });
  const b = await seedPayment(t.db, cust.organizationId, { projectId: "prj_fee", pi: "pi_test_pending" });
  const c = await seedPayment(t.db, cust.organizationId, { projectId: null, pi: "pi_test_known", fee: 300 });
  const r = await runCostImport(t.db, t.env);
  assert.equal(r.feesFetched, 1);
  assert.equal(r.feesUnavailable, 1);
  assert.ok(calls.every((x) => x.method === "GET"), "read-only");
  assert.ok(calls.some((x) => x.url === "/v1/payment_intents/pi_test_settled?expand%5B%5D=latest_charge.balance_transaction"));
  assert.equal((await one<{ fee_cents: number }>(t.db, `SELECT fee_cents FROM payments WHERE id = ?`, a.pay)).fee_cents, 2927);
  assert.equal((await one<{ fee_cents: number | null }>(t.db, `SELECT fee_cents FROM payments WHERE id = ?`, b.pay)).fee_cents, null, "unsettled fee stays unknown");
  const feeCosts = (await t.db.prepare(`SELECT project_id, amount_cents FROM project_costs WHERE category = 'payment_fee'`).all<{ project_id: string; amount_cents: number }>()).results.map((x) => ({ ...x }));
  assert.deepEqual(feeCosts, [{ project_id: "prj_fee", amount_cents: 2927 }]);
  assert.equal((await one<{ project_cost_id: string | null }>(t.db, `SELECT project_cost_id FROM cost_imports WHERE source = 'stripe_fee' AND source_id = ?`, c.pay)).project_cost_id, null, "no project → ledger only");
  // Re-run: no duplicate costs, the pending one is asked again (still unknown).
  const before = calls.length;
  await runCostImport(t.db, t.env);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM project_costs WHERE category = 'payment_fee'`), 1);
  assert.deepEqual(calls.slice(before).map((x) => x.url.split("?")[0]), ["/v1/payment_intents/pi_test_pending"]);
});

// ───────────── Stripe-side reconciliation (PAY-009) ─────────────

test("[PAY-009] reconciliation is skipped when payments are not configured and refuses live keys", async () => {
  const t = await createTestApp();
  const res = await runJobs(t.env, ["stripe_side_reconcile", "cost_import"]);
  assert.equal(res.stripe_side_reconcile.ok, true);
  assert.equal(res.stripe_side_reconcile.detail, "skipped: payments not configured");
  assert.equal(res.cost_import.ok, true);
  const live = await runStripeReconciliation(t.db, { ...t.env, STRIPE_SECRET_KEY: "sk_live_nope" });
  assert.equal(live.status, "skipped");
  assert.match(live.detail, /not authorised/);
  assert.ok(SCHEDULE["17 11 * * *"].includes("stripe_side_reconcile") && SCHEDULE["17 11 * * *"].includes("cost_import"));
  const toml = readFileSync("wrangler.toml", "utf8");
  for (const cron of Object.keys(SCHEDULE)) assert.ok(toml.includes(`"${cron}"`));
});

test("[PAY-009] Stripe-side reconciliation reports discrepancies for human review and never marks anything paid", async () => {
  const now = Math.floor(Date.now() / 1000);
  const calls: string[] = [];
  let sessions: unknown[] = [];
  const fake = (async (u: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(String(u)).pathname}`);
    return new Response(JSON.stringify({ object: "list", data: sessions, has_more: false }), { status: 200 });
  }) as typeof fetch;
  const t = await createTestApp({ STRIPE_SECRET_KEY: "sk_test_fake", overrides: { fetch: fake } });
  const cust = await createCustomer(t.db);
  const unpaid = await seedPayment(t.db, cust.organizationId, { pi: "pi_test_a", invoiceStatus: "open", payment: false });
  const matched = await seedPayment(t.db, cust.organizationId, { pi: "pi_test_ok" });
  const orphan = await seedPayment(t.db, cust.organizationId, { pi: "pi_test_orphan" });
  const cs = (id: string, o: Record<string, unknown>) => ({ id, object: "checkout.session", created: now - 7200, mode: "payment", status: "complete", payment_status: "paid", amount_total: 99_900, payment_intent: null, subscription: null, metadata: {}, livemode: false, ...o });
  sessions = [
    cs("cs_test_unpaid", { payment_intent: "pi_test_a", metadata: { invoice_id: unpaid.inv } }),
    cs("cs_test_ok", { payment_intent: "pi_test_ok", metadata: { invoice_id: matched.inv } }),
    cs("cs_test_ghost", { payment_intent: "pi_test_ghost", metadata: { invoice_id: "inv_does_not_exist" } }),
    cs("cs_test_recent", { created: now - 60, payment_intent: "pi_test_r", metadata: { invoice_id: "inv_x" } }), // webhook grace period
    cs("cs_test_open", { payment_status: "unpaid", status: "open" }),
  ];
  const owner = await createStaff(t.db, "owner");
  const r1 = await runStripeReconciliation(t.db, t.env);
  assert.equal(r1.status, "ok");
  assert.equal(r1.checked, 5);
  assert.ok(calls.every((c) => c === "GET /v1/checkout/sessions"), "read-only listing");
  const kinds = (await t.db.prepare(`SELECT kind, stripe_object_id FROM reconciliation_findings WHERE status = 'open' ORDER BY kind`).all<{ kind: string; stripe_object_id: string }>()).results.map((x) => ({ ...x }));
  assert.deepEqual(kinds, [
    { kind: "paid_in_stripe_unpaid_locally", stripe_object_id: "cs_test_unpaid" },
    { kind: "paid_locally_not_in_stripe", stripe_object_id: "pi_test_orphan" },
    { kind: "unknown_local_invoice", stripe_object_id: "cs_test_ghost" },
  ]);
  // Never auto-paid: the invoice stays open and no payment row was created.
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM invoices WHERE id = ?`, unpaid.inv)).status, "open");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM payments WHERE stripe_payment_intent_id = 'pi_test_a'`), 0);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND kind = 'reconciliation_finding'`, owner.id), 3);
  // Re-run: same findings, no duplicates.
  const r2 = await runStripeReconciliation(t.db, t.env);
  assert.equal(r2.opened, 0);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM reconciliation_findings`), 3);
  // The webhook later pays the invoice → the finding clears automatically on the next run.
  await t.db.prepare(`UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?`).bind(new Date().toISOString(), unpaid.inv).run();
  await t.db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, amount_cents, stripe_payment_intent_id, status, created_at) VALUES ('pay_late', ?, ?, 99900, 'pi_test_a', 'succeeded', ?)`).bind(cust.organizationId, unpaid.inv, new Date().toISOString()).run();
  const r3 = await runStripeReconciliation(t.db, t.env);
  assert.equal(r3.cleared, 1);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM reconciliation_findings WHERE stripe_object_id = 'cs_test_unpaid'`)).status, "cleared");
  // Staff review page (finance.read): list, mark reviewed with a note; changes no money state.
  const { c: sales } = await staffClient(t, "sales");
  assert.equal((await sales.get("/staff/finance/reconciliation")).status, 403);
  const oc = t.client(); await oc.login(owner.email, TEST_PASSWORD, owner.secret);
  const page = await (await oc.get("/staff/finance/reconciliation")).text();
  assert.match(page, /cs_test_ghost/);
  assert.match(page, /Findings never change payment state/);
  const f = await one<{ id: string }>(t.db, `SELECT id FROM reconciliation_findings WHERE stripe_object_id = 'cs_test_ghost'`);
  assert.equal((await oc.post(`/staff/finance/reconciliation/${f.id}/resolve`, { note: "no" })).status, 422);
  assert.equal((await oc.post(`/staff/finance/reconciliation/${f.id}/resolve`, { note: "Test-mode session from a deleted invoice; nothing owed." })).status, 303);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM reconciliation_findings WHERE id = ?`, f.id)).status, "resolved");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'reconciliation.finding_resolved'`), 1);
  assert.equal((await oc.get("/staff/finance/reconciliation?view=costs")).status, 200);
});

// ───────────── Integration health ─────────────

test("[VOICE-003] [EMAIL-003] retell and resend_webhooks integrations are not_configured until their secrets exist", async () => {
  const t = await createTestApp();
  const rows = await refreshIntegrationHealth({ db: t.db, env: t.env, storage: null });
  assert.equal(rows.find((r) => r.integration === "retell")!.status, "not_configured");
  assert.equal(rows.find((r) => r.integration === "resend_webhooks")!.status, "not_configured");
  const rows2 = await refreshIntegrationHealth({ db: t.db, env: { ...t.env, RETELL_API_KEY: RETELL_KEY, RESEND_WEBHOOK_SECRET: WHSEC }, storage: null });
  assert.equal(rows2.find((r) => r.integration === "retell")!.status, "configured_unverified");
  assert.equal(rows2.find((r) => r.integration === "resend_webhooks")!.status, "configured_unverified");
  const p = secretPresence({ ...t.env, RETELL_API_KEY: RETELL_KEY });
  assert.equal(p.find((x) => x.name === "RETELL_API_KEY")!.present, true);
  assert.equal(p.find((x) => x.name === "RESEND_WEBHOOK_SECRET")!.present, false);
});
