// The 33 required E2E journeys (directive §69, TEST-002) against the DEPLOYED, public staging site.
// Uses only what a real person has: a browser and the demo accounts the deploy
// workflow issues (access/demo-accounts.md). No database access, no webhook secrets, no fixtures.
//   E2E_BASE_URL          https://crestmont-platform-staging.<subdomain>.workers.dev
//   E2E_ACCOUNTS_FILE     demo-accounts.md (| role | email | `password` | `TOTPKEY` or — | note |)
// Journeys 29–30 additionally act as the CI client of the readiness API (as the deploy workflow does):
//   EVIDENCE_INGEST_SECRET          set by the workflow's "Evidence ingest secret" step
//   E2E_CI_EVIDENCE_FILE            default evidence/ci-evidence.json (written by `npm test` earlier in the run)
//   E2E_STAGING_CHECK_FILE          default evidence/staging-check.json (written by the smoke step)
// Without the three E2E_* variables the whole file reports itself skipped.
//
// Honesty rules:
//  - Journeys that cannot happen on staging today are explicit skips naming the CURRENT blocker, read from staging
//    where possible (journey 25 asks staging whether maintenance plans can be bought; 27–28 look for a real call).
//    Production-only journeys (31–33, LAUNCH-001) are reported separately. Nothing is simulated and nothing is
//    reported as passed.
//  - Journeys 4–8, 17 and 19 use a FRESH project created and paid for (Stripe test mode) on every run, so they are
//    repeatable; other post-payment journeys run against the seeded sample projects (Harbor Dental: design stage,
//    tasks assigned; Ridgeline Landscaping). Every record created carries the run id; mutations of sample records are additive or reversed
//    (approvals are superseded by later decisions, the milestone status is restored, the E2E task and file
//    are deleted, refund requests end denied, tickets end resolved). Sample projects are never cancelled,
//    deployed or closed.
//  - Re-runnable on the same staging database: nothing depends on a fresh database; stale state left by an
//    interrupted earlier run (an open approval request, a pending refund) is resolved first.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { launchBrowser, evidenceRunLink } from "./support.ts";
import { totpCode } from "../../src/lib/auth-crypto.ts";
import { signEvidence } from "../../src/readiness/ingest.ts";

const BASE = process.env.E2E_BASE_URL?.replace(/\/$/, "");
const ACCOUNTS = process.env.E2E_ACCOUNTS_FILE;
const unset = !BASE || !ACCOUNTS ? "E2E_BASE_URL / E2E_ACCOUNTS_FILE not set (staging journeys run only against deployed staging)" : "";
const RUN = `e2e-${Date.now().toString(36)}`;
const TIMEOUT = 30_000;

type Page = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Playwright is loaded at runtime (zero-dependency repo)
type Ctx = any; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Actor { ctx: Ctx; page: Page }
type Account = { role: string; email: string; password: string; totp?: string };

function accounts(): Account[] {
  const md = readFileSync(ACCOUNTS!, "utf8");
  return [...md.matchAll(/^\| (\w+) \| (\S+) \| `([^`]+)` \| (?:`([A-Z2-7]+)`|—) \|/gm)].map((m) => ({ role: m[1], email: m[2], password: m[3], totp: m[4] }));
}
const account = (key: string) => {
  const a = accounts().find((x) => x.role === key || x.email.startsWith(`${key}@`));
  assert.ok(a, `demo account "${key}" in ${ACCOUNTS}`);
  return a!;
};

let browser: Awaited<ReturnType<typeof launchBrowser>>;
before(async () => { if (!unset) browser = await launchBrowser(); });
after(async () => { await stripeDiagnostics().catch(() => undefined); for (const a of Object.values(people)) await a.ctx.close().catch(() => undefined); await browser?.close(); });

/** Read-only Stripe diagnostics for the deploy log (the raw job log and artifacts are often unreadable from review
 * sessions, so the workflow turns this file into annotations): the Owner's view of Stripe events needing attention,
 * the newest disputes, and what the journey customer sees on billing and projects. Staff-visible data only; no secrets. */
async function stripeDiagnostics() {
  if (unset || !people.newCustomer || !people.owner) return;
  const grab = async (pg: Page, url: string, sel = "main") => { try { await pg.goto(url); return (await text(pg, sel)).replace(/\s+/g, " ").slice(0, 900); } catch (e) { return `unavailable: ${(e as Error).message.split("\n")[0]}`; } };
  const o = people.owner.page, c = people.newCustomer.page;
  const section = async (pg: Page, url: string, heading: string) => { try { await pg.goto(url); return ((await pg.locator("section.card", { hasText: heading }).first().innerText()) as string).replace(/\s+/g, " ").slice(0, 900); } catch (e) { return `unavailable: ${(e as Error).message.split("\n")[0]}`; } };
  // The read-only Stripe probe (GET /v1/balance and /v1/webhook_endpoints): is a webhook endpoint registered for
  // <APP_URL>/api/webhooks/stripe, enabled, at a supported version, with every handled event?
  let probe = "";
  try {
    await o.goto(`${BASE}/staff/integrations`);
    const row = o.locator("main tbody tr", { hasText: /^\s*Stripe/ }).first();
    await nav(o, row.getByRole("button", { name: "Run check" }));
    probe = `${await alerts(o)} | row: ${((await o.locator("main tbody tr", { hasText: /^\s*Stripe/ }).first().innerText()) as string).replace(/\s+/g, " ").slice(0, 2000)}`;
  } catch (e) { probe = `unavailable: ${(e as Error).message.split("\n")[0]}`; }
  const lines = [
    `stripe probe: ${probe}`,
    `stripe events needing attention: ${await section(o, `${BASE}/staff/monitoring`, "Stripe events needing attention")}`,
    `disputes: ${await grab(o, `${BASE}/staff/disputes`)}`,
    `customer billing: ${await grab(c, `${BASE}/portal/billing`)}`,
    `customer projects: ${await grab(c, `${BASE}/portal/projects`)}`,
  ];
  mkdirSync("evidence", { recursive: true });
  writeFileSync("evidence/stripe-diagnostics.txt", lines.join("\n") + "\n");
}

// ───────────── browser helpers ─────────────

const issues: string[] = [];
function watch(page: Page) {
  page.on("dialog", (d: { accept(): Promise<void> }) => d.accept()); // data-confirm prompts
  page.on("console", (m: { type(): string; text(): string }) => {
    const t = m.text();
    if (m.type() !== "error" || /fonts\.(googleapis|gstatic)\.com|challenges\.cloudflare\.com|turnstile/i.test(t) || !page.url().startsWith(BASE!)) return;
    if (/Content Security Policy|Refused to/i.test(t)) issues.push(`CSP: ${t} @ ${page.url()}`);
  });
  page.on("pageerror", (e: Error) => { if (page.url().startsWith(BASE!)) issues.push(`JS error: ${e.message} @ ${page.url()}`); });
  page.on("response", (r: { status(): number; url(): string }) => { if (r.status() >= 500 && r.url().startsWith(BASE!)) issues.push(`HTTP ${r.status()} ${r.url()}`); });
}
function assertClean() { assert.deepEqual(issues.splice(0), [], "no CSP violations, JS errors or 5xx responses"); }

/** A fresh browser context with NO cookies (a first-time visitor): staging is public since 2026-10-28, so the homepage
 * must load directly, with no preview password prompt. Each actor then signs in with its own demo account. */
async function previewContext(): Promise<Actor> {
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(TIMEOUT);
  const page = await ctx.newPage();
  watch(page);
  const r = await page.goto(BASE + "/");
  assert.equal(r?.status(), 200, "public homepage loads for a fresh visitor");
  assert.doesNotMatch(await page.content(), /Preview password|__preview-access/i, "no preview password prompt");
  return { ctx, page };
}

async function nav(page: Page, target: string | { click(): Promise<void> }) {
  const loc = typeof target === "string" ? page.locator(target) : target;
  await Promise.all([page.waitForNavigation({ waitUntil: "load" }), loc.click()]);
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const btn = (scope: Page, name: string | RegExp) => scope.getByRole("button", { name: typeof name === "string" ? new RegExp(`^${esc(name)}$`, "i") : name }).first();
const text = async (page: Page, sel = "main") => (await page.locator(sel).first().innerText()) as string;
const alerts = async (page: Page) => (await page.locator(".alert, .toast").allInnerTexts().catch(() => [])).join(" | ");
const re = (s: string) => new RegExp(esc(s), "i");

/** Every code attempt counts toward the account's limit (8 per 15 minutes, refused ones included), and a code is
 * accepted once per 30 s step. Entering each code in a fresh step means no attempt is spent on a replay of a code
 * another sign-in of the same account used moments earlier (deploy #71). */
const freshTotpStep = () => new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 1_000));

/** Sign in through the real login page. Staff complete TOTP; a code is single-use per 30 s step, so when the
 * current step was already used (another sign-in of the same account moments ago) wait for the next one. */
async function signIn(page: Page, a: Account) {
  await page.goto(BASE + "/login");
  await page.fill("#f-email", a.email);
  await page.fill("#f-password", a.password);
  await nav(page, "button[type=submit]");
  for (let attempt = 0; new URL(page.url()).pathname.startsWith("/mfa") && attempt < 2; attempt++) {
    assert.ok(a.totp, `${a.role} needs a TOTP key`);
    if (attempt > 0 && /Too many codes/i.test(await alerts(page))) break; // never retry into the attempt limit
    await freshTotpStep();
    await page.fill("#f-code", await totpCode(a.totp!));
    await nav(page, "button[type=submit]");
  }
  assert.doesNotMatch(new URL(page.url()).pathname, /^\/(login|mfa)/, `signed in as ${a.role} (${await alerts(page)})`);
}

/** One signed-in browser per person for the whole file (each account signs in once). */
const people: Record<string, Actor> = {};
async function as(key: string): Promise<Page> {
  if (!people[key]) {
    const a = await previewContext();
    await signIn(a.page, account(key));
    people[key] = a;
  }
  return people[key].page;
}

/** Text body of the newest dev-outbox message to `to` (optionally of a template, containing `marker`), read by the Owner. */
async function outbox(to: string, template: string, marker?: string): Promise<string> {
  const o = await as("owner");
  await o.goto(`${BASE}/staff/email?to=${encodeURIComponent(to)}&template=${template}`);
  const hrefs: string[] = await o.locator('main table a[href^="/staff/email/"]').evaluateAll((as: HTMLAnchorElement[]) => as.map((a) => a.getAttribute("href")!));
  for (const h of hrefs.slice(0, 5)) {
    await o.goto(BASE + h);
    const body = await text(o, "pre.code-block");
    if (!marker || body.includes(marker)) return body;
  }
  throw new Error(`no ${template} email to ${to}${marker ? ` containing ${marker}` : ""} in the outbox`);
}
/** A link to `path` in an email body, re-based on the preview URL (emails use the Worker's own origin). */
function linkIn(body: string, path: string): string {
  const m = new RegExp(`https?://[^\\s/]+(${esc(path)}[^\\s)>\\]]*)`).exec(body);
  assert.ok(m, `no ${path} link in:\n${body}`);
  return BASE + m![1];
}
/** Staging uses Cloudflare Turnstile (always-pass test keys); wait for its token before submitting. */
async function awaitTurnstile(page: Page) {
  if (!(await page.locator(".cf-turnstile").count())) return; // development: no widget
  // Not page.waitForFunction: Playwright evaluates its predicate in the page with new Function(), which the site's CSP
  // (script-src without 'unsafe-eval') refuses — deploy #57 journey 1 failed with exactly that EvalError. Locator reads
  // run in Playwright's own context, so the real CSP stays in force for everything the page itself does.
  const token = page.locator("[name='cf-turnstile-response']").first();
  for (const until = Date.now() + TIMEOUT; ; await page.waitForTimeout(250)) {
    if ((await token.count()) && (await token.inputValue())) return;
    if (Date.now() > until) throw new Error(`Turnstile produced no token within ${TIMEOUT / 1000}s`);
  }
}
/** Step-up MFA before a sensitive action (src/app/step-up.ts). Codes are single-use per 30 s step, so on a replay wait for the next step. */
async function freshMfa(page: Page, a: Account) {
  const back = new URL(page.url()).pathname + new URL(page.url()).search;
  await page.goto(`${BASE}/mfa/step-up?next=${encodeURIComponent(back)}`);
  for (let attempt = 0; new URL(page.url()).pathname === "/mfa/step-up" && attempt < 2; attempt++) {
    if (attempt > 0 && /Too many codes/i.test(await alerts(page))) break; // never retry into the attempt limit
    await freshTotpStep();
    await page.fill("#f-code", await totpCode(a.totp!));
    await nav(page, "button[type=submit]");
  }
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, back, `step-up check passed for ${a.role} (${await alerts(page)})`);
}
async function projectId(customer: string, name: RegExp): Promise<string> {
  const c = await as(customer);
  await c.goto(BASE + "/portal/projects");
  const href = await c.locator("main a", { hasText: name }).first().getAttribute("href");
  assert.match(href ?? "", /^\/portal\/projects\/prj_/, `sample project ${name} on staging`);
  return href!.split("/").pop()!;
}

// ───────────── journey bookkeeping ─────────────

const outcome = new Map<number, string>(); // journey → "passed" | reason it did not pass
function journey(n: number, tags: string[], title: string, opts: { needs?: number[]; blocked?: string }, fn?: (t: { skip(reason: string): void }) => Promise<void>) {
  const name = `[TEST-002] ${tags.map((t) => `[${t}]`).join(" ")} journey ${n}: ${title}`;
  if (unset || opts.blocked) {
    test(name, { skip: unset || opts.blocked }, () => {});
    outcome.set(n, unset || opts.blocked!);
    return;
  }
  test(name, async (t) => {
    const missing = (opts.needs ?? []).filter((d) => outcome.get(d) !== "passed");
    if (missing.length) {
      const why = `needs journey ${missing.join(", ")} (${missing.map((d) => outcome.get(d) ?? "not run").join("; ")})`;
      outcome.set(n, why);
      t.skip(why);
      return;
    }
    let skipped = "";
    try {
      await fn!({ skip: (reason: string) => { skipped = reason; t.skip(reason); } });
      outcome.set(n, skipped || "passed");
    } catch (e) {
      outcome.set(n, `failed: ${(e as Error).message.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 8).join(" ").replace(/\s+/g, " ").slice(0, 400)}`);
      for (const [who, a] of Object.entries(people)) console.error(`[${who}] ${a.page.url()} ${await alerts(a.page)}`);
      throw e;
    }
  });
}

// ───────────── shared state ─────────────

const contact = { name: `Morgan Reyes ${RUN}`, email: `morgan.${RUN}@staging-journeys.example`, company: `E2E Coffee ${RUN}`, password: `E2e-${RUN}-pass!` };
const lines = [{ desc: "Online ordering system", dollars: "6,000", cents: 600_000 }, { desc: "Loyalty portal", dollars: "1500.50", cents: 150_050 }];
const total = lines.reduce((s, l) => s + l.cents, 0);
const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents % 100 ? 2 : 0 });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
let leadUrl = "", proposalUrl = "", taskTitle = "", ticketUrl = "";
/** Set by journey 4 from what staging itself shows: "test" when the deposit invoice offers Stripe test-mode checkout. */
let payments: "unconfigured" | "test" = "unconfigured";
let depositInvoiceUrl = "";
let revision: { mode: "included" | "billable"; allowance: number; usedBefore: number } | null = null;
const HARBOR = /Harbor Dental/, RIDGELINE = /Ridgeline/;

// ───────────── 1–4. Lead → CRM → quote → acceptance ─────────────

journey(1, ["WEB-005"], "visitor submits a lead through the public quote form", {}, async () => {
  const v = await previewContext();
  const p = v.page;
  await p.goto(BASE + "/quote");
  await p.fill("#f-name", contact.name);
  await p.fill("#f-email", contact.email);
  await p.fill("#f-company", contact.company);
  await p.selectOption("#f-interest", "custom");
  await p.selectOption("#f-budget", "$5,000 – $10,000");
  await p.selectOption("#f-timeline", "1 – 3 months");
  await p.fill("#f-message", `E2E staging journey ${RUN}: online ordering for three cafés and a loyalty portal.`);
  await awaitTurnstile(p);
  await nav(p, btn(p, "Request my quote"));
  assert.equal(new URL(p.url()).pathname, "/quote/thanks", await alerts(p));
  assert.match(await text(p, "h1"), /Quote request received/);
  await v.ctx.close();
  assertClean();
});

journey(2, ["CRM-001"], "lead appears in the CRM with its source, is assigned and shows in the sales pipeline", { needs: [1] }, async () => {
  const o = await as("owner");
  await o.goto(`${BASE}/staff/crm?q=${encodeURIComponent(RUN)}`);
  await nav(o, o.locator("a.kanban__card", { hasText: contact.name }));
  leadUrl = o.url();
  assert.match(new URL(leadUrl).pathname, /^\/staff\/crm\/leads\/ld_/);
  const detail = await text(o);
  assert.match(detail, /Source\s+Quote form/i, "source tracked");
  assert.match(detail, /Budget range: \$5,000 – \$10,000/);
  assert.match(detail, re(contact.email));
  const salesOption = await o.locator("#f-owner option", { hasText: /sales/i }).first().getAttribute("value");
  await o.selectOption("#f-owner", salesOption);
  await nav(o, btn(o, "Save owner"));
  assert.match(await text(o), /Owner\s+[^\n]*Sales/i);
  const s = await as("sales");
  await s.goto(`${BASE}/staff/crm?q=${encodeURIComponent(RUN)}`);
  assert.match(await text(s), re(contact.name), "lead in the assigned rep's pipeline");
  assertClean();
});

journey(3, ["SALES-002", "SALES-003"], "sales qualifies the lead, builds a custom quote (server-side totals) and sends the proposal", { needs: [2] }, async () => {
  const s = await as("sales");
  await s.goto(leadUrl);
  for (const to of ["qualified", "quote_required"]) {
    await s.selectOption("#f-to", to);
    await nav(s, btn(s, "Change stage"));
  }
  assert.match(await text(s), /Quote required/i);
  await nav(s, s.getByRole("link", { name: "New quote" }));
  await s.selectOption("#f-package", "custom");
  for (const [i, l] of lines.entries()) { await s.fill(`#line-desc-${i}`, l.desc); await s.fill(`#line-amt-${i}`, l.dollars); }
  await s.fill("#f-scope", `E2E ${RUN}: online ordering for three locations, loyalty accounts, admin portal, 3 revision rounds.`);
  await nav(s, btn(s, "Save draft (v1)"));
  const q = await text(s);
  assert.match(q, new RegExp(`Total ${esc(usd(total))}`, "i"));
  assert.match(q, new RegExp(`50% deposit on acceptance\\s+${esc(usd(Math.floor(total / 2)))}`, "i"));
  await nav(s, btn(s, "Send proposal"));
  proposalUrl = linkIn(await outbox(contact.email, "quote_sent"), "/q/");
  await s.goto(leadUrl);
  assert.match(await text(s), /Quote sent/i);
  assertClean();
});

journey(4, ["SALES-004"], "customer registers from the proposal, verifies the email, signs in and accepts the quote → order and deposit invoice", { needs: [3] }, async () => {
  const c = await previewContext();
  people.newCustomer = c;
  const p = c.page;
  await p.goto(proposalUrl);
  assert.match(await text(p), /Ready to accept\?/);
  await nav(p, p.getByRole("link", { name: "Create account" }));
  await p.fill("#f-name", contact.name);
  await p.fill("#f-organization", contact.company);
  await p.fill("#f-email", contact.email);
  await p.fill("#f-password", contact.password);
  await p.check("input[name=terms]");
  await awaitTurnstile(p); // /register is bot-protected (always-pass test keys on staging)
  await nav(p, "button[type=submit]");
  assert.match(await text(p, "h1"), /Check your email/, await alerts(p));
  await p.goto(linkIn(await outbox(contact.email, "verification"), "/verify-email"));
  await signIn(p, { role: "customer_admin", email: contact.email, password: contact.password });
  await p.goto(proposalUrl);
  assert.match(await text(p), new RegExp(esc(usd(total))));
  await p.check("input[name=agree]");
  await nav(p, btn(p, "Accept and continue to payment"));
  assert.match(new URL(p.url()).pathname, /^\/portal\/billing\/invoices\/inv_/, await alerts(p));
  const inv = await text(p);
  assert.match(inv, new RegExp(esc(usd(Math.floor(total / 2)))), "50% deposit invoice");
  assert.match(inv, /Open/i);
  // Without a Stripe test key (BLK-004) the page must say so instead of offering a payment button; with one it offers
  // Stripe test-mode checkout. Either is correct; anything else (a pay button that is not Stripe, or neither) fails.
  depositInvoiceUrl = p.url();
  if (/Online payment is not configured yet\./.test(inv)) payments = "unconfigured";
  else {
    assert.match(inv, new RegExp(`Pay ${esc(usd(Math.floor(total / 2)))} securely`), "a Stripe checkout button for the deposit");
    assert.match(inv, /taken to Stripe's secure checkout/);
    payments = "test";
  }
  const s = await as("sales");
  await s.goto(leadUrl);
  assert.match(await text(s), /Awaiting payment/i);
  assertClean();
});

// ───────────── 5–7. Payment (Stripe) ─────────────

const NO_STRIPE = "BLK-004: no Stripe test-mode key is configured on staging (the deposit invoice says online payment is not configured), so no checkout, payment or signed Stripe webhook can occur; the development suite covers the handler with signed fixtures";
const STRIPE_TEST_CARD = { number: "4242 4242 4242 4242", expiry: "12 / 34", cvc: "123" }; // Stripe's published test card

/** Completes Stripe's hosted Checkout in TEST mode with the published test card. Refuses anything but a test session. */
async function payOnStripeCheckout(p: Page, testCard: { number: string; expiry: string; cvc: string } = STRIPE_TEST_CARD): Promise<void> {
  await p.waitForURL(/^https:\/\/checkout\.stripe\.com\//, { timeout: 60_000 });
  assert.match(p.url(), /\/c\/pay\/cs_test_/, "a Stripe TEST-mode checkout session (never live)");
  // Checkout renders the card inputs (#cardNumber, #cardExpiry, #cardCvc) only once Card is SELECTED in its payment-method
  // accordion. The accordion's card-accordion-item-button is a zero-size click overlay (classes "AccordionButton-open
  // AccordionButton-expandedClickArea" even while collapsed), so Playwright reports it "not visible" and never clicks it
  // (deploys 41173061886-41182841756). Inspected on Stripe's live test-mode Checkout (checkout.stripe.dev, 2026-10-31):
  // a click event dispatched on that button selects Card and renders the inputs, which is what a real user's click on
  // the visible Card header does.
  const cardNumber = p.locator("#cardNumber");
  const cardButton = p.locator('[data-testid="card-accordion-item-button"]').first();
  await Promise.any([cardNumber.waitFor({ state: "visible", timeout: 30_000 }), cardButton.waitFor({ state: "attached", timeout: 30_000 })]).catch(() => undefined);
  if (!(await cardNumber.isVisible()) && (await cardButton.count())) await cardButton.dispatchEvent("click");
  await cardNumber.waitFor({ state: "visible", timeout: 30_000 });
  await cardNumber.fill(testCard.number);
  await p.locator("#cardExpiry").fill(testCard.expiry);
  await p.locator("#cardCvc").fill(testCard.cvc);
  if (await p.locator("#billingName").count()) await p.locator("#billingName").fill(contact.name);
  if (await p.locator("#billingPostalCode").isVisible().catch(() => false)) await p.locator("#billingPostalCode").fill("48933");
  if (await p.locator("#email").isEditable().catch(() => false)) await p.locator("#email").fill(contact.email);
  // "Save my information with Link" is pre-checked and makes a phone number required, so the payment cannot submit.
  // Opt out (no Link account is created for a test customer).
  const link = p.locator("#enableStripePass");
  if ((await link.count()) && (await link.isChecked())) await link.dispatchEvent("click");
  if ((await link.count()) && (await link.isChecked())) await link.setChecked(false, { force: true });
  await p.locator('[data-testid="hosted-payment-submit-button"], .SubmitButton').first().click();
  await p.waitForURL((u: URL) => u.href.startsWith(BASE!), { timeout: 90_000 });
}
/** Reloads `url` until `re` matches the page (the Stripe webhook arrives asynchronously). */
async function until(p: Page, url: string, re: RegExp, what: string, ms = 120_000): Promise<string> {
  const end = Date.now() + ms;
  for (;;) {
    await p.goto(url);
    const t = await text(p);
    if (re.test(t)) return t;
    if (Date.now() > end) assert.fail(`${what} did not happen within ${ms / 1000}s. Page: ${t.slice(0, 200).replace(/\s+/g, " ")}`);
    await p.waitForTimeout(5_000);
  }
}

journey(5, ["PAY-001"], "customer completes payment in Stripe test mode", { needs: [4] }, async (t) => {
  if (payments !== "test") { t.skip(NO_STRIPE); return; }
  const p = people.newCustomer.page;
  await p.goto(depositInvoiceUrl);
  await nav(p, btn(p, `Pay ${usd(Math.floor(total / 2))} securely`));
  await payOnStripeCheckout(p);
  assert.match(new URL(p.url()).search + new URL(p.url()).pathname, /checkout=success|\/portal\/billing/, "Stripe returns to the portal");
  assertClean();
});

journey(6, ["PAY-003"], "payment webhook creates the order", { needs: [5] }, async () => {
  const p = people.newCustomer.page;
  // The invoice's own status badge must read Paid. (Deploy 41187430075 passed this journey on the words "Paid to date"
  // and "Receipts" while the invoice was still Open and no payment had been recorded.)
  const end = Date.now() + 120_000;
  for (;;) {
    await p.goto(depositInvoiceUrl);
    const status = ((await p.locator("main .badge").first().innerText().catch(() => "")) as string).trim();
    if (/^Paid$/i.test(status)) break;
    if (Date.now() > end) assert.fail(`the signed Stripe webhook did not mark the deposit paid within 120s (invoice status "${status}")`);
    await p.waitForTimeout(5_000);
  }
  await p.goto(`${BASE}/portal/billing`);
  const receipts = p.locator('main a[href^="/portal/billing/receipts/"]');
  assert.equal(await receipts.filter({ hasText: /^Receipt$/ }).count(), 1, "exactly one receipt for the deposit (charged once)");
  assert.match(await text(p), new RegExp(esc(usd(Math.floor(total / 2)))), "the receipt shows the deposit amount");
  assertClean();
});

journey(7, ["SALES-004"], "project is provisioned after payment", { needs: [6] }, async () => {
  const p = people.newCustomer.page;
  const list = await until(p, `${BASE}/portal/projects`, /prj_|Project/i, "project provisioning after the paid deposit");
  assert.equal((list.match(new RegExp(esc(contact.company), "g")) ?? []).length <= 1, true, "exactly one project for the order (no duplicate provisioning)");
  assert.ok(await p.locator('main a[href^="/portal/projects/prj_"]').count(), "the provisioned project is listed for the customer");
  const s = await as("sales");
  await s.goto(leadUrl);
  assert.doesNotMatch(await text(s), /Awaiting payment/i, "the lead is no longer awaiting payment");
  assertClean();
});

// ───────────── 8–9. Onboarding (this run's project) and files (seeded sample project) ─────────────

/** The project journey 7 provisioned for this run's customer (a fresh, isolated project on every run). */
let runProjectId = "";
async function runProject(): Promise<string> {
  if (runProjectId) return runProjectId;
  const c = people.newCustomer.page;
  await c.goto(`${BASE}/portal/projects`);
  const href = await c.locator('main a[href^="/portal/projects/prj_"]', { hasText: contact.company }).first().getAttribute("href");
  assert.match(href ?? "", /^\/portal\/projects\/prj_/, "this run's provisioned project");
  return (runProjectId = href!.split("/").pop()!);
}

journey(8, ["PORTAL-002"], "customer completes conditional onboarding (this run's freshly provisioned project) and the PM sees the answers", { needs: [7] }, async () => {
  // Repeatable: journeys 4–7 create and pay for a new project on every run, so there is always a project awaiting
  // onboarding (the seeded Ridgeline sample could only be onboarded once).
  const id = await runProject();
  // The Owner assigns the project manager, as for any new project.
  const o = await as("owner");
  await o.goto(`${BASE}/staff/projects/${id}`);
  const pmForm = o.locator('form[action$="/pm"]');
  const pmId = await pmForm.locator("select[name=user_id] option", { hasText: /manager/i }).first().getAttribute("value");
  await pmForm.locator("select[name=user_id]").selectOption(pmId);
  await nav(o, pmForm.getByRole("button", { name: "Save" }));
  assert.match(await alerts(o), /Project manager updated/i);
  const c = people.newCustomer.page;
  await c.goto(`${BASE}/portal/projects/${id}/onboarding`);
  assert.ok(await c.locator("#f-industry").count(), `the new project awaits onboarding. Page: ${(await text(c)).slice(0, 160).replace(/\s+/g, " ")}`);
  const visible = (sel: string) => c.locator(sel).isVisible();
  for (const [sel, v] of [["#f-business_name", contact.company], ["#f-contact_name", contact.name]] as const) {
    if (!(await c.locator(sel).inputValue())) await c.fill(sel, v);
  }
  await c.fill("#f-industry", `Cafés (${RUN})`);
  await c.fill("#f-goals", "Online ordering for three cafés and a loyalty programme.");
  await c.fill("#f-target_audience", "Regular customers and office lunch orders.");
  assert.equal(await visible("#f-brand_style"), false, "style question hidden until the branding answer");
  await c.check("input[name=has_branding][value=no]");
  assert.equal(await visible("#f-brand_style"), true, "style question shown when there is no branding");
  assert.equal(await visible("#f-logo"), false);
  await c.fill("#f-brand_style", "Warm, friendly, coffee browns.");
  await c.fill("#f-pages", "Home, Menu, Order online, Loyalty, Locations, Contact");
  await c.check("input[name=functionality][value=booking]");
  assert.equal(await visible("#f-booking_details"), true, "booking follow-up appears");
  await c.check("input[name=content_source][value=crestmont_draft]");
  await c.check("input[name=images_source][value=licensed]");
  await c.check("input[name=domain_status][value=need]");
  assert.equal(await visible("#f-domain_wishes"), true);
  await c.fill("#f-domain_wishes", `${RUN}.staging-journeys.example`);
  await c.check("input[name=hosting][value=crestmont]");
  // Submitting without the now-required booking details is refused server-side and keeps what was typed.
  await nav(c, btn(c, "Submit onboarding"));
  assert.match(await text(c, ".alert--error"), /Booking details is required/);
  assert.equal(await c.locator("#f-industry").inputValue(), `Cafés (${RUN})`);
  await c.fill("#f-booking_details", "Customers reserve catering pickups; we use a paper diary today.");
  await nav(c, btn(c, "Submit onboarding"));
  assert.equal(new URL(c.url()).pathname, `/portal/projects/${id}`, await alerts(c));
  assert.match(await text(c), /Scope review/i);
  const pm = await as("project_manager");
  await pm.goto(`${BASE}/staff/projects/${id}`);
  assert.match(await text(pm), re(`Cafés (${RUN})`), "PM sees the onboarding answers");
  assertClean();
});

journey(9, ["PORTAL-004", "FILE-001"], "customer uploads a project file (sample Harbor project), previews it and removes it", {}, async (t) => {
  const id = await projectId("customer.harbor", HARBOR);
  const c = await as("customer.harbor");
  const name = `e2e-${RUN}.png`;
  await c.goto(`${BASE}/portal/projects/${id}/files`);
  await c.setInputFiles("#f-file", { name, mimeType: "image/png", buffer: PNG });
  await c.fill("#f-folder", "E2E uploads");
  await nav(c, btn(c, "Upload"));
  const after = `${await alerts(c)} ${await text(c)}`;
  if (/File storage is not configured/i.test(after)) {
    t.skip("file storage (R2) is not enabled on the staging Cloudflare account; the portal honestly refuses uploads (see the deploy workflow warning 'File uploads disabled on staging')");
    return;
  }
  assert.match(after, re(name), "upload listed");
  await nav(c, c.getByRole("link", { name }));
  const img = c.locator("main img").first();
  await img.evaluate((el: HTMLImageElement) => el.decode().catch(() => undefined));
  assert.ok((await img.evaluate((el: HTMLImageElement) => el.naturalWidth)) > 0, "preview renders under the CSP");
  // Leave the sample project as it was.
  await nav(c, c.locator('form[action$="/delete"]').getByRole("button").first());
  await c.goto(`${BASE}/portal/projects/${id}/files`);
  assert.doesNotMatch(await text(c), re(name), "E2E file removed");
  assertClean();
});

// ───────────── 10–11. PM tasks, developer milestones ─────────────

journey(10, ["PM-004"], "PM assigns a new task on the sample Harbor project to the developer", {}, async () => {
  const id = await projectId("customer.harbor", HARBOR);
  const pm = await as("project_manager");
  taskTitle = `E2E ${RUN}: review homepage hero copy`;
  await pm.goto(`${BASE}/staff/projects/${id}?tab=plan`);
  await pm.fill("#f-title", taskTitle);
  await pm.selectOption("#f-milestone_id", { label: "Design" });
  const devId = await pm.locator("#f-assignee_id option", { hasText: /developer/i }).first().getAttribute("value");
  await pm.selectOption("#f-assignee_id", devId);
  await pm.fill("#f-estimate_minutes", "60");
  await nav(pm, btn(pm, "Add task"));
  assert.match(await text(pm), new RegExp(`${esc(taskTitle)}[\\s\\S]*Developer`, "i"), await alerts(pm));
  const d = await as("developer");
  await d.goto(`${BASE}/staff/tasks?assignee=me`);
  assert.match(await text(d), re(taskTitle), "task in the developer's queue");
  assertClean();
});

journey(11, ["PORTAL-003", "PM-004"], "developer completes the task and updates the Design milestone; the customer sees the progress (then restored)", { needs: [10] }, async () => {
  const id = await projectId("customer.harbor", HARBOR);
  const d = await as("developer");
  await d.goto(`${BASE}/staff/tasks?assignee=me`);
  await nav(d, d.getByRole("link", { name: taskTitle }));
  const taskUrl = d.url();
  await d.selectOption("#f-status", "done");
  await nav(d, btn(d, "Update status"));
  assert.match(await text(d), /Done/i);

  const ms = 'form:has(select[aria-label="Status for Design"])';
  await d.goto(`${BASE}/staff/projects/${id}?tab=plan`);
  const original: string = await d.locator(`${ms} select`).inputValue();
  const next = original === "in_progress" ? "done" : "in_progress";
  await d.locator(`${ms} select`).selectOption(next);
  await nav(d, d.locator(ms).getByRole("button", { name: "Save" }));
  assert.equal(await d.locator(`${ms} select`).inputValue(), next, await alerts(d));
  const c = await as("customer.harbor");
  await c.goto(`${BASE}/portal/projects/${id}`);
  assert.match(await text(c), new RegExp(`Design\\s+${next === "done" ? "Done" : "In progress"}`, "i"), "customer sees the milestone update");

  // Restore the sample project: milestone back, E2E task removed by the PM.
  await d.goto(`${BASE}/staff/projects/${id}?tab=plan`);
  await d.locator(`${ms} select`).selectOption(original);
  await nav(d, d.locator(ms).getByRole("button", { name: "Save" }));
  assert.equal(await d.locator(`${ms} select`).inputValue(), original);
  const pm = await as("project_manager");
  await pm.goto(taskUrl);
  await nav(pm, btn(pm, "Delete task"));
  await pm.goto(`${BASE}/staff/projects/${id}?tab=plan`);
  assert.doesNotMatch(await text(pm), re(taskTitle), "E2E task removed");
  assertClean();
});

// ───────────── 12–15. Notifications, design review, revisions ─────────────

/** PM asks the customer for an approval. A request of the same kind left open by an interrupted run is first
 * resolved by the customer (rejected with a note), so re-runs never depend on earlier state. */
async function requestApproval(customer: string, id: string, kindValue: string, kindLabel: string, note: string) {
  const pm = await as("project_manager");
  const send = async () => {
    await pm.goto(`${BASE}/staff/projects/${id}?tab=approvals`);
    const f = 'form[action$="/request-approval"]';
    await pm.locator(`${f} select[name=kind]`).selectOption(kindValue);
    await pm.locator(`${f} textarea[name=note]`).fill(note);
    await nav(pm, pm.locator(f).getByRole("button", { name: "Send request" }));
    return alerts(pm);
  };
  let res = await send();
  if (/already an open request/i.test(res)) {
    await decide(customer, id, kindLabel, "Reject", `E2E ${RUN}: closing a request left open by an interrupted earlier run.`);
    res = await send();
  }
  assert.doesNotMatch(res, /error|cannot|already/i, res);
}
async function decide(customer: string, id: string, kindLabel: string, decision: "Approve" | "Reject", notes: string) {
  const c = await as(customer);
  await c.goto(`${BASE}/portal/projects/${id}/approvals`);
  const section = c.locator("section", { has: c.locator("h2", { hasText: new RegExp(`^${esc(kindLabel)}$`) }) }).first();
  await section.locator("textarea[name=notes]").fill(notes);
  await nav(c, section.getByRole("button", { name: decision }));
  return alerts(c);
}

journey(12, ["PORTAL-005"], "customer receives a notification (portal and email outbox) when the PM requests a design review", {}, async () => {
  const id = await projectId("customer.harbor", HARBOR);
  const note = `E2E ${RUN}: please review the homepage design concept.`;
  await requestApproval("customer.harbor", id, "design", "Design approval", note);
  const c = await as("customer.harbor");
  await c.goto(BASE + "/portal");
  const dash = await text(c);
  // The unread notification's line is the PM's note, or (FD-14 review deadlines, #111) the response deadline; the note
  // itself still reaches the customer by email (checked below by this run's id) and on the approvals page (journey 13).
  assert.match(dash, new RegExp(`New\\s+(?:${esc(note)}|Please respond by [^\\n]+We never treat silence as approval)`), "unread portal notification");
  assert.match(dash, /Design approval awaiting your decision/, "required action on the dashboard");
  const mail = await outbox(account("customer.harbor").email, "approval_request", RUN);
  assert.match(mail, /Design approval/);
  assert.match(mail, /\/portal\/projects\/prj_\w+\/approvals/, "email links to the approvals page");
  assertClean();
});

journey(13, ["PORTAL-007"], "customer reviews the design and requests changes; the decision reaches the PM", { needs: [12] }, async () => {
  const id = await projectId("customer.harbor", HARBOR);
  const c = await as("customer.harbor");
  await c.goto(BASE + "/portal");
  await nav(c, c.getByRole("link", { name: /Design approval awaiting your decision/ }).first());
  assert.match(await text(c), re(`E2E ${RUN}: please review the homepage design concept.`));
  const notes = `E2E ${RUN}: warmer hero photo and a larger booking button, please.`;
  const res = await decide("customer.harbor", id, "Design approval", "Reject", notes);
  assert.match(res, /Design approval rejected/i);
  assert.match(await text(c), new RegExp(`Design approval\\s+Rejected[^\\n]*\\n?[^\\n]*${esc(notes)}`, "i"));
  const pm = await as("project_manager");
  await pm.goto(`${BASE}/staff/projects/${id}?tab=approvals`);
  assert.match(await text(pm), re(notes), "PM sees the customer's decision");
  assertClean();
});

const kpi = async (page: Page, label: string) => Number(new RegExp(`${esc(label)}\\s+(\\d+)`, "i").exec(await text(page, ".kpis"))?.[1]);

journey(14, ["PORTAL-006"], "customer submits a revision request (included round, or change order once the allowance is used)", {}, async () => {
  const id = await projectId("customer.harbor", HARBOR);
  const c = await as("customer.harbor");
  const page = `${BASE}/portal/projects/${id}/revisions`;
  await c.goto(page);
  const allowance = await kpi(c, "Included rounds"), usedBefore = await kpi(c, "Used");
  assert.ok(allowance >= 1 && usedBefore >= 0, "allowance shown");
  const submit = async () => {
    await c.goto(page);
    await c.fill("#f-request", `E2E ${RUN}: warmer hero photo, larger booking button on mobile.`);
    // PR #105 renamed the button ("Submit request"; once the allowance is used, "Submit request (changes need a
    // change-order quote)") and added a change/problem choice whose default, "change", is what this journey submits.
    // The old labels made deploy #121 time out here waiting for a navigation that never started.
    await nav(c, btn(c, /^Submit request( \(changes need a change-order quote\))?$/i));
    return alerts(c);
  };
  let res = await submit();
  if (/waiting for a change-order proposal/i.test(res)) {
    await settleBillable(id); // left by an interrupted earlier run
    res = await submit();
  }
  if (usedBefore < allowance) {
    assert.match(res, new RegExp(`Revision round ${usedBefore + 1} submitted`, "i"), res);
    revision = { mode: "included", allowance, usedBefore };
  } else {
    // Allowance used (earlier runs consumed the sample's rounds): the request is recorded as billable and needs a
    // change order. Settle it at no charge so the sample project has no pending request or unpaid invoice.
    assert.match(await text(c), /Awaiting change-order quote/i, res);
    revision = { mode: "billable", allowance, usedBefore };
    await settleBillable(id);
  }
  assertClean();
});
/** PM proposes a no-charge change order for the pending billable revision; the customer approves it. */
async function settleBillable(id: string) {
  const pm = await as("project_manager");
  await pm.goto(`${BASE}/staff/projects/${id}?tab=revisions`);
  const co = pm.locator('form[action$="/change-orders"]:has(input[name=revision_id])').first();
  if (await co.locator("textarea[name=scope]").count()) await co.locator("textarea[name=scope]").fill(`E2E ${RUN}: no-charge change order for a staging journey revision request.`);
  await co.locator("input[name=price]").fill("0");
  await nav(pm, co.getByRole("button", { name: "Propose change order" }));
  const c = await as("customer.harbor");
  await c.goto(`${BASE}/portal/projects/${id}/revisions`);
  await nav(c, btn(c, "Approve change order"));
  assert.match(await alerts(c), /Change order approved/i);
}

journey(15, ["PM-002"], "revision allowance counter updates for the customer and the PM", { needs: [14] }, async () => {
  const id = await projectId("customer.harbor", HARBOR);
  const c = await as("customer.harbor");
  await c.goto(`${BASE}/portal/projects/${id}/revisions`);
  const r = revision!;
  const used = await kpi(c, "Used"), remaining = await kpi(c, "Remaining");
  if (r.mode === "included") {
    assert.equal(used, r.usedBefore + 1, "used rounds +1");
    assert.equal(remaining, r.allowance - r.usedBefore - 1, "remaining rounds −1");
  } else {
    assert.equal(used, r.allowance);
    assert.equal(remaining, 0);
    assert.match(await text(c), /Further changes need a change order/i);
  }
  assert.match(await text(c), re(`E2E ${RUN}: warmer hero photo`), "round listed");
  const pm = await as("project_manager");
  await pm.goto(`${BASE}/staff/projects/${id}?tab=revisions`);
  assert.equal(await kpi(pm, "Included used"), used, "PM sees the same count");
  assertClean();
});

// ───────────── 16–19. Final approval (sample), payments and deployment (this run's project), QA (sample) ─────────────

journey(16, ["PORTAL-007"], "customer approves the final work (final launch approval, sample Ridgeline project)", {}, async () => {
  const id = await projectId("customer.ridgeline", RIDGELINE);
  await requestApproval("customer.ridgeline", id, "customer_launch", "Final launch approval", `E2E ${RUN}: please confirm the final website is approved for launch.`);
  const res = await decide("customer.ridgeline", id, "Final launch approval", "Approve", `E2E ${RUN}: approved (staging journey test).`);
  assert.match(res, /Final launch approval approved/i);
  const pm = await as("project_manager");
  await pm.goto(`${BASE}/staff/projects/${id}?tab=approvals`);
  assert.match(await text(pm, ".card--gold"), /5\. Customer approval \(final launch approval\)\s+Pass/);
  assertClean();
});

// Journeys 17 and 19 used to be blocked with NO_STRIPE, which became untrue once staging got a Stripe test key: journeys 5, 6
// and 24 pay through Stripe test-mode Checkout on staging. The reasons below are the real ones.
/** PM moves this run's project to the next status with the overview's "Move to …" button. */
async function moveTo(id: string, statusLabel: string) {
  const pm = await as("project_manager");
  await pm.goto(`${BASE}/staff/projects/${id}`);
  await nav(pm, btn(pm, `Move to ${statusLabel}`));
  assert.match(await alerts(pm), new RegExp(`Project moved to ${esc(statusLabel)}`, "i"), await alerts(pm));
}
/** PM issues a milestone invoice; the customer is emailed, opens it, pays in Stripe test-mode Checkout, and the signed
 *  webhook marks it Paid. Returns the invoice URL. */
async function issueAndPay(id: string, buttonLabel: string): Promise<string> {
  const pm = await as("project_manager");
  await pm.goto(`${BASE}/staff/projects/${id}?tab=approvals`);
  await nav(pm, btn(pm, buttonLabel));
  assert.match(await alerts(pm), /Milestone invoice issued/i, await alerts(pm));
  const invUrl = linkIn(await outbox(contact.email, "invoice"), "/portal/billing/invoices/");
  const c = people.newCustomer.page;
  await c.goto(invUrl);
  await nav(c, btn(c, /^Pay \$[\d,.]+ securely$/));
  await payOnStripeCheckout(c);
  const end = Date.now() + 120_000;
  for (;;) {
    await c.goto(invUrl);
    const status = ((await c.locator("main .badge").first().innerText().catch(() => "")) as string).trim();
    if (/^Paid$/i.test(status)) break;
    if (Date.now() > end) assert.fail(`the signed Stripe webhook did not mark ${buttonLabel} paid within 120s (status "${status}")`);
    await c.waitForTimeout(5_000);
  }
  return invUrl;
}
const gate = async () => { const pm = await as("project_manager"); return text(pm, ".card--gold"); };

journey(17, ["PAY-006"], "required payments are verified before release (this run's project: every milestone paid in Stripe test mode)", { needs: [8] }, async () => {
  const id = await runProject();
  // Scope → design: a new scope version, approved by the customer.
  const pm = await as("project_manager");
  await pm.goto(`${BASE}/staff/projects/${id}`);
  await pm.locator('form[action$="/scope"] textarea[name=scope]').fill(`E2E ${RUN}: online ordering for three cafés, loyalty accounts, admin portal; 3 revision rounds.`);
  await nav(pm, btn(pm, "Save new version"));
  assert.match(await alerts(pm), /Scope version \d+ saved/i, await alerts(pm));
  await requestApproval("newCustomer", id, "scope", "Scope approval", `E2E ${RUN}: please approve the project scope.`);
  assert.match(await decide("newCustomer", id, "Scope approval", "Approve", `E2E ${RUN}: scope approved.`), /Scope approval approved/i);
  await moveTo(id, "Design");
  // Design approved → the 25% design invoice, paid through Stripe test mode.
  await requestApproval("newCustomer", id, "design", "Design approval", `E2E ${RUN}: please approve the design.`);
  assert.match(await decide("newCustomer", id, "Design approval", "Approve", `E2E ${RUN}: design approved.`), /Design approval approved/i);
  await issueAndPay(id, "Issue 25% design invoice");
  await moveTo(id, "Customer review");
  // Final launch approval → the 25% pre-launch invoice. While it is unpaid the release gate refuses.
  await requestApproval("newCustomer", id, "customer_launch", "Final launch approval", `E2E ${RUN}: please confirm the website is approved for launch.`);
  assert.match(await decide("newCustomer", id, "Final launch approval", "Approve", `E2E ${RUN}: approved for launch.`), /Final launch approval approved/i);
  await pm.goto(`${BASE}/staff/projects/${id}?tab=approvals`);
  await nav(pm, btn(pm, "Issue 25% pre-launch invoice"));
  assert.match(await alerts(pm), /Milestone invoice issued/i);
  assert.match(await gate(), /6\. Required payment verification\s+Missing\s+Unpaid: prelaunch_25/, "an unpaid required invoice blocks release");
  assert.equal(await pm.locator('form[action$="/deployments"]').count(), 0, "no deployment form while a payment is outstanding");
  const invUrl = linkIn(await outbox(contact.email, "invoice"), "/portal/billing/invoices/");
  const c = people.newCustomer.page;
  await c.goto(invUrl);
  await nav(c, btn(c, /^Pay \$[\d,.]+ securely$/));
  await payOnStripeCheckout(c);
  await until(c, invUrl, /\bPaid\b/, "the signed Stripe webhook marking the pre-launch invoice paid");
  // Verified only from Stripe-confirmed payment records: the gate's payment check now passes.
  await pm.goto(`${BASE}/staff/projects/${id}?tab=approvals`);
  assert.match(await gate(), /6\. Required payment verification\s+Pass/, "all required invoices paid");
  await c.goto(`${BASE}/portal/billing`);
  assert.equal(await c.locator('main a[href^="/portal/billing/receipts/"]').filter({ hasText: /^Receipt$/ }).count(), 3, "one receipt per milestone: deposit, design, pre-launch");
  assertClean();
});

journey(18, ["PM-006"], "internal QA certifies the project; deployment authorization stays refused until every check passes", {}, async () => {
  const id = await projectId("customer.ridgeline", RIDGELINE);
  const pm = await as("project_manager");
  await pm.goto(`${BASE}/staff/projects/${id}?tab=approvals`);
  const rec = 'form[action$="/approvals"]';
  for (const kind of ["engineering_complete", "internal_qa", "security_accessibility"]) {
    await pm.locator(`${rec} select[name=kind]`).selectOption(kind);
    await pm.locator(`${rec} select[name=decision]`).selectOption("approved");
    await pm.locator(`${rec} textarea[name=notes]`).fill(`E2E ${RUN}: ${kind} checked (staging journey test).`);
    await nav(pm, pm.locator(rec).getByRole("button", { name: "Record" }));
    assert.match(await alerts(pm), /Approval recorded/i);
  }
  const panel = await text(pm, ".card--gold");
  for (const n of [1, 2, 3]) assert.match(panel, new RegExp(`${n}\\. [^\\n]+\\s+Pass`), `check ${n} passes`);
  assert.match(panel, /Blocked: \d+ check\(s\) outstanding/, "the sample project is not releasable");
  await pm.locator(`${rec} select[name=kind]`).selectOption("deployment_authorized");
  await nav(pm, pm.locator(rec).getByRole("button", { name: "Record" }));
  assert.match(await text(pm, ".alert--error"), /Deployment cannot be authorized until every other check passes/);
  assert.equal(await pm.locator('form[action$="/deployments"]').count(), 0, "no deployment form while blocked");
  assertClean();
});

journey(19, ["PM-007"], "authorized deployment occurs (this run's project, after every release check)", { needs: [17] }, async () => {
  const id = await runProject();
  await moveTo(id, "Final approval");
  const pm = await as("project_manager");
  await pm.goto(`${BASE}/staff/projects/${id}?tab=approvals`);
  const rec = 'form[action$="/approvals"]';
  for (const kind of ["engineering_complete", "internal_qa", "security_accessibility", "deployment_authorized"]) {
    await pm.locator(`${rec} select[name=kind]`).selectOption(kind);
    await pm.locator(`${rec} select[name=decision]`).selectOption("approved");
    await pm.locator(`${rec} textarea[name=notes]`).fill(`E2E ${RUN}: ${kind} checked (staging journey test).`);
    await nav(pm, pm.locator(rec).getByRole("button", { name: "Record" }));
    assert.match(await alerts(pm), /Approval recorded/i, await alerts(pm));
  }
  const panel = await gate();
  for (const n of [1, 2, 3, 4, 5, 6, 7]) assert.match(panel, new RegExp(`${n}\\. [^\\n]+\\s+Pass`), `check ${n} passes`);
  // A deployment record for this run's project (a placeholder URL on a reserved domain; no real site is published).
  const live = `https://${RUN}.staging-journeys.example/`;
  await pm.fill('form[action$="/deployments"] input[name=url]', live);
  await nav(pm, btn(pm, "Record deployment"));
  assert.match(await alerts(pm), /Deployment recorded/i, await alerts(pm));
  assert.match(await text(pm), re(live), "deployment listed for the PM");
  const c = people.newCustomer.page;
  await c.goto(`${BASE}/portal/projects/${id}`);
  const page = await text(c);
  assert.match(page, /Deployment/i, "the customer sees the project in deployment");
  assertClean();
});

// ───────────── 20. Handoff ─────────────

journey(20, ["PORTAL-010"], "PM publishes the handoff (sample Ridgeline project) and the customer receives it", {}, async () => {
  const id = await projectId("customer.ridgeline", RIDGELINE);
  const pm = await as("project_manager");
  await pm.goto(`${BASE}/staff/projects/${id}?tab=handoff`);
  await pm.fill("#f-website_url", "https://ridgeline-sample.example");
  await pm.fill("#f-documentation", `Sample editing guide for services and gallery pages (E2E ${RUN}).`);
  await pm.fill("#f-access_instructions", "Admin invitations are sent to your email; set your own password.");
  await pm.fill("#f-ownership_notes", "Domain registered in the customer's name (sample).");
  await pm.fill("#f-training_notes", "30-minute recorded walkthrough (sample).");
  await nav(pm, btn(pm, /^(Publish to customer|Update published handoff)$/i));
  assert.match(await text(pm), /Published/i, await alerts(pm));
  const c = await as("customer.ridgeline");
  await c.goto(BASE + "/portal");
  await nav(c, c.getByRole("link", { name: /Review your handoff and record final acceptance/ }).first());
  const h = await text(c);
  assert.match(h, re(`(E2E ${RUN})`), "customer sees the current handoff");
  assert.match(h, /ridgeline-sample\.example/);
  assert.match(h, /30-minute recorded walkthrough/);
  assertClean();
});

// ───────────── 21–23. Support ─────────────

const ticketSubject = `E2E ${RUN}: contact form emails not arriving`;
journey(21, ["SUP-001", "PORTAL-009"], "customer submits a support ticket from the portal", {}, async () => {
  const id = await projectId("customer.harbor", HARBOR);
  const c = await as("customer.harbor");
  await c.goto(BASE + "/portal/support");
  await nav(c, c.getByRole("link", { name: "New ticket" }).first());
  await c.fill("#f-subject", ticketSubject);
  await c.selectOption("#f-category", "technical");
  await c.selectOption("#f-project_id", id);
  await c.fill("#f-description", "Visitors say the contact form confirmation never arrives (staging journey test).");
  const canAttach = (await c.locator("#f-attachments").count()) > 0; // absent when file storage is not configured
  if (canAttach) await c.setInputFiles("#f-attachments", { name: `screenshot-${RUN}.png`, mimeType: "image/png", buffer: PNG });
  await nav(c, btn(c, "Submit ticket"));
  ticketUrl = c.url();
  assert.match(new URL(ticketUrl).pathname, /^\/portal\/support\/tkt_/, await alerts(c));
  const t = await text(c);
  assert.match(t, re(ticketSubject));
  if (canAttach) assert.match(t, re(`screenshot-${RUN}.png`));
  assertClean();
});

journey(22, ["SUP-002"], "staff responds (internal note hidden from the customer, reply visible)", { needs: [21] }, async () => {
  const s = await as("support");
  await s.goto(`${BASE}/staff/support?q=${encodeURIComponent(RUN)}`);
  await nav(s, s.getByRole("link", { name: ticketSubject }));
  await s.fill('form[action$="/note"] textarea[name=body]', `INTERNAL ${RUN}: check the routing address in business settings.`);
  await nav(s, btn(s, "Add internal note"));
  await s.fill('form[action$="/reply"] textarea[name=body]', `Thanks — we fixed the sender settings (${RUN}). Please try the form again.`);
  await nav(s, btn(s, "Send reply"));
  const c = await as("customer.harbor");
  await c.goto(ticketUrl);
  const t = await text(c);
  assert.match(t, re(`we fixed the sender settings (${RUN})`));
  assert.doesNotMatch(t, re(`INTERNAL ${RUN}`), "internal note never shown to the customer");
  assertClean();
});

journey(23, ["SUP-002"], "ticket is resolved and the customer sees it resolved", { needs: [22] }, async () => {
  const s = await as("support");
  await s.goto(`${BASE}/staff/support?q=${encodeURIComponent(RUN)}`);
  await nav(s, s.getByRole("link", { name: ticketSubject }));
  await s.selectOption('form[action$="/status"] select[name=status]', "resolved");
  await nav(s, btn(s, "Update status"));
  assert.match(await text(s, "main aside"), /Status\s+Resolved/i);
  const c = await as("customer.harbor");
  await c.goto(ticketUrl);
  assert.match(await text(c), /Status\s+Resolved/i);
  assertClean();
});

// ───────────── 24–26. Subscriptions, failed payments, refunds ─────────────

journey(24, ["PAY-004"], "customer opens the Stripe billing portal to manage payment methods and subscriptions", { needs: [6] }, async () => {
  // Maintenance plans stay closed until their entitlements are approved (BLK-010), so the journey verifies the
  // billing portal the paying customer would use to manage a subscription: test-mode portal, created by checkout.
  const p = people.newCustomer.page;
  await p.goto(`${BASE}/portal/billing`);
  // Wait for the redirect to Stripe to COMMIT, not for the portal page's load event (deploy 41187430075 timed out
  // waiting for "load" after the click). An error from our side stays on BASE and is reported with its alerts.
  await btn(p, "Manage payment methods").click();
  await p.waitForURL(/^https:\/\/billing\.stripe\.com\//, { timeout: 60_000, waitUntil: "commit" }).catch(async (e: Error) => {
    throw new Error(`no redirect to the Stripe billing portal (${e.message.split("\n")[0]}); page ${p.url()}: ${await alerts(p)} ${(await text(p).catch(() => "")).slice(0, 200)}`);
  });
  // Test mode is enforced server-side: the adapter refuses a portal session whose livemode differs from staging's test
  // mode (assertObjectMode), so reaching billing.stripe.com from staging means a test-mode session. The URL format is
  // Stripe's own (deploy 41258366594 did not match the older /p/session/test_ pattern); the shape is reported with
  // session tokens redacted, never the token itself.
  const shape = (u: string) => { const x = new URL(u); return `${x.host}${x.pathname.split("/").map((seg) => (seg.length > 12 ? "<token>" : seg)).join("/")}`; };
  assert.match(new URL(p.url()).host, /^billing\.stripe\.com$/, `the Stripe billing portal (got ${shape(p.url())})`);
  await p.goto(`${BASE}/portal/billing`);
  assertClean();
});
journey(25, ["PAY-004"], "failed payment triggers recovery", { needs: [4] }, async (t) => {
  // A renewal can only fail for a customer who has a maintenance subscription. Read from staging itself whether one can
  // be bought yet, so the reported blocker is always the current one (never a stale message).
  const c = people.newCustomer.page;
  const r = await c.goto(`${BASE}/checkout/maintenance/essential`);
  const page = await text(c);
  if (r?.status() === 409 && /awaiting Founder approval/i.test(page)) {
    t.skip("BLK-010 (Founder decision): maintenance plans cannot be purchased until the Founder approves their entitlements (staging answers: 'Maintenance plans are not available for purchase yet'), so no subscription exists whose renewal could fail. invoice.payment_failed handling is covered by signed-fixture tests (tests/commerce-closeout.test.ts)");
    return;
  }
  // Plans are purchasable: making a renewal fail on demand still needs a Stripe test clock attached to the customer,
  // which a browser cannot create. That staging-only driver does not exist yet, so this stays an honest skip.
  t.skip("maintenance plans are purchasable, but no staging Stripe test-clock driver exists yet to make a renewal fail on demand; build it before this journey can run");
});

journey(26, ["PAY-007"], "refund request enters the approval workflow: support review → recommendation → Founder decision (denied, so the sample payment stays clean)", {}, async () => {
  const c = await as("customer.harbor");
  const s = await as("support");
  const o = await as("owner");
  // A request left open by an interrupted earlier run blocks a new one for the same payment: close it first.
  await s.goto(`${BASE}/staff/refunds`);
  for (const href of await s.locator("main table tr", { hasText: /E2E e2e-/ }).filter({ hasText: /Requested|Under review|Recommended/i }).locator("a").evaluateAll((as: HTMLAnchorElement[]) => as.map((a) => a.getAttribute("href")!))) {
    await s.goto(BASE + href);
    if (await btn(s, "Start review").count()) { await s.fill("#f-notes", `E2E ${RUN}: closing a stale test request.`); await nav(s, btn(s, "Start review")); }
    if (await btn(s, "Deny").count()) { await s.fill("#f-notes", `E2E ${RUN}: closing a stale test request.`); await nav(s, btn(s, "Deny")); continue; }
    await o.goto(BASE + href);
    await freshMfa(o, account("owner"));
    await o.fill("#f-notes", `E2E ${RUN}: closing a stale test request.`);
    await nav(o, btn(o, "Deny refund"));
  }

  await c.goto(BASE + "/portal/billing");
  await c.locator("summary", { hasText: "Request a refund" }).click();
  await c.fill("#f-amount", "1");
  await c.fill("#f-reason", `E2E ${RUN}: staging journey test of the refund approval workflow (no real refund).`);
  await nav(c, btn(c, "Submit request"));
  assert.match(await text(c), /Refund requests[\s\S]*\$1(\.00)?[\s\S]*Requested/i, await alerts(c));

  await s.goto(`${BASE}/staff/refunds`);
  await nav(s, s.locator("main table tr", { hasText: RUN }).locator("a").first());
  const refundUrl = s.url();
  assert.match(await text(s), re(RUN));
  await s.fill("#f-notes", "Checked the payment and the request.");
  await nav(s, btn(s, "Start review"));
  await s.fill("#f-notes", "Test request; recommending so the Founder decision step is exercised.");
  await nav(s, btn(s, "Recommend refund"));
  assert.match(await text(s), /Awaiting the Founder's decision\./);

  await o.goto(refundUrl);
  await freshMfa(o, account("owner"));
  assert.match(await text(o, ".page-head, main"), /Recommended/i);
  await o.fill("#f-notes", `E2E ${RUN}: denied — staging journey test, no refund owed.`);
  await nav(o, btn(o, "Deny refund"));
  assert.match(await text(o, ".page-head, main"), /Denied/i, await alerts(o));
  await c.goto(BASE + "/portal/billing");
  assert.match(await text(c), /Refund requests[\s\S]*\$1(\.00)?[\s\S]*Denied/i, "customer sees the decision");
  assertClean();
});

// Not one of the 33 numbered journeys (certification is unchanged): a REAL Stripe test-mode refund of the deposit that
// journeys 5–6 paid, issued by the Founder, then the signed charge.refunded webhook. Checks the refund confirmation is
// emailed exactly once (the issue step and the webhook share one idempotency key; PR #71) and that the webhook matched
// the platform's request via the pinned-version refund lookup. $1 of a journey-created fictional customer's TEST deposit.
test("[PAY-007] [PAY-003] Stripe test mode: the Founder issues a refund; the signed charge.refunded webhook is matched and the customer is notified once", { skip: unset || false }, async (t) => {
  if (outcome.get(6) !== "passed") { t.skip(`needs journey 6 (${outcome.get(6) ?? "not run"})`); return; }
  const c = people.newCustomer.page;
  const s = await as("support");
  const o = await as("owner");
  await c.goto(BASE + "/portal/billing");
  await c.locator("summary", { hasText: "Request a refund" }).click();
  await c.fill("#f-amount", "1");
  await c.fill("#f-reason", `E2E ${RUN}: staging Stripe test-mode refund of the journey deposit.`);
  await nav(c, btn(c, "Submit request"));
  assert.match(await text(c), /Refund requests[\s\S]*\$1(\.00)?[\s\S]*Requested/i, await alerts(c));

  await s.goto(`${BASE}/staff/refunds`);
  await nav(s, s.locator("main table tr", { hasText: RUN }).locator("a").first());
  const refundUrl = s.url();
  await s.fill("#f-notes", "Checked the journey payment and the request.");
  await nav(s, btn(s, "Start review"));
  await s.fill("#f-notes", "Journey test: recommending a $1 Stripe test-mode refund.");
  await nav(s, btn(s, "Recommend refund"));

  await o.goto(refundUrl);
  await freshMfa(o, account("owner"));
  await o.fill("#f-notes", `E2E ${RUN}: approved — Stripe test-mode refund check.`);
  await nav(o, btn(o, "Approve refund"));
  assert.match(await text(o, ".page-head, main"), /Approved/i, await alerts(o));
  // Poll the request's own page for the outcome rather than relying on one navigation event (deploy 41258366594 timed out
  // waiting for "load" after this click, and the request stayed Approved). The failure message carries what the page says.
  // formatCents shows whole dollars without cents ("$1"); deploy 41265983047 looked for "$1.00" and never found the button.
  await btn(o, /^Issue \$1(\.00)? refund via Stripe$/).click();
  let detail = "";
  for (const end = Date.now() + 60_000; ; await o.waitForTimeout(3_000)) {
    if (new URL(o.url()).pathname !== new URL(refundUrl).pathname) await o.goto(refundUrl).catch(() => undefined);
    detail = await text(o).catch(() => "");
    const status = ((await o.locator(".page-head .badge, main .badge").first().innerText().catch(() => "")) as string).trim();
    if (/^(Issued|Failed)$/i.test(status)) break;
    if (Date.now() > end) assert.fail(`the Founder's Stripe refund was not issued within 60s: status "${status}", page ${o.url()}, alerts: ${await alerts(o)} | ${detail.replace(/\s+/g, " ").slice(0, 300)}`);
    if (/^Approved$/i.test(status) && Date.now() > end - 45_000) await o.reload().catch(() => undefined);
  }
  assert.match(detail, /Issued/i, `the refund was refused by Stripe: ${await alerts(o)} | ${detail.replace(/\s+/g, " ").slice(0, 300)}`);
  const stripeRefund = /\b(re_[A-Za-z0-9]+)\b/.exec(detail)?.[1];
  assert.ok(stripeRefund, `a Stripe refund id on the request (${await alerts(o)})`);
  const pi = /\b(pi_[A-Za-z0-9]+)\b/.exec(detail)?.[1];
  assert.ok(pi, "the refunded payment's PaymentIntent");

  // The signed charge.refunded webhook arrives asynchronously; it is audited with the refund it resolved.
  await until(o, `${BASE}/staff/audit?action=payment.refunded&subject=${pi}`, new RegExp(esc(stripeRefund!)), "the signed charge.refunded webhook for the refund");

  // Exactly one "refund issued" confirmation for this refund (no second one from the webhook).
  await o.goto(`${BASE}/staff/email?to=${encodeURIComponent(contact.email)}&template=refund_decision`);
  const rows: string[] = await o.locator("main table tbody tr").allInnerTexts();
  assert.equal(rows.filter((r) => /issued/i.test(r)).length, 1, `one refund-issued email, got:\n${rows.join("\n")}`);
  assert.match(await outbox(contact.email, "refund_decision", stripeRefund), /\$1(\.00)?\b/);
  await c.goto(BASE + "/portal/billing");
  assert.match(await text(c), /Refund requests[\s\S]*\$1(\.00)?[\s\S]*Issued/i, "customer sees the refund issued");
  assertClean();
});

// Not one of the 33 numbered journeys: a Stripe TEST-mode dispute. The journey customer buys a Starter package and pays with
// Stripe's published dispute test card, which succeeds and then opens a fraudulent-reason dispute. The signed
// charge.dispute.created webhook must record it for staff and email the Owner once. Test mode only.
const STRIPE_DISPUTE_CARD = { number: "4000 0000 0000 0259", expiry: "12 / 34", cvc: "123" };
test("[PAY-008] [PAY-003] Stripe test mode: a disputed payment reaches staff Disputes and the Owner is emailed once", { skip: unset || false }, async (t) => {
  if (outcome.get(6) !== "passed") { t.skip(`needs journey 6 (${outcome.get(6) ?? "not run"})`); return; }
  const o = await as("owner");
  const ownerMail = `${BASE}/staff/email?to=${encodeURIComponent(account("owner").email)}&template=dispute_opened`;
  const disputeMails = async () => { await o.goto(ownerMail); return (await o.locator("main table tbody tr", { hasText: /Payment dispute opened/i }).count()) as number; };
  const before = await disputeMails();
  const c = people.newCustomer.page;
  await c.goto(`${BASE}/checkout/starter`);
  await c.locator("input[name=terms]").check();
  await nav(c, c.getByRole("button", { name: /^Pay \$[\d,.]+/ }).first());
  await payOnStripeCheckout(c, STRIPE_DISPUTE_CARD);
  const disputes = await until(o, `${BASE}/staff/disputes?q=${encodeURIComponent(contact.company)}`, /\b(dp|du)_[A-Za-z0-9]+/, "the signed charge.dispute.created webhook recording the dispute");
  assert.match(disputes, re(contact.company), "the dispute is matched to the journey customer's payment");
  const end = Date.now() + 120_000;
  let after = await disputeMails();
  while (after === before && Date.now() < end) { await o.waitForTimeout(5_000); after = await disputeMails(); }
  assert.equal(after, before + 1, "exactly one new dispute email to the Owner");
  assertClean();
});

// ───────────── 27–28. AI receptionist ─────────────

// 27–28 verify a REAL call: a person rings the staging receptionist number (…2055), the live Retell agent answers and the
// platform records the call and the lead through the authenticated (signed) Retell webhooks. A browser cannot place a
// phone call, so the journeys look for such a call made recently and verify what it produced, end to end, through the
// Owner's pages. Synthetic or signed-fixture calls are flagged as test calls and never count.
const REAL_CALL_DAYS = 7;
let receptionistCall: { url: string; leadId: string; started: string; followUp: boolean } | null = null;
const parseShown = (s: string) => new Date(s.replace(/,(?=\s\d{1,2}:)/, "")).getTime(); // "Nov 1, 2026, 5:39 PM EST"

journey(27, ["VOICE-003"], "AI receptionist captures a lead from a real test call (live Retell agent, signed webhooks)", {}, async (t) => {
  const o = await as("owner");
  await o.goto(`${BASE}/staff/voice`);
  const rows = o.locator("main table tbody tr", { has: o.locator('a[href^="/staff/voice/calls/"]') });
  const since = Date.now() - REAL_CALL_DAYS * 86_400_000;
  for (let i = 0; i < Math.min(await rows.count(), 20); i++) {
    const row = rows.nth(i);
    const link = row.locator('a[href^="/staff/voice/calls/"]').first();
    const started = ((await link.innerText()) as string).trim();
    if (parseShown(started) < since) break; // newest first
    if (/^\s*—\s*$/.test(((await row.locator("td").nth(3).innerText()) as string))) continue; // no lead on this call
    const url = BASE + (await link.getAttribute("href"));
    await o.goto(url);
    const detail = await text(o);
    if (!/Provider\s+retell/i.test(detail)) { await o.goto(`${BASE}/staff/voice`); continue; }
    const lead = /Lead\s+(ld_[A-Za-z0-9]+)/.exec(detail);
    assert.ok(lead, `the call links its lead: ${detail.slice(0, 300)}`);
    assert.doesNotMatch(detail, /Test call/, "a real call, not a test fixture");
    assert.doesNotMatch(detail, /Outcome\s+Error/i, "the call did not end in an error");
    receptionistCall = { url, leadId: lead![1], started, followUp: /fn:(request_callback|schedule_consultation|escalate)\b/.test(detail) };
    break;
  }
  if (!receptionistCall) {
    t.skip(`needs a real test call (Founder action): no real Retell receptionist call with a captured lead in the last ${REAL_CALL_DAYS} days on staging. Call the staging receptionist number (…2055), give a name and what you need and ask for a callback, then re-run`);
    return;
  }
  console.log(`journey 27: real receptionist call ${receptionistCall.url} started ${receptionistCall.started} → lead ${receptionistCall.leadId}`);
  assertClean();
});

journey(28, ["CRM-007"], "the real call's lead appears in the CRM with its source and call activity", { needs: [27] }, async () => {
  const o = await as("owner");
  await o.goto(`${BASE}/staff/crm/leads/${receptionistCall!.leadId}`);
  const lead = await text(o);
  assert.match(lead, /Source\s+Ai receptionist/i, "lead source is the AI receptionist");
  assert.match(lead, /Lead captured by AI receptionist/i, "call activity on the lead");
  // Dual calendars: a callback, booking or escalation the caller asked for is routed to exactly one internal calendar,
  // AI Follow-Up unless the caller explicitly asked for the Founder (src/domain/calendars.ts).
  const onCalendar = async (slug: string) => {
    const r = await o.goto(`${BASE}/staff/calendars/${slug}`);
    if (r?.status() === 404) return null;
    return o.locator(`main a[href="/staff/crm/leads/${receptionistCall!.leadId}"]`).count();
  };
  const ai = await onCalendar("ai-follow-up"), founder = await onCalendar("founder-callback");
  if (ai === null || founder === null) console.log("journey 28: the dual calendars are not deployed on staging yet; calendar routing not checked");
  else if (!receptionistCall!.followUp) console.log("journey 28: the call asked for no callback or booking; calendar routing not exercised by this call");
  else {
    assert.equal((ai > 0 ? 1 : 0) + (founder > 0 ? 1 : 0), 1, `the requested follow-up is on exactly one calendar (AI Follow-Up: ${ai}, Founder Callback: ${founder})`);
    console.log(`journey 28: the requested follow-up is on the ${ai ? "AI Follow-Up" : "Founder Callback"} calendar`);
  }
  assertClean();
});

// ───────────── 29–30. Launch readiness evidence ─────────────

/** Posts an evidence document exactly as scripts/post-evidence.ts does (the CI client of the readiness API). */
async function postEvidence(body: string, secret = process.env.EVIDENCE_INGEST_SECRET!) {
  const res = await fetch(BASE + "/api/readiness/evidence", { method: "POST", headers: { "content-type": "application/json", "x-crestmont-signature": await signEvidence(secret, body) }, body });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as { status?: string; accepted?: number; runId?: string } };
}
function evidenceFile(env: string, fallback: string): string | null {
  const f = process.env[env] ?? fallback;
  return existsSync(f) ? f : null;
}
/** Signed ingestion of `file`: done here when the secret is present (development), otherwise read from the receipt the
 *  deploy workflow's first-party step wrote (the browser step never holds the secret). null = neither is available. */
async function ingested(file: string, receipt: string): Promise<{ status: number; json: { status?: string; accepted?: number; runId?: string } } | null> {
  if (process.env.EVIDENCE_INGEST_SECRET) return postEvidence(readFileSync(file, "utf8"));
  return existsSync(receipt) ? (JSON.parse(readFileSync(receipt, "utf8")) as { status: number; json: { status?: string; accepted?: number; runId?: string } }) : null;
}

journey(29, ["READY-004"], "launch readiness ingests this run's CI evidence (signed) and shows it to the Owner", {}, async (t) => {
  const file = evidenceFile("E2E_CI_EVIDENCE_FILE", "evidence/ci-evidence.json");
  const r = file ? await ingested(file, process.env.E2E_CI_RECEIPT ?? "evidence/receipts/ci.json") : null;
  if (!file || !r) {
    t.skip("needs this run's CI evidence document and its signed ingestion (the deploy workflow's 'Post this run's evidence' step writes evidence/receipts/ci.json)");
    return;
  }
  const body = readFileSync(file, "utf8");
  const doc = JSON.parse(body) as { runId: string; results: unknown[] };
  assert.equal((await postEvidence(body, "not-the-ingest-secret")).status, 401, "a wrongly signed document is refused");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(String(r.json.status), /^(ingested|duplicate)$/);
  const o = await as("owner");
  await o.goto(BASE + "/staff/readiness/engineering");
  const link = evidenceRunLink(o, doc.runId) as { count(): Promise<number>; first(): { click(): Promise<void> } };
  assert.equal(await link.count(), 1, `run ${doc.runId} listed under CI evidence (exactly this id, not a sibling run)`);
  await nav(o, link.first());
  const run = await text(o);
  const m = /(\d+) passed\/skipped, (\d+) failed/.exec(run);
  assert.ok(m, `run summary shown: ${run.slice(0, 300)}`);
  // Results are stored once per (requirement, test name); a document with repeated names is shown de-duplicated.
  const distinct = new Set((doc.results as { requirementId: string; testName: string }[]).map((x) => `${x.requirementId}|${x.testName}`)).size;
  const shown = Number(m![1]) + Number(m![2]);
  assert.ok(shown > 0 && shown <= distinct, `run shows ${shown} of ${distinct} distinct results`);
  if (r.json.status === "ingested" && r.json.accepted === doc.results.length) assert.equal(shown, distinct, "every result of the document is shown");
  assertClean();
});

journey(30, ["READY-006"], "staging verification of this deployment updates readiness (staging environment view and LAUNCH-003)", {}, async (t) => {
  const file = evidenceFile("E2E_STAGING_CHECK_FILE", "evidence/staging-check.json");
  const r = file ? await ingested(file, process.env.E2E_STAGING_CHECK_RECEIPT ?? "evidence/receipts/staging-check.json") : null;
  if (!file || !r) {
    t.skip("needs this deployment's verification document and its signed ingestion (the deploy workflow's 'Post this run's evidence' step writes evidence/receipts/staging-check.json)");
    return;
  }
  const body = readFileSync(file, "utf8");
  const doc = JSON.parse(body) as { runId: string; environment: string; results: { requirementId: string }[] };
  assert.equal(doc.environment, "staging");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const o = await as("owner");
  await o.goto(BASE + "/staff/readiness/env/staging");
  assert.match(await text(o), re(doc.runId), "staging environment view lists the verification run");
  await o.goto(BASE + "/staff/readiness/requirements/LAUNCH-003");
  const req = await text(o);
  assert.match(req, re(doc.runId), "LAUNCH-003 evidence history includes the staging verification");
  assert.doesNotMatch(req, /Staging\s+None/, "LAUNCH-003 has a staging verification state");
  assertClean();
});

// ───────────── 31–33. Founder approval and production ─────────────

/** Journeys only the real production launch can satisfy (reported separately in the certification file). */
const PRODUCTION_ONLY = [31, 32, 33];
journey(31, ["READY-008"], "Founder approval is recorded", { blocked: "LAUNCH-001: the production launch decision is the Founder's own; recording one from a demo Owner account on the shared staging readiness system would create a release candidate that invalidates any real approval (covered in development by journeys.e2e.ts [READY-008])" });
journey(32, ["READY-009"], "production deployment updates release history", { blocked: "LAUNCH-001: there is no production environment and no Founder launch authorization, so no production deployment can occur" });
journey(33, ["LAUNCH-003"], "production health verification updates readiness", { blocked: "LAUNCH-001: there is no production deployment to verify" });

// Untagged on purpose: a bookkeeping check, not evidence for any requirement.
test("[TEST-002] staging journeys: summary of the 33 required journeys", { skip: unset || false }, () => {
  const rows = [...Array(33)].map((_, i) => `${String(i + 1).padStart(2)}  ${outcome.get(i + 1) ?? "not run"}`);
  console.log(`Staging journeys (${RUN}):\n${rows.join("\n")}`);
  assert.equal(outcome.size, 33, "every journey ran or was explicitly skipped");
  // Staging is CERTIFIED only when all 33 required journeys passed on this deployment; a skip or block is never a pass.
  const list = [...Array(33)].map((_, i) => ({ journey: i + 1, outcome: outcome.get(i + 1) ?? "not run" }));
  const passed = list.filter((j) => j.outcome === "passed").length;
  const failed = list.filter((j) => j.outcome.startsWith("failed")).length;
  // Recorded separately (never counted as passed, and certification is unchanged): checks that only the real production
  // launch can satisfy. They stay skipped on staging by design, so staging alone can at most reach 30/33.
  const productionOnly = list.filter((j) => PRODUCTION_ONLY.includes(j.journey) && j.outcome !== "passed");
  const stagingApplicable = list.filter((j) => !PRODUCTION_ONLY.includes(j.journey));
  const cert = { run: RUN, required: 33, passed, failed, notPassed: list.filter((j) => j.outcome !== "passed"), certified: passed === 33,
    stagingApplicable: { required: stagingApplicable.length, passed: stagingApplicable.filter((j) => j.outcome === "passed").length },
    productionOnly };
  mkdirSync("evidence", { recursive: true });
  writeFileSync(process.env.E2E_CERTIFICATION_FILE ?? "evidence/staging-certification.json", JSON.stringify(cert, null, 2));
  console.log(cert.certified ? "STAGING CERTIFIED: 33/33 required journeys passed" : `STAGING NOT CERTIFIED: ${passed}/33 passed, ${failed} failed, ${33 - passed - failed} skipped or blocked`);
  console.log(`Staging-applicable journeys: ${cert.stagingApplicable.passed}/${cert.stagingApplicable.required} passed; production/Founder-launch only (not counted as passed): ${productionOnly.map((j) => j.journey).join(", ") || "none outstanding"}`);
});
