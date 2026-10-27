// Project lifecycle, revisions, pauses and customer release approval (§25–§28).
import { assertTransition, TransitionError } from "./state-machine.ts";
import type { PaymentSchedule } from "./catalog.ts";

export const PROJECT_STATUSES = ["purchased", "awaiting_onboarding", "scope_review", "design", "development", "internal_qa",
  "customer_review", "revisions", "final_approval", "deployment", "completed", "maintenance", "paused", "cancelled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  purchased: ["awaiting_onboarding"],
  awaiting_onboarding: ["scope_review"],
  scope_review: ["design"],
  design: ["development", "customer_review"],
  development: ["internal_qa"],
  internal_qa: ["development", "customer_review"],
  customer_review: ["revisions", "final_approval"],
  revisions: ["internal_qa", "customer_review"],
  final_approval: ["deployment", "revisions"],
  deployment: ["completed"],
  completed: ["maintenance"],
  maintenance: [],
  paused: [],     // resume handled by resumeProject (returns to paused_from_status)
  cancelled: [],
};

const PAUSABLE: ProjectStatus[] = ["awaiting_onboarding", "scope_review", "design", "development", "internal_qa", "customer_review", "revisions", "final_approval"];

export function transitionProject(from: ProjectStatus, to: ProjectStatus): void {
  if (to === "paused") {
    if (!PAUSABLE.includes(from)) throw new TransitionError(from, to, "project cannot be paused from this status");
    return;
  }
  if (to === "cancelled") {
    // Cancellation is never automatic (§27); callers must pass through cancelProject with an actor.
    throw new TransitionError(from, to, "use cancelProject with an authorized actor and reason");
  }
  assertTransition(PROJECT_TRANSITIONS, from, to);
}

export function resumeProject(current: ProjectStatus, pausedFrom: ProjectStatus | null): ProjectStatus {
  if (current !== "paused" || !pausedFrom) throw new TransitionError(current, pausedFrom ?? "?", "project is not paused");
  return pausedFrom;
}

// ── Inactivity policy (PM-005) ──
export interface InactivityPolicy { remindAfterDays: number[]; escalateAfterDays: number; pauseAfterDays: number }
export const DEFAULT_INACTIVITY_POLICY: InactivityPolicy = { remindAfterDays: [7, 14], escalateAfterDays: 21, pauseAfterDays: 30 };

export type InactivityAction = { kind: "none" } | { kind: "remind"; reminder: number } | { kind: "escalate" } | { kind: "pause" };

/** Decides the next inactivity action. Never returns cancellation. */
export function inactivityAction(daysInactive: number, alreadySent: { reminders: number; escalated: boolean },
  policy: InactivityPolicy = DEFAULT_INACTIVITY_POLICY): InactivityAction {
  if (daysInactive >= policy.pauseAfterDays && alreadySent.escalated) return { kind: "pause" };
  if (daysInactive >= policy.escalateAfterDays && !alreadySent.escalated) return { kind: "escalate" };
  const due = policy.remindAfterDays.filter((d) => daysInactive >= d).length;
  if (due > alreadySent.reminders) return { kind: "remind", reminder: alreadySent.reminders + 1 };
  return { kind: "none" };
}

// ── Revisions (PM-002, PM-003) ──
export type RevisionDecision =
  | { kind: "included"; round: number; remainingAfter: number }
  | { kind: "change_order_required"; round: number };

export function decideRevision(allowance: number, usedRounds: number): RevisionDecision {
  const round = usedRounds + 1;
  if (usedRounds < allowance) return { kind: "included", round, remainingAfter: allowance - round };
  return { kind: "change_order_required", round };
}

// ── Customer website release approval (PM-006, §28, §23) ──
export const CUSTOMER_RELEASE_CHECKS = ["engineering_complete", "internal_qa", "security_accessibility", "customer_launch", "payment_verified", "deployment_authorized"] as const;
export type ReleaseCheck = (typeof CUSTOMER_RELEASE_CHECKS)[number];

export interface ReleaseContext {
  approvals: { kind: string; decision: "approved" | "rejected"; createdAt: string }[];
  schedule: PaymentSchedule;
  paidMilestones: string[];        // invoice milestone kinds with status=paid
  documentedPaymentException?: { approvedBy: "owner"; reason: string };
}

export function customerReleaseReadiness(ctx: ReleaseContext): { ready: boolean; missing: string[] } {
  const latest = new Map<string, { decision: string; createdAt: string }>();
  for (const a of ctx.approvals) {
    const prev = latest.get(a.kind);
    if (!prev || prev.createdAt <= a.createdAt) latest.set(a.kind, a);
  }
  const missing: string[] = [];
  for (const check of CUSTOMER_RELEASE_CHECKS) {
    if (check === "payment_verified") continue;
    if (latest.get(check)?.decision !== "approved") missing.push(check);
  }
  const required = ctx.schedule === "upfront" ? ["full"] : ["deposit_50", "design_25", "prelaunch_25"];
  const unpaid = required.filter((m) => !ctx.paidMilestones.includes(m));
  if (unpaid.length && !ctx.documentedPaymentException) missing.push(`payment:${unpaid.join(",")}`);
  return { ready: missing.length === 0, missing };
}

/** The design_25 invoice may only be issued once design is approved; prelaunch_25 once final launch approval exists. */
export function milestoneInvoiceAllowed(kind: "deposit_50" | "design_25" | "prelaunch_25", approvals: { kind: string; decision: string }[]): boolean {
  const ok = (k: string) => approvals.some((a) => a.kind === k && a.decision === "approved");
  if (kind === "deposit_50") return true;
  if (kind === "design_25") return ok("design");
  return ok("customer_launch");
}
