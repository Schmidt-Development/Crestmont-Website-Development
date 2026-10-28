// AI Website Builder V4 (Founder, 2026-10-28: local dual-model on owned GPUs), platform side. Every runner interaction
// here is a SIMULATED orchestrator (signed HTTP calls made by the test). No model is called; nothing is deployed.
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
const CAPS = ["local-model", "container-sandbox", "zero-token-cost", "git"];
async function worker(t: App, label: string, capacity = 1) {
  const r = await W.registerWorker({ db: t.db, userId: t.owner.id }, { label, maxActiveProjects: capacity });
  return { id: r.id, key: r.enrollmentKey, label };
}
const NODE1_STATUS = {
  gpu: { name: "NVIDIA GeForce RTX 5090", vramTotalMb: 32607, vramUsedMb: 19100, utilPercent: 87, driver: "581.57", source: "nvidia-smi (host sampler)" },
  inference: { state: "ready: qwen3.6:35b-a3b-q4_K_M", active: 2, queued: 3, maxConcurrent: 2, loaded: [{ model: "qwen3.6:35b-a3b-q4_K_M", vramMb: 23900 }], throughput: { "qwen3.6:35b-a3b-q4_K_M": { tokensPerSecond: 61.2 } }, switches: { count: 4, failures: 0, avgMs: 21000 } },
  slotsTotal: 4, slotsBusy: 2,
  models: [
    { tag: "qwen3.8:27b-q4_K_M", role: "architect_reviewer", family: "qwen3.8", parameterSize: "27B", quantization: "Q4_K_M", contextTokens: 65536, vramMb: 18000, vramSource: "configured-estimate", license: "Apache-2.0" },
    { tag: "qwen3.6:35b-a3b-q4_K_M", role: "builder", family: "qwen3.6", parameterSize: "35B-A3B", quantization: "Q4_K_M", contextTokens: 65536, vramMb: 23900, vramSource: "measured", license: "Apache-2.0", tokensPerSecond: 61.2, requests: 40 },
  ],
};
const claim = (t: App, w: { id: string; key: string }, status: Record<string, unknown> = {}) => runner(t, "claim", { runnerId: `orch-${w.id}`, capabilities: CAPS, workerId: w.id, workerKey: w.key, workerStatus: status });
const stageOf = async (t: App, pid: string) => (await PL.getPipeline(t.db, pid))?.stage;


test("[AIB-012] V4 GPU scheduling (simulated runner): one GPU worker serves many websites up to its measured capacity; waiting websites hold no capacity; priority with aging; no rented or paid capacity", async () => {
  const t = await app();
  await t.db.prepare(`UPDATE build_settings SET max_concurrent = 10`).run();
  // Only owned hardware can be registered; capacity is bounded.
  await assert.rejects(W.registerWorker({ db: t.db, userId: t.owner.id }, { label: "Rented A100", costClass: "rented-gpu" }), /separate Founder approval and budget/);
  await assert.rejects(W.registerWorker({ db: t.db, userId: t.owner.id }, { label: "Too big", maxActiveProjects: 99 }), /Concurrent website builds must be/);
  const n1 = await worker(t, "Node 1 RTX 5090", 2);
  // A wrong key is refused; telemetry is stored as reported, VRAM only with a named source.
  assert.equal((await runner(t, "claim", { runnerId: "x", capabilities: CAPS, workerId: n1.id, workerKey: "0".repeat(64) })).status, 403);
  await runner(t, "workers/status", { runnerId: "node1", workerId: n1.id, workerKey: n1.key, status: { gpu: { vramTotalMb: 32607, vramUsedMb: 1000 } } });
  assert.equal((await W.getWorker(t.db, n1.id))!.vram_used_mb, null, "VRAM without a telemetry source is not recorded (never fabricated)");
  await runner(t, "workers/status", { runnerId: "node1", workerId: n1.id, workerKey: n1.key, status: NODE1_STATUS });
  const w = (await W.getWorker(t.db, n1.id))!;
  assert.deepEqual([w.vram_total_mb, w.vram_used_mb, w.gpu_util_percent, w.telemetry_source, w.active_requests, w.queued_requests, w.max_concurrent_requests], [32607, 19100, 87, "nvidia-smi (host sampler)", 2, 3, 2]);
  const models = await W.listModels(t.db);
  assert.deepEqual(models.map((m) => [m.model_tag, m.role, m.loaded]), [["qwen3.8:27b-q4_K_M", "architect_reviewer", 0], ["qwen3.6:35b-a3b-q4_K_M", "builder", 1]]);
  assert.equal(models[1].vram_source, "measured");
  // Ten tracked websites; all get affinity to the one worker, but only its capacity runs at once.
  const sites = [];
  for (const name of ["Alpha Bakery", "Beta Plumbing", "Gamma Dental", "Delta Florist", "Epsilon Gym", "Zeta Law", "Eta Cafe", "Theta Auto", "Iota Salon", "Kappa Vet"]) sites.push(await website(t, name));
  await W.dispatch(t.db);
  for (const s of sites) assert.equal((await W.activeAssignment(t.db, s.pid))?.worker_id, n1.id);
  assert.equal(await stageOf(t, sites[0].pid), "WORKER_ASSIGNED");
  // Founder priority: Kappa Vet first, even though it arrived last.
  assert.equal((await t.oc.post(`/staff/builds/projects/${sites[9].pid}/priority`, { priority: "3" })).status, 303);
  const j1 = (await claim(t, n1, NODE1_STATUS)).json.job;
  assert.equal(j1.projectId, sites[9].pid, "highest priority first");
  assert.equal(j1.worker.maxActiveProjects, 2);
  const j2 = (await claim(t, n1)).json.job;
  assert.equal(j2.projectId, sites[0].pid, "then arrival order");
  assert.equal((await claim(t, n1)).json.reason, "at_capacity", "capacity 2: a third build waits");
  // Scheduler view: what the runner reports per build.
  await runner(t, "heartbeat", { jobId: j1.id, leaseToken: j1.leaseToken, turns: 3, orchestration: { activity: "gpu_waiting", model: "qwen3.8:27b-q4_K_M", task: "architecture" } });
  await runner(t, "heartbeat", { jobId: j2.id, leaseToken: j2.leaseToken, turns: 3, orchestration: { activity: "testing", model: "qwen3.6:35b-a3b-q4_K_M", task: "frontend" } });
  const sv = await W.schedulerView(t.db);
  assert.equal(sv.waitingForGpu, 1);
  assert.equal(sv.waitingForTests, 1);
  assert.equal(sv.executingGpuRequests, 2, "as reported by the GPU worker");
  assert.equal(sv.readyToRun, 8);
  assert.equal(sv.activeProjects, 10);
  // A website waiting for a person frees its capacity: another website runs meanwhile.
  await runner(t, "complete", { jobId: j1.id, leaseToken: j1.leaseToken, outcome: "ready_for_review", runCostUsd: 0, sourceCommit: "a1b2c3d4", previewUrl: null });
  assert.equal(await stageOf(t, sites[9].pid), "AWAITING_INTERNAL_APPROVAL");
  assert.equal((await W.activeAssignment(t.db, sites[9].pid))?.worker_id, n1.id, "affinity kept through review (workspace and checkpoints live there)");
  const j3 = (await claim(t, n1)).json.job;
  assert.equal(j3.projectId, sites[1].pid, "the freed capacity goes to the next website");
  // Aging: a low-priority website waiting long enough overtakes a newer default one (no starvation).
  const now = new Date();
  assert.equal(W.effectivePriority(-2, new Date(now.getTime() - 9 * 3600_000).toISOString(), now), 0);
  assert.equal(W.effectivePriority(0, now.toISOString(), now), 0);
  assert.ok(W.effectivePriority(-5, new Date(now.getTime() - 40 * 3600_000).toISOString(), now) > 0);
  // A second GPU worker later takes new websites without a scheduler change (most free capacity first).
  const n2 = await worker(t, "Node 2", 4);
  await runner(t, "workers/status", { runnerId: "node2", workerId: n2.id, workerKey: n2.key, status: {} });
  const late = await website(t, "Lambda Studio");
  await W.dispatch(t.db);
  assert.equal((await W.activeAssignment(t.db, late.pid))?.worker_id, n2.id);
  // A paused, a disconnected and a model-failed worker are not eligible.
  await runner(t, "workers/status", { runnerId: "node2", workerId: n2.id, workerKey: n2.key, status: { inference: { state: "failed: qwen3.6:35b-a3b-q4_K_M did not load within 300 s" } } });
  assert.match(String((await W.workerAvailability(t.db)).find((a) => a.workerId === n2.id)!.reason), /model server not ready/);
  // Dashboard pages render the GPU, the models and the scheduler view.
  const gw = await (await t.oc.get("/staff/builds/workers")).text();
  assert.match(gw, /NVIDIA GeForce RTX 5090/);
  assert.match(gw, /qwen3\.8:27b-q4_K_M/);
  assert.match(gw, /Model A: architect, reviewer/);
  assert.match(gw, /measured/);
  const pipe = await (await t.oc.get("/staff/builds/pipeline")).text();
  assert.match(pipe, /Kappa Vet/);
  assert.match(pipe, /Waiting for GPU/);
  assert.match(pipe, /Awaiting internal approval/);
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'builds.project_priority'`).first());
});

test("[AIB-013] review loop (simulated Model A reviewer): evidence overrules a premature 'ready', corrective prompts are traceable, models recorded, loops are bounded", async () => {
  const t = await app();
  const w = await worker(t, "Node 1");
  await runner(t, "workers/status", { runnerId: "node1", workerId: w.id, workerKey: w.key, status: {} });
  const site = await website(t, "Alpha Bakery");
  const job = (await claim(t, w)).json.job;
  const keys = (await t.db.prepare(`SELECT key FROM build_integrations WHERE project_id = ? ORDER BY key`).bind(site.pid).all<{ key: string }>()).results.map((r) => r.key);
  assert.deepEqual(keys, ["domain", "resend", "stripe"]);
  assert.equal((await runner(t, "pipeline/spec", { jobId: job.id, leaseToken: job.leaseToken, provider: "local:model-a", spec: { schema: "crestmont.master-spec/1" } })).status, 422);
  const spec = { schema: "crestmont.master-spec/1", projectSpec: "Bakery site", designSpec: "Warm", technicalArchitecture: "Static assets Worker", masterPrompt: "Build the bakery site.",
    tasks: [{ id: "t1", title: "Pages", workstream: "frontend", paths: ["public/"], dependsOn: [] }, { id: "t2", title: "Checkout adapter", workstream: "integration", paths: ["src/pay/"], dependsOn: ["t1"] }],
    acceptanceCriteria: [{ id: "ac-pages", text: "All pages", verification: "screenshot" }, { id: "integration-stripe", text: "Stripe adapter with mocks", verification: "automated" }],
    integrations: [{ key: "stripe", name: "Stripe", purpose: "Payments" }], assumptions: ["Draft copy is provisional"] };
  assert.equal((await runner(t, "pipeline/spec", { jobId: job.id, leaseToken: job.leaseToken, provider: "local:model-a", spec: { ...spec, tasks: [{ ...spec.tasks[0], dependsOn: ["t2"] }, spec.tasks[1]] } })).status, 422, "cyclic task graph refused");
  assert.equal((await runner(t, "pipeline/spec", { jobId: job.id, leaseToken: job.leaseToken, provider: "local:model-a", spec })).status, 200);
  const shots = [{ path: "s/home-desktop.png", viewport: "desktop", page: "/" }, { path: "s/home-mobile.png", viewport: "mobile", page: "/" }];
  const models = { builderModel: "qwen3.6:35b-a3b-q4_K_M", reviewerModel: "qwen3.8:27b-q4_K_M", routing: { builder: "B", reason: "routine frontend development" } };
  const submit = (cycle: number, extra: Record<string, unknown>) => runner(t, "cycles/submit", { jobId: job.id, leaseToken: job.leaseToken, cycle, prompt: cycle === 1 ? "Build the bakery site." : "fix", promptSource: cycle === 1 ? "architect" : "reviewer", reviewerProvider: "local:model-a", ...models, ...extra });
  // Cycle 1: the reviewer says "ready" (an older runner's decision name) but a check fails → overruled.
  let r = (await submit(1, { decision: "READY_FOR_FOUNDER_APPROVAL", nextPrompt: "Fix the failing link check on /menu.", evidence: { checks: [{ id: "links", ok: false }], criteria: [{ id: "ac-pages", status: "passed" }], screenshots: shots } })).json;
  assert.equal(r.decision, "FIX_DEFECTS");
  assert.match(r.reason, /Overruled/);
  assert.equal(await stageOf(t, site.pid), "REVISION_REQUIRED");
  assert.equal((await B.getJob(t.db, job.id))!.ai_acceptance, "failed");
  const row = (await t.db.prepare(`SELECT builder_model, reviewer_model, routing_json FROM build_cycles WHERE job_id = ? AND cycle = 1`).bind(job.id).first<{ builder_model: string; reviewer_model: string; routing_json: string }>())!;
  assert.deepEqual([row.builder_model, row.reviewer_model], ["qwen3.6:35b-a3b-q4_K_M", "qwen3.8:27b-q4_K_M"]);
  assert.equal((await submit(1, { decision: "READY_FOR_FINAL_QA", evidence: {} })).json.decision, "FIX_DEFECTS", "idempotent");
  assert.equal((await submit(5, { decision: "FIX_DEFECTS", evidence: {} })).status, 409);
  r = (await submit(2, { decision: "WAIT_FOR_EXTERNAL_SETUP", evidence: { checks: [{ id: "links", ok: true }], criteria: [{ id: "ac-pages", status: "passed" }, { id: "integration-stripe", status: "not_verified" }], screenshots: shots, integrationBlockers: ["Stripe live keys"] } })).json;
  assert.equal(r.decision, "WAIT_FOR_EXTERNAL_SETUP");
  assert.equal(await stageOf(t, site.pid), "WAITING_FOR_EXTERNAL_SETUP");
  assert.equal((await B.getJob(t.db, job.id))!.ai_acceptance, "passed_pending_integrations");
  r = (await submit(3, { decision: "WAIT_FOR_EXTERNAL_SETUP", nextPrompt: "Finish the menu page.", evidence: { checks: [{ id: "links", ok: true }], criteria: [{ id: "ac-pages", status: "failed" }], screenshots: shots, integrationBlockers: ["Stripe live keys"] } })).json;
  assert.equal(r.decision, "CONTINUE_BUILDING");
  const same = { decision: "FIX_DEFECTS", nextPrompt: "Fix the contrast issue.", evidence: { checks: [{ id: "a11y", ok: false }, { id: "links", ok: true }, { id: "perf", ok: true }], criteria: [{ id: "ac-pages", status: "passed" }, { id: "ac-menu", status: "passed" }], screenshots: shots } };
  assert.equal((await submit(4, same)).json.decision, "FIX_DEFECTS");
  assert.equal((await submit(5, same)).json.decision, "FIX_DEFECTS");
  r = (await submit(6, same)).json;
  assert.equal(r.decision, "ESCALATED");
  assert.equal(await stageOf(t, site.pid), "FAILED_NEEDS_INTERVENTION");
  // A passing cycle: the AI verdict sets "passed" but moves the website only to AI review, never past the private review.
  const t2 = await app();
  const w2 = await worker(t2, "Node 1");
  await runner(t2, "workers/status", { runnerId: "node1", workerId: w2.id, workerKey: w2.key, status: {} });
  const s2 = await website(t2, "Solo Site");
  const j2 = (await claim(t2, w2)).json.job;
  r = (await runner(t2, "cycles/submit", { jobId: j2.id, leaseToken: j2.leaseToken, cycle: 1, decision: "READY_FOR_INTERNAL_APPROVAL", evidence: { checks: [{ id: "build", ok: true }], criteria: [{ id: "ac", status: "passed" }], screenshots: shots } })).json;
  assert.equal(r.decision, "READY_FOR_INTERNAL_APPROVAL");
  assert.equal((await B.getJob(t2.db, j2.id))!.ai_acceptance, "passed");
  assert.equal(await stageOf(t2, s2.pid), "AI_REVIEW");
  assert.equal((await B.getJob(t2.db, j2.id))!.internal_approved_at, null, "no AI verdict approves anything");
  // A continuation without a corrective prompt is escalated; max cycles.
  const t3 = await app();
  const w3 = await worker(t3, "Node 1");
  await runner(t3, "workers/status", { runnerId: "node1", workerId: w3.id, workerKey: w3.key, status: {} });
  await website(t3, "Third Site");
  const j3 = (await claim(t3, w3)).json.job;
  r = (await runner(t3, "cycles/submit", { jobId: j3.id, leaseToken: j3.leaseToken, cycle: 1, decision: "CONTINUE_BUILDING", evidence: { checks: [{ id: "x", ok: false }] } })).json;
  assert.equal(r.decision, "ESCALATED");
  await t3.db.prepare(`UPDATE build_settings SET max_review_cycles = 2`).run();
  r = (await runner(t3, "cycles/submit", { jobId: j3.id, leaseToken: j3.leaseToken, cycle: 2, decision: "FIX_DEFECTS", nextPrompt: "x", evidence: { checks: [{ id: "y", ok: false }] } })).json;
  assert.match(r.reason, /limit of 2 review cycles/);
  assert.equal((await runner(t, "cycles/submit", { jobId: job.id, leaseToken: "0".repeat(64), cycle: 7, evidence: {} })).status, 409);
  const page = await (await t.oc.get(`/staff/builds/projects/${site.pid}/pipeline`)).text();
  assert.match(page, /Fix the contrast issue/);
  assert.match(page, /Overruled/);
  assert.match(page, /qwen3\.8:27b-q4_K_M/);
  assert.match(page, /routine frontend development/);
});

test("[AIB-014] sensitive actions and integration operations wait for the Owner while work continues; integrations are never marked live by the builder", async () => {
  const t = await app();
  const w = await worker(t, "Node 1");
  await runner(t, "workers/status", { runnerId: "node1", workerId: w.id, workerKey: w.key, status: {} });
  const site = await website(t, "Alpha Bakery");
  const job = (await claim(t, w)).json.job;
  assert.equal((await runner(t, "approvals/request", { jobId: job.id, leaseToken: job.leaseToken, kind: "run_tests", summary: "Run npm test" })).status, 422);
  const a1 = (await runner(t, "approvals/request", { jobId: job.id, leaseToken: job.leaseToken, kind: "credential_request", summary: "Stripe live secret key for payments" })).json;
  assert.equal(a1.status, "pending");
  assert.equal((await runner(t, "approvals/request", { jobId: job.id, leaseToken: job.leaseToken, kind: "credential_request", summary: "Stripe live secret key for payments" })).json.duplicate, true);
  // A trusted integration operation must name a catalogued operation.
  assert.equal((await runner(t, "approvals/request", { jobId: job.id, leaseToken: job.leaseToken, kind: "integration_operation", summary: "Check the Stripe test-mode key" })).status, 422);
  const op = (await runner(t, "approvals/request", { jobId: job.id, leaseToken: job.leaseToken, kind: "integration_operation", operation: "stripe.verify_test_key", summary: "Check the Stripe test-mode key works" })).json;
  assert.equal(op.status, "pending");
  assert.equal((await runner(t, "heartbeat", { jobId: job.id, leaseToken: job.leaseToken, costUsd: 0, turns: 1 })).status, 200, "work continues meanwhile");
  // The builder reports code + mock status; "live" from the runner is ignored; the trusted layer's sanitized result is kept.
  await runner(t, "integrations/report", { jobId: job.id, leaseToken: job.leaseToken, items: [{ key: "stripe", codeStatus: "implemented", mockStatus: "passed", liveStatus: "verified_live", sandboxStatus: "passed", sandboxEvidence: `HTTP 200 from api.stripe.com test mode with key ${["sk", "test", "FIXTURE" + "x".repeat(24)].join("_")}` }] });
  const stripe = (await t.db.prepare(`SELECT * FROM build_integrations WHERE project_id = ? AND key = 'stripe'`).bind(site.pid).first<{ id: string; code_status: string; mock_status: string; sandbox_status: string; sandbox_evidence: string; live_status: string }>())!;
  assert.deepEqual([stripe.code_status, stripe.mock_status, stripe.sandbox_status, stripe.live_status], ["implemented", "passed", "passed", "awaiting_credentials"]);
  assert.doesNotMatch(stripe.sandbox_evidence, /FIXTUREx/, "credential-like strings are redacted from evidence");
  const page = await (await t.oc.get("/staff/builds/pipeline")).text();
  assert.match(page, /Stripe live secret key for payments/);
  assert.match(page, /stripe\.verify_test_key/);
  assert.match(decodeURIComponent((await t.oc.post(`/staff/builds/approvals/${a1.id}/decide`, { decision: "reject", note: "" })).headers.getSetCookie().join(";")), /Give a reason/);
  assert.equal((await t.oc.post(`/staff/builds/approvals/${op.id}/decide`, { decision: "approve", note: "Test mode only" })).status, 303);
  const list = (await runner(t, "approvals/list", { jobId: job.id, leaseToken: job.leaseToken })).json.approvals as { id: string; status: string; operation: string | null }[];
  assert.deepEqual(list.find((x) => x.id === op.id), { ...list.find((x) => x.id === op.id), status: "approved", operation: "stripe.verify_test_key" });
  assert.equal((await t.oc.post(`/staff/builds/integrations/${stripe.id}/live`, { live: "1" })).status, 303);
  assert.equal((await t.db.prepare(`SELECT live_status FROM build_integrations WHERE id = ?`).bind(stripe.id).first<{ live_status: string }>())!.live_status, "verified_live");
  // A later build of the same project (e.g. a revision) sees the Owner's decision on the operation.
  await t.db.prepare(`CREATE TEMP TABLE j2 AS SELECT * FROM build_jobs WHERE id = ?`).bind(job.id).run();
  await t.db.prepare(`UPDATE j2 SET id = 'bjob_later', dedupe_key = 'later', state = 'canceled'`).run();
  await t.db.prepare(`INSERT INTO build_jobs SELECT * FROM j2`).run();
  assert.equal((await PL.approvalsForJob(t.db, "bjob_later")).find((x) => x.operation === "stripe.verify_test_key")?.status, "approved");
  assert.equal((await PL.approvalsForJob(t.db, "bjob_later")).some((x) => x.kind === "credential_request"), false, "other jobs' ordinary requests stay with their job");
  const pm = await createStaff(t.db, "project_manager", "pm-v2@crestmont.test");
  const pc = await t.client().login(pm.email, undefined, pm.secret);
  assert.equal((await pc.post(`/staff/builds/approvals/${a1.id}/decide`, { decision: "approve" })).status, 403);
});

test("[AIB-012] worker disconnects: the project returns to the queue with its work checkpointed; reassignment is explicit and audited", async () => {
  const t = await app();
  const w1 = await worker(t, "Node 1"), w2 = await worker(t, "Node 2");
  await runner(t, "workers/status", { runnerId: "node1", workerId: w1.id, workerKey: w1.key, status: {} });
  const site = await website(t, "Alpha Bakery");
  await W.dispatch(t.db);
  assert.equal((await W.activeAssignment(t.db, site.pid))!.worker_id, w1.id);
  const j = (await claim(t, w1)).json.job;
  assert.match(decodeURIComponent((await t.oc.post(`/staff/builds/projects/${site.pid}/reassign`, { reason: "move" })).headers.getSetCookie().join(";")), /A build is running/);
  const later = new Date(Date.now() + 3 * 3600_000);
  await B.sweepBuilds(t.db, later);
  assert.equal((await B.getJob(t.db, j.id))!.state, "queued");
  await runner(t, "workers/status", { runnerId: "node2", workerId: w2.id, workerKey: w2.key, status: {} });
  await t.db.prepare(`UPDATE build_workers SET last_seen_at = ? WHERE id = ?`).bind(later.toISOString(), w2.id).run();
  await W.sweepWorkers(t.db, later);
  assert.equal((await W.activeAssignment(t.db, site.pid))!.worker_id, w2.id, "reassigned to the connected worker");
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'builds.project_reassigned'`).first());
});

test("[AIB-017] private Crestmont review: a finished website is invisible to the customer until staff approve it internally and share it; no AI verdict, notification or status leaks it", async () => {
  const t = await app();
  const w = await worker(t, "Node 1");
  await runner(t, "workers/status", { runnerId: "node1", workerId: w.id, workerKey: w.key, status: {} });
  const site = await website(t, "Alpha Bakery");
  const job = (await claim(t, w)).json.job;
  const shots = [{ path: "s/a-desktop.png", viewport: "desktop", page: "/" }, { path: "s/a-mobile.png", viewport: "mobile", page: "/" }];
  await runner(t, "cycles/submit", { jobId: job.id, leaseToken: job.leaseToken, cycle: 1, decision: "READY_FOR_INTERNAL_APPROVAL", reviewerProvider: "local:model-a", evidence: { checks: [{ id: "build", ok: true }], criteria: [{ id: "ac", status: "passed" }], screenshots: shots } });
  const notesBefore = (await t.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?`).bind(site.cu.id).first<{ n: number }>())!.n;
  await runner(t, "complete", { jobId: job.id, leaseToken: job.leaseToken, outcome: "ready_for_review", runCostUsd: 0, sourceCommit: "a1b2c3d4", previewUrl: "https://cm-prv-alpha-b0.acct.workers.dev", previewName: "cm-prv-alpha-b0", previewGated: true });
  assert.equal(await stageOf(t, site.pid), "AWAITING_INTERNAL_APPROVAL");
  // The customer: no notification, no preview, no internal review results, only a neutral status.
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?`).bind(site.cu.id).first<{ n: number }>())!.n, notesBefore, "no website-ready notification");
  const status = await (await site.c.get(`/portal/projects/${site.pid}/build-status`)).json() as { status: string };
  assert.equal(status.status, "In internal review");
  assert.equal((await site.c.get(`/portal/projects/${site.pid}/previews/${job.id}`)).status, 404);
  const portal = await (await site.c.get(`/portal/projects/${site.pid}/revisions`)).text();
  assert.doesNotMatch(portal, /Website previews|cm-prv-alpha|READY_FOR|AI review|cycle/i);
  assert.equal((await site.c.get(`/staff/builds/projects/${site.pid}/pipeline`)).status, 403);
  // Order is enforced: no sharing and no final approval before the internal approval.
  const flash = (r: Response) => decodeURIComponent(r.headers.getSetCookie().join(";"));
  assert.match(flash(await t.oc.post(`/staff/builds/${job.id}/share-preview`, { action: "share" })), /Approve this build internally first/);
  assert.match(flash(await t.oc.post(`/staff/builds/${job.id}/approve`, { notes: "" })), /Approve the build internally first/);
  // Only builds.configure (Owner) may approve internally; a project manager cannot.
  const pm = await createStaff(t.db, "project_manager", "pm-int@crestmont.test");
  const pc = await t.client().login(pm.email, undefined, pm.secret);
  assert.equal((await pc.post(`/staff/builds/${job.id}/internal-approve`, { note: "" })).status, 403);
  // AI acceptance passed: no reason needed; approval is audited, still shares nothing.
  assert.equal((await t.oc.post(`/staff/builds/${job.id}/internal-approve`, { note: "" })).status, 303);
  assert.equal(await stageOf(t, site.pid), "READY_FOR_CUSTOMER_PREVIEW");
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'builds.internal_approved' AND subject_id = ?`).bind(job.id).first());
  assert.equal((await site.c.get(`/portal/projects/${site.pid}/previews/${job.id}`)).status, 404);
  assert.match(flash(await t.oc.post(`/staff/builds/${job.id}/internal-approve`, { note: "" })), /already approved internally/);
  // Explicit staff authorization shares it: portal, notification, customer review.
  assert.equal((await t.oc.post(`/staff/builds/${job.id}/share-preview`, { action: "share" })).status, 303);
  assert.equal(await stageOf(t, site.pid), "CUSTOMER_PREVIEW");
  assert.ok((await t.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?`).bind(site.cu.id).first<{ n: number }>())!.n > notesBefore);
  assert.match(await (await site.c.get(`/portal/projects/${site.pid}/revisions`)).text(), /Website previews/);
  assert.equal((await site.c.post(`/portal/projects/${site.pid}/previews/${job.id}/review`, { decision: "changes_requested", note: "Bigger logo please." })).status, 303);
  assert.equal(await stageOf(t, site.pid), "CUSTOMER_FEEDBACK");
  // Final approval after the internal one.
  assert.equal((await t.oc.post(`/staff/builds/${job.id}/approve`, { notes: "final" })).status, 303);
  assert.equal(await stageOf(t, site.pid), "APPROVED_FOR_DELIVERY");
  // A build that did not pass the automated review needs a written reason to be approved internally.
  const t2 = await app();
  const w2 = await worker(t2, "Node 1");
  await runner(t2, "workers/status", { runnerId: "node1", workerId: w2.id, workerKey: w2.key, status: {} });
  await website(t2, "Beta Site");
  const j2 = (await claim(t2, w2)).json.job;
  await runner(t2, "cycles/submit", { jobId: j2.id, leaseToken: j2.leaseToken, cycle: 1, decision: "FIX_DEFECTS", nextPrompt: "fix", evidence: { checks: [{ id: "build", ok: false }] } });
  await runner(t2, "complete", { jobId: j2.id, leaseToken: j2.leaseToken, outcome: "ready_for_review", runCostUsd: 0, sourceCommit: "b1", previewUrl: "https://cm-prv-beta-b0.acct.workers.dev", previewName: "cm-prv-beta-b0", previewGated: true });
  assert.match(flash(await t2.oc.post(`/staff/builds/${j2.id}/internal-approve`, { note: "ok" })), /did not pass the automated acceptance review/);
  assert.equal((await t2.oc.post(`/staff/builds/${j2.id}/internal-approve`, { note: "Checked by hand: the failing check is a flaky external link." })).status, 303);
  const audit = await t2.db.prepare(`SELECT details_json FROM audit_logs WHERE action = 'builds.internal_approved'`).first<{ details_json: string }>();
  assert.match(audit!.details_json, /"override":true/);
  // A build approved before the review gate existed can still be recorded as internally approved (then shared).
  await t2.db.prepare(`UPDATE build_jobs SET state = 'approved', internal_approved_at = NULL WHERE id = ?`).bind(j2.id).run();
  assert.equal((await t2.oc.post(`/staff/builds/${j2.id}/internal-approve`, { note: "Approved before the gate existed; recorded now." })).status, 303);
  assert.ok((await B.getJob(t2.db, j2.id))!.internal_approved_at);
});
