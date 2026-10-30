// Optional rendering checks with Playwright (free; `npm i -g playwright && npx playwright install chromium` on the
// workstation). Absent → the audit uses HTML-only checks and says so. Every sub-request the page makes is checked:
// requests to non-public addresses are aborted (the workstation sits on a private network).
import { lookup } from "node:dns/promises";
import { spawn } from "node:child_process";
import { isPublicAddress } from "./http.ts";

export interface BrowserCheck { viewport: string; viewportWidth: number; scrollWidth: number; overflowPx: number; textLength: number; consoleErrors: number; firstErrors: string[]; smallTapTargets: number; error: string | null }

type PwPage = { on(e: string, cb: (x: { type(): string; text(): string }) => void): void; route(p: string, h: (r: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) => Promise<void>): Promise<void>; goto(u: string, o: object): Promise<unknown>; evaluate<T>(fn: () => T): Promise<T>; close(): Promise<void> };
type PwBrowser = { newContext(o: object): Promise<{ newPage(): Promise<PwPage>; close(): Promise<void> }>; close(): Promise<void> };

const hostOk = new Map<string, boolean>();
async function publicHost(host: string): Promise<boolean> {
  if (hostOk.has(host)) return hostOk.get(host)!;
  let ok = false;
  try { const a = await lookup(host, { all: true }); ok = a.length > 0 && a.every((x) => isPublicAddress(x.address)); } catch { ok = false; }
  if (hostOk.size > 50_000) hostOk.clear();
  hostOk.set(host, ok);
  return ok;
}

export class Browser {
  private browser: PwBrowser | null = null;
  readonly userAgent: string;
  constructor(userAgent: string) { this.userAgent = userAgent; }
  /** Null when Playwright or its Chromium is not installed. */
  static async open(userAgent: string): Promise<Browser | null> {
    try {
      const pw = await (Function("m", "return import(m)") as (m: string) => Promise<{ chromium: { launch(o: object): Promise<PwBrowser> } }>)("playwright");
      const b = new Browser(userAgent);
      b.browser = await pw.chromium.launch({ headless: true });
      return b;
    } catch { return null; }
  }
  async check(url: string, timeoutMs = 30_000): Promise<BrowserCheck> {
    const viewportWidth = 390;
    const base: BrowserCheck = { viewport: `${viewportWidth}x844`, viewportWidth, scrollWidth: 0, overflowPx: 0, textLength: 0, consoleErrors: 0, firstErrors: [], smallTapTargets: 0, error: null };
    if (!this.browser) return { ...base, error: "browser not available" };
    const ctx = await this.browser.newContext({ viewport: { width: viewportWidth, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: `${this.userAgent} Mobile` });
    try {
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
      await page.route("**/*", async (r) => {
        let ok = false;
        try { const u = new URL(r.request().url()); ok = /^https?:$/.test(u.protocol) ? await publicHost(u.hostname) : u.protocol === "data:" || u.protocol === "blob:"; } catch { ok = false; }
        return ok ? r.continue() : r.abort();
      });
      await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
      const m = await page.evaluate(() => {
        const d = document.documentElement;
        const small = [...document.querySelectorAll("a,button,input,select")].filter((e) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24); }).length;
        return { scrollWidth: d.scrollWidth, innerWidth: window.innerWidth, text: (document.body?.innerText ?? "").trim().length, small };
      });
      return { ...base, scrollWidth: m.scrollWidth, overflowPx: Math.max(0, m.scrollWidth - m.innerWidth), textLength: m.text, consoleErrors: errors.length, firstErrors: errors.slice(0, 3), smallTapTargets: m.small };
    } catch (e) { return { ...base, error: (e as Error).message.slice(0, 200) }; }
    finally { await ctx.close().catch(() => {}); }
  }
  async close() { await this.browser?.close().catch(() => {}); }
}

/** Optional Lighthouse CLI (free). Null when not configured or when it fails. */
export function runLighthouse(bin: string, url: string, timeoutMs = 120_000): Promise<{ performance: number | null; accessibility: number | null; seo: number | null; version: string } | null> {
  return new Promise((resolve) => {
    const p = spawn(bin, [url, "--output=json", "--quiet", "--form-factor=mobile", "--only-categories=performance,accessibility,seo", "--chrome-flags=--headless=new"], { windowsHide: true, shell: process.platform === "win32" && /\.cmd$/i.test(bin) });
    let out = "";
    const t = setTimeout(() => { p.kill(); resolve(null); }, timeoutMs);
    p.stdout.on("data", (d) => { if (out.length < 30_000_000) out += d; });
    p.on("error", () => { clearTimeout(t); resolve(null); });
    p.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) return resolve(null);
      try {
        const j = JSON.parse(out) as { lighthouseVersion: string; categories: Record<string, { score: number | null }> };
        resolve({ performance: j.categories.performance?.score ?? null, accessibility: j.categories.accessibility?.score ?? null, seo: j.categories.seo?.score ?? null, version: j.lighthouseVersion });
      } catch { resolve(null); }
    });
  });
}
