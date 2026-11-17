// TEMPORARY diagnostic (not part of the product): the shared remote browser on the REAL websites, end to end, on a
// GitHub runner — the development server with the remote browser on the runner's Chromium (no production session,
// no browser-minutes). Each URL goes through the normal staff Add flow (mode chosen automatically) and is published
// in this throwaway database (TEST DATA; nothing on production), then a visitor opens it and the check records when
// the slide turned live and whether the website's content was on screen at that moment.
//   node scripts/diag-real-sites.mjs http://localhost:8787 .dev/real.db https://site-a/ https://site-b/ …
import { DatabaseSync } from "node:sqlite";
import { hashPassword, newTotpSecret, totpCode } from "../src/lib/auth-crypto.ts";
const [BASE, DB, ...urls] = process.argv.slice(2);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const db = new DatabaseSync(DB);
const b = await chromium.launch();
const pw = "Diag-pass-2026!", email = `owner.diag.${Date.now()}@crestmont.test`, secret = newTotpSecret(), now = new Date().toISOString();
db.exec(`INSERT OR IGNORE INTO organizations (id, name, kind, created_at) VALUES ('org_crestmont','Crestmont Website Development','internal','${now}')`);
db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, totp_secret, mfa_enabled, created_at) VALUES (?,?,?,?,?,?,1,?)`).run("usr_diag", email, "Diag Owner", await hashPassword(pw), now, secret, now);
db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?,?,?)`).run("mbr_diag", "usr_diag", "org_crestmont", "owner", now);
const staff = await (await b.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
await staff.goto(BASE + "/login"); await staff.fill("#f-email", email); await staff.fill("#f-password", pw);
await Promise.all([staff.waitForLoadState("load"), staff.click("button[type=submit]")]);
if (new URL(staff.url()).pathname.startsWith("/mfa")) { await staff.fill("#f-code", await totpCode(secret)); await Promise.all([staff.waitForNavigation(), staff.click("button[type=submit]")]); }
const slugs = [];
for (const url of urls) {
  const slug = "real-" + new URL(url).hostname.replace(/^www\./, "").split(".")[0];
  await staff.goto(BASE + "/staff/portfolio");
  await staff.fill('[data-testid="pf-new"] input[name="live_url"]', url);
  await Promise.all([staff.waitForNavigation(), staff.locator('[data-testid="pf-new"] button[type=submit]').click()]);
  await staff.fill('input[name="name"]', slug); await staff.fill('input[name="slug"]', slug); await staff.fill('input[name="industry"]', "Diagnostic (TEST DATA)");
  if (!(await staff.inputValue('textarea[name="description"]'))) await staff.fill('textarea[name="description"]', "Diagnostic copy (TEST DATA).");
  await Promise.all([staff.waitForNavigation(), staff.getByRole("button", { name: /create project/i }).click()]);
  const id = /\/staff\/portfolio\/([^/?#]+)$/.exec(new URL(staff.url()).pathname)[1];
  const mode = await staff.locator('[data-testid="pf-embed"]').getAttribute("data-display-mode");
  const submit = (form) => Promise.all([staff.waitForNavigation(), staff.locator(`${form} button[type=submit]`).last().click()]);
  await staff.goto(`${BASE}/staff/portfolio/${id}`);
  await submit(`form[action$="/verify-link"]`);
  await staff.fill('form[action$="/relationship"] input[name="relationship"]', "Diagnostic (TEST DATA)"); await staff.fill('form[action$="/relationship"] textarea[name="evidence"]', "Throwaway runner database.");
  await submit(`form[action$="/relationship"]`);
  await staff.fill('form[action$="/consent"] input[name="given_by"]', "Diagnostic (TEST DATA)"); await staff.selectOption('form[action$="/consent"] select[name="method"]', "written");
  await staff.fill('form[action$="/consent"] input[name="given_on"]', now.slice(0, 10)); await staff.fill('form[action$="/consent"] textarea[name="evidence"]', "Throwaway runner database.");
  await submit(`form[action$="/consent"]`); await submit(`form[action$="/publish"]`);
  console.log(`MODE ${url} → ${mode} (${slug})`);
  slugs.push(slug);
}
await staff.goto(BASE + "/staff/portfolio");
await new Promise((r) => setTimeout(r, 3000));
const sel = (slug) => `.pfx__slide[data-remote-slug="${slug}"]`;
for (const [k, slug] of slugs.entries()) {
  for (const [label, opts] of [["desktop", { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }], ["phone", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }]]) {
    const ctx = await b.newContext(opts); const p = await ctx.newPage();
    const t0 = Date.now();
    await p.goto(`${BASE}/portfolio/${slug}`); await p.locator(sel(slug)).scrollIntoViewIfNeeded();
    const ok = await p.waitForSelector(`${sel(slug)}[data-remote-state="live"].is-ready`, { timeout: 45000 }).then(() => true, () => false);
    const tl = Date.now() - t0;
    const m = ok ? await p.locator(`${sel(slug)} canvas.pfx__remote`).evaluate((c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let lit = 0, n = 0; const b0 = d[0] + d[1] + d[2]; for (let i = 0; i < d.length; i += 4 * 97) { n++; if (Math.abs(d[i] + d[i + 1] + d[i + 2] - b0) > 30) lit++; } return { w: c.width, h: c.height, lit, n }; }) : null;
    console.log(`${m && m.lit >= 0.02 * m.n ? "PASS" : "FAIL"} ${urls[k]} ${label}: live after ${(tl / 1000).toFixed(1)} s, content at that moment ${m ? `${m.lit} of ${m.n} samples (${(100 * m.lit / m.n).toFixed(1)}%) at ${m.w}×${m.h}` : "— never live"}`);
    if (ok) await p.locator(`${sel(slug)} canvas.pfx__remote`).screenshot({ path: `diag-out/${slug}-${label}-at-live.png` });
    await new Promise((r) => setTimeout(r, 2500));
    if (ok) await p.locator(`${sel(slug)} canvas.pfx__remote`).screenshot({ path: `diag-out/${slug}-${label}-2s-later.png` });
    await ctx.close();
    await new Promise((r) => setTimeout(r, 1500));
  }
}
console.log("SLUGS " + slugs.join(","));
await b.close();
