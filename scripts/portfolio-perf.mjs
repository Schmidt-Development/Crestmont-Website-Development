// Portfolio remote-browser performance measurement (Owner, 2026-11-16: "MASTER PORTFOLIO PERFORMANCE UPGRADE").
// Read-only, like a visitor: opens the published portfolio entry at a position (default #2) and measures, from the
// visitor's own browser, what a person experiences — without any change to production code (so it measures the
// running release as it is):
//   • start-up: session request, WebSocket open, first frame, first picture drawn;
//   • frames: delivered frames per second, bytes per second, frame sizes, gaps; idle and while animating;
//   • input → visible response: a single wheel scroll, a click on a same-site link, a touch swipe — the time until the
//     canvas actually shows a large change (a 48×27 luminance signature of every drawn frame is compared with the one
//     before the input), and how long frames keep arriving after the input stops ("settle": a backlog of stale frames
//     shows up here as seconds);
//   • visitor cost: image decode and canvas draw times, long tasks, JS heap, CPU time (CDP Performance.getMetrics);
//   • when the server reports them ({t:"stats"}): frames produced / sent / skipped, frame round trip, quality, size.
// It also loads the same website directly (no Crestmont) for comparison: load timing and the native scroll response.
//   PLAYWRIGHT_MODULE=… node scripts/portfolio-perf.mjs https://crestmontwebsitedevelopment.com --position 2 [--slug s]
//     [--devices desktop,pixel,iphone,ipad] [--out perf.json] [--label baseline]
// Sessions used: one per device (well inside the per-visitor limit); about 2–3 browser-minutes in total.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const BASE = (args[0] ?? "").replace(/\/$/, "");
const opt = (k, d) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : d; };
if (!/^https?:\/\/[A-Za-z0-9.:-]+$/.test(BASE)) { console.error("usage: portfolio-perf.mjs <origin> [--position 2] [--slug s] [--devices …] [--out f] [--label l]"); process.exit(2); }
const POSITION = Number(opt("--position", "2"));
const DEVICES = opt("--devices", "desktop,pixel,iphone,ipad").split(",");
const OUT = opt("--out", "portfolio-perf.json");
const LABEL = opt("--label", "measurement");
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { chromium, devices } = pw.chromium ? pw : pw.default;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const p95 = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : null; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// Runs in the visitor's page before Crestmont's scripts: observes, changes nothing the viewer depends on.
const PROBE = `(() => {
  const M = window.__pf = { ws: [], msgs: [], sends: [], decodes: [], draws: [], longtasks: [], stats: [] };
  const N = window.WebSocket;
  function W(url, p) {
    const ws = p === undefined ? new N(url) : new N(url, p);
    const rec = { url: String(url).replace(/token=[0-9a-f]+/, "token=…"), t0: performance.now(), open: null, close: null };
    M.ws.push(rec);
    ws.addEventListener("open", () => { rec.open = performance.now(); });
    ws.addEventListener("close", () => { rec.close = performance.now(); });
    ws.addEventListener("message", (e) => {
      const t = performance.now();
      if (typeof e.data === "string") { let m = null; try { m = JSON.parse(e.data); } catch {} if (m && m.t === "stats") M.stats.push({ t, ...m }); else M.msgs.push({ t, k: "j", m }); }
      else M.msgs.push({ t, k: "b", n: e.data.size ?? e.data.byteLength ?? 0 });
    });
    const send = ws.send.bind(ws);
    ws.send = (d) => { M.sends.push({ t: performance.now(), d: typeof d === "string" ? d.slice(0, 60) : "bin" }); return send(d); };
    return ws;
  }
  W.prototype = N.prototype; W.CONNECTING = 0; W.OPEN = 1; W.CLOSING = 2; W.CLOSED = 3;
  window.WebSocket = W;
  const cib = window.createImageBitmap;
  window.createImageBitmap = function (...a) { const t = performance.now(); return cib.apply(this, a).then((b) => { M.decodes.push({ t, d: performance.now() - t }); return b; }); };
  const small = document.createElement("canvas"); small.width = 48; small.height = 27;
  const sg = small.getContext("2d", { willReadFrequently: true });
  const di = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...a) {
    const t = performance.now();
    const r = di.apply(this, a);
    const c = this.canvas;
    if (c && c.classList && c.classList.contains("pfx__remote")) {
      const d = performance.now() - t;
      di.call(sg, c, 0, 0, 48, 27);
      const px = sg.getImageData(0, 0, 48, 27).data, sig = new Uint8Array(48 * 27);
      for (let i = 0; i < sig.length; i++) sig[i] = (px[i * 4] * 3 + px[i * 4 + 1] * 6 + px[i * 4 + 2]) / 10;
      M.draws.push({ t, d, w: c.width, h: c.height, sig: Array.from(sig) });
    }
    return r;
  };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) M.longtasks.push({ t: e.startTime, d: e.duration }); }).observe({ type: "longtask", buffered: true }); } catch {}
})();`;

// ── Analysis helpers (in Node, over the page's records) ──
const changed = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 24) n++; return n / a.length; };
/** Vertical movement between two 48×27 signatures: the row shift that explains b best, if clearly better than none.
 *  Recognises scrolling on low-contrast pages and ignores animation that changes pixels in place. */
function moved(a, b) {
  const W = 48, H = 27;
  const err = (k) => { let s = 0, n = 0; for (let r = 0; r < H; r++) { const ra = r + k; if (ra < 0 || ra >= H) continue; for (let c = 0; c < W; c++) { s += Math.abs(a[ra * W + c] - b[r * W + c]); n++; } } return n ? s / n : Infinity; };
  const e0 = err(0); let best = 0, be = e0;
  for (let k = -21; k <= 21; k++) { if (!k || H - Math.abs(k) < 6) continue; const e = err(k); if (e < be) { be = e; best = k; } }
  return best !== 0 && e0 > 1.5 && be < e0 * 0.6;
}
/** Input → visible response. kind "scroll": the first frame whose content has moved vertically relative to the frame
 *  shown when the input was sent; settle = the last frame that still moved, after the input ended (a backlog of stale
 *  frames shows as a long settle). kind "change": the first frame with ≥ frac of the picture changed (navigation). */
function response(M, tIn, tEndInput = tIn, kind = "scroll", frac = 0.3) {
  // Start the clock when the viewer actually sent the input (its first message after the gesture began).
  const sent = M.sends.find((x) => x.t >= tIn && x.t - tIn < 300 && !x.d.includes('"a":"move"') && !x.d.includes('"ack"'));
  if (sent) tIn = sent.t;
  const before = [...M.draws].reverse().find((d) => d.t <= tIn);
  const after = M.draws.filter((d) => d.t > tIn);
  let visible = null;
  if (before) for (const d of after) if (d.w === before.w && (kind === "scroll" ? moved(before.sig, d.sig) : changed(before.sig, d.sig) >= frac)) { visible = d.t - tIn; break; }
  let last = null, stale = 0;
  for (let i = 1; i < M.draws.length; i++) { const d = M.draws[i], p = M.draws[i - 1]; if (d.t > tEndInput && d.w === p.w && (kind === "scroll" ? moved(p.sig, d.sig) : changed(p.sig, d.sig) > 0.05)) { last = d.t; stale++; } }
  return { visibleMs: r1(visible), settleMs: last == null ? 0 : r1(last - tEndInput), framesAfterInputEnded: stale };
}
function frames(M, t0, t1) {
  const fr = M.msgs.filter((m) => m.k === "b" && m.t >= t0 && m.t < t1);
  const secs = Math.max(0.001, (t1 - t0) / 1000);
  const gaps = fr.slice(1).map((m, i) => m.t - fr[i].t);
  const draws = M.draws.filter((d) => d.t >= t0 && d.t < t1);
  return { frames: fr.length, fps: r1(fr.length / secs), drawsPerSec: r1(draws.length / secs), kbPerSec: r1(fr.reduce((s, m) => s + m.n, 0) / 1024 / secs), kbPerFrame: r1(fr.length ? fr.reduce((s, m) => s + m.n, 0) / 1024 / fr.length : 0), gapMedMs: r1(med(gaps)), gapP95Ms: r1(p95(gaps)), droppedBeforeDraw: Math.max(0, fr.length - draws.length) };
}
const now = (p) => p.evaluate(() => performance.now());
const getM = (p) => p.evaluate(() => window.__pf);

async function cpu(cdp) { const m = await cdp.send("Performance.getMetrics"); const g = (k) => m.metrics.find((x) => x.name === k)?.value ?? 0; return { task: g("TaskDuration"), script: g("ScriptDuration"), heapMB: g("JSHeapUsedSize") / 1048576, ts: g("Timestamp") }; }

const browser = await chromium.launch();
const report = { label: LABEL, base: BASE, at: new Date().toISOString(), position: POSITION, target: null, devices: {}, direct: null, notes: [] };

// ── Which project is at the position (the explorer's order on /portfolio) ──
{
  const ctx = await browser.newContext(); const p = await ctx.newPage();
  await p.goto(`${BASE}/portfolio`, { waitUntil: "domcontentloaded" });
  const slides = await p.evaluate(() => [...document.querySelectorAll("[data-pfx] [data-pfx-slide]")].map((s) => ({ name: s.dataset.name, kind: s.dataset.kind, slug: s.dataset.remoteSlug ?? null, live: s.dataset.liveUrl })));
  const slug = opt("--slug", null);
  report.target = slug ? slides.find((s) => s.slug === slug) ?? { slug } : slides[POSITION - 1];
  report.slides = slides.map((s, i) => `${i + 1}. ${s.name} (${s.kind})`);
  await ctx.close();
}
const T = report.target;
console.log(`target: position ${POSITION} → ${T?.name} (${T?.kind}) ${T?.live ?? ""} slug=${T?.slug}`);
if (!T || T.kind !== "remote" || !T.slug) { console.log("The target is not a remote-browser (Mode B) entry; nothing to measure."); writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(1); }

/** A same-site link visible in the first screen of the real site at this viewport (read directly; nothing submitted). */
async function findTargets(url, w, h, mobile) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  try {
    await p.goto(url, { waitUntil: "load", timeout: 45000 }); await sleep(1200);
    return await p.evaluate(({ h }) => {
      const here = new URL(location.href), site = here.hostname.replace(/^www\./, "");
      const bad = /(^|\/)(login|log-in|signin|sign-in|signup|sign-up|register|account|admin|owner|dashboard|portal|billing|checkout|cart|pay|payment|api|download|upload)(\/|$|\.)/i;
      const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 8 || r.height < 8 || r.top < 2 || r.bottom > h - 2 || r.left < 0 || r.right > innerWidth) return null; const x = r.left + r.width / 2, y = r.top + r.height / 2; const top = document.elementFromPoint(x, y); return top && (el === top || el.contains(top)) ? { x: Math.round(x), y: Math.round(y) } : null; };
      let link = null, text = null;
      for (const a of document.querySelectorAll("a[href]")) {
        let u; try { u = new URL(a.href); } catch { continue; }
        if (u.protocol !== "https:" || !(u.hostname === site || u.hostname.endsWith("." + site)) || u.pathname === here.pathname || bad.test(u.pathname) || a.hasAttribute("download") || (a.target && a.target !== "_self")) continue;
        const v = vis(a); if (v) { link = { ...v, path: u.pathname }; break; }
      }
      for (const el of document.querySelectorAll("h1, h2, p")) { if (el.closest("a,button,label,[onclick],[role=button]")) continue; const v = vis(el); if (v) { text = v; break; } }
      return { link, text };
    }, { h });
  } catch { return { link: null, text: null }; } finally { await ctx.close(); }
}

const DEV = {
  desktop: { label: "Desktop Chrome 1440×900", opts: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, touch: false },
  pixel: { label: "Android-sized (Pixel 7, Chromium emulation)", opts: devices["Pixel 7"], touch: true },
  iphone: { label: "iPhone-sized (iPhone 13 viewport, Chromium emulation — NOT Safari)", opts: devices["iPhone 13"], touch: true },
  ipad: { label: "Tablet (iPad Mini viewport, Chromium emulation)", opts: devices["iPad Mini"], touch: true },
};

for (const key of DEVICES) {
  const D = DEV[key]; if (!D) continue;
  const o = { ...D.opts }; delete o.defaultBrowserType;
  const ctx = await browser.newContext(o);
  await ctx.addInitScript(PROBE);
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Performance.enable");
  const R = { label: D.label };
  const sel = `.pfx__slide[data-remote-slug="${T.slug}"]`;
  try {
    const tNav = Date.now();
    await p.goto(`${BASE}/portfolio/${T.slug}`, { waitUntil: "domcontentloaded" });
    await p.locator(sel).scrollIntoViewIfNeeded();
    await p.locator(sel).evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    const ok = await p.waitForSelector(`${sel}.is-ready canvas.pfx__remote`, { timeout: 60000 }).then(() => true, () => false);
    const M0 = await getM(p);
    const res = await p.evaluate(() => performance.getEntriesByType("resource").filter((r) => r.name.includes("/api/portfolio/remote-sessions")).map((r) => ({ start: r.startTime, end: r.responseEnd })));
    const firstFrame = M0.msgs.find((m) => m.k === "b"), ready = M0.msgs.find((m) => m.k === "j" && m.m?.t === "ready");
    R.startup = { ok, wallMs: Date.now() - tNav, sessionRequestMs: r1(res[0] ? res[0].end - res[0].start : null), sessionRequestAt: r1(res[0]?.start), wsOpenAt: r1(M0.ws[0]?.open), readyAt: r1(ready?.t), firstFrameAt: r1(firstFrame?.t), firstDrawAt: r1(M0.draws[0]?.t),
      requestToFirstDrawMs: r1(res[0] && M0.draws[0] ? M0.draws[0].t - res[0].start : null) };
    if (!ok) { R.error = (await p.locator(`${sel} [data-pfx-status]`).innerText().catch(() => "")) || "not live"; throw new Error(R.error); }
    const box = async () => { const b = await p.locator(`${sel} canvas.pfx__remote`).boundingBox(); const wh = await p.locator(`${sel} canvas.pfx__remote`).evaluate((c) => [c.width, c.height]); return { b, w: wh[0], h: wh[1] }; };
    const at = async (x, y) => { const { b, w, h } = await box(); return { x: b.x + (x / w) * b.width, y: b.y + (y / h) * b.height }; };
    const c0 = await cpu(cdp);
    // Idle / animation: 5 s with no input.
    await sleep(1500);
    let t0 = await now(p); await sleep(5000); let t1 = await now(p);
    R.idle = frames(await getM(p), t0, t1);
    const { w, h } = await box();
    const targets = await findTargets(T.live, w, h, D.touch);
    const mid = await at(Math.round(w / 2), Math.round(h / 2));
    if (!D.touch) {
      // Single wheel scrolls, 5×: input → visible change.
      await p.mouse.move(mid.x, mid.y);
      const single = [];
      for (let i = 0; i < 5; i++) {
        const tIn = await now(p); await p.mouse.wheel(0, 360); await sleep(1600);
        single.push(response(await getM(p), tIn));
      }
      R.scrollSingle = { visibleMedMs: med(single.map((s) => s.visibleMs)), visibleMaxMs: Math.max(...single.map((s) => s.visibleMs ?? Infinity)), settleMedMs: med(single.map((s) => s.settleMs)), samples: single };
      // Continuous scrolling: 60 wheel events every 16 ms (≈1 s), then back up.
      t0 = await now(p);
      for (let i = 0; i < 60; i++) { await p.mouse.wheel(0, 90); await sleep(16); }
      const tEnd = await now(p); await sleep(3000); t1 = await now(p);
      const Mc = await getM(p);
      R.scrollContinuous = { ...frames(Mc, t0, tEnd), ...response(Mc, t0, tEnd), inputMessages: Mc.sends.filter((s) => s.t >= t0 && s.t <= tEnd + 50 && s.d.includes('"wheel"')).length };
      for (let i = 0; i < 12; i++) { await p.mouse.wheel(0, -1500); await sleep(30); }
      await sleep(1500);
      // Rapid repeated clicks on plain text: every click must arrive; the viewer stays responsive.
      if (targets.text) {
        const pt = await at(targets.text.x, targets.text.y);
        const tA = await now(p);
        for (let i = 0; i < 10; i++) { await p.mouse.click(pt.x, pt.y); await sleep(40); }
        const tB = await now(p); await sleep(1500);
        const Mr = await getM(p);
        R.rapidClicks = { clicks: 10, mouseMessages: Mr.sends.filter((s) => s.t >= tA && s.t <= tB + 50 && s.d.includes('"mouse"') && !s.d.includes('"a":"move"')).length, ...response(Mr, tA, tB, "change", 0.5) };
      }
      // Click a same-site link: click → new page visible; then Back.
      if (targets.link) {
        const pt = await at(targets.link.x, targets.link.y);
        const tIn = await now(p); await p.mouse.click(pt.x, pt.y); await sleep(6000);
        const Ml = await getM(p);
        const url = Ml.msgs.find((m) => m.k === "j" && m.m?.t === "url" && m.t > tIn);
        R.clickLink = { path: targets.link.path, urlNoticeMs: r1(url ? url.t - tIn : null), ...response(Ml, tIn, tIn, "change", 0.3) };
        const tB = await now(p); await p.click("[data-pfx-back]"); await sleep(5000);
        R.back = response(await getM(p), tB, tB, "change", 0.3);
      } else report.notes.push(`${key}: no visible same-site link in the first screen`);
    } else {
      // Touch swipes on the canvas (CDP touch events on the visitor's page), 3×, then a long continuous swipe.
      const swipe = async (fromF, toF, steps = 10, stepMs = 16) => {
        const a = await at(Math.round(w / 2), Math.round(h * fromF)), b = await at(Math.round(w / 2), Math.round(h * toF));
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: a.x, y: a.y }] });
        for (let i = 1; i <= steps; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: a.x, y: a.y + ((b.y - a.y) * i) / steps }] }); await sleep(stepMs); }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      const sw = [];
      const outer0 = await p.evaluate(() => scrollY);
      for (let i = 0; i < 3; i++) { const tIn = await now(p); await swipe(0.75, 0.35); const tEnd = await now(p); await sleep(1800); sw.push({ ...response(await getM(p), tIn, tEnd) }); }
      R.swipe = { visibleMedMs: med(sw.map((s) => s.visibleMs)), settleMedMs: med(sw.map((s) => s.settleMs)), samples: sw };
      t0 = await now(p);
      for (let k = 0; k < 4; k++) await swipe(0.85, 0.15, 14, 16);
      const tEnd = await now(p); await sleep(3000);
      const Ms = await getM(p);
      R.swipeContinuous = { ...frames(Ms, t0, tEnd), ...response(Ms, t0, tEnd) };
      R.outerPageMoved = (await p.evaluate(() => scrollY)) !== outer0;
      for (let k = 0; k < 6; k++) await swipe(0.2, 0.9, 6, 16);
      await sleep(800);
    }
    // Device switching (desktop only: phone → desktop) — time to the new width on screen.
    if (key === "desktop") {
      for (const [m, wd] of [["mobile", 390], ["desktop", 1440]]) {
        const tIn = await now(p); await p.click(`[data-pfx-mode="${m}"]`);
        const done = await p.waitForFunction(([s, wd]) => { const c = document.querySelector(s); return c && c.width === wd; }, [`${sel} canvas.pfx__remote`, wd], { timeout: 15000 }).then(() => true, () => false);
        R[`switchTo_${m}`] = { ok: done, ms: r1((await now(p)) - tIn) };
        await sleep(1200);
      }
    }
    const c1 = await cpu(cdp);
    const M = await getM(p);
    R.whole = frames(M, M.draws[0]?.t ?? 0, await now(p));
    R.visitor = { decodeMedMs: r1(med(M.decodes.map((d) => d.d))), decodeP95Ms: r1(p95(M.decodes.map((d) => d.d))), drawMedMs: r1(med(M.draws.map((d) => d.d))), longTasks: M.longtasks.length, longTaskMs: r1(M.longtasks.reduce((s, x) => s + x.d, 0)),
      cpuPctOfOneCore: r1(((c1.task - c0.task) / Math.max(0.001, c1.ts - c0.ts)) * 100), scriptPct: r1(((c1.script - c0.script) / Math.max(0.001, c1.ts - c0.ts)) * 100), heapMB: r1(c1.heapMB), inputMessages: M.sends.length };
    R.serverStats = M.stats.length ? M.stats[M.stats.length - 1] : null;
  } catch (e) { R.error = R.error ?? String(e.message).split("\n")[0].slice(0, 200); }
  report.devices[key] = R;
  await ctx.close();
  console.log(`${key}: ${JSON.stringify(R)}`);
  await sleep(1500);
}

// ── The same website loaded directly (no Crestmont): load timing and the native scroll response ──
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  try {
    await p.goto(T.live, { waitUntil: "load", timeout: 60000 });
    const nav = await p.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; return { ttfbMs: n.responseStart, domContentLoadedMs: n.domContentLoadedEventEnd, loadMs: n.loadEventEnd }; });
    await sleep(1000);
    const scroll = [];
    await p.mouse.move(700, 450);
    for (let i = 0; i < 5; i++) {
      // Wheel event → the first rendered frame in which the page has moved (native: the next animation frame or two).
      const pr = p.evaluate(() => new Promise((res) => {
        const y0 = scrollY, start = performance.now(); let tw = null;
        addEventListener("wheel", () => { if (tw === null) tw = performance.now(); }, { capture: true, passive: true });
        const f = () => { if (tw !== null && scrollY !== y0) res(performance.now() - tw); else if (performance.now() - start > 3000) res(null); else requestAnimationFrame(f); };
        requestAnimationFrame(f);
      }));
      await sleep(50); await p.mouse.wheel(0, 360);
      const ms = await pr;
      scroll.push(typeof ms === "number" ? r1(ms) : null);
      await sleep(600);
    }
    const fps = await p.evaluate(() => new Promise((res) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < 2000) requestAnimationFrame(f); else res(n / 2); }; requestAnimationFrame(f); }));
    report.direct = { url: T.live, ...Object.fromEntries(Object.entries(nav).map(([k, v]) => [k, r1(v)])), scrollToVisibleMedMs: med(scroll), nativeFps: r1(fps) };
  } catch (e) { report.direct = { url: T.live, error: String(e.message).split("\n")[0].slice(0, 200) }; }
  await ctx.close();
}
await browser.close();
writeFileSync(OUT, JSON.stringify(report, null, 2));

// ── Summary (markdown) ──
const rows = [];
for (const [k, R] of Object.entries(report.devices)) {
  const s = R.startup ?? {};
  rows.push(`| ${R.label} | ${R.error ? `**${R.error}**` : "ok"} | ${s.requestToFirstDrawMs ?? "—"} | ${R.idle?.fps ?? "—"} / ${R.idle?.kbPerSec ?? "—"} | ${R.scrollSingle?.visibleMedMs ?? R.swipe?.visibleMedMs ?? "—"} | ${R.scrollSingle?.settleMedMs ?? R.swipe?.settleMedMs ?? "—"} | ${(R.scrollContinuous ?? R.swipeContinuous)?.fps ?? "—"} fps, ${(R.scrollContinuous ?? R.swipeContinuous)?.kbPerSec ?? "—"} KB/s, ${(R.scrollContinuous ?? R.swipeContinuous)?.kbPerFrame ?? "—"} KB/frame | ${(R.scrollContinuous ?? R.swipeContinuous)?.settleMs ?? "—"} | ${R.clickLink?.visibleMs ?? "—"} | ${R.visitor?.decodeMedMs ?? "—"} / ${R.visitor?.cpuPctOfOneCore ?? "—"}% |`);
}
const md = [`### Portfolio performance — ${LABEL} (${report.at})`, `Target: position ${POSITION} → **${T.name}** (${T.live})`, "",
  "| Device | Status | Start → first picture (ms) | Idle fps / KB/s | Scroll/swipe → visible (ms, median) | Settle after single (ms) | Continuous scroll: delivered | Settle after continuous (ms) | Click link → new page visible (ms) | Decode ms / visitor CPU |",
  "|---|---|---|---|---|---|---|---|---|---|", ...rows, "",
  report.direct ? `Direct visit to ${report.direct.url}: TTFB ${report.direct.ttfbMs} ms, load ${report.direct.loadMs} ms, scroll → visible ${report.direct.scrollToVisibleMedMs} ms (native), ${report.direct.nativeFps} fps.` : "",
  ...report.notes.map((n) => `- ${n}`)].join("\n");
console.log("\n" + md);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n", { flag: "a" });
