// Automatic portfolio display modes and the remote browser (Owner, 2026-11-16: "PERMANENT AUTOMATIC INTERACTIVE
// PORTFOLIO SYSTEM"). A new website is added by URL alone; Crestmont picks Mode A (native embed), Mode B (remote
// interactive browser) or Mode C (honest fallback) from the site's own headers — never by changing the site.
// These tests pin the selection rules, the security policy, the admission limits, the session core (with a fake
// Chrome DevTools connection) and the API. The real-browser end-to-end check is scripts/remote-browser-check.mjs (CI).
// TEST DATA only; every network answer is a local stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import { selectDisplayMode, publishBlockers, getBySlug, type PortfolioProject } from "../src/services/portfolio.ts";
import { decideRequest, forbiddenHost, sensitivePath, siteOf, GUARD_SCRIPT } from "../src/services/remote-browser/policy.ts";
import { admit, claim, expireStale, finish, remoteBrowserConfig, usage } from "../src/services/remote-browser/admission.ts";
import { issuePreviewToken, prepareConnection } from "../src/services/remote-browser/connect.ts";
import { Cdp, type SocketLike } from "../src/services/remote-browser/cdp.ts";
import { RemoteSession } from "../src/services/remote-browser/session.ts";

const REMOTE_ON = { REMOTE_BROWSER: "on", REMOTE_BROWSER_LOCAL: "test" } as const;
type Headers0 = Record<string, string>;
/** Fixture sites: blocked by CSP, blocked by X-Frame-Options, allowed, unreachable, and a bot challenge. */
const sites = (origin: string): typeof fetch => async (input) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  const page = (title: string, headers: Headers0, status = 200) => new Response(`<title>${title}</title><meta name="description" content="${title} is a TEST DATA website.">`, { status, headers: { "content-type": "text/html", ...headers } });
  switch (u.hostname) {
    case "fa-none.fixture-portfolio.com": return page("FA None", { "content-security-policy": "frame-ancestors 'none'" });
    case "xfo-deny.fixture-portfolio.com": return page("XFO Deny", { "x-frame-options": "DENY" });
    case "allowed.fixture-portfolio.com": return page("Allowed", { "content-security-policy": `frame-ancestors ${origin}` });
    case "challenge.fixture-portfolio.com": return page("Just a moment...", { "cf-mitigated": "challenge" }, 403);
    default: throw new TypeError("fetch failed");
  }
};

// ── Selection rules: the regression guard for the whole system ──
test("[PORT-006] [PORT-007] display-mode selection: allowed → A, refused → B (C where the remote browser is off), unreachable → C", () => {
  const cases: [Parameters<typeof selectDisplayMode>[0], boolean, string][] = [
    [{ status: "allowed", detail: "frame-ancestors allows" }, true, "embed"],
    [{ status: "allowed", detail: "no restriction" }, false, "embed"],
    [{ status: "blocked", detail: "Content-Security-Policy frame-ancestors 'none'" }, true, "remote"],
    [{ status: "blocked", detail: "X-Frame-Options: DENY" }, true, "remote"],
    [{ status: "blocked", detail: "X-Frame-Options: DENY" }, false, "unavailable"],
    [{ status: "error", detail: "the site did not answer" }, true, "unavailable"],
    [{ status: "error", detail: "a bot check Crestmont does not bypass" }, true, "unavailable"],
  ];
  for (const [r, on, mode] of cases) assert.equal(selectDisplayMode(r, on).mode, mode, `${r.status} / remote ${on ? "on" : "off"}`);
  assert.match(selectDisplayMode({ status: "blocked", detail: "X" }, true).reason, /site itself is not changed/);
});

test("[PORT-006] remote browser is enabled only with REMOTE_BROWSER=on AND its bindings (Browser Run + Durable Object)", () => {
  assert.equal(remoteBrowserConfig({}).enabled, false);
  assert.equal(remoteBrowserConfig({ REMOTE_BROWSER: "on" }).enabled, false, "no bindings → off (Mode C)");
  assert.equal(remoteBrowserConfig({ REMOTE_BROWSER: "on", BROWSER: {}, PORTFOLIO_BROWSER: {} }).enabled, true);
  assert.equal(remoteBrowserConfig({ REMOTE_BROWSER: "off", BROWSER: {}, PORTFOLIO_BROWSER: {} }).enabled, false);
  const d = remoteBrowserConfig({ REMOTE_BROWSER: "on", BROWSER: {}, PORTFOLIO_BROWSER: {} });
  assert.deepEqual([d.maxConcurrent, d.dailyMinutes, d.maxSessionSeconds, d.idleSeconds], [3, 20, 300, 90], "defaults stay inside the included Browser Run allowance");
  assert.equal(remoteBrowserConfig({ REMOTE_BROWSER: "on", REMOTE_BROWSER_MAX_CONCURRENT: "9999" }).maxConcurrent, 3, "out-of-range values fall back to the default");
});

// ── The normal Add workflow, end to end in the app ──
test("[PORT-006] [PORT-007] add by URL (new entries, 2026-11-18): a site that refuses framing is NEVER handed to the remote browser — native readiness says what is needed; allowed → native; unreachable / bot check → unavailable", async () => {
  const t0 = await createTestApp(); const origin = new URL(t0.env.APP_URL!).origin; t0.close();
  const t = await createTestApp({ ...REMOTE_ON, overrides: { portfolioFetch: sites(origin) } } as never);
  const owner = await createStaff(t.db, "owner");
  const o = await t.client().login(owner.email, TEST_PASSWORD);
  const step2 = await (await o.post("/staff/portfolio/new", { live_url: "fa-none.fixture-portfolio.com" })).text();
  assert.doesNotMatch(step2, /Mode B/, "the remote browser is not offered for a new entry");
  assert.match(step2, /does not permit native embedding yet/);
  assert.match(step2, /not shown through the remote browser instead/);
  const add = async (slug: string, host: string) => {
    const r = await o.post("/staff/portfolio", { name: slug, slug, industry: "Testing", live_url: `https://${host}/`, description: `${slug} is a TEST DATA website.`, features: "", technology_summary: "", relationship: "Relationship documentation pending" });
    assert.equal(r.status, 303);
    return (await getBySlug(t.db, slug))!;
  };
  const fa = await add("fa-none", "fa-none.fixture-portfolio.com");
  const xfo = await add("xfo-deny", "xfo-deny.fixture-portfolio.com");
  const ok = await add("allowed", "allowed.fixture-portfolio.com");
  const down = await add("down", "down.fixture-portfolio.com");
  const bot = await add("challenge", "challenge.fixture-portfolio.com");
  assert.deepEqual([fa.display_mode, xfo.display_mode, ok.display_mode, down.display_mode, bot.display_mode], ["unavailable", "unavailable", "embed", "unavailable", "unavailable"]);
  // No connection and no verification browser in this test environment: each says exactly why.
  assert.deepEqual([fa.native_state, xfo.native_state, ok.native_state, down.native_state, bot.native_state], ["authorization_required", "authorization_required", "checking", "unavailable", "unavailable"]);
  assert.match(ok.native_reason!, /No verification browser is available/);
  assert.match(bot.native_reason!, /does not bypass/);
  const ed = await o.get(`/staff/portfolio/${fa.id}`);
  const edh = await ed.text();
  assert.match(edh, /data-native-state="authorization_required"/);
  assert.doesNotMatch(edh, /Mode B — remote interactive browser/);
  assert.doesNotMatch(edh, /data-kind="remote"/);
  assert.doesNotMatch(edh, /data-preview=/, "no remote-browser preview session for a new entry");
  assert.doesNotMatch(ed.headers.get("content-security-policy")!, /fa-none\.fixture/, "a blocked site is never framed");
  // Never publishable while not verified native; once forced published, no public surface shows a remote view.
  assert.ok(publishBlockers(fa).some((b) => /not verified as a native embed/.test(b)));
  await t.db.prepare(`UPDATE portfolio_projects SET published = 1 WHERE id IN (?, ?)`).bind(fa.id, ok.id).run();
  // The remote-browser API refuses it as well — even if its display mode were ever recorded as remote.
  await t.db.prepare(`UPDATE portfolio_projects SET display_mode = 'remote' WHERE id = ?`).bind(fa.id).run();
  const api = await t.client().request("POST", "/api/portfolio/remote-sessions", { body: JSON.stringify({ slug: "fa-none" }), headers: { origin: "http://crestmont.test", "content-type": "application/json" } });
  assert.equal(api.status, 409);
  for (const path of ["/portfolio/fa-none", "/portfolio", "/"]) {
    const h = await (await t.client().get(path)).text();
    assert.doesNotMatch(h, /data-remote-slug="fa-none"/, path);
    assert.doesNotMatch(h, /data-frame-url="https:\/\/fa-none/, path);
    assert.doesNotMatch(h, /data-frame-url="https:\/\/allowed\.fixture/, `${path}: an unverified native frame is never shown`);
  }
  t.close();
});

test("[PORT-006] [PORT-007] existing (legacy) entries keep the automatic display modes: refused → Mode B with its limits; publishing and every public surface unchanged", async () => {
  const t0 = await createTestApp(); const origin = new URL(t0.env.APP_URL!).origin; t0.close();
  const t = await createTestApp({ ...REMOTE_ON, overrides: { portfolioFetch: sites(origin) } } as never);
  const owner = await createStaff(t.db, "owner");
  const o = await t.client().login(owner.email, TEST_PASSWORD);
  await o.post("/staff/portfolio", { name: "fa-none", slug: "fa-none", industry: "Testing", live_url: "https://fa-none.fixture-portfolio.com/", description: "fa-none is a TEST DATA website.", features: "", technology_summary: "", relationship: "Relationship documentation pending" });
  // An entry that existed before native readiness (migration 0110 marks those native_required = 0).
  await t.db.prepare(`UPDATE portfolio_projects SET native_required = 0, native_state = 'legacy' WHERE slug = 'fa-none'`).run();
  const id = (await getBySlug(t.db, "fa-none"))!.id;
  await o.post(`/staff/portfolio/${id}/embed-check`, {});
  const fa = (await getBySlug(t.db, "fa-none"))!;
  assert.equal(fa.display_mode, "remote");
  const ed = await o.get(`/staff/portfolio/${fa.id}`);
  const edh = await ed.text();
  assert.match(edh, /data-display-mode="remote"/);
  assert.match(edh, /Mode B — remote interactive browser/);
  assert.match(edh, /data-testid="pf-remote-limits"/);
  assert.match(edh, /data-kind="remote"[^>]*data-remote-slug="fa-none"/);
  assert.match(edh, /data-preview="[0-9a-f]{48}"/);
  assert.doesNotMatch(ed.headers.get("content-security-policy")!, /fa-none\.fixture/, "a blocked site is never framed");
  assert.equal(ed.headers.get("cache-control"), "no-store");
  assert.deepEqual(publishBlockers(fa).filter((b) => /screenshot/i.test(b)), []);
  assert.ok(publishBlockers(fa).some((b) => /opt-in/.test(b)), "owner consent still required");
  await o.post(`/staff/portfolio/${fa.id}/verify-link`, { verified_on: new Date().toISOString().slice(0, 10) });
  await o.post(`/staff/portfolio/${fa.id}/relationship`, { relationship: "TEST DATA fixture", evidence: "TEST DATA engagement letter on file" });
  await o.post(`/staff/portfolio/${fa.id}/consent`, { given_by: "Test Owner", method: "written", given_on: new Date().toISOString().slice(0, 10), evidence: "TEST DATA consent email on file" });
  assert.equal((await o.post(`/staff/portfolio/${fa.id}/publish`, {})).status, 303);
  for (const path of ["/portfolio/fa-none", "/portfolio", "/"]) {
    const h = await (await t.client().get(path)).text();
    assert.match(h, /data-kind="remote"[^>]*data-remote-slug="fa-none"/, path);
    assert.match(h, /Live website · remote view/, path);
    assert.doesNotMatch(h, /data-frame-url="https:\/\/fa-none/, path);
  }
  t.close();
});

test("[PORT-006] remote browser off in an environment: refused legacy sites fall back to Mode C with the live link", async () => {
  const t0 = await createTestApp(); const origin = new URL(t0.env.APP_URL!).origin; t0.close();
  const t = await createTestApp({ overrides: { portfolioFetch: sites(origin) } } as never);
  const owner = await createStaff(t.db, "owner");
  const o = await t.client().login(owner.email, TEST_PASSWORD);
  await o.post("/staff/portfolio", { name: "fa", slug: "fa", industry: "Testing", live_url: "https://fa-none.fixture-portfolio.com/", description: "fa is a TEST DATA website that refuses framing.", features: "", technology_summary: "", relationship: "Relationship documentation pending" });
  await t.db.prepare(`UPDATE portfolio_projects SET native_required = 0, native_state = 'legacy' WHERE slug = 'fa'`).run();
  const id = (await getBySlug(t.db, "fa"))!.id;
  await o.post(`/staff/portfolio/${id}/embed-check`, {});
  const p = (await getBySlug(t.db, "fa"))!;
  assert.equal(p.display_mode, "unavailable");
  const h = await (await o.get(`/staff/portfolio/${p.id}`)).text();
  assert.match(h, /Mode C — unavailable/);
  assert.doesNotMatch(h, /data-kind="remote"/);
  t.close();
});

// ── Security policy ──
test("[PORT-006] remote-browser policy: public https on the project's own site only; no private routes, writes, private hosts or metadata", () => {
  const site = siteOf("https://www.premiuminvoices.com/")!;
  assert.equal(site, "premiuminvoices.com");
  const nav = (url: string, method = "GET") => decideRequest({ url, method, resourceType: "Document", isNavigation: true }, site).action;
  const sub = (url: string, method = "GET") => decideRequest({ url, method, resourceType: "Script", isNavigation: false }, site).action;
  assert.equal(nav("https://premiuminvoices.com/"), "continue");
  assert.equal(nav("https://www.premiuminvoices.com/pricing"), "continue");
  for (const p of ["/login", "/owner", "/admin/users", "/account", "/dashboard", "/billing", "/checkout", "/cart", "/api/v1/x", "/wp-login.php", "/uploads/a", "/Sign-In"]) assert.equal(nav(`https://premiuminvoices.com${p}`), "block-page", p);
  assert.equal(nav("https://evil.example.com/"), "block-page", "leaving the site");
  assert.equal(nav("http://premiuminvoices.com/"), "block-page", "plain http");
  assert.equal(nav("https://premiuminvoices.com/contact", "POST"), "block-page", "form submission");
  assert.equal(sub("https://premiuminvoices.com/api/track", "POST"), "fail", "writes from scripts");
  assert.equal(sub("https://cdn.example-cdn.com/app.js"), "continue", "public third-party assets load");
  assert.equal(sub("https://evil-site.com/favicon.ico"), "fail", "no favicon fetch from a refused website");
  assert.equal(sub("https://premiuminvoices.com/favicon.ico"), "continue");
  for (const h of ["169.254.169.254", "127.0.0.1", "10.0.0.1", "[::1]", "localhost", "metadata.google.internal", "db.internal", "router.lan", "0x7f000001"]) {
    assert.ok(forbiddenHost(h.replace(/^\[|\]$/g, "").includes(":") ? `[${h.replace(/^\[|\]$/g, "")}]` : h), h);
    assert.notEqual(sub(`https://${h}/x`), "continue", h);
  }
  assert.equal(siteOf("https://10.0.0.1/"), null, "a private address can never be a project site");
  assert.equal(siteOf("http://premiuminvoices.com/"), null);
  assert.equal(sensitivePath("/blog/accounting-tips"), null);
  assert.match(GUARD_SCRIPT, /window\.open = function/);
  assert.match(GUARD_SCRIPT, /addEventListener\("submit"/);
  assert.match(GUARD_SCRIPT, /password/);
});

// ── Admission: concurrency, budget, rate, one-time tokens, cleanup ──
test("[PORT-006] admission: concurrency cap, daily budget, per-visitor rate, one-time token, abandoned-session cleanup", async () => {
  const t = await createTestApp();
  const now0 = Date.now();
  await t.db.prepare(`INSERT INTO portfolio_projects (id, slug, name, industry, live_url, relationship, description, verified_features_json, position, published, updated_at, created_at, display_mode) VALUES ('pf_a','a','A','T','https://a.fixture-portfolio.com/','TEST','TEST','[]',1,1,?,?,'remote')`).bind(new Date().toISOString(), new Date().toISOString()).run();
  const cfg = { ...remoteBrowserConfig({ REMOTE_BROWSER: "on", REMOTE_BROWSER_LOCAL: "x" }), maxConcurrent: 2, dailyMinutes: 5, perVisitorPer10Min: 3 };
  const a1 = await admit(t.db, cfg, { projectId: "pf_a", clientKey: "v1", access: "public", now: now0 });
  const a2 = await admit(t.db, cfg, { projectId: "pf_a", clientKey: "v2", access: "public", now: now0 });
  const a3 = await admit(t.db, cfg, { projectId: "pf_a", clientKey: "v3", access: "public", now: now0 });
  assert.ok(a1.ok && a2.ok);
  assert.equal(!a3.ok && a3.code, "busy");
  // One-time token, within two minutes.
  assert.ok(a1.ok);
  if (!a1.ok) return;
  assert.equal(await claim(t.db, a1.id, "f".repeat(48), now0), null, "wrong token");
  assert.ok(await claim(t.db, a1.id, a1.token, now0 + 1000));
  assert.equal(await claim(t.db, a1.id, a1.token, now0 + 2000), null, "reused token");
  if (a2.ok) assert.equal(await claim(t.db, a2.id, a2.token, now0 + 121_000), null, "expired before connecting");
  // Abandoned sessions (no heartbeat) are ended, freeing capacity.
  assert.equal(await expireStale(t.db, now0 + 200_000), 2);
  // A reservation that never connected frees its viewer after 20 s (not after the 75 s heartbeat window).
  const u1 = await admit(t.db, cfg, { projectId: "pf_a", clientKey: "u1", access: "preview", now: now0 + 300_000 });
  const u2 = await admit(t.db, cfg, { projectId: "pf_a", clientKey: "u2", access: "preview", now: now0 + 300_000 });
  assert.ok(u1.ok && u2.ok);
  const u3 = await admit(t.db, cfg, { projectId: "pf_a", clientKey: "u3", access: "public", now: now0 + 305_000 });
  assert.equal(!u3.ok && u3.code, "busy", "still reserved 5 s later");
  const u4 = await admit(t.db, cfg, { projectId: "pf_a", clientKey: "u4", access: "public", now: now0 + 321_000 });
  assert.ok(u4.ok, "an unconnected reservation is released after 20 s");
  if (u4.ok) assert.ok(await claim(t.db, u4.id, u4.token, now0 + 322_000), "the new visitor connects");
  if (u1.ok) assert.equal(await claim(t.db, u1.id, u1.token, now0 + 322_000), null, "a released reservation cannot connect later");
  await t.db.prepare(`UPDATE remote_browser_sessions SET ended_at = ?, end_reason = 'test' WHERE ended_at IS NULL`).bind(new Date(now0 + 322_000).toISOString()).run();
  assert.equal((await usage(t.db, now0 + 200_000)).active, 0);
  // Per-visitor rate.
  const r = [];
  for (let i = 0; i < 4; i++) { const x = await admit(t.db, cfg, { projectId: "pf_a", clientKey: "same", access: "public", now: now0 + 401_000 }); r.push(x.ok ? "ok" : x.code); if (x.ok) await finish(t.db, x.id, now0 + 401_000, "test"); }
  assert.deepEqual(r, ["ok", "ok", "ok", "rate"]);
  // Daily budget: sessions that ran past the budget stop new ones.
  await t.db.prepare(`UPDATE remote_browser_sessions SET seconds = 400`).run();
  const b = await admit(t.db, cfg, { projectId: "pf_a", clientKey: "v9", access: "public", now: now0 + 402_000 });
  assert.equal(!b.ok && b.code, "budget");
  assert.equal((await admit(t.db, { ...cfg, enabled: false }, { projectId: "pf_a", clientKey: "v10", access: "public", now: now0 }) as { code?: string }).code, "disabled");
  t.close();
});

// ── API ──
test("[PORT-006] API: sessions only for published Mode B projects (or a preview link), same-origin JSON, WebSocket token checked", async () => {
  const t = await createTestApp({ ...REMOTE_ON, REMOTE_BROWSER_MAX_CONCURRENT: "1" } as never);
  const at = new Date().toISOString();
  const ins = (id: string, slug: string, published: number, mode: string) => t.db.prepare(`INSERT INTO portfolio_projects (id, slug, name, industry, live_url, relationship, description, verified_features_json, position, published, updated_at, created_at, display_mode, native_required, native_state) VALUES (?,?,?,'T',?,'TEST','TEST','[]',1,?,?,?,?,0,'legacy')`).bind(id, slug, slug, `https://${slug}.fixture-portfolio.com/`, published, at, at, mode).run();
  await ins("pf_pub", "pub", 1, "remote"); await ins("pf_draft", "draft", 0, "remote"); await ins("pf_embed", "emb", 1, "embed");
  const c = t.client();
  const post = (body: unknown, origin = "http://crestmont.test", type = "application/json") => c.request("POST", "/api/portfolio/remote-sessions", { body: JSON.stringify(body), headers: { origin, "content-type": type } });
  assert.equal((await post({ slug: "pub" }, "https://evil.example")).status, 403);
  assert.equal((await post({ slug: "pub" }, "http://crestmont.test", "text/plain")).status, 415);
  assert.equal((await post({ slug: "draft" })).status, 404, "unpublished");
  assert.equal((await post({ slug: "emb" })).status, 409, "not a remote-mode project");
  const ok = await post({ slug: "pub" });
  assert.equal(ok.status, 200);
  const s = await ok.json() as { id: string; ws: string };
  assert.match(s.ws, /^\/api\/portfolio\/remote-sessions\/rb_[0-9a-f]{24}\/live\?token=[0-9a-f]{48}$/);
  const busy = await post({ slug: "pub" });
  assert.equal(busy.status, 503);
  assert.equal((await busy.json() as { code: string }).code, "busy");
  await finish(t.db, s.id, Date.now(), "test");
  // Preview link: the draft becomes viewable for its holder only.
  const tok = await issuePreviewToken(t.db, "pf_draft", 30, "test", Date.now());
  assert.equal((await post({ slug: "draft", preview: tok })).status, 200);
  assert.equal((await post({ slug: "pub", preview: tok })).status, 404, "a preview link names one project");
  const pv = await c.get(`/portfolio/preview/${tok}`);
  assert.equal(pv.status, 200);
  assert.equal(pv.headers.get("cache-control"), "no-store");
  assert.match(await pv.text(), /noindex/);
  assert.equal((await c.get(`/portfolio/preview/${"0".repeat(48)}`)).status, 404);
  // The WebSocket: upgrade required, same origin, valid one-time token.
  const ws = (path: string, h: Record<string, string>) => c.request("GET", path, { headers: h });
  assert.equal((await ws(s.ws, { origin: "http://crestmont.test" })).status, 426);
  assert.equal((await ws(s.ws, { upgrade: "websocket", origin: "https://evil.example" })).status, 403);
  assert.equal((await ws(s.ws.replace(/token=\w+/, `token=${"0".repeat(48)}`), { upgrade: "websocket", origin: "http://crestmont.test" })).status, 503, "no Durable Object binding in tests");
  // prepareConnection is the token check the Durable Object path relies on.
  const ad = await admit(t.db, remoteBrowserConfig({ REMOTE_BROWSER: "on", REMOTE_BROWSER_LOCAL: "x" }), { projectId: "pf_pub", clientKey: "k", access: "public", now: Date.now() });
  assert.ok(ad.ok);
  if (ad.ok) {
    const q = new URLSearchParams({ device: "mobile", h: "700" });
    assert.equal(await prepareConnection(t.db, ad.id, "0".repeat(48), q, Date.now(), { maxSessionSeconds: 300, idleSeconds: 90 }), null);
    const info = await prepareConnection(t.db, ad.id, ad.token, q, Date.now(), { maxSessionSeconds: 300, idleSeconds: 90 });
    assert.deepEqual(info && [info.url, info.site, info.device, info.height], ["https://pub.fixture-portfolio.com/", "pub.fixture-portfolio.com", "mobile", 700]);
    assert.equal(await prepareConnection(t.db, ad.id, ad.token, q, Date.now(), { maxSessionSeconds: 300, idleSeconds: 90 }), null, "single use");
  }
  t.close();
});

// ── Session core with a fake browser ──
class FakeSocket implements SocketLike {
  sent: unknown[] = []; closed = false;
  private l: Record<string, ((e: { data?: unknown }) => void)[]> = {};
  send(d: string | ArrayBuffer | Uint8Array) { this.sent.push(d); }
  close() { if (!this.closed) { this.closed = true; for (const f of this.l.close ?? []) f({}); } }
  addEventListener(t: string, f: (e: { data?: unknown }) => void) { (this.l[t] ??= []).push(f); }
  emit(t: string, data?: unknown) { for (const f of this.l[t] ?? []) f({ data }); }
}
/** A fake Chromium that answers CDP commands and records them. */
function fakeBrowser() {
  const sock = new FakeSocket();
  const calls: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  sock.send = (d) => {
    const m = JSON.parse(String(d)) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
    calls.push(m);
    const result: Record<string, unknown> = m.method === "Target.createBrowserContext" ? { browserContextId: "ctx1" } : m.method === "Target.createTarget" ? { targetId: "T1" }
      : m.method === "Target.attachToTarget" ? { sessionId: "S1" } : m.method === "Browser.getVersion" ? { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0 Safari/537.36" }
      : m.method === "Page.getNavigationHistory" ? { currentIndex: 1, entries: [{ id: 7 }, { id: 8 }] } : {};
    queueMicrotask(() => sock.emit("message", JSON.stringify({ id: m.id, result })));
  };
  const event = (method: string, params: Record<string, unknown>) => sock.emit("message", JSON.stringify({ method, params, sessionId: "S1" }));
  return { sock, calls, event };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test("[PORT-006] session core: isolated context, guard + interception before navigation, frames relayed, input dispatched, everything closed at the end", async () => {
  const b = fakeBrowser(), visitor = new FakeSocket();
  let now = 1_000_000, closedBrowser = 0;
  const ended: string[] = [];
  const s = new RemoteSession(new Cdp(b.sock), visitor, { url: "https://site.fixture-portfolio.com/", site: "site.fixture-portfolio.com", device: "desktop", height: 800, maxSessionSeconds: 300, idleSeconds: 90, now: () => now, closeBrowser: () => { closedBrowser++; }, onEnd: (r) => { ended.push(r); } });
  await s.start();
  const order = b.calls.map((c) => c.method);
  for (const m of ["Target.createBrowserContext", "Browser.setDownloadBehavior", "Page.addScriptToEvaluateOnNewDocument", "Fetch.enable", "Emulation.setDeviceMetricsOverride", "Page.navigate", "Page.startScreencast"]) assert.ok(order.includes(m), m);
  assert.ok(order.indexOf("Fetch.enable") < order.indexOf("Page.navigate") && order.indexOf("Page.addScriptToEvaluateOnNewDocument") < order.indexOf("Page.navigate"), "policy is in place before the first request");
  assert.equal(b.calls.find((c) => c.method === "Browser.setDownloadBehavior")!.params.behavior, "deny");
  assert.equal(b.calls.find((c) => c.method === "Target.createTarget")!.params.browserContextId, "ctx1", "a fresh browser context per session");
  assert.deepEqual(JSON.parse(String(visitor.sent.at(-1))), { t: "ready", w: 1440, h: 800, device: "desktop" });
  // Requests: a private route gets the block page; a POST fails; a normal page continues.
  b.event("Fetch.requestPaused", { requestId: "r1", request: { url: "https://site.fixture-portfolio.com/login", method: "GET" }, resourceType: "Document", frameId: "T1" });
  b.event("Fetch.requestPaused", { requestId: "r2", request: { url: "https://site.fixture-portfolio.com/api/x", method: "POST" }, resourceType: "XHR", frameId: "T1" });
  b.event("Fetch.requestPaused", { requestId: "r3", request: { url: "https://site.fixture-portfolio.com/about", method: "GET" }, resourceType: "Document", frameId: "T1" });
  b.event("Fetch.requestPaused", { requestId: "r4", request: { url: "http://169.254.169.254/latest/meta-data", method: "GET" }, resourceType: "XHR", frameId: "T1" });
  await tick();
  const byReq = (id: string) => b.calls.find((c) => c.params.requestId === id)!.method;
  assert.deepEqual([byReq("r1"), byReq("r2"), byReq("r3"), byReq("r4")], ["Fetch.fulfillRequest", "Fetch.failRequest", "Fetch.continueRequest", "Fetch.failRequest"]);
  assert.ok(visitor.sent.some((m) => typeof m === "string" && JSON.parse(m).t === "blocked"));
  // Frames: acknowledged and relayed as binary.
  b.event("Page.screencastFrame", { sessionId: 3, data: Buffer.from("JPEGDATA").toString("base64"), metadata: {} });
  await tick();
  assert.ok(b.calls.some((c) => c.method === "Page.screencastFrameAck"));
  assert.ok(visitor.sent.some((m) => m instanceof Uint8Array && new TextDecoder().decode(m) === "JPEGDATA"));
  // Input: bounded and dispatched; code is never evaluated.
  visitor.emit("message", JSON.stringify({ t: "mouse", a: "down", x: 99999, y: -5, b: "left" }));
  visitor.emit("message", JSON.stringify({ t: "wheel", x: 10, y: 10, dy: 1e9 }));
  visitor.emit("message", JSON.stringify({ t: "key", a: "down", key: "a", code: "KeyA" }));
  visitor.emit("message", JSON.stringify({ t: "nav", a: "back" }));
  visitor.emit("message", JSON.stringify({ t: "nav", a: "path", path: "javascript:alert(1)" }));
  visitor.emit("message", JSON.stringify({ t: "eval", code: "alert(1)" }));
  visitor.emit("message", JSON.stringify({ t: "device", d: "mobile", h: 700 }));
  await tick(); await tick();
  const mouse = b.calls.find((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed")!;
  assert.deepEqual([mouse.params.x, mouse.params.y], [1440, 0], "coordinates clamped to the viewport");
  assert.equal(b.calls.find((c) => c.params.type === "mouseWheel")!.params.deltaY, 5000);
  assert.equal(b.calls.find((c) => c.method === "Input.dispatchKeyEvent")!.params.text, "a");
  assert.equal(b.calls.find((c) => c.method === "Page.navigateToHistoryEntry")!.params.entryId, 7);
  assert.ok(!b.calls.some((c) => c.method === "Runtime.evaluate"), "nothing the visitor sends is evaluated");
  assert.equal(b.calls.filter((c) => c.method === "Page.navigate").length, 1, "a javascript: path is not navigated");
  const dm = b.calls.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1)!;
  assert.deepEqual([dm.params.width, dm.params.mobile], [390, true]);
  assert.match(String(b.calls.filter((c) => c.method === "Emulation.setUserAgentOverride").at(-1)!.params.userAgent), /HeadlessChrome.*Mobile Safari/, "stays identifiable as headless Chrome");
  // Idle: pings do not keep it alive; the session ends and releases the browser.
  now += 60_000; visitor.emit("message", JSON.stringify({ t: "ping" }));
  now += 40_000;
  (s as unknown as { tick(): void }).tick();
  await tick(); await tick();
  assert.deepEqual(ended, ["idle"]);
  assert.equal(closedBrowser, 1);
  assert.ok(b.calls.some((c) => c.method === "Target.disposeBrowserContext"));
  assert.ok(visitor.closed);
});

test("[PORT-006] session core: a visitor who leaves, or a browser that crashes, ends the session once", async () => {
  for (const how of ["visitor", "crash"] as const) {
    const b = fakeBrowser(), visitor = new FakeSocket();
    const ended: string[] = [];
    let closed = 0;
    const s = new RemoteSession(new Cdp(b.sock), visitor, { url: "https://x.fixture-portfolio.com/", site: "x.fixture-portfolio.com", device: "tablet", height: 900, maxSessionSeconds: 300, idleSeconds: 90, closeBrowser: () => { closed++; }, onEnd: (r) => { ended.push(r); } });
    await s.start();
    if (how === "visitor") visitor.close(); else b.event("Inspector.targetCrashed", {});
    await tick(); await tick();
    visitor.close();
    await tick();
    assert.deepEqual(ended, [how === "visitor" ? "visitor-left" : "crashed"], how);
    assert.equal(closed, 1, how);
  }
});

test("[PORT-006] staging and production wire the remote browser with caps that stay inside the included allowance", async () => {
  const toml = (await import("node:fs")).readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  for (const env of ["staging", "production"]) {
    const block = toml.split(`[env.${env}]`)[1]!.split(/\n\[env\.|\n# Secrets/)[0]!;
    assert.match(block, /browser = \{ binding = "BROWSER" \}/, env);
    assert.match(block, /name = "PORTFOLIO_BROWSER", class_name = "PortfolioBrowser"/, env);
    assert.match(block, /new_sqlite_classes = \["PortfolioBrowser"\]/, env);
    assert.match(block, /REMOTE_BROWSER = "on", REMOTE_BROWSER_MAX_CONCURRENT = "3", REMOTE_BROWSER_DAILY_MINUTES = "20"/, env);
  }
  const worker = (await import("node:fs")).readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
  assert.match(worker, /export \{ PortfolioBrowser \}/);
});

test("[PORT-006] release acceptance intake: the Add steps for real addresses — unpublished, mode selected, no consent, existing projects only re-checked", async () => {
  const { signEvidence } = await import("../src/readiness/ingest.ts");
  const t0 = await createTestApp(); const origin = new URL(t0.env.APP_URL!).origin; t0.close();
  const t = await createTestApp({ ...REMOTE_ON, EVIDENCE_INGEST_SECRET: "intake-secret", overrides: { portfolioFetch: sites(origin) } } as never);
  const at = new Date().toISOString();
  await t.db.prepare(`INSERT INTO portfolio_projects (id, slug, name, industry, live_url, relationship, description, verified_features_json, position, published, updated_at, created_at) VALUES ('pf_ok','existing-allowed','Allowed','T','https://allowed.fixture-portfolio.com/','Founder-owned','TEST DATA existing project','[]',1,1,?,?)`).bind(at, at).run();
  const body = JSON.stringify({ urls: ["https://fa-none.fixture-portfolio.com/", "https://xfo-deny.fixture-portfolio.com/", "https://allowed.fixture-portfolio.com/", "https://down.fixture-portfolio.com/", "http://10.0.0.1/"] });
  const post = async (b: string, sig?: string) => t.client().request("POST", "/api/ops/portfolio-intake", { body: b, headers: { "content-type": "application/json", ...(sig ? { "x-crestmont-signature": sig } : {}) } });
  assert.equal((await post(body)).status, 401, "unsigned");
  const res = await post(body, await signEvidence("intake-secret", body));
  assert.equal(res.status, 200);
  const j = await res.json() as { remoteBrowser: { enabled: boolean }; results: { slug: string | null; mode: string; created: boolean; published: boolean; preview: string | null; error?: string }[] };
  assert.equal(j.remoteBrowser.enabled, true);
  assert.deepEqual(j.results.map((r) => [r.mode, r.created, r.published]), [["remote", true, false], ["remote", true, false], ["embed", false, true], ["unavailable", true, false], ["unavailable", false, false]]);
  assert.equal(j.results[2]!.slug, "existing-allowed", "an existing project for the same site is re-checked, not duplicated");
  assert.equal(j.results[4]!.error, "invalid", "a private address is refused outright");
  for (const r of j.results.slice(0, 4)) assert.match(r.preview!, /^[0-9a-f]{48}$/);
  const fa = (await getBySlug(t.db, j.results[0]!.slug!))!;
  assert.equal(fa.published, 0);
  assert.equal(fa.portfolio_consent_at, null, "consent is never recorded by automation");
  assert.equal(fa.relationship_documented_at, null);
  assert.equal((await t.client().get(`/portfolio/preview/${j.results[0]!.preview}`)).status, 200);
  t.close();
});

test("[PORT-006] Durable Object: Browser Run's DevTools endpoint, or the chunked connectDevtools fallback; a missing browser fails honestly", async () => {
  const { PortfolioBrowser } = await import("../src/durable/portfolio-browser.ts");
  const { chunkedSocket } = await import("../src/services/remote-browser/cdp.ts");
  // chunkedSocket: length-prefixed frames in both directions, reassembled across chunks.
  const raw = new FakeSocket();
  const cs = chunkedSocket(raw);
  const got: string[] = [];
  cs.addEventListener("message", (e) => got.push(String(e.data)));
  cs.send('{"id":1}');
  const sent = raw.sent[0] as Uint8Array;
  assert.equal(new DataView(sent.buffer, sent.byteOffset).getUint32(0, true), 8);
  assert.equal(new TextDecoder().decode(sent.subarray(4)), '{"id":1}');
  const msg = new TextEncoder().encode('{"method":"x"}');
  const first = new Uint8Array(4 + 5); new DataView(first.buffer).setUint32(0, msg.length, true); first.set(msg.subarray(0, 5), 4);
  raw.emit("message", first); raw.emit("message", "pong"); raw.emit("message", msg.subarray(5));
  assert.deepEqual(got, ['{"method":"x"}']);

  // The Durable Object with a fake Browser Run binding: which endpoints it tries, and the visitor's honest error.
  const db = (await createTestApp()).db;
  await db.prepare(`INSERT INTO portfolio_projects (id, slug, name, industry, live_url, relationship, description, verified_features_json, position, published, updated_at, created_at) VALUES ('pf_d','d','D','T','https://d.fixture-portfolio.com/','T','TEST DATA','[]',1,1,'x','x')`).run();
  await db.prepare(`INSERT INTO remote_browser_sessions (id, project_id, token_hash, client_key, access, created_at, last_seen_at) VALUES ('rb_000000000000000000000001','pf_d','h','k','public',?,?)`).bind(new Date().toISOString(), new Date().toISOString()).run();
  const calls: string[] = [];
  const binding = { fetch: async (url: string) => { calls.push(new URL(url).pathname); return new Response("no", { status: 503 }); } };
  const Pair = class { 0 = new FakeSocket(); 1 = new FakeSocket(); };
  (globalThis as Record<string, unknown>).WebSocketPair = class extends Pair { constructor() { super(); (this[0] as FakeSocket & { accept?: () => void }).accept = () => undefined; (this[1] as FakeSocket & { accept?: () => void }).accept = () => undefined; } };
  const origStatus = Response;
  (globalThis as Record<string, unknown>).Response = class extends origStatus { constructor(b: BodyInit | null, i?: ResponseInit) { super(b, i && i.status === 101 ? { ...i, status: 200 } : i); } };
  try {
    const dobj = new PortfolioBrowser({}, { DB: db, BROWSER: binding } as never);
    const info = { id: "rb_000000000000000000000001", url: "https://d.fixture-portfolio.com/", site: "d.fixture-portfolio.com", device: "desktop", height: 800, maxSessionSeconds: 300, idleSeconds: 90 };
    const res = await dobj.fetch(new Request("https://x/", { headers: { upgrade: "websocket", "x-rb-session": JSON.stringify(info) } }));
    assert.ok(res);
    for (let i = 0; i < 50 && calls.length < 2; i++) await tick();
    await tick(); await tick();
    assert.deepEqual(calls, ["/v1/devtools/browser", "/v1/acquire"], "the standard endpoint first, then the fallback");
    const row = await db.prepare(`SELECT ended_at, end_reason FROM remote_browser_sessions WHERE id = 'rb_000000000000000000000001'`).first<{ ended_at: string | null; end_reason: string }>();
    assert.ok(row!.ended_at, "the session is closed in the books");
    assert.match(row!.end_reason, /no-browser/);
  } finally { (globalThis as Record<string, unknown>).Response = origStatus; delete (globalThis as Record<string, unknown>).WebSocketPair; }
});

export type { PortfolioProject };
