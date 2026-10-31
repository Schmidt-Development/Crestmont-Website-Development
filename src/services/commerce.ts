// Orders, invoices and project provisioning (SALES-004, PAY-005, PAY-006).
// Prices always come from the server catalog or a stored quote version — never from the client.
import type { Db, DbStatement } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { PACKAGES, MAINTENANCE_PLANS, milestoneSplit, type PackageId, type MaintenanceId } from "../domain/catalog.ts";
import { milestoneInvoiceAllowed } from "../domain/project.ts";
import { audit } from "./security.ts";
import { HttpError } from "../app/http.ts";
import { effectivePackagePrice } from "./pricing-approvals.ts";
import { taxForNewInvoice, quoteProductKey, checkoutLinesFor } from "./tax.ts";

export interface InvoiceRow { id: string; organization_id: string; order_id: string | null; project_id: string | null; milestone_kind: string | null; amount_cents: number; status: string; description: string | null }

export async function createPackageOrder(db: Db, organizationId: string, packageId: PackageId, actorUserId: string, now: Date = new Date(), opts: { leadId?: string | null } = {}) {
  const pkg = PACKAGES[packageId];
  if (!pkg) throw new HttpError(400, "Unknown package");
  // CAT-007: the Founder-approved effective price (catalog price unless an approved override is in force).
  const price = await effectivePackagePrice(db, pkg.id, now);
  const amount = price.cents;
  const at = nowIso(() => now);
  // LEGAL-005: tax (if the Owner configured it) is added on top of the price; the order total stays pre-tax.
  const tax = await taxForNewInvoice(db, { description: `${pkg.name} package — 100% upfront`, amountCents: amount, productKey: pkg.id });
  const description = `${pkg.name} website package`;
  // CREST-GAP-036: one open invoice per organization and package. A repeat checkout reuses it (same amounts), so
  // abandoned clicks do not pile up as receivables and two separate invoices can never both be paid. If the price or
  // tax changed since, the stale invoice is voided and a new one is issued.
  const open = await db.prepare(`SELECT i.id AS invoice_id, o.id AS order_id, o.lead_id, o.total_cents, i.amount_cents, i.subtotal_cents, i.tax_cents, i.tax_detail_json FROM invoices i JOIN orders o ON o.id = i.order_id
      WHERE o.organization_id = ? AND o.kind = 'package' AND o.product_id = ? AND o.status = 'pending_payment' AND i.status = 'open' AND i.milestone_kind = 'full'
      ORDER BY i.created_at DESC LIMIT 1`).bind(organizationId, pkg.id)
    .first<{ invoice_id: string; order_id: string; lead_id: string | null; total_cents: number; amount_cents: number; subtotal_cents: number | null; tax_cents: number; tax_detail_json: string | null }>();
  if (open) {
    if (open.total_cents === amount && open.amount_cents === tax.amountCents && (open.tax_detail_json ?? null) === (tax.detailJson ?? null)) {
      if (opts.leadId && !open.lead_id) await db.prepare(`UPDATE orders SET lead_id = ? WHERE id = ? AND lead_id IS NULL`).bind(opts.leadId, open.order_id).run();
      await audit(db, { actorUserId, action: "order.reused", subjectType: "order", subjectId: open.order_id, organizationId, details: { packageId, invoiceId: open.invoice_id } });
      return { orderId: open.order_id, invoiceId: open.invoice_id, amountCents: open.amount_cents, description, reused: true,
        checkoutLines: checkoutLinesFor({ description, amount_cents: open.amount_cents, subtotal_cents: open.subtotal_cents, tax_detail_json: open.tax_detail_json }, description) };
    }
    await db.batch([
      db.prepare(`UPDATE invoices SET status = 'void' WHERE id = ? AND status = 'open'`).bind(open.invoice_id),
      db.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending_payment'`).bind(open.order_id),
    ]);
    await audit(db, { actorUserId, action: "invoice.voided_price_changed", subjectType: "invoice", subjectId: open.invoice_id, organizationId, details: { packageId, oldAmountCents: open.amount_cents, newAmountCents: tax.amountCents } });
  }
  const orderId = newId("ord"), invoiceId = newId("inv");
  await db.batch([
    db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, lead_id, created_at) VALUES (?,?,?,?, 'pending_payment','package',?,?)`).bind(orderId, organizationId, pkg.id, amount, opts.leadId ?? null, at),
    db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, subtotal_cents, tax_cents, tax_detail_json, status, description, created_at) VALUES (?,?,?, 'full', ?, ?, ?, ?, 'open', ?, ?)`)
      .bind(invoiceId, organizationId, orderId, tax.amountCents, tax.subtotalCents, tax.taxCents, tax.detailJson, `${pkg.name} package — 100% upfront`, at),
  ]);
  await audit(db, { actorUserId, action: "order.created", subjectType: "order", subjectId: orderId, organizationId, details: { packageId, totalCents: amount, taxCents: tax.taxCents, priceSource: price.source, priceOverrideId: price.overrideId } });
  return { orderId, invoiceId, amountCents: tax.amountCents, description, reused: false,
    checkoutLines: checkoutLinesFor({ description, amount_cents: tax.amountCents, subtotal_cents: tax.subtotalCents, tax_detail_json: tax.detailJson }, description) };
}

/**
 * The product an accepted quote provisions as (CREST-GAP-033): a package quote keeps its package identity (revision
 * allowance, build strategy, agreements); custom work is "custom" (or none for an upfront custom quote, as before).
 */
export function quoteOrderProduct(v: { package_id?: string | null; payment_schedule: string }): string | null {
  if (v.package_id && v.package_id in PACKAGES) return v.package_id;
  return v.payment_schedule === "upfront" ? null : "custom";
}

/**
 * Statements that create the order and the first invoice (full or 50% deposit) for an accepted quote version, for the
 * caller to commit in the same batch as the acceptance itself (CREST-GAP-032: all or nothing).
 */
export async function prepareQuoteOrder(db: Db, organizationId: string, quoteVersion: { id: string; total_cents: number; payment_schedule: string; quote_id: string; package_id?: string | null }, leadId: string | null,
  guard?: { sql: string; binds: unknown[] }) {
  const at = nowIso();
  const orderId = newId("ord"), invoiceId = newId("inv");
  const first = quoteVersion.payment_schedule === "milestone_50_25_25" ? milestoneSplit(quoteVersion.total_cents)[0] : { kind: "full" as const, amountCents: quoteVersion.total_cents };
  const description = first.kind === "deposit_50" ? "50% deposit" : "Payment in full";
  const tax = await taxForNewInvoice(db, { description, amountCents: first.amountCents, productKey: await quoteProductKey(db, quoteVersion.id) });
  // With a guard, the order is created only when the guard holds and no order exists for this version yet, and the
  // invoice only when that order was created: safe to place in the same batch as the acceptance (CREST-GAP-032).
  const statements: DbStatement[] = [
    db.prepare(`INSERT INTO orders (id, organization_id, quote_version_id, product_id, total_cents, status, kind, lead_id, created_at) SELECT ?,?,?,?,?, 'pending_payment','quote',?,?
                WHERE NOT EXISTS (SELECT 1 FROM orders WHERE quote_version_id = ? AND kind = 'quote')${guard ? ` AND ${guard.sql}` : ""}`)
      .bind(orderId, organizationId, quoteVersion.id, quoteOrderProduct(quoteVersion), quoteVersion.total_cents, leadId, at, quoteVersion.id, ...(guard?.binds ?? [])),
    db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, subtotal_cents, tax_cents, tax_detail_json, status, description, created_at) SELECT ?,?,?,?,?,?,?,?, 'open', ?, ? WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?)`)
      .bind(invoiceId, organizationId, orderId, first.kind, tax.amountCents, tax.subtotalCents, tax.taxCents, tax.detailJson, description, at, orderId),
  ];
  return { orderId, invoiceId, amountCents: tax.amountCents, taxCents: tax.taxCents, statements };
}

/** Accepting a quote version creates the order and the first invoice (full or 50% deposit). */
export async function createQuoteOrder(db: Db, organizationId: string, quoteVersion: { id: string; total_cents: number; payment_schedule: string; quote_id: string; package_id?: string | null }, leadId: string | null, actorUserId: string) {
  const o = await prepareQuoteOrder(db, organizationId, quoteVersion, leadId);
  await db.batch(o.statements);
  await audit(db, { actorUserId, action: "order.created", subjectType: "order", subjectId: o.orderId, organizationId, details: { quoteVersionId: quoteVersion.id, taxCents: o.taxCents } });
  return { orderId: o.orderId, invoiceId: o.invoiceId, amountCents: o.amountCents };
}

/** Idempotent: provisions exactly one project per paid order. */
export async function provisionProject(db: Db, orderId: string): Promise<string> {
  return (await provisionProjectOnce(db, orderId)).projectId;
}

/**
 * Exactly one project per order (CREST-GAP-006): the unique index uq_projects_order (migration 0043) plus INSERT OR
 * IGNORE means a concurrent or repeated call never creates a second project; the dependent rows are only inserted
 * when this call's project row was the one created. `created` is true only for that call.
 */
export async function provisionProjectOnce(db: Db, orderId: string): Promise<{ projectId: string; created: boolean }> {
  const existing = await db.prepare(`SELECT id FROM projects WHERE order_id = ?`).bind(orderId).first<{ id: string }>();
  if (existing) return { projectId: existing.id, created: false };
  const o = await db.prepare(
    `SELECT o.id, o.organization_id, o.product_id, o.quote_version_id, o.kind, org.name AS org_name, qv.payment_schedule, qv.scope_text
     FROM orders o JOIN organizations org ON org.id = o.organization_id LEFT JOIN quote_versions qv ON qv.id = o.quote_version_id WHERE o.id = ?`,
  ).bind(orderId).first<{ id: string; organization_id: string; product_id: string | null; quote_version_id: string | null; kind: string; org_name: string; payment_schedule: string | null; scope_text: string | null }>();
  if (!o) throw new Error(`Order ${orderId} not found`);
  const pkg = o.product_id && o.product_id in PACKAGES ? PACKAGES[o.product_id as PackageId] : null;
  const schedule = o.payment_schedule ?? "upfront";
  const allowance = pkg?.revisionRounds ?? 3; // custom projects: 3 rounds unless the quote scope states otherwise
  const at = nowIso();
  const projectId = newId("prj");
  const scope = o.scope_text ?? (pkg ? `${pkg.name} package: ${pkg.includes.join("; ")}.` : "Scope per accepted quote.");
  const milestoneNames = ["Onboarding", "Scope review", "Design", "Development", "Internal QA", "Customer review", "Launch"];
  const mine = `EXISTS (SELECT 1 FROM projects WHERE id = ?)`;
  const res = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO projects (id, organization_id, order_id, product_id, name, status, revision_allowance, payment_schedule, last_customer_activity_at, created_at, updated_at)
                VALUES (?,?,?,?,?, 'awaiting_onboarding', ?, ?, ?, ?, ?)`)
      .bind(projectId, o.organization_id, o.id, o.product_id, `${o.org_name} — ${pkg ? pkg.name + " website" : "custom project"}`, allowance, schedule, at, at, at),
    db.prepare(`INSERT INTO project_scopes (id, project_id, version, scope_text) SELECT ?,?,1,? WHERE ${mine}`).bind(newId("scp"), projectId, scope, projectId),
    ...milestoneNames.map((n, i) => db.prepare(`INSERT INTO milestones (id, project_id, name, position, status) SELECT ?,?,?,?, 'pending' WHERE ${mine}`).bind(newId("ms"), projectId, n, i + 1, projectId)),
    db.prepare(`UPDATE invoices SET project_id = ? WHERE order_id = ? AND project_id IS NULL AND ${mine}`).bind(projectId, o.id, projectId),
  ]);
  if (res[0].meta.changes !== 1) {
    const winner = await db.prepare(`SELECT id FROM projects WHERE order_id = ?`).bind(orderId).first<{ id: string }>();
    if (!winner) throw new Error(`Project for order ${orderId} was not created`);
    return { projectId: winner.id, created: false };
  }
  await audit(db, { actorKind: "system", action: "project.provisioned", subjectType: "project", subjectId: projectId, organizationId: o.organization_id, details: { orderId } });
  return { projectId, created: true };
}

/** Issues the next 25% milestone invoice when its project approval exists; refuses duplicates. */
export async function issueMilestoneInvoice(db: Db, projectId: string, kind: "design_25" | "prelaunch_25", actorUserId: string) {
  const p = await db.prepare(`SELECT p.id, p.organization_id, p.payment_schedule, o.total_cents, o.quote_version_id FROM projects p JOIN orders o ON o.id = p.order_id WHERE p.id = ?`).bind(projectId).first<{ id: string; organization_id: string; payment_schedule: string; total_cents: number; quote_version_id: string | null }>();
  if (!p) throw new HttpError(404, "Project not found");
  if (p.payment_schedule !== "milestone_50_25_25") throw new HttpError(409, "This project is paid upfront");
  const approvals = (await db.prepare(`SELECT kind, decision FROM approvals WHERE project_id = ?`).bind(projectId).all<{ kind: string; decision: string }>()).results;
  if (!milestoneInvoiceAllowed(kind, approvals)) throw new HttpError(409, kind === "design_25" ? "Design must be approved before the design milestone invoice" : "Final launch approval is required before the pre-launch invoice");
  const amount = milestoneSplit(p.total_cents).find((m) => m.kind === kind)!.amountCents;
  const id = newId("inv");
  const description = kind === "design_25" ? "25% on approved design" : "25% before launch";
  const tax = await taxForNewInvoice(db, { description, amountCents: amount, productKey: await quoteProductKey(db, p.quote_version_id) });
  try {
    await db.prepare(`INSERT INTO invoices (id, organization_id, order_id, project_id, milestone_kind, amount_cents, subtotal_cents, tax_cents, tax_detail_json, status, description, created_at)
                      SELECT ?, organization_id, order_id, id, ?, ?, ?, ?, ?, 'open', ?, ? FROM projects WHERE id = ?`)
      .bind(id, kind, tax.amountCents, tax.subtotalCents, tax.taxCents, tax.detailJson, description, nowIso(), projectId).run();
  } catch (e) {
    if (/UNIQUE/.test((e as Error).message)) throw new HttpError(409, "That milestone invoice already exists");
    throw e;
  }
  await audit(db, { actorUserId, action: "invoice.milestone_issued", subjectType: "invoice", subjectId: id, organizationId: p.organization_id, details: { kind, amount, taxCents: tax.taxCents } });
  return id;
}

export async function markInvoicePaid(db: Db, invoiceId: string, payment: { amountCents: number; paymentIntentId: string | null; chargeId?: string | null; feeCents?: number | null;
  /** Test-only payment simulation (migration 0059); Stripe otherwise. */ provider?: "stripe" | "simulated"; simulatedTransactionId?: string | null }) {
  const inv = await db.prepare(`SELECT * FROM invoices WHERE id = ?`).bind(invoiceId).first<InvoiceRow>();
  if (!inv) throw new Error(`Invoice ${invoiceId} not found`);
  if (inv.status === "paid") {
    if ((payment.provider ?? "stripe") !== "simulated" && payment.paymentIntentId) {
      // A real payment for an invoice an internal test marked paid by SIMULATION: never acknowledge it silently.
      // Throwing marks the Stripe event failed (retried, then dead-lettered) so it shows in reconciliation.
      const sim = await db.prepare(`SELECT 1 FROM payments WHERE invoice_id = ? AND provider = 'simulated'`).bind(invoiceId).first();
      const known = await db.prepare(`SELECT 1 FROM payments WHERE stripe_payment_intent_id = ?`).bind(payment.paymentIntentId).first();
      if (sim && !known) throw new Error(`Real Stripe payment ${payment.paymentIntentId} for invoice ${invoiceId}, which an internal test marked paid by SIMULATION: needs manual review`);
    }
    return { alreadyPaid: true, invoice: inv };
  }
  if (payment.amountCents !== inv.amount_cents) throw new Error(`Amount mismatch for ${invoiceId}: paid ${payment.amountCents}, expected ${inv.amount_cents}`);
  const at = nowIso();
  await db.batch([
    db.prepare(`UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ? AND status <> 'paid'`).bind(at, invoiceId),
    db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, order_id, amount_cents, fee_cents, stripe_payment_intent_id, stripe_charge_id, status, provider, simulated_transaction_id, created_at)
                VALUES (?,?,?,?,?,?,?,?, 'succeeded', ?, ?, ?) ON CONFLICT(stripe_payment_intent_id) DO NOTHING`)
      .bind(newId("pay"), inv.organization_id, inv.id, inv.order_id, payment.amountCents, payment.feeCents ?? null, payment.paymentIntentId, payment.chargeId ?? null,
        payment.provider ?? "stripe", payment.simulatedTransactionId ?? null, at),
  ]);
  if (inv.order_id) {
    const totals = await db.prepare(`SELECT o.total_cents, COALESCE(SUM(COALESCE(i.subtotal_cents, i.amount_cents)),0) AS paid FROM orders o LEFT JOIN invoices i ON i.order_id = o.id AND i.status = 'paid' WHERE o.id = ? GROUP BY o.id`).bind(inv.order_id).first<{ total_cents: number; paid: number }>();
    const status = totals && totals.paid >= totals.total_cents ? "paid" : "partially_paid";
    await db.prepare(`UPDATE orders SET status = ? WHERE id = ?`).bind(status, inv.order_id).run();
  }
  await audit(db, { actorKind: payment.provider === "simulated" ? "system" : "webhook", action: "invoice.paid", subjectType: "invoice", subjectId: invoiceId, organizationId: inv.organization_id, details: { amountCents: payment.amountCents, provider: payment.provider ?? "stripe" } });
  return { alreadyPaid: false, invoice: inv };
}

export function maintenancePlan(id: string) {
  return (MAINTENANCE_PLANS as Record<string, (typeof MAINTENANCE_PLANS)[MaintenanceId]>)[id] ?? null;
}
