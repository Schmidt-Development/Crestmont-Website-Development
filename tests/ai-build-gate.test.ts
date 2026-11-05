// Phased launch: the production feature gate around autonomous AI website generation (src/domain/ai-build-gate.ts).
// Every runner interaction here is a signed HTTP fixture made by the test; no agent or model runs.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestApp, createCustomer, createStaff, MemoryStorage, TEST_PASSWORD } from "./support/app.ts";
import { createPackageOrder } from "../src/services/commerce.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { FakePayments } from "./support/security-world.ts";
import * as B from "../src/services/builds.ts";
import { aiBuildGate, configureAiBuildGateFromEnv, AI_BUILD_PRODUCTION_CLOSED } from "../src/domain/ai-build-gate.ts";
import { productionBlock } from "../scripts/provision-production.ts";
import type { Env } from "../src/app/context.ts";

const RUNNER_SECRET = "test-runner-secret";
const WHSEC = "whsec_gatetest";
type App = Awaited<ReturnType<typeof createTestApp>>;

// The gate is per-isolate state configured on every request; reset it so no other test inherits a closed gate.
afterEach(() => { configureAiBuildGateFromEnv({ ENVIRONMENT: "development" }); });

async function app(extra: Partial<Env> = {}) {
  const t = await createTestApp({ BUILD_RUNNER_SECRET: RUNNER_SECRET, STRIPE_WEBHOOK_SECRET: WHSEC, overrides: { storage: new MemoryStorage(), payments: new FakePayments() }, ...extra });
  const owner = await createStaff(t.db, "owner", "owner@crestmont.test");
  const oc = await t.client().login(owner.email, undefined, owner.secret);
  return { ...t, owner, oc };
}
async function runnerClaim(t: App) {
  const raw = JSON.stringify({ runnerId: "r1", capabilities: ["local-model", "container-sandbox", "zero-token-cost", "git"] });
  const ts = Math.floor(Date.now() / 1000);
  const res = await t.client().request("POST", "/api/builds/runner/claim", { body: raw, headers: { "content-type": "application/json", "x-crestmont-runner-signature": `t=${ts},v1=${await hmacSha256Hex(RUNNER_SECRET, `${ts}.${raw}`)}` } });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}
let evt = 0;
async function paid(t: App, orgId: string, inv: { orderId: string; invoiceId: string; amountCents: number }) {
  const pi = `pi_gate_${++evt}`;
  const body = JSON.stringify({ id: `evt_gate_${evt}_${Date.now()}`, type: "checkout.session.completed", created: Math.floor(Date.now() / 1000),
    data: { object: { id: `cs_${pi}`, mode: "payment", payment_status: "paid", amount_total: inv.amountCents, payment_intent: pi, metadata: { organization_id: orgId, invoice_id: inv.invoiceId, order_id: inv.orderId, kind: "package" } } } });
  const ts = Math.floor(Date.now() / 1000);
  return t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(WHSEC, `${ts}.${body}`)}` } });
}
const INTAKE = { intent: "submit", business_name: "Harbor Bakery", contact_name: "Dana", contact_email: "hello@harbor.example", industry: "Bakery", goals: "More catering orders",
  target_audience: "Local offices", has_branding: "no", brand_style: "Warm and simple", pages: "Home\nMenu\nContact", content_source: "crestmont_draft", images_source: "licensed",
  domain_status: "need", domain_wishes: "harborbakery.example", hosting: "crestmont", functionality: ["contact_form"], competitors: "" };

/** A paid Starter order with submitted intake: exactly the facts that queue a first build when the gate is open. */
async function paidProjectWithIntake(t: App) {
  const cu = await createCustomer(t.db, `c${Math.random().toString(16).slice(2, 8)}@ex.example`, "Harbor Bakery");
  const c = await t.client().login(cu.email, TEST_PASSWORD);
  const order = await createPackageOrder(t.db, cu.organizationId, "starter", cu.id);
  assert.equal((await paid(t, cu.organizationId, order)).status, 200);
  const pid = (await t.db.prepare(`SELECT id FROM projects WHERE order_id = ?`).bind(order.orderId).first<{ id: string }>())!.id;
  assert.equal((await c.post(`/portal/projects/${pid}/onboarding`, INTAKE)).status, 303);
  return pid;
}
const jobsOf = async (t: App, pid: string) => (await t.db.prepare(`SELECT state FROM build_jobs WHERE project_id = ?`).bind(pid).all<{ state: string }>()).results.map((r) => ({ state: r.state }));

test("phased launch: production is closed for every AI_BUILD_AUTOMATION value except exactly \"on\"; staging/dev are open unless \"off\"", () => {
  for (const v of [undefined, "", "off", "true", "yes", "ON", "On", "1", "enabled", " on-ish"]) {
    const g = aiBuildGate({ ENVIRONMENT: "production", AI_BUILD_AUTOMATION: v });
    assert.equal(g.open, false, `production must stay closed for ${JSON.stringify(v)}`);
    assert.equal(g.reason, AI_BUILD_PRODUCTION_CLOSED);
  }
  assert.equal(aiBuildGate({ ENVIRONMENT: "production", AI_BUILD_AUTOMATION: "on" }).open, true);
  assert.equal(aiBuildGate({ ENVIRONMENT: "staging" }).open, true, "the builder's staging certification keeps running");
  assert.equal(aiBuildGate({ ENVIRONMENT: "development" }).open, true);
  assert.equal(aiBuildGate({ ENVIRONMENT: "staging", AI_BUILD_AUTOMATION: "off" }).open, false);
});

test("phased launch: the committed production configuration keeps AI website generation off", () => {
  const block = productionBlock(readFileSync("wrangler.toml", "utf8")).replace(/#.*$/gm, "");
  const value = /AI_BUILD_AUTOMATION = "([^"]*)"/.exec(block)?.[1];
  assert.equal(value, "off");
  assert.equal(aiBuildGate({ ENVIRONMENT: "production", AI_BUILD_AUTOMATION: value }).open, false);
});

test("phased launch: on a production-configured isolate the Owner's database switch cannot reopen automation", async () => {
  const t = await createTestApp();
  await t.db.prepare(`UPDATE build_settings SET automation_enabled = 1, globally_paused = 0 WHERE id = 1`).run();
  configureAiBuildGateFromEnv({ ENVIRONMENT: "production" });
  const s = await B.getBuildSettings(t.db);
  assert.equal(s.automation_enabled, 0);
  assert.equal(s.globally_paused, 1);
  assert.equal(s.pause_reason, AI_BUILD_PRODUCTION_CLOSED);
  const raw = await t.db.prepare(`SELECT automation_enabled, globally_paused FROM build_settings WHERE id = 1`).first<{ automation_enabled: number; globally_paused: number }>();
  assert.deepEqual({ ...raw }, { automation_enabled: 1, globally_paused: 0 }, "the gate overrides; it never rewrites the Owner's stored settings");
  t.close();
});

test("phased launch: with the gate closed, a paid project with submitted intake creates no AI build, the sweep queues nothing and no runner is dispatched", async () => {
  const t = await app({ AI_BUILD_AUTOMATION: "off" });
  const pid = await paidProjectWithIntake(t);
  assert.deepEqual(await jobsOf(t, pid), [], "payment + intake must not create or queue AI work");
  // The project itself is real and waits for people: it moved into scope review like any human-delivered project.
  assert.equal((await t.db.prepare(`SELECT status FROM projects WHERE id = ?`).bind(pid).first<{ status: string }>())!.status, "scope_review");
  configureAiBuildGateFromEnv(t.env);
  await B.sweepBuilds(t.db);
  assert.deepEqual(await jobsOf(t, pid), [], "the recovery sweep must not enqueue either");
  // Even a job that somehow exists is never handed out.
  await t.db.prepare(`INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, state_reason, strategy, trigger, max_attempts, created_at, updated_at)
    SELECT 'bld_gate_probe', id, organization_id, 'first_build', 0, id || ':first', 'queued', 'probe', 'standard', 'sweep', 3, '2026-11-05T00:00:00Z', '2026-11-05T00:00:00Z' FROM projects WHERE id = ?`).bind(pid).run();
  const claim = await runnerClaim(t);
  assert.equal(claim.status, 200);
  assert.deepEqual(claim.json, { job: null, reason: "disabled_in_environment" });
  assert.equal((await t.db.prepare(`SELECT state FROM build_jobs WHERE id = 'bld_gate_probe'`).first<{ state: string }>())!.state, "queued", "nothing was leased");
  assert.equal(await t.db.prepare(`SELECT 1 FROM build_runners WHERE runner_id = 'r1'`).first(), null, "a closed gate records no runner check-in either");
  t.close();
});

test("phased launch: with the gate closed, Owner actions that would queue AI work are refused and change nothing", async () => {
  const t = await app({ AI_BUILD_AUTOMATION: "off" });
  const before = await t.db.prepare(`SELECT automation_enabled, globally_paused, updated_at FROM build_settings WHERE id = 1`).first();
  for (const [path, form] of [
    ["/staff/builds/pause", { paused: "0" }],
    ["/staff/builds/settings", { automation_enabled: "1", run_budget: "5", project_budget: "20", max_runtime: "60", max_turns: "100", max_concurrent: "1", max_attempts: "3", model: "qwen3-coder:30b" }],
    ["/staff/builds/backfill", { project_id: "prj_missing" }],
    ["/staff/builds/bld_missing/retry", {}],
    ["/staff/builds/bld_missing/resume", {}],
    ["/staff/builds/customer-revisions/rev_missing/forward", { instruction: "Change the hero" }],
  ] as const) {
    const res = await t.oc.post(path, form);
    assert.equal(res.status, 303, `${path} refuses with a message, not an error page`);
  }
  assert.deepEqual(await t.db.prepare(`SELECT automation_enabled, globally_paused, updated_at FROM build_settings WHERE id = 1`).first(), before);
  assert.equal(await t.db.prepare(`SELECT 1 FROM build_jobs LIMIT 1`).first(), null);
  const page = await (await t.oc.get("/staff/builds")).text();
  assert.match(page, /AI website generation is off on this environment/);
  assert.doesNotMatch(page, /Resume automation/, "no control is offered that the gate would refuse");
  assert.match(await (await t.oc.get("/staff/projects")).text(), /Delivered by the Crestmont team/, "staff are told paid projects are theirs to deliver");
  // Pausing (making things safer) stays possible.
  assert.equal((await t.oc.post("/staff/builds/pause", { paused: "1", reason: "Phase 1 human delivery" })).status, 303);
  assert.equal((await t.db.prepare(`SELECT globally_paused FROM build_settings WHERE id = 1`).first<{ globally_paused: number }>())!.globally_paused, 1);
  t.close();
});

test("phased launch control: the same paid project with the gate open still queues exactly one first build (the closed case is not vacuous)", async () => {
  const t = await app();
  const pid = await paidProjectWithIntake(t);
  assert.deepEqual(await jobsOf(t, pid), [{ state: "queued" }]);
  t.close();
});
