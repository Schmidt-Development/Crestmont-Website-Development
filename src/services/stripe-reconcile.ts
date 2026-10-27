// Stripe-side reconciliation (PAY-009, §22 "Reconciliation"). READ-ONLY against Stripe and READ-ONLY
// against local payment state: the job lists recent Checkout Sessions with GET /v1/checkout/sessions
// (https://docs.stripe.com/api/checkout/sessions/list) and compares them with local invoices, payments
// and subscriptions. Every discrepancy becomes a reconciliation_findings row for a human to review.
// Nothing here ever marks an invoice or payment paid: verified webhooks stay authoritative (§22). A
// discrepancy that disappears (for example the webhook arrives later) is marked "cleared" automatically.
import type { Env } from "../app/context.ts";
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { StripeReadOnly, LivePaymentsNotAuthorized, type StripeCheckoutSessionSummary } from "../adapters/payments.ts";
import { audit } from "./security.ts";

export const RECONCILE_WINDOW_DAYS = 30;
/** Sessions paid less than this long ago are skipped: their webhook may still be in flight. */
export const WEBHOOK_GRACE_SECONDS = 60 * 60;
const MAX_PAGES = 5;

export type StripeReader = { ok: true; client: StripeReadOnly } | { ok: false; reason: string };

/** Stripe read access when payments are configured with a test-mode key; otherwise why not. */
export function stripeReader(env: Env): StripeReader {
  if (!env.STRIPE_SECRET_KEY) return { ok: false, reason: "payments not configured" };
  try {
    return { ok: true, client: new StripeReadOnly(env.STRIPE_SECRET_KEY, env.overrides?.fetch ?? fetch) };
  } catch (e) {
    if (e instanceof LivePaymentsNotAuthorized) return { ok: false, reason: "a non-test Stripe key is set; live payments are not authorised (PAY-010)" };
    throw e;
  }
}

export const FINDING_KINDS = {
  paid_in_stripe_unpaid_locally: "Paid in Stripe, invoice not paid locally",
  unknown_local_invoice: "Paid in Stripe, no matching local invoice",
  amount_mismatch: "Amount differs between Stripe and the invoice",
  payment_missing_locally: "Invoice paid locally but no payment row for this Stripe payment",
  subscription_missing_locally: "Subscription started in Stripe, not recorded locally",
  paid_locally_not_in_stripe: "Recorded as paid locally, no paid Stripe checkout found",
} as const;
export type FindingKind = keyof typeof FINDING_KINDS;

interface Finding { kind: FindingKind; key: string; stripeObjectId: string | null; invoiceId?: string | null; paymentId?: string | null; organizationId?: string | null; stripeAmount?: number | null; localAmount?: number | null; detail: string }

export interface ReconcileResult { status: "ok" | "skipped" | "failed"; detail: string; checked: number; opened: number; cleared: number; runId: string }

async function startRun(db: Db): Promise<string> {
  const id = newId("rcn");
  await db.prepare(`INSERT INTO reconciliation_runs (id, started_at, status) VALUES (?,?, 'running')`).bind(id, nowIso()).run();
  return id;
}
async function finishRun(db: Db, id: string, status: ReconcileResult["status"], detail: string, checked: number, opened: number) {
  await db.prepare(`UPDATE reconciliation_runs SET finished_at = ?, status = ?, detail = ?, objects_checked = ?, findings_opened = ? WHERE id = ?`)
    .bind(nowIso(), status, detail.slice(0, 1000), checked, opened, id).run();
}

export async function runStripeReconciliation(db: Db, env: Env, now = Date.now()): Promise<ReconcileResult> {
  const runId = await startRun(db);
  const reader = stripeReader(env);
  if (!reader.ok) {
    const detail = `skipped: ${reader.reason}`;
    await finishRun(db, runId, "skipped", detail, 0, 0);
    return { status: "skipped", detail, checked: 0, opened: 0, cleared: 0, runId };
  }
  try {
    const nowS = Math.floor(now / 1000);
    const since = nowS - RECONCILE_WINDOW_DAYS * 86400;
    const sessions: StripeCheckoutSessionSummary[] = [];
    let after: string | undefined, truncated = false;
    for (let page = 0; ; page++) {
      if (page === MAX_PAGES) { truncated = true; break; }
      const r = await reader.client.listCheckoutSessions(since, after);
      sessions.push(...r.data);
      if (!r.has_more || !r.data.length) break;
      after = r.data[r.data.length - 1].id;
    }
    const findings: Finding[] = [];
    const paidPis = new Set<string>();
    for (const cs of sessions) {
      if (cs.livemode === true) throw new LivePaymentsNotAuthorized("Stripe returned a live-mode session");
      const settled = nowS - cs.created > WEBHOOK_GRACE_SECONDS;
      if (cs.mode === "payment" && cs.payment_status === "paid") {
        if (cs.payment_intent) paidPis.add(cs.payment_intent);
        if (!settled) continue;
        const invoiceId = cs.metadata?.invoice_id ?? null;
        const inv = invoiceId ? await db.prepare(`SELECT id, organization_id, amount_cents, status FROM invoices WHERE id = ?`).bind(invoiceId).first<{ id: string; organization_id: string; amount_cents: number; status: string }>() : null;
        if (!inv) {
          findings.push({ kind: "unknown_local_invoice", key: cs.id, stripeObjectId: cs.id, invoiceId, stripeAmount: cs.amount_total, detail: `Checkout session ${cs.id} is paid in Stripe${invoiceId ? ` for invoice ${invoiceId}, which does not exist locally` : " but carries no invoice_id metadata"}.` });
          continue;
        }
        if (cs.amount_total !== null && cs.amount_total !== inv.amount_cents) {
          findings.push({ kind: "amount_mismatch", key: cs.id, stripeObjectId: cs.id, invoiceId: inv.id, organizationId: inv.organization_id, stripeAmount: cs.amount_total, localAmount: inv.amount_cents, detail: `Stripe collected ${cs.amount_total} cents; invoice ${inv.id} is for ${inv.amount_cents} cents.` });
        }
        if (inv.status !== "paid") {
          const pending = await db.prepare(`SELECT id, status, last_error FROM stripe_events WHERE object_id = ? ORDER BY stripe_created DESC LIMIT 1`).bind(cs.id).first<{ id: string; status: string; last_error: string | null }>();
          findings.push({ kind: "paid_in_stripe_unpaid_locally", key: cs.id, stripeObjectId: cs.id, invoiceId: inv.id, organizationId: inv.organization_id, stripeAmount: cs.amount_total, localAmount: inv.amount_cents,
            detail: `Checkout session ${cs.id} is paid in Stripe but invoice ${inv.id} is ${inv.status} locally. ${pending ? `Stored webhook ${pending.id} is ${pending.status}${pending.last_error ? ` (${pending.last_error.slice(0, 200)})` : ""}.` : "No webhook for this session has been received."} Check the webhook log; do not mark the invoice paid by hand without confirming in Stripe.` });
        } else if (cs.payment_intent) {
          const pay = await db.prepare(`SELECT id FROM payments WHERE stripe_payment_intent_id = ?`).bind(cs.payment_intent).first<{ id: string }>();
          if (!pay) findings.push({ kind: "payment_missing_locally", key: cs.payment_intent, stripeObjectId: cs.payment_intent, invoiceId: inv.id, organizationId: inv.organization_id, stripeAmount: cs.amount_total, detail: `Invoice ${inv.id} is paid locally but no payment row references Stripe payment ${cs.payment_intent}.` });
        }
      } else if (cs.mode === "subscription" && cs.status === "complete" && cs.subscription && settled) {
        const sub = await db.prepare(`SELECT id FROM subscriptions WHERE stripe_subscription_id = ?`).bind(cs.subscription).first();
        if (!sub) findings.push({ kind: "subscription_missing_locally", key: cs.subscription, stripeObjectId: cs.subscription, organizationId: cs.metadata?.organization_id ?? null, stripeAmount: cs.amount_total, detail: `Stripe subscription ${cs.subscription} (session ${cs.id}) has no local subscription record.` });
      }
    }
    // Reverse direction: local captured payments in the fully covered part of the window (sessions
    // expire after 24 h, so payments in the first day could belong to sessions created before it).
    if (!truncated) {
      const fromIso = new Date((since + 86400) * 1000).toISOString();
      const local = (await db.prepare(`SELECT id, invoice_id, organization_id, amount_cents, stripe_payment_intent_id FROM payments
          WHERE stripe_payment_intent_id IS NOT NULL AND status IN ('succeeded','partially_refunded','refunded','disputed') AND created_at >= ?`).bind(fromIso)
        .all<{ id: string; invoice_id: string | null; organization_id: string; amount_cents: number; stripe_payment_intent_id: string }>()).results;
      for (const p of local) {
        if (paidPis.has(p.stripe_payment_intent_id)) continue;
        findings.push({ kind: "paid_locally_not_in_stripe", key: p.id, stripeObjectId: p.stripe_payment_intent_id, invoiceId: p.invoice_id, paymentId: p.id, organizationId: p.organization_id, localAmount: p.amount_cents,
          detail: `Payment ${p.id} (Stripe ${p.stripe_payment_intent_id}) is recorded locally, but no paid Checkout Session in Stripe references it in the last ${RECONCILE_WINDOW_DAYS} days.` });
      }
    }
    const opened = await storeFindings(db, runId, findings);
    let cleared = 0;
    if (!truncated) {
      const res = await db.prepare(`UPDATE reconciliation_findings SET status = 'cleared' WHERE status = 'open' AND (last_run_id IS NULL OR last_run_id <> ?)`).bind(runId).run();
      cleared = res.meta.changes;
    }
    const detail = `${sessions.length} Stripe checkout sessions checked; ${findings.length} discrepancies (${opened} new), ${cleared} cleared${truncated ? `; listing truncated at ${MAX_PAGES} pages, reverse check and auto-clear skipped` : ""}`;
    await finishRun(db, runId, "ok", detail, sessions.length, opened);
    return { status: "ok", detail, checked: sessions.length, opened, cleared, runId };
  } catch (e) {
    const detail = `failed: ${(e as Error).message.slice(0, 300)}`;
    await finishRun(db, runId, "failed", detail, 0, 0);
    throw new Error(detail);
  }
}

async function storeFindings(db: Db, runId: string, findings: Finding[]): Promise<number> {
  let opened = 0;
  const at = nowIso();
  for (const f of findings) {
    const fp = `${f.kind}:${f.key}`;
    const prev = await db.prepare(`SELECT id, status FROM reconciliation_findings WHERE fingerprint = ?`).bind(fp).first<{ id: string; status: string }>();
    if (prev) {
      // A human-resolved finding stays resolved; an auto-cleared one re-opens if it comes back.
      await db.prepare(`UPDATE reconciliation_findings SET last_seen_at = ?, last_run_id = ?, detail = ?, status = CASE WHEN status = 'cleared' THEN 'open' ELSE status END WHERE id = ?`)
        .bind(at, runId, f.detail, prev.id).run();
      continue;
    }
    const id = newId("rcf");
    await db.prepare(`INSERT INTO reconciliation_findings (id, fingerprint, kind, stripe_object_id, invoice_id, payment_id, organization_id, stripe_amount_cents, local_amount_cents, detail, status, first_seen_at, last_seen_at, last_run_id)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'open', ?, ?, ?)`)
      .bind(id, fp, f.kind, f.stripeObjectId, f.invoiceId ?? null, f.paymentId ?? null, f.organizationId ?? null, f.stripeAmount ?? null, f.localAmount ?? null, f.detail.slice(0, 1000), at, at, runId).run();
    opened++;
    const owners = (await db.prepare(`SELECT DISTINCT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id = 'owner' AND u.disabled_at IS NULL`).all<{ user_id: string }>()).results;
    for (const o of owners) {
      await db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) VALUES (?,?,'reconciliation_finding','reconciliation_finding',?,?,?)`)
        .bind(newId("ntf"), o.user_id, id, `Stripe reconciliation: ${FINDING_KINDS[f.kind]}. Review it under Finance → Reconciliation.`, at).run();
    }
    await audit(db, { actorKind: "system", action: "reconciliation.finding_opened", subjectType: "reconciliation_finding", subjectId: id, organizationId: f.organizationId ?? null, details: { kind: f.kind, stripe: f.stripeObjectId } });
  }
  return opened;
}

export class FindingError extends Error {}

/** Human review. Marks the finding reviewed with a note; it changes nothing in invoices or payments. */
export async function resolveFinding(db: Db, id: string, userId: string, note: string): Promise<void> {
  const n = note.trim();
  if (n.length < 5 || n.length > 1000) throw new FindingError("Describe what you checked and what was done (5–1,000 characters).");
  const res = await db.prepare(`UPDATE reconciliation_findings SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ? AND status IN ('open','cleared')`)
    .bind(userId, nowIso(), n, id).run();
  if (res.meta.changes !== 1) throw new FindingError("That finding does not exist or is already resolved.");
  await audit(db, { actorUserId: userId, action: "reconciliation.finding_resolved", subjectType: "reconciliation_finding", subjectId: id, details: { note: n } });
}

export interface FindingRow { id: string; kind: FindingKind; stripe_object_id: string | null; invoice_id: string | null; payment_id: string | null; org_name: string | null; stripe_amount_cents: number | null; local_amount_cents: number | null; detail: string; status: string; first_seen_at: string; last_seen_at: string; resolved_by_name: string | null; resolved_at: string | null; resolution_note: string | null }

export async function listFindings(db: Db, f: { status?: string; limit: number; offset: number }): Promise<FindingRow[]> {
  const where = f.status ? `WHERE r.status = ?` : "";
  return (await db.prepare(`SELECT r.*, o.name AS org_name, u.display_name AS resolved_by_name FROM reconciliation_findings r LEFT JOIN organizations o ON o.id = r.organization_id LEFT JOIN users u ON u.id = r.resolved_by
      ${where} ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'cleared' THEN 1 ELSE 2 END, r.last_seen_at DESC LIMIT ? OFFSET ?`).bind(...(f.status ? [f.status] : []), f.limit + 1, f.offset).all<FindingRow>()).results;
}

export async function recentRuns(db: Db, limit = 10) {
  return (await db.prepare(`SELECT id, started_at, finished_at, status, detail, objects_checked, findings_opened FROM reconciliation_runs ORDER BY started_at DESC, rowid DESC LIMIT ?`).bind(limit)
    .all<{ id: string; started_at: string; finished_at: string | null; status: string; detail: string | null; objects_checked: number; findings_opened: number }>()).results;
}
