// Phase 12: the AI receptionist's status comes from the sources it really uses (Retell inbound key, voice settings,
// signed real calls in THIS environment, costs, the live audit) — never "not configured" because the wrong source was
// read, and never "verified" without evidence from this environment. TEST DATA; no Retell call is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import { receptionistStatus } from "../src/services/receptionist-status.ts";
import { refreshIntegrationHealth } from "../src/services/integrations.ts";
import type { Env } from "../src/app/context.ts";

const KEY = "key_test_receptionist_inbound";
async function call(db: Env["DB"], o: { env?: string; test?: boolean; to?: string; ended?: boolean; cost?: number | null } = {}) {
  const id = newId("call"), at = new Date(Date.now() - 3_600_000).toISOString();
  await db.prepare(`INSERT INTO calls (id, provider, provider_call_id, from_number, to_number, direction, recording_consent, started_at, ended_at, cost_microusd, is_test, environment, created_at)
    VALUES (?, 'retell', ?, '+15550100123', ?, 'inbound', 0, ?, ?, ?, ?, ?, ?)`).bind(id, id, o.to ?? "+15175550100", at, o.ended === false ? null : at, o.cost === undefined ? 120000 : o.cost, o.test ? 1 : 0, o.env ?? "staging", at).run();
}

test("[VOICE-005] receptionist status: not configured without the Retell key; configured but unverified until real calls; verified by real signed calls here", async () => {
  const none = await createTestApp({ ENVIRONMENT: "staging" });
  let s = await receptionistStatus(none.db, none.env);
  assert.equal(s.provider.state, "not_configured");
  assert.match(s.provider.detail, /RETELL_INBOUND_API_KEY .* is not set in staging/);

  const t = await createTestApp({ ENVIRONMENT: "staging", RETELL_INBOUND_API_KEY: KEY });
  s = await receptionistStatus(t.db, t.env);
  assert.deepEqual([s.provider.state, s.phone.state, s.agent.state, s.webhooks.state], ["configured_unverified", "not_configured", "not_configured", "configured_unverified"]);

  // Test calls and production calls do not prove staging.
  await call(t.db, { test: true });
  await call(t.db, { env: "production" });
  s = await receptionistStatus(t.db, t.env);
  assert.equal(s.provider.state, "configured_unverified");
  assert.equal(s.realCalls30, 0);

  // A real signed call answered in staging: the dashboard now agrees with reality.
  await call(t.db, { cost: null });
  await call(t.db);
  s = await receptionistStatus(t.db, t.env);
  assert.equal(s.provider.state, "verified");
  assert.match(s.provider.detail, /2 real signed calls received in staging/);
  assert.equal(s.phone.state, "verified");
  assert.match(s.phone.detail, /Real calls arrived on …0100 .* not listed in this environment's voice settings/);
  assert.equal(s.agent.state, "verified");
  assert.equal(s.webhooks.state, "verified");
  assert.equal(s.costs.state, "configured_unverified", "one call's cost has not arrived: not claimed as complete");
  assert.match(s.costs.detail, /1 of 2 real calls/);

  // Production, same database: staging's calls never count there.
  const prodEnv = { ...t.env, ENVIRONMENT: "production" as const };
  assert.equal((await receptionistStatus(t.db, prodEnv)).provider.state, "verified", "the production call above counts for production");
  const p2 = await createTestApp({ ENVIRONMENT: "production", RETELL_INBOUND_API_KEY: KEY });
  await call(p2.db, { env: "staging" });
  assert.equal((await receptionistStatus(p2.db, p2.env)).provider.state, "configured_unverified");

  // A failing live audit is shown as failing.
  await t.db.prepare(`INSERT INTO audit_logs (actor_kind, action, subject_type, subject_id, details_json, created_at) VALUES ('system', 'voice.retell_audit', 'retell_agent', 'agent_rcpt_1', '{"status":"issues"}', ?)`).bind(nowIso()).run();
  s = await receptionistStatus(t.db, t.env);
  assert.equal(s.agent.state, "failing");
  assert.match(s.agent.detail, /agent_rcpt_1.*found problems/);
});

test("[VOICE-005] the receptionist page and the Integrations rows show the same real status", async () => {
  const t = await createTestApp({ ENVIRONMENT: "staging", RETELL_INBOUND_API_KEY: KEY });
  await call(t.db);
  const owner = await createStaff(t.db, "owner");
  const c = t.client(); await c.login(owner.email, TEST_PASSWORD, owner.secret);
  const page = await (await c.get("/staff/voice")).text();
  assert.match(page, /Receptionist status — staging/);
  assert.match(page, /Provider \(Retell\)<\/th><td><span class="badge[^"]*"[^>]*>Verified/);
  assert.doesNotMatch(page, /No voice provider selected/);
  const rows = await refreshIntegrationHealth({ db: t.db, env: t.env, storage: null });
  const row = (id: string) => rows.find((r) => r.integration === id && r.environment === "staging")!;
  assert.equal(row("voice").status, "verified");
  assert.equal(row("telephony").status, "verified");
});
