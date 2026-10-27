// Stripe-side reconciliation (PAY-009, §22 "Reconciliation"). READ-ONLY against Stripe and READ-ONLY
// against local payment state: the job lists recent Checkout Sessions with GET /v1/checkout/sessions
// (https://docs.stripe.com/api/checkout/sessions/list) and compares them with local invoices, payments
// and subscriptions. Every discrepancy becomes a reconciliation_findings row for a human to review.
// Nothing here ever marks an invoice or payment paid: verified webhooks stay authoritative (§22). A
// discrepancy that disappears (for example the webhook arrives later) is marked "cleared" automatically.
import type { Env } from "../app/context.ts";
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { StripeReadOnly, LivePaymentsNotAuthorized, type StripeCheckoutSessionSummary, type StripeBalanceTransaction } from "../adapters/payments.ts";
import { audit } from "./security.ts";
import { toCsv } from "./finance.ts";

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
  // ledger scope (Stripe Invoices, balance transactions, payouts)
  stripe_invoice_missing_locally: "Stripe invoice with no matching local invoice",
  stripe_invoice_amount_mismatch: "Stripe invoice amount differs from the local invoice",
  stripe_invoice_status_mismatch: "Stripe invoice status disagrees with the local invoice",
  local_stripe_invoice_not_found: "Local invoice points to a Stripe invoice that Stripe did not list",
  balance_txn_missing_locally: "Stripe balance transaction with no local payment",
  balance_txn_amount_mismatch: "Stripe balance transaction amount differs from the local record",
  fee_mismatch: "Stripe fee differs from the fee recorded locally",
  refund_missing_locally: "Refund in Stripe with no local refund record",
  payout_amount_mismatch: "Payout amount does not match its transactions",
  payout_failed: "Stripe payout failed",
} as const;
export type FindingKind = keyof typeof FINDING_KINDS;
export type ReconcileScope = "checkout" | "ledger";
export const CHECKOUT_KINDS: FindingKind[] = ["paid_in_stripe_unpaid_locally", "unknown_local_invoice", "amount_mismatch", "payment_missing_locally", "subscription_missing_locally", "paid_locally_not_in_stripe"];
export const LEDGER_KINDS = (Object.keys(FINDING_KINDS) as FindingKind[]).filter((k) => !CHECKOUT_KINDS.includes(k));

/** Typed outcomes a reviewer records when closing a finding (PAY-009 resolution workflow). */
export const RESOLUTIONS = {
  no_action_needed: "No action needed (explained / test data)",
  corrected_locally: "Corrected the local record",
  corrected_in_stripe: "Corrected in Stripe",
  refunded_or_credited: "Refunded or credited the customer",
  escalated_to_accountant: "Escalated to the accountant",
} as const;
export type Resolution = keyof typeof RESOLUTIONS;

interface Finding { kind: FindingKind; key: string; stripeObjectId: string | null; invoiceId?: string | null; paymentId?: string | null; organizationId?: string | null; stripeAmount?: number | null; localAmount?: number | null; detail: string }

export interface ReconcileResult { status: "ok" | "skipped" | "failed"; detail: string; checked: number; opened: number; cleared: number; runId: string }

async function startRun(db: Db, scope: ReconcileScope = "checkout"): Promise<string> {
  const id = newId("rcn");
  await db.prepare(`INSERT INTO reconciliation_runs (id, started_at, status, scope) VALUES (?,?, 'running', ?)`).bind(id, nowIso(), scope).run();
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
      // Payments collected through a Stripe Invoice (PAY-006) have no Checkout Session; the ledger scope compares them.
      const local = (await db.prepare(`SELECT id, invoice_id, organization_id, amount_cents, stripe_payment_intent_id FROM payments
          WHERE stripe_payment_intent_id IS NOT NULL AND status IN ('succeeded','partially_refunded','refunded','disputed') AND created_at >= ?
            AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = payments.invoice_id AND i.stripe_invoice_id IS NOT NULL)`).bind(fromIso)
        .all<{ id: string; invoice_id: string | null; organization_id: string; amount_cents: number; stripe_payment_intent_id: string }>()).results;
      for (const p of local) {
        if (paidPis.has(p.stripe_payment_intent_id)) continue;
        findings.push({ kind: "paid_locally_not_in_stripe", key: p.id, stripeObjectId: p.stripe_payment_intent_id, invoiceId: p.invoice_id, paymentId: p.id, organizationId: p.organization_id, localAmount: p.amount_cents,
          detail: `Payment ${p.id} (Stripe ${p.stripe_payment_intent_id}) is recorded locally, but no paid Checkout Session in Stripe references it in the last ${RECONCILE_WINDOW_DAYS} days.` });
      }
    }
    const opened = await storeFindings(db, runId, findings, "checkout");
    const cleared = truncated ? 0 : await autoClear(db, runId, "checkout");
    const detail = `${sessions.length} Stripe checkout sessions checked; ${findings.length} discrepancies (${opened} new), ${cleared} cleared${truncated ? `; listing truncated at ${MAX_PAGES} pages, reverse check and auto-clear skipped` : ""}`;
    await finishRun(db, runId, "ok", detail, sessions.length, opened);
    return { status: "ok", detail, checked: sessions.length, opened, cleared, runId };
  } catch (e) {
    const detail = `failed: ${(e as Error).message.slice(0, 300)}`;
    await finishRun(db, runId, "failed", detail, 0, 0);
    throw new Error(detail);
  }
}

/** Open findings of this scope that the run did not see again are marked cleared. */
async function autoClear(db: Db, runId: string, scope: ReconcileScope): Promise<number> {
  const res = await db.prepare(`UPDATE reconciliation_findings SET status = 'cleared' WHERE status = 'open' AND scope = ? AND (last_run_id IS NULL OR last_run_id <> ?)`).bind(scope, runId).run();
  return res.meta.changes;
}

async function storeFindings(db: Db, runId: string, findings: Finding[], scope: ReconcileScope): Promise<number> {
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
    await db.prepare(`INSERT INTO reconciliation_findings (id, fingerprint, kind, scope, stripe_object_id, invoice_id, payment_id, organization_id, stripe_amount_cents, local_amount_cents, detail, status, first_seen_at, last_seen_at, last_run_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, 'open', ?, ?, ?)`)
      .bind(id, fp, f.kind, scope, f.stripeObjectId, f.invoiceId ?? null, f.paymentId ?? null, f.organizationId ?? null, f.stripeAmount ?? null, f.localAmount ?? null, f.detail.slice(0, 1000), at, at, runId).run();
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

/**
 * Human review. Records a typed resolution and a note; it changes nothing in invoices or payments
 * (corrections are made through the normal, separately audited workflows or in Stripe).
 */
export async function resolveFinding(db: Db, id: string, userId: string, note: string, resolution: string = "no_action_needed"): Promise<void> {
  const n = note.trim();
  if (n.length < 5 || n.length > 1000) throw new FindingError("Describe what you checked and what was done (5–1,000 characters).");
  if (!(resolution in RESOLUTIONS)) throw new FindingError("Choose how the finding was resolved.");
  const row = await db.prepare(`SELECT organization_id, kind FROM reconciliation_findings WHERE id = ?`).bind(id).first<{ organization_id: string | null; kind: string }>();
  const res = await db.prepare(`UPDATE reconciliation_findings SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution_note = ?, resolution = ? WHERE id = ? AND status IN ('open','cleared')`)
    .bind(userId, nowIso(), n, resolution, id).run();
  if (res.meta.changes !== 1) throw new FindingError("That finding does not exist or is already resolved.");
  await audit(db, { actorUserId: userId, action: "reconciliation.finding_resolved", subjectType: "reconciliation_finding", subjectId: id, organizationId: row?.organization_id ?? null, details: { note: n, resolution, kind: row?.kind } });
}

/** Re-opens a resolved finding (for example when the recorded fix turned out to be wrong). Audited. */
export async function reopenFinding(db: Db, id: string, userId: string, note: string): Promise<void> {
  const n = note.trim();
  if (n.length < 5 || n.length > 1000) throw new FindingError("Say why the finding is being re-opened (5–1,000 characters).");
  const row = await db.prepare(`SELECT organization_id, resolution, resolution_note FROM reconciliation_findings WHERE id = ? AND status = 'resolved'`).bind(id).first<{ organization_id: string | null; resolution: string | null; resolution_note: string | null }>();
  if (!row) throw new FindingError("Only a resolved finding can be re-opened.");
  const res = await db.prepare(`UPDATE reconciliation_findings SET status = 'open', resolved_by = NULL, resolved_at = NULL, resolution = NULL, resolution_note = NULL, reopened_count = reopened_count + 1 WHERE id = ? AND status = 'resolved'`).bind(id).run();
  if (res.meta.changes !== 1) throw new FindingError("Only a resolved finding can be re-opened.");
  await audit(db, { actorUserId: userId, action: "reconciliation.finding_reopened", subjectType: "reconciliation_finding", subjectId: id, organizationId: row.organization_id, details: { note: n, previousResolution: row.resolution, previousNote: row.resolution_note } });
}

export interface FindingRow { id: string; kind: FindingKind; scope: ReconcileScope; stripe_object_id: string | null; invoice_id: string | null; payment_id: string | null; organization_id: string | null; org_name: string | null; stripe_amount_cents: number | null; local_amount_cents: number | null; detail: string; status: string; first_seen_at: string; last_seen_at: string; resolved_by_name: string | null; resolved_at: string | null; resolution: Resolution | null; resolution_note: string | null; reopened_count: number }
export interface FindingFilter { status?: string; kind?: string; scope?: string; q?: string }

function findingWhere(f: FindingFilter): { sql: string; binds: unknown[] } {
  const conds: string[] = [], binds: unknown[] = [];
  if (f.status) { conds.push(`r.status = ?`); binds.push(f.status); }
  if (f.kind && f.kind in FINDING_KINDS) { conds.push(`r.kind = ?`); binds.push(f.kind); }
  if (f.scope === "checkout" || f.scope === "ledger") { conds.push(`r.scope = ?`); binds.push(f.scope); }
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(`(r.stripe_object_id LIKE ? ESCAPE '\\' OR r.invoice_id LIKE ? ESCAPE '\\' OR r.payment_id LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\' OR r.detail LIKE ? ESCAPE '\\')`);
    binds.push(like, like, like, like, like);
  }
  return { sql: conds.length ? `WHERE ${conds.join(" AND ")}` : "", binds };
}

export async function listFindings(db: Db, f: FindingFilter & { limit: number; offset: number }): Promise<FindingRow[]> {
  const w = findingWhere(f);
  return (await db.prepare(`SELECT r.*, o.name AS org_name, u.display_name AS resolved_by_name FROM reconciliation_findings r LEFT JOIN organizations o ON o.id = r.organization_id LEFT JOIN users u ON u.id = r.resolved_by
      ${w.sql} ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'cleared' THEN 1 ELSE 2 END, r.last_seen_at DESC LIMIT ? OFFSET ?`).bind(...w.binds, f.limit + 1, f.offset).all<FindingRow>()).results;
}

export async function findingCounts(db: Db) {
  return (await db.prepare(`SELECT scope, status, COUNT(*) AS n FROM reconciliation_findings GROUP BY scope, status`).all<{ scope: ReconcileScope; status: string; n: number }>()).results;
}

export async function recentRuns(db: Db, limit = 10) {
  return (await db.prepare(`SELECT id, scope, started_at, finished_at, status, detail, objects_checked, findings_opened FROM reconciliation_runs ORDER BY started_at DESC, rowid DESC LIMIT ?`).bind(limit)
    .all<{ id: string; scope: ReconcileScope; started_at: string; finished_at: string | null; status: string; detail: string | null; objects_checked: number; findings_opened: number }>()).results;
}

export interface PayoutRow { id: string; amount_cents: number; currency: string; status: string; arrival_date: string | null; stripe_created: string; txn_count: number; matched_count: number; stripe_net_cents: number | null; local_expected_cents: number | null; state: string; detail: string | null; last_seen_at: string }
export async function listPayouts(db: Db, limit: number, offset: number): Promise<PayoutRow[]> {
  return (await db.prepare(`SELECT * FROM stripe_payouts ORDER BY stripe_created DESC LIMIT ? OFFSET ?`).bind(limit + 1, offset).all<PayoutRow>()).results;
}

// ───────────── Ledger scope: Stripe Invoices, balance transactions, payouts ─────────────
// GET /v1/invoices, GET /v1/balance_transactions?expand[]=data.source, GET /v1/payouts and
// GET /v1/balance_transactions?payout=po_… — all read-only. Findings never change payment state.

const LOCAL_PAID = `('succeeded','partially_refunded','refunded','disputed')`;
type Src = Exclude<StripeBalanceTransaction["source"], string | null>;
const srcObj = (bt: StripeBalanceTransaction): Src | null => (bt.source && typeof bt.source === "object" ? bt.source : null);
const srcId = (bt: StripeBalanceTransaction): string | null => (typeof bt.source === "string" ? bt.source : bt.source?.id ?? null);
const CHARGE_TYPES = new Set(["charge", "payment"]);
const REFUND_TYPES = new Set(["refund", "payment_refund"]);

async function listAll<T extends { id: string; livemode?: boolean }>(page: (after?: string) => Promise<{ data: T[]; has_more: boolean }>): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let after: string | undefined;
  for (let p = 0; ; p++) {
    if (p === MAX_PAGES) return { items, truncated: true };
    const r = await page(after);
    for (const x of r.data) if (x.livemode === true) throw new LivePaymentsNotAuthorized("Stripe returned a live-mode object");
    items.push(...r.data);
    if (!r.has_more || !r.data.length) return { items, truncated: false };
    after = r.data[r.data.length - 1].id;
  }
}

interface LocalPayment { id: string; invoice_id: string | null; organization_id: string; amount_cents: number; fee_cents: number | null; stripe_payment_intent_id: string | null; stripe_charge_id: string | null }
async function paymentForCharge(db: Db, src: Src | null, chargeId: string | null): Promise<LocalPayment | null> {
  const pi = typeof src?.payment_intent === "string" ? src.payment_intent : null;
  const sel = `SELECT id, invoice_id, organization_id, amount_cents, fee_cents, stripe_payment_intent_id, stripe_charge_id FROM payments`;
  if (pi) { const p = await db.prepare(`${sel} WHERE stripe_payment_intent_id = ?`).bind(pi).first<LocalPayment>(); if (p) return p; }
  return chargeId ? db.prepare(`${sel} WHERE stripe_charge_id = ?`).bind(chargeId).first<LocalPayment>() : null;
}

export async function runStripeLedgerReconciliation(db: Db, env: Env, now = Date.now()): Promise<ReconcileResult> {
  const runId = await startRun(db, "ledger");
  const reader = stripeReader(env);
  if (!reader.ok) {
    const detail = `skipped: ${reader.reason}`;
    await finishRun(db, runId, "skipped", detail, 0, 0);
    return { status: "skipped", detail, checked: 0, opened: 0, cleared: 0, runId };
  }
  const stripe = reader.client;
  try {
    const nowS = Math.floor(now / 1000);
    const since = nowS - RECONCILE_WINDOW_DAYS * 86400;
    const findings: Finding[] = [];
    let checked = 0;

    // A. Stripe Invoices (non-Checkout) vs local invoices.
    const invs = await listAll((after) => stripe.listInvoices({ createdGte: since, startingAfter: after }));
    checked += invs.items.length;
    const seen = new Set<string>();
    for (const si of invs.items) {
      seen.add(si.id);
      if (si.subscription) continue; // maintenance subscription invoices: compared through subscriptions (checkout scope)
      if (si.status === "draft") continue;
      const tagged = si.metadata?.crestmont_invoice_id ?? null;
      const local = await db.prepare(`SELECT id, organization_id, amount_cents, status, stripe_invoice_id FROM invoices WHERE ${tagged ? "id = ?" : "stripe_invoice_id = ?"}`).bind(tagged ?? si.id)
        .first<{ id: string; organization_id: string; amount_cents: number; status: string; stripe_invoice_id: string | null }>();
      if (!local || (local.stripe_invoice_id && local.stripe_invoice_id !== si.id)) {
        if (si.status === "void") continue;
        findings.push({ kind: "stripe_invoice_missing_locally", key: si.id, stripeObjectId: si.id, invoiceId: local?.id ?? tagged, organizationId: local?.organization_id ?? null, stripeAmount: si.total,
          detail: local ? `Stripe invoice ${si.id} (${si.status}) is tagged for local invoice ${local.id}, which records a different Stripe invoice (${local.stripe_invoice_id}). Possible duplicate billing: void the extra invoice in Stripe if it is not intended.`
            : `Stripe invoice ${si.id} (${si.status}, ${si.total} cents) has no matching local invoice${tagged ? ` (tagged ${tagged})` : ""}.` });
        continue;
      }
      if ((si.status === "open" || si.status === "paid") && si.total !== local.amount_cents) {
        findings.push({ kind: "stripe_invoice_amount_mismatch", key: si.id, stripeObjectId: si.id, invoiceId: local.id, organizationId: local.organization_id, stripeAmount: si.total, localAmount: local.amount_cents,
          detail: `Stripe invoice ${si.id} totals ${si.total} cents; local invoice ${local.id} is for ${local.amount_cents} cents.` });
      }
      const paidAt = si.status_transitions?.paid_at ?? null;
      if (si.status === "paid" && local.status !== "paid" && (!paidAt || nowS - paidAt > WEBHOOK_GRACE_SECONDS)) {
        findings.push({ kind: "stripe_invoice_status_mismatch", key: `${si.id}:paid`, stripeObjectId: si.id, invoiceId: local.id, organizationId: local.organization_id, stripeAmount: si.amount_paid, localAmount: local.amount_cents,
          detail: `Stripe invoice ${si.id} is paid but local invoice ${local.id} is ${local.status}. Check the invoice.paid webhook in the event log; do not mark the invoice paid by hand without confirming in Stripe.` });
      } else if (local.status === "paid" && si.status !== "paid") {
        findings.push({ kind: "stripe_invoice_status_mismatch", key: `${si.id}:local_paid`, stripeObjectId: si.id, invoiceId: local.id, organizationId: local.organization_id, stripeAmount: si.amount_due, localAmount: local.amount_cents,
          detail: `Local invoice ${local.id} is paid but Stripe invoice ${si.id} is ${si.status}. If it was paid another way, void the Stripe invoice so the customer is not asked to pay twice.` });
      } else if (local.status === "open" && (si.status === "void" || si.status === "uncollectible")) {
        findings.push({ kind: "stripe_invoice_status_mismatch", key: `${si.id}:${si.status}`, stripeObjectId: si.id, invoiceId: local.id, organizationId: local.organization_id, stripeAmount: si.total, localAmount: local.amount_cents,
          detail: `Stripe invoice ${si.id} is ${si.status} but local invoice ${local.id} is still open; the customer cannot pay the Stripe link.` });
      }
    }
    if (!invs.truncated) {
      const fromIso = new Date((since + 86400) * 1000).toISOString();
      const locals = (await db.prepare(`SELECT id, organization_id, amount_cents, stripe_invoice_id FROM invoices WHERE stripe_invoice_id IS NOT NULL AND COALESCE(stripe_invoice_synced_at, created_at) >= ?`).bind(fromIso)
        .all<{ id: string; organization_id: string; amount_cents: number; stripe_invoice_id: string }>()).results;
      for (const l of locals) {
        if (seen.has(l.stripe_invoice_id)) continue;
        findings.push({ kind: "local_stripe_invoice_not_found", key: l.stripe_invoice_id, stripeObjectId: l.stripe_invoice_id, invoiceId: l.id, organizationId: l.organization_id, localAmount: l.amount_cents,
          detail: `Local invoice ${l.id} records Stripe invoice ${l.stripe_invoice_id}, but Stripe did not list it for the last ${RECONCILE_WINDOW_DAYS} days.` });
      }
    }

    // B. Balance transactions (charges and refunds) vs payments and refunds.
    const bts = await listAll((after) => stripe.listBalanceTransactions({ createdGte: since, startingAfter: after }));
    checked += bts.items.length;
    for (const bt of bts.items) {
      if (nowS - bt.created <= WEBHOOK_GRACE_SECONDS) continue;
      const src = srcObj(bt), sid = srcId(bt);
      if (CHARGE_TYPES.has(bt.type)) {
        const pay = await paymentForCharge(db, src, sid);
        if (!pay) {
          findings.push({ kind: "balance_txn_missing_locally", key: bt.id, stripeObjectId: bt.id, stripeAmount: bt.amount,
            detail: `Stripe ${bt.type} ${sid ?? bt.id} (${bt.amount} ${bt.currency}) in balance transaction ${bt.id} has no local payment${src?.payment_intent ? ` for payment ${src.payment_intent}` : ""}.` });
          continue;
        }
        if (bt.currency !== "usd" || bt.amount !== pay.amount_cents) {
          findings.push({ kind: "balance_txn_amount_mismatch", key: bt.id, stripeObjectId: bt.id, paymentId: pay.id, invoiceId: pay.invoice_id, organizationId: pay.organization_id, stripeAmount: bt.amount, localAmount: pay.amount_cents,
            detail: `Balance transaction ${bt.id} is ${bt.amount} ${bt.currency}; local payment ${pay.id} is ${pay.amount_cents} usd.` });
        }
        if (pay.fee_cents !== null && pay.fee_cents !== bt.fee) {
          findings.push({ kind: "fee_mismatch", key: bt.id, stripeObjectId: bt.id, paymentId: pay.id, invoiceId: pay.invoice_id, organizationId: pay.organization_id, stripeAmount: bt.fee, localAmount: pay.fee_cents,
            detail: `Stripe charged a fee of ${bt.fee} cents on ${bt.id}; payment ${pay.id} records ${pay.fee_cents} cents.` });
        }
      } else if (REFUND_TYPES.has(bt.type)) {
        const ref = sid ? await db.prepare(`SELECT f.id, f.amount_cents, f.organization_id, f.payment_id FROM refunds f WHERE f.stripe_refund_id = ?`).bind(sid).first<{ id: string; amount_cents: number; organization_id: string; payment_id: string }>() : null;
        if (!ref) {
          findings.push({ kind: "refund_missing_locally", key: bt.id, stripeObjectId: sid ?? bt.id, stripeAmount: -bt.amount,
            detail: `Stripe refund ${sid ?? "(unknown id)"} for ${-bt.amount} cents (balance transaction ${bt.id}) has no local refund record. Refunds must go through the refund workflow; record what happened.` });
        } else if (-bt.amount !== ref.amount_cents) {
          findings.push({ kind: "balance_txn_amount_mismatch", key: bt.id, stripeObjectId: bt.id, paymentId: ref.payment_id, organizationId: ref.organization_id, stripeAmount: -bt.amount, localAmount: ref.amount_cents,
            detail: `Stripe refunded ${-bt.amount} cents in ${bt.id}; local refund ${ref.id} is for ${ref.amount_cents} cents.` });
        }
      }
    }

    // C. Payouts: each payout's balance transactions vs its amount, and vs local records.
    const pos = await listAll((after) => stripe.listPayouts(since, after));
    checked += pos.items.length;
    const at = nowIso();
    for (const po of pos.items) {
      let state: "matched" | "mismatch" | "incomplete" | "failed" | "pending";
      let net: number | null = null, expected: number | null = null, txnCount = 0, matched = 0;
      const notes: string[] = [];
      if (po.status === "failed" || po.status === "canceled") {
        state = "failed";
        if (po.status === "failed") findings.push({ kind: "payout_failed", key: po.id, stripeObjectId: po.id, stripeAmount: po.amount, detail: `Payout ${po.id} for ${po.amount} ${po.currency} failed${po.failure_message ? `: ${po.failure_message}` : ""}. Check the bank account in Stripe.` });
      } else {
        const txns = await listAll((after) => stripe.listBalanceTransactions({ payout: po.id, startingAfter: after }));
        const members = txns.items.filter((t) => t.type !== "payout");
        txnCount = members.length;
        net = members.reduce((s, t) => s + t.net, 0);
        expected = 0;
        for (const t of members) {
          const src = srcObj(t), sid = srcId(t);
          if (CHARGE_TYPES.has(t.type)) {
            const pay = await paymentForCharge(db, src, sid);
            if (pay && pay.fee_cents !== null && expected !== null) { expected += pay.amount_cents - pay.fee_cents; matched++; }
            else { if (pay) matched++; expected = null; notes.push(pay ? `fee unknown for payment ${pay.id}` : `no local payment for ${sid ?? t.id}`); }
          } else if (REFUND_TYPES.has(t.type)) {
            const ref = sid ? await db.prepare(`SELECT amount_cents FROM refunds WHERE stripe_refund_id = ?`).bind(sid).first<{ amount_cents: number }>() : null;
            if (ref && expected !== null) { expected -= ref.amount_cents; matched++; } else { if (ref) matched++; expected = null; notes.push(ref ? "" : `no local refund for ${sid ?? t.id}`); }
          } else { expected = null; notes.push(`${t.type} ${t.id} has no local counterpart`); }
        }
        if (txns.truncated) { expected = null; notes.push("transaction listing truncated"); }
        if (net !== po.amount && !txns.truncated) {
          findings.push({ kind: "payout_amount_mismatch", key: `${po.id}:stripe`, stripeObjectId: po.id, stripeAmount: po.amount, localAmount: net,
            detail: `Payout ${po.id} is ${po.amount} cents but its ${txnCount} balance transactions net to ${net} cents in Stripe's own listing.` });
        }
        if (expected !== null && expected !== po.amount) {
          findings.push({ kind: "payout_amount_mismatch", key: `${po.id}:local`, stripeObjectId: po.id, stripeAmount: po.amount, localAmount: expected,
            detail: `Payout ${po.id} is ${po.amount} cents; local payments − fees − refunds for its ${txnCount} transactions come to ${expected} cents.` });
        }
        state = po.status !== "paid" ? "pending" : expected === null ? "incomplete" : expected === po.amount && net === po.amount ? "matched" : "mismatch";
      }
      const detail = notes.filter(Boolean).slice(0, 5).join("; ") || null;
      await db.prepare(`INSERT INTO stripe_payouts (id, amount_cents, currency, status, arrival_date, stripe_created, txn_count, matched_count, stripe_net_cents, local_expected_cents, state, detail, last_run_id, first_seen_at, last_seen_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET amount_cents = excluded.amount_cents, status = excluded.status, arrival_date = excluded.arrival_date, txn_count = excluded.txn_count,
          matched_count = excluded.matched_count, stripe_net_cents = excluded.stripe_net_cents, local_expected_cents = excluded.local_expected_cents, state = excluded.state, detail = excluded.detail, last_run_id = excluded.last_run_id, last_seen_at = excluded.last_seen_at`)
        .bind(po.id, po.amount, po.currency, po.status, po.arrival_date ? new Date(po.arrival_date * 1000).toISOString() : null, new Date(po.created * 1000).toISOString(), txnCount, matched, net, expected, state, detail, runId, at, at).run();
    }

    const truncated = invs.truncated || bts.truncated || pos.truncated;
    const opened = await storeFindings(db, runId, findings, "ledger");
    const cleared = truncated ? 0 : await autoClear(db, runId, "ledger");
    const detail = `${invs.items.length} Stripe invoices, ${bts.items.length} balance transactions, ${pos.items.length} payouts checked; ${findings.length} discrepancies (${opened} new), ${cleared} cleared${truncated ? `; a listing was truncated at ${MAX_PAGES} pages, reverse checks and auto-clear skipped` : ""}`;
    await finishRun(db, runId, "ok", detail, checked, opened);
    return { status: "ok", detail, checked, opened, cleared, runId };
  } catch (e) {
    const detail = `failed: ${(e as Error).message.slice(0, 300)}`;
    await finishRun(db, runId, "failed", detail, 0, 0);
    throw new Error(detail);
  }
}

/** Findings as CSV for the accountant (same formula-injection guard as other exports). */
export async function findingsCsv(db: Db, f: FindingFilter): Promise<string> {
  const rows = await listFindings(db, { ...f, limit: 10_000, offset: 0 });
  return toCsv(["finding_id", "scope", "kind", "description", "status", "customer", "stripe_object", "invoice_id", "payment_id", "stripe_amount_cents", "local_amount_cents", "first_seen", "last_seen", "resolution", "resolved_by", "resolved_at", "note", "detail"],
    rows.slice(0, 10_000).map((r) => [r.id, r.scope, r.kind, FINDING_KINDS[r.kind] ?? r.kind, r.status, r.org_name, r.stripe_object_id, r.invoice_id, r.payment_id, r.stripe_amount_cents, r.local_amount_cents, r.first_seen_at, r.last_seen_at, r.resolution, r.resolved_by_name, r.resolved_at, r.resolution_note, r.detail]));
}
