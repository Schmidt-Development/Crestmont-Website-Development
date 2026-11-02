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

test("[AIB-020] the verification link is taken from the email body and nothing else", () => {
  assert.equal(verificationPath("Confirm: https://crestmont-platform-staging.example.workers.dev/verify-email?token=abc_DEF-123\nThanks"), "/verify-email?token=abc_DEF-123");
  assert.equal(verificationPath("no link here"), null);
});

test("[AIB-020] the certification workflow keeps secrets away from the browser and reads staging only on main", () => {
  const wf = readFileSync(".github/workflows/builder-staging-e2e.yml", "utf8");
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
});
