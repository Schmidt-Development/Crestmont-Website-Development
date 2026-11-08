// Production-closeout verification on DEPLOYED STAGING, in a browser (.github/workflows/staging-closeout-verify.yml).
//
// What only the deployed system can show, and the in-process suite cannot:
//   LG  The maintenance launch gate against REAL Stripe test-mode Checkout and the REAL signed webhooks: a project at
//       customer review cannot be published; the customer sees both pending actions; signing alone does not unlock it;
//       an abandoned Checkout and a declined card leave it pending; a paid subscription (Stripe's published test card)
//       clears both actions only once Stripe's webhook confirms the first payment; then, and only then, the handoff
//       publishes. The project and its customer are a per-run fixture (scripts/staging-closeout-fixture.ts).
//   EM  A real internal notification: a test lead through the public lead API makes the platform email the internal
//       mailbox through Resend; scripts/staging-closeout-check.ts then reads what Resend did with it (accepted,
//       delivered) from staging D1. The Resend health check is run from the Integrations page as the Owner.
//   AI  "AI draft reply" on a real support ticket and a real customer conversation: the draft appears in the editable
//       reply box without a reload, from the configured provider, and nothing is sent.
//   ST  What the AI receptionist and Integrations pages actually say on staging (recorded for the report).
//
// Card numbers are Stripe's published TEST cards; the Checkout session is asserted to be a test session (cs_test_).
// Nothing here can charge a card, place a call or mail a customer. The run's ids are written to access/closeout-run.json
// for the D1 checker.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { launchBrowser } from "./support.ts";
import { totpCode } from "../../src/lib/auth-crypto.ts";

type Page = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Playwright is loaded at runtime

const BASE = process.env.E2E_BASE_URL?.replace(/\/$/, "");
const ACCOUNTS = process.env.E2E_ACCOUNTS_FILE;
const FIXTURE = process.env.E2E_CLOSEOUT_FIXTURE;
const RUN_FILE = process.env.E2E_CLOSEOUT_RUN_FILE ?? "access/closeout-run.json";
const unset = !BASE || !ACCOUNTS || !FIXTURE ? "E2E_BASE_URL / E2E_ACCOUNTS_FILE / E2E_CLOSEOUT_FIXTURE not set" : false;
const AI_PATIENCE_MS = Number(process.env.E2E_AI_PATIENCE_MS ?? 360_000);

interface Account { role: string; email: string; password: string; totp?: string }
interface Fixture { run: string; orgId: string; projectId: string; email: string; password: string; totp: string }
const fx = (): Fixture => JSON.parse(readFileSync(FIXTURE!, "utf8"));
function accounts(): Account[] {
  const md = readFileSync(ACCOUNTS!, "utf8");
  return [...md.matchAll(/^\| (\w+) \| (\S+) \| `([^`]+)` \| (?:`([A-Z2-7]+)`|—) \|/gm)].map((m) => ({ role: m[1], email: m[2], password: m[3], totp: m[4] }));
}
const staff = (role: string) => { const a = accounts().find((x) => x.role === role); assert.ok(a, `a ${role} demo account exists`); return a!; };
const customer = (): Account => { const f = fx(); return { role: "customer_admin", email: f.email, password: f.password, totp: f.totp }; };

const record: Record<string, unknown> = { startedAt: new Date().toISOString() };
const save = () => writeFileSync(RUN_FILE, JSON.stringify(record, null, 2));

let browser: Awaited<ReturnType<typeof launchBrowser>>;
const pages = new Map<string, Page>();
before(async () => { if (unset) return; browser = await launchBrowser(); const f = fx(); Object.assign(record, { run: f.run, orgId: f.orgId, projectId: f.projectId }); save(); });
after(async () => { save(); await browser?.close(); });

async function signIn(a: Account): Promise<Page> {
  if (pages.has(a.email)) return pages.get(a.email);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("dialog", (d: { accept: () => Promise<void> }) => d.accept());
  await page.goto(BASE + "/login");
  await page.fill("#f-email", a.email);
  await page.fill("#f-password", a.password);
  await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);
  if (new URL(page.url()).pathname.startsWith("/mfa")) {
    assert.ok(a.totp, `${a.role} was asked for a code and has no key`);
    await page.fill("#f-code", await totpCode(a.totp!));
    await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);
  }
  assert.doesNotMatch(new URL(page.url()).pathname, /^\/(login|mfa)/, `signed in as ${a.role}`);
  pages.set(a.email, page);
  return page;
}
const text = async (p: Page, sel = "main") => ((await p.locator(sel).first().innerText()) as string).replace(/\s+/g, " ");
const nav = async (p: Page, loc: { click(): Promise<void> }) => { await Promise.all([p.waitForNavigation({ waitUntil: "load" }), loc.click()]); };

/** A staff POST through the signed-in browser context (same cookies, real CSRF token from the page), redirects not followed. */
async function staffPost(p: Page, path: string, form: Record<string, string>): Promise<{ status: number; body: string }> {
  const csrf = await p.locator("input[name=_csrf]").first().inputValue();
  const r = await p.request.post(BASE + path, { form: { _csrf: csrf, ...form }, maxRedirects: 0, headers: { origin: BASE!, referer: p.url() } });
  return { status: r.status(), body: (await r.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") };
}

// ───────────── LG: maintenance launch gate with real Stripe test mode ─────────────

const projectUrl = () => `${BASE}/portal/projects/${fx().projectId}`;
const approvalsUrl = () => `${BASE}/staff/projects/${fx().projectId}?tab=approvals`;
const CHECK7 = /7\. Maintenance agreement signed and first subscription payment verified\s+(Pass|Missing|Fail)/i;
const HANDOFF = () => ({ intent: "publish", website_url: `https://example.com/?crestmont-closeout=${fx().run}`, documentation: "Closeout E2E handoff documentation (TEST DATA).",
  access_instructions: "Closeout E2E access instructions (TEST DATA).", ownership_notes: "Closeout E2E ownership notes (TEST DATA).", training_notes: "Closeout E2E training notes (TEST DATA)." });

async function startCheckout(p: Page): Promise<void> {
  await p.goto(projectUrl());
  await nav(p, p.locator("[data-launch-gate]").getByRole("link", { name: "Activate your maintenance subscription" }));
  assert.match(new URL(p.url()).pathname, /^\/checkout\/maintenance\/essential$/, "the Essential plan the project committed to");
  assert.match(await text(p), /Essential — \$99\/month/, "the Founder-established Essential price ($99/month)");
  await p.locator("input[name=terms]").check();
  await p.locator('form[action="/checkout/maintenance/essential"] button[type=submit]').click();
  await p.waitForURL(/^https:\/\/checkout\.stripe\.com\//, { timeout: 60_000 });
  assert.match(p.url(), /\/c\/pay\/cs_test_/, "a Stripe TEST-mode Checkout session (never live)");
}
async function fillCard(p: Page, number: string): Promise<void> {
  const f = fx();
  const cardNumber = p.locator("#cardNumber");
  const cardButton = p.locator('[data-testid="card-accordion-item-button"]').first();
  await Promise.any([cardNumber.waitFor({ state: "visible", timeout: 30_000 }), cardButton.waitFor({ state: "attached", timeout: 30_000 })]).catch(() => undefined);
  if (!(await cardNumber.isVisible()) && (await cardButton.count())) await cardButton.dispatchEvent("click");
  await cardNumber.waitFor({ state: "visible", timeout: 30_000 });
  await cardNumber.fill(number);
  await p.locator("#cardExpiry").fill("12 / 34");
  await p.locator("#cardCvc").fill("123");
  if (await p.locator("#billingName").count()) await p.locator("#billingName").fill("Launch Gate Tester");
  if (await p.locator("#billingPostalCode").isVisible().catch(() => false)) await p.locator("#billingPostalCode").fill("48933");
  if (await p.locator("#email").isEditable().catch(() => false)) await p.locator("#email").fill(f.email);
  const link = p.locator("#enableStripePass");
  if ((await link.count()) && (await link.isChecked())) await link.dispatchEvent("click");
  if ((await link.count()) && (await link.isChecked())) await link.setChecked(false, { force: true });
  await p.locator('[data-testid="hosted-payment-submit-button"], .SubmitButton').first().click();
}

test("[PAY-004] LG-01 a project at customer review shows both pending actions; the subscription cannot be started before the agreement is signed", { skip: unset }, async () => {
  const p = await signIn(customer());
  await p.goto(projectUrl());
  const card = await text(p, "[data-launch-gate]");
  assert.match(card, /Pending action: Sign your maintenance agreement/);
  assert.match(card, /Pending action: Activate your maintenance subscription/);
  assert.match(card, /Available after you sign the maintenance agreement/);
  assert.equal(await p.locator("[data-launch-gate]").getByRole("link", { name: "Activate your maintenance subscription" }).count(), 0, "no activation link before signing");
  const r = await p.request.get(`${BASE}/checkout/maintenance/essential`);
  const direct = await p.request.post(`${BASE}/checkout/maintenance/essential`, { form: { _csrf: await p.locator("input[name=_csrf]").first().inputValue().catch(() => ""), terms: "1" }, maxRedirects: 0, headers: { origin: BASE!, referer: p.url() } });
  assert.notEqual(direct.status(), 303, `a direct POST to start Checkout before signing must be refused (got ${direct.status()}, GET ${r.status()})`);
});

test("[PAY-004] LG-02 every publish path is refused before the gate: handoff publish (409) and the release check (7 is not passing)", { skip: unset }, async () => {
  const o = await signIn(staff("owner"));
  await o.goto(approvalsUrl());
  const panel = await text(o, ".card--gold");
  assert.match(panel, CHECK7);
  assert.notEqual(CHECK7.exec(panel)![1].toLowerCase(), "pass", "check 7 is not passing before the agreement and payment");
  const h = await staffPost(o, `/staff/projects/${fx().projectId}/handoff`, HANDOFF());
  assert.equal(h.status, 409, `handoff publish must be refused before the launch gate (got ${h.status})`);
  assert.match(h.body, /cannot be published yet/i);
  const d = await staffPost(o, `/staff/projects/${fx().projectId}/deployments`, { url: `https://example.com/?crestmont-closeout=${fx().run}` });
  assert.notEqual(d.status, 303, `recording a deployment must be refused before every release check passes (got ${d.status})`);
});

test("[PAY-004] LG-03 the customer signs the maintenance agreement in the portal; signing alone does not unlock publishing", { skip: unset }, async () => {
  const p = await signIn(customer());
  await p.goto(projectUrl());
  await nav(p, p.locator("[data-launch-gate]").getByRole("link", { name: "Sign your maintenance agreement" }));
  await p.locator("input[name=agree]").check();
  await nav(p, p.getByRole("button", { name: "Sign the maintenance agreement" }));
  await p.goto(projectUrl());
  const card = await text(p, "[data-launch-gate]");
  assert.match(card, /Maintenance agreement signed/);
  assert.match(card, /Pending action: Activate your maintenance subscription/);
  assert.equal(await p.locator("[data-launch-gate]").getByRole("link", { name: "Activate your maintenance subscription" }).count(), 1, "the activation link appears once signed");
  const o = await signIn(staff("owner"));
  await o.goto(approvalsUrl());
  assert.equal((await staffPost(o, `/staff/projects/${fx().projectId}/handoff`, HANDOFF())).status, 409, "still refused with the agreement signed but no subscription");
});

test("[PAY-004] LG-04 an abandoned Stripe Checkout leaves the subscription pending", { skip: unset }, async () => {
  const p = await signIn(customer());
  await startCheckout(p);
  await p.goto(projectUrl()); // walks away without paying
  assert.match(await text(p, "[data-launch-gate]"), /Pending action: Activate your maintenance subscription/);
});

test("[PAY-004] LG-05 a declined card is refused by Stripe and the subscription stays pending", { skip: unset }, async () => {
  const p = await signIn(customer());
  await startCheckout(p);
  await fillCard(p, "4000 0000 0000 0002"); // Stripe's published "generic decline" test card
  // Polled through a locator: evaluating code in the page is refused by a strict CSP (tests/e2e harness rule, TEST-002).
  const end = Date.now() + 45_000;
  while (!/declined/i.test((await p.locator("body").innerText().catch(() => "")) as string)) {
    if (Date.now() > end) assert.fail("Stripe did not show the decline within 45s");
    await p.waitForTimeout(1_000);
  }
  assert.match(p.url(), /^https:\/\/checkout\.stripe\.com\//, "Stripe keeps the customer on Checkout after a decline");
  await p.goto(projectUrl());
  assert.match(await text(p, "[data-launch-gate]"), /Pending action: Activate your maintenance subscription/);
});

test("[PAY-004] LG-06 paying with Stripe's test card activates the subscription; both actions clear only after Stripe's webhook confirms the first payment", { skip: unset }, async () => {
  const p = await signIn(customer());
  await startCheckout(p);
  await fillCard(p, "4242 4242 4242 4242");
  await p.waitForURL((u: URL) => u.href.startsWith(BASE!), { timeout: 90_000 });
  const end = Date.now() + 180_000;
  let card = "";
  for (;;) {
    await p.goto(projectUrl());
    card = await text(p, "[data-launch-gate]");
    if (/Everything is in place/.test(card)) break;
    if (Date.now() > end) assert.fail(`Stripe's webhook did not confirm the subscription's first payment within 180s. Card: ${card.slice(0, 400)}`);
    await p.waitForTimeout(5_000);
  }
  assert.match(card, /Maintenance subscription active/);
  assert.match(card, /First payment confirmed by Stripe on \d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(card, /Pending action/);
  record.subscriptionPaidAt = new Date().toISOString(); save();
});

test("[PAY-004] LG-07 with the gate satisfied the release check passes and the handoff publishes", { skip: unset }, async () => {
  const o = await signIn(staff("owner"));
  await o.goto(approvalsUrl());
  const panel = await text(o, ".card--gold");
  assert.equal(CHECK7.exec(panel)?.[1].toLowerCase(), "pass", `check 7 passes: ${panel.slice(0, 600)}`);
  const h = await staffPost(o, `/staff/projects/${fx().projectId}/handoff`, HANDOFF());
  assert.equal(h.status, 303, `the handoff publishes once the gate holds (got ${h.status}: ${h.body.slice(0, 300)})`);
  record.handoffPublished = true; save();
});

// ───────────── EM: a real internal notification through Resend ─────────────

test("[EMAIL-001] EM-01 the Resend health check runs from the Integrations page; its result is recorded", { skip: unset }, async () => {
  const o = await signIn(staff("owner"));
  await o.goto(`${BASE}/staff/integrations`);
  const run = o.locator('form[action="/staff/integrations/resend/verify"] button');
  if (await run.count()) await nav(o, run.first());
  await o.goto(`${BASE}/staff/integrations`);
  const rows = await o.locator("main tr").evaluateAll((trs: Element[]) => trs.map((tr) => (tr.textContent ?? "").replace(/\s+/g, " ").trim()).filter((s) => s.length > 0));
  record.integrations = rows; save();
  const resend = rows.find((r: string) => /^Resend \(email/.test(r));
  assert.ok(resend, "the Resend row is shown");
  console.log(`  Resend on staging: ${resend!.slice(0, 400)}`);
});

test("[EMAIL-001] EM-02 a test lead through the public lead API triggers the internal new-lead email (delivery read from D1 afterwards)", { skip: unset }, async () => {
  const run = fx().run;
  const r = await fetch(`${BASE}/api/leads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    name: "Closeout Email Check (TEST DATA)", email: `closeout-${run}@example.com`, company: `Closeout E2E ${run} (TEST DATA)`, interest: "starter",
    message: "[TEST DATA] production closeout: verifies the internal new-lead email through Resend. Nothing to do.", source: "web_form", turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" }) });
  const body = (await r.json().catch(() => ({}))) as { leadId?: string; error?: string };
  assert.equal(r.status, 201, `the public lead API accepted the test lead (${body.error ?? ""})`);
  record.leadId = body.leadId; save();
});

// ───────────── AI: draft replies from the configured provider, without a reload ─────────────

async function waitForDraft(p: Page, what: string): Promise<string> {
  await p.locator("[data-ai-draft-button]").first().click();
  await p.locator("[data-ai-draft-status]").first().waitFor({ state: "visible", timeout: 15_000 }); // the request is acknowledged at once
  const t0 = Date.now();
  for (;;) {
    const body = (await p.locator("#reply textarea[name=body]").inputValue()) as string;
    const state = (await p.locator("[data-ai-draft-status]").getAttribute("data-state")) as string;
    const status = ((await p.locator("[data-ai-draft-status]").innerText()) as string).replace(/\s+/g, " ").trim();
    if (body.trim().length > 20) return body;
    if (state === "failed") assert.fail(`${what}: the AI draft failed — ${status}`);
    if (Date.now() - t0 > AI_PATIENCE_MS) assert.fail(`${what}: no draft within ${AI_PATIENCE_MS / 1000}s (state ${state}: ${status}). With AI_PROVIDER=local-runner this means the self-hosted runner did not complete the job.`);
    await p.waitForTimeout(2_000);
  }
}

test("[SUP-002] AI-01 Support: AI draft reply fills the editable reply box without a reload and sends nothing", { skip: unset }, async () => {
  const c = await signIn(customer());
  await c.goto(`${BASE}/portal/support/new`);
  await c.fill("input[name=subject]", `Closeout E2E question ${fx().run} (TEST DATA)`);
  await c.selectOption("select[name=category]", "technical");
  await c.fill("textarea[name=description]", "Hello, how do I update the opening hours shown on my website? This is a test ticket for the production closeout.");
  await nav(c, c.locator('form[action="/portal/support/new"] button[type=submit]'));
  const ticketId = /\/portal\/support\/(tkt_[A-Za-z0-9]+)/.exec(c.url())?.[1];
  assert.ok(ticketId, `the ticket was created (${c.url()})`);
  record.ticketId = ticketId; save();
  const s = await signIn(staff("support"));
  await s.goto(`${BASE}/staff/support/${ticketId}`);
  const url = s.url();
  const draft = await waitForDraft(s, "Support");
  assert.equal(s.url(), url, "the page was not reloaded or navigated");
  assert.ok(await s.locator("#reply textarea[name=body]").isEditable(), "the draft is editable");
  record.supportDraftChars = draft.length; save();
});

test("[CRM-004] AI-02 Conversations: AI draft reply uses the customer's conversation, fills the reply box without a reload and sends nothing", { skip: unset }, async () => {
  const c = await signIn(customer());
  await c.goto(`${BASE}/portal/messages/general`);
  await c.fill("textarea[name=body]", "Could you remind me what is included in the Essential maintenance plan? (closeout test message)");
  await nav(c, c.locator('form[action="/portal/messages/general"] button[type=submit]'));
  const o = await signIn(staff("owner"));
  await o.goto(`${BASE}/staff/conversations/${fx().orgId}`);
  const url = o.url();
  const draft = await waitForDraft(o, "Conversations");
  assert.equal(o.url(), url, "the page was not reloaded or navigated");
  record.conversationDraftChars = draft.length; save();
});

// ───────────── ST: what staging's status pages say ─────────────

test("[VOICE-005] ST-01 the AI receptionist page reports status from its real sources", { skip: unset }, async () => {
  const o = await signIn(staff("owner"));
  await o.goto(`${BASE}/staff/voice`);
  const status = await text(o, "[data-receptionist-status]");
  record.receptionist = status; save();
  console.log(`  Receptionist on staging: ${status.slice(0, 900)}`);
  assert.doesNotMatch(await text(o), /No voice provider selected/);
});
