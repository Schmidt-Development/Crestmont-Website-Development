// Trusted integration-execution layer (Founder V4 §8), part 1: the catalogue of operations the runner itself may run
// for a website, on the agent's request, after the Owner approved that exact operation on the platform.
//
// Rules every operation keeps:
//  - test environments only: a live/production credential is refused before any request is made;
//  - read-only checks: nothing is created, charged, sent or changed in the provider account;
//  - credentials come from the runner's integration secrets directory (per project), never from the agent, its
//    workspace, its prompts or its environment; responses are reduced to a short, redacted summary;
//  - the request goes out through the runner's egress proxy, so the provider host must be on the allow-list.
// An operation that is not in this catalogue is never run; the agent's request is recorded as "not supported" for a
// person to handle. New operations are added here (code review), never described by a model.

export interface OperationContext {
  /** Secret values by name, read by the broker from the project's secrets directory. */
  secrets: Record<string, string>;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}

export interface OperationResult { ok: boolean; evidence: string }

export interface Operation {
  id: string;
  integration: string;
  description: string;
  /** Secret file names the operation needs (in <secrets>/integrations/<projectId>/). */
  secrets: string[];
  /** Hosts the request goes to (must be on the egress allow-list). */
  hosts: string[];
  run(ctx: OperationContext): Promise<OperationResult>;
}

export class RefusedOperationError extends Error {
  constructor(message: string) { super(message); this.name = "RefusedOperationError"; }
}

const stripeTestKey = (k: string) => {
  if (!/^(sk|rk)_test_[A-Za-z0-9]{10,}$/.test(k)) throw new RefusedOperationError("only a Stripe TEST-mode key (sk_test_ / rk_test_) is accepted; live keys are never used by the AI builder");
  return k;
};

async function stripeGet(ctx: OperationContext, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const key = stripeTestKey(ctx.secrets.STRIPE_TEST_SECRET_KEY ?? "");
  const res = await ctx.fetchImpl(`https://api.stripe.com${path}`, { headers: { authorization: `Bearer ${key}` }, signal: ctx.signal });
  let body: Record<string, unknown> = {};
  try { body = await res.json() as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.status, body };
}

export const OPERATIONS: Operation[] = [
  {
    id: "stripe.verify_test_key", integration: "stripe", description: "Check that the project's Stripe test-mode key works (GET /v1/balance; read-only, test mode only).",
    secrets: ["STRIPE_TEST_SECRET_KEY"], hosts: ["api.stripe.com"],
    async run(ctx) {
      const r = await stripeGet(ctx, "/v1/balance");
      if (r.status === 200 && r.body.livemode === false) return { ok: true, evidence: "Stripe API answered 200 in test mode (livemode=false)" };
      if (r.body.livemode === true) return { ok: false, evidence: "Stripe answered in LIVE mode: refused; provide a test-mode key" };
      return { ok: false, evidence: `Stripe API answered ${r.status}${typeof (r.body.error as Record<string, unknown> | undefined)?.type === "string" ? ` (${(r.body.error as Record<string, unknown>).type})` : ""}` };
    },
  },
  {
    id: "stripe.list_test_webhooks", integration: "stripe", description: "List the webhook endpoints configured in the project's Stripe test mode (GET /v1/webhook_endpoints; read-only).",
    secrets: ["STRIPE_TEST_SECRET_KEY"], hosts: ["api.stripe.com"],
    async run(ctx) {
      const r = await stripeGet(ctx, "/v1/webhook_endpoints?limit=20");
      if (r.status !== 200) return { ok: false, evidence: `Stripe API answered ${r.status}` };
      const data = Array.isArray(r.body.data) ? r.body.data as Record<string, unknown>[] : [];
      if (data.some((d) => d.livemode === true)) return { ok: false, evidence: "Stripe returned live-mode endpoints: refused" };
      const urls = data.map((d) => { try { const u = new URL(String(d.url)); return `${u.host}${u.pathname}`; } catch { return "?"; } });
      return { ok: true, evidence: `${data.length} test-mode webhook endpoint(s)${urls.length ? `: ${urls.slice(0, 5).join(", ")}` : ""}` };
    },
  },
  {
    id: "resend.verify_sending_domain", integration: "resend", description: "Check that the customer's own Resend account has a VERIFIED sending domain (GET /domains; read-only, sends nothing).",
    secrets: ["RESEND_API_KEY"], hosts: ["api.resend.com"],
    async run(ctx) {
      const key = ctx.secrets.RESEND_API_KEY ?? "";
      if (!/^re_[A-Za-z0-9_]{10,}$/.test(key)) throw new RefusedOperationError("only a Resend API key (re_…) is accepted");
      const res = await ctx.fetchImpl("https://api.resend.com/domains", { headers: { authorization: `Bearer ${key}` }, signal: ctx.signal });
      let body: Record<string, unknown> = {};
      try { body = await res.json() as Record<string, unknown>; } catch { /* non-JSON */ }
      if (res.status !== 200) return { ok: false, evidence: `Resend API answered ${res.status}` };
      const data = Array.isArray(body.data) ? body.data as Record<string, unknown>[] : [];
      const verified = data.filter((d) => d.status === "verified").map((d) => String(d.name ?? "?"));
      return verified.length ? { ok: true, evidence: `${verified.length} verified sending domain(s): ${verified.slice(0, 3).join(", ")}` } : { ok: false, evidence: `no verified sending domain (${data.length} domain(s) found)` };
    },
  },
];

export function findOperation(id: string): Operation | null {
  return OPERATIONS.find((o) => o.id === id) ?? null;
}
