// Content and accessibility checks against the DEPLOYED staging preview (WEB-009, TEST-003).
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
