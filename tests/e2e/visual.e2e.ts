// Visual consistency + accessibility audit in a real browser (BRAND-006, TEST-003, BRAND-003..005).
// Chromium via Playwright against dev/server.ts on a throwaway database. Run with:
//   node --no-warnings --test --test-concurrency=1 tests/e2e/visual.e2e.ts
// Set VISUAL_SHOTS_DIR=/some/scratch/dir to also save full-page screenshots of every page at every width
// (for human review; never written into the repository). Every record here is TEST DATA.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startServer, launchBrowser } from "./support.ts";
import { pageRules, contrastRules } from "./visual-rules.ts";
import { hashPassword, totpCode, newTotpSecret } from "../../src/lib/auth-crypto.ts";

type Server = Awaited<ReturnType<typeof startServer>>;
type Page = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Ctx = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let srv: Server;
let browser: Awaited<ReturnType<typeof launchBrowser>>;
const PW = "e2e-visual-password-123";
const RUN = Date.now().toString(36);
const SHOTS = process.env.VISUAL_SHOTS_DIR;
const WIDTHS = [375, 768, 1440] as const;
const ids = { project: `prj_vis_${RUN}`, lead: `ld_vis_${RUN}`, org: `org_vis_${RUN}`, file: "" };
let ownerState: unknown, customerState: unknown;

// ───────────── fixtures (TEST DATA) ─────────────

function seed(now: string) {
  const db = srv.db;
  db.exec(`INSERT OR IGNORE INTO organizations (id, name, kind, created_at) VALUES ('org_crestmont','Crestmont Website Development','internal','${now}')`);
  db.prepare(`INSERT INTO organizations (id, name, kind, created_at) VALUES (?, 'Visual Audit Bakery (test data)', 'customer', ?)`).run(ids.org, now);
  db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, created_at) VALUES (?, ?, 'business', 249900, 'paid', 'package', ?)`).run(`ord_vis_${RUN}`, ids.org, now);
  db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, description, created_at, paid_at) VALUES (?,?,?, 'full', 249900, 'paid', 'Business package — 100% upfront', ?, ?)`).run(`inv_vis_${RUN}`, ids.org, `ord_vis_${RUN}`, now, now);
  db.prepare(`INSERT INTO projects (id, organization_id, order_id, product_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES (?,?,?, 'business', 'Bakery website with a deliberately long project name to test wrapping', 'design', 3, 'upfront', ?, ?)`)
    .run(ids.project, ids.org, `ord_vis_${RUN}`, now, now);
  db.prepare(`INSERT INTO contacts (id, name, email, phone, created_at) VALUES (?, 'Alexandria Montgomery-Fitzgerald', 'alexandria.montgomery-fitzgerald@an-extremely-long-domain-name.example', '+1 (555) 010-0199', ?)`).run(`ct_vis_${RUN}`, now);
  db.prepare(`INSERT INTO leads (id, contact_id, source, stage, interest, message, utm_source, utm_medium, utm_campaign, referrer, landing_page, created_at, updated_at) VALUES (?,?, 'quote_form', 'qualified', 'custom', ?, 'google', 'cpc', 'fall-2026', 'https://www.google.com/search', '/services', ?, ?)`)
    .run(ids.lead, `ct_vis_${RUN}`, "We need online ordering, a loyalty programme and a catering enquiry form for three locations.", now, now);
  db.prepare(`INSERT INTO messages (id, organization_id, project_id, author_user_id, body, created_at) VALUES (?, ?, NULL, ?, 'A general question that is not about the project.', ?)`).run(`msg_vis_${RUN}`, ids.org, `usr_vis_cust_${RUN}`, now);
}

async function signIn(ctx: Ctx, email: string, secret?: string) {
  const page = await ctx.newPage();
  await page.goto(srv.base + "/login");
  await page.fill("#f-email", email);
  await page.fill("#f-password", PW);
  await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);
  if (new URL(page.url()).pathname.startsWith("/mfa")) {
    srv.db.prepare("UPDATE users SET totp_last_step = NULL WHERE email = ?").run(email);
    await page.fill("#f-code", await totpCode(secret!));
    await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);
  }
  assert.doesNotMatch(new URL(page.url()).pathname, /^\/(login|mfa)/);
  await page.close();
}

before(async () => {
  srv = await startServer();
  browser = await launchBrowser();
  const now = new Date().toISOString();
  const hash = await hashPassword(PW);
  const secret = newTotpSecret();
  srv.db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, created_at) VALUES (?,?,?,?,?,?)`).run(`usr_vis_cust_${RUN}`, `cust.${RUN}@bakery.example`, "Pat Baker", hash, now, now);
  seed(now);
  srv.db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?, 'customer_admin', ?)`).run(`mbr_vis_cust_${RUN}`, `usr_vis_cust_${RUN}`, ids.org, now);
  srv.db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, totp_secret, mfa_enabled, created_at) VALUES (?,?,?,?,?,?,1,?)`).run(`usr_vis_owner_${RUN}`, `owner.${RUN}@crestmont.test`, "Olivia Owner", hash, now, secret, now);
  srv.db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?, 'org_crestmont', 'owner', ?)`).run(`mbr_vis_owner_${RUN}`, `usr_vis_owner_${RUN}`, now);
  const o = await browser.newContext(); await signIn(o, `owner.${RUN}@crestmont.test`, secret); ownerState = await o.storageState(); await o.close();
  const c = await browser.newContext(); await signIn(c, `cust.${RUN}@bakery.example`);
  // A real upload through the portal so file pages have content.
  const p = await c.newPage();
  await p.goto(`${srv.base}/portal/projects/${ids.project}/files`);
  await p.setInputFiles("#f-file", { name: "brand-guidelines-final-v3-approved.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%visual audit fixture\n") });
  await Promise.all([p.waitForNavigation(), p.locator("form[enctype] button[type=submit]").first().click()]);
  ids.file = (srv.db.prepare(`SELECT id FROM files WHERE organization_id = ?`).get(ids.org) as { id: string }).id;
  await p.close();
  customerState = await c.storageState(); await c.close();
});
after(async () => { await browser?.close(); await srv?.stop(); });

const PUBLIC = ["/", "/services", "/services/custom-development", "/pricing", "/pricing/compare", "/portfolio", "/about", "/process", "/faq", "/hosting-maintenance", "/quote", "/contact", "/legal/privacy", "/legal/terms", "/login", "/register"];
const portal = () => ["/portal", "/portal/projects", `/portal/projects/${ids.project}`, `/portal/projects/${ids.project}/files`, `/portal/projects/${ids.project}/messages`, `/portal/projects/${ids.project}/revisions`,
  `/portal/files/${ids.file}`, `/files/${ids.file}/share`, "/portal/messages", "/portal/messages/general", "/portal/billing", "/portal/support", "/portal/team"];
const staff = () => ["/staff", "/staff/crm", "/staff/crm?view=list", `/staff/crm/leads/${ids.lead}`, `/staff/crm/leads/${ids.lead}/quick`, "/staff/sales", "/staff/quotes", "/staff/customers", `/staff/customers/${ids.org}`,
  "/staff/conversations", `/staff/conversations/${ids.org}`, "/staff/projects", `/staff/projects/${ids.project}`, `/staff/projects/${ids.project}?tab=files`, "/staff/tasks", "/staff/support", "/staff/refunds",
  "/staff/cms", "/staff/cms/about.page", "/staff/employees", "/staff/settings", "/staff/audit"];
const owner = () => ["/staff/owner", "/staff/readiness", "/staff/readiness/blockers", "/staff/finance", "/staff/finance/invoices", "/staff/reports", "/staff/security", "/staff/integrations"];
const groups = () => [
  { name: "public", state: undefined, paths: PUBLIC },
  { name: "portal", state: customerState, paths: portal() },
  { name: "staff", state: ownerState, paths: staff() },
  { name: "owner", state: ownerState, paths: owner() },
];


async function sweep(width: number, check: (page: Page, path: string, group: string) => Promise<string[]>) {
  const problems: string[] = [];
  for (const g of groups()) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 800 ? 900 : 1000 }, deviceScaleFactor: width === 375 ? 2 : 1, isMobile: width === 375, hasTouch: width < 1000, ...(g.state ? { storageState: g.state } : {}) });
    const page = await ctx.newPage();
    page.on("pageerror", (e: Error) => problems.push(`JS error ${e.message} @ ${page.url()}`));
    for (const path of g.paths) {
      const res = await page.goto(srv.base + path, { waitUntil: "load" });
      if (res.status() !== 200) { problems.push(`${width}px ${path}: HTTP ${res.status()}`); continue; }
      for (const p of await check(page, path, g.name)) problems.push(`${width}px ${path}: ${p}`);
    }
    await ctx.close();
  }
  return problems;
}

for (const width of WIDTHS) {
  test(`[TEST-003] [BRAND-006] ${width}px sweep of public, portal, staff and owner pages: no horizontal overflow, one main, labelled navs, named buttons, linked errors, no upscaled images${width === 375 ? ", tap targets ≥ 34px" : ""}`, async () => {
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    const problems = await sweep(width, async (page, path, group) => {
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${width}-${group}-${path.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "") || "home"}.png`), fullPage: true });
      return page.evaluate(pageRules, { mobile: width === 375, width });
    });
    assert.deepEqual(problems, []);
  });
}

test("[BRAND-006] computed contrast of every visible text run (body text and buttons) meets WCAG AA: 4.5:1, or 3:1 for large text", async () => {
  const problems = await sweep(1440, async (page) => (await page.evaluate(contrastRules)).map((x: { text: string; ratio: number; need: number; sel: string }) => `"${x.text}" ${x.sel} ${x.ratio}:1 < ${x.need}:1`));
  assert.deepEqual(problems, []);
});

test("[TEST-003] [BRAND-006] keyboard focus is always visible: outline ≥ 2px with ≥ 3:1 contrast on links, buttons and fields", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: ownerState });
  const page = await ctx.newPage();
  const problems: string[] = [];
  for (const path of ["/contact", "/staff/crm", "/staff/sales", `/staff/crm/leads/${ids.lead}`]) {
    await page.goto(srv.base + path);
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      const r = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const s = getComputedStyle(el);
        const parse = (c: string) => (c.match(/\d+(\.\d+)?/g) ?? []).map(Number);
        const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        let bg = [13, 13, 13];
        for (let e: Element | null = el.parentElement; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.length >= 3 && (c[3] ?? 1) > 0.9) { bg = c; break; } }
        const oc = parse(s.outlineColor);
        const ratio = (Math.max(lum(oc), lum(bg)) + 0.05) / (Math.min(lum(oc), lum(bg)) + 0.05);
        const ring = s.boxShadow && s.boxShadow !== "none";
        return { tag: `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${(el.innerText || (el as HTMLInputElement).name || "").trim().slice(0, 24)}"`, style: s.outlineStyle, width: parseFloat(s.outlineWidth), ratio, ring };
      });
      if (!r) continue;
      const ok = (r.style !== "none" && r.width >= 2 && r.ratio >= 3) || r.ring;
      if (!ok) problems.push(`${path}: ${r.tag} focus ${r.style} ${r.width}px ${r.ratio.toFixed(2)}:1`);
    }
  }
  await ctx.close();
  assert.deepEqual([...new Set(problems)], []);
});

test("[TEST-003] [BRAND-005] form errors are announced and linked to their fields with aria-describedby (no-JS submit)", async () => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 768, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(srv.base + "/contact");
  await page.fill("#f-name", "A");
  await page.fill("#f-email", "not-an-email");
  await Promise.all([page.waitForNavigation(), page.click("form.lead-form button[type=submit]")]);
  const r = await page.evaluate(() => ["name", "email", "message"].map((n) => {
    const el = document.getElementById(`f-${n}`)!;
    const refs = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    return { n, invalid: el.getAttribute("aria-invalid"), errorText: refs.map((id) => document.getElementById(id)).find((x) => x?.classList.contains("error-text"))?.textContent ?? null, summary: !!document.querySelector(".alert--error[role=alert]") };
  }));
  for (const f of r) {
    assert.equal(f.invalid, "true", `${f.n} aria-invalid`);
    assert.ok(f.errorText && f.errorText.length > 3, `${f.n} described by its error message`);
    assert.ok(f.summary, "error summary announced");
  }
  await ctx.close();
});

test("[BRAND-003] drawer: CRM Quick view opens the lead in a <dialog class=drawer> with JS, and is a plain link to the quick-view page without JS", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: ownerState });
  const page = await ctx.newPage();
  await page.goto(srv.base + "/staff/crm");
  await page.locator(`a.kanban__quick[href="/staff/crm/leads/${ids.lead}/quick"]`).click();
  const drawer = page.locator("dialog.drawer[open]");
  await drawer.waitFor();
  await page.locator("dialog.drawer[open] [data-attribution]").waitFor();
  assert.equal(new URL(page.url()).pathname, "/staff/crm", "stayed on the board");
  assert.match(await drawer.innerText(), /Alexandria Montgomery-Fitzgerald[\s\S]*google/);
  await drawer.evaluate((el: Element) => Promise.all(el.getAnimations().map((x) => x.finished)));
  const box = await drawer.boundingBox();
  assert.ok(box && Math.round(box.x + box.width) === 1440 && box.height >= 990, `drawer pinned to the right edge, full height: ${JSON.stringify(box)}`);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("dialog.drawer[open]").count(), 0, "Escape closes the drawer");
  await ctx.close();
  const nojs = await browser.newContext({ javaScriptEnabled: false, storageState: ownerState });
  const p2 = await nojs.newPage();
  await p2.goto(srv.base + "/staff/crm");
  await Promise.all([p2.waitForNavigation(), p2.locator(`a.kanban__quick[href="/staff/crm/leads/${ids.lead}/quick"]`).click()]);
  assert.equal(new URL(p2.url()).pathname, `/staff/crm/leads/${ids.lead}/quick`);
  assert.match(await p2.locator("main").innerText(), /Open full lead/);
  await nojs.close();
});

test("[BRAND-004] rich-text editor: toolbar inserts markdown and the live preview renders it safely; date-range presets are links", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: ownerState });
  const page = await ctx.newPage();
  await page.goto(srv.base + "/staff/cms/about.page");
  const ta = page.locator("#f-body");
  await ta.fill("Intro <img src=x onerror=window.__xss=1>");
  await ta.press("End");
  await page.locator(".richtext__toolbar button", { hasText: "Bold" }).click();
  const preview = page.locator("#f-body-preview");
  assert.match(await preview.innerHTML(), /<strong>bold text<\/strong>/);
  assert.match(await preview.innerHTML(), /&lt;img src=x onerror=window.__xss=1&gt;/, "HTML typed into the editor is shown as text");
  assert.equal(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss), undefined);
  assert.equal(await page.locator(".richtext__toolbar[role=toolbar][aria-label=Formatting] button").count(), 6);
  await page.goto(srv.base + "/staff/finance");
  await Promise.all([page.waitForNavigation(), page.locator(".date-range__presets a", { hasText: "This year" }).click()]);
  const u = new URL(page.url());
  assert.equal(u.searchParams.get("from"), `${new Date().getUTCFullYear()}-01-01`);
  assert.equal(await page.locator('.date-range__presets a[aria-current="true"]').innerText(), "This year");
  await ctx.close();
});

test("[BRAND-005] skeleton loader appears while a slow server-rendered page loads, and is gone once it arrives", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: ownerState });
  const page = await ctx.newPage();
  await page.goto(srv.base + "/staff");
  // Delay the readiness response so the in-between state is observable, and record (before the document is
  // replaced) whether the skeleton was rendered into <main>.
  await page.route("**/staff/readiness", async (route: { continue(): Promise<void> }) => { await new Promise((r) => setTimeout(r, 900)); await route.continue(); });
  await page.evaluate(() => {
    new MutationObserver(() => {
      if (document.querySelector("main.is-loading > .loading-state .skeleton")) sessionStorage.setItem("skeletonSeen", "1");
    }).observe(document.querySelector("main")!, { childList: true, subtree: true, attributes: true });
  });
  await Promise.all([page.waitForURL(/\/staff\/readiness$/), page.locator('.sidebar a[href="/staff/readiness"]').click()]);
  await page.waitForLoadState("load");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("skeletonSeen")), "1", "skeleton shown while the slow page computed");
  assert.equal(await page.locator("main .loading-state").count(), 0);
  await ctx.close();
});
