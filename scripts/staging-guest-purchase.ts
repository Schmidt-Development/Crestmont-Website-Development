// Simulated end-to-end purchase on STAGING, as a completely new visitor (Founder launch closeout, 2026-11-13,
// criteria 2, 3, 4 and 8). For each package, in a fresh real browser with no account and no cookies:
//   /checkout/<package> → the guest intake (no sign-in) → the bot check (staging's always-pass Turnstile test key) →
//   the review (server-side price, required maintenance plan, agreements) → Stripe TEST-mode Checkout paid with
//   Stripe's published test card 4242… (never a live session: the script refuses anything but cs_test_) →
// then verifies, in the staging database and through the deployed site:
//   - exactly one paid order, one project and the chosen maintenance plan recorded on the order;
//   - the receipt and the account-setup email to the buyer, and the internal new-order notice, accepted by Resend
//     (the buyer is a Resend test inbox, delivered+…@resend.dev, which accepts mail without reaching a person);
//   - the account-setup link sets a password and confirms the email; the buyer signs in and sees the project;
//   - a Crestmont Owner (staging demo account, TOTP) opens the same project in the staff workspace.
//
//   E2E_BASE_URL=https://crestmont-platform-staging… E2E_ACCOUNTS_FILE=access/demo-accounts.md PLAYWRIGHT_MODULE=… \
//   WRANGLER="npx --yes wrangler@4.149.0" node --no-warnings scripts/staging-guest-purchase.ts [starter,business,premium]
// Output: one PASS/FAIL line per check, no password, token or link. Exit 1 on any failure.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { PACKAGES, MINIMUM_PLAN_FOR_PACKAGE } from "../src/domain/catalog.ts";
import { totpCode } from "../src/lib/auth-crypto.ts";

const BASE = (process.env.E2E_BASE_URL ?? "").replace(/\/$/, "");
if (!/^https:\/\/crestmont-platform-staging\.[a-z0-9-]+\.workers\.dev$/.test(BASE)) { console.error("E2E_BASE_URL must be the staging workers.dev origin (this script never runs against production)"); process.exit(2); }
const pkgs = (process.argv[2] ?? "starter,business,premium").split(",").map((s) => s.trim()).filter(Boolean);
const pwModule = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = pwModule.chromium ? pwModule : pwModule.default;
const [cmd, ...wbase] = (process.env.WRANGLER ?? "npx --yes wrangler@4.149.0").split(" ").filter(Boolean);
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const d1 = (sql: string): Record<string, any>[] => {
  const out = execFileSync(cmd, [...wbase, "d1", "execute", "crestmont-staging", "--remote", "--env", "staging", "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  return (JSON.parse(out.slice(out.indexOf("["))) as { results?: Record<string, unknown>[] }[]).flatMap((p) => p.results ?? []);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, ms: number, f: () => T | undefined | null | false): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = f(); if (v) return v; if (Date.now() > end) throw new Error(`${what}: not within ${ms / 1000}s`); await sleep(5_000); }
}
let failed = 0;
const check = (ok: boolean, what: string, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failed++; return ok; };

const accounts = [...readFileSync(process.env.E2E_ACCOUNTS_FILE ?? "access/demo-accounts.md", "utf8").matchAll(/^\| (\w+) \| (\S+) \| `([^`]+)` \| (?:`([A-Z2-7]+)`|—) \|/gm)].map((m) => ({ role: m[1], email: m[2], password: m[3], totp: m[4] }));
const owner = accounts.find((a) => a.role === "owner");
if (!owner?.totp) { console.error("No staging Owner demo account with a TOTP key in the accounts file"); process.exit(2); }

const run = randomBytes(3).toString("hex");
const browser = await chromium.launch();
const internalSince = new Date(Date.now() - 5_000).toISOString();

async function payOnStripe(p: any, email: string, name: string) {
  await p.waitForURL(/^https:\/\/checkout\.stripe\.com\//, { timeout: 60_000 });
  if (!/\/c\/pay\/cs_test_/.test(p.url())) throw new Error("not a Stripe TEST-mode session; refusing to enter a card");
  const cardNumber = p.locator("#cardNumber");
  const cardButton = p.locator('[data-testid="card-accordion-item-button"]').first();
  await Promise.any([cardNumber.waitFor({ state: "visible", timeout: 30_000 }), cardButton.waitFor({ state: "attached", timeout: 30_000 })]).catch(() => undefined);
  if (!(await cardNumber.isVisible()) && (await cardButton.count())) await cardButton.dispatchEvent("click");
  await cardNumber.waitFor({ state: "visible", timeout: 30_000 });
  await cardNumber.fill("4242 4242 4242 4242");
  await p.locator("#cardExpiry").fill("12 / 34");
  await p.locator("#cardCvc").fill("123");
  if (await p.locator("#billingName").count()) await p.locator("#billingName").fill(name);
  if (await p.locator("#billingPostalCode").isVisible().catch(() => false)) await p.locator("#billingPostalCode").fill("48933");
  if (await p.locator("#email").isEditable().catch(() => false)) await p.locator("#email").fill(email);
  const link = p.locator("#enableStripePass");
  if ((await link.count()) && (await link.isChecked())) await link.dispatchEvent("click");
  if ((await link.count()) && (await link.isChecked())) await link.setChecked(false, { force: true });
  await p.locator('[data-testid="hosted-payment-submit-button"], .SubmitButton').first().click();
  await p.waitForURL((u: URL) => u.href.startsWith(BASE), { timeout: 90_000 });
}

async function fillForm(p: any, answers: Record<string, string>) {
  for (const [name, value] of Object.entries(answers)) {
    const el = p.locator(`form [name="${name}"]`);
    const n = await el.count();
    if (!n) continue;
    const type = await el.first().evaluate((e: HTMLInputElement) => e.tagName === "SELECT" ? "select" : e.type);
    if (type === "radio" || type === "checkbox") await p.locator(`form [name="${name}"][value="${value}"]`).check();
    else if (type === "select") await el.first().selectOption(value);
    else if (type !== "hidden" && type !== "file") await el.first().fill(value);
  }
}

// Staff: one Owner sign-in for the whole run.
const staffCtx = await browser.newContext();
const staff = await staffCtx.newPage();
await staff.goto(`${BASE}/login`);
await staff.fill("#f-email", owner.email);
await staff.fill("#f-password", owner.password);
await Promise.all([staff.waitForLoadState("load"), staff.click("button[type=submit]")]);
for (let i = 0; new URL(staff.url()).pathname.startsWith("/mfa") && i < 2; i++) {
  if (i > 0) await sleep(30_000 - (Date.now() % 30_000) + 1_000);
  await staff.fill("#f-code", await totpCode(owner.totp));
  await Promise.all([staff.waitForLoadState("load"), staff.click("button[type=submit]")]);
}
check(!/^\/(login|mfa)/.test(new URL(staff.url()).pathname), "staging Owner signs in (password + TOTP)");

try {
  for (const id of pkgs) {
    const pkg = (PACKAGES as Record<string, (typeof PACKAGES)[keyof typeof PACKAGES]>)[id];
    if (!check(!!pkg, `${id}: known package`)) continue;
    const plan = MINIMUM_PLAN_FOR_PACKAGE[id as keyof typeof MINIMUM_PLAN_FOR_PACKAGE];
    const price = `$${(pkg.basePriceCents / 100).toLocaleString("en-US")}`;
    const email = `delivered+guest-${run}-${id}@resend.dev`;
    const business = `[Guest purchase ${run}] ${pkg.name} fixture`;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    try {
      // 1. A new visitor: package → intake, no account.
      await p.goto(`${BASE}/checkout/${id}`);
      check(new URL(p.url()).pathname === `/checkout/${id}/intake` && (await p.locator('[data-testid="guest-intake"]').count()) === 1, `${id}: a new visitor reaches the intake without signing in`, new URL(p.url()).pathname);
      await fillForm(p, { business_name: business, contact_name: "Guest Purchase Probe", contact_email: email, contact_phone: "(517) 555-0100", industry: "Automated staging purchase check",
        business_description: "Automated staging purchase check; not a real order.", existing_website: "", goals: "Verify the purchase flow end to end.", target_audience: "None (automated check).",
        has_branding: "no", brand_style: "None", design_preferences: "None", pages: "Home", content_source: "crestmont_draft", images_source: "licensed", domain_status: "need",
        domain_wishes: "none.example", hosting: "crestmont", special_instructions: "AUTOMATED STAGING CHECK — not a real order." });
      if (await p.locator(".cf-turnstile").count()) await p.waitForFunction(() => !!(document.querySelector('[name="cf-turnstile-response"]') as HTMLInputElement | null)?.value, null, { timeout: 30_000 });
      await Promise.all([p.waitForURL(new RegExp(`/checkout/${id}/review`), { timeout: 30_000 }), p.locator('form[data-testid="guest-intake"] button[type=submit]').click()]);
      const reviewText = await p.locator("main").innerText();
      check(reviewText.includes(price), `${id}: the review shows the server-side price ${price}`);
      // 2. Agreement + required maintenance plan → Stripe test Checkout, paid with the test card.
      await p.locator(`[name="maintenance_plan"][value="${plan}"]`).check();
      await p.locator('[name="terms"]').check();
      await p.locator('button:has-text("Pay $")').click();
      await payOnStripe(p, email, "Guest Purchase Probe");
      check(true, `${id}: Stripe TEST Checkout paid with the published test card and returned to Crestmont`);
      // 3. Provisioning, exactly once.
      const user = d1(`SELECT id FROM users WHERE email = ${q(email)}`)[0];
      if (!check(!!user, `${id}: the buyer's account was created by the checkout`)) continue;
      const org = d1(`SELECT o.id FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ${q(user.id)} AND m.role_id = 'customer_admin'`)[0];
      const paid = await until(`${id}: order paid`, 150_000, () => d1(`SELECT id, status, total_cents, maintenance_plan_id FROM orders WHERE organization_id = ${q(org.id)}`).filter((o) => o.status === "paid").length ? d1(`SELECT id, status, total_cents, maintenance_plan_id FROM orders WHERE organization_id = ${q(org.id)}`) : null).catch((e) => { check(false, (e as Error).message); return [] as Record<string, any>[]; });
      const projects = await until(`${id}: project`, 90_000, () => { const r = d1(`SELECT id FROM projects WHERE organization_id = ${q(org.id)}`); return r.length ? r : null; }).catch(() => [] as Record<string, any>[]);
      check(paid.length === 1 && paid[0].status === "paid" && paid[0].total_cents === pkg.basePriceCents, `${id}: exactly one order, paid, at ${price}`, JSON.stringify(paid.map((o) => [o.status, o.total_cents])));
      check(paid[0]?.maintenance_plan_id === plan, `${id}: maintenance plan ${plan} recorded on the order`, String(paid[0]?.maintenance_plan_id));
      check(projects.length === 1, `${id}: exactly one project provisioned`, `${projects.length}`);
      // 4. Emails accepted by Resend.
      const mails = await until(`${id}: buyer emails`, 120_000, () => { const r = d1(`SELECT id, template, status, provider_message_id AS pm FROM email_deliveries WHERE to_email = ${q(email)}`); return r.some((m) => m.template === "account_setup" && m.pm) && r.some((m) => m.template === "receipt" && m.pm) ? r : null; })
        .catch(() => d1(`SELECT id, template, status, provider_message_id AS pm FROM email_deliveries WHERE to_email = ${q(email)}`));
      const setupMails = mails.filter((m) => m.template === "account_setup");
      check(mails.some((m) => m.template === "receipt" && m.pm), `${id}: receipt email accepted by Resend`, mails.map((m) => `${m.template}:${m.status}`).join(", "));
      check(setupMails.length === 1 && !!setupMails[0].pm, `${id}: exactly one account-setup email, accepted by Resend`);
      const events = d1(`SELECT d.template, e.type FROM email_webhook_events e JOIN email_deliveries d ON d.id = e.delivery_id WHERE d.to_email = ${q(email)}`);
      console.log(`INFO ${id}: Resend webhook events so far: ${events.map((e) => `${e.template}:${e.type}`).join(", ") || "none yet"}`);
      // 5. The setup link (read from the staging outbox; never printed) → password → sign in → the project.
      const body = setupMails[0] ? (d1(`SELECT text_body FROM email_messages WHERE delivery_id = ${q(setupMails[0].id)}`)[0]?.text_body as string | undefined) : undefined;
      const m = body ? /https?:\/\/[^\s]+(\/password\/reset\?token=[A-Za-z0-9_-]+&setup=1)/.exec(body) : null;
      if (check(!!m, `${id}: the setup email carries a single-use account-setup link`)) {
        const c2 = await browser.newContext();
        const s = await c2.newPage();
        await s.goto(`${BASE}${m![1]}`);
        check(/Set your password/.test(await s.locator("main").innerText()), `${id}: the setup link opens "Set your password"`);
        const pw = randomBytes(18).toString("base64url");
        await s.locator('main form [name="password"]').first().fill(pw);
        const confirm = s.locator('main form [name="password_confirm"], main form [name="confirm"]');
        if (await confirm.count()) await confirm.first().fill(pw);
        await Promise.all([s.waitForLoadState("load"), s.locator("main form button[type=submit]").first().click()]);
        await s.goto(`${BASE}/login`);
        await s.fill("#f-email", email);
        await s.fill("#f-password", pw);
        await Promise.all([s.waitForLoadState("load"), s.click("button[type=submit]")]);
        check(!/^\/login/.test(new URL(s.url()).pathname), `${id}: the buyer signs in with the password they chose`, new URL(s.url()).pathname);
        const verified = d1(`SELECT email_verified_at FROM users WHERE id = ${q(user.id)}`)[0]?.email_verified_at;
        check(!!verified, `${id}: using the setup link confirmed the email address`);
        await s.goto(`${BASE}/portal/projects`);
        const portal = await s.locator("main").innerText();
        check(projects.length === 1 && (await s.locator(`a[href*="${projects[0].id}"]`).count()) > 0 || portal.includes(pkg.name), `${id}: the customer portal lists the new project`);
        if (projects[0]) { const r = await s.goto(`${BASE}/portal/projects/${projects[0].id}`); check(r?.status() === 200, `${id}: the customer opens the project`, `HTTP ${r?.status()}`); }
        await c2.close();
      }
      // 6. Staff fulfilment access.
      if (projects[0]) { const r = await staff.goto(`${BASE}/staff/projects/${projects[0].id}`); const st = await staff.locator("main").innerText(); check(r?.status() === 200 && (st.includes(run) || st.includes(pkg.name)), `${id}: a Crestmont Owner opens the project for fulfilment`, `HTTP ${r?.status()}`); }
    } catch (e) {
      check(false, `${id}: journey`, (e as Error).message.slice(0, 300));
      await p.screenshot({ path: `evidence/guest-purchase-${id}-failure.png`, fullPage: true }).catch(() => undefined);
    } finally { await ctx.close(); }
  }
  const internal = d1(`SELECT status, provider_message_id AS pm FROM email_deliveries WHERE template = 'internal_alert' AND created_at >= ${q(internalSince)}`);
  check(internal.length >= 1 && internal.every((x) => x.pm), "internal new-order notices sent to the Crestmont operations mailbox and accepted by Resend", `${internal.length} notice(s)`);
} finally {
  await browser.close();
}
console.log(failed ? `${failed} check(s) failed` : `guest purchase journey verified on staging for ${pkgs.join(", ")} (Stripe test mode)`);
process.exit(failed ? 1 : 0);
