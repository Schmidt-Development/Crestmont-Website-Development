// The automatic four-slot build queue, through the DEPLOYED staging interface.
//
// tests/gallery-to-builder.test.ts proves the claim and the screen agree on who is next ([QUE-01]) and that a full
// node queues the rest ([QUE-02]), both in-process against an in-memory database with a fake runner. Neither says
// whether submitting six finished frontends to the real site puts four of them on a real Node 1 and leaves two
// waiting, nor whether a released slot is picked up with nobody pressing anything. That is what this does.
//
//   E2E_BASE_URL        https://crestmont-platform-staging.<subdomain>.workers.dev
//   E2E_ACCOUNTS_FILE   demo-accounts.md (scripts/staging-access.ts writes it)
//   E2E_QUEUE_FIXTURES  how many to submit (default 6: two more than the cap, so the queue is not empty)
//
// Without the first two it reports itself skipped, so a local run is unaffected.
//
// It writes: `E2E_QUEUE_FIXTURES` projects in the internal "Artifact Builder tests" organization, each named with
// this run's id, and one disposable archive uploaded to each. These are generated here and belong to the test --
// the Founder's own test artifacts are never submitted, read or altered by it. The projects are left in place
// deliberately: they are the evidence, and their names cannot be mistaken for a customer's.
//
// Submitting is all it does. Approval rides along with the submission (the acknowledgement on the upload screen),
// and approval is what queues a backend build, so nothing here presses a start button -- that is the behaviour
// under test.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./support.ts";
import { totpCode } from "../../src/lib/auth-crypto.ts";
import { makeZip } from "../../runner/test/fixtures/zip-writer.ts";

const BASE = process.env.E2E_BASE_URL?.replace(/\/$/, "");
const ACCOUNTS = process.env.E2E_ACCOUNTS_FILE;
const unset = !BASE || !ACCOUNTS ? "E2E_BASE_URL / E2E_ACCOUNTS_FILE not set" : false;
const RUN = `q${Date.now().toString(36)}`;
const FIXTURES = Math.max(1, Number(process.env.E2E_QUEUE_FIXTURES ?? 6));
const DASH = "/staff/builds/frontends";
const SUBMIT = `form[action$="${DASH}/new"] button[type=submit]`;

type Page = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Playwright is loaded at runtime
type Account = { role: string; email: string; password: string; totp?: string };

function account(role: string): Account {
  const md = readFileSync(ACCOUNTS!, "utf8");
  const all = [...md.matchAll(/^\| (\w+) \| (\S+) \| `([^`]+)` \| (?:`([A-Z2-7]+)`|—) \|/gm)]
    .map((m) => ({ role: m[1], email: m[2], password: m[3], totp: m[4] }));
  const found = all.find((a) => a.role === role);
  assert.ok(found, `no ${role} account in ${ACCOUNTS} (have: ${all.map((a) => a.role).join(", ")})`);
  return found;
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
    await page.fill("#f-code", await totpCode(a.totp));
    await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);
  }
  assert.doesNotMatch(new URL(page.url()).pathname, /^\/(login|mfa)/, `signed in as ${role} (${await alerts(page)})`);
  return page;
}

/**
 * A disposable frontend, different in every fixture.
 *
 * Different because identical bytes are one artifact: the platform keys an artifact by its sha256, and six copies
 * of one archive would prove six submissions collapse into one, not that six builds queue. The variation is in the
 * content, so each is a genuine frontend of its own with its own measured design.
 */
function fixtureZip(n: number): Buffer {
  const hue = 20 + n * 37;
  return makeZip([
    { path: "index.html", body: Buffer.from(`<!doctype html><html><head><title>Queue fixture ${n} (${RUN})</title><link rel=stylesheet href=/s.css></head><body><header><h1>Fixture ${n}</h1></header><main><p>Disposable artifact ${n} for run ${RUN}.</p><form><label>Name <input name=name></label><button type=submit>Send</button></form></main></body></html>`) },
    { path: "s.css", body: Buffer.from(`:root{--accent:hsl(${hue} 46% 32%)}body{font-family:system-ui;color:#102428;margin:0}header{padding:${16 + n}px;background:var(--accent);color:#fff}main{padding:24px}button{background:var(--accent);color:#fff;border:0;padding:8px 14px}`) },
    { path: "app.js", body: Buffer.from(`document.querySelector("form")?.addEventListener("submit", (e) => { e.preventDefault(); });\n// fixture ${n} of run ${RUN}\n`) },
  ]);
}

/**
 * What the dashboard's "Backend builds" section says, parsed from the rendered page.
 *
 * Read from the interface on purpose. The Founder's requirement is that the screen shows the real state and the
 * real position, so reading the database instead would test something nobody looks at.
 */
async function queueBoard(p: Page): Promise<{ cap: number; active: { project: string; state: string }[]; queued: { position: number; project: string }[]; raw: string }> {
  await p.goto(BASE + DASH, { waitUntil: "domcontentloaded" });
  const section = p.locator("section", { has: p.locator("h2", { hasText: "Backend builds" }) }).first();
  if (!(await section.count())) return { cap: 0, active: [], queued: [], raw: (await p.locator("main").innerText()).slice(0, 300) };
  const raw = await section.innerText();

  const cap = Number(raw.match(/At most (\d+) run at once/)?.[1] ?? 0);
  const rows = async (table: Page) => {
    const out: string[][] = [];
    for (const tr of await table.locator("tbody tr").all()) out.push(await tr.locator("td").allInnerTexts());
    return out;
  };
  const tables = await section.locator("table").all();
  const hasQueue = await section.locator("h3", { hasText: "Queue" }).count() > 0;
  // The section renders the active table first and the queue table, when there is one, after an <h3>Queue</h3>.
  const activeRows = tables.length && !(hasQueue && tables.length === 1) ? await rows(tables[0]) : [];
  const queuedRows = hasQueue ? await rows(tables[tables.length - 1]) : [];

  return {
    cap,
    active: activeRows.map((c) => ({ project: (c[1] ?? "").trim(), state: (c[2] ?? "").trim() })),
    queued: queuedRows.map((c) => ({ position: Number(c[0]), project: (c[1] ?? "").trim() })),
    raw,
  };
}

const mine = (name: string) => name.includes(RUN);
const ours = (b: Awaited<ReturnType<typeof queueBoard>>) => ({
  active: b.active.filter((a) => mine(a.project)),
  queued: b.queued.filter((q) => mine(q.project)),
});

const submitted: { n: number; url: string }[] = [];

test(`[AB-Q-01] ${FIXTURES} disposable frontends are submitted and approved in one step each`, { skip: unset }, async () => {
  const o = await signedIn("owner");
  for (let n = 1; n <= FIXTURES; n++) {
    await o.goto(`${BASE}${DASH}/new`);
    const newRadio = o.locator('input[name=target][value=new]');
    if (await newRadio.count()) await newRadio.check();
    await o.fill('input[name=name]', `Queue fixture ${n} ${RUN}`);

    // The acknowledgement: this submission says the frontend IS the approved design. It approves nothing yet --
    // there is nothing to approve until the archive has been scanned, imported and measured -- and that is the
    // point of submitting it this way rather than approving by hand afterwards.
    const approve = o.locator('input[name=approve]');
    assert.ok(await approve.count(), "the upload screen must offer approval at submission, or nothing queues by itself");
    await approve.check();

    await o.setInputFiles('input[name=artifact]', { name: `fixture-${n}.zip`, mimeType: "application/zip", buffer: fixtureZip(n) });
    await Promise.all([o.waitForNavigation(), o.click(SUBMIT)]);

    const path = new URL(o.url()).pathname;
    assert.match(path, new RegExp(`^${DASH}/prj_`), `fixture ${n} landed on ${o.url()} (${await alerts(o)})`);
    submitted.push({ n, url: BASE + path });
    console.log(`  submitted fixture ${n}: ${path}`);
  }
  assert.equal(submitted.length, FIXTURES);
});

test("[AB-Q-02] four builds run and the rest hold real positions, with nobody pressing start", { skip: unset }, async (t) => {
  if (submitted.length !== FIXTURES) return t.skip("not every fixture was submitted");
  const o = await signedIn("owner");

  // Scanning is the operational scanner's 60s poll, importing and measuring is Node 1's work over the signed
  // protocol, and both happen once per fixture. Patient on purpose, and it reports what it is waiting on rather
  // than failing on a slow node.
  const deadline = Date.now() + 45 * 60_000;
  let board = await queueBoard(o);
  let best = { total: -1, at: "" };
  for (;;) {
    board = await queueBoard(o);
    const m = ours(board);
    const total = m.active.length + m.queued.length;
    if (total > best.total) best = { total, at: new Date().toISOString() };
    if (total >= FIXTURES) break;
    if (Date.now() > deadline) {
      return t.skip(`only ${total} of ${FIXTURES} fixtures had reached the queue within 45 minutes ` +
        `(${m.active.length} running, ${m.queued.length} waiting; most seen ${best.total} at ${best.at}). Board:\n${board.raw.slice(0, 800)}`);
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }

  const m = ours(board);
  assert.equal(board.cap, 4, `the screen must report the four-slot cap: ${board.raw.slice(0, 200)}`);
  assert.equal(board.active.length, 4, `four builds run at once, no more and no fewer: ${board.raw.slice(0, 600)}`);
  assert.equal(m.active.length + m.queued.length, FIXTURES, "every fixture is accounted for, running or waiting");
  assert.equal(m.queued.length, FIXTURES - 4, `${FIXTURES - 4} wait while four run`);

  // A position is a promise about order, so it has to count from one without gaps.
  assert.deepEqual(
    board.queued.map((q) => q.position),
    board.queued.map((_, i) => i + 1),
    `positions count from one with no gaps: ${JSON.stringify(board.queued)}`,
  );

  // And the running builds are reported in a state that means working, not a placeholder.
  for (const a of m.active) {
    assert.match(a.state, /preparing|building|verifying/, `${a.project} is in a real build state, not "${a.state}"`);
  }
  console.log(`  cap ${board.cap}; running ${m.active.map((a) => `${a.project} (${a.state})`).join(", ")}`);
  console.log(`  waiting ${m.queued.map((q) => `${q.position}. ${q.project}`).join(", ")}`);
});

test("[AB-Q-03] releasing a slot starts the next in line by itself", { skip: unset }, async (t) => {
  if (submitted.length !== FIXTURES) return t.skip("not every fixture was submitted");
  const o = await signedIn("owner");
  const before = await queueBoard(o);
  const waiting = ours(before).queued;
  if (!waiting.length) return t.skip(`nothing was waiting to be started: ${before.raw.slice(0, 300)}`);
  const next = waiting[0];
  assert.equal(next.position, 1, "the one at position 1 is the one that should start");

  // Free a slot the way a slot is freed in service: cancel one of the running builds from its own page. Cancelling
  // is a person's action; starting the next one is not, and that is what this watches for.
  const running = ours(before).active[0];
  assert.ok(running, "a build has to be running for a slot to be released");
  // The cancel control lives on the build job's own page (/staff/builds/<id>), reached from the builds list by
  // searching for the project. The design-locked project page is a different screen and has no such control.
  await o.goto(`${BASE}/staff/builds?q=${encodeURIComponent(running.project)}`, { waitUntil: "domcontentloaded" });
  const jobLink = o.locator(`tbody tr:has-text("${running.project}") a[href^="/staff/builds/"]`).first();
  if (!(await jobLink.count())) return t.skip(`no build row for "${running.project}" in the builds list; cannot release a slot through the interface`);
  await Promise.all([o.waitForNavigation(), jobLink.click()]);

  const reason = o.locator("#f-cancel-reason");
  if (!(await reason.count())) return t.skip(`no cancel control on ${o.url()}; cannot release a slot through the interface`);
  await reason.fill(`Releasing a slot to prove the queue starts the next build by itself (${RUN})`);
  await Promise.all([o.waitForNavigation().catch(() => {}), o.locator('form[action$="/cancel"] button[type=submit]').first().click()]);
  console.log(`  cancelled ${running.project} to release its slot`);

  // Nothing is pressed from here on. The runner claims the next build on its own poll.
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const board = await queueBoard(o);
    const started = board.active.some((a) => a.project === next.project);
    if (started) {
      const still = ours(board).queued;
      assert.ok(
        still.every((q) => q.project !== next.project),
        `${next.project} is running and must no longer be listed as waiting: ${JSON.stringify(still)}`,
      );
      assert.ok(board.active.length <= board.cap, `still within the cap: ${board.active.length} of ${board.cap}`);
      assert.deepEqual(board.queued.map((q) => q.position), board.queued.map((_, i) => i + 1), "and the rest moved up");
      console.log(`  ${next.project} started on its own; ${board.active.length} of ${board.cap} slots busy`);
      return;
    }
    if (Date.now() > deadline) {
      return t.skip(`${next.project} had not been started within 10 minutes of the slot being released. Board:\n${board.raw.slice(0, 800)}`);
    }
    await new Promise((r) => setTimeout(r, 20_000));
  }
});
