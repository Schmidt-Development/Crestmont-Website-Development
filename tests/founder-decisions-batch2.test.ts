// Founder decisions (2026-11), batch 2: FD-14 five-business-day customer reviews (FD-15 silence is never approval),
// FD-24 quotes valid 30 days, FD-25 30 days' notice of subscription price increases, FD-38 90-day raw IPs and 180-day
// security logs. TEST DATA only; email goes to the development outbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, lastEmail } from "./support/app.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import type { Env } from "../src/app/context.ts";
import type { Actor } from "../src/domain/authz.ts";
import { addBusinessDays, customerReviewDeadline } from "../src/lib/business-time.ts";
import { validateQuoteInput, QUOTE_VALIDITY_DAYS } from "../src/services/quotes.ts";
import { proposePriceChange, decidePriceChange, SUBSCRIPTION_INCREASE_NOTICE_DAYS } from "../src/services/pricing-approvals.ts";
import { CONFIGURABLE_RULES, runRetention } from "../src/services/retention.ts";
import { provisionProject } from "../src/services/commerce.ts";
import { runReviewDeadlineSweep, requestCustomerApproval } from "../src/services/projects.ts";
import { OutboxEmail } from "../src/adapters/email.ts";

const DAY = 86_400_000;
const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;
const ownerActor = (o: { id: string; organizationId: string }): Actor => ({ kind: "user", userId: o.id, roles: [{ role: "owner", organizationId: o.organizationId }], mfaVerified: true });

test("[PM-002] FD-14: five business days skip weekends; the deadline is the end of that day in Eastern time", () => {
  assert.equal(addBusinessDays(new Date("2026-11-02T15:00:00Z"), 5), "2026-11-09", "Monday → next Monday");
  assert.equal(addBusinessDays(new Date("2026-11-06T15:00:00Z"), 5), "2026-11-13", "Friday → next Friday");
  assert.equal(addBusinessDays(new Date("2026-11-07T15:00:00Z"), 5), "2026-11-13", "Saturday → Friday");
  assert.equal(customerReviewDeadline(new Date("2026-11-02T15:00:00Z")), "2026-11-10T04:59:59.999Z", "23:59:59.999 EST on 9 November");
});

test("[PM-002] FD-14 / FD-15: a review request carries its five-business-day deadline; when it passes nothing is approved, the customer is reminded once and the team told", async () => {
  const t = await createTestApp();
  const pm = await createStaff(t.db, "project_manager");
  const cu = await createCustomer(t.db, "review@fixture.example", "Fixture Review LLC");
  const orderId = newId("ord");
  await t.db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, created_at) VALUES (?,?, 'business', 249900, 'paid', 'package', ?)`).bind(orderId, cu.organizationId, nowIso()).run();
  await t.db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, created_at) VALUES (?,?,?, 'full', 249900, 'paid', ?)`).bind(newId("inv"), cu.organizationId, orderId, nowIso()).run();
  const pid = await provisionProject(t.db, orderId);
  await t.db.prepare(`UPDATE projects SET project_manager_id = ? WHERE id = ?`).bind(pm.id, pid).run();
  const ctx = { db: t.db, email: new OutboxEmail(t.db), baseUrl: "http://crestmont.test", now: () => new Date() };
  const pmActor: Actor = { kind: "user", userId: pm.id, roles: [{ role: "project_manager", organizationId: pm.organizationId }], mfaVerified: true };
  const reqId = await requestCustomerApproval(ctx, pmActor, pid, "design", "Please review the homepage design (TEST DATA)");
  const req = await one<{ respond_by: string; created_at: string }>(t.db, `SELECT respond_by, created_at FROM approval_requests WHERE id = ?`, reqId);
  assert.equal(req.respond_by, customerReviewDeadline(new Date(req.created_at)));
  assert.match((await lastEmail(t.db, cu.email))!.text_body, /five business days/);
  assert.match((await lastEmail(t.db, cu.email))!.text_body, /never treat silence as approval/);
  const portal = await (await t.client().login(cu.email)).get(`/portal/projects/${pid}/approvals`);
  assert.match(await portal.text(), /data-testid="respond-by"/);

  assert.equal(await runReviewDeadlineSweep(ctx), 0, "not overdue yet");
  const later = { ...ctx, now: () => new Date(Date.parse(req.respond_by) + 60_000) };
  assert.equal(await runReviewDeadlineSweep(later), 1);
  assert.equal(await runReviewDeadlineSweep(later), 0, "reminded once");
  const after = await one<{ resolved_at: string | null; approval_id: string | null }>(t.db, `SELECT resolved_at, approval_id FROM approval_requests WHERE id = ?`, reqId);
  assert.deepEqual({ ...after }, { resolved_at: null, approval_id: null }, "FD-15: silence is not approval — the request stays open");
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM approvals WHERE project_id = ?`, pid)).n, 0);
  assert.match((await lastEmail(t.db, cu.email))!.text_body, /Nothing has been approved on your behalf/);
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'approval.review_overdue' AND subject_id = ?`).bind(pid).first());
});

test("[SALES-002] FD-24: a quote is valid for at most 30 days from the day its version is created", () => {
  assert.equal(QUOTE_VALIDITY_DAYS, 30);
  const base = { packageId: "starter" as const, lines: [], scope: "Starter package website: five pages with a contact form." };
  assert.equal(validateQuoteInput({ ...base, validUntil: "2026-12-01" }, "2026-11-01").ok, true, "exactly 30 days");
  const over = validateQuoteInput({ ...base, validUntil: "2026-12-02" }, "2026-11-01");
  assert.equal(over.ok, false);
  assert.match((over as { issues: string[] }).issues.join(" "), /at most 30 days \(until 2026-12-01\)/);
});

test("[CAT-007] FD-25: a maintenance price increase needs 30 days' notice, counted from the Founder's approval; subscribers are emailed", async () => {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner");
  const actor = ownerActor(owner);
  const now = new Date();
  const soon = new Date(now.getTime() + 10 * DAY).toISOString().slice(0, 10);
  const r1 = await proposePriceChange(t.db, actor, { itemType: "maintenance", itemId: "essential", proposed: "129", effectiveDate: soon, reason: "Hosting cost increase (TEST DATA)" }, now);
  assert.equal(r1.ok, false);
  assert.match((r1 as { issues: string[] }).issues.join(" "), new RegExp(`at least ${SUBSCRIPTION_INCREASE_NOTICE_DAYS} days' notice`));
  // A decrease, or a one-time package price, has no notice requirement.
  assert.equal((await proposePriceChange(t.db, actor, { itemType: "maintenance", itemId: "professional", proposed: "189", effectiveDate: soon, reason: "Plan price decrease (TEST DATA)" }, now)).ok, true);
  assert.equal((await proposePriceChange(t.db, actor, { itemType: "package", itemId: "starter", proposed: "1099", effectiveDate: soon, reason: "Package price change (TEST DATA)" }, now)).ok, true);

  // An existing Essential subscriber.
  const cu = await createCustomer(t.db, "subscriber@fixture.example", "Fixture Subscriber LLC");
  await t.db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, stripe_subscription_id, status, created_at, updated_at) VALUES (?,?, 'essential', 'sub_fd25', 'active', ?, ?)`).bind(newId("sub"), cu.organizationId, nowIso(), nowIso()).run();
  const eff = new Date(now.getTime() + 31 * DAY).toISOString().slice(0, 10);
  const r2 = await proposePriceChange(t.db, actor, { itemType: "maintenance", itemId: "essential", proposed: "129", effectiveDate: eff, reason: "Hosting cost increase (TEST DATA)" }, now);
  assert.equal(r2.ok, true);
  // The Founder approves 20 days later: the increase moves to 30 days after approval, never sooner.
  const approvedAt = new Date(now.getTime() + 20 * DAY);
  const { effectiveAt } = await decidePriceChange(t.db, actor, (r2 as { id: string }).id, "approved", "", approvedAt, { db: t.db, email: new OutboxEmail(t.db), baseUrl: "http://crestmont.test" });
  assert.ok(Date.parse(effectiveAt) >= approvedAt.getTime() + 30 * DAY, `${effectiveAt} is at least 30 days after approval`);
  const mail = await lastEmail(t.db, cu.email);
  assert.equal(mail?.template, "subscription_update");
  assert.match(mail!.text_body, /\$99\.00 to \$129\.00/);
  assert.match(mail!.text_body, /at least 30 days' notice/);
});

test("[SEC-006] FD-38: proposed periods are 180 days for security events and 90 days for raw IPs", () => {
  const by = (c: string) => CONFIGURABLE_RULES.find((r) => r.category === c)!;
  assert.equal(by("security_events").proposedDays, 180);
  assert.equal(by("raw_ips").proposedDays, 90);
});

test("[SEC-006] [SEC-005] FD-38: the IP rule clears old IPs on sessions, security events and audit entries, keeps the rows, never touches agreement evidence, and the audit log stays otherwise append-only", async () => {
  const t = await createTestApp();
  const cu = await createCustomer(t.db, "ips@fixture.example", "Fixture IP LLC");
  const old = new Date(Date.now() - 100 * DAY).toISOString(), recent = new Date(Date.now() - 10 * DAY).toISOString();
  for (const [id, at] of [["ses_old", old], ["ses_new", recent]]) {
    await t.db.prepare(`INSERT INTO sessions (id, user_id, token_hash, ip, created_at, expires_at) VALUES (?,?,?, '203.0.113.7', ?, ?)`).bind(id, cu.id, `hash_${id}`, at, new Date(Date.now() + DAY).toISOString()).run();
  }
  await t.db.prepare(`INSERT INTO security_events (kind, user_id, detail, ip, created_at) VALUES ('login_failed', ?, 'se_old', '203.0.113.7', ?)`).bind(cu.id, old).run();
  await t.db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, ip, created_at) VALUES (?, 'user', 'fixture.old', 'user', ?, '203.0.113.7', ?), (?, 'user', 'fixture.new', 'user', ?, '203.0.113.8', ?)`)
    .bind(cu.id, cu.id, old, cu.id, cu.id, recent).run();
  // The audit log permits clearing an IP and nothing else.
  await assert.rejects(t.db.prepare(`UPDATE audit_logs SET action = 'tampered' WHERE action = 'fixture.old'`).run(), /append-only/);
  await assert.rejects(t.db.prepare(`UPDATE audit_logs SET ip = '198.51.100.1' WHERE action = 'fixture.old'`).run(), /append-only/);
  await assert.rejects(t.db.prepare(`UPDATE audit_logs SET ip = NULL, details_json = '{}' WHERE action = 'fixture.old'`).run(), /append-only/);
  await assert.rejects(t.db.prepare(`DELETE FROM audit_logs WHERE action = 'fixture.old'`).run(), /append-only/);

  const unset = await runRetention({ db: t.db, storage: null });
  assert.equal(unset.find((r) => r.category === "raw_ips")!.mode, "skipped", "nothing happens until the Owner applies the period");
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('retention.raw_ip_days', '90', ?)`).bind(nowIso()).run();
  const res = (await runRetention({ db: t.db, storage: null })).find((r) => r.category === "raw_ips")!;
  assert.equal(res.affected, 3);
  assert.equal((await one<{ ip: string | null }>(t.db, `SELECT ip FROM sessions WHERE id = 'ses_old'`)).ip, null);
  assert.equal((await one<{ ip: string | null }>(t.db, `SELECT ip FROM sessions WHERE id = 'ses_new'`)).ip, "203.0.113.7");
  assert.equal((await one<{ ip: string | null }>(t.db, `SELECT ip FROM security_events WHERE detail = 'se_old'`)).ip, null);
  const audits = (await t.db.prepare(`SELECT action, ip FROM audit_logs WHERE action LIKE 'fixture.%' ORDER BY action`).all<{ action: string; ip: string | null }>()).results;
  assert.deepEqual(audits.map((a) => ({ ...a })), [{ action: "fixture.new", ip: "203.0.113.8" }, { action: "fixture.old", ip: null }], "rows kept; only the old IP cleared");
});
