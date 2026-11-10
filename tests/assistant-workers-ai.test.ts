// The public website assistant on Cloudflare Workers AI (Founder, 2026-11-10): the Worker's AI binding in the existing
// account, no key or subscription, capped below Cloudflare's free daily allocation. Only the website assistant uses it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./support/app.ts";
import { assistantProviderFromEnv, aiProviderFromEnv, WorkersAiProvider, WORKERS_AI_DEFAULT_MODEL } from "../src/services/ai.ts";
import { WORKERS_AI_DAILY_CALLS } from "../src/services/assistant.ts";

const ORIGIN = "http://crestmont.test";
type Call = { model: string; input: { messages: { role: string; content: string }[]; max_tokens: number } };
const fakeAi = (reply: string | ((c: Call) => string), calls: Call[] = []) => ({ calls, async run(model: string, input: Record<string, unknown>) { const c = { model, input } as Call; calls.push(c); return { response: typeof reply === "function" ? reply(c) : reply, usage: { prompt_tokens: 1800, completion_tokens: 90 } }; } });
const ask = (c: ReturnType<Awaited<ReturnType<typeof createTestApp>>["client"]>, messages: { role: string; content: string }[]) =>
  c.request("POST", "/api/assistant", { body: JSON.stringify({ messages }), headers: { "content-type": "application/json", origin: ORIGIN, "x-assistant-session": "sess-wai-1234" } });

test("[AIOPS-001] Workers AI answers the website assistant with grounded facts, multi-turn, no Owner budget and no cost; staff drafting never uses it", async () => {
  const ai = fakeAi("The Business package is $2,499 and includes up to the published pages. You can buy it at /checkout/business or compare packages at /pricing/compare.");
  const env = { ASSISTANT_PROVIDER: "workers-ai", AI: ai } as never;
  const t = await createTestApp(env);
  const c = t.client();
  const g = await (await c.get("/api/assistant")).json() as { available: boolean; reason: string };
  assert.deepEqual([g.available, g.reason], [true, "ok"], "available without any paid key or Owner budget");
  const r = await ask(c, [{ role: "user", content: "How much is the Business package?" }, { role: "assistant", content: "It depends what you need." }, { role: "user", content: "Just the Business one, please." }]);
  assert.equal(r.status, 200);
  const j = await r.json() as { reply: string; links: string[] };
  assert.match(j.reply, /\$2,499/);
  assert.deepEqual(j.links.sort(), ["/checkout/business", "/pricing/compare"].sort(), "checkout and comparison links are offered");
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].model, WORKERS_AI_DEFAULT_MODEL);
  const msgs = ai.calls[0].input.messages;
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /Business: \$2,499\./, "grounded in the published prices");
  assert.match(msgs[0].content, /HOW TO BUY A STANDARD PACKAGE/);
  assert.deepEqual(msgs.slice(1).map((m) => m.role), ["user", "assistant", "user"], "the whole conversation is sent");
  assert.ok(ai.calls[0].input.max_tokens <= 450);
  const job = await t.db.prepare(`SELECT provider, cost_microusd, status FROM ai_jobs WHERE workflow = 'website_assistant'`).first<{ provider: string; cost_microusd: number | null; status: string }>();
  assert.deepEqual([job!.provider, job!.cost_microusd, job!.status], ["workers-ai", null, "succeeded"], "no paid cost recorded");
  // Staff drafting and the builder keep their own backend: the AI binding never reaches them.
  assert.equal(aiProviderFromEnv(env), null);
});

test("[AIOPS-001] [SEC-002] Workers AI guardrails: an invented price is withheld, the daily cap stops calls before the free allocation, a provider error fails safely", async () => {
  const ai = fakeAi("Good news, Starter is only $499 this week!");
  const t = await createTestApp({ ASSISTANT_PROVIDER: "workers-ai", AI: ai } as never);
  const c = t.client();
  const j = await (await ask(c, [{ role: "user", content: "Any discounts on Starter?" }])).json() as { reply: string };
  assert.doesNotMatch(j.reply, /\$499/, "an unpublished price never reaches the visitor");
  assert.match(j.reply, /can't confirm that figure/);
  // The daily cap: once WORKERS_AI_DAILY_CALLS calls are recorded today, no further call is made.
  const now = new Date().toISOString();
  for (let i = 0; i < WORKERS_AI_DAILY_CALLS; i++) await t.db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, created_at, updated_at) VALUES (?, 'website_assistant', 'workers-ai', 'm', 'succeeded', 'x', ?, ?)`).bind(`ai_cap_${i}`, now, now).run();
  const before = ai.calls.length;
  const capped = await ask(t.client(), [{ role: "user", content: "One more question" }]);
  assert.equal(capped.status, 429);
  assert.match(((await capped.json()) as { message: string }).message, /as many questions as it can today/);
  assert.equal(ai.calls.length, before, "no Workers AI call past the cap");
  assert.equal(((await (await c.get("/api/assistant")).json()) as { reason: string }).reason, "daily_limit");
  // A provider failure is an honest error, never a made-up answer.
  const broken = await createTestApp({ ASSISTANT_PROVIDER: "workers-ai", AI: { run: async () => { throw new Error("AI binding unavailable"); } } } as never);
  const b = await ask(broken.client(), [{ role: "user", content: "hello" }]);
  assert.equal(b.status, 503);
  assert.match(((await b.json()) as { message: string }).message, /couldn't answer just now/);
});

test("[AIOPS-001] Workers AI is selected only when configured with a binding and a valid model; production before launch keeps the assistant closed", async () => {
  assert.equal(assistantProviderFromEnv({ ASSISTANT_PROVIDER: "workers-ai" }), null, "no binding, no assistant");
  assert.equal(assistantProviderFromEnv({ ASSISTANT_PROVIDER: "workers-ai", AI: fakeAi("x"), ASSISTANT_MODEL: "gpt-4; drop" }), null, "an invalid model id fails closed");
  assert.ok(assistantProviderFromEnv({ ASSISTANT_PROVIDER: "workers-ai", AI: fakeAi("x") }) instanceof WorkersAiProvider);
  assert.equal(assistantProviderFromEnv({}), null, "default unchanged: no paid key, no assistant");
  const prod = await createTestApp({ ENVIRONMENT: "production", ASSISTANT_PROVIDER: "workers-ai", AI: fakeAi("x") } as never);
  assert.equal((await ask(prod.client(), [{ role: "user", content: "hi" }])).status, 503, "the pre-launch gate still closes the assistant in production");
});

test("[AIOPS-001] [INFRA-006] the Workers AI daily-cap count is an index search, never a table scan (staging D1 overload, run 42793493743)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/services/assistant.ts", "utf8");
  const sql = /SELECT COUNT\(\*\) AS n FROM ai_jobs WHERE status IN \([^)]*\) AND provider = 'workers-ai' AND created_at >= \? AND created_at < \?/.exec(src)?.[0];
  assert.ok(sql, "the cap query is the indexed form");
  assert.doesNotMatch(src, /substr\(created_at, 1, 10\) = \?`\)\.bind\(day\)/, "no substr() scan");
  const t = await createTestApp();
  const raw = (t.db as unknown as { raw: { prepare(s: string): { all(...a: unknown[]): { detail: string }[] } } }).raw;
  const plan = raw.prepare(`EXPLAIN QUERY PLAN ${sql!.replace("COUNT(*) AS n", "COUNT(*)")}`).all("2026-11-10T00:00:00.000Z", "2026-11-11T00:00:00.000Z").map((r) => r.detail).join(" | ");
  assert.match(plan, /USING (COVERING )?INDEX idx_ai_jobs_queue/, plan);
  assert.doesNotMatch(plan, /SCAN ai_jobs/, plan);
});

test("[AIOPS-001] a database fault during an assistant request answers 503 with the friendly message, never a bare 500", async () => {
  const t = await createTestApp({ ASSISTANT_PROVIDER: "workers-ai", AI: fakeAi("hello") } as never);
  const env = t.env as unknown as { DB: { prepare: (s: string) => unknown } };
  const real = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (s: string) => { if (/FROM ai_jobs/.test(s)) throw new Error("D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window"); return real(s); };
  const r = await ask(t.client(), [{ role: "user", content: "hi" }]);
  assert.equal(r.status, 503);
  assert.match(((await r.json()) as { message: string }).message, /couldn't answer just now/);
});
