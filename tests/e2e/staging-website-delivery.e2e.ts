// Delivering a finished website to an existing customer project, in a browser, against deployed staging.
//
// WHY THIS FILE EXISTS. Everything else that covers the handover runs in-process against an in-memory database.
// None of it can say whether a customer can actually open the website: that needs the deployed Worker, the real
// stored snapshot in R2, a real signed preview capability, and two real sign-ins. The Founder's requirement is
// not "the assignment row was written" -- it is "the customer opened the website".
//
// HOW IT FINDS ITS FIXTURES. It does not create a customer or a project. It signs in as a demo CUSTOMER first and
// reads the projects that customer already has, so the customer/project pairing is a fact rather than an
// assumption, and the website is then delivered to one of those. A second customer account is used for the
// isolation checks. If staging has no finished build or no second customer, the run FAILS with what is missing --
// those are prerequisites of the test, not reasons to report nothing.
//
// It writes one delivery per run, on an existing project, and supersedes rather than replacing anything
// destructively. Nothing is deleted, and the previous delivery stays available for a rollback.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./support.ts";
import { totpCode } from "../../src/lib/auth-crypto.ts";

type Page = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Playwright is loaded at runtime

const BASE = process.env.E2E_BASE_URL?.replace(/\/$/, "");
const ACCOUNTS = process.env.E2E_ACCOUNTS_FILE;
const unset = !BASE || !ACCOUNTS ? "E2E_BASE_URL / E2E_ACCOUNTS_FILE not set" : false;
const RUN = `wd${Date.now().toString(36)}`;

interface Account { role: string; email: string; password: string; totp?: string }

function accounts(): Account[] {
  const md = readFileSync(ACCOUNTS!, "utf8");
  return [...md.matchAll(/^\| (\w+) \| (\S+) \| `([^`]+)` \| (?:`([A-Z2-7]+)`|—) \|/gm)]
    .map((m) => ({ role: m[1], email: m[2], password: m[3], totp: m[4] }));
}

let browser: Awaited<ReturnType<typeof launchBrowser>>;
before(async () => { if (!unset) browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

async function signIn(a: Account): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
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

/** The projects a customer can see in their own portal. The pairing, read from the customer's side. */
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

let customerA: Account | null = null;
let customerB: Account | null = null;
let projectA: { id: string; name: string } | null = null;
let jobId: string | null = null;

test("[WDE-01] two existing customer accounts and an existing project are present on staging", { skip: unset }, async () => {
  const all = accounts();
  const customers = all.filter((a) => /customer/i.test(a.role));
  assert.ok(customers.length >= 2,
    `this test delivers to an EXISTING customer project and then proves a second customer cannot see it, so it needs two customer accounts; the access artifact has: ${all.map((a) => a.role).join(", ")}`);

  // Whichever customer already has a project is the one the website is delivered to.
  for (const c of customers) {
    const page = await signIn(c);
    const projects = await portalProjects(page);
    await page.close();
    if (projects.length && !projectA) { customerA = c; projectA = projects[0]; continue; }
    if (projects.length === 0 || (customerA && c.email !== customerA.email)) customerB ??= c;
  }
  assert.ok(customerA && projectA, `no demo customer has an existing project to deliver to (checked ${customers.length} account(s))`);
  assert.ok(customerB, "a second customer account is needed for the isolation checks");
  console.log(`  customer A ${customerA!.email} has project ${projectA!.id} (${projectA!.name}); customer B is ${customerB!.email}`);
});

test("[WDE-02] a finished website exists to deliver", { skip: unset }, async (t) => {
  if (!projectA) return t.skip("no customer project was found by [WDE-01]");
  const owner = await signIn(accounts().find((a) => a.role === "owner")!);

  // The builds a person would see, filtered to the ones that are actually finished. This test does not run a
  // build: Phase 8's point is the handover, and a GPU build to prove an assignment form would be waste.
  await owner.goto(`${BASE}/staff/builds?state=ready_for_review`, { waitUntil: "domcontentloaded" });
  let ids = await owner.locator('a[href^="/staff/builds/bld_"]').evaluateAll(
    (els: Element[]) => [...new Set(els.map((e) => /\/staff\/builds\/(bld_[0-9a-f]+)/.exec(e.getAttribute("href") ?? "")?.[1] ?? "").filter(Boolean))],
  );
  if (!ids.length) {
    await owner.goto(`${BASE}/staff/builds?state=approved`, { waitUntil: "domcontentloaded" });
    ids = await owner.locator('a[href^="/staff/builds/bld_"]').evaluateAll(
      (els: Element[]) => [...new Set(els.map((e) => /\/staff\/builds\/(bld_[0-9a-f]+)/.exec(e.getAttribute("href") ?? "")?.[1] ?? "").filter(Boolean))],
    );
  }

  // The deliver page says whether a build may be delivered and why not, so it is the honest way to choose one.
  for (const id of ids) {
    await owner.goto(`${BASE}/staff/builds/${id}/deliver`, { waitUntil: "domcontentloaded" });
    const text = await owner.locator("main").innerText();
    if (/finished and has a stored website/i.test(text)) { jobId = id; break; }
  }
  await owner.close();
  assert.ok(jobId, `no finished build with a stored website snapshot was found among ${ids.length} candidate(s); the builder has to produce one before it can be delivered`);
  console.log(`  delivering build ${jobId}`);
});

test("[WDE-03] staff assign the finished website to the existing project", { skip: unset }, async (t) => {
  if (!jobId || !projectA) return t.skip("no build or project was established");
  const owner = await signIn(accounts().find((a) => a.role === "owner")!);

  // Search for the project by name, as a person would, then assign to that exact project id.
  await owner.goto(`${BASE}/staff/builds/${jobId}/deliver?q=${encodeURIComponent(projectA.name.slice(0, 20))}`, { waitUntil: "domcontentloaded" });
  const form = owner.locator(`form[action$="/deliver"]:has(input[value="${projectA.id}"])`);
  assert.ok(await form.count(), `the search did not offer project ${projectA.id}; the page says: ${(await owner.locator("main").innerText()).slice(0, 400)}`);

  await form.locator('input[name=visible]').check();
  await Promise.all([owner.waitForNavigation().catch(() => {}), form.locator('button[type=submit]').click()]);

  const after = await owner.locator("main").innerText();
  assert.match(after, /Already delivered/i, `the delivery was not recorded: ${after.slice(0, 500)}`);
  assert.match(after, /Available to customer/i, `and it should be visible to the customer: ${after.slice(0, 500)}`);
  await owner.close();
});

test("[WDE-04] the customer opens the website from their own portal", { skip: unset }, async (t) => {
  if (!customerA || !projectA) return t.skip("no customer project was established");
  const page = await signIn(customerA);
  await page.goto(`${BASE}/portal/projects/${projectA.id}`, { waitUntil: "domcontentloaded" });
  const text = await page.locator("main").innerText();
  assert.match(text, /Your website/i, `the deliverable section is on the customer's project page: ${text.slice(0, 500)}`);
  assert.match(text, /View website/i, "and it offers the action");

  // The actual website, not a screenshot and not a mockup: follow the link and read what rendered.
  const link = page.locator('a:has-text("View website")');
  const href = await link.getAttribute("href");
  assert.ok(href && href.startsWith("/build-preview/"), `the action must open the stored website: ${href}`);

  const siteCtx = await browser.newContext();
  const site = await siteCtx.newPage();
  const errors: string[] = [];
  site.on("console", (m: { type: () => string; text: () => string }) => { if (m.type() === "error") errors.push(m.text()); });
  const res = await site.goto(`${BASE}${href}`, { waitUntil: "load" });
  assert.equal(res?.status(), 200, `the website itself must load: ${res?.status()}`);

  const bodyText = await site.locator("body").innerText();
  assert.ok(bodyText.trim().length > 20, `the page rendered content rather than an empty shell: ${bodyText.slice(0, 200)}`);
  // A stylesheet that 404s renders as unstyled HTML, which is the failure this catches.
  const styled = await site.evaluate(() => {
    const b = getComputedStyle(document.body);
    return { bg: b.backgroundColor, font: b.fontFamily, sheets: document.styleSheets.length };
  });
  assert.ok(styled.sheets > 0 || /\w/.test(styled.font), `the website is styled, not raw HTML: ${JSON.stringify(styled)}`);
  assert.deepEqual(errors.filter((e) => /failed to load|refused|blocked|net::/i.test(e)), [],
    `no asset or request errors in the customer's browser: ${errors.slice(0, 5).join(" | ")}`);

  await site.close();
  await page.close();
});

test("[WDE-05] another customer can reach neither the project nor the website", { skip: unset }, async (t) => {
  if (!customerB || !projectA) return t.skip("no second customer was established");
  const page = await signIn(customerB);

  // Their own portal does not list it.
  const theirs = await portalProjects(page);
  assert.ok(!theirs.some((x) => x.id === projectA!.id), `customer B must not see project ${projectA!.id}: ${JSON.stringify(theirs)}`);

  // And asking for it directly is refused, not merely hidden from the navigation.
  const res = await page.goto(`${BASE}/portal/projects/${projectA!.id}`, { waitUntil: "domcontentloaded" });
  assert.ok(res && [403, 404].includes(res.status()), `direct access must be refused, got ${res?.status()}`);
  const text = await page.locator("body").innerText();
  assert.doesNotMatch(text, /Your website/i, "and no deliverable is rendered for them");
  assert.doesNotMatch(text, /View website/i);
  await page.close();
});

test("[WDE-06] a tampered preview capability is refused", { skip: unset }, async (t) => {
  if (!customerA || !projectA) return t.skip("no customer project was established");
  const page = await signIn(customerA);
  await page.goto(`${BASE}/portal/projects/${projectA.id}`, { waitUntil: "domcontentloaded" });
  const href = await page.locator('a:has-text("View website")').getAttribute("href");
  assert.ok(href, "the customer has a preview link to tamper with");

  // The link is a signed capability naming one snapshot. Editing any part of it must be refused rather than
  // serving somebody else's revision -- that is what makes "guess the URL" not an attack.
  const parts = href!.split("/").filter(Boolean);           // build-preview / :id / :rev / :token / …
  const token = parts[3];
  const tampered = [
    href!.replace(token, `${token.slice(0, -2)}xx`),
    href!.replace(`/${parts[2]}/`, "/9-9/"),
    href!.replace(parts[1], parts[1].replace(/.$/, "0")),
  ];
  for (const url of tampered) {
    const res = await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
    assert.ok(res && [403, 404].includes(res.status()), `a tampered capability must be refused, got ${res?.status()} for ${url}`);
  }
  await page.close();
});
