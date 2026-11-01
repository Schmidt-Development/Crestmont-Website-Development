// Cloudflare Worker entry: /api/* runs here (everything else is a static asset from public/).
// Bindings (wrangler.jsonc): DB (this website's own D1 database), ASSETS. Secrets live on the CUSTOMER's account:
// STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, MAIL_FROM, ADMIN_SETUP_TOKEN. Nothing secret is in source.
import { HttpError, errorResponse, json, SECURITY_HEADERS } from "./lib/http.js";
import { ensureSeeded, one } from "./lib/db.js";
import { processOutbox } from "./lib/notify.js";
import * as pub from "./routes/public.js";
import * as adm from "./routes/admin.js";
import * as cus from "./routes/customer.js";
import { stripeWebhook } from "./routes/webhooks.js";

/** [method, pattern, handler(env, request, url, params)] — first match wins. */
const ROUTES = [
  ["GET", /^\/api\/health$/, health],
  ["GET", /^\/api\/config$/, (env) => pub.publicConfig(env)],
  ["GET", /^\/api\/services$/, (env) => pub.listServices(env)],
  ["GET", /^\/api\/availability$/, (env, req, url) => pub.getAvailability(env, url)],
  ["POST", /^\/api\/bookings$/, (env, req) => pub.createBooking(env, req)],
  ["GET", /^\/api\/bookings\/(BK-[A-Z0-9]{8})$/, (env, req, url, p) => pub.getBooking(env, req, p[1])],
  ["POST", /^\/api\/bookings\/(BK-[A-Z0-9]{8})\/cancel$/, (env, req, url, p) => pub.cancelBooking(env, req, p[1])],
  ["POST", /^\/api\/bookings\/(BK-[A-Z0-9]{8})\/reschedule$/, (env, req, url, p) => pub.rescheduleBooking(env, req, p[1])],
  ["POST", /^\/api\/bookings\/(BK-[A-Z0-9]{8})\/checkout$/, (env, req, url, p) => pub.checkout(env, req, p[1], env.fetch ?? fetch)],
  ["POST", /^\/api\/quotes$/, (env, req) => pub.createQuote(env, req)],
  ["POST", /^\/api\/contact$/, (env, req) => pub.createContact(env, req)],
  ["POST", /^\/api\/webhooks\/stripe$/, (env, req) => stripeWebhook(env, req)],
  ["POST", /^\/api\/account\/register$/, (env, req) => cus.register(env, req)],
  ["POST", /^\/api\/account\/login$/, (env, req) => cus.customerLogin(env, req)],
  ["POST", /^\/api\/account\/logout$/, (env, req) => cus.customerLogout(env, req)],
  ["GET", /^\/api\/account$/, (env, req) => cus.myAccount(env, req)],
  ["POST", /^\/api\/admin\/setup$/, (env, req) => adm.setup(env, req)],
  ["POST", /^\/api\/admin\/login$/, (env, req) => adm.login(env, req)],
  ["POST", /^\/api\/admin\/logout$/, (env, req) => adm.logout(env, req)],
  ["GET", /^\/api\/admin\/me$/, (env, req) => adm.me(env, req)],
  ["GET", /^\/api\/admin\/dashboard$/, (env, req) => adm.dashboard(env, req)],
  ["GET", /^\/api\/admin\/(bookings|quotes|messages|payments|notifications|audit)$/, (env, req, url, p) => adm.list(env, req, p[1], url)],
  ["POST", /^\/api\/admin\/(quotes|messages)\/([a-z]{3}_[0-9a-f]{24})\/status$/, (env, req, url, p) => adm.setStatus(env, req, p[1], p[2])],
  ["POST", /^\/api\/admin\/bookings\/(bkg_[0-9a-f]{24})\/(cancel|complete|no_show|reschedule)$/, (env, req, url, p) => adm.bookingAction(env, req, p[1], p[2])],
  ["GET", /^\/api\/admin\/bookings\/(bkg_[0-9a-f]{24})\/history$/, (env, req, url, p) => adm.bookingHistory(env, req, p[1])],
  ["POST", /^\/api\/admin\/settings$/, (env, req) => adm.updateSettings(env, req)],
  ["POST", /^\/api\/admin\/services\/([a-z0-9-]{2,41})$/, (env, req, url, p) => adm.updateService(env, req, p[1])],
  ["POST", /^\/api\/admin\/payments\/(pay_[0-9a-f]{24})\/reconcile$/, (env, req, url, p) => adm.reconcilePayment(env, req, p[1], env.fetch ?? fetch)],
  ["POST", /^\/api\/admin\/users$/, (env, req) => adm.addStaff(env, req)],
];

async function health(env) {
  try {
    const f = await one(env.DB, `SELECT value FROM schema_info WHERE key = 'foundation'`);
    return json({ ok: f?.value === "fullstack-v1", database: "ok" });
  } catch {
    return json({ ok: false, database: "unavailable" }, 503);
  }
}

export async function handle(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) {
    if (!env.ASSETS) return new Response("Not found", { status: 404 });
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!h.has(k)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  }
  try {
    const route = ROUTES.find(([m, re]) => re.test(url.pathname) && (m === request.method || (m === "GET" && request.method === "HEAD")));
    if (!route) {
      const exists = ROUTES.some(([, re]) => re.test(url.pathname));
      throw new HttpError(exists ? 405 : 404, exists ? "method_not_allowed" : "not_found", exists ? "Method not allowed." : "Not found.");
    }
    if (url.pathname !== "/api/health") await ensureSeeded(env);
    return await route[2](env, request, url, url.pathname.match(route[1]));
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(JSON.stringify({ level: "error", path: url.pathname, error: String(err?.message ?? err).slice(0, 300) }));
    return errorResponse(err);
  }
}

export default {
  fetch: (request, env) => handle(request, env),
  scheduled: (_event, env, ctx) => ctx.waitUntil(processOutbox(env)),
};
