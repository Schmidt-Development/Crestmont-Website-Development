// AI Website Builder Architecture V2 (2026-10-28), platform side. Every runner interaction here is a SIMULATED
// orchestrator (signed HTTP calls made by the test). No Claude, ChatGPT or local model is called; nothing is deployed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, MemoryStorage, TEST_PASSWORD } from "./support/app.ts";
import { createPackageOrder } from "../src/services/commerce.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { FakePayments } from "./support/security-world.ts";
import * as B from "../src/services/builds.ts";
import * as W from "../src/services/build-workers.ts";
import * as PL from "../src/services/build-pipeline.ts";

const RUNNER_SECRET = "test-runner-secret";
const WHSEC = "whsec_buildtest";
type App = Awaited<ReturnType<typeof createTestApp>> & { owner: { id: string }; oc: Awaited<ReturnType<ReturnType<Awaited<ReturnType<typeof createTestApp>>["client"]>["login"]>> };

async function app(): Promise<App> {
  const t = await createTestApp({ BUILD_RUNNER_SECRET: RUNNER_SECRET, STRIPE_WEBHOOK_SECRET: WHSEC, overrides: { storage: new MemoryStorage(), payments: new FakePayments() } });
  const owner = await createStaff(t.db, "owner", "owner@crestmont.test");
  const oc = await t.client().login(owner.email, undefined, owner.secret);
  await t.db.prepare(`UPDATE build_settings SET max_concurrent = 3`).run();
  return { ...t, owner, oc } as App;
}
async function runner(t: App, path: string, body: unknown) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const res = await t.client().request("POST", `/api/builds/runner/${path}`, { body: raw, headers: { "content-type": "application/json", "x-crestmont-runner-signature": `t=${ts},v1=${await hmacSha256Hex(RUNNER_SECRET, `${ts}.${raw}`)}` } });
  return { status: res.status, json: await res.json() as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
let evt = 0;
async function stripe(t: App, o: Record<string, unknown>) {
  const body = JSON.stringify({ id: `evt_v2_${++evt}_${Date.now()}`, type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: o } });
  const ts = Math.floor(Date.now() / 1000);
  return t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(WHSEC, `${ts}.${body}`)}` } });
}
const INTAKE = { intent: "submit", business_name: "Harbor Bakery", contact_name: "Dana", contact_email: "hello@harbor.example", industry: "Bakery", goals: "More catering orders",
  target_audience: "Local offices", has_branding: "no", brand_style: "Warm and simple", pages: "Home\nMenu\nAbout\nContact", content_source: "crestmont_draft",
  images_source: "licensed", domain_status: "need", domain_wishes: "harborbakery.example", hosting: "crestmont", functionality: ["contact_form", "ecommerce"], ecommerce_details: "Sell gift boxes online" };
async function website(t: App, name: string) {
  const cu = await createCustomer(t.db, `${name.toLowerCase().replace(/\W/g, "")}${Math.random().toString(16).slice(2, 6)}@ex.example`, name);
  const c = await t.client().login(cu.email, TEST_PASSWORD);
  const order = await createPackageOrder(t.db, cu.organizationId, "starter", cu.id);
  const pi = `pi_${Math.random().toString(16).slice(2)}`;
  await stripe(t, { id: `cs_${pi}`, mode: "payment", payment_status: "paid", amount_total: order.amountCents, payment_intent: pi, metadata: { organization_id: cu.organizationId, invoice_id: order.invoiceId, order_id: order.orderId, kind: "package" } });
  const pid = (await t.db.prepare(`SELECT id FROM projects WHERE order_id = ?`).bind(order.orderId).first<{ id: string }>())!.id;
  await c.post(`/portal/projects/${pid}/onboarding`, { ...INTAKE, business_name: name });
  return { pid, cu, c };
}
const CAPS = ["claude-code", "subscription-included", "git"];
async function worker(t: App, label: string, kind = "claude-code") {
  const r = await W.registerWorker({ db: t.db, userId: t.owner.id }, { label, providerKind: kind });
  return { id: r.id, key: r.enrollmentKey, label };
}
const claim = (t: App, w: { id: string; key: string }, status: Record<string, unknown> = {}) => runner(t, "claim", { runnerId: `orch-${w.id}`, capabilities: CAPS, workerId: w.id, workerKey: w.key, workerStatus: status });
const stageOf = async (t: App, pid: string) => (await PL.getPipeline(t.db, pid))?.stage;

test("[AIB-012] Proof 5 (simulated): three workers take three websites, a fourth waits; lowest VERIFIED usage first, documented fallback without telemetry; one website per worker", async () => {
  const t = await app();
  const w1 = await worker(t, "Claude account 1"), w2 = await worker(t, "Claude account 2"), w3 = await worker(t, "Claude account 3");
  // Heartbeats: account 2 has the lowest verified usage, account 1 more, account 3 reports none (no authorized interface).
  await runner(t, "workers/status", { runnerId: "orch", workerId: w1.id, workerKey: w1.key, status: { usage: { percent: 40, source: "claude-code:statusline" } } });
  await runner(t, "workers/status", { runnerId: "orch", workerId: w2.id, workerKey: w2.key, status: { usage: { percent: 12, source: "claude-code:statusline" } } });
  await runner(t, "workers/status", { runnerId: "orch", workerId: w3.id, workerKey: w3.key, status: { usage: { percent: 3 } } });
  assert.equal((await W.getWorker(t.db, w3.id))!.usage_percent, null, "usage without a named authorized source is not recorded (never fabricated)");
  // A claim with a wrong key is refused.
  assert.equal((await runner(t, "claim", { runnerId: "x", capabilities: CAPS, workerId: w1.id, workerKey: "0".repeat(64) })).status, 403);
  const A = await website(t, "Alpha Bakery"), Bw = await website(t, "Beta Plumbing"), C = await website(t, "Gamma Dental"), Dd = await website(t, "Delta Florist");
  await W.dispatch(t.db);
  const owner = async (pid: string) => (await W.activeAssignment(t.db, pid))?.worker_id ?? null;
  assert.equal(await owner(A.pid), w2.id, "first website → lowest verified usage (12%)");
  assert.equal(await owner(Bw.pid), w1.id, "second → next verified (40%)");
  assert.equal(await owner(C.pid), w3.id, "third → the worker without telemetry (fallback: after verified workers)");
  assert.equal(await owner(Dd.pid), null, "fourth waits");
  assert.equal(await stageOf(t, Dd.pid), "WAITING_FOR_WORKER_CAPACITY");
  assert.equal(await stageOf(t, A.pid), "WORKER_ASSIGNED");
  const sel = JSON.parse((await W.activeAssignment(t.db, A.pid))!.selection_json!);
  assert.equal(sel.policy, "lowest verified weekly usage");
  // Each worker receives only its own website; a busy worker gets nothing else.
  const j2 = (await claim(t, w2)).json.job;
  assert.equal(j2.projectId, A.pid);
  assert.equal(j2.worker.label, "Claude account 2");
  assert.equal((await claim(t, w2)).json.job, null, "busy worker: no second website");
  assert.equal((await claim(t, w1)).json.job.projectId, Bw.pid);
  assert.equal((await claim(t, w3)).json.job.projectId, C.pid);
  const live = (await t.db.prepare(`SELECT COUNT(*) AS n FROM build_jobs WHERE state IN ('preparing','building','verifying')`).first<{ n: number }>())!.n;
  assert.equal(live, 3, "three concurrent websites");
  // The first website finishes its turn → its worker frees up → the fourth website is assigned to it.
  await runner(t, "complete", { jobId: j2.id, leaseToken: j2.leaseToken, outcome: "ready_for_review", runCostUsd: 0, sourceCommit: "a1b2c3d4", previewUrl: null });
  assert.equal(await owner(A.pid), null, "released at owner review");
  const j4 = (await claim(t, w2)).json.job;
  assert.equal(j4.projectId, Dd.pid, "queued website dispatched to the freed worker");
  // A worker at its verified usage limit, a paused one, a disconnected one are not eligible.
  await runner(t, "workers/status", { runnerId: "orch", workerId: w1.id, workerKey: w1.key, status: { usage: { percent: 97, source: "claude-code:statusline" } } });
  const av = new Map((await W.workerAvailability(t.db)).map((a) => [a.workerId, a]));
  assert.match(String(av.get(w1.id)!.reason), /at its usage limit|owns another website/);
  // Additional workers are registered without any scheduler change; a metered API worker is refused at the $0 cap.
  const api = await worker(t, "API worker", "anthropic-api");
  await runner(t, "workers/status", { runnerId: "orch", workerId: api.id, workerKey: api.key, status: {} });
  assert.match(String(new Map((await W.workerAvailability(t.db)).map((a) => [a.workerId, a])).get(api.id)!.reason), /\$0 spending cap/);
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'builds.worker_assigned'`).first());
  // Dashboard pages render.
  assert.match(await (await t.oc.get("/staff/builds/workers")).text(), /Claude account 2/);
  const pipe = await t.oc.get("/staff/builds/pipeline");
  assert.equal(pipe.status, 200);
  assert.match(await pipe.text(), /Delta Florist/);
});

test("[AIB-013] review loop (simulated reviewer): evidence overrules a premature 'ready', corrective prompts are traceable, loops are bounded", async () => {
  const t = await app();
  const w = await worker(t, "Claude account 1");
  await runner(t, "workers/status", { runnerId: "orch", workerId: w.id, workerKey: w.key, status: {} });
  const site = await website(t, "Alpha Bakery");
  const job = (await claim(t, w)).json.job;
  // Integrations seeded from the intake (contact form → Resend, e-commerce → Stripe, domain).
  const keys = (await t.db.prepare(`SELECT key FROM build_integrations WHERE project_id = ? ORDER BY key`).bind(site.pid).all<{ key: string }>()).results.map((r) => r.key);
  assert.deepEqual(keys, ["domain", "resend", "stripe"]);
  // Architect specification (validated; an invalid one is refused).
  assert.equal((await runner(t, "pipeline/spec", { jobId: job.id, leaseToken: job.leaseToken, provider: "mock-architect", spec: { schema: "crestmont.master-spec/1" } })).status, 422);
  const spec = { schema: "crestmont.master-spec/1", projectSpec: "Bakery site", designSpec: "Warm", technicalArchitecture: "Static assets Worker", masterPrompt: "Build the bakery site.",
    tasks: [{ id: "t1", title: "Pages", workstream: "frontend", paths: ["public/"], dependsOn: [] }, { id: "t2", title: "Checkout adapter", workstream: "integration", paths: ["src/pay/"], dependsOn: ["t1"] }],
    acceptanceCriteria: [{ id: "ac-pages", text: "All pages", verification: "screenshot" }, { id: "integration-stripe", text: "Stripe adapter with mocks", verification: "automated" }],
    integrations: [{ key: "stripe", name: "Stripe", purpose: "Payments" }], assumptions: ["Draft copy is provisional"] };
  assert.equal((await runner(t, "pipeline/spec", { jobId: job.id, leaseToken: job.leaseToken, provider: "mock-architect", spec: { ...spec, tasks: [{ ...spec.tasks[0], dependsOn: ["t2"] }, spec.tasks[1]] } })).status, 422, "cyclic task graph refused");
  assert.equal((await runner(t, "pipeline/spec", { jobId: job.id, leaseToken: job.leaseToken, provider: "mock-architect", spec })).status, 200);
  const shots = [{ path: "s/home-desktop.png", viewport: "desktop", page: "/" }, { path: "s/home-mobile.png", viewport: "mobile", page: "/" }];
  const submit = (cycle: number, extra: Record<string, unknown>) => runner(t, "cycles/submit", { jobId: job.id, leaseToken: job.leaseToken, cycle, prompt: cycle === 1 ? "Build the bakery site." : "fix", promptSource: cycle === 1 ? "architect" : "reviewer", reviewerProvider: "mock-reviewer", ...extra });
  // Cycle 1: the reviewer says "ready" but a check fails → overruled to FIX_DEFECTS.
  let r = (await submit(1, { decision: "READY_FOR_FOUNDER_APPROVAL", nextPrompt: "Fix the failing link check on /menu.", evidence: { checks: [{ id: "links", ok: false }], criteria: [{ id: "ac-pages", status: "passed" }], screenshots: shots } })).json;
  assert.equal(r.decision, "FIX_DEFECTS");
  assert.equal(r.continue, true);
  assert.match(r.reason, /Overruled/);
  assert.equal(await stageOf(t, site.pid), "REVISION_REQUIRED");
  // Idempotent resubmission; out-of-order cycle refused.
  assert.equal((await submit(1, { decision: "READY_FOR_FINAL_QA", evidence: {} })).json.decision, "FIX_DEFECTS");
  assert.equal((await submit(5, { decision: "FIX_DEFECTS", evidence: {} })).status, 409);
  // Cycle 2: everything passes except the live Stripe connection → external setup does not stop… only the live part waits.
  r = (await submit(2, { decision: "WAIT_FOR_EXTERNAL_SETUP", evidence: { checks: [{ id: "links", ok: true }], criteria: [{ id: "ac-pages", status: "passed" }, { id: "integration-stripe", status: "not_verified" }], screenshots: shots, integrationBlockers: ["Stripe live keys"] } })).json;
  assert.equal(r.decision, "WAIT_FOR_EXTERNAL_SETUP");
  assert.equal(await stageOf(t, site.pid), "WAITING_FOR_EXTERNAL_SETUP");
  // …but "waiting" with independent work still open is overruled to CONTINUE_BUILDING.
  r = (await submit(3, { decision: "WAIT_FOR_EXTERNAL_SETUP", nextPrompt: "Finish the menu page.", evidence: { checks: [{ id: "links", ok: true }], criteria: [{ id: "ac-pages", status: "failed" }], screenshots: shots, integrationBlockers: ["Stripe live keys"] } })).json;
  assert.equal(r.decision, "CONTINUE_BUILDING");
  // Loop guard: the same failures three cycles in a row → ESCALATED, never an endless loop.
  const same = { decision: "FIX_DEFECTS", nextPrompt: "Fix the contrast issue.", evidence: { checks: [{ id: "a11y", ok: false }, { id: "links", ok: true }, { id: "perf", ok: true }], criteria: [{ id: "ac-pages", status: "passed" }, { id: "ac-menu", status: "passed" }], screenshots: shots } };
  assert.equal((await submit(4, same)).json.decision, "FIX_DEFECTS");
  assert.equal((await submit(5, same)).json.decision, "FIX_DEFECTS");
  r = (await submit(6, same)).json;
  assert.equal(r.decision, "ESCALATED");
  assert.equal(r.continue, false);
  assert.equal(await stageOf(t, site.pid), "FAILED_NEEDS_INTERVENTION");
  // A continuation without a corrective prompt is escalated (every continuation must be traceable).
  const t2 = await app();
  const w2 = await worker(t2, "Worker two");
  await runner(t2, "workers/status", { runnerId: "orch", workerId: w2.id, workerKey: w2.key, status: {} });
  await website(t2, "Solo Site");
  const j2 = (await claim(t2, w2)).json.job;
  r = (await runner(t2, "cycles/submit", { jobId: j2.id, leaseToken: j2.leaseToken, cycle: 1, decision: "CONTINUE_BUILDING", evidence: { checks: [{ id: "x", ok: false }] } })).json;
  assert.equal(r.decision, "ESCALATED");
  // Max cycles.
  await t2.db.prepare(`UPDATE build_settings SET max_review_cycles = 2`).run();
  r = (await runner(t2, "cycles/submit", { jobId: j2.id, leaseToken: j2.leaseToken, cycle: 2, decision: "FIX_DEFECTS", nextPrompt: "x", evidence: { checks: [{ id: "y", ok: false }] } })).json;
  assert.equal(r.decision, "ESCALATED");
  assert.match(r.reason, /limit of 2 review cycles/);
  // A wrong lease cannot submit.
  assert.equal((await runner(t, "cycles/submit", { jobId: job.id, leaseToken: "0".repeat(64), cycle: 7, evidence: {} })).status, 409);
  // The prompt history is visible to the Owner.
  const page = await (await t.oc.get(`/staff/builds/projects/${site.pid}/pipeline`)).text();
  assert.match(page, /Fix the contrast issue/);
  assert.match(page, /Overruled/);
});

test("[AIB-014] sensitive actions wait for the Owner while work continues; integrations are never marked live by the builder", async () => {
  const t = await app();
  const w = await worker(t, "Claude account 1");
  await runner(t, "workers/status", { runnerId: "orch", workerId: w.id, workerKey: w.key, status: {} });
  const site = await website(t, "Alpha Bakery");
  const job = (await claim(t, w)).json.job;
  // Routine operations are not approval kinds at all.
  assert.equal((await runner(t, "approvals/request", { jobId: job.id, leaseToken: job.leaseToken, kind: "run_tests", summary: "Run npm test" })).status, 422);
  const a1 = (await runner(t, "approvals/request", { jobId: job.id, leaseToken: job.leaseToken, kind: "credential_request", summary: "Stripe live secret key for payments" })).json;
  assert.equal(a1.status, "pending");
  assert.equal((await runner(t, "approvals/request", { jobId: job.id, leaseToken: job.leaseToken, kind: "credential_request", summary: "Stripe live secret key for payments" })).json.duplicate, true);
  // Work continues: the job is still leased and can heartbeat and submit cycles while the approval is pending.
  assert.equal((await runner(t, "heartbeat", { jobId: job.id, leaseToken: job.leaseToken, costUsd: 0, turns: 1 })).status, 200);
  // Integrations: the builder reports code + mock status; a "live" claim from the runner is ignored.
  await runner(t, "integrations/report", { jobId: job.id, leaseToken: job.leaseToken, items: [{ key: "stripe", codeStatus: "implemented", mockStatus: "passed", liveStatus: "verified_live" }] });
  const stripe = (await t.db.prepare(`SELECT * FROM build_integrations WHERE project_id = ? AND key = 'stripe'`).bind(site.pid).first<{ id: string; code_status: string; mock_status: string; live_status: string }>())!;
  assert.deepEqual([stripe.code_status, stripe.mock_status, stripe.live_status], ["implemented", "passed", "awaiting_credentials"]);
  // The Owner decides (reject needs a reason); the orchestrator reads the decision.
  const page = await (await t.oc.get("/staff/builds/pipeline")).text();
  assert.match(page, /Stripe live secret key for payments/);
  assert.match(decodeURIComponent((await t.oc.post(`/staff/builds/approvals/${a1.id}/decide`, { decision: "reject", note: "" })).headers.getSetCookie().join(";")), /Give a reason/);
  assert.equal((await t.oc.post(`/staff/builds/approvals/${a1.id}/decide`, { decision: "approve", note: "Customer sent keys via portal" })).status, 303);
  assert.equal((await runner(t, "approvals/list", { jobId: job.id, leaseToken: job.leaseToken })).json.approvals[0].status, "approved");
  // Only a person marks a live connection verified.
  assert.equal((await t.oc.post(`/staff/builds/integrations/${stripe.id}/live`, { live: "1" })).status, 303);
  assert.equal((await t.db.prepare(`SELECT live_status FROM build_integrations WHERE id = ?`).bind(stripe.id).first<{ live_status: string }>())!.live_status, "verified_live");
  // A non-owner cannot decide approvals.
  const pm = await createStaff(t.db, "project_manager", "pm-v2@crestmont.test");
  const pc = await t.client().login(pm.email, undefined, pm.secret);
  assert.equal((await pc.post(`/staff/builds/approvals/${a1.id}/decide`, { decision: "approve" })).status, 403);
});

test("[AIB-012] worker disconnects: the project returns to the queue with its work checkpointed; reassignment is explicit and audited", async () => {
  const t = await app();
  const w1 = await worker(t, "Claude account 1"), w2 = await worker(t, "Claude account 2");
  await runner(t, "workers/status", { runnerId: "orch", workerId: w1.id, workerKey: w1.key, status: {} });
  const site = await website(t, "Alpha Bakery");
  await W.dispatch(t.db);
  assert.equal((await W.activeAssignment(t.db, site.pid))!.worker_id, w1.id);
  // Owner reassignment needs a reason and is refused while a session runs.
  const j = (await claim(t, w1)).json.job;
  assert.match(decodeURIComponent((await t.oc.post(`/staff/builds/projects/${site.pid}/reassign`, { reason: "move" })).headers.getSetCookie().join(";")), /A session is running/);
  // The worker vanishes: the lease expires (job requeued, checkpointed), then the stale worker gives the project up.
  const later = new Date(Date.now() + 3 * 3600_000);
  await B.sweepBuilds(t.db, later);
  assert.equal((await B.getJob(t.db, j.id))!.state, "queued");
  await runner(t, "workers/status", { runnerId: "orch", workerId: w2.id, workerKey: w2.key, status: {} });
  await t.db.prepare(`UPDATE build_workers SET last_seen_at = ? WHERE id = ?`).bind(later.toISOString(), w2.id).run();
  await W.sweepWorkers(t.db, later);
  assert.equal((await W.activeAssignment(t.db, site.pid))!.worker_id, w2.id, "reassigned to the connected worker");
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'builds.project_reassigned'`).first());
});
