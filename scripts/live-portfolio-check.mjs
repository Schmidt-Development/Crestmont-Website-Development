// Live interactive portfolio check (Owner, 2026-11-13; live websites 2026-11-15): on the given site (production after
// a deploy), in a real Chromium at desktop and phone sizes, every published project on /portfolio must be INTERACTIVE
// (the real live website, or its isolated demo — never only the screenshot), and each must scroll inside its frame
// without moving Crestmont's page, navigate internally, reload/reset and switch devices
// (scripts/preview-explorer-checks.mjs: the same checks the staging deploy runs). --live <slug,…> additionally
// requires those projects to show their REAL live website (data-kind="live") on /portfolio and on their own case
// study. No transaction is run. Exit 1 on any failure.
//   PLAYWRIGHT_MODULE=… node scripts/live-portfolio-check.mjs <https-origin> [expected-count] [--live slug,slug]
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = pw.chromium ? pw : pw.default;
const { checkLocation, checkInteractive } = await import("./preview-explorer-checks.mjs");
const base = (process.argv[2] ?? "").replace(/\/$/, "");
const expected = Number(process.argv[3] ?? 4);
const li = process.argv.indexOf("--live");
const mustBeLive = li > 0 ? (process.argv[li + 1] ?? "").split(",").filter(Boolean) : [];
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
    for (const [n, s] of Object.entries(states)) ok(s === "interactive", `${name} · ${n}: the INTERACTIVE website is shown (state ${s}), not the screenshot`);
    // Projects that must show their REAL live website: on /portfolio and on the case study, the frame is the live origin.
    for (const slug of mustBeLive) {
      await p.goto(`${base}/portfolio/${slug}`, { waitUntil: "domcontentloaded" });
      const res = await p.evaluate(() => { const s = document.querySelector(".pfx__slide"); return s ? { kind: s.dataset.kind, url: s.dataset.frameUrl, live: s.dataset.liveUrl, flag: s.querySelector("[data-pfx-flag]")?.textContent.trim() } : null; });
      ok(!!res && res.kind === "live" && !!res.url && new URL(res.url).origin === new URL(res.live).origin, `${name} /portfolio/${slug}: the REAL live website is framed (${res ? `${res.kind} ${res.url} — flag "${res.flag}"` : "no explorer"})`);
      await p.locator(".pfx").first().scrollIntoViewIfNeeded();
      let st = "loading";
      for (let k = 0; k < 75 && st === "loading"; k++) { st = await p.evaluate(() => { const s = document.querySelector(".pfx__slide"); return s.classList.contains("is-ready") ? "ready" : s.dataset.unavailable === "true" ? "unavailable" : "loading"; }); if (st === "loading") await p.waitForTimeout(400); }
      const fr = res?.url ? p.frames().find((f) => f.url().startsWith(new URL(res.url).origin)) : null;
      const title = fr ? await fr.title().catch(() => "") : "";
      ok(st === "ready" && !!title, `${name} /portfolio/${slug}: the live website loaded inside the frame (state ${st}; page title "${title}")`);
      if (st === "ready") { try { await checkInteractive(p, `${name} /portfolio/${slug}`, ok, { touch: mobile }); } catch (e) { ok(false, `${name} /portfolio/${slug}: ${String(e.message).split("\n")[0].slice(0, 200)}`); } }
    }
    await p.goto(base + "/portfolio", { waitUntil: "domcontentloaded" }); await p.locator(".pfx").scrollIntoViewIfNeeded();
    const count = await p.locator(".pfx__slide").count();
    for (let i = 0; i < count; i++) {
      if (i) { await p.locator("[data-pfx-next]").first().click(); await p.waitForTimeout(700); }
      for (let k = 0; k < 80; k++) { if (await p.evaluate(() => { const s = document.querySelector(".pfx__slide:not([inert])"); return s.classList.contains("is-ready") || s.dataset.unavailable === "true" || !s.dataset.frameUrl; })) break; await p.waitForTimeout(400); }
      if (!(await p.evaluate(() => document.querySelector(".pfx__slide:not([inert])").classList.contains("is-ready")))) continue;
      // A Mode B project (remote browser) has no frame to drive here; scripts/live-remote-acceptance.mjs verifies it.
      if (await p.evaluate(() => document.querySelector(".pfx__slide:not([inert])").dataset.kind === "remote")) { ok(true, `${name} project ${i + 1}: live through the remote browser (interaction verified by live-remote-acceptance)`); continue; }
      try { await checkInteractive(p, `${name} /portfolio`, ok, { touch: mobile }); } catch (e) { ok(false, `${name} demo ${i + 1}: ${String(e.message).split("\n")[0].slice(0, 200)}`); }
      // An "open the live website" link is offered next to each demo.
      const live = await p.locator(".pfx__slide:not([inert]) a.pfx__link--live[href^='https://']").count();
      ok(live > 0, `${name} project ${i + 1}: a "Visit live website" link is offered`);
    }
  } catch (e) { ok(false, `${name}: ${String(e.message).split("\n")[0].slice(0, 200)}`); }
  await ctx.close();
}
await b.close();
console.log(failed ? `${failed} portfolio check(s) failed` : `interactive portfolio verified on ${base} (desktop and phone)`);
process.exit(failed ? 1 : 0);
