// CRM pipeline (§20, CRM-003). "Reopened" is modelled as a transition back to `qualified`
// from a closed stage, recorded as a stage_change activity with kind "reopened".
import { assertTransition } from "./state-machine.ts";

export const LEAD_STAGES = ["new", "qualified", "quote_required", "quote_sent", "negotiation", "accepted",
  "awaiting_payment", "converted", "lost", "rejected", "archived"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

const CLOSABLE: LeadStage[] = ["lost", "rejected", "archived"];

export const LEAD_TRANSITIONS: Record<LeadStage, readonly LeadStage[]> = {
  new: ["qualified", ...CLOSABLE],
  qualified: ["quote_required", ...CLOSABLE],
  quote_required: ["quote_sent", "qualified", ...CLOSABLE],
  quote_sent: ["negotiation", "accepted", "quote_required", ...CLOSABLE],
  negotiation: ["quote_sent", "accepted", ...CLOSABLE],
  accepted: ["awaiting_payment", "negotiation", ...CLOSABLE],
  awaiting_payment: ["converted", "accepted", ...CLOSABLE],
  converted: ["archived"],
  lost: ["qualified", "archived"],      // reopen
  rejected: ["qualified", "archived"],  // reopen
  archived: ["qualified"],              // reopen
};

export function isReopen(from: LeadStage, to: LeadStage): boolean {
  return CLOSABLE.includes(from) && to === "qualified";
}

export function transitionLead(from: LeadStage, to: LeadStage, opts: { lostReason?: string; paymentConfirmedByWebhook?: boolean } = {}): void {
  assertTransition(LEAD_TRANSITIONS, from, to);
  if ((to === "lost" || to === "rejected") && !opts.lostReason?.trim()) {
    throw new Error(`A reason is required to mark a lead ${to}`);
  }
  if (to === "converted" && !opts.paymentConfirmedByWebhook) {
    // Browser redirects are never authoritative (§22); conversion is driven by verified webhooks.
    throw new Error("A lead converts only after a verified payment webhook");
  }
}
