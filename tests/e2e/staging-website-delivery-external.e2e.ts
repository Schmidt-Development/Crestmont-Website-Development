// Website Delivery tab, in a browser, against deployed staging: an externally hosted website handed to an existing
// customer project and opened by that customer.
//
// What this proves that the in-process tests cannot: the deployed Worker has the tab and its routes, migration 0097
// is applied to staging D1, two real customer sign-ins see what they should and nothing else, and the customer's
// View Website button opens the exact intended address in a new tab.
//
// FIXTURES. It creates no customer and no project. It signs in as each demo CUSTOMER, reads the projects that
// customer already has, and delivers to one of those; a second customer account is used for the isolation checks.
// The website is https://example.com/ (IANA's reserved example domain: a safe, controlled public HTTPS page) with a
// per-run query string, so the exact-URL checks cannot be satisfied by an earlier run's data.
//
// It writes two versions per run on one existing project, superseding (never deleting) what was there.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./support.ts";
import { totpCode } from "../../src/lib/auth-crypto.ts";

type Page = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Playwright is loaded at runtime

const BASE = process.env.E2E_BASE_URL?.replace(/\/$/, "");
const ACCOUNTS = process.env.E2E_ACCOUNTS_FILE;
const unset = !BASE || !ACCOUNTS ? "E2E_BASE_URL / E2E_ACCOUNTS_FILE not set" : false;
const RUN = `wdx${Date.now().toString(36)}`;
const V1 = `https://example.com/?crestmont-e2e=${RUN}-v1`;
const V2 = `https://example.com/?crestmont-e2e=${RUN}-v2`;
const NAME = `E2E hosted website ${RUN}`;
const INTERNAL = `internal-note-${RUN}`;

interface Account { role: string; email: string; password: string; totp?: string }

function accounts(): Account[] {
  const md = readFileSync(ACCOUNTS!, "utf8");
  return [...md.matchAll(/^\| (\w+) \| (\S+) \| `([^`]+)` \| (?:`([A-Z2-7]+)`|—) \|/gm)]
    .map((m) => ({ role: m[1], email: m[2], password: m[3], totp: m[4] }));
}

let browser: Awaited<ReturnType<typeof launchBrowser>>;
before(async () => { if (!unset) browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

// LOCAL DRY RUNS ONLY: a sandbox without internet access can set E2E_LOCAL_STUB_EXAMPLE_COM=1 to answer example.com
// from a stub, so the rest of the flow can be exercised. The staging workflow never sets it, and a run that does is
// not evidence that the external website opened.
const STUB = process.env.E2E_LOCAL_STUB_EXAMPLE_COM === "1";

async function signIn(a: Account): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (STUB) await ctx.route("https://example.com/**", (r: { fulfill: (o: object) => Promise<void> }) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>Example Domain (local stub)</title><h1>stub</h1>" }));
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
  assert.doesNotMatch(new URL(page.url()).pathname, /^\/(login|mfa)/, `signed in as ${a.role} (${a.email})`);
  return page;
}

async function portalProjects(p: Page): Promise<{ id: string; name: string }[]> {
  await p.goto(`${BASE}/portal/projects`, { waitUntil: "domcontentloaded" });
  const hrefs = await p.locator('a[href^="/portal/projects/prj_"]').evaluateAll(
    (els: Element[]) => els.map((e) => ({ href: e.getAttribute("href") ?? "", name: (e.textContent ?? "").trim() })),
  );
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const h of hrefs) {
    const id = /\/portal\/projects\/(prj_[0-9a-f]+)/.exec(h.href)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: h.name });
  }
  return out;
}

const owner = () => accounts().find((a) => a.role === "owner")!;
let customerA: Account | null = null;
let customerB: Account | null = null;
let projectA: { id: string; name: string } | null = null;
let deliveryId: string | null = null;
let shared = false;

test("[WDX-E01] two existing staging customer accounts and an existing project", { skip: unset }, async () => {
  const customers = accounts().filter((a) => /customer/i.test(a.role));
  assert.ok(customers.length >= 2, `two customer accounts are needed; the access artifact has: ${accounts().map((a) => a.role).join(", ")}`);
  for (const c of customers) {
    const page = await signIn(c);
    const projects = await portalProjects(page);
    await page.context().close();
    if (projects.length && !projectA) { customerA = c; projectA = projects[0]; continue; }
    if (!customerA || c.email !== customerA.email) customerB ??= c;
  }
  assert.ok(customerA && projectA, "no demo customer has an existing project");
  assert.ok(customerB, "a second customer account is needed for the isolation checks");
  console.log(`  customer A ${customerA!.email} → project ${projectA!.id} (${projectA!.name}); customer B ${customerB!.email}; run ${RUN}`);
});

test("[WDX-E02] Website Delivery is a Staff Dashboard tab that staff can open", { skip: unset }, async () => {
  const page = await signIn(owner());
  await page.goto(`${BASE}/staff`, { waitUntil: "domcontentloaded" });
  const tab = page.locator('nav a[href="/staff/website-delivery"]');
  assert.equal(await tab.count(), 1, "the staff navigation has the Website Delivery tab");
  assert.match(await tab.innerText(), /Website Delivery/);
  await Promise.all([page.waitForNavigation(), tab.click()]);
  assert.equal(new URL(page.url()).pathname, "/staff/website-delivery");
  assert.equal((await page.locator("main h1").innerText()).trim(), "Website Delivery");
  await Promise.all([page.waitForNavigation(), page.locator('a:has-text("+ Add Website")').first().click()]);
  assert.equal(new URL(page.url()).pathname, "/staff/website-delivery/new");
  await page.context().close();
});

test("[WDX-E03] staff add the hosted website to the existing project as a draft, then share it", { skip: unset }, async (t) => {
  if (!projectA || !customerA) return t.skip("no customer project was established by [WDX-E01]");
  const page = await signIn(owner());

  // The customer's name, as staff would know it, read from the project itself.
  await page.goto(`${BASE}/staff/website-delivery/new?project=${projectA.id}`, { waitUntil: "domcontentloaded" });
  const orgName = (await page.locator("main section.card strong").first().innerText()).trim();
  assert.ok(orgName, "the project's customer is shown");

  // Then the real workflow: search the existing customer, select them, choose the existing project.
  await page.goto(`${BASE}/staff/website-delivery/new`, { waitUntil: "domcontentloaded" });
  await page.fill("#f-q", orgName.slice(0, 40));
  await Promise.all([page.waitForNavigation(), page.locator('form[role=search] button[type=submit]').click()]);
  const row = page.locator("main table tbody tr", { hasText: orgName }).first();
  assert.ok(await row.count(), `the search offers ${orgName}`);
  await Promise.all([page.waitForNavigation(), row.locator('a:has-text("Select")').click()]);
  assert.ok(await page.locator(`select[name=projectId] option[value="${projectA.id}"]`).count(), "the customer's existing project is offered");
  await page.selectOption("select[name=projectId]", projectA.id);
  await page.fill("#f-websiteName", NAME);
  await page.fill("#f-websiteUrl", V1);
  await page.fill("#f-note", INTERNAL);
  await Promise.all([page.waitForNavigation(), page.locator('button[name=intent][value=draft]').click()]);

  const path = new URL(page.url()).pathname;
  deliveryId = /^\/staff\/website-delivery\/(wdl_[0-9a-f]+)$/.exec(path)?.[1] ?? null;
  assert.ok(deliveryId, `saved, and taken to the delivery's page (${path}): ${(await page.locator("main").innerText()).slice(0, 400)}`);
  let text = await page.locator("main").innerText();
  assert.match(text, /Draft/);
  assert.match(text, new RegExp(RUN));

  // The draft is not visible to the customer.
  const cust = await signIn(customerA);
  await cust.goto(`${BASE}/portal/projects/${projectA.id}`, { waitUntil: "domcontentloaded" });
  assert.equal(await cust.locator(`a[href="${V1}"]`).count(), 0, "a draft is not shown to the customer");
  await cust.context().close();

  // Share it.
  await Promise.all([page.waitForNavigation(), page.locator('form[action$="/share"] button').first().click()]);
  text = await page.locator("main").innerText();
  assert.match(text, /Visible to customer/, `shared: ${text.slice(0, 400)}`);
  shared = true;
  console.log(`  delivery ${deliveryId} (version 1) shared: ${V1}`);
  await page.context().close();
});

test("[WDX-E04] the correct customer sees the website and View Website opens the exact URL", { skip: unset }, async (t) => {
  if (!shared || !customerA || !projectA) return t.skip("nothing was shared — see [WDX-E03]");
  const page = await signIn(customerA);
  await page.goto(`${BASE}/portal/projects/${projectA.id}`, { waitUntil: "domcontentloaded" });
  const section = page.locator("[data-your-website]");
  assert.equal(await section.count(), 1, "the Your website section is on the customer's existing project page");
  const text = await section.innerText();
  assert.match(text, new RegExp(NAME));
  assert.match(text, /Version 1/);
  assert.doesNotMatch(await page.locator("body").innerText(), new RegExp(INTERNAL), "staff-only notes are not shown");
  assert.equal(await page.locator("iframe").count(), 0, "the website is not framed");

  const link = page.locator("[data-website-link]");
  assert.equal(await link.getAttribute("href"), V1, "the link is the exact stored address");
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.match((await link.getAttribute("rel")) ?? "", /noopener/);
  const [popup] = await Promise.all([page.context().waitForEvent("page"), link.click()]);
  await popup.waitForLoadState("domcontentloaded");
  assert.equal(popup.url(), V1, "View Website opened exactly the intended URL in a new tab");
  assert.match(await popup.title(), /Example Domain/, "and the website loaded");
  await page.context().close();
});

test("[WDX-E05] the customer requests changes and staff see the feedback", { skip: unset }, async (t) => {
  if (!shared || !customerA || !projectA || !deliveryId) return t.skip("nothing was shared — see [WDX-E03]");
  const feedback = `Please change the headline (${RUN})`;
  const page = await signIn(customerA);
  await page.goto(`${BASE}/portal/projects/${projectA.id}`, { waitUntil: "domcontentloaded" });
  await page.fill("#f-website-note", feedback);
  await Promise.all([page.waitForNavigation(), page.locator('button:has-text("Request Changes")').click()]);
  assert.match(await page.locator("[data-your-website]").innerText(), /You asked for changes to version 1/);
  await page.context().close();

  const staff = await signIn(owner());
  await staff.goto(`${BASE}/staff/website-delivery/${deliveryId}`, { waitUntil: "domcontentloaded" });
  const text = await staff.locator("main").innerText();
  assert.match(text, /The customer asked for changes/);
  assert.match(text, new RegExp(feedback.replace(/[()]/g, "\\$&")));
  await staff.goto(`${BASE}/staff/website-delivery?approval=revision_requested&q=${encodeURIComponent(NAME)}`, { waitUntil: "domcontentloaded" });
  assert.match(await staff.locator("main").innerText(), /Changes requested/);
  await staff.context().close();
});

test("[WDX-E06] staff share a revised version 2; the customer approves it; staff see the approval and the history", { skip: unset }, async (t) => {
  if (!shared || !customerA || !projectA || !deliveryId) return t.skip("nothing was shared — see [WDX-E03]");
  const staff = await signIn(owner());
  await staff.goto(`${BASE}/staff/website-delivery/${deliveryId}`, { waitUntil: "domcontentloaded" });
  await staff.fill("#replace input[name=websiteUrl]", V2);
  await Promise.all([staff.waitForNavigation(), staff.locator('#replace button[name=intent][value=share]').click()]);
  const v2Id = /\/staff\/website-delivery\/(wdl_[0-9a-f]+)$/.exec(new URL(staff.url()).pathname)?.[1];
  assert.ok(v2Id && v2Id !== deliveryId, "a new version was created rather than the old one edited");

  const cust = await signIn(customerA);
  await cust.goto(`${BASE}/portal/projects/${projectA.id}`, { waitUntil: "domcontentloaded" });
  assert.equal(await cust.locator("[data-website-link]").getAttribute("href"), V2, "the customer now sees version 2");
  assert.match(await cust.locator("[data-your-website]").innerText(), /Version 2/);
  await Promise.all([cust.waitForNavigation(), cust.locator('button:has-text("Approve Website")').click()]);
  assert.match(await cust.locator("[data-your-website]").innerText(), /You approved version 2/);
  await cust.context().close();

  await staff.goto(`${BASE}/staff/website-delivery/${v2Id}`, { waitUntil: "domcontentloaded" });
  const text = await staff.locator("main").innerText();
  assert.match(text, /The customer approved version 2/);
  const history = await staff.locator("main table").last().innerText();
  assert.match(history, /v2/);
  assert.match(history, /v1/);
  assert.match(history, /Changes requested/, "version 1 keeps its own decision in the history");
  assert.match(history, new RegExp(`${RUN}-v1`));
  await staff.context().close();
});

test("[WDX-E07] a second customer can neither see nor change the delivery; customers cannot reach staff endpoints", { skip: unset }, async (t) => {
  if (!customerB || !projectA || !deliveryId) return t.skip("no delivery or second customer was established");
  const page = await signIn(customerB);
  const theirs = await portalProjects(page);
  assert.ok(!theirs.some((x) => x.id === projectA!.id), "customer B's portal does not list A's project");
  for (const p of ["/portal", "/portal/projects", ...theirs.map((x) => `/portal/projects/${x.id}`)]) {
    await page.goto(BASE + p, { waitUntil: "domcontentloaded" });
    assert.doesNotMatch(await page.content(), new RegExp(RUN), `${p} shows nothing of A's website`);
  }
  const res = await page.goto(`${BASE}/portal/projects/${projectA.id}`, { waitUntil: "domcontentloaded" });
  assert.ok(res && [403, 404].includes(res.status()), `direct access to A's project is refused, got ${res?.status()}`);

  // A forged decision on A's project, with B's own valid session and CSRF token, is refused.
  await page.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
  const token = await page.locator("input[name=_csrf]").first().getAttribute("value");
  assert.ok(token, "customer B has a CSRF token to try with");
  const status = await page.evaluate(async ({ url, token }: { url: string; token: string }) => {
    const r = await fetch(url, { method: "POST", body: new URLSearchParams({ _csrf: token, decision: "approved" }), redirect: "manual" });
    return r.status;
  }, { url: `${BASE}/portal/projects/${projectA.id}/website/decision`, token });
  assert.ok([403, 404].includes(status), `B's decision on A's project is refused, got ${status}`);

  // Management endpoints are staff-only.
  for (const p of ["/staff/website-delivery", `/staff/website-delivery/${deliveryId}`]) {
    const r = await page.goto(BASE + p, { waitUntil: "domcontentloaded" });
    assert.equal(r?.status(), 403, `${p} is refused to a customer`);
  }
  const replace = await page.evaluate(async ({ url, token }: { url: string; token: string }) => {
    const r = await fetch(url, { method: "POST", body: new URLSearchParams({ _csrf: token, websiteUrl: "https://evil.example.org", intent: "share" }), redirect: "manual" });
    return r.status;
  }, { url: `${BASE}/staff/website-delivery/${deliveryId}/replace`, token });
  assert.equal(replace, 403, "a customer cannot replace a stored URL");
  await page.context().close();

  // Anonymous visitors are sent to sign in.
  const anonCtx = await browser.newContext();
  const anon = await anonCtx.newPage();
  await anon.goto(`${BASE}/staff/website-delivery`, { waitUntil: "domcontentloaded" });
  assert.match(new URL(anon.url()).pathname, /^\/login/);
  await anonCtx.close();
});
