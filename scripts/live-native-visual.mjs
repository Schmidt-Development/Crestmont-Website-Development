// Native embedding, measured fairly (Owner, 2026-11-18): every published portfolio website is opened DIRECTLY and
// THROUGH Crestmont's native frame (/portfolio/<slug>) in the same Chromium, at the same size, on the same machine, and
// the same things are measured inside the website's own page in both:
//   first content (FCP) and largest content (LCP) on the site's own clock; layout stability (CLS); animation frames
//   (fps and the 95th-percentile frame interval); a wheel scroll → the page has moved; a click → the Event Timing
//   API's duration (input delay + processing + next paint); every large canvas (2D or WebGL): pixels drawn and whether
//   they change (animation).
// Lead Haven Collective's animated 3D Earth is checked specifically: its canvas must draw and animate inside Crestmont,
// within reach of what the same browser draws on the direct site (a cropped screenshot of each is kept as evidence).
// If the direct site itself lacks it, that is reported separately — Crestmont is not blamed without evidence.
// Read-only: no sign-in, nothing submitted, no cookies kept. A site slow on its own is classified as such.
//   PLAYWRIGHT_MODULE=… node scripts/live-native-visual.mjs <https-origin> [out-dir]
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = pw.chromium ? pw : pw.default;
const base = (process.argv[2] ?? "").replace(/\/$/, "");
const out = process.argv[3] ?? "native-visual";
if (!/^https?:\/\/[A-Za-z0-9.:-]+$/.test(base)) { console.error("usage: live-native-visual.mjs <origin> [out-dir]"); process.exit(2); }
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) failed++; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// Installed in every document before its scripts: observers only (LCP, CLS, Event Timing); changes nothing.
const OBSERVE = `(() => { const M = window.__nv = { lcp: null, cls: 0, events: [] };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) M.lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) M.cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) M.events.push({ name: e.name, duration: e.duration }); }).observe({ type: "event", durationThreshold: 16, buffered: true }); } catch {}
})();`;

// Runs inside the website's page (direct or framed).
const MEASURE = async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nav = performance.getEntriesByType("navigation")[0], fcp = performance.getEntriesByName("first-contentful-paint")[0];
  const frames = await new Promise((res) => { const d = []; let last = performance.now(); const t0 = last; const g = (now) => { d.push(now - last); last = now; if (now - t0 < 2000) requestAnimationFrame(g); else { d.sort((a, b) => a - b); res({ fps: Math.round(d.length / ((now - t0) / 1000) * 10) / 10, p95: Math.round(d[Math.floor(d.length * 0.95)] * 10) / 10 }); } }; requestAnimationFrame(g); });
  const big = [...document.querySelectorAll("canvas")].filter((c) => { const r = c.getBoundingClientRect(); return r.width >= 96 && r.height >= 96 && c.width > 0 && c.height > 0; }).slice(0, 3);
  const sample = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(big.map((c) => {
    try { const s = document.createElement("canvas"); s.width = 32; s.height = 32; const x = s.getContext("2d"); x.drawImage(c, 0, 0, 32, 32); const d = x.getImageData(0, 0, 32, 32).data;
      const counts = new Map(); for (let i = 0; i < d.length; i += 4) { const k = d[i + 3] < 8 ? "t" : ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4); counts.set(k, (counts.get(k) || 0) + 1); }
      let max = 0; for (const v of counts.values()) max = Math.max(max, v);
      let sig = 0; for (let i = 0; i < d.length; i += 4) sig = (sig * 31 + (d[i] >> 3) * 1031 + (d[i + 1] >> 3) * 37 + (d[i + 2] >> 3)) % 1000000007;
      return { drawn: 1 - max / 1024, sig };
    } catch (e) { return { drawn: 0, sig: 0, error: String(e.message || e).slice(0, 60) }; } })))));
  const s1 = await sample(); await sleep(500); const s2 = await sample(); await sleep(500); const s3 = await sample();
  const canvases = big.map((c, i) => { const r = c.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top), drawn: Math.round(Math.max(s1[i].drawn, s2[i].drawn, s3[i].drawn) * 1000) / 1000, animated: !!s1[i].sig && (s1[i].sig !== s2[i].sig || s2[i].sig !== s3[i].sig), error: s1[i].error ?? null }; });
  let webgl = false; try { const t = document.createElement("canvas"); webgl = !!(t.getContext("webgl2") || t.getContext("webgl")); } catch {}
  return { fcp: fcp ? Math.round(fcp.startTime) : null, lcp: window.__nv?.lcp == null ? null : Math.round(window.__nv.lcp), cls: Math.round((window.__nv?.cls ?? 0) * 1000) / 1000, load: nav ? Math.round(nav.loadEventEnd) : null, ...frames, canvases, webgl, text: (document.body?.innerText || "").length };
};
// A wheel scroll → the first animation frame in which the page (or its scroll container) has moved.
const WATCH_SCROLL = () => new Promise((res) => {
  const pos = () => Math.round(scrollY) + [...document.querySelectorAll("body *")].reduce((a, e) => a + e.scrollTop, 0);
  const y0 = pos(), start = performance.now(); let t = null;
  addEventListener("wheel", () => { if (t === null) t = performance.now(); }, { capture: true, passive: true, once: true });
  const step = () => { if (t !== null && pos() !== y0) res(performance.now() - t); else if (performance.now() - start > 4000) res(null); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
});
const SPOT = () => { for (const e of document.querySelectorAll("h1, h2, h3, p")) { const r = e.getBoundingClientRect(); if (r.width < 40 || r.height < 10 || r.top < 0 || r.bottom > innerHeight) continue; const x = r.left + Math.min(16, r.width / 2), y = r.top + r.height / 2, hit = document.elementFromPoint(x, y); if (hit && !hit.closest("a, button, input, select, textarea, label, summary, [role=button], [onclick]")) return { x, y }; } return null; };

async function measure(ctx, kind, project) {
  const p = await ctx.newPage();
  await p.addInitScript(OBSERVE);
  const t0 = Date.now();
  let f, offset = { x: 0, y: 0 }, scale = 1;
  if (kind === "direct") {
    await p.goto(project.url, { waitUntil: "load", timeout: 45_000 });
    f = p.mainFrame();
  } else {
    await p.goto(`${base}/portfolio/${project.slug}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await p.locator(".pfx").first().scrollIntoViewIfNeeded();
    await p.waitForSelector(".pfx__slide.is-ready iframe.pfx__frame", { timeout: 45_000 });
    const origin = new URL(project.url).origin;
    for (let k = 0; k < 80 && !(f = p.frames().find((x) => x.url().startsWith(origin))); k++) await sleep(250);
    if (!f) throw new Error("the live frame was not found");
    await f.waitForLoadState("load", { timeout: 45_000 }).catch(() => {});
    const el = p.locator(".pfx__slide.is-ready iframe.pfx__frame").first();
    await el.evaluate((e) => e.scrollIntoView({ block: "center" })); await sleep(300);
    const box = await el.boundingBox(); const iw = await f.evaluate(() => innerWidth);
    offset = { x: box.x, y: box.y }; scale = box.width / iw;
  }
  const openMs = Date.now() - t0;
  await sleep(2500);
  const m = await f.evaluate(MEASURE);
  // Scroll response (3 samples) and click response.
  const vp = p.viewportSize();
  const cx = kind === "direct" ? vp.width / 2 : offset.x + 40, cy = kind === "direct" ? vp.height / 2 : offset.y + 120;
  const scroll = [];
  for (let k = 0; k < 3; k++) { await p.mouse.move(cx, cy); const w = f.evaluate(WATCH_SCROLL); await sleep(50); await p.mouse.wheel(0, 360); scroll.push(await w); await sleep(600); }
  await f.evaluate(() => { scrollTo(0, 0); for (const e of document.querySelectorAll("body *")) if (e.scrollTop) e.scrollTop = 0; });
  await sleep(500);
  const spot = await f.evaluate(SPOT);
  let click = null;
  if (spot) { await p.mouse.click(offset.x + spot.x * scale, offset.y + spot.y * scale); await sleep(800); const ev = await f.evaluate(() => (window.__nv?.events ?? []).filter((e) => /click|pointerup|pointerdown|mouseup|mousedown/.test(e.name))); click = ev.length ? Math.max(...ev.map((e) => e.duration)) : 16; }
  // Evidence: the largest canvas, cropped, as shown to a visitor.
  let shot = null;
  const c = m.canvases.sort((a, b) => b.w * b.h - a.w * a.h)[0];
  if (c) { shot = `${out}/${project.slug}-${kind}-${ctx.__label}.png`; await p.screenshot({ path: shot, clip: { x: offset.x + c.x * scale, y: offset.y + Math.max(0, c.y) * scale, width: Math.max(1, Math.min(c.w * scale, vp.width)), height: Math.max(1, Math.min(c.h * scale, vp.height)) } }).catch(() => { shot = null; }); }
  await p.close();
  const ok3 = scroll.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return { openMs, ...m, scrollMs: ok3.length ? r1(ok3[Math.floor((ok3.length - 1) / 2)]) : null, clickMs: click == null ? null : r1(click), shot };
}

const b = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
const listCtx = await b.newContext();
const lp = await listCtx.newPage();
await lp.goto(`${base}/portfolio`, { waitUntil: "domcontentloaded" });
const projects = await lp.evaluate(() => [...document.querySelectorAll(".pfx__slide")].map((s) => ({ slug: s.id.replace(/^pfx-/, ""), name: s.dataset.name, kind: s.dataset.kind, url: s.dataset.frameUrl || s.dataset.liveUrl })));
await listCtx.close();
const report = { at: new Date().toISOString(), base, devices: {} };
const rows = [];
for (const [label, opts] of [["desktop", { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }], ["phone", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }]]) {
  for (const project of projects) {
    if (project.kind !== "live") { ok(false, `${label} ${project.name}: not shown natively (${project.kind})`); continue; }
    const ctx = await b.newContext(opts); ctx.__label = label;
    let d, n;
    try { d = await measure(ctx, "direct", project); n = await measure(ctx, "framed", project); }
    catch (e) { ok(false, `${label} ${project.name}: ${String(e.message).split("\n")[0].slice(0, 160)}`); await ctx.close(); continue; }
    await ctx.close();
    (report.devices[label] ??= {})[project.slug] = { direct: d, framed: n };
    const tag = `${label} ${project.name}`;
    ok(n.text > 200 && n.fps >= Math.min(20, d.fps * 0.8), `${tag}: renders and animates inside Crestmont like the direct site (${n.fps} fps framed vs ${d.fps} direct; ${n.text} characters)`);
    // Canvases (2D/WebGL): what the site draws directly must also be drawn — and keep moving — inside Crestmont.
    for (const [i, dc] of d.canvases.entries()) {
      const fc = n.canvases[i];
      if (dc.drawn < 0.02) { ok(true, `${tag}: a ${dc.w}×${dc.h} canvas is empty on the DIRECT site too (${dc.error ?? "nothing drawn"}) — not an embedding issue${d.webgl ? "" : "; this browser has no WebGL"}`); continue; }
      ok(!!fc && fc.drawn >= Math.max(0.02, dc.drawn * 0.5) && (!dc.animated || fc.animated), `${tag}: ${dc.w}×${dc.h} canvas draws inside Crestmont (${fc ? `${Math.round(fc.drawn * 100)}% drawn${fc.animated ? ", animating" : ", still"}` : "missing"}) as on the direct site (${Math.round(dc.drawn * 100)}%${dc.animated ? ", animating" : ""})`);
    }
    if (/lead-haven/.test(project.slug)) {
      // The largest canvas on each side (canvases are sorted largest first) is the Earth.
      const earthD = d.canvases[0] && d.canvases[0].w >= 150 && d.canvases[0].h >= 150 ? d.canvases[0] : null, earthF = n.canvases[0] ?? null;
      if (!earthD) ok(false, `${tag}: the animated Earth canvas was not found on the DIRECT production site (WebGL ${d.webgl ? "available" : "unavailable"} in this browser) — reported as a site/browser issue, not Crestmont's`);
      else ok(earthD.drawn >= 0.05 && earthD.animated && !!earthF && earthF.drawn >= 0.05 && earthF.animated, `${tag}: Lead Haven's 3D Earth is visible and animating inside Crestmont (${earthF ? `${Math.round(earthF.drawn * 100)}% drawn, ${earthF.animated ? "animating" : "STILL"}` : "missing"}) as on the direct site (${Math.round(earthD.drawn * 100)}% drawn, ${earthD.animated ? "animating" : "still"}); evidence ${n.shot ?? "—"} vs ${d.shot ?? "—"}`);
    }
    if (/get-every-invoice-paid/.test(project.slug)) ok(n.scrollMs != null && (n.scrollMs <= Math.max(50, (d.scrollMs ?? 0) * 2)), `${tag}: GEIP scroll responds natively inside Crestmont (${n.scrollMs} ms framed vs ${d.scrollMs} ms direct)`);
    // Classification: the site's own speed vs Crestmont's embedding.
    const overhead = (a, b2) => a != null && b2 != null && a > b2 * 1.5 && a - b2 > 50;
    const notes = [];
    if (overhead(n.scrollMs, d.scrollMs)) notes.push("scroll slower framed");
    if (overhead(n.clickMs, d.clickMs)) notes.push("click slower framed");
    if (d.fps < 30) notes.push(`site itself animates at ${d.fps} fps here (no GPU on this machine)`);
    if ((d.lcp ?? 0) > 2500) notes.push(`site itself: LCP ${d.lcp} ms`);
    rows.push(`| ${label} | ${project.name} | ${d.fcp ?? "—"} / ${n.fcp ?? "—"} | ${d.lcp ?? "—"} / ${n.lcp ?? "—"} | ${d.cls} / ${n.cls} | ${d.fps} (p95 ${d.p95}) / ${n.fps} (p95 ${n.p95}) | ${d.scrollMs ?? "—"} / ${n.scrollMs ?? "—"} | ${d.clickMs ?? "—"} / ${n.clickMs ?? "—"} | ${d.canvases.map((c) => `${Math.round(c.drawn * 100)}%${c.animated ? "↻" : ""}`).join(" ") || "—"} / ${n.canvases.map((c) => `${Math.round(c.drawn * 100)}%${c.animated ? "↻" : ""}`).join(" ") || "—"} | ${notes.join("; ") || "no embedding overhead measured"} |`);
  }
}
await b.close();
writeFileSync(`${out}/native-visual.json`, JSON.stringify(report, null, 2));
const md = [`### Native vs direct — ${report.at}`, "Each cell: **direct site / inside Crestmont's native frame**, same Chromium, same size, same machine (GitHub runner, software rendering — absolute fps is the machine's, not a visitor's).", "",
  "| Device | Website | FCP ms | LCP ms | CLS | Animation fps (p95 frame ms) | Scroll → moved ms | Click → next paint ms | Canvases drawn (↻ animating) | Classification |", "|---|---|---|---|---|---|---|---|---|---|", ...rows].join("\n");
console.log("\n" + md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
console.log(failed ? `${failed} native visual check(s) failed` : `native rendering verified against the direct sites on ${base}`);
process.exit(failed ? 1 : 0);
