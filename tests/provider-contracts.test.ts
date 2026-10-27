// Provider contract tests (SIMULATED): each adapter is driven against a recording fake of the provider's HTTP API
// and must send exactly the documented request shape, handle documented error answers, and never leak credentials
// into stored state. These prove the platform side of the contract only — not that a real provider accepted it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./support/app.ts";
import { StripeTestPayments, LivePaymentsNotAuthorized } from "../src/adapters/payments.ts";
import { ResendEmail } from "../src/adapters/email.ts";
import { AnthropicProvider, requestAiDraft } from "../src/services/ai.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
function recorder(reply: (c: Call, n: number) => Response) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const c: Call = { url: String(url), method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body ?? "") };
    calls.push(c);
    return reply(c, calls.length);
  }) as typeof fetch;
  return { f, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("[PAY-001] Stripe Checkout contract (simulated): form-encoded session with server prices, metadata on session and PaymentIntent, idempotency key; live keys refused", async () => {
  assert.throws(() => new StripeTestPayments("sk_live_abc"), LivePaymentsNotAuthorized);
  const r = recorder(() => json(200, { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }));
  const s = new StripeTestPayments("sk_test_contract", r.f);
  const out = await s.createCheckout({ mode: "payment", lines: [{ name: "Starter website package", amountCents: 99_900 }], customerEmail: "c@ex.example",
    successUrl: "https://staging.example/portal/billing?paid=1", cancelUrl: "https://staging.example/checkout/starter?cancelled=1",
    metadata: { invoice_id: "inv_1", order_id: "ord_1", organization_id: "org_1", kind: "package" }, idempotencyKey: "checkout:inv_1" });
  assert.deepEqual(out, { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  const c = r.calls[0];
  assert.equal(c.url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(c.method, "POST");
  assert.equal(c.headers.authorization, "Bearer sk_test_contract");
  assert.equal(c.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(c.headers["idempotency-key"], "checkout:inv_1");
  const form = new URLSearchParams(c.body);
  assert.equal(form.get("mode"), "payment");
  assert.equal(form.get("line_items[0][price_data][unit_amount]"), "99900");
  assert.equal(form.get("line_items[0][price_data][currency]"), "usd");
  assert.equal(form.get("metadata[invoice_id]"), "inv_1");
  assert.equal(form.get("payment_intent_data[metadata][invoice_id]"), "inv_1", "the PaymentIntent carries the invoice id for refunds and disputes");
  // Subscriptions: monthly recurring price, no payment_intent_data.
  await s.createCheckout({ mode: "subscription", lines: [{ name: "Essential maintenance", amountCents: 9_900 }], customerEmail: "c@ex.example", successUrl: "https://x/s", cancelUrl: "https://x/c", metadata: { product_id: "essential" }, recurringInterval: "month", idempotencyKey: "sub:1" });
  const sub = new URLSearchParams(r.calls[1].body);
  assert.equal(sub.get("line_items[0][price_data][recurring][interval]"), "month");
  assert.equal(sub.get("payment_intent_data[metadata][product_id]"), null);
  // Documented error envelope surfaces Stripe's message, never the key.
  const bad = new StripeTestPayments("sk_test_contract", recorder(() => json(400, { error: { type: "invalid_request_error", message: "Amount must be at least $0.50 usd" } })).f);
  await assert.rejects(bad.createCheckout({ mode: "payment", lines: [{ name: "x", amountCents: 1 }], customerEmail: "c@ex.example", successUrl: "https://x/s", cancelUrl: "https://x/c", metadata: {}, idempotencyKey: "k" }),
    (e: Error) => /Amount must be at least/.test(e.message) && !e.message.includes("sk_test"));
});

test("[PAY-007] Stripe refund + billing portal contracts (simulated): refund by PaymentIntent with amount and idempotency key; portal session for the customer", async () => {
  const r = recorder((c) => json(200, c.url.endsWith("/refunds") ? { id: "re_1", status: "pending" } : { url: "https://billing.stripe.com/p/session/1" }));
  const s = new StripeTestPayments("sk_test_contract", r.f);
  assert.deepEqual(await s.createRefund("pi_123", 5_000, "refund:ref_1"), { id: "re_1", status: "pending" });
  assert.equal(r.calls[0].url, "https://api.stripe.com/v1/refunds");
  assert.equal(r.calls[0].headers["idempotency-key"], "refund:ref_1");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(r.calls[0].body)), { payment_intent: "pi_123", amount: "5000" });
  assert.equal((await s.createBillingPortal("cus_1", "https://x/portal/billing")).url, "https://billing.stripe.com/p/session/1");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(r.calls[1].body)), { customer: "cus_1", return_url: "https://x/portal/billing" });
});

test("[EMAIL-003] Resend contract (simulated): POST /emails with bearer key and idempotency key; failures retried up to 5 attempts then failed; the key never reaches stored errors", async () => {
  const t = await createTestApp();
  let status = 200;
  const r = recorder(() => status === 200 ? json(200, { id: "re_msg_1" }) : json(status, { name: "validation_error", message: "The `to` field is invalid." }));
  const mail = new ResendEmail(t.db, "re_test_SECRETKEY123456", "Crestmont <support@crestmontwebsitedevelopment.com>", r.f);
  const msg = { template: "verification", to: "dana@harbor.example", subject: "Confirm your email", html: "<p>Hi</p>", text: "Hi", idempotencyKey: "verify:usr_1:abc" } as never;
  const ok = await mail.send(msg);
  assert.equal(ok.status, "sent");
  const c = r.calls[0];
  assert.equal(c.url, "https://api.resend.com/emails");
  assert.equal(c.headers.authorization, "Bearer re_test_SECRETKEY123456");
  assert.equal(c.headers["idempotency-key"], "verify:usr_1:abc");
  assert.deepEqual(JSON.parse(c.body), { from: "Crestmont <support@crestmontwebsitedevelopment.com>", to: ["dana@harbor.example"], subject: "Confirm your email", html: "<p>Hi</p>", text: "Hi" });
  assert.equal((await t.db.prepare(`SELECT provider_message_id FROM email_deliveries WHERE id = ?`).bind(ok.deliveryId).first<{ provider_message_id: string }>())!.provider_message_id, "re_msg_1");
  // The same idempotency key is never sent twice.
  assert.equal((await mail.send(msg)).status, "duplicate");
  assert.equal(r.calls.length, 1);
  // Provider rejections: queued for retry, then failed after five attempts.
  status = 422;
  const bad = await mail.send({ ...(msg as object), idempotencyKey: "verify:usr_2:def" } as never);
  for (let i = 0; i < 4; i++) await mail.attempt(bad.deliveryId, { ...(msg as object), idempotencyKey: "verify:usr_2:def" } as never);
  const row = (await t.db.prepare(`SELECT status, attempts, last_error FROM email_deliveries WHERE id = ?`).bind(bad.deliveryId).first<{ status: string; attempts: number; last_error: string }>())!;
  assert.deepEqual([row.status, row.attempts], ["failed", 5]);
  assert.match(row.last_error, /Resend 422: The `to` field is invalid/);
  assert.doesNotMatch(row.last_error, /SECRETKEY/);
});

test("[AIOPS-002] AI provider contract (simulated): Messages API request shape, usage-based cost, drafts await human approval, provider errors fail the job without leaking the key", async () => {
  const t = await createTestApp();
  let mode: "ok" | "overloaded" = "ok";
  const r = recorder(() => mode === "ok" ? json(200, { content: [{ type: "text", text: "Draft reply for review." }], usage: { input_tokens: 1000, output_tokens: 200 } })
    : json(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
  const p = new AnthropicProvider("sk-ant-test-SECRET", "claude-sonnet-5-5", r.f);
  const res = await requestAiDraft(t.db, p, { workflow: "support_reply", inputRef: "ticket:tkt_1", prompt: "Customer asks about invoice timing.", requestedBy: null });
  assert.equal(res.status, "awaiting_approval");
  const c = r.calls[0];
  assert.equal(c.url, "https://api.anthropic.com/v1/messages");
  assert.equal(c.headers["x-api-key"], "sk-ant-test-SECRET");
  assert.equal(c.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(c.body);
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.match(body.system, /draft that a human will review/);
  assert.deepEqual(body.messages, [{ role: "user", content: "Customer asks about invoice timing." }]);
  const job = (await t.db.prepare(`SELECT status, cost_microusd FROM ai_jobs WHERE id = ?`).bind(res.jobId).first<{ status: string; cost_microusd: number }>())!;
  assert.deepEqual([job.status, job.cost_microusd], ["awaiting_approval", 1000 * 3 + 200 * 15]);
  mode = "overloaded";
  const failed = await requestAiDraft(t.db, p, { workflow: "support_reply", inputRef: "ticket:tkt_2", prompt: "x", requestedBy: null });
  assert.equal(failed.status, "failed");
  const err = (await t.db.prepare(`SELECT error FROM ai_jobs WHERE id = ?`).bind(failed.jobId).first<{ error: string }>())!.error;
  assert.match(err, /Anthropic 529: Overloaded/);
  assert.doesNotMatch(err, /SECRET/);
});
