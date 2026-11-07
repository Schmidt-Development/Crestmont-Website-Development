// The Artifact Builder's upload workflow, through the DEPLOYED staging interface.
//
// Everything else that covers this workflow runs in-process: tests/design-locked.test.ts drives the routes against
// an in-memory database, and scripts/design-locked-e2e.ts drives the whole chain with a real sandbox and real
// models. Neither tells you whether a person can do it on the site. The Founder could see the Artifact Builder on
// staging and had nowhere to put a ZIP, and no test noticed, because no test used the interface.
//
// So this one does, as a person: sign in, click through, upload a real archive, read what the page says.
//
//   E2E_BASE_URL        https://crestmont-platform-staging.<subdomain>.workers.dev
//   E2E_ACCOUNTS_FILE   demo-accounts.md (scripts/staging-access.ts writes it)
//
// Without those it reports itself skipped, so a local run is unaffected.
//
// It writes: one project in the internal "Artifact Builder tests" organization per run, named with the run id, and
// the artifacts uploaded to it. Nothing else on staging is touched. The project is left in place deliberately --
// it is the evidence, and it is named so it can never be mistaken for a customer's.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./support.ts";
import { totpCode } from "../../src/lib/auth-crypto.ts";
import { makeZip } from "../../runner/test/fixtures/zip-writer.ts";

const BASE = process.env.E2E_BASE_URL?.replace(/\/$/, "");
const ACCOUNTS = process.env.E2E_ACCOUNTS_FILE;
const unset = !BASE || !ACCOUNTS ? "E2E_BASE_URL / E2E_ACCOUNTS_FILE not set" : false;
const RUN = `ab${Date.now().toString(36)}`;

type Page = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Playwright is loaded at runtime
type Account = { role: string; email: string; password: string; totp?: string };

function account(role: string): Account {
  const md = readFileSync(ACCOUNTS!, "utf8");
  const all = [...md.matchAll(/^\| (\w+) \| (\S+) \| `([^`]+)` \| (?:`([A-Z2-7]+)`|—) \|/gm)]
    .map((m) => ({ role: m[1], email: m[2], password: m[3], totp: m[4] }));
  const found = all.find((a) => a.role === role);
  assert.ok(found, `no ${role} account in ${ACCOUNTS} (have: ${all.map((a) => a.role).join(", ")})`);
  return found!;
}

let browser: Awaited<ReturnType<typeof launchBrowser>>;
before(async () => { if (!unset) browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

const alerts = async (p: Page) => (await p.locator(".alert, .toast").allInnerTexts().catch(() => [])).join(" | ");

async function signedIn(role: string): Promise<Page> {
  const a = account(role);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/login");
  await page.fill("#f-email", a.email);
  await page.fill("#f-password", a.password);
  await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);
  if (new URL(page.url()).pathname.startsWith("/mfa")) {
    assert.ok(a.totp, `${role} was asked for a code and has no key`);
    await page.fill("#f-code", await totpCode(a.totp!));
    await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);
  }
  assert.doesNotMatch(new URL(page.url()).pathname, /^\/(login|mfa)/, `signed in as ${role} (${await alerts(page)})`);
  return page;
}

/** A real frontend archive: a page, a stylesheet and a script, so it is a plausible artifact rather than a stub. */
function artifactZip(): Buffer {
  return makeZip([
    { path: "index.html", body: Buffer.from(`<!doctype html><html><head><title>Upload ${RUN}</title><link rel=stylesheet href=/s.css></head><body><h1>Upload ${RUN}</h1></body></html>`) },
    { path: "s.css", body: Buffer.from("body{font-family:system-ui;color:#102428}h1{color:#0a4451}") },
    { path: "app.js", body: Buffer.from("document.title = document.title;") },
  ]);
}

/** The standard harmless antivirus test signature, assembled at run time so this file is not itself flagged. */
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");

const DASH = "/staff/builds/frontends";

/**
 * The upload form's own submit.
 *
 * Every staff page carries a sign-out form in its header (src/ui/layout.ts), so `button[type=submit]` matches that
 * one first: measured on the deployed site, the run pressed Sign out three times and reported "landed on / (You
 * are signed out.)" as though the upload had failed. Scope every submit to the form it belongs to.
 */
const SUBMIT = `form[action$="${DASH}/new"] button[type=submit]`;
let projectUrl = "";

test("[AB-UI-01] an authorized staff user sees the upload control on the dashboard", { skip: unset }, async () => {
  const o = await signedIn("owner");
  await o.goto(BASE + DASH);
  const body = await o.locator("main").innerText();
  assert.match(body, /Upload frontend artifact/i, `the dashboard offered: ${body.slice(0, 400)}`);

  // And it goes somewhere, which is the part that was missing.
  await Promise.all([o.waitForNavigation(), o.click("text=Upload frontend artifact")]);
  assert.equal(new URL(o.url()).pathname, `${DASH}/new`, `clicking it went to ${o.url()}`);
  assert.ok(await o.locator('input[type=file][name=artifact]').count(), "the screen has a file field");
});

test("[AB-UI-02] a first test project is created and a valid ZIP is accepted, through the interface", { skip: unset }, async () => {
  const o = await signedIn("owner");
  await o.goto(`${BASE}${DASH}/new`);

  // "A new test project" is the default; name it after this run so the evidence is identifiable.
  const newRadio = o.locator('input[name=target][value=new]');
  if (await newRadio.count()) await newRadio.check();
  await o.fill('input[name=name]', `Artifact upload check ${RUN}`);
  await o.setInputFiles('input[name=artifact]', { name: "frontend.zip", mimeType: "application/zip", buffer: artifactZip() });
  await Promise.all([o.waitForNavigation(), o.click(SUBMIT)]);

  const path = new URL(o.url()).pathname;
  assert.match(path, new RegExp(`^${DASH}/prj_`), `landed on ${o.url()} (${await alerts(o)})`);
  projectUrl = BASE + path;

  const text = await o.locator("main").innerText();
  assert.match(text, new RegExp(`Artifact upload check ${RUN}`), "the page is the project that was just created");
  // Any state before approval will do. Insisting on "pending" failed on the system being FASTER than the test
  // assumed: measured on staging, by the time this page was read the scanner had already returned clean and the
  // runner had claimed it, so the page said "validating artifact". What this check is for is that the upload was
  // accepted and the artifact is moving, not that nothing has happened to it yet.
  assert.match(text, /not yet scanned|pending|scanning|validating|awaiting approval|clean/i,
    `the artifact is somewhere before approval: ${text.slice(0, 400)}`);
  assert.doesNotMatch(text, /design-locked/i, "and nothing is locked before a person approves it");
});

test("[AB-UI-03] the scanner's verdict becomes visible on the page", { skip: unset }, async (t) => {
  if (!projectUrl) return t.skip("no project was created by [AB-UI-02]");
  const o = await signedIn("owner");

  // The operational scanner polls on its own schedule (60s). Give it four passes before giving up, and report what
  // the page said rather than calling an unscanned artifact anything.
  const deadline = Date.now() + 5 * 60_000;
  let text = "";
  for (;;) {
    await o.goto(projectUrl);
    text = await o.locator("main").innerText();
    if (/scanned clean|clean/i.test(text) || /infected|quarantin/i.test(text)) break;
    if (Date.now() > deadline) {
      return t.skip(`the scanner had not reported within 5 minutes; the page still says: ${text.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 20_000));
  }
  assert.match(text, /clean/i, `a harmless archive must come back clean, not quarantined: ${text.slice(0, 300)}`);
});

test("[AB-UI-04] the imported frontend and its measurements appear, and approval is offered", { skip: unset }, async (t) => {
  if (!projectUrl) return t.skip("no project was created by [AB-UI-02]");
  const o = await signedIn("owner");

  // Importing and measuring is the runner's work, claimed from staging over its signed protocol. It takes minutes.
  const deadline = Date.now() + 12 * 60_000;
  for (;;) {
    await o.goto(projectUrl);
    const text = await o.locator("main").innerText();
    if (/approve/i.test(text) && /baseline|design/i.test(text)) {
      assert.match(text, /route|page|interaction/i, `the measurements are shown: ${text.slice(0, 300)}`);
      return;
    }
    if (Date.now() > deadline) {
      return t.skip(`no measured design within 12 minutes; the page says: ${text.slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
});

test("[AB-UI-05] an invalid file is refused with a reason, and nothing is created for it", { skip: unset }, async () => {
  const o = await signedIn("owner");
  await o.goto(`${BASE}${DASH}/new`);
  const newRadio = o.locator('input[name=target][value=new]');
  if (await newRadio.count()) await newRadio.check();
  await o.fill('input[name=name]', `Should not exist ${RUN}`);
  await o.setInputFiles('input[name=artifact]', { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a zip") });
  await Promise.all([o.waitForNavigation().catch(() => {}), o.click(SUBMIT)]);

  const shown = (await o.locator("body").innerText()).slice(0, 600);
  assert.match(shown, /zip|not allowed|do not match/i, `the refusal says why: ${shown}`);

  // And the dashboard did not gain a project for it.
  await o.goto(BASE + DASH);
  assert.doesNotMatch(await o.locator("main").innerText(), new RegExp(`Should not exist ${RUN}`), "a refused file left no project behind");
});

test("[AB-UI-06] EICAR is accepted for scanning and then quarantined, not delivered", { skip: unset }, async (t) => {
  const o = await signedIn("owner");
  await o.goto(`${BASE}${DASH}/new`);
  const newRadio = o.locator('input[name=target][value=new]');
  if (await newRadio.count()) await newRadio.check();
  await o.fill('input[name=name]', `Quarantine check ${RUN}`);
  await o.setInputFiles('input[name=artifact]', {
    name: "infected.zip", mimeType: "application/zip",
    buffer: makeZip([{ path: "eicar.com", body: Buffer.from(EICAR, "latin1") }]),
  });
  await Promise.all([o.waitForNavigation(), o.click(SUBMIT)]);
  const infectedUrl = o.url();
  assert.match(new URL(infectedUrl).pathname, new RegExp(`^${DASH}/prj_`), `landed on ${infectedUrl}`);

  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    await o.goto(infectedUrl);
    const text = await o.locator("main").innerText();
    if (/infected|quarantin/i.test(text)) {
      assert.doesNotMatch(text, /approve this design|design-locked/i, "a quarantined artifact is not offered for approval");
      return;
    }
    if (/scanned clean/i.test(text)) assert.fail("EICAR was reported clean");
    if (Date.now() > deadline) return t.skip(`the scanner had not reported within 5 minutes: ${text.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 20_000));
  }
});

test("[AB-UI-07] a customer cannot reach the upload screen or post to it", { skip: unset }, async () => {
  const c = await signedIn("customer_admin");
  await c.goto(`${BASE}${DASH}/new`);
  const body = (await c.locator("body").innerText()).slice(0, 400);

  // What matters is that the form is not there, not how the refusal is worded. Measured: a customer is given the
  // public marketing shell at that path, which contains none of the words a refusal page would -- so asserting on
  // "not found" or "no permission" tested the wording and not the behaviour.
  assert.equal(await c.locator('input[type=file][name=artifact]').count(), 0, `a customer was shown the file field: ${body}`);
  assert.equal(await c.locator(SUBMIT).count(), 0, `a customer was shown the upload form: ${body}`);
  assert.doesNotMatch(body, /Upload and scan/i, "and is not offered it in any other shape");
});

/**
 * The Founder's own upload, by shape: ONE self-contained HTML document with a name of its own.
 *
 * Every artifact fixture in this repository was called `index.html` -- this file's, the queue verification's, the
 * runner's -- so every test agreed with the detector about what a website looks like, and none of them could have
 * caught a detector that only recognised that one name. The first real upload, `01-vesper-rowe-law.html`, was
 * refused in 0.55 seconds as "no supported frontend was recognised", by a message that lists static HTML as
 * supported. This fixture exists so that the next time that happens, a test says so first.
 */
function singleDocumentZip(): Buffer {
  const name = `${RUN}-vesper-rowe-law.html`;
  return makeZip([{
    path: name,
    body: Buffer.from(
      `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">`
      + `<title>Single document ${RUN}</title><style>:root{--ink:#102428;--accent:#7a5c2e}`
      + `body{margin:0;font-family:system-ui;color:var(--ink)}header{padding:28px;background:var(--accent);color:#fff}`
      + `main{padding:24px;max-width:60rem}h1{margin:0;font-size:32px}form{display:grid;gap:8px;max-width:22rem}`
      + `button{background:var(--accent);color:#fff;border:0;padding:10px 16px}</style></head>`
      + `<body><header><h1>Vesper Rowe</h1></header><main><p>One document, no index.html, run ${RUN}.</p>`
      + `<form id=consult><label>Name <input name=name></label><button type=submit>Request a consultation</button></form></main>`
      + `<script>document.querySelector("#consult")?.addEventListener("submit",(e)=>{e.preventDefault()});</script>`
      + `</body></html>`,
    ),
  }]);
}

let singleDocUrl: string | null = null;

test("[AB-UI-08] a single arbitrarily named HTML document uploads, imports and is measured", { skip: unset }, async () => {
  const o = await signedIn("owner");
  await o.goto(`${BASE}${DASH}/new`);
  const newRadio = o.locator('input[name=target][value=new]');
  if (await newRadio.count()) await newRadio.check();
  await o.fill('input[name=name]', `Single document ${RUN}`);
  await o.setInputFiles('input[name=artifact]', { name: "single-document.zip", mimeType: "application/zip", buffer: singleDocumentZip() });
  await Promise.all([o.waitForNavigation(), o.click(SUBMIT)]);

  const landed = new URL(o.url()).pathname;
  assert.match(landed, new RegExp(`^${DASH}/prj_`), `landed on ${o.url()} (${await alerts(o)})`);
  singleDocUrl = BASE + landed;
});

test("[AB-UI-09] the single-document artifact reaches a measured design, not a rejection", { skip: unset }, async (t) => {
  if (!singleDocUrl) return t.skip("no project was created by [AB-UI-08]");
  const o = await signedIn("owner");

  // Scanning is the operational scanner's own 60s poll and importing is the runner's work, so this is patient.
  // It does NOT skip on a rejection: being told "rejected" is a determined answer, and the wrong one.
  const deadline = Date.now() + 15 * 60_000;
  let text = "";
  for (;;) {
    await o.goto(singleDocUrl);
    text = await o.locator("main").innerText();

    if (/rejected|not a supported|unsupported/i.test(text)) {
      assert.fail(`a single HTML document is a supported artifact and was refused: ${text.slice(0, 800)}`);
    }
    if (/approve/i.test(text) && /baseline|design/i.test(text)) break;
    if (Date.now() > deadline) {
      assert.fail(`no measured design within 15 minutes, and no rejection either; the page says: ${text.slice(0, 600)}`);
    }
    await new Promise((r) => setTimeout(r, 20_000));
  }

  // Measured, and measured as a static site with a page in it.
  assert.match(text, /static/i, `the framework is recognised as static: ${text.slice(0, 400)}`);
  assert.match(text, /route|page|interaction/i, `the measurements are shown: ${text.slice(0, 400)}`);
  // The rename is the owner's business: they uploaded a file with a name, and the page says what happened to it.
  assert.match(text, /renamed|index\.html/i, `the normalisation is disclosed on the page: ${text.slice(0, 600)}`);
});
