// Test-only payment provider simulation (Founder E2E benchmark directive, 2026-10-30; migration 0044).
//
// Stripe is not configured, so an internal end-to-end test of "customer pays → onboarding → AI build" needs a
// stand-in for the payment provider. This module is that stand-in and nothing else:
//  - it is an Owner action (payments.simulate, Owner-only, MFA step-up on the route);
//  - it is refused in production whatever the configuration says, and refused unless PAYMENT_SIMULATION_ENABLED=true;
//  - it only pays invoices of organizations the Owner explicitly marked as fictional test organizations, and an
//    organization that ever paid through Stripe cannot be marked;
//  - it never calls Stripe or any external service, never sends a receipt, and is never recorded as a Stripe payment.
// A synthetic event enters the same internal payment-confirmation handler a verified Stripe webhook uses
// (confirmInvoicePayment in payments.ts), so project provisioning, lead conversion and build eligibility are the
// real application workflow. A simulated payment never authorizes real customer fulfillment: builds.ts refuses it
// for organizations without the test mark, and customer preview sharing and production release are refused
// (builds.ts sharePreview, site-delivery.ts releaseBlockers / insertDeployment).
//
// What this does NOT test: Stripe Checkout, Stripe signature verification, settlement, payouts, refunds, disputes.
import type { AppContext, Env } from "../app/context.ts";
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { HttpError } from "../app/http.ts";
import { audit } from "./security.ts";
import { confirmInvoicePayment } from "./payments.ts";

export const SIMULATED_EVENT_SCHEMA = "crestmont.simulated-payment/1";
export const SIMULATED_PAID = "SIMULATED_PAID";
export const SIMULATED_FAILED = "SIMULATED_FAILED";
/** Same window as Stripe's signature tolerance: an event older (or newer) than this is treated as a replay. */
export const EVENT_TOLERANCE_SECONDS = 300;

export interface SimulatedPaymentEvent {
  schema: typeof SIMULATED_EVENT_SCHEMA;
  simulated: true;
  id: string;              // evt_sim_…
  transactionId: string;   // txn_sim_…
  orderId: string;
  invoiceId: string;
  customerId: string;      // the customer administrator (user id) the order belongs to
  packageId: string;       // catalog package id, or quote_version:<id> for a quoted (custom) order
  amountCents: number;
  currency: string;        // "usd"
  paymentStatus: string;   // SIMULATED_PAID | SIMULATED_FAILED
  timestamp: string;       // ISO 8601
  environment: string;     // must equal the platform's ENVIRONMENT
  correlationId: string;
}

export type SimulationOutcome = "applied" | "rejected" | "failed_payment" | "duplicate_order";
export interface DeliveryResult { eventId: string; outcome: SimulationOutcome; reason: string | null; duplicateDelivery: boolean; projectId: string | null }

export class SimulationDisabled extends HttpError {}

/** Refuses the whole feature unless this is a non-production environment with the explicit flag set. */
export function assertSimulationAllowed(env: Pick<Env, "ENVIRONMENT" | "PAYMENT_SIMULATION_ENABLED">): void {
  // Allow-list, so a missing or misspelled ENVIRONMENT fails closed.
  if (env.ENVIRONMENT !== "development" && env.ENVIRONMENT !== "staging") throw new SimulationDisabled(403, "Payment simulation is never available in production (only in development or staging).");
  if (env.PAYMENT_SIMULATION_ENABLED !== "true") throw new SimulationDisabled(403, "Payment simulation is disabled (PAYMENT_SIMULATION_ENABLED is not \"true\" in this environment).");
}

export function simulationAvailable(env: Pick<Env, "ENVIRONMENT" | "PAYMENT_SIMULATION_ENABLED">): boolean {
  try { assertSimulationAllowed(env); return true; } catch { return false; }
}

// ── test organizations ──

/** Addresses that cannot belong to a real customer: reserved test domains (RFC 2606/6761) or Crestmont's own domain. */
const FICTIONAL_EMAIL = /(?:\.(?:test|example|invalid|localhost)|@crestmontwebsitedevelopment\.com)$/i;

/**
 * Why an organization cannot be (or stay) a fictional test organization, or null. Re-checked on every simulated
 * payment, not only when marking: real money arriving later, or a real person joining, ends simulation for it.
 */
export async function fictionalOrgProblem(db: Db, organizationId: string): Promise<string | null> {
  const real = await db.prepare(`SELECT 1 FROM payments WHERE organization_id = ? AND provider <> 'simulated' LIMIT 1`).bind(organizationId).first();
  if (real) return "the organization has real (Stripe) payments; a real customer can never be paid by simulation";
  const people = (await db.prepare(`SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ?`).bind(organizationId).all<{ email: string }>()).results;
  if (!people.length) return "the organization has no members";
  const realPerson = people.find((p) => !FICTIONAL_EMAIL.test(p.email));
  if (realPerson) return "a member uses a real email domain; test organizations may only contain reserved test addresses (.test, .example, .invalid, .localhost) or @crestmontwebsitedevelopment.com";
  return null;
}

/** The Owner marks (or unmarks) a customer organization as a fictional test organization. */
export async function markTestOrganization(ctx: Pick<AppContext, "db" | "env">, actorUserId: string, organizationId: string, mark: boolean, confirmName: string): Promise<void> {
  assertSimulationAllowed(ctx.env);
  const org = await ctx.db.prepare(`SELECT id, name, kind, simulation_test_org FROM organizations WHERE id = ?`).bind(organizationId).first<{ id: string; name: string; kind: string; simulation_test_org: number }>();
  if (!org) throw new HttpError(404, "Organization not found.");
  if (org.kind !== "customer") throw new HttpError(409, "Only customer organizations can be test organizations.");
  if (confirmName.trim() !== org.name) throw new HttpError(422, `Type the organization's exact name (${org.name}) to confirm.`);
  if (mark) {
    const problem = await fictionalOrgProblem(ctx.db, organizationId);
    if (problem) throw new HttpError(409, `This organization cannot be marked as a test organization: ${problem}.`);
  }
  if (!!org.simulation_test_org === mark) return;
  await ctx.db.prepare(`UPDATE organizations SET simulation_test_org = ?, simulation_marked_by = ?, simulation_marked_at = ? WHERE id = ?`)
    .bind(mark ? 1 : 0, actorUserId, nowIso(), organizationId).run();
  await audit(ctx.db, { actorUserId, action: mark ? "payments.simulation_test_org_marked" : "payments.simulation_test_org_unmarked", subjectType: "organization", subjectId: organizationId, organizationId, details: { name: org.name } });
}

// ── the adapter: builds a deterministic synthetic event ──

interface InvoiceContext {
  invoice_id: string; amount_cents: number; status: string; organization_id: string; order_id: string | null;
  product_id: string | null; quote_version_id: string | null; simulation_test_org: number;
}

async function invoiceContext(db: Db, invoiceId: string): Promise<InvoiceContext | null> {
  return db.prepare(`SELECT i.id AS invoice_id, i.amount_cents, i.status, i.organization_id, i.order_id, o.product_id, o.quote_version_id, org.simulation_test_org
                     FROM invoices i JOIN organizations org ON org.id = i.organization_id LEFT JOIN orders o ON o.id = i.order_id WHERE i.id = ?`).bind(invoiceId).first<InvoiceContext>();
}

async function customerAdmin(db: Db, organizationId: string): Promise<string | null> {
  return (await db.prepare(`SELECT m.user_id FROM memberships m WHERE m.organization_id = ? AND m.role_id = 'customer_admin' ORDER BY m.user_id LIMIT 1`).bind(organizationId).first<{ user_id: string }>())?.user_id ?? null;
}

/** A quoted order's "package" is the accepted quote version (its product_id is only "custom" or empty). */
const packageRef = (c: InvoiceContext) => c.quote_version_id ? `quote_version:${c.quote_version_id}` : c.product_id ?? "none";

/**
 * Deterministic: the same invoice, correlation id, status, amount and currency always give the same event and
 * transaction ids, so re-sending an identical simulation is a duplicate delivery, never a second payment.
 * Overrides exist for negative tests (wrong amount or currency, failed payment).
 */
export async function createSimulatedEvent(db: Db, env: Pick<Env, "ENVIRONMENT">, invoiceId: string, opts: {
  correlationId: string; now?: Date; paymentStatus?: string; amountCents?: number; currency?: string;
}): Promise<SimulatedPaymentEvent> {
  const c = await invoiceContext(db, invoiceId);
  if (!c || !c.order_id) throw new HttpError(404, "Invoice not found, or it belongs to no order.");
  const customerId = await customerAdmin(db, c.organization_id);
  if (!customerId) throw new HttpError(409, "The organization has no customer administrator.");
  const status = opts.paymentStatus ?? SIMULATED_PAID;
  const amount = opts.amountCents ?? c.amount_cents;
  const currency = opts.currency ?? "usd";
  const seed = `${invoiceId}|${opts.correlationId}|${status}|${amount}|${currency}`;
  return {
    schema: SIMULATED_EVENT_SCHEMA, simulated: true,
    id: `evt_sim_${(await sha256Hex(`event|${seed}`)).slice(0, 24)}`,
    transactionId: `txn_sim_${(await sha256Hex(`txn|${seed}`)).slice(0, 24)}`,
    orderId: c.order_id, invoiceId, customerId, packageId: packageRef(c), amountCents: amount, currency, paymentStatus: status,
    timestamp: (opts.now ?? new Date()).toISOString(), environment: env.ENVIRONMENT, correlationId: opts.correlationId,
  };
}

// ── the confirmation entry point ──

const ID = /^[a-z]+_sim_[0-9a-f]{24}$/;

/** Pure-ish validation (reads only). Returns the outcome the event will be recorded with. */
async function evaluate(db: Db, env: Pick<Env, "ENVIRONMENT">, e: SimulatedPaymentEvent, now: Date): Promise<{ outcome: SimulationOutcome; reason: string | null; ctx: InvoiceContext | null }> {
  const reject = (reason: string, ctx: InvoiceContext | null = null) => ({ outcome: "rejected" as const, reason, ctx });
  if (e.schema !== SIMULATED_EVENT_SCHEMA || e.simulated !== true) return reject("not a simulated-payment event");
  if (!ID.test(e.id) || !e.id.startsWith("evt_sim_") || !ID.test(e.transactionId) || !e.transactionId.startsWith("txn_sim_")) return reject("malformed event or transaction id");
  if (e.environment !== env.ENVIRONMENT) return reject(`event is for environment "${e.environment}", this is "${env.ENVIRONMENT}"`);
  const ts = Date.parse(e.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now.getTime() - ts) > EVENT_TOLERANCE_SECONDS * 1000) return reject(`stale or replayed event: timestamp outside ${EVENT_TOLERANCE_SECONDS / 60} minutes`);
  const reused = await db.prepare(`SELECT id FROM simulated_payment_events WHERE transaction_id = ? AND id <> ? LIMIT 1`).bind(e.transactionId, e.id).first<{ id: string }>();
  if (reused) return reject(`replayed transaction: ${e.transactionId} was already delivered as ${reused.id}`);
  const c = await invoiceContext(db, e.invoiceId);
  if (!c) return reject("unknown invoice");
  if (c.order_id !== e.orderId) return reject("the invoice does not belong to that order", c);
  if (packageRef(c) !== e.packageId) return reject("the package does not match the order", c);
  if (!c.simulation_test_org) return reject("the organization is not a marked test organization; simulated payments can never pay a real customer's invoice", c);
  const problem = await fictionalOrgProblem(db, c.organization_id);
  if (problem) return reject(problem, c);
  const admin = await db.prepare(`SELECT 1 FROM memberships WHERE organization_id = ? AND user_id = ? AND role_id = 'customer_admin'`).bind(c.organization_id, e.customerId).first();
  if (!admin) return reject("the customer is not an administrator of the invoice's organization", c);
  if (e.currency !== "usd") return reject(`incorrect currency: ${e.currency} (invoices are in usd)`, c);
  if (!Number.isInteger(e.amountCents) || e.amountCents !== c.amount_cents) return reject(`incorrect amount: ${e.amountCents} cents, invoice is ${c.amount_cents} cents`, c);
  if (e.paymentStatus === SIMULATED_FAILED) return { outcome: "failed_payment", reason: "simulated payment failure", ctx: c };
  if (e.paymentStatus !== SIMULATED_PAID) return reject(`unknown payment status: ${String(e.paymentStatus).slice(0, 40)}`, c);
  if (c.status === "paid") return { outcome: "duplicate_order", reason: "the invoice is already paid; no second payment was recorded", ctx: c };
  if (c.status !== "open") return reject(`the invoice is ${c.status}; only open invoices can be paid`, c);
  return { outcome: "applied", reason: null, ctx: c };
}

/**
 * Delivers one synthetic event. Stored exactly once by event id: a duplicate delivery is acknowledged with the
 * original outcome and never re-applied. Only an "applied" outcome reaches confirmInvoicePayment.
 */
export async function deliverSimulatedEvent(ctx: Pick<AppContext, "db" | "env" | "email" | "baseUrl">, actorUserId: string, e: SimulatedPaymentEvent, now = new Date()): Promise<DeliveryResult> {
  assertSimulationAllowed(ctx.env);
  const db = ctx.db;
  const prior = await db.prepare(`SELECT outcome, reason FROM simulated_payment_events WHERE id = ?`).bind(String(e?.id ?? "")).first<{ outcome: SimulationOutcome; reason: string | null }>();
  if (prior) return { eventId: e.id, outcome: prior.outcome, reason: prior.reason, duplicateDelivery: true, projectId: null };
  let v = await evaluate(db, ctx.env, e, now);
  const payload = JSON.stringify(e).slice(0, 8000);
  const ins = await db.prepare(`INSERT INTO simulated_payment_events (id, transaction_id, order_id, invoice_id, organization_id, customer_id, package_id, amount_cents, currency, payment_status, environment, correlation_id, event_created_at, payload, outcome, reason, actor_user_id, received_at)
                                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(String(e.id).slice(0, 64), String(e.transactionId ?? "").slice(0, 64), e.orderId ?? null, e.invoiceId ?? null, v.ctx?.organization_id ?? null, e.customerId ?? null, e.packageId ?? null,
      Number.isInteger(e.amountCents) ? e.amountCents : null, String(e.currency ?? "").slice(0, 8), String(e.paymentStatus ?? "").slice(0, 40), String(e.environment ?? "").slice(0, 20),
      String(e.correlationId ?? "").slice(0, 100), String(e.timestamp ?? "").slice(0, 40), payload, v.outcome, v.reason, actorUserId, nowIso()).run();
  if (!ins.meta.changes) {
    const p = await db.prepare(`SELECT outcome, reason FROM simulated_payment_events WHERE id = ?`).bind(e.id).first<{ outcome: SimulationOutcome; reason: string | null }>();
    return { eventId: e.id, outcome: p?.outcome ?? v.outcome, reason: p?.reason ?? v.reason, duplicateDelivery: true, projectId: null };
  }
  let projectId: string | null = null;
  if (v.outcome === "applied") {
    try {
      const r = await confirmInvoicePayment(ctx, { provider: "simulated", eventId: e.id, transactionId: e.transactionId }, e.invoiceId,
        { amountCents: e.amountCents, paymentIntentId: null, chargeId: null }, null);
      projectId = r.projectId;
      if (r.alreadyPaid) v = { ...v, outcome: "duplicate_order", reason: "the invoice was paid meanwhile; no second payment was recorded" };
    } catch (err) {
      const msg = (err as Error).message;
      const ours = await db.prepare(`SELECT 1 FROM payments WHERE simulated_transaction_id = ?`).bind(e.transactionId).first();
      if (!ours && /UNIQUE constraint failed: payments\./i.test(msg)) {
        // Two different events for one invoice at the same moment: the unique index (one simulated payment per
        // invoice) rejects the second; its batch rolled back, so nothing of it was recorded.
        v = { ...v, outcome: "duplicate_order", reason: "a simulated payment for this invoice already exists; no second payment was recorded" };
      } else if (ours) {
        // The payment is recorded; a follow-up (provisioning, lead, build sync) failed. The sweep re-evaluates the build.
        v = { ...v, reason: `payment recorded; a follow-up step failed: ${msg.slice(0, 300)}` };
      } else {
        v = { outcome: "rejected", reason: `not applied: ${msg.slice(0, 300)}`, ctx: v.ctx };
      }
    }
    if (v.outcome !== "applied" || v.reason) await db.prepare(`UPDATE simulated_payment_events SET outcome = ?, reason = ? WHERE id = ?`).bind(v.outcome, v.reason, e.id).run();
  }
  await audit(db, { actorUserId, action: `payments.simulated_${v.outcome}`, subjectType: "invoice", subjectId: e.invoiceId ?? null, organizationId: v.ctx?.organization_id ?? null,
    details: { event: e.id, transaction: e.transactionId, amountCents: e.amountCents, currency: e.currency, status: e.paymentStatus, correlationId: e.correlationId, reason: v.reason } });
  return { eventId: e.id, outcome: v.outcome, reason: v.reason, duplicateDelivery: false, projectId };
}

// ── staff views ──

export interface SimulationEventRow { id: string; transaction_id: string; invoice_id: string | null; organization_id: string | null; amount_cents: number | null; currency: string | null; payment_status: string | null; outcome: SimulationOutcome; reason: string | null; correlation_id: string | null; received_at: string }
export async function recentSimulationEvents(db: Db, limit = 50): Promise<SimulationEventRow[]> {
  return (await db.prepare(`SELECT id, transaction_id, invoice_id, organization_id, amount_cents, currency, payment_status, outcome, reason, correlation_id, received_at FROM simulated_payment_events ORDER BY received_at DESC LIMIT ?`).bind(limit).all<SimulationEventRow>()).results;
}

export interface TestOrgInvoice { invoice_id: string; organization_id: string; organization_name: string; amount_cents: number; status: string; description: string | null; simulation_test_org: number }
/** Open invoices of customer organizations, test organizations first (the page shows which can be simulated). */
export async function simulationCandidates(db: Db, limit = 50): Promise<TestOrgInvoice[]> {
  return (await db.prepare(`SELECT i.id AS invoice_id, o.id AS organization_id, o.name AS organization_name, i.amount_cents, i.status, i.description, o.simulation_test_org
                            FROM invoices i JOIN organizations o ON o.id = i.organization_id WHERE o.kind = 'customer' AND i.status = 'open'
                            ORDER BY o.simulation_test_org DESC, i.created_at DESC LIMIT ?`).bind(limit).all<TestOrgInvoice>()).results;
}
