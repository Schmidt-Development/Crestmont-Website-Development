// Real-browser journeys for the shared core (Chromium via Playwright, against dev/server.ts).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, launchBrowser, latestEmail, linkIn } from "./support.ts";
import { hashPassword, totpCode, newTotpSecret } from "../../src/lib/auth-crypto.ts";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PORTFOLIO_PROJECTS } from "../../src/content/portfolio-projects.ts";

type Server = Awaited<ReturnType<typeof startServer>>;
let srv: Server;
let browser: Awaited<ReturnType<typeof launchBrowser>>;

before(async () => { srv = await startServer(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); await srv?.stop(); });

const PW = "e2e-test-password-123";

test("[BRAND-001] header shows the original crest artwork at exactly 2x pixel density (sharp on retina)", async () => {
  const ctx = await browser.newContext({ deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(srv.base + "/login");
  const img = page.locator("img.brand__mark").first();
  const info = await img.evaluate((el: HTMLImageElement) => ({ natural: el.naturalWidth, naturalH: el.naturalHeight, shown: el.getBoundingClientRect().width, shownH: el.getBoundingClientRect().height, complete: el.complete, src: el.getAttribute("src") }));
  assert.equal(info.src, "/assets/brand/crestmont-crest.png");
  assert.ok(info.complete && info.natural === 84 && info.naturalH === 82, `loaded original crop ${JSON.stringify(info)}`);
  assert.ok(info.natural / info.shown >= 2 - 1e-6, `never upscaled: ${info.natural}px source shown at ${info.shown}px`);
  // The artwork has an opaque #0d0d0d background, so the surface directly behind it must be exactly that black
  // (since design v3 the pages are light and the crest sits in a #0d0d0d tile — docs/frontend/DESIGN.md §2).
  const bg = await img.evaluate((el: HTMLElement) => {
    for (let e: HTMLElement | null = el.parentElement; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c; }
    return getComputedStyle(document.body).backgroundColor;
  });
  assert.equal(bg, "rgb(13, 13, 13)", "the surface behind the crest matches the logo artwork background");
  await ctx.close();
});

test("[AUTH-001] browser journey: register → confirm email from outbox → sign in", async () => {
  const page = await browser.newPage();
  const email = `e2e${Date.now()}@example.com`;
  await page.goto(srv.base + "/register");
  await page.fill("#f-name", "Avery Example");
  await page.fill("#f-organization", "Example Landscaping");
  await page.fill("#f-email", email);
  await page.fill("#f-password", PW);
  await page.check("input[name=terms]");
  await Promise.all([page.waitForLoadState("load"), page.click("button[type=submit]")]);
  assert.match(await page.textContent("h1") ?? "", /Check your email/);
  const mail = latestEmail(srv.db, email);
  assert.equal(mail?.template, "verification");
  await page.goto(linkIn(mail!.text_body, srv.base, "/verify-email"));
  assert.match(page.url(), /\/login$/);
  await page.fill("#f-email", email);
  await page.fill("#f-password", PW);
  await Promise.all([page.waitForURL(/\/portal/), page.click("button[type=submit]")]);
  assert.match(page.url(), /\/portal/);
  await page.close();
});

test("[AUTH-003] browser journey: staff sign-in requires a TOTP code", async () => {
  const secret = newTotpSecret();
  const now = new Date().toISOString();
  srv.db.exec(`INSERT OR IGNORE INTO organizations (id, name, kind, created_at) VALUES ('org_crestmont','Crestmont Website Development','internal','${now}')`);
  srv.db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, totp_secret, mfa_enabled, created_at) VALUES ('usr_e2e_pm','pm.e2e@crestmont.test','E2E PM',?,?,?,1,?)`).run(await hashPassword(PW), now, secret, now);
  srv.db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES ('mbr_e2e_pm','usr_e2e_pm','org_crestmont','project_manager',?)`).run(now);
  const page = await browser.newPage();
  await page.goto(srv.base + "/login");
  await page.fill("#f-email", "pm.e2e@crestmont.test");
  await page.fill("#f-password", PW);
  await Promise.all([page.waitForURL(/\/mfa/), page.click("button[type=submit]")]);
  await page.fill("#f-code", "000000");
  await Promise.all([page.waitForLoadState("load"), page.click("button[type=submit]")]);
  assert.match(await page.content(), /That code is not valid/);
  await page.fill("#f-code", await totpCode(secret));
  await Promise.all([page.waitForURL((u: URL) => !u.pathname.startsWith("/mfa")), page.click("button[type=submit]")]);
  assert.match(page.url(), /\/staff/);
  await page.close();
});

test("[TEST-003] auth pages are usable at phone width and pass basic accessibility checks", async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 3, isMobile: true });
  const page = await ctx.newPage();
  for (const path of ["/login", "/register", "/password/forgot"]) {
    await page.goto(srv.base + path);
    const r = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      lang: document.documentElement.lang,
      h1: document.querySelectorAll("h1").length,
      unlabeled: [...document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]), select, textarea")].filter((el) => !(el.id && document.querySelector(`label[for="${el.id}"]`)) && !el.closest("label")).length,
      imgsNoAlt: [...document.querySelectorAll("img")].filter((i) => !i.hasAttribute("alt")).length,
      smallTargets: [...document.querySelectorAll("button, .btn")].filter((b) => b.getBoundingClientRect().height > 0 && b.getBoundingClientRect().height < 34).length,
    }));
    assert.ok(r.overflow <= 0, `${path}: no horizontal scroll (${r.overflow}px)`);
    assert.equal(r.lang, "en");
    assert.equal(r.h1, 1, `${path}: exactly one h1`);
    assert.equal(r.unlabeled, 0, `${path}: every field has a label`);
    assert.equal(r.imgsNoAlt, 0, `${path}: every image has alt`);
    assert.equal(r.smallTargets, 0, `${path}: touch targets at least 34px tall`);
  }
  await ctx.close();
});

// ───────────── Frontend closeout (docs/closeout/AUDIT-2026-10-29.md §C) ─────────────
let portfolioSeeded = false;
function seedPortfolio() {
  if (portfolioSeeded) return;
  const out = join(mkdtempSync(join(tmpdir(), "e2e-pf-")), "setup.sql");
  execFileSync(process.execPath, ["--no-warnings", "scripts/portfolio-setup.ts", "--out", out, "--origins", PORTFOLIO_PROJECTS.map((p) => new URL(p.demoUrl).origin).join(" ")], { stdio: "pipe" });
  srv.db.exec(readFileSync(out, "utf8"));
  portfolioSeeded = true;
}
type Box = { w: number; h: number; t: string };

test("[BRAND-006] [TEST-003] 390px phone: the audited controls are at least 44×44 px — portfolio device and project buttons, About journey stops, simulation buttons, assistant controls, small buttons (CREST-GAP-045)", async () => {
  seedPortfolio();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const small: string[] = [];
  const measure = async (where: string, sel: string, min = 1) => {
    const boxes: Box[] = await page.$$eval(sel, (els: Element[]) => els.map((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, t: `${e.className} "${(e.textContent || "").trim().slice(0, 24)}"` }; }).filter((b) => b.w > 0 && b.h > 0));
    assert.ok(boxes.length >= min, `${where}: ${sel} is visible (${boxes.length})`);
    for (const b of boxes) if (b.w < 44 - 0.5 || b.h < 44 - 0.5) small.push(`${where} ${sel}: ${Math.round(b.w)}×${Math.round(b.h)} ${b.t}`);
  };
  await page.goto(srv.base + "/portfolio");
  await measure("/portfolio", ".pfx__seg .pfx__tool", 3);
  await measure("/portfolio", ".pfx__page", 2);
  await measure("/portfolio", ".pfx__tools > .pfx__tool", 1);
  await page.goto(srv.base + "/about");
  await measure("/about", ".jr__stop", 5);
  await page.goto(srv.base + "/services/ai-receptionist");
  await measure("/services/ai-receptionist", ".sv__opt--sm", 1);
  await measure("/services/ai-receptionist", ".site-footer .btn--sm", 1);
  // Assistant: open the panel and measure its controls.
  await page.locator("[data-cb-launch]").waitFor({ state: "visible" });
  await page.click("[data-cb-launch]");
  await page.locator("[data-cb-panel]").waitFor({ state: "visible" });
  await page.waitForTimeout(500); // the panel's 340ms opening scale animation
  await measure("assistant", ".cb__icon, .cb__send", 3);
  await measure("assistant", ".cb__foot a", 2);
  await measure("assistant", ".cb__chip, .cb__links a", 1);
  assert.deepEqual(small, [], "controls below 44×44 px");
  await ctx.close();
});

test("[PORT-006] [TEST-003] expanded portfolio view is a modal dialog: focus starts at Close, the background is inert, Tab stays inside, Escape closes and returns focus (CREST-GAP-076)", async () => {
  seedPortfolio();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(srv.base + "/portfolio");
  await page.locator("[data-pfx] [data-pfx-expand]").first().click();
  const state = () => page.evaluate(() => {
    const root = document.querySelector("[data-pfx]")!, a = document.activeElement as HTMLElement | null;
    const inert = (sel: string) => (document.querySelector(sel) as HTMLElement & { inert: boolean }).inert;
    return { expanded: root.classList.contains("pfx--expanded"), role: root.getAttribute("role"), modal: root.getAttribute("aria-modal"), label: root.getAttribute("aria-label"), active: a?.textContent ?? null, headerInert: inert(".site-header"), footerInert: inert(".site-footer") };
  });
  const open = await state();
  assert.equal(open.role, "dialog"); assert.equal(open.modal, "true"); assert.match(open.label ?? "", /^Expanded view: /);
  assert.equal(open.active, "Close expanded view", "focus starts at Close");
  assert.ok(open.headerInert && open.footerInert, "the page behind the overlay is inert");
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press(i % 7 === 6 ? "Shift+Tab" : "Tab");
    const inside = await page.evaluate(() => { const a = document.activeElement; return !!a && a !== document.body && document.querySelector("[data-pfx]")!.contains(a); });
    assert.ok(inside, `Tab ${i + 1}: focus stays inside the overlay`);
  }
  await page.keyboard.press("Escape");
  const closed = await state();
  assert.deepEqual({ ...closed, label: undefined }, { expanded: false, role: "region", modal: null, label: undefined, active: "Expand", headerInert: false, footerInert: false });
  assert.equal(closed.label, "Portfolio projects");
  await ctx.close();
});

test("[BRAND-006] [TEST-003] without JavaScript the primary navigation is visible at 390px (CREST-GAP-077); case-study screenshots reserve their space (CREST-GAP-078)", async () => {
  seedPortfolio();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto(srv.base + "/pricing");
  const nav = await page.evaluate(() => {
    const navEl = document.getElementById("site-nav")!;
    const links = [...navEl.querySelectorAll("a")].map((a) => { const r = a.getBoundingClientRect(); return { t: (a.textContent || "").trim(), w: r.width, h: r.height, vis: getComputedStyle(a).visibility }; });
    return { links, opacity: Number(getComputedStyle(navEl).opacity), toggle: getComputedStyle(document.querySelector(".site-header .nav-toggle")!).display, overflow: document.documentElement.scrollWidth - innerWidth };
  });
  assert.equal(nav.toggle, "none", "the script-only Menu button is hidden");
  assert.equal(nav.opacity, 1);
  assert.ok(nav.links.length >= 7);
  for (const l of nav.links) assert.ok(l.w > 0 && l.h >= 44 - 0.5 && l.vis === "visible", `nav link visible and tappable: ${JSON.stringify(l)}`);
  assert.ok(nav.overflow <= 0, `no horizontal scroll (${nav.overflow}px)`);
  await page.goto(srv.base + "/portfolio/lansing-car-rentals");
  const shots: { w: string | null; h: string | null; box: number }[] = await page.$$eval(".case-shots img", (imgs: HTMLImageElement[]) => imgs.map((i) => ({ w: i.getAttribute("width"), h: i.getAttribute("height"), box: i.getBoundingClientRect().height })));
  assert.equal(shots.length, 2);
  for (const s of shots) assert.ok(s.w && s.h && s.box > 50, `screenshot has intrinsic size and reserved height: ${JSON.stringify(s)}`);
  await ctx.close();
});
