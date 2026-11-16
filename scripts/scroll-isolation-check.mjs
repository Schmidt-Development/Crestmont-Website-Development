// Scroll isolation of the portfolio explorer (Owner, 2026-11-16): for ANY embedded website, a scroll gesture inside
// the frame — wheel on desktop, touch swipes and fast flings on phones and tablets — moves only the embedded site, also
// when it continues past the site's top or bottom; Crestmont's page stays exactly where it was. Scrolling outside the
// frame still scrolls the page. Run against a Crestmont origin whose portfolio frames the fixture sites below (they are
// served by this script through Playwright request routing, so nothing external is contacted):
//   PLAYWRIGHT_MODULE=… node scripts/scroll-isolation-check.mjs http://localhost:8787 slug-a,slug-b,…
// Each slug's live_url host is answered with the fixture named by the first label of its host
// (e.g. https://plain-long.fixture-portfolio.com/ → scripts/fixtures/scroll/plain-long.html).
import { readFileSync, existsSync } from "node:fs";
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = pw.chromium ? pw : pw.default;
const base = (process.argv[2] ?? "").replace(/\/$/, "");
const slugs = (process.argv[3] ?? "").split(",").filter(Boolean);
const extraFixtureDir = process.env.FIXTURE_DIR; // optional: a directory served for leadhavencollective.com (the real page)
const VIEWPORTS = [
  ["iPhone 13 (390×844)", { width: 390, height: 844 }, true],
  ["Android small (360×740)", { width: 360, height: 740 }, true],
  ["Android large (412×915)", { width: 412, height: 915 }, true],
  ["iPad (820×1180)", { width: 820, height: 1180 }, true],
  ["desktop (1440×900)", { width: 1440, height: 900 }, false],
];
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();
for (const [label, viewport, touch] of VIEWPORTS) {
  const ctx = await b.newContext({ viewport, isMobile: touch && viewport.width < 800, hasTouch: touch, deviceScaleFactor: 1 });
  await ctx.route(/^https:\/\/[a-z0-9-]+\.fixture-portfolio\.com\//, (r) => {
    const name = new URL(r.request().url()).hostname.split(".")[0];
    const f = new URL(`./fixtures/scroll/${name}.html`, import.meta.url);
    if (!existsSync(f)) return r.fulfill({ status: 404, body: "" });
    r.fulfill({ status: 200, headers: { "content-type": "text/html", "content-security-policy": `frame-ancestors ${base}` }, body: readFileSync(f) });
  });
  // The smooth-scroll fixture loads Lenis from unpkg; LENIS_FILE serves a local copy of that exact release.
  if (process.env.LENIS_FILE) await ctx.route("https://unpkg.com/lenis@1.3.23/dist/lenis.mjs", (r) => r.fulfill({ status: 200, headers: { "content-type": "text/javascript", "access-control-allow-origin": "*" }, body: readFileSync(process.env.LENIS_FILE) }));
  if (extraFixtureDir) await ctx.route("https://leadhavencollective.com/**", (r) => {
    const u = new URL(r.request().url()); const p = u.pathname.endsWith("/") ? u.pathname + "index.html" : u.pathname; const f = extraFixtureDir + p;
    if (!existsSync(f)) return r.fulfill({ status: 404, body: "" });
    r.fulfill({ status: 200, headers: { "content-type": p.endsWith(".html") ? "text/html" : p.endsWith(".css") ? "text/css" : "text/javascript", "content-security-policy": `frame-ancestors ${base}` }, body: readFileSync(f) });
  });
  for (const slug of slugs) {
    const p = await ctx.newPage();
    const tag = `${label} · ${slug}`;
    try {
      await p.goto(`${base}/portfolio/${slug}`, { waitUntil: "domcontentloaded" });
      await p.locator(".pfx").first().scrollIntoViewIfNeeded();
      for (let k = 0; k < 60 && !(await p.evaluate(() => document.querySelector(".pfx__slide")?.classList.contains("is-ready"))); k++) await sleep(300);
      const origin = await p.evaluate(() => document.querySelector(".pfx__slide")?.dataset.frameOrigin);
      const fr = p.frames().find((f) => origin && f.url().startsWith(origin));
      if (!fr) { ok(false, `${tag}: the site did not load in the frame`); await p.close(); continue; }
      const iframe = p.locator(".pfx__slide iframe.pfx__frame").first();
      await iframe.evaluate((el) => el.scrollIntoView({ block: "center" })); await sleep(300);
      const box = await iframe.boundingBox();
      const cx = Math.round(box.x + box.width / 2), cy = Math.round(box.y + box.height / 2);
      const outer = () => p.evaluate(() => Math.round(scrollY));
      const inner = () => fr.evaluate(() => ({ y: Math.round(scrollY), max: Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight)) }));
      const cdp = touch ? await ctx.newCDPSession(p) : null;
      // dy > 0 scrolls the content down. fast: a short flick (fling) instead of a slow drag.
      const gesture = async (dy, { fast = false, x = cx, y = cy } = {}) => {
        if (cdp) {
          const steps = fast ? 3 : 12, dist = Math.min(Math.abs(dy), Math.round(box.height * 0.4)), dir = dy > 0 ? -1 : 1;
          const sy = y - dir * Math.round(dist / 2);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: sy }] });
          for (let k = 1; k <= steps; k++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: Math.round(sy + dir * k * dist / steps) }] }); if (!fast) await sleep(16); }
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } else { await p.mouse.move(x, y); await p.mouse.wheel(0, dy); }
        await sleep(fast ? 450 : 160);
      };
      const y0 = await outer();
      const scrollable = (await inner()).max > 0;
      // 1) A gesture inside the frame scrolls the site, never Crestmont's page.
      const i0 = (await inner()).y;
      await gesture(300);
      ok(!scrollable || (await inner()).y > i0, `${tag}: the site scrolls inside the frame (${i0} → ${(await inner()).y}px)`);
      ok((await outer()) === y0, `${tag}: Crestmont's page stays still while the site scrolls (${y0} → ${await outer()}px)`);
      // 2) At the site's bottom, keep going: slow drags and fast flings past the boundary.
      await fr.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" })); await sleep(200);
      for (let k = 0; k < 3; k++) await gesture(400);
      for (let k = 0; k < 3; k++) await gesture(500, { fast: true });
      ok((await outer()) === y0, `${tag}: still stationary past the site's bottom — drags and flings (${y0} → ${await outer()}px)`);
      // 3) At the site's top, keep going upwards.
      await fr.evaluate(() => scrollTo({ top: 0, behavior: "instant" })); await sleep(200);
      for (let k = 0; k < 3; k++) await gesture(-400);
      for (let k = 0; k < 3; k++) await gesture(-500, { fast: true });
      ok((await outer()) === y0, `${tag}: still stationary past the site's top — drags and flings (${y0} → ${await outer()}px)`);
      // 4) Outside the frame the page scrolls normally (a gesture on the page heading area).
      const head = await p.locator("h1").first().boundingBox();
      const hx = 12, hy = head ? Math.max(70, Math.min(Math.round(head.y + head.height / 2), viewport.height - 10)) : 80;
      await p.evaluate(() => scrollTo(0, 0)); await sleep(300);
      const before = await outer();
      await gesture(400, { x: hx, y: hy }); await sleep(700); // let a smooth page scroll settle
      ok((await outer()) !== before, `${tag}: a gesture outside the frame scrolls Crestmont's page (${before} → ${await outer()}px)`);
      if (cdp) await cdp.detach();
    } catch (e) { ok(false, `${tag}: ${String(e.message).split("\n")[0].slice(0, 160)}`); }
    await p.close();
  }
  await ctx.close();
}
await b.close();
console.log(failed ? `${failed} scroll-isolation check(s) failed` : "scroll isolation verified");
process.exit(failed ? 1 : 0);
