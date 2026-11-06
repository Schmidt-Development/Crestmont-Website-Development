// The Junk in the Trunk staging certification driver (scripts/builder-staging-e2e.ts). Everything here is a FIXTURE:
// an in-memory database built from every migration, a signed checkout.session.completed made by the test and no runner.
// It proves the driver's SQL matches the real schema, that its fixture intake passes the real onboarding validation and
// that it never reports a step as passed without the row that proves it. It is NOT evidence of a staging run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestApp, createCustomer, TEST_PASSWORD } from "./support/app.ts";
import { FakePayments } from "./support/security-world.ts";
import { createPackageOrder } from "../src/services/commerce.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { passwordProblems } from "../src/lib/auth-crypto.ts";
import { customerPassword, verificationPath, readOnly, report } from "../scripts/builder-staging-e2e.ts";
import { formatCents } from "../src/lib/html.ts";
import { certificationEmail } from "../scripts/builder-staging-e2e.ts";
import { JITT_BUSINESS as C } from "./fixtures/junk-in-the-trunk-business.ts";

const WHSEC = "whsec_jitt_fixture";

test("[AIB-020] the driver only runs single SELECT statements against staging D1", async () => {
  const q = readOnly(async () => []);
  for (const bad of ["DELETE FROM users", "UPDATE build_jobs SET state = 'approved'", "SELECT 1; DROP TABLE payments", "INSERT INTO payments VALUES (1)"]) assert.throws(() => q(bad), /single SELECT/, bad);
  assert.deepEqual(await q("SELECT 1"), []);
});

test("[AIB-020] the test customer's derived password meets the platform policy, is stable and depends on the root key", () => {
  const a = customerPassword("root-key-fixture-1"), b = customerPassword("root-key-fixture-2");
  assert.deepEqual(passwordProblems(a, C.email), []);
  assert.equal(a, customerPassword("root-key-fixture-1"));
  assert.notEqual(a, b);
  assert.throws(() => customerPassword(""), /required/);
});

// The driver clicks a button by its exact label and asserts an exact price, so its idea of "$2,499" has to be the
// page's. It wasn't: the driver expected "$2,499.00" while formatCents omits the cents on a whole-dollar amount,
// and the purchase step failed on a checkout page that was perfectly correct. Asserted against the real rendered
// page, because that is the disagreement that matters -- comparing the driver to itself would have proven nothing.
// A corrected brief cannot be re-sent to a customer who has already bought: onboarding is submitted exactly once
// per project. Re-certifying therefore means a fresh customer, and the address is the one thing in this whole
// certification that can reach outside the test environment -- staging mails nothing to .test, and would mail a
// real domain for real. So the driver refuses anything else rather than trusting whoever typed the workflow input.
test("[AIB-020] the certification customer is the fixture's by default and may only ever be overridden to a .test address", () => {
  assert.equal(certificationEmail(undefined), C.email, "unset: the certification runs as the fixture's customer");
  assert.equal(certificationEmail(""), C.email, "a blank workflow input is the same as unset");
  assert.equal(certificationEmail("   "), C.email, "and so is one the dispatcher left as whitespace");
  assert.equal(certificationEmail(" casey2@junkinthetrunk.test "), "casey2@junkinthetrunk.test", "a .test address is taken, trimmed");
  for (const bad of ["casey@junkinthetrunk.com", "casey@gmail.com", "casey@junkinthetrunk.test.com", "not-an-address", "a@b.test extra"]) {
    assert.throws(() => certificationEmail(bad), /must use a \.test address/, `${bad} must be refused`);
  }
});

test("[AIB-020] the price and button label the driver expects are what the real checkout page renders", async () => {
  const t = await createTestApp({ overrides: { payments: new FakePayments() } });
  const cu = await createCustomer(t.db, C.email, C.business);
  const c = await t.client().login(cu.email, TEST_PASSWORD);
  // The driver's path: /checkout/business opens the website intake first; its fixture intake must pass the real
  // validation there, and "Continue to review" leads to the page with the price and the Pay button.
  const entry = await c.get("/checkout/business");
  assert.equal(entry.headers.get("location"), "/checkout/business/intake", "the checkout starts with the intake");
  const intakePage = await (await c.get("/checkout/business/intake")).text();
  assert.ok(intakePage.includes(">Continue to review<"), "the intake's submit button carries the label the driver clicks");
  const submitted = await c.post("/checkout/business/intake", { intent: "submit", ...C.intake, functionality: [...C.intake.functionality] });
  assert.equal(submitted.headers.get("location"), "/checkout/business/review", "the fixture intake passes the real validation");
  const res = await c.get("/checkout/business/review");
  assert.equal(res.status, 200, "the Business checkout page renders");
  const page = await res.text();
  assert.match(page, /name="maintenance_plan" value="professional"/, "the plan picker the driver selects from");

  const expected = formatCents(C.packageCents);
  assert.equal(expected, "$2,499", "a whole-dollar package is rendered without cents");
  const price = /data-testid="checkout-price"[^>]*>([^<]*)/.exec(page);
  assert.ok(price, "the page exposes its price through the testid the driver reads");
  assert.ok(price[1].trim().startsWith(expected), `the page shows ${price[1].trim()}, the driver expects ${expected}`);
  assert.ok(page.includes(`Pay ${expected}`), "the Pay button carries the amount the driver clicks");

  // No tax block: with tax configured the button would charge a total other than $2,499, which the report's
  // Payment line (matched on exactly packageCents) would then never recognise. The driver refuses that case.
  assert.ok(!page.includes(`data-testid="checkout-tax"`), "no tax is configured, so the total is the package price");
  t.close();
});

test("[AIB-020] the verification link is taken from the email body and nothing else", () => {
  assert.equal(verificationPath("Confirm: https://crestmont-platform-staging.example.workers.dev/verify-email?token=abc_DEF-123\nThanks"), "/verify-email?token=abc_DEF-123");
  assert.equal(verificationPath("no link here"), null);
});

test("[AIB-020] the certification workflow keeps secrets away from the browser and reads staging only on main", () => {
  // Normalised: the assertions below are written with "\n", and a CRLF checkout would otherwise match none of them.
  const wf = readFileSync(".github/workflows/builder-staging-e2e.yml", "utf8").replace(/\r\n/g, "\n");
  assert.match(wf, /environment: staging/);
  assert.match(wf, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(wf, /permissions:\n  contents: read/);
  assert.doesNotMatch(wf, /secret put|secret delete|wrangler deploy|d1 execute|STRIPE_|deploy-production|--env production/, "no secret write, deploy, D1 write or Stripe key");
  // Steps that hold the token never run package code; the browser steps hold no secret (F-24).
  for (const step of wf.split(/\n      - name: /).slice(1)) {
    const holdsToken = /secrets\.CLOUDFLARE_API_TOKEN/.test(step);
    const runsPackages = /playwright|npm install|builder-staging-e2e\.ts (register|purchase)/.test(step);
    assert.ok(!(holdsToken && runsPackages), `step mixes the Cloudflare token with package code: ${step.split("\n")[0]}`);
  }

  // One Chromium directory for the whole job. The install step and the browser steps each resolve
  // PLAYWRIGHT_BROWSERS_PATH for themselves, and tests/e2e/support.ts -- which the browser commands import --
  // defaults it to /opt/pw-browsers when it is unset, which is not where "playwright install" writes. Setting it
  // per step invites exactly that drift, so it belongs to the job and must appear once, above "steps:".
  const [jobHeader, stepsBlock] = wf.split("\n    steps:\n");
  assert.ok(stepsBlock, "the job has a steps: block");
  assert.match(jobHeader, /^      PLAYWRIGHT_BROWSERS_PATH: .+$/m, "the job pins the Chromium directory");
  // Reading it in a run: is fine (the install step reports which directory it used); re-ASSIGNING it per step is
  // what would let the install and the launch drift apart again.
  assert.doesNotMatch(stepsBlock, /^s+PLAYWRIGHT_BROWSERS_PATH:/m, "no step sets it: install and launch must agree");
});

test("[AIB-020] the report: every step PENDING before anything happens; purchase → payment → project → queued build proven by rows (FIXTURE)", async () => {
  const t = await createTestApp({ STRIPE_WEBHOOK_SECRET: WHSEC, overrides: { payments: new FakePayments() } });
  const q = readOnly(async (sql) => (await t.db.prepare(sql).all()).results as never);

  let r = await report(q);
  const v = (step: string) => r.steps.find((s) => s.step === step)?.verdict;
  assert.equal(v("Customer registration"), "PENDING");
  assert.equal(v("Payment"), "PENDING");
  assert.equal(v("Node 1 execution"), "PENDING");
  assert.equal(v("Staging launch"), "BLOCKED");
  assert.equal(r.data.node1Online, false, "no runner has ever polled");

  const cu = await createCustomer(t.db, C.email, C.business);
  const c = await t.client().login(cu.email, TEST_PASSWORD);
  const order = await createPackageOrder(t.db, cu.organizationId, C.packageId, cu.id);
  assert.equal(order.amountCents, C.packageCents, "Business is billed $2,499 upfront");
  const body = JSON.stringify({ id: `evt_jitt_${Date.now()}`, type: "checkout.session.completed", created: Math.floor(Date.now() / 1000),
    data: { object: { id: "cs_test_jitt", mode: "payment", payment_status: "paid", amount_total: order.amountCents, payment_intent: "pi_test_jitt_fixture",
      metadata: { organization_id: cu.organizationId, invoice_id: order.invoiceId, order_id: order.orderId, kind: "package" } } } });
  const ts = Math.floor(Date.now() / 1000);
  assert.equal((await t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(WHSEC, `${ts}.${body}`)}` } })).status, 200);
  const pid = (await t.db.prepare(`SELECT id FROM projects WHERE order_id = ?`).bind(order.orderId).first<{ id: string }>())!.id;

  r = await report(q);
  assert.equal(v("Customer registration"), "PASS");
  assert.equal(v("Package selection"), "PASS");
  assert.equal(v("Payment"), "PASS");
  assert.match(r.steps.find((s) => s.step === "Payment")!.evidence, /pi_test_jitt_fixture/);
  assert.equal(v("Project creation"), "PASS");
  assert.equal(v("Build dispatch"), "PENDING", "no build is dispatched before the intake");

  // The fixture's intake must pass the REAL onboarding validation, or the staging run would stall at the form.
  const res = await c.post(`/portal/projects/${pid}/onboarding`, { intent: "submit", ...C.intake, functionality: [...C.intake.functionality] });
  assert.equal(res.status, 303, "onboarding accepted");
  r = await report(q);
  assert.equal(v("Build dispatch"), "PASS");
  const job = (r.data.buildJobs as { kind: string; state: string; package: string; strategy: string }[]).find((j) => j.kind === "first_build")!;
  assert.equal(job.state, "queued");
  assert.equal(job.package, "business");
  assert.equal(job.strategy, "standard");
  assert.equal(v("Node 1 execution"), "PENDING", "nothing claims it in a fixture, and the report never pretends otherwise");
  assert.equal(v("AI generation"), "PENDING");
  assert.equal(v("Subscription"), "PENDING");
  assert.equal(r.data.prelaunchMaintenanceCharges, 0, "no $199 charge at purchase");

  // The AI Build preview line reports stored snapshots, and a queued build has none yet. "PENDING" and "the
  // preview works" must never be confusable, so the wording is asserted too, not just the verdict.
  assert.equal(v("Website preview"), "PENDING");
  assert.match(r.steps.find((s) => s.step === "Website preview")!.evidence, /no snapshot stored yet/);

  // A revision row with no file behind it is the one case that must not read as success: the Founder would open
  // the preview and see nothing. The verdict is driven by stored files, never by the existence of a row.
  const jobId = (r.data.buildJobs as { id: string; kind: string }[]).find((j) => j.kind === "first_build")!.id;
  const insertRevision = (cycle: number, files: number, bytes: number, best: number) =>
    t.db.prepare(`INSERT INTO build_revisions (id, job_id, project_id, cycle, attempt, phase, commit_sha, score, decision, is_best, reverted, reverted_reason, file_count, total_bytes, created_at)
      VALUES (?, ?, ?, ?, 1, 'repair', 'deadbeef', 8.9, 'ACCEPT', ?, 0, NULL, ?, ?, ?)`)
      .bind(`rev_fixture_${cycle}`, jobId, pid, cycle, best, files, bytes, new Date().toISOString()).run();

  await insertRevision(0, 0, 0, 0);
  r = await report(q);
  assert.equal(v("Website preview"), "FAIL", "a snapshot that stored no file is not a working preview");

  await insertRevision(1, 3, 4096, 1);
  r = await report(q);
  assert.equal(v("Website preview"), "PASS");
  const preview = r.steps.find((s) => s.step === "Website preview")!.evidence;
  assert.match(preview, /2 revision\(s\)/);
  assert.match(preview, /3 file\(s\)/, "the file count the Founder would actually be served");
  assert.match(preview, /1-1\/repair@8\.9 BEST/, "which revision is the best one, and its score");
  assert.ok(preview.includes(`/staff/builds/${jobId}/inspect`), "the report links the page that shows the artifacts");

  // preview_url belongs to the separate preview-deploy feature, which nothing here configures. The two lines are
  // independent on purpose: neither may borrow the other's verdict.
  assert.equal(v("Preview"), "PENDING", "no preview_url was ever recorded");
});
