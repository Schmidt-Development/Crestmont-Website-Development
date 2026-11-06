// MFA removed (Founder directive, 2026-11-06): the password is the whole sign-in for every account — Founder/Owner,
// staff, administrators and customers. These tests run the real request pipeline (src/app/app.ts) and prove:
//   - every kind of account signs in with email + password and lands in its area, even with a stored authenticator;
//   - the old /mfa, /mfa/setup and /mfa/step-up addresses only send a signed-in user onward (no code form);
//   - step-up actions and customer-administrator actions no longer detour through MFA;
//   - authorization is otherwise unchanged; and stored MFA data is preserved untouched.
// Every account and record here is TEST DATA; Stripe is a local fake that records calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, enrolTotp, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import { completeIntake } from "./support/intake.ts";
import type { Env } from "../src/app/context.ts";
import type { PaymentsAdapter, CheckoutRequest } from "../src/adapters/payments.ts";
import { stepUpAction } from "../src/app/step-up.ts";
import { newTotpSecret } from "../src/lib/auth-crypto.ts";
import { newId, nowIso } from "../src/lib/db.ts";

class FakePayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  checkouts: CheckoutRequest[] = [];
  async createCheckout(req: CheckoutRequest) { this.checkouts.push(req); const id = `cs_test_nomfa_${this.checkouts.length}`; return { id, url: `https://checkout.stripe.com/c/pay/${id}` }; }
  async createBillingPortal(customerId: string) { return { url: `https://billing.stripe.com/p/session/test_${customerId}` }; }
  async createRefund(pi: string, amount: number) { return { id: `re_test_${pi}_${amount}`, status: "succeeded" }; }
}

const loc = (r: Response) => r.headers.get("location") ?? "";
const n = async (db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())!.n;
/** A code form is any form posting a one-time code (the removed /mfa challenge, setup and step-up pages had one). */
const CODE_FORM = /name="code"|one-time-code|data-testid="totp-secret"|data-testid="recovery-codes"/;

/** A customer member (not an administrator) in `organizationId`, with a stored authenticator secret. */
async function createMember(db: Env["DB"], organizationId: string, email: string) {
  const id = newId("usr");
  const secret = newTotpSecret();
  await db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, totp_secret, mfa_enabled, created_at) SELECT ?, ?, 'Morgan Member', password_hash, ?, ?, 1, ? FROM users WHERE password_hash IS NOT NULL LIMIT 1`)
    .bind(id, email, nowIso(), secret, nowIso()).run();
  await db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?, 'customer_member', ?)`).bind(newId("mbr"), id, organizationId, nowIso()).run();
  return { id, email, secret };
}

test("[AUTH-003] MFA removed: the Owner, staff, a customer administrator and a customer member sign in with email + password alone, even with a stored authenticator", async () => {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner", "founder@crestmont.test");
  const developer = await createStaff(t.db, "developer", "dev@crestmont.test");
  const admin = await createCustomer(t.db, "admin@nomfa.example", "No MFA Co");
  const member = await createMember(t.db, admin.organizationId, "member@nomfa.example");
  const accounts = [
    { who: "Owner", email: owner.email, area: "/staff", page: "/staff/readiness/approve" },
    { who: "staff member", email: developer.email, area: "/staff", page: "/staff" },
    { who: "customer administrator", email: admin.email, area: "/portal", page: "/portal/billing" },
    { who: "customer member", email: member.email, area: "/portal", page: "/portal/projects" },
  ];
  for (const a of accounts) {
    const row = await t.db.prepare(`SELECT totp_secret, mfa_enabled FROM users WHERE email = ?`).bind(a.email).first<{ totp_secret: string | null; mfa_enabled: number }>();
    assert.ok(row?.totp_secret && row.mfa_enabled === 1, `${a.who} has a stored authenticator`);
    const c = t.client();
    const res = await c.post("/login", { email: a.email, password: TEST_PASSWORD });
    assert.equal(res.status, 303, a.who);
    assert.equal(loc(res), a.area, `${a.who} lands in ${a.area}, not on /mfa`);
    for (const p of [a.area, a.page]) {
      const r = await c.get(p);
      assert.equal(r.status, 200, `${a.who}: ${p} opens straight after the password`);
      assert.doesNotMatch(await r.text(), /data-mfa-reminder|data-mfa-setup-link|Set up two-factor authentication/, `${a.who}: ${p} asks for no enrolment`);
    }
    const account = await (await c.get("/account")).text();
    assert.doesNotMatch(account, /Two-factor authentication|href="\/mfa\/setup"|\/account\/mfa\/recovery-codes/, `${a.who}: the account page has no two-factor section`);
  }
  t.close();
});

test("[AUTH-003] MFA removed: GET and POST /mfa, /mfa/setup and /mfa/step-up send a signed-in user onward and never render a code form", async () => {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner");
  const cust = await createCustomer(t.db, "onward@nomfa.example", "Onward Co");
  const staffClient = await t.client().login(owner.email);
  const custClient = await t.client().login(cust.email);
  for (const path of ["/mfa", "/mfa/setup", "/mfa/step-up"]) {
    for (const method of ["GET", "POST"] as const) {
      for (const [who, c, home] of [["staff", staffClient, "/staff"], ["customer", custClient, "/portal"]] as const) {
        const send = (p: string) => method === "GET" ? c.get(p) : c.post(p, { code: "123456" });
        const plain = await send(path);
        assert.equal(plain.status, 303, `${method} ${path} (${who})`);
        assert.equal(loc(plain), home, `${method} ${path} (${who}) → ${home}`);
        assert.doesNotMatch(await plain.text(), CODE_FORM, `${method} ${path} (${who}) renders no code form`);
        const next = await send(`${path}?next=${encodeURIComponent("/account")}`);
        assert.equal(loc(next), "/account", `${method} ${path}?next=/account (${who}) honours a same-origin next`);
        const offsite = await send(`${path}?next=${encodeURIComponent("https://evil.example/")}`);
        assert.equal(loc(offsite), home, `${method} ${path} (${who}) never redirects off-site`);
      }
    }
  }
  // Nothing about these addresses opens a session: an anonymous visitor is sent to sign in.
  const anon = await t.client().get("/mfa/setup");
  assert.equal(anon.status, 303);
  assert.match(loc(anon), /^\/login/);
  t.close();
});

test("[AUTH-003] [AUTH-008] MFA removed: step-up actions run without a /mfa/step-up detour, however old the sign-in", async () => {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner", "founder@crestmont.test");
  const oc = await t.client().login(owner.email);
  // A session signed in long ago (the old 10-minute step-up window is far exceeded).
  await t.db.prepare(`UPDATE sessions SET mfa_verified_at = ? WHERE user_id = ?`).bind(new Date(Date.now() - 6 * 3600e3).toISOString(), owner.id).run();

  assert.ok(stepUpAction("POST", "/staff/readiness/phased-release/defer", new URL("http://x/")), "the action is still on the step-up list");
  const defer = await oc.post("/staff/readiness/phased-release/defer", { id: "AIB-010", notes: "Phase 1 opens the non-AI offering; the builder is certified separately.", confirm: "defer for phase 1" });
  assert.equal(defer.status, 303);
  assert.doesNotMatch(loc(defer), /^\/mfa/, "not sent to step-up");
  assert.notEqual((await t.db.prepare(`SELECT disposition FROM requirements WHERE id = 'AIB-010'`).first<{ disposition: string }>())!.disposition, "in_scope", "the deferral was performed");

  assert.ok(stepUpAction("POST", "/staff/ops/retention", new URL("http://x/")));
  const retention = await oc.post("/staff/ops/retention", { "retention.app_errors_days": "90" });
  assert.equal(retention.status, 303);
  assert.equal(loc(retention), "/staff/ops/retention", "retention saved without a step-up");
  assert.match(decodeURIComponent(oc.cookies.get("cm_flash") ?? ""), /Saved: retention\.app_errors_days/);
  t.close();
});

test("[AUTH-003] [AUTH-007] MFA removed: a customer administrator without an authenticator invites a teammate and reaches Stripe checkout, with no enrolment detour", async () => {
  const fake = new FakePayments();
  const t = await createTestApp({ overrides: { payments: fake } });
  const admin = await createCustomer(t.db, "noauth-admin@nomfa.example", "No Authenticator Co", { mfa: false });
  const c: TestClient = await t.client().login(admin.email);
  const dash = await (await c.get("/portal")).text();
  assert.doesNotMatch(dash, /data-mfa-reminder|Set up two-factor authentication/, "no enrolment notice");

  const invite = await c.post("/portal/team", { email: "teammate@nomfa.example", role: "customer_member" });
  assert.equal(invite.status, 303);
  assert.equal(loc(invite), "/portal/team");
  assert.equal(await n(t.db, `SELECT COUNT(*) AS n FROM invitations WHERE email = 'teammate@nomfa.example' AND organization_id = ?`, admin.organizationId), 1, "the invitation was created");

  await completeIntake(c, "starter"); // intake before payment (Founder requirement)
  const checkout = await c.post("/checkout/starter", { terms: "1", maintenance_plan: "essential" });
  assert.equal(checkout.status, 303);
  assert.match(loc(checkout), /^https:\/\/checkout\.stripe\.com\//, "sent to Stripe Checkout, not to /mfa/setup");
  assert.equal(fake.checkouts.length, 1);
  assert.equal(await n(t.db, `SELECT COUNT(*) AS n FROM orders WHERE organization_id = ?`, admin.organizationId), 1);
  t.close();
});

test("[AUTH-003] [AUTH-007] [AUTH-008] MFA removed: authorization is unchanged — customers are refused /staff, staff without the permission are refused, anonymous visitors are sent to sign in", async () => {
  const t = await createTestApp();
  const cust = await createCustomer(t.db, "outsider@nomfa.example", "Outsider Co");
  const support = await createStaff(t.db, "support", "support@crestmont.test");
  const member = await createMember(t.db, cust.organizationId, "plain-member@nomfa.example");

  const cc = await t.client().login(cust.email);
  for (const p of ["/staff", "/staff/crm", "/staff/readiness/approve"]) assert.equal((await cc.get(p)).status, 403, `customer: ${p}`);

  const sc = await t.client().login(support.email);
  assert.equal((await sc.get("/staff")).status, 200, "support reaches the staff area");
  assert.equal((await sc.post("/staff/ops/retention", { "retention.app_errors_days": "90" })).status, 403, "support lacks settings.operational");
  assert.equal((await sc.post("/staff/readiness/phased-release/defer", { id: "AIB-010", notes: "not allowed for support staff at all", confirm: "defer for phase 1" })).status, 403, "only the Owner defers release scope");
  assert.equal((await t.db.prepare(`SELECT disposition FROM requirements WHERE id = 'AIB-010'`).first<{ disposition: string }>())!.disposition, "in_scope", "nothing changed");

  const mc = await t.client().login(member.email);
  assert.equal((await mc.post("/portal/team", { email: "x@nomfa.example", role: "customer_member" })).status, 403, "a customer member still cannot invite");
  assert.equal(await n(t.db, `SELECT COUNT(*) AS n FROM invitations WHERE email = 'x@nomfa.example'`), 0);

  for (const p of ["/staff", "/staff/readiness/approve", "/portal", "/account"]) {
    const r = await t.client().get(p);
    assert.equal(r.status, 303, `anonymous: ${p}`);
    assert.match(loc(r), /^\/login/, `anonymous: ${p} → sign-in`);
  }
  const wrong = await t.client().post("/login", { email: support.email, password: "not-the-right-password-at-all" });
  assert.notEqual(wrong.status, 303, "a wrong password still signs nobody in");
  t.close();
});

test("[AUTH-003] [SEC-004] MFA removed: stored MFA data is preserved — sign-in leaves the authenticator secret, its flags and recovery codes exactly as they were", async () => {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  // With MFA_ENCRYPTION_KEY set the old sign-in re-encrypted a legacy plaintext secret on verification; now nothing does.
  const t = await createTestApp({ MFA_ENCRYPTION_KEY: key });
  const staff = await createStaff(t.db, "project_manager", "pm@crestmont.test");
  const cust = await createCustomer(t.db, "keeps-data@nomfa.example", "Keeps Data Co", { mfa: false });
  await enrolTotp(t.db, cust.id);
  await t.db.prepare(`INSERT INTO mfa_recovery_codes (id, user_id, lookup, code_hash, created_at) VALUES ('mrc_keep', ?, 'abcd', 'pbkdf2$1$00$00', ?)`).bind(staff.id, nowIso()).run();
  const read = (id: string) => t.db.prepare(`SELECT totp_secret, totp_pending_secret, mfa_enabled, totp_last_step FROM users WHERE id = ?`).bind(id).first();
  const codes = (id: string) => n(t.db, `SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL`, id);
  const before = { staff: await read(staff.id), cust: await read(cust.id), staffCodes: await codes(staff.id) };
  assert.ok((before.staff as { totp_secret: string }).totp_secret && (before.cust as { totp_secret: string }).totp_secret);

  for (const email of [staff.email, cust.email]) {
    const c = await t.client().login(email);
    await c.get("/account");
    await c.post("/mfa", { code: "000000" }); // an old bookmark posting a code changes nothing either
  }
  assert.deepEqual(await read(staff.id), before.staff, "staff: authenticator data unchanged");
  assert.deepEqual(await read(cust.id), before.cust, "customer: authenticator data unchanged");
  assert.equal(await codes(staff.id), before.staffCodes, "recovery codes kept and unused");
  assert.equal(await n(t.db, `SELECT COUNT(*) AS n FROM security_events WHERE kind LIKE 'mfa_%'`), 0, "no second-factor attempt was ever recorded");
  t.close();
});
