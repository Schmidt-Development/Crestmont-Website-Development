// Maintenance lifecycle after launch (Founder decisions FD-21, FD-26, FD-27 and clarifications 1–2, 2026-11).
//
// Activation (FD-27): recurring maintenance billing starts when the customer approves and launches the completed
// website — never because development was purchased. The two launch paths (a recorded customer deployment and a
// verified live release) both require the customer's final launch approval; each calls openMaintenanceActivation(),
// which records ONE activation per project for the plan committed on the order (orders.maintenance_plan_id). While the
// plan's benefits are not yet operationally verified (FD-05, clarification 8) the activation waits as
// "awaiting_plan_verification": nothing is billed and the Owner is told.
//
// Failed payments (clarifications 1–2): an unresolved failed monthly payment is recorded with the time of the first
// failure. Notices go to the customer at failure (day 0) and again before the seven-day threshold. From day seven the
// hosting is ELIGIBLE for suspension; suspension itself is a documented Owner decision. Nothing here deletes a website
// or customer data, and a successful payment clears the failure and restores suspended hosting.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { HttpError } from "../app/http.ts";
import { MAINTENANCE_PLANS, MAINTENANCE_ORDER, isMaintenanceId, type MaintenanceId } from "../domain/catalog.ts";
import { audit } from "./security.ts";
import { sendMail } from "./mailer.ts";
import type { AppContext } from "../app/context.ts";
import { notifyOwners } from "./voice-common.ts";

export const SUSPENSION_GRACE_DAYS = 7;
/** The pre-suspension reminder goes out this many days after the first failure (two days before eligibility). */
export const SUSPENSION_REMINDER_DAY = 5;
const DAY_MS = 86_400_000;

/** What the lifecycle needs: the database, the email adapter and the public base URL (an AppContext satisfies it). */
export type LifecycleCtx = Pick<AppContext, "db" | "email" | "baseUrl"> & { settings?: Record<string, string> };

export type ActivationTrigger = "deployment_recorded" | "release_live";
export interface MaintenanceActivation {
  id: string; organization_id: string; project_id: string; order_id: string | null; plan_id: MaintenanceId;
  status: "due" | "awaiting_plan_verification" | "active" | "cancelled"; trigger: ActivationTrigger;
  launched_at: string; subscription_id: string | null; activated_at: string | null; cancelled_reason: string | null;
}

function planSellable(id: MaintenanceId): boolean {
  return MAINTENANCE_PLANS[id].entitlementsStatus === "approved";
}

async function customerAdmins(db: Db, organizationId: string): Promise<string[]> {
  return (await db.prepare(`SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.role_id = 'customer_admin' AND u.disabled_at IS NULL`)
    .bind(organizationId).all<{ email: string }>()).results.map((r) => r.email);
}

/**
 * Opens the maintenance activation for a project that has just launched. Idempotent per project (a later deployment or
 * release changes nothing). Projects without a committed plan (quote orders whose plan is set in the approved quote,
 * orders from before migration 0064) are reported to the Owner instead of guessed.
 */
export async function openMaintenanceActivation(db: Db, mail: LifecycleCtx | null, projectId: string, trigger: ActivationTrigger): Promise<MaintenanceActivation | null> {
  const existing = await db.prepare(`SELECT * FROM maintenance_activations WHERE project_id = ?`).bind(projectId).first<MaintenanceActivation>();
  if (existing) return existing;
  const p = await db.prepare(`SELECT p.id, p.name, p.organization_id, p.order_id, o.maintenance_plan_id FROM projects p LEFT JOIN orders o ON o.id = p.order_id WHERE p.id = ?`)
    .bind(projectId).first<{ id: string; name: string; organization_id: string; order_id: string | null; maintenance_plan_id: string | null }>();
  if (!p) return null;
  if (!p.maintenance_plan_id || !isMaintenanceId(p.maintenance_plan_id)) {
    await notifyOwners(db, "maintenance_activation", `${p.name} launched without a committed maintenance plan on its order. Record the plan from the approved quote before billing can start (FD-26/FD-27).`, "project", p.id);
    await audit(db, { actorKind: "system", action: "maintenance.activation_missing_plan", subjectType: "project", subjectId: p.id, organizationId: p.organization_id, details: { trigger } });
    return null;
  }
  const plan = p.maintenance_plan_id;
  const status = planSellable(plan) ? "due" : "awaiting_plan_verification";
  const at = nowIso();
  const id = newId("mact");
  const ins = await db.prepare(`INSERT INTO maintenance_activations (id, organization_id, project_id, order_id, plan_id, status, trigger, launched_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO NOTHING`)
    .bind(id, p.organization_id, p.id, p.order_id, plan, status, trigger, at, at, at).run();
  if (ins.meta.changes !== 1) return db.prepare(`SELECT * FROM maintenance_activations WHERE project_id = ?`).bind(projectId).first<MaintenanceActivation>();
  await audit(db, { actorKind: "system", action: "maintenance.activation_opened", subjectType: "project", subjectId: p.id, organizationId: p.organization_id, details: { activationId: id, planId: plan, status, trigger } });
  if (status === "due") {
    if (mail) for (const to of await customerAdmins(db, p.organization_id)) {
      await sendMail(mail, { template: "subscription_update", to, idempotencyKey: `mact:${id}:${to}`, data: { planName: MAINTENANCE_PLANS[plan].name, status: "ready to start — your website is live", url: `${mail.baseUrl}/checkout/maintenance/${plan}` } });
    }
  } else {
    await notifyOwners(db, "maintenance_activation", `${p.name} launched. Its ${MAINTENANCE_PLANS[plan].name} plan cannot be billed yet: the plan's benefits are awaiting operational verification (FD-05).`, "project", p.id);
  }
  return db.prepare(`SELECT * FROM maintenance_activations WHERE id = ?`).bind(id).first<MaintenanceActivation>();
}

/**
 * FD-26/FD-27 guard for maintenance checkout. A customer whose package order committed a plan may subscribe only after
 * launch (an open activation) and only to that plan or a higher one — never a silent downgrade.
 */
export async function maintenanceCheckoutBlock(db: Db, organizationId: string, planId: MaintenanceId): Promise<string | null> {
  const committed = await db.prepare(`SELECT o.maintenance_plan_id FROM orders o WHERE o.organization_id = ? AND o.kind = 'package' AND o.status IN ('paid','partially_paid') AND o.maintenance_plan_id IS NOT NULL ORDER BY o.created_at DESC LIMIT 1`)
    .bind(organizationId).first<{ maintenance_plan_id: MaintenanceId }>();
  if (!committed) return null;
  const act = await db.prepare(`SELECT plan_id, status FROM maintenance_activations WHERE organization_id = ? AND status IN ('due','awaiting_plan_verification') ORDER BY launched_at DESC LIMIT 1`)
    .bind(organizationId).first<{ plan_id: MaintenanceId; status: string }>();
  if (!act) {
    const live = await db.prepare(`SELECT 1 FROM maintenance_activations WHERE organization_id = ? AND status = 'active'`).bind(organizationId).first();
    return live ? null : "Your maintenance plan starts when you approve and launch your completed website. Nothing is billed before launch.";
  }
  if (MAINTENANCE_ORDER.indexOf(planId) < MAINTENANCE_ORDER.indexOf(act.plan_id)) {
    return `Your website package requires the ${MAINTENANCE_PLANS[act.plan_id].name} plan or higher.`;
  }
  return null;
}

/** Called from the signed Stripe subscription webhook: an active maintenance subscription completes the activation. */
export async function completeActivationForSubscription(db: Db, organizationId: string, subscriptionRowId: string, productId: string | null, status: string): Promise<void> {
  if (!productId || !isMaintenanceId(productId) || !["active", "trialing"].includes(status)) return;
  const act = await db.prepare(`SELECT id, plan_id FROM maintenance_activations WHERE organization_id = ? AND status = 'due' ORDER BY launched_at LIMIT 1`).bind(organizationId).first<{ id: string; plan_id: MaintenanceId }>();
  if (!act || MAINTENANCE_ORDER.indexOf(productId) < MAINTENANCE_ORDER.indexOf(act.plan_id)) return;
  const at = nowIso();
  const r = await db.prepare(`UPDATE maintenance_activations SET status = 'active', subscription_id = ?, activated_at = ?, updated_at = ? WHERE id = ? AND status = 'due'`).bind(subscriptionRowId, at, at, act.id).run();
  if (r.meta.changes === 1) await audit(db, { actorKind: "webhook", action: "maintenance.activation_active", subjectType: "subscription", subjectId: subscriptionRowId, organizationId, details: { activationId: act.id, planId: productId } });
}

// ───────────── failed payments → notices → suspension eligibility → Owner decision → restore ─────────────

/** First unresolved failure starts the seven-day clock; later failures of the same episode keep the original time. */
export async function recordPaymentFailure(db: Db, stripeSubscriptionId: string, at = new Date()): Promise<{ eligibleAt: string } | null> {
  const iso = at.toISOString();
  const eligible = new Date(at.getTime() + SUSPENSION_GRACE_DAYS * DAY_MS).toISOString();
  await db.prepare(`UPDATE subscriptions SET payment_failed_at = COALESCE(payment_failed_at, ?), suspension_eligible_at = COALESCE(suspension_eligible_at, ?), updated_at = ? WHERE stripe_subscription_id = ?`)
    .bind(iso, eligible, iso, stripeSubscriptionId).run();
  const row = await db.prepare(`SELECT suspension_eligible_at FROM subscriptions WHERE stripe_subscription_id = ?`).bind(stripeSubscriptionId).first<{ suspension_eligible_at: string | null }>();
  return row?.suspension_eligible_at ? { eligibleAt: row.suspension_eligible_at } : null;
}

/** A successful payment clears the failure episode and, if hosting was suspended, restores it. */
export async function recordPaymentRecovered(ctx: LifecycleCtx, stripeSubscriptionId: string): Promise<{ restored: boolean }> {
  const db = ctx.db;
  const s = await db.prepare(`SELECT id, organization_id, product_id, hosting_suspended_at FROM subscriptions WHERE stripe_subscription_id = ?`).bind(stripeSubscriptionId)
    .first<{ id: string; organization_id: string; product_id: string; hosting_suspended_at: string | null }>();
  if (!s) return { restored: false };
  const at = nowIso();
  await db.prepare(`UPDATE subscriptions SET payment_failed_at = NULL, suspension_eligible_at = NULL, suspension_reminder_sent_at = NULL, hosting_restored_at = CASE WHEN hosting_suspended_at IS NOT NULL THEN ? ELSE hosting_restored_at END,
      hosting_suspended_at = NULL, hosting_suspended_by = NULL, hosting_suspension_reason = NULL, updated_at = ? WHERE id = ?`).bind(at, at, s.id).run();
  if (!s.hosting_suspended_at) return { restored: false };
  await audit(db, { actorKind: "webhook", action: "hosting.restored", subjectType: "subscription", subjectId: s.id, organizationId: s.organization_id, details: { reason: "payment received" } });
  await notifyOwners(db, "hosting_restored", "Hosting restored automatically after payment was received. Bring the site back online if it was taken offline.", "subscription", s.id);
  const plan = isMaintenanceId(s.product_id) ? MAINTENANCE_PLANS[s.product_id].name : "maintenance";
  for (const to of await customerAdmins(db, s.organization_id)) {
    await sendMail(ctx, { template: "subscription_update", to, idempotencyKey: `restored:${s.id}:${at}:${to}`, data: { planName: plan, status: "payment received — hosting restored", url: `${ctx.baseUrl}/portal/billing` } });
  }
  return { restored: true };
}

/**
 * Daily sweep. Sends the pre-suspension reminder from day five and tells the Owner once a subscription becomes eligible.
 * It never suspends anything and never deletes anything.
 */
export async function runSuspensionSweep(ctx: LifecycleCtx, now = new Date()): Promise<{ reminded: number; eligible: number }> {
  const db = ctx.db;
  const reminderCutoff = new Date(now.getTime() - SUSPENSION_REMINDER_DAY * DAY_MS).toISOString();
  const due = (await db.prepare(`SELECT id, organization_id, suspension_eligible_at FROM subscriptions WHERE status = 'past_due' AND payment_failed_at IS NOT NULL AND payment_failed_at <= ? AND suspension_reminder_sent_at IS NULL`)
    .bind(reminderCutoff).all<{ id: string; organization_id: string; suspension_eligible_at: string }>()).results;
  for (const s of due) {
    for (const to of await customerAdmins(db, s.organization_id)) {
      await sendMail(ctx, { template: "failed_payment", to, idempotencyKey: `suspwarn:${s.id}:${to}`, data: { kind: "suspension_notice", url: `${ctx.baseUrl}/portal/billing`, suspendAfter: s.suspension_eligible_at.slice(0, 10) } });
    }
    await db.prepare(`UPDATE subscriptions SET suspension_reminder_sent_at = ? WHERE id = ?`).bind(now.toISOString(), s.id).run();
    await audit(db, { actorKind: "system", action: "hosting.suspension_notice_sent", subjectType: "subscription", subjectId: s.id, organizationId: s.organization_id, details: { eligibleAt: s.suspension_eligible_at } });
  }
  const eligible = (await db.prepare(`SELECT id FROM subscriptions WHERE status = 'past_due' AND hosting_suspended_at IS NULL AND suspension_eligible_at IS NOT NULL AND suspension_eligible_at <= ? AND suspension_reminder_sent_at IS NOT NULL`)
    .bind(now.toISOString()).all<{ id: string }>()).results;
  for (const s of eligible) {
    const seen = await db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'hosting.suspension_eligible' AND subject_id = ?`).bind(s.id).first();
    if (seen) continue;
    await audit(db, { actorKind: "system", action: "hosting.suspension_eligible", subjectType: "subscription", subjectId: s.id });
    await notifyOwners(db, "hosting_suspension_eligible", "A failed maintenance payment has been unresolved for seven days after notice. Hosting may now be suspended (Owner decision). Nothing will be deleted.", "subscription", s.id);
  }
  return { reminded: due.length, eligible: eligible.length };
}

export interface SuspensionCandidate { id: string; organization_id: string; organization: string; product_id: string; payment_failed_at: string | null; suspension_eligible_at: string | null; suspension_reminder_sent_at: string | null; hosting_suspended_at: string | null; hosting_suspension_reason: string | null }

export async function suspensionCandidates(db: Db): Promise<SuspensionCandidate[]> {
  return (await db.prepare(`SELECT s.id, s.organization_id, o.name AS organization, s.product_id, s.payment_failed_at, s.suspension_eligible_at, s.suspension_reminder_sent_at, s.hosting_suspended_at, s.hosting_suspension_reason
      FROM subscriptions s JOIN organizations o ON o.id = s.organization_id WHERE s.payment_failed_at IS NOT NULL OR s.hosting_suspended_at IS NOT NULL ORDER BY s.payment_failed_at`).all<SuspensionCandidate>()).results;
}

/** Owner decision: suspend hosting for an eligible subscription. Records who, when and why; deletes nothing. */
export async function suspendHosting(ctx: LifecycleCtx, ownerUserId: string, subscriptionId: string, reason: string, now = new Date()): Promise<void> {
  const db = ctx.db;
  if (reason.trim().length < 10) throw new HttpError(422, "Record why hosting is being suspended (at least 10 characters).");
  const s = await db.prepare(`SELECT id, organization_id, status, suspension_eligible_at, suspension_reminder_sent_at, hosting_suspended_at FROM subscriptions WHERE id = ?`).bind(subscriptionId)
    .first<{ id: string; organization_id: string; status: string; suspension_eligible_at: string | null; suspension_reminder_sent_at: string | null; hosting_suspended_at: string | null }>();
  if (!s) throw new HttpError(404, "Subscription not found.");
  if (s.hosting_suspended_at) throw new HttpError(409, "Hosting is already suspended.");
  if (s.status !== "past_due" || !s.suspension_eligible_at) throw new HttpError(409, "There is no unresolved failed payment for this subscription.");
  if (s.suspension_eligible_at > now.toISOString()) throw new HttpError(409, `Not eligible until ${s.suspension_eligible_at.slice(0, 10)}: a failed payment must stay unresolved for seven days.`);
  if (!s.suspension_reminder_sent_at) throw new HttpError(409, "The customer has not received the pre-suspension notice yet.");
  const at = now.toISOString();
  const r = await db.prepare(`UPDATE subscriptions SET hosting_suspended_at = ?, hosting_suspended_by = ?, hosting_suspension_reason = ?, updated_at = ? WHERE id = ? AND hosting_suspended_at IS NULL`)
    .bind(at, ownerUserId, reason.trim().slice(0, 1000), at, s.id).run();
  if (r.meta.changes !== 1) throw new HttpError(409, "The subscription changed; reload and try again.");
  await audit(db, { actorUserId: ownerUserId, action: "hosting.suspended", subjectType: "subscription", subjectId: s.id, organizationId: s.organization_id, details: { reason: reason.trim().slice(0, 500), dataDeleted: false } });
  for (const to of await customerAdmins(db, s.organization_id)) {
    await sendMail(ctx, { template: "failed_payment", to, idempotencyKey: `suspended:${s.id}:${at}:${to}`, data: { kind: "suspended", url: `${ctx.baseUrl}/portal/billing` } });
  }
}

/** Owner decision: restore hosting without waiting for payment (e.g. a payment arrangement). */
export async function restoreHosting(ctx: LifecycleCtx, ownerUserId: string, subscriptionId: string, reason: string): Promise<void> {
  const db = ctx.db;
  if (reason.trim().length < 5) throw new HttpError(422, "Record why hosting is being restored.");
  const at = nowIso();
  const s = await db.prepare(`SELECT id, organization_id, product_id FROM subscriptions WHERE id = ? AND hosting_suspended_at IS NOT NULL`).bind(subscriptionId).first<{ id: string; organization_id: string; product_id: string }>();
  if (!s) throw new HttpError(409, "Hosting is not suspended for this subscription.");
  await db.prepare(`UPDATE subscriptions SET hosting_suspended_at = NULL, hosting_suspended_by = NULL, hosting_suspension_reason = NULL, hosting_restored_at = ?, updated_at = ? WHERE id = ?`).bind(at, at, s.id).run();
  await audit(db, { actorUserId: ownerUserId, action: "hosting.restored", subjectType: "subscription", subjectId: s.id, organizationId: s.organization_id, details: { reason: reason.trim().slice(0, 500) } });
  const plan = isMaintenanceId(s.product_id) ? MAINTENANCE_PLANS[s.product_id].name : "maintenance";
  for (const to of await customerAdmins(db, s.organization_id)) {
    await sendMail(ctx, { template: "subscription_update", to, idempotencyKey: `restored:${s.id}:${at}:${to}`, data: { planName: plan, status: "hosting restored", url: `${ctx.baseUrl}/portal/billing` } });
  }
}
