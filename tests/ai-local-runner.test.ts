// Self-hosted AI drafts (AI_PROVIDER=local-runner). CONTROLLED FIXTURE: the "runner" here is the test making signed
// HTTP calls with canned text — no model runs. Proves the control-plane contract only, not real local inference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./support/app.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { requestAiDraft, aiProviderFromEnv, LOCAL_RUNNER } from "../src/services/ai.ts";
import { sweepAiLeases } from "../src/services/ai-runner.ts";

const SECRET = "test-runner-secret";
type App = Awaited<ReturnType<typeof createTestApp>>;
async function runner(t: App, path: string, body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const res = await t.client().request("POST", `/api/builds/runner/${path}`, { body: raw, headers: { "content-type": "application/json", "x-crestmont-runner-signature": `t=${ts},v1=${await hmacSha256Hex(secret, `${ts}.${raw}`)}` } });
  return { status: res.status, json: await res.json() as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const job = (t: App, id: string) => t.db.prepare(`SELECT status, model, cost_microusd, output_ref, error FROM ai_jobs WHERE id = ?`).bind(id).first<Record<string, any>>(); // eslint-disable-line @typescript-eslint/no-explicit-any

test("[AIOPS-002] local-runner backend is selected only explicitly and never falls back to a paid API", () => {
  assert.equal(aiProviderFromEnv({ AI_PROVIDER: "local-runner", BUILD_RUNNER_SECRET: "s", ANTHROPIC_API_KEY: "sk-ant-x" } as never), LOCAL_RUNNER);
  assert.equal(aiProviderFromEnv({ AI_PROVIDER: "local-runner", ANTHROPIC_API_KEY: "sk-ant-x" } as never), null, "no runner secret → AI off, not Anthropic");
});

test("[AIOPS-002] [SUP-004] queued draft → signed claim → completion awaits human approval at $0 per-token cost; bad lease rejected; unsigned refused", async () => {
  const t = await createTestApp({ BUILD_RUNNER_SECRET: SECRET });
  const q = await requestAiDraft(t.db, LOCAL_RUNNER, { workflow: "support_reply", inputRef: "ticket:tkt_1", prompt: "Customer asks about invoice timing.", requestedBy: null });
  assert.equal(q.status, "queued");
  assert.equal((await runner(t, "ai/claim", { runnerId: "rig-1" }, "wrong")).status, 401);
  const c = await runner(t, "ai/claim", { runnerId: "rig-1" });
  assert.equal(c.status, 200);
  assert.equal(c.json.job.id, q.jobId);
  assert.equal(c.json.job.prompt, "Customer asks about invoice timing.");
  assert.match(c.json.job.system, /draft that a human will review/);
  assert.equal((await runner(t, "ai/claim", { runnerId: "rig-2" })).json.job, null, "a leased job is not handed out twice");
  assert.equal((await runner(t, "ai/complete", { jobId: q.jobId, leaseToken: "0".repeat(64), text: "x" })).status, 409);
  const done = await runner(t, "ai/complete", { jobId: q.jobId, leaseToken: c.json.job.leaseToken, text: "Invoices are issued on the 1st.", model: "qwen3-coder:30b", inputTokens: 40, outputTokens: 9 });
  assert.deepEqual(done.json, { status: "awaiting_approval" });
  const row = (await job(t, q.jobId))!;
  assert.deepEqual([row.status, row.model, row.cost_microusd, row.output_ref], ["awaiting_approval", "self-hosted:qwen3-coder:30b", 0, "Invoices are issued on the 1st."]);
  assert.equal((await runner(t, "ai/complete", { jobId: q.jobId, leaseToken: c.json.job.leaseToken, text: "again" })).status, 409, "a finished lease cannot be reused");
});

test("[AIOPS-002] runner errors and expired leases requeue up to 3 attempts, then fail", async () => {
  const t = await createTestApp({ BUILD_RUNNER_SECRET: SECRET });
  const q = await requestAiDraft(t.db, LOCAL_RUNNER, { workflow: "lead_qualification", inputRef: "lead:l1", prompt: "p", requestedBy: null });
  const a = await runner(t, "ai/claim", { runnerId: "rig-1" });
  assert.deepEqual((await runner(t, "ai/complete", { jobId: q.jobId, leaseToken: a.json.job.leaseToken, error: "ollama timeout" })).json, { status: "queued" });
  await runner(t, "ai/claim", { runnerId: "rig-1" });
  assert.equal(await sweepAiLeases(t.db, new Date(Date.now() + 10 * 60_000)), 1);
  assert.equal((await job(t, q.jobId))!.status, "queued");
  const third = await runner(t, "ai/claim", { runnerId: "rig-1" });
  assert.deepEqual((await runner(t, "ai/complete", { jobId: q.jobId, leaseToken: third.json.job.leaseToken, error: "out of memory" })).json, { status: "failed" });
  assert.equal((await job(t, q.jobId))!.error, "out of memory");
});
