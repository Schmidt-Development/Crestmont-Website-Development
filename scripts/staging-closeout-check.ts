// Reads staging D1 after tests/e2e/staging-closeout.e2e.ts and reports what actually happened, as PASS / FAIL /
// PENDING / BLOCKED lines plus evidence (.github/workflows/staging-closeout-verify.yml). SELECT only; never prints a
// secret or an email body. Exit 1 on any FAIL; PENDING (e.g. accepted by Resend, delivery webhook not yet arrived)
// and BLOCKED (an external precondition) are reported but are not failures of the code.
//
//   email    the internal new-lead email for the run's test lead: queued → accepted by Resend (message id) →
//            delivered (Resend's signed delivery webhook), plus Resend's 7-day record on staging
//   gate     the run's subscription: Stripe events processed, subscription active, first payment recorded, activation
//            active, handoff published only after it
//   ai       the run's AI draft jobs (provider, model, status) and the self-hosted runner's last heartbeat
//   health   every integration row staging recorded
//   calls    real inbound receptionist calls on staging: count, durations, provider ids, costs
import { readFileSync, writeFileSync } from "node:fs";
import { wranglerOps } from "./staging-access.ts";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const runFile = arg("run") ?? "access/closeout-run.json";
const out = arg("out") ?? "evidence/staging-closeout.json";
const waitMs = Number(arg("wait-ms") ?? 180_000);
const d1 = wranglerOps();
const q = <T = Record<string, unknown>>(sql: string) => d1.query<T>(sql);
const lit = (s: string | null | undefined) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);

type Verdict = "PASS" | "FAIL" | "PENDING" | "BLOCKED" | "INFO";
const results: { check: string; verdict: Verdict; detail: string }[] = [];
const report = (check: string, verdict: Verdict, detail: string) => { results.push({ check, verdict, detail }); console.log(`${verdict} ${check} — ${detail}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let run: { run?: string; orgId?: string; projectId?: string; leadId?: string; ticketId?: string; startedAt?: string; handoffPublished?: boolean } = {};
try { run = JSON.parse(readFileSync(runFile, "utf8")); } catch { report("run_file", "FAIL", `${runFile} is missing: the browser verification did not start`); }
const since = run.startedAt ?? new Date(Date.now() - 3_600_000).toISOString();

// ── email ──
if (run.leadId) {
  const key = `internal:new_lead:${run.leadId}`;
  type Row = { id: string; status: string; provider: string | null; provider_message_id: string | null; last_error: string | null; attempts: number; to_email: string };
  const read = async () => (await q<Row>(`SELECT d.id, d.status, m.provider, d.provider_message_id, d.last_error, d.attempts, d.to_email FROM email_deliveries d LEFT JOIN email_messages m ON m.delivery_id = d.id WHERE d.idempotency_key = ${lit(key)}`))[0];
  let row = await read();
  const end = Date.now() + waitMs;
  while (row && row.provider === "resend" && ["queued", "sent"].includes(row.status) && Date.now() < end) { await sleep(10_000); row = await read(); }
  if (!row) report("email_internal_new_lead", "FAIL", `no email was created for the test lead (${key})`);
  else if (row.to_email !== "crestmontwebsitedevelopment@gmail.com") report("email_internal_new_lead", "FAIL", `addressed to ${row.to_email}, not the internal mailbox`);
  else if (row.provider === "dev-outbox") report("email_internal_new_lead", "FAIL", `held, never sent: ${row.last_error ?? "the Worker uses the development outbox"}`);
  else if (row.status === "delivered") report("email_internal_new_lead", "PASS", `accepted by Resend (message ${row.provider_message_id}) and delivery confirmed by Resend's signed webhook`);
  else if (row.status === "sent") report("email_internal_new_lead", "PENDING", `accepted by Resend (message ${row.provider_message_id}); no delivery webhook within ${waitMs / 1000}s`);
  else if (row.status === "bounced") report("email_internal_new_lead", "FAIL", `Resend reported a bounce for the internal mailbox (message ${row.provider_message_id})`);
  else report("email_internal_new_lead", "FAIL", `status ${row.status} after ${row.attempts} attempt(s): ${row.last_error ?? "no error recorded"}`);
  if (row?.provider_message_id) {
    const ev = await q<{ type: string; outcome: string; received_at: string }>(`SELECT type, outcome, received_at FROM email_webhook_events WHERE provider_message_id = ${lit(row.provider_message_id)} ORDER BY received_at`);
    report("email_webhook_events", ev.length ? "INFO" : "PENDING", ev.length ? ev.map((e) => `${e.type} (${e.outcome}) ${e.received_at}`).join("; ") : "Resend has not posted a delivery event for this message yet");
  }
} else report("email_internal_new_lead", "FAIL", "the browser run recorded no test lead");
const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
const agg = await q<{ status: string; n: number }>(`SELECT d.status, COUNT(*) AS n FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE m.provider = 'resend' AND d.created_at >= ${lit(week)} GROUP BY d.status`);
const errs = await q<{ e: string; n: number }>(`SELECT substr(d.last_error, 1, 120) AS e, COUNT(*) AS n FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE m.provider = 'resend' AND d.created_at >= ${lit(week)} AND d.last_error IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 3`);
report("email_resend_7_days", "INFO", `${agg.map((a) => `${a.status} ×${a.n}`).join(", ") || "no Resend sends"}${errs.length ? `; errors: ${errs.map((e) => `${e.e} ×${e.n}`).join("; ")}` : ""}`);

// ── launch gate ──
if (run.orgId && run.projectId) {
  const sub = (await q<{ id: string; status: string; stripe_subscription_id: string | null; product_id: string }>(`SELECT id, status, stripe_subscription_id, product_id FROM subscriptions WHERE organization_id = ${lit(run.orgId)} ORDER BY created_at DESC LIMIT 1`))[0];
  if (!sub) report("gate_subscription", "FAIL", "no subscription was recorded for the run's customer (no signed customer.subscription.* webhook applied)");
  else {
    report("gate_subscription", sub.status === "active" ? "PASS" : "FAIL", `${sub.product_id} subscription ${sub.status} (Stripe ${sub.stripe_subscription_id?.slice(0, 8)}…)`);
    const first = (await q<{ paid_at: string; amount_cents: number; reversed_at: string | null }>(`SELECT paid_at, amount_cents, reversed_at FROM subscription_initial_payments WHERE stripe_subscription_id = ${lit(sub.stripe_subscription_id)}`))[0];
    report("gate_first_payment", first && !first.reversed_at ? "PASS" : "FAIL", first ? `first payment $${(first.amount_cents / 100).toFixed(2)} confirmed ${first.paid_at}` : "no first payment recorded from a signed invoice.paid webhook");
    const evs = await q<{ type: string; status: string; n: number }>(`SELECT type, status, COUNT(*) AS n FROM stripe_events WHERE received_at >= ${lit(since)} AND (payload LIKE ${lit(`%${sub.stripe_subscription_id}%`)} OR payload LIKE ${lit(`%${run.orgId}%`)}) GROUP BY type, status ORDER BY type`);
    const bad = evs.filter((e) => ["failed", "dead_letter"].includes(e.status));
    report("gate_stripe_events", bad.length ? "FAIL" : evs.length ? "PASS" : "FAIL", evs.map((e) => `${e.type} ${e.status} ×${e.n}`).join(", ") || "no Stripe events for this subscription");
  }
  const act = (await q<{ status: string; activated_at: string | null }>(`SELECT status, activated_at FROM maintenance_activations WHERE project_id = ${lit(run.projectId)}`))[0];
  report("gate_activation", act?.status === "active" ? "PASS" : "FAIL", `maintenance activation ${act?.status ?? "missing"}${act?.activated_at ? ` at ${act.activated_at}` : ""}`);
  const ho = (await q<{ published_at: string | null }>(`SELECT published_at FROM handoffs WHERE project_id = ${lit(run.projectId)}`))[0];
  const firstPay = (await q<{ paid_at: string }>(`SELECT i.paid_at FROM subscription_initial_payments i JOIN subscriptions s ON s.stripe_subscription_id = i.stripe_subscription_id WHERE s.organization_id = ${lit(run.orgId)}`))[0];
  if (!ho?.published_at) report("gate_handoff_after_payment", run.handoffPublished ? "FAIL" : "FAIL", "the handoff was not published");
  else report("gate_handoff_after_payment", firstPay && ho.published_at >= firstPay.paid_at ? "PASS" : "FAIL", `handoff published ${ho.published_at}, after the first payment ${firstPay?.paid_at ?? "(none)"}`);
  const refused = await q<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_logs WHERE subject_id = ${lit(run.projectId)} AND action = 'project.handoff_published'`);
  report("gate_publish_audit", "INFO", `handoff publications audited for the project: ${refused[0]?.n ?? 0}`);
}

// ── AI drafts ──
const jobs = await q<{ id: string; provider: string; model: string; status: string; error: string | null; input_ref: string; created_at: string; updated_at: string }>(
  `SELECT id, provider, model, status, error, input_ref, created_at, updated_at FROM ai_jobs WHERE workflow = 'support_reply' AND created_at >= ${lit(since)} ORDER BY created_at`);
for (const j of jobs) report(`ai_draft ${j.input_ref.split(":")[0]}`, j.status === "awaiting_approval" || j.status === "completed" || j.status === "approved" ? "PASS" : j.status === "failed" ? "FAIL" : "PENDING", `${j.provider}/${j.model} ${j.status}${j.error ? `: ${j.error.slice(0, 160)}` : ""} (${j.created_at} → ${j.updated_at})`);
if (!jobs.length) report("ai_draft", "FAIL", "no AI draft job was created during the run");
if (run.ticketId) {
  const sent = await q<{ n: number }>(`SELECT COUNT(*) AS n FROM ticket_messages m JOIN memberships mb ON mb.user_id = m.author_user_id JOIN organizations o ON o.id = mb.organization_id AND o.kind = 'internal' WHERE m.ticket_id = ${lit(run.ticketId)} AND m.internal = 0`);
  report("ai_draft_not_sent", (sent[0]?.n ?? 0) === 0 ? "PASS" : "FAIL", `${sent[0]?.n ?? 0} staff reply(ies) on the test ticket: a draft is never sent by itself`);
}
const runner = (await q<{ runner_id: string; last_seen_at: string; capabilities: string | null }>(`SELECT runner_id, last_seen_at, capabilities FROM build_runners ORDER BY last_seen_at DESC LIMIT 1`))[0];
report("ai_self_hosted_runner", runner && Date.now() - Date.parse(runner.last_seen_at) < 10 * 60_000 ? "INFO" : "BLOCKED", runner ? `last heartbeat ${runner.last_seen_at} from ${runner.runner_id}` : "no self-hosted runner has ever checked in on staging");

// ── integration health (staging) ──
const health = await q<{ integration: string; status: string; detail: string | null; checked_at: string }>(`SELECT integration, status, detail, checked_at FROM integration_health WHERE environment = 'staging' ORDER BY integration`);
for (const h of health) report(`health ${h.integration}`, "INFO", `${h.status} (${h.checked_at}): ${(h.detail ?? "").slice(0, 300)}`);

// ── real receptionist calls ──
const calls = await q<{ n: number; with_cost: number; with_duration: number; with_provider_id: number; total_cost: number | null; first_at: string | null; last_at: string | null }>(
  `SELECT COUNT(*) AS n, COALESCE(SUM(cost_microusd IS NOT NULL), 0) AS with_cost, COALESCE(SUM(duration_ms IS NOT NULL), 0) AS with_duration, COALESCE(SUM(provider_call_id IS NOT NULL), 0) AS with_provider_id,
     SUM(cost_microusd) AS total_cost, MIN(started_at) AS first_at, MAX(started_at) AS last_at FROM calls WHERE provider = 'retell' AND is_test = 0`);
const c = calls[0];
report("calls_real", "INFO", c?.n ? `${c.n} real Retell call(s) on staging (${c.first_at} → ${c.last_at}); duration on ${c.with_duration}, provider call id on ${c.with_provider_id}, provider cost on ${c.with_cost} (total $${((c.total_cost ?? 0) / 1e6).toFixed(4)})` : "no real (non-test) Retell call is recorded on staging");
const dup = await q<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT provider_call_id FROM calls WHERE provider_call_id IS NOT NULL GROUP BY provider_call_id HAVING COUNT(*) > 1)`);
report("calls_no_duplicates", (dup[0]?.n ?? 0) === 0 ? "PASS" : "FAIL", `${dup[0]?.n ?? 0} provider call id(s) recorded more than once`);

writeFileSync(out, JSON.stringify({ run: run.run ?? null, checkedAt: new Date().toISOString(), results }, null, 2));
const n = (v: Verdict) => results.filter((r) => r.verdict === v).length;
console.log(`Staging closeout check: ${n("PASS")} passed, ${n("FAIL")} failed, ${n("PENDING")} pending, ${n("BLOCKED")} blocked, ${n("INFO")} informational`);
process.exit(n("FAIL") ? 1 : 0);
