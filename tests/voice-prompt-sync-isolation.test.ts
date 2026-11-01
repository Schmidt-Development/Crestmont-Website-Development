// Receptionist prompt sync never writes to a sales agent (VOICE-004, SEC-001). TEST DATA; Retell is a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { defaultVoiceConfig, saveVoiceConfig, salesAgentIds, VoiceConfigError } from "../src/services/voice-settings.ts";
import { createAgentConfig, activateAgentConfig } from "../src/services/voice.ts";
import { syncPrompt } from "../src/services/voice-prompt-sync.ts";

const KEY = "key_fixture_prompt_isolation_01";

async function setup() {
  const calls: string[] = [];
  const t = await createTestApp({ RETELL_INBOUND_API_KEY: KEY });
  const f = (async (url: string) => { calls.push(String(url)); return new Response(JSON.stringify({ agent_id: "x", response_engine: { type: "retell-llm", llm_id: "llm_x" }, general_prompt: "" }), { status: 200 }); }) as unknown as typeof fetch;
  t.env.overrides = { storage: t.storage, fetch: f } as Env["overrides"];
  const owner = await createStaff(t.db, "owner");
  await t.db.prepare(`INSERT INTO so_targets (stage, agent_id, updated_by, updated_at) VALUES ('staging', 'agent_sales_out01', ?, ?)`).bind(owner.id, new Date().toISOString()).run();
  await createAgentConfig(t.db, owner.id, "Greet the caller warmly, state you are an AI assistant, and help with questions about services and packages.", "Initial");
  await activateAgentConfig(t.db, owner.id, 1);
  return { ...t, owner, calls, f };
}

test("[VOICE-004] [SEC-001] receptionist agent id fields refuse an agent registered as a sales agent", async () => {
  const t = await setup();
  assert.deepEqual([...await salesAgentIds(t.db)], ["agent_sales_out01"]);
  const c = defaultVoiceConfig(); c.inbound.agent_id = "agent_sales_out01";
  await assert.rejects(saveVoiceConfig(t.db, t.owner.id, c), (e: unknown) => e instanceof VoiceConfigError && /registered as a sales agent/.test((e as Error).message));
  const o = defaultVoiceConfig(); o.outbound.agent_id = "agent_sales_out01";
  await assert.rejects(saveVoiceConfig(t.db, t.owner.id, o), /follow-up \(outbound\) agent id is registered as a sales agent/);
  const ok = defaultVoiceConfig(); ok.inbound.agent_id = "agent_reception01";
  await saveVoiceConfig(t.db, t.owner.id, ok);
});

test("[VOICE-004] [SEC-001] prompt push refuses a sales agent stored before the check existed (inbound empty, outbound = sales): nothing is sent to Retell", async () => {
  const t = await setup();
  const legacy = defaultVoiceConfig(); legacy.outbound.agent_id = "agent_sales_out01"; // inbound empty → sync would fall back to it
  await t.db.prepare(`INSERT INTO voice_settings (id, config_json, updated_at) VALUES (1, ?, ?)`).bind(JSON.stringify(legacy), new Date().toISOString()).run();
  const r = await syncPrompt({ db: t.db, env: t.env, fetch: t.f, userId: t.owner.id, mode: "push" });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /never written to a sales agent; nothing was sent/);
  assert.deepEqual(t.calls, [], "no Retell request at all");
  // A separate receptionist agent still syncs normally.
  const fixed = defaultVoiceConfig(); fixed.inbound.agent_id = "agent_reception01";
  await t.db.prepare(`UPDATE voice_settings SET config_json = ? WHERE id = 1`).bind(JSON.stringify(fixed)).run();
  await syncPrompt({ db: t.db, env: t.env, fetch: t.f, userId: t.owner.id, mode: "push" });
  const urls: string[] = [...t.calls];
  assert.ok(urls.length > 0 && urls.every((u) => u.includes("agent_reception01") || u.includes("llm_x")));
});
