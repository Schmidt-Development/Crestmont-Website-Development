// CREST-GAP-001 / CREST-GAP-004 adversarial tests: an invitation (staff or customer team) must never hand a role
// to an account the invitee does not own, and CRM data must never attach to an unproven email address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, lastEmail, linkFrom, TEST_PASSWORD } from "./support/app.ts";
import { createInvitation, acceptInvitation, AuthError } from "../src/services/auth.ts";
import { nowIso } from "../src/lib/db.ts";

const ATTACKER_PW = "attacker-chosen-pass-77q";
const INVITEE_PW = "employee-chosen-pass-55z";

async function inviteStaffVia(app: Awaited<ReturnType<typeof createTestApp>>, email: string, role = "developer") {
  const owner = await createStaff(app.db, "owner", `owner${Math.random().toString(36).slice(2, 8)}@crestmont.test`);
  const o = await app.client().login(owner.email, undefined, owner.secret);
  const res = await o.post("/staff/employees/invite", { email, role });
  return { res, owner, link: res.status === 303 ? linkFrom((await lastEmail(app.db, email))!.text_body, "/invite") : null };
}

test("[AUTH-006] [SEC-001] pre-registered unverified account cannot capture a staff invitation (CREST-GAP-001)", async () => {
  const app = await createTestApp();
  const attacker = app.client();
  assert.ok([200, 303].includes((await attacker.post("/register", { name: "Attacker", organization: "Shell Co", email: "newhire@crestmont.test", password: ATTACKER_PW, terms: "on" })).status));
  // The attacker is signed in to the unverified account before the invitation is accepted.
  assert.equal((await app.client().post("/login", { email: "newhire@crestmont.test", password: ATTACKER_PW })).status, 303);
  const attackerSession = app.client();
  await attackerSession.post("/login", { email: "newhire@crestmont.test", password: ATTACKER_PW });

  const { link } = await inviteStaffVia(app, "newhire@crestmont.test");
  const employee = app.client();
  const page = await employee.get(link!);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Choose a password/, "the invitee sets their own password; nothing reveals an existing account");
  const token = new URL(link!, "http://x").searchParams.get("token")!;
  assert.equal((await employee.post("/invite", { token, name: "Real Employee", password: INVITEE_PW })).status, 303);

  // The attacker's password no longer works; the invitee's does and is forced into MFA enrolment.
  assert.equal((await app.client().post("/login", { email: "newhire@crestmont.test", password: ATTACKER_PW })).status, 400);
  const real = app.client();
  const ok = await real.post("/login", { email: "newhire@crestmont.test", password: INVITEE_PW });
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get("location") ?? "", /^\/mfa/);
  // The attacker's pre-existing session was revoked.
  const stale = await attackerSession.get("/portal");
  assert.notEqual(stale.status, 200, "pre-acceptance session must be invalid");

  const u = await app.db.prepare(`SELECT id, email_verified_at, totp_secret, mfa_enabled FROM users WHERE email = 'newhire@crestmont.test'`).first<{ id: string; email_verified_at: string | null; totp_secret: string | null; mfa_enabled: number }>();
  assert.ok(u!.email_verified_at, "address is now verified (proven by the token)");
  assert.equal(u!.totp_secret, null);
  const memberships = (await app.db.prepare(`SELECT o.kind, m.role_id FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ?`).bind(u!.id).all<{ kind: string; role_id: string }>()).results;
  assert.deepEqual(memberships.map((m) => ({ ...m })), [{ kind: "internal", role_id: "developer" }], "the self-created customer org membership is removed");
  const ev = await app.db.prepare(`SELECT COUNT(*) AS n FROM security_events WHERE kind = 'account_reclaimed_by_invitation' AND user_id = ?`).bind(u!.id).first<{ n: number }>();
  assert.equal(ev!.n, 1, "reclaim is recorded as a security event");
});

test("[AUTH-006] [SEC-001] attacker who enrolled MFA on the unverified account loses it on reclaim (CREST-GAP-001)", async () => {
  const app = await createTestApp();
  await app.client().post("/register", { name: "Attacker", organization: "Shell Co", email: "pm@crestmont.test", password: ATTACKER_PW, terms: "on" });
  const uid = (await app.db.prepare(`SELECT id FROM users WHERE email = 'pm@crestmont.test'`).first<{ id: string }>())!.id;
  await app.db.prepare(`UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP', mfa_enabled = 1 WHERE id = ?`).bind(uid).run();
  await app.db.prepare(`INSERT INTO mfa_recovery_codes (id, user_id, lookup, code_hash, created_at) VALUES ('rc1', ?, 'abcd', 'x', ?)`).bind(uid, nowIso()).run();
  await app.db.prepare(`INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES ('h1', ?, 'password_reset', ?, ?)`).bind(uid, new Date(Date.now() + 3600e3).toISOString(), nowIso()).run();
  const { link } = await inviteStaffVia(app, "pm@crestmont.test", "project_manager");
  const token = new URL(link!, "http://x").searchParams.get("token")!;
  assert.equal((await app.client().post("/invite", { token, name: "Real PM", password: INVITEE_PW })).status, 303);
  const u = await app.db.prepare(`SELECT totp_secret, mfa_enabled FROM users WHERE id = ?`).bind(uid).first<{ totp_secret: string | null; mfa_enabled: number }>();
  assert.equal(u!.totp_secret, null);
  assert.equal(u!.mfa_enabled, 0);
  assert.equal((await app.db.prepare(`SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ?`).bind(uid).first<{ n: number }>())!.n, 0);
  assert.equal((await app.db.prepare(`SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ? AND used_at IS NULL`).bind(uid).first<{ n: number }>())!.n, 0, "outstanding reset tokens are revoked");
});

test("[AUTH-006] [SEC-001] verified existing account: the invitation alone grants nothing; signed-in holder can accept (CREST-GAP-001)", async () => {
  const app = await createTestApp();
  const owner = await createStaff(app.db, "owner");
  const a = await createCustomer(app.db, "admin@a.example", "Org A");
  const b = await createCustomer(app.db, "member@b.example", "Org B");
  const token = await createInvitation(app.db, a.id, b.email, "customer_member", a.organizationId);
  // Someone with only the token (not signed in) cannot accept or change the password.
  const anon = app.client();
  const page = await anon.get(`/invite?token=${token}`);
  assert.match(await page.text(), /Sign in to that account/);
  const res = await anon.post("/invite", { token, name: "X", password: ATTACKER_PW });
  assert.equal(res.status, 403);
  await assert.rejects(acceptInvitation(app.db, token, "X", ATTACKER_PW), (e: unknown) => e instanceof AuthError && e.status === 403);
  assert.equal((await app.client().post("/login", { email: b.email, password: TEST_PASSWORD })).status, 303, "existing password unchanged");
  // A different signed-in user cannot accept it either.
  const other = await app.client().login(a.email);
  assert.equal((await other.post("/invite", { token })).status, 403);
  // The account holder, signed in, accepts with one click.
  const holder = await app.client().login(b.email);
  const ok = await holder.post("/invite", { token });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/portal");
  const m = await app.db.prepare(`SELECT role_id FROM memberships WHERE user_id = ? AND organization_id = ?`).bind(b.id, a.organizationId).first<{ role_id: string }>();
  assert.equal(m!.role_id, "customer_member");
  assert.equal((await holder.post("/invite", { token })).status, 400, "single use");
  void owner;
});

test("[AUTH-006] [SEC-001] customer-team invitation gets the same reclaim protection (CREST-GAP-001)", async () => {
  const app = await createTestApp();
  const a = await createCustomer(app.db, "admin@team.example", "Team Org");
  await app.client().post("/register", { name: "Attacker", organization: "Evil", email: "colleague@team.example", password: ATTACKER_PW, terms: "on" });
  const token = await createInvitation(app.db, a.id, "colleague@team.example", "customer_admin", a.organizationId);
  assert.equal((await app.client().post("/invite", { token, name: "Real Colleague", password: INVITEE_PW })).status, 303);
  assert.equal((await app.client().post("/login", { email: "colleague@team.example", password: ATTACKER_PW })).status, 400);
  assert.equal((await app.client().post("/login", { email: "colleague@team.example", password: INVITEE_PW })).status, 303);
  const orgs = (await app.db.prepare(`SELECT m.organization_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'colleague@team.example'`).all<{ organization_id: string }>()).results;
  assert.deepEqual(orgs.map((o) => o.organization_id), [a.organizationId]);
});

test("[AUTH-006] [SEC-001] staff invitation to a verified customer account is refused; to an unverified one it is allowed (CREST-GAP-001)", async () => {
  const app = await createTestApp();
  await createCustomer(app.db, "buyer@example.com", "Buyer Co");
  const { res } = await inviteStaffVia(app, "buyer@example.com");
  assert.notEqual(res.status, 303);
  assert.match(await res.text(), /belongs to a customer account/);
  assert.equal((await app.db.prepare(`SELECT COUNT(*) AS n FROM invitations WHERE email = 'buyer@example.com'`).first<{ n: number }>())!.n, 0);
  await app.client().post("/register", { name: "Someone", organization: "X", email: "blocker@crestmont.test", password: ATTACKER_PW, terms: "on" });
  const second = await inviteStaffVia(app, "blocker@crestmont.test");
  assert.equal(second.res.status, 303, "pre-registering an address cannot block its invitation");
});

test("[AUTH-006] [SEC-001] concurrent acceptances of one invitation grant the role once (CREST-GAP-001)", async () => {
  const app = await createTestApp();
  await createStaff(app.db, "owner");
  const org = (await app.db.prepare(`SELECT id FROM organizations WHERE kind = 'internal'`).first<{ id: string }>())!.id;
  const owner = (await app.db.prepare(`SELECT id FROM users LIMIT 1`).first<{ id: string }>())!.id;
  const token = await createInvitation(app.db, owner, "race@crestmont.test", "sales", org);
  const results = await Promise.allSettled([acceptInvitation(app.db, token, "A", INVITEE_PW), acceptInvitation(app.db, token, "B", "another-password-xyz-12")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await app.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE email = 'race@crestmont.test'`).first<{ n: number }>())!.n, 1);
});

test("[SEC-006] CRM contacts link only after the email is verified (CREST-GAP-004)", async () => {
  const app = await createTestApp();
  await app.db.prepare(`INSERT INTO contacts (id, name, email, phone, created_at) VALUES ('ct_v','Victim Person','Victim@Example.com','+15551234567',?)`).bind(nowIso()).run();
  const att = app.client();
  assert.ok([200, 303].includes((await att.post("/register", { name: "Attacker", organization: "Evil Co", email: "victim@example.com", password: ATTACKER_PW, terms: "on" })).status));
  const linked = await app.db.prepare(`SELECT user_id FROM contacts WHERE id = 'ct_v'`).first<{ user_id: string | null }>();
  assert.equal(linked!.user_id, null, "not linked before verification");
  await att.post("/login", { email: "victim@example.com", password: ATTACKER_PW });
  const exp = await att.post("/account/privacy/export");
  const body = await exp.text();
  assert.doesNotMatch(body, /Victim Person|5551234567/, "export holds no CRM data for an unproven address");
  // After the real owner verifies, the contact is linked (case-insensitive).
  const mail = await lastEmail(app.db, "victim@example.com");
  const v = app.client();
  const vr = await v.get(linkFrom(mail!.text_body, "/verify-email"));
  assert.ok(vr.status === 303 || vr.status === 200);
  const after = await app.db.prepare(`SELECT user_id FROM contacts WHERE id = 'ct_v'`).first<{ user_id: string | null }>();
  assert.ok(after!.user_id, "linked after verification");
});
