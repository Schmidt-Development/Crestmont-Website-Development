// Genuine portfolio screenshots (PORT-001..003, §13). Opens each live portfolio site in headless Chromium and saves
// an unedited desktop and mobile capture plus a manifest (URL, final URL after redirects, HTTP status, viewport,
// capture time, SHA-256 of each file). Nothing is retouched, cropped, composited or generated.
// The output is for the Founder's review: screenshots are published only after the Founder uploads them in
// Staff → Portfolio, documents the relationship (PORT-005) and verifies the link (PORT-006). This script never
// writes to the platform.
//   node --no-warnings scripts/capture-portfolio.ts --out portfolio-shots [--only <slug>]
//   env PLAYWRIGHT_MODULE (path to playwright's index.mjs; defaults to "playwright")
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PORTFOLIO_TARGETS = [
  { slug: "better-lansing-mechanics", requirement: "PORT-001", url: "https://betterlansingmechanics.com" },
  { slug: "lansing-car-rentals", requirement: "PORT-002", url: "https://lansingcarrentals.com" },
  { slug: "lcr-mentorship", requirement: "PORT-003", url: "https://mentorship.lansingcarrentals.com" },
] as const;

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
} as const;

export interface CaptureRecord {
  slug: string; requirement: string; url: string; viewport: keyof typeof VIEWPORTS; finalUrl: string | null; httpStatus: number | null;
  capturedAt: string; file: string | null; sha256: string | null; bytes: number | null; error: string | null;
}

/** A capture counts only if the live site answered 2xx on the expected host (a parked or redirected domain is not genuine). */
export function acceptable(r: CaptureRecord): boolean {
  if (!r.file || r.error || r.httpStatus === null || r.httpStatus < 200 || r.httpStatus >= 300 || !r.finalUrl) return false;
  const want = new URL(r.url).hostname.replace(/^www\./, "");
  return new URL(r.finalUrl).hostname.replace(/^www\./, "") === want;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const out = arg("--out") ?? "portfolio-shots";
  const only = arg("--only");
  mkdirSync(out, { recursive: true });
  const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  const browser = await pw.chromium.launch();
  const records: CaptureRecord[] = [];
  try {
    for (const t of PORTFOLIO_TARGETS.filter((x) => !only || x.slug === only)) {
      for (const [name, vp] of Object.entries(VIEWPORTS) as [keyof typeof VIEWPORTS, (typeof VIEWPORTS)[keyof typeof VIEWPORTS]][]) {
        const rec: CaptureRecord = { slug: t.slug, requirement: t.requirement, url: t.url, viewport: name, finalUrl: null, httpStatus: null, capturedAt: new Date().toISOString(), file: null, sha256: null, bytes: null, error: null };
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
        try {
          const page = await ctx.newPage();
          const res = await page.goto(t.url, { waitUntil: "networkidle", timeout: 60_000 });
          rec.httpStatus = res?.status() ?? null;
          rec.finalUrl = page.url();
          await page.waitForTimeout(1500); // let web fonts and lazy images settle; no interaction, no edits
          const file = `${t.slug}-${name}.png`;
          const buf: Buffer = await page.screenshot({ path: join(out, file), fullPage: true });
          rec.file = file; rec.bytes = buf.length; rec.sha256 = createHash("sha256").update(buf).digest("hex");
          rec.capturedAt = new Date().toISOString();
        } catch (e) {
          rec.error = (e as Error).message.slice(0, 300);
        } finally {
          await ctx.close();
        }
        records.push(rec);
        console.log(`${t.slug} ${name}: ${acceptable(rec) ? "captured" : `NOT usable (${rec.error ?? `HTTP ${rec.httpStatus} at ${rec.finalUrl}`})`}`);
      }
    }
  } finally {
    await browser.close();
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), note: "Unedited headless-Chromium captures of the live sites for Founder review. Publish only via Staff → Portfolio after review.", records: records.map((r) => ({ ...r, usable: acceptable(r) })) }, null, 2));
  if (!records.some(acceptable)) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
