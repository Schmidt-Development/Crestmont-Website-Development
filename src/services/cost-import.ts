// Automatic cost import (FIN-002, §57). Imports costs the platform already knows into project_costs so
// project profitability (finance.ts#projectProfitability) includes them. Idempotent through the
// cost_imports ledger: a source record is imported at most once. Unknown stays unknown (NULL), never 0.
//
// (a) AI usage — ai_jobs.cost_microusd → project_costs category 'ai_usage'.
//     input_ref convention (documented in docs/voice/RETELL-INTEGRATION.md §"Cost import"):
//       "project:<projectId>"  or  "project:<projectId>:<anything>"  → attributed to that project
//       "ticket:<ticketId>"    → attributed to the ticket's project when tickets.project_id is set
//       anything else (e.g. "lead:<id>")  → unattributed: a project_costs row with project_id NULL, so
//                                          company-wide AI spend is still recorded.
//     Only finished jobs are imported. A job whose provider was called but whose cost the platform could
//     not price (cost_microusd NULL) is imported with amount NULL ("Unknown"). Jobs that never reached a
//     provider (provider 'none') or failed without usage are recorded in the ledger as skipped.
//     Amounts: micro-USD → cents rounded to the nearest cent; the exact micro-USD is kept in the description.
// (b) Stripe fees — for captured payments with fee_cents NULL, when payments are configured, read
//     GET /v1/payment_intents/:id?expand[]=latest_charge.balance_transaction
//     (https://docs.stripe.com/expand/use-cases, https://docs.stripe.com/api/balance_transactions/object)
//     and store payments.fee_cents (only while still NULL). Every payment with a known fee is then
//     imported once as a 'payment_fee' cost on the invoice's project (no project → ledger only).
import type { Env } from "../app/context.ts";
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { stripeReader } from "./stripe-reconcile.ts";

export const AI_FINAL_STATUSES = ["succeeded", "failed", "awaiting_approval", "approved", "rejected"] as const;
const BATCH = 200;
const FEE_FETCH_LIMIT = 50;

/** Project id referenced by an ai_jobs.input_ref, or null when the job is not project work. */
export async function projectForInputRef(db: Db, inputRef: string): Promise<string | null> {
  const m = /^project:([A-Za-z0-9_.-]{1,120})(?::.*)?$/.exec(inputRef);
  if (m) return (await db.prepare(`SELECT id FROM projects WHERE id = ?`).bind(m[1]).first<{ id: string }>())?.id ?? null;
  const t = /^ticket:([A-Za-z0-9_.-]{1,120})$/.exec(inputRef);
  if (t) return (await db.prepare(`SELECT project_id FROM tickets WHERE id = ?`).bind(t[1]).first<{ project_id: string | null }>())?.project_id ?? null;
  return null;
}

/** Inserts the cost row and the ledger row atomically; the cost row is written only if the ledger row is new. */
async function importOnce(db: Db, source: "ai_job" | "stripe_fee", sourceId: string, cost: { projectId: string | null; category: string; amountCents: number | null; description: string; incurredOn: string } | null, note: string): Promise<boolean> {
  const costId = cost ? newId("cost") : null;
  const stmts = [];
  if (cost) {
    stmts.push(db.prepare(`INSERT INTO project_costs (id, project_id, category, amount_cents, description, incurred_on)
        SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM cost_imports WHERE source = ? AND source_id = ?)`)
      .bind(costId, cost.projectId, cost.category, cost.amountCents, cost.description.slice(0, 300), cost.incurredOn, source, sourceId));
  }
  stmts.push(db.prepare(`INSERT INTO cost_imports (source, source_id, project_cost_id, project_id, amount_cents, note, imported_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(source, source_id) DO NOTHING`)
    .bind(source, sourceId, costId, cost?.projectId ?? null, cost?.amountCents ?? null, note.slice(0, 300), nowIso()));
  const res = await db.batch(stmts);
  return res[res.length - 1].meta.changes === 1;
}

export interface CostImportResult { aiImported: number; aiUnattributed: number; aiUnknown: number; aiSkipped: number; feesFetched: number; feesUnavailable: number; feeImports: number; stripe: string }

export async function importAiCosts(db: Db): Promise<Pick<CostImportResult, "aiImported" | "aiUnattributed" | "aiUnknown" | "aiSkipped">> {
  const out = { aiImported: 0, aiUnattributed: 0, aiUnknown: 0, aiSkipped: 0 };
  const jobs = (await db.prepare(`SELECT j.id, j.workflow, j.provider, j.model, j.status, j.input_ref, j.cost_microusd, j.created_at FROM ai_jobs j
      WHERE j.status IN (${AI_FINAL_STATUSES.map(() => "?").join(",")}) AND NOT EXISTS (SELECT 1 FROM cost_imports c WHERE c.source = 'ai_job' AND c.source_id = j.id)
      ORDER BY j.created_at LIMIT ?`).bind(...AI_FINAL_STATUSES, BATCH)
    .all<{ id: string; workflow: string; provider: string; model: string; status: string; input_ref: string; cost_microusd: number | null; created_at: string }>()).results;
  for (const j of jobs) {
    const noUsage = j.provider === "none" || (j.status === "failed" && j.cost_microusd === null);
    if (noUsage) {
      if (await importOnce(db, "ai_job", j.id, null, j.provider === "none" ? "skipped: no AI provider was called" : "skipped: failed without recorded usage")) out.aiSkipped++;
      continue;
    }
    const projectId = await projectForInputRef(db, j.input_ref);
    const cents = j.cost_microusd === null ? null : Math.round(j.cost_microusd / 10_000);
    const exact = j.cost_microusd === null ? "cost unknown (model price not known to the platform)" : `${j.cost_microusd} micro-USD`;
    const ok = await importOnce(db, "ai_job", j.id, {
      projectId, category: "ai_usage", amountCents: cents, incurredOn: j.created_at.slice(0, 10),
      description: `AI ${j.workflow} (${j.provider}/${j.model}), job ${j.id}: ${exact}${projectId ? "" : " — not attributed to a project"}`,
    }, projectId ? `project ${projectId}` : `unattributed (${j.input_ref.split(":")[0]})`);
    if (!ok) continue;
    out.aiImported++;
    if (!projectId) out.aiUnattributed++;
    if (cents === null) out.aiUnknown++;
  }
  return out;
}

type Expanded = Awaited<ReturnType<import("../adapters/payments.ts").StripeReadOnly["retrievePaymentIntentWithFee"]>>;
function feeOf(pi: Expanded): { fee: number; chargeId: string | null } | null {
  const ch = pi.latest_charge;
  if (!ch || typeof ch === "string") return null;
  const bt = ch.balance_transaction;
  if (!bt || typeof bt === "string") return null;
  if (typeof bt.fee !== "number" || !Number.isInteger(bt.fee) || bt.fee < 0 || bt.currency !== "usd") return null;
  return { fee: bt.fee, chargeId: ch.id ?? null };
}

export async function importStripeFees(db: Db, env: Env): Promise<Pick<CostImportResult, "feesFetched" | "feesUnavailable" | "feeImports" | "stripe">> {
  const out = { feesFetched: 0, feesUnavailable: 0, feeImports: 0, stripe: "" };
  const reader = stripeReader(env);
  if (!reader.ok) out.stripe = `fee lookup skipped: ${reader.reason}`;
  else {
    const missing = (await db.prepare(`SELECT id, stripe_payment_intent_id FROM payments WHERE fee_cents IS NULL AND stripe_payment_intent_id IS NOT NULL
        AND status IN ('succeeded','partially_refunded','refunded','disputed') ORDER BY created_at LIMIT ?`).bind(FEE_FETCH_LIMIT).all<{ id: string; stripe_payment_intent_id: string }>()).results;
    for (const p of missing) {
      if (!/^pi_[A-Za-z0-9_]{1,100}$/.test(p.stripe_payment_intent_id)) { out.feesUnavailable++; continue; }
      const fee = feeOf(await reader.client.retrievePaymentIntentWithFee(p.stripe_payment_intent_id));
      if (!fee) { out.feesUnavailable++; continue; } // not settled yet / non-USD: stays NULL (Unknown)
      const res = await db.prepare(`UPDATE payments SET fee_cents = ?, stripe_charge_id = COALESCE(stripe_charge_id, ?) WHERE id = ? AND fee_cents IS NULL`).bind(fee.fee, fee.chargeId, p.id).run();
      if (res.meta.changes === 1) out.feesFetched++;
    }
    out.stripe = `${out.feesFetched} fees read from Stripe, ${out.feesUnavailable} not available yet`;
  }
  // Import every known fee once, whether it came from Stripe here or was recorded at payment time.
  const known = (await db.prepare(`SELECT p.id, p.fee_cents, p.created_at, p.stripe_payment_intent_id, i.project_id FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
      WHERE p.fee_cents IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cost_imports c WHERE c.source = 'stripe_fee' AND c.source_id = p.id) ORDER BY p.created_at LIMIT ?`).bind(BATCH)
    .all<{ id: string; fee_cents: number; created_at: string; stripe_payment_intent_id: string | null; project_id: string | null }>()).results;
  for (const p of known) {
    const cost = p.project_id ? { projectId: p.project_id, category: "payment_fee", amountCents: p.fee_cents, incurredOn: p.created_at.slice(0, 10), description: `Stripe fee for payment ${p.id}${p.stripe_payment_intent_id ? ` (${p.stripe_payment_intent_id})` : ""}` } : null;
    if (await importOnce(db, "stripe_fee", p.id, cost, p.project_id ? `project ${p.project_id}` : "no project: fee stays on the payment only")) out.feeImports++;
  }
  return out;
}

export async function runCostImport(db: Db, env: Env): Promise<{ detail: string } & CostImportResult> {
  const ai = await importAiCosts(db);
  const fees = await importStripeFees(db, env);
  const detail = `AI: ${ai.aiImported} jobs imported (${ai.aiUnattributed} unattributed, ${ai.aiUnknown} unknown cost), ${ai.aiSkipped} skipped; Stripe: ${fees.stripe}; ${fees.feeImports} fee imports`;
  return { detail, ...ai, ...fees };
}

export async function listCostImports(db: Db, limit: number, offset: number) {
  return (await db.prepare(`SELECT c.source, c.source_id, c.project_id, p.name AS project_name, c.amount_cents, c.note, c.imported_at, c.project_cost_id FROM cost_imports c LEFT JOIN projects p ON p.id = c.project_id
      ORDER BY c.imported_at DESC, c.rowid DESC LIMIT ? OFFSET ?`).bind(limit + 1, offset)
    .all<{ source: string; source_id: string; project_id: string | null; project_name: string | null; amount_cents: number | null; note: string | null; imported_at: string; project_cost_id: string | null }>()).results;
}

export async function unattributedAiSummary(db: Db) {
  return db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS known_cents, SUM(CASE WHEN amount_cents IS NULL THEN 1 ELSE 0 END) AS unknown
      FROM project_costs WHERE project_id IS NULL AND category = 'ai_usage'`).first<{ n: number; known_cents: number; unknown: number | null }>();
}
