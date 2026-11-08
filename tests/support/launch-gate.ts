// Test helper: put a project through the launch gate's customer steps (src/services/launch-gate.ts), so a test about
// something AFTER launch (a release, a deployment, a handoff) starts from a legitimately launchable project.
//
// It does what the real flow does, in order: the maintenance activation is opened for the project, a customer of the
// organisation signs the maintenance agreement, and the subscription is completed through the real
// completeActivationForSubscription() (what the signed customer.subscription.* webhook calls) with its first invoice
// recorded as paid (what the signed invoice.paid webhook writes). The full webhook path itself is proven in
// tests/launch-gate.test.ts.
import type { Env } from "../../src/app/context.ts";
import { newId, nowIso } from "../../src/lib/db.ts";
import { completeActivationForSubscription } from "../../src/services/maintenance-lifecycle.ts";

type Db = Env["DB"];

export async function ensureMaintenanceAgreementRow(db: Db): Promise<string> {
  const id = "agr_test_maintenance";
  await db.prepare(`INSERT OR IGNORE INTO agreements (id, kind, version, body_sha256, attorney_reviewed, effective_at, title, body_text, created_at)
    VALUES (?, 'maintenance_agreement', 'test-fixture', ?, 0, ?, 'Maintenance Agreement', 'test fixture', ?)`).bind(id, "0".repeat(64), nowIso(), nowIso()).run();
  return id;
}

/** Opens the activation (if the project has none) without needing a committed plan on an order. */
export async function openActivation(db: Db, projectId: string, plan: "essential" | "professional" | "executive" = "essential"): Promise<string> {
  const p = (await db.prepare(`SELECT organization_id, order_id FROM projects WHERE id = ?`).bind(projectId).first<{ organization_id: string; order_id: string | null }>())!;
  const existing = await db.prepare(`SELECT id FROM maintenance_activations WHERE project_id = ?`).bind(projectId).first<{ id: string }>();
  if (existing) return existing.id;
  const id = newId("mact");
  await db.prepare(`INSERT INTO maintenance_activations (id, organization_id, project_id, order_id, plan_id, status, trigger, opened_at, created_at, updated_at)
    VALUES (?,?,?,?,?,'due','ready_for_review',?,?,?)`).bind(id, p.organization_id, projectId, p.order_id, plan, nowIso(), nowIso(), nowIso()).run();
  return id;
}

export async function signMaintenanceAgreement(db: Db, projectId: string, userId?: string): Promise<void> {
  const p = (await db.prepare(`SELECT organization_id FROM projects WHERE id = ?`).bind(projectId).first<{ organization_id: string }>())!;
  const signer = userId ?? (await db.prepare(`SELECT user_id FROM memberships WHERE organization_id = ? ORDER BY created_at LIMIT 1`).bind(p.organization_id).first<{ user_id: string }>())?.user_id;
  if (!signer) throw new Error("the project's organisation has no member to sign the agreement");
  const agreementId = await ensureMaintenanceAgreementRow(db);
  await db.prepare(`INSERT INTO agreement_acceptances (id, agreement_id, user_id, organization_id, ip, accepted_at, context_type, context_id, user_agent)
    VALUES (?,?,?,?,NULL,?,'maintenance_agreement',?,NULL)`).bind(newId("acc"), agreementId, signer, p.organization_id, nowIso(), projectId).run();
}

/** The subscription becomes active (webhook path) and its first invoice is recorded as paid. Returns the Stripe id. */
export async function activateSubscription(db: Db, projectId: string, o: { firstPaymentPaid?: boolean; status?: string } = {}): Promise<string> {
  const p = (await db.prepare(`SELECT organization_id FROM projects WHERE id = ?`).bind(projectId).first<{ organization_id: string }>())!;
  const act = (await db.prepare(`SELECT plan_id FROM maintenance_activations WHERE project_id = ?`).bind(projectId).first<{ plan_id: string }>())!;
  const stripeId = `sub_test_${projectId.slice(-12)}`;
  const subId = newId("sub");
  const status = o.status ?? "active";
  await db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, stripe_subscription_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(stripe_subscription_id) DO UPDATE SET status = excluded.status`).bind(subId, p.organization_id, act.plan_id, stripeId, status, nowIso(), nowIso()).run();
  const row = (await db.prepare(`SELECT id FROM subscriptions WHERE stripe_subscription_id = ?`).bind(stripeId).first<{ id: string }>())!;
  await completeActivationForSubscription(db, p.organization_id, row.id, act.plan_id, status);
  if (o.firstPaymentPaid !== false) {
    await db.prepare(`INSERT OR IGNORE INTO subscription_initial_payments (stripe_subscription_id, stripe_invoice_id, stripe_payment_intent_id, amount_cents, paid_at, event_id, created_at)
      VALUES (?, ?, ?, 9900, ?, ?, ?)`).bind(stripeId, `in_test_${projectId.slice(-10)}`, `pi_test_${projectId.slice(-10)}`, nowIso(), `evt_test_${projectId.slice(-10)}`, nowIso()).run();
  }
  return stripeId;
}

/** All of the above: the project is launch-eligible afterwards (given it is in a review stage or later). */
export async function satisfyLaunchGate(db: Db, projectId: string): Promise<void> {
  await openActivation(db, projectId);
  const signed = await db.prepare(`SELECT 1 FROM agreement_acceptances x JOIN agreements a ON a.id = x.agreement_id JOIN projects p ON p.organization_id = x.organization_id
    WHERE p.id = ? AND a.kind = 'maintenance_agreement'`).bind(projectId).first();
  if (!signed) await signMaintenanceAgreement(db, projectId);
  await activateSubscription(db, projectId);
}
