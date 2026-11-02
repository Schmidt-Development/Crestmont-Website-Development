// Founder decision FD-30: "Require multifactor authentication for customer administrators. Staff and Owner accounts
// must also meet their applicable MFA requirements." (AUTH-002, AUTH-003)
//
// Enforcement (src/domain/authz.ts#can, src/services/auth.ts#loadSession, src/app/app.ts#requireCustomerAdminMfa):
//   - a customer_admin session without a verified second factor holds member permissions only;
//   - until enrolment it may sign in, browse (GET), verify email, enrol / complete MFA, manage its own account
//     security and open support tickets; every other state-changing request is sent to /mfa/setup (nothing is created);
//   - an administrator who has an authenticator must complete the code at sign-in before any admin permission applies;
//   - customer members keep MFA optional (FD-30 names administrators only).
// All records are TEST DATA; Stripe is a local fake that records calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, lastEmail, linkFrom, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import type { PaymentsAdapter, CheckoutRequest } from "../src/adapters/payments.ts";
import { loadSession } from "../src/services/auth.ts";
import { can } from "../src/domain/authz.ts";
import { newId, nowIso } from "../src/lib/db.ts";

class FakePayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  checkouts: CheckoutRequest[] = [];
  async createCheckout(req: CheckoutRequest) { this.checkouts.push(req); const id = `cs_test_fd30_${this.checkouts.length}`; return { id, url: `https://checkout.stripe.com/c/pay/${id}` }; }
  async createBillingPortal(customerId: string) { return { url: `https://billing.stripe.com/p/session/test_${customerId}` }; }
  async createRefund(pi: string, amount: number) { return { id: `re_test_${pi}_${amount}`, status: "succeeded" }; }
}

const n = async (db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())!.n;
const loc = (r: Response) => r.headers.get("location") ?? "";
const future = (days = 30) => new Date(Date.now() + days * 86400e3).toISOString().slice(0, 10);

async function app() {
  const fake = new FakePayments();
  const t = await createTestApp({ overrides: { payments: fake } });
  return { ...t, fake };
}

/** Owner sends a proposal to `email` through the real staff routes; returns the /q/<token> path. */
async function proposalFor(t: Awaited<ReturnType<typeof app>>, email: string): Promise<string> {
  const lead = await t.client().request("POST", "/api/leads", { body: JSON.stringify({ name: "Jordan Admin", email, company: "Admin Co", interest: "custom", message: "We need a custom site with ordering.", source: "quote_form" }), headers: { "content-type": "application/json" } });
  assert.equal(lead.status, 201);
  const leadId = ((await lead.json()) as { leadId: string }).leadId;
  const o = await createStaff(t.db, "owner", `owner-${newId("x")}@crestmont.test`);
  const oc = await t.client().login(o.email);
  for (const to of ["qualified", "quote_required"]) assert.equal((await oc.post(`/staff/crm/leads/${leadId}/stage`, { to })).status, 303);
  const save = await oc.post(`/staff/quotes/new?lead=${leadId}`, { package: "custom", line_desc: ["Ordering site", ""], line_amount: ["6,000", ""], scope: "Custom ordering website with admin portal and 3 revision rounds.", valid_until: future() });
  assert.equal(save.status, 303);
  const quoteId = loc(save).split("/").pop()!;
  assert.equal((await oc.post(`/staff/quotes/${quoteId}/send`)).status, 303);
  return linkFrom((await lastEmail(t.db, email))!.text_body, "/q/");
}

async function sessionActor(db: Env["DB"], c: TestClient) {
  const s = await loadSession(db, c.cookies.get("cm_session"));
  assert.ok(s, "a session exists");
  return s!;
}

test("[AUTH-003] [AUTH-007] FD-30: a customer administrator without MFA can sign in and browse, but checkout, proposal acceptance, team invitations and data export are sent to enrolment and create nothing", async () => {
  const t = await app();
  const cu = await createCustomer(t.db, "unenrolled-admin@fd30.example", "Unenrolled Admin Co", { mfa: false });
  const qpath = await proposalFor(t, cu.email);
  const c = t.client();
  const signIn = await c.post("/login", { email: cu.email, password: TEST_PASSWORD });
  assert.equal(signIn.status, 303);
  assert.equal(loc(signIn), "/portal", "password sign-in completes: there is no factor to ask for yet");

  // Browsing (read-only) works and says what is needed.
  const dash = await c.get("/portal");
  assert.equal(dash.status, 200);
  assert.match(await dash.text(), /Set up two-factor authentication to continue/);
  for (const p of ["/portal/projects", "/portal/billing", "/portal/team", "/portal/support", "/checkout/starter"]) assert.equal((await c.get(p)).status, 200, p);
  const account = await (await c.get("/account")).text();
  assert.match(account, /Required for account administrators/);
  assert.doesNotMatch(account, /Optional for customers/);
  assert.match(await (await c.get("/portal/billing")).text(), /data-mfa-setup-link/);
  const proposal = await (await c.get(qpath)).text();
  assert.match(proposal, /data-mfa-required/);
  assert.doesNotMatch(proposal, /action="\/q\/[0-9a-f]+\/accept"/, "no accept form until enrolled");

  // Administrator permissions do not apply to this session.
  const s = await sessionActor(t.db, c);
  assert.equal(s.mfaVerified, true, "sign-in itself is complete (no authenticator yet)");
  assert.equal(s.actor.mfaVerified, false);
  assert.equal(can(s.actor, "customer.billing", { organizationId: cu.organizationId }), false);
  assert.equal(can(s.actor, "customer.approve", { organizationId: cu.organizationId }), false);
  assert.equal(can(s.actor, "customer.org.read", { organizationId: cu.organizationId }), true, "member-level read stays");

  // Every privileged action is routed to enrolment with a clear message, and nothing is created.
  const attempts: [string, Record<string, string>][] = [
    ["/checkout/starter", { terms: "1" }],
    [`${qpath}/accept`, { agree: "1" }],
    ["/portal/team", { email: "colleague@fd30.example", role: "customer_member" }],
    ["/portal/billing/refund-request", { payment_id: "pay_x", amount: "10", reason: "test" }],
    ["/account/privacy/export", {}],
    ["/account/privacy/delete", { confirm: "DELETE" }],
  ];
  for (const [path, fields] of attempts) {
    const r = await c.post(path, fields);
    assert.equal(r.status, 303, path);
    assert.match(loc(r), /^\/mfa\/setup\?next=%2F/, `${path} → enrolment`);
    const flash = decodeURIComponent(c.cookies.get("cm_flash") ?? "");
    assert.match(flash, /Set up two-factor authentication to continue/, `${path} explains why`);
  }
  assert.equal(t.fake.checkouts.length, 0, "no Stripe checkout started");
  assert.equal(await n(t.db, `SELECT COUNT(*) AS n FROM orders`), 0, "no order");
  assert.equal(await n(t.db, `SELECT COUNT(*) AS n FROM invitations WHERE email = 'colleague@fd30.example'`), 0, "no invitation");
  assert.equal(await n(t.db, `SELECT COUNT(*) AS n FROM quote_versions WHERE accepted_at IS NOT NULL`), 0, "proposal not accepted");
  assert.equal(await n(t.db, `SELECT COUNT(*) AS n FROM privacy_requests`), 0, "no privacy request");

  // A proposal form posted from the proposal page returns there after enrolment.
  const fromPage = await c.request("POST", `${qpath}/accept`, { body: new URLSearchParams({ _csrf: c.cookies.get("cm_csrf")!, agree: "1" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://crestmont.test", referer: `http://crestmont.test${qpath}` } });
  assert.equal(loc(fromPage), `/mfa/setup?next=${encodeURIComponent(qpath)}`);

  // Enrol through the real pages (shows recovery codes once), then the same actions succeed.
  const enrolled = await c.enrolMfa(qpath);
  assert.match(enrolled.page, new RegExp(`href="${qpath.replace(/\//g, "\\/")}"`), "continue link returns to the proposal");
  const after = await sessionActor(t.db, c);
  assert.equal(after.actor.mfaVerified, true);
  const invite = await c.post("/portal/team", { email: "colleague@fd30.example", role: "customer_member" });
  assert.equal(loc(invite), "/portal/team");
  assert.equal(await n(t.db, `SELECT COUNT(*) AS n FROM invitations WHERE email = 'colleague@fd30.example'`), 1);
  const accept = await c.post(`${qpath}/accept`, { agree: "1" });
  assert.match(loc(accept), /^\/portal\/billing\/invoices\/inv_/, "proposal accepted after enrolment");
  const checkout = await c.post("/checkout/starter", { terms: "1", maintenance_plan: "essential" });
  assert.equal(checkout.status, 303);
  assert.match(loc(checkout), /^https:\/\/checkout\.stripe\.com\//);
  assert.equal(t.fake.checkouts.length, 1);

  // Next sign-in: the code is now required before anything (as for staff).
  const again = t.client();
  const r = await again.post("/login", { email: cu.email, password: TEST_PASSWORD });
  assert.match(loc(r), /^\/mfa/);
  await t.db.prepare(`UPDATE users SET totp_last_step = NULL WHERE id = ?`).bind(cu.id).run();
  await again.login(cu.email); // harness remembers the enrolled secret
  assert.equal(loc(await again.post("/portal/team", { email: "second@fd30.example" })), "/portal/team");
});

test("[AUTH-003] [AUTH-007] FD-30: a customer administrator with an authenticator who skips the code has no administrator permissions and is sent to the code prompt", async () => {
  const t = await app();
  const cu = await createCustomer(t.db, "enrolled-admin@fd30.example", "Enrolled Admin Co");
  assert.ok(cu.secret, "createCustomer enrols TOTP by default (FD-30)");
  const half = t.client();
  const r = await half.post("/login", { email: cu.email, password: TEST_PASSWORD });
  assert.equal(r.status, 303);
  assert.match(loc(r), /^\/mfa/);
  const s = await sessionActor(t.db, half);
  assert.equal(s.mfaVerified, false);
  assert.equal(s.actor.mfaVerified, false);
  for (const perm of ["customer.billing", "customer.approve", "customer.org.write"] as const) assert.equal(can(s.actor, perm, { organizationId: cu.organizationId }), perm === "customer.org.write", perm);
  assert.match(loc(await half.get("/portal")), /^\/mfa\?next=/, "portal needs the code first");
  assert.match(loc(await half.get("/portal/billing")), /^\/mfa\?next=/);
  for (const [path, fields] of [["/checkout/starter", { terms: "1" }], ["/portal/team", { email: "x@fd30.example" }], ["/account/privacy/export", {}]] as const) {
    const res = await half.post(path, fields);
    assert.equal(res.status, 303, path);
    assert.match(loc(res), /^\/mfa\?next=/, `${path} → code prompt (not enrolment: already enrolled)`);
  }
  assert.equal(t.fake.checkouts.length, 0);
  assert.equal(await n(t.db, `SELECT COUNT(*) AS n FROM invitations`), 0);
  // Completing the code unlocks the administrator.
  await t.db.prepare(`UPDATE users SET totp_last_step = NULL WHERE id = ?`).bind(cu.id).run();
  const ok = await t.client().login(cu.email, TEST_PASSWORD, cu.secret!);
  assert.equal((await sessionActor(t.db, ok)).actor.mfaVerified, true);
  assert.equal(loc(await ok.post("/portal/team", { email: "x@fd30.example" })), "/portal/team");
});

test("[AUTH-002] FD-30: a customer administrator can sign in with a recovery code and can regenerate recovery codes", async () => {
  const t = await app();
  const cu = await createCustomer(t.db, "recovery-admin@fd30.example", "Recovery Admin Co", { mfa: false });
  const c = await t.client().login(cu.email);
  const { page, secret } = await c.enrolMfa();
  const codes = [...page.matchAll(/<li><code>([^<]+)<\/code><\/li>/g)].map((m) => m[1]);
  assert.ok(codes.length >= 8, "recovery codes shown once at enrolment");
  // Lost phone: password, then a recovery code instead of the 6-digit code.
  const lost = t.client();
  assert.match(loc(await lost.post("/login", { email: cu.email, password: TEST_PASSWORD })), /^\/mfa/);
  const rec = await lost.post("/mfa", { code: codes[0] });
  assert.equal(rec.status, 303);
  assert.equal(loc(rec), "/portal");
  assert.match(decodeURIComponent(lost.cookies.get("cm_flash") ?? ""), /recovery code/);
  assert.equal((await sessionActor(t.db, lost)).actor.mfaVerified, true, "a recovery code is a valid second factor");
  assert.equal(loc(await lost.post("/portal/team", { email: "after-recovery@fd30.example" })), "/portal/team");
  assert.equal(await n(t.db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'user.mfa_recovery_code_used' AND subject_id = ?`, cu.id), 1);
  assert.equal((await lastEmail(t.db, cu.email))?.template, "security_notification");
  // The same recovery code does not work twice.
  const replay = t.client();
  await replay.post("/login", { email: cu.email, password: TEST_PASSWORD });
  assert.equal((await replay.post("/mfa", { code: codes[0] })).status, 401);
  // Regenerating recovery codes from the account page works for the administrator.
  await t.db.prepare(`UPDATE users SET totp_last_step = NULL WHERE id = ?`).bind(cu.id).run();
  const { totpCode } = await import("../src/lib/auth-crypto.ts");
  const regen = await lost.post("/account/mfa/recovery-codes", { code: await totpCode(secret) });
  assert.equal(regen.status, 200);
  assert.match(await regen.text(), /data-testid="recovery-codes"/);
});

test("[AUTH-003] FD-30: customer members keep MFA optional — a member without an authenticator signs in and uses member features; administrator actions stay refused as before", async () => {
  const t = await app();
  const admin = await createCustomer(t.db, "org-admin@fd30.example", "Member Co");
  const member = newId("usr");
  await t.db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, created_at) SELECT ?, 'plain-member@fd30.example', 'Member', password_hash, ?, ? FROM users WHERE id = ?`).bind(member, nowIso(), nowIso(), admin.id).run();
  await t.db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?, 'customer_member', ?)`).bind(newId("mbr"), member, admin.organizationId, nowIso()).run();
  const m = t.client();
  const r = await m.post("/login", { email: "plain-member@fd30.example", password: TEST_PASSWORD });
  assert.equal(loc(r), "/portal", "no second factor needed for a member");
  const s = await sessionActor(t.db, m);
  assert.equal(s.actor.mfaVerified, true, "unchanged: members without MFA are fully signed in");
  assert.equal(can(s.actor, "customer.org.write", { organizationId: admin.organizationId }), true);
  const dash = await (await m.get("/portal")).text();
  assert.doesNotMatch(dash, /data-mfa-reminder/);
  assert.match(await (await m.get("/account")).text(), /Optional for team members/);
  const ticket = await m.post("/portal/support/new", { subject: "Member question", category: "account", description: "A question from a team member." });
  assert.equal(ticket.status, 303);
  assert.doesNotMatch(loc(ticket), /^\/mfa/);
  // Administrator actions: refused for a member exactly as before FD-30 (403, not an enrolment prompt).
  assert.equal((await m.post("/portal/team", { email: "y@fd30.example" })).status, 403);
  assert.equal((await m.post("/checkout/starter", { terms: "1" })).status, 403);
});

test("[AUTH-003] FD-30: an unenrolled customer administrator can still open a support ticket and manage their own account security", async () => {
  const t = await app();
  const cu = await createCustomer(t.db, "help-admin@fd30.example", "Help Co", { mfa: false });
  const c = await t.client().login(cu.email);
  const ticket = await c.post("/portal/support/new", { subject: "Cannot set up my authenticator", category: "account", description: "My phone is new; please help." });
  assert.equal(ticket.status, 303);
  assert.doesNotMatch(loc(ticket), /^\/mfa/);
  assert.equal(loc(await c.post("/account/profile", { display_name: "Help Admin" })), "/account/profile");
  assert.equal((await c.post("/account/sessions/revoke-others")).status, 303);
  assert.equal(loc(await c.post("/logout")), "/");
});
