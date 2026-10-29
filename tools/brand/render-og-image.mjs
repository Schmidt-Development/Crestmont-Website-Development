// Renders the 1200×630 social preview image (public/assets/brand/og-image.png, CREST-GAP-075) from existing brand
// assets only: the original crest artwork (shown at its natural size, never upscaled), the self-hosted Inter Display
// face and the approved black / gold / white tokens from app.css. No external images or fonts.
//
//   PLAYWRIGHT_MODULE=/opt/npm-tools/node_modules/playwright/index.mjs node tools/brand/render-og-image.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const asset = (p) => readFileSync(join(root, "public", "assets", p)).toString("base64");
const PW = process.env.PLAYWRIGHT_MODULE ?? "/opt/npm-tools/node_modules/playwright/index.mjs";
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "/opt/pw-browsers";

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Inter Display"; src: url(data:font/woff;base64,${asset("fonts/InterDisplay-Medium.woff")}) format("woff"); font-weight: 500; }
@font-face { font-family: "Inter"; src: url(data:font/woff;base64,${asset("fonts/Inter-Medium.woff")}) format("woff"); font-weight: 500; }
html, body { margin: 0; width: 1200px; height: 630px; background: #080808; overflow: hidden; }
.card { position: relative; width: 1200px; height: 630px; display: grid; grid-template-columns: 300px 1fr; align-items: center; box-sizing: border-box; padding: 0 96px;
  background: linear-gradient(90deg, #0d0d0d 38%, #080808 100%); }
.card::before { content: ""; position: absolute; inset: 28px; border: 1px solid #4f4128; border-radius: 6px; }
.card::after { content: ""; position: absolute; left: 28px; right: 28px; bottom: 28px; height: 3px; background: linear-gradient(90deg, transparent, #d7b56f 30%, #f1dfb0 50%, #d7b56f 70%, transparent); }
.crest { width: 232px; height: 213px; }
.crest img { width: 232px; height: 213px; display: block; mix-blend-mode: lighten; }
.word { font: 500 88px/1 "Inter Display", sans-serif; letter-spacing: .16em; color: #f5f5f5; margin: 0; }
.sub { font: 500 24px/1 "Inter", sans-serif; letter-spacing: .42em; color: #e6c582; margin: 26px 0 0; }
.line { font: 500 26px/1.4 "Inter", sans-serif; color: #b8b8b8; margin: 44px 0 0; max-width: 640px; }
</style></head><body><div class="card"><div class="crest"><img src="data:image/png;base64,${asset("brand/crestmont-logo-original.png")}" alt=""></div>
<div><p class="word">CRESTMONT</p><p class="sub">WEBSITE DEVELOPMENT</p><p class="line">Website design and development with published prices and launch only on your approval.</p></div></div></body></html>`;

const { chromium } = await import(PW);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();
const out = join(root, "public", "assets", "brand", "og-image.png");
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
