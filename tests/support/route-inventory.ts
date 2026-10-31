// Route security inventory (AUTH-007, AUTH-008, EMP-002, SEC-001).
//
// EVERY route registered in src/routes/*.ts (enumerated through src/routes/index.ts#listRoutes) must
// have exactly one entry here. tests/security-matrix.test.ts fails when a route is added without a
// classification, or when an entry no longer matches a registered route, so the matrix stays exhaustive.
//
// access  — who may call the route (server-side, enforced in src/):
//   public     anyone, no session
//   token      anyone holding a secret capability token in the URL (share links, proposals, invitations)
//   authflow   sign-in / MFA flow: needs a session but runs BEFORE MFA verification by design
//   session    any fully signed-in user (staff or customer), acting only on their own account
//   customer   a member of a customer organization, scoped to that organization (admin: customer_admin only;
//              staffToo: staff may also call it, subject to record-level checks)
//   staff      Crestmont staff with MFA; `roles` = the staff roles allowed to perform the action at all
//   signed     machine-to-machine API authenticated by an HMAC signature header (no cookies)
//   webhook    provider webhook authenticated by the provider's signature header
// params  — the resource kind each :param names (used to substitute real ids from another tenant).
// audit   — for every authenticated state-changing route (and data exports): the audit_logs action the
//           route writes when it succeeds (proven by the matrix), or `exempt` with a one-line reason
//           why the action is not sensitive, or `blocked` when the sensitive action cannot succeed in
//           this environment (the matrix then proves it fails closed).
import { ROLE_PERMISSIONS, STAFF_ROLES, type Permission } from "../../src/domain/authz.ts";

export type StaffRole = (typeof STAFF_ROLES)[number];
export type ResourceKind =
  | "org" | "project" | "file" | "file2" | "shareLink" | "shareToken" | "changeOrder" | "ticket" | "invoice" | "paidInvoice" | "payment"
  | "session" | "revision" | "milestone" | "task" | "task2" | "assignment" | "refund" | "message" | "approvalRequest" | "customerInvitation"
  | "lead" | "leadTask" | "aiJob" | "quote" | "quoteToken" | "cmsRevision" | "cmsKey" | "portfolio" | "portfolioSlug" | "portfolioFile"
  | "testimonial" | "testimonialAction" | "blocker" | "finding" | "snapshot" | "run" | "requirement" | "env" | "invitation" | "staffUser"
  | "emailDelivery" | "emailTemplate" | "integration" | "privacyRequest" | "voiceVersion" | "call" | "consultation" | "outboundRequest" | "priceRequest" | "suppression"
  | "reconFinding" | "serviceSlug" | "legalSlug" | "legalKind" | "legalVersion" | "package" | "plan" | "reportFile"
  | "member" | "notification" | "staffNotification" | "buildJob" | "siteDeployment" | "buildWorker" | "buildApproval" | "buildIntegration"
  | "soVersion" | "soStage" | "soExperiment" | "runnerDiagnostic" | "researchProspect" | "researchProspect2" | "salesCall" | "salesLinkToken" | "salesUnsubToken";

export type Access =
  | { kind: "public" }
  | { kind: "token"; note: string }
  | { kind: "authflow" }
  | { kind: "session" }
  | { kind: "customer"; admin?: true; staffToo?: true }
  | { kind: "staff"; roles: readonly StaffRole[] }
  | { kind: "signed"; header: string; staffRead?: true }
  | { kind: "webhook"; header: string };

export type AuditClass = { action: string } | { exempt: string } | { blocked: string };

export interface RouteSpec {
  access: Access;
  params?: Record<string, ResourceKind>;
  audit?: AuditClass;
  /** JSON API route (/api/*): denials are JSON 401/403, never a redirect. */
  api?: true;
  /** GET answers 303 to an off-site URL (a signed preview sign-in link), not a page. */
  offsite?: true;
  /** Query string the page needs to render, with {resourceKind} placeholders (e.g. "lead={lead}"). */
  query?: string;
}

/** Staff roles holding ANY of the permissions. */
export const rolesWith = (...perms: Permission[]): StaffRole[] => STAFF_ROLES.filter((r) => perms.some((p) => ROLE_PERMISSIONS[r].has(p)));
const OWNER: StaffRole[] = ["owner"];

const pub: RouteSpec = { access: { kind: "public" } };
const token = (note: string, params?: RouteSpec["params"], audit?: AuditClass): RouteSpec => ({ access: { kind: "token", note }, params, audit });
const flow = (audit?: AuditClass): RouteSpec => ({ access: { kind: "authflow" }, audit });
const session = (audit?: AuditClass, params?: RouteSpec["params"]): RouteSpec => ({ access: { kind: "session" }, audit, params });
const cust = (params?: RouteSpec["params"], audit?: AuditClass, opts: { admin?: true; staffToo?: true } = {}): RouteSpec => ({ access: { kind: "customer", ...opts }, params, audit });
const staff = (roles: readonly StaffRole[], params?: RouteSpec["params"], audit?: AuditClass): RouteSpec => ({ access: { kind: "staff", roles }, params, audit });
const signed = (header: string, opts: { staffRead?: true } = {}): RouteSpec => ({ access: { kind: "signed", header, ...opts }, api: true });
const hook = (header: string): RouteSpec => ({ access: { kind: "webhook", header }, api: true });
const act = (action: string): AuditClass => ({ action });
const exempt = (why: string): AuditClass => ({ exempt: why });
const blocked = (why: string): AuditClass => ({ blocked: why });

const P = (k: ResourceKind) => ({ id: k });
const crm = rolesWith("crm.access");
const delivery = rolesWith("delivery.access");
const coord = rolesWith("project.coordinate");
const readiness = rolesWith("readiness.read");
const ops = rolesWith("settings.operational");
const finance = rolesWith("finance.read");

export const ROUTE_INVENTORY: Record<string, RouteSpec> = {
  // ── JSON API, CI and provider webhooks (src/routes/api.ts, hooks.ts, ops.ts, platform.ts) ──
  "GET /api/health": pub,
  "POST /api/leads": { access: { kind: "public" }, api: true },
  "GET /api/assistant": { access: { kind: "public" }, api: true },
  "POST /api/assistant": { access: { kind: "public" }, api: true },
  "POST /api/readiness/evidence": signed("x-crestmont-signature"),
  "POST /api/readiness/github-snapshot": signed("x-crestmont-signature"),
  "POST /api/scheduled/run": signed("x-crestmont-scheduler-signature"),
  "POST /api/voice/retell-audit": signed("x-crestmont-scheduler-signature"),
  "POST /api/crm/v1/imports": signed("x-crestmont-signature"),
  "POST /api/webhooks/stripe": hook("stripe-signature"),
  "GET /api/readiness": { access: { kind: "staff", roles: readiness }, api: true },
  "GET /api/readiness/requirements.csv": { access: { kind: "staff", roles: readiness }, api: true, audit: act("readiness.exported") },
  "GET /api/readiness/health": { access: { kind: "public" }, api: true },
  "POST /api/webhooks/voice": hook("x-crestmont-voice-signature"),
  "POST /api/webhooks/retell": hook("x-retell-signature"),
  "POST /api/webhooks/retell/functions": hook("x-retell-signature"),
  "POST /api/webhooks/retell/inbound": hook("x-retell-signature"),
  "POST /api/webhooks/retell/outbound/functions": hook("x-retell-signature"),
  "POST /api/webhooks/resend": hook("svix-signature"),
  "POST /api/readiness/deployments": signed("x-crestmont-signature"),
  "POST /api/readiness/release-candidates": signed("x-crestmont-signature"),
  "GET /api/readiness/release-authorization": signed("x-crestmont-signature", { staffRead: true }),
  // AI Builds runner API (HMAC-signed with BUILD_RUNNER_SECRET; src/routes/builds.ts)
  "POST /api/builds/runner/claim": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/heartbeat": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/checkpoint": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/requirements": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/checkpoint/fetch": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/ai/claim": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/ai/complete": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/ai/checkpoint": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/files": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/complete": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/previews/claim": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/previews/deleted": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/deployments/claim": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/deployments/complete": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/pipeline/spec": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/cycles/submit": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/integrations/report": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/approvals/request": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/approvals/list": signed("x-crestmont-runner-signature"),
  "POST /api/builds/runner/workers/status": signed("x-crestmont-runner-signature"),
  "GET /api/builds": { access: { kind: "staff", roles: rolesWith("builds.read") }, api: true },
  "GET /api/builds/:id": { access: { kind: "staff", roles: rolesWith("builds.read") }, api: true, params: { id: "buildJob" } },

  // ── Authentication and account (src/routes/auth.ts, platform.ts privacy) ──
  "GET /login": pub,
  "POST /login": pub,
  "POST /logout": pub,
  "GET /register": pub,
  "POST /register": pub,
  "GET /verify-email": token("email verification token (?token=)"),
  "POST /verify-email/resend": flow(exempt("re-sends the caller's own verification email; rate of mail is bounded by idempotency keys")),
  "GET /mfa": flow(),
  "POST /mfa": flow(act("session.mfa_verified")),
  "GET /mfa/setup": flow(),
  "POST /mfa/setup": flow(act("user.mfa_enabled")),
  // Step-up MFA (src/app/step-up.ts): a fully signed-in session re-verifies before a sensitive action.
  "GET /mfa/step-up": session(),
  "POST /mfa/step-up": session(act("session.step_up_verified")),
  "POST /account/mfa/recovery-codes": session(act("user.mfa_recovery_codes_regenerated")),
  "GET /password/forgot": pub,
  "POST /password/forgot": pub,
  "GET /password/reset": token("password reset token (?token=)"),
  "POST /password/reset": token("password reset token (form field)"),
  "GET /invite": token("invitation token (?token=)"),
  "POST /invite": token("invitation token (form field)"),
  "GET /account": session(),
  "POST /account/password": session(act("user.password_changed")),
  "POST /account/sessions/:id/revoke": session(act("session.revoked"), P("session")),
  "POST /account/sessions/revoke-others": session(act("session.revoked_all")),
  "GET /account/privacy": session(),
  // Customer profile self-service (CREST-GAP-073, src/routes/account-profile.ts). Customers only; staff emails are managed by administrators.
  "GET /account/profile": cust(),
  "POST /account/profile": cust(undefined, act("user.profile_updated")),
  "POST /account/email": cust(undefined, act("user.email_change_requested")),
  "POST /account/email/cancel": cust(undefined, act("user.email_change_cancelled")),
  "GET /account/email/confirm": token("email change confirmation token (?token=)"),
  "POST /account/email/confirm": token("email change confirmation token (form field)"),
  "POST /portal/notices/mfa-reminder/dismiss": cust(undefined, act("user.mfa_reminder_dismissed")),
  "POST /account/privacy/export": session(act("privacy.export_generated")),
  "POST /account/privacy/delete": session(act("privacy.deletion_requested")),

  // ── Public website (src/routes/public.ts, legal.ts) ──
  "GET /": pub,
  "GET /services": pub,
  "GET /services/hosting-maintenance": pub,
  "GET /services/:slug": { access: { kind: "public" }, params: { slug: "serviceSlug" } },
  "GET /pricing": pub,
  "GET /pricing/compare": pub,
  "GET /portfolio": pub,
  "GET /portfolio/:slug": { access: { kind: "public" }, params: { slug: "portfolioSlug" } },
  "GET /portfolio-media/:fileId": { access: { kind: "public" }, params: { fileId: "portfolioFile" } },
  "GET /about": pub,
  "GET /process": pub,
  "GET /faq": pub,
  "GET /hosting-maintenance": pub,
  "GET /quote": pub,
  "POST /quote": pub,
  "GET /quote/thanks": pub,
  "GET /contact": pub,
  "POST /contact": pub,
  "GET /contact/thanks": pub,
  "GET /legal": pub,
  "GET /legal/:slug": { access: { kind: "public" }, params: { slug: "legalSlug" } },
  "GET /robots.txt": pub,
  "GET /sitemap.xml": pub,
  "GET /legal/:kind/versions": { access: { kind: "public" }, params: { kind: "legalKind" } },
  "GET /legal/:kind/versions/:version": { access: { kind: "public" }, params: { kind: "legalKind", version: "legalVersion" } },

  // ── CMS and portfolio admin (src/routes/public.ts) ──
  "GET /staff/cms": staff(rolesWith("cms.edit")),
  "GET /staff/cms/revisions/:id": staff(rolesWith("cms.edit"), P("cmsRevision")),
  "POST /staff/cms/revisions/:id/publish": staff(rolesWith("cms.publish"), P("cmsRevision"), act("cms.published")),
  "GET /staff/cms/:key": staff(rolesWith("cms.edit"), { key: "cmsKey" }),
  "POST /staff/cms/:key": staff(rolesWith("cms.edit"), { key: "cmsKey" }, act("cms.draft_saved")),
  "POST /staff/cms/:key/revert": staff(rolesWith("cms.publish"), { key: "cmsKey" }, act("cms.reverted_to_default")),
  "GET /staff/portfolio": staff(rolesWith("portfolio.manage")),
  "POST /staff/portfolio": staff(rolesWith("portfolio.manage"), undefined, act("portfolio.created")),
  "GET /staff/portfolio/files/:fileId": staff(rolesWith("portfolio.manage"), { fileId: "portfolioFile" }),
  "POST /staff/portfolio/testimonials/:tid/:action": staff(rolesWith("portfolio.manage"), { tid: "testimonial", action: "testimonialAction" }, act("testimonial.published")),
  "GET /staff/portfolio/:id": staff(rolesWith("portfolio.manage"), P("portfolio")),
  "POST /staff/portfolio/:id": staff(rolesWith("portfolio.manage"), P("portfolio"), act("portfolio.updated")),
  "POST /staff/portfolio/:id/screenshot": staff(rolesWith("portfolio.manage"), P("portfolio"), act("portfolio.screenshot_uploaded")),
  "POST /staff/portfolio/:id/verify-link": staff(rolesWith("portfolio.manage"), P("portfolio"), act("portfolio.link_verified")),
  "POST /staff/portfolio/:id/relationship": staff(rolesWith("portfolio.manage"), P("portfolio"), act("portfolio.relationship_documented")),
  "POST /staff/portfolio/:id/demo": staff(rolesWith("portfolio.manage"), P("portfolio"), act("portfolio.demo_updated")),
  "POST /staff/portfolio/:id/publish": staff(rolesWith("portfolio.manage"), P("portfolio"), act("portfolio.published")),
  "POST /staff/portfolio/:id/unpublish": staff(rolesWith("portfolio.manage"), P("portfolio"), act("portfolio.unpublished")),
  "POST /staff/portfolio/:id/move": staff(rolesWith("portfolio.manage"), P("portfolio"), act("portfolio.reordered")),
  "POST /staff/portfolio/:id/testimonials": staff(rolesWith("portfolio.manage"), P("portfolio"), act("testimonial.verified_added")),
  "GET /staff/cms/revisions/:id/compare": staff(rolesWith("cms.edit"), P("cmsRevision")),
  "POST /staff/cms/revisions/:id/discard": staff(rolesWith("cms.edit"), P("cmsRevision"), act("cms.draft_discarded")),
  "POST /staff/cms/revisions/:id/restore": staff(rolesWith("cms.edit"), P("cmsRevision"), act("cms.revision_restored")),

  // ── Customer portal (src/routes/portal.ts) ──
  "GET /portal": cust(),
  "POST /portal/notifications/read": cust(undefined, exempt("marks the caller's own notifications as read")),
  "GET /portal/projects": cust(),
  "GET /portal/projects/:id": cust(P("project")),
  "GET /portal/projects/:id/onboarding": cust(P("project")),
  "POST /portal/projects/:id/onboarding": cust(P("project"), act("onboarding.draft_saved")),
  "GET /portal/files": cust(),
  "POST /portal/files": cust(undefined, act("file.uploaded")),
  "GET /portal/projects/:id/files": cust(P("project")),
  "POST /portal/projects/:id/files": cust(P("project"), act("file.uploaded")),
  "GET /portal/files/:id": cust(P("file")),
  "POST /portal/files/:id/replace": cust(P("file"), act("file.replaced")),
  "POST /portal/files/:id/move": cust(P("file"), act("file.moved")),
  "POST /portal/files/:id/delete": cust(P("file"), act("file.deleted")),
  "GET /files/:id": cust(P("file"), act("file.downloaded"), { staffToo: true }),
  "GET /files/:id/preview": cust(P("file"), act("file.downloaded"), { staffToo: true }),
  "GET /files/:id/share": cust(P("file"), undefined, { staffToo: true }),
  "POST /files/:id/share": cust(P("file"), act("share_link.created"), { staffToo: true, admin: true }),
  "POST /files/share-links/:id/revoke": cust(P("shareLink"), act("share_link.revoked"), { staffToo: true, admin: true }),
  "GET /share/:token": token("file share link token", { token: "shareToken" }),
  "POST /share/:token/download": token("file share link token", { token: "shareToken" }),
  "GET /portal/messages": cust(),
  "GET /portal/messages/general": cust(),
  "POST /portal/messages/general": cust(undefined, act("message.posted")),
  "GET /portal/projects/:id/messages": cust(P("project")),
  "POST /portal/projects/:id/messages": cust(P("project"), act("message.posted")),
  "GET /portal/projects/:id/revisions": cust(P("project")),
  "POST /portal/projects/:id/revisions": cust(P("project"), act("revision.requested")),
  "POST /portal/change-orders/:id/decide": cust(P("changeOrder"), act("change_order.approved"), { admin: true }),
  "GET /portal/approvals": cust(),
  "GET /portal/projects/:id/approvals": cust(P("project")),
  "POST /portal/projects/:id/approvals": cust(P("project"), act("approval.approved"), { admin: true }),
  "GET /portal/projects/:id/handoff": cust(P("project")),
  "GET /portal/team": cust(),
  "POST /portal/team": cust(undefined, act("customer.member_invited"), { admin: true }),
  "POST /portal/team/members/:userId/role": cust({ userId: "member" }, act("customer.member_role_changed"), { admin: true }),
  "POST /portal/team/members/:userId/remove": cust({ userId: "member" }, act("customer.member_removed"), { admin: true }),
  "POST /portal/team/invitations/:id/revoke": cust(P("customerInvitation"), act("customer.invitation_revoked"), { admin: true }),
  "GET /portal/notifications": cust(),
  "GET /portal/projects/:id/build-status": cust(P("project")),
  "GET /live/unread": session(),
  "POST /portal/notifications/:id/read": cust(P("notification"), exempt("marks one of the caller's own notifications as read (scoped to the user; others' ids are 404)")),
  "GET /portal/maintenance": cust(),

  // ── Sales: CRM, customers, quotes, proposals, checkout (src/routes/crm.ts) ──
  "GET /staff/crm": staff(crm),
  "GET /staff/crm/export.csv": staff(crm, undefined, act("lead.exported")),
  "GET /staff/crm/new": staff(crm),
  "GET /staff/crm/new/matches": staff(rolesWith("lead.write_all", "lead.write_assigned")),
  "POST /staff/crm/identity-erasure": staff(OWNER, undefined, act("crm.identity_erased")),
  "POST /staff/crm/identity-reviews/resolve": staff(rolesWith("lead.write_all"), undefined, act("crm.identity_review_resolved")),
  "POST /staff/crm/new": staff(rolesWith("lead.write_all", "lead.write_assigned"), undefined, act("lead.created")),
  "GET /staff/crm/contacts": staff(crm),
  "GET /staff/crm/duplicates": staff(crm),
  "POST /staff/crm/duplicates/dismiss": staff(rolesWith("lead.write_all", "lead.write_assigned"), undefined, act("lead.duplicate_dismissed")),
  "POST /staff/crm/leads/:id/merge": staff(rolesWith("lead.write_all", "lead.write_assigned"), P("lead"), act("lead.merged")),
  "GET /staff/crm/leads/:id": staff(crm, P("lead")),
  "GET /staff/crm/leads/:id/quick": staff(crm, P("lead")),
  "POST /staff/crm/leads/:id/stage": staff(rolesWith("lead.write_all", "lead.write_assigned"), P("lead"), act("lead.stage_changed")),
  "POST /staff/crm/leads/:id/note": staff(rolesWith("lead.write_all", "lead.write_assigned"), P("lead"), exempt("appends a note to the lead's own activity history (crm_activities keeps author and time); no money, permission, file or legal effect")),
  "POST /staff/crm/leads/:id/task": staff(rolesWith("lead.write_all", "lead.write_assigned"), P("lead"), exempt("schedules a follow-up in the lead's own activity history (crm_activities keeps author and time); no money, permission, file or legal effect")),
  "POST /staff/crm/leads/:id/tasks/:taskId/complete": staff(rolesWith("lead.write_all", "lead.write_assigned"), { id: "lead", taskId: "leadTask" }, act("lead.task_completed")),
  "POST /staff/crm/leads/:id/contact": staff(rolesWith("lead.write_all", "lead.write_assigned"), P("lead"), act("lead.contact_updated")),
  "POST /staff/crm/leads/:id/assign": staff(rolesWith("lead.assign"), P("lead"), act("lead.assigned")),
  "POST /staff/crm/leads/:id/ai-draft": staff(rolesWith("lead.write_all", "lead.write_assigned"), P("lead"), act("ai.draft_created")),
  "POST /staff/crm/leads/:id/ai-draft/:jobId": staff(rolesWith("lead.write_all", "lead.write_assigned"), { id: "lead", jobId: "aiJob" }, act("ai.draft_approved")),
  "GET /staff/customers": staff(rolesWith("customers.read")),
  "GET /staff/customers/export.csv": staff(rolesWith("customers.read"), undefined, act("customer.exported")),
  "GET /staff/customers/:id": staff(rolesWith("customers.read"), P("org"), act("customer.viewed")),
  "GET /staff/sales": staff(crm),
  "GET /staff/quotes": staff(rolesWith("quote.write")),
  "GET /staff/quotes/export.csv": staff(rolesWith("quote.write"), undefined, act("quote.exported")),
  "POST /staff/quotes/:id/close": staff(rolesWith("quote.write"), P("quote"), act("quote.withdrawn")),
  "GET /staff/quotes/new": { ...staff(rolesWith("quote.write")), query: "lead={lead}" },
  "POST /staff/quotes/new": staff(rolesWith("quote.write"), undefined, act("quote.created")),
  "GET /staff/quotes/:id": staff(rolesWith("quote.write"), P("quote")),
  "POST /staff/quotes/:id": staff(rolesWith("quote.write"), P("quote"), act("quote.revised")),
  "POST /staff/quotes/:id/send": staff(rolesWith("quote.send"), P("quote"), act("quote.sent")),
  "GET /q/:token": token("proposal token emailed to the lead", { token: "quoteToken" }),
  "POST /q/:token/accept": { access: { kind: "customer", admin: true }, params: { token: "quoteToken" }, audit: act("quote.accepted") },
  "GET /checkout/maintenance/:planId": cust({ planId: "plan" }),
  "POST /checkout/maintenance/:planId": cust({ planId: "plan" }, blocked("no maintenance plan's entitlements are Founder-approved, so checkout returns 409 for every caller"), { admin: true }),
  "GET /checkout/:packageId": cust({ packageId: "package" }),
  "POST /checkout/:packageId": cust({ packageId: "package" }, act("checkout.started"), { admin: true }),

  // ── Delivery: my work, conversations, projects, tasks (src/routes/projects.ts) ──
  "GET /staff": staff(STAFF_ROLES),
  "GET /staff/conversations": staff(rolesWith("customers.read")),
  "GET /staff/conversations/:orgId": staff(rolesWith("customers.read"), { orgId: "org" }, act("conversation.viewed")),
  "POST /staff/conversations/:orgId": staff(rolesWith("customers.read"), { orgId: "org" }, act("message.posted")),
  "POST /staff/notifications/read": staff(STAFF_ROLES, undefined, exempt("marks the caller's own notifications as read")),
  "GET /staff/projects": staff(delivery),
  "GET /staff/projects/export.csv": staff(delivery, undefined, act("project.exported")),
  "GET /staff/notifications": staff(STAFF_ROLES),
  "POST /staff/notifications/:id/read": staff(STAFF_ROLES, P("staffNotification"), exempt("marks one of the caller's own notifications as read (scoped to the user; others' ids are 404)")),
  "POST /staff/projects/sweep-inactivity": staff(coord, undefined, exempt("runs the scheduled inactivity policy on demand; each reminder/escalation/pause it causes is audited per project")),
  "GET /staff/projects/:id": staff(delivery, P("project")),
  "POST /staff/projects/:id/status": staff(coord, P("project"), act("project.paused")),
  "POST /staff/projects/:id/resume": staff(coord, P("project"), act("project.resumed")),
  "POST /staff/projects/:id/cancel": staff(OWNER, P("project"), act("project.cancelled")),
  "POST /staff/projects/:id/pm": staff(coord, P("project"), act("project.pm_assigned")),
  "POST /staff/projects/:id/target": staff(coord, P("project"), act("project.target_launch_set")),
  "POST /staff/projects/:id/assign": staff(coord, P("project"), act("assignment.created")),
  "POST /staff/assignments/:id/end": staff(coord, P("assignment"), act("assignment.ended")),
  "POST /staff/projects/:id/scope": staff(coord, P("project"), act("scope.version_created")),
  "POST /staff/projects/:id/request-approval": staff(coord, P("project"), act("approval.requested")),
  "POST /staff/projects/:id/approvals": staff(coord, P("project"), act("approval.approved")),
  "POST /staff/projects/:id/invoices": staff(coord, P("project"), act("invoice.milestone_issued")),
  "POST /staff/projects/:id/deployments": staff(coord, P("project"), act("deployment.recorded")),
  "POST /staff/projects/:id/handoff": staff(coord, P("project"), act("handoff.saved")),
  "POST /staff/projects/:id/costs": staff(coord, P("project"), act("project_cost.recorded")),
  "POST /staff/projects/:id/change-orders": staff(coord, P("project"), act("change_order.proposed")),
  "POST /staff/revisions/:id/status": staff(rolesWith("project.coordinate", "task.update_assigned"), P("revision"), act("revision.status_changed")),
  "POST /staff/projects/:id/messages": staff(delivery, P("project"), act("message.posted")),
  "POST /staff/projects/:id/files": staff(delivery, P("project"), act("file.uploaded")),
  "POST /staff/projects/:id/milestones": staff(coord, P("project"), act("milestone.created")),
  "POST /staff/milestones/:id": staff(rolesWith("milestone.update"), P("milestone"), act("milestone.updated")),
  "POST /staff/milestones/:id/delete": staff(coord, P("milestone"), act("milestone.deleted")),
  "POST /staff/projects/:id/tasks": staff(coord, P("project"), act("task.created")),
  "GET /staff/tasks": staff(delivery),
  "GET /staff/tasks/export.csv": staff(delivery, undefined, act("task.exported")),
  "GET /staff/tasks/:id": staff(delivery, P("task")),
  "POST /staff/tasks/:id/status": staff(rolesWith("project.coordinate", "task.update_assigned"), P("task"), act("task.status_changed")),
  "POST /staff/tasks/:id": staff(coord, P("task"), act("task.updated")),
  "POST /staff/tasks/:id/delete": staff(coord, P("task"), act("task.deleted")),
  "POST /staff/tasks/:id/dependencies": staff(coord, P("task"), act("task.dependency_added")),
  "POST /staff/tasks/:id/dependencies/:dep/delete": staff(coord, { id: "task2", dep: "task" }, act("task.dependency_removed")),
  "POST /staff/tasks/:id/time": staff(rolesWith("project.coordinate", "task.update_assigned"), P("task"), act("time.logged")),
  "POST /staff/tasks/:id/assign": staff(coord, P("task"), act("assignment.created")),

  // ── Support (src/routes/support.ts) ──
  "GET /portal/support": cust(),
  "GET /portal/support/new": cust(),
  "POST /portal/support/new": cust(undefined, act("ticket.created")),
  "GET /portal/support/:id": cust(P("ticket")),
  "POST /portal/support/:id/reply": cust(P("ticket"), act("ticket.customer_reply")),
  "POST /portal/support/:id/reopen": cust(P("ticket"), act("ticket.status_changed")),
  "GET /staff/support": staff(rolesWith("support.access")),
  "GET /staff/support/export.csv": staff(rolesWith("support.access"), undefined, act("ticket.exported")),
  "GET /staff/support/settings": staff(ops),
  "POST /staff/support/settings": staff(ops, undefined, act("support.settings_updated")),
  "POST /staff/support/sweep": staff(rolesWith("ticket.manage"), undefined, exempt("runs the scheduled first-response SLA sweep on demand; each newly flagged ticket is audited (ticket.sla_breached)")),
  "GET /staff/support/:id": staff(rolesWith("support.access"), P("ticket")),
  "POST /staff/support/:id/assign": staff(rolesWith("ticket.manage"), P("ticket"), act("ticket.assigned")),
  "POST /staff/support/:id/triage": staff(rolesWith("ticket.manage"), P("ticket"), act("ticket.triaged")),
  "POST /staff/support/:id/status": staff(rolesWith("ticket.manage"), P("ticket"), act("ticket.status_changed")),
  "POST /staff/support/:id/escalate": staff(rolesWith("ticket.manage"), P("ticket"), act("ticket.status_changed")),
  "POST /staff/support/:id/note": staff(rolesWith("ticket.internal_note"), P("ticket"), act("ticket.internal_note")),
  "POST /staff/support/:id/reply": staff(rolesWith("ticket.manage"), P("ticket"), act("ticket.staff_reply")),
  "POST /staff/support/:id/draft": staff(rolesWith("ticket.manage"), P("ticket"), act("ticket.ai_draft_requested")),
  "POST /staff/support/:id/draft/discard": staff(rolesWith("ticket.manage"), P("ticket"), act("ai.draft_rejected")),

  // ── Billing, refunds and finance (src/routes/finance.ts, legal.ts, hooks.ts, owner.ts) ──
  "GET /portal/billing": cust(),
  "GET /portal/billing/invoices/:id": cust(P("invoice")),
  "POST /portal/billing/invoices/:id/pay": cust(P("invoice"), act("checkout.started"), { admin: true }),
  "POST /portal/billing/manage": cust(undefined, act("billing.portal_opened"), { admin: true }),
  "POST /portal/billing/refund-request": cust(undefined, act("refund.requested"), { admin: true }),
  "GET /staff/refunds": staff(rolesWith("refund.review")),
  "GET /staff/refunds/:id": staff(rolesWith("refund.review"), P("refund")),
  "POST /staff/refunds/:id/review": staff(rolesWith("refund.review"), P("refund"), act("refund.under_review")),
  "POST /staff/refunds/:id/decide": staff(rolesWith("refund.decide"), P("refund"), act("refund.approved")),
  "POST /staff/refunds/:id/issue": staff(rolesWith("refund.issue"), P("refund"), act("refund.issued")),
  "GET /staff/disputes": staff(finance),
  "GET /staff/finance": staff(finance),
  "GET /staff/finance/subscriptions": staff(finance),
  "GET /staff/finance/invoices": staff(finance),
  "GET /staff/finance/profitability": staff(finance),
  "POST /staff/finance/costs": staff(finance, undefined, act("finance.cost_recorded")),
  "GET /staff/reports": staff(finance),
  "GET /staff/reports/operations": staff(STAFF_ROLES),
  "GET /staff/reports/operations/summary.csv": staff(STAFF_ROLES, undefined, act("report.operations_exported")),
  "GET /staff/reports/operations/time.csv": staff(coord, undefined, act("report.time_exported")),
  "GET /staff/finance/invoices/:id": staff(finance, P("invoice")),
  "POST /staff/finance/invoices/:id/stripe-invoice": staff(finance, P("invoice"), blocked("no Stripe secret key in tests: the Stripe invoice is refused (409) and nothing is sent; a configured run audits invoice.stripe_invoice_created")),
  "GET /staff/finance/invoices/:id/pdf": staff(finance, P("invoice"), act("invoice.pdf_downloaded")),
  "GET /staff/finance/receipts/:paymentId/pdf": staff(finance, { paymentId: "payment" }, act("receipt.pdf_downloaded")),
  "GET /portal/billing/invoices/:id/pdf": cust(P("invoice"), act("invoice.pdf_downloaded")),
  "GET /portal/billing/receipts/:paymentId/pdf": cust({ paymentId: "payment" }, act("receipt.pdf_downloaded")),
  "GET /staff/reports/:file": staff(finance, { file: "reportFile" }, act("finance.exported")),
  "GET /staff/owner": staff(finance),
  "GET /portal/agreements": cust(),
  "GET /staff/legal": staff(rolesWith("customers.read")),
  "GET /portal/billing/receipts/:paymentId": cust({ paymentId: "payment" }),
  "GET /staff/finance/receipts/:paymentId": staff(finance, { paymentId: "payment" }),
  "GET /staff/pricing": staff(rolesWith("quote.write", "settings.operational", "pricing.change")),
  "POST /staff/pricing": staff(rolesWith("quote.write", "settings.operational"), undefined, act("pricing.change_proposed")),
  "POST /staff/pricing/:id/decide": staff(OWNER, P("priceRequest"), act("pricing.change_approved")),
  "GET /staff/email-suppressions": staff(ops),
  "POST /staff/email-suppressions/:id/remove": staff(ops, P("suppression"), act("email.suppression_removed")),
  "GET /staff/finance/reconciliation": staff(finance),
  "POST /staff/finance/reconciliation/:id/resolve": staff(finance, P("reconFinding"), act("reconciliation.finding_resolved")),
  "POST /staff/finance/reconciliation/:id/reopen": staff(finance, P("reconFinding"), act("reconciliation.finding_reopened")),

  // ── Launch readiness and operations (src/routes/readiness.ts, ops.ts) ──
  "GET /staff/readiness": staff(readiness),
  "GET /staff/readiness/requirements": staff(readiness),
  "GET /staff/readiness/requirements/:id": staff(readiness, P("requirement")),
  "GET /staff/readiness/runs/:id": staff(readiness, P("run")),
  "GET /staff/readiness/engineering": staff(readiness),
  "POST /staff/readiness/github/sync": staff(ops, undefined, exempt("imports read-only CI/repository metadata from GitHub when configured (audited as readiness.github_synced); changes no customer, money, permission or release state")),
  "GET /staff/readiness/env/:env": staff(readiness, { env: "env" }),
  "GET /staff/readiness/blockers": staff(readiness),
  "GET /staff/readiness/blockers/new": staff(ops),
  "POST /staff/readiness/blockers/new": staff(ops, undefined, act("blocker.created")),
  "GET /staff/readiness/blockers/:id": staff(readiness, P("blocker")),
  "POST /staff/readiness/blockers/:id": staff(ops, P("blocker"), act("blocker.updated")),
  "POST /staff/readiness/blockers/:id/resolve": staff(ops, P("blocker"), act("blocker.resolved")),
  "POST /staff/readiness/blockers/:id/reopen": staff(ops, P("blocker"), act("blocker.reopened")),
  "GET /staff/readiness/security": staff(readiness),
  "POST /staff/readiness/security": staff(ops, undefined, act("security_finding.opened")),
  "POST /staff/readiness/security/:id/resolve": staff(ops, P("finding"), act("security_finding.resolved")),
  "GET /staff/readiness/releases": staff(readiness),
  "POST /staff/readiness/releases": staff(ops, undefined, act("release.candidate_created")),
  "GET /staff/readiness/approve": staff(OWNER),
  "POST /staff/readiness/approve": staff(OWNER, undefined, act("release.founder_approved")),
  "GET /staff/readiness/export.csv": staff(readiness, undefined, act("readiness.exported")),
  "GET /staff/readiness/packet.json": staff(readiness, undefined, act("readiness.exported")),
  "GET /staff/readiness/report": staff(readiness),
  "GET /staff/readiness/snapshots": staff(readiness),
  "POST /staff/readiness/snapshots": staff(ops, undefined, act("readiness.snapshot_saved")),
  "GET /staff/readiness/snapshots/:id": staff(readiness, P("snapshot")),
  "GET /staff/ops": staff(readiness),
  "POST /staff/ops/environments": staff(ops, undefined, act("settings.updated")),
  "POST /staff/ops/probe": staff(ops, undefined, act("ops.environment_probe")),
  "GET /staff/ops/retention": staff(ops),
  "POST /staff/ops/retention": staff(OWNER, undefined, act("retention.periods_updated")),
  "GET /staff/readiness/founder-report": staff(readiness),
  "GET /staff/readiness/founder-report.md": staff(readiness, undefined, act("readiness.exported")),

  // ── Platform: employees, email, integrations, monitoring, security, audit, backups, settings, AI, voice ──
  "GET /staff/employees": staff(rolesWith("employee.manage")),
  "GET /staff/employees/export.csv": staff(rolesWith("employee.manage"), undefined, act("employee.exported")),
  "GET /staff/employees/:id": staff(rolesWith("employee.manage"), P("staffUser")),
  "POST /staff/employees/:id/profile": staff(rolesWith("employee.manage"), P("staffUser"), act("employee.profile_updated")),
  "POST /staff/employees/invite": staff(rolesWith("employee.manage"), undefined, act("invitation.created")),
  "POST /staff/employees/invitations/:id/revoke": staff(rolesWith("employee.manage"), P("invitation"), act("invitation.revoked")),
  "POST /staff/employees/:id/role": staff(rolesWith("employee.manage"), P("staffUser"), act("employee.role_changed")),
  "POST /staff/employees/:id/disable": staff(rolesWith("employee.manage"), P("staffUser"), act("employee.disabled")),
  "POST /staff/employees/:id/enable": staff(rolesWith("employee.manage"), P("staffUser"), act("employee.enabled")),
  "POST /staff/employees/:id/mfa-reset": staff(rolesWith("employee.manage"), P("staffUser"), act("employee.mfa_reset")),
  "GET /staff/employees/:id/offboarding": staff(rolesWith("employee.manage"), P("staffUser")),
  "POST /staff/employees/:id/offboarding": staff(rolesWith("employee.manage"), P("staffUser"), act("offboarding.resolved")),
  "GET /staff/email": staff(ops),
  "GET /staff/email/export.csv": staff(ops, undefined, act("email.log_exported")),
  "GET /staff/email/templates": staff(ops),
  "GET /staff/email/templates/:name/html": staff(ops, { name: "emailTemplate" }),
  "GET /staff/email/:id": staff(ops, P("emailDelivery")),
  "GET /staff/email/:id/html": staff(ops, P("emailDelivery"), act("email.body_downloaded")),
  "POST /staff/email/:id/retry": staff(ops, P("emailDelivery"), blocked("Resend is not configured in tests, so retry refuses and changes nothing; a configured retry audits email.retried")),
  "GET /staff/integrations": staff(ops),
  "POST /staff/integrations/:name/verify": staff(ops, { name: "integration" }, act("integration.verified_probe")),
  "GET /staff/monitoring": staff(ops),
  "GET /staff/security": staff(rolesWith("audit.read")),
  "GET /staff/security/events.csv": staff(rolesWith("audit.read"), undefined, act("security.events_exported")),
  "POST /staff/privacy/:id/process": staff(rolesWith("employee.manage"), P("privacyRequest"), act("privacy.deletion_completed")),
  "GET /staff/audit": staff(rolesWith("audit.read")),
  "GET /staff/audit/export.csv": staff(rolesWith("audit.read"), undefined, act("audit.exported")),
  "GET /staff/backups": staff(ops),
  "POST /staff/backups/records": staff(ops, undefined, act("backup.recorded")),
  "POST /staff/backups/restore-tests": staff(ops, undefined, act("backup.restore_test_recorded")),
  "GET /staff/settings": staff(ops),
  "POST /staff/settings": staff(ops, undefined, act("settings.updated")),
  // LEGAL-005 tax configuration (src/routes/tax.ts): Owner only, every change audited.
  "GET /staff/settings/tax": staff(OWNER),
  "POST /staff/settings/tax": staff(OWNER, undefined, act("tax.settings_updated")),
  "POST /staff/settings/tax/jurisdictions": staff(OWNER, undefined, act("tax.jurisdiction_added")),
  "GET /staff/ai": staff(rolesWith("ai.manage")),
  "GET /staff/ai/export.csv": staff(rolesWith("ai.manage"), undefined, act("ai.jobs_exported")),
  "GET /staff/ai/:id": staff(rolesWith("ai.manage"), P("aiJob")),
  // AI Builds owner dashboard (src/routes/builds.ts)
  "GET /staff/builds": staff(rolesWith("builds.read")),
  // Node 1 dispatch-to-GPU diagnostic (migration 0050)
  "GET /staff/builds/diagnostics": staff(rolesWith("builds.configure")),
  "POST /staff/builds/diagnostics": staff(rolesWith("builds.configure"), undefined, act("builds.diagnostic_created")),
  "GET /staff/builds/diagnostics/:id": staff(rolesWith("builds.configure"), P("runnerDiagnostic")),
  "GET /staff/builds/:id": staff(rolesWith("builds.read"), P("buildJob")),
  "POST /staff/builds/pause": staff(rolesWith("builds.manage"), undefined, act("builds.paused_globally")),
  "POST /staff/builds/settings": staff(rolesWith("builds.configure"), undefined, act("builds.settings_updated")),
  "POST /staff/builds/backfill": staff(rolesWith("builds.configure"), undefined, act("builds.backfill_authorized")),
  "POST /staff/builds/projects/:projectId/pause": staff(rolesWith("builds.manage"), { projectId: "project" }, act("builds.project_paused")),
  "POST /staff/builds/projects/:projectId/budget": staff(rolesWith("builds.configure"), { projectId: "project" }, act("builds.project_budget_set")),
  "POST /staff/builds/:id/cancel": staff(rolesWith("builds.manage"), P("buildJob"), act("builds.canceled")),
  "POST /staff/builds/:id/retry": staff(rolesWith("builds.manage"), P("buildJob"), act("builds.retry")),
  "POST /staff/builds/:id/resume": staff(rolesWith("builds.manage"), P("buildJob"), act("builds.resume")),
  "POST /staff/builds/:id/revision": staff(rolesWith("builds.manage"), P("buildJob"), act("builds.revision_submitted")),
  "POST /staff/builds/:id/internal-approve": staff(rolesWith("builds.configure"), P("buildJob"), act("builds.internal_approved")),
  "POST /staff/builds/projects/:id/priority": staff(rolesWith("builds.manage"), P("project"), act("builds.project_priority")),
  "POST /staff/builds/:id/approve": staff(rolesWith("builds.configure"), P("buildJob"), act("builds.preview_approved")),
  "POST /staff/builds/customer-revisions/:id/forward": staff(rolesWith("builds.manage"), P("revision"), act("builds.customer_revision_forwarded")),
  "POST /staff/builds/customer-revisions/:id/reject": staff(rolesWith("builds.manage"), P("revision"), act("builds.customer_revision_rejected")),
  "POST /staff/builds/:id/delete-preview": staff(rolesWith("builds.manage"), P("buildJob"), act("builds.preview_delete_requested")),
  "POST /staff/builds/:id/preview-retention": staff(rolesWith("builds.manage"), P("buildJob"), act("builds.preview_retention_changed")),
  // Founder decision D3: private previews. Opening one issues a signed 5-minute sign-in link (audited).
  "GET /staff/builds/:id/preview": { ...staff(rolesWith("builds.read"), P("buildJob"), act("builds.preview_opened")), offsite: true },
  "POST /staff/builds/:id/share-preview": staff(rolesWith("builds.manage"), P("buildJob"), act("builds.preview_shared")),
  "GET /portal/projects/:id/previews/:buildId": { ...cust({ id: "project", buildId: "buildJob" }, act("portal.preview_opened")), offsite: true },
  "POST /portal/projects/:id/previews/:buildId/review": cust({ id: "project", buildId: "buildJob" }, act("portal.preview_reviewed"), { admin: true }),
  // Founder decision D5: customer production delivery (Owner only; authorization and domains need a recent MFA step-up).
  "GET /staff/builds/projects/:id/delivery": staff(rolesWith("builds.read"), P("project")),
  // Architecture V2: builder accounts, pipeline, approvals, integrations.
  "GET /staff/builds/workers": staff(rolesWith("builds.read")),
  "POST /staff/builds/workers": staff(rolesWith("builds.configure"), undefined, act("builds.worker_registered")),
  "POST /staff/builds/workers/:id/update": staff(rolesWith("builds.configure"), P("buildWorker"), act("builds.worker_updated")),
  "POST /staff/builds/workers/:id/rotate-key": staff(rolesWith("builds.configure"), P("buildWorker"), act("builds.worker_updated")),
  "POST /staff/builds/projects/:id/reassign": staff(rolesWith("builds.manage"), P("project"), act("builds.project_reassigned")),
  "GET /staff/builds/pipeline": staff(rolesWith("builds.read")),
  "GET /staff/builds/projects/:id/pipeline": staff(rolesWith("builds.read"), P("project")),
  "POST /staff/builds/approvals/:id/decide": staff(rolesWith("builds.configure"), P("buildApproval"), act("builds.approval_decided")),
  "POST /staff/builds/integrations/:id/live": staff(rolesWith("builds.configure"), P("buildIntegration"), act("builds.integration_live_status")),
  "POST /staff/builds/projects/:id/site-target": staff(rolesWith("builds.configure"), P("project"), act("builds.site_target_created")),
  "POST /staff/builds/projects/:id/site-domain": staff(rolesWith("builds.configure"), P("project"), act("builds.site_domain_changed")),
  "POST /staff/builds/:id/prepare-release": staff(rolesWith("builds.configure"), P("buildJob"), act("builds.site_release_prepared")),
  "POST /staff/builds/releases/:id/authorize": staff(rolesWith("builds.configure"), P("siteDeployment"), act("builds.site_release_authorized")),
  "POST /staff/builds/releases/:id/cancel": staff(rolesWith("builds.configure"), P("siteDeployment"), act("builds.site_release_canceled")),
  "POST /staff/builds/releases/:id/rollback": staff(rolesWith("builds.configure"), P("siteDeployment"), act("builds.site_rollback_prepared")),
  "POST /staff/ai/:id/decide": staff(rolesWith("ai.manage"), P("aiJob"), act("ai.draft_approved")),
  "POST /staff/ai/:id/retry": staff(rolesWith("ai.manage"), P("aiJob"), act("ai.job_retried")),
  "POST /staff/ai/budget": staff(rolesWith("ai.budget"), undefined, act("ai.budget_updated")),
  // Test-only payment simulation (Owner; refused in production; migration 0044)
  "GET /staff/test-payments": staff(rolesWith("payments.simulate")),
  "POST /staff/test-payments/organizations/:id/mark": staff(rolesWith("payments.simulate"), P("org"), act("payments.simulation_test_org_marked")),
  "POST /staff/test-payments/simulate": staff(rolesWith("payments.simulate"), undefined, act("payments.simulated_applied")),
  "GET /staff/voice": staff(rolesWith("voice.manage")),
  "POST /staff/voice/configs": staff(rolesWith("voice.manage"), undefined, act("voice.config_version_created")),
  "POST /staff/voice/configs/:version/activate": staff(rolesWith("voice.manage"), { version: "voiceVersion" }, act("voice.config_activated")),
  "GET /staff/voice/configs/diff": { ...staff(rolesWith("voice.manage")), query: "a={voiceVersion}&b={voiceVersion}" },
  "POST /staff/voice/prompt-sync": staff(rolesWith("voice.manage"), undefined, act("voice.prompt_sync")),
  "POST /staff/voice/budget": staff(rolesWith("voice.manage"), undefined, act("voice.budget_updated")),
  "GET /staff/voice/calls/:id": staff(rolesWith("voice.manage"), P("call"), act("call.viewed")),
  "POST /staff/voice/test-event": staff(rolesWith("voice.manage"), undefined, act("voice.test_event_sent")),
  "GET /staff/voice/operations": staff(rolesWith("voice.manage")),
  "POST /staff/voice/operations/settings": staff(rolesWith("voice.manage"), undefined, act("voice.settings_updated")),
  "POST /staff/voice/consultations/:id/decide": staff(rolesWith("voice.manage"), P("consultation"), act("consultation.confirmed")),
  "POST /staff/voice/outbound": staff(rolesWith("voice.manage"), undefined, act("voice.outbound_requested")),
  "POST /staff/voice/outbound/:id/decide": staff(rolesWith("voice.manage"), P("outboundRequest"), act("voice.outbound_decided")),
  "POST /staff/voice/dnc": staff(rolesWith("voice.manage"), undefined, act("voice.dnc_added")),
  // ── AI Sales Optimization (src/routes/sales-optimization.ts): view salesopt.read, decisions salesopt.decide (both Owner-only) ──
  "GET /staff/sales-optimization": staff(rolesWith("salesopt.read")),
  "GET /staff/sales-optimization/versions/:id": staff(rolesWith("salesopt.read"), P("soVersion")),
  "POST /staff/sales-optimization/control": staff(rolesWith("salesopt.decide"), undefined, act("salesopt.control_changed")),
  "POST /staff/sales-optimization/targets": staff(rolesWith("salesopt.decide"), undefined, act("salesopt.target_set")),
  "POST /staff/sales-optimization/targets/:stage/verify": staff(rolesWith("salesopt.decide"), { stage: "soStage" }, act("salesopt.target_verified")),
  "POST /staff/sales-optimization/versions": staff(rolesWith("salesopt.read"), undefined, act("salesopt.version_created")),
  "POST /staff/sales-optimization/versions/:id/evaluate": staff(rolesWith("salesopt.read"), P("soVersion"), act("salesopt.eval_started")),
  "POST /staff/sales-optimization/versions/:id/decide": staff(rolesWith("salesopt.decide"), P("soVersion"), act("salesopt.version_rejected")),
  "POST /staff/sales-optimization/deploy": staff(rolesWith("salesopt.decide"), undefined, blocked("needs an evaluated version and a verified Retell sales agent; refused with an error otherwise")),
  "POST /staff/sales-optimization/rollback": staff(rolesWith("salesopt.decide"), undefined, blocked("needs an earlier verified deployment on the stage; refused with an error otherwise")),
  "POST /staff/sales-optimization/experiments": staff(rolesWith("salesopt.decide"), undefined, blocked("needs a version verified on the production sales agent; refused with an error otherwise")),
  "POST /staff/sales-optimization/experiments/:id/decide": staff(rolesWith("salesopt.decide"), P("soExperiment"), act("salesopt.experiment_start")),
  "POST /staff/sales-optimization/run": staff(rolesWith("salesopt.decide"), undefined, act("salesopt.cycle_run")),
  // ── Lead research (worker API signed with RESEARCH_RUNNER_SECRET; dashboard for lead.read_all; decisions lead.write_all; controls Owner) ──
  "POST /api/research/runner/heartbeat": signed("x-crestmont-research-signature"),
  "POST /api/research/runner/batch": signed("x-crestmont-research-signature"),
  // ── Outbound AI sales calls (src/routes/sales-outbound.ts) ──
  "GET /buy/:token": token("purchase link emailed to the verified prospect (only its SHA-256 is stored)", { token: "salesLinkToken" }),
  "GET /sales/unsubscribe/:token": token("sales email unsubscribe token (confirm page)", { token: "salesUnsubToken" }),
  "POST /sales/unsubscribe/:token": token("sales email unsubscribe token", { token: "salesUnsubToken" }, exempt("records an opt-out for the token's own address; same answer whatever the token")),
  "GET /staff/sales-outbound": staff(rolesWith("voice.manage")),
  "POST /staff/sales-outbound/settings": staff(rolesWith("voice.manage"), undefined, act("sales_outbound.settings_updated")),
  "POST /staff/sales-outbound/compliance": staff(rolesWith("voice.manage"), undefined, act("sales_outbound.compliance_approved")),
  "POST /staff/sales-outbound/consents": staff(rolesWith("voice.manage"), undefined, act("sales_outbound.consent_recorded")),
  "POST /staff/sales-outbound/dnc-scrubs": staff(rolesWith("voice.manage"), undefined, act("sales_outbound.dnc_scrub_recorded")),
  "POST /staff/sales-outbound/queue": staff(rolesWith("voice.manage"), undefined, act("sales_outbound.blocked")),
  "POST /staff/sales-outbound/queue/:id/cancel": staff(rolesWith("voice.manage"), P("salesCall"), act("sales_outbound.cancelled")),
  "GET /staff/research": staff(rolesWith("lead.read_all")),
  "POST /staff/research/settings": staff(OWNER, undefined, act("research.settings_updated")),
  "POST /staff/research/promote": staff(rolesWith("lead.write_all"), undefined, act("research.prospect_promoted")),
  "POST /staff/research/dismiss": staff(rolesWith("lead.write_all"), undefined, act("research.prospect_dismissed")),
  "POST /staff/voice/caller-erasure": staff(rolesWith("voice.manage"), undefined, act("voice.caller_data_erased")),
};

export const routeKey = (method: string, pattern: string) => `${method} ${pattern}`;
