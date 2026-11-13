// Live interactive portfolio check (Owner, 2026-11-13): on the given site (production after a deploy), in a real
// Chromium at desktop and phone sizes, every published project on /portfolio must show its INTERACTIVE demo (not the
// screenshot), and each demo must scroll inside its frame without moving Crestmont's page, navigate internally,
// reset and switch devices (scripts/preview-explorer-checks.mjs: the same checks the staging deploy runs). The demos
// are the isolated portfolio-demo Workers; no simulated transaction is run here. Exit 1 on any failure.
//   PLAYWRIGHT_MODULE=… node scripts/live-portfolio-check.mjs <https-origin> [expected-count]
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = pw.chromium ? pw : pw.default;
const { checkLocation, checkInteractive } = await import("./preview-explorer-checks.mjs");
const base = (process.argv[2] ?? "").replace(/\/$/, "");
const expected = Number(process.argv[3] ?? 4);
if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(base)) { console.error("usage: live-portfolio-check.mjs <https-origin> [count]"); process.exit(2); }
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failed++; };
const b = await chromium.launch();
for (const [name, viewport, mobile] of [["desktop", { width: 1440, height: 900 }, false], ["phone", { width: 390, height: 844 }, true]]) {
  const ctx = await b.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  try {
    const states = await checkLocation(p, base, "/portfolio", name, ok);
    const names = Object.keys(states);
    ok(names.length === expected, `${name}: ${names.length} published projects on /portfolio (${names.join(", ")})`);
    for (const [n, s] of Object.entries(states)) ok(s === "interactive", `${name} · ${n}: the INTERACTIVE demo is shown (state ${s}), not the screenshot`);
    await p.goto(base + "/portfolio", { waitUntil: "domcontentloaded" }); await p.locator(".pfx").scrollIntoViewIfNeeded();
    const count = await p.locator(".pfx__slide").count();
    for (let i = 0; i < count; i++) {
      if (i) { await p.locator("[data-pfx-next]").first().click(); await p.waitForTimeout(700); }
      for (let k = 0; k < 80; k++) { if (await p.evaluate(() => { const s = document.querySelector(".pfx__slide:not([inert])"); return s.classList.contains("is-ready") || s.dataset.unavailable === "true" || !s.dataset.demoUrl; })) break; await p.waitForTimeout(400); }
      if (!(await p.evaluate(() => document.querySelector(".pfx__slide:not([inert])").classList.contains("is-ready")))) continue;
      try { await checkInteractive(p, `${name} /portfolio`, ok, { touch: mobile }); } catch (e) { ok(false, `${name} demo ${i + 1}: ${String(e.message).split("\n")[0].slice(0, 200)}`); }
      // An "open the live website" link is offered next to each demo.
      const live = await p.locator(".pfx__slide:not([inert]) a[href^='https://']:not([href*='portfolio-demo'])").count();
      ok(live > 0, `${name} demo ${i + 1}: an "open the live website" link is offered`);
    }
  } catch (e) { ok(false, `${name}: ${String(e.message).split("\n")[0].slice(0, 200)}`); }
  await ctx.close();
}
await b.close();
console.log(failed ? `${failed} portfolio check(s) failed` : `interactive portfolio verified on ${base} (desktop and phone)`);
process.exit(failed ? 1 : 0);
