// Phase 15: integration statuses read the right source and use the four words honestly (Not configured / Configured but
// unverified / Verified / Failing), per environment. TEST DATA; no provider is contacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./support/app.ts";
import { nowIso } from "../src/lib/db.ts";
import { assessConfiguration } from "../src/services/integrations.ts";
import type { Env } from "../src/app/context.ts";

const deps = (t: Awaited<ReturnType<typeof createTestApp>>, env: Partial<Env>, storage: unknown = null) => ({ db: t.db, env: { ...t.env, ...env } as Env, storage: storage as never });
const job = (db: Env["DB"], at: string | null, error: string | null = null) =>
  db.prepare(`INSERT INTO ingestion_status (source, last_success_at, last_attempt_at, last_error) VALUES ('job:ops_alerts', ?, ?, ?) ON CONFLICT(source) DO UPDATE SET last_success_at = excluded.last_success_at, last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error`)
    .bind(error ? null : at, at, error).run();

test("[INFRA-006] monitoring: alert routing is reported from the real job; a stopped scheduler is failing; no external uptime monitor is ever claimed", async () => {
  const t = await createTestApp({});
  const d = deps(t, { ENVIRONMENT: "staging" });
  let a = await assessConfiguration(d, "monitoring");
  assert.equal(a.status, "failing");
  assert.match(a.detail, /never run in staging/);
  await job(t.db, new Date(Date.now() - 3 * 3_600_000).toISOString());
  a = await assessConfiguration(d, "monitoring");
  assert.equal(a.status, "failing");
  assert.match(a.detail, /last ran 180 minutes ago .* scheduler may have stopped/);
  await job(t.db, nowIso(), "D1 timeout");
  assert.match((await assessConfiguration(d, "monitoring")).detail, /last operations-alert run failed \(D1 timeout\)/);
  await job(t.db, new Date(Date.now() - 5 * 60_000).toISOString());
  a = await assessConfiguration(d, "monitoring");
  assert.equal(a.status, "configured_unverified");
  assert.match(a.detail, /email the internal mailbox \(last run 5 minutes ago\)\. No external uptime monitor is configured/);
});

test("[VOICE-005] Retell outbound: not configured without the sales key; failing if the keys are identical or the live audit failed; verified only by a passing audit or real sales calls", async () => {
  const t = await createTestApp({});
  assert.equal((await assessConfiguration(deps(t, { ENVIRONMENT: "staging" }), "retell_outbound")).status, "not_configured");
  assert.equal((await assessConfiguration(deps(t, { ENVIRONMENT: "staging", RETELL_OUTBOUND_API_KEY: "k_same", RETELL_INBOUND_API_KEY: "k_same" }), "retell_outbound")).status, "failing");
  const d = deps(t, { ENVIRONMENT: "staging", RETELL_OUTBOUND_API_KEY: "k_out", RETELL_INBOUND_API_KEY: "k_in" });
  let a = await assessConfiguration(d, "retell_outbound");
  assert.equal(a.status, "configured_unverified");
  assert.match(a.detail, /no live audit has passed and no real sales call has completed here/);
  await t.db.prepare(`INSERT INTO audit_logs (actor_kind, action, subject_type, subject_id, details_json, created_at) VALUES ('system', 'sales_outbound.retell_audit', 'retell_agent', 'agent_sales', '{"status":"issues"}', ?)`).bind(new Date(Date.now() - 60_000).toISOString()).run();
  assert.equal((await assessConfiguration(d, "retell_outbound")).status, "failing");
  await t.db.prepare(`INSERT INTO audit_logs (actor_kind, action, subject_type, subject_id, details_json, created_at) VALUES ('system', 'sales_outbound.retell_audit', 'retell_agent', 'agent_sales', '{"status":"ok"}', ?)`).bind(nowIso()).run();
  a = await assessConfiguration(d, "retell_outbound");
  assert.equal(a.status, "verified");
  assert.match(a.detail, /passed the read-only audit .* in staging/);
});

test("[INFRA-002] environment bindings: missing secrets are named for this environment; all present is reported from the Worker itself", async () => {
  const t = await createTestApp({});
  assert.equal((await assessConfiguration(deps(t, { ENVIRONMENT: "development" }), "bindings")).status, "configured_unverified");
  let a = await assessConfiguration(deps(t, { ENVIRONMENT: "production", APP_URL: "https://crestmontwebsitedevelopment.com" }), "bindings");
  assert.equal(a.status, "degraded");
  assert.match(a.detail, /Missing in this production Worker: R2 file storage \(FILES\), SCHEDULER_TRIGGER_SECRET, STRIPE_SECRET_KEY/);
  const full: Partial<Env> = { ENVIRONMENT: "staging", APP_URL: "https://staging.example.com", SCHEDULER_TRIGGER_SECRET: "s", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x",
    RESEND_API_KEY: "re_x", RESEND_WEBHOOK_SECRET: "whsec_r", RETELL_INBOUND_API_KEY: "k_in", TURNSTILE_SECRET: "t", TURNSTILE_SITE_KEY: "t" };
  a = await assessConfiguration(deps(t, full, { kind: "r2" }), "bindings");
  assert.equal(a.status, "verified");
  assert.match(a.detail, /All 10 required bindings and secrets are present in this staging Worker .* Staging results never prove production/);
});
