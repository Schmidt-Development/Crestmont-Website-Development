// Focused visual check of the purchase pages (not part of `npm test`; Chromium from the preinstalled Playwright):
// /checkout/<package>/intake and /review rendered by the real app for a signed-in new customer, screenshotted at desktop,
// tablet and phone widths, with layout assertions (no horizontal page scroll, no control wider than its card, headings
// inside their sections, buttons not overlapping).
//   node --no-warnings tests/ui/checkout-pages.ui.ts <out-dir> [package]
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
import { createTestApp, createCustomer, TEST_PASSWORD } from "../support/app.ts";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const out = process.argv[2] ?? "evidence/ui"; const pkg = process.argv[3] ?? "business";
mkdirSync(out, { recursive: true });
const t = await createTestApp({ STRIPE_SECRET_KEY: "sk_test_ui_check", STRIPE_WEBHOOK_SECRET: "whsec_ui_check" } as never);
const cust = await createCustomer(t.db, "new.customer@example.com", "Harbor Coffee Roasters");
const c = await t.client().login(cust.email, TEST_PASSWORD, cust.secret);
const intakeHtml = await (await c.get(`/checkout/${pkg}/intake`)).text();
const answers: Record<string, string> = {
  business_name: "Harbor Coffee Roasters", contact_name: "Morgan Reyes", contact_email: "new.customer@example.com", contact_phone: "(517) 555-0142",
  industry: "Coffee roastery and café", business_description: "Small-batch roaster with a café in Lansing.", existing_website: "https://harbor-coffee.example",
  goals: "More wholesale enquiries and online orders.", target_audience: "Local coffee drinkers and cafés.", has_branding: "no", brand_style: "Warm, modern, craft.",
  design_preferences: "Large photography, minimal text.", pages: "Home\nAbout\nMenu\nWholesale\nContact", content_source: "crestmont_draft", images_source: "licensed",
  domain_status: "need", domain_wishes: "harborcoffee.example", hosting: "crestmont", special_instructions: "None.", intent: "submit",
};
const sub = await c.post(`/checkout/${pkg}/intake`, answers);
const reviewHtml = await (await c.get(`/checkout/${pkg}/review`)).text();
const b = await chromium.launch();
const problems: string[] = [];
for (const [name, html] of [["intake", intakeHtml], ["review", reviewHtml]] as const) {
  for (const vp of [{ w: 1440, h: 900, m: false, n: "desktop" }, { w: 820, h: 1180, m: true, n: "tablet" }, { w: 390, h: 844, m: true, n: "phone" }]) {
    const ctx = await b.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: vp.m, hasTouch: vp.m, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.route("**/*", async (r: any) => {
      const u = new URL(r.request().url());
      if (u.pathname.startsWith("/assets/")) { try { return r.fulfill({ status: 200, body: readFileSync(`public${u.pathname}`), contentType: u.pathname.endsWith(".js") ? "text/javascript" : u.pathname.endsWith(".css") ? "text/css" : u.pathname.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream" }); } catch { return r.fulfill({ status: 404 }); } }
      if (u.pathname.startsWith("/checkout/")) return r.fulfill({ status: 200, body: html, contentType: "text/html" });
      return r.fulfill({ status: 404, body: "" });
    });
    const errors: string[] = []; p.on("pageerror", (e: Error) => errors.push(e.message));
    await p.goto(`http://crestmont.test/checkout/${pkg}/${name}`);
    await p.waitForTimeout(300);
    const found = await p.evaluate(() => {
      const issues: string[] = [];
      const doc = document.documentElement;
      if (doc.scrollWidth > doc.clientWidth + 1) issues.push(`page scrolls horizontally (${doc.scrollWidth} > ${doc.clientWidth})`);
      const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      for (const card of document.querySelectorAll("main .card, main fieldset")) {
        const cr = card.getBoundingClientRect();
        for (const el of card.querySelectorAll("input, textarea, select, button, label, legend, h2, h3, p, .hint")) {
          if (!vis(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.left < cr.left - 1 || r.right > cr.right + 1) issues.push(`${el.tagName.toLowerCase()}${el.getAttribute("name") ? `[name=${el.getAttribute("name")}]` : ""} "${(el.textContent ?? "").trim().slice(0, 30)}" extends outside its card (${Math.round(r.left)}–${Math.round(r.right)} vs ${Math.round(cr.left)}–${Math.round(cr.right)})`);
          if ((el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 2 && /^(P|LABEL|LEGEND|H2|H3)$/.test(el.tagName)) issues.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}" text overflows`);
        }
        const legend = card.querySelector(":scope > legend");
        if (legend && vis(legend)) { const lr = legend.getBoundingClientRect(); if (lr.top < cr.top - 2) issues.push(`legend "${legend.textContent?.trim().slice(0, 30)}" floats above its card (${Math.round(cr.top - lr.top)}px)`); }
      }
      const btns = [...document.querySelectorAll("main button, main .btn")].filter(vis).map((x) => x.getBoundingClientRect());
      for (let i = 0; i < btns.length; i++) for (let j = i + 1; j < btns.length; j++) {
        const a = btns[i], c = btns[j];
        if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) issues.push("two buttons overlap");
      }
      return issues;
    });
    for (const f of [...new Set(found)].slice(0, 25)) problems.push(`${name} ${vp.n}: ${f}`);
    for (const e of errors) problems.push(`${name} ${vp.n}: page error ${e}`);
    await p.screenshot({ path: `${out}/${name}-${vp.n}.png`, fullPage: true });
    await ctx.close();
  }
}
await b.close();
console.log(JSON.stringify({ intakeSubmit: sub.status, reviewHasPay: /Pay \$/.test(reviewHtml), problems }, null, 1));
