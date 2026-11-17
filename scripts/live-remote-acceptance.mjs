// Production acceptance of the automatic display system on REAL websites (Owner, 2026-11-16), run by
// deploy-production.yml (verify-live-portfolio) with the intake result of the deploy job
// (POST /api/ops/portfolio-intake: slug, mode, reason and a one-hour view-only preview link per website).
//   PLAYWRIGHT_MODULE=… node scripts/live-remote-acceptance.mjs https://crestmontwebsitedevelopment.com intake.json
// Nothing on the destination websites is changed and nothing is submitted to them: the remote browser refuses writes,
// and this script only scrolls, clicks same-site links and switches devices.
//   • every website's mode follows its own headers: allowed → embed (A), refused → remote (B), no answer / bot check →
//     unavailable (C) — and at least one refused website is checked through the remote browser;
//   • Mode B, desktop: live picture, wheel scrolling moves the remote page and not Crestmont's, a same-site link is
//     followed (found by loading the same website at the same viewport), Back, Reload, device switching (1440 / 820 / 390);
//     the remote browser's own policy refuses /login, /owner, /admin, /checkout, /account and another website;
//   • Mode B, Android phone (Pixel 7), iPhone-sized (iPhone 13 viewport) and tablet (iPad Mini) — Chromium emulation with
//     touch, NOT Safari: the phone/tablet layout, touch scrolling moves the remote page and not Crestmont's;
//   • several visitors at once up to the production limit, the next one told honestly; closed sessions cleaned up;
//     an idle session ends on its own and Resume recovers;
//   • Mode A: the real site in the frame; Mode C: an honest notice, nothing claimed interactive.
import { readFileSync } from "node:fs";

const [BASE, FILE] = process.argv.slice(2);
if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(BASE ?? "") || !FILE) { console.error("usage: live-remote-acceptance.mjs <https-origin> <intake.json>"); process.exit(2); }
const intake = JSON.parse(readFileSync(FILE, "utf8"));
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { chromium, devices } = pw.chromium ? pw : pw.default;
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failed++; return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, every = 250) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(every); } return v; }
const status = async () => (await (await fetch(`${BASE}/api/portfolio/remote-sessions/status`, { headers: { "cache-control": "no-cache" } })).json());
const run = async (name, fn) => { try { await fn(); } catch (e) { ok(false, `${name}: ${String(e && e.message || e).split("\n")[0].slice(0, 240)}`); } };

const rb = intake.remoteBrowser ?? {};
console.log(`COST remote browser ${rb.enabled ? "on" : "OFF"}: at most ${rb.maxConcurrent} concurrent sessions and ${rb.dailyMinutes} browser-minutes a day (inside the Workers Paid allowance)`);
const expectMode = (st) => (st === "allowed" ? "embed" : st === "blocked" ? (rb.enabled ? "remote" : "unavailable") : "unavailable");
for (const r of intake.results) {
  console.log(`MODE ${r.url} → ${r.mode} (check: ${r.status}) — ${r.reason}`);
  ok(r.mode === expectMode(r.status), `${r.url}: the selected mode (${r.mode}) follows the site's own answer (${r.status})`);
  ok(!!r.preview, `${r.url}: a view-only preview link was issued`);
}
const remote = intake.results.filter((r) => r.mode === "remote");
ok(remote.length > 0, `at least one website that refuses framing is shown through the remote browser (${remote.map((r) => r.slug).join(", ") || "none"})`);

const b = await chromium.launch();
const sel = (slug) => `.pfx__slide[data-remote-slug="${slug}"]`;
const outerY = (p) => p.evaluate(() => Math.round(scrollY));
async function openPreview(ctx, r) {
  const p = await ctx.newPage();
  await p.goto(`${BASE}/portfolio/preview/${r.preview}`, { waitUntil: "domcontentloaded" });
  await p.locator(".pfx").first().scrollIntoViewIfNeeded();
  return p;
}
const isLive = (p, slug, ms = 45000) => p.waitForSelector(`${sel(slug)}[data-remote-state="live"].is-ready`, { timeout: ms }).then(() => true, () => false);
const canvasInfo = (p, slug) => p.locator(`${sel(slug)} canvas.pfx__remote`).evaluate((c) => {
  const g = c.getContext("2d"), d = g.getImageData(0, 0, c.width, c.height).data;
  // "lit" = samples that differ from the first one: a real picture has contrast even on a dark design; a blank canvas
  // (nothing drawn) has none. (Counting bright samples failed on Get Every Invoice Paid's dark first screen.)
  let h = 0, lit = 0; const b0 = d[0] + d[1] + d[2];
  for (let i = 0; i < d.length; i += 4 * 97) { h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) >>> 0; if (Math.abs(d[i] + d[i + 1] + d[i + 2] - b0) > 30) lit++; }
  return { w: c.width, h: c.height, hash: h, lit };
});
async function aim(p, slug, x, y) {
  const c = p.locator(`${sel(slug)} canvas.pfx__remote`);
  const box = await c.boundingBox(); const ci = await canvasInfo(p, slug);
  return { x: box.x + (x / ci.w) * box.width, y: box.y + (y / ci.h) * box.height };
}
const urlLabel = (p, slug) => p.locator(`${sel(slug)} [data-pfx-url]`).innerText();
/** A visible same-site link in the first screen of the real website at this viewport (loaded directly, read-only). */
async function findLink(url, w, h, mobile) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  try {
    await p.goto(url, { waitUntil: "load", timeout: 45000 }); await sleep(1500);
    return await p.evaluate(({ h }) => {
      const here = new URL(location.href), site = here.hostname.replace(/^www\./, "");
      const bad = /(^|\/)(login|log-in|signin|sign-in|signup|sign-up|register|account|admin|owner|dashboard|portal|billing|checkout|cart|pay|payment|api|download|upload)(\/|$|\.)/i;
      for (const a of document.querySelectorAll("a[href]")) {
        let u; try { u = new URL(a.href); } catch { continue; }
        if (u.protocol !== "https:" || !(u.hostname === site || u.hostname.endsWith("." + site)) || u.pathname === here.pathname || bad.test(u.pathname) || a.hasAttribute("download") || (a.target && a.target !== "_self")) continue;
        const r = a.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || r.top < 2 || r.bottom > h - 2 || r.left < 0 || r.right > innerWidth) continue;
        const x = r.left + r.width / 2, y = r.top + r.height / 2, top = document.elementFromPoint(x, y);
        if (!top || !(a === top || a.contains(top))) continue;
        return { x: Math.round(x), y: Math.round(y), path: u.pathname, text: (a.textContent || "").trim().slice(0, 40) };
      }
      return null;
    }, { h });
  } catch { return null; } finally { await ctx.close(); }
}

for (const r of intake.results) {
  const slug = r.slug;
  if (r.mode === "embed") {
    await run(`${slug} (Mode A)`, async () => {
      const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
      const p = await ctx.newPage();
      await p.goto(`${BASE}/portfolio/preview/${r.preview}`, { waitUntil: "domcontentloaded" });
      await p.locator(".pfx").first().scrollIntoViewIfNeeded();
      const st = await until(() => p.evaluate(() => { const s = document.querySelector(".pfx__slide"); return s.classList.contains("is-ready") ? `${s.dataset.kind}:ready` : s.dataset.unavailable ? "unavailable" : ""; }), 30000);
      ok(st === "live:ready", `${slug} (Mode A): the real website is shown in the native frame (${st || "not loaded"})`);
      await ctx.close();
    });
    continue;
  }
  if (r.mode === "unavailable") {
    await run(`${slug} (Mode C)`, async () => {
      const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
      const p = await ctx.newPage();
      await p.goto(`${BASE}/portfolio/preview/${r.preview}`, { waitUntil: "domcontentloaded" });
      const s = await p.evaluate(() => { const x = document.querySelector(".pfx__slide"); return { kind: x.dataset.kind, flag: x.querySelector("[data-pfx-flag]").textContent, canvas: !!x.querySelector("canvas"), iframe: !!x.querySelector("iframe") }; });
      ok(s.kind === "shot" && !s.canvas && !s.iframe && !/live/i.test(s.flag), `${slug} (Mode C): an honest fallback — nothing presented as live (${JSON.stringify(s)})`);
      ok(await p.locator(".pfx__link--live[href^='https://']").count() > 0, `${slug} (Mode C): the Visit live website link is offered`);
      await ctx.close();
    });
    continue;
  }

  // ── Mode B: desktop ──
  await run(`${slug} desktop`, async () => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const p = await openPreview(ctx, r);
    if (!ok(await isLive(p, slug), `${slug} desktop: the live website is shown through the remote browser`)) { console.log(`  status: ${await p.locator(`${sel(slug)} [data-pfx-status]`).innerText().catch(() => "")}`); await ctx.close(); return; }
    let ci = await canvasInfo(p, slug);
    ok(ci.w === 1440 && ci.lit > 50, `${slug} desktop: rendered at 1440 px (${ci.w}×${ci.h}, ${ci.lit} samples with contrast)`);
    ok(/remote view/i.test(await p.locator(`${sel(slug)} [data-pfx-flag]`).innerText()), `${slug} desktop: labelled "Live website · remote view"`);
    // Scrolling: the remote page moves; Crestmont's page does not.
    const y0 = await outerY(p), before = ci.hash;
    const mid = await aim(p, slug, 720, Math.round(ci.h / 2));
    await p.mouse.move(mid.x, mid.y);
    for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, 450); await sleep(120); }
    const moved = await until(async () => (await canvasInfo(p, slug)).hash !== before, 8000);
    ok(moved, `${slug} desktop: wheel scrolling moves the remote website`);
    ok((await outerY(p)) === y0, `${slug} desktop: Crestmont's page stayed still while scrolling inside`);
    for (let i = 0; i < 8; i++) { await p.mouse.wheel(0, -900); await sleep(60); }
    ok((await outerY(p)) === y0, `${slug} desktop: Crestmont's page stayed still at the top edge`);
    await sleep(800);
    // Navigation through a real same-site link at the same viewport.
    const link = await findLink(r.url, ci.w, ci.h, false);
    if (link) {
      const at = await aim(p, slug, link.x, link.y);
      await p.mouse.click(at.x, at.y);
      const went = await until(async () => (await urlLabel(p, slug)).includes(link.path.replace(/\/$/, "")) && link.path !== "/", 15000);
      ok(!!went, `${slug} desktop: clicking "${link.text}" opened ${link.path} inside the remote browser (URL bar: ${await urlLabel(p, slug)})`);
      await p.click("[data-pfx-back]");
      const back = await until(async () => !(await urlLabel(p, slug)).includes(link.path.replace(/\/$/, "")), 15000);
      ok(!!back, `${slug} desktop: Back returned to the previous page`);
    } else console.log(`SKIP ${slug} desktop: no visible same-site link in the first screen to click (navigation is still checked by the policy probe below)`);
    // Reload, then device switching.
    await p.click("[data-pfx-reset]");
    ok(!!(await until(async () => !(await urlLabel(p, slug)).includes("/") || /^[^/]+\/?$/.test(await urlLabel(p, slug)), 10000)), `${slug} desktop: Reload returned to the home page`);
    for (const [m, w] of [["mobile", 390], ["tablet", 820], ["desktop", 1440]]) {
      await p.click(`[data-pfx-mode="${m}"]`);
      const got = await until(async () => (await canvasInfo(p, slug)).w === w, 15000);
      ok(!!got, `${slug}: device switch to ${m} renders at ${w} px`);
    }
    await ctx.close();
  });

  // The policy and the phone/tablet viewer do not depend on the website: checked once (the first Mode B site), which
  // keeps the release check inside a few minutes of the daily browser budget.
  if (r !== remote[0]) continue;
  // ── Mode B: the production policy on this real website (refused private routes and another website) ──
  await run(`${slug} policy`, async () => {
    const ctx = await b.newContext();
    const p = await ctx.newPage();
    await p.goto(`${BASE}/portfolio/preview/${r.preview}`, { waitUntil: "domcontentloaded" });
    const res = await p.evaluate(async ({ slug, preview }) => {
      const s = await (await fetch("/api/portfolio/remote-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, preview }) })).json();
      if (!s.ws) return { error: s.code || "no session" };
      const ws = new WebSocket(`wss://${location.host}${s.ws}&device=desktop&h=800`);
      const seen = { ready: false, blocked: [], urls: [] };
      ws.onmessage = (e) => { if (typeof e.data !== "string") return; const m = JSON.parse(e.data); if (m.t === "ready") seen.ready = true; if (m.t === "blocked") seen.blocked.push(m.title); if (m.t === "url") seen.urls.push(m.href); };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 60 && !seen.ready; i++) await wait(500);
      const probes = ["/login", "/owner", "/admin", "/checkout", "/account", "//example.com/"];
      for (const path of probes) { const n = seen.blocked.length; ws.send(JSON.stringify({ t: "nav", a: "path", path })); for (let i = 0; i < 60 && seen.blocked.length === n; i++) await wait(250); }
      ws.close();
      return { ready: seen.ready, blocked: seen.blocked.length, probes: probes.length, titles: [...new Set(seen.blocked)] };
    }, { slug, preview: r.preview });
    ok(res.ready && res.blocked === res.probes, `${slug}: /login, /owner, /admin, /checkout, /account and another website are refused by the remote browser (${JSON.stringify(res)})`);
    await ctx.close();
  });

  // ── Mode B: phones and tablet (Chromium emulation with touch — NOT Safari) ──
  for (const [label, dev, w] of [["Android phone (Pixel 7)", "Pixel 7", 390], ["iPhone-sized (iPhone 13 viewport)", "iPhone 13", 390], ["tablet (iPad Mini viewport)", "iPad Mini", 820]]) {
    await run(`${slug} ${label}`, async () => {
      const opts = { ...devices[dev] }; delete opts.defaultBrowserType;
      const ctx = await b.newContext(opts);
      const p = await openPreview(ctx, r);
      if (!ok(await isLive(p, slug), `${slug} ${label}: live through the remote browser`)) { await ctx.close(); return; }
      const ci = await until(async () => { const c = await canvasInfo(p, slug); return c.w === w ? c : null; }, 15000);
      ok(!!ci, `${slug} ${label}: rendered at ${w} px`);
      const y0 = await outerY(p), before = (await canvasInfo(p, slug)).hash;
      const cdp = await ctx.newCDPSession(p);
      // Within the part of the canvas that is on screen (on a phone it can be taller than the viewport).
      const vis = await p.locator(`${sel(slug)} canvas.pfx__remote`).evaluate((c) => { const r = c.getBoundingClientRect(); return { top: Math.max(r.top, 0), bottom: Math.min(r.bottom, innerHeight), x: r.left + r.width / 2 }; });
      const from = { x: vis.x, y: vis.top + (vis.bottom - vis.top) * 0.8 }, to = { x: vis.x, y: vis.top + (vis.bottom - vis.top) * 0.25 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
      for (let i = 1; i <= 10; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x, y: from.y + ((to.y - from.y) * i) / 10 }] }); await sleep(16); }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      ok(!!(await until(async () => (await canvasInfo(p, slug)).hash !== before, 8000)), `${slug} ${label}: touch scrolling moves the remote website`);
      ok((await outerY(p)) === y0, `${slug} ${label}: Crestmont's page stayed still`);
      await ctx.close();
    });
  }
}

// ── Several visitors, the limit, cleanup, idle timeout and Resume (one Mode B website) ──
if (remote.length && rb.enabled) {
  const r = remote[0], slug = r.slug, max = rb.maxConcurrent ?? 3;
  await run("concurrency", async () => {
    await until(async () => (await status()).active === 0, 30000);
    const ctxs = [], pages = [];
    for (let i = 0; i < max; i++) { const c = await b.newContext({ viewport: { width: 1280, height: 860 } }); ctxs.push(c); pages.push(await openPreview(c, r)); }
    const lives = await Promise.all(pages.map((p) => isLive(p, slug)));
    ok(lives.every(Boolean), `${max} visitors at once are each shown the live website in their own session (${lives.join(", ")})`);
    ok((await status()).active === max, `the production limit is reached at ${max} live sessions`);
    const extra = await b.newContext({ viewport: { width: 1280, height: 860 } });
    const p4 = await openPreview(extra, r);
    const told = await p4.waitForSelector(`${sel(slug)}[data-remote-state="unavailable"]`, { timeout: 30000 }).then(() => true, () => false);
    ok(told && /in use/i.test(await p4.locator(`${sel(slug)} [data-pfx-status]`).innerText()), `visitor ${max + 1} is told all viewers are in use (not shown as live)`);
    await ctxs[0].close();
    const freed = await until(async () => (await status()).active === max - 1, 20000);
    ok(!!freed, "a closed visitor's session is ended and its browser released");
    await p4.click(`${sel(slug)} [data-pfx-resume]`);
    ok(await isLive(p4, slug), `visitor ${max + 1} gets in with Try again once a viewer is free`);
    for (const c of [...ctxs.slice(1), extra]) await c.close();
    ok(!!(await until(async () => (await status()).active === 0, 30000)), "every closed visitor's session is cleaned up");
  });
  // The idle timeout (90 s on production) is verified in CI with a 20 s setting (scripts/remote-browser-check.mjs);
  // here it would cost two browser-minutes of the visitors' daily budget for every release.
}

await b.close();
const s = await status().catch(() => null);
if (s) console.log(`COST used today: ${s.minutesToday} of ${s.dailyMinutes} browser-minutes; ${s.active} live sessions now`);
console.log(failed ? `${failed} display-mode check(s) failed` : `display modes and the remote browser verified on ${BASE}`);
process.exit(failed ? 1 : 0);
