// Production smoke test (F6, 2026-11-09): anonymous and read-only. It proves that the deployed production Worker
// serves the public website, keeps every customer entry point closed before the public launch (src/app/prelaunch.ts),
// protects the portal, staff area and Owner pages, refuses unsigned Stripe / Resend / Retell webhooks, keeps payments
// and AI website generation closed, and answers over HTTPS with the expected headers.
//
// Nothing here signs in, submits a form that is accepted, or writes anything: every POST is one the Worker refuses
// before any handler runs (the pre-launch gate) or before any record is touched (webhook signature checks).
// Authenticated checks (Owner dashboard, employee access) need the Founder's own production account and MFA, so they
// are a Founder step, not part of this script.
//
//   node --no-warnings scripts/production-smoke.ts --base https://crestmontwebsitedevelopment.com [--out evidence/production-smoke.json]
// Exit 1 when a critical check failed. Run from a GitHub runner (production-smoke.yml).
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolve4, resolve6 } from "node:dns/promises";
import { connect } from "node:tls";

export type Fetcher = (req: Request) => Promise<Response>;
export interface SmokeResult { name: string; area: string; critical: boolean; outcome: "passed" | "failed"; message?: string }

const UA = { "user-agent": "crestmont-production-smoke" };

/** The HTTP checks, runnable against any fetcher (the deployed Worker, or the in-memory app in tests). */
export async function httpSmoke(base: string, fetcher: Fetcher, expectPrelaunch = true): Promise<SmokeResult[]> {
  const results: SmokeResult[] = [];
  const check = async (area: string, name: string, critical: boolean, run: () => Promise<string | null>) => {
    let failure: string | null;
    try { failure = await run(); } catch (e) { failure = `request failed: ${(e as Error).message}`; }
    results.push({ name, area, critical, outcome: failure ? "failed" : "passed", ...(failure ? { message: failure.slice(0, 500) } : {}) });
  };
  const req = (method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) =>
    fetcher(new Request(base + path, { method, redirect: "manual", headers: { ...UA, ...(init.headers ?? {}) }, body: init.body }));
  const text = async (r: Response) => { try { return await r.text(); } catch { return ""; } };

  // ── Health and configuration stated by the running Worker ──
  let health: Record<string, unknown> = {};
  await check("health", "/api/health answers ok for production", true, async () => {
    const r = await req("GET", "/api/health");
    const b = await text(r);
    try { health = JSON.parse(b); } catch { return `HTTP ${r.status}: not JSON`; }
    return r.status === 200 && health.status === "ok" && health.environment === "production" ? null : `HTTP ${r.status} ${b.slice(0, 200)}`;
  });
  await check("health", "database answers (health runs SELECT 1 on D1)", true, async () => (health.status === "ok" ? null : "health not ok"));
  await check("health", "file storage (R2) bound", true, async () => (health.fileStorage === "bound" ? null : `fileStorage: ${String(health.fileStorage)}`));
  // What the running Worker states about payments and the website assistant (no secret: modes, reasons, presence only).
  try {
    const p = health.payments as { mode?: string; checkout?: string; reason?: string; webhookSecret?: boolean; keyKind?: string; blockers?: string[] } | undefined;
    console.log(`  stripe key: ${p?.keyKind ?? "?"}; checkout blockers: ${p?.blockers?.length ? p.blockers.join(" | ") : "none"}; customer access: ${String(health.customerAccess ?? "?")}`);
    const a = await (await req("GET", "/api/assistant")).json().catch(() => ({})) as { available?: boolean; reason?: string };
    console.log(`  payments: mode ${p?.mode ?? "?"}, checkout ${p?.checkout ?? "?"}${p?.reason ? ` (${p.reason})` : ""}, webhook secret ${p?.webhookSecret ? "present" : "missing"}`);
    console.log(`  website assistant: ${a.available ? "available" : `unavailable (${a.reason ?? "?"})`}`);
  } catch { /* informational only */ }
  // Business settings as published (Founder, 2026-11-10): the legal name in full (it is public); the address and staffed
  // hours only as recorded / not recorded; whether the site shows a phone link.
  try {
    const d = (await (await req("GET", "/legal/disclosures")).text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const legal = /Legal name: ([^.]+(?:\.[A-Z][^.]*)*)\./.exec(d)?.[1] ?? null;
    console.log(`  business settings: legal name ${legal ? `"${legal.trim()}"` : "NOT shown"}; address ${/Registered business address:/.test(d) ? "recorded" : "not recorded"}; staffed hours ${/Staffed support hours:/.test((await (await req("GET", "/legal/support")).text())) ? "recorded" : "not recorded"}`);
    const home = await (await req("GET", "/")).text();
    console.log(`  phone on the site: ${/href="tel:\+\d+"/.test(home) ? `shown (${/href="tel:(\+\d+)"/.exec(home)![1].replace(/\d(?=\d{4})/g, "•")})` : "not shown"}`);
  } catch { /* informational only */ }
  await check("ai", "AI website generation is off", true, async () => (health.aiBuildAutomation === "off" ? null : `aiBuildAutomation: ${String(health.aiBuildAutomation)}`));
  if (expectPrelaunch) {
    await check("payments", "checkout is closed (no live charges before the payments authorization)", true, async () => {
      const p = health.payments as { checkout?: string; mode?: string; reason?: string } | undefined;
      return p?.checkout === "closed" ? null : `payments: ${JSON.stringify(p)}`;
    });
  } else {
    await check("payments", "checkout is open in live mode with the webhook secret set (after the payments authorization)", true, async () => {
      const p = health.payments as { checkout?: string; mode?: string; reason?: string; webhookSecret?: boolean; blockers?: string[] } | undefined;
      return p?.checkout === "open" && p?.mode === "live" && p?.webhookSecret ? null : `payments: ${JSON.stringify(p)}`;
    });
  }

  // ── Public website ──
  for (const [path, must] of [["/", /Crestmont/i], ["/pricing", /\$/], ["/services", /Crestmont/i], ["/about", /Crestmont/i], ["/portfolio", /Crestmont/i],
    ["/contact", /<form/i], ["/quote", /<form/i], ["/login", /name="password"/], ["/password/forgot", /<form/i]] as const) {
    await check("public", `${path} renders`, true, async () => {
      const r = await req("GET", path);
      const b = await text(r);
      if (r.status !== 200) return `HTTP ${r.status}`;
      if (!/text\/html/.test(r.headers.get("content-type") ?? "")) return "not HTML";
      return must.test(b) ? null : "expected content missing";
    });
  }
  // Portfolio: every published entry listed on /portfolio opens its case study (the public order is printed).
  await check("portfolio", "every published portfolio entry opens its case study", true, async () => {
    const b = await text(await req("GET", "/portfolio"));
    const slugs = [...new Set([...b.matchAll(/href="\/portfolio\/([a-z0-9-]+)"/g)].map((m) => m[1]))];
    console.log(`  portfolio (public order): ${slugs.join(", ") || "none published"}`);
    const bad: string[] = [];
    for (const sl of slugs) { const r = await req("GET", `/portfolio/${sl}`); await text(r); if (r.status !== 200) bad.push(`${sl}=${r.status}`); }
    return bad.length ? bad.join(", ") : null;
  });
  await check("purchase", "/pricing package buttons lead to the standard purchase flow (intake and checkout), never the custom quote form", true, async () => {
    const r = await req("GET", "/pricing");
    const b = await text(r);
    const missing = ["starter", "business", "premium"].filter((id) => !b.includes(`href="/checkout/${id}"`));
    if (missing.length) return `no /checkout link for: ${missing.join(", ")}`;
    return /href="\/quote\?package=(starter|business)"/.test(b) ? "a standard package still links to the quote form" : null;
  });
  await check("purchase", "custom projects keep the quote form (/quote?package=custom)", true, async () => {
    const r = await req("GET", "/quote?package=custom");
    await text(r);
    return r.status === 200 ? null : `HTTP ${r.status}`;
  });
  await check("security", "security headers: CSP frame-ancestors 'none', nosniff, HSTS", true, async () => {
    const r = await req("GET", "/");
    await text(r);
    const csp = r.headers.get("content-security-policy") ?? "";
    const missing = [!/frame-ancestors 'none'/.test(csp) && "CSP frame-ancestors", r.headers.get("x-content-type-options") !== "nosniff" && "nosniff",
      !/max-age=\d+/.test(r.headers.get("strict-transport-security") ?? "") && "HSTS"].filter(Boolean);
    return missing.length ? `missing: ${missing.join(", ")}` : null;
  });

  // ── After the public launch: a new visitor reaches registration and every package's purchase flow ──
  if (!expectPrelaunch) {
    for (const path of ["/register", "/checkout/starter", "/checkout/business", "/checkout/premium"]) {
      await check("launch", `GET ${path} is open to a new visitor (no "opening soon")`, true, async () => {
        const r = await req("GET", path);
        const b = await text(r);
        if (/We are opening soon/.test(b) || r.status === 503) return `HTTP ${r.status}: still the "opening soon" page`;
        return r.status === 200 || (r.status >= 300 && r.status < 400) ? null : `HTTP ${r.status}`;
      });
    }
    // Guest checkout (2026-11-13): a visitor with no account goes straight from the package to its intake form — no
    // sign-in page, no 403 — and the form carries the bot check. (Submitting it needs a human Turnstile pass.)
    for (const id of ["starter", "business", "premium"]) {
      await check("launch", `a new visitor without an account opens the ${id} intake directly (guest checkout)`, true, async () => {
        const e = await req("GET", `/checkout/${id}`);
        await text(e);
        const loc = e.headers.get("location") ?? "";
        if (e.status !== 303 || !loc.endsWith(`/checkout/${id}/intake`)) return `GET /checkout/${id}: HTTP ${e.status} → ${loc || "no redirect"}`;
        const r = await req("GET", `/checkout/${id}/intake`);
        const b = await text(r);
        if (r.status !== 200) return `intake HTTP ${r.status}`;
        if (!/data-testid="guest-intake"/.test(b)) return "intake is not the guest form";
        return /class="cf-turnstile[^"]*" data-sitekey="[^"]+"/.test(b) ? null : "guest intake has no Turnstile widget";
      });
    }
  }

  // ── Customer access stays closed before the public launch ──
  if (expectPrelaunch) {
    for (const path of ["/register", "/checkout/starter"]) {
      await check("prelaunch", `GET ${path} is closed ("opening soon", 503)`, true, async () => {
        const r = await req("GET", path);
        const b = await text(r);
        return r.status === 503 && /We are opening soon/.test(b) ? null : `HTTP ${r.status}`;
      });
    }
    const form = { "content-type": "application/x-www-form-urlencoded" };
    for (const path of ["/register", "/quote", "/contact"]) {
      await check("prelaunch", `POST ${path} is refused (503) and records nothing`, true, async () => {
        const r = await req("POST", path, { body: "name=Smoke&email=smoke%40example.invalid", headers: form });
        await text(r);
        return r.status === 503 ? null : `HTTP ${r.status}`;
      });
    }
    for (const path of ["/api/leads", "/api/assistant"]) {
      await check("prelaunch", `POST ${path} is refused (503 not_open_yet)`, true, async () => {
        const r = await req("POST", path, { body: "{}", headers: { "content-type": "application/json", origin: base } });
        const b = await text(r);
        return r.status === 503 && /not_open_yet/.test(b) ? null : `HTTP ${r.status} ${b.slice(0, 120)}`;
      });
    }
  }

  // ── Portal, staff area, Owner pages and support require sign-in ──
  for (const path of ["/portal", "/staff", "/staff/email/templates", "/staff/readiness", "/staff/crm", "/staff/support", "/portal/support"]) {
    await check("access", `${path} requires sign-in`, true, async () => {
      const r = await req("GET", path);
      await text(r);
      const loc = r.headers.get("location") ?? "";
      return r.status === 303 && /^(https?:\/\/[^/]+)?\/login/.test(loc) ? null : `expected 303 to /login, got ${r.status} ${loc}`;
    });
  }
  await check("access", "staff-sent proposal links are not blocked by the pre-launch gate (unknown token: 404)", true, async () => {
    const r = await req("GET", "/q/smoke-unknown-token");
    await text(r);
    return r.status === 404 ? null : `HTTP ${r.status}`;
  });

  // ── Integrations refuse unsigned calls (nothing is processed) ──
  for (const [path, label] of [["/api/webhooks/stripe", "Stripe"], ["/api/webhooks/resend", "Resend"], ["/api/webhooks/retell", "Retell"],
    ["/api/webhooks/retell/functions", "Retell functions"], ["/api/webhooks/retell/inbound", "Retell inbound"]] as const) {
    await check("integrations", `${label} webhook refuses an unsigned request`, true, async () => {
      const r = await req("POST", path, { body: "{}", headers: { "content-type": "application/json" } });
      await text(r);
      return r.status === 401 || r.status === 403 ? null : `HTTP ${r.status} (expected 401/403)`;
    });
  }
  return results;
}

/** Network-level checks only a real deployment can answer: DNS, the TLS certificate, HTTP → HTTPS, www. */
async function networkSmoke(base: string): Promise<SmokeResult[]> {
  const host = new URL(base).hostname;
  const results: SmokeResult[] = [];
  const push = (area: string, name: string, critical: boolean, failure: string | null) =>
    results.push({ name, area, critical, outcome: failure ? "failed" : "passed", ...(failure ? { message: failure } : {}) });
  const v4 = await resolve4(host).catch(() => [] as string[]);
  const v6 = await resolve6(host).catch(() => [] as string[]);
  push("dns", `${host} resolves (A ${v4.length}, AAAA ${v6.length})`, true, v4.length + v6.length ? null : "no A/AAAA records");
  const cert = await new Promise<string | null>((done) => {
    const s = connect({ host, port: 443, servername: host, timeout: 15_000 }, () => {
      const c = s.getPeerCertificate();
      const days = Math.floor((new Date(c.valid_to).getTime() - Date.now()) / 86_400_000);
      s.end();
      done(s.authorized ? (days < 14 ? `certificate expires in ${days} days` : null) : `TLS not authorized: ${String(s.authorizationError)}`);
      console.log(`  certificate: ${c.subject?.CN ?? "?"} issued by ${c.issuer?.O ?? c.issuer?.CN ?? "?"}, valid to ${c.valid_to} (${days} days)`);
    });
    s.on("error", (e) => done(`TLS failed: ${e.message}`));
    s.on("timeout", () => { s.destroy(); done("TLS timed out"); });
  });
  push("tls", "HTTPS certificate valid for the domain", true, cert);
  try {
    const r = await fetch(`http://${host}/`, { redirect: "manual", headers: UA, signal: AbortSignal.timeout(15_000) });
    const loc = r.headers.get("location") ?? "";
    push("tls", "plain HTTP redirects to HTTPS", false, [301, 302, 307, 308].includes(r.status) && loc.startsWith("https://") ? null : `HTTP ${r.status} ${loc}`);
  } catch (e) { push("tls", "plain HTTP redirects to HTTPS", false, `request failed: ${(e as Error).message}`); }
  try {
    const r = await fetch(`https://www.${host}/pricing?ref=smoke`, { redirect: "manual", headers: UA, signal: AbortSignal.timeout(15_000) });
    const loc = r.headers.get("location") ?? "";
    push("dns", `www.${host} redirects permanently to the apex, keeping path and query`, true, r.status === 301 && loc === `https://${host}/pricing?ref=smoke` ? null : `HTTP ${r.status} ${loc}`);
  } catch (e) { push("dns", `www.${host} redirects permanently to the apex, keeping path and query`, true, `not answering: ${(e as Error).message}`); }
  try {
    const r = await fetch(`http://www.${host}/contact`, { redirect: "manual", headers: UA, signal: AbortSignal.timeout(15_000) });
    const loc = r.headers.get("location") ?? "";
    push("tls", `http://www.${host} redirects to HTTPS`, false, [301, 302, 307, 308].includes(r.status) && loc.startsWith("https://") ? null : `HTTP ${r.status} ${loc}`);
  } catch (e) { push("tls", `http://www.${host} redirects to HTTPS`, false, `request failed: ${(e as Error).message}`); }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const base = get("--base")?.replace(/\/+$/, "");
  const out = get("--out") ?? "evidence/production-smoke.json";
  if (!base || !/^https:\/\//.test(base)) { console.error("--base https://<host> is required"); process.exit(2); }
  const fetcher: Fetcher = (r) => fetch(r, { signal: AbortSignal.timeout(20_000) });
  const results = [...(await networkSmoke(base)), ...(await httpSmoke(base, fetcher, get("--expect-prelaunch") !== "no"))];
  for (const r of results) console.log(`${r.outcome === "passed" ? "✔" : r.critical ? "✖" : "!"} [${r.area}] ${r.name}${r.message ? ` — ${r.message}` : ""}`);
  const failedCritical = results.filter((r) => r.outcome === "failed" && r.critical);
  const passed = results.filter((r) => r.outcome === "passed").length;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ base, checkedAt: new Date().toISOString(), commit: process.env.GITHUB_SHA, results }, null, 2));
  const summary = `${passed}/${results.length} production smoke checks passed; ${failedCritical.length} critical failure(s)`;
  console.log(`\n${summary}`);
  console.log(`::notice title=Production smoke::${summary}`);
  process.exit(failedCritical.length ? 1 : 0);
}
