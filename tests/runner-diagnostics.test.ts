// Node 1 dispatch-to-GPU diagnostic, platform side (migration 0048). Every runner call here is a SIGNED HTTP FIXTURE
// made by the test: no runner process, no Ollama, no GPU. These tests prove that the platform records each checkpoint
// honestly (and refuses forged ones). They are NOT evidence that Node 1 executed anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, MemoryStorage } from "./support/app.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import * as DX from "../src/services/runner-diagnostics.ts";
import { sweepAiLeases } from "../src/services/ai-runner.ts";
import type { Env } from "../src/app/context.ts";

const SECRET = "diag-runner-secret";
type T = Awaited<ReturnType<typeof app>>;

async function app(extra: Partial<Env> = {}) {
  const t = await createTestApp({ BUILD_RUNNER_SECRET: SECRET, overrides: { storage: new MemoryStorage() }, ...extra });
  const owner = await createStaff(t.db, "owner", "owner@crestmont.test");
  const oc = await t.client().login(owner.email, undefined, owner.secret);
  return { ...t, owner, oc };
}
async function signed(t: T, path: string, body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const res = await t.client().request("POST", `/api/builds/runner/${path}`, { body: raw, headers: { "content-type": "application/json", "x-crestmont-runner-signature": `t=${ts},v1=${await hmacSha256Hex(secret, `${ts}.${raw}`)}` } });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const CAPS = ["local-model", "container-sandbox", "zero-token-cost", "git", "ai-drafts"];
async function queue(t: T) {
  const res = await t.oc.post("/staff/builds/diagnostics");
  assert.equal(res.status, 303);
  return res.headers.get("location")!.split("/").pop()!;
}
const status = async (t: T, id: string) => Object.fromEntries((await DX.getDiagnostic(t.db, id))!.steps.map((s) => [s.code, s.status]));

test("[AIB-021] diagnostic trace: created, persisted, worker known and fresh, offered, claimed, runner checkpoints D07–D11, result received and finalized (signed fixtures, no GPU)", async () => {
  const t = await app();
  const id = await queue(t);
  let d = (await DX.getDiagnostic(t.db, id))!;
  assert.deepEqual(d.steps.slice(0, 3).map((s) => s.status), ["pass", "pass", "missing"]);
  assert.equal(d.firstFailure?.code, "D03");
  assert.match(await (await t.oc.get(`/staff/builds/diagnostics/${id}`)).text(), /First unproven step: <strong>D03/);

  // The runner registers through its normal build claim (no build queued), then asks for drafts.
  assert.equal((await signed(t, "claim", { runnerId: "node1", version: "1.4.0", capabilities: CAPS })).json.job, null);
  const claim = await signed(t, "ai/claim", { runnerId: "node1" });
  const job = claim.json.job;
  assert.equal(job.workflow, DX.DIAGNOSTIC_WORKFLOW);
  assert.equal(job.prompt, DX.DIAGNOSTIC_PROMPT);
  assert.match(job.diagnostic.correlationId, /^corr_/);
  assert.equal(job.diagnostic.correlationId, d.correlationId);
  assert.deepEqual(await status(t, id), { D01: "pass", D02: "pass", D03: "pass", D04: "pass", D05: "pass", D06: "pass", D07: "missing", D08: "missing", D09: "missing", D10: "missing", D11: "missing", D12: "missing", D13: "missing" });

  // Runner checkpoints: authenticated by the lease token and the correlation id; only D07–D11.
  const cp = (code: string, extra: Record<string, unknown> = {}) => signed(t, "ai/checkpoint", { jobId: job.id, leaseToken: job.leaseToken, correlationId: job.diagnostic.correlationId, code, ok: true, at: new Date().toISOString(), component: "ollama", evidence: { code }, ...extra });
  assert.equal((await cp("D07", { component: "runner", evidence: { host: "NODE1" } })).status, 200);
  assert.equal((await cp("D12")).status, 422, "the runner cannot claim platform checkpoints");
  assert.equal((await cp("D08", { correlationId: "corr_other" })).status, 422);
  assert.equal((await cp("D08", { leaseToken: "0".repeat(64) })).status, 409);
  for (const c of ["D08", "D09", "D11"]) assert.equal((await cp(c)).status, 200, c);
  // Runner evidence keeps digests (they are the evidence) but credential-shaped strings are redacted.
  const sha = "a".repeat(64);
  assert.equal((await cp("D10", { evidence: { promptSha256: sha, leaked: "Bearer abcdefghijklmnopqrstuvwxyz012345", key: "sk-ant-api03-SECRETSECRETSECRET" } })).status, 200);
  const d10 = (await DX.getDiagnostic(t.db, id))!.steps.find((s) => s.code === "D10")!.row!.evidence!;
  assert.match(d10, new RegExp(sha));
  assert.doesNotMatch(d10, /abcdefghijklmnopqrstuvwxyz012345|SECRETSECRET/);
  const html = "<!doctype html><html><head><title>Junk in the Trunk</title></head><body><h1>Junk in the Trunk</h1><p>We haul it away.</p><script>alert(1)</script></body></html>";
  const done = await signed(t, "ai/complete", { jobId: job.id, leaseToken: job.leaseToken, text: html, model: "qwen3.6:35b-a3b-q4_K_M", inputTokens: 51, outputTokens: 88, correlationId: job.diagnostic.correlationId, diagnostic: { tokensPerSecond: 61.2, residency: { gpuPercent: 100 } } });
  assert.deepEqual(done.json, { status: "succeeded" });
  d = (await DX.getDiagnostic(t.db, id))!;
  assert.equal(d.firstFailure, null);
  assert.ok(d.steps.every((s) => s.status === "pass"));
  assert.equal(d.jobStatus, "succeeded", "a diagnostic never enters the human draft-approval queue");
  assert.equal(d.output, html);
  assert.equal(d.model, "self-hosted:qwen3.6:35b-a3b-q4_K_M");
  assert.match(d.steps.find((s) => s.code === "D12")!.row!.evidence!, /"sha256":"[0-9a-f]{64}"/);
  const page = await (await t.oc.get(`/staff/builds/diagnostics/${id}`)).text();
  assert.match(page, /All 13 steps recorded as passed/);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "the returned artifact is shown as escaped text, never rendered");
  assert.doesNotMatch(page, /<script>alert\(1\)/);
  // A late or replayed completion is refused.
  assert.equal((await signed(t, "ai/complete", { jobId: job.id, leaseToken: job.leaseToken, text: "again", model: "m" })).status, 409);
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'builds.diagnostic_created'`).first());
});

test("[AIB-021] the first unproven step is named: unregistered or stale runner, old runner without checkpoints, model failure, expired lease", async () => {
  const t = await app();
  // A runner that never made a build claim (no registration) and an Ollama failure reported at D09.
  const a = await queue(t);
  const j = (await signed(t, "ai/claim", { runnerId: "ghost" })).json.job;
  let st = await status(t, a);
  assert.equal(st.D03, "fail");
  assert.equal(st.D04, "fail");
  await signed(t, "ai/checkpoint", { jobId: j.id, leaseToken: j.leaseToken, correlationId: j.diagnostic.correlationId, code: "D07", ok: true, at: new Date().toISOString(), component: "runner" });
  await signed(t, "ai/checkpoint", { jobId: j.id, leaseToken: j.leaseToken, correlationId: j.diagnostic.correlationId, code: "D08", ok: true, at: new Date().toISOString(), component: "ollama" });
  await signed(t, "ai/checkpoint", { jobId: j.id, leaseToken: j.leaseToken, correlationId: j.diagnostic.correlationId, code: "D09", ok: false, at: new Date().toISOString(), component: "ollama", error: "model qwen3.6:35b-a3b-q4_K_M did not load: /api/generate → HTTP 404: model not found" });
  assert.deepEqual((await signed(t, "ai/complete", { jobId: j.id, leaseToken: j.leaseToken, error: "model not found", model: "qwen3.6:35b-a3b-q4_K_M" })).json, { status: "failed" });
  st = await status(t, a);
  assert.deepEqual([st.D09, st.D12, st.D13], ["fail", "fail", "fail"]);
  assert.equal((await DX.getDiagnostic(t.db, a))!.jobStatus, "failed", "never retried");
  assert.equal((await signed(t, "ai/claim", { runnerId: "ghost" })).json.job, null);

  // An older runner serves it as a plain draft: the round trip is proven, the runner steps are "not reported".
  await signed(t, "claim", { runnerId: "old-runner", version: "1.0.0", capabilities: CAPS });
  const b = await queue(t);
  const o = (await signed(t, "ai/claim", { runnerId: "old-runner" })).json.job;
  await signed(t, "ai/complete", { jobId: o.id, leaseToken: o.leaseToken, text: "<html><title>x</title><h1>x</h1><p>x</p></html>", model: "llama", inputTokens: 1, outputTokens: 2 });
  const vb = (await DX.getDiagnostic(t.db, b))!;
  assert.equal(vb.firstFailure?.code, "D07");
  assert.match(vb.steps.find((s) => s.code === "D12")!.row!.evidence!, /runner predates diagnostics/);
  assert.match(await (await t.oc.get(`/staff/builds/diagnostics/${b}`)).text(), /this runner version predates diagnostics/);
  // A current runner whose checkpoints did not arrive is not mistaken for an old runner.
  const e = await queue(t);
  const n = (await signed(t, "ai/claim", { runnerId: "old-runner" })).json.job;
  await signed(t, "ai/complete", { jobId: n.id, leaseToken: n.leaseToken, text: "<html><title>x</title><h1>x</h1><p>x</p></html>", model: "llama", correlationId: n.diagnostic.correlationId });
  assert.match(await (await t.oc.get(`/staff/builds/diagnostics/${e}`)).text(), /checkpoint never arrived/);

  // Claimed, then silence: the lease sweep fails it (no retry) and the gap is recorded at D12.
  const c = await queue(t);
  await signed(t, "ai/claim", { runnerId: "old-runner" });
  assert.equal(await sweepAiLeases(t.db, new Date(Date.now() + 20 * 60e3)), 1);
  const vc = (await DX.getDiagnostic(t.db, c))!;
  assert.equal(vc.jobStatus, "failed");
  assert.match(vc.steps.find((s) => s.code === "D12")!.row!.error!, /no result arrived before the 15-minute lease expired/);
  assert.equal((await signed(t, "ai/claim", { runnerId: "old-runner" })).json.job, null, "not requeued");
});

test("[AIB-021] connectivity view: no secret on the platform; rejected runner signatures are recorded (rate-limited, no secret material); runners and freshness", async () => {
  const none = await app({ BUILD_RUNNER_SECRET: undefined } as Partial<Env>);
  assert.equal((await signed(none, "claim", { runnerId: "node1" })).status, 503);
  assert.match(await (await none.oc.get("/staff/builds/diagnostics")).text(), /BUILD_RUNNER_SECRET is not set on this Worker/);

  const t = await app();
  // Unsigned requests (internet scanners) are refused without taking the logging slot.
  assert.equal((await t.client().request("POST", "/api/builds/runner/claim", { body: "{}", headers: { "content-type": "application/json" } })).status, 401);
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM security_events WHERE kind = 'runner_auth_failed'`).first<{ n: number }>())!.n, 0);
  for (let i = 0; i < 3; i++) assert.equal((await signed(t, "claim", { runnerId: "node1" }, "wrong-secret")).status, 401);
  const ev = (await t.db.prepare(`SELECT detail FROM security_events WHERE kind = 'runner_auth_failed'`).all<{ detail: string }>()).results;
  assert.equal(ev.length, 1, "recorded at most once a minute");
  assert.match(ev[0].detail, /Signature mismatch on \/api\/builds\/runner\/claim/);
  assert.doesNotMatch(ev[0].detail, /wrong-secret|v1=/);
  await signed(t, "claim", { runnerId: "node1", version: "1.4.0", capabilities: CAPS });
  const page = await (await t.oc.get("/staff/builds/diagnostics")).text();
  assert.match(page, /node1/);
  assert.match(page, /fresh/);
  assert.match(page, /Signature mismatch/);
  // Ordinary drafts are unchanged: they still go to human approval.
  await t.db.batch([
    t.db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, created_at, updated_at) VALUES ('ai_plain', 'support_reply', 'local-runner', 'x', 'queued', 'ticket:1', ?, ?)`).bind(new Date().toISOString(), new Date().toISOString()),
    t.db.prepare(`INSERT INTO ai_job_inputs (job_id, prompt, created_at) VALUES ('ai_plain', 'Draft a reply', ?)`).bind(new Date().toISOString()),
  ]);
  const pj = (await signed(t, "ai/claim", { runnerId: "node1" })).json.job;
  assert.equal(pj.diagnostic, undefined);
  assert.equal((await signed(t, "ai/checkpoint", { jobId: pj.id, leaseToken: pj.leaseToken, correlationId: "corr_x", code: "D07", ok: true })).status, 422, "checkpoints only for diagnostic jobs");
  assert.deepEqual((await signed(t, "ai/complete", { jobId: pj.id, leaseToken: pj.leaseToken, text: "Hello", model: "m" })).json, { status: "awaiting_approval" });
});
