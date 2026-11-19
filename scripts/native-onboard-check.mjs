// Independent browser check of a native onboarding result (Owner, 2026-11-19): opens the entry's one-hour preview page
// on production at desktop and phone size and confirms, from the visitor's side, that Crestmont shows the REAL website
// in its native iframe — the frame's document is the live origin, real content is visible, the site scrolls inside the
// frame while Crestmont's page stays still, animation frames run — and that the remote browser is not used. It also
// reads the site's protected pages' headers (still refusing framing). Read-only; nothing is submitted.
//   PLAYWRIGHT_MODULE=… node scripts/native-onboard-check.mjs <preview-url> <live-url>
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = pw.chromium ? pw : pw.default;
const [preview, live] = process.argv.slice(2);
const origin = new URL(live).origin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) failed++; };
const b = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
for (const [label, opts] of [["desktop", { viewport: { width: 1440, height: 900 } }], ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
  const ctx = await b.newContext(opts), p = await ctx.newPage();
  const remote = [];
  p.on("websocket", (ws) => remote.push(ws.url()));
  await p.goto(preview, { waitUntil: "domcontentloaded" });
  await p.locator(".pfx").first().scrollIntoViewIfNeeded();
  const slide = await p.waitForSelector(".pfx__slide.is-ready", { timeout: 45_000 }).then(() => p.evaluate(() => { const s = document.querySelector(".pfx__slide"); return { kind: s.dataset.kind, frame: s.dataset.frameUrl ?? "", flag: s.querySelector("[data-pfx-flag]")?.textContent.trim() }; }), () => null);
  ok(!!slide && slide.kind === "live" && slide.frame.startsWith(origin), `${label}: Crestmont shows the real website natively (${slide ? `${slide.kind} ${slide.frame} — "${slide.flag}"` : "not ready"})`);
  let f = null;
  for (let k = 0; k < 60 && !(f = p.frames().find((x) => x.url().startsWith(origin))); k++) await sleep(250);
  ok(!!f, `${label}: the frame's document is ${origin}`);
  if (f) {
    await f.waitForLoadState("load").catch(() => {}); await sleep(2000);
    const m = await f.evaluate(() => new Promise((res) => { let n = 0; const t = performance.now(); const g = () => { n++; if (performance.now() - t < 1000) requestAnimationFrame(g); else res({ fps: n, text: (document.body?.innerText || "").replace(/\s+/g, " ").trim().length, title: document.title, overflow: document.documentElement.scrollWidth - innerWidth }); }; requestAnimationFrame(g); }));
    ok(m.text > 40, `${label}: real content visible (${m.text} characters, "${m.title}")`);
    ok(m.fps >= 5, `${label}: animation frames run in the frame (${m.fps}/s)`);
    ok(m.overflow <= 24, `${label}: responsive — ${m.overflow > 0 ? `${m.overflow}px wider than its frame` : "no sideways overflow"}`);
    const el = p.locator(".pfx__slide iframe.pfx__frame").first();
    await el.evaluate((e) => e.scrollIntoView({ block: "center" })); await sleep(300);
    const box = await el.boundingBox(), y0 = await p.evaluate(() => scrollY);
    const pos = () => f.evaluate(() => Math.round(scrollY) + [...document.querySelectorAll("body *")].reduce((a, e) => a + e.scrollTop, 0));
    const i0 = await pos();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.wheel(0, 500); await sleep(800);
    const i1 = await pos(), y1 = await p.evaluate(() => scrollY);
    const room = await f.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    ok(room <= 0 || (i1 > i0 && y1 === y0), `${label}: the site scrolls inside the frame (${i0} → ${i1}px) while Crestmont stays still (${y0} → ${y1}px)`);
  }
  ok(!remote.some((u) => /remote-sessions/.test(u)) && !(await p.locator("canvas.pfx__remote").count()), `${label}: no remote-browser stream is used`);
  await ctx.close();
}
await b.close();
// Protected pages: read their own headers (a visitor's GET), never load them in a frame.
for (const path of ["/login", "/account", "/admin", "/checkout"]) {
  try {
    const r = await fetch(new URL(path, live), { redirect: "manual" });
    if (r.status >= 400 || (r.status >= 300 && r.status < 400)) { console.log(`INFO ${path}: HTTP ${r.status}`); continue; }
    const csp = r.headers.get("content-security-policy") ?? "", xfo = r.headers.get("x-frame-options") ?? "";
    const fa = csp.split(",").flatMap((p) => p.split(";").map((d) => d.trim()).filter((d) => d.startsWith("frame-ancestors")));
    const refuses = fa.length ? fa.every((d) => !/crestmontwebsitedevelopment\.com|\*/.test(d)) : /deny|sameorigin/i.test(xfo);
    ok(refuses, `protected ${path} still refuses framing (${fa.join("; ") || `X-Frame-Options ${xfo || "none"}`})`);
  } catch (e) { console.log(`INFO ${path}: ${e.message}`); }
}
console.log(failed ? `${failed} native onboarding check(s) failed` : `native onboarding verified for ${live}`);
process.exit(failed ? 1 : 0);
