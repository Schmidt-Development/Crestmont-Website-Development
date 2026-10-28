// Real-browser verification of the deployed frontend preview (deploy-frontend-preview.yml). Runs on the GitHub runner,
// which can reach the preview; signs in through the preview password gate by cookie (nothing is typed on screen), then
// drives the hosted pages at phone and desktop sizes. Produces screenshots and recorded tours (no credentials appear in
// them) and one annotation with the results. Exit 1 if any check fails.
//
//   PREVIEW_PASSWORD=… PLAYWRIGHT_MODULE=… node scripts/frontend-preview-browser.mjs <base-url> <out-dir>
import fs from "node:fs";
// Any crash is reported as an annotation (the job log is not always readable where the results are reviewed).
const crash = (e) => { console.log(`::error title=Browser verification crashed::${String(e?.stack || e).replace(/\n/g, " | ").slice(0, 1500)}`); process.exit(1); };
process.on("uncaughtException", crash); process.on("unhandledRejection", crash);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { checkLocation, checkInteractive, checkFlow } = await import("./preview-explorer-checks.mjs");
const { checkConstellation } = await import("./preview-about-checks.mjs");
const base = (process.argv[2] ?? "").replace(/\/$/, ""), out = process.argv[3] ?? "preview-browser";
const pw = process.env.PREVIEW_PASSWORD ?? "";
const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base); // dry runs against dev/server.ts (no gate)
if (!local && (!/^https:\/\//.test(base) || !pw)) { console.log("::error::usage: PREVIEW_PASSWORD=… frontend-preview-browser.mjs <https base> <out>"); process.exit(1); }
fs.mkdirSync(`${out}/video`, { recursive: true }); fs.mkdirSync(`${out}/screens`, { recursive: true });
process.env.PREVIEW_SHOTS = `${out}/screens`;

// Gate cookie (same flow as scripts/frontend-preview-check.ts).
let gate = "";
for (let i = 0; i < 12 && !gate && !local; i++) {
  const r = await fetch(`${base}/__preview-access`, { method: "POST", redirect: "manual", body: new URLSearchParams({ password: pw, next: "/" }) });
  for (const c of r.headers.getSetCookie()) if (c.startsWith("cm_preview=")) gate = c.split(";")[0].slice("cm_preview=".length);
  if (!gate) await new Promise((r) => setTimeout(r, 5000));
}
if (!gate && !local) { console.log("::error::the preview did not accept the preview password"); process.exit(1); }
const host = new URL(base).hostname;

const results = [], fails = [];
const ok = (cond, msg) => { (cond ? results : fails).push(msg); console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); };
const step = async (label, fn) => { try { await fn(); } catch (e) { ok(false, `${label}: ${String(e.message).split("\n")[0].slice(0, 200)}`); } };
const b = await chromium.launch();
async function context(name, viewport, mobile, extra = {}) {
  const ctx = await b.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1, recordVideo: { dir: `${out}/video/${name}`, size: viewport }, ...extra });
  if (!local) await ctx.addCookies([{ name: "cm_preview", value: gate, domain: host, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  return ctx;
}
const PAGES = ["/", "/services", "/services/ai-receptionist", "/pricing", "/pricing/compare", "/portfolio", "/process", "/about", "/contact", "/faq"];

const demoStates = {};
for (const [name, viewport, mobile] of [["desktop", { width: 1440, height: 900 }, false], ["phone", { width: 390, height: 844 }, true]]) {
  const ctx = await context(name, viewport, mobile); const p = await ctx.newPage();
  const errors = []; p.on("pageerror", (e) => errors.push(`${p.url()}: ${e.message}`)); p.on("console", (m) => { if (m.type() === "error") errors.push(`${p.url()}: ${m.text()}`); });
  // 1. Every key page renders, scrolls without horizontal overflow, and carries the assistant launcher.
  for (const path of PAGES) {
    const res = await p.goto(base + path, { waitUntil: "networkidle" });
    await p.waitForTimeout(600);
    const m = await p.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, launcher: !!document.querySelector("[data-cb-launch]") }));
    ok(res.status() === 200 && m.overflow <= 0 && m.launcher, `${name} ${path}: 200, no horizontal overflow, assistant present`);
    await p.screenshot({ path: `${out}/screens/${name}${path.replace(/\//g, "_") || "_home"}.png`, fullPage: false });
  }
  await step(`${name} pricing`, async () => {
  // 2. Pricing: no dash under a higher package where a lower one is included.
  await p.goto(base + "/pricing/compare", { waitUntil: "networkidle" });
  const inherit = await p.evaluate(() => [...document.querySelectorAll("[data-compare] tbody tr")].filter((tr) => tr.querySelectorAll("td").length === 3 && tr.querySelector(".toggletip")).every((tr) => {
    const c = [...tr.querySelectorAll("td")].map((td) => td.classList.contains("compare__no")); const first = c.indexOf(false); return first < 0 || c.slice(first).every((x) => !x); }));
  ok(inherit, `${name} pricing comparison: packages are cumulative in every row`);
  });
  await step(`${name} portfolio`, async () => {
  // 3. Portfolio explorer at every location (home, portfolio, each case study): full width, arrows outside the frame,
  //    honest state; then, on the portfolio page, every interactive demo: scrolling containment (wheel on desktop,
  //    finger swipes on the phone), navigation, reset, device controls and — on desktop — its simulated transaction.
  await p.goto(base + "/portfolio", { waitUntil: "domcontentloaded" });
  const cases = await p.$$eval("a[href^='/portfolio/']", (a) => [...new Set(a.map((x) => new URL(x.href).pathname))].filter((x) => x.split("/").length === 3));
  for (const path of ["/", "/portfolio", ...cases]) {
    const states = await checkLocation(p, base, path, name, ok);
    if (path === "/portfolio") demoStates[name] = states;
  }
  await p.goto(base + "/portfolio", { waitUntil: "domcontentloaded" }); await p.locator(".pfx").scrollIntoViewIfNeeded();
  const n = await p.locator(".pfx__slide").count();
  for (let i = 0; i < n; i++) {
    if (i) { await p.locator("[data-pfx-next]").first().click(); await p.waitForTimeout(700); }
    for (let k = 0; k < 80; k++) { if (await p.evaluate(() => { const s = document.querySelector(".pfx__slide:not([inert])"); return s.classList.contains("is-ready") || s.dataset.unavailable === "true" || !s.dataset.demoUrl; })) break; await p.waitForTimeout(400); }
    if (!(await p.evaluate(() => document.querySelector(".pfx__slide:not([inert])").classList.contains("is-ready")))) continue;
    await step(`${name} interactive demo ${i + 1}`, () => checkInteractive(p, `${name} /portfolio`, ok, { touch: mobile }));
    if (!mobile) await step(`${name} simulated transaction ${i + 1}`, () => checkFlow(p, `${name} /portfolio`, ok));
  }
  });
  await step(`${name} receptionist`, async () => {
  // 4. AI Receptionist: the call plays and finishes with a summary.
  await p.goto(base + "/services/ai-receptionist", { waitUntil: "networkidle" });
  const rc = p.locator("#sv-rc-page"); await rc.scrollIntoViewIfNeeded();
  await rc.getByRole("button", { name: "Replay" }).click();
  for (let i = 0; i < 14; i++) await rc.getByRole("button", { name: "Next line" }).click();
  ok(await rc.locator(".rc-scn[data-on] .rc-summary.is-in").count() === 1, `${name} AI Receptionist call completes with a summary`);
  });
  await step(`${name} assistant`, async () => {
  // 5. Assistant: opens, states honestly whether live answers are on; never shows an AI answer without one.
  await p.evaluate(() => scrollTo(0, 0));
  await p.locator("[data-cb-launch]").click(); await p.waitForTimeout(1200);
  const status = await p.locator("[data-cb-status]").textContent();
  const live = /^AI ·/.test(status);
  ok(live || (/off/.test(status) && await p.locator("[data-cb-input]").isDisabled()), `${name} assistant state: ${live ? "live answers on" : "live answers off (honest offline state)"}`);
  await p.locator("[data-cb-close]").click();
  });
  await step(`${name} about`, async () => {
  // 6. About: interactions respond and the CRESTMONT wordmark is preserved.
  await p.goto(base + "/about", { waitUntil: "networkidle" });
  await p.locator("#sv-constellation [data-cst=ai]").click();
  await p.locator("#sv-journey").getByRole("button", { name: "Next step" }).click();
  await p.locator("#lab").getByRole("tab", { name: "Accessibility" }).click(); await p.locator("#lab").getByRole("button", { name: "Check contrast" }).click();
  const about = await p.evaluate(() => ({ cst: document.querySelector("#sv-constellation .cst").dataset.node, jr: document.querySelector("#sv-journey .jr").dataset.step, ratios: document.querySelectorAll("#lab [data-lab-ratios] li.ok").length, word: document.querySelector(".footer-word")?.textContent }));
  ok(about.cst === "ai" && about.jr === "1" && about.ratios === 4 && about.word === "CRESTMONT", `${name} About: constellation, journey, live contrast checks; wordmark preserved`);
  });
  await step(`${name} about diagram`, () => checkConstellation(p, base, name, ok, { touch: mobile }));
  await step(`${name} contact`, async () => {
  // 7. Contact: a safe test submission to the disposable preview database reaches the thank-you page.
  if (name === "desktop") {
    await p.goto(base + "/contact", { waitUntil: "networkidle" });
    await p.locator("#f-name").fill("Preview Check"); await p.locator("#f-email").fill("preview-check@example.com");
    await p.locator(".cx-chip", { hasText: "Something else" }).click();
    await p.locator("#f-message").fill("Automated preview verification — please ignore.");
    const turnstile = await p.locator(".cf-turnstile").count();
    if (turnstile) ok(true, "contact: Turnstile is configured on the preview (automated submission skipped)");
    else {
      const nav = p.waitForURL("**/contact/thanks", { timeout: 20000 }).then(() => true).catch(() => false);
      await p.locator("[data-cx-send]").click({ noWaitAfter: true });
      ok(await nav, "contact: test submission accepted and the thank-you page shown");
    }
  }
  });
  ok(errors.length === 0, `${name}: no console or page errors${errors.length ? ` (${errors.slice(0, 3).join(" | ")})` : ""}`);
  await ctx.close();
}

// Laptop (1180px, where Glassly was shown at the tablet layout) and touch tablet: explorer framing and the About diagram.
for (const [name, viewport, mobile] of [["laptop", { width: 1180, height: 820 }, false], ["tablet", { width: 820, height: 1180 }, true]]) {
  const ctx = await context(name, viewport, mobile); const p = await ctx.newPage();
  const errors = []; p.on("pageerror", (e) => errors.push(`${p.url()}: ${e.message}`));
  await step(`${name} portfolio`, async () => {
    for (const path of ["/", "/portfolio", "/portfolio/glassly-auto-glass"]) {
      await checkLocation(p, base, path, name, ok);
      const mode = await p.evaluate(() => document.querySelector(".pfx").dataset.mode);
      ok(mode === (name === "laptop" ? "desktop" : "tablet"), `${name} ${path}: the explorer shows the ${name === "laptop" ? "desktop" : "tablet"} layout (${mode})`);
    }
  });
  await step(`${name} about diagram`, () => checkConstellation(p, base, name, ok, { touch: mobile }));
  ok(errors.length === 0, `${name}: no page errors${errors.length ? ` (${errors.slice(0, 2).join(" | ")})` : ""}`);
  await ctx.close();
}

// Reduced motion: animations settle to their final state; the explorer moves without transition.
{
  const ctx = await context("reduced-motion", { width: 1440, height: 900 }, false, { reducedMotion: "reduce" }); const p = await ctx.newPage();
  await step("reduced motion", async () => {
    await p.goto(base + "/services/ai-receptionist", { waitUntil: "domcontentloaded" }); await p.locator("#sv-rc-page").scrollIntoViewIfNeeded(); await p.waitForTimeout(800);
    ok(await p.locator("#sv-rc-page .rc-scn[data-on] .rc-summary.is-in").count() === 1, "reduced motion: the receptionist call shows its final state without playing");
    await p.goto(base + "/portfolio", { waitUntil: "domcontentloaded" });
    const tr = await p.evaluate(() => { const c = getComputedStyle(document.querySelector("[data-pfx-track]")); return { prop: c.transitionProperty, dur: c.transitionDuration }; });
    ok(tr.prop === "none" || tr.dur.split(",").every((d) => parseFloat(d) < 0.01), `reduced motion: switching projects has no sliding transition (${tr.prop}, ${tr.dur})`);
    await checkConstellation(p, base, "reduced-motion", ok);
    ok((await p.evaluate(() => getComputedStyle(document.querySelector("#sv-constellation .cst__link.is-on") || document.body).animationName)) === "none", "reduced motion: the diagram's connector animation is off");
  });
  await ctx.close();
}
await b.close();
const demoLine = Object.entries(demoStates.desktop ?? {}).map(([k, v]) => `${k}: ${v}`).join(" | ");
if (demoLine) console.log(`::notice title=Portfolio demos on this preview::${demoLine}`);
const summary = `Hosted browser verification — ${results.length} passed, ${fails.length} failed`;
console.log(`::notice title=${summary}::${fails.length ? fails.map((f) => `FAIL ${f}`).join(" | ").slice(0, 3800) : "All checks passed."}`);
// Passing checks in groups (annotations are limited in number and length; the step summary has the full list).
const groups = {};
for (const r of results) { const g = /portfolio|demo|frame|explorer|transaction|Reset|scroll/i.test(r) ? "Portfolio" : /About/.test(r) ? "About" : "Pages and interactions"; (groups[g] ??= []).push(r); }
for (const [g, list] of Object.entries(groups)) console.log(`::notice title=${g} — ${list.length} passed::${list.join(" | ").slice(0, 3800)}`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${summary}\n\n${[...fails.map((f) => `- ❌ ${f}`), ...results.map((r) => `- ✅ ${r}`)].join("\n")}\n\nRecorded tours and screenshots are in the \`frontend-preview-browser\` artifact (no credentials appear in them).\n`);
process.exit(fails.length ? 1 : 0);
