// wants_founder on the receptionist's calendar tools in Retell (Founder directive 2026-11-06): the write is limited to
// one optional property on two tools, verified by read-back; nothing else on the agent may change. Retell is a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { defaultVoiceConfig, saveVoiceConfig } from "../src/services/voice-settings.ts";
import { addFounderFlag, WANTS_FOUNDER_PROPERTY } from "../src/services/retell-founder-flag.ts";
import { wantsFounderArg, routeCalendar } from "../src/domain/calendars.ts";
import { sign } from "../scripts/trigger-scheduler.ts";

const IN = "key_fixture_inbound_founder_flag";
const BASE = "https://crestmont-platform-staging.example.workers.dev";
const PROMPT = "The Founder's published V4 prompt (fixture).";

function liveLlm() {
  const tool = (name: string, props: Record<string, unknown>, required: string[]) => ({ type: "custom", name, description: `Fixture ${name}`, url: `${BASE}/api/webhooks/retell/functions`, method: "POST", timeout_ms: 10_000, max_retry: 1, speak_during_execution: true, parameters: { type: "object", properties: props, required } });
  return {
    llm_id: "llm_rcpt01", version: 3, general_prompt: PROMPT, begin_message: "Hello", model: "gpt-5.6-terra", knowledge_base_ids: ["kb_1"],
    general_tools: [
      tool("schedule_consultation", { name: { type: "string" }, phone: { type: "string" }, start_time: { type: "string" }, topic: { type: "string" }, reminder_call_ok: { type: "string", enum: ["true", "false"] } }, []),
      tool("request_callback", { name: { type: "string" }, phone: { type: "string" }, reason: { type: "string" }, preferred_time: { type: "string" } }, ["name", "phone", "reason"]),
      tool("get_packages_pricing", {}, []),
      { type: "end_call", name: "end_call" },
      { type: "transfer_call", name: "transfer_call", transfer_destination: { type: "predefined", number: "{{transfer_number}}" }, transfer_option: { type: "warm_transfer" } },
    ],
  };
}

function fakeRetell(o: { tamper?: boolean } = {}) {
  let llm: Record<string, any> = liveLlm();
  const patches: Record<string, unknown>[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url), m = init.method ?? "GET";
    if (u.pathname === "/get-agent/agent_rcpt01") return new Response(JSON.stringify({ agent_id: "agent_rcpt01", response_engine: { type: "retell-llm", llm_id: "llm_rcpt01" } }));
    if (u.pathname === "/get-retell-llm/llm_rcpt01") return new Response(JSON.stringify(llm));
    if (u.pathname === "/update-retell-llm/llm_rcpt01" && m === "PATCH") {
      const b = JSON.parse(String(init.body)); patches.push(b);
      llm = { ...llm, ...b, version: llm.version, ...(o.tamper ? { general_prompt: "changed" } : {}) };
      return new Response(JSON.stringify(llm));
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, patches, get llm() { return llm; } };
}

async function setup(env: Partial<Env> = {}) {
  const t = await createTestApp({ RETELL_INBOUND_API_KEY: IN, SCHEDULER_TRIGGER_SECRET: "sched-key", ...env } as Partial<Env>);
  const owner = await createStaff(t.db, "owner");
  const c = defaultVoiceConfig(); c.inbound.agent_id = "agent_rcpt01";
  await saveVoiceConfig(t.db, owner.id, c);
  return t;
}

test("[VOICE-003] wants_founder is added to schedule_consultation and request_callback only, optional, typed as the backend reads it; nothing else changes", async () => {
  const t = await setup();
  const r = fakeRetell();
  const dry = await addFounderFlag({ db: t.db, env: t.env, fetch: r.f, dryRun: true });
  assert.equal(dry.status, "would_update");
  assert.equal(r.patches.length, 0, "a dry run writes nothing");
  const before = JSON.parse(JSON.stringify(r.llm));
  const res = await addFounderFlag({ db: t.db, env: t.env, fetch: r.f, dryRun: false });
  assert.equal(res.status, "updated", res.detail);
  assert.deepEqual(res.tools.map((x) => [x.name, x.before, x.after]), [["schedule_consultation", "missing", "present"], ["request_callback", "missing", "present"]]);
  assert.equal(r.patches.length, 1);
  assert.deepEqual(Object.keys(r.patches[0]), ["general_tools"], "only the tools are sent: never the prompt or any other setting");
  const after = r.llm;
  assert.equal(after.general_prompt, PROMPT, "the published V4 prompt is untouched");
  for (const name of ["schedule_consultation", "request_callback"]) {
    const t1 = after.general_tools.find((x: { name: string }) => x.name === name), t0 = before.general_tools.find((x: { name: string }) => x.name === name);
    assert.deepEqual(t1.parameters.properties.wants_founder, WANTS_FOUNDER_PROPERTY);
    assert.ok(!t1.parameters.required.includes("wants_founder"), "never required");
    const { wants_founder: _w, ...rest } = t1.parameters.properties;
    assert.deepEqual({ ...t1, parameters: { ...t1.parameters, properties: rest } }, t0, `${name}: name, url, auth, timeouts and other parameters unchanged`);
  }
  assert.deepEqual(after.general_tools.slice(2), before.general_tools.slice(2), "every other tool unchanged");
  // Running again changes nothing.
  assert.equal((await addFounderFlag({ db: t.db, env: t.env, fetch: r.f, dryRun: false })).status, "already_configured");
  assert.equal(r.patches.length, 1);
  // The backend reads exactly what the tool now sends: "true" → Founder Calendar; "false"/omitted → AI Outbound Calendar.
  const ctx = { channel: "inbound_receptionist" as const, fn: "schedule_consultation", kind: "consultation" };
  assert.equal(routeCalendar({ wantsFounder: (wantsFounderArg as (v: unknown) => unknown)("true"), context: ctx }).calendar, "founder_callback");
  for (const v of ["false", undefined, ""]) assert.equal(routeCalendar({ wantsFounder: (wantsFounderArg as (v: unknown) => unknown)(v), context: ctx }).calendar, "ai_follow_up", String(v));
});

test("[VOICE-005] [SEC-002] the write is refused for a sales agent, on production, unsigned, and a read-back that differs is a failure, never success", async () => {
  const t = await setup();
  const tampered = fakeRetell({ tamper: true });
  const bad = await addFounderFlag({ db: t.db, env: t.env, fetch: tampered.f, dryRun: false });
  assert.equal(bad.status, "failed");
  assert.match(bad.detail, /the prompt changed/);
  await t.db.prepare(`UPDATE sales_outbound_settings SET agent_id = 'agent_rcpt01' WHERE id = 1`).run();
  assert.equal((await addFounderFlag({ db: t.db, env: t.env, fetch: fakeRetell().f, dryRun: false })).status, "refused");
  // Endpoint: signed, dry run by default, never on production.
  const t2 = await setup();
  t2.env.overrides = { ...t2.env.overrides, fetch: fakeRetell().f } as Env["overrides"];
  const c = t2.client();
  const body = JSON.stringify({});
  assert.equal((await c.request("POST", "/api/voice/retell-tools/founder-flag", { body, headers: { "content-type": "application/json" } })).status, 401);
  const ok = await c.request("POST", "/api/voice/retell-tools/founder-flag", { body, headers: { "content-type": "application/json", "x-crestmont-scheduler-signature": sign("sched-key", body) } });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { status: string }).status, "would_update", "without apply it is a dry run");
  const prod = await setup({ ENVIRONMENT: "production" } as Partial<Env>);
  const pr = await prod.client().request("POST", "/api/voice/retell-tools/founder-flag", { body, headers: { "content-type": "application/json", "x-crestmont-scheduler-signature": sign("sched-key", body) } });
  assert.equal(pr.status, 404);
});
