// The universal onboarding matrix (Owner, 2026-11-20, Phase 6 Test A): 100 website configurations — page technologies
// (static, div-only app shells, client-rendered, internal scroll containers, web components, CSS/canvas/WebGL animation,
// lazy media, heavy main threads) × framing setups (X-Frame-Options, a site's own frame-ancestors 'none', already
// permitted), the website defects and frame failures the verifier must reject, authorization blockers, and intake
// edge cases (invalid, duplicate, www, path and redirect variants). All 100 go through Staff → Portfolio → "Add
// several" in ONE submission, then ONLY the real 15-minute job advances them (no direct database edit), with the REAL
// verifier driving a real Chromium. Each configuration has an expected verdict, decided before the run; the test fails
// on any false approval or false rejection, and writes metrics (MATRIX_REPORT=path) for the CI artifact.
// Needs Chromium (see portfolio-native-browser.test.ts). TEST DATA only: nothing outside this process is contacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import { NativeWorld, homepage, page, type Site } from "./support/native-world.ts";
import { listActive } from "../src/services/portfolio.ts";
import { runJobs } from "../src/app/scheduled.ts";
import { Cdp } from "../src/services/remote-browser/cdp.ts";
import { launchLocalBrowser } from "../dev/local-browser.ts";

async function chromiumPath(): Promise<string | null> {
  if (process.env.NATIVE_E2E_CHROMIUM && existsSync(process.env.NATIVE_E2E_CHROMIUM)) return process.env.NATIVE_E2E_CHROMIUM;
  for (const m of [process.env.PLAYWRIGHT_MODULE, "playwright", "/opt/node-tools/node_modules/playwright/index.js"].filter(Boolean) as string[]) {
    try { const pw = await import(m); const p = (pw.chromium ?? pw.default?.chromium).executablePath(); if (p && existsSync(p)) return p; } catch { /* next */ }
  }
  return null;
}
const CHROMIUM = await chromiumPath();
const skip = CHROMIUM ? false : "Chromium is not available on this host (set NATIVE_E2E_CHROMIUM or PLAYWRIGHT_MODULE)";
const ACCT = "c".repeat(32);
const D = "matrix-native.com";

// ── Page technologies (each a complete TEST DATA page) ──
const P = "More TEST DATA content so the page can be scrolled by a visitor, written as ordinary paragraphs.";
const doc = (title: string, head: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${head}</head><body style="margin:0;font:16px sans-serif">${body}</body></html>`;
const PAGES: Record<string, (t: string) => string> = {
  static: (t) => homepage(t),
  "div-only": (t) => homepage(t, { divOnly: true }),
  heavy: (t) => homepage(t, { heavy: true }),
  webgl: (t) => homepage(t, { webgl: "ok" }),
  "webgl-deferred": (t) => homepage(t, { webgl: "deferred" }),
  "decorative-canvas": (t) => homepage(t, { webgl: "decorative" }),
  // Client-rendered: the server sends an empty shell; the bundle renders the content after load.
  csr: (t) => doc(t, "", `<div id="app"></div><script>setTimeout(function(){var a=document.getElementById("app");var h="<h1>${t}</h1><p>${t} is a client-rendered TEST DATA application; this text was rendered by JavaScript after load.</p>";for(var i=0;i<30;i++)h+="<p>${P}</p>";a.innerHTML=h;},400);</script>`),
  // The document itself never scrolls; an inner container does (app layouts, dashboards).
  "inner-scroll": (t) => doc(t, `<style>html,body{height:100%;overflow:hidden}#s{height:100vh;overflow-y:auto}</style>`, `<div id="s"><h1>${t}</h1><p>${t} scrolls inside its own container, not the document.</p>${`<p>${P}</p>`.repeat(40)}</div>`),
  "css-animation": (t) => doc(t, `<style>@keyframes spin{to{transform:rotate(360deg)}}.spin{width:120px;height:120px;background:#2a7;animation:spin 2s linear infinite}</style>`, `<h1>${t}</h1><div class="spin" aria-hidden="true"></div><p>${t} animates with CSS keyframes.</p>${`<p>${P}</p>`.repeat(25)}`),
  "lazy-media": (t) => doc(t, "", `<h1>${t}</h1><p>${t} lazy-loads its images.</p>${Array.from({ length: 8 }, (_, i) => `<img loading="lazy" width="320" height="200" alt="TEST DATA image ${i}" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='200'%3E%3Crect width='320' height='200' fill='%23${(i * 2 + 3).toString(16)}a7'/%3E%3C/svg%3E"><p>${P}</p>`).join("")}`),
  // Web components: all visible text lives in open shadow roots.
  "web-components": (t) => doc(t, "", `<x-app></x-app><script>customElements.define("x-app",class extends HTMLElement{connectedCallback(){var r=this.attachShadow({mode:"open"});var h="<h1>${t}</h1><p>${t} renders everything inside custom elements with shadow DOM.</p>";for(var i=0;i<30;i++)h+="<p>${P}</p>";r.innerHTML=h;}});</script>`),
  "canvas-2d": (t) => doc(t, "", `<h1>${t}</h1><canvas id="c" width="480" height="300" style="display:block;width:100%;max-width:480px"></canvas><script>(function(){var g=document.getElementById("c").getContext("2d"),k=0;function f(){k++;g.fillStyle="#123";g.fillRect(0,0,480,300);g.fillStyle="#e83";g.fillRect(40+(k*4)%360,100,80,80);requestAnimationFrame(f);}requestAnimationFrame(f);})();</script><p>${t} animates a 2D canvas.</p>${`<p>${P}</p>`.repeat(25)}`),
  // ── Defects (the verifier must reject these) ──
  "webgl-fail": (t) => homepage(t, { webgl: "fail" }),
  "broken-js": (t) => homepage(t, { brokenJs: true }),
  "broken-draws": (t) => homepage(t, { webgl: "broken-draws" }),
  "module-race": (t) => homepage(t, { webgl: "ok" }),
  "top-only": (t) => homepage(t, { webgl: "top-only" }),
  "mobile-overflow": (t) => doc(t, "", `<div style="min-width:1400px"><h1>${t}</h1><p>${t} has a fixed 1400 px layout that overflows phones.</p>${`<p>${P}</p>`.repeat(25)}</div>`),
  // The document never scrolls (overflow hidden, as full-page slider sites do): the same on its own and in the frame —
  // the website's own design, not an embedding failure, so it is verified (and reported as nothing to scroll).
  "no-scroll": (t) => doc(t, `<style>html,body{overflow:hidden}</style>`, `<h1>${t}</h1><p>${t} cannot be scrolled: the rest of its content is unreachable.</p>${`<p>${P}</p>`.repeat(40)}`),
  "browser-refuses": (t) => homepage(t),
  "sensitive-exposed": (t) => homepage(t),
};
const GOOD = ["static", "div-only", "heavy", "webgl", "webgl-deferred", "decorative-canvas", "csr", "inner-scroll", "css-animation", "lazy-media", "web-components", "canvas-2d"];
const BAD = ["webgl-fail", "broken-js", "broken-draws", "module-race", "top-only", "mobile-overflow", "browser-refuses"];
type Framing = "xfo" | "csp-none" | "allowed" | "xfo+csp";
const framing = (f: Framing): Pick<Site, "baseXfo" | "baseCsp"> => f === "xfo" ? { baseXfo: "DENY", baseCsp: null } : f === "csp-none" ? { baseXfo: null, baseCsp: "frame-ancestors 'none'; base-uri 'self'" } : f === "xfo+csp" ? { baseXfo: "SAMEORIGIN", baseCsp: "frame-ancestors 'none'" } : { baseXfo: null, baseCsp: "frame-ancestors http://crestmont.test" };

interface Config { id: string; input: string; expect: "native_verified" | "unavailable" | "authorization_required" | "invalid" | "duplicate" | "existing"; kind: string; framing?: Framing }

function build() {
  const w = new NativeWorld();
  const configs: Config[] = [];
  const variance = new Map<string, Record<string, string>>(), later = new Map<string, string>();
  const add = (kind: string, f: Framing, expect: Config["expect"], extra: Partial<Site> = {}, zone = true) => {
    const id = `${kind}-${f}`.replace(/[^a-z0-9-]/g, "");
    const host = `${id}.${D}`;
    w.site({ host, pages: { "/": PAGES[kind](`${kind} ${f}`), "/services": page("Services"), "/about": page("About"), "/login": page("Sign in"), "/book": page("Book") }, ...framing(f), ...extra });
    if (zone) w.cloudflareZone(host, ACCT, { proxied: [host] });
    configs.push({ id, input: `https://${host}/`, expect, kind, framing: f });
    return host;
  };
  // 12 technologies × 4 framing setups = 48 websites that must become native-verified.
  for (const k of GOOD) for (const f of ["xfo", "csp-none", "allowed", "xfo+csp"] as Framing[]) add(k, f, "native_verified");
  // 7 defects × 3 framing setups = 21 websites that must NOT be verified (whatever their frame rate or framing).
  // The site's own design, identical direct and embedded (×3).
  for (const f of ["xfo", "csp-none", "allowed"] as Framing[]) add("no-scroll", f, "native_verified");
  for (const k of BAD) for (const f of ["xfo", "csp-none", "allowed"] as Framing[]) {
    const host = add(k, f, "unavailable");
    if (k === "browser-refuses") variance.set(host, { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'self'" });
    if (k === "module-race") later.set(host, homepage(`${k} ${f}`, { webgl: "module-error" }));
  }
  // Security: sign-in and booking pages that permit framing block publication of an otherwise working site (×4).
  for (const v of ["a", "b", "c", "d"]) { const id = `sensitive-exposed-${v}`, host = `${id}.${D}`; w.site({ host, pages: { "/": PAGES["sensitive-exposed"](id), "/login": page("Sign in"), "/book": page("Book") }, ...framing("allowed"), sensitiveOpen: true }); configs.push({ id, input: `https://${host}/`, expect: "unavailable", kind: "sensitive-exposed", framing: "allowed" }); }
  // Authorization blockers: not served by any connected account (×9); a per-request CSP nonce no rule can match (×5).
  for (let i = 1; i <= 9; i++) { const id = `not-owned-${i}`, host = `${id}.${D}`; w.site({ host, pages: { "/": homepage(id), "/login": page("Sign in") }, ...framing("xfo") }); configs.push({ id, input: `https://${host}/`, expect: "authorization_required", kind: "not-owned", framing: "xfo" }); }
  for (let i = 1; i <= 5; i++) { const id = `csp-nonce-${i}`, host = `${id}.${D}`; w.site({ host, pages: { "/": homepage(id), "/login": page("Sign in") }, baseXfo: null, baseCsp: "default-src 'self' 'unsafe-inline'; frame-ancestors 'none'", cspNonce: true }).cloudflareZone(host, ACCT, { proxied: [host] }); configs.push({ id, input: `https://${host}/`, expect: "unavailable", kind: "csp-unstable" }); }
  // Intake: invalid (×3) and duplicates — repeated, www, a deeper path, and redirects to a listed site (×7).
  for (const [id, input] of [["invalid-http-local", "http://localhost/"], ["invalid-text", "notawebsite"], ["invalid-private-ip", "https://10.0.0.1/"]]) configs.push({ id, input, expect: "invalid", kind: "intake" });
  configs.push({ id: "dup-repeat-1", input: `https://static-xfo.${D}/`, expect: "duplicate", kind: "intake" });
  configs.push({ id: "dup-repeat-2", input: `https://webgl-allowed.${D}`, expect: "duplicate", kind: "intake" });
  configs.push({ id: "dup-www", input: `https://www.csr-xfo.${D}/`, expect: "duplicate", kind: "intake" });
  configs.push({ id: "dup-www-2", input: `https://www.web-components-allowed.${D}/`, expect: "duplicate", kind: "intake" });
  configs.push({ id: "dup-path", input: `https://heavy-csp-none.${D}/about`, expect: "duplicate", kind: "intake" });
  for (const v of ["a", "b"]) { const host = `old-${v}.${D}`; w.site({ host, pages: { "/": "" }, redirectTo: `https://div-only-xfo.${D}/` }); configs.push({ id: `dup-redirect-${v}`, input: `https://${host}/`, expect: "duplicate", kind: "intake" }); }
  return { w, configs, variance, later };
}
test("[PORT-NATIVE-MATRIX] 100 configurations through one bulk Add and the real job: zero false approvals, zero false rejections", { skip, timeout: 3_600_000 }, async () => {
  const { w, configs, variance, later } = build();
  assert.equal(configs.length, 100, "one hundred configurations");
  const browsers: (() => void)[] = [];
  const t = await createTestApp({ PORTFOLIO_CLOUDFLARE_TOKEN: "cf-test-token", PORTFOLIO_NATIVE_CONCURRENCY: process.env.MATRIX_CONCURRENCY ?? "4", PORTFOLIO_NATIVE_ONBOARD_DAILY: "400",
    overrides: { portfolioFetch: w.fetchSite, providerFetch: w.fetchApi,
      nativeBrowser: async () => { const b = await launchLocalBrowser(CHROMIUM!, ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"]); browsers.push(b.close); return { cdp: new Cdp(b.ws, 30_000), close: b.close }; } } } as never);
  (t.env.overrides as { storage: unknown }).storage = t.storage;
  const client = t.client(), loads = new Map<string, number>();
  (t.env.overrides as { nativeFixture: unknown }).nativeFixture = async (url: string) => {
    const u = new URL(url);
    if (u.host === "crestmont.test") { const r = await client.get(u.pathname + u.search); const headers: Record<string, string> = {}; r.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v; }); return { status: r.status, headers, body: await r.text() }; }
    const lt = later.get(u.hostname);
    if (lt && u.pathname === "/") { const n = (loads.get(u.hostname) ?? 0) + 1; loads.set(u.hostname, n); if (n > 1) { const base = w.respond(url)!; return { ...base, body: lt }; } }
    const r = w.respond(url);
    if (!r) return { status: 404, headers: { "content-type": "text/plain" }, body: "" };
    return { ...r, headers: { ...r.headers, ...(variance.get(u.hostname) ?? {}) } };
  };
  const started = Date.now();
  try {
    const owner = await createStaff(t.db, "owner");
    const o = await client.login(owner.email, TEST_PASSWORD);
    // ONE submission of all 100 addresses (Staff → Portfolio → Add several).
    const res = await o.post("/staff/portfolio/bulk", { urls: configs.map((c) => c.input).join("\n") });
    assert.equal(res.status, 200);
    const html = await res.text();
    const intake = new Map([...html.matchAll(/<li data-result="(\w+)">[^<]*<strong>([^<]+)<\/strong>/g)].map((m) => [m[2], m[1]]));
    const queuedAt = Date.now();
    // Only the real scheduled job advances them — no direct database edit, no forced step.
    let ticks = 0;
    for (; ticks < 60; ticks++) {
      const busy = (await listActive(t.db)).filter((p) => p.live_url.includes(D) && p.native_state === "checking" || p.native_state === "preparing").length;
      if (!busy) break;
      await runJobs(t.env, ["portfolio_native"]);
    }
    const entries = (await listActive(t.db)).filter((p) => p.live_url.includes(D));   // (the test database's seed entries aside)
    const bySite = new Map(entries.map((p) => [new URL(p.live_url).hostname, p]));
    // Expected vs actual, per configuration.
    const rows = configs.map((c) => {
      let actual: string;
      if (["invalid", "duplicate", "existing"].includes(c.expect)) actual = intake.get(c.input) ?? intake.get(c.input.trim()) ?? [...intake.entries()].find(([k]) => k.startsWith(c.input.replace(/\/$/, "")))?.[1] ?? "missing";
      else { const p = bySite.get(new URL(c.input).hostname); actual = p?.native_state ?? "missing"; }
      // "existing" and "duplicate" are both de-duplication (which one depends on whether the first copy was already created).
      const okExpected = actual === c.expect || (c.expect === "invalid" && actual === "unreachable") || (c.expect === "duplicate" && actual === "existing");
      return { ...c, actual, ok: okExpected, reason: bySite.get(new URL(c.input.includes("://") ? c.input : "https://x/").hostname)?.native_reason?.slice(0, 240) ?? "" };
    });
    const falseApprovals = rows.filter((r) => r.actual === "native_verified" && r.expect !== "native_verified");
    const falseRejections = rows.filter((r) => r.expect === "native_verified" && r.actual !== "native_verified");
    const other = rows.filter((r) => !r.ok && !falseApprovals.includes(r) && !falseRejections.includes(r));
    const verifications = (await t.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'portfolio.native_verification'`).first<{ n: number }>())!.n;
    const metrics = {
      configurations: configs.length, entriesCreated: entries.length, ticks, verifications,
      seconds: { total: Math.round((Date.now() - started) / 1000), intake: Math.round((queuedAt - started) / 1000), queue: Math.round((Date.now() - queuedAt) / 1000) },
      expected: Object.fromEntries([...new Set(configs.map((c) => c.expect))].map((e) => [e, configs.filter((c) => c.expect === e).length])),
      correct: rows.filter((r) => r.ok).length, falseApprovals: falseApprovals.map((r) => r.id), falseRejections: falseRejections.map((r) => `${r.id}: ${r.reason}`), otherMismatches: other.map((r) => `${r.id}: expected ${r.expect}, got ${r.actual} ${r.reason}`),
      rulesPerZone: Math.max(0, ...w.zones.map((z) => z.rulesets?.rules.length ?? 0)), published: entries.filter((p) => p.published).length,
      rows: rows.map(({ id, kind, framing: f, expect, actual }) => ({ id, kind, framing: f, expect, actual })),
    };
    if (process.env.MATRIX_REPORT) writeFileSync(process.env.MATRIX_REPORT, JSON.stringify(metrics, null, 1));
    console.log(JSON.stringify({ ...metrics, rows: undefined }, null, 1));
    assert.deepEqual(metrics.falseApprovals, [], "zero false approvals");
    assert.deepEqual(metrics.falseRejections, [], "zero false rejections");
    assert.deepEqual(metrics.otherMismatches, [], "every configuration reached its expected verdict");
    assert.equal(entries.length, 100 - 3 - 7, "no duplicate entries: one per distinct website");
    assert.ok(metrics.rulesPerZone <= 1, "never more than one Crestmont rule per zone");
    assert.equal(metrics.published, 0, "nothing was published");
    // Every verified website carries visual evidence and its protected pages still refuse framing.
    for (const p of entries.filter((x) => x.native_state === "native_verified")) {
      const v = JSON.parse(p.native_verification!);
      assert.ok(v.shots?.some((s: { label: string }) => s.label === "embedded"), `${p.slug}: screenshot evidence`);
      assert.ok(v.checks.some((c: { name: string; ok: boolean }) => c.name === "protected pages" && c.ok), `${p.slug}: protected pages`);
    }
  } finally { for (const c of browsers) c(); t.close(); }
});
