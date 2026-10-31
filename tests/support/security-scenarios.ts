// Success scenarios for every audited route in the inventory (EMP-002), and valid form bodies for every
// customer POST (reused by the tenant-isolation and fuzz tests). Each scenario performs the action
// for real, so the matrix can prove the audit row it writes. Every record created here is TEST DATA.
import { createCustomer, TEST_PASSWORD, type TestClient } from "./app.ts";
import { pdf, png, type World, type Tenant } from "./security-world.ts";
import { pathFor } from "./security-helpers.ts";
import { ROUTE_INVENTORY } from "./route-inventory.ts";
import { newId, nowIso } from "../../src/lib/db.ts";
import { createPackageOrder } from "../../src/services/commerce.ts";
import { totpCode } from "../../src/lib/auth-crypto.ts";
import { baselineSalesInstructions as baselineSales } from "../../src/domain/sales-opt/policy.ts";

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
    "POST /portal/projects/:id/previews/:buildId/review": () => ({ decision: "changes_requested", note: `${t.marker} please use the new logo` }),
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
    "POST /account/profile": () => ({ display_name: `${t.marker} Admin` }),
    "POST /account/email": () => ({ new_email: `changed-${Math.random().toString(16).slice(2, 8)}@${t.marker.toLowerCase()}.example`, current_password: TEST_PASSWORD }),
    "POST /account/email/cancel": () => ({}),
    "POST /portal/notices/mfa-reminder/dismiss": () => ({}),
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
  let simOrg: { id: string; organizationId: string } | undefined;
  let simInvoice: string | undefined;
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
    // CREST-GAP-072 / 073
    { key: "POST /account/profile", as: spareAs, fields: () => ({ display_name: "Spare Account Holder" }) },
    { key: "POST /account/email", as: spareAs, fields: () => ({ new_email: "spare-new-address@matrix.example", current_password: NEWPW }) },
    { key: "POST /account/email/cancel", as: spareAs },
    { key: "POST /portal/notices/mfa-reminder/dismiss", as: spareAs },
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
    { key: "POST /staff/portfolio/:id/demo", fields: () => ({ demo_url: "", demo_status: "none", demo_revision: "matrix-site@abc1234", demo_verified_on: "", poster_desktop_asset: "/assets/portfolio/matrix-desktop.webp", poster_mobile_asset: "" }) },
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
    { key: "POST /staff/crm/identity-erasure", fields: () => ({ phones: "", emails: "erase-me@matrix.example", note: "Matrix: person asked by email" }) },
    { key: "POST /staff/crm/identity-reviews/resolve", fields: () => ({ id: x.review, decision: "reject", back: "/staff/crm/duplicates?view=review" }), setup: async () => {
      x.review = newId("rev");
      await w.db.prepare(`INSERT INTO crm_identity_reviews (id, kind, lead_id, reason, dedupe_key, created_at) VALUES (?, 'possible_duplicate', ?, 'matrix test item', ?, ?)`).bind(x.review, w.ids.lead!, `matrix:${x.review}`, nowIso()).run();
    } },
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
    // CREST-GAP-041: a disabled person's queued work is ended from the offboarding queue.
    { key: "POST /staff/employees/:id/offboarding", fields: () => ({ item: "all", action: "end" }), setup: async () => {
      await w.db.prepare(`UPDATE users SET disabled_at = ? WHERE id = ?`).bind(nowIso(), w.ids.staffUser).run();
      await w.db.prepare(`INSERT INTO offboarding_items (id, user_id, subject_type, subject_id, label, status, created_at) VALUES (?, ?, 'task', ?, 'Matrix task', 'pending', ?)`).bind(newId("off"), w.ids.staffUser, w.a.ids.task, nowIso()).run();
    } },
    { key: "GET /staff/customers/:id" },
    { key: "GET /staff/conversations/:orgId" },
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
    // No agent id is recorded in the matrix world, so this records "not_configured" without any Retell request.
    { key: "POST /staff/voice/prompt-sync", fields: () => ({ mode: "check" }) },
    { key: "POST /staff/voice/budget", fields: () => ({ monthly_budget_usd: "40" }) },
    { key: "GET /staff/voice/calls/:id" },
    { key: "POST /staff/voice/operations/settings", fields: () => ({ timezone: "America/Detroit", "hours.mon": "09:00-17:00", "hours.tue": "09:00-17:00", "inbound.mode": "answer",
      "scheduling.duration_minutes": "30", "scheduling.min_notice_hours": "24", "scheduling.horizon_days": "21", "outbound.window_start": "09:00", "outbound.window_end": "20:00",
      "outbound.max_per_number_per_day": "1", "outbound.max_per_number_per_week": "3" }) },
    { key: "POST /staff/voice/consultations/:id/decide", fields: () => ({ decision: "confirm" }), setup: async () => {
      w.ids.consultation = newId("cns");
      const start = new Date(Date.now() + 5 * 86400e3).toISOString();
      await w.db.prepare(`INSERT INTO consultations (id, name, phone, starts_at, duration_minutes, timezone, status, confirmation_code, source, is_test, created_at, updated_at)
          VALUES (?, 'Matrix Caller', '+15550100990', ?, 30, 'America/Detroit', 'requested', ?, 'ai_receptionist', 1, ?, ?)`).bind(w.ids.consultation, start, w.ids.consultation.slice(-6).toUpperCase(), nowIso(), nowIso()).run();
    } },
    { key: "POST /staff/voice/outbound", fields: () => ({ purpose: "callback", phone: "+15550100991", name: "Matrix Caller", reason: "TEST DATA: caller asked for a callback", consent: "Asked by email for a callback (TEST DATA)" }) },
    { key: "POST /staff/voice/outbound/:id/decide", fields: () => ({ decision: "cancel", note: "matrix" }), setup: async () => {
      w.ids.outboundRequest = newId("vob");
      await w.db.prepare(`INSERT INTO voice_outbound_requests (id, purpose, phone_e164, reason, status, idempotency_key, is_test, created_at, updated_at)
          VALUES (?, 'callback', '+15550100992', 'TEST DATA', 'pending_approval', ?, 1, ?, ?)`).bind(w.ids.outboundRequest, `crestmont_${w.ids.outboundRequest}`, nowIso(), nowIso()).run();
    } },
    { key: "POST /staff/voice/dnc", fields: () => ({ phone: "+15550100993", detail: "Matrix opt-out (TEST DATA)" }) },
    // ── Outbound AI sales calls (TEST DATA; nothing dials: RETELL_SALES_OUTBOUND is unset) ──
    { key: "POST /staff/sales-outbound/settings", fields: () => ({ agent_id: "agent_matrix_sales_out", from_number: "+15550100970", max_concurrent: "1", max_per_run: "1", max_per_day: "5", max_attempts: "2", retry_after_hours: "48" }) },
    { key: "POST /staff/sales-outbound/compliance", fields: () => ({ action: "approve", counsel_reference: "MATRIX-COUNSEL-REF (TEST DATA)", notes: "", confirm: "1" }) },
    { key: "POST /staff/sales-outbound/consents", fields: () => ({ phone: "+15550100971", line_type: "landline", signer_name: "Matrix Signer", evidence_ref: "matrix-form-0001",
      disclosure_text: "I agree Crestmont may call this number about website services using an AI (artificial) voice. TEST DATA.", captured_at: new Date(Date.now() - 86400e3).toISOString() }) },
    { key: "POST /staff/sales-outbound/dnc-scrubs", fields: () => ({ phone: "+15550100972", registry: "national", result: "clear", source_ref: "MATRIX-SAN", checked_at: new Date(Date.now() - 3600e3).toISOString() }) },
    { key: "POST /staff/sales-outbound/queue", fields: () => ({ lead_id: w.ids.lead! }) },
    { key: "POST /staff/sales-outbound/queue/:id/cancel", fields: () => ({ note: "matrix" }) },
    // ── Lead research ──
    { key: "POST /staff/research/settings", fields: () => ({ paused: "1", reason: "Matrix pause (TEST DATA)", threshold: "60", max_batch: "100" }) },
    { key: "POST /staff/research/promote", fields: () => ({ prospect_id: w.ids.researchProspect! }), setup: async () => { w.ids.researchProspect = await insertResearchProspect(w, "+12025550143"); } },
    { key: "POST /staff/research/dismiss", fields: () => ({ prospect_id: w.ids.researchProspect2!, reason: "Matrix dismissal (TEST DATA)" }), setup: async () => { w.ids.researchProspect2 = await insertResearchProspect(w, "+12025550144"); } },
    { key: "POST /staff/voice/caller-erasure", fields: () => ({ phone: "+15550100994", note: "Matrix erasure request by email (TEST DATA)" }) },

    // ── AI Sales Optimization (TEST DATA; Retell is a fixture that answers only api.retellai.com) ──
    { key: "POST /staff/sales-optimization/control", fields: () => ({ paused: "1", auto_rollback: "1", minConnected: "50", maxOptOutRate: "15", maxComplianceRate: "2", maxComplaintRate: "5", maxErrorRate: "5", maxRefundRate: "20" }) },
    { key: "POST /staff/sales-optimization/targets", fields: () => ({ stage: "staging", agent_id: "agent_matrix_sales" }) },
    { key: "POST /staff/sales-optimization/targets/:stage/verify", setup: async () => {
      const real = globalThis.fetch;
      w.env.overrides = { ...w.env.overrides, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith("https://api.retellai.com/")
        ? new Response(JSON.stringify({ agent_id: "agent_matrix_sales", response_engine: { type: "retell-llm", llm_id: "llm_matrix_sales" } }), { status: 200 })
        : real(input, init)) as typeof fetch };
    } },
    { key: "POST /staff/sales-optimization/versions", fields: () => ({ parent_id: w.ids.soVersion!, instructions: `${baselineSales()}\nRepeat the email address back before ending the call.`, rationale: "Matrix: confirm email" }) },
    { key: "POST /staff/sales-optimization/versions/:id/evaluate" },
    { key: "POST /staff/sales-optimization/versions/:id/decide", fields: () => ({ decision: "reject", note: "matrix" }), path: () => `/staff/sales-optimization/versions/${x.soDraft}/decide`, setup: async () => {
      x.soDraft = (await w.db.prepare(`SELECT id FROM so_versions WHERE status = 'draft' ORDER BY seq DESC LIMIT 1`).first<{ id: string }>())!.id;
    } },
    { key: "POST /staff/sales-optimization/deploy", fields: () => ({ stage: "staging", version_id: w.ids.soVersion!, expected_current: "" }) },
    { key: "POST /staff/sales-optimization/rollback", fields: () => ({ stage: "staging" }) },
    { key: "POST /staff/sales-optimization/experiments", fields: () => ({ baseline_id: w.ids.soVersion!, candidate_id: w.ids.soVersion!, share: "20", min: "400" }) },
    { key: "POST /staff/sales-optimization/experiments/:id/decide", fields: () => ({ action: "start" }) },
    { key: "POST /staff/sales-optimization/run" },

    // ── AI Builds (owner controls) ──
    { key: "POST /staff/ai/budget", fields: () => ({ monthly_budget_usd: "25" }) },
    // Test-only payment simulation: a fresh fictional organization (the tenants have real Stripe payments and are refused).
    { key: "POST /staff/test-payments/organizations/:id/mark", setup: async () => {
      simOrg = await createCustomer(w.db, `sim-${Date.now()}@matrix.example`, "Matrix Simulation Test Org");
    }, path: () => `/staff/test-payments/organizations/${simOrg!.organizationId}/mark`, fields: () => ({ mark: "1", confirm: "Matrix Simulation Test Org" }) },
    { key: "POST /staff/test-payments/simulate", setup: async () => {
      simInvoice = (await createPackageOrder(w.db, simOrg!.organizationId, "starter", simOrg!.id)).invoiceId;
    }, fields: () => ({ invoice_id: simInvoice!, outcome: "paid" }) },
    { key: "POST /staff/builds/settings", fields: () => ({ run_budget: "30", project_budget: "90", model: "claude-sonnet-5-5", max_runtime: "120", max_turns: "200", max_concurrent: "2", max_attempts: "3", automation_enabled: "1" }) },
    { key: "POST /staff/builds/pause", fields: () => ({ paused: "1", reason: "matrix pause" }) },
    { key: "POST /staff/builds/projects/:projectId/pause", fields: () => ({ paused: "1", reason: "matrix project pause" }) },
    { key: "POST /staff/builds/projects/:projectId/budget", fields: () => ({ project_budget: "50" }) },
    // Earlier refund scenarios made tenant A's order ineligible, which (correctly) canceled its build; restore the fixture state.
    // V4 §7 F: the private internal review, then the final approval.
    { key: "POST /staff/builds/:id/internal-approve", fields: () => ({ note: "Matrix: reviewed the preview by hand" }), setup: async () => { await w.db.prepare(`UPDATE build_jobs SET state = 'ready_for_review', internal_approved_at = NULL, preview_url = COALESCE(preview_url, 'https://cm-prv-matrix-b0.acct.workers.dev'), preview_deleted_at = NULL, preview_delete_requested_at = NULL WHERE id = ?`).bind(w.ids.buildJob).run(); } },
    { key: "POST /staff/builds/:id/approve", fields: () => ({ notes: "matrix approval" }), setup: async () => { await w.db.prepare(`UPDATE build_jobs SET state = 'ready_for_review', internal_approved_at = COALESCE(internal_approved_at, ?), preview_url = COALESCE(preview_url, 'https://cm-prv-matrix-b0.acct.workers.dev'), preview_deleted_at = NULL, preview_delete_requested_at = NULL WHERE id = ?`).bind(nowIso(), w.ids.buildJob).run(); } },
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
    { key: "POST /staff/builds/:id/share-preview", fields: () => ({ action: "share" }), setup: async () => { await w.db.prepare(`UPDATE build_jobs SET internal_approved_at = COALESCE(internal_approved_at, ?) WHERE id = ?`).bind(nowIso(), w.ids.buildJob).run(); } },
    { key: "GET /portal/projects/:id/previews/:buildId", as: custA, path: () => `/portal/projects/${a.ids.project}/previews/${w.ids.buildJob}` },
    { key: "POST /portal/projects/:id/previews/:buildId/review", as: custA, path: () => `/portal/projects/${a.ids.project}/previews/${w.ids.buildJob}/review`, fields: () => ({ decision: "changes_requested", note: "Please use the new logo." }) },
    // Founder decision D5: customer production delivery (framework only; nothing is deployed in tests).
    { key: "POST /staff/builds/projects/:id/site-target", setup: async () => {
      await w.db.prepare(`DELETE FROM site_deployment_events WHERE deployment_id IN (SELECT id FROM site_deployments WHERE project_id = ?)`).bind(a.ids.project).run();
      await w.db.prepare(`DELETE FROM site_deployments WHERE project_id = ?`).bind(a.ids.project).run();
      await w.db.prepare(`DELETE FROM site_targets WHERE project_id = ?`).bind(a.ids.project).run();
    } },
    { key: "POST /staff/builds/projects/:id/site-domain", fields: () => ({ hostname: "www.matrix-customer.example", confirm: "www.matrix-customer.example" }) },
    { key: "POST /staff/builds/:id/prepare-release", fields: () => ({ customer_review_na: "Owner-managed site; customer reviewed in a meeting." }), setup: async () => {
      await w.db.prepare(`UPDATE build_jobs SET state = 'canceled' WHERE project_id = ? AND id <> ? AND state = 'approved'`).bind(a.ids.project, w.ids.buildJob).run();
      await w.db.prepare(`UPDATE build_jobs SET state = 'approved', approved_at = ?, source_repo = 'https://github.com/crestmont-builds/matrix', source_commit = 'def5678', customer_preview_shared_at = NULL WHERE id = ?`).bind(nowIso(), w.ids.buildJob).run();
    } },
    { key: "POST /staff/builds/releases/:id/authorize", setup: async () => {
      await w.db.prepare(`UPDATE site_deployments SET state = 'canceled' WHERE project_id = ? AND state IN ('prepared','authorized','deploying')`).bind(a.ids.project).run();
      const t = await w.db.prepare(`SELECT id, worker_name, hostname FROM site_targets WHERE project_id = ?`).bind(a.ids.project).first<{ id: string; worker_name: string; hostname: string | null }>();
      x.siteWorker = t!.worker_name;
      await w.db.prepare(`INSERT INTO site_deployments (id, target_id, project_id, organization_id, build_job_id, version, kind, state, state_reason, source_repo, source_commit, worker_name, hostname, prepared_at, created_at, updated_at)
        SELECT ?, ?, project_id, organization_id, id, 100, 'release', 'prepared', 'Customer review not applicable: matrix', source_repo, source_commit, ?, ?, ?, ?, ? FROM build_jobs WHERE id = ?`)
        .bind(w.ids.siteDeployment, t!.id, t!.worker_name, t!.hostname, nowIso(), nowIso(), nowIso(), w.ids.buildJob).run();
    }, fields: () => ({ confirm: x.siteWorker ?? "cm-site-matrix-a", note: "matrix" }), path: () => `/staff/builds/releases/${w.ids.siteDeployment}/authorize` },
    { key: "POST /staff/builds/releases/:id/cancel", fields: () => ({ reason: "Matrix cancellation" }) },
    { key: "POST /staff/builds/releases/:id/rollback", setup: async () => {
      await w.db.prepare(`UPDATE site_deployments SET state = 'superseded', verified_at = ? WHERE id = ?`).bind(nowIso(), w.ids.siteDeployment).run();
    } },
    // V4: GPU workers, priority
    { key: "POST /staff/builds/workers", fields: () => ({ label: "Node 9 GPU", cost_class: "owned-hardware", max_active_projects: "2" }) },
    { key: "POST /staff/builds/projects/:id/priority", fields: () => ({ priority: "2" }) },
    { key: "POST /staff/builds/workers/:id/update", fields: () => ({ action: "pause", reason: "Matrix pause" }) },
    { key: "POST /staff/builds/workers/:id/rotate-key" },
    { key: "POST /staff/builds/projects/:id/reassign", fields: () => ({ reason: "Matrix reassignment" }), setup: async () => {
      await w.db.prepare(`UPDATE build_jobs SET state = 'ready_for_review' WHERE project_id = ? AND state IN ('preparing','building','verifying')`).bind(a.ids.project).run();
      await w.db.prepare(`UPDATE build_assignments SET released_at = ? WHERE project_id = ? AND released_at IS NULL`).bind(nowIso(), a.ids.project).run();
      await w.db.prepare(`INSERT INTO build_assignments (id, project_id, organization_id, worker_id, assigned_at) SELECT 'asg_matrix', id, organization_id, ?, ? FROM projects WHERE id = ?`).bind(w.ids.buildWorker, nowIso(), a.ids.project).run();
    } },
    { key: "POST /staff/builds/approvals/:id/decide", fields: () => ({ decision: "approve", note: "Matrix" }) },
    { key: "POST /staff/builds/integrations/:id/live", fields: () => ({ live: "1" }) },
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
    { key: "POST /staff/builds/diagnostics" },

    // Last: cancelling tenant A's project (Owner only).
    { key: "POST /staff/projects/:id/cancel", path: () => P(w, "POST /staff/projects/:id/cancel"), fields: () => ({ reason: "Customer requested cancellation in writing" }) },
  ];
}

/** A qualified research prospect (TEST DATA) for the promote / dismiss audit scenarios. */
async function insertResearchProspect(w: World, phone: string): Promise<string> {
  const id = newId("rp"), at = nowIso();
  await w.db.prepare(`INSERT INTO research_prospects (id, business_key, name, name_norm, state, phone_e164, phone_norm, phones_json, sources_json, website_class, website_json, identity_confidence, score, qualified, status, content_hash, last_verified_at, first_seen_at, updated_at)
      VALUES (?, ?, 'Matrix Research Co (TEST DATA)', 'matrix research', 'MI', ?, ?, ?, '[{"source":"overture","sourceId":"t","license":"CDLA-Permissive-2.0","retrievedAt":"2026-10-30T00:00:00.000Z"}]', 'NO_OFFICIAL_WEBSITE_FOUND',
      '{"confidence":0.8,"checkedAt":"2026-10-30T00:00:00.000Z","identitySignals":[],"checks":[]}', 0.9, 80, 1, 'qualified', 'x', ?, ?, ?)`)
    .bind(id, `overture:${id}`, phone, phone.slice(2), JSON.stringify([phone]), at, at, at).run();
  return id;
}
