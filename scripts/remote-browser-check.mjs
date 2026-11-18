// Real-browser acceptance of the automatic portfolio display system (docs/frontend/PORTFOLIO.md §Display modes) against
// the development server with the remote browser on a local Chromium and the TEST DATA fixture sites
// (scripts/fixtures/remote/sites.mjs). Run by CI (.github/workflows/ci.yml, job portfolio-remote-browser):
//   REMOTE_BROWSER=on REMOTE_BROWSER_CHROMIUM=<chromium> REMOTE_BROWSER_FIXTURES=1 REMOTE_BROWSER_MAX_CONCURRENT=2 \
//   REMOTE_BROWSER_IDLE_SECONDS=20 REMOTE_BROWSER_RATE_PER_10MIN=500 node dev/server.ts --port 8787 --db .dev/rb.db &
//   node scripts/remote-browser-check.mjs http://localhost:8787 .dev/rb.db
// What it proves (each line is one named check; any failure fails the job):
//   • the normal staff Add flow selects Mode A / B / C automatically for frame-ancestors 'none', X-Frame-Options DENY,
//     an allowed site and an unreachable one, and the staff editor shows the mode, its reason and its limitations;
//   • a blocked site published through the normal requirements is interactive on /portfolio/<slug>, /portfolio and the
//     homepage: clicks, typing, wheel and touch scrolling and same-site navigation reach the REAL page inside the remote
//     Chromium (the fixture page reports what it saw), while Crestmont's own page does not move;
//   • sign-in pages, third-party sites, downloads and form posts never reach the site; reload, Back, device switching
//     (desktop 1440 / tablet 820 / phone 390), heavy JS animation and a long page work;
//   • phone (Android, touch), iPhone-sized and tablet viewports — Chromium emulation, NOT Safari;
//   • concurrency limit, cleanup of closed sessions, idle timeout, failure recovery after the browser dies, and the API's
//     refusal of cross-origin, unpublished and reused-token requests.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { hashPassword, newTotpSecret, totpCode } from "../src/lib/auth-crypto.ts";
import { LAYOUT, EXPECTED_MODE, fixtureResponse } from "./fixtures/remote/sites.mjs";

const [BASE = "http://localhost:8787", DB = ".dev/rb.db"] = process.argv.slice(2);
const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const db = new DatabaseSync(DB);
const results = [];
const check = async (name, fn) => {
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`); }
  catch (e) { results.push({ name, ok: false }); console.log(`FAIL ${name}: ${(e && e.message || String(e)).split("\n").slice(0, 6).join(" | ")}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (path, init) => (await fetch(BASE + path, init)).json();
const fx = (name) => json(`/__dev/remote-fixtures/state?name=${name}`);
async function until(what, fn, ms = 15000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { last = await fn(); if (last && last.ok) return last; await sleep(200); }
  throw new Error(`${what} — not seen within ${ms / 1000} s (last: ${JSON.stringify(last && last.v !== undefined ? last.v : last)})`);
}
const stateIs = (name, pred, what, ms) => until(what, async () => { const v = await fx(name); return { ok: !!v && pred(v), v }; }, ms);
const activeSessions = async () => (await json("/api/portfolio/remote-sessions/status")).active;

const browser = await chromium.launch();
const pw = "Fixture-pass-2026!";

// ── Staff (TEST DATA): an Owner signs in through the real login page with TOTP ──
const ownerEmail = `owner.rb.${Date.now()}@crestmont.test`, secret = newTotpSecret(), now = new Date().toISOString();
db.exec(`INSERT OR IGNORE INTO organizations (id, name, kind, created_at) VALUES ('org_crestmont','Crestmont Website Development','internal','${now}')`);
db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, totp_secret, mfa_enabled, created_at) VALUES (?,?,?,?,?,?,1,?)`).run("usr_rb_owner", ownerEmail, "RB Owner", await hashPassword(pw), now, secret, now);
db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?,?,?)`).run("mbr_rb_owner", "usr_rb_owner", "org_crestmont", "owner", now);
const staffCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
// Mode A's iframe loads the allowed fixture straight from the visitor's browser: answered here, like a real site.
await staffCtx.route("https://allowed.fixture-portfolio.com/**", (route) => { const a = fixtureResponse(route.request().url(), new URL(BASE).origin); return route.fulfill({ status: a.status, headers: a.headers, body: a.body }); });
const staff = await staffCtx.newPage();
await staff.goto(BASE + "/login");
await staff.fill("#f-email", ownerEmail); await staff.fill("#f-password", pw);
await Promise.all([staff.waitForLoadState("load"), staff.click("button[type=submit]")]);
if (new URL(staff.url()).pathname.startsWith("/mfa")) { await staff.fill("#f-code", await totpCode(secret)); await Promise.all([staff.waitForNavigation(), staff.click("button[type=submit]")]); }
assert.doesNotMatch(new URL(staff.url()).pathname, /^\/(login|mfa)/, "owner signed in");

const projectId = {};
async function addProject(name) {
  await staff.goto(BASE + "/staff/portfolio");
  await staff.fill('[data-testid="pf-new"] input[name="live_url"]', `https://${name}.fixture-portfolio.com/`);
  await Promise.all([staff.waitForNavigation(), staff.locator('[data-testid="pf-new"] button[type=submit]').click()]);
  const verdict = await staff.locator(".alert").first().innerText();
  await staff.fill('input[name="name"]', `RB ${name}`);
  await staff.fill('input[name="slug"]', `rb-${name}`);
  await staff.fill('input[name="industry"]', "Testing (TEST DATA)");
  if (!(await staff.inputValue('textarea[name="description"]'))) await staff.fill('textarea[name="description"]', "TEST DATA fixture site.");
  await Promise.all([staff.waitForNavigation(), staff.getByRole("button", { name: /create project/i }).click()]);
  const m = /\/staff\/portfolio\/([^/?#]+)$/.exec(new URL(staff.url()).pathname);
  assert.ok(m, `editor opened for ${name} (${staff.url()})`);
  projectId[name] = m[1];
  return { verdict, mode: await staff.locator('[data-testid="pf-embed"]').getAttribute("data-display-mode"), reason: await staff.locator('[data-testid="pf-embed"]').innerText() };
}
async function publish(name) {
  await staff.goto(`${BASE}/staff/portfolio/${projectId[name]}`);
  const submit = (form) => Promise.all([staff.waitForNavigation(), staff.locator(`${form} button[type=submit]`).last().click()]);
  await submit(`form[action$="/verify-link"]`);
  await staff.fill('form[action$="/relationship"] input[name="relationship"]', "TEST DATA fixture (no real business)");
  await staff.fill('form[action$="/relationship"] textarea[name="evidence"]', "CI fixture; no real business involved.");
  await submit(`form[action$="/relationship"]`);
  await staff.fill('form[action$="/consent"] input[name="given_by"]', "TEST DATA fixture owner");
  await staff.selectOption('form[action$="/consent"] select[name="method"]', "written");
  await staff.fill('form[action$="/consent"] input[name="given_on"]', new Date().toISOString().slice(0, 10));
  await staff.fill('form[action$="/consent"] textarea[name="evidence"]', "CI fixture; not a real consent record.");
  await submit(`form[action$="/consent"]`);
  await submit(`form[action$="/publish"]`);
  assert.equal(db.prepare("SELECT published FROM portfolio_projects WHERE id = ?").get(projectId[name]).published, 1, `${name} published without screenshots`);
}

// ── 1. Automatic mode selection in the normal Add workflow ──
for (const name of ["fa-none", "xfo-deny", "heavy-js", "late-paint", "allowed", "unavailable"]) {
  await check(`add ${name}: automatic mode = ${EXPECTED_MODE[name]}`, async () => {
    const r = await addProject(name);
    assert.equal(r.mode, EXPECTED_MODE[name], `display mode recorded (${r.reason.slice(0, 200)})`);
    if (EXPECTED_MODE[name] === "remote") {
      assert.match(r.verdict, /Remote interactive browser selected \(Mode B\)/, "step 2 tells staff the remote browser will be used");
      assert.match(r.reason, /Mode B — remote interactive browser/);
      assert.match(await staff.locator('[data-testid="pf-remote-limits"]').innerText(), /Sign-in, account and checkout pages.*blocked/s, "limitations shown to staff");
      // Immediate staff preview (unpublished, through a short-lived preview link).
      await staff.waitForSelector(".pfx__slide.is-ready canvas.pfx__remote", { timeout: 40000 });
    } else if (EXPECTED_MODE[name] === "embed") {
      assert.match(r.reason, /Mode A — native interactive embed/);
      await staff.waitForSelector('.pfx__slide[data-kind="live"].is-ready iframe', { timeout: 30000 });
    } else {
      assert.match(r.reason, /Mode C — unavailable/);
      assert.equal(await staff.locator("canvas.pfx__remote, iframe.pfx__frame").count(), 0, "nothing interactive is claimed");
      assert.doesNotMatch(await staff.locator("[data-pfx-flag]").first().innerText(), /live/i, "not labelled live");
    }
  });
}
// Leave the staff editor so its preview session is released before the visitor checks.
await staff.goto(BASE + "/staff/portfolio");
await check("publish the blocked sites through the normal requirements (no screenshots needed in Mode B)", async () => { for (const n of ["fa-none", "xfo-deny", "heavy-js", "late-paint"]) await publish(n); await staff.goto(BASE + "/staff/portfolio"); });
await until("staff preview sessions released", async () => ({ ok: (await activeSessions()) === 0, v: await activeSessions() }), 20000).catch(() => undefined);

// ── Visitor helpers ──
const slideSel = (slug) => `.pfx__slide[data-remote-slug="${slug}"]`;
async function aim(page, slug, x, y) {
  const c = page.locator(`${slideSel(slug)} canvas.pfx__remote`);
  // The point must be on screen: bring the remote view fully into view first (outer page scroll, before any gesture).
  await c.evaluate((el) => { const r = el.getBoundingClientRect(); if (r.top < 0 || r.bottom > innerHeight) el.scrollIntoView({ block: "center", behavior: "instant" }); });
  const box = await c.boundingBox();
  const [w, h] = await c.evaluate((el) => [el.width, el.height]);
  return { x: box.x + (x / w) * box.width, y: box.y + (y / h) * box.height };
}
const live = (page, slug, ms = 40000) => page.waitForSelector(`${slideSel(slug)}[data-remote-state="live"].is-ready`, { timeout: ms });
const outerY = (page) => page.evaluate(() => Math.round(window.scrollY));
// The production acceptance's measure (scripts/live-remote-acceptance.mjs): samples that differ from the first one.
const contrastSamples = (page, slug) => page.locator(`${slideSel(slug)} canvas.pfx__remote`).evaluate((c) => {
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let lit = 0, n = 0; const b0 = d[0] + d[1] + d[2];
  for (let i = 0; i < d.length; i += 4 * 97) { n++; if (Math.abs(d[i] + d[i + 1] + d[i + 2] - b0) > 30) lit++; }
  return { lit, n };
});
async function visitor(opts = { viewport: { width: 1280, height: 900 } }) { const c = await browser.newContext(opts); return { c, p: await c.newPage() }; }
async function openCase(page, slug) {
  await page.goto(`${BASE}/portfolio/${slug}`);
  await page.locator(slideSel(slug)).scrollIntoViewIfNeeded();
  await live(page, slug);
  await aim(page, slug, 1, 1); // settle the outer scroll position before any measurement
}
const resetFx = () => fetch(BASE + "/__dev/remote-fixtures/reset", { method: "POST" });

// ── 2. Desktop visitor on the public case study ──
{
  const { c, p } = await visitor();
  await resetFx();
  await check("desktop: the blocked site is shown live through the remote browser (1440 px, desktop)", async () => {
    await openCase(p, "rb-fa-none");
    await stateIs("fa-none", (s) => s.w === "1440" && s.ua === "desktop" && s.path === "/", "fixture reports desktop at /");
    assert.match(await p.locator(`${slideSel("rb-fa-none")} [data-pfx-flag]`).innerText(), /remote view/i);
    const blank = await p.locator(`${slideSel("rb-fa-none")} canvas.pfx__remote`).evaluate((el) => { const d = el.getContext("2d").getImageData(0, 0, el.width, el.height).data; let v = 0; for (let i = 0; i < d.length; i += 4000) v += d[i] + d[i + 1] + d[i + 2]; return v === 0; });
    assert.equal(blank, false, "pixels are drawn");
  });
  await check("desktop: wheel scrolls the remote page; Crestmont's page stays still", async () => {
    const before = await outerY(p);
    const at = await aim(p, "rb-fa-none", 700, 500);
    await p.mouse.move(at.x, at.y);
    for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, 400); await sleep(80); }
    await stateIs("fa-none", (s) => Number(s.scrollY) > 600, "remote scrollY > 600");
    assert.equal(await outerY(p), before, "outer page did not scroll");
    for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, -800); await sleep(60); }
    await stateIs("fa-none", (s) => s.scrollY === "0", "back to the top");
    assert.equal(await outerY(p), before, "outer page did not scroll at the top edge either");
  });
  await check("desktop: a click reaches the real page", async () => {
    const at = await aim(p, "rb-fa-none", LAYOUT.clicker.x, LAYOUT.clicker.y);
    await p.mouse.click(at.x, at.y);
    await stateIs("fa-none", (s) => s.clicks === "1", "clicks = 1");
  });
  await check("desktop: typing into the site's search box", async () => {
    const at = await aim(p, "rb-fa-none", LAYOUT.search.x, LAYOUT.search.y);
    await p.mouse.click(at.x, at.y);
    await p.keyboard.type("crestmont", { delay: 30 });
    await stateIs("fa-none", (s) => s.q === "crestmont", "typed text arrived");
  });
  await check("desktop: same-site navigation, the URL bar, and Back", async () => {
    const at = await aim(p, "rb-fa-none", LAYOUT.about.x, LAYOUT.about.y);
    await p.mouse.click(at.x, at.y);
    await stateIs("fa-none", (s) => s.path === "/about", "navigated to /about");
    await until("URL bar shows /about", async () => ({ ok: /\/about$/.test(await p.locator(`${slideSel("rb-fa-none")} [data-pfx-url]`).innerText()) }));
    await p.click("[data-pfx-back]");
    await stateIs("fa-none", (s) => s.path === "/", "Back returned to /");
  });
  await check("desktop: sign-in page, third-party site, download and form post never reach anything", async () => {
    const liveText = () => p.locator("[data-pfx-live]").first().evaluate((el) => el.textContent);
    for (const [k, navigates] of [["login", true], ["external", true], ["download", false], ["post", false]]) {
      await p.locator("[data-pfx-live]").first().evaluate((el) => { el.textContent = ""; });
      const at = await aim(p, "rb-fa-none", LAYOUT[k].x, LAYOUT[k].y);
      await p.mouse.click(at.x, at.y);
      if (navigates) {
        await until(`${k}: the visitor is told`, async () => ({ ok: /not available in the portfolio view/i.test(await liveText()), v: await liveText() }), 8000);
        await p.click("[data-pfx-back]");
        await stateIs("fa-none", (s) => s.path === "/" && Number(s.at) > Date.now() - 4000, `${k}: Back to the site`, 8000);
      } else await sleep(1200);
    }
    const s = await fx("fa-none");
    assert.equal(s.privateReached, undefined, `no private route, file or form post reached the site (${s.privateReached})`);
    assert.equal(await fx("elsewhere"), null, "the third-party site was never loaded");
  });
  await check("desktop: Reload returns to the site's home page", async () => {
    const before = Number((await fx("fa-none")).loads);
    await p.click("[data-pfx-reset]");
    await stateIs("fa-none", (s) => s.path === "/" && Number(s.loads) > before, "reloaded at /");
  });
  await check("desktop: device switching — phone 390, tablet 820, desktop 1440", async () => {
    for (const [m, w, ua] of [["mobile", "390", "mobile"], ["tablet", "820", "mobile"], ["desktop", "1440", "desktop"]]) {
      await p.click(`[data-pfx-mode="${m}"]`);
      await stateIs("fa-none", (s) => s.w === w && s.ua === ua, `${m}: viewport ${w}`);
    }
  });
  await c.close();
}

await check("closed visitors are cleaned up (sessions ended, browsers closed)", async () => {
  await until("no active sessions", async () => ({ ok: (await activeSessions()) === 0, v: await activeSessions() }), 15000);
  await until("no local browsers", async () => { const r = await json("/__dev/remote-fixtures/browsers"); return { ok: r.running === 0, v: r }; }, 15000);
});

// ── 2a. Readable layout on every slide (Owner, 2026-11-18): the long "remote view" label must not squeeze the title
// and description into a narrow strip — desktop, tablet and phone widths.
for (const [vw, vh] of [[1440, 900], [1280, 800], [820, 1180], [390, 844]]) {
  const { c, p } = await visitor({ viewport: { width: vw, height: vh } });
  await check(`layout at ${vw} px: every slide keeps a readable description beside its links`, async () => {
    await p.goto(`${BASE}/portfolio`);
    await p.locator(".pfx").first().scrollIntoViewIfNeeded();
    const n = await p.locator(".pfx__slide").count();
    const bad = [];
    for (let i = 0; i < n; i++) {
      if (i) { await p.locator("[data-pfx-next]").first().click(); await sleep(500); }
      const l = await p.evaluate(() => {
        const s = document.querySelector(".pfx__slide:not([inert])"), w = (sel) => s.querySelector(sel)?.getBoundingClientRect().width ?? 0;
        return { name: s.dataset.name, kind: s.dataset.kind, meta: w(".pfx__meta"), desc: w(".pfx__desc"), links: w(".pfx__links") };
      });
      const stacked = vw <= 1000;
      if (!(l.meta > 0 && l.desc >= l.meta * (stacked ? 0.85 : 0.5) && (stacked || l.links <= l.meta * 0.42))) bad.push(`${l.name} (${l.kind}): description ${Math.round(l.desc)} of ${Math.round(l.meta)} px, links ${Math.round(l.links)} px`);
    }
    assert.equal(n > 0, true, "slides present");
    assert.deepEqual(bad, [], "squeezed slides");
  });
  await c.close();
}
await until("layout visitors released", async () => ({ ok: (await activeSessions()) === 0, v: await activeSessions() }), 30000).catch(() => undefined);

// ── 2b. A website that paints late (production: Get Every Invoice Paid paints a dark empty page ~1 s before its
// content fades in; Premium Invoices a black frame before its first paint). The slide must not be shown as live until
// its content is on screen — the visitor never sees an empty box labelled "Live website".
{
  const { c, p } = await visitor({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await check("a website that paints late is shown live only once its content is on screen (desktop, 1440 px)", async () => {
    await p.goto(`${BASE}/portfolio/rb-late-paint`);
    await p.locator(slideSel("rb-late-paint")).scrollIntoViewIfNeeded();
    await live(p, "rb-late-paint");
    const { lit, n } = await contrastSamples(p, "rb-late-paint");
    assert.ok(lit >= 0.02 * n, `content on screen at the moment the slide turned live (${lit} of ${n} samples with contrast, ≥ 2%; the empty dark page has ~1%)`);
  });
  await c.close();
}

// ── 3. Heavy JavaScript animation and a long page ──
{
  const { c, p } = await visitor();
  await check("heavy JS animation renders and keeps changing", async () => {
    await openCase(p, "rb-heavy-js");
    await stateIs("heavy-js", (s) => Number(s.raf) > 30, "animation frames running");
    const px = () => p.locator(`${slideSel("rb-heavy-js")} canvas.pfx__remote`).evaluate((el) => [...el.getContext("2d").getImageData(400, 400, 1, 1).data].slice(0, 3).join(","));
    const a = await px(); await sleep(700); const b = await px(); await sleep(700); const d = await px();
    assert.ok(a !== b || b !== d, `the picture changes over time (${a} / ${b} / ${d})`);
  });
  await c.close();
}
{
  const { c, p } = await visitor({ viewport: { width: 1280, height: 900 } });
  await check("long page: scrolls to its end; Crestmont's page stays still at the bottom edge", async () => {
    await openCase(p, "rb-xfo-deny");
    const before = await outerY(p);
    const at = await aim(p, "rb-xfo-deny", 700, 400);
    await p.mouse.move(at.x, at.y);
    for (let i = 0; i < 30; i++) { await p.mouse.wheel(0, 600); await sleep(40); }
    await stateIs("xfo-deny", (s) => Number(s.scrollY) > 7000, "reached the end of the 9000 px page", 20000);
    for (let i = 0; i < 5; i++) { await p.mouse.wheel(0, 600); await sleep(40); }
    assert.equal(await outerY(p), before, "outer page did not move");
  });
  await c.close();
}

// ── 4. Phones and tablet (Chromium device emulation with touch — NOT Safari) ──
/** A vertical swipe between two fractions of the remote view's height (0 = top, 1 = bottom). */
async function touchSwipe(p, slug, from, to) {
  const cdp = await p.context().newCDPSession(p);
  const h = await p.locator(`${slideSel(slug)} canvas.pfx__remote`).evaluate((el) => el.height);
  const a = await aim(p, slug, 200, Math.round(h * from)), b = await aim(p, slug, 200, Math.round(h * to));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: a.x, y: a.y }] });
  for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: a.x, y: a.y + ((b.y - a.y) * i) / 8 }] }); await sleep(16); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
for (const [label, dev, w] of [["Android phone (Pixel 7)", "Pixel 7", "390"], ["iPhone-sized (iPhone 13 viewport, Chromium)", "iPhone 13", "390"], ["tablet (iPad Mini viewport)", "iPad Mini", "820"]]) {
  const opts = { ...devices[dev] }; delete opts.defaultBrowserType;
  const { c, p } = await visitor(opts);
  await resetFx();
  await check(`${label}: live remote view at ${w} px; touch scroll moves the site, not Crestmont; tap clicks`, async () => {
    await openCase(p, "rb-fa-none");
    await stateIs("fa-none", (s) => s.w === w && s.ua === "mobile", `fixture at ${w} px, mobile UA`);
    const before = await outerY(p);
    await touchSwipe(p, "rb-fa-none", 0.85, 0.2);
    await stateIs("fa-none", (s) => Number(s.touches) > 0 && Number(s.scrollY) > 100, "touch reached the site and scrolled it");
    assert.equal(await outerY(p), before, "outer page did not scroll");
    for (let i = 0; i < 3; i++) await touchSwipe(p, "rb-fa-none", 0.2, 0.9);
    await stateIs("fa-none", (s) => s.scrollY === "0", "scrolled back to the top");
    assert.equal(await outerY(p), before, "outer page did not scroll at the top edge");
    const t = await aim(p, "rb-fa-none", LAYOUT.clicker.x, LAYOUT.clicker.y);
    await p.touchscreen.tap(t.x, t.y);
    await stateIs("fa-none", (s) => Number(s.clicks) >= 1, "tap clicked the site's button");
  });
  await c.close();
}

// ── 5. Every surface: /portfolio and the homepage ──
for (const path of ["/portfolio", "/"]) {
  const { c, p } = await visitor();
  await check(`${path}: the blocked project is interactive in the shared explorer`, async () => {
    await p.goto(BASE + path);
    const root = p.locator("[data-pfx]").first();
    await root.scrollIntoViewIfNeeded();
    const idx = await p.locator(`[data-pfx] [data-pfx-slide]`).evaluateAll((els) => els.findIndex((e) => e.dataset.remoteSlug === "rb-fa-none"));
    assert.ok(idx >= 0, "the project is in the explorer");
    if (idx > 0) await p.locator(`[data-pfx-go="${idx}"]`).first().click();
    await live(p, "rb-fa-none");
    const at = await aim(p, "rb-fa-none", LAYOUT.clicker.x, LAYOUT.clicker.y);
    const before = Number((await fx("fa-none"))?.clicks ?? 0);
    await p.mouse.click(at.x, at.y);
    await stateIs("fa-none", (s) => Number(s.clicks) > before, "click arrived");
  });
  await c.close();
}

// ── 6. Several visitors at once, cleanup, idle timeout, failure recovery ──
await until("idle before the concurrency check", async () => ({ ok: (await activeSessions()) === 0, v: await activeSessions() }), 15000).catch(() => undefined);
{
  const a = await visitor(), b = await visitor(), d = await visitor();
  await check("concurrency: two visitors live at once (limit 2); a third is told honestly, and gets in once one leaves", async () => {
    await openCase(a.p, "rb-fa-none"); await openCase(b.p, "rb-fa-none");
    assert.equal(await activeSessions(), 2);
    await d.p.goto(`${BASE}/portfolio/rb-fa-none`);
    await d.p.waitForSelector(`${slideSel("rb-fa-none")}[data-remote-state="unavailable"]`, { timeout: 20000 });
    assert.match(await d.p.locator(`${slideSel("rb-fa-none")} [data-pfx-status]`).innerText(), /All interactive viewers are in use/);
    assert.match(await d.p.locator(`${slideSel("rb-fa-none")} [data-pfx-flag]`).innerText(), /unavailable/i, "never labelled live while refused");
    await a.c.close();
    await until("one session left", async () => ({ ok: (await activeSessions()) === 1, v: await activeSessions() }));
    await d.p.click(`${slideSel("rb-fa-none")} [data-pfx-resume]`);
    await live(d.p, "rb-fa-none");
  });
  await b.c.close(); await d.c.close();
}
{
  const { c, p } = await visitor();
  await check("idle sessions end on their own (20 s in CI) and Resume starts a new one", async () => {
    await openCase(p, "rb-fa-none");
    await p.waitForSelector(`${slideSel("rb-fa-none")}[data-remote-state="ended"]`, { timeout: 45000 });
    assert.match(await p.locator(`${slideSel("rb-fa-none")} [data-pfx-status]`).innerText(), /paused after a period of inactivity/);
    await until("ended session released", async () => ({ ok: (await activeSessions()) === 0, v: await activeSessions() }));
    await p.click(`${slideSel("rb-fa-none")} [data-pfx-resume]`);
    await live(p, "rb-fa-none");
  });
  await check("failure recovery: the browser dies mid-session; the visitor is told and Resume recovers", async () => {
    const r = await (await fetch(BASE + "/__dev/remote-fixtures/kill-browsers", { method: "POST" })).json();
    assert.ok(r.killed >= 1, "a browser was running");
    await p.waitForSelector(`${slideSel("rb-fa-none")}[data-remote-state="ended"]`, { timeout: 20000 });
    await p.click(`${slideSel("rb-fa-none")} [data-pfx-resume]`);
    await live(p, "rb-fa-none");
    const at = await aim(p, "rb-fa-none", LAYOUT.clicker.x, LAYOUT.clicker.y);
    const before = Number((await fx("fa-none")).clicks);
    await p.mouse.click(at.x, at.y);
    await stateIs("fa-none", (s) => Number(s.clicks) > before, "interactive again");
  });
  await c.close();
}

// ── 7. API refusals ──
await check("API: cross-origin, non-JSON, unpublished and unknown projects are refused", async () => {
  const post = (body, headers = {}) => fetch(BASE + "/api/portfolio/remote-sessions", { method: "POST", headers: { "content-type": "application/json", origin: BASE, ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ slug: "rb-fa-none" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await fetch(BASE + "/api/portfolio/remote-sessions", { method: "POST", headers: { origin: BASE, "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await post({ slug: "rb-allowed" })).status, 404, "unpublished project");
  assert.equal((await post({ slug: "rb-fa-none", preview: "0".repeat(48) })).status, 404, "invalid preview link");
  assert.equal((await post({ slug: "nope" })).status, 404);
  assert.equal((await fetch(BASE + "/portfolio/preview/" + "a".repeat(48))).status, 404, "invalid preview page");
});
{
  const { c, p } = await visitor();
  await check("API: a session token works once; a reused or wrong token is refused", async () => {
    await p.goto(BASE + "/contact");
    const r = await p.evaluate(async () => {
      const s = await (await fetch("/api/portfolio/remote-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "rb-fa-none" }) })).json();
      const open = (url) => new Promise((res) => { const ws = new WebSocket(url); let opened = false; ws.onopen = () => { opened = true; setTimeout(() => ws.close(), 300); }; ws.onclose = () => res(opened); setTimeout(() => res(opened), 8000); });
      const u = `ws://${location.host}${s.ws}&device=desktop&h=800`;
      return { first: await open(u), reused: await open(u), wrong: await open(u.replace(/token=[0-9a-f]{4}/, "token=ffff")) };
    });
    assert.deepEqual(r, { first: true, reused: false, wrong: false });
  });
  await c.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} remote-browser checks passed${failed.length ? `; FAILED: ${failed.map((f) => f.name).join("; ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
