// Success scenarios for every audited route in the inventory (EMP-002), and valid form bodies for every
// customer POST (reused by the tenant-isolation and fuzz tests). Each scenario performs the action
// for real, so the matrix can prove the audit row it writes. Every record created here is TEST DATA.
import { createCustomer, TEST_PASSWORD, type TestClient } from "./app.ts";
import { pdf, png, type World, type Tenant } from "./security-world.ts";
import { pathFor } from "./security-helpers.ts";
import { ROUTE_INVENTORY } from "./route-inventory.ts";
import { newId, nowIso } from "../../src/lib/db.ts";
import { totpCode } from "../../src/lib/auth-crypto.ts";

type Fields = Record<string, string | string[] | File>;
const day = (n: number) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);

/** Valid bodies for every customer/session POST, addressed at tenant `t`'s own records. */
export function customerPostFields(w: World, t: Tenant): Record<string, () => Fields> {
  return {
    "POST /portal/notifications/read": () => ({}),
    "POST /portal/projects/:id/onboarding": () => ({ intent: "draft", business_name: `${t.marker} onboarding answer 2` }),
    "POST /portal/files": () => ({ file: pdf(`${t.marker}-upload.pdf`), folder: "Uploads", project_id: t.ids.project! }),
    "POST /portal/projects/:id/files": () => ({ file: pdf(`${t.marker}-project-upload.pdf`) }),
    "POST /portal/files/:id/replace": () => ({ file: pdf(`${t.marker}-v2.pdf`) }),
    "POST /portal/files/:id/move": () => ({ folder: `${t.marker} moved` }),
    "POST /portal/files/:id/delete": () => ({}),
    "POST /files/:id/share": () => ({ hours: "24", acknowledge_unscanned: "1", note: "shared" }),
    "POST /files/share-links/:id/revoke": () => ({}),
    "POST /portal/messages/general": () => ({ body: `${t.marker} another general message` }),
    "POST /portal/projects/:id/messages": () => ({ body: `${t.marker} another project message` }),
    "POST /portal/projects/:id/revisions": () => ({ request: `${t.marker} please adjust the footer spacing` }),
    "POST /portal/change-orders/:id/decide": () => ({ decision: "approved", notes: "ok" }),
    "POST /portal/projects/:id/approvals": () => ({ kind: "scope", decision: "approved", notes: "Looks right" }),
    "POST /portal/team": () => ({ email: `invitee-${Math.random().toString(16).slice(2, 8)}@${t.marker.toLowerCase()}.example` }),
    "POST /portal/team/members/:userId/role": () => ({ role: "customer_admin" }),
    "POST /portal/team/members/:userId/remove": () => ({}),
    "POST /portal/team/invitations/:id/revoke": () => ({}),
    "POST /portal/notifications/:id/read": () => ({}),
    "POST /q/:token/accept": () => ({ agree: "1" }),
    "POST /checkout/maintenance/:planId": () => ({ terms: "1" }),
    "POST /checkout/:packageId": () => ({ terms: "1" }),
    "POST /portal/support/new": () => ({ subject: `${t.marker} second ticket`, category: "billing", description: `${t.marker} a question about my invoice`, project_id: t.ids.project! }),
    "POST /portal/support/:id/reply": () => ({ body: `${t.marker} more detail for the team` }),
    "POST /portal/support/:id/reopen": () => ({}),
    "POST /portal/billing/invoices/:id/pay": () => ({}),
    "POST /portal/billing/manage": () => ({}),
    "POST /portal/billing/refund-request": () => ({ payment_id: t.ids.payment!, amount: "50", reason: `${t.marker} duplicate purchase by mistake`, evidence: "receipt" }),
    "POST /mfa/step-up": () => ({ code: "000000" }),
    "POST /account/mfa/recovery-codes": () => ({ code: "000000" }),
    "POST /account/password": () => ({ current: TEST_PASSWORD, next: TEST_PASSWORD }),
    "POST /account/sessions/:id/revoke": () => ({}),
    "POST /account/sessions/revoke-others": () => ({}),
    "POST /account/privacy/export": () => ({}),
    "POST /account/privacy/delete": () => ({ confirm: "1", reason: "no longer needed" }),
  };
}

export interface Scenario {
  key: string;
  /** Who performs the action (default: the Owner). */
  as?: (w: World) => { c: TestClient; id: string };
  path?: (w: World) => string;
  fields?: (w: World) => Fields;
  setup?: (w: World) => Promise<void>;
  /** Accept an error flash on success (the action ran and was recorded, but reports a provider-side failure). */
  allowErrorFlash?: true;
  /** Fully custom request (multi-step flows such as MFA enrolment). */
  run?: (w: World) => Promise<{ res: Response; actorId: string }>;
}

const owner = (w: World) => w.staff.owner;
const one = async <T>(w: World, sql: string, ...b: unknown[]) => (await w.db.prepare(sql).bind(...b).first<T>())!;
const P = (w: World, key: string, t: Tenant = w.a) => pathFor(w, { method: key.split(" ")[0], pattern: key.split(" ")[1], key, spec: ROUTE_INVENTORY[key] }, t);

/** Fake Anthropic responses for the AI scenarios (no network). */
export function withFakeAi(w: World): () => void {
  const real = globalThis.fetch;
  w.env.ANTHROPIC_API_KEY = "test-key-not-real";
  w.env.AI_PROVIDER = "anthropic"; // paid AI is explicit opt-in; the Owner budget row is set below
  void w.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('ai.monthly_budget_usd', '100', ?) ON CONFLICT(key) DO NOTHING`).bind(new Date().toISOString()).run();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("https://api.anthropic.com/")) return new Response(JSON.stringify({ content: [{ type: "text", text: "Draft text for review." }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
    return real(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = real; delete w.env.ANTHROPIC_API_KEY; delete w.env.AI_PROVIDER; };
}

/** Ordered scenarios; later ones may rely on state created by earlier ones. Keys must match the inventory. */
export function auditScenarios(w: World): Scenario[] {
  const a = w.a, s = w.staff;
  const custA = () => ({ c: a.admin.c, id: a.admin.id });
  const cf = customerPostFields(w, a);
  const cust = (key: string, extra: Partial<Scenario> = {}): Scenario => ({ key, as: custA, fields: () => cf[key](), ...extra });
  const x: Record<string, string> = {};
  let spare: { id: string; email: string; c: TestClient; secret: string };
  const NEWPW = "a-brand-new-password-123";
  const spareAs = () => ({ c: spare.c, id: spare.id });
  return [
    // ── Authentication flow and account (a dedicated spare customer, so tenant A is unaffected) ──
    { key: "POST /mfa/setup", run: async () => {
      const cu = await createCustomer(w.db, "spare-account@matrix.example", "Spare Account Co");
      spare = { id: cu.id, email: cu.email, c: await w.app.client().login(cu.email), secret: "" };
      const page = await (await spare.c.get("/mfa/setup")).text();
      spare.secret = /data-testid="totp-secret">([A-Z2-7 ]+)</.exec(page)![1].replace(/\s/g, "");
      return { res: await spare.c.post("/mfa/setup", { code: await totpCode(spare.secret) }), actorId: cu.id };
    } },
    { key: "POST /mfa", run: async () => {
      const c = w.app.client();
      await c.post("/login", { email: spare.email, password: TEST_PASSWORD });
      await w.db.prepare(`UPDATE users SET totp_last_step = NULL WHERE id = ?`).bind(spare.id).run();
      const res = await c.post("/mfa", { code: await totpCode(spare.secret) });
      spare.c = c;
      return { res, actorId: spare.id };
    } },
    { key: "POST /mfa/step-up", run: async () => {
      await w.db.prepare(`UPDATE users SET totp_last_step = NULL WHERE id = ?`).bind(spare.id).run();
      return { res: await spare.c.post("/mfa/step-up?next=%2Faccount", { code: await totpCode(spare.secret) }), actorId: spare.id };
    } },
    { key: "POST /account/mfa/recovery-codes", run: async () => {
      await w.db.prepare(`UPDATE users SET totp_last_step = NULL WHERE id = ?`).bind(spare.id).run();
      return { res: await spare.c.post("/account/mfa/recovery-codes", { code: await totpCode(spare.secret) }), actorId: spare.id };
    } },
    { key: "POST /account/password", as: spareAs, fields: () => ({ current: TEST_PASSWORD, next: NEWPW }) },
    { key: "POST /account/sessions/:id/revoke", run: async () => {
      const other = w.app.client();
      await other.post("/login", { email: spare.email, password: NEWPW });
      const sid = (await one<{ id: string }>(w, `SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`, spare.id)).id;
      return { res: await spare.c.post(`/account/sessions/${sid}/revoke`), actorId: spare.id };
    } },
    { key: "POST /account/sessions/revoke-others", as: spareAs, setup: async () => { await w.app.client().post("/login", { email: spare.email, password: NEWPW }); } },
    { key: "POST /account/privacy/export", as: spareAs },
    { key: "POST /account/privacy/delete", as: spareAs, fields: () => ({ confirm: "1", reason: "matrix" }) },

    // ── CMS and portfolio ──
    { key: "POST /staff/cms/:key", fields: () => ({ eyebrow: "Crestmont", heading: "A second hero heading.", lede: "Another lead paragraph for the homepage hero.", primary_label: "See packages", quote_label: "Get a quote", note: "audit" }) },
    { key: "POST /staff/cms/revisions/:id/publish", path: () => `/staff/cms/revisions/${w.ids.cmsRevision}/publish` },
    { key: "POST /staff/cms/:key/revert" },
    { key: "POST /staff/cms/revisions/:id/discard", path: () => `/staff/cms/revisions/${x.cmsDraft}/discard`, setup: async () => {
      await owner(w).c.post("/staff/cms/home.hero", { eyebrow: "Crestmont", heading: "A draft to discard.", lede: "A lead paragraph that will be discarded.", primary_label: "See packages", quote_label: "Get a quote", note: "discard me" });
      x.cmsDraft = (await one<{ id: string }>(w, `SELECT id FROM cms_revisions WHERE note = 'discard me'`)).id;
    } },
    { key: "POST /staff/cms/revisions/:id/restore", path: () => `/staff/cms/revisions/${x.cmsDraft}/restore` },
    { key: "POST /staff/portfolio", fields: () => ({ name: "Audit Portfolio", slug: "audit-portfolio", industry: "Retail", live_url: "https://audit.matrix.example", description: "A verified description of the live website.", features: "Contact form", technology_summary: "", relationship: "Relationship documentation pending" }) },
    { key: "POST /staff/portfolio/:id", fields: () => ({ name: "Matrix Portfolio", slug: "matrix-portfolio", industry: "Retail", live_url: "https://portfolio.matrix.example", description: "An updated verified description of the live website.", features: "Single-page website", technology_summary: "", relationship: "Relationship documentation pending" }) },
    { key: "POST /staff/portfolio/:id/screenshot", fields: () => ({ kind: "mobile", captured_on: day(-1), screenshot: png("mobile.png") }) },
    { key: "POST /staff/portfolio/:id/verify-link", fields: () => ({ verified_on: day(-1) }) },
    { key: "POST /staff/portfolio/:id/relationship", fields: () => ({ relationship: "Website built by the Crestmont Founder for a related business", evidence: "Founder authorization letter on file, dated 2026-10-26" }) },
    { key: "POST /staff/portfolio/:id/publish" },
    { key: "POST /staff/portfolio/:id/move", fields: () => ({ dir: "up" }) },
    { key: "POST /staff/portfolio/:id/testimonials", fields: () => ({ author: "B. Person", body: "Clear, careful and on time.", evidence: "Email from author dated 2026-10-26 granting permission" }) },
    { key: "POST /staff/portfolio/testimonials/:tid/:action" },
    { key: "POST /staff/portfolio/:id/unpublish" },

    // ── Customer portal (tenant A administrator) ──
    cust("POST /portal/projects/:id/onboarding", { setup: async () => { await w.db.prepare(`UPDATE projects SET status = 'awaiting_onboarding' WHERE id = ?`).bind(a.ids.project).run(); } }),
    cust("POST /portal/files"),
    cust("POST /portal/projects/:id/files"),
    cust("POST /portal/files/:id/move"),
    cust("POST /portal/files/:id/replace"),
    cust("POST /portal/files/:id/delete", { path: () => `/portal/files/${a.ids.file2}/delete` }),
    { key: "GET /files/:id", as: custA, path: () => `/files/${a.ids.file}` },
    { key: "GET /files/:id/preview", as: custA, path: () => `/files/${a.ids.file}/preview` },
    cust("POST /files/:id/share"),
    cust("POST /files/share-links/:id/revoke"),
    cust("POST /portal/messages/general"),
    cust("POST /portal/projects/:id/messages"),
    cust("POST /portal/projects/:id/revisions", { setup: async () => { await w.db.prepare(`UPDATE projects SET status = 'design' WHERE id = ?`).bind(a.ids.project).run(); } }),
    cust("POST /portal/change-orders/:id/decide"),
    cust("POST /portal/projects/:id/approvals"),
    cust("POST /portal/team"),
    cust("POST /portal/team/members/:userId/role", { path: () => `/portal/team/members/${x.member2}/role`, setup: async () => {
      x.member2 = newId("usr");
      await w.db.batch([
        w.db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, created_at) VALUES (?, 'second-member@a.matrix.example', 'Second Member', 'x', ?, ?)`).bind(x.member2, nowIso(), nowIso()),
        w.db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?, 'customer_member', ?)`).bind(newId("mbr"), x.member2, a.orgId, nowIso()),
      ]);
    } }),
    cust("POST /portal/team/members/:userId/remove", { path: () => `/portal/team/members/${x.member2}/remove` }),
    cust("POST /portal/team/invitations/:id/revoke"),
    { key: "GET /portal/billing/invoices/:id/pdf", as: custA, path: () => `/portal/billing/invoices/${a.ids.paidInvoice}/pdf` },
    { key: "GET /portal/billing/receipts/:paymentId/pdf", as: custA, path: () => `/portal/billing/receipts/${a.ids.payment}/pdf` },
    cust("POST /portal/support/new"),
    cust("POST /portal/support/:id/reply"),
    cust("POST /portal/billing/invoices/:id/pay"),
    cust("POST /portal/billing/manage", { setup: async () => { await w.db.prepare(`UPDATE organizations SET stripe_customer_id = 'cus_matrix_a' WHERE id = ?`).bind(a.orgId).run(); } }),
    cust("POST /portal/billing/refund-request", { setup: async () => {
      // A second paid payment so a fresh refund request is allowed (one open request per payment).
      const ord = newId("ord"), inv = newId("inv"), pay = newId("pay");
      await w.db.batch([
        w.db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, created_at) VALUES (?,?, 'starter', 99900, 'paid', 'package', ?)`).bind(ord, a.orgId, nowIso()),
        w.db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, description, created_at, paid_at) VALUES (?,?,?, 'full', 99900, 'paid', 'Starter', ?, ?)`).bind(inv, a.orgId, ord, nowIso(), nowIso()),
        w.db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, order_id, amount_cents, fee_cents, stripe_payment_intent_id, status, created_at) VALUES (?,?,?,?, 99900, NULL, 'pi_audit_refund', 'succeeded', ?)`).bind(pay, a.orgId, inv, ord, nowIso()),
      ]);
      a.ids.payment = pay;
    } }),
    cust("POST /checkout/:packageId"),
    cust("POST /checkout/maintenance/:planId"),
    // The proposal is accepted by the customer account registered with the lead's own email address.
    { key: "POST /q/:token/accept", run: async () => {
      const cu = await createCustomer(w.db, "lead@matrix.example", "Lead Co Customer");
      const c = await w.app.client().login(cu.email);
      return { res: await c.post(`/q/${w.ids.quoteToken}/accept`, { agree: "1" }), actorId: cu.id };
    } },

    // ── CRM and quotes ──
    { key: "GET /staff/crm/export.csv" },
    { key: "POST /staff/crm/new", fields: () => ({ name: "Audit Lead", email: "audit-lead@matrix.example", phone: "", company: "Audit Co", website: "", interest: "starter", message: "Hello", source: "referral" }) },
    { key: "POST /staff/crm/leads/:id/stage", fields: () => ({ to: "qualified" }) },
    { key: "POST /staff/crm/leads/:id/tasks/:taskId/complete" },
    { key: "POST /staff/crm/leads/:id/contact", fields: () => ({ name: "Matrix Lead", email: "lead@matrix.example", phone: "+1 555 0100", company: "Lead Co", website: "https://lead.example", qualification_notes: "Budget confirmed" }) },
    { key: "POST /staff/crm/leads/:id/assign", fields: () => ({ owner: s.sales.id }) },
    { key: "POST /staff/crm/leads/:id/ai-draft" },
    { key: "POST /staff/crm/leads/:id/ai-draft/:jobId", fields: () => ({ decision: "approved" }) },
    { key: "POST /staff/quotes/new", path: () => `/staff/quotes/new?lead=${x.lead2}`, fields: () => ({ package: "starter", scope: "Starter package website: five pages with a contact form.", valid_until: day(20) }),
      setup: async () => { x.lead2 = (await one<{ id: string }>(w, `SELECT l.id FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE c.email = 'audit-lead@matrix.example'`)).id; } },
    { key: "POST /staff/quotes/:id", path: () => `/staff/quotes/${x.quote2}`, fields: () => ({ package: "premium", scope: "Premium package website: twenty pages with booking and a blog.", valid_until: day(25) }),
      setup: async () => { x.quote2 = (await one<{ id: string }>(w, `SELECT id FROM quotes WHERE lead_id = ?`, x.lead2)).id; } },
    { key: "POST /staff/quotes/:id/send", path: () => `/staff/quotes/${x.quote2}/send` },
    { key: "POST /staff/quotes/:id/close", path: () => `/staff/quotes/${x.quote2}/close`, fields: () => ({ kind: "withdrawn", reason: "Scope changed after the call" }) },
    { key: "GET /staff/quotes/export.csv" },
    { key: "GET /staff/customers/export.csv" },
    { key: "POST /staff/crm/duplicates/dismiss", fields: () => ({ a: w.ids.lead!, b: x.lead2, back: "/staff/crm/duplicates" }) },
    { key: "POST /staff/crm/leads/:id/merge", path: () => `/staff/crm/leads/${x.mergeSrc}/merge`, fields: () => ({ into: x.lead2 }), setup: async () => {
      await owner(w).c.post("/staff/crm/new", { name: "Merge Source", email: "merge-source@matrix.example", phone: "", company: "", website: "", interest: "starter", message: "dup", source: "referral" });
      x.mergeSrc = (await one<{ id: string }>(w, `SELECT l.id FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE c.email = 'merge-source@matrix.example'`)).id;
    } },

    // ── Delivery (tenant A's project) ──
    { key: "POST /staff/conversations/:orgId", path: () => `/staff/conversations/${a.orgId}`, fields: () => ({ body: "Following up on your question." }) },
    { key: "POST /staff/projects/:id/status", path: () => P(w, "POST /staff/projects/:id/status"), fields: () => ({ to: "paused", note: "Waiting on content" }) },
    { key: "POST /staff/projects/:id/resume", path: () => P(w, "POST /staff/projects/:id/resume") },
    { key: "POST /staff/projects/:id/pm", path: () => P(w, "POST /staff/projects/:id/pm"), fields: () => ({ user_id: s.owner.id }) },
    { key: "POST /staff/projects/:id/target", path: () => P(w, "POST /staff/projects/:id/target"), fields: () => ({ target_launch_at: day(60) }) },
    { key: "POST /staff/projects/:id/assign", path: () => P(w, "POST /staff/projects/:id/assign"), fields: () => ({ user_id: s.support.id }) },
    { key: "POST /staff/assignments/:id/end", path: () => P(w, "POST /staff/assignments/:id/end") },
    { key: "POST /staff/projects/:id/scope", path: () => P(w, "POST /staff/projects/:id/scope"), fields: () => ({ scope: "Revised scope: six pages, contact form and booking." }) },
    { key: "POST /staff/projects/:id/request-approval", path: () => P(w, "POST /staff/projects/:id/request-approval"), fields: () => ({ kind: "design", note: "Please review the design" }) },
    { key: "POST /staff/projects/:id/approvals", path: () => P(w, "POST /staff/projects/:id/approvals"), fields: () => ({ kind: "internal_qa", decision: "approved", notes: "QA passed" }) },
    { key: "POST /staff/projects/:id/invoices", path: () => P(w, "POST /staff/projects/:id/invoices"), fields: () => ({ kind: "design_25" }),
      setup: async () => {
        await w.db.prepare(`UPDATE projects SET payment_schedule = 'milestone_50_25_25' WHERE id = ?`).bind(a.ids.project).run();
        // The design milestone invoice needs the customer's design approval (requested by the scenario above).
        await a.admin.c.post(`/portal/projects/${a.ids.project}/approvals`, { kind: "design", decision: "approved", notes: "Design approved" });
      } },
    // Deployment is recorded on tenant B's (upfront, paid) project once its release chain is complete (fixture shortcut: rows inserted directly).
    { key: "POST /staff/projects/:id/deployments", path: () => P(w, "POST /staff/projects/:id/deployments", w.b), fields: () => ({ url: "https://b.matrix.example", commit_sha: "abc1234" }),
      setup: async () => {
        const pid = w.b.ids.project!;
        await w.db.prepare(`UPDATE projects SET status = 'final_approval' WHERE id = ?`).bind(pid).run();
        for (const kind of ["engineering_complete", "internal_qa", "security_accessibility", "customer_launch", "deployment_authorized"]) {
          await w.db.prepare(`INSERT INTO approvals (id, project_id, kind, decision, decided_by, notes, created_at) VALUES (?,?,?, 'approved', ?, 'fixture', ?)`).bind(newId("apv"), pid, kind, s.owner.id, nowIso()).run();
        }
        await w.db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, created_at) VALUES (?, 'user', 'project.status_changed', 'project', ?, '{"to":"customer_review"}', ?)`).bind(s.owner.id, pid, nowIso()).run();
      } },
    { key: "POST /staff/projects/:id/handoff", path: () => P(w, "POST /staff/projects/:id/handoff"), fields: () => ({ intent: "draft", website_url: "https://a.matrix.example", documentation: "Editing guide" }) },
    { key: "POST /staff/projects/:id/costs", path: () => P(w, "POST /staff/projects/:id/costs"), fields: () => ({ category: "hosting", amount: "12.50", description: "Hosting October", incurred_on: day(-2) }) },
    { key: "POST /staff/projects/:id/change-orders", path: () => P(w, "POST /staff/projects/:id/change-orders"), fields: () => ({ scope: "Add a gallery page with lightbox", price: "300" }) },
    { key: "POST /staff/revisions/:id/status", path: () => P(w, "POST /staff/revisions/:id/status"), fields: () => ({ status: "in_progress" }) },
    { key: "POST /staff/projects/:id/messages", path: () => P(w, "POST /staff/projects/:id/messages"), fields: () => ({ body: "Design draft is ready." }) },
    { key: "POST /staff/projects/:id/files", path: () => P(w, "POST /staff/projects/:id/files"), fields: () => ({ file: pdf("design-draft.pdf") }) },
    { key: "POST /staff/projects/:id/milestones", path: () => P(w, "POST /staff/projects/:id/milestones"), fields: () => ({ name: "SEO pass", due_at: day(30) }) },
    { key: "POST /staff/milestones/:id", path: () => P(w, "POST /staff/milestones/:id"), fields: () => ({ status: "in_progress" }) },
    { key: "POST /staff/projects/:id/tasks", path: () => P(w, "POST /staff/projects/:id/tasks"), fields: () => ({ title: "Audit task", estimate_minutes: "60" }) },
    { key: "POST /staff/tasks/:id/status", path: () => P(w, "POST /staff/tasks/:id/status"), fields: () => ({ status: "in_progress" }) },
    { key: "POST /staff/tasks/:id", path: () => P(w, "POST /staff/tasks/:id"), fields: () => ({ title: "Renamed task", description: "", estimate_minutes: "90", due_at: day(10), milestone_id: "" }) },
    { key: "POST /staff/tasks/:id/dependencies/:dep/delete", path: () => P(w, "POST /staff/tasks/:id/dependencies/:dep/delete") },
    { key: "POST /staff/tasks/:id/dependencies", path: () => P(w, "POST /staff/tasks/:id/dependencies"), fields: () => ({ depends_on: a.ids.task2! }) },
    { key: "POST /staff/tasks/:id/time", path: () => P(w, "POST /staff/tasks/:id/time"), fields: () => ({ minutes: "45", worked_on: day(-1), hourly_cost: "50" }) },
    { key: "POST /staff/tasks/:id/assign", path: () => P(w, "POST /staff/tasks/:id/assign"), fields: () => ({ user_id: s.project_manager.id }) },
    { key: "POST /staff/tasks/:id/delete", path: () => `/staff/tasks/${x.delTask}/delete`, setup: async () => {
      await owner(w).c.post(`/staff/projects/${a.ids.project}/tasks`, { title: "Task to delete" });
      x.delTask = (await one<{ id: string }>(w, `SELECT id FROM tasks WHERE title = 'Task to delete'`)).id;
    } },
    { key: "POST /staff/milestones/:id/delete", path: () => `/staff/milestones/${x.delMs}/delete`, setup: async () => {
      await owner(w).c.post(`/staff/projects/${a.ids.project}/milestones`, { name: "Milestone to delete", due_at: day(40) });
      x.delMs = (await one<{ id: string }>(w, `SELECT id FROM milestones WHERE name = 'Milestone to delete'`)).id;
    } },
    // Staff side of the shared file routes (the Owner shares and revokes a customer file).
    { key: "POST /files/:id/share", path: () => `/files/${a.ids.file}/share`, fields: () => ({ hours: "48", acknowledge_unscanned: "1" }) },
    { key: "POST /files/share-links/:id/revoke", path: () => `/files/share-links/${x.staffShare}/revoke`, setup: async () => {
      x.staffShare = (await one<{ id: string }>(w, `SELECT id FROM share_links WHERE file_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, a.ids.file)).id;
    } },

    // ── Support ──
    { key: "POST /staff/support/settings", fields: () => ({ staffed_hours: "Mon–Fri 9:00–17:00 Eastern", target_hours: "8" }) },
    { key: "POST /staff/support/:id/assign", path: () => P(w, "POST /staff/support/:id/assign"), fields: () => ({ assignee: s.support.id }) },
    { key: "POST /staff/support/:id/triage", path: () => P(w, "POST /staff/support/:id/triage"), fields: () => ({ priority: "high", category: "technical" }) },
    { key: "POST /staff/support/:id/escalate", path: () => P(w, "POST /staff/support/:id/escalate"), fields: () => ({ reason: "Site down for the customer" }) },
    { key: "POST /staff/support/:id/note", path: () => P(w, "POST /staff/support/:id/note"), fields: () => ({ body: "Checked DNS" }) },
    { key: "POST /staff/support/:id/reply", path: () => P(w, "POST /staff/support/:id/reply"), fields: () => ({ body: "We are looking at it now." }) },
    { key: "POST /staff/support/:id/draft", path: () => P(w, "POST /staff/support/:id/draft") },
    { key: "POST /staff/support/:id/draft/discard", path: () => P(w, "POST /staff/support/:id/draft/discard"), fields: () => ({ ai_job_id: x.supportDraft }),
      setup: async () => { x.supportDraft = (await one<{ id: string }>(w, `SELECT id FROM ai_jobs WHERE workflow = 'support_reply' AND status = 'awaiting_approval' ORDER BY created_at DESC LIMIT 1`)).id; } },
    { key: "POST /staff/support/:id/status", path: () => P(w, "POST /staff/support/:id/status"), fields: () => ({ status: "resolved" }) },
    cust("POST /portal/support/:id/reopen"),

    // ── Refunds and finance ──
    { key: "POST /staff/refunds/:id/review", as: (ww) => ww.staff.support, path: () => P(w, "POST /staff/refunds/:id/review"), fields: () => ({ to: "under_review", notes: "Checking project status" }) },
    { key: "POST /staff/refunds/:id/decide", path: () => P(w, "POST /staff/refunds/:id/decide"), fields: () => ({ decision: "approved", notes: "Approved per policy." }),
      setup: async () => { await w.staff.support.c.post(P(w, "POST /staff/refunds/:id/review"), { to: "recommended", notes: "No work started" }); } },
    { key: "POST /staff/refunds/:id/issue", path: () => P(w, "POST /staff/refunds/:id/issue") },
    { key: "POST /staff/finance/costs", fields: () => ({ project_id: a.ids.project!, category: "hosting", amount: "40.50", description: "Cloudflare hosting", incurred_on: day(-3) }) },
    { key: "GET /staff/reports/:file" },
    { key: "GET /staff/reports/operations/summary.csv" },
    { key: "GET /staff/reports/operations/time.csv" },
    { key: "GET /staff/finance/invoices/:id/pdf", path: () => `/staff/finance/invoices/${a.ids.paidInvoice}/pdf` },
    { key: "GET /staff/finance/receipts/:paymentId/pdf", path: () => `/staff/finance/receipts/${a.ids.payment}/pdf` },
    { key: "POST /staff/finance/invoices/:id/stripe-invoice" },
    { key: "GET /staff/projects/export.csv" },
    { key: "GET /staff/tasks/export.csv" },
    { key: "GET /staff/support/export.csv" },
    { key: "POST /staff/pricing", as: (ww) => ww.staff.sales, fields: () => ({ item: "package:business", proposed: "2599", effective_date: day(2), reason: "Audit market adjustment (TEST DATA)" }) },
    { key: "POST /staff/pricing/:id/decide", fields: () => ({ decision: "approved", note: "Approved" }) },
    { key: "POST /staff/email-suppressions/:id/remove", fields: () => ({ note: "Customer confirmed the new mailbox works" }) },
    { key: "POST /staff/finance/reconciliation/:id/resolve", fields: () => ({ resolution: "no_action_needed", note: "Test-mode session from a deleted invoice; nothing owed." }) },
    { key: "POST /staff/finance/reconciliation/:id/reopen", fields: () => ({ note: "Customer disputes this; reviewing again." }) },

    // ── Readiness and operations ──
    { key: "POST /staff/readiness/blockers/new", fields: () => ({ category: "security", severity: "medium", description: "Audit blocker description", subsystem: "Platform", owner: "Engineering", required_action: "Do the thing properly", dependency: "", requirement_ids: "" }) },
    { key: "POST /staff/readiness/blockers/:id", fields: () => ({ category: "security", severity: "high", description: "Matrix blocker description (edited)", subsystem: "Authentication", owner: "Engineering", required_action: "Scope cookie to app domain", dependency: "", requirement_ids: "AUTH-007" }) },
    { key: "POST /staff/readiness/blockers/:id/resolve", fields: () => ({ evidence: "Fixed in commit 1a2b3c4; verified by test run ci-55" }) },
    { key: "POST /staff/readiness/blockers/:id/reopen", fields: () => ({ reason: "Regression found in review" }) },
    { key: "POST /staff/readiness/security", fields: () => ({ title: "Audit finding", severity: "medium", source: "Manual review", detail: "" }) },
    { key: "POST /staff/readiness/security/:id/resolve", fields: () => ({ outcome: "resolved", evidence: "Escaped output in commit 9f8e7d6, retested" }) },
    { key: "POST /staff/readiness/releases", fields: () => ({ commit_sha: "abc1234def5678abc1234def5678abc1234def56", config_sha256: "a".repeat(64), notes: "Candidate notes", rollback_plan: "Redeploy previous worker version" }) },
    { key: "POST /staff/readiness/approve", fields: () => ({ decision: "approved", confirm_commit: "abc1234def5678abc1234def5678abc1234def56", evidence_set: x.evSet, notes: "Approved" }),
      setup: async () => { x.evSet = /name="evidence_set" value="([0-9a-f]{64})"/.exec(await (await owner(w).c.get("/staff/readiness/approve")).text())![1]; } },
    { key: "POST /staff/readiness/snapshots" },
    { key: "GET /staff/readiness/export.csv" },
    { key: "GET /staff/readiness/packet.json" },
    { key: "GET /staff/readiness/founder-report.md" },
    { key: "GET /api/readiness/requirements.csv" },
    { key: "POST /staff/ops/probe" },
    { key: "POST /staff/ops/environments", fields: () => ({ staging_url: "https://staging.matrix.example", production_url: "https://matrix.example" }) },
    { key: "POST /staff/ops/retention", fields: () => ({ "retention.app_errors_days": "60" }) },

    // ── Platform ──
    { key: "POST /staff/employees/invite", fields: () => ({ email: "second-invitee@matrix.crestmont.test", role: "support" }) },
    { key: "POST /staff/employees/invitations/:id/revoke" },
    { key: "POST /staff/employees/:id/role", fields: () => ({ role: "project_manager" }) },
    { key: "POST /staff/employees/:id/disable", fields: () => ({ reason: "Left the company" }) },
    { key: "POST /staff/employees/:id/enable" },
    { key: "POST /staff/employees/:id/mfa-reset" },
    { key: "POST /staff/employees/:id/profile", fields: () => ({ job_title: "Front-end developer", weekly_capacity_hours: "30" }) },
    { key: "GET /staff/employees/export.csv" },
    { key: "GET /staff/email/export.csv" },
    { key: "GET /staff/security/events.csv" },
    { key: "GET /staff/ai/export.csv" },
    { key: "GET /staff/email/:id/html" },
    { key: "POST /staff/email/:id/retry" },
    { key: "POST /staff/integrations/:name/verify" },
    { key: "POST /staff/privacy/:id/process", fields: () => ({ decision: "complete", notes: "Verified by email" }) },
    { key: "GET /staff/audit/export.csv" },
    { key: "POST /staff/backups/records", fields: () => ({ what: "D1 dev export", location: "local disk ~/backups/dev.sql", environment: "development", method: "d1_export", taken_at: day(-2) + "T10:00", result: "succeeded", evidence: "wrangler d1 export output: 12 tables", size_bytes: "2048" }) },
    { key: "POST /staff/backups/restore-tests", fields: () => ({ what: "dev db", target: "scratch sqlite file", environment: "development", performed_at: day(-1) + "T11:00", result: "passed", duration_minutes: "12", evidence: "row counts matched for 12 tables" }) },
    { key: "POST /staff/settings", fields: () => ({ "business.legal_name": "", "business.address": "", "contact.email": "hello@matrix.crestmont.test", "contact.phone": "", staffed_hours: "Mon–Fri 9am–5pm ET", first_response_target_hours: "8" }) },
    { key: "POST /staff/settings/tax", fields: () => ({ notes: "Matrix test: registration not decided (TEST DATA)" }) },
    { key: "POST /staff/settings/tax/jurisdictions", fields: () => ({ name: "Matrix Test Jurisdiction", registration_id: "TEST-0001", rate: "1.5" }) },
    { key: "POST /staff/ai/:id/decide", fields: () => ({ decision: "approved", final_text: "Edited draft" }), setup: async () => {
      w.ids.aiJob = newId("ai");
      await w.db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, output_ref, created_at, updated_at) VALUES (?, 'quote_draft', 'anthropic', 'test', 'awaiting_approval', 'quote:x', 'Draft', ?, ?)`).bind(w.ids.aiJob, nowIso(), nowIso()).run();
    } },
    { key: "POST /staff/ai/:id/retry", setup: async () => {
      w.ids.aiJob = newId("ai");
      await w.db.batch([
        w.db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, error, created_at, updated_at) VALUES (?, 'lead_qualification', 'anthropic', 'test', 'failed', ?, 'timeout', ?, ?)`).bind(w.ids.aiJob, `lead:${w.ids.lead}`, nowIso(), nowIso()),
        w.db.prepare(`INSERT INTO ai_job_inputs (job_id, prompt, created_at) VALUES (?, 'Summarize this lead', ?)`).bind(w.ids.aiJob, nowIso()),
      ]);
    } },
    { key: "POST /staff/voice/configs", fields: () => ({ instructions: "Greet the caller warmly, state you are an AI assistant, and help with questions about services and packages.\nAlways offer a callback.", note: "Callback" }) },
    { key: "POST /staff/voice/configs/:version/activate" },
    { key: "POST /staff/voice/test-event", fields: () => ({ scenario: "callback" }) },
    { key: "GET /staff/voice/calls/:id" },

    // ── AI Builds (owner controls) ──
    { key: "POST /staff/ai/budget", fields: () => ({ monthly_budget_usd: "25" }) },
    { key: "POST /staff/builds/settings", fields: () => ({ run_budget: "30", project_budget: "90", model: "claude-sonnet-5-5", max_runtime: "120", max_turns: "200", max_concurrent: "2", max_attempts: "3", automation_enabled: "1" }) },
    { key: "POST /staff/builds/pause", fields: () => ({ paused: "1", reason: "matrix pause" }) },
    { key: "POST /staff/builds/projects/:projectId/pause", fields: () => ({ paused: "1", reason: "matrix project pause" }) },
    { key: "POST /staff/builds/projects/:projectId/budget", fields: () => ({ project_budget: "50" }) },
    // Earlier refund scenarios made tenant A's order ineligible, which (correctly) canceled its build; restore the fixture state.
    { key: "POST /staff/builds/:id/approve", fields: () => ({ notes: "matrix approval" }), setup: async () => { await w.db.prepare(`UPDATE build_jobs SET state = 'ready_for_review' WHERE id = ?`).bind(w.ids.buildJob).run(); } },
    { key: "POST /staff/builds/:id/revision", fields: () => ({ instruction: "Make the hero heading larger and add the opening hours to the footer." }), setup: async () => {
      // Eligibility for new automated work: submitted intake, no approved/issued refund on the order.
      await w.db.prepare(`UPDATE onboarding_responses SET completed_at = ? WHERE project_id = ?`).bind(nowIso(), w.a.ids.project).run();
      await w.db.prepare(`UPDATE refunds SET status = 'denied' WHERE status IN ('approved','issued') AND payment_id IN (SELECT id FROM payments WHERE order_id = (SELECT order_id FROM projects WHERE id = ?))`).bind(w.a.ids.project).run();
      await w.db.prepare(`UPDATE payments SET status = 'succeeded' WHERE order_id = (SELECT order_id FROM projects WHERE id = ?)`).bind(w.a.ids.project).run();
    } },
    // Founder decision D1: the owner rejects a customer's revision request (no AI build; customer told why).
    { key: "POST /staff/builds/customer-revisions/:id/reject", fields: () => ({ reason: "Outside the agreed scope for this package." }), setup: async () => {
      await w.db.prepare(`UPDATE build_jobs SET state = 'canceled' WHERE customer_revision_id = ?`).bind(w.a.ids.revision).run();
      await w.db.prepare(`UPDATE revisions SET status = 'submitted', included = 1, ai_decision = NULL, ai_decided_by = NULL, ai_decided_at = NULL, ai_decision_note = NULL WHERE id = ?`).bind(w.a.ids.revision).run();
    } },
    // A customer's open, included revision request forwarded to the AI builder (owner_approval policy).
    { key: "POST /staff/builds/customer-revisions/:id/forward", fields: () => ({ instruction: "Add the opening hours to the contact page footer." }), setup: async () => {
      await w.db.prepare(`UPDATE build_jobs SET state = 'canceled' WHERE project_id = ? AND id <> ?`).bind(w.a.ids.project, w.ids.buildJob).run();
      await w.db.prepare(`UPDATE build_jobs SET state = 'ready_for_review' WHERE id = ?`).bind(w.ids.buildJob).run();
      await w.db.prepare(`UPDATE revisions SET status = 'submitted', included = 1, ai_decision = NULL, ai_decided_by = NULL, ai_decided_at = NULL, ai_decision_note = NULL WHERE id = ?`).bind(w.a.ids.revision).run();
      await w.db.prepare(`UPDATE onboarding_responses SET completed_at = ? WHERE project_id = ?`).bind(nowIso(), w.a.ids.project).run();
      await w.db.prepare(`UPDATE refunds SET status = 'denied' WHERE status IN ('approved','issued') AND payment_id IN (SELECT id FROM payments WHERE order_id = (SELECT order_id FROM projects WHERE id = ?))`).bind(w.a.ids.project).run();
      await w.db.prepare(`UPDATE payments SET status = 'succeeded' WHERE order_id = (SELECT order_id FROM projects WHERE id = ?)`).bind(w.a.ids.project).run();
    } },
    { key: "POST /staff/builds/:id/preview-retention", fields: () => ({ action: "extend" }), setup: async () => {
      await w.db.prepare(`UPDATE build_jobs SET preview_name = 'cm-prv-matrix-b0', preview_deleted_at = NULL, preview_delete_claimed_at = NULL WHERE id = ?`).bind(w.ids.buildJob).run();
    } },
    // Founder decision D3: private previews (owner opens/shares; the project's customer opens/reviews a shared one).
    { key: "GET /staff/builds/:id/preview", setup: async () => {
      await w.db.prepare(`UPDATE build_jobs SET state = 'ready_for_review', preview_url = 'https://cm-prv-matrix-b0.acct.workers.dev', preview_name = 'cm-prv-matrix-b0', preview_gated = 1, preview_deleted_at = NULL, customer_preview_shared_at = NULL WHERE id = ?`).bind(w.ids.buildJob).run();
    } },
    { key: "POST /staff/builds/:id/share-preview", fields: () => ({ action: "share" }) },
    { key: "GET /portal/projects/:id/previews/:buildId", as: custA, path: () => `/portal/projects/${a.ids.project}/previews/${w.ids.buildJob}` },
    { key: "POST /portal/projects/:id/previews/:buildId/review", as: custA, path: () => `/portal/projects/${a.ids.project}/previews/${w.ids.buildJob}/review`, fields: () => ({ decision: "changes_requested", note: "Please use the new logo." }) },
    { key: "POST /staff/builds/:id/delete-preview", setup: async () => {
      await w.db.prepare(`UPDATE build_jobs SET state = 'ready_for_review', preview_name = 'cm-prv-matrix-b0', preview_deleted_at = NULL, preview_delete_requested_at = NULL, source_commit = 'abc123', checkpoint_key = 'builds/matrix/ckpt-1.tgz' WHERE id = ?`).bind(w.ids.buildJob).run();
    } },
    { key: "POST /staff/builds/:id/retry", setup: async () => {
      await w.db.prepare(`UPDATE build_jobs SET state = 'canceled' WHERE project_id = ? AND kind = 'revision'`).bind(w.a.ids.project).run();
      await w.db.prepare(`UPDATE build_jobs SET state = 'failed' WHERE id = ?`).bind(w.ids.buildJob).run();
    } },
    { key: "POST /staff/builds/:id/resume", setup: async () => { await w.db.prepare(`UPDATE build_jobs SET state = 'paused' WHERE id = ?`).bind(w.ids.buildJob).run(); } },
    { key: "POST /staff/builds/:id/cancel", fields: () => ({ reason: "matrix cancel" }) },
    { key: "POST /staff/builds/backfill", fields: () => ({ project_id: w.b.ids.project! }) },

    // Last: cancelling tenant A's project (Owner only).
    { key: "POST /staff/projects/:id/cancel", path: () => P(w, "POST /staff/projects/:id/cancel"), fields: () => ({ reason: "Customer requested cancellation in writing" }) },
  ];
}

