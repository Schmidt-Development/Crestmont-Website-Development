// Regression tests for the security & legal readiness review (2026-10-28):
// findings F-20 (lockout password oracle), F-21 (quarantined downloads), F-22 (reset links after a reset),
// F-25 (legal holds), and the provider-independent malware-scan verdict path (F-02).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, lastEmail, linkFrom, TEST_PASSWORD } from "./support/app.ts";
import { LOCK_AFTER, LOCKED_MESSAGE } from "../src/services/auth.ts";
import { storeUpload } from "../src/services/files.ts";
import { recordScanResult, filesAwaitingScan, ScanResultError } from "../src/services/malware-scan.ts";
import { placeHold, releaseHold, activeHolds, LegalHoldError } from "../src/services/legal-holds.ts";
import { runRetention } from "../src/services/retention.ts";
import { processDeletion, requestDeletion, PrivacyError, buildExport } from "../src/services/privacy.ts";
import { postMessage, MessageError } from "../src/services/messages.ts";
import { stepUpAction } from "../src/app/step-up.ts";
import { newId } from "../src/lib/db.ts";
import { newTotpSecret } from "../src/lib/auth-crypto.ts";

const PDF = new TextEncoder().encode("%PDF-1.4\n% test document\n");
const NEW_PASSWORD = "an-entirely-different-passphrase-42";

const loginMessage = async (res: Response) => {
  const body = await res.text();
  return body.includes(LOCKED_MESSAGE) ? "locked" : /Email or password is incorrect/.test(body) ? "incorrect" : /Too many sign-in attempts/.test(body) ? "rate_limited" : `other:${res.status}`;
};

test("[AUTH-005] lockout does not confirm a correct password: a locked account answers 'locked' to right and wrong passwords alike", async () => {
  const { db, client } = await createTestApp();
  const cust = await createCustomer(db, "lock-oracle@example.com");
  const c = client();
  for (let i = 0; i < LOCK_AFTER; i++) await c.post("/login", { email: cust.email, password: `wrong-guess-${i}-xx` });
  assert.ok((await db.prepare(`SELECT locked_until FROM users WHERE id = ?`).bind(cust.id).first<{ locked_until: string | null }>())?.locked_until, "locked after the threshold");
  const wrong = await loginMessage(await c.post("/login", { email: cust.email, password: "yet-another-wrong-guess" }));
  const right = await c.post("/login", { email: cust.email, password: TEST_PASSWORD });
  assert.equal(right.status, 400, "no session for the right password while locked");
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM sessions WHERE user_id = ?`).bind(cust.id).first<{ n: number }>())?.n, 0, "no session created");
  assert.equal(wrong, "locked");
  assert.equal(await loginMessage(right), "locked", "the right password gets exactly the same answer as a wrong one");
  const ev = await db.prepare(`SELECT COUNT(*) n FROM security_events WHERE kind = 'login_blocked_locked' AND user_id = ?`).bind(cust.id).first<{ n: number }>();
  assert.equal(ev?.n, 2);
});

test("[AUTH-005] lockout does not reveal which emails have accounts: an unknown address locks the same way", async () => {
  const { db, client } = await createTestApp();
  const known = await createCustomer(db, "known@example.com");
  const answers = async (email: string) => {
    const c = client();
    const seen: string[] = [];
    for (let i = 0; i < LOCK_AFTER + 1; i++) seen.push(await loginMessage(await c.post("/login", { email, password: `wrong-guess-${i}-xx` })));
    return seen;
  };
  const a = await answers(known.email), b = await answers("nobody-here@example.com");
  assert.deepEqual(a, b, "identical answer sequence for an existing and a non-existent account");
  assert.equal(a.at(-1), "locked");
  assert.ok(a.slice(0, LOCK_AFTER).every((x) => x === "incorrect"));
});

test("[AUTH-002] resetting or changing a password invalidates every other outstanding reset link", async () => {
  const { db, client } = await createTestApp();
  const cust = await createCustomer(db, "reset-links@example.com");
  await client().post("/password/forgot", { email: cust.email });
  const first = linkFrom((await lastEmail(db, cust.email))!.text_body, "/password/reset");
  await client().post("/password/forgot", { email: cust.email });
  const second = linkFrom((await lastEmail(db, cust.email))!.text_body, "/password/reset");
  assert.notEqual(first, second);
  const token = (u: string) => new URL(u, "http://x").searchParams.get("token")!;
  const used = await client().post("/password/reset", { token: token(second), password: NEW_PASSWORD });
  assert.equal(used.status, 303, "second link resets the password");
  const stale = await client().post("/password/reset", { token: token(first), password: "attacker-chosen-passphrase-99" });
  assert.equal(stale.status, 400, "the earlier link no longer works");
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM auth_tokens WHERE user_id = ? AND purpose = 'password_reset' AND used_at IS NULL`).bind(cust.id).first<{ n: number }>())?.n, 0);

  // Change password (signed in) also kills a pending reset link.
  await client().post("/password/forgot", { email: cust.email });
  const third = token(linkFrom((await lastEmail(db, cust.email))!.text_body, "/password/reset"));
  const signed = await client().login(cust.email, NEW_PASSWORD);
  const changed = await signed.post("/account/password", { current: NEW_PASSWORD, next: "a-third-strong-passphrase-77" });
  assert.ok([200, 303].includes(changed.status), `change password accepted (${changed.status})`);
  assert.equal((await client().post("/password/reset", { token: third, password: "attacker-chosen-passphrase-99" })).status, 400);
});

async function fileSetup() {
  const app = await createTestApp();
  const cust = await createCustomer(app.db, "scan-owner@example.com", "Scan Org");
  const f = await storeUpload({ db: app.db, storage: app.storage }, { organizationId: cust.organizationId, projectId: null, file: new File([PDF], "brief.pdf"), uploadedBy: cust.id });
  const c = await app.client().login(cust.email);
  return { ...app, cust, f, c };
}

test("[SEC-003] quarantined files (infected or failed scan) cannot be downloaded or previewed; pending ones still can", async () => {
  const t = await fileSetup();
  assert.equal((await t.c.get(`/files/${t.f.id}`)).status, 200, "pending (no scanner yet) stays downloadable");
  for (const status of ["failed", "infected"]) {
    await t.db.prepare(`UPDATE files SET scan_status = ? WHERE id = ?`).bind(status, t.f.id).run();
    for (const path of [`/files/${t.f.id}`, `/files/${t.f.id}?inline=1`]) {
      const res = await t.c.get(path);
      assert.equal(res.status, 409, `${status} ${path} refused`);
      assert.doesNotMatch(await res.text(), /%PDF/, "no file bytes in the refusal");
    }
  }
  const blocked = await t.db.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'file.download_blocked' AND subject_id = ?`).bind(t.f.id).first<{ n: number }>();
  assert.equal(blocked?.n, 4, "every blocked attempt is audited");
});

test("[SEC-003] [F-02] scan verdicts: bound to the stored bytes, infected is terminal and revokes share links, history is append-only", async () => {
  const t = await fileSetup();
  assert.deepEqual((await filesAwaitingScan(t.db)).map((x) => x.id), [t.f.id]);
  await assert.rejects(recordScanResult(t.db, { fileId: t.f.id, verdict: "clean", engine: "test-engine 1", scannedSha256: "0".repeat(64) }), (e: unknown) => e instanceof ScanResultError && e.status === 409, "verdict for other bytes refused");
  await assert.rejects(recordScanResult(t.db, { fileId: t.f.id, verdict: "infected", engine: "test-engine 1", scannedSha256: t.f.sha256 }), ScanResultError, "infected needs a detection name");
  await assert.rejects(recordScanResult(t.db, { fileId: t.f.id, verdict: "clean", engine: "", scannedSha256: t.f.sha256 }), ScanResultError, "engine required");

  const failed = await recordScanResult(t.db, { fileId: t.f.id, verdict: "failed", engine: "test-engine 1", scannedSha256: t.f.sha256, detail: "timeout" });
  assert.equal(failed.current, "failed");
  assert.equal((await filesAwaitingScan(t.db)).length, 1, "failed scans are retried");
  const clean = await recordScanResult(t.db, { fileId: t.f.id, verdict: "clean", engine: "test-engine 1", scannedSha256: t.f.sha256.toUpperCase() });
  assert.equal(clean.current, "clean");
  assert.equal((await filesAwaitingScan(t.db)).length, 0);

  const share = await t.c.post(`/files/${t.f.id}/share`, { hours: "24" });
  assert.equal(share.status, 201, "clean file shares without the unscanned acknowledgement");
  const infected = await recordScanResult(t.db, { fileId: t.f.id, verdict: "infected", engine: "test-engine 2", scannedSha256: t.f.sha256, signature: "Test.Signature" });
  assert.deepEqual({ current: infected.current, sharesRevoked: infected.sharesRevoked }, { current: "infected", sharesRevoked: 1 });
  assert.equal((await t.db.prepare(`SELECT COUNT(*) n FROM share_links WHERE file_id = ? AND revoked_at IS NULL`).bind(t.f.id).first<{ n: number }>())?.n, 0);
  const again = await recordScanResult(t.db, { fileId: t.f.id, verdict: "clean", engine: "test-engine 3", scannedSha256: t.f.sha256 });
  assert.equal(again.current, "infected", "a later clean verdict cannot lift an infection");
  assert.equal((await t.c.get(`/files/${t.f.id}`)).status, 409);

  assert.equal((await t.db.prepare(`SELECT COUNT(*) n FROM file_scans WHERE file_id = ?`).bind(t.f.id).first<{ n: number }>())?.n, 4);
  await assert.rejects(t.db.prepare(`DELETE FROM file_scans`).run(), /append-only/);
  await assert.rejects(t.db.prepare(`UPDATE file_scans SET verdict = 'clean'`).run(), /append-only/);
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'file.quarantined' AND subject_id = ?`).bind(t.f.id).first());
});

test("[SEC-006] legal holds: retention keeps held data, anonymisation waits, holds are immutable and released once", async () => {
  const t = await fileSetup();
  const owner = await createStaff(t.db, "owner");
  const other = await createCustomer(t.db, "other-org@example.com", "Other Org");
  const otherFile = await storeUpload({ db: t.db, storage: t.storage }, { organizationId: other.organizationId, projectId: null, file: new File([PDF], "x.pdf"), uploadedBy: other.id });
  const old = new Date(Date.now() - 400 * 86400e3).toISOString();
  await t.db.batch([
    t.db.prepare(`UPDATE files SET deleted_at = ?`).bind(old),
    t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('retention.deleted_files_days', '30', ?), ('retention.security_events_days', '365', ?)`).bind(old, old),
    t.db.prepare(`INSERT INTO security_events (kind, user_id, email, detail, created_at) VALUES ('login_failed', ?, 'a@x', 'held', ?), ('login_failed', ?, 'b@x', 'free', ?)`).bind(t.cust.id, old, other.id, old),
  ]);

  await assert.rejects(placeHold(t.db, { scope: "organization", reason: "Chargeback dispute" }), LegalHoldError);
  await assert.rejects(placeHold(t.db, { scope: "user", subjectId: "usr_missing", reason: "Investigation" }), LegalHoldError);
  const orgHold = await placeHold(t.db, { scope: "organization", subjectId: t.cust.organizationId, reason: "Chargeback dispute", matterReference: "CB-1", placedBy: owner.id });
  await placeHold(t.db, { scope: "user", subjectId: t.cust.id, reason: "Security investigation", placedBy: owner.id });

  await runRetention({ db: t.db, storage: t.storage });
  const purged = async (id: string) => !!(await t.db.prepare(`SELECT purged_at FROM files WHERE id = ?`).bind(id).first<{ purged_at: string | null }>())?.purged_at;
  assert.equal(await purged(t.f.id), false, "held organization's deleted file kept");
  assert.equal(await purged(otherFile.id), true, "other organization's deleted file purged as configured");
  const events = (await t.db.prepare(`SELECT detail FROM security_events WHERE created_at = ?`).bind(old).all<{ detail: string }>()).results.map((r) => r.detail);
  assert.deepEqual(events, ["held"], "held user's security events kept, others deleted");

  const req = await requestDeletion(t.db, t.cust.id, "please delete");
  await assert.rejects(processDeletion(t.db, owner.id, req, "complete", ""), (e: unknown) => e instanceof PrivacyError && e.status === 409);
  assert.equal((await t.db.prepare(`SELECT email FROM users WHERE id = ?`).bind(t.cust.id).first<{ email: string }>())?.email, t.cust.email, "not anonymised while held");

  // Global hold: the configurable tier and old sessions are left alone entirely.
  const g = await placeHold(t.db, { scope: "global", reason: "Incident INC-1 evidence preservation", placedBy: owner.id });
  const res = await runRetention({ db: t.db, storage: t.storage });
  assert.ok(res.filter((r) => r.category !== "rate_limits" && r.category !== "auth_tokens" && r.category !== "env_metrics").every((r) => r.mode === "skipped" && r.affected === 0));
  assert.equal((await activeHolds(t.db)).global, true);

  await assert.rejects(t.db.prepare(`UPDATE legal_holds SET reason = 'changed' WHERE id = ?`).bind(orgHold).run(), /immutable/);
  await assert.rejects(t.db.prepare(`DELETE FROM legal_holds`).run(), /cannot be deleted/);
  await assert.rejects(releaseHold(t.db, g, { releasedBy: owner.id, note: "no" }), LegalHoldError, "release needs a reason");
  await releaseHold(t.db, g, { releasedBy: owner.id, note: "Incident closed; counsel approved release" });
  await assert.rejects(releaseHold(t.db, g, { releasedBy: owner.id, note: "Second release attempt" }), LegalHoldError);
  assert.equal((await activeHolds(t.db)).global, false);
  const audited = (await t.db.prepare(`SELECT action FROM audit_logs WHERE action LIKE 'legal_hold.%' OR action = 'privacy.deletion_blocked_by_hold' ORDER BY id`).all<{ action: string }>()).results.map((r) => r.action);
  assert.deepEqual(audited, ["legal_hold.placed", "legal_hold.placed", "privacy.deletion_blocked_by_hold", "legal_hold.placed", "legal_hold.released"]);
});

test("[SEC-007] findings register: fixed findings recorded as resolved; new open findings gate release", async () => {
  const { db } = await createTestApp();
  const rows = Object.fromEntries((await db.prepare(`SELECT id, status, release_blocking FROM security_findings`).all<{ id: string; status: string; release_blocking: number }>()).results.map((r) => [r.id, r]));
  for (const id of ["F-06", "F-08", "F-11", "F-13", "F-15", "F-20", "F-21", "F-22", "F-25", "F-26", "F-27", "F-28"]) assert.equal(rows[id]?.status, "resolved", id);
  for (const id of ["F-18", "F-19", "F-23"]) assert.deepEqual([rows[id]?.status, rows[id]?.release_blocking], ["open", 1], id);
  for (const id of ["F-01", "F-02", "F-03", "F-10", "F-16"]) assert.equal(rows[id]?.status, "open", `${id} stays open until externally resolved`);
});

test("[SEC-006] the self-service privacy export never contains staff internal notes", async () => {
  const t = await fileSetup();
  const staff = await createStaff(t.db, "project_manager");
  const at = new Date().toISOString();
  await t.db.batch([
    t.db.prepare(`INSERT INTO messages (id, organization_id, project_id, author_user_id, body, internal, created_at) VALUES (?,?,NULL,?,?,0,?)`).bind(newId("msg"), t.cust.organizationId, staff.id, "Visible reply to customer", at),
    t.db.prepare(`INSERT INTO messages (id, organization_id, project_id, author_user_id, body, internal, created_at) VALUES (?,?,NULL,?,?,1,?)`).bind(newId("msg"), t.cust.organizationId, staff.id, "INTERNAL: customer is slow to pay", at),
  ]);
  const text = JSON.stringify(await buildExport(t.db, t.cust.id));
  assert.match(text, /Visible reply to customer/);
  assert.doesNotMatch(text, /customer is slow to pay/, "internal note excluded");
});

test("[PORTAL-005] internal notes cannot carry attachments (files are visible to the customer organization)", async () => {
  const t = await fileSetup();
  const staff = await createStaff(t.db, "project_manager");
  const ctx = { db: t.db, storage: t.storage } as unknown as Parameters<typeof postMessage>[0];
  const before = (await t.db.prepare(`SELECT COUNT(*) n FROM files`).first<{ n: number }>())!.n;
  await assert.rejects(postMessage(ctx, { organizationId: t.cust.organizationId, projectId: null, authorUserId: staff.id, body: "see attached", internal: true, fromStaff: true, attachment: new File([PDF], "internal.pdf") }), MessageError);
  assert.equal((await t.db.prepare(`SELECT COUNT(*) n FROM files`).first<{ n: number }>())!.n, before, "nothing stored in the customer's files");
  const id = await postMessage(ctx, { organizationId: t.cust.organizationId, projectId: null, authorUserId: staff.id, body: "plain internal note", internal: true, fromStaff: true });
  assert.ok(id, "internal notes without attachments still work");
});

test("[AUTH-008] irreversible and Founder-protected actions require recent MFA (step-up)", async () => {
  const u = new URL("http://x/");
  for (const route of ["/staff/privacy/:id/process", "/staff/ops/retention", "/staff/pricing/:id/decide", "/staff/settings/tax", "/staff/settings/tax/jurisdictions", "/staff/employees/invitations/:id/revoke", "/portal/team", "/portal/team/members/:userId/role", "/portal/team/members/:userId/remove"]) {
    assert.ok(stepUpAction("POST", route, u), route);
  }
  const { db, client } = await createTestApp();
  const owner = await createStaff(db, "owner");
  const c = await client().login(owner.email, TEST_PASSWORD, owner.secret);
  await db.prepare(`UPDATE sessions SET mfa_verified_at = ? WHERE user_id = ?`).bind(new Date(Date.now() - 30 * 60e3).toISOString(), owner.id).run();
  const res = await c.post("/staff/ops/retention", { "retention.app_errors_days": "90" });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location") ?? "", /^\/mfa\/step-up/, "stale MFA is sent to step-up before retention changes");

  // Customer admin who enabled two-factor: team changes need a recent verification too; nothing is recorded before it.
  const cust = await createCustomer(db, "mfa-admin@example.com", "MFA Org");
  const secret = newTotpSecret();
  await db.prepare(`UPDATE users SET totp_secret = ?, mfa_enabled = 1 WHERE id = ?`).bind(secret, cust.id).run();
  const cc = await client().login(cust.email, TEST_PASSWORD, secret);
  await db.prepare(`UPDATE sessions SET mfa_verified_at = ? WHERE user_id = ?`).bind(new Date(Date.now() - 30 * 60e3).toISOString(), cust.id).run();
  for (const path of ["/portal/team", `/portal/team/members/${cust.id}/role`, `/portal/team/members/${cust.id}/remove`]) {
    const r = await cc.post(path, { email: "new-member@example.com", role: "customer_member" });
    assert.match(r.headers.get("location") ?? "", /^\/mfa\/step-up/, `${path} needs step-up`);
  }
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM invitations WHERE email = 'new-member@example.com'`).first<{ n: number }>())?.n, 0, "no invitation before step-up");
});
