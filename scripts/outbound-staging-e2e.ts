// Outbound AI sales agent — live staging verification. Runs in .github/workflows/deploy-staging.yml after the deploy and
// on demand (.github/workflows/outbound-staging-verify.yml), against the deployed Worker, the real staging D1 and (when
// the staging environment holds RETELL_OUTBOUND_API_KEY) the real outbound Retell workspace — READ-ONLY there.
//
// NOTHING IS DIALLED: no create-phone-call request is ever made. Synthetic leads use fictional 555-01xx numbers and an
// allowlisted @crestmontwebsitedevelopment.com address; every synthetic record is marked [TEST DATA] / is_test.
// The repository is public: output is PASS / FAIL / BLOCKED lines with ids and counts only (no keys, agent ids or prompts).
//
//   env: E2E_BASE_URL, CLOUDFLARE_API_TOKEN/ACCOUNT_ID (D1 via wrangler), optional RETELL_OUTBOUND_API_KEY,
//        RETELL_INBOUND_API_KEY, OUTBOUND_AGENT_ID
//   node --no-warnings scripts/outbound-staging-e2e.ts
// Exit 1 only for an engineering failure (FAIL). Missing external configuration is BLOCKED (exit 0) and named exactly.
import { writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { wranglerOps } from "./staging-access.ts";
import { signRetell } from "../src/adapters/retell.ts";
import { composeSalesPrompt, baselineSalesInstructions } from "../src/domain/sales-opt/policy.ts";
import { SALES_FUNCTIONS } from "../src/services/sales-functions.ts";

const BASE = (process.env.E2E_BASE_URL ?? "").replace(/\/$/, "");
const OUT_KEY = process.env.RETELL_OUTBOUND_API_KEY ?? "";
const IN_KEY = process.env.RETELL_INBOUND_API_KEY ?? "";
if (!BASE) { console.error("::error::E2E_BASE_URL is required"); process.exit(2); }
const FN_URL = `${BASE}/api/webhooks/retell/outbound/functions`;
const HOOK_URL = `${BASE}/api/webhooks/retell`;
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

async function post(url: string, payload: unknown, key: string | null, query = "") {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["x-retell-signature"] = await signRetell(key, raw);
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
  if (IN_KEY) await check("inbound_workspace_key_rejected", async () => {
    const r = await post(FN_URL, { name: "get_packages_pricing", call: { call_id: "x" }, args: {} }, IN_KEY);
    assert(r.status === 401, `a request signed with the receptionist's workspace key returned ${r.status}`);
  });
  if (!OUT_KEY) {
    await check("outbound_workspace_key", async () => { throw new Blocked("RETELL_OUTBOUND_API_KEY is not a `staging` environment secret in GitHub, so no signed outbound request can be made from CI"); });
    return;
  }
  await check("worker_has_outbound_key", async () => {
    const r = await post(FN_URL, { name: "get_outbound_lead_context", call: { call_id: `call_${RUN}u`, metadata: { crestmont_env: ENV_NAME } }, args: {} }, OUT_KEY);
    if (r.status === 401) throw new Blocked("the staging Worker rejects the outbound workspace signature: RETELL_OUTBOUND_API_KEY is not set on the Worker or differs from the GitHub secret");
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
    const r = await post(FN_URL, fn(A.callId, A.salesId, "get_outbound_lead_context", {}), OUT_KEY, `?lead_id=${A.leadId}`);
    assert(r.status === 200 && r.json.lead_id === A.leadId, `got ${r.status}`);
    assert(r.json.website_classification === "unknown" && r.json.research_verified === false, "an unresearched lead must be neutral");
    assert(!JSON.stringify(r.json).includes(A.phone), "the phone number must not be returned to the agent");
    const bound = await q<{ provider_call_id: string }>(`SELECT provider_call_id FROM sales_calls WHERE id = ${lit(A.salesId)}`);
    assert(bound[0]?.provider_call_id === A.callId, "the Retell call id was not bound to the sales call");
    return "verified-only context; call bound";
  });
  await check("fn_cross_lead_refused", async () => {
    const r = await post(FN_URL, fn(A.callId, A.salesId, "get_outbound_lead_context", { lead_id: "ld_someone_else" }), OUT_KEY);
    assert(r.status === 403 && r.json.refused === "lead_mismatch", `got ${r.status} ${String(r.json.refused)}`);
  });
  await check("fn_get_packages_pricing", async () => {
    const r = await post(FN_URL, fn(A.callId, A.salesId, "get_packages_pricing", {}), OUT_KEY);
    const pk = (r.json.packages as { id: string; price: string }[] | undefined) ?? [];
    assert(r.status === 200 && pk.length === 3, `got ${r.status}, ${pk.length} packages`);
    return pk.map((p) => `${p.id} ${p.price}`).join(", ");
  });
  await check("fn_update_outbound_lead_via_crm_intake", async () => {
    const args = { contact_name: "Pat Tester", contact_email: email, discovery_notes: "Synthetic staging E2E (TEST DATA)", qualification: "qualified", service_interests: ["starter"] };
    const r = await post(FN_URL, fn(A.callId, A.salesId, "update_outbound_lead", args), OUT_KEY);
    assert(r.status === 200 && r.json.contact_verification === "verified", `got ${r.status} ${String(r.json.contact_verification)}`);
    const again = await post(FN_URL, fn(A.callId, A.salesId, "update_outbound_lead", args), OUT_KEY);
    assert(again.json.duplicate === true, "an identical retry was not replayed (idempotency)");
    const leads = await q<{ n: number }>(`SELECT COUNT(*) AS n FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE c.phone = ${lit(A.phone)} AND l.message LIKE '[TEST DATA] outbound%'`);
    const stage = await q<{ stage: string }>(`SELECT stage FROM leads WHERE id = ${lit(A.leadId)}`);
    assert(stage[0]?.stage === "qualified", `stage is ${stage[0]?.stage}`);
    return `verified; replayed on retry; ${leads[0]?.n} lead for the number; stage qualified`;
  });
  await check("fn_create_checkout_session", async () => {
    const r = await post(FN_URL, fn(A.callId, A.salesId, "create_checkout_session", { package: "starter", email, buyer_confirmed: true }), OUT_KEY);
    assert(r.status === 200, `got ${r.status}`);
    if (r.json.reason === "payments_not_configured") throw new Blocked("Stripe test mode is not configured on staging (BLK-004): the handler answered payments_not_configured correctly");
    assert(r.json.checkout_link_sent === true || r.json.checkout_reference, `unexpected ${JSON.stringify(r.json).slice(0, 160)}`);
    const dup = await post(FN_URL, fn(A.callId, A.salesId, "create_checkout_session", { package: "starter", email, buyer_confirmed: true }), OUT_KEY);
    assert(dup.json.duplicate === true || dup.json.already_sent_today === true, "a duplicate checkout request created a second link");
    if (typeof r.json.checkout_url === "string") {
      const buy = await fetch(r.json.checkout_url as string, { redirect: "manual" });
      assert(buy.status === 303 && (buy.headers.get("location") ?? "").includes("/checkout/starter"), `purchase link answered ${buy.status}`);
    }
    return `link ${r.json.delivery ?? "created"}; duplicate refused; link opens /checkout/starter`;
  });
  await check("fn_check_payment_status_never_assumes_paid", async () => {
    const r = await post(FN_URL, fn(A.callId, A.salesId, "check_payment_status", {}), OUT_KEY);
    assert(r.status === 200 && r.json.payment_status !== "paid", `got ${r.status} ${String(r.json.payment_status)}`);
    return String(r.json.payment_status);
  });
  await check("fn_schedule_sales_followup_once", async () => {
    const args = { followup_type: "staff_callback", preferred_date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10), preferred_time: "morning", topic: "TEST DATA", prospect_agreed: true };
    const r = await post(FN_URL, fn(A.callId, A.salesId, "schedule_sales_followup", args), OUT_KEY);
    assert(r.status === 200 && r.json.scheduled === true, `got ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    const dup = await post(FN_URL, fn(A.callId, A.salesId, "schedule_sales_followup", { ...args, preferred_time: "afternoon" }), OUT_KEY);
    assert(dup.json.already_scheduled === true, "a second follow-up of the same kind was created");
  });
  await check("fn_send_sales_email_policy", async () => {
    const bad = await post(FN_URL, fn(A.callId, A.salesId, "send_sales_email", { email_type: "package_information", email: "someone@example.com" }), OUT_KEY);
    assert(bad.json.reason === "email_not_verified", "an unverified recipient was accepted");
    const r = await post(FN_URL, fn(A.callId, A.salesId, "send_sales_email", { email_type: "package_information", email }), OUT_KEY);
    assert(r.status === 200, `got ${r.status}`);
    return `unverified recipient refused; allowlisted recipient → ${String(r.json.delivery ?? r.json.reason)}`;
  });
  await check("webhook_status_and_outcome_once", async () => {
    const s = await post(HOOK_URL, { event: "call_started", call: call(A.callId, A.salesId) }, OUT_KEY);
    assert(s.status === 200, `call_started → ${s.status}`);
    const st = await q<{ status: string }>(`SELECT status FROM sales_calls WHERE id = ${lit(A.salesId)}`);
    assert(st[0]?.status === "in_progress", `status ${st[0]?.status}`);
    const ended = { event: "call_ended", call: call(A.callId, A.salesId, { disconnection_reason: "agent_hangup", call_status: "ended", duration_ms: 123000, transcript: "Agent: TEST\nUser: TEST" }) };
    assert((await post(HOOK_URL, ended, OUT_KEY)).status === 200, "call_ended rejected");
    const row = await q<{ outcome: string; outcome_source: string; finalized_at: string }>(`SELECT outcome, outcome_source, finalized_at FROM sales_calls WHERE id = ${lit(A.salesId)}`);
    assert(row[0]?.finalized_at && row[0].outcome, "no final outcome recorded");
    assert((await post(HOOK_URL, ended, OUT_KEY)).status === 200, "duplicate call_ended rejected");
    const audits = await q<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'sales_outbound.outcome' AND subject_id = ${lit(A.salesId)}`);
    assert(Number(audits[0]?.n) === 1, `outcome written ${audits[0]?.n} times`);
    return `outcome ${row[0].outcome} (${row[0].outcome_source}); duplicate ignored`;
  });
  if (IN_KEY) await check("inbound_signed_event_cannot_touch_sales_queue", async () => {
    const b = await syntheticCall("i");
    await post(HOOK_URL, { event: "call_started", call: call(b.callId, b.salesId) }, IN_KEY);
    const st = await q<{ status: string }>(`SELECT status FROM sales_calls WHERE id = ${lit(b.salesId)}`);
    assert(st[0]?.status === "dialing", `an inbound-signed event changed the sales call to ${st[0]?.status}`);
  });
  await check("fn_record_do_not_call_everywhere", async () => {
    const c = await syntheticCall("d");
    const r = await post(FN_URL, fn(c.callId, c.salesId, "record_do_not_call", {}), OUT_KEY);
    assert(r.status === 200 && r.json.recorded === true, `got ${r.status}`);
    const dnc = await q<{ n: number }>(`SELECT COUNT(*) AS n FROM voice_dnc WHERE phone_e164 = ${lit(c.phone)}`);
    assert(Number(dnc[0]?.n) === 1, "the number is not on voice_dnc");
    return "number on the shared do-not-call list";
  });

  // ── 3. Retell outbound workspace (read-only) ──
  const agentId = process.env.OUTBOUND_AGENT_ID || (await q<{ agent_id: string | null }>(`SELECT agent_id FROM sales_outbound_settings WHERE id = 1`))[0]?.agent_id
    || (await q<{ agent_id: string }>(`SELECT agent_id FROM so_targets WHERE stage = 'staging'`))[0]?.agent_id || "";
  const retell = async (path: string) => {
    const r = await fetch(`${process.env.RETELL_API_BASE ?? "https://api.retellai.com"}${path}`, { headers: { authorization: `Bearer ${OUT_KEY}` } });
    let body: Record<string, unknown> = {}; try { body = await r.json() as Record<string, unknown>; } catch { /* */ }
    return { status: r.status, body };
  };
  await check("retell_outbound_key_works", async () => {
    const r = await retell("/list-agents");
    if (r.status === 401 || r.status === 403) throw new Blocked(`Retell refused the outbound key (${r.status}): RETELL_OUTBOUND_API_KEY is not a valid API key of the outbound workspace`);
    assert(r.status === 200, `list-agents returned ${r.status}`);
    return `${Array.isArray(r.body) ? (r.body as unknown[]).length : "?"} agent version(s) visible in the outbound workspace`;
  });
  if (!agentId) {
    await check("retell_sales_agent_registered", async () => { throw new Blocked("no sales agent id is recorded on staging (Owner: /staff/sales-outbound settings, or the SIE staging target)"); });
  } else {
    let llmId = "";
    await check("retell_sales_agent_config", async () => {
      const r = await retell(`/get-agent/${agentId}`);
      assert(r.status === 200, `get-agent returned ${r.status}`);
      const eng = (r.body.response_engine ?? {}) as { type?: string; llm_id?: string };
      assert(eng.type === "retell-llm" && eng.llm_id, `response engine is ${eng.type} (the SIE and this register need a Retell LLM single-prompt agent)`);
      llmId = eng.llm_id;
      const hook = r.body.webhook_url;
      assert(hook === HOOK_URL, `agent webhook_url is ${hook ? "a different URL" : "not set"}; expected ${HOOK_URL}`);
      const ev = Array.isArray(r.body.webhook_events) ? (r.body.webhook_events as string[]) : null;
      if (ev) for (const e of ["call_started", "call_ended", "call_analyzed"]) assert(ev.includes(e), `webhook event ${e} is not enabled`);
      return `retell-llm; webhook URL correct; events ${ev ? ev.length : "default"}`;
    });
    if (llmId) {
      await check("retell_functions_registered", async () => {
        const r = await retell(`/get-retell-llm/${llmId}`);
        assert(r.status === 200, `get-retell-llm returned ${r.status}`);
        const tools = (Array.isArray(r.body.general_tools) ? r.body.general_tools : []) as { type?: string; name?: string; url?: string; args_at_root?: boolean }[];
        const byName = new Map(tools.map((t) => [t.name, t]));
        const missing = SALES_FUNCTIONS.filter((n) => !byName.has(n));
        assert(!missing.length, `missing custom functions: ${missing.join(", ")}`);
        const wrongUrl = SALES_FUNCTIONS.filter((n) => !(byName.get(n)?.url ?? "").startsWith(FN_URL));
        assert(!wrongUrl.length, `functions pointing elsewhere: ${wrongUrl.join(", ")}`);
        const argsOnly = SALES_FUNCTIONS.filter((n) => byName.get(n)?.args_at_root === true);
        assert(!argsOnly.length, `"Payload: args only" is ON for: ${argsOnly.join(", ")}`);
        for (const b of ["end_call", "transfer_call"]) if (!tools.some((t) => t.type === b || t.name === b)) throw new Error(`built-in ${b} not found`);
        const consent = byName.get("record_consent");
        return `8/8 sales functions at the outbound URL; end_call + transfer_call present; record_consent ${consent ? "present" : "NOT configured (transcripts are discarded without consent; the SIE then has no transcript to analyse)"}`;
      });
      await check("retell_master_prompt_installed", async () => {
        const r = await retell(`/get-retell-llm/${llmId}`);
        const prompt = typeof r.body.general_prompt === "string" ? r.body.general_prompt : "";
        if (prompt !== composeSalesPrompt(baselineSalesInstructions())) throw new Blocked(`the agent's prompt differs from docs/voice/outbound-sales-agent-prompt.txt (${prompt.length} vs ${composeSalesPrompt(baselineSalesInstructions()).length} characters)`);
        return `byte-identical to SIE version 1 (${r.body.is_published === true ? "published" : "draft"})`;
      });
    }
    await check("sie_registration", async () => {
      const t = await q<{ agent_id: string; verified_at: string | null; engine_type: string | null }>(`SELECT agent_id, verified_at, engine_type FROM so_targets WHERE stage = 'staging'`);
      if (!t[0]) throw new Blocked("the sales agent is not registered as the SIE staging target (/staff/sales-optimization → Targets)");
      assert(t[0].agent_id === agentId, "the SIE staging target is a different agent than the outbound sales agent");
      if (!t[0].verified_at) throw new Blocked("the SIE staging target is registered but not verified with Retell (press Verify with Retell)");
      const v = await q<{ n: number }>(`SELECT COUNT(*) AS n FROM so_versions`);
      return `registered and verified (${t[0].engine_type}); ${v[0]?.n} version(s)`;
    });
  }
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
