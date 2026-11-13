// scripts/retell-route.ts against a simulated Retell API that enforces Retell's versioning (retell-sdk 6.2.20):
// published agent versions and their LLM versions are immutable (PATCH answers 400 "Cannot update published LLM" —
// the production failure of run 43353265696), drafts come from POST /create-agent-version {base_version}, publishing is
// POST /publish-agent-version {version}, and the version list carries no URLs. Only the three kinds of URL change; the
// prompt, all tools and every other setting stay byte-for-byte; nothing unpublished goes live; numbers move last; a URL
// on a foreign origin is never rewritten.
import { test } from "node:test";
import assert from "node:assert/strict";
import { route, reroute, retellMessage } from "../scripts/retell-route.ts";

const STG = "https://crestmont-platform-staging.partners-df4.workers.dev";
const PROD = "https://crestmontwebsitedevelopment.com";
const AGENT = "agent_receptionist";
const LLM = "llm_receptionist";
const PHONE = "+15175550155";
type Obj = Record<string, any>;
const TOOL_NAMES = ["crm_customer_lookup", "crm_upsert_lead", "get_packages_pricing", "create_checkout_session", "check_payment_status", "schedule_consultation", "create_support_ticket", "send_customer_email", "record_consent", "request_callback", "escalate", "check_transfer_availability", "get_business_hours", "record_opt_out", "lookup_consultation", "reschedule_consultation", "cancel_consultation"];

function fakeRetell(o: { draftPrompt?: string; foreignTool?: boolean; pin?: boolean } = {}) {
  const tools = (origin: string) => [
    ...TOOL_NAMES.map((name, i) => ({ type: "custom", name, url: o.foreignTool && i === 5 ? "https://elsewhere.example/hook" : `${origin}/api/webhooks/retell/functions`, description: `Tool ${name}`,
      parameters: { type: "object", properties: { q: { type: "string", description: "query" } }, required: ["q"] }, speak_during_execution: i % 2 === 0, speak_after_execution: true, execution_message_description: "One moment.", timeout_ms: 12000, args_at_root: false })),
    { type: "end_call", name: "end_call", description: "End the call" },
  ];
  const llmVersions: Obj[] = [{ llm_id: LLM, version: 4, is_published: true, general_prompt: "You are the Crestmont receptionist.", general_tools: tools(STG), model: "gpt-4.1", begin_message: "Hello", last_modification_timestamp: 1 }];
  const agentVersions: Obj[] = [{ agent_id: AGENT, agent_name: "Inbound AI Agent", version: 4, is_published: true, webhook_url: `${STG}/api/webhooks/retell`, webhook_events: ["call_started", "call_ended"], voice_id: "v1", response_engine: { type: "retell-llm", llm_id: LLM, version: 4 }, last_modification_timestamp: 1 }];
  if (o.draftPrompt) {
    llmVersions.push({ ...structuredClone(llmVersions[0]), version: 5, is_published: false, general_prompt: o.draftPrompt });
    agentVersions.push({ ...structuredClone(agentVersions[0]), version: 5, is_published: false, response_engine: { type: "retell-llm", llm_id: LLM, version: 5 } });
  }
  const numbers: Obj[] = [{ phone_number: PHONE, inbound_webhook_url: `${STG}/api/webhooks/retell/inbound`, inbound_agents: [{ agent_id: AGENT, weight: 1, ...(o.pin ? { agent_version: 4 } : {}) }] }];
  const writes: string[] = [];
  const refused: string[] = [];
  const last = (xs: Obj[]): Obj => xs.reduce((a, b) => (b.version > a.version ? b : a));
  const pick = (xs: Obj[], v: string | null) => (v ? xs.find((x) => x.version === Number(v)) : last(xs));
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url); const m = init.method ?? "GET"; const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const json = (x: unknown, s = 200) => new Response(JSON.stringify(x), { status: s });
    const v = u.searchParams.get("version");
    if (m !== "GET") writes.push(`${m} ${u.pathname}${u.search}`);
    if (m === "GET" && u.pathname === `/get-agent/${AGENT}`) { const a = pick(agentVersions, v); return a ? json(a) : json({ message: "not found" }, 404); }
    if (m === "GET" && u.pathname === `/get-retell-llm/${LLM}`) { const l = pick(llmVersions, v); return l ? json(l) : json({ message: "not found" }, 404); }
    if (m === "GET" && u.pathname === "/v2/list-phone-numbers") return json({ items: numbers, has_more: false });
    if (m === "GET" && u.pathname === `/get-phone-number/${encodeURIComponent(PHONE)}`) return json(numbers[0]);
    if (m === "GET" && u.pathname === `/list-agent-versions/${AGENT}`) return json({ has_more: false, items: agentVersions.map((a) => ({ version: a.version, is_published: a.is_published, last_modification_timestamp: a.last_modification_timestamp })) });
    if (m === "PATCH" && u.pathname === `/update-retell-llm/${LLM}`) {
      const l = pick(llmVersions, v)!;
      if (l.is_published) { refused.push(`${m} ${u.pathname}${u.search}`); return json({ status: "error", message: "Cannot update published LLM" }, 400); }
      Object.assign(l, body, { last_modification_timestamp: Date.now() }); return json(l);
    }
    if (m === "PATCH" && u.pathname === `/update-agent/${AGENT}`) {
      const a = pick(agentVersions, v)!;
      if (a.is_published) { refused.push(`${m} ${u.pathname}${u.search}`); return json({ status: "error", message: "Cannot update published agent" }, 400); }
      Object.assign(a, body, { last_modification_timestamp: Date.now() }); return json(a);
    }
    if (m === "POST" && u.pathname === `/create-agent-version/${AGENT}`) {
      const base = agentVersions.find((a) => a.version === body.base_version)!;
      const baseLlm = llmVersions.find((l) => l.version === base.response_engine.version)!;
      const nl = { ...structuredClone(baseLlm), version: last(llmVersions).version + 1, is_published: false, last_modification_timestamp: Date.now() };
      llmVersions.push(nl);
      const na = { ...structuredClone(base), version: last(agentVersions).version + 1, is_published: false, base_version: base.version, response_engine: { ...base.response_engine, version: nl.version }, last_modification_timestamp: Date.now() };
      agentVersions.push(na); return json(na, 201);
    }
    if (m === "POST" && u.pathname === `/publish-agent-version/${AGENT}`) {
      const a = agentVersions.find((x) => x.version === body.version)!;
      a.is_published = true; a.version_title = body.version_title; llmVersions.find((l) => l.version === a.response_engine.version)!.is_published = true; return new Response(null, { status: 204 });
    }
    if (m === "PATCH" && u.pathname === `/update-phone-number/${encodeURIComponent(PHONE)}`) { Object.assign(numbers[0], body); return json(numbers[0]); }
    return json({ message: "not found" }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, writes, refused, llmVersions, agentVersions, numbers };
}
const published = (xs: Obj[]) => xs.filter((v) => v.is_published).reduce((a, b) => (b.version > a.version ? b : a));

test("receptionist routing: URL rules — only the staging or production origin is rewritten", () => {
  assert.deepEqual(reroute(`${STG}/api/webhooks/retell`, "events", STG, PROD), { next: `${PROD}/api/webhooks/retell`, change: true });
  assert.deepEqual(reroute(`${PROD}/api/webhooks/retell`, "events", STG, PROD), { next: `${PROD}/api/webhooks/retell`, change: false });
  assert.ok("refuse" in reroute("https://elsewhere.example/api/webhooks/retell", "events", STG, PROD));
});

test("[VOICE-003] regression: the provider refuses edits to a published LLM (the production 400), and the route never attempts one", async () => {
  const r = fakeRetell();
  // The pre-fix request: PATCH the latest LLM (published v4) — reproduces Retell's 400 with its message.
  const naive = await r.fetch(`https://api.retellai.com/update-retell-llm/${LLM}`, { method: "PATCH", body: JSON.stringify({ general_tools: [] }) });
  assert.equal(naive.status, 400);
  assert.equal(retellMessage(await naive.clone().json(), ""), ": Cannot update published LLM", "the refusal is now reported with Retell's own message");
  r.refused.length = 0; r.writes.length = 0;
  const run = await route({ key: "k", agentId: AGENT, from: STG, to: PROD, apply: true, fetch: r.fetch });
  assert.equal(run.status, "routed", run.lines.join("\n"));
  assert.deepEqual(r.refused, [], "no write is ever sent to a published version");
  assert.deepEqual(r.writes.slice(0, 4), [`POST /create-agent-version/${AGENT}`, `PATCH /update-retell-llm/${LLM}?version=5`, `PATCH /update-agent/${AGENT}?version=5`, `POST /publish-agent-version/${AGENT}`]);
});

test("[VOICE-003] receptionist routing: dry run writes nothing; apply publishes a copy of the published version with all 17 tool URLs, the agent webhook and the number on production", async () => {
  const r = fakeRetell();
  const before = structuredClone(published(r.llmVersions));
  const dry = await route({ key: "k", agentId: AGENT, from: STG, to: PROD, apply: false, fetch: r.fetch });
  assert.equal(dry.status, "would_route", dry.lines.join("\n"));
  assert.deepEqual(r.writes, []);

  const run = await route({ key: "k", agentId: AGENT, from: STG, to: PROD, apply: true, fetch: r.fetch });
  assert.equal(run.status, "routed", run.lines.join("\n"));
  const pubAgent = published(r.agentVersions);
  assert.equal(pubAgent.version, 5);
  assert.equal(pubAgent.webhook_url, `${PROD}/api/webhooks/retell`);
  assert.deepEqual(pubAgent.webhook_events, ["call_started", "call_ended"]);
  const pubLlm = published(r.llmVersions);
  assert.equal(pubLlm.version, pubAgent.response_engine.version);
  assert.equal(pubLlm.general_prompt, before.general_prompt);
  assert.equal(pubLlm.general_tools.length, 18);
  const custom = pubLlm.general_tools.filter((t: Obj) => t.type === "custom");
  assert.equal(custom.length, 17);
  assert.ok(custom.every((t: Obj) => t.url === `${PROD}/api/webhooks/retell/functions`));
  // Every tool's name, description, parameters, speech and timeout settings are exactly what was published before.
  const strip = (ts: Obj[]) => ts.map(({ url, ...rest }) => rest);
  assert.deepEqual(strip(pubLlm.general_tools), strip(before.general_tools));
  assert.equal(r.llmVersions.find((l) => l.version === 4)!.general_tools[0].url, `${STG}/api/webhooks/retell/functions`, "the old published version is not touched");
  assert.equal(r.numbers[0].inbound_webhook_url, `${PROD}/api/webhooks/retell/inbound`);
  assert.equal(r.writes.at(-1), `PATCH /update-phone-number/${encodeURIComponent(PHONE)}`, "the number moves last");
  assert.ok(!run.lines.join(" ").includes("5175550155"), "numbers are shown by their last 4 digits only");

  const again = await route({ key: "k", agentId: AGENT, from: STG, to: PROD, apply: true, fetch: r.fetch });
  assert.equal(again.status, "already_routed", again.lines.join("\n"));

  const back = await route({ key: "k", agentId: AGENT, from: PROD, to: STG, apply: true, fetch: r.fetch });
  assert.equal(back.status, "routed", "rollback is the same run with the origins swapped");
  assert.equal(r.numbers[0].inbound_webhook_url, `${STG}/api/webhooks/retell/inbound`);
  assert.equal(published(r.agentVersions).webhook_url, `${STG}/api/webhooks/retell`);
});

test("[VOICE-003] receptionist routing: a number pinned to the published version is moved to the new one", async () => {
  const r = fakeRetell({ pin: true });
  const run = await route({ key: "k", agentId: AGENT, from: STG, to: PROD, apply: true, fetch: r.fetch });
  assert.equal(run.status, "routed", run.lines.join("\n"));
  assert.equal(r.numbers[0].inbound_agents[0].agent_version, 5);
  assert.equal(r.numbers[0].inbound_agents[0].weight, 1);
});

test("[VOICE-003] receptionist routing: an unpublished prompt edit is never published or edited; production still gets the published prompt with production URLs", async () => {
  const r = fakeRetell({ draftPrompt: "An unpublished Founder edit." });
  const run = await route({ key: "k", agentId: AGENT, from: STG, to: PROD, apply: true, fetch: r.fetch });
  assert.equal(run.status, "routed", run.lines.join("\n"));
  assert.match(run.lines.join("\n"), /unpublished draft v5 exists; it is left exactly as it is/);
  const live = published(r.llmVersions);
  assert.equal(live.general_prompt, "You are the Crestmont receptionist.");
  assert.equal(r.llmVersions.find((l) => l.version === 5)!.general_prompt, "An unpublished Founder edit.");
  assert.equal(r.llmVersions.find((l) => l.version === 5)!.is_published, false);
  assert.equal(r.agentVersions.find((a) => a.version === 5)!.webhook_url, `${STG}/api/webhooks/retell`, "the Founder's draft is not edited");
});

test("receptionist routing: a tool on a foreign origin refuses the whole run before any write", async () => {
  const r = fakeRetell({ foreignTool: true });
  const run = await route({ key: "k", agentId: AGENT, from: STG, to: PROD, apply: true, fetch: r.fetch });
  assert.equal(run.status, "refused");
  assert.deepEqual(r.writes, []);
});

test("receptionist settings for production: the staging copy keeps hours, transfer, scheduling and numbers; follow-up calling is forced off", async () => {
  const { forProduction, insertSql, summary } = await import("../scripts/receptionist-settings.ts");
  const c = forProduction({ timezone: "America/Detroit", hours: { mon: [{ open: "09:00", close: "17:00" }] }, inbound: { mode: "answer", numbers: [PHONE], agent_id: AGENT },
    transfer: { enabled: true, number: "+15175550199" }, scheduling: { enabled: true }, outbound: { enabled: true, agent_id: "agent_followup" } });
  assert.equal(c.outbound.enabled, false);
  assert.equal(c.outbound.agent_id, "agent_followup");
  assert.equal(c.timezone, "America/Detroit");
  assert.deepEqual(c.inbound.numbers, [PHONE]);
  assert.equal(c.transfer.number, "+15175550199");
  const sql = insertSql(c, "2026-11-11T00:00:00.000Z");
  assert.match(sql, /ON CONFLICT\(id\) DO NOTHING/, "production settings the Owner already has are never replaced");
  assert.ok(!summary(c).join(" ").includes("5550199") && !summary(c).join(" ").includes("5175550155"), "no number is printed in full");
});
