// scripts/retell-route.ts against a simulated Retell API: only the three kinds of URL change, the prompt and every other
// setting stay byte-for-byte, the draft is published only when it differs from the published version in the URLs
// alone, numbers move last, and a URL on a foreign origin is never rewritten.
import { test } from "node:test";
import assert from "node:assert/strict";
import { route, reroute } from "../scripts/retell-route.ts";

const STG = "https://crestmont-platform-staging.partners-df4.workers.dev";
const PROD = "https://crestmontwebsitedevelopment.com";
const AGENT = "agent_receptionist";
const LLM = "llm_receptionist";
const PHONE = "+15175550155";
type Obj = Record<string, any>;

function fakeRetell(o: { draftPrompt?: string; foreignTool?: boolean; pin?: boolean } = {}) {
  const tools = (origin: string) => [
    { type: "custom", name: "lookup_package", url: `${origin}/api/webhooks/retell/functions`, description: "Look up a package", parameters: { type: "object", properties: { pkg: { type: "string" } } } },
    { type: "custom", name: "schedule_consultation", url: o.foreignTool ? "https://elsewhere.example/hook" : `${origin}/api/webhooks/retell/functions`, description: "Book", parameters: { type: "object", properties: {} } },
    { type: "end_call", name: "end_call" },
  ];
  const llmVersions: Obj[] = [{ llm_id: LLM, version: 3, is_published: true, general_prompt: "You are the Crestmont receptionist.", general_tools: tools(STG), model: "gpt-4.1", begin_message: "Hello" }];
  if (o.draftPrompt) llmVersions.push({ ...structuredClone(llmVersions[0]), version: 4, is_published: false, general_prompt: o.draftPrompt });
  const agentVersions: Obj[] = [{ agent_id: AGENT, agent_name: "Receptionist", version: 7, is_published: true, webhook_url: `${STG}/api/webhooks/retell`, webhook_events: ["call_started", "call_ended"], voice_id: "v1", response_engine: { type: "retell-llm", llm_id: LLM, version: 3 } }];
  const numbers: Obj[] = [{ phone_number: PHONE, inbound_webhook_url: `${STG}/api/webhooks/retell/inbound`, inbound_agents: [{ agent_id: AGENT, weight: 1, ...(o.pin ? { agent_version: 7 } : {}) }] }];
  const writes: string[] = [];
  const latest = (xs: Obj[]): Obj => xs[xs.length - 1];
  const draftLlm = (): Obj => { const l = latest(llmVersions); if (!l.is_published) return l; const d = { ...structuredClone(l), version: l.version + 1, is_published: false }; llmVersions.push(d); return d; };
  const draftAgent = (): Obj => { const a = latest(agentVersions); if (!a.is_published) return a; const d = { ...structuredClone(a), version: a.version + 1, is_published: false }; agentVersions.push(d); return d; };
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url); const m = init.method ?? "GET"; const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const json = (x: unknown, s = 200) => new Response(JSON.stringify(x), { status: s });
    if (m !== "GET") writes.push(`${m} ${u.pathname}`);
    if (m === "GET" && u.pathname === `/get-agent/${AGENT}`) return json(latest(agentVersions));
    if (m === "GET" && u.pathname === `/get-retell-llm/${LLM}`) { const v = u.searchParams.get("version"); return json(v ? llmVersions.find((x) => x.version === Number(v)) : latest(llmVersions)); }
    if (m === "GET" && u.pathname === "/v2/list-phone-numbers") return json({ items: numbers, has_more: false });
    if (m === "GET" && u.pathname === `/get-phone-number/${encodeURIComponent(PHONE)}`) return json(numbers[0]);
    if (m === "GET" && u.pathname === `/list-agent-versions/${AGENT}`) return json(agentVersions);
    if (m === "PATCH" && u.pathname === `/update-retell-llm/${LLM}`) { Object.assign(draftLlm(), body); return json(latest(llmVersions)); }
    if (m === "PATCH" && u.pathname === `/update-agent/${AGENT}`) { const d = draftAgent(); Object.assign(d, body); d.response_engine = { ...d.response_engine, version: latest(llmVersions).version }; return json(d); }
    if (m === "POST" && u.pathname === `/publish-agent/${AGENT}`) { latest(agentVersions).is_published = true; latest(llmVersions).is_published = true; return json({}); }
    if (m === "PATCH" && u.pathname === `/update-phone-number/${encodeURIComponent(PHONE)}`) { Object.assign(numbers[0], body); return json(numbers[0]); }
    return json({ error: "not found" }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, writes, llmVersions, agentVersions, numbers };
}

test("receptionist routing: URL rules — only the staging or production origin is rewritten", () => {
  assert.deepEqual(reroute(`${STG}/api/webhooks/retell`, "events", STG, PROD), { next: `${PROD}/api/webhooks/retell`, change: true });
  assert.deepEqual(reroute(`${PROD}/api/webhooks/retell`, "events", STG, PROD), { next: `${PROD}/api/webhooks/retell`, change: false });
  assert.ok("refuse" in reroute("https://elsewhere.example/api/webhooks/retell", "events", STG, PROD));
});

test("receptionist routing: dry run writes nothing; apply moves the agent, tools and number to production, publishes, keeps the prompt", async () => {
  const r = fakeRetell();
  const dry = await route({ key: "k", agentId: AGENT, from: STG, to: PROD, apply: false, fetch: r.fetch });
  assert.equal(dry.status, "would_route", dry.lines.join("\n"));
  assert.deepEqual(r.writes, []);

  const run = await route({ key: "k", agentId: AGENT, from: STG, to: PROD, apply: true, fetch: r.fetch });
  assert.equal(run.status, "routed", run.lines.join("\n"));
  const pubAgent = r.agentVersions.filter((v) => v.is_published).at(-1)!;
  assert.equal(pubAgent.webhook_url, `${PROD}/api/webhooks/retell`);
  const pubLlm = r.llmVersions.filter((v) => v.is_published).at(-1)!;
  assert.equal(pubLlm.general_prompt, "You are the Crestmont receptionist.");
  assert.deepEqual(pubLlm.general_tools.filter((t: Obj) => t.url).map((t: Obj) => t.url), [`${PROD}/api/webhooks/retell/functions`, `${PROD}/api/webhooks/retell/functions`]);
  assert.equal(pubLlm.general_tools[0].description, "Look up a package");
  assert.equal(r.numbers[0].inbound_webhook_url, `${PROD}/api/webhooks/retell/inbound`);
  assert.equal(r.writes.at(-1), `PATCH /update-phone-number/${encodeURIComponent(PHONE)}`, "the number moves last");
  assert.ok(!run.lines.join(" ").includes("5175550155"), "numbers are shown by their last 4 digits only");

  const again = await route({ key: "k", agentId: AGENT, from: STG, to: PROD, apply: true, fetch: r.fetch });
  assert.equal(again.status, "already_routed", again.lines.join("\n"));

  const back = await route({ key: "k", agentId: AGENT, from: PROD, to: STG, apply: true, fetch: r.fetch });
  assert.equal(back.status, "routed", "rollback is the same run with the origins swapped");
  assert.equal(r.numbers[0].inbound_webhook_url, `${STG}/api/webhooks/retell/inbound`);
});

test("receptionist routing: a number pinned to the published version is moved to the new one", async () => {
  const r = fakeRetell({ pin: true });
  const run = await route({ key: "k", agentId: AGENT, from: STG, to: PROD, apply: true, fetch: r.fetch });
  assert.equal(run.status, "routed", run.lines.join("\n"));
  assert.equal(r.numbers[0].inbound_agents[0].agent_version, 8);
  assert.equal(r.numbers[0].inbound_agents[0].weight, 1);
});

test("receptionist routing: an unpublished prompt edit is never published, and the number stays put", async () => {
  const r = fakeRetell({ draftPrompt: "An unpublished Founder edit." });
  const run = await route({ key: "k", agentId: AGENT, from: STG, to: PROD, apply: true, fetch: r.fetch });
  assert.equal(run.status, "draft_saved_not_published", run.lines.join("\n"));
  assert.ok(!r.writes.some((w) => w.startsWith("POST /publish-agent")));
  assert.equal(r.numbers[0].inbound_webhook_url, `${STG}/api/webhooks/retell/inbound`);
  assert.equal(r.llmVersions.filter((v) => v.is_published).at(-1)!.general_prompt, "You are the Crestmont receptionist.");
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
