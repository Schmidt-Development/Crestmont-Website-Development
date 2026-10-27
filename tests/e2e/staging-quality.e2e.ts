// Content, visual-consistency and accessibility checks against the DEPLOYED staging preview (WEB-009, TEST-003, BRAND-006).
//   E2E_BASE_URL, E2E_PREVIEW_PASSWORD  the preview (required; otherwise the file is skipped)
//   E2E_ACCOUNTS_FILE                   demo accounts (optional; adds the customer portal to the accessibility scan)
//   AXE_PATH                            path to axe-core's axe.min.js (installed by the deploy workflow; the
//                                       accessibility test is skipped, with that reason, when it is absent)
// Read-only: GET requests and one customer sign-in. The preview password is submitted once (the gate allows
// 10 submissions per IP per 15 minutes) and its pass cookie is reused by the crawler and the browser.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { launchBrowser } from "./support.ts";
import { pageRules, contrastRules } from "./visual-rules.ts";
import { totpCode } from "../../src/lib/auth-crypto.ts";
import { findProhibitedClaims } from "../../src/domain/catalog.ts";
import { FABRICATION } from "../support/content-rules.ts";

const BASE = process.env.E2E_BASE_URL?.replace(/\/$/, "");
const PREVIEW_PW = process.env.E2E_PREVIEW_PASSWORD;
const AXE = process.env.AXE_PATH;
const skip = !BASE || !PREVIEW_PW ? "E2E_BASE_URL / E2E_PREVIEW_PASSWORD not set (runs only against a deployed preview)" : false;

let pass = "";
before(async () => {
  if (skip) return;
  const r = await fetch(BASE + "/__preview-access", { method: "POST", redirect: "manual", body: new URLSearchParams({ password: PREVIEW_PW!, next: "/" }), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const c = r.headers.getSetCookie().find((x) => x.startsWith("cm_preview="));
  assert.ok(c, `preview password accepted (HTTP ${r.status})`);
  pass = c.split(";")[0];
});

const get = (path: string) => fetch(BASE + path, { headers: { cookie: pass, "user-agent": "crestmont-staging-quality" }, redirect: "manual" });
const text = (h: string) => h.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const links = (h: string) => [...h.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

test("[WEB-009] staging: every internal link and asset reachable from the homepage resolves, and no page carries a prohibited or fabricated claim", { skip }, async () => {
  const seen = new Set<string>(), queue = ["/"], dead: string[] = [], claims: string[] = [];
  const assets = new Set<string>();
  while (queue.length && seen.size < 200) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const res = await get(path);
    if (res.status === 404 || res.status >= 500) { dead.push(`${path} → ${res.status}`); continue; }
    if (res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("text/html")) { await res.arrayBuffer(); continue; }
    const h = await res.text();
    const t = text(h);
    for (const c of findProhibitedClaims(t)) claims.push(`${path}: ${c}`);
    for (const re of FABRICATION) if (re.test(t)) claims.push(`${path}: matches ${re}`);
    for (const href of links(h)) {
      if (!href.startsWith("/") || href.startsWith("//")) continue;
      const clean = href.split("#")[0];
      if (clean.startsWith("/assets/")) { assets.add(clean); continue; }
      if (/^\/(staff|portal|account|logout|mfa|password|verify-email|invite|checkout|files|share|__preview)/.test(clean)) continue;
      if (!seen.has(clean)) queue.push(clean);
    }
  }
  for (const a of assets) {
    const r = await get(a);
    if (r.status !== 200) dead.push(`${a} → ${r.status}`);
    await r.arrayBuffer();
  }
  assert.ok(seen.size >= 30, `crawled ${seen.size} pages`);
  assert.deepEqual(dead, [], "dead links or assets");
  assert.deepEqual(claims, [], "prohibited or fabricated claims");
});

test("[TEST-003] staging: axe-core WCAG 2.1 A/AA scan of public pages, sign-in and the customer portal has no serious or critical violations", { skip: skip || (!AXE || !existsSync(AXE) ? "AXE_PATH not set or missing (the deploy workflow installs axe-core)" : false) }, async () => {
  const axeSource = readFileSync(AXE!, "utf8");
  const browser = await launchBrowser();
  try {
    // bypassCSP only lets the test inject axe itself; the site's CSP is unchanged for real visitors.
    const ctx = await browser.newContext({ bypassCSP: true });
    const [name, value] = pass.split("=");
    await ctx.addCookies([{ name, value, url: BASE! }]);
    const page = await ctx.newPage();
    const pages = ["/", "/services", "/pricing", "/portfolio", "/about", "/contact", "/quote", "/legal", "/legal/privacy", "/login", "/register"];
    const failures: string[] = [];
    const scan = async (path: string) => {
      await page.goto(BASE + path);
      await page.addScriptTag({ content: axeSource });
      const res = await page.evaluate(async () => {
        const r = await (window as unknown as { axe: { run: (ctx: Document, o: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
      });
      for (const v of res) if (v.impact === "serious" || v.impact === "critical") failures.push(`${path}: ${v.id} (${v.impact}) ${v.targets.join(", ")}`);
    };
    for (const p of pages) await scan(p);
    const accounts = process.env.E2E_ACCOUNTS_FILE && existsSync(process.env.E2E_ACCOUNTS_FILE) ? readFileSync(process.env.E2E_ACCOUNTS_FILE, "utf8") : "";
    const cust = /^\| customer_admin \| (customer\.harbor@\S+) \| `([^`]+)` \|/m.exec(accounts);
    if (cust) {
      await page.goto(BASE + "/login");
      await page.fill("#f-email", cust[1]);
      await page.fill("#f-password", cust[2]);
      await Promise.all([page.waitForLoadState("load"), page.click("button[type=submit]")]);
      for (const p of ["/portal", "/portal/projects", "/portal/messages", "/portal/billing", "/portal/support"]) await scan(p);
    }
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

type Acct = { role: string; email: string; password: string; totp?: string };
function demoAccounts(): Acct[] {
  const f = process.env.E2E_ACCOUNTS_FILE;
  if (!f || !existsSync(f)) return [];
  return [...readFileSync(f, "utf8").matchAll(/^\| (\w+) \| (\S+) \| `([^`]+)` \| (?:`([A-Z2-7]+)`|—) \|/gm)].map((m) => ({ role: m[1], email: m[2], password: m[3], totp: m[4] }));
}

test("[BRAND-006] [TEST-003] staging: shared design language holds on the deployed build — public, customer portal, employee and Owner pages at 375px and 1440px (layout, landmarks, naming, tap targets, AA contrast)", { skip: skip || (demoAccounts().length ? false : "E2E_ACCOUNTS_FILE not set") }, async () => {
  const all = demoAccounts();
  const want = [all.find((a) => a.role === "owner"), all.find((a) => a.role === "developer"), all.find((a) => a.email.startsWith("customer.harbor"))];
  assert.ok(want.every(Boolean), "owner, developer and customer demo accounts present");
  const browser = await launchBrowser();
  const problems: string[] = [];
  let pagesChecked = 0;
  try {
    const [name, value] = pass.split("=");
    // Sign in once per role at desktop width, then reuse the session for every width.
    const states: { role: string; state: unknown; paths: string[] }[] = [];
    for (const a of want as Acct[]) {
      const ctx = await browser.newContext();
      await ctx.addCookies([{ name, value, url: BASE! }]);
      const page = await ctx.newPage();
      await page.goto(BASE + "/login");
      await page.fill("#f-email", a.email);
      await page.fill("#f-password", a.password);
      await Promise.all([page.waitForLoadState("load"), page.click("button[type=submit]")]);
      if (new URL(page.url()).pathname.startsWith("/mfa")) {
        assert.ok(a.totp, `${a.role} needs a TOTP key`);
        const left = 30 - (Math.floor(Date.now() / 1000) % 30);
        await new Promise((r) => setTimeout(r, (left + 1) * 1000));
        await page.fill("#f-code", await totpCode(a.totp!));
        await Promise.all([page.waitForLoadState("load"), page.click("button[type=submit]")]);
      }
      assert.doesNotMatch(new URL(page.url()).pathname, /^\/(login|mfa)/, `signed in as ${a.role}`);
      const area = a.role === "customer_admin" ? "/portal" : "/staff";
      await page.goto(BASE + area);
      const hrefs: string[] = await page.$$eval(`a[href^='${area}']`, (as: Element[]) => [...new Set(as.map((x) => x.getAttribute("href")!.split("#")[0]))]);
      const paths = [area, ...hrefs.filter((h) => h !== area && !/logout|export|\.csv|\.pdf|download/.test(h))].slice(0, 45);
      states.push({ role: a.role, state: await ctx.storageState(), paths });
      await ctx.close();
    }
    const publicPaths = ["/", "/services", "/pricing", "/portfolio", "/about", "/process", "/faq", "/contact", "/quote", "/legal/privacy", "/login", "/register"];
    for (const width of [375, 1440]) {
      const groups = [{ role: "public", state: undefined as unknown, paths: publicPaths }, ...states];
      for (const g of groups) {
        const ctx = await browser.newContext({ viewport: { width, height: width < 800 ? 900 : 1000 }, deviceScaleFactor: width === 375 ? 2 : 1, isMobile: width === 375, hasTouch: width < 1000, ...(g.state ? { storageState: g.state } : {}) });
        await ctx.addCookies([{ name, value, url: BASE! }]);
        const page = await ctx.newPage();
        page.on("pageerror", (e: Error) => problems.push(`JS error ${e.message} @ ${page.url()}`));
        for (const path of g.paths) {
          const res = await page.goto(BASE + path, { waitUntil: "load" });
          if (!res || res.status() !== 200) { problems.push(`${width}px ${g.role} ${path}: HTTP ${res?.status()}`); continue; }
          pagesChecked++;
          for (const p of await page.evaluate(pageRules, { mobile: width === 375, width })) problems.push(`${width}px ${g.role} ${path}: ${p}`);
          if (width === 1440) for (const x of await page.evaluate(contrastRules)) problems.push(`${g.role} ${path}: contrast "${x.text}" ${x.sel} ${x.ratio}:1 < ${x.need}:1`);
        }
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }
  assert.ok(pagesChecked >= 60, `checked ${pagesChecked} page views`);
  assert.deepEqual(problems, []);
});
