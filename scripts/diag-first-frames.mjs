// TEMPORARY diagnostic (not part of the product): what does Chromium's screencast show in the first seconds after
// Page.navigate, exactly as src/services/remote-browser/session.ts starts a session (navigate, then start a JPEG
// screencast at once, quality 55, 1440×817)? For each frame: time since navigate, size, and the acceptance check's
// "samples with contrast" measure. Also the page's own paint/load milestones. Saves frames as JPEG for inspection.
//   node scripts/diag-first-frames.mjs out-dir url...
import { mkdirSync, writeFileSync } from "node:fs";
const [out, ...urls] = process.argv.slice(2);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
mkdirSync(out, { recursive: true });
const b = await chromium.launch();
// The acceptance check's measure, computed on a decoded frame (same sampling stride, same threshold).
const scorer = await (await b.newContext()).newPage();
const score = (jpegB64) => scorer.evaluate(async (d) => {
  const img = await createImageBitmap(await (await fetch("data:image/jpeg;base64," + d)).blob());
  const c = new OffscreenCanvas(1440, 817), g = c.getContext("2d"); g.drawImage(img, 0, 0, 1440, 817);
  const px = g.getImageData(0, 0, 1440, 817).data; let lit = 0; const b0 = px[0] + px[1] + px[2];
  for (let i = 0; i < px.length; i += 4 * 97) if (Math.abs(px[i] + px[i + 1] + px[i + 2] - b0) > 30) lit++;
  // A coarse 24×8 luminance map, printed as text so the log shows what the frame looks like.
  const rows = []; const ramp = " .:-=+*#%@";
  for (let y = 0; y < 8; y++) { let r = ""; for (let x = 0; x < 48; x++) { const i = ((Math.floor((y + 0.5) * 817 / 8)) * 1440 + Math.floor((x + 0.5) * 1440 / 48)) * 4; const l = (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) / 255; r += ramp[Math.min(9, Math.floor(l * 10))]; } rows.push(r); }
  return { lit, w: img.width, h: img.height, map: rows };
}, jpegB64);

for (const url of urls) {
  const name = new URL(url).hostname.replace(/\W+/g, "-");
  const ctx = await b.newContext({ viewport: { width: 1440, height: 817 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const frames = [], events = [];
  let t0 = 0;
  const now = () => Math.round(performance.now() - t0);
  await cdp.send("Page.enable");
  await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });
  cdp.on("Page.lifecycleEvent", (e) => { if (e.frameId === page.mainFrame()._guid || true) events.push(`${now()} ms lifecycle ${e.name}`); });
  cdp.on("Page.loadEventFired", () => events.push(`${now()} ms loadEventFired`));
  cdp.on("Page.screencastFrame", (f) => { frames.push({ at: now(), data: f.data, bytes: Math.round(f.data.length * 0.75) }); void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); });
  t0 = performance.now();
  await cdp.send("Page.navigate", { url });
  events.push(`${now()} ms Page.navigate returned (navigation committed)`);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 1440, maxHeight: 817, everyNthFrame: 1 });
  events.push(`${now()} ms screencast started`);
  await new Promise((r) => setTimeout(r, 8000));
  await cdp.send("Page.stopScreencast").catch(() => {});
  console.log(`\n===== ${url}`);
  for (const e of events.filter((e) => !/lifecycle (init|commit|DOMContentLoaded|load)$/.test(e) || true)) console.log("  " + e);
  console.log(`  ${frames.length} frames in 8 s`);
  let shown = 0;
  for (const [k, f] of frames.entries()) {
    const s = await score(f.data);
    const keep = k < 6 || k === frames.length - 1 || k % 10 === 0;
    console.log(`  frame ${String(k).padStart(3)} at ${String(f.at).padStart(5)} ms  ${String(f.bytes).padStart(6)} B  ${s.w}×${s.h}  contrast samples ${s.lit}`);
    if (keep && shown < 9) { shown++; for (const r of s.map) console.log("      |" + r + "|"); writeFileSync(`${out}/${name}-${String(k).padStart(3, "0")}-${f.at}ms.jpg`, Buffer.from(f.data, "base64")); }
  }
  await ctx.close();
}
await b.close();
