// Calls the real Worker (src/worker.js) with a local D1, a fixed clock and an optional fake fetch for providers.
// This is how the acceptance gates exercise the backend offline: the same code that is deployed, no mocks of it.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { migratedDb } from "./d1.mjs";
import { hmacSha256Hex } from "../../src/lib/crypto.js";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");

export async function app(o = {}) {
  const { db } = migratedDb(ROOT);
  let now = o.now ?? Date.parse("2030-03-04T15:00:00Z");
  const env = {
    DB: db, ENVIRONMENT: o.environment ?? "staging",
    ADMIN_SETUP_TOKEN: "setup-token-for-local-tests-0123456789",
    now: () => now,
    fetch: o.fetch,
    ...o.env,
  };
  const { handle } = await import(pathToFileURL(path.join(ROOT, "src", "worker.js")).href);
  const origin = "https://site.example";
  let cookie = "";
  async function call(method, p, body, headers = {}) {
    const h = { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers };
    const res = await handle(new Request(origin + p, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }), env);
    const set = res.headers.get("set-cookie");
    if (set) cookie = /Max-Age=0/.test(set) ? "" : set.split(";")[0];
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, headers: res.headers, text };
  }
  const same = { origin, "x-requested-with": "fetch" };
  return {
    env, db, call, same,
    get: (p, h) => call("GET", p, undefined, h),
    post: (p, b, h) => call("POST", p, b, h),
    adminPost: (p, b, h = {}) => call("POST", p, b, { ...same, ...h }),
    setNow: (ms) => { now = ms; },
    now: () => now,
    clearCookie: () => { cookie = ""; },
    /** Create the owner and sign in. */
    async signInOwner() {
      await call("POST", "/api/admin/setup", { token: env.ADMIN_SETUP_TOKEN, name: "Owner Test", email: "owner@site.example", password: "correct horse battery staple" }, same);
      return call("POST", "/api/admin/login", { email: "owner@site.example", password: "correct horse battery staple" }, same);
    },
    /** A Stripe-signed webhook delivery (the same algorithm Stripe uses). */
    async stripeEvent(event, secret = env.STRIPE_WEBHOOK_SECRET) {
      const payload = JSON.stringify(event);
      const t = Math.floor(now / 1000);
      return call("POST", "/api/webhooks/stripe", payload, { "content-type": "application/json", "stripe-signature": `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${payload}`)}` });
    },
  };
}

/** Recording fake of the Stripe API (only for offline tests; real test-mode verification is a separate gate). */
export function fakeStripe() {
  const calls = [];
  let n = 0;
  const f = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null;
    calls.push({ method: init.method ?? "GET", path: u.pathname, body, headers: init.headers ?? {} });
    if (u.hostname !== "api.stripe.com") return new Response("{}", { status: 404 });
    if (u.pathname === "/v1/checkout/sessions" && init.method === "POST") {
      n++;
      return Response.json({ id: `cs_test_${n}`, url: `https://checkout.stripe.com/c/pay/cs_test_${n}`, livemode: false, amount_total: Number(body["line_items[0][price_data][unit_amount]"]), currency: body["line_items[0][price_data][currency]"] });
    }
    const m = /^\/v1\/checkout\/sessions\/(.+)$/.exec(u.pathname);
    if (m) return Response.json(f.sessions?.[m[1]] ?? { id: m[1], status: "open", payment_status: "unpaid" });
    return new Response("{}", { status: 404 });
  };
  f.calls = calls;
  f.sessions = {};
  return f;
}
