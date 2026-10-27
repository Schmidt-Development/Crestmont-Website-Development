// Real-browser journeys for the shared core (Chromium via Playwright, against dev/server.ts).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, launchBrowser, latestEmail, linkIn } from "./support.ts";
import { hashPassword, totpCode, newTotpSecret } from "../../src/lib/auth-crypto.ts";

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
