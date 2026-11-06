// Pre-purchase website intake (Founder requirement, 2026-11; SALES-004, PORTAL-002). The customer describes the
// website before paying: select package → intake → review scope and price → accept agreements → Stripe → fulfilment.
// The questions, conditional visibility, validation, draft/resume and partial-save behaviour are exactly those of
// project onboarding (ONBOARDING_SECTIONS, validateOnboarding, collectAnswers in ./onboarding.ts); only the record
// differs: purchase_intakes (migration 0089) is keyed by organization + package, or organization + accepted quote
// version, because no project exists yet. provisionProjectOnce (./commerce.ts) copies the completed intake into
// onboarding_responses when the paid order provisions its project. Completing an intake never queues a build: no
// project exists, and the build eligibility (./builds.ts) is evaluated only for projects.
import type { AppContext } from "../app/context.ts";
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { HttpError } from "../app/http.ts";
import { PACKAGES, type PackageId } from "../domain/catalog.ts";
import { audit } from "./security.ts";
import { collectAnswers, OnboardingError, type Answers } from "./onboarding.ts";

export interface PurchaseIntake {
  id: string; organization_id: string; product_id: string | null; quote_version_id: string | null; order_id: string | null; project_id: string | null;
  answers: Answers; completed_at: string | null; created_at: string; updated_at: string;
}
type Row = Omit<PurchaseIntake, "answers"> & { answers_json: string };

/** What the intake is for: a standard package, or the accepted quote version of one of the organization's orders. */
export type IntakeTarget = { kind: "package"; productId: PackageId } | { kind: "quote"; quoteVersionId: string };

const COLS = `id, organization_id, product_id, quote_version_id, order_id, project_id, answers_json, completed_at, created_at, updated_at`;

function parse(r: Row | null): PurchaseIntake | null {
  if (!r) return null;
  let answers: Answers = {};
  try { answers = JSON.parse(r.answers_json); } catch { /* keep empty */ }
  const { answers_json: _a, ...rest } = r; void _a;
  return { ...rest, answers };
}

/**
 * The intake for this target. For a package this is the OPEN intake (not yet consumed by a provisioned project), so a
 * later purchase of the same package starts afresh; for a quote version it is the one intake of that accepted version.
 */
export async function findIntake(db: Db, organizationId: string, target: IntakeTarget): Promise<PurchaseIntake | null> {
  if (target.kind === "package") {
    return parse(await db.prepare(`SELECT ${COLS} FROM purchase_intakes WHERE organization_id = ? AND product_id = ? AND project_id IS NULL`).bind(organizationId, target.productId).first<Row>());
  }
  return parse(await db.prepare(`SELECT ${COLS} FROM purchase_intakes WHERE organization_id = ? AND quote_version_id = ?`).bind(organizationId, target.quoteVersionId).first<Row>());
}

/** A completed intake that may still be bought against (not yet consumed by a project). */
export async function completedOpenIntake(db: Db, organizationId: string, target: IntakeTarget): Promise<PurchaseIntake | null> {
  const i = await findIntake(db, organizationId, target);
  return i && i.completed_at && !i.project_id ? i : null;
}

/** The quote order an accepted quote version belongs to, scoped to the organization (404 otherwise). */
export async function quoteOrderFor(db: Db, organizationId: string, quoteVersionId: string) {
  const o = await db.prepare(`SELECT o.id, o.status, o.product_id, qv.package_id FROM orders o JOIN quote_versions qv ON qv.id = o.quote_version_id
      WHERE o.quote_version_id = ? AND o.organization_id = ? AND o.kind = 'quote'`).bind(quoteVersionId, organizationId)
    .first<{ id: string; status: string; product_id: string | null; package_id: string | null }>();
  if (!o) throw new HttpError(404, "Order not found.");
  return o;
}

/** The product id the onboarding questions are filtered by (allFields): the package, or "custom" for custom work. */
export function intakeProductKey(target: IntakeTarget, quotePackageId: string | null = null): string {
  if (target.kind === "package") return target.productId;
  return quotePackageId && quotePackageId in PACKAGES ? quotePackageId : "custom";
}

/**
 * Save a draft or submit the pre-purchase intake. Same validation as project onboarding: a draft keeps whatever is
 * valid (and re-opens a completed intake until it is submitted again); a submit validates every visible required
 * question and marks the intake complete. Refused once a paid order has consumed the intake (it is then the
 * project's onboarding, changed through Messages).
 */
export async function savePurchaseIntake(ctx: AppContext, input: { organizationId: string; userId: string; target: IntakeTarget; form: FormData; submit: boolean }): Promise<{ completed: boolean; intakeId: string }> {
  const db = ctx.db;
  let productKey: string;
  let orderId: string | null = null;
  if (input.target.kind === "quote") {
    const o = await quoteOrderFor(db, input.organizationId, input.target.quoteVersionId);
    if (o.status !== "pending_payment") throw new OnboardingError(["The first invoice for this project is already paid. Send changes to your team through Messages."]);
    productKey = intakeProductKey(input.target, o.package_id);
    orderId = o.id;
  } else productKey = intakeProductKey(input.target);
  const existing = await findIntake(db, input.organizationId, input.target);
  if (existing?.project_id) throw new OnboardingError(["This intake is already part of a paid project. Send changes to your team through Messages."]);
  const { clean, errors } = await collectAnswers(ctx, { organizationId: input.organizationId, projectId: null, productId: productKey, userId: input.userId, existing: existing?.answers ?? null, form: input.form, submit: input.submit });
  const at = nowIso(ctx.now);
  let id = existing?.id ?? null;
  if (!id) {
    id = newId("pin");
    await db.prepare(`INSERT OR IGNORE INTO purchase_intakes (id, organization_id, product_id, quote_version_id, order_id, answers_json, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(id, input.organizationId, input.target.kind === "package" ? input.target.productId : null, input.target.kind === "quote" ? input.target.quoteVersionId : null, orderId, JSON.stringify(clean), input.userId, at, at).run();
    // A concurrent first save for the same target wins the unique index; continue with its row.
    id = (await findIntake(db, input.organizationId, input.target))!.id;
  }
  // Drafts persist whatever is valid even when the submit fails, so nothing typed is lost. Saving a draft re-opens a
  // completed intake: only a successful submit marks it complete again.
  const complete = input.submit && !errors.length;
  const upd = await db.prepare(`UPDATE purchase_intakes SET answers_json = ?, updated_at = ?, completed_at = ?, order_id = COALESCE(?, order_id) WHERE id = ? AND project_id IS NULL`)
    .bind(JSON.stringify(clean), at, complete ? at : null, orderId, id).run();
  if (upd.meta.changes !== 1) throw new OnboardingError(["This intake is already part of a paid project. Send changes to your team through Messages."]);
  if (errors.length) throw new OnboardingError(errors);
  await audit(db, { actorUserId: input.userId, action: complete ? "purchase_intake.completed" : "purchase_intake.draft_saved", subjectType: "purchase_intake", subjectId: id, organizationId: input.organizationId,
    details: input.target.kind === "package" ? { productId: input.target.productId } : { quoteVersionId: input.target.quoteVersionId, orderId } });
  return { completed: complete, intakeId: id };
}

/** Records which order a completed package intake is being bought with (checkout creates or reuses the order). */
export async function stampIntakeOrder(db: Db, intakeId: string, orderId: string): Promise<void> {
  await db.prepare(`UPDATE purchase_intakes SET order_id = ? WHERE id = ? AND project_id IS NULL`).bind(orderId, intakeId).run();
}
