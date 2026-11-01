// Outbound AI sales agent — live staging verification. Runs in .github/workflows/deploy-staging.yml after the deploy and
// on demand (.github/workflows/outbound-staging-verify.yml), against the deployed Worker, the real staging D1 and (when
// the staging environment holds RETELL_OUTBOUND_API_KEY) the real outbound Retell workspace — READ-ONLY there.
//
// NOTHING IS DIALLED: no create-phone-call request is ever made. Synthetic leads use fictional 555-01xx numbers and an
// allowlisted @crestmontwebsitedevelopment.com address; every synthetic record is marked [TEST DATA] / is_test.
// The repository is public: output is PASS / FAIL / BLOCKED lines with ids and counts only (no keys, agent ids or prompts).
//
//   env: E2E_BASE_URL, CLOUDFLARE_API_TOKEN/ACCOUNT_ID (D1 via wrangler), ACCESS_ROOT_KEY (= the Cloudflare token: signs
//        the Worker's own read-only Retell audit), optional RETELL_OUTBOUND_API_KEY and RETELL_INBOUND_API_KEY
//   node --no-warnings scripts/outbound-staging-e2e.ts
// Exit 1 only for an engineering failure (FAIL). Missing external configuration is BLOCKED (exit 0) and named exactly.
import { writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { wranglerOps } from "./staging-access.ts";
import { signRetell } from "../src/adapters/retell.ts";
import { deriveSchedulerKey, sign } from "./trigger-scheduler.ts";

const BASE = (process.env.E2E_BASE_URL ?? "").replace(/\/$/, "");
const OUT_KEY = process.env.RETELL_OUTBOUND_API_KEY ?? "";
const IN_KEY = process.env.RETELL_INBOUND_API_KEY ?? "";
if (!BASE) { console.error("::error::E2E_BASE_URL is required"); process.exit(2); }
const FN_URL = `${BASE}/api/webhooks/retell/outbound/functions`;
const HOOK_URL = `${BASE}/api/webhooks/retell`;
const CONSENT_URL = `${BASE}/api/webhooks/retell/functions`;
/** The environment the target Worker stamps (staging in CI; "development" when rehearsed against dev/server.ts). */
const ENV_NAME = process.env.E2E_ENVIRONMENT ?? "staging";
const RUN = `e2e${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const d1 = wranglerOps();
const q = async <T = Record<string, unknown>>(sql: string) => d1.query<T>(sql);
const lit = (s: string | null) => (s === null ? "NULL" : `'${s.replace(/'/g, "''")}'`);

type Status = "PASS" | "FAIL" | "BLOCKED";
const results: { id: string; status: Status; detail: string }[] = [];
class Blocked extends Error {}
async function check(id: string, f: () => Promise<string | void>) {
  try { const d = (await f()) ?? ""; results.push({ id, status: "PASS", detail: d }); console.log(`PASS ${id}${d ? ` — ${d}` : ""}`); }
  catch (e) {
    const status: Status = e instanceof Blocked ? "BLOCKED" : "FAIL";
    const d = String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 300);
    results.push({ id, status, detail: d }); console.log(`${status} ${id} — ${d}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

/**
 * Signer: "outbound" / "inbound" mean the Retell workspace keys. With the keys in the CI environment the request is signed
 * here; otherwise the staging Worker signs it with ITS OWN key (POST /api/sales-outbound/test-dispatch, scheduler-signed,
 * synthetic is_test calls only) — a "Worker-signed" staging test: same route, signature check, handlers and D1.
 * Any other string is used as a literal (wrong) key; null sends the request unsigned.
 */
const ROOT = process.env.ACCESS_ROOT_KEY ?? "";
export const SIGNER: "github" | "worker" | null = OUT_KEY ? "github" : ROOT ? "worker" : null;
async function post(url: string, payload: unknown, key: "outbound" | "inbound" | string | null, query = "") {
  const raw = JSON.stringify(payload);
  const named = key === "outbound" ? OUT_KEY : key === "inbound" ? IN_KEY : key;
  if ((key === "outbound" || key === "inbound") && !named && ROOT) {
    const target = url === FN_URL ? "outbound_functions" : url === HOOK_URL ? "webhook" : url === CONSENT_URL ? "functions" : null;
    if (!target) throw new Error(`no Worker dispatch target for ${url}`);
    const body = JSON.stringify({ key, target, payload, query });
    const res = await fetch(`${BASE}/api/sales-outbound/test-dispatch`, { method: "POST", headers: { "content-type": "application/json", "x-crestmont-scheduler-signature": sign(deriveSchedulerKey(ROOT), body) }, body });
    const j = await res.json().catch(() => ({})) as { status?: number; json?: Record<string, unknown>; error?: string };
    if (res.status !== 200) throw new Error(`test-dispatch answered ${res.status} ${j.error ?? ""}`);
    return { status: j.status ?? 0, json: (j.json ?? {}) as Record<string, unknown> };
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (named) headers["x-retell-signature"] = await signRetell(named, raw);
  const res = await fetch(url + query, { method: "POST", headers, body: raw });
  let json: Record<string, unknown> = {};
  try { json = await res.json() as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.status, json };
}
const call = (callId: string, salesId: string, extra: Record<string, unknown> = {}) => ({ call_id: callId, call_type: "phone_call", direction: "outbound",
  from_number: "+16145550100", to_number: "+16145550101", metadata: { crestmont_env: ENV_NAME, crestmont_sales_call_id: salesId, crestmont_test: "true" }, ...extra });
const fn = (callId: string, salesId: string, name: string, args: Record<string, unknown>) => ({ name, call: call(callId, salesId), args });

/** One synthetic CRM lead + a sales call row in 'dialing' (what the dialler writes just before Retell answers). */
async function syntheticCall(tag: string): Promise<{ leadId: string; salesId: string; callId: string; phone: string }> {
  const n = 100 + (parseInt(randomBytes(1).toString("hex"), 16) % 100);
  const phone = `+1614555${String(n).padStart(4, "0")}`;
  const id = (p: string) => `${p}_${RUN}${tag}`;
  const at = new Date().toISOString();
  await q(`INSERT INTO companies (id, name, industry, created_at) VALUES (${lit(id("co"))}, ${lit(`Outbound E2E Bakery ${RUN}${tag} (TEST DATA)`)}, 'bakery', ${lit(at)})`);
  await q(`INSERT INTO contacts (id, company_id, name, phone, created_at) VALUES (${lit(id("ct"))}, ${lit(id("co"))}, ${lit(`Outbound E2E Bakery ${RUN}${tag} (TEST DATA)`)}, ${lit(phone)}, ${lit(at)})`);
  await q(`INSERT INTO leads (id, contact_id, source, stage, interest, message, created_at, updated_at) VALUES (${lit(id("ld"))}, ${lit(id("ct"))}, 'manual', 'new', 'starter', '[TEST DATA] outbound staging E2E', ${lit(at)}, ${lit(at)})`);
  await q(`INSERT INTO sales_calls (id, lead_id, phone_e164, status, attempts, idempotency_key, is_test, created_at, updated_at) VALUES (${lit(id("scall"))}, ${lit(id("ld"))}, ${lit(phone)}, 'dialing', 1, ${lit(`crestmont_${id("scall")}`)}, 1, ${lit(at)}, ${lit(at)})`);
  return { leadId: id("ld"), salesId: id("scall"), callId: `call_${RUN}${tag}`, phone };
}

/**
 * The main synthetic lead enters the CRM the way a real one does (public lead API → CRM intake engine, so identity links
 * and duplicate protection apply); then the sales call row the dialler would have written is added. Staging uses
 * Cloudflare's documented always-pass Turnstile test keys, so the dummy token is accepted.
 */
async function syntheticIntakeCall(email: string): Promise<{ leadId: string; salesId: string; callId: string; phone: string }> {
  const n = 100 + (parseInt(randomBytes(1).toString("hex"), 16) % 100);
  const phone = `+1614555${String(n).padStart(4, "0")}`;
  const res = await fetch(`${BASE}/api/leads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    name: "Pat Tester (TEST DATA)", email, phone, company: `Outbound E2E Bakery ${RUN} (TEST DATA)`, interest: "starter",
    message: "[TEST DATA] outbound staging E2E synthetic lead; nothing is dialled", source: "web_form", turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" }) });
  const body = await res.json().catch(() => ({})) as { leadId?: string; error?: string };
  assert(res.status === 201 && body.leadId, `public lead API returned ${res.status} ${body.error ?? ""}`);
  const salesId = `scall_${RUN}a`, at = new Date().toISOString();
  await q(`INSERT INTO sales_calls (id, lead_id, phone_e164, status, attempts, idempotency_key, is_test, created_at, updated_at) VALUES (${lit(salesId)}, ${lit(body.leadId)}, ${lit(phone)}, 'dialing', 1, ${lit(`crestmont_${salesId}`)}, 1, ${lit(at)}, ${lit(at)})`);
  return { leadId: body.leadId, salesId, callId: `call_${RUN}a`, phone };
}

async function main() {
  // ── 1. Deployment and authentication ──
  await check("route_deployed_and_fails_closed", async () => {
    const r = await post(FN_URL, { name: "get_packages_pricing", call: { call_id: "x" }, args: {} }, null);
    assert(r.status !== 404, "the outbound functions route is not deployed (404)");
    assert(r.status === 401, `an unsigned request returned ${r.status}, expected 401`);
    return "unsigned → 401";
  });
  await check("migration_applied", async () => {
    const t = await q<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sales_calls','sales_function_events','sales_outbound_settings')`);
    assert(t.length === 3, `only ${t.length}/3 outbound tables exist in staging D1`);
    const s = await q<{ enabled: number }>(`SELECT enabled FROM sales_outbound_settings WHERE id = 1`);
    return `tables present; outbound switch ${s[0]?.enabled ? "ON" : "off"}`;
  });
  await check("bogus_signature_rejected", async () => {
    const r = await post(FN_URL, { name: "get_packages_pricing", call: { call_id: "x" }, args: {} }, "key_wrong_workspace_000000000000");
    assert(r.status === 401, `a request signed with an unknown key returned ${r.status}`);
  });
  if (IN_KEY || SIGNER === "worker") await check("inbound_workspace_key_rejected", async () => {
    // A synthetic call id: the Worker signer only dispatches call_e2e… ids (and the route must refuse the inbound key anyway).
    const r = await post(FN_URL, { name: "get_packages_pricing", call: { call_id: `call_${RUN}k` }, args: {} }, "inbound");
    assert(r.status === 401, `a request signed with the receptionist's workspace key returned ${r.status}`);
  });
  await workerRetellAudit();
  if (!SIGNER) {
    await check("outbound_workspace_key", async () => { throw new Blocked("neither RETELL_OUTBOUND_API_KEY (GitHub staging secret) nor ACCESS_ROOT_KEY (Worker-signed tests) is available"); });
    return;
  }
  console.log(`Signed tests: ${SIGNER === "github" ? "signed in CI with the GitHub staging secret" : "Worker-signed (the staging Worker signs synthetic requests with its own Retell keys)"}`);
  await check("worker_has_outbound_key", async () => {
    const r = await post(FN_URL, { name: "get_outbound_lead_context", call: { call_id: `call_${RUN}u`, metadata: { crestmont_env: ENV_NAME } }, args: {} }, "outbound");
    if (r.status === 401) throw new Blocked("the staging Worker rejects the outbound workspace signature: RETELL_OUTBOUND_API_KEY is not set on the Worker or differs from the GitHub secret");
    if (r.status === 403 && SIGNER === "worker" && r.json.refused !== "unbound_call") throw new Error(`unexpected ${JSON.stringify(r.json).slice(0, 120)}`);
    assert(r.status === 403 && r.json.refused === "unbound_call", `expected 403 unbound_call, got ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    return "signed by the outbound workspace; an unbound call is refused";
  });

  // ── 2. Functions end to end on staging D1 (synthetic lead) ──
  const email = `outbound-e2e+${RUN}@crestmontwebsitedevelopment.com`;
  let a: Awaited<ReturnType<typeof syntheticCall>> | null = null;
  await check("synthetic_lead_via_crm_intake", async () => { a = await syntheticIntakeCall(email); return "1 lead through the public lead API (CRM intake), 1 sales call (dialing)"; });
  if (!a) return;
  const A = a as Awaited<ReturnType<typeof syntheticCall>>;
  await check("fn_get_outbound_lead_context", async () => {
    const r = await post(FN_URL, fn(A.callId, A.salesId, "get_outbound_lead_context", {}), "outbound", `?lead_id=${A.leadId}`);
    assert(r.status === 200 && r.json.lead_id === A.leadId, `got ${r.status}`);
    assert(r.json.website_classification === "unknown" && r.json.research_verified === false, "an unresearched lead must be neutral");
    assert(!JSON.stringify(r.json).includes(A.phone), "the phone number must not be returned to the agent");
    const bound = await q<{ provider_call_id: string }>(`SELECT provider_call_id FROM sales_calls WHERE id = ${lit(A.salesId)}`);
    assert(bound[0]?.provider_call_id === A.callId, "the Retell call id was not bound to the sales call");
    return "verified-only context; call bound";
  });
  await check("fn_cross_lead_refused", async () => {
    const r = await post(FN_URL, fn(A.callId, A.salesId, "get_outbound_lead_context", { lead_id: "ld_someone_else" }), "outbound");
    assert(r.status === 403 && r.json.refused === "lead_mismatch", `got ${r.status} ${String(r.json.refused)}`);
  });
  await check("fn_get_packages_pricing", async () => {
    const r = await post(FN_URL, fn(A.callId, A.salesId, "get_packages_pricing", {}), "outbound");
    const pk = (r.json.packages as { id: string; price: string }[] | undefined) ?? [];
    assert(r.status === 200 && pk.length === 3, `got ${r.status}, ${pk.length} packages`);
    return pk.map((p) => `${p.id} ${p.price}`).join(", ");
  });
  await check("fn_update_outbound_lead_via_crm_intake", async () => {
    const args = { contact_name: "Pat Tester", contact_email: email, discovery_notes: "Synthetic staging E2E (TEST DATA)", qualification: "qualified", service_interests: ["starter"] };
    const r = await post(FN_URL, fn(A.callId, A.salesId, "update_outbound_lead", args), "outbound");
    assert(r.status === 200 && r.json.contact_verification === "verified", `got ${r.status} ${String(r.json.contact_verification)}`);
    const again = await post(FN_URL, fn(A.callId, A.salesId, "update_outbound_lead", args), "outbound");
    assert(again.json.duplicate === true, "an identical retry was not replayed (idempotency)");
    const leads = await q<{ n: number }>(`SELECT COUNT(*) AS n FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE c.phone = ${lit(A.phone)} AND l.message LIKE '[TEST DATA] outbound%'`);
    const stage = await q<{ stage: string }>(`SELECT stage FROM leads WHERE id = ${lit(A.leadId)}`);
    assert(stage[0]?.stage === "qualified", `stage is ${stage[0]?.stage}`);
    return `verified; replayed on retry; ${leads[0]?.n} lead for the number; stage qualified`;
  });
  await check("fn_create_checkout_session", async () => {
    const r = await post(FN_URL, fn(A.callId, A.salesId, "create_checkout_session", { package: "starter", email, buyer_confirmed: true }), "outbound");
    assert(r.status === 200, `got ${r.status}`);
    if (r.json.reason === "payments_not_configured") throw new Blocked("Stripe test mode is not configured on staging (BLK-004): the handler answered payments_not_configured correctly");
    assert(r.json.checkout_link_sent === true || r.json.checkout_reference, `unexpected ${JSON.stringify(r.json).slice(0, 160)}`);
    const dup = await post(FN_URL, fn(A.callId, A.salesId, "create_checkout_session", { package: "starter", email, buyer_confirmed: true }), "outbound");
    assert(dup.json.duplicate === true || dup.json.already_sent_today === true, "a duplicate checkout request created a second link");
    if (typeof r.json.checkout_url === "string") {
      const buy = await fetch(r.json.checkout_url as string, { redirect: "manual" });
      assert(buy.status === 303 && (buy.headers.get("location") ?? "").includes("/checkout/starter"), `purchase link answered ${buy.status}`);
      assert(/crestmont_sales_link=[0-9a-f]{64};.*HttpOnly/i.test(buy.headers.get("set-cookie") ?? ""), "the purchase link did not set the lead-binding cookie (checkout → CRM lead association)");
    }
    return `link ${r.json.delivery ?? "created"}; duplicate refused; link opens /checkout/starter and binds the checkout to lead ${A.leadId}`;
  });
  await check("fn_check_payment_status_never_assumes_paid", async () => {
    const r = await post(FN_URL, fn(A.callId, A.salesId, "check_payment_status", {}), "outbound");
    assert(r.status === 200 && r.json.payment_status !== "paid", `got ${r.status} ${String(r.json.payment_status)}`);
    return String(r.json.payment_status);
  });
  await check("fn_schedule_sales_followup_once", async () => {
    const args = { followup_type: "staff_callback", preferred_date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10), preferred_time: "morning", topic: "TEST DATA", prospect_agreed: true };
    const r = await post(FN_URL, fn(A.callId, A.salesId, "schedule_sales_followup", args), "outbound");
    assert(r.status === 200 && r.json.scheduled === true, `got ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    const dup = await post(FN_URL, fn(A.callId, A.salesId, "schedule_sales_followup", { ...args, preferred_time: "afternoon" }), "outbound");
    assert(dup.json.already_scheduled === true, "a second follow-up of the same kind was created");
  });
  await check("fn_send_sales_email_policy", async () => {
    const bad = await post(FN_URL, fn(A.callId, A.salesId, "send_sales_email", { email_type: "package_information", email: "someone@example.com" }), "outbound");
    assert(bad.json.reason === "email_not_verified", "an unverified recipient was accepted");
    const r = await post(FN_URL, fn(A.callId, A.salesId, "send_sales_email", { email_type: "package_information", email }), "outbound");
    assert(r.status === 200, `got ${r.status}`);
    return `unverified recipient refused; allowlisted recipient → ${String(r.json.delivery ?? r.json.reason)}`;
  });
  await check("webhook_status_and_outcome_once", async () => {
    const s = await post(HOOK_URL, { event: "call_started", call: call(A.callId, A.salesId) }, "outbound");
    assert(s.status === 200, `call_started → ${s.status}`);
    const st = await q<{ status: string }>(`SELECT status FROM sales_calls WHERE id = ${lit(A.salesId)}`);
    assert(st[0]?.status === "in_progress", `status ${st[0]?.status}`);
    const ended = { event: "call_ended", call: call(A.callId, A.salesId, { disconnection_reason: "agent_hangup", call_status: "ended", duration_ms: 123000, transcript: "Agent: TEST\nUser: TEST" }) };
    assert((await post(HOOK_URL, ended, "outbound")).status === 200, "call_ended rejected");
    const row = await q<{ outcome: string; outcome_source: string; finalized_at: string }>(`SELECT outcome, outcome_source, finalized_at FROM sales_calls WHERE id = ${lit(A.salesId)}`);
    assert(row[0]?.finalized_at && row[0].outcome, "no final outcome recorded");
    assert((await post(HOOK_URL, ended, "outbound")).status === 200, "duplicate call_ended rejected");
    const audits = await q<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'sales_outbound.outcome' AND subject_id = ${lit(A.salesId)}`);
    assert(Number(audits[0]?.n) === 1, `outcome written ${audits[0]?.n} times`);
    return `outcome ${row[0].outcome} (${row[0].outcome_source}); duplicate ignored`;
  });
  if (IN_KEY || SIGNER === "worker") await check("inbound_signed_event_cannot_touch_sales_queue", async () => {
    const b = await syntheticCall("i");
    await post(HOOK_URL, { event: "call_started", call: call(b.callId, b.salesId) }, "inbound");
    const st = await q<{ status: string }>(`SELECT status FROM sales_calls WHERE id = ${lit(b.salesId)}`);
    assert(st[0]?.status === "dialing", `an inbound-signed event changed the sales call to ${st[0]?.status}`);
  });
  await check("fn_record_do_not_call_everywhere", async () => {
    const c = await syntheticCall("d");
    const r = await post(FN_URL, fn(c.callId, c.salesId, "record_do_not_call", {}), "outbound");
    assert(r.status === 200 && r.json.recorded === true, `got ${r.status}`);
    const dnc = await q<{ n: number }>(`SELECT COUNT(*) AS n FROM voice_dnc WHERE phone_e164 = ${lit(c.phone)}`);
    assert(Number(dnc[0]?.n) === 1, "the number is not on voice_dnc");
    return "number on the shared do-not-call list";
  });
  await check("record_consent_granted_and_declined_shared_endpoint", async () => {
    const g = await syntheticCall("c");
    const yes = await post(CONSENT_URL, { name: "record_consent", call: call(g.callId, g.salesId), args: { consent: true } }, "outbound");
    assert(yes.status === 200 && yes.json.recorded === true, `granted → ${yes.status} ${JSON.stringify(yes.json).slice(0, 120)}`);
    const row = await q<{ consent: number }>(`SELECT consent FROM retell_call_consents WHERE provider_call_id = ${lit(g.callId)}`);
    assert(Number(row[0]?.consent) === 1, "consent not stored");
    const h = await syntheticCall("n");
    const no = await post(CONSENT_URL, { name: "record_consent", call: call(h.callId, h.salesId), args: { consent: false } }, "outbound");
    assert(no.status === 200 && /won't keep a recording/.test(String(no.json.message)), `declined → ${no.status}`);
    return "outbound workspace may call record_consent on the shared endpoint; granted stored, declined message returned";
  });
  await check("outbound_key_cannot_run_receptionist_function", async () => {
    const g = await syntheticCall("x");
    const r = await post(CONSENT_URL, { name: "create_lead", call: call(g.callId, g.salesId), args: { name: "TEST", phone: g.phone } }, "outbound");
    assert(r.status === 403, `an outbound-signed receptionist function returned ${r.status}`);
  });
  await check("webhook_wrong_number_outcome", async () => {
    const w = await syntheticCall("w");
    await post(FN_URL, fn(w.callId, w.salesId, "update_outbound_lead", { sales_outcome: "wrong_number" }), "outbound");
    await post(HOOK_URL, { event: "call_ended", call: call(w.callId, w.salesId, { disconnection_reason: "agent_hangup", call_status: "ended", transcript: "TEST wrong number" }) }, "outbound");
    const row = await q<{ outcome: string }>(`SELECT outcome FROM sales_calls WHERE id = ${lit(w.salesId)}`);
    assert(row[0]?.outcome === "wrong_number", `outcome ${row[0]?.outcome}`);
    return "wrong_number recorded on the right lead";
  });
  await check("webhook_voicemail_outcome", async () => {
    const v = await syntheticCall("v");
    await post(HOOK_URL, { event: "call_ended", call: call(v.callId, v.salesId, { disconnection_reason: "voicemail_reached", call_status: "ended" }) }, "outbound");
    const row = await q<{ status: string; outcome: string | null; status_detail: string | null }>(`SELECT status, outcome, status_detail FROM sales_calls WHERE id = ${lit(v.salesId)}`);
    assert(row[0]?.outcome === "voicemail" || (row[0]?.status === "queued" && /voicemail/.test(row[0]?.status_detail ?? "")), `status ${row[0]?.status} outcome ${row[0]?.outcome}`);
    return row[0]?.outcome === "voicemail" ? "final outcome voicemail" : "voicemail → one retry scheduled";
  });

}

/**
 * The Worker audits the sales agent's live Retell configuration with ITS OWN RETELL_OUTBOUND_API_KEY
 * (POST /api/sales-outbound/retell-audit, signed with the scheduler key derived from the Cloudflare token). This needs no
 * Retell key in GitHub, and it is the only way to prove the key exists on the Worker without exposing it.
 */
async function workerRetellAudit() {
  const root = process.env.ACCESS_ROOT_KEY ?? "";
  if (!root) { await check("worker_retell_audit", async () => { throw new Blocked("ACCESS_ROOT_KEY is not available to this step, so the Worker's audit cannot be triggered"); }); return; }
  const key = deriveSchedulerKey(root);
  // The Founder's stated outbound number (decision 2026-11-01); public business number, not a secret.
  const body = JSON.stringify({ audit: "retell-outbound", expected_caller_number: process.env.OUTBOUND_CALLER_NUMBER || "+15173007764" });
  const res = await fetch(`${BASE}/api/sales-outbound/retell-audit`, { method: "POST", headers: { "content-type": "application/json", "x-crestmont-scheduler-signature": sign(key, body) }, body });
  const text = await res.text();
  let a: { status: string; agentId: string | null; llmId: string | null; agents: { id: string; name: string | null }[]; findings: { check: string; ok: boolean; detail: string; state?: string; observed?: string; expected?: string }[] } | null = null;
  try { a = JSON.parse(text); } catch { /* not JSON */ }
  await check("worker_retell_audit_endpoint", async () => {
    if (res.status === 429) throw new Blocked("the audit ran within the last few minutes (rate limit); re-run outbound-staging-verify.yml later");
    assert(res.status === 200 && a, `POST /api/sales-outbound/retell-audit returned ${res.status} ${text.replace(/\s+/g, " ").slice(0, 120)}`);
    return `status ${a.status}; ${a.findings.filter((f) => f.ok).length}/${a.findings.length} checks pass; agent ${a.agentId ?? "?"}; llm ${a.llmId ?? "?"}; agents: ${a.agents.map((x) => x.id).join(", ") || "none"}`;
  });
  if (!a) return;
  const clean = (x: string) => x.replace(/[\r\n]+/g, " ").replace(/::/g, ": ").slice(0, 300);
  // Plain lines (the job log keeps all of them; GitHub keeps only 10 annotations per level per step) + annotations.
  for (const f of a.findings) {
    const state = f.state ?? (f.ok ? "PASS" : "FAIL");
    const oe = f.observed !== undefined || f.expected !== undefined ? ` [observed: ${f.observed ?? "-"} | expected: ${f.expected ?? "-"}]` : "";
    console.log(`RETELL ${state} ${clean(f.check)} — ${clean(f.detail)}${clean(oe)}`);
  }
  const fails = a.findings.filter((f) => !f.ok);
  console.log(`::notice title=Retell outbound audit::${a.findings.filter((f) => f.state === "PASS" || (f.ok && !f.state)).length} PASS · ${fails.length} FAIL · ${a.findings.filter((f) => f.state === "UNVERIFIED").length} UNVERIFIED · ${a.findings.filter((f) => f.state === "INFO").length} INFO`);
  if (fails.length) console.log(`::warning title=Retell outbound audit: ${fails.length} to fix::${fails.map((f) => `${f.check}: ${f.detail}`).join(" | ").replace(/[\r\n]+/g, " ").replace(/::/g, ": ").slice(0, 3800)}`);
  const keyFinding = a.findings.find((f) => f.check === "outbound key on this Worker");
  await check("worker_has_outbound_key_secret", async () => {
    if (!keyFinding?.ok) throw new Blocked("RETELL_OUTBOUND_API_KEY is not set on the staging Worker (Cloudflare → Workers → crestmont-platform-staging → Settings → Variables and Secrets)");
    return "present on the Worker (value never leaves Cloudflare)";
  });
  const works = a.findings.find((f) => f.check === "outbound key works with Retell");
  if (keyFinding?.ok) await check("retell_outbound_key_works", async () => {
    if (!works?.ok) throw new Blocked(works ? clean(works.detail) : "not checked");
    return clean(works.detail);
  });
  // Dashboard settings the Founder still has to make are BLOCKED (external configuration), never an engineering FAIL.
  if (works?.ok) await check("retell_sales_agent_configuration", async () => {
    const todo = a!.findings.filter((f) => !f.ok);
    if (todo.length) throw new Blocked(`${todo.length} dashboard item(s): ${todo.map((f) => `${f.check}: ${clean(f.detail)}`).join(" | ").slice(0, 1500)}`);
    return "agent, webhook, events, 8 functions + record_consent, built-ins, defaults, prompt, SIE target and caller number all match";
  });
}

await main().catch((e) => results.push({ id: "script", status: "FAIL", detail: String((e as Error).message ?? e).slice(0, 300) }));
mkdirSync("evidence", { recursive: true });
writeFileSync("evidence/outbound-staging-e2e.json", JSON.stringify({ run: RUN, base: BASE, at: new Date().toISOString(), results }, null, 2));
const by = (s: Status) => results.filter((r) => r.status === s);
const line = (rs: typeof results) => rs.map((r) => `${r.id}${r.detail ? ` (${r.detail.slice(0, 120)})` : ""}`).join(" | ");
if (by("PASS").length) console.log(`::notice title=Outbound staging E2E: ${by("PASS").length} passed::${line(by("PASS")).slice(0, 3800)}`);
if (by("BLOCKED").length) console.log(`::warning title=Outbound staging E2E: ${by("BLOCKED").length} blocked (external configuration)::${line(by("BLOCKED")).slice(0, 3800)}`);
for (const r of by("FAIL").slice(0, 9)) console.log(`::error title=Outbound staging E2E: ${r.id}::${r.detail}`);
console.log(`Outbound staging E2E ${RUN}: ${by("PASS").length} passed, ${by("FAIL").length} failed, ${by("BLOCKED").length} blocked`);
process.exit(by("FAIL").length ? 1 : 0);
