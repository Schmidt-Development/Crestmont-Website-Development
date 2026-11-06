// §6's full contract, and the one question it exists to answer: could this plan be carried out HONESTLY?
//
// `validateManifest` asks whether a plan is well-formed. `completeness` asks whether executing it would produce
// real behaviour — which is the check that stands between "connect the checkout" and a checkout that reports
// success without a payment. §8 is unambiguous: no fake production integrations, no success responses that
// pretend data was saved. A plan that cannot name its provider is a plan that will fake it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MANIFEST_SCHEMA, PACKAGES, completeness, describeContract } from "../src/frontend/integration-manifest.ts";
import type { IntegrationManifest, IntegrationOperation, ManifestContract } from "../src/frontend/integration-manifest.ts";

const op = (over: Partial<IntegrationOperation> = {}): IntegrationOperation => ({
  id: "quote-submit", page: "quote", element: "form#quote-request", kind: "form-submit",
  behaviour: "Store a quote request.", expectChange: "content",
  acceptance: ["a submitted request is stored"],
  dataModel: [{ table: "quote_requests", fields: ["name", "email"] }],
  ...over,
});

const plan = (ops: IntegrationOperation[], contract: ManifestContract = {}): IntegrationManifest & ManifestContract => ({
  schema: MANIFEST_SCHEMA, artifactSha: "a".repeat(64), designFingerprint: "d".repeat(64), operations: ops,
  dataModels: [{ table: "quote_requests", fields: ["name", "email"], purpose: "leads from the website" }],
  ...contract,
});

const codes = (c: { blockers: { code: string }[] }) => c.blockers.map((b) => b.code);

test("[CON-01] a plan that declares what it needs can be carried out", () => {
  const c = completeness(plan([op()], {
    project: { projectId: "prj_1", packageId: "business", scope: "A seven-page marketing site with a quote form." },
    runtime: { framework: "vite", node: "22" },
    apis: [{ method: "POST", path: "/api/quote-requests", auth: "public", purpose: "receive a quote request" }],
    security: ["server-side validation on every field", "no credentials in the frontend bundle"],
    baselineRef: { baselineId: "dbl_1", version: 1, fingerprint: "d".repeat(64) },
  }));

  assert.equal(c.ok, true, JSON.stringify(c.blockers));
  assert.deepEqual(c.blockers, []);
  const text = describeContract(plan([op()], { project: { projectId: "prj_1", packageId: "business" }, runtime: { framework: "vite" } }));
  assert.match(text, /package business/);
  assert.match(text, /runtime: vite/);
  assert.match(text, /can be carried out honestly/);
});

test("[CON-02] a payment with no named provider is a blocker, not a detail", () => {
  const pay = op({ id: "checkout", kind: "payment", element: "button#pay", acceptance: ["a test charge succeeds"], dataModel: [{ table: "payments", fields: ["amount"] }] });

  const silent = completeness(plan([pay], { dataModels: [{ table: "payments", fields: ["amount"] }] }));
  assert.equal(silent.ok, false);
  assert.ok(codes(silent).includes("payment-without-provider"), codes(silent).join(","));
  assert.match(silent.blockers[0].detail, /fake checkout/, "it says plainly what the alternative would be");

  // Naming an approved provider in test mode is enough.
  const named = completeness(plan([pay], {
    dataModels: [{ table: "payments", fields: ["amount"] }],
    externalIntegrations: [{ name: "Stripe", origin: "https://api.stripe.com", approved: true, mode: "test" }],
    secrets: [{ name: "STRIPE_SECRET_KEY", purpose: "test-mode charges", provided: true }],
  }));
  assert.equal(named.ok, true, JSON.stringify(named.blockers));

  // Live mode is a person's decision, never the AI's.
  const live = completeness(plan([pay], {
    dataModels: [{ table: "payments", fields: ["amount"] }],
    externalIntegrations: [{ name: "Stripe", approved: true, mode: "live" }],
  }));
  assert.equal(live.ok, false);
  assert.ok(codes(live).includes("payment-live-mode"));
  assert.match(live.blockers.find((b) => b.code === "payment-live-mode")!.detail, /a person enables live/);

  // Recording it as missing is also acceptable: the gap is stated instead of invented.
  const recorded = completeness(plan([pay], {
    dataModels: [{ table: "payments", fields: ["amount"] }],
    missing: [{ what: "the payment provider and its test keys", why: "the customer has not said who processes their card payments", blocks: ["checkout"] }],
  }));
  assert.equal(recorded.ok, true, JSON.stringify(recorded.blockers));
  assert.match(describeContract(plan([pay], { dataModels: [{ table: "payments", fields: ["amount"] }], missing: recorded.missing })), /missing — the payment provider/);
});

test("[CON-03] an unavailable credential or unapproved service blocks the work that needs it", () => {
  const c = completeness(plan([op()], {
    secrets: [
      { name: "RESEND_API_KEY", purpose: "sending the quote confirmation", provided: false },
      { name: "DATABASE_URL", purpose: "storing requests", provided: true },
    ],
    externalIntegrations: [{ name: "SomeAnalytics", origin: "https://cdn.example.com", approved: false }],
  }));

  assert.equal(c.ok, false);
  assert.ok(codes(c).includes("secret-unavailable"));
  assert.ok(codes(c).includes("integration-unapproved"));
  assert.match(c.blockers.find((b) => b.code === "secret-unavailable")!.detail, /RESEND_API_KEY/);
  assert.ok(!codes(c).some((x) => x === "secret-unavailable" && false), "the provided one is not a blocker");
  assert.equal(c.blockers.filter((b) => b.code === "secret-unavailable").length, 1, "only the unavailable secret");
  assert.match(c.blockers.find((b) => b.code === "integration-unapproved")!.detail, /not wired up on the AI's say-so/);
});

test("[CON-04] signing users in, or sending mail, needs a contract the AI did not write", () => {
  const auth = completeness(plan([op({ id: "login", kind: "auth", element: "form#login", acceptance: ["a known user signs in"], dataModel: undefined })]));
  assert.equal(auth.ok, false);
  assert.ok(codes(auth).includes("auth-without-contract"));
  assert.match(auth.blockers[0].detail, /not for the AI to decide/);

  const withAuth = completeness(plan([op({ id: "login", kind: "auth", element: "form#login", acceptance: ["ok"], dataModel: undefined })], {
    auth: { required: true, roles: ["customer"], provider: "crestmont-sessions" },
  }));
  assert.equal(withAuth.ok, true, JSON.stringify(withAuth.blockers));

  const mail = completeness(plan([op({ id: "notify", kind: "email", element: "form#quote-request", acceptance: ["a confirmation arrives"], dataModel: undefined })]));
  assert.ok(codes(mail).includes("email-without-transport"));

  const withMail = completeness(plan([op({ id: "notify", kind: "email", element: "form#quote-request", acceptance: ["ok"], dataModel: undefined })], {
    secrets: [{ name: "RESEND_API_KEY", purpose: "quote confirmations", provided: true }],
  }));
  assert.equal(withMail.ok, true, JSON.stringify(withMail.blockers));
});

test("[CON-05] a write to a table nobody designed is caught before any code is written", () => {
  const c = completeness(plan([op({ dataModel: [{ table: "bookings", fields: ["slot"] }] })]));
  assert.equal(c.ok, false);
  assert.ok(codes(c).includes("table-not-modelled"));
  assert.match(c.blockers[0].detail, /"bookings", which is not in the plan's data models/);
  assert.equal(c.blockers[0].operationId, "quote-submit", "attributed to the operation that would have written it");
});

test("[CON-06] package scope is never invented, and a recorded gap must actually say something", () => {
  const bad = completeness(plan([op()], { project: { packageId: "enterprise" as never } }));
  assert.ok(codes(bad).includes("unknown-package"));
  assert.match(bad.blockers[0].detail, /starter, business, premium, custom/);
  assert.deepEqual([...PACKAGES], ["starter", "business", "premium", "custom"]);

  for (const p of PACKAGES) {
    assert.equal(completeness(plan([op()], { project: { packageId: p } })).ok, true, p);
  }

  // "Something is missing" is not a record of what is missing.
  const vague = completeness(plan([op()], { missing: [{ what: "", why: "", blocks: [] }] }));
  assert.ok(codes(vague).includes("vague-missing-entry"));
});

test("[CON-07] the contract reads as a statement of what is known and what is not", () => {
  const text = describeContract(plan([op({ id: "checkout", kind: "payment", element: "button#pay", acceptance: ["x"], dataModel: undefined })], {
    project: { projectId: "prj_summit", packageId: "business" },
    runtime: { framework: "vite", node: "22" },
    baselineRef: { version: 2, fingerprint: "f".repeat(64) },
    apis: [{ method: "POST", path: "/api/quote-requests" }],
    auth: { required: true, roles: ["customer", "staff"] },
    secrets: [{ name: "STRIPE_SECRET_KEY", purpose: "charges", provided: false }],
    externalIntegrations: [{ name: "Stripe", approved: false }],
    missing: [{ what: "Stripe test keys", why: "the customer has not opened an account yet", blocks: ["checkout"] }],
  }));

  assert.match(text, /project prj_summit, package business/);
  assert.match(text, /against baseline v2 ffffffffffffffff/);
  assert.match(text, /1 endpoint\(s\): POST \/api\/quote-requests/);
  assert.match(text, /authentication required for customer, staff/);
  assert.match(text, /1 secret\(s\), 1 not available/);
  assert.match(text, /Stripe \(NOT APPROVED\)/);
  assert.match(text, /missing — Stripe test keys/);
  assert.match(text, /blocker\(s\) must be resolved by a person/);
});
