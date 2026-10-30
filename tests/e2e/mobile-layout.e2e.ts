// No horizontal overflow on phones, with the bot-check widget present as on staging (deploy #64: /register overflowed
// by 7px at 375px because Turnstile's standard widget is a fixed 300px; /contact and /services/ai-receptionist also
// overflowed at 320–360px). The widget is replaced by a stand-in that honours the size the page asks for.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, launchBrowser } from "./support.ts";

let srv: Awaited<ReturnType<typeof startServer>>;
let browser: Awaited<ReturnType<typeof launchBrowser>>;
before(async () => { process.env.TURNSTILE_SITE_KEY = "1x00000000000000000000AA"; srv = await startServer(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); await srv?.stop(); delete process.env.TURNSTILE_SITE_KEY; });

// Stand-in for api.js: explicit or implicit rendering; normal = 300px, flexible = 100% (min 300px), compact = 150px.
const FAKE = `(()=>{const q=new URL(document.currentScript.src).searchParams;window.turnstile={render(el,o){o=o||{};const f=document.createElement("iframe");f.title="bot check";f.style.border="0";f.style.display="block";f.style.height=o.size==="compact"?"140px":"65px";f.style.width=o.size==="compact"?"150px":o.size==="flexible"?"100%":"300px";if(o.size==="flexible")f.style.minWidth="300px";el.appendChild(f);el.dataset.size=o.size||"normal";const i=document.createElement("input");i.type="hidden";i.name="cf-turnstile-response";i.value="pass";el.appendChild(i);return "w"}};if(q.get("render")!=="explicit")document.querySelectorAll(".cf-turnstile").forEach((el)=>window.turnstile.render(el,{}));else if(window[q.get("onload")])window[q.get("onload")]()})();`;
const PAGES = ["/", "/services", "/services/ai-receptionist", "/pricing", "/pricing/compare", "/portfolio", "/process", "/about", "/contact", "/faq", "/quote", "/login", "/register", "/password/forgot", "/legal", "/legal/privacy"];

test("[BRAND-006] [TEST-003] no public page overflows horizontally at 320, 360, 375 or 390px, bot check included", async () => {
  const problems: string[] = [];
  for (const width of [320, 360, 375, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await ctx.route("https://challenges.cloudflare.com/**", (r: { fulfill(o: unknown): Promise<void> }) => r.fulfill({ contentType: "text/javascript", body: FAKE }));
    const p = await ctx.newPage();
    for (const path of PAGES) {
      await p.goto(srv.base + path, { waitUntil: "load" });
      await p.waitForTimeout(250);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - window.screen.width);
      if (over > 0) problems.push(`${width}px ${path}: ${over}px wider than the screen`);
    }
    await ctx.close();
  }
  assert.deepEqual(problems, []);
});

test("[BRAND-006] the bot check renders compact where its field is narrower than 300px and flexible where it fits, and still yields its token", async () => {
  for (const [width, want] of [[375, "compact"], [1440, "flexible"]] as const) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.route("https://challenges.cloudflare.com/**", (r: { fulfill(o: unknown): Promise<void> }) => r.fulfill({ contentType: "text/javascript", body: FAKE }));
    const p = await ctx.newPage();
    await p.goto(srv.base + "/register", { waitUntil: "load" });
    await p.waitForTimeout(250);
    assert.equal(await p.locator(".cf-turnstile").getAttribute("data-size"), want, `${width}px`);
    assert.equal(await p.locator("[name=cf-turnstile-response]").count(), 1);
    await ctx.close();
  }
});
