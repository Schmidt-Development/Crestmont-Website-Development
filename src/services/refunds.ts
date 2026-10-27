// Refund workflow and disputes (§24, PAY-007, PAY-008). Every move goes through refundTransition()
// (src/domain/refunds.ts): support reviews and recommends; only the Owner decides and issues;
// AI/automation can never act. Every step is audited and the customer is notified of decisions.
import type { AppContext } from "../app/context.ts";
import type { Db } from "../lib/db.ts";
import { nowIso, newId } from "../lib/db.ts";
import { HttpError } from "../app/http.ts";
import { refundTransition, type RefundStatus, REFUND_STATUSES } from "../domain/refunds.ts";
import { ForbiddenError, type Actor } from "../domain/authz.ts";
import { TransitionError } from "../domain/state-machine.ts";
import { syncProjectBuildSafe } from "./builds.ts";
import { audit } from "./security.ts";
import { sendMail, templateContent } from "./mailer.ts";
import { NOT_CONFIGURED } from "./billing.ts";

export interface RefundRow {
  id: string; organization_id: string; org_name: string; payment_id: string; amount_cents: number; reason: string; evidence: string | null; status: RefundStatus;
  requested_by: string; requester_name: string; requester_email: string; reviewed_by: string | null; reviewer_name: string | null; review_notes: string | null;
  decided_by: string | null; decider_name: string | null; decided_at: string | null; decision_notes: string | null; mandatory_obligation: number;
  stripe_refund_id: string | null; customer_notified_at: string | null; created_at: string; issued_at: string | null; failure_reason: string | null;
  payment_amount_cents: number; payment_status: string; stripe_payment_intent_id: string | null; invoice_id: string | null;
}

const SELECT = `SELECT r.*, o.name AS org_name, u.display_name AS requester_name, u.email AS requester_email, rv.display_name AS reviewer_name, dc.display_name AS decider_name,
  p.amount_cents AS payment_amount_cents, p.status AS payment_status, p.stripe_payment_intent_id, p.invoice_id
  FROM refunds r JOIN organizations o ON o.id = r.organization_id JOIN users u ON u.id = r.requested_by JOIN payments p ON p.id = r.payment_id
  LEFT JOIN users rv ON rv.id = r.reviewed_by LEFT JOIN users dc ON dc.id = r.decided_by`;

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listRefunds(db: Db, status: string | undefined, page: { limit: number; offset: number }, q = "") {
  const conds: string[] = [], binds: unknown[] = [];
  if (status && (REFUND_STATUSES as readonly string[]).includes(status)) { conds.push("r.status = ?"); binds.push(status); }
  if (q) { const l = like(q); conds.push(`(o.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR r.reason LIKE ? ESCAPE '\\' OR r.id LIKE ? ESCAPE '\\' OR p.stripe_payment_intent_id LIKE ? ESCAPE '\\')`); binds.push(l, l, l, l, l); }
  return (await db.prepare(`${SELECT} ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} ORDER BY CASE r.status WHEN 'requested' THEN 0 WHEN 'under_review' THEN 1 WHEN 'recommended' THEN 2 WHEN 'approved' THEN 3 WHEN 'failed' THEN 4 ELSE 5 END, r.created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, page.limit + 1, page.offset).all<RefundRow>()).results;
}

export async function getRefund(db: Db, id: string): Promise<RefundRow> {
  const r = await db.prepare(`${SELECT} WHERE r.id = ?`).bind(id).first<RefundRow>();
  if (!r) throw new HttpError(404, "Refund request not found.");
  return r;
}

function guard(actor: Actor, from: RefundStatus, to: RefundStatus, opts: { mandatoryObligation?: boolean; notes?: string }) {
  try {
    refundTransition(actor, from, to, opts);
  } catch (e) {
    if (e instanceof ForbiddenError) throw new HttpError(403, e.message);
    if (e instanceof TransitionError) throw new HttpError(409, `A refund in "${from}" cannot move to "${to}".`);
    throw new HttpError(422, (e as Error).message);
  }
}

type RefundMail = { event: "under_review" } | { event: "denied" } | { event: "approved"; amountCents: number } | { event: "issued"; amountCents: number; reference: string };
async function notifyCustomer(ctx: AppContext, r: RefundRow, mail: RefundMail, key: string) {
  const data = { ...mail, url: `${ctx.baseUrl}/portal/billing` };
  await sendMail(ctx, { template: "refund_decision", to: r.requester_email, idempotencyKey: `refund:${r.id}:${key}`, data });
  const heading = templateContent({ template: "refund_decision", data }).heading;
  await ctx.db.prepare(`UPDATE refunds SET customer_notified_at = ? WHERE id = ?`).bind(nowIso(ctx.now), r.id).run();
  await ctx.db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(newId("ntf"), r.requested_by, "refund_update", "refund", r.id, heading, nowIso(ctx.now)).run();
}

/** Support review steps: requested→under_review, under_review→recommended|denied. */
export async function reviewRefund(ctx: AppContext, actor: Actor, id: string, to: RefundStatus, input: { notes: string; mandatoryObligation?: boolean }) {
  const r = await getRefund(ctx.db, id);
  const mandatory = input.mandatoryObligation ?? !!r.mandatory_obligation;
  if (!["under_review", "recommended", "denied"].includes(to) || (to === "denied" && r.status !== "under_review")) throw new HttpError(409, "Use the Founder decision for this step.");
  guard(actor, r.status, to, { notes: input.notes, mandatoryObligation: mandatory });
  const at = nowIso(ctx.now);
  const notes = [r.review_notes, `[${at.slice(0, 16).replace("T", " ")} ${to}] ${input.notes}`].filter(Boolean).join("\n");
  const res = await ctx.db.prepare(`UPDATE refunds SET status = ?, reviewed_by = ?, review_notes = ?, mandatory_obligation = ?${to === "denied" ? ", decided_at = ?, decided_by = ?" : ""} WHERE id = ? AND status = ?`)
    .bind(to, actor.userId ?? null, notes, mandatory ? 1 : 0, ...(to === "denied" ? [at, actor.userId ?? null] : []), id, r.status).run();
  if (res.meta.changes !== 1) throw new HttpError(409, "This refund changed while you were viewing it. Reload and try again.");
  await audit(ctx.db, { actorUserId: actor.userId, action: `refund.${to}`, subjectType: "refund", subjectId: id, organizationId: r.organization_id, details: { from: r.status, mandatoryObligation: mandatory } });
  if (to === "denied") {
    await notifyCustomer(ctx, r, { event: "denied" }, "denied");
  } else if (to === "under_review") {
    await notifyCustomer(ctx, r, { event: "under_review" }, "under_review");
  }
  if (to === "recommended") {
    const owners = (await ctx.db.prepare(`SELECT DISTINCT user_id FROM memberships WHERE role_id = 'owner'`).all<{ user_id: string }>()).results;
    for (const o of owners) await ctx.db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(newId("ntf"), o.user_id, "refund_recommended", "refund", id, `Refund of $${(r.amount_cents / 100).toFixed(2)} for ${r.org_name} awaits your decision.`, at).run();
  }
}

/** Founder decision: recommended→approved|denied. */
export async function decideRefund(ctx: AppContext, actor: Actor, id: string, to: "approved" | "denied", notes: string) {
  const r = await getRefund(ctx.db, id);
  guard(actor, r.status, to, { mandatoryObligation: !!r.mandatory_obligation, notes });
  if (!notes.trim()) throw new HttpError(422, "Record the reason for the decision.");
  const at = nowIso(ctx.now);
  const res = await ctx.db.prepare(`UPDATE refunds SET status = ?, decided_by = ?, decided_at = ?, decision_notes = ? WHERE id = ? AND status = ?`).bind(to, actor.userId ?? null, at, notes, id, r.status).run();
  if (res.meta.changes !== 1) throw new HttpError(409, "This refund changed while you were viewing it. Reload and try again.");
  await audit(ctx.db, { actorUserId: actor.userId, action: `refund.${to}`, subjectType: "refund", subjectId: id, organizationId: r.organization_id, details: { amountCents: r.amount_cents } });
  if (to === "approved") await syncBuildsForRefund(ctx.db, r.payment_id);
  await notifyCustomer(ctx, r, to === "approved" ? { event: "approved", amountCents: r.amount_cents } : { event: "denied" }, to);
}

/** Founder issues an approved refund through Stripe (approved|failed → issued|failed). */
export async function issueRefund(ctx: AppContext, actor: Actor, id: string) {
  const r = await getRefund(ctx.db, id);
  guard(actor, r.status, "issued", {});
  if (!ctx.payments.configured) throw new HttpError(409, `${NOT_CONFIGURED} The refund stays approved and can be issued once Stripe is connected; nothing was sent.`);
  if (!r.stripe_payment_intent_id) throw new HttpError(409, "This payment has no Stripe payment reference, so it cannot be refunded through Stripe.");
  const at = nowIso(ctx.now);
  let result: { id: string; status: string };
  try {
    result = await ctx.payments.createRefund(r.stripe_payment_intent_id, r.amount_cents, `refund:${r.id}`);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    if (r.status !== "failed") await ctx.db.prepare(`UPDATE refunds SET status = 'failed', failure_reason = ? WHERE id = ? AND status = ?`).bind(msg, id, r.status).run();
    else await ctx.db.prepare(`UPDATE refunds SET failure_reason = ? WHERE id = ?`).bind(msg, id).run();
    await audit(ctx.db, { actorUserId: actor.userId, action: "refund.failed", subjectType: "refund", subjectId: id, organizationId: r.organization_id, details: { error: msg } });
    throw new HttpError(502, `Stripe did not accept the refund: ${msg}`);
  }
  const failed = result.status === "failed" || result.status === "canceled";
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE refunds SET status = ?, stripe_refund_id = ?, issued_at = ?, failure_reason = ? WHERE id = ? AND status = ?`)
      .bind(failed ? "failed" : "issued", result.id, failed ? null : at, failed ? `Stripe status ${result.status}` : null, id, r.status),
    ...(failed ? [] : [ctx.db.prepare(`UPDATE payments SET status = ? WHERE id = ?`).bind(r.amount_cents >= r.payment_amount_cents ? "refunded" : "partially_refunded", r.payment_id)]),
  ]);
  await audit(ctx.db, { actorUserId: actor.userId, action: failed ? "refund.failed" : "refund.issued", subjectType: "refund", subjectId: id, organizationId: r.organization_id, details: { stripeRefundId: result.id, status: result.status, amountCents: r.amount_cents } });
  if (!failed) await syncBuildsForRefund(ctx.db, r.payment_id);
  if (!failed) await notifyCustomer(ctx, r, { event: "issued", amountCents: r.amount_cents, reference: result.id }, "issued");
  return { stripeRefundId: result.id, status: failed ? "failed" : "issued" };
}

/** An approved or issued refund makes the order ineligible for new automated build work (AI Builds). */
async function syncBuildsForRefund(db: AppContext["db"], paymentId: string | null) {
  if (!paymentId) return;
  const rows = (await db.prepare(`SELECT DISTINCT i.project_id FROM payments p JOIN invoices i ON i.order_id = p.order_id WHERE p.id = ? AND i.project_id IS NOT NULL`).bind(paymentId).all<{ project_id: string }>()).results;
  for (const x of rows) await syncProjectBuildSafe(db, x.project_id, "sweep");
}

/** Stripe dispute statuses that need no further action. */
export const DISPUTE_CLOSED = ["won", "lost", "closed", "warning_closed"] as const;
export type DisputeRow = { id: string; organization_id: string | null; org_name: string | null; payment_id: string | null; stripe_dispute_id: string; amount_cents: number; reason: string | null; status: string; evidence_due_by: string | null; created_at: string; updated_at: string; payment_amount_cents: number | null; invoice_id: string | null; stripe_payment_intent_id: string | null };

/** `state`: "open" (needs action), "closed", or "" for all. */
export async function listDisputes(db: Db, page: { limit: number; offset: number }, f: { state?: string; q?: string } = {}) {
  const conds: string[] = [], binds: unknown[] = [];
  const closed = `(${DISPUTE_CLOSED.map((s) => `'${s}'`).join(",")})`;
  if (f.state === "open") conds.push(`d.status NOT IN ${closed}`);
  if (f.state === "closed") conds.push(`d.status IN ${closed}`);
  if (f.q) { const l = like(f.q); conds.push(`(o.name LIKE ? ESCAPE '\\' OR d.stripe_dispute_id LIKE ? ESCAPE '\\' OR p.stripe_payment_intent_id LIKE ? ESCAPE '\\' OR d.reason LIKE ? ESCAPE '\\')`); binds.push(l, l, l, l); }
  return (await db.prepare(`SELECT d.*, o.name AS org_name, p.amount_cents AS payment_amount_cents, p.invoice_id, p.stripe_payment_intent_id FROM disputes d LEFT JOIN organizations o ON o.id = d.organization_id LEFT JOIN payments p ON p.id = d.payment_id
    ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} ORDER BY CASE WHEN d.status IN ${closed} THEN 1 ELSE 0 END, COALESCE(d.evidence_due_by, d.created_at) LIMIT ? OFFSET ?`).bind(...binds, page.limit + 1, page.offset)
    .all<DisputeRow>()).results;
}
