// Production acceptance of the ONE native-first portfolio standard on REAL websites (Owner, 2026-11-19), run by
// deploy-production.yml (verify-live-portfolio) with the deploy job's intake result (POST /api/ops/portfolio-intake:
// slug, mode, reason and a one-hour, view-only preview link per acceptance website).
//   PLAYWRIGHT_MODULE=… node scripts/live-native-acceptance.mjs https://crestmontwebsitedevelopment.com intake.json
// Read-only: nothing on the destination websites is changed or submitted; the previews are only looked at.
//   • every acceptance website is REQUIRED to be native-ready (2026-11-19, strict): its display is the native embed,
//     never "remote" (switched off) — and an honest notice, though correct for a site that cannot be shown, FAILS here;
//   • desktop (1440) and phone (Pixel 7): each is the REAL site in a native iframe (the frame's document is its own
//     origin, with real content); no remote-browser request, WebSocket or stream canvas appears anywhere.
import { readFileSync } from "node:fs";

const [BASE, FILE] = process.argv.slice(2);
if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(BASE ?? "") || !FILE) { console.error("usage: live-native-acceptance.mjs <https-origin> <intake.json>"); process.exit(2); }
const intake = JSON.parse(readFileSync(FILE, "utf8"));
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { chromium, devices } = pw.chromium ? pw : pw.default;
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failed++; return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`COST remote streaming ${intake.remoteBrowser?.enabled ? "ON (unexpected)" : "off"}; Browser Run is used only for native verification`);
const expectMode = (st) => (st === "allowed" ? "embed" : "unavailable");
for (const r of intake.results) {
  console.log(`MODE ${r.url} → ${r.mode} (check: ${r.status}) — ${r.reason}`);
  if (!r.preview) { ok(r.error === "invalid", `${r.url}: refused as an invalid address`); continue; }
  ok(r.mode !== "remote", `${r.url}: never shown through a remote stream`);
  ok(r.mode === expectMode(r.status), `${r.url}: the display (${r.mode}) follows the site's own answer (${r.status})`);
  ok(r.mode === "embed", `${r.url}: required native — the site permits Crestmont's frame (${r.status})`);
}

const b = await chromium.launch();
for (const [label, opts] of [["desktop", { viewport: { width: 1440, height: 900 } }], ["phone", { ...devices["Pixel 7"] }]]) {
  for (const r of intake.results.filter((x) => x.preview)) {
    const ctx = await b.newContext(opts), p = await ctx.newPage(), traffic = [];
    p.on("websocket", (ws) => traffic.push(ws.url()));
    p.on("request", (q) => { if (/remote-sessions/.test(q.url())) traffic.push(q.url()); });
    try {
      await p.goto(`${BASE}/portfolio/preview/${r.preview}`, { waitUntil: "domcontentloaded" });
      const slide = p.locator(".pfx__slide").first();
      await slide.scrollIntoViewIfNeeded();
      const kind = await slide.getAttribute("data-kind");
      if (kind === "live") {
        const origin = new URL((await slide.getAttribute("data-frame-url")) ?? r.url).origin;
        const ready = await p.waitForSelector(".pfx__slide.is-ready iframe", { timeout: 45000 }).then(() => true, () => false);
        let f = null; for (let k = 0; k < 60 && !(f = p.frames().find((x) => x.url().startsWith(origin))); k++) await sleep(250);
        const text = f ? await f.evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().length).catch(() => 0) : 0;
        ok(ready && !!f && text > 40, `${label} ${r.slug}: the real website natively — frame document ${origin}, ${text} characters`);
      } else {
        const status = await slide.locator("[data-pfx-status]").innerText();
        ok(await p.locator("iframe.pfx__frame").count() === 0, `${label} ${r.slug}: nothing framed or claimed live`);
        ok(false, `${label} ${r.slug}: required native, but the portfolio shows the fallback notice ("${status.slice(0, 80)}") — not native-ready`);
      }
      ok(await p.locator("canvas.pfx__remote").count() === 0 && !traffic.length, `${label} ${r.slug}: no remote stream`);
    } catch (e) { ok(false, `${label} ${r.slug}: ${String(e && e.message || e).split("\n")[0].slice(0, 200)}`); }
    await ctx.close();
  }
}
await b.close();
console.log(failed ? `${failed} native-first display check(s) failed` : `native-first display verified on ${BASE}`);
process.exit(failed ? 1 : 0);
