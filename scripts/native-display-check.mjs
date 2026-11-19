// Real-browser acceptance of the ONE native-first portfolio standard (Owner, 2026-11-19: "UNIVERSAL NATIVE PORTFOLIO
// ENGINE") against the development server and the TEST DATA fixture sites (scripts/fixtures/remote/sites.mjs). Run by
// CI (.github/workflows/ci.yml, job portfolio-native-display):
//   REMOTE_BROWSER=off REMOTE_BROWSER_FIXTURES=1 REMOTE_BROWSER_CHROMIUM=<chromium> node dev/server.ts --port 8787 --db .dev/nd.db &
//   node scripts/native-display-check.mjs http://localhost:8787 .dev/nd.db
// What it proves (each line is one named check; any failure fails the job):
//   • the normal Staff → Portfolio → Add workflow: a website that permits Crestmont is verified by the REAL verifier in
//     a real Chromium and becomes "Ready for portfolio publication"; one that refuses framing is never streamed — the
//     editor says, in plain English, what is needed; one that does not answer is reported honestly;
//   • publishing: the verified website publishes through the normal requirements; the refused one cannot be published;
//   • visitors (desktop 1440 and phone 390): the verified websites are the real sites in native iframes (the frame's
//     document is the live origin), they scroll inside the frame while Crestmont's page stays still, and no remote-
//     browser session, WebSocket or stream canvas is ever used; a converted existing entry whose site refuses framing
//     shows an honest notice and its live link;
//   • viewer performance: only the active project's website is loaded, switching viewport sizes never reloads a frame,
//     and at most two websites stay mounted;
//   • visibility protocol: each framed website receives exact-origin {source:"crestmont-portfolio", type:"visibility"}
//     messages — visible when it is the active project, hidden when the visitor switches away or the page is hidden.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { hashPassword, newTotpSecret, totpCode } from "../src/lib/auth-crypto.ts";
import { fixtureResponse } from "./fixtures/remote/sites.mjs";

const [BASE = "http://localhost:8787", DB = ".dev/nd.db"] = process.argv.slice(2);
const pwm = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { chromium, devices } = pwm.chromium ? pwm : pwm.default;
const db = new DatabaseSync(DB);
const results = [];
const check = async (name, fn) => {
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`); }
  catch (e) { results.push({ name, ok: false }); console.log(`FAIL ${name}: ${(e && e.message || String(e)).split("\n").slice(0, 6).join(" | ")}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = new URL(BASE).origin;
const browser = await chromium.launch();
const pw = "Fixture-pass-2026!";
const routeFixtures = (ctx) => ctx.route(/https:\/\/[a-z0-9-]+\.fixture-portfolio\.com\/.*/, (route) => {
  const a = fixtureResponse(route.request().url(), ORIGIN);
  if (!a || a.error) return route.abort();
  return route.fulfill({ status: a.status, headers: a.headers, body: a.body });
});

// ── Staff (TEST DATA): an Owner signs in through the real login page with TOTP ──
const ownerEmail = `owner.nd.${Date.now()}@crestmont.test`, secret = newTotpSecret(), now = new Date().toISOString();
db.exec(`INSERT OR IGNORE INTO organizations (id, name, kind, created_at) VALUES ('org_crestmont','Crestmont Website Development','internal','${now}')`);
db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, totp_secret, mfa_enabled, created_at) VALUES (?,?,?,?,?,?,1,?)`).run("usr_nd_owner", ownerEmail, "ND Owner", await hashPassword(pw), now, secret, now);
db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?,?,?)`).run("mbr_nd_owner", "usr_nd_owner", "org_crestmont", "owner", now);
const staffCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
await routeFixtures(staffCtx);
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
  await staff.fill('input[name="name"]', `ND ${name}`);
  await staff.fill('input[name="slug"]', `nd-${name}`);
  await staff.fill('input[name="industry"]', "Testing (TEST DATA)");
  if (!(await staff.inputValue('textarea[name="description"]'))) await staff.fill('textarea[name="description"]', "TEST DATA fixture site.");
  await Promise.all([staff.waitForNavigation({ timeout: 180000 }), staff.getByRole("button", { name: /create project/i }).click()]);
  const m = /\/staff\/portfolio\/([^/?#]+)$/.exec(new URL(staff.url()).pathname);
  assert.ok(m, `editor opened for ${name} (${staff.url()})`);
  projectId[name] = m[1];
  const card = staff.locator('[data-testid="pf-native"]');
  return { state: await card.getAttribute("data-native-state"), stage: Number(await card.getAttribute("data-owner-stage")), owner: await staff.locator('[data-testid="pf-native-owner"]').innerText(), action: await staff.locator('[data-testid="pf-native-action"]').count() ? await staff.locator('[data-testid="pf-native-action"]').innerText() : "" };
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
  return db.prepare("SELECT published FROM portfolio_projects WHERE id = ?").get(projectId[name]).published;
}

// ── 1. The normal Add workflow ──
for (const name of ["allowed", "allowed2"]) {
  await check(`add ${name}: the real verifier runs in Chromium → Ready for portfolio publication`, async () => {
    const r = await addProject(name);
    assert.equal(r.state, "native_verified", r.owner);
    assert.equal(r.stage, 4);
    assert.match(r.owner, /verified in Crestmont's native frame/);
    const dev = await staff.locator('[data-testid="pf-native-developer"]').textContent();
    assert.match(dev, /Embedded \(in Crestmont\)/, "direct-vs-embedded performance recorded");
    await staff.waitForSelector('.pfx__slide[data-kind="live"].is-ready iframe', { timeout: 30000 });
  });
}
await check("add fa-none (refuses framing, no hosting connection): never streamed; one plain-English action; cannot be published", async () => {
  const r = await addProject("fa-none");
  assert.notEqual(r.state, "native_verified");
  assert.match(r.owner + " " + r.action, /connect|hosting account/i);
  assert.equal(await staff.locator("canvas.pfx__remote, iframe.pfx__frame").count(), 0, "nothing interactive is claimed");
  assert.equal(await publish("fa-none"), 0, "publishing is refused until the website is verified natively");
});
await check("add unavailable (does not answer): reported honestly, nothing claimed live", async () => {
  const r = await addProject("unavailable");
  assert.notEqual(r.state, "native_verified");
  assert.equal(await staff.locator("canvas.pfx__remote, iframe.pfx__frame").count(), 0);
});
await check("publish the verified websites through the normal requirements (no screenshots needed)", async () => {
  for (const n of ["allowed", "allowed2"]) assert.equal(await publish(n), 1, n);
});
// A converted existing entry (migration 0111) whose site refuses framing: published, shown honestly.
db.prepare("UPDATE portfolio_projects SET published = 1, native_migrated_at = ? WHERE id = ?").run(new Date().toISOString(), projectId["fa-none"]);
await staff.goto(BASE + "/staff/portfolio");

// ── 2. Visitors ──
const remoteTraffic = (page) => { const seen = []; page.on("websocket", (ws) => seen.push(ws.url())); page.on("request", (r) => { if (/remote-sessions/.test(r.url())) seen.push(r.url()); }); return seen; };
async function visitorContext(opts) {
  const c = await browser.newContext(opts);
  await routeFixtures(c);
  // Records every visibility message a framed website receives (all frames, including cross-origin ones).
  await c.addInitScript(() => { window.__vis = []; addEventListener("message", (e) => { if (e.data && e.data.source === "crestmont-portfolio") window.__vis.push({ origin: e.origin, visible: e.data.visible }); }); });
  return c;
}
const frameOf = (page, host) => page.frames().find((f) => f.url().startsWith(`https://${host}/`));
for (const [label, opts] of [["desktop", { viewport: { width: 1440, height: 900 } }], ["phone", { ...devices["Pixel 7"] }]]) {
  await check(`${label}: the verified website is the real site in a native frame; it scrolls inside while Crestmont stays still; no stream`, async () => {
    const c = await visitorContext(opts), p = await c.newPage(), traffic = remoteTraffic(p);
    await p.goto(`${BASE}/portfolio/nd-allowed`);
    const slide = p.locator('.pfx__slide[data-kind="live"]').first();
    await slide.scrollIntoViewIfNeeded();
    await p.waitForSelector('.pfx__slide[data-kind="live"].is-ready iframe', { timeout: 30000 });
    let f = null; for (let k = 0; k < 40 && !(f = frameOf(p, "allowed.fixture-portfolio.com")); k++) await sleep(250);
    assert.ok(f, "the frame's document is the live origin");
    const box = await p.locator(".pfx__slide.is-ready iframe").first().boundingBox();
    const y0 = await p.evaluate(() => Math.round(scrollY)), i0 = await f.evaluate(() => Math.round(scrollY));
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    if (label === "desktop") await p.mouse.wheel(0, 600); else await f.evaluate(() => scrollBy(0, 600));
    await sleep(800);
    const y1 = await p.evaluate(() => Math.round(scrollY)), i1 = await f.evaluate(() => Math.round(scrollY));
    assert.ok(i1 > i0, `the site scrolled (${i0} → ${i1})`);
    if (label === "desktop") assert.equal(y1, y0, "Crestmont's page stayed still");
    assert.equal(await p.locator("canvas.pfx__remote").count(), 0);
    assert.deepEqual(traffic, [], "no remote-browser request or WebSocket");
    await c.close();
  });
}
await check("a converted existing entry whose site refuses framing: honest notice and live link on every public surface, never streamed", async () => {
  const c = await visitorContext({ viewport: { width: 1280, height: 900 } }), p = await c.newPage(), traffic = remoteTraffic(p);
  for (const path of ["/portfolio/nd-fa-none", "/portfolio", "/"]) {
    await p.goto(BASE + path);
    const s = p.locator("#pfx-nd-fa-none");
    if (!(await s.count())) continue;
    assert.equal(await s.getAttribute("data-kind"), "shot", path);
    assert.match(await s.locator("[data-pfx-status]").innerText(), /can't be shown here right now — please visit it directly/, path);
    assert.equal(await s.locator('a.pfx__link--live[href="https://fa-none.fixture-portfolio.com/"]').count(), 1, path);
  }
  assert.deepEqual(traffic, []);
  await c.close();
});

// ── 3. Viewer performance and the visibility protocol (the /portfolio explorer, several projects) ──
await check("viewer: only the active website loads; viewport switches never reload it; at most two stay mounted; visibility messages follow the active project", async () => {
  const c = await visitorContext({ viewport: { width: 1440, height: 900 } }), p = await c.newPage();
  const loads = {}; p.on("request", (r) => { const h = new URL(r.url()).hostname; if (r.resourceType() === "document" && h.endsWith(".fixture-portfolio.com")) loads[h] = (loads[h] ?? 0) + 1; });
  await p.goto(BASE + "/portfolio");
  const root = p.locator("[data-pfx]").first();
  await root.scrollIntoViewIfNeeded();
  const go = async (slug) => { await p.locator(`[data-pfx-go]`).nth(await p.locator("[data-pfx-slide]").evaluateAll((els, s) => els.findIndex((e) => e.id === `pfx-${s}`), slug)).click(); await sleep(1500); };
  await go("nd-allowed");
  await p.waitForSelector("#pfx-nd-allowed.is-ready iframe", { timeout: 30000 });
  assert.equal(await p.locator("iframe.pfx__frame").count(), 1, "only the active project's website is loaded");
  for (const m of ["tablet", "mobile", "desktop"]) { await p.click(`[data-pfx-mode="${m}"]`); await sleep(300); }
  assert.equal(loads["allowed.fixture-portfolio.com"], 1, "switching viewport sizes did not reload the website");
  let f = null; for (let k = 0; k < 40 && !(f = frameOf(p, "allowed.fixture-portfolio.com")); k++) await sleep(250);
  const v1 = await f.evaluate(() => window.__vis.slice());
  assert.ok(v1.length && v1.every((x) => x.origin === ORIGIN) && v1.at(-1).visible === true, `visible message from Crestmont's origin: ${JSON.stringify(v1)}`);
  await go("nd-allowed2");
  await p.waitForSelector("#pfx-nd-allowed2.is-ready iframe", { timeout: 30000 });
  const v2 = await f.evaluate(() => window.__vis.slice());
  assert.equal(v2.at(-1).visible, false, "the website the visitor left is told it is hidden");
  assert.ok(await p.locator("iframe.pfx__frame").count() <= 2, "at most two websites mounted");
  await c.close();
});

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} of ${results.length} native-first display check(s) failed` : `native-first portfolio display verified (${results.length} checks)`);
process.exit(failed ? 1 : 0);
