// The website launch gate (Founder directive 2026-11-08): no website goes live until the customer has signed the
// maintenance agreement AND the first maintenance subscription payment has been verified through Stripe.
//
// Required sequence:
//   1. the website is complete and marked ready for customer review   (project status customer_review onwards)
//   2. the customer reviews it
//   3. Pending Action: Sign Your Maintenance Agreement                 (agreement_acceptances, kind maintenance_agreement)
//   4. Pending Action: Activate Your Maintenance Subscription          (Stripe Checkout)
//   5. the SIGNED webhook reports the subscription active and its first invoice paid
//                                                                      (maintenance_activations.status = 'active' and
//                                                                       subscription_initial_payments, not reversed)
//   6. only then may any release path publish the website
//
// ENFORCED ON THE SERVER, at every path that can publish: releaseReadiness() (project status -> deployment, the
// "deployment authorized" approval, recording a deployment), the Owner's release preparation and authorization
// (site-delivery releaseBlockers), the runner's claim of an authorized deployment, and publishing the handoff. A
// hidden button is never the control. Customer approval alone never satisfies it, a Checkout redirect never
// satisfies it, and there is no exception or override: the Founder's payment exception (FD-16) waives development
// milestones only.
//
// Read-only: it decides, it never changes a record. Later monthly payment failures follow the existing seven-day
// policy in maintenance-lifecycle.ts and do not un-launch a live website.
import type { Db } from "../lib/db.ts";
import { MAINTENANCE_PLANS, isMaintenanceId } from "../domain/catalog.ts";

export type LaunchStepKey = "ready_for_review" | "agreement_signed" | "subscription_active" | "initial_payment_verified";

export interface LaunchStep { key: LaunchStepKey; label: string; done: boolean; detail: string }

export interface LaunchEligibility {
  eligible: boolean;
  steps: LaunchStep[];
  /** One plain sentence for staff, e.g. "Website ready — waiting for maintenance subscription". */
  status: string;
  /** Machine-readable reasons, for releaseReadiness' `missing` list. */
  missing: string[];
  /** What the customer still has to do, in order (empty when nothing). */
  customerActions: ("sign_agreement" | "activate_subscription")[];
  planId: string | null;
  planName: string | null;
  activationStatus: string | null;
}

const REVIEW_STAGES = ["customer_review", "revisions", "final_approval", "deployment", "completed", "maintenance"];

/** Has a member of the customer's organisation signed the maintenance agreement for this project? */
export async function maintenanceAgreementSigned(db: Db, organizationId: string, projectId: string): Promise<{ signedAt: string; by: string } | null> {
  const r = await db.prepare(
    `SELECT x.accepted_at, u.display_name FROM agreement_acceptances x
       JOIN agreements a ON a.id = x.agreement_id JOIN users u ON u.id = x.user_id
      WHERE x.organization_id = ? AND a.kind = 'maintenance_agreement'
        AND ((x.context_type = 'maintenance_agreement' AND x.context_id = ?) OR x.context_type = 'maintenance_checkout')
      ORDER BY x.accepted_at DESC LIMIT 1`,
  ).bind(organizationId, projectId).first<{ accepted_at: string; display_name: string }>();
  return r ? { signedAt: r.accepted_at, by: r.display_name } : null;
}

export async function launchEligibility(db: Db, projectId: string): Promise<LaunchEligibility> {
  const p = await db.prepare(
    `SELECT p.id, p.status, p.organization_id, o.maintenance_plan_id FROM projects p LEFT JOIN orders o ON o.id = p.order_id WHERE p.id = ?`,
  ).bind(projectId).first<{ id: string; status: string; organization_id: string; maintenance_plan_id: string | null }>();
  if (!p) {
    return { eligible: false, steps: [], status: "Project not found", missing: ["project_not_found"], customerActions: [], planId: null, planName: null, activationStatus: null };
  }
  const act = await db.prepare(`SELECT * FROM maintenance_activations WHERE project_id = ?`).bind(projectId)
    .first<{ id: string; status: string; plan_id: string; subscription_id: string | null; activated_at: string | null }>();
  const planId = act?.plan_id ?? p.maintenance_plan_id ?? null;
  const planName = planId && isMaintenanceId(planId) ? MAINTENANCE_PLANS[planId].name : null;

  const reviewReady = REVIEW_STAGES.includes(p.status);
  const signed = await maintenanceAgreementSigned(db, p.organization_id, projectId);
  const sub = act?.subscription_id
    ? await db.prepare(`SELECT id, status, stripe_subscription_id FROM subscriptions WHERE id = ?`).bind(act.subscription_id)
      .first<{ id: string; status: string; stripe_subscription_id: string | null }>()
    : null;
  // past_due only happens after a LATER renewal failed (the first invoice was paid), which the existing seven-day policy
  // in maintenance-lifecycle.ts handles; it does not withdraw launch eligibility. incomplete / unpaid / canceled do.
  const subscriptionActive = !!act && act.status === "active" && (sub?.status === "active" || sub?.status === "past_due");
  const first = sub?.stripe_subscription_id
    ? await db.prepare(`SELECT paid_at, amount_cents, reversed_at, reversal_reason FROM subscription_initial_payments WHERE stripe_subscription_id = ?`)
      .bind(sub.stripe_subscription_id).first<{ paid_at: string; amount_cents: number; reversed_at: string | null; reversal_reason: string | null }>()
    : null;
  const paymentVerified = !!first && !first.reversed_at;

  const subscriptionDetail = !act
    ? (planId ? "Opens when the website is ready for the customer's review" : "No maintenance plan is recorded on this project's order — record the plan from the approved quote")
    : act.status === "awaiting_plan_verification" ? `The ${planName ?? "maintenance"} plan's benefits are awaiting operational verification, so it cannot be activated yet`
    : act.status === "cancelled" ? "The maintenance activation was cancelled"
    : act.status === "due" ? "Waiting for the customer to activate the subscription in Stripe Checkout"
    : sub?.status !== "active" && sub?.status !== "past_due" ? `Stripe reports the subscription as ${sub?.status ?? "missing"}`
    : "Active (confirmed by Stripe)";
  const paymentDetail = !sub ? "No subscription yet"
    : !first ? "Waiting for Stripe to confirm the first payment (a Checkout redirect is not proof of payment)"
    : first.reversed_at ? `The first payment was ${first.reversal_reason ?? "reversed"} on ${first.reversed_at.slice(0, 10)}`
    : `First payment confirmed by Stripe on ${first.paid_at.slice(0, 10)}`;

  const steps: LaunchStep[] = [
    { key: "ready_for_review", label: "Website ready for customer review", done: reviewReady, detail: reviewReady ? "Ready" : `Project is in ${p.status.replace(/_/g, " ")}` },
    { key: "agreement_signed", label: "Maintenance agreement signed", done: !!signed, detail: signed ? `Signed by ${signed.by} on ${signed.signedAt.slice(0, 10)}` : "Waiting for the customer to sign" },
    { key: "subscription_active", label: "Maintenance subscription active", done: subscriptionActive, detail: subscriptionDetail },
    { key: "initial_payment_verified", label: "First subscription payment verified", done: paymentVerified, detail: paymentDetail },
  ];
  const missing: string[] = [];
  if (!reviewReady) missing.push("maintenance:website_not_ready_for_review");
  if (!signed) missing.push("maintenance:agreement_not_signed");
  if (!subscriptionActive) missing.push("maintenance:subscription_not_active");
  if (!paymentVerified) missing.push("maintenance:initial_payment_not_verified");

  const customerActions: LaunchEligibility["customerActions"] = [];
  if (reviewReady && act && act.status !== "cancelled") {
    if (!signed) customerActions.push("sign_agreement");
    else if (act.status === "due" || (act.status === "active" && !subscriptionActive)) customerActions.push("activate_subscription");
  }

  const eligible = missing.length === 0;
  const status = eligible ? "Website approved for publishing"
    : !reviewReady ? "Website not ready for customer review yet"
    : !signed ? "Website ready — waiting for the maintenance agreement to be signed"
    : !subscriptionActive ? "Website ready — waiting for maintenance subscription"
    : "Website ready — waiting for Stripe to confirm the first maintenance payment";
  return { eligible, steps, status, missing, customerActions, planId, planName, activationStatus: act?.status ?? null };
}

/** Throws a plain-English refusal when the website may not be published. Used at every release path. */
export async function assertLaunchAllowed(db: Db, projectId: string): Promise<void> {
  const e = await launchEligibility(db, projectId);
  if (!e.eligible) {
    const { HttpError } = await import("../app/http.ts");
    const todo = e.steps.filter((s) => !s.done).map((s) => `${s.label}: ${s.detail}`).join("; ");
    throw new HttpError(409, `This website cannot be published yet. ${e.status}. Still required — ${todo}.`);
  }
}
