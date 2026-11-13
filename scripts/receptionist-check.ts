// Production AI receptionist verification (Owner, 2026-11-13, launch priority 2). No phone call is placed, nobody is
// contacted, and nothing is charged. Three parts, all with the receptionist's own key (RETELL_INBOUND_API_KEY, never
// printed):
//
//  1. Configuration (Retell API, read-only): the number (517) 300-2055 routes to the receptionist agent; the latest
//     PUBLISHED agent version and its LLM version use the production webhook and all 17 custom tools point at the
//     production function endpoint; the live prompt passes the 24/7 behaviour checks (promptBehaviourFindings; the
//     prompt itself is never printed).
//  2. Backend (production Worker, Retell-signed requests exactly as Retell sends them): one TEST call (call_type
//     web_call → recorded as a test, excluded from reporting): consent, pricing, hours (24/7 AI vs staffed hours),
//     transfer availability, lead capture, the checkout link (it opens the intake; emailed to a Resend test inbox),
//     callback availability, a deliberately invalid request (graceful answer, no error page), then call_ended with a
//     transcript; the database must show the test call, its functions, outcome and transcript.
//  3. Conversation (Retell's own simulation tests on the PUBLISHED LLM version): simulated callers ask about prices and
//     maintenance, call at 3 a.m., buy a package, ask for a callback, and hit a failing tool. Tool calls are mocked with
//     the real production answers from part 2, so a simulation writes nothing anywhere. Retell's evaluator grades each
//     criterion; the transcripts are not printed.
//
//   PROD=https://… AGENT=agent_… RETELL_INBOUND_API_KEY=… WRANGLER="npx --yes wrangler@4.149.0" node --no-warnings scripts/receptionist-check.ts
// Output: PASS/FAIL lines (ids, URLs, booleans; numbers by last 4 digits). Exit 1 on any failure.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { RETELL_API_BASE, signRetell } from "../src/adapters/retell.ts";
import { promptBehaviourFindings } from "../src/services/retell-inbound-audit.ts";

type Obj = Record<string, any>;
const PROD = (process.env.PROD ?? "").replace(/\/$/, "");
const AGENT = process.env.AGENT ?? "";
const KEY = process.env.RETELL_INBOUND_API_KEY ?? "";
const NUMBER = "+15173002055";
if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(PROD) || !/^agent_[A-Za-z0-9]+$/.test(AGENT) || !KEY) { console.error("PROD, AGENT and RETELL_INBOUND_API_KEY are required"); process.exit(2); }
const SKIP_SIMULATION = process.env.SKIP_SIMULATION === "1";
let failed = 0;
const check = (ok: boolean, what: string, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failed++; return ok; };
const info = (l: string) => console.log(`INFO ${l}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retell(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${RETELL_API_BASE}${path}`, { method, headers: { authorization: `Bearer ${KEY}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    .catch((e: Error) => new Response(JSON.stringify({ error: `network: ${e.message}` }), { status: 599 }));
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: r.status, json };
}
const items = (x: any): any[] => (Array.isArray(x) ? x : x?.items ?? []);

// ───────────── 1. Configuration ─────────────
const fnUrl = `${PROD}/api/webhooks/retell/functions`;
const versions = items((await retell("GET", `/list-agent-versions/${AGENT}?limit=100`)).json);
const pubV = versions.filter((v) => v.is_published).map((v) => v.version as number).sort((a, b) => b - a)[0];
const pub = (await retell("GET", `/get-agent/${AGENT}?version=${pubV}`)).json as Obj;
const llmId = pub?.response_engine?.llm_id as string;
const llm = (await retell("GET", `/get-retell-llm/${llmId}?version=${pub?.response_engine?.version}`)).json as Obj;
const nums = items((await retell("GET", "/v2/list-phone-numbers?limit=100")).json);
const line = nums.find((n) => n.phone_number === NUMBER);
check(!!line && (line.inbound_agents ?? []).some((a: Obj) => a.agent_id === AGENT), "the number …2055 routes inbound calls to the receptionist agent", line ? `agents: ${(line.inbound_agents ?? []).map((a: Obj) => `${a.agent_id}@${a.agent_version ?? "latest_published"}`).join(", ")}` : "number not in this workspace");
check(line?.inbound_webhook_url === `${PROD}/api/webhooks/retell/inbound`, "the number's inbound webhook is production", String(line?.inbound_webhook_url));
check(pub?.is_published === true && pub?.webhook_url === `${PROD}/api/webhooks/retell`, `published agent v${pubV} sends call events to production`, String(pub?.webhook_url));
const custom = (llm?.general_tools ?? []).filter((t: Obj) => t.type === "custom");
check(custom.length === 17 && custom.every((t: Obj) => t.url === fnUrl), `all ${custom.length} custom tools of LLM v${llm?.version} call the production function endpoint`, custom.filter((t: Obj) => t.url !== fnUrl).map((t: Obj) => t.name).join(", ") || fnUrl);
for (const f of promptBehaviourFindings(String(llm?.general_prompt ?? ""))) check(f.status !== "fail", f.check, f.detail);
const prompt = String(llm?.general_prompt ?? "");
check(!/\b(staff|team|people|humans?|someone)\b[^.]{0,60}\b(24\s*\/\s*7|around the clock|24 hours)/i.test(prompt), "prompt never promises human staff around the clock", "AI availability only");
check(!/sign in or create an account|create an account[^.]{0,40}before (paying|payment)|must (sign in|log in|register)/i.test(prompt), "prompt does not tell buyers to create an account before paying (guest checkout)");

// ───────────── 2. Backend (signed test call) ─────────────
const run = randomBytes(4).toString("hex");
const callId = `call_crestmont_check_${run}`;
const call = { call_id: callId, call_type: "web_call", direction: "inbound", agent_id: AGENT, from_number: "+15175550100", to_number: NUMBER, metadata: { crestmont_env: "production", crestmont_test: true } };
const email = `delivered+receptionist-${run}@resend.dev`;
async function signed(path: string, body: Obj): Promise<{ status: number; json: any }> {
  const raw = JSON.stringify(body);
  const r = await fetch(`${PROD}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-retell-signature": await signRetell(KEY, raw) }, body: raw, signal: AbortSignal.timeout(30_000) })
    .catch((e: Error) => new Response(JSON.stringify({ error: `network: ${e.message}` }), { status: 599 }));
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: r.status, json };
}
const fn = (name: string, args: Obj) => signed("/api/webhooks/retell/functions", { name, call, args });
const outputs: Record<string, unknown> = {};

check((await signed("/api/webhooks/retell", { event: "call_started", call: { ...call, start_timestamp: Date.now() } })).status === 200, "production accepts the signed call_started event (test call)");
const consent = await fn("record_consent", { consent: true });
check(consent.status === 200 && consent.json?.recorded === true, "record_consent is stored", `HTTP ${consent.status}`);
const pricing = await fn("get_packages_pricing", {});
outputs.get_packages_pricing = pricing.json;
const pj = JSON.stringify(pricing.json);
check(pricing.status === 200 && /999/.test(pj) && /2,?499/.test(pj) && /4,?999/.test(pj), "get_packages_pricing returns Starter $999, Business $2,499, Premium $4,999", `HTTP ${pricing.status}`);
check(/maintenance/i.test(pj), "get_packages_pricing includes the maintenance plans");
const hours = await fn("get_business_hours", {});
outputs.get_business_hours = hours.json;
check(hours.status === 200 && hours.json?.ai_available === true, "get_business_hours: the AI receptionist is available 24/7", `staffed now: ${hours.json?.staff_available_now}; hours: ${String(hours.json?.hours ?? "").slice(0, 80)}`);
check(!/human staff are available 24|staff (are )?available around the clock/i.test(JSON.stringify(hours.json)), "get_business_hours never claims human staff around the clock");
check(hours.json?.staff_available_now === false || hours.json?.live_transfer_configured === true, "get_business_hours says a person is available only when a live transfer is configured", `staff_available_now ${hours.json?.staff_available_now}, live transfer ${hours.json?.live_transfer_configured}`);
const transfer = await fn("check_transfer_availability", {});
outputs.check_transfer_availability = transfer.json;
check(transfer.status === 200 && typeof transfer.json?.transfer_available === "boolean", "check_transfer_availability answers", `transfer available: ${transfer.json?.transfer_available}`);
const lead = await fn("crm_upsert_lead", { name: "Receptionist Check", phone: "+15175550100", email, company: `[Receptionist check ${run}] automated test`, interest: "business", requirements: "Automated production receptionist check; not a real enquiry." });
outputs.crm_upsert_lead = lead.json;
check(lead.status === 200 && lead.json?.lead_saved === true, "crm_upsert_lead records the lead", `HTTP ${lead.status}`);
const checkout = await fn("create_checkout_session", { package: "business", name: "Receptionist Check", email });
outputs.create_checkout_session = checkout.json;
check(checkout.status === 200 && checkout.json?.link_sent === true, "create_checkout_session emails the secure Business checkout link (opens the intake; Resend test inbox)", `${checkout.json?.reason ?? ""} ${checkout.json?.email_status ?? ""}`.trim());
const slots = await fn("schedule_consultation", {});
outputs.schedule_consultation = slots.json;
check(slots.status === 200 && (slots.json?.available === true ? Array.isArray(slots.json?.slots) : typeof slots.json?.message === "string"), "schedule_consultation lists real open times (or explains a callback instead)", slots.json?.available ? `${slots.json.slots.length} slot(s), ${slots.json.calendar}` : `not available: ${slots.json?.reason}`);
const bad = await fn("create_checkout_session", { package: "platinum", name: "X", email: "not-an-email" });
check(bad.status < 500 && typeof (bad.json?.error ?? bad.json?.message ?? bad.json?.result?.error) === "string" && !/exception|stack|undefined/i.test(JSON.stringify(bad.json)), "an invalid tool request gets a graceful answer the agent can say", `HTTP ${bad.status}: ${String(bad.json?.error ?? bad.json?.message ?? bad.json?.result?.error).slice(0, 90)}`);
const ended = await signed("/api/webhooks/retell", { event: "call_ended", call: { ...call, call_status: "ended", duration_ms: 95_000, disconnection_reason: "user_hangup", transcript: "Agent: Thanks for calling Crestmont.\nUser: This is an automated receptionist check.\nAgent: Thank you, goodbye." } });
check(ended.status === 200, "production accepts the signed call_ended event", `HTTP ${ended.status}`);
if (process.env.WRANGLER !== "") {
  try {
    const [cmd, ...base] = (process.env.WRANGLER ?? "npx --yes wrangler@4.149.0").split(" ").filter(Boolean);
    const out = execFileSync(cmd, [...base, "d1", "execute", "crestmont-production", "--remote", "--env", "production", "--json", "--command",
      `SELECT c.is_test, c.outcome, c.recording_consent, (c.transcript IS NOT NULL) AS has_transcript, c.lead_id IS NOT NULL AS has_lead, (SELECT COUNT(*) FROM voice_events e WHERE e.call_id = c.id) AS events FROM calls c WHERE c.provider_call_id = '${callId}'`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const row = (JSON.parse(out.slice(out.indexOf("[")))[0]?.results ?? [])[0];
    check(!!row && row.is_test === 1 && row.outcome === "lead_captured" && row.has_transcript === 1 && row.has_lead === 1 && row.events >= 7,
      "the test call is recorded: test flag, outcome lead_captured, transcript kept (consent), lead linked, every function logged", JSON.stringify(row ?? null));
  } catch (e) { check(false, "read the recorded test call from production", (e as Error).message.slice(0, 160)); }
}

// ───────────── 3. Conversation (Retell simulation tests) ─────────────
if (!SKIP_SIMULATION && llmId) {
  const engine = { type: "retell-llm", llm_id: llmId, version: llm.version };
  const mock = (tool: string, output: unknown) => ({ tool_name: tool, input_match_rule: { type: "any" }, output: JSON.stringify(output) });
  const okMocks = [
    ...Object.entries(outputs).map(([k, v]) => mock(k, v)),
    mock("record_consent", { recorded: true, message: "Thank you. This call may be recorded and transcribed." }),
    mock("crm_customer_lookup", { found: false, message: "No match. Treat the caller as new." }),
    mock("request_callback", { callback_requested: true, message: "Callback request recorded. A team member will call back during staffed hours." }),
    mock("escalate", { escalated: true, transfer: false, message: "I'm passing this to a member of the Crestmont team who will follow up." }),
    mock("send_customer_email", { email_sent: true, message: "Sent." }),
    mock("create_support_ticket", { ticket_created: true, message: "Support request recorded." }),
  ];
  const slotList = (outputs.schedule_consultation as Obj)?.slots ?? [];
  const bookMock = { tool_name: "schedule_consultation", input_match_rule: { type: "any" }, output: JSON.stringify(slotList.length ? { step: "availability", ...(outputs.schedule_consultation as Obj) } : outputs.schedule_consultation) };
  // Time-of-day callers (Owner, 2026-11-13): the worst case for every hour — staff hours Mon–Fri 8 AM–5 PM, staff NOT in,
  // no live transfer — with the production hours-tool answer for that state. The AI must still help fully.
  const hoursVars = (now: string) => ({ current_time: now, receptionist_mode: "full", business_open_now: "false", business_hours_configured: "true",
    business_hours: "Monday to Friday, 8 AM to 5 PM Eastern (human staff)", transfer_available: "false", scheduling_available: "false" });
  const afterHoursMocks = [...okMocks.filter((m) => m.tool_name !== "get_business_hours"), mock("get_business_hours", { configured: true, open_now: false, staff_available_now: false, ai_available: true, ai_hours: "24/7", live_transfer_configured: false, hours: null, next_open: null,
    message: "You, the AI receptionist, are available 24/7 and can help with everything. No team member can take a live call right now: offer a booked callback time or a callback request. Never promise an immediate callback or that people are available around the clock." })];
  const TIME_METRICS = ["The agent never says Crestmont is closed, unavailable or not taking calls, and never tells the caller to leave a message or call back later because of the time.",
    "The agent answers the question about the Business package (price $2,499 and what it includes) and offers a way to get started now (checkout link, lead details or a callback).",
    "The agent does not describe human staff hours as the company's opening hours and does not promise an immediate human callback."];
  const cases = [
    { name: "pricing and maintenance", user: "You run a small bakery and are calling Crestmont to ask what each website package costs, what is included, and whether you also need a monthly maintenance plan. Ask about every package, then thank the agent and end the call. When your questions are answered (or after at most six exchanges), say goodbye and hang up; never repeat a question the agent already answered.",
      metrics: ["The agent states the package prices exactly as the pricing tool returned them: Starter $999, Business $2,499 and Premium from $4,999.", "The agent explains that a maintenance plan is part of buying a package and describes at least one maintenance plan accurately.", "The agent does not invent prices, discounts or packages that the pricing tool did not return."], mocks: okMocks },
    { name: "2 AM weekday", vars: hoursVars("Tuesday, November 17, 2026 at 2:00 AM Eastern Time"),
      user: "It is 2 a.m. on a Tuesday. You ask whether Crestmont is open right now, then ask what the Business package costs and includes, and ask to get started. When your questions are answered (or after at most six exchanges), say goodbye and hang up; never repeat a question the agent already answered.",
      metrics: TIME_METRICS, mocks: afterHoursMocks },
    { name: "8 AM weekday", vars: hoursVars("Monday, November 16, 2026 at 8:00 AM Eastern Time"),
      user: "It is 8 a.m. on a Monday. You ask whether Crestmont is open right now, then ask what the Business package costs and includes, and ask to get started. When your questions are answered (or after at most six exchanges), say goodbye and hang up; never repeat a question the agent already answered.",
      metrics: TIME_METRICS, mocks: afterHoursMocks },
    { name: "6 PM weekday", vars: hoursVars("Friday, November 20, 2026 at 6:00 PM Eastern Time"),
      user: "It is 6 p.m. on a Friday. You ask whether Crestmont is open right now, then ask what the Business package costs and includes, and ask to get started. When your questions are answered (or after at most six exchanges), say goodbye and hang up; never repeat a question the agent already answered.",
      metrics: TIME_METRICS, mocks: afterHoursMocks },
    { name: "midnight", vars: hoursVars("Saturday, November 21, 2026 at 12:00 AM Eastern Time"),
      user: "It is midnight on a Friday night. You ask whether Crestmont is open right now, then ask what the Business package costs and includes, and ask to get started. When your questions are answered (or after at most six exchanges), say goodbye and hang up; never repeat a question the agent already answered.",
      metrics: TIME_METRICS, mocks: afterHoursMocks },
    { name: "weekend", vars: hoursVars("Sunday, November 22, 2026 at 3:00 PM Eastern Time"),
      user: "It is a Sunday afternoon. You ask whether Crestmont is open right now, then ask what the Business package costs and includes, and ask to get started. When your questions are answered (or after at most six exchanges), say goodbye and hang up; never repeat a question the agent already answered.",
      metrics: TIME_METRICS, mocks: afterHoursMocks },
    { name: "holiday", vars: hoursVars("Friday, December 25, 2026 at 10:00 AM Eastern Time"),
      user: "It is Christmas Day. You ask whether Crestmont is open right now, then ask what the Business package costs and includes, and ask to get started. When your questions are answered (or after at most six exchanges), say goodbye and hang up; never repeat a question the agent already answered.",
      metrics: TIME_METRICS, mocks: afterHoursMocks },
    { name: "buyer", user: "You want to buy the Business package today. Your name is Jordan Test, phone 517-555-0100, email jordan@example.com, business Jordan's Bakery. Answer the agent's questions and accept a checkout link. When your questions are answered (or after at most six exchanges), say goodbye and hang up; never repeat a question the agent already answered.",
      metrics: ["The agent collects the caller's name, phone or email and business name.", "The agent records the enquiry (crm_upsert_lead, or create_checkout_session, which records it too).", "The agent sends the secure checkout link for the Business package with create_checkout_session and tells the caller what the link opens (the project intake, agreements and payment), without asking them to create an account first."], mocks: okMocks },
    { name: "callback", user: "You would like someone to call you back about a Premium website. Ask for a callback time and pick the first time the agent offers. When your questions are answered (or after at most six exchanges), say goodbye and hang up; never repeat a question the agent already answered.",
      metrics: ["The agent checks availability with schedule_consultation and offers only times the tool returned, or takes a callback request if none are available.", "The agent does not promise a time that the tool did not return."], mocks: [...okMocks.filter((m) => m.tool_name !== "schedule_consultation"), bookMock] },
    { name: "failing tool", user: "You want a checkout link for the Starter package; your name is Sam Test and your email is sam@example.com. When your questions are answered (or after at most six exchanges), say goodbye and hang up; never repeat a question the agent already answered.",
      metrics: ["When sending the checkout link fails, the agent apologises, does not claim the link was sent, and offers an alternative such as a callback or a team member following up."],
      mocks: [...okMocks.filter((m) => m.tool_name !== "create_checkout_session"), mock("create_checkout_session", { error: "I couldn't complete that. A team member will follow up." })] },
  ];
  const defs: string[] = [];
  try {
    for (const c of cases) {
      const r = await retell("POST", "/create-test-case-definition", { name: `[Crestmont launch check ${run}] ${c.name}`, response_engine: engine, user_prompt: c.user, metrics: c.metrics, tool_mocks: c.mocks, llm_model: "gpt-4.1-mini", ...((c as { vars?: Record<string, string> }).vars ? { dynamic_variables: (c as { vars?: Record<string, string> }).vars } : {}) });
      if (!check(r.status < 300 && !!r.json?.test_case_definition_id, `simulation "${c.name}" defined`, r.status < 300 ? "" : `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`)) continue;
      defs.push(r.json.test_case_definition_id);
    }
    if (defs.length) {
      const batch = await retell("POST", "/create-batch-test", { response_engine: engine, test_case_definition_ids: defs });
      const id = batch.json?.test_case_batch_job_id;
      if (check(!!id, "Retell simulation batch started", id ?? `HTTP ${batch.status}`)) {
        let b: Obj = batch.json;
        for (let i = 0; i < 60 && b?.status !== "complete"; i++) { await sleep(10_000); b = (await retell("GET", `/get-batch-test/${id}`)).json; }
        const runs = items((await retell("GET", `/v2/list-test-runs/${id}?limit=50`)).json);
        for (const t of runs) {
          const c = cases.find((x) => t.test_case_definition_snapshot?.name?.endsWith(x.name));
          check(t.status === "pass", `Retell simulation: ${c?.name ?? t.test_case_definition_id}`, `${t.status}${t.result_explanation ? `: ${String(t.result_explanation).replace(/\s+/g, " ").slice(0, 400)}` : ""}`);
          if (t.status !== "pass") {
            // The simulated conversation (no real person), last turns only, to show where it went wrong.
            const snap = t.transcript_snapshot as { transcript?: { role?: string; content?: string }[] } | null;
            const turns = (snap?.transcript ?? (Array.isArray(snap) ? snap as { role?: string; content?: string }[] : [])).filter((x) => x?.content).slice(-6);
            for (const x of turns) info(`   ${x.role}: ${String(x.content).replace(/\s+/g, " ").slice(0, 160)}`);
          }
        }
        info(`simulation batch ${id}: ${b?.pass_count ?? "?"} pass, ${b?.fail_count ?? "?"} fail, ${b?.error_count ?? "?"} error of ${b?.total_count ?? "?"}`);
      }
    }
  } finally {
    for (const d of defs) await retell("DELETE", `/delete-test-case-definition/${d}`).catch(() => undefined);
  }
}
console.log(failed ? `${failed} receptionist check(s) failed` : "production AI receptionist verified");
process.exit(failed ? 1 : 0);
