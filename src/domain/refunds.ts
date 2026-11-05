// Refund workflow (§24, PAY-007). Support reviews and routes; only the Founder (Owner) decides and issues
// discretionary refunds. AI and automation can never move a refund forward past review.
// FD-03 (Founder decision, 2026-11): development refunds are a Founder-controlled discretionary review based on
// completed work, approved costs, contract terms and legal obligations — there is no percentage schedule, and support
// can never deny a request (denial at any stage is a Founder decision).
// Mandatory legal / payment-network obligations are flagged and still require an owner decision
// record, but cannot be denied.
import { assertTransition } from "./state-machine.ts";
import { can, type Actor, ForbiddenError } from "./authz.ts";

export const REFUND_STATUSES = ["requested", "under_review", "recommended", "approved", "denied", "issued", "failed"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

const T: Record<RefundStatus, readonly RefundStatus[]> = {
  requested: ["under_review"],
  under_review: ["recommended", "denied"],
  recommended: ["approved", "denied"],
  approved: ["issued", "failed"],
  failed: ["issued"],
  denied: [],
  issued: [],
};

export function refundTransition(actor: Actor, from: RefundStatus, to: RefundStatus, opts: { mandatoryObligation?: boolean; notes?: string } = {}): void {
  assertTransition(T, from, to);
  if (actor.kind === "ai") throw new ForbiddenError("AI cannot act on refunds");
  if (to === "denied" && from === "under_review" && !can(actor, "refund.decide")) throw new ForbiddenError("Only the Founder can deny a refund request");
  if (to === "under_review" || to === "recommended" || (to === "denied" && from === "under_review")) {
    if (!can(actor, "refund.review")) throw new ForbiddenError("Refund review requires support permissions");
    if (!opts.notes?.trim()) throw new Error("Review notes are required");
    if (to === "denied" && opts.mandatoryObligation) throw new Error("A mandatory refund obligation cannot be denied at review");
    return;
  }
  if (to === "approved" || to === "denied") {
    if (!can(actor, "refund.decide")) throw new ForbiddenError("Only the Founder can decide refunds");
    if (to === "denied" && opts.mandatoryObligation) throw new Error("A mandatory refund obligation cannot be denied");
    return;
  }
  if (to === "issued" || to === "failed") {
    if (!can(actor, "refund.issue")) throw new ForbiddenError("Only the Founder can issue refunds");
  }
}
