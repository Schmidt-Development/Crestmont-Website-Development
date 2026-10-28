// Real-browser journeys for the §69 required E2E list (Chromium via Playwright, against dev/server.ts).
// One development server + throwaway database for the whole file; the tests run in order and share
// the records each step creates. Every record here is TEST DATA in a development environment.
//
// Allowed shortcuts (everything else goes through real pages, links, forms and buttons):
//  - staff users are inserted directly (hashPassword + newTotpSecret), then sign in through the UI with TOTP;
//  - verification / proposal links are read from the dev email outbox;
//  - Stripe, the voice provider and CI are simulated by posting correctly SIGNED payloads over HTTP to the
//    dev server. There is no Stripe account (BLK-004), no voice provider and no CI connection here, so these
//    are labelled fixtures: they prove our webhook handling, not the external services.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, launchBrowser, latestEmail, linkIn } from "./support.ts";
import { hashPassword, totpCode, newTotpSecret } from "../../src/lib/auth-crypto.ts";
import { hmacSha256Hex } from "../../src/lib/crypto.ts";

type Server = Awaited<ReturnType<typeof startServer>>;
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
// Playwright is loaded dynamically (no npm types in this repo), so pages are loosely typed.
type Page = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Ctx = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let srv: Server;
let browser: Browser;
const PW = "e2e-test-password-123";
const RUN = Date.now().toString(36);
const issues: string[] = [];
// The journey is one story: later steps build on earlier records. Once a step fails, the dependent steps are
// skipped (reported as skipped, never as passed) instead of timing out one after another.
let journeyBroken = "";
function step(name: string, fn: () => Promise<void>) {
  test(name, async (t) => {
    if (journeyBroken) { t.skip(`depends on an earlier step that failed: ${journeyBroken}`); return; }
    try { await fn(); } catch (e) {
      journeyBroken = name.slice(0, name.indexOf("]") + 1);
      // Diagnostics: where each person's browser is and what alerts it shows.
      for (const [who, a] of Object.entries({ owner, rep, pm, dev, supportAgent, customer })) {
        if (!a) continue;
        const alerts = await a.page.locator(".alert, .toast").allInnerTexts().catch(() => []);
        console.error(`[${who}] ${a.page.url()} ${JSON.stringify(alerts)}`);
      }
      throw e;
    }
  });
}

before(async () => { srv = await startServer(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); await srv?.stop(); });

// ───────────── helpers ─────────────

const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents % 100 ? 2 : 0 });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

interface Actor { ctx: Ctx; page: Page }

/** A browser context per person (own cookies). Records CSP violations, page errors and 5xx responses. */
async function actor(opts: Record<string, unknown> = {}): Promise<Actor> {
  const ctx = await browser.newContext(opts);
  ctx.setDefaultTimeout(10_000);
  const page = await ctx.newPage();
  watch(page);
  return { ctx, page };
}
function watch(page: Page) {
  page.on("dialog", (d: { accept(): Promise<void> }) => d.accept()); // data-confirm prompts
  page.on("console", (m: { type(): string; text(): string }) => {
    const t = m.text();
    if (m.type() !== "error" || /fonts\.(googleapis|gstatic)\.com/.test(t)) return; // fonts are unreachable from this sandbox
    if (/Content Security Policy|Refused to/i.test(t)) issues.push(`CSP: ${t} @ ${page.url()}`);
  });
  page.on("pageerror", (e: Error) => issues.push(`JS error: ${e.message} @ ${page.url()}`));
  page.on("response", (r: { status(): number; url(): string }) => { if (r.status() >= 500) issues.push(`HTTP ${r.status()} ${r.url()}`); });
}
function assertClean() {
  const found = issues.splice(0);
  assert.deepEqual(found, [], "no CSP violations, JS errors or 5xx responses");
}

/** Click something that submits a form or follows a link, and wait for the next document. */
async function nav(page: Page, target: string | { click(): Promise<void> }) {
  const loc = typeof target === "string" ? page.locator(target) : target;
  await Promise.all([page.waitForNavigation({ waitUntil: "load" }), loc.click()]);
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Button by its accessible name (case-insensitive: labels are title-cased by label()). */
const btn = (page: Page, name: string, scope?: string) => (scope ? page.locator(scope) : page).getByRole("button", { name: new RegExp(`^${esc(name)}$`, "i") }).first();
const text = async (page: Page, sel = "main") => (await page.locator(sel).first().innerText()) as string;

interface StaffUser { id: string; email: string; secret: string; name: string }
const staffUsers: Record<string, StaffUser> = {};
async function createStaff(role: string, name: string): Promise<StaffUser> {
  const id = `usr_e2e_${role}_${RUN}`, email = `${role}.${RUN}@crestmont.test`, secret = newTotpSecret(), now = new Date().toISOString();
  srv.db.exec(`INSERT OR IGNORE INTO organizations (id, name, kind, created_at) VALUES ('org_crestmont','Crestmont Website Development','internal','${now}')`);
  srv.db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, totp_secret, mfa_enabled, created_at) VALUES (?,?,?,?,?,?,1,?)`).run(id, email, name, await hashPassword(PW), now, secret, now);
  srv.db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?,?,?)`).run(`mbr_${id}`, id, "org_crestmont", role, now);
  return (staffUsers[role] = { id, email, secret, name });
}

/** Sign in through the real login page; staff complete the TOTP step. */
async function signIn(page: Page, email: string, secret?: string) {
  await page.goto(srv.base + "/login");
  await page.fill("#f-email", email);
  await page.fill("#f-password", PW);
  await nav(page, "button[type=submit]");
  if (new URL(page.url()).pathname.startsWith("/mfa")) {
    assert.ok(secret, "MFA required");
    // TOTP codes are single-use per 30-second step (replay protection). Several staff sign in within the same
    // window here, and a user may sign in twice in one window, so simulate "the next window" first.
    srv.db.prepare("UPDATE users SET totp_last_step = NULL WHERE email = ?").run(email);
    await page.fill("#f-code", await totpCode(secret!));
    await nav(page, "button[type=submit]");
  }
  assert.doesNotMatch(new URL(page.url()).pathname, /^\/(login|mfa)/, `signed in as ${email}`);
}
/** Step-up MFA (src/app/step-up.ts): sensitive actions need a TOTP check within 10 minutes; do it just before. */
async function freshMfa(page: Page, user: StaffUser) {
  const back = new URL(page.url()).pathname + new URL(page.url()).search;
  await page.goto(`${srv.base}/mfa/step-up?next=${encodeURIComponent(back)}`);
  srv.db.prepare("UPDATE users SET totp_last_step = NULL WHERE email = ?").run(user.email);
  await page.fill("#f-code", await totpCode(user.secret));
  await nav(page, "button[type=submit]");
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, back, "returned to the page after the step-up check");
}
async function staffActor(role: string, name: string, opts: Record<string, unknown> = {}): Promise<Actor & { user: StaffUser }> {
  const user = await createStaff(role, name);
  const a = await actor(opts);
  await signIn(a.page, user.email, user.secret);
  return { ...a, user };
}

/** Signed Stripe webhook fixture (no Stripe account; BLK-004). Metadata mirrors what our checkout sends to Stripe. */
let evtSeq = 0;
async function stripePaid(invoiceId: string, email: string) {
  const inv = srv.db.prepare(`SELECT i.amount_cents, i.organization_id, i.order_id, i.milestone_kind, o.kind AS order_kind FROM invoices i LEFT JOIN orders o ON o.id = i.order_id WHERE i.id = ?`).get(invoiceId) as
    { amount_cents: number; organization_id: string; order_id: string | null; milestone_kind: string; order_kind: string | null };
  const kind = inv.milestone_kind === "change_order" ? "change_order" : ["design_25", "prelaunch_25"].includes(inv.milestone_kind) ? "milestone" : inv.order_kind ?? "invoice";
  evtSeq++;
  const evt = { id: `evt_e2e_${RUN}_${evtSeq}`, type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: {
    id: `cs_test_e2e_${RUN}_${evtSeq}`, object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: inv.amount_cents,
    payment_intent: `pi_test_e2e_${RUN}_${evtSeq}`, customer: `cus_test_e2e_${RUN}`, customer_email: email,
    metadata: { organization_id: inv.organization_id, invoice_id: invoiceId, order_id: inv.order_id ?? "", kind } } } };
  const body = JSON.stringify(evt);
  const post = async () => {
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(srv.base + "/api/webhooks/stripe", { method: "POST", body, headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${await hmacSha256Hex("whsec_e2e_test_secret", `${ts}.${body}`)}` } });
    return { status: res.status, json: (await res.json()) as { received: boolean; duplicate: boolean } };
  };
  const first = await post();
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.duplicate, false);
  const again = await post(); // Stripe retries deliveries; the second one must be a no-op
  assert.equal(again.json.duplicate, true);
  paidCents.push(inv.amount_cents);
  return inv.amount_cents;
}
const paidCents: number[] = [];

async function signedPost(path: string, header: string, secret: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(srv.base + path, { method: "POST", body, headers: { "content-type": "application/json", [header]: `t=${ts},v1=${await hmacSha256Hex(secret, `${ts}.${body}`)}` } });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ───────────── shared journey state ─────────────

const contact = { name: `Morgan Reyes ${RUN}`, email: `morgan.${RUN}@harborcoffee.example`, company: `Harbor Coffee ${RUN}` };
const lines = [{ desc: "Online ordering system", dollars: "6,000" , cents: 600_000 }, { desc: "Loyalty portal", dollars: "1500.50", cents: 150_050 }];
const total = lines.reduce((s, l) => s + l.cents, 0);
let owner: Actor & { user: StaffUser };
let rep: Actor & { user: StaffUser };
let pm: Actor & { user: StaffUser };
let dev: Actor & { user: StaffUser };
let supportAgent: Actor & { user: StaffUser };
let customer: Actor;
let leadId = "", quoteId = "", proposalUrl = "", depositInvoiceId = "", projectId = "", ticketUrl = "";

// ───────────── 1–2. Lead capture → CRM ─────────────

step("[CRM-001] visitor submits the public quote form and the lead appears in the owner's CRM, then in the assigned rep's pipeline", async () => {
  const visitor = await actor();
  const p = visitor.page;
  await p.goto(srv.base + "/quote");
  await p.fill("#f-name", contact.name);
  await p.fill("#f-email", contact.email);
  await p.fill("#f-company", contact.company);
  await p.selectOption("#f-interest", "custom");
  await p.selectOption("#f-budget", "$5,000 – $10,000");
  await p.selectOption("#f-timeline", "1 – 3 months");
  await p.fill("#f-message", "We need online ordering for three cafés and a loyalty portal for regulars.");
  await nav(p, btn(p, "Request my quote"));
  assert.match(new URL(p.url()).pathname, /^\/quote\/thanks$/);
  assert.match(await text(p, "h1"), /Quote request received/);
  assert.equal(latestEmail(srv.db, contact.email)?.template, "lead_received", "acknowledgement email in the outbox");
  await visitor.ctx.close();

  owner = await staffActor("owner", "E2E Owner");
  rep = await staffActor("sales", "E2E Sales Rep");
  const o = owner.page;
  await o.goto(srv.base + "/staff/crm");
  await nav(o, o.locator("a.kanban__card", { hasText: contact.name }));
  leadId = new URL(o.url()).pathname.split("/").pop()!;
  assert.match(leadId, /^ld_/);
  const detail = await text(o);
  assert.match(detail, /Source\s+Quote form/i, "source tracked");
  assert.match(detail, /Budget range: \$5,000 – \$10,000/);

  // Before assignment the rep cannot see it; the owner assigns it; then it is in the rep's pipeline.
  await rep.page.goto(srv.base + "/staff/crm");
  assert.doesNotMatch(await text(rep.page), new RegExp(contact.name, "i"));
  await o.selectOption("#f-owner", rep.user.id);
  await nav(o, btn(o, "Save owner"));
  assert.match(await text(o), new RegExp(`Owner\\s+${rep.user.name}`, "i"));
  await rep.page.goto(srv.base + "/staff/crm");
  assert.match(await text(rep.page), new RegExp(contact.name, "i"));
  assertClean();
});

// ───────────── 3. Quote builder + proposal ─────────────

step("[SALES-002] sales rep qualifies the lead and builds a custom quote whose total and 50/25/25 schedule are computed server-side", async () => {
  const p = rep.page;
  await p.goto(`${srv.base}/staff/crm/leads/${leadId}`);
  for (const to of ["qualified", "quote_required"]) {
    await p.selectOption("#f-to", to);
    await nav(p, btn(p, "Change stage"));
  }
  assert.match(await text(p, ".page-head, main"), /Quote required/i);
  await nav(p, p.getByRole("link", { name: "New quote" }));
  await p.selectOption("#f-package", "custom");
  for (const [i, l] of lines.entries()) { await p.fill(`#line-desc-${i}`, l.desc); await p.fill(`#line-amt-${i}`, l.dollars); }
  await p.fill("#f-scope", "Custom web application: online ordering for three locations, loyalty accounts, admin portal, 3 revision rounds.");
  await nav(p, btn(p, "Save draft (v1)"));
  quoteId = new URL(p.url()).pathname.split("/").pop()!;
  assert.match(quoteId, /^q/);
  const page = await text(p);
  assert.match(page, new RegExp(`Total ${usd(total).replace("$", "\\$")}`, "i"));
  assert.match(page, new RegExp(`50% deposit on acceptance\\s+${usd(Math.floor(total / 2)).replace("$", "\\$")}`, "i"));
  assert.match(page, /Version history/);
  assertClean();
});

step("[SALES-003] sending the proposal emails the contact a private link and moves the lead to Quote sent", async () => {
  const p = rep.page;
  await nav(p, btn(p, "Send proposal"));
  const mail = latestEmail(srv.db, contact.email);
  assert.equal(mail?.template, "quote_sent");
  proposalUrl = linkIn(mail!.text_body, srv.base, "/q/");
  await p.goto(`${srv.base}/staff/crm/leads/${leadId}`);
  assert.match(await text(p), /Quote sent/i);
  assertClean();
});

// ───────────── 4. Customer accepts → order + invoice; checkout is honest ─────────────

step("[SALES-004] customer registers with the quote email, verifies, signs in, accepts the proposal → order and open deposit invoice; checkout honestly says payments are not configured", async () => {
  customer = await actor();
  const p = customer.page;
  await p.goto(proposalUrl);
  assert.match(await text(p), /Ready to accept\?/);
  await nav(p, p.getByRole("link", { name: "Create account" }));
  await p.fill("#f-name", contact.name);
  await p.fill("#f-organization", contact.company);
  await p.fill("#f-email", contact.email);
  await p.fill("#f-password", PW);
  await p.check("input[name=terms]");
  await nav(p, "button[type=submit]");
  assert.match(await text(p, "h1"), /Check your email/);
  const verify = latestEmail(srv.db, contact.email);
  assert.equal(verify?.template, "verification");
  await p.goto(linkIn(verify!.text_body, srv.base, "/verify-email"));
  await signIn(p, contact.email);

  await p.goto(proposalUrl);
  assert.match(await text(p), new RegExp(usd(total).replace("$", "\\$")));
  await p.check("input[name=agree]");
  await nav(p, btn(p, "Accept and continue to payment"));
  const path = new URL(p.url()).pathname;
  assert.match(path, /^\/portal\/billing\/invoices\/inv_/);
  depositInvoiceId = path.split("/").pop()!;
  const inv = await text(p);
  assert.match(inv, new RegExp(usd(Math.floor(total / 2)).replace("$", "\\$")));
  assert.match(inv, /Online payment is not configured yet\./, "honest: no Stripe key in this environment");
  assert.equal(await p.getByRole("button", { name: /Pay .* securely/ }).count(), 0, "no pay button when payments are not configured");

  await nav(p, p.getByRole("link", { name: "All billing" }));
  const billing = await text(p);
  assert.match(billing, /Online payment is not configured yet\. Open invoices cannot be paid online yet/);
  assert.match(billing, /50% deposit[\s\S]*Open/i);
  assert.match(billing, /Pending payment/i);
  assert.equal(await p.getByRole("button", { name: "Pay now" }).count(), 0);
  await rep.page.goto(`${srv.base}/staff/crm/leads/${leadId}`);
  assert.match(await text(rep.page), /Awaiting payment/i);
  assertClean();
});

// ───────────── 5–7. Payment webhook → order, project, conversion ─────────────

step("[PAY-003] signed webhook fixture (no Stripe account; BLK-004): checkout.session.completed marks the deposit paid, provisions the project and converts the lead; the retry is a duplicate", async () => {
  const amount = await stripePaid(depositInvoiceId, contact.email);
  const p = customer.page;
  await p.goto(srv.base + "/portal/billing");
  const billing = await text(p);
  assert.match(billing, /50% deposit[\s\S]*Paid/i);
  assert.match(billing, /Receipt/);
  assert.match(billing, new RegExp(`Paid to date\\s+${usd(amount).replace("$", "\\$")}`, "i"));
  assert.match(billing, /Partially paid/i);
  assert.equal(latestEmail(srv.db, contact.email)?.template, "receipt");

  await p.goto(srv.base + "/portal");
  await nav(p, p.locator("main table a").first());
  projectId = new URL(p.url()).pathname.split("/").pop()!;
  assert.match(projectId, /^prj_/);
  assert.match(await text(p), /Awaiting onboarding/i);

  await rep.page.goto(`${srv.base}/staff/crm/leads/${leadId}`);
  const lead = await text(rep.page);
  assert.match(lead, /Converted/i);
  assert.match(lead, /Payment confirmed by Stripe webhook/);
  assert.match(lead, new RegExp(quoteId, "i"));
  assertClean();
});

// ───────────── 8–9. Onboarding + uploads ─────────────

step("[PORTAL-002] customer completes conditional onboarding: answers reveal follow-up questions, hidden required fields are enforced only when shown, logo uploads", async () => {
  const p = customer.page;
  await p.goto(srv.base + "/portal");
  await nav(p, p.getByRole("link", { name: /Complete onboarding for/ }));
  const visible = (sel: string) => p.locator(sel).isVisible();
  assert.equal(await visible("#f-logo"), false, "logo upload hidden until branding answer");
  await p.check("input[name=has_branding][value=yes]");
  assert.equal(await visible("#f-logo"), true);
  assert.equal(await visible("#f-brand_style"), false);
  await p.check("input[name=has_branding][value=no]");
  assert.equal(await visible("#f-brand_style"), true, "style question when there is no branding");
  await p.check("input[name=has_branding][value=yes]");
  await p.setInputFiles("#f-logo", { name: "harbor-logo.png", mimeType: "image/png", buffer: PNG });
  await p.fill("#f-industry", "Specialty coffee");
  await p.fill("#f-goals", "Online ordering for pickup and a loyalty program.");
  await p.fill("#f-target_audience", "Regulars and office workers near our three cafés.");
  await p.fill("#f-pages", "Home, Menu, Order, Locations, Loyalty, Contact");
  await p.check("input[name=functionality][value=booking]");
  assert.equal(await visible("#f-booking_details"), true);
  await p.check("input[name=content_source][value=crestmont_draft]");
  await p.check("input[name=images_source][value=licensed]");
  assert.equal(await visible("#f-images"), false);
  await p.check("input[name=domain_status][value=need]");
  assert.equal(await visible("#f-domain_wishes"), true);
  assert.equal(await visible("#f-domain_name"), false);
  await p.fill("#f-domain_wishes", "harborcoffee-e2e.example");
  await p.check("input[name=hosting][value=crestmont]");
  // Submit without the now-required booking details → server-side conditional validation.
  await nav(p, btn(p, "Submit onboarding"));
  assert.match(await text(p, ".alert--error"), /Booking details is required/);
  assert.match(await text(p), /Uploaded: harbor-logo\.png/, "logo kept with the draft");
  assert.equal(await p.locator("#f-industry").inputValue(), "Specialty coffee", "valid answers kept");
  await p.fill("#f-booking_details", "Table reservations for tastings, managed in Google Calendar today.");
  await nav(p, btn(p, "Submit onboarding"));
  assert.equal(new URL(p.url()).pathname, `/portal/projects/${projectId}`);
  assert.match(await text(p), /Scope review/i);
  assertClean();
});

step("[PORTAL-004] customer uploads a project file; it is listed with its folder and the image preview renders", async () => {
  const p = customer.page;
  await p.goto(`${srv.base}/portal/projects/${projectId}`);
  await nav(p, p.locator("nav.tabs").getByRole("link", { name: "Files" }));
  await p.setInputFiles("#f-file", { name: "storefront.png", mimeType: "image/png", buffer: PNG });
  await p.fill("#f-folder", "Branding");
  await nav(p, btn(p, "Upload"));
  const page = await text(p);
  assert.match(page, /storefront\.png/);
  assert.match(page, /Branding/);
  assert.match(page, /harbor-logo\.png/, "onboarding logo also stored as a project file");
  await nav(p, p.getByRole("link", { name: "storefront.png" }));
  const img = p.locator("main img").first();
  await img.evaluate((el: HTMLImageElement) => el.decode().catch(() => undefined));
  assert.ok((await img.evaluate((el: HTMLImageElement) => el.naturalWidth)) > 0, "preview image loads under the CSP");
  assertClean();
});

// ───────────── 10–12. PM tasks, developer milestones, customer notifications ─────────────

step("[PM-004] PM takes the project and assigns a task; the developer updates the task and a milestone; the customer sees the progress", async () => {
  pm = await staffActor("project_manager", "E2E Project Manager");
  dev = await staffActor("developer", "E2E Developer");
  const p = pm.page;
  await p.goto(srv.base + "/staff/projects");
  await nav(p, p.locator("main a", { hasText: contact.company }).first());
  assert.equal(new URL(p.url()).pathname, `/staff/projects/${projectId}`);
  assert.match(await text(p), /Specialty coffee/, "PM sees the onboarding answers");
  await p.locator('form[action$="/pm"] select').selectOption(pm.user.id);
  await nav(p, p.locator('form[action$="/pm"]').getByRole("button", { name: "Save" }));
  assert.match(await text(p), new RegExp(`Project manager\\s+${pm.user.name}`, "i"));

  await nav(p, p.locator("nav.tabs").getByRole("link", { name: "Milestones & tasks" }));
  await p.fill("#f-title", "Build the menu and ordering page layout");
  await p.selectOption("#f-milestone_id", { label: "Design" });
  await p.selectOption("#f-assignee_id", dev.user.id);
  await p.fill("#f-estimate_minutes", "240");
  await nav(p, btn(p, "Add task"));
  assert.match(await text(p), new RegExp(`Build the menu and ordering page layout[\\s\\S]*${dev.user.name}`, "i"));

  const d = dev.page;
  await d.goto(srv.base + "/staff/tasks");
  await nav(d, d.getByRole("link", { name: "Build the menu and ordering page layout" }));
  await d.selectOption("#f-status", "done");
  await nav(d, btn(d, "Update status"));
  assert.match(await text(d), /Done/i);
  await nav(d, d.locator("main").getByRole("link", { name: contact.company, exact: false }).first());
  const ms = 'form:has(select[aria-label="Status for Design"])';
  await d.locator(`${ms} select`).selectOption("in_progress");
  await nav(d, d.locator(ms).getByRole("button", { name: "Save" }));
  assert.equal(await d.locator(`${ms} select`).inputValue(), "in_progress");

  const c = customer.page;
  await c.goto(`${srv.base}/portal/projects/${projectId}`);
  const overview = await text(c);
  assert.match(overview, /Design\s+In progress/i);
  assert.match(overview, /Task progress\s+1 \/ 1/i);
  assert.match(overview, new RegExp(`Project manager\\s+${pm.user.name}`, "i"));
  assertClean();
});

step("[PORTAL-007] PM requests scope approval; the customer is notified, approves, and sees the project move into Design", async () => {
  const p = pm.page;
  await p.goto(`${srv.base}/staff/projects/${projectId}?tab=approvals`);
  const ask = 'form[action$="/request-approval"]';
  await p.locator(`${ask} select[name=kind]`).selectOption("scope");
  await p.locator(`${ask} textarea[name=note]`).fill("Please review the scope for your ordering and loyalty site.");
  await nav(p, p.locator(ask).getByRole("button", { name: "Send request" }));
  assert.equal(latestEmail(srv.db, contact.email)?.template, "approval_request");

  const c = customer.page;
  await c.goto(srv.base + "/portal");
  const dash = await text(c);
  assert.match(dash, /New\s+Please review the scope for your ordering and loyalty site\./, "unread notification");
  await nav(c, c.getByRole("link", { name: /Scope approval awaiting your decision/ }));
  await nav(c, c.locator("section", { hasText: "Scope approval" }).getByRole("button", { name: "Approve" }));
  assert.match(await text(c), /Scope approval\s+Approved/i);

  await p.goto(`${srv.base}/staff/projects/${projectId}`);
  await nav(p, btn(p, "Move to Design"));
  await c.goto(srv.base + "/portal");
  assert.match(await text(c), /Status changed from Scope review to Design/i);
  await c.goto(`${srv.base}/portal/projects/${projectId}`);
  assert.match(await text(c, ".kpis"), /Status\s+Design/i);
  assertClean();
});

// ───────────── 13–15. Design review, revisions, allowance, change order ─────────────

step("[PORTAL-006] customer reviews the design, uses the included revision rounds (counter updates), and the next request requires a change order", async () => {
  const p = pm.page, c = customer.page;
  await p.goto(`${srv.base}/staff/projects/${projectId}`);
  await nav(p, btn(p, "Move to Customer review"));
  await p.goto(`${srv.base}/staff/projects/${projectId}?tab=approvals`);
  await p.locator('form[action$="/request-approval"] select[name=kind]').selectOption("design");
  await nav(p, p.locator('form[action$="/request-approval"]').getByRole("button", { name: "Send request" }));

  await c.goto(`${srv.base}/portal/projects/${projectId}/approvals`);
  await nav(c, c.locator("section", { hasText: "Design approval" }).getByRole("button", { name: "Approve" }));
  await c.goto(`${srv.base}/portal/projects/${projectId}/revisions`);
  const allowance = Number((await text(c, ".kpis")).match(/Included rounds\s+(\d+)/i)![1]);
  assert.ok(allowance >= 1);
  for (let round = 1; round <= allowance; round++) {
    assert.match(await text(c, ".kpis"), new RegExp(`Used\\s+${round - 1}\\s[\\s\\S]*Remaining\\s+${allowance - round + 1}`, "i"));
    await c.fill("#f-request", `Round ${round}: enlarge the menu photos and move the order button above the fold.`);
    await nav(c, btn(c, "Submit revision request"));
    assert.match(await text(c, ".toast"), new RegExp(`Revision round ${round} submitted`, "i"));
    if (round === 1) {
      // The team delivers round 1 and the customer approves it.
      await p.goto(`${srv.base}/staff/projects/${projectId}?tab=revisions`);
      await nav(p, btn(p, "Mark delivered"));
      await c.goto(`${srv.base}/portal/projects/${projectId}/approvals`);
      await nav(c, c.locator("section", { hasText: "Revision approval" }).getByRole("button", { name: "Approve" }));
      await c.goto(`${srv.base}/portal/projects/${projectId}/revisions`);
    }
  }
  assert.match(await text(c, ".kpis"), new RegExp(`Used\\s+${allowance}[\\s\\S]*Remaining\\s+0`, "i"));
  assert.match(await text(c), /Further changes need a change order/i);
  await c.fill("#f-request", "Add a gift-card page with online purchase.");
  await nav(c, btn(c, "Request a change-order quote"));
  assert.match(await text(c), /Awaiting change-order quote/i);

  // PM prices it; customer approves; an invoice is created and the pay link opens the invoice honestly.
  await p.goto(`${srv.base}/staff/projects/${projectId}?tab=revisions`);
  const co = p.locator('form[action$="/change-orders"]:has(input[name=revision_id])');
  await co.locator("input[name=price]").fill("450");
  await nav(p, co.getByRole("button", { name: "Propose change order" }));
  await c.goto(`${srv.base}/portal/projects/${projectId}/revisions`);
  assert.match(await text(c), /\$450[\s\S]*Proposed/i);
  await nav(c, btn(c, "Approve change order"));
  assert.match(await text(c, ".toast"), /Change order approved\. An invoice is ready under Billing\./);
  await nav(c, c.getByRole("link", { name: "Pay invoice" }));
  assert.match(new URL(c.url()).pathname, /^\/portal\/billing\/invoices\/inv_/, "pay link opens the invoice");
  assert.match(await text(c), /Online payment is not configured yet\./);
  await stripePaid(new URL(c.url()).pathname.split("/").pop()!, contact.email);
  await c.reload();
  assert.match(await text(c, ".page-head, main"), /Paid/i);
  assertClean();
});

// ───────────── 16–19. Final approval, payments, QA, deployment ─────────────

step("[PM-006] release readiness panel gates deployment: customer launch approval, every milestone payment (signed webhook fixtures), internal QA, then deployment is recorded only when all 7 checks pass", async () => {
  const p = pm.page, c = customer.page;
  const approvalsTab = `${srv.base}/staff/projects/${projectId}?tab=approvals`;
  await p.goto(approvalsTab);
  let panel = await text(p, ".card--gold");
  assert.match(panel, /Blocked: \d+ check\(s\) outstanding/);
  assert.match(await text(p), /Deployment can be recorded once every readiness check passes\./);
  assert.equal(await p.locator('form[action$="/deployments"]').count(), 0);

  // Design milestone invoice (design is approved) → paid by signed webhook fixture.
  await nav(p, btn(p, "Issue 25% design invoice"));
  await c.goto(srv.base + "/portal/billing");
  await nav(c, c.getByRole("link", { name: "25% on approved design" }));
  await stripePaid(new URL(c.url()).pathname.split("/").pop()!, contact.email);

  // Deployment authorization is refused while other checks fail.
  await p.goto(approvalsTab);
  const rec = 'form[action$="/approvals"]';
  await p.locator(`${rec} select[name=kind]`).selectOption("deployment_authorized");
  await nav(p, p.locator(rec).getByRole("button", { name: "Record" }));
  assert.match(await text(p, ".alert--error"), /Deployment cannot be authorized until every other check passes/);

  // Customer approves the final work (final launch approval).
  await p.goto(`${srv.base}/staff/projects/${projectId}`);
  await nav(p, btn(p, "Move to Customer review")); // revisions → customer review
  await p.goto(approvalsTab);
  await p.locator('form[action$="/request-approval"] select[name=kind]').selectOption("customer_launch");
  await nav(p, p.locator('form[action$="/request-approval"]').getByRole("button", { name: "Send request" }));
  await c.goto(`${srv.base}/portal/projects/${projectId}/approvals`);
  await nav(c, c.locator("section", { hasText: "Final launch approval" }).getByRole("button", { name: "Approve" }));

  // Pre-launch invoice → paid; every required payment is now verified.
  await p.goto(approvalsTab);
  await nav(p, btn(p, "Issue 25% pre-launch invoice"));
  await c.goto(srv.base + "/portal/billing");
  await nav(c, c.getByRole("link", { name: "25% before launch" }));
  await stripePaid(new URL(c.url()).pathname.split("/").pop()!, contact.email);
  await p.goto(approvalsTab);
  assert.match(await text(p, ".card--gold"), /6\. Required payment verification\s+Pass\s+All required invoices paid/);

  // Internal QA chain.
  for (const kind of ["engineering_complete", "internal_qa", "security_accessibility", "deployment_authorized"]) {
    await p.locator(`${rec} select[name=kind]`).selectOption(kind);
    await p.locator(`${rec} textarea[name=notes]`).fill(`E2E: ${kind} checked in development.`);
    await nav(p, p.locator(rec).getByRole("button", { name: "Record" }));
    assert.match(await text(p, ".toast"), /Approval recorded/);
  }
  panel = await text(p, ".card--gold");
  for (const n of [1, 2, 3, 4, 5, 6, 7]) assert.match(panel, new RegExp(`${n}\\. [^\\n]+\\s+Pass`, "i"), `check ${n} passes`);
  assert.match(panel, /Ready to deploy/);

  await p.goto(`${srv.base}/staff/projects/${projectId}`);
  await nav(p, btn(p, "Move to Final approval"));
  await p.goto(approvalsTab);
  await p.fill('form[action$="/deployments"] input[name=url]', "https://harbor-coffee-e2e.example");
  await nav(p, btn(p, "Record deployment"));
  const tab = await text(p);
  assert.match(tab, /https:\/\/harbor-coffee-e2e\.example/);
  assert.match(await text(p, ".page-head, main"), /Deployment/i);
  assertClean();
});

// ───────────── 20. Handoff ─────────────

step("[PORTAL-010] PM publishes the handoff; the customer reviews it and records final acceptance, completing the project", async () => {
  const p = pm.page, c = customer.page;
  // Closure checklist (PM-007): every task must be done before the project can complete. The developer
  // finishes the remaining work (e.g. the task created by the paid change order) through the task page.
  const open = srv.db.prepare(`SELECT id FROM tasks WHERE project_id = ? AND status <> 'done'`).all(projectId) as { id: string }[];
  for (const t of open) {
    const tp = srv.db.prepare(`SELECT COUNT(*) AS n FROM assignments WHERE subject_type = 'task' AND subject_id = ? AND user_id = ? AND ended_at IS NULL`).get(t.id, dev.user.id) as { n: number };
    const actorPage = tp.n ? dev.page : p;
    await actorPage.goto(`${srv.base}/staff/tasks/${t.id}`);
    await actorPage.selectOption("#f-status", "done");
    await nav(actorPage, btn(actorPage, "Update status"));
    assert.match(await text(actorPage), /Done/i);
  }
  // …and the PM delivers every outstanding revision request (closure check "Revision requests delivered").
  const revs = srv.db.prepare(`SELECT id FROM revisions WHERE project_id = ? AND status IN ('submitted','in_progress')`).all(projectId) as { id: string }[];
  for (const r of revs) {
    await p.goto(`${srv.base}/staff/projects/${projectId}?tab=revisions`);
    const f = p.locator(`form[action="/staff/revisions/${r.id}/status"]`);
    await f.locator(`#rn-${r.id}`).fill("Delivered in the final build.");
    await nav(p, f.getByRole("button", { name: "Mark delivered" }));
  }
  assert.equal((srv.db.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE project_id = ? AND status IN ('submitted','in_progress')`).get(projectId) as { n: number }).n, 0);
  await p.goto(`${srv.base}/staff/projects/${projectId}?tab=handoff`);
  assert.equal(await p.locator("#f-website_url").inputValue(), "https://harbor-coffee-e2e.example");
  await p.fill("#f-documentation", "Editing guide for menu items, prices and loyalty rewards.");
  await p.fill("#f-access_instructions", "Admin invitations are sent to your email; set your own password.");
  await p.fill("#f-ownership_notes", "Domain registered in Harbor Coffee's name; code repository transferred after final payment.");
  await p.fill("#f-training_notes", "45-minute recorded walkthrough of ordering and loyalty admin.");
  await nav(p, btn(p, "Publish to customer"));
  assert.match(await text(p), /Published/i);

  await c.goto(srv.base + "/portal");
  await nav(c, c.getByRole("link", { name: /Review your handoff and record final acceptance/ }));
  const h = await text(c);
  assert.match(h, /Editing guide for menu items/);
  assert.match(h, /45-minute recorded walkthrough/);
  await nav(c, btn(c, "Accept the website"));
  assert.match(await text(c), /Final acceptance recorded/);
  await c.goto(`${srv.base}/portal/projects/${projectId}`);
  assert.match(await text(c, ".kpis"), /Status\s+Completed/i);
  assertClean();
});

// ───────────── 21–23. Support ─────────────

step("[SUP-001] customer submits a support ticket about the project from the portal", async () => {
  const c = customer.page;
  await c.goto(srv.base + "/portal/support");
  await nav(c, c.getByRole("link", { name: "New ticket" }).first());
  await c.fill("#f-subject", "Order confirmation emails not arriving");
  await c.selectOption("#f-category", "technical");
  await c.selectOption("#f-project_id", projectId);
  await c.fill("#f-description", "Customers who order for pickup say they do not receive a confirmation email.");
  await c.setInputFiles("#f-attachments", { name: "screenshot.png", mimeType: "image/png", buffer: PNG });
  await nav(c, btn(c, "Submit ticket"));
  ticketUrl = c.url();
  assert.match(new URL(ticketUrl).pathname, /^\/portal\/support\/tkt_/);
  const t = await text(c);
  assert.match(t, /Order confirmation emails not arriving/);
  assert.match(t, /screenshot\.png/);
  assertClean();
});

step("[SUP-002] support replies (internal note hidden from the customer) and resolves; the customer sees the reply and can reopen", async () => {
  supportAgent = await staffActor("support", "E2E Support Agent");
  const s = supportAgent.page, c = customer.page;
  await s.goto(srv.base + "/staff/support");
  await nav(s, s.getByRole("link", { name: "Order confirmation emails not arriving" }));
  await s.fill('form[action$="/note"] textarea[name=body]', "INTERNAL: mail provider not configured in this environment.");
  await nav(s, btn(s, "Add internal note"));
  await s.fill('form[action$="/reply"] textarea[name=body]', "Thanks — we found the cause and fixed the sender settings. Please try an order.");
  await nav(s, btn(s, "Send reply"));
  await s.selectOption('form[action$="/status"] select[name=status]', "resolved");
  await nav(s, btn(s, "Update status"));
  assert.match(await text(s, "main aside"), /Status\s+Resolved/i);

  await c.goto(ticketUrl);
  const t = await text(c);
  assert.match(t, /we found the cause and fixed the sender settings/);
  assert.doesNotMatch(t, /INTERNAL: mail provider/, "internal note never shown to the customer");
  assert.match(t, /Status\s+Resolved/i);
  await nav(c, btn(c, "Reopen ticket"));
  assert.match(await text(c, "main aside"), /Status\s+Open/i);
  assertClean();
});

// ───────────── 26. Refund approval workflow ─────────────

step("[PAY-007] refund request from billing enters the approval workflow: support recommends, the Owner decides, and issuing honestly fails because payments are not configured", async () => {
  const c = customer.page;
  await c.goto(srv.base + "/portal/billing");
  await c.locator("summary", { hasText: "Request a refund" }).click();
  const value = await c.locator("#f-payment_id option", { hasText: "Change order" }).getAttribute("value");
  await c.selectOption("#f-payment_id", value);
  await c.fill("#f-amount", "50");
  await c.fill("#f-reason", "The gift-card page was delivered without the purchase option we were quoted.");
  await nav(c, btn(c, "Submit request"));
  assert.match(await text(c), /Refund requests[\s\S]*\$50[\s\S]*Requested/i);

  const s = supportAgent.page;
  await s.goto(srv.base + "/staff/refunds");
  await nav(s, s.locator("main table a").first());
  const refundUrl = s.url();
  await s.fill("#f-notes", "Checked the delivered change order against the agreed scope.");
  await nav(s, btn(s, "Start review"));
  await s.fill("#f-notes", "Purchase option missing at delivery; recommend a partial refund of $50.");
  await nav(s, btn(s, "Recommend refund"));
  assert.match(await text(s), /Awaiting the Founder's decision\./);

  const o = owner.page;
  await o.goto(srv.base + "/staff/owner");
  assert.match(await text(o, '[data-metric="Pending approvals"]'), /1 refunds awaiting review\/decision/);
  await o.goto(refundUrl);
  await freshMfa(o, owner.user);
  assert.match(await text(o, ".page-head, main"), /Recommended/i);
  await o.fill("#f-notes", "Approved as a goodwill partial refund (E2E test data).");
  await nav(o, btn(o, "Approve refund"));
  assert.match(await text(o), /Online payment is not configured yet\. The refund cannot be issued through Stripe until payments are connected\./);
  await nav(o, o.getByRole("button", { name: /Issue \$50 refund via Stripe/ }));
  assert.match(await text(o, ".alert--error"), /Online payment is not configured yet\. The refund stays approved and can be issued once Stripe is connected; nothing was sent\./);
  assert.match(await text(o, ".page-head, main"), /Approved/i);
  assertClean();
});

// ───────────── 27–28. AI receptionist ─────────────

test("[VOICE-003] signed voice webhook fixture (no voice provider; development secret): a call that creates a lead appears in the CRM with source AI receptionist", async () => {
  const sec = "e2e-voice-secret", hdr = "x-crestmont-voice-signature", callId = `call-e2e-${RUN}`;
  const send = (ev: Record<string, unknown>) => signedPost("/api/webhooks/voice", hdr, sec, { provider: "e2e-fixture", call_id: callId, test: true, ...ev });
  assert.equal((await send({ event: "call_started", from_number: "+1 555 0142" })).status, 200);
  const lead = await send({ event: "function_call", event_id: `${callId}-lead`, function: { name: "create_lead", arguments: { name: `Riley Caller ${RUN}`, phone: "+1 555 0142", email: `riley.${RUN}@dental.example`, interest: "business", requirements: "Ten-page site with booking for a dental office." } } });
  assert.equal(lead.status, 200, JSON.stringify(lead.json));
  assert.equal((await send({ event: "call_ended", outcome: "lead_captured" })).status, 200);
  // A forged signature is refused.
  const forged = await fetch(srv.base + "/api/webhooks/voice", { method: "POST", body: "{}", headers: { [hdr]: `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` } });
  assert.equal(forged.status, 401);

  const o = owner.page;
  await o.goto(srv.base + "/staff/crm?view=list");
  await o.selectOption("#f-source", "ai_receptionist");
  await nav(o, btn(o, "Filter"));
  await nav(o, o.getByRole("link", { name: `Riley Caller ${RUN}` }));
  const d = await text(o);
  assert.match(d, /Source\s+Ai receptionist/i);
  assert.match(d, /Ten-page site with booking for a dental office/);
  assertClean();
});

// ───────────── 29–31. Launch readiness ─────────────

const COMMIT_A = "abcdef1234567", COMMIT_B = "1234567abcdef";
test("[READY-004] signed CI evidence fixture is ingested and shown in the readiness command center", async () => {
  const runId = `e2e-ci-${RUN}`;
  const now = new Date().toISOString();
  const res = await signedPost("/api/readiness/evidence", "x-crestmont-signature", "e2e-ingest-secret", {
    runId, source: "ci", environment: "development", commitSha: COMMIT_A, branch: "main", startedAt: now, finishedAt: now,
    results: [{ requirementId: "CRM-001", testName: "e2e fixture: quote form lead", outcome: "passed" }, { requirementId: "SALES-004", testName: "e2e fixture: acceptance", outcome: "passed" },
      { requirementId: "READY-004", testName: "e2e fixture: deliberately failing row", outcome: "failed", message: "fixture failure" }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.status, "ingested");
  assert.equal((await signedPost("/api/readiness/evidence", "x-crestmont-signature", "wrong-secret", { runId })).status, 401);

  const o = owner.page;
  await o.goto(srv.base + "/staff/readiness/engineering");
  assert.match(await text(o), new RegExp(runId, "i"));
  await nav(o, o.getByRole("link", { name: runId }));
  const run = await text(o);
  assert.match(run, /2 passed\/skipped, 1 failed/);
  assert.match(run, /e2e fixture: deliberately failing row/);
  await o.goto(srv.base + "/staff/readiness");
  assert.match(await text(o, "#feeds-h + *, section[aria-labelledby=feeds-h]"), /ci[\s\S]*Healthy/i);
  assertClean();
});

test("[READY-008] Owner creates a release candidate and records the Founder decision bound to it; a newer candidate invalidates the approval", async () => {
  const o = owner.page;
  const candidate = async (commit: string, cfg: string) => {
    await o.goto(srv.base + "/staff/readiness/releases");
    await o.fill("#f-commit_sha", commit);
    await o.fill("#f-config_sha256", cfg);
    await o.fill("#f-notes", `E2E release candidate ${commit} (development test data).`);
    await o.fill("#f-rollback_plan", "Redeploy the previous Worker version and restore the last D1 backup.");
    await nav(o, btn(o, "Create release candidate"));
    assert.match(await text(o, ".toast"), /Release candidate rel_\w+ created/);
  };
  await candidate(COMMIT_A, "a".repeat(64));
  await nav(o, o.getByRole("link", { name: "Founder approval panel" }));
  await freshMfa(o, owner.user);
  assert.match(await text(o), new RegExp(COMMIT_A));
  await o.selectOption("#f-decision", "approved");
  await o.fill("#f-confirm_commit", COMMIT_A);
  await o.fill("#f-notes", "E2E: development-environment approval (test data).");
  await nav(o, btn(o, "Record Founder decision"));
  assert.match(await text(o, ".toast"), /Founder decision recorded/);
  assert.match(await text(o), /Validity\s+Valid/i);

  await candidate(COMMIT_B, "b".repeat(64));
  const timeline = await text(o);
  assert.match(timeline, /invalidated/i);
  assert.equal(await o.locator('li[data-kind="invalidation"]').count(), 1);
  await o.goto(srv.base + "/staff/readiness/approve");
  const panel = await text(o);
  assert.match(panel, /Not valid/i);
  assert.match(panel, new RegExp(`Superseded by release candidate rel_\\w+ \\(${COMMIT_B.slice(0, 12)}`, "i"));
  assertClean();
});

// ───────────── Owner overview from the journey's real data ─────────────

step("[OWN-002] executive overview reflects the journey's records: revenue equals the sum of payments confirmed by webhook and links to the finance detail", async () => {
  const o = owner.page;
  await o.goto(srv.base + "/staff/owner");
  const revenue = paidCents.reduce((a, b) => a + b, 0);
  assert.match(await text(o, '[data-metric="Revenue (all time)"]'), new RegExp(`${usd(revenue).replace("$", "\\$")}[\\s\\S]*Sum of ${paidCents.length} succeeded payments`, "i"));
  assert.match(await text(o, '[data-metric="Active projects"]'), /\d/);
  await nav(o, o.locator('[data-metric="Revenue (all time)"]'));
  assert.equal(new URL(o.url()).pathname, "/staff/finance");
  assertClean();
});

// ───────────── Responsive + accessibility sweep ─────────────

step("[TEST-003] phone-width sweep (375px) of public, portal and staff pages: no horizontal scroll, one h1, labelled fields, unique ids, images with alt", async () => {
  const pages: { who: Actor | null; paths: string[] }[] = [
    { who: null, paths: ["/", "/services", "/pricing", "/pricing/compare", "/portfolio", "/about", "/process", "/faq", "/hosting-maintenance", "/quote", "/contact", "/legal/privacy", proposalUrl.replace(srv.base, "")] },
    { who: customer, paths: ["/portal", "/portal/projects", `/portal/projects/${projectId}`, `/portal/projects/${projectId}/revisions`, `/portal/projects/${projectId}/approvals`, `/portal/projects/${projectId}/handoff`, `/portal/projects/${projectId}/files`, "/portal/billing", "/portal/support", new URL(ticketUrl).pathname, "/portal/support/new"] },
    { who: owner, paths: ["/staff", "/staff/crm", "/staff/crm?view=list", `/staff/crm/leads/${leadId}`, `/staff/quotes/${quoteId}`, `/staff/projects/${projectId}`, `/staff/projects/${projectId}?tab=plan`, `/staff/projects/${projectId}?tab=approvals`, `/staff/projects/${projectId}?tab=revisions`, `/staff/projects/${projectId}?tab=handoff`, "/staff/support", "/staff/refunds", "/staff/owner", "/staff/readiness", "/staff/readiness/releases", "/staff/readiness/approve", "/staff/finance"] },
  ];
  const problems: string[] = [];
  for (const group of pages) {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, ...(group.who ? { storageState: await group.who.ctx.storageState() } : {}) });
    const page = await ctx.newPage();
    watch(page);
    for (const path of group.paths) {
      const res = await page.goto(srv.base + path);
      if (res.status() !== 200) { problems.push(`${path}: HTTP ${res.status()}`); continue; }
      const r = await page.evaluate(() => {
        const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
        return {
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          h1: document.querySelectorAll("h1").length,
          unlabeled: [...document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea")]
            .filter((el) => !(el.id && document.querySelector(`label[for="${el.id}"]`)) && !el.closest("label") && !el.getAttribute("aria-label")).map((el) => (el as HTMLInputElement).name),
          dupIds: [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))],
          imgsNoAlt: [...document.querySelectorAll("img")].filter((i) => !i.hasAttribute("alt")).length,
        };
      });
      if (r.overflow > 0) problems.push(`${path}: horizontal scroll ${r.overflow}px`);
      if (r.h1 !== 1) problems.push(`${path}: ${r.h1} h1 elements`);
      if (r.unlabeled.length) problems.push(`${path}: unlabelled fields ${r.unlabeled.join(", ")}`);
      if (r.dupIds.length) problems.push(`${path}: duplicate ids ${r.dupIds.join(", ")}`);
      if (r.imgsNoAlt) problems.push(`${path}: ${r.imgsNoAlt} images without alt`);
    }
    await ctx.close();
  }
  assert.deepEqual(problems, []);
  assertClean();
});

// ───────────── Visual sanity: inline-width meters under the CSP ─────────────

step("[BRAND-004] meters and bar charts sized with inline style widths actually render (style-src-attr is allowed by the CSP)", async () => {
  const checks: [Actor, string, string][] = [
    [customer, `/portal/projects/${projectId}`, ".meter > span"],
    [owner, "/staff/readiness", ".meter > span"],
    [owner, "/staff/finance", ".bar-chart__bar > span"],
  ];
  for (const [who, path, sel] of checks) {
    await who.page.goto(srv.base + path);
    const bars = await who.page.locator(sel).evaluateAll((els: HTMLElement[]) => els.map((e) => ({ declared: parseFloat(e.style.width), rendered: e.getBoundingClientRect().width })));
    const nonZero = bars.filter((b: { declared: number }) => b.declared > 0);
    assert.ok(nonZero.length > 0, `${path}: at least one ${sel} with a non-zero declared width (${JSON.stringify(bars)})`);
    for (const b of nonZero) assert.ok(b.rendered > 0, `${path}: ${sel} declared ${b.declared}% renders ${b.rendered}px`);
  }
  assertClean();
});
