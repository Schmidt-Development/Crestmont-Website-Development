// Route security matrix fixture (AUTH-007, AUTH-008, EMP-002, SEC-001): one app populated with TWO
// customer organizations that each own every customer resource type, every staff role, and the
// staff-side records the staff routes act on. Built through the real routes and services so every
// row is valid by construction. Every record created here is TEST DATA.
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, MemoryStorage, TEST_PASSWORD, type TestClient } from "./app.ts";
import { hashPassword } from "../../src/lib/auth-crypto.ts";
import { newId, nowIso } from "../../src/lib/db.ts";
import { createPackageOrder, markInvoicePaid, provisionProject } from "../../src/services/commerce.ts";
import { recordAcceptance } from "../../src/services/agreements.ts";
import { STAFF_ROLES, type Role } from "../../src/domain/authz.ts";
import type { PaymentsAdapter } from "../../src/adapters/payments.ts";
import type { Env } from "../../src/app/context.ts";
import type { ResourceKind } from "./route-inventory.ts";

export type StaffRole = (typeof STAFF_ROLES)[number];
export const SECRETS = { scheduler: "matrix-scheduler-secret", runner: "matrix-runner-secret", evidence: "matrix-evidence-secret", voice: "matrix-voice-secret", stripe: "whsec_matrixstripe", retell: "matrix-retell-key", resend: "whsec_" + Buffer.from("matrix-resend-secret").toString("base64") };

export const PDF = new TextEncoder().encode("%PDF-1.4\n%security matrix fixture\n");
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
export const pdf = (name: string) => new File([PDF], name, { type: "application/pdf" });
export const png = (name: string) => new File([PNG], name, { type: "image/png" });

export class FakePayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  calls = 0;
  async createCheckout() { this.calls++; return { id: `cs_test_${this.calls}`, url: `https://checkout.stripe.com/c/pay/cs_test_${this.calls}` }; }
  async createBillingPortal() { this.calls++; return { url: `https://billing.stripe.com/p/session/test_${this.calls}` }; }
  async createRefund() { this.calls++; return { id: `re_test_${this.calls}`, status: "succeeded" }; }
}

/** Everything one customer organization owns. `marker` appears in every text the org writes. */
export interface Tenant {
  marker: string;
  orgId: string;
  orgName: string;
  admin: { id: string; email: string; c: TestClient };
  member: { id: string; email: string; c: TestClient };
  ids: Partial<Record<ResourceKind, string>>;
  /** Every id this tenant owns, used to detect leaks into another tenant's responses. */
  allIds: string[];
}

export interface World {
  app: Awaited<ReturnType<typeof createTestApp>>;
  db: Env["DB"];
  env: Env;
  payments: FakePayments;
  staff: Record<StaffRole, { id: string; email: string; secret: string; c: TestClient }>;
  a: Tenant;
  b: Tenant;
  /** Staff-side (non-tenant) records the staff routes act on. */
  ids: Partial<Record<ResourceKind, string>>;
  anon: () => TestClient;
}

const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;

async function ok(res: Response | Promise<Response>, what: string, statuses = [200, 201, 303]): Promise<Response> {
  const r = await res;
  if (!statuses.includes(r.status)) assert.fail(`fixture step failed: ${what} → ${r.status} ${(await r.clone().text()).replace(/\s+/g, " ").slice(0, 400)}`);
  if (r.status === 303) assert.doesNotMatch(r.headers.get("location") ?? "", /^\/(login|mfa)/, `fixture step bounced to sign-in: ${what}`);
  return r;
}

async function addMember(db: Env["DB"], orgId: string, email: string, name: string) {
  const id = newId("usr");
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, created_at) VALUES (?,?,?,?,?,?)`).bind(id, email, name, await hashPassword(TEST_PASSWORD), nowIso(), nowIso()),
    db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?,'customer_member',?)`).bind(newId("mbr"), id, orgId, nowIso()),
  ]);
  return id;
}

async function buildTenant(w: Omit<World, "a" | "b">, key: "a" | "b"): Promise<Tenant> {
  const { db, app } = w;
  const marker = key === "a" ? "ZZALPHA" : "ZZBRAVO";
  const orgName = `${marker} ${key === "a" ? "Alpha Plumbing" : "Bravo Dental"}`;
  const cu = await createCustomer(db, `${key}-admin@${key}.matrix.example`, orgName);
  await db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`).bind(`${marker} Admin`, cu.id).run();
  const memberEmail = `${key}-member@${key}.matrix.example`;
  const memberId = await addMember(db, cu.organizationId, memberEmail, `${marker} Member`);
  const admin = { id: cu.id, email: cu.email, c: await app.client().login(cu.email) };
  const member = { id: memberId, email: memberEmail, c: await app.client().login(memberEmail) };
  const owner = w.staff.owner.c;
  const ids: Tenant["ids"] = { org: cu.organizationId };

  // Paid package → provisioned project; a second, unpaid order → open invoice.
  const paid = await createPackageOrder(db, cu.organizationId, "business", cu.id);
  await markInvoicePaid(db, paid.invoiceId, { amountCents: paid.amountCents, paymentIntentId: `pi_${key}_matrix`, feeCents: null });
  const pid = await provisionProject(db, paid.orderId);
  await db.prepare(`UPDATE projects SET name = ? WHERE id = ?`).bind(`${marker} Website`, pid).run();
  ids.project = pid;
  ids.payment = (await one<{ id: string }>(db, `SELECT id FROM payments WHERE invoice_id = ?`, paid.invoiceId)).id;
  ids.paidInvoice = paid.invoiceId;
  ids.invoice = (await createPackageOrder(db, cu.organizationId, "starter", cu.id)).invoiceId;

  // Delivery records (staff side of the tenant's project).
  await ok(owner.post(`/staff/projects/${pid}/pm`, { user_id: w.staff.project_manager.id }), "set PM");
  if (key === "a") await ok(owner.post(`/staff/projects/${pid}/assign`, { user_id: w.staff.developer.id }), "assign developer to A only");
  await ok(owner.post(`/staff/projects/${pid}/milestones`, { name: `${marker} milestone`, due_at: "2027-01-15" }), "milestone");
  ids.milestone = (await one<{ id: string }>(db, `SELECT id FROM milestones WHERE project_id = ? ORDER BY position DESC LIMIT 1`, pid)).id;
  await ok(owner.post(`/staff/projects/${pid}/tasks`, { title: `${marker} task one`, assignee_id: key === "a" ? w.staff.developer.id : "" }), "task 1");
  await ok(owner.post(`/staff/projects/${pid}/tasks`, { title: `${marker} task two` }), "task 2");
  const tasks = (await db.prepare(`SELECT id FROM tasks WHERE project_id = ? ORDER BY created_at, rowid`).bind(pid).all<{ id: string }>()).results;
  ids.task = tasks[0].id; ids.task2 = tasks[1].id;
  await ok(owner.post(`/staff/tasks/${ids.task2}/dependencies`, { depends_on: ids.task }), "dependency");
  await ok(owner.post(`/staff/tasks/${ids.task}/assign`, { user_id: w.staff.support.id }), "assignment");
  ids.assignment = (await one<{ id: string }>(db, `SELECT id FROM assignments WHERE subject_id = ? AND user_id = ?`, ids.task, w.staff.support.id)).id;

  // Customer collaboration.
  await ok(admin.c.post(`/portal/projects/${pid}/onboarding`, { intent: "draft", business_name: `${marker} onboarding answer` }), "onboarding draft");
  await ok(admin.c.post(`/portal/projects/${pid}/files`, { file: pdf(`${marker}-brief.pdf`), folder: `${marker} folder` }), "project file");
  await ok(admin.c.post(`/portal/files`, { file: png(`${marker}-logo.png`) }), "general file");
  ids.file = (await one<{ id: string }>(db, `SELECT id FROM files WHERE organization_id = ? AND project_id IS NOT NULL`, cu.organizationId)).id;
  ids.file2 = (await one<{ id: string }>(db, `SELECT id FROM files WHERE organization_id = ? AND project_id IS NULL`, cu.organizationId)).id;
  const share = await ok(admin.c.post(`/files/${ids.file}/share`, { hours: "24", acknowledge_unscanned: "1", note: `${marker} share note` }), "share link", [201]);
  ids.shareToken = /\/share\/([A-Za-z0-9_-]+)/.exec(await share.text())![1];
  ids.shareLink = (await one<{ id: string }>(db, `SELECT id FROM share_links WHERE file_id = ?`, ids.file)).id;
  await ok(admin.c.post(`/portal/messages/general`, { body: `${marker} general question` }), "general message");
  await ok(admin.c.post(`/portal/projects/${pid}/messages`, { body: `${marker} project message` }), "project message");
  await ok(owner.post(`/staff/projects/${pid}/messages`, { body: `${marker} staff reply` }), "staff message");
  await ok(owner.post(`/staff/projects/${pid}/messages`, { body: `${marker} INTERNAL staff note`, internal: "1" }), "internal note");
  ids.message = (await one<{ id: string }>(db, `SELECT id FROM messages WHERE organization_id = ? ORDER BY created_at LIMIT 1`, cu.organizationId)).id;
  // Fixture shortcut: move the project into design so revision rounds are open (lifecycle gates are tested elsewhere).
  await db.prepare(`UPDATE projects SET status = 'design' WHERE id = ?`).bind(pid).run();
  await ok(admin.c.post(`/portal/projects/${pid}/revisions`, { request: `${marker} please change the header` }), "revision");
  ids.revision = (await one<{ id: string }>(db, `SELECT id FROM revisions WHERE project_id = ?`, pid)).id;
  await ok(owner.post(`/staff/projects/${pid}/scope`, { scope: `${marker} scope: five pages and a contact form` }), "scope");
  await ok(owner.post(`/staff/projects/${pid}/request-approval`, { kind: "scope", note: `${marker} please approve` }), "approval request");
  ids.approvalRequest = (await one<{ id: string }>(db, `SELECT id FROM approval_requests WHERE project_id = ?`, pid)).id;
  await ok(owner.post(`/staff/projects/${pid}/change-orders`, { scope: `${marker} extra services page`, price: "450" }), "change order");
  ids.changeOrder = (await one<{ id: string }>(db, `SELECT id FROM change_orders WHERE project_id = ?`, pid)).id;
  await ok(owner.post(`/staff/projects/${pid}/handoff`, { intent: "draft", website_url: `https://${key}.matrix.example`, documentation: `${marker} handoff docs` }), "handoff draft");
  await ok(admin.c.post(`/portal/support/new`, { subject: `${marker} ticket subject`, category: "technical", description: `${marker} the contact form is broken`, project_id: pid }), "ticket");
  ids.ticket = (await one<{ id: string }>(db, `SELECT id FROM tickets WHERE organization_id = ?`, cu.organizationId)).id;
  await ok(owner.post(`/staff/support/${ids.ticket}/note`, { body: `${marker} INTERNAL ticket note` }), "ticket internal note");
  await ok(admin.c.post(`/portal/billing/refund-request`, { payment_id: ids.payment, amount: "100", reason: `${marker} project cancelled before kickoff`, evidence: "email" }), "refund request");
  ids.refund = (await one<{ id: string }>(db, `SELECT id FROM refunds WHERE organization_id = ?`, cu.organizationId)).id;
  await ok(admin.c.post(`/portal/team`, { email: `${key}-invitee@${key}.matrix.example` }), "team invitation");
  ids.customerInvitation = (await one<{ id: string }>(db, `SELECT id FROM invitations WHERE organization_id = ?`, cu.organizationId)).id;
  await recordAcceptance({ db, settings: {}, ip: "203.0.113.5", now: () => new Date(), req: new Request("http://crestmont.test/register") } as never, { userId: cu.id, organizationId: cu.organizationId, context: "registration" });
  ids.session = (await one<{ id: string }>(db, `SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, cu.id)).id;
  ids.member = memberId;
  ids.notification = (await one<{ id: string }>(db, `SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at LIMIT 1`, cu.id)).id;

  const allIds = [...new Set([...Object.values(ids).filter((v): v is string => !!v && v.length >= 8), cu.id, memberId])];
  return { marker, orgId: cu.organizationId, orgName, admin, member, ids, allIds };
}

export async function buildWorld(): Promise<World> {
  const payments = new FakePayments();
  const app = await createTestApp({
    EVIDENCE_INGEST_SECRET: SECRETS.evidence, VOICE_WEBHOOK_SECRET: SECRETS.voice, STRIPE_WEBHOOK_SECRET: SECRETS.stripe,
    RETELL_API_KEY: SECRETS.retell, RESEND_WEBHOOK_SECRET: SECRETS.resend, BUILD_RUNNER_SECRET: SECRETS.runner, SCHEDULER_TRIGGER_SECRET: SECRETS.scheduler,
    overrides: { storage: new MemoryStorage(), payments },
  });
  const db = app.db;
  const staff = {} as World["staff"];
  for (const role of STAFF_ROLES) {
    const s = await createStaff(db, role as Role, `${role}@matrix.crestmont.test`, `Matrix ${role}`);
    staff[role] = { ...s, c: await app.client().login(s.email, TEST_PASSWORD, s.secret) };
  }
  const base = { app, db, env: app.env, payments, staff, ids: {} as World["ids"], anon: () => app.client() };
  const a = await buildTenant(base, "a");
  const b = await buildTenant(base, "b");
  const w: World = { ...base, a, b };
  await buildStaffRecords(w);
  return w;
}

/** Staff-side records: CRM, quotes, CMS, portfolio, readiness, platform, finance and integrations. */
async function buildStaffRecords(w: World) {
  const { db, ids } = w;
  const o = w.staff.owner.c;
  const future = new Date(Date.now() + 20 * 86400e3).toISOString().slice(0, 10);
  // CRM + quotes
  await ok(o.post("/staff/crm/new", { name: "Matrix Lead", email: "lead@matrix.example", phone: "", company: "Lead Co", website: "", interest: "business", message: "Needs a site", source: "referral" }), "lead");
  ids.lead = (await one<{ id: string }>(db, `SELECT id FROM leads ORDER BY created_at DESC LIMIT 1`)).id;
  await ok(o.post(`/staff/crm/leads/${ids.lead}/assign`, { owner: w.staff.sales.id }), "assign lead to sales");
  await ok(o.post(`/staff/crm/leads/${ids.lead}/task`, { body: "Call back", due: future }), "lead task");
  ids.leadTask = (await one<{ id: string }>(db, `SELECT id FROM crm_activities WHERE lead_id = ? AND kind = 'task'`, ids.lead)).id;
  await ok(o.post(`/staff/quotes/new?lead=${ids.lead}`, { package: "business", scope: "Business package website: 12 pages with booking integration and blog.", valid_until: future }), "quote");
  ids.quote = (await one<{ id: string }>(db, `SELECT id FROM quotes ORDER BY created_at DESC LIMIT 1`)).id;
  await ok(o.post(`/staff/quotes/${ids.quote}/send`), "quote send");
  const mail = await one<{ text_body: string }>(db, `SELECT m.text_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.to_email = 'lead@matrix.example' ORDER BY d.created_at DESC LIMIT 1`);
  ids.quoteToken = /\/q\/([A-Za-z0-9_-]+)/.exec(mail.text_body)![1];
  ids.emailDelivery = (await one<{ id: string }>(db, `SELECT id FROM email_deliveries ORDER BY created_at LIMIT 1`)).id;
  // AI jobs: one awaiting approval (decide), one failed with retained input (retry).
  ids.aiJob = newId("ai");
  await db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, output_ref, created_at, updated_at) VALUES (?, 'lead_qualification', 'anthropic', 'test', 'awaiting_approval', ?, 'Draft notes', ?, ?)`).bind(ids.aiJob, `lead:${ids.lead}`, nowIso(), nowIso()).run();
  // CMS + portfolio
  ids.cmsKey = "home.hero";
  await ok(o.post("/staff/cms/home.hero", { eyebrow: "Crestmont", heading: "Refined websites for serious businesses.", lede: "A new lead paragraph for the homepage hero section.", primary_label: "See packages", quote_label: "Get a quote", note: "matrix" }), "cms draft");
  ids.cmsRevision = (await one<{ id: string }>(db, `SELECT id FROM cms_revisions ORDER BY created_at DESC LIMIT 1`)).id;
  await ok(o.post("/staff/portfolio", { name: "Matrix Portfolio", slug: "matrix-portfolio", industry: "Retail", live_url: "https://portfolio.matrix.example", description: "A verified description of the live website.", features: "Contact form", technology_summary: "", relationship: "Relationship documentation pending" }), "portfolio");
  ids.portfolio = (await one<{ id: string }>(db, `SELECT id FROM portfolio_projects WHERE slug = 'matrix-portfolio'`)).id;
  ids.portfolioSlug = "matrix-portfolio";
  await ok(o.post(`/staff/portfolio/${ids.portfolio}/screenshot`, { kind: "desktop", captured_on: "2026-10-26", screenshot: png("matrix.png") }), "portfolio screenshot");
  ids.portfolioFile = (await one<{ id: string }>(db, `SELECT desktop_screenshot_file_id AS id FROM portfolio_projects WHERE id = ?`, ids.portfolio)).id;
  await ok(o.post(`/staff/portfolio/${ids.portfolio}/testimonials`, { author: "A. Person", body: "Great to work with on this site.", evidence: "Email from author dated 2026-10-26 granting permission" }), "testimonial");
  ids.testimonial = (await one<{ id: string }>(db, `SELECT id FROM testimonials ORDER BY created_at DESC LIMIT 1`)).id;
  // Readiness
  await ok(o.post("/staff/readiness/blockers/new", { category: "security", severity: "high", description: "Matrix blocker description", subsystem: "Authentication", owner: "Engineering", required_action: "Scope cookie to app domain", dependency: "", requirement_ids: "AUTH-007" }), "blocker");
  ids.blocker = (await one<{ id: string }>(db, `SELECT id FROM blockers ORDER BY created_at DESC LIMIT 1`)).id;
  await ok(o.post("/staff/readiness/security", { title: "Matrix finding", severity: "low", source: "Manual review", detail: "detail" }), "finding");
  ids.finding = (await one<{ id: string }>(db, `SELECT id FROM security_findings ORDER BY opened_at DESC LIMIT 1`)).id;
  await ok(o.post("/staff/readiness/snapshots"), "snapshot");
  ids.snapshot = (await one<{ id: string }>(db, `SELECT id FROM readiness_snapshots ORDER BY taken_at DESC LIMIT 1`)).id;
  ids.requirement = "AUTH-007";
  ids.env = "staging";
  const { signEvidence } = await import("../../src/readiness/ingest.ts");
  const ev = JSON.stringify({ runId: "matrix-run-1", source: "ci", environment: "development", commitSha: "abc1234", branch: "main", startedAt: "2026-10-26T10:00:00Z", finishedAt: "2026-10-26T10:05:00Z", results: [{ requirementId: "AUTH-007", testName: "t", outcome: "passed" }] });
  await ok(w.anon().request("POST", "/api/readiness/evidence", { body: ev, headers: { "content-type": "application/json", "x-crestmont-signature": await signEvidence(SECRETS.evidence, ev) } }), "evidence run", [200]);
  ids.run = "matrix-run-1";
  // Platform
  await ok(o.post("/staff/employees/invite", { email: "invitee@matrix.crestmont.test", role: "sales" }), "staff invitation");
  ids.invitation = (await one<{ id: string }>(db, `SELECT id FROM invitations WHERE email = 'invitee@matrix.crestmont.test'`)).id;
  ids.staffUser = (await createStaff(db, "developer", "spare-dev@matrix.crestmont.test", "Spare Developer")).id;
  ids.emailTemplate = "verification";
  ids.integration = "database";
  await ok(o.post("/staff/voice/configs", { instructions: "Greet the caller warmly, state you are an AI assistant, and help with questions about services and packages.", note: "Initial" }), "voice config");
  ids.voiceVersion = "1";
  await ok(o.post("/staff/voice/test-event", { scenario: "lead" }), "voice test call");
  ids.call = (await one<{ id: string }>(db, `SELECT id FROM calls ORDER BY started_at DESC LIMIT 1`)).id;
  const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
  await ok(w.staff.sales.c.post("/staff/pricing", { item: "package:starter", proposed: "1099", effective_date: tomorrow, reason: "Matrix market adjustment (TEST DATA)" }), "price change request");
  ids.priceRequest = (await one<{ id: string }>(db, `SELECT id FROM price_change_requests ORDER BY requested_at DESC LIMIT 1`)).id;
  // A spare customer files a deletion request (processing it anonymises that account only).
  const spare = await createCustomer(db, "privacy@spare.matrix.example", "Spare Privacy Co");
  await ok((await w.app.client().login(spare.email)).post("/account/privacy/delete", { confirm: "1", reason: "matrix" }), "privacy request");
  ids.privacyRequest = (await one<{ id: string }>(db, `SELECT id FROM privacy_requests WHERE user_id = ?`, spare.id)).id;
  // Provider-fed records (normally written by signed webhooks / scheduled jobs).
  ids.suppression = newId("sup");
  await db.prepare(`INSERT INTO email_suppressions (id, email, reason, detail, created_at) VALUES (?, 'bounced@matrix.example', 'hard_bounce', 'mailbox does not exist', ?)`).bind(ids.suppression, nowIso()).run();
  ids.reconFinding = newId("rf");
  await db.prepare(`INSERT INTO reconciliation_findings (id, fingerprint, kind, detail, status, first_seen_at, last_seen_at) VALUES (?, 'matrix-fp', 'unknown_local_invoice', 'Matrix finding detail', 'open', ?, ?)`).bind(ids.reconFinding, nowIso(), nowIso()).run();
  ids.staffNotification = newId("ntf");
  await db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) VALUES (?, ?, 'system', 'project', NULL, 'Matrix staff notification', ?)`).bind(ids.staffNotification, w.staff.owner.id, nowIso()).run();
  // AI build record for tenant A's project (normally created by the payment/intake hooks).
  ids.buildJob = newId("bld");
  await db.prepare(`INSERT INTO build_jobs (id, project_id, organization_id, order_id, kind, revision, dedupe_key, state, state_reason, strategy, package_id, trigger, preview_url, agent_session_id, created_at, updated_at)
                    SELECT ?, p.id, p.organization_id, p.order_id, 'first_build', 0, p.id || ':first', 'ready_for_review', 'matrix fixture', 'standard', 'business', 'sweep', 'https://preview.matrix.example', 'sess-matrix', ?, ? FROM projects p WHERE p.id = ?`)
    .bind(ids.buildJob, nowIso(), nowIso(), w.a.ids.project).run();
  // Public identifiers
  ids.serviceSlug = "website-design-development";
  ids.legalSlug = "terms";
  ids.legalKind = "terms_of_service";
  ids.legalVersion = (await one<{ version: string }>(db, `SELECT version FROM agreements WHERE kind = 'terms_of_service' ORDER BY effective_at LIMIT 1`)).version;
  ids.package = "starter";
  ids.plan = "essential";
  ids.reportFile = "transactions.csv";
  ids.testimonialAction = "publish";
}

/** Resolves the id to use for a resource kind: the tenant's own record first, then staff-side records. */
export function idFor(w: World, kind: ResourceKind, tenant: Tenant = w.b): string {
  const v = tenant.ids[kind] ?? w.ids[kind];
  if (!v) throw new Error(`No fixture id for resource kind ${kind}`);
  return v;
}

export function fillPath(pattern: string, params: Record<string, string>): string {
  return pattern.replace(/:([A-Za-z]+)/g, (_, k) => encodeURIComponent(params[k] ?? "zz-missing"));
}
