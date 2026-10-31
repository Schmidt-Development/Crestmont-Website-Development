// The portfolio flows' visitor click (scripts/preview-demo-flows.mjs): clicking inside a cross-site demo frame never
// scrolls the Crestmont page around it — also when the target is briefly covered, where Playwright's own locator.click()
// retries with a native re-scroll that moves the parent page (hosted desktop BLM: "Crestmont's page stayed still" failed).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { launchBrowser } from "./support.ts";
// Untyped .mjs harness shared with the hosted browser check (imported by path so the typecheck does not need a .d.ts).
const FLOWS_PATH = "../../scripts/preview-demo-flows.mjs";
const { click } = (await import(FLOWS_PATH)) as { click: (l: unknown, ms?: number) => Promise<void> };

let parent: Server, demo: Server, browser: Awaited<ReturnType<typeof launchBrowser>>;
let P = 0, D = 0;
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));

before(async () => {
  // The demo: a tall page with a horizontally scrolling strip (like BLM's day picker) and buttons that count clicks.
  demo = createServer((_q, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><body style="margin:0;font:16px sans-serif">
<div style="height:500px"></div>
<div id="strip" style="display:flex;gap:8px;overflow-x:auto;width:300px">${[...Array(12)].map((_, i) => `<button class="day" style="flex:0 0 90px;height:60px">Day ${i}</button>`).join("")}</div>
<div style="height:900px"></div><button id="go" style="width:160px;height:48px">Continue</button><div style="height:20px"></div>
<script>/* as every portfolio demo's embed script: content scrolling stays inside the frame (vertical only, like BLM's) */Element.prototype.scrollIntoView=function(o){const r=this.getBoundingClientRect(),b=(o&&o.block)||"start";window.scrollTo(0,Math.max(0,scrollY+(b==="center"?r.top-(innerHeight-r.height)/2:b==="end"?r.bottom-innerHeight:r.top)))};window.clicks=[];document.addEventListener("click",e=>{if(e.target.matches("button"))clicks.push(e.target.textContent+(e.isTrusted?"":" (synthetic)"))})</script></body>`));
  D = await listen(demo);
  // Crestmont's page: the frame mid-page, as in the explorer. Different site from the demo (localhost vs 127.0.0.1).
  parent = createServer((_q, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><body style="margin:0">
<div style="height:900px"></div><iframe src="http://127.0.0.1:${D}/" style="display:block;width:800px;height:600px;border:0"></iframe><div style="height:1600px"></div></body>`));
  P = await listen(parent);
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); parent?.close(); demo?.close(); });

async function setup() {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(`http://localhost:${P}/`);
  await p.locator("iframe").evaluate((el: Element) => el.scrollIntoView({ block: "center" }));
  const f = p.frames().find((x: { url(): string }) => x.url().startsWith(`http://127.0.0.1:${D}`))!;
  await f.waitForLoadState();
  return { ctx, p, f, y0: await p.evaluate(() => scrollY) };
}
const cover = (l: { evaluate: (fn: (el: Element) => void) => Promise<unknown> }, ms: number) => l.evaluate((el: Element) => {
  const r = el.getBoundingClientRect(), o = document.createElement("div");
  Object.assign(o.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, zIndex: "9" });
  document.body.append(o); setTimeout(() => o.remove(), (window as unknown as { __ms: number }).__ms);
}).catch(() => undefined);

test("[PORT-006] a covered control in a cross-site demo is clicked once (trusted) without moving the page around the frame", async () => {
  const { ctx, p, f, y0 } = await setup();
  const go = f.locator("#go");
  await f.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); // the control sits at the end of the page
  await f.evaluate(() => { (window as unknown as { __ms: number }).__ms = 700; });
  await cover(go, 700);
  await click(go);
  assert.deepEqual(await f.evaluate(() => (window as unknown as { clicks: string[] }).clicks), ["Continue"], "exactly one trusted click reached the control");
  assert.equal(await p.evaluate(() => scrollY), y0, "the page around the frame did not move");
  await ctx.close();
});

test("[PORT-006] a day clipped in a horizontal strip is swiped into view inside the demo, never by scrolling the page", async () => {
  const { ctx, p, f, y0 } = await setup();
  await click(f.locator(".day").nth(9));
  assert.deepEqual(await f.evaluate(() => (window as unknown as { clicks: string[] }).clicks), ["Day 9"]);
  assert.ok(await f.evaluate(() => document.getElementById("strip")!.scrollLeft > 0), "the strip itself scrolled sideways");
  assert.equal(await p.evaluate(() => scrollY), y0, "the page around the frame did not move");
  await ctx.close();
});

test("[PORT-006] control: Playwright's own locator.click() on a covered control does move the page around the frame (why the flows do not use it)", async () => {
  const { ctx, p, f, y0 } = await setup();
  const go = f.locator("#go");
  await f.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await f.evaluate(() => { (window as unknown as { __ms: number }).__ms = 700; });
  await cover(go, 700);
  await go.click();
  assert.notEqual(await p.evaluate(() => scrollY), y0, "locator.click() re-scrolled the parent page");
  await ctx.close();
});
