// End-to-end in a REAL browser (Owner, 2026-11-18: "Create a real end-to-end test that simulates adding a completely
// new owned website"). A new TEST DATA website that refuses Crestmont's frame is added through Staff → Portfolio; the
// automation discovers it through the (hermetic) Cloudflare connection, adds Crestmont's rule for its public pages,
// sees the new headers, and the REAL verifier (src/services/native/verify.ts) drives a real Chromium through
// Crestmont's verification page: Chromium itself enforces the site's headers, renders its WebGL "globe", scrolls,
// clicks, and loads it at phone width. Then the entry is published and its protected pages still refuse framing.
// Negative cases use the same real browser: a WebGL scene that never draws, a JavaScript bundle that fails (blank
// page), and a site whose frame the BROWSER refuses although Crestmont's own header check passed.
// Needs Chromium: NATIVE_E2E_CHROMIUM, or the Playwright module (PLAYWRIGHT_MODULE / playwright). Skipped otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import { NativeWorld, homepage, page } from "./support/native-world.ts";
import { getById, getBySlug } from "../src/services/portfolio.ts";
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
const ACCT = "b".repeat(32);

async function world(w: NativeWorld, extra: Record<string, unknown> = {}) {
  const browsers: (() => void)[] = [];
  const t = await createTestApp({ PORTFOLIO_CLOUDFLARE_TOKEN: "cf-test-token", ...extra, overrides: { portfolioFetch: w.fetchSite, providerFetch: w.fetchApi,
    nativeBrowser: async () => { const b = await launchLocalBrowser(CHROMIUM!, ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"]); browsers.push(b.close); return { cdp: new Cdp(b.ws, 30_000), close: b.close }; } } } as never);
  // What the verification browser fetches: Crestmont's own pages from this in-process app, the TEST DATA sites from the
  // world (with the browser-side variance a test may set), and nothing from the real network.
  const client = t.client();
  (t.env.overrides as { nativeFixture: unknown }).nativeFixture = async (url: string) => {
    const u = new URL(url);
    if (u.host === "crestmont.test") { const r = await client.get(u.pathname + u.search); const headers: Record<string, string> = {}; r.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v; }); return { status: r.status, headers, body: await r.text() }; }
    const r = w.respond(url);
    if (!r) return { status: 404, headers: { "content-type": "text/plain" }, body: "" };
    return { ...r, headers: { ...r.headers, ...(browserVariance.get(u.hostname) ?? {}) } };
  };
  const owner = await createStaff(t.db, "owner");
  const o = await t.client().login(owner.email, TEST_PASSWORD);
  const add = async (slug: string, url: string) => {
    const r = await o.post("/staff/portfolio", { name: slug, slug, industry: "Testing", live_url: url, description: `${slug} is a TEST DATA website for native onboarding.`, features: "", technology_summary: "", relationship: "Relationship documentation pending" });
    assert.equal(r.status, 303);
    return (await getBySlug(t.db, slug))!;
  };
  return { t, o, add, close: () => { for (const c of browsers) c(); t.close(); } };
}
const browserVariance = new Map<string, Record<string, string>>();
const checks = (p: { native_verification?: string | null }) => (JSON.parse(p.native_verification ?? "{}").checks ?? []) as { name: string; ok: boolean; detail: string }[];

test("[PORT-NATIVE-E2E] a NEW owned website: refuses → prepared through Cloudflare → real Chromium verifies content, WebGL globe, scroll, click, phone width → published; protected pages still refuse; re-run changes nothing", { skip, timeout: 240_000 }, async () => {
  const w = new NativeWorld()
    .site({ host: "earth.fixture-native.com", pages: { "/": homepage("Earth Fixture", { webgl: "ok" }), "/services": page("Services"), "/about": page("About"), "/login": page("Sign in"), "/book": page("Book") } })
    .cloudflareZone("fixture-native.com", ACCT, { workerDomain: { hostname: "earth.fixture-native.com", service: "earth" } });
  const { t, o, add, close } = await world(w);
  try {
    assert.equal(w.respond("https://earth.fixture-native.com/")!.headers["x-frame-options"], "DENY", "1–2: the new site initially refuses Crestmont's frame");
    let p = await add("earth", "https://earth.fixture-native.com/");                   // 3: submitted
    assert.equal(p.native_state, "preparing", p.native_reason!);                         // 4–6: discovered, rule applied
    assert.match(p.native_provider!, /Workers custom domain \(earth\)/);
    await runJobs(t.env, ["portfolio_native"]);                                          // 7–9: new policy detected → real verification
    p = (await getById(t.db, p.id))!;
    const c = checks(p);
    assert.equal(p.native_state, "native_verified", `${p.native_reason}\n${JSON.stringify(c, null, 1)}`);
    const by = Object.fromEntries(c.map((x) => [x.name, x]));
    for (const n of ["frame", "content", "javascript", "canvas", "scroll", "click", "mobile", "protected pages"]) assert.ok(by[n]?.ok, `${n}: ${by[n]?.detail}`);
    assert.match(by.canvas.detail, /\d+×\d+ webgl canvas drew \d+% of its area, animating/, "the WebGL scene really drew and animated inside the frame");
    // The same website was measured directly and inside Crestmont (performance, environment context recorded).
    assert.match(by.performance.detail, /embedded: LCP .* direct: LCP /);
    const perf = JSON.parse(p.native_perf ?? "{}");
    assert.ok(perf.direct && perf.embedded, "direct and embedded performance recorded");
    assert.match(perf.environment, /viewport 1440×900/);
    assert.match(by.scroll.detail, /A wheel gesture scrolled the site/);                 // 10: scroll and safe interaction
    assert.match(by["protected pages"].detail, /\/book, \/login/);                       // 11: protected pages still refuse
    // 12: publishable after the existing authorization steps, and the public page frames the real site.
    await o.post(`/staff/portfolio/${p.id}/verify-link`, { verified_on: new Date().toISOString().slice(0, 10) });
    await o.post(`/staff/portfolio/${p.id}/relationship`, { relationship: "Website owned by the Owner (TEST DATA)", evidence: "TEST DATA ownership record" });
    await o.post(`/staff/portfolio/${p.id}/consent`, { given_by: "Test Owner, owner", method: "written", given_on: new Date().toISOString().slice(0, 10), evidence: "TEST DATA consent on file" });
    assert.equal((await o.post(`/staff/portfolio/${p.id}/publish`, {})).status, 303);
    assert.match(await (await t.client().get("/portfolio/earth")).text(), /data-kind="live"[^>]*data-frame-url="https:\/\/earth\.fixture-native\.com\/"/);
    // 13: re-running verifies again but changes nothing at the provider and needs no repair.
    const writes = w.writes.length;
    await o.post(`/staff/portfolio/${p.id}/embed-check`, {});
    p = (await getById(t.db, p.id))!;
    assert.equal(p.native_state, "native_verified");
    assert.equal(w.writes.length, writes);
    assert.equal(w.zones[0].rulesets!.rules.length, 1);
  } finally { close(); }
});

test("[PORT-NATIVE-E2E] real-browser negatives: a WebGL scene that never draws, a JavaScript bundle that fails (blank page), and a frame the browser refuses — none becomes native", { skip, timeout: 240_000 }, async () => {
  const w = new NativeWorld()
    .site({ host: "nogl.fixture-native.com", baseXfo: null, pages: { "/": homepage("No GL", { webgl: "fail" }) } })
    .site({ host: "broken.fixture-native.com", baseXfo: null, pages: { "/": homepage("Broken", { brokenJs: true }) } })
    .site({ host: "cdn.fixture-native.com", baseXfo: null, pages: { "/": homepage("CDN variance") } });
  browserVariance.set("cdn.fixture-native.com", { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'self'" });
  const { add, close } = await world(w, { PORTFOLIO_CLOUDFLARE_TOKEN: "" });
  try {
    const gl = await add("nogl", "https://nogl.fixture-native.com/");
    assert.equal(gl.native_state, "unavailable");
    // Classified as the website's own defect (also when visited directly) — never blamed on Crestmont's frame.
    assert.match(gl.native_reason!, /canvas: essential \d+×\d+ canvas drew nothing — it was never initialised \(WebGL\/2D failed to render\) — also when visited directly/);
    const glDiag = JSON.parse(gl.native_diagnosis ?? "{}");
    assert.ok(glDiag.codes.includes("site_render_defect"), JSON.stringify(glDiag));
    assert.equal(glDiag.embedFailure, false, "the frame is not what fails");
    const br = await add("broken", "https://broken.fixture-native.com/");
    assert.equal(br.native_state, "unavailable");
    assert.match(br.native_reason!, /content: The framed page is blank or stuck loading .*JavaScript error/);
    const cdn = await add("cdn", "https://cdn.fixture-native.com/");
    assert.equal(cdn.native_state, "unavailable");
    assert.match(cdn.native_reason!, /frame: The browser did not load https:\/\/cdn\.fixture-native\.com inside Crestmont's frame/);
  } finally { browserVariance.clear(); close(); }
});

test("[PORT-NATIVE-E2E] context-aware visuals: a decorative empty background canvas and a late-starting 3D scene pass; a visible scene whose draw calls produce nothing is the website's own defect", { skip, timeout: 300_000 }, async () => {
  const w = new NativeWorld()
    .site({ host: "decor.fixture-native.com", baseXfo: null, baseCsp: "frame-ancestors http://crestmont.test", pages: { "/": homepage("Decorative Canvas", { webgl: "decorative" }) } })
    .site({ host: "lazy.fixture-native.com", baseXfo: null, baseCsp: "frame-ancestors http://crestmont.test", pages: { "/": homepage("Lazy Scene", { webgl: "deferred" }) } })
    .site({ host: "draws.fixture-native.com", baseXfo: null, baseCsp: "frame-ancestors http://crestmont.test", pages: { "/": homepage("Broken Draws", { webgl: "broken-draws" }) } });
  const { add, close } = await world(w, { PORTFOLIO_CLOUDFLARE_TOKEN: "" });
  try {
    const decor = await add("decor", "https://decor.fixture-native.com/");
    assert.equal(decor.native_state, "native_verified", decor.native_reason!);
    assert.match(checks(decor).find((c) => c.name === "canvas")!.detail, /decorative layer .* harmless/);
    const lazy = await add("lazy", "https://lazy.fixture-native.com/");
    assert.equal(lazy.native_state, "native_verified", lazy.native_reason!);
    assert.match(checks(lazy).find((c) => c.name === "canvas")!.detail, /webgl canvas drew \d+% of its area/);
    const draws = await add("draws", "https://draws.fixture-native.com/");
    assert.equal(draws.native_state, "unavailable");
    assert.match(draws.native_reason!, /essential 480×480 webgl canvas drew nothing \(\d+ draw calls produced no visible pixels\).*also when visited directly/);
    assert.ok(JSON.parse(draws.native_diagnosis!).codes.includes("site_render_defect"));
  } finally { close(); }
});
