// Content, visual-consistency and accessibility checks against the DEPLOYED, public staging site (WEB-009, TEST-003, BRAND-006).
//   E2E_BASE_URL                        the staging URL (required; otherwise the file is skipped)
//   E2E_ACCOUNTS_FILE                   demo accounts (optional; adds the customer portal to the accessibility scan)
//   AXE_PATH                            path to axe-core's axe.min.js (installed by the deploy workflow; the
//                                       accessibility test is skipped, with that reason, when it is absent)
// Read-only: GET requests and one customer sign-in. Staging is public (no preview password since 2026-10-28), so the
// crawler and every browser context start with no cookies, like a first-time visitor.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { launchBrowser } from "./support.ts";
import { pageRules, contrastRules } from "./visual-rules.ts";
import { totpCode } from "../../src/lib/auth-crypto.ts";
import { findProhibitedClaims } from "../../src/domain/catalog.ts";
import { FABRICATION } from "../support/content-rules.ts";

const BASE = process.env.E2E_BASE_URL?.replace(/\/$/, "");
const AXE = process.env.AXE_PATH;
const skip = !BASE ? "E2E_BASE_URL not set (runs only against deployed staging)" : false;


const get = (path: string) => fetch(BASE + path, { headers: { "user-agent": "crestmont-staging-quality" }, redirect: "manual" });
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
    // Contrast is measured on the text as it is READ. Headings reveal word by word (hero on load; sections as they scroll
    // into view, and back out when they leave), so at an arbitrary instant many words sit at 10–12% opacity — deploy
    // #64's axe failures on /, /services and /pricing were exactly those mid-animation words. With reduced motion the
    // site renders every word in its settled state (same colours, full opacity), which is what axe must judge; a
    // second, normal-motion pass below proves each animated heading really reaches that state when it is on screen.
    const ctx = await browser.newContext({ bypassCSP: true, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const motion = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const mp = await motion.newPage();
    const readable = async (path: string) => {
      await mp.goto(BASE + path);
      const stuck = await mp.evaluate(async () => {
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const heads = [...new Set([...document.querySelectorAll(".w")].map((w) => w.parentElement!).filter((h) => h.getClientRects().length))];
        const out: string[] = [];
        for (const h of heads) {
          h.scrollIntoView({ block: "center", behavior: "instant" });
          let faint: Element[] = [];
          for (let t = 0; t < 30; t++) { await wait(100); faint = [...h.querySelectorAll(".w")].filter((w) => Number(getComputedStyle(w).opacity) < 0.99); if (!faint.length) break; }
          if (faint.length) out.push(`"${(h.textContent || "").trim().slice(0, 40)}" (${faint.length} word(s) below full opacity while on screen)`);
        }
        return out;
      });
      for (const x of stuck) failures.push(`${path}: animated heading never becomes fully readable: ${x}`);
    };
    const pages = ["/", "/services", "/pricing", "/portfolio", "/about", "/contact", "/quote", "/legal", "/legal/privacy", "/login", "/register"];
    const failures: string[] = [];
    const scan = async (path: string) => {
      await page.goto(BASE + path);
      await page.waitForTimeout(300); // reduced motion: reveals complete immediately; let the first frame settle
      await page.addScriptTag({ content: axeSource });
      const res = await page.evaluate(async () => {
        const r = await (window as unknown as { axe: { run: (ctx: Document, o: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
      });
      for (const v of res) if (v.impact === "serious" || v.impact === "critical") failures.push(`${path}: ${v.id} (${v.impact}) ${v.targets.join(", ")}`);
    };
    for (const p of pages) { await scan(p); await readable(p); }
    await motion.close();
    const accounts = process.env.E2E_ACCOUNTS_FILE && existsSync(process.env.E2E_ACCOUNTS_FILE) ? readFileSync(process.env.E2E_ACCOUNTS_FILE, "utf8") : "";
    const cust = /^\| customer_admin \| (customer\.harbor@\S+) \| `([^`]+)` \| (?:`([A-Z2-7]+)`|—) \|/m.exec(accounts);
    if (cust) {
      await page.goto(BASE + "/login");
      await page.fill("#f-email", cust[1]);
      await page.fill("#f-password", cust[2]);
      await Promise.all([page.waitForLoadState("load"), page.click("button[type=submit]")]);
      // FD-30: demo customer administrators have two-factor authentication (scripts/staging-access.ts).
      if (new URL(page.url()).pathname.startsWith("/mfa") && cust[3]) {
        await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 1_000)); // a fresh 30 s step (codes are single-use)
        await page.fill("#f-code", await totpCode(cust[3]));
        await Promise.all([page.waitForLoadState("load"), page.click("button[type=submit]")]);
      }
      assert.doesNotMatch(new URL(page.url()).pathname, /^\/(login|mfa)/, "customer signed in for the accessibility scan");
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
    // Sign in once per role at desktop width, then reuse the session for every width.
    const states: { role: string; state: unknown; paths: string[] }[] = [];
    for (const a of want as Acct[]) {
      const ctx = await browser.newContext();
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
