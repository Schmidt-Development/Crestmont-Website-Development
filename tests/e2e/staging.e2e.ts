// Browser journey against the deployed, PUBLIC staging site (TEST-002 staging evidence; no preview password since 2026-10-28).
// Runs only when pointed at staging:
//   E2E_BASE_URL          https://crestmont-platform-staging.<subdomain>.workers.dev
//   E2E_ACCOUNTS_FILE     demo-accounts.md written by scripts/seed-staging.ts
// With EVIDENCE_ENVIRONMENT=staging the results are recorded as staging evidence. Without the
// variables the suite reports itself skipped, so local `npm run e2e` is unaffected.
// Read-only by design: it signs in and views pages; it never submits business forms on staging.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./support.ts";
import { totpCode } from "../../src/lib/auth-crypto.ts";

const BASE = process.env.E2E_BASE_URL?.replace(/\/$/, "");
const ACCOUNTS = process.env.E2E_ACCOUNTS_FILE;
const skip = !BASE || !ACCOUNTS ? "E2E_BASE_URL / E2E_ACCOUNTS_FILE not set" : false;

type Page = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Playwright is loaded at runtime (zero-dependency repo)
type Account = { role: string; email: string; password: string; totp?: string };
function accounts(): Account[] {
  const md = readFileSync(ACCOUNTS!, "utf8");
  return [...md.matchAll(/^\| (\w+) \| (\S+) \| `([^`]+)` \| (?:`([A-Z2-7]+)`|—) \|/gm)].map((m) => ({ role: m[1], email: m[2], password: m[3], totp: m[4] }));
}

let browser: Awaited<ReturnType<typeof launchBrowser>>;
before(async () => { if (!skip) browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

/** A fresh browser context with NO cookies or credentials: the public website must load directly. */
async function previewContext() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const r = await page.goto(BASE + "/");
  assert.equal(r?.status(), 200, "public homepage loads for a fresh visitor");
  assert.doesNotMatch(await page.content(), /Preview password|__preview-access/, "no preview password prompt");
  assert.equal(r?.headers()["x-robots-tag"], "noindex, nofollow", "staging is not indexable");
  return { ctx, page };
}

async function signIn(page: Page, a: Account) {
  await page.goto(BASE + "/login");
  await page.fill("#f-email", a.email);
  await page.fill("#f-password", a.password);
  await Promise.all([page.waitForLoadState("load"), page.click("button[type=submit]")]);
  if (new URL(page.url()).pathname.startsWith("/mfa")) {
    assert.ok(a.totp, `${a.role} needs a TOTP key`);
    // Codes are single-use per 30 s step: wait for a fresh step so a recent sign-in cannot collide.
    const left = 30 - (Math.floor(Date.now() / 1000) % 30);
    await new Promise((r) => setTimeout(r, (left + 1) * 1000));
    await page.fill("#f-code", await totpCode(a.totp!));
    await Promise.all([page.waitForLoadState("load"), page.click("button[type=submit]")]);
  }
  assert.doesNotMatch(new URL(page.url()).pathname, /^\/(login|mfa)/, `signed in as ${a.role}`);
}

test("[TEST-002] public staging: fresh visitor sees the site; customer portal and Owner command center still need their own sign-in", { skip }, async () => {
  const { ctx, page } = await previewContext();
  // Every public page linked from the homepage header and footer must load.
  await page.goto(BASE + "/");
  const publicPages: string[] = await page.$$eval("header a[href^='/'], footer a[href^='/']", (as: Element[]) =>
    [...new Set(as.map((a) => a.getAttribute("href")!.split("#")[0]))].filter((h: string) => h && !/^\/(staff|portal|login|register|logout)/.test(h)));
  assert.ok(publicPages.length >= 5, `public navigation found: ${publicPages.join(", ")}`);
  for (const p of publicPages) {
    const r = await page.goto(BASE + p);
    assert.ok(r && r.status() < 400, `${p} → ${r?.status()}`);
  }
  // Protected areas still require their own sign-in.
  for (const p of ["/staff", "/portal"]) {
    await page.goto(BASE + p);
    assert.match(new URL(page.url()).pathname, /^\/login/, `${p} redirects an anonymous visitor to sign-in`);
  }

  const all = accounts();
  const customer = all.find((a) => a.email.startsWith("customer.harbor"))!;
  await signIn(page, customer);
  await page.goto(BASE + "/portal/projects");
  const projects = await page.content();
  assert.match(projects, /Harbor Dental/);
  assert.doesNotMatch(projects, /Ridgeline/, "tenant isolation on staging");
  await ctx.close();

  const o = await previewContext();
  await signIn(o.page, all.find((a) => a.role === "owner")!);
  const hrefs: string[] = await o.page.$$eval("nav a[href^='/staff']", (as: Element[]) => [...new Set(as.map((a) => a.getAttribute("href")!))]);
  assert.ok(hrefs.length >= 32, `Owner navigation lists ${hrefs.length} modules`);
  for (const h of hrefs) {
    const r = await o.page.goto(BASE + h);
    assert.equal(r?.status(), 200, h);
  }
  await o.ctx.close();
});
