import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./support/sqlite-d1.ts";
import { captureLead, changeLeadStage } from "../src/services/leads.ts";
import { recordStripeEvent, verifyStripeSignature, isStaleEvent, markEventResult, type StripeEvent } from "../src/domain/stripe-webhook.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { ValidationError } from "../src/lib/validate.ts";
import { handle, type Env } from "../src/worker.ts";
import type { Actor } from "../src/domain/authz.ts";

const lead = { name: "Dana Ortiz", email: "dana@example.com", interest: "business", message: "We need a 10 page site with booking.", source: "web_form", company: "Ortiz Dental" };

test("[DATA-001] all migrations apply cleanly with foreign keys enforced", () => {
  const db = createTestDb();
  const tables = db.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => (r as { name: string }).name);
  for (const t of ["users", "organizations", "leads", "quotes", "quote_versions", "orders", "invoices", "payments", "subscriptions", "refunds",
    "projects", "milestones", "tasks", "revisions", "change_orders", "approvals", "messages", "files", "tickets", "email_deliveries",
    "notifications", "ai_jobs", "calls", "portfolio_projects", "audit_logs", "deployments", "requirements", "test_evidence",
    "integration_health", "blockers", "readiness_snapshots", "release_approvals", "stripe_events"]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  assert.equal((db.raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
});

test("[DATA-002] referential integrity rejects orphan records", () => {
  const db = createTestDb();
  assert.throws(() => db.raw.prepare(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES ('l1','missing','web_form','new','x','x')`).run(), /FOREIGN KEY/);
  assert.throws(() => db.raw.prepare(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES ('l1','missing','web_form','bogus','x','x')`).run(), /CHECK/);
});

test("[SEC-005] audit log is append-only", async () => {
  const db = createTestDb();
  await captureLead(db, lead);
  assert.throws(() => db.raw.exec(`UPDATE audit_logs SET action='x'`), /append-only/);
  assert.throws(() => db.raw.exec(`DELETE FROM audit_logs`), /append-only/);
});

test("[CRM-001] public lead capture persists contact, company, lead, activity and audit atomically", async () => {
  const db = createTestDb();
  const { leadId } = await captureLead(db, lead, { ip: "203.0.113.5" });
  const row = db.raw.prepare(`SELECT l.stage, l.source, c.email, co.name AS company FROM leads l JOIN contacts c ON c.id=l.contact_id LEFT JOIN companies co ON co.id=c.company_id WHERE l.id=?`).get(leadId) as Record<string, string>;
  assert.deepEqual({ ...row }, { stage: "new", source: "web_form", email: "dana@example.com", company: "Ortiz Dental" });
  assert.equal((db.raw.prepare(`SELECT COUNT(*) n FROM crm_activities WHERE lead_id=?`).get(leadId) as { n: number }).n, 1);
  assert.equal((db.raw.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE subject_id=?`).get(leadId) as { n: number }).n, 1);
});

test("[SEC-001] lead capture rejects invalid input without writing anything", async () => {
  const db = createTestDb();
  await assert.rejects(captureLead(db, { ...lead, email: "not-an-email", message: "short" }), ValidationError);
  await assert.rejects(captureLead(db, { ...lead, interest: "guaranteed-seo" }), ValidationError);
  assert.equal((db.raw.prepare(`SELECT COUNT(*) n FROM leads`).get() as { n: number }).n, 0);
});

test("[SEC-002] SQL injection payloads are stored as data, not executed", async () => {
  const db = createTestDb();
  const { leadId } = await captureLead(db, { ...lead, name: "Robert'); DROP TABLE leads;--" });
  assert.equal((db.raw.prepare(`SELECT c.name FROM leads l JOIN contacts c ON c.id=l.contact_id WHERE l.id=?`).get(leadId) as { name: string }).name, "Robert'); DROP TABLE leads;--");
});

test("[CRM-004] stage changes are recorded in activity history and enforce assignment", async () => {
  const db = createTestDb();
  const { leadId } = await captureLead(db, lead);
  const sales: Actor = { kind: "user", userId: "u_sales", roles: [{ role: "sales", organizationId: "org_internal" }], mfaVerified: true };
  await assert.rejects(changeLeadStage(db, sales, leadId, "qualified"), /not assigned/);
  db.raw.exec(`INSERT INTO users (id,email,display_name,created_at) VALUES ('u_sales','s@crestmont.test','Sales','x')`);
  db.raw.prepare(`UPDATE leads SET owner_user_id='u_sales' WHERE id=?`).run(leadId);
  await changeLeadStage(db, sales, leadId, "qualified");
  await assert.rejects(changeLeadStage(db, sales, leadId, "converted"), /webhook/);
  const acts = db.raw.prepare(`SELECT kind, body FROM crm_activities WHERE lead_id=? ORDER BY created_at`).all(leadId) as { kind: string; body: string }[];
  assert.ok(acts.some((a) => a.kind === "stage_change" && a.body.includes("new → qualified")));
});

test("[PAY-002] Stripe webhook signatures are verified with timestamp tolerance", async () => {
  const body = JSON.stringify({ id: "evt_1" });
  const t = 1_800_000_000;
  const sig = await hmacSha256Hex("whsec_test", `${t}.${body}`);
  await verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_test", { nowSeconds: t + 10 });
  await assert.rejects(verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_other", { nowSeconds: t }), /mismatch/);
  await assert.rejects(verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_test", { nowSeconds: t + 3600 }), /tolerance/);
  await assert.rejects(verifyStripeSignature(body + " ", `t=${t},v1=${sig}`, "whsec_test", { nowSeconds: t }), /mismatch/);
  await assert.rejects(verifyStripeSignature(body, null, "whsec_test"), /Missing/);
  await assert.rejects(verifyStripeSignature(body, `t=${t},v1=${sig}`, ""), /not configured/);
});

test("[PAY-003] webhook events are idempotent, out-of-order safe, and dead-lettered after retries", async () => {
  const db = createTestDb();
  const evt = (id: string, created: number): StripeEvent => ({ id, type: "invoice.paid", created, data: { object: { id: "in_1" } } });
  assert.equal(await recordStripeEvent(db, evt("evt_a", 200), "{}"), "new");
  assert.equal(await recordStripeEvent(db, evt("evt_a", 200), "{}"), "duplicate");
  await markEventResult(db, "evt_a", { ok: true });
  await recordStripeEvent(db, evt("evt_old", 100), "{}");
  assert.equal(await isStaleEvent(db, evt("evt_old", 100)), true);
  await recordStripeEvent(db, evt("evt_new", 300), "{}");
  assert.equal(await isStaleEvent(db, evt("evt_new", 300)), false);
  for (let i = 0; i < 5; i++) await markEventResult(db, "evt_new", { ok: false, error: "boom" });
  assert.equal((db.raw.prepare(`SELECT status FROM stripe_events WHERE id='evt_new'`).get() as { status: string }).status, "dead_letter");
});

test("[PAY-006] duplicate milestone invoices are rejected by the database", () => {
  const db = createTestDb();
  db.raw.exec(`INSERT INTO organizations (id,name,kind,created_at) VALUES ('org1','Acme','customer','x');
    INSERT INTO projects (id,organization_id,name,status,revision_allowance,payment_schedule,created_at,updated_at) VALUES ('p1','org1','Acme site','design',2,'milestone_50_25_25','x','x');
    INSERT INTO invoices (id,organization_id,project_id,milestone_kind,amount_cents,status,created_at) VALUES ('i1','org1','p1','deposit_50',500,'paid','x');`);
  assert.throws(() => db.raw.exec(`INSERT INTO invoices (id,organization_id,project_id,milestone_kind,amount_cents,status,created_at) VALUES ('i2','org1','p1','deposit_50',500,'open','x')`), /UNIQUE/);
});

test("[AUTH-007] protected readiness API returns 401/403 server-side", async () => {
  const db = createTestDb();
  const base: Env = { DB: db, ENVIRONMENT: "development" };
  assert.equal((await handle(new Request("https://x/api/readiness"), base)).status, 401);
  const cust: Actor = { kind: "user", userId: "c", roles: [{ role: "customer_admin", organizationId: "o" }], mfaVerified: true };
  assert.equal((await handle(new Request("https://x/api/readiness"), { ...base, resolveActor: async () => cust })).status, 403);
});

test("[WEB-005] quote/contact form endpoint creates a CRM lead and fails closed on bot check outside development", async () => {
  const db = createTestDb();
  const req = () => new Request("https://x/api/leads", { method: "POST", body: JSON.stringify({ ...lead, source: "quote_form" }), headers: { "content-type": "application/json" } });
  const res = await handle(req(), { DB: db, ENVIRONMENT: "development" });
  assert.equal(res.status, 201);
  assert.equal((await handle(req(), { DB: db, ENVIRONMENT: "staging" })).status, 400);
  const bad = await handle(new Request("https://x/api/leads", { method: "POST", body: "{not json" }), { DB: db, ENVIRONMENT: "development" });
  assert.equal(bad.status, 400);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});
