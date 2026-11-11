// Focused browser check of Staff → Portfolio ordering (Chromium, preinstalled Playwright; not part of `npm test`):
// keyboard, mouse drag and touch drag with edge auto-scroll reorder the real rendered page, Save submits the order and
// the app stores it. Run: node --no-warnings tests/ui/portfolio-order.ui.ts
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createTestApp, createStaff, TEST_PASSWORD } from "../support/app.ts";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const t = await createTestApp();
const owner = await createStaff(t.db, "owner");
const o = await t.client().login(owner.email, TEST_PASSWORD, owner.secret);
const f = (name: string, slug: string) => ({ name, slug, industry: "Testing", live_url: `https://${slug}.fixture-portfolio.com`, description: `${name} is a TEST DATA portfolio entry for ordering.`, features: "", technology_summary: "", relationship: "Relationship documentation pending" });
for (const [n, s] of [["Alpha Fixture", "alpha-fixture"], ["Bravo Fixture", "bravo-fixture"], ["Charlie Fixture", "charlie-fixture"]]) await o.post("/staff/portfolio", f(n, s));
const html = await (await o.get("/staff/portfolio")).text();
const names = async () => (await t.db.prepare(`SELECT name FROM portfolio_projects WHERE archived_at IS NULL ORDER BY position, name`).all<{ name: string }>()).results.map((r) => r.name);
const before = await names();
const b = await chromium.launch();
let posted = "";
for (const vp of [{ width: 1280, height: 900, mobile: false }, { width: 390, height: 844, mobile: true }]) {
  const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile });
  const p = await ctx.newPage();
  await p.route("**/*", async (r: any) => {
    const u = new URL(r.request().url());
    if (r.request().method() === "POST" && u.pathname === "/staff/portfolio/order") { posted = new URLSearchParams(r.request().postData() ?? "").get("order") ?? ""; return r.fulfill({ status: 200, body: "saved" }); }
    if (u.pathname.startsWith("/assets/")) { try { return r.fulfill({ status: 200, body: readFileSync(`public${u.pathname}`), contentType: u.pathname.endsWith(".js") ? "text/javascript" : u.pathname.endsWith(".css") ? "text/css" : "application/octet-stream" }); } catch { return r.fulfill({ status: 404 }); } }
    if (u.pathname === "/staff/portfolio") return r.fulfill({ status: 200, body: html, contentType: "text/html" });
    return r.fulfill({ status: 404 });
  });
  const errors: string[] = []; p.on("pageerror", (e: Error) => errors.push(e.message));
  await p.goto("http://crestmont.test/staff/portfolio");
  const order = () => p.$$eval("[data-pf-order] [data-pf-id]", (els: Element[]) => els.map((e) => (e.querySelector("[data-pf-handle]")?.getAttribute("aria-label") ?? "").replace(/^Reorder (.*): drag.*$/, "$1")));
  const hidden = () => p.$eval("[data-pf-order-input]", (e: any) => e.value);
  const start = await order();
  await p.focus("[data-pf-order] [data-pf-id]:first-child [data-pf-handle]");
  await p.keyboard.press("ArrowDown");
  const afterKey = await order();
  const status = await p.$eval("[data-pf-status]", (e: Element) => e.textContent);
  const handles = await p.$$("[data-pf-order] [data-pf-handle]");
  // Desktop: whole list in view, drag the last card above the first. Phone: drag to the top edge and hold (auto-scroll).
  await p.evaluate(() => { const l = document.querySelector("[data-pf-order]")!; window.scrollTo(0, l.getBoundingClientRect().top + window.scrollY - 80); });
  const last = await handles[handles.length - 1].boundingBox(); const first = await handles[0].boundingBox();
  const x = last!.x + last!.width / 2, y0 = Math.min(last!.y + last!.height / 2, vp.height - 80);
  if (vp.mobile) await p.evaluate(() => window.scrollBy(0, 1200));
  const lastNow = await handles[handles.length - 1].boundingBox();
  const ys = vp.mobile ? lastNow!.y + lastNow!.height / 2 : y0;
  const target = vp.mobile ? 20 : first!.y - 10;
  const steps = vp.mobile ? 200 : 12;
  const yAt = (i: number) => Math.max(target, ys + (target - ys) * Math.min(1, i / 12));
  if (vp.mobile) {
    const cdp = await ctx.newCDPSession(p);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: ys }] });
    for (let i = 1; i <= steps; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: yAt(i) + (i % 2 ? 0.5 : 0) }] });
    await p.waitForTimeout(2500); // finger held at the top edge: the page scrolls on its own
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 20 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await p.mouse.move(x, ys); await p.mouse.down();
    for (let i = 1; i <= steps; i++) await p.mouse.move(x, yAt(i));
    await p.mouse.up();
  }
  const afterDrag = await order();
  const hid = await hidden();
  await p.click("[data-pf-order-form] button[type=submit]");
  await p.waitForTimeout(300);
  console.log(JSON.stringify({ viewport: vp.width, start, afterKey, status, afterDrag, hiddenMatches: hid.split(",").length === afterDrag.length, posted: posted === hid, errors }));
  await ctx.close();
}
await b.close();
const r = await o.post("/staff/portfolio/order", { order: posted });
console.log(JSON.stringify({ saveStatus: r.status, before, saved: await names() }));
