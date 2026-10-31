// Two Retell workspaces (src/adapters/retell-workspaces.ts): receptionist = RETELL_INBOUND_API_KEY, sales agent +
// Self-Improvement Engine = RETELL_OUTBOUND_API_KEY. FIXTURES ONLY: signed fixture payloads and a fake Retell API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { signRetell } from "../src/adapters/retell.ts";
import { verifyRetellWorkspace, retellKey } from "../src/adapters/retell-workspaces.ts";
import { defaultVoiceConfig, saveVoiceConfig } from "../src/services/voice-settings.ts";
import { outboundGate } from "../src/services/voice-outbound.ts";
import { productionGate } from "../src/services/sales-opt/deploy.ts";
import { syncPrompt } from "../src/services/voice-prompt-sync.ts";
import { createAgentConfig, activateAgentConfig, INBOUND_MASTER_INSTRUCTIONS } from "../src/services/voice.ts";
import { assessConfiguration } from "../src/services/integrations.ts";

const IN = "key_fixture_inbound_workspace_01";
const OUT = "key_fixture_outbound_workspace_1";
const count = async (db: Env["DB"], sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;

async function app(env: Partial<Env>) {
  const t = await createTestApp(env);
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('voice.monthly_budget_usd', '50', ?)`).bind(new Date().toISOString()).run();
  const post = async (path: string, payload: unknown, key: string) => {
    const raw = JSON.stringify(payload);
    const res = await t.client().request("POST", path, { body: raw, headers: { "content-type": "application/json", "x-retell-signature": await signRetell(key, raw) } });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { ...t, post };
}
const call = (id: string) => ({ call_id: id, call_type: "phone_call", from_number: "+15550100123", to_number: "+15550109999", direction: "inbound" });

test("[VOICE-003] [SEC-002] the workspace is proven by the signature: each key verifies only its own workspace, no fallback", async () => {
  const env = { RETELL_INBOUND_API_KEY: IN, RETELL_OUTBOUND_API_KEY: OUT };
  const body = '{"x":1}';
  assert.equal(await verifyRetellWorkspace(env, ["inbound", "outbound"], body, await signRetell(IN, body)), "inbound");
  assert.equal(await verifyRetellWorkspace(env, ["inbound", "outbound"], body, await signRetell(OUT, body)), "outbound");
  await assert.rejects(verifyRetellWorkspace(env, ["inbound"], body, await signRetell(OUT, body)), /Signature mismatch/, "outbound key never passes an inbound-only route");
  await assert.rejects(verifyRetellWorkspace({ RETELL_OUTBOUND_API_KEY: OUT }, ["inbound"], body, await signRetell(OUT, body)), /not configured \(RETELL_INBOUND_API_KEY\)/, "no fallback to the other workspace's key");
  await assert.rejects(verifyRetellWorkspace({ RETELL_INBOUND_API_KEY: IN, RETELL_OUTBOUND_API_KEY: IN }, ["inbound"], body, await signRetell(IN, body)), /identical/, "identical keys are ambiguous: refused");
  await assert.rejects(verifyRetellWorkspace({ RETELL_API_KEY: IN } as Partial<Env>, ["inbound", "outbound"], body, await signRetell(IN, body)), /not configured \(RETELL_INBOUND_API_KEY or RETELL_OUTBOUND_API_KEY\)/, "the legacy single key is never read");
  await assert.rejects(verifyRetellWorkspace(env, ["inbound"], body, `v=${Date.now() - 600_000},d=${"0".repeat(64)}`), /tolerance/);
  assert.equal(retellKey({ RETELL_INBOUND_API_KEY: "" }, "inbound"), undefined);
});

test("[VOICE-003] [SEC-002] routes: receptionist functions and the inbound webhook accept only the inbound workspace; events accept both", async () => {
  const t = await app({ RETELL_INBOUND_API_KEY: IN, RETELL_OUTBOUND_API_KEY: OUT });
  assert.equal((await t.post("/api/webhooks/retell/functions", { name: "get_packages_pricing", call: call("c_ws1"), args: {} }, IN)).status, 200);
  const wrong = await t.post("/api/webhooks/retell/functions", { name: "crm_upsert_lead", call: call("c_ws2"), args: { name: "Sal Sales", phone: "+15550100170", interest: "starter", requirements: "Wants a website" } }, OUT);
  assert.equal(wrong.status, 403, "a receptionist function signed by the sales workspace is refused");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM leads`), 0, "nothing ran");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'voice.wrong_workspace'`), 1);
  assert.equal((await t.post("/api/webhooks/retell/functions", { name: "record_consent", call: call("c_ws3"), args: { consent: true } }, OUT)).status, 200, "the sales agent may record consent");
  const inbound = { event: "call_inbound", call_inbound: { call_id: "c_ws4", from_number: "+15550100123", to_number: "+15550109999" } };
  assert.equal((await t.post("/api/webhooks/retell/inbound", inbound, OUT)).status, 401, "the receptionist's inbound webhook refuses the sales workspace");
  assert.equal((await t.post("/api/webhooks/retell/inbound", inbound, IN)).status, 200);
  assert.equal((await t.post("/api/webhooks/retell", { event: "call_started", call: call("c_ws5") }, IN)).status, 200);
  assert.equal((await t.post("/api/webhooks/retell", { event: "call_started", call: call("c_ws6") }, OUT)).status, 200, "sales-agent events still reach the optimizer");
  assert.equal((await t.post("/api/webhooks/retell", { event: "call_started", call: call("c_ws7") }, "key_some_other_workspace_00000")).status, 401);
});

test("[VOICE-003] a missing inbound key fails closed with a diagnostic that names the secret, even when the sales key is set", async () => {
  const t = await app({ RETELL_OUTBOUND_API_KEY: OUT });
  const raw = JSON.stringify({ name: "get_packages_pricing", call: call("c_ws8"), args: {} });
  const res = await t.client().request("POST", "/api/webhooks/retell/inbound", { body: raw, headers: { "x-retell-signature": await signRetell(OUT, raw) } });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /RETELL_INBOUND_API_KEY/);
  const row = await assessConfiguration({ db: t.db, env: t.env, storage: null }, "retell");
  assert.equal(row.status, "not_configured");
  assert.match(row.detail, /RETELL_INBOUND_API_KEY is not set/);
  assert.match(row.detail, /RETELL_OUTBOUND_API_KEY\): set/);
  assert.ok(!row.detail.includes(OUT), "never shows a value");
});

test("[VOICE-004] [SALESOPT-007] each Retell API caller uses only its own workspace key", async () => {
  // Receptionist prompt sync → inbound key only.
  const seen: string[] = [];
  const f = (async (_u: string, init: RequestInit = {}) => {
    seen.push(new Headers(init.headers).get("authorization") ?? "");
    return new Response(JSON.stringify({ agent_id: "agent_rcpt01", response_engine: { type: "retell-llm", llm_id: "llm_rcpt01" }, general_prompt: "" }), { status: 200 });
  }) as unknown as typeof fetch;
  const t = await app({ RETELL_INBOUND_API_KEY: IN, RETELL_OUTBOUND_API_KEY: OUT });
  const owner = await createStaff(t.db, "owner", "owner@crestmontwebsitedevelopment.com");
  const c = defaultVoiceConfig(); c.inbound.agent_id = "agent_rcpt01";
  await saveVoiceConfig(t.db, owner.id, c);
  const v = await createAgentConfig(t.db, owner.id, INBOUND_MASTER_INSTRUCTIONS, "master");
  await activateAgentConfig(t.db, owner.id, v.version);
  await syncPrompt({ db: t.db, env: t.env, fetch: f, userId: owner.id, mode: "push" });
  assert.ok(seen.length > 0);
  assert.ok(seen.every((h) => h === `Bearer ${IN}`), "receptionist prompt sync never uses the sales workspace key");
  // Without the inbound key nothing is sent, even though the sales key is present.
  seen.length = 0;
  const r = await syncPrompt({ db: t.db, env: { ...t.env, RETELL_INBOUND_API_KEY: undefined }, fetch: f, userId: owner.id, mode: "push" });
  assert.equal(r.status, "not_configured");
  assert.equal(seen.length, 0);
  // Receptionist follow-up calls need the inbound key; the sales optimizer needs the outbound key.
  assert.ok(outboundGate({ RETELL_OUTBOUND_API_KEY: OUT, RETELL_OUTBOUND: "on", ENVIRONMENT: "staging" } as Env, c).reasons.includes("RETELL_INBOUND_API_KEY is not set"));
  assert.ok((await productionGate(t.db, { RETELL_INBOUND_API_KEY: IN, ENVIRONMENT: "production" } as Env)).reasons.includes("RETELL_OUTBOUND_API_KEY is not set"));
  void TEST_PASSWORD;
});
