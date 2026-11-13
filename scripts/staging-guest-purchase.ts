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
if (pkgs.some((id) => !/^[a-z]+$/.test(id) || !Object.hasOwn(PACKAGES, id))) { console.error(`unknown package in ${pkgs.join(",")}`); process.exit(2); }
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

async function payOnStripe(p: any, email: string, name: string, sessionUrl: string, cardNo = "4242 4242 4242 4242"): Promise<"paid" | "declined"> {
  // Test mode is proven by the session Crestmont created (its redirect to Stripe), not by the address Stripe's page
  // ends up on, which Stripe may rewrite. Anything but a cs_test_ session is refused before a card is entered.
  if (!/^https:\/\/checkout\.stripe\.com\/.*cs_test_/.test(sessionUrl)) throw new Error("Crestmont did not create a Stripe TEST-mode session; refusing to enter a card");
  await p.waitForURL(/^https:\/\/checkout\.stripe\.com\//, { timeout: 60_000 });
  await p.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  // Stripe's hosted page changes layout over time: the card field may be on the page or inside a frame, and Card may
  // first have to be chosen in a payment-method list. Look everywhere, by stable attributes (autocomplete cc-*).
  const CARD = 'input[autocomplete="cc-number"], #cardNumber, input[name="cardnumber"], input[name="number"]';
  const findCard = async () => { for (const f of p.frames()) { const l = f.locator(CARD).first(); if (await l.isVisible().catch(() => false)) return { f, l }; } return null; };
  let card = await findCard();
  for (let i = 0; !card && i < 20; i++) {
    // Stripe Checkout (2026) renders the Payment Element in a js.stripe.com frame: Card is an accordion button there.
    for (const fr of [p.mainFrame(), ...p.frames()]) {
      const c = fr.locator('[data-testid="card-accordion-item-button"], button, [role="button"], [role="radio"]').filter({ hasText: /^\s*Card/ }).first();
      if (await c.count().catch(() => 0)) { await c.click({ timeout: 3_000 }).catch(() => c.dispatchEvent("click").catch(() => undefined)); break; }
    }
    await p.waitForTimeout(1_500);
    card = await findCard();
  }
  if (!card) {
    // What the page offers, for the next fix: field and button NAMES only (no values; a test page).
    const shape = [];
    for (const f of p.frames()) {
      const d = await f.evaluate(() => ({
        inputs: [...document.querySelectorAll("input,select")].slice(0, 30).map((e) => [e.id, (e as HTMLInputElement).name, e.getAttribute("autocomplete"), e.getAttribute("type")].filter(Boolean).join("/")),
        buttons: [...document.querySelectorAll("button,[role=button],[role=radio]")].slice(0, 20).map((e) => (e.getAttribute("data-testid") || (e.textContent ?? "").trim()).slice(0, 40)),
      })).catch(() => null);
      if (d) shape.push(`${new URL(f.url()).host}${new URL(f.url()).pathname.slice(0, 24)} inputs[${d.inputs.join(", ")}] buttons[${d.buttons.join(" | ")}]`);
    }
    throw new Error(`no card number field on Stripe's page; page shape: ${shape.join(" ;; ").slice(0, 1500)}`);
  }
  // A field by stable attributes, in whichever frame shows it (card frame first).
  const visible = async (sel: string) => { for (const fr of [card!.f, p.mainFrame(), ...p.frames()]) { const l = fr.locator(sel).first(); if (await l.isVisible().catch(() => false)) return l; } return null; };
  await card.l.fill(cardNo);
  await (await visible('input[autocomplete="cc-exp"], #cardExpiry, input[name="exp-date"], input[name="expiry"]'))?.fill("12 / 34");
  await (await visible('input[autocomplete="cc-csc"], #cardCvc, input[name="cvc"]'))?.fill("123");
  const nameField = await visible('#billingName, input[autocomplete="cc-name"], input[name="name"][autocomplete*="name"]');
  if (nameField && !(await nameField.inputValue().catch(() => ""))) await nameField.fill(name);
  const zip = await visible('#billingPostalCode, input[autocomplete="postal-code"], input[name="postalCode"]');
  if (zip) await zip.fill("48933");
  const country = await visible('select[autocomplete="country"], select[name="country"]');
  if (country) await country.selectOption("US").catch(() => undefined);
  const emailField = await visible('#email, input[autocomplete="email"]');
  if (emailField && await emailField.isEditable().catch(() => false) && !(await emailField.inputValue().catch(() => ""))) await emailField.fill(email);
  // Never save the test card to Link (it would ask for a phone number).
  for (const fr of [p.mainFrame(), ...p.frames()]) {
    const link = fr.locator('#enableStripePass, input[name="enableStripePass"], input[type="checkbox"][name*="link" i]').first();
    if ((await link.count().catch(() => 0)) && (await link.isChecked().catch(() => false))) await link.setChecked(false, { force: true }).catch(() => link.dispatchEvent("click").catch(() => undefined));
  }
  const submit = await visible('[data-testid="hosted-payment-submit-button"], [data-testid="payment-form-submit-button"], .SubmitButton');
  if (!submit) throw new Error("no Pay button on Stripe's page");
  await submit.click();
  if (cardNo !== "4242 4242 4242 4242") {
    // Stripe's published decline card: Checkout must refuse it and stay on its own page.
    // The decline message appears inside Stripe's payment frame (or on the page): look in every frame.
    const end = Date.now() + 60_000;
    for (;;) {
      for (const fr of [p.mainFrame(), ...p.frames()]) if (await fr.getByText(/declined/i).first().isVisible().catch(() => false)) return "declined";
      if (p.url().startsWith(BASE)) return "paid"; // must never happen with the decline card
      if (Date.now() > end) throw new Error("Stripe showed no decline message within 60s");
      await p.waitForTimeout(1_000);
    }
  }
  await p.waitForURL((u: URL) => u.href.startsWith(BASE), { timeout: 90_000 });
  return "paid";
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
      // The site's CSP forbids eval (correctly), so wait for the Turnstile token by polling the field, not waitForFunction.
      if (await p.locator(".cf-turnstile").count()) {
        const token = p.locator('[name="cf-turnstile-response"]').first();
        const end = Date.now() + 30_000;
        while (!(await token.inputValue().catch(() => ""))) { if (Date.now() > end) throw new Error("the Turnstile test widget produced no token within 30s"); await p.waitForTimeout(500); }
      }
      await Promise.all([p.waitForURL((u: URL) => u.pathname === `/checkout/${id}/review`, { timeout: 30_000 }), p.locator('form[data-testid="guest-intake"] button[type=submit]').click()]);
      const reviewText = await p.locator("main").innerText();
      check(reviewText.includes(price), `${id}: the review shows the server-side price ${price}`);
      // 2. Agreement + required maintenance plan → Stripe test Checkout, paid with the test card.
      await p.locator(`[name="maintenance_plan"][value="${plan}"]`).check();
      await p.locator('[name="terms"]').check();
      const payResponse = p.waitForResponse((r: any) => r.request().method() === "POST" && new URL(r.url()).pathname === `/checkout/${id}`, { timeout: 30_000 });
      await p.locator('button:has-text("Pay $")').click();
      const sessionUrl = (await payResponse).headers()["location"] ?? "";
      check(/cs_test_/.test(sessionUrl), `${id}: Pay creates a Stripe TEST-mode Checkout session`, sessionUrl ? `${new URL(sessionUrl).host} ${(/cs_test_[A-Za-z0-9]{0,6}/.exec(sessionUrl) ?? ["?"])[0]}…` : "no redirect");
      await payOnStripe(p, email, "Guest Purchase Probe", sessionUrl);
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
      check(false, `${id}: journey`, (e as Error).message.slice(0, 1800));
      await p.screenshot({ path: `evidence/guest-purchase-${id}-failure.png`, fullPage: true }).catch(() => undefined);
    } finally { await ctx.close(); }
  }
  // Returning customer: an email that already has an account is never taken over; the visitor is asked to sign in.
  if (pkgs.includes("starter")) {
    const ctx = await browser.newContext(); const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/checkout/business/intake`);
      await fillForm(p, { business_name: `[Guest purchase ${run}] returning`, contact_name: "Guest Purchase Probe", contact_email: `delivered+guest-${run}-starter@resend.dev`, contact_phone: "(517) 555-0100", industry: "Automated check",
        business_description: "Automated staging purchase check; not a real order.", goals: "Verify a returning customer.", target_audience: "None.", has_branding: "no", brand_style: "None", design_preferences: "None", pages: "Home",
        content_source: "crestmont_draft", images_source: "licensed", domain_status: "need", domain_wishes: "none.example", hosting: "crestmont", special_instructions: "AUTOMATED STAGING CHECK." });
      if (await p.locator(".cf-turnstile").count()) { const t = p.locator('[name="cf-turnstile-response"]').first(); const end = Date.now() + 30_000; while (!(await t.inputValue().catch(() => "")) && Date.now() < end) await p.waitForTimeout(500); }
      const resp = p.waitForResponse((r: any) => r.request().method() === "POST" && new URL(r.url()).pathname === "/checkout/business/intake", { timeout: 30_000 });
      await p.locator('form[data-testid="guest-intake"] button[type=submit]').click();
      const r = await resp;
      check(r.status() === 409 && /already has a Crestmont account/.test(await p.locator("main").innerText()), "returning customer: an existing account's email is asked to sign in, never taken over", `HTTP ${r.status()}`);
    } catch (e) { check(false, "returning customer", (e as Error).message.slice(0, 400)); } finally { await ctx.close(); }
  }
  // Failed payment: Stripe's decline card is refused on Stripe's page; nothing is provisioned for that buyer.
  {
    const ctx = await browser.newContext(); const p = await ctx.newPage();
    const email = `delivered+guest-${run}-declined@resend.dev`;
    try {
      await p.goto(`${BASE}/checkout/starter/intake`);
      await fillForm(p, { business_name: `[Guest purchase ${run}] declined card`, contact_name: "Guest Purchase Probe", contact_email: email, contact_phone: "(517) 555-0100", industry: "Automated check",
        business_description: "Automated staging purchase check; not a real order.", goals: "Verify a declined payment.", target_audience: "None.", has_branding: "no", brand_style: "None", design_preferences: "None", pages: "Home",
        content_source: "crestmont_draft", images_source: "licensed", domain_status: "need", domain_wishes: "none.example", hosting: "crestmont", special_instructions: "AUTOMATED STAGING CHECK." });
      if (await p.locator(".cf-turnstile").count()) { const t = p.locator('[name="cf-turnstile-response"]').first(); const end = Date.now() + 30_000; while (!(await t.inputValue().catch(() => "")) && Date.now() < end) await p.waitForTimeout(500); }
      await Promise.all([p.waitForURL((u: URL) => u.pathname === "/checkout/starter/review", { timeout: 30_000 }), p.locator('form[data-testid="guest-intake"] button[type=submit]').click()]);
      await p.locator('[name="maintenance_plan"][value="essential"]').check();
      await p.locator('[name="terms"]').check();
      const payResponse = p.waitForResponse((r: any) => r.request().method() === "POST" && new URL(r.url()).pathname === "/checkout/starter", { timeout: 30_000 });
      await p.locator('button:has-text("Pay $")').click();
      const sessionUrl = (await payResponse).headers()["location"] ?? "";
      const outcome = await payOnStripe(p, email, "Guest Purchase Probe", sessionUrl, "4000 0000 0000 0002");
      await sleep(15_000);
      const u = d1(`SELECT id FROM users WHERE email = ${q(email)}`)[0];
      const orders = u ? d1(`SELECT o.status FROM orders o JOIN memberships m ON m.organization_id = o.organization_id WHERE m.user_id = ${q(u.id)}`) : [];
      const projects = u ? d1(`SELECT p.id FROM projects p JOIN memberships m ON m.organization_id = p.organization_id WHERE m.user_id = ${q(u.id)}`) : [];
      const setups = d1(`SELECT id FROM email_deliveries WHERE to_email = ${q(email)} AND template = 'account_setup'`);
      check(outcome === "declined" && orders.every((o) => o.status !== "paid") && projects.length === 0 && setups.length === 0,
        "failed payment: Stripe declines the card, the order stays unpaid, no project and no account-setup email", JSON.stringify({ outcome, orders: orders.map((o) => o.status), projects: projects.length, setups: setups.length }));
    } catch (e) { check(false, "failed payment", (e as Error).message.slice(0, 600)); } finally { await ctx.close(); }
  }
  const internal = d1(`SELECT status, provider_message_id AS pm FROM email_deliveries WHERE template = 'internal_alert' AND created_at >= ${q(internalSince)}`);
  check(internal.length >= 1 && internal.every((x) => x.pm), "internal new-order notices sent to the Crestmont operations mailbox and accepted by Resend", `${internal.length} notice(s)`);
} finally {
  await browser.close();
}
console.log(failed ? `${failed} check(s) failed` : `guest purchase journey verified on staging for ${pkgs.join(", ")} (Stripe test mode)`);
process.exit(failed ? 1 : 0);
