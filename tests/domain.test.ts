// Test names start with "[REQ-ID]" so the evidence reporter can map results to requirements.
import { test } from "node:test";
import assert from "node:assert/strict";
import { priceQuote, milestoneSplit, PACKAGES, MAINTENANCE_PLANS, PricingError, findProhibitedClaims } from "../src/domain/catalog.ts";
import { transitionLead, LEAD_TRANSITIONS, LEAD_STAGES } from "../src/domain/crm.ts";
import { transitionProject, resumeProject, decideRevision, inactivityAction, customerReleaseReadiness, milestoneInvoiceAllowed } from "../src/domain/project.ts";
import { can, type Actor } from "../src/domain/authz.ts";
import { refundTransition } from "../src/domain/refunds.ts";
import { TransitionError } from "../src/domain/state-machine.ts";

const owner: Actor = { kind: "user", userId: "u_owner", roles: [{ role: "owner", organizationId: "org_internal" }], mfaVerified: true };
const support: Actor = { kind: "user", userId: "u_sup", roles: [{ role: "support", organizationId: "org_internal" }], mfaVerified: true };
const sales: Actor = { kind: "user", userId: "u_sales", roles: [{ role: "sales", organizationId: "org_internal" }], mfaVerified: true };
const ai: Actor = { kind: "ai", roles: [{ role: "owner", organizationId: "org_internal" }], mfaVerified: true };
const custA: Actor = { kind: "user", userId: "u_a", roles: [{ role: "customer_admin", organizationId: "org_a" }], mfaVerified: false };

test("[CAT-002] package prices and revision rounds match the approved directive", () => {
  assert.equal(PACKAGES.starter.basePriceCents, 99_900);
  assert.equal(PACKAGES.business.basePriceCents, 249_900);
  assert.equal(PACKAGES.premium.basePriceCents, 499_900);
  assert.deepEqual([PACKAGES.starter.pageLimit, PACKAGES.business.pageLimit, PACKAGES.premium.pageLimit], [5, 12, 25]);
  assert.deepEqual([PACKAGES.starter.revisionRounds, PACKAGES.business.revisionRounds, PACKAGES.premium.revisionRounds], [2, 3, 4]);
  assert.ok(Object.isFrozen(PACKAGES));
});

test("[SALES-001] standard packages are fixed-price and cannot be padded with lines", () => {
  assert.equal(priceQuote({ packageId: "starter" }).totalCents, 99_900);
  assert.throws(() => priceQuote({ packageId: "business", customLines: [{ description: "extra", amountCents: 1 }] }), PricingError);
  assert.equal(priceQuote({ packageId: "premium", customLines: [{ description: "Booking integration", amountCents: 120_000 }] }).totalCents, 619_900);
  assert.throws(() => priceQuote({ packageId: "custom", customLines: [{ description: "x", amountCents: -5 }] }), PricingError);
  assert.throws(() => priceQuote({ packageId: "nope" as never }), PricingError);
});

test("[CAT-004] standard packages are 100% upfront; custom uses an exact 50/25/25 split", () => {
  assert.deepEqual(priceQuote({ packageId: "starter" }).installments, [{ kind: "full", amountCents: 99_900 }]);
  const c = priceQuote({ packageId: "custom", customLines: [{ description: "SaaS build", amountCents: 1_000_001 }] });
  assert.equal(c.schedule, "milestone_50_25_25");
  assert.equal(c.installments.reduce((s, i) => s + i.amountCents, 0), 1_000_001);
  assert.deepEqual(milestoneSplit(1000).map((i) => i.amountCents), [500, 250, 250]);
});

test("[CAT-006] maintenance entitlements are not marked approved without the Founder", () => {
  assert.deepEqual(Object.values(MAINTENANCE_PLANS).map((p) => p.monthlyCents), [9_900, 19_900, 29_900]);
  for (const p of Object.values(MAINTENANCE_PLANS)) assert.equal(p.entitlementsStatus, "proposed_pending_founder_approval");
});

test("[WEB-009] prohibited marketing claims are detected", () => {
  assert.ok(findProhibitedClaims("We guarantee rankings on Google").length > 0);
  assert.ok(findProhibitedClaims("Only 3 spots left this month!").length > 0);
  assert.equal(findProhibitedClaims("Technical SEO foundations built to best practice.").length, 0);
});

test("[CRM-003] lead pipeline enforces valid transitions, reasons, and reopen paths", () => {
  transitionLead("new", "qualified");
  assert.throws(() => transitionLead("new", "accepted"), TransitionError);
  assert.throws(() => transitionLead("qualified", "lost"), /reason/);
  transitionLead("qualified", "lost", { lostReason: "Budget" });
  transitionLead("lost", "qualified");
  transitionLead("archived", "qualified");
  assert.throws(() => transitionLead("awaiting_payment", "converted"), /webhook/);
  transitionLead("awaiting_payment", "converted", { paymentConfirmedByWebhook: true });
  for (const s of LEAD_STAGES) assert.ok(LEAD_TRANSITIONS[s], `stage ${s} has a transition entry`);
});

test("[PM-001] project lifecycle follows the validated state machine", () => {
  transitionProject("purchased", "awaiting_onboarding");
  transitionProject("final_approval", "deployment");
  assert.throws(() => transitionProject("design", "deployment"), TransitionError);
  assert.throws(() => transitionProject("development", "cancelled"), /authorized actor/);
  transitionProject("development", "paused");
  assert.equal(resumeProject("paused", "development"), "development");
  assert.throws(() => transitionProject("completed", "paused"), TransitionError);
});

test("[PM-002] revision allowance is enforced per package", () => {
  for (const [pkg, n] of [["starter", 2], ["business", 3], ["premium", 4]] as const) {
    const allowance = PACKAGES[pkg].revisionRounds;
    assert.equal(allowance, n);
    for (let used = 0; used < n; used++) assert.equal(decideRevision(allowance, used).kind, "included");
    assert.equal(decideRevision(allowance, n).kind, "change_order_required");
  }
});

test("[PM-005] inactivity reminds, escalates, then pauses — never cancels", () => {
  assert.deepEqual(inactivityAction(3, { reminders: 0, escalated: false }), { kind: "none" });
  assert.deepEqual(inactivityAction(8, { reminders: 0, escalated: false }), { kind: "remind", reminder: 1 });
  assert.deepEqual(inactivityAction(15, { reminders: 1, escalated: false }), { kind: "remind", reminder: 2 });
  assert.deepEqual(inactivityAction(22, { reminders: 2, escalated: false }), { kind: "escalate" });
  assert.deepEqual(inactivityAction(31, { reminders: 2, escalated: true }), { kind: "pause" });
  assert.deepEqual(inactivityAction(31, { reminders: 2, escalated: false }), { kind: "escalate" });
});

test("[PM-006] customer release requires all approvals and payments", () => {
  const all = ["engineering_complete", "internal_qa", "security_accessibility", "customer_launch", "deployment_authorized"]
    .map((kind) => ({ kind, decision: "approved" as const, createdAt: "2026-10-01T00:00:00Z" }));
  assert.equal(customerReleaseReadiness({ approvals: all, schedule: "upfront", paidMilestones: ["full"] }).ready, true);
  const unpaid = customerReleaseReadiness({ approvals: all, schedule: "milestone_50_25_25", paidMilestones: ["deposit_50", "design_25"] });
  assert.equal(unpaid.ready, false);
  assert.ok(unpaid.missing.includes("payment:prelaunch_25"));
  const revoked = [...all, { kind: "internal_qa", decision: "rejected" as const, createdAt: "2026-10-02T00:00:00Z" }];
  assert.ok(customerReleaseReadiness({ approvals: revoked, schedule: "upfront", paidMilestones: ["full"] }).missing.includes("internal_qa"));
});

test("[PAY-006] milestone invoices are gated by project approvals", () => {
  assert.equal(milestoneInvoiceAllowed("deposit_50", []), true);
  assert.equal(milestoneInvoiceAllowed("design_25", []), false);
  assert.equal(milestoneInvoiceAllowed("design_25", [{ kind: "design", decision: "approved" }]), true);
  assert.equal(milestoneInvoiceAllowed("prelaunch_25", [{ kind: "design", decision: "approved" }]), false);
});

test("[EMP-002] granular permissions are enforced and staff require MFA", () => {
  assert.equal(can(sales, "quote.write"), true);
  assert.equal(can(sales, "refund.decide"), false);
  assert.equal(can(support, "refund.review"), true);
  assert.equal(can(support, "refund.decide"), false);
  assert.equal(can(owner, "release.approve_production"), true);
  assert.equal(can({ ...owner, mfaVerified: false }, "release.approve_production"), false);
});

test("[AUTH-008] customers cannot act on another organization", () => {
  assert.equal(can(custA, "customer.org.read", { organizationId: "org_a" }), true);
  assert.equal(can(custA, "customer.org.read", { organizationId: "org_b" }), false);
  assert.equal(can(custA, "customer.org.read"), false);
  assert.equal(can(custA, "lead.read_all"), false);
});

test("[AIOPS-003] AI actors never hold Founder-protected permissions", () => {
  for (const p of ["refund.decide", "refund.issue", "release.approve_production", "release.deploy_production", "pricing.change"] as const) {
    assert.equal(can(ai, p), false, p);
  }
});

test("[PAY-007] refunds: support reviews, only the Founder decides, AI is blocked", () => {
  refundTransition(support, "requested", "under_review", { notes: "Opened" });
  refundTransition(support, "under_review", "recommended", { notes: "Duplicate charge confirmed" });
  assert.throws(() => refundTransition(support, "recommended", "approved"), /Founder/);
  refundTransition(owner, "recommended", "approved");
  assert.throws(() => refundTransition(ai, "requested", "under_review", { notes: "x" }), /AI/);
  assert.throws(() => refundTransition(owner, "recommended", "denied", { mandatoryObligation: true }), /mandatory/);
  assert.throws(() => refundTransition(owner, "requested", "approved"), TransitionError);
});

test("[PAY-007] FD-03: only the Founder may deny a refund request, at review or at decision; mandatory refunds are never deniable", () => {
  assert.throws(() => refundTransition(support, "under_review", "denied", { notes: "Out of policy" }), /Only the Founder can deny/);
  assert.throws(() => refundTransition(support, "recommended", "denied", { notes: "No" }), /Founder/);
  refundTransition(owner, "under_review", "denied", { notes: "Founder discretionary review: work delivered as scoped" });
  refundTransition(owner, "recommended", "denied", { notes: "No" });
  assert.throws(() => refundTransition(owner, "under_review", "denied", { notes: "No", mandatoryObligation: true }), /mandatory/);
});
