// Portfolio explorer postMessage security (public/assets/portfolio.js). The explorer trusts a message only from an
// approved demo origin, sent by its OWN frame (event.source), as a plain object of a known type with a same-origin href.
// Adversarial: forged origins, forged sources (another frame of the approved origin), malformed payloads, unexpected
// types, cross-origin and oversized hrefs, and a forged Escape while expanded. Hosted desktop BLM check, deploy #63.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { startServer, launchBrowser } from "./support.ts";

type Page = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Playwright is loaded at runtime
type Frame = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let demo: Server, DEMO = "";
let app: Awaited<ReturnType<typeof startServer>>;
let browser: Awaited<ReturnType<typeof launchBrowser>>;

before(async () => {
  // A fake demo on a different site (127.0.0.1 vs localhost) that announces itself like the real embed script.
  demo = createServer((q, res) => {
    if (q.url?.startsWith("/__demo/info")) { res.writeHead(200, { "content-type": "application/json" }).end('{"demo":true}'); return; }
    res.writeHead(200, { "content-type": "text/html", "content-security-policy": "frame-ancestors http://localhost:*" }).end(`<!doctype html><title>demo</title><h1>Demo ${q.url}</h1>
<script>parent.postMessage({ source: "crestmont-demo", type: "ready", href: location.href }, "*")</script>`);
  });
  await new Promise<void>((r) => demo.listen(0, "127.0.0.1", () => r()));
  DEMO = `http://127.0.0.1:${(demo.address() as { port: number }).port}`;
  process.env.PORTFOLIO_DEMO_ORIGINS = DEMO;
  app = await startServer();
  app.db.prepare(`UPDATE portfolio_projects SET demo_url = ?, demo_status = 'ready', demo_verified_at = ?, published = 1, published_at = COALESCE(published_at, ?) WHERE id = 'pf_better_lansing_mechanics'`)
    .run(`${DEMO}/`, new Date().toISOString(), new Date().toISOString());
  app.db.prepare(`UPDATE portfolio_projects SET published = 0 WHERE id <> 'pf_better_lansing_mechanics'`).run();
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await app?.stop(); demo?.close(); delete process.env.PORTFOLIO_DEMO_ORIGINS; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function open(): Promise<{ p: Page; f: Frame; label: () => Promise<string> }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${app.base}/portfolio`);
  await p.locator(".pfx").first().scrollIntoViewIfNeeded();
  for (let i = 0; i < 50 && !(await p.evaluate(() => document.querySelector(".pfx__slide:not([inert])")?.classList.contains("is-ready"))); i++) await sleep(200);
  const f = p.frames().find((x: Frame) => x.url().startsWith(DEMO));
  assert.ok(f, "the explorer embedded the approved demo");
  const label = async () => ((await p.locator(".pfx__slide:not([inert]) [data-pfx-url]").textContent()) ?? "").trim();
  return { p, f, label };
}
const host = () => new URL(DEMO).host;

test("[PORT-006] the approved demo's own frame is accepted: ready marks it interactive, navigate relabels it (same-origin path only)", async () => {
  const { p, f, label } = await open();
  assert.equal(await p.evaluate(() => document.querySelector(".pfx__slide:not([inert])")!.classList.contains("is-ready")), true);
  await f.evaluate(() => parent.postMessage({ source: "crestmont-demo", type: "navigate", href: location.origin + "/services" }, "*"));
  await sleep(300);
  assert.equal(await label(), `${host()}/services`);
  await p.context().close();
});

test("[PORT-006] [SEC-001] forged origin: a message from Crestmont's own window (or any non-approved origin) never relabels the frame", async () => {
  const { p, label } = await open();
  const before = await label();
  await p.evaluate(() => window.postMessage({ source: "crestmont-demo", type: "navigate", href: "https://attacker.example/x" }, "*"));
  await sleep(300);
  assert.equal(await label(), before);
  await p.context().close();
});

test("[PORT-006] [SEC-001] forged source: another frame of the APPROVED origin (not the explorer's) is ignored", async () => {
  const { p, label } = await open();
  const before = await label();
  await p.evaluate((d: string) => { const x = document.createElement("iframe"); x.hidden = true; x.src = d + "/evil-path"; document.body.append(x); }, DEMO);
  const evil = await (async () => { for (let i = 0; i < 40; i++) { const fr = p.frames().find((x: Frame) => x.url().endsWith("/evil-path")); if (fr) return fr; await sleep(100); } return null; })();
  assert.ok(evil, "the foreign frame of the approved origin loaded");
  await evil.evaluate(() => parent.postMessage({ source: "crestmont-demo", type: "navigate", href: location.href }, "*"));
  await sleep(500);
  assert.equal(await label(), before, "a frame that is not the explorer's cannot relabel it, even from the approved origin");
  await p.context().close();
});

test("[PORT-006] [SEC-001] malformed payloads, unexpected types and bad hrefs from the explorer's own frame change nothing", async () => {
  const { p, f, label } = await open();
  const before = await label();
  await f.evaluate(() => {
    const o = location.origin;
    const bad: unknown[] = [
      "crestmont-demo navigate " + o + "/a", null, 42, [{ source: "crestmont-demo", type: "navigate", href: o + "/b" }],
      { source: "other", type: "navigate", href: o + "/c" }, { type: "navigate", href: o + "/d" },
      { source: "crestmont-demo", type: "takeover", href: o + "/e" }, { source: "crestmont-demo", type: 7, href: o + "/f" },
      { source: "crestmont-demo", type: "navigate", href: { pathname: "/g" } }, { source: "crestmont-demo", type: "navigate", href: 12345 },
      { source: "crestmont-demo", type: "navigate", href: o + "/" + "h".repeat(5000) },
      { source: "crestmont-demo", type: "navigate", href: "https://attacker.example/i" },
      { source: "crestmont-demo", type: "navigate", href: "javascript:alert(1)" },
    ];
    for (const m of bad) parent.postMessage(m, "*");
  });
  await sleep(500);
  assert.equal(await label(), before);
  await p.context().close();
});

test("[PORT-006] [SEC-001] Escape forwarded by a foreign frame of the approved origin does not close the expanded view; the explorer's own frame does", async () => {
  const { p, f } = await open();
  await p.locator("[data-pfx-expand]").first().click();
  const expanded = () => p.evaluate(() => document.querySelector(".pfx")!.classList.contains("pfx--expanded"));
  assert.equal(await expanded(), true);
  await p.evaluate((d: string) => { const x = document.createElement("iframe"); x.hidden = true; x.src = d + "/other"; document.body.append(x); }, DEMO);
  let evil: Frame = null;
  for (let i = 0; i < 40 && !evil; i++) { evil = p.frames().find((x: Frame) => x.url().endsWith("/other")) ?? null; if (!evil) await sleep(100); }
  assert.ok(evil);
  await evil.evaluate(() => parent.postMessage({ source: "crestmont-demo", type: "key", key: "Escape" }, "*"));
  await sleep(300);
  assert.equal(await expanded(), true, "a forged Escape is ignored");
  await f.evaluate(() => parent.postMessage({ source: "crestmont-demo", type: "key", key: "Escape" }, "*"));
  await sleep(300);
  assert.equal(await expanded(), false, "Escape from the explorer's own demo frame closes the expanded view");
  await p.context().close();
});
