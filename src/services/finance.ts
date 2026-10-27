// Finance (FIN-001..004, §56–§58). Every metric is computed from persisted rows; definitions are
// exported so each page can show exactly how a number was derived. Unknown values (NULL fees,
// NULL costs) are reported as unknown — never coerced to zero.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { HttpError } from "../app/http.ts";
import { MAINTENANCE_PLANS } from "../domain/catalog.ts";
import { audit } from "./security.ts";

// ── shared helpers (also used by crm/quotes/billing) ──

/** CSV cell with spreadsheet formula-injection guard (same rule as src/readiness/report.ts). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
/** Accounting-friendly dollars column: plain decimal, no currency symbol or thousands separator. */
export const dollars = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : (cents / 100).toFixed(2));

/** "1,250.50" / "$999" → cents. Returns null for blank, NaN for invalid. */
export function parseDollars(raw: string): number | null {
  const s = raw.replace(/[$,\s]/g, "");
  if (!s) return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export interface DateRange { from: string; to: string; fromIso: string; toIso: string }
/** Inclusive date range from ?from=YYYY-MM-DD&to=YYYY-MM-DD; `toIso` is the exclusive upper bound. */
export function parseRange(params: URLSearchParams, defaultDays: number, now = new Date()): DateRange {
  const today = now.toISOString().slice(0, 10);
  const valid = (s: string | null) => (s && DATE_RE.test(s) && !Number.isNaN(Date.parse(s)) ? s : null);
  let to = valid(params.get("to")) ?? today;
  let from = valid(params.get("from")) ?? new Date(Date.parse(to) - (defaultDays - 1) * 86400e3).toISOString().slice(0, 10);
  if (from > to) [from, to] = [to, from];
  return { from, to, fromIso: `${from}T00:00:00.000Z`, toIso: new Date(Date.parse(to) + 86400e3).toISOString() };
}

// ── definitions shown on each page ──
export const FINANCE_DEFINITIONS: [string, string][] = [
  ["Gross revenue", "Sum of payments.amount_cents for captured Stripe payments (status succeeded, partially_refunded, refunded or disputed) created in the range. Payments are written only by verified Stripe webhooks."],
  ["Refunds", "Sum of refunds.amount_cents with status issued whose issue date (issued_at, else decided_at) falls in the range."],
  ["Net revenue", "Gross revenue − refunds. Stripe fees are shown separately because they may not be reconciled yet."],
  ["Stripe fees", "Sum of payments.fee_cents in the range. If any payment in the range has no recorded fee, the total is shown as Unknown — not yet reconciled."],
  ["Subscription revenue", "Captured payments in the range linked to a subscription invoice (invoices.milestone_kind = subscription) or a subscription order."],
  ["MRR", "Active subscriptions (status active) × the plan's server-side monthly price (src/domain/catalog.ts MAINTENANCE_PLANS)."],
  ["Churn", "Subscriptions canceled during the range ÷ subscriptions active at the start of the range (created before it and not canceled before it). Cancel time = updated_at of the canceled row."],
  ["Outstanding invoices", "All invoices currently in status open, regardless of date."],
  ["Average order value", "Sum of orders.total_cents ÷ number of orders, for orders created in the range with status paid or partially_paid."],
  ["Sales conversion", "Leads created in the range that are now converted ÷ all leads created in the range."],
];

const CAPTURED = `('succeeded','partially_refunded','refunded','disputed')`;

export interface Dashboard {
  range: DateRange;
  gross: number; refunds: number; net: number;
  fees: { known: number; unknownCount: number; paymentCount: number };
  subscriptionRevenue: number; mrr: number; activeSubscriptions: number; /** active subscriptions whose plan has no server-side monthly price (excluded from MRR, never counted as $0) */ mrrUnpriced: number;
  churn: { canceled: number; activeAtStart: number; rate: number | null };
  outstanding: { cents: number; count: number };
  aov: { cents: number | null; orders: number };
  conversion: { converted: number; created: number; rate: number | null };
  byMonth: { month: string; cents: number }[];
  byKind: { kind: string; cents: number }[];
}

export function planMonthlyCents(productId: string): number | null {
  return (MAINTENANCE_PLANS as Record<string, { monthlyCents: number }>)[productId]?.monthlyCents ?? null;
}

export async function financeDashboard(db: Db, range: DateRange): Promise<Dashboard> {
  const r = [range.fromIso, range.toIso];
  const pay = await db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS gross, COALESCE(SUM(fee_cents),0) AS fees, COUNT(*) AS n, SUM(CASE WHEN fee_cents IS NULL THEN 1 ELSE 0 END) AS unknown
    FROM payments WHERE status IN ${CAPTURED} AND created_at >= ? AND created_at < ?`).bind(...r).first<{ gross: number; fees: number; n: number; unknown: number | null }>();
  const ref = await db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS c FROM refunds WHERE status = 'issued' AND COALESCE(issued_at, decided_at, created_at) >= ? AND COALESCE(issued_at, decided_at, created_at) < ?`).bind(...r).first<{ c: number }>();
  const subRev = await db.prepare(`SELECT COALESCE(SUM(p.amount_cents),0) AS c FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN orders o ON o.id = p.order_id
    WHERE p.status IN ${CAPTURED} AND p.created_at >= ? AND p.created_at < ? AND (i.milestone_kind = 'subscription' OR o.kind = 'subscription')`).bind(...r).first<{ c: number }>();
  const subs = (await db.prepare(`SELECT product_id, COUNT(*) AS n FROM subscriptions WHERE status = 'active' GROUP BY product_id`).all<{ product_id: string; n: number }>()).results;
  let mrr = 0, active = 0, unpriced = 0;
  for (const s of subs) { const m = planMonthlyCents(s.product_id); if (m === null) unpriced += s.n; else mrr += m * s.n; active += s.n; }
  const canceled = await db.prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'canceled' AND updated_at >= ? AND updated_at < ?`).bind(...r).first<{ n: number }>();
  const atStart = await db.prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE created_at < ? AND status NOT IN ('incomplete') AND NOT (status = 'canceled' AND updated_at < ?)`).bind(range.fromIso, range.fromIso).first<{ n: number }>();
  const out = await db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS c, COUNT(*) AS n FROM invoices WHERE status = 'open'`).first<{ c: number; n: number }>();
  const aov = await db.prepare(`SELECT COALESCE(SUM(total_cents),0) AS c, COUNT(*) AS n FROM orders WHERE status IN ('paid','partially_paid') AND created_at >= ? AND created_at < ?`).bind(...r).first<{ c: number; n: number }>();
  const conv = await db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN stage = 'converted' THEN 1 ELSE 0 END) AS c FROM leads WHERE created_at >= ? AND created_at < ?`).bind(...r).first<{ n: number; c: number | null }>();
  const byMonth = (await db.prepare(`SELECT substr(created_at,1,7) AS month, SUM(amount_cents) AS cents FROM payments WHERE status IN ${CAPTURED} AND created_at >= ? AND created_at < ? GROUP BY month ORDER BY month`).bind(...r).all<{ month: string; cents: number }>()).results;
  const byKind = (await db.prepare(`SELECT COALESCE(i.milestone_kind, o.kind, 'other') AS kind, SUM(p.amount_cents) AS cents FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN orders o ON o.id = p.order_id
    WHERE p.status IN ${CAPTURED} AND p.created_at >= ? AND p.created_at < ? GROUP BY kind ORDER BY cents DESC`).bind(...r).all<{ kind: string; cents: number }>()).results;
  const gross = pay?.gross ?? 0, refunds = ref?.c ?? 0;
  const c = canceled?.n ?? 0, s0 = atStart?.n ?? 0;
  return {
    range, gross, refunds, net: gross - refunds,
    fees: { known: pay?.fees ?? 0, unknownCount: pay?.unknown ?? 0, paymentCount: pay?.n ?? 0 },
    subscriptionRevenue: subRev?.c ?? 0, mrr, activeSubscriptions: active, mrrUnpriced: unpriced,
    churn: { canceled: c, activeAtStart: s0, rate: s0 > 0 ? c / s0 : null },
    outstanding: { cents: out?.c ?? 0, count: out?.n ?? 0 },
    aov: { cents: aov && aov.n > 0 ? Math.round(aov.c / aov.n) : null, orders: aov?.n ?? 0 },
    conversion: { converted: conv?.c ?? 0, created: conv?.n ?? 0, rate: conv && conv.n > 0 ? (conv.c ?? 0) / conv.n : null },
    byMonth, byKind,
  };
}

// ── lists ──
/** Max rows in a list CSV export (the list itself is paginated). */
export const LIST_EXPORT_LIMIT = 10_000;

/** LIKE pattern for a free-text search box (wildcards in the user's text are escaped). */
export function likePattern(q: string): string { return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; }
/** Normalized search text from ?q= (trimmed, at most 100 characters). */
export function searchParam(params: URLSearchParams): string { return (params.get("q") ?? "").trim().slice(0, 100); }

export interface SubscriptionRow { id: string; organization_id: string; org_name: string; product_id: string; status: string; stripe_subscription_id: string | null; current_period_end: string | null; created_at: string; updated_at: string }
export async function listSubscriptions(db: Db, f: { status?: string; q?: string; limit: number; offset: number }) {
  const conds: string[] = [], binds: unknown[] = [];
  if (f.status) { conds.push(`s.status = ?`); binds.push(f.status); }
  if (f.q) { const l = likePattern(f.q); conds.push(`(o.name LIKE ? ESCAPE '\\' OR s.stripe_subscription_id LIKE ? ESCAPE '\\' OR s.product_id LIKE ? ESCAPE '\\' OR s.id LIKE ? ESCAPE '\\')`); binds.push(l, l, l, l); }
  return (await db.prepare(`SELECT s.*, o.name AS org_name FROM subscriptions s JOIN organizations o ON o.id = s.organization_id ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, f.limit + 1, f.offset).all<SubscriptionRow>()).results;
}
export function subscriptionsListCsv(rows: SubscriptionRow[]): string {
  return toCsv(["subscription_id", "customer", "plan", "status", "monthly_price_cents", "monthly_price_usd", "current_period_end", "started", "updated", "stripe_subscription"],
    rows.map((s) => { const m = planMonthlyCents(s.product_id); return [s.id, s.org_name, s.product_id, s.status, m ?? "", dollars(m), s.current_period_end?.slice(0, 10) ?? "", s.created_at.slice(0, 10), s.updated_at.slice(0, 10), s.stripe_subscription_id]; }));
}

export const INVOICE_STATUSES = ["draft", "open", "paid", "void", "uncollectible"] as const;
export const INVOICE_KINDS = ["full", "deposit_50", "design_25", "prelaunch_25", "change_order", "subscription"] as const;
export interface InvoiceListRow {
  id: string; organization_id: string; org_name: string; order_id: string | null; project_id: string | null; milestone_kind: string | null; amount_cents: number; status: string; description: string | null;
  created_at: string; paid_at: string | null; due_at: string | null; stripe_invoice_id: string | null; stripe_invoice_status: string | null; stripe_checkout_session_id: string | null;
  /** Comma-separated ids of the invoice's non-failed payments (each has a receipt). */
  payment_ids: string | null; paid_cents: number;
}
export async function listInvoices(db: Db, f: { status?: string; kind?: string; q?: string; range?: DateRange; limit: number; offset: number }) {
  const conds: string[] = [], binds: unknown[] = [];
  if (f.status) { conds.push(`i.status = ?`); binds.push(f.status); }
  if (f.kind) { conds.push(`i.milestone_kind = ?`); binds.push(f.kind); }
  if (f.q) { const l = likePattern(f.q); conds.push(`(o.name LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\' OR i.id LIKE ? ESCAPE '\\' OR i.stripe_invoice_id LIKE ? ESCAPE '\\')`); binds.push(l, l, l, l); }
  if (f.range) { conds.push(`i.created_at >= ? AND i.created_at < ?`); binds.push(f.range.fromIso, f.range.toIso); }
  return (await db.prepare(`SELECT i.*, o.name AS org_name,
        (SELECT group_concat(p.id) FROM payments p WHERE p.invoice_id = i.id AND p.status <> 'failed') AS payment_ids,
        (SELECT COALESCE(SUM(p.amount_cents),0) FROM payments p WHERE p.invoice_id = i.id AND p.status <> 'failed') AS paid_cents
      FROM invoices i JOIN organizations o ON o.id = i.organization_id ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY i.created_at DESC, i.rowid DESC LIMIT ? OFFSET ?`)
    .bind(...binds, f.limit + 1, f.offset).all<InvoiceListRow>()).results;
}
export function invoicesListCsv(rows: InvoiceListRow[]): string {
  return toCsv(["invoice_id", "issued_date", "customer", "kind", "description", "amount_cents", "amount_usd", "status", "paid_cents", "paid_date", "due_date", "project_id", "order_id", "payment_ids", "stripe_invoice", "stripe_invoice_status"],
    rows.map((i) => [i.id, i.created_at.slice(0, 10), i.org_name, i.milestone_kind, i.description, i.amount_cents, dollars(i.amount_cents), i.status, i.paid_cents, i.paid_at?.slice(0, 10) ?? "", i.due_at?.slice(0, 10) ?? "", i.project_id, i.order_id, (i.payment_ids ?? "").replace(/,/g, " "), i.stripe_invoice_id, i.stripe_invoice_status]));
}

// ── profitability (FIN-002, FIN-003) ──
export const COST_CATEGORIES = ["labor", "hosting", "ai_usage", "third_party_api", "software_license", "payment_fee", "other"] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export interface UnknownCost { source: "project_cost" | "time_entry"; id: string; description: string; date: string }
export interface ProjectProfit {
  projectId: string; name: string; organization: string; status: string;
  revenueCents: number; knownCostCents: number; unknown: UnknownCost[];
  /** Known cost per category (labor includes time entries). */
  knownByCategory: Partial<Record<CostCategory, number>>;
  profitCents: number | null; // null when any cost is unknown
}

export async function projectProfitability(db: Db, projectId?: string): Promise<ProjectProfit[]> {
  const projects = (await db.prepare(`SELECT p.id, p.name, p.status, o.name AS org FROM projects p JOIN organizations o ON o.id = p.organization_id ${projectId ? "WHERE p.id = ?" : ""} ORDER BY p.created_at DESC LIMIT 500`)
    .bind(...(projectId ? [projectId] : [])).all<{ id: string; name: string; status: string; org: string }>()).results;
  const out: ProjectProfit[] = [];
  for (const p of projects) {
    const rev = await db.prepare(`SELECT COALESCE(SUM(COALESCE(subtotal_cents, amount_cents)),0) AS c FROM invoices WHERE project_id = ? AND status = 'paid'`).bind(p.id).first<{ c: number }>();
    const costs = (await db.prepare(`SELECT id, category, amount_cents, description, incurred_on FROM project_costs WHERE project_id = ?`).bind(p.id).all<{ id: string; category: string; amount_cents: number | null; description: string; incurred_on: string }>()).results;
    const time = (await db.prepare(`SELECT te.id, te.minutes, te.hourly_cost_cents, te.worked_on, t.title FROM time_entries te JOIN tasks t ON t.id = te.task_id WHERE t.project_id = ?`).bind(p.id)
      .all<{ id: string; minutes: number; hourly_cost_cents: number | null; worked_on: string; title: string }>()).results;
    let known = 0;
    const unknown: UnknownCost[] = [];
    const byCat: Partial<Record<CostCategory, number>> = {};
    const addCat = (k: CostCategory, v: number) => { byCat[k] = (byCat[k] ?? 0) + v; };
    for (const c of costs) {
      if (c.amount_cents === null) unknown.push({ source: "project_cost", id: c.id, description: `${c.category}: ${c.description}`, date: c.incurred_on });
      else { known += c.amount_cents; addCat(c.category as CostCategory, c.amount_cents); }
    }
    for (const t of time) {
      if (t.hourly_cost_cents === null) unknown.push({ source: "time_entry", id: t.id, description: `Labor (${t.minutes} min) on "${t.title}" — hourly cost unknown`, date: t.worked_on });
      else { const v = Math.round((t.minutes * t.hourly_cost_cents) / 60); known += v; addCat("labor", v); }
    }
    const revenue = rev?.c ?? 0;
    out.push({ projectId: p.id, name: p.name, organization: p.org, status: p.status, revenueCents: revenue, knownCostCents: known, unknown, knownByCategory: byCat, profitCents: unknown.length ? null : revenue - known });
  }
  return out;
}

export async function addCost(db: Db, userId: string, input: { projectId: string | null; category: string; amountCents: number | null; description: string; incurredOn: string }) {
  const issues: string[] = [];
  if (!(COST_CATEGORIES as readonly string[]).includes(input.category)) issues.push("Choose a cost category");
  if (input.amountCents !== null && (!Number.isInteger(input.amountCents) || input.amountCents < 0)) issues.push("Amount must be a positive dollar amount, or blank if unknown");
  if (input.description.length < 3 || input.description.length > 300) issues.push("Describe the cost (3–300 characters)");
  if (!DATE_RE.test(input.incurredOn)) issues.push("Enter the date the cost was incurred");
  if (input.projectId) {
    const p = await db.prepare(`SELECT id FROM projects WHERE id = ?`).bind(input.projectId).first();
    if (!p) issues.push("Project not found");
  }
  if (issues.length) return { ok: false as const, issues };
  const id = newId("cost");
  await db.prepare(`INSERT INTO project_costs (id, project_id, category, amount_cents, description, incurred_on) VALUES (?,?,?,?,?,?)`)
    .bind(id, input.projectId, input.category, input.amountCents, input.description, input.incurredOn).run();
  await audit(db, { actorUserId: userId, action: "finance.cost_recorded", subjectType: "project_cost", subjectId: id, details: { projectId: input.projectId, category: input.category, amountCents: input.amountCents } });
  return { ok: true as const, id };
}

// ── accounting exports (FIN-004) ──
export const EXPORT_KINDS = ["transactions", "invoices", "refunds", "subscriptions", "profitability"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export async function exportCsv(db: Db, kind: ExportKind, range: DateRange): Promise<string> {
  const r = [range.fromIso, range.toIso];
  switch (kind) {
    case "transactions": {
      const rows = (await db.prepare(`SELECT p.id, p.created_at, o.name AS org, p.invoice_id, p.order_id, p.amount_cents, p.fee_cents, p.status, p.stripe_payment_intent_id, p.stripe_charge_id
        FROM payments p JOIN organizations o ON o.id = p.organization_id WHERE p.created_at >= ? AND p.created_at < ? ORDER BY p.created_at`).bind(...r)
        .all<{ id: string; created_at: string; org: string; invoice_id: string | null; order_id: string | null; amount_cents: number; fee_cents: number | null; status: string; stripe_payment_intent_id: string | null; stripe_charge_id: string | null }>()).results;
      return toCsv(["payment_id", "date", "customer", "invoice_id", "order_id", "amount_cents", "amount_usd", "fee_cents", "fee_usd", "fee_status", "status", "stripe_payment_intent", "stripe_charge"],
        rows.map((x) => [x.id, x.created_at.slice(0, 10), x.org, x.invoice_id, x.order_id, x.amount_cents, dollars(x.amount_cents), x.fee_cents ?? "", dollars(x.fee_cents), x.fee_cents === null ? "unknown" : "known", x.status, x.stripe_payment_intent_id, x.stripe_charge_id]));
    }
    case "invoices": {
      const rows = (await db.prepare(`SELECT i.id, i.created_at, i.paid_at, i.due_at, o.name AS org, i.order_id, i.project_id, i.milestone_kind, i.description, i.amount_cents, i.status
        FROM invoices i JOIN organizations o ON o.id = i.organization_id WHERE i.created_at >= ? AND i.created_at < ? ORDER BY i.created_at`).bind(...r)
        .all<{ id: string; created_at: string; paid_at: string | null; due_at: string | null; org: string; order_id: string | null; project_id: string | null; milestone_kind: string | null; description: string | null; amount_cents: number; status: string }>()).results;
      return toCsv(["invoice_id", "issued_date", "paid_date", "due_date", "customer", "order_id", "project_id", "kind", "description", "amount_cents", "amount_usd", "status"],
        rows.map((x) => [x.id, x.created_at.slice(0, 10), x.paid_at?.slice(0, 10) ?? "", x.due_at?.slice(0, 10) ?? "", x.org, x.order_id, x.project_id, x.milestone_kind, x.description, x.amount_cents, dollars(x.amount_cents), x.status]));
    }
    case "refunds": {
      const rows = (await db.prepare(`SELECT f.id, f.created_at, f.decided_at, f.issued_at, o.name AS org, f.payment_id, f.amount_cents, f.reason, f.status, f.mandatory_obligation, f.stripe_refund_id
        FROM refunds f JOIN organizations o ON o.id = f.organization_id WHERE f.created_at >= ? AND f.created_at < ? ORDER BY f.created_at`).bind(...r)
        .all<{ id: string; created_at: string; decided_at: string | null; issued_at: string | null; org: string; payment_id: string; amount_cents: number; reason: string; status: string; mandatory_obligation: number; stripe_refund_id: string | null }>()).results;
      return toCsv(["refund_id", "requested_date", "decided_date", "issued_date", "customer", "payment_id", "amount_cents", "amount_usd", "reason", "status", "mandatory_obligation", "stripe_refund"],
        rows.map((x) => [x.id, x.created_at.slice(0, 10), x.decided_at?.slice(0, 10) ?? "", x.issued_at?.slice(0, 10) ?? "", x.org, x.payment_id, x.amount_cents, dollars(x.amount_cents), x.reason, x.status, x.mandatory_obligation ? "yes" : "no", x.stripe_refund_id]));
    }
    case "subscriptions": {
      const rows = (await db.prepare(`SELECT s.id, s.created_at, s.updated_at, o.name AS org, s.product_id, s.status, s.current_period_end, s.stripe_subscription_id
        FROM subscriptions s JOIN organizations o ON o.id = s.organization_id WHERE s.created_at < ? AND NOT (s.status = 'canceled' AND s.updated_at < ?) ORDER BY s.created_at`).bind(range.toIso, range.fromIso)
        .all<{ id: string; created_at: string; updated_at: string; org: string; product_id: string; status: string; current_period_end: string | null; stripe_subscription_id: string | null }>()).results;
      return toCsv(["subscription_id", "start_date", "customer", "plan", "status", "monthly_price_cents", "monthly_price_usd", "current_period_end", "canceled_date", "stripe_subscription"],
        rows.map((x) => { const m = planMonthlyCents(x.product_id); return [x.id, x.created_at.slice(0, 10), x.org, x.product_id, x.status, m ?? "", dollars(m), x.current_period_end?.slice(0, 10) ?? "", x.status === "canceled" ? x.updated_at.slice(0, 10) : "", x.stripe_subscription_id]; }));
    }
    case "profitability": {
      const rows = await projectProfitability(db);
      return toCsv(["project_id", "project", "customer", "status", "revenue_cents", "revenue_usd", "known_cost_cents", "known_cost_usd", "unknown_cost_items", "profit_cents", "profit_usd", "profit_status"],
        rows.map((x) => [x.projectId, x.name, x.organization, x.status, x.revenueCents, dollars(x.revenueCents), x.knownCostCents, dollars(x.knownCostCents), x.unknown.length, x.profitCents ?? "", dollars(x.profitCents), x.profitCents === null ? "incomplete_unknown_costs" : "complete"]));
    }
  }
  throw new HttpError(404, "Unknown export");
}

export const nowDate = () => nowIso().slice(0, 10);
