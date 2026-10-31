// Compatibility of the two users of the self-hosted runner channel: the Node 1 dispatch-to-GPU diagnostic (#52/#64,
// migration 0050) and the Self-Improvement Engine's sales-optimization jobs (#49/#54). Both are served by the same
// signed /api/builds/runner/ai/* endpoints. Every runner call here is a SIGNED HTTP FIXTURE made by the test: no
// runner process, no Ollama/Qwen, no GPU. This proves the platform keeps the two apart; it is NOT evidence that Node 1
// executed anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, MemoryStorage } from "./support/app.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import * as DX from "../src/services/runner-diagnostics.ts";
import { SALES_OPT_SYSTEM_PROMPT } from "../src/services/ai-runner.ts";
import { LOCAL_RUNNER } from "../src/services/ai.ts";
import { WF } from "../src/services/sales-opt/jobs.ts";

const SECRET = "compat-runner-secret";
const CAPS = ["local-model", "container-sandbox", "zero-token-cost", "git", "ai-drafts"];

test("[AIB-021] [SALESOPT-003] Node 1 diagnostic and sales-optimization jobs share the runner channel without interfering (signed fixtures, no GPU)", async () => {
  const t = await createTestApp({ BUILD_RUNNER_SECRET: SECRET, overrides: { storage: new MemoryStorage() } });
  const owner = await createStaff(t.db, "owner", "owner@crestmont.test");
  const oc = await t.client().login(owner.email, undefined, owner.secret);
  const signed = async (path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const res = await t.client().request("POST", `/api/builds/runner/${path}`, { body: raw, headers: { "content-type": "application/json", "x-crestmont-runner-signature": `t=${ts},v1=${await hmacSha256Hex(SECRET, `${ts}.${raw}`)}` } });
    return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  // One sales-optimization analysis job queued first (as src/services/sales-opt/jobs.ts does), then a diagnostic.
  const soJob = newId("ai"), at = nowIso();
  await t.db.batch([
    t.db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, created_at, updated_at) VALUES (?,?,?, 'self-hosted', 'queued', ?, ?, ?)`).bind(soJob, WF.analysis, LOCAL_RUNNER, "so_analysis:compat", at, at),
    t.db.prepare(`INSERT INTO ai_job_inputs (job_id, prompt, created_at) VALUES (?,?,?)`).bind(soJob, "Analyse this fixture transcript.", at),
  ]);
  const res = await oc.post("/staff/builds/diagnostics");
  assert.equal(res.status, 303);
  const diagId = res.headers.get("location")!.split("/").pop()!;
  const diag = (await DX.getDiagnostic(t.db, diagId))!;

  // The runner registers, then claims twice: each job gets its own system prompt, lease and (for the diagnostic only) correlation id.
  assert.equal((await signed("claim", { runnerId: "node1", version: "1.4.0", capabilities: CAPS })).json.job, null);
  const first = (await signed("ai/claim", { runnerId: "node1" })).json.job;
  const second = (await signed("ai/claim", { runnerId: "node1" })).json.job;
  const so = [first, second].find((j) => j.workflow === WF.analysis)!;
  const dj = [first, second].find((j) => j.workflow === DX.DIAGNOSTIC_WORKFLOW)!;
  assert.ok(so && dj, "both jobs were offered");
  assert.equal(so.id, soJob);
  assert.equal(so.system, SALES_OPT_SYSTEM_PROMPT);
  assert.equal(so.diagnostic, undefined, "a sales-optimization job carries no diagnostic correlation id");
  assert.equal(dj.system, DX.DIAGNOSTIC_SYSTEM);
  assert.equal(dj.diagnostic.correlationId, diag.correlationId);
  assert.notEqual(so.leaseToken, dj.leaseToken);

  // A lease token for one job cannot write to the other.
  assert.equal((await signed("ai/checkpoint", { jobId: dj.id, leaseToken: so.leaseToken, correlationId: dj.diagnostic.correlationId, code: "D07", ok: true, at: nowIso(), component: "runner" })).status, 409);
  assert.equal((await signed("ai/complete", { jobId: so.id, leaseToken: dj.leaseToken, text: "x", model: "qwen3-fixture" })).status, 409);
  // A sales-optimization job cannot record diagnostic checkpoints.
  assert.equal((await signed("ai/checkpoint", { jobId: so.id, leaseToken: so.leaseToken, correlationId: dj.diagnostic.correlationId, code: "D07", ok: true, at: nowIso(), component: "runner" })).status >= 400, true);

  // Both complete.
  for (const c of ["D07", "D08", "D09", "D10", "D11"]) assert.equal((await signed("ai/checkpoint", { jobId: dj.id, leaseToken: dj.leaseToken, correlationId: dj.diagnostic.correlationId, code: c, ok: true, at: nowIso(), component: "ollama", evidence: { code: c } })).status, 200, c);
  const html = "<!doctype html><html><head><title>Junk in the Trunk</title></head><body><h1>Junk in the Trunk</h1><p>We haul it away.</p></body></html>";
  assert.deepEqual((await signed("ai/complete", { jobId: dj.id, leaseToken: dj.leaseToken, text: html, model: "qwen3-fixture", inputTokens: 5, outputTokens: 9, correlationId: dj.diagnostic.correlationId })).json, { status: "succeeded" });
  assert.deepEqual((await signed("ai/complete", { jobId: so.id, leaseToken: so.leaseToken, text: "{\"findings\":[]}", model: "qwen3-fixture", inputTokens: 5, outputTokens: 3 })).json, { status: "succeeded" });

  // Diagnostic: fully proven, never in the draft-approval queue, never counted as a sales-optimization analysis.
  assert.equal((await DX.getDiagnostic(t.db, diagId))!.firstFailure, null);
  const statuses = Object.fromEntries((await t.db.prepare(`SELECT id, status FROM ai_jobs WHERE id IN (?, ?)`).bind(so.id, dj.id).all<{ id: string; status: string }>()).results.map((r) => [r.id, r.status]));
  assert.deepEqual(statuses, { [so.id]: "succeeded", [dj.id]: "succeeded" });
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM ai_jobs WHERE status = 'awaiting_approval'`).first<{ n: number }>())!.n, 0);
  const analyses = (await t.db.prepare(`SELECT subject_id FROM audit_logs WHERE action = 'ai.analysis_completed'`).all<{ subject_id: string }>()).results.map((r) => r.subject_id);
  assert.deepEqual(analyses, [so.id], "only the sales-optimization job is recorded as an analysis");
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM runner_diagnostic_checkpoints c JOIN runner_diagnostics d ON d.id = c.diagnostic_id WHERE d.ai_job_id = ?`).bind(so.id).first<{ n: number }>())!.n, 0, "no checkpoints for the sales-optimization job");

  // Each dashboard shows its own job only.
  const soPage = await (await oc.get("/staff/sales-optimization")).text();
  assert.match(soPage, /qwen3-fixture/, "the Self-Improvement Engine runner panel names the model that completed its job");
  assert.match(soPage, /0 queued/);
  const dxPage = await (await oc.get(`/staff/builds/diagnostics/${diagId}`)).text();
  assert.doesNotMatch(dxPage, new RegExp(so.id), "the diagnostic page does not reference the sales-optimization job");
});
