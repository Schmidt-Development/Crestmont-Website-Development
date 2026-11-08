// Financial issues as My Work items (Founder directive 2026-11-08, Phase 4).
//
// The reconciliation engine and cost import keep running exactly as before (src/services/stripe-reconcile.ts,
// cost-import.ts, the daily scheduled jobs). This module turns what they -- and the payment, refund and dispute records
// -- already know into plain-English work items for the person who has to act, in My Work.
//
// LIVE, NOT COPIED. Each item is read from its source record every time, so:
//   - it appears automatically as soon as the source says there is a problem (a finding opens, a payment fails, a
//     dispute arrives, the cost import fails);
//   - it disappears automatically as soon as the problem is genuinely resolved (the next reconciliation run no longer
//     sees it and marks it cleared; the payment recovers; the refund is decided; the dispute closes; the import runs);
//   - there can never be two items for one unresolved problem: the item IS the record (a finding's fingerprint is
//     unique), and a retry or a second run cannot create a duplicate;
//   - a resolved problem that genuinely comes back re-opens the same finding (stripe-reconcile.ts storeFindings).
// Nothing here changes a financial record. Resolving a finding records the reviewer's typed resolution and note
// (resolveFinding); corrections are made through the normal, separately audited workflows or in Stripe.
//
// Who sees it: finance.read (the Owner). Refund requests are also shown to refund reviewers (refund.review).
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";
import { can, type Actor } from "../domain/authz.ts";
import * as AUTHZ from "../domain/authz.ts";
import type { FindingKind } from "./stripe-reconcile.ts";

export type FinancePriority = "urgent" | "high" | "normal";

export interface FinanceWorkItem {
  key: string;
  title: string;
  customer: string | null;
  project: { id: string; name: string } | null;
  explanation: string;
  amountCents: number | null;
  priority: FinancePriority;
  discoveredAt: string;
  assignedTo: { id: string; name: string } | null;
  nextAction: string;
  status: string;
  href: string;
  /** For findings: resolve inline from My Work. */
  findingId?: string;
  /** Raw technical detail, shown only inside a collapsed "Technical details". */
  technical?: string;
}

/** Plain-English title, explanation and next step per reconciliation finding kind. */
const FINDING_TEXT: Record<FindingKind, { title: string; explain: string; next: string; priority: FinancePriority }> = {
  paid_in_stripe_unpaid_locally: { title: "Customer paid, but the invoice still shows unpaid", explain: "Stripe received this payment, but Crestmont's invoice is not marked paid, so the customer may be asked to pay again or their project may not start.", next: "Check the payment in Stripe and the invoice; the stored payment event may need to be re-processed.", priority: "urgent" },
  unknown_local_invoice: { title: "Payment received with no matching invoice", explain: "Stripe took a payment that does not belong to any Crestmont invoice.", next: "Find which customer and order the payment belongs to, then record or refund it.", priority: "high" },
  amount_mismatch: { title: "Payment amount does not match the invoice", explain: "The amount Stripe collected is different from the amount on Crestmont's invoice.", next: "Compare the Stripe payment with the invoice and correct whichever is wrong.", priority: "high" },
  payment_missing_locally: { title: "Invoice marked paid without its payment record", explain: "The invoice is paid in Crestmont, but the Stripe payment behind it was never recorded, so refunds and reports cannot be matched to it.", next: "Re-process the stored Stripe event for this payment.", priority: "high" },
  subscription_missing_locally: { title: "Maintenance subscription not recorded", explain: "A subscription started in Stripe but Crestmont has no record of it, so the customer's plan may not show as active.", next: "Re-process the subscription event so the plan is recorded.", priority: "high" },
  paid_locally_not_in_stripe: { title: "Invoice marked paid, but Stripe has no payment", explain: "Crestmont shows this invoice as paid, but Stripe has no paid checkout for it.", next: "Confirm how the customer paid; if they did not, the invoice status must be corrected through the normal workflow.", priority: "urgent" },
  stripe_invoice_missing_locally: { title: "Stripe invoice with no Crestmont invoice", explain: "Stripe has an invoice that does not match any Crestmont invoice.", next: "Identify the customer and either record it or void it in Stripe.", priority: "normal" },
  stripe_invoice_amount_mismatch: { title: "Stripe invoice amount differs", explain: "The invoice amount in Stripe is different from Crestmont's invoice.", next: "Correct whichever invoice is wrong.", priority: "high" },
  stripe_invoice_status_mismatch: { title: "Stripe invoice status disagrees", explain: "Stripe and Crestmont disagree about whether this invoice is paid, open or void.", next: "Check the invoice in Stripe and bring the two in line through the normal workflow.", priority: "normal" },
  local_stripe_invoice_not_found: { title: "Invoice points to a missing Stripe invoice", explain: "Crestmont's invoice refers to a Stripe invoice that Stripe did not list.", next: "Check whether the Stripe invoice was deleted or belongs to another Stripe account.", priority: "normal" },
  balance_txn_missing_locally: { title: "Stripe transaction not recorded", explain: "Stripe shows money moving that Crestmont has no payment record for.", next: "Match the transaction to a customer payment and record it.", priority: "normal" },
  balance_txn_amount_mismatch: { title: "Stripe transaction amount differs", explain: "A Stripe transaction amount is different from the payment Crestmont recorded.", next: "Compare and correct the recorded payment.", priority: "normal" },
  fee_mismatch: { title: "Stripe fee differs from what was recorded", explain: "The processing fee Stripe charged is different from the fee recorded in Crestmont, so profit figures may be off.", next: "Confirm the fee in Stripe; the next sync usually corrects it.", priority: "normal" },
  refund_missing_locally: { title: "Refund in Stripe not recorded", explain: "A refund was issued in Stripe that Crestmont has no record of.", next: "Record the refund against the right payment, or find out who issued it.", priority: "high" },
  payout_amount_mismatch: { title: "Payout does not add up", explain: "A Stripe payout to the bank does not equal the transactions it is supposed to contain.", next: "Review the payout in Stripe and tell the accountant if it cannot be explained.", priority: "normal" },
  payout_failed: { title: "Stripe payout to the bank failed", explain: "Stripe could not send money to Crestmont's bank account.", next: "Check the bank details in the Stripe dashboard.", priority: "urgent" },
};

const PRIORITY_ORDER: Record<FinancePriority, number> = { urgent: 0, high: 1, normal: 2 };

async function assignments(db: Db): Promise<Map<string, { id: string; name: string }>> {
  const rows = (await db.prepare(`SELECT a.item_key, u.id, u.display_name FROM finance_work_assignments a JOIN users u ON u.id = a.user_id`).all<{ item_key: string; id: string; display_name: string }>()).results;
  return new Map(rows.map((r) => [r.item_key, { id: r.id, name: r.display_name }]));
}

/** Every open financial issue the actor may see, most urgent first. Read-only. */
export async function financeWorkItems(db: Db, actor: Actor, now = new Date()): Promise<FinanceWorkItem[]> {
  const finance = can(actor, "finance.read"), refunds = finance || can(actor, "refund.review");
  if (!refunds) return [];
  const assigned = await assignments(db);
  const items: FinanceWorkItem[] = [];
  if (finance) {
    // 1. Stripe vs Crestmont discrepancies (the reconciliation engine). Open only: a cleared finding resolved itself.
    const findings = (await db.prepare(
      `SELECT r.id, r.kind, r.detail, r.first_seen_at, r.reopened_count, r.stripe_amount_cents, r.local_amount_cents, r.invoice_id, o.name AS org,
              (SELECT p.id FROM invoices i JOIN projects p ON p.id = i.project_id WHERE i.id = r.invoice_id) AS project_id,
              (SELECT p.name FROM invoices i JOIN projects p ON p.id = i.project_id WHERE i.id = r.invoice_id) AS project_name
         FROM reconciliation_findings r LEFT JOIN organizations o ON o.id = r.organization_id WHERE r.status = 'open'
        ORDER BY r.first_seen_at LIMIT 200`,
    ).all<{ id: string; kind: FindingKind; detail: string; first_seen_at: string; reopened_count: number; stripe_amount_cents: number | null; local_amount_cents: number | null; invoice_id: string | null; org: string | null; project_id: string | null; project_name: string | null }>()).results;
    for (const f of findings) {
      const t = FINDING_TEXT[f.kind] ?? { title: "Payment record needs review", explain: "Stripe and Crestmont's records disagree.", next: "Review the record.", priority: "normal" as FinancePriority };
      items.push({
        key: `finding:${f.id}`, findingId: f.id, title: t.title + (f.reopened_count ? " (came back after being fixed)" : ""), customer: f.org,
        project: f.project_id ? { id: f.project_id, name: f.project_name ?? f.project_id } : null,
        explanation: t.explain, amountCents: f.stripe_amount_cents ?? f.local_amount_cents, priority: f.reopened_count ? "urgent" : t.priority,
        discoveredAt: f.first_seen_at, assignedTo: assigned.get(`finding:${f.id}`) ?? null, nextAction: t.next, status: f.reopened_count ? "Re-opened" : "Open",
        href: `/staff/finance/reconciliation?q=${encodeURIComponent(f.id)}`, technical: f.detail,
      });
    }
    // 2. Maintenance payments that failed and are still unresolved (the seven-day policy runs separately).
    const failed = (await db.prepare(
      `SELECT s.id, s.payment_failed_at, s.suspension_eligible_at, s.product_id, o.name AS org FROM subscriptions s JOIN organizations o ON o.id = s.organization_id
        WHERE s.payment_failed_at IS NOT NULL AND s.status = 'past_due' ORDER BY s.payment_failed_at LIMIT 100`,
    ).all<{ id: string; payment_failed_at: string; suspension_eligible_at: string | null; product_id: string; org: string }>()).results;
    for (const s of failed) {
      const eligible = s.suspension_eligible_at && s.suspension_eligible_at <= now.toISOString();
      items.push({
        key: `subscription:${s.id}`, title: "Maintenance payment failed", customer: s.org, project: null,
        explanation: `The customer's monthly maintenance payment failed on ${s.payment_failed_at.slice(0, 10)} and has not been paid since. ${eligible ? "Hosting is now eligible for suspension under the seven-day policy." : `Hosting becomes eligible for suspension on ${(s.suspension_eligible_at ?? "").slice(0, 10)} if it stays unpaid.`}`,
        amountCents: null, priority: eligible ? "urgent" : "high", discoveredAt: s.payment_failed_at, assignedTo: assigned.get(`subscription:${s.id}`) ?? null,
        nextAction: "Contact the customer so they update their card; the customer has already been emailed automatically.", status: eligible ? "Suspension eligible" : "Awaiting payment",
        href: "/staff/billing/hosting",
      });
    }
    // 3. Open payment disputes.
    const disputes = (await db.prepare(
      `SELECT d.id, d.amount_cents, d.reason, d.status, d.evidence_due_by, d.created_at, o.name AS org FROM disputes d LEFT JOIN organizations o ON o.id = d.organization_id
        WHERE d.status IN ('needs_response','warning_needs_response','under_review','warning_under_review') ORDER BY d.created_at LIMIT 100`,
    ).all<{ id: string; amount_cents: number; reason: string | null; status: string; evidence_due_by: string | null; created_at: string; org: string | null }>()).results;
    for (const d of disputes) {
      const needsResponse = d.status.includes("needs_response");
      items.push({
        key: `dispute:${d.id}`, title: needsResponse ? "Payment dispute needs a response" : "Payment dispute under review", customer: d.org, project: null,
        explanation: `The customer's bank disputed this payment${d.reason ? ` (${d.reason.replace(/_/g, " ")})` : ""}.${d.evidence_due_by ? ` Evidence is due by ${d.evidence_due_by.slice(0, 10)}.` : ""}`,
        amountCents: d.amount_cents, priority: needsResponse ? "urgent" : "normal", discoveredAt: d.created_at, assignedTo: assigned.get(`dispute:${d.id}`) ?? null,
        nextAction: needsResponse ? "Gather the agreement, invoices and project messages and submit evidence in Stripe before the deadline." : "Wait for the bank's decision; nothing is needed unless Stripe asks.",
        status: d.status.replace(/_/g, " "), href: "/staff/disputes",
      });
    }
    // 4. The daily cost import failed on its latest attempt.
    const job = await db.prepare(`SELECT last_attempt_at, last_error FROM ingestion_status WHERE source = 'job:cost_import' AND last_error IS NOT NULL`).first<{ last_attempt_at: string; last_error: string }>();
    if (job) {
      items.push({
        key: "job:cost_import", title: "Cost import failed", customer: null, project: null,
        explanation: "The daily import of AI and Stripe processing costs did not finish, so project costs and profit may be incomplete. It runs again automatically every day.",
        amountCents: null, priority: "normal", discoveredAt: job.last_attempt_at, assignedTo: assigned.get("job:cost_import") ?? null,
        nextAction: "If it fails again tomorrow, ask the person who looks after the platform to check the error.", status: "Failed", href: "/staff/finance/reconciliation?view=costs",
        technical: job.last_error,
      });
    }
  }
  // 5. Refund requests waiting for review (the refund workflow itself is unchanged).
  const reqs = (await db.prepare(
    `SELECT r.id, r.amount_cents, r.reason, r.status, r.created_at, o.name AS org FROM refunds r JOIN organizations o ON o.id = r.organization_id
      WHERE r.status IN ('requested','under_review','recommended') ORDER BY r.created_at LIMIT 100`,
  ).all<{ id: string; amount_cents: number; reason: string; status: string; created_at: string; org: string }>()).results;
  for (const r of reqs) {
    items.push({
      key: `refund:${r.id}`, title: r.status === "recommended" ? "Refund recommended — Owner decision needed" : "Refund request to review", customer: r.org, project: null,
      explanation: `The customer asked for a refund: “${r.reason.slice(0, 200)}”. Refunds are not guaranteed; only the Owner may approve an exception under the refund policy.`,
      amountCents: r.amount_cents, priority: r.status === "recommended" ? "high" : "normal", discoveredAt: r.created_at, assignedTo: assigned.get(`refund:${r.id}`) ?? null,
      nextAction: r.status === "recommended" ? "Owner: approve or deny under the refund policy." : "Review the request, add notes, and recommend a decision.",
      status: r.status.replace(/_/g, " "), href: `/staff/refunds/${r.id}`,
    });
  }
  return items.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.discoveredAt.localeCompare(b.discoveredAt));
}

export class FinanceWorkError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}

const KEY = /^(finding:rcf_[0-9a-f]+|subscription:[A-Za-z0-9_]+|dispute:[A-Za-z0-9_]+|refund:[A-Za-z0-9_]+|job:cost_import)$/;

/** Who is handling an issue. Assignable to staff who may see financial issues. Audited; never changes the issue. */
export async function assignFinanceWork(db: Db, actor: Actor, byUserId: string, itemKey: string, toUserId: string | null): Promise<void> {
  if (!can(actor, "finance.read")) throw new FinanceWorkError("Only staff with finance access can assign financial issues.", 403);
  if (!KEY.test(itemKey)) throw new FinanceWorkError("Unknown issue.", 404);
  // Only an issue that is open right now can be assigned (a resolved one has already left My Work).
  if (toUserId && !(await financeWorkItems(db, actor)).some((i) => i.key === itemKey)) throw new FinanceWorkError("This issue is no longer open.");
  if (toUserId) {
    // Only someone who can SEE the issue may be given it: refund requests go to refund reviewers, everything else to
    // staff with finance access.
    const roles = assigneeRoles(itemKey);
    const ok = await db.prepare(`SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = ? AND o.kind = 'internal' AND u.disabled_at IS NULL AND m.role_id IN (${roles.map(() => "?").join(",")})`).bind(toUserId, ...roles).first();
    if (!ok) throw new FinanceWorkError(itemKey.startsWith("refund:") ? "Choose an active staff member who reviews refunds." : "Choose an active staff member with finance access.");
    await db.prepare(`INSERT INTO finance_work_assignments (item_key, user_id, assigned_by, assigned_at) VALUES (?,?,?,?)
      ON CONFLICT(item_key) DO UPDATE SET user_id = excluded.user_id, assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at`).bind(itemKey, toUserId, byUserId, nowIso()).run();
  } else {
    await db.prepare(`DELETE FROM finance_work_assignments WHERE item_key = ?`).bind(itemKey).run();
  }
  await audit(db, { actorUserId: byUserId, action: "finance_work.assigned", subjectType: "finance_issue", subjectId: itemKey, details: { to: toUserId } });
}

/** Staff roles that may see (and so be given) an issue: refund reviewers for refunds, finance access otherwise. */
export function assigneeRoles(itemKey: string): string[] {
  const { ROLE_PERMISSIONS, STAFF_ROLES } = AUTHZ;
  const perm = itemKey.startsWith("refund:") ? "refund.review" : "finance.read";
  return STAFF_ROLES.filter((r) => ROLE_PERMISSIONS[r].has(perm as never) || (perm === "refund.review" && ROLE_PERMISSIONS[r].has("finance.read" as never)));
}

/** People an issue can be assigned to. */
export async function financeAssignees(db: Db, itemKey: string): Promise<{ id: string; display_name: string }[]> {
  const roles = assigneeRoles(itemKey);
  return (await db.prepare(`SELECT DISTINCT u.id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id
      WHERE o.kind = 'internal' AND u.disabled_at IS NULL AND m.role_id IN (${roles.map(() => "?").join(",")}) ORDER BY u.display_name`).bind(...roles).all<{ id: string; display_name: string }>()).results;
}
