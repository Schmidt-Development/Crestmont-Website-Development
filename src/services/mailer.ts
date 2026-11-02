// Branded email template registry (EMAIL-002).
//
// One typed template per workflow. Each template owns its subject, heading, body copy and call to action;
// call sites pass DATA only (names, amounts, links) through sendMail(ctx, { template, to, data, idempotencyKey }).
// Every message is rendered through one Crestmont layout (header, body, footer with business identity) into
// HTML and plain text. Business identity comes from Business settings; anything not yet recorded renders as
// honest "pending" text — an address, legal name or contact email is never invented.
//
// Content rules: no passwords, no full card data, no internal notes. Links point back into the authenticated
// portal for details. Every interpolated value is escaped in the HTML part; subjects are single-line.
//
// Unsubscribe rule (EMAIL-003): every current template is transactional (account, project, billing,
// security), so no unsubscribe link is shown. A template marked "marketing" must be sent with an
// unsubscribe URL and the layout then adds the link; sending marketing mail without one is refused.
import { escapeHtml } from "../lib/html.ts";
import type { AppContext } from "../app/context.ts";
import type { Db } from "../lib/db.ts";

/**
 * The 20 workflows the master directive (§55) requires branded templates for, in directive order.
 * EMAIL_TEMPLATES adds the platform's other transactional workflows.
 */
/** A review deadline in Eastern time, e.g. "Monday, November 9 (end of day, Eastern)". */
const fmtDeadline = (iso: string) => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "the date shown in your portal"; // never crash a template on a malformed value
  return `${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" }).format(new Date(ms - 1000))} (end of day, Eastern)`;
};

export const REQUIRED_WORKFLOWS = [
  "registration", "verification", "purchase", "receipt", "onboarding", "project_update", "approval_request",
  "revision_update", "change_order", "invoice", "failed_payment", "subscription_update", "support_ticket",
  "support_reply", "refund_request", "refund_decision", "project_completion", "handoff", "security_notification",
  "critical_incident",
] as const;
export const EMAIL_TEMPLATES = [...REQUIRED_WORKFLOWS, "password_reset", "staff_invitation", "quote_sent", "lead_received", "lead_alert", "proposal_accepted", "dispute_opened", "consultation", "voice_escalation", "email_change_confirm", "voice_followup", "sales_info"] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];
export type MailCategory = "transactional" | "marketing";
export type Audience = "customer" | "staff" | "prospect" | "any";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const stage = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

// ───────────── Template data (what call sites pass) ─────────────
type ProjectBase = { projectName: string; url: string };
export interface TemplateData {
  /** Customer team invitation: the invitee registers into an existing organization. */
  registration: { inviterName: string; organizationName: string; acceptUrl: string };
  verification: { name: string | null; confirmUrl: string };
  /** Order confirmation (no call site yet: payment confirmation is sent as `receipt`). */
  purchase: { orderDescription: string; amountCents: number; url: string };
  receipt: { amountCents: number; next: "onboarding" | "billing"; url: string };
  onboarding: ProjectBase & { event: "completed" };
  project_update:
    | ProjectBase & { event: "status_changed"; from: string; to: string }
    | ProjectBase & { event: "paused"; note: string | null }
    | ProjectBase & { event: "resumed"; stage: string }
    | ProjectBase & { event: "cancelled" }
    | ProjectBase & { event: "inactivity_reminder"; days: number; stage: string; pauseAfterDays: number }
    | ProjectBase & { event: "message_from_team"; preview: string }
    | ProjectBase & { event: "message_from_customer"; preview: string }
    | ProjectBase & { event: "inactivity_escalation"; days: number; stage: string }
    | ProjectBase & { event: "preview_shared" }
    | ProjectBase & { event: "preview_reviewed"; decision: "approved" | "changes_requested"; note: string | null }
    | ProjectBase & { event: "site_released"; version: number; siteUrl: string | null }
    | ProjectBase & { event: "inactivity_paused"; days: number }
    | { event: "general_message_from_team"; preview: string; url: string }
    | { event: "general_message_from_customer"; organizationName: string; preview: string; url: string };
  approval_request:
    | ProjectBase & { event: "requested"; approval: string; note: string | null; respondBy?: string | null }
    | ProjectBase & { event: "overdue"; approval: string; respondBy: string }
    | ProjectBase & { event: "decided"; approval: string; decision: string; notes: string | null };
  revision_update:
    | ProjectBase & { event: "requested"; round: number; allowance: number }
    | ProjectBase & { event: "beyond_allowance"; allowance: number }
    | ProjectBase & { event: "delivered"; round: number; notes: string | null }
    | ProjectBase & { event: "accepted"; round: number }
    | ProjectBase & { event: "declined"; round: number; reason: string };
  change_order:
    | ProjectBase & { event: "proposed" }
    | ProjectBase & { event: "decided"; decision: string; invoiceIssued: boolean };
  /** `hostedInvoiceUrl`: the Stripe-hosted page of a finalized Stripe invoice (CREST-GAP-039); the call to action pays there. */
  invoice: ProjectBase & { milestone: string; hostedInvoiceUrl?: string | null };
  /** `kind`: "plan" = maintenance renewal (invoice.payment_failed); "checkout" = a delayed checkout payment failed (CREST-GAP-083). */
  failed_payment: { url: string; kind?: "plan" | "checkout" };
  subscription_update: { planName: string; status: string; url: string };
  support_ticket:
    | { event: "received"; name: string; subject: string; ticketRef: string; hoursNotice: string; url: string }
    | { event: "escalated"; subject: string; ticketRef: string; url: string }
    | { event: "assigned"; subject: string; ticketRef: string; priority: string; url: string }
    | { event: "sla_breached"; subject: string; ticketRef: string; targetHours: number; url: string };
  support_reply:
    | { event: "staff_replied"; name: string; subject: string; url: string }
    | { event: "customer_replied"; subject: string; url: string }
    | { event: "customer_reopened"; subject: string; url: string };
  refund_request: { amountCents: number; url: string };
  refund_decision:
    | { event: "under_review"; url: string }
    | { event: "denied"; url: string }
    | { event: "approved"; amountCents: number; url: string }
    | { event: "issued"; amountCents: number; reference: string; url: string };
  project_completion: ProjectBase;
  handoff: ProjectBase;
  security_notification: { event: "mfa_enabled" | "password_changed" | "password_reset_completed" | "deletion_requested" | "mfa_recovery_code_used" | "mfa_recovery_codes_regenerated" | "mfa_reset" | "sign_in_attempts" | "email_change_requested" | "email_changed" };
  /** Owner alert raised by the scheduled ops_alerts job (src/services/monitoring.ts#runOpsAlerts). */
  critical_incident: { summary: string; occurredAt: string; url: string };
  password_reset: { resetUrl: string };
  staff_invitation: { inviterName: string; roleLabel: string; acceptUrl: string };
  quote_sent: { contactName: string; totalCents: number; validUntil: string | null; proposalUrl: string };
  lead_received: { name: string; kind: "quote" | "contact" };
  /** Staff alert for a new web lead (CREST-GAP-005). */
  lead_alert: { kind: "quote" | "contact" | "lead"; name: string; company: string | null; interest: string | null; assigned: boolean; url: string };
  /** Confirmation of an accepted proposal, listing the exact agreement versions accepted (CREST-GAP-039). */
  proposal_accepted: { contactName: string; version: number; totalCents: number; firstInvoiceCents: number; agreements: string[]; url: string };
  /** Owner alert: a payment dispute was opened (CREST-GAP-039). */
  dispute_opened: { amountCents: number; evidenceDueBy: string | null; url: string };
  /** Consultation booked by phone with the AI receptionist (VOICE-003). `when` is pre-formatted in the business time zone. */
  consultation: { event: "requested" | "confirmed" | "rescheduled" | "cancelled"; name: string; when: string; code: string };
  /** Staff alert: the AI receptionist escalated a call that could not be transferred live (CREST-GAP-053). */
  voice_escalation: { reason: string; caller: string; why: "outside_hours" | "no_transfer" | "unavailable"; test: boolean; url: string };
  /** Sent to the NEW address of a requested account email change (CREST-GAP-073); the change applies only after confirmation. */
  email_change_confirm: { confirmUrl: string };
  /**
   * Requested by the caller during a call with the AI receptionist (send_customer_email / create_checkout_session).
   * Fixed wording only: the AI supplies the name and picks the kind; it can never write the body.
   */
  voice_followup:
    | { kind: "package_information"; name: string; packages: { name: string; price: string }[]; maintenance: { name: string; monthly: string }[]; url: string }
    | { kind: "checkout_link"; name: string; packageName: string; price: string; reference: string; url: string };
  /**
   * Sales email requested by a prospect on an outbound AI sales call (src/services/sales-functions.ts). Commercial, so
   * category "marketing": it always carries the unsubscribe link and postal address. Content is fixed per event; the
   * agent can never supply free text. Prices come from the server catalog / Founder-approved effective prices.
   */
  sales_info:
    | { event: "package_information"; name: string | null; packages: { name: string; price: string }[]; maintenanceNote: string; pricingUrl: string }
    | { event: "checkout_link"; name: string | null; packageName: string; price: string; url: string; expires: string }
    | { event: "follow_up"; name: string | null; when: string | null; url: string }
    | { event: "onboarding_instructions"; name: string | null; url: string };
}

export interface MailContent { subject: string; heading: string; paragraphs: string[]; cta?: { label: string; url: string } }
export interface TemplateDef<K extends EmailTemplate> {
  name: K;
  /** What the Founder sees in the preview catalogue. */
  description: string;
  category: MailCategory;
  audience: Audience;
  render(d: TemplateData[K]): MailContent;
  /** Sample data for the preview catalogue (labelled as preview data; never sent). */
  samples: TemplateData[K][];
}

const P = (d: { projectName: string }) => `Project: ${d.projectName}`;
const sampleProject = { projectName: "Sample Bakery — Business website", url: "https://example.com/portal/projects/prj_sample" };

export const TEMPLATES: { [K in EmailTemplate]: TemplateDef<K> } = {
  registration: {
    name: "registration", category: "transactional", audience: "customer",
    description: "Customer administrator invites a colleague to register into their organization.",
    render: (d) => ({
      subject: `${d.inviterName} invited you to ${d.organizationName} on Crestmont`, heading: `Join ${d.organizationName}`,
      paragraphs: [`${d.inviterName} invited you to collaborate on ${d.organizationName}'s website project with Crestmont Website Development.`, "This invitation expires in 7 days."],
      cta: { label: "Accept invitation", url: d.acceptUrl },
    }),
    samples: [{ inviterName: "Jordan Lee", organizationName: "Sample Bakery", acceptUrl: "https://example.com/invite?token=preview" }],
  },
  verification: {
    name: "verification", category: "transactional", audience: "any",
    description: "Email address confirmation after registration or on request.",
    render: (d) => ({
      subject: "Confirm your email — Crestmont", heading: "Confirm your email address",
      paragraphs: [...(d.name ? [`Hello ${d.name}, thank you for creating a Crestmont account.`] : []), "Confirm your email address to finish setting up your account. This link expires in 48 hours."],
      cta: { label: "Confirm email", url: d.confirmUrl },
    }),
    samples: [{ name: "Jordan Lee", confirmUrl: "https://example.com/verify-email?token=preview" }],
  },
  purchase: {
    name: "purchase", category: "transactional", audience: "customer",
    description: "Order confirmation. Not sent yet: payment confirmation currently goes out as the Receipt email.",
    render: (d) => ({
      subject: "Your Crestmont order", heading: "Your order is recorded",
      paragraphs: [`We recorded your order: ${d.orderDescription} (${money(d.amountCents)}).`, "Your order is confirmed when our payment processor confirms your payment. You will receive a receipt by email."],
      cta: { label: "View billing", url: d.url },
    }),
    samples: [{ orderDescription: "Business website package", amountCents: 250000, url: "https://example.com/portal/billing" }],
  },
  receipt: {
    name: "receipt", category: "transactional", audience: "customer",
    description: "Payment received (sent from the verified Stripe webhook only).",
    render: (d) => ({
      subject: "Payment received — Crestmont", heading: "Thank you — your payment was received",
      paragraphs: [`We received your payment of ${money(d.amountCents)}.`, d.next === "onboarding" ? "Your project is set up. The next step is onboarding, where you tell us about your business, brand and goals." : "Your project record has been updated."],
      cta: { label: d.next === "onboarding" ? "Start onboarding" : "View billing", url: d.url },
    }),
    samples: [{ amountCents: 250000, next: "onboarding", url: "https://example.com/portal/projects/prj_sample/onboarding" }, { amountCents: 62500, next: "billing", url: "https://example.com/portal/billing" }],
  },
  onboarding: {
    name: "onboarding", category: "transactional", audience: "staff",
    description: "Tells the project manager that the customer completed onboarding.",
    render: (d) => ({
      subject: "Customer onboarding completed", heading: "Customer onboarding completed",
      paragraphs: [P(d), "The customer submitted onboarding. The project is now in scope review."], cta: { label: "Open project", url: d.url },
    }),
    samples: [{ ...sampleProject, event: "completed" }],
  },
  project_update: {
    name: "project_update", category: "transactional", audience: "any",
    description: "Project status changes, inactivity notices and new messages (customer and staff versions).",
    render: (d) => {
      const portal = { label: "Open your portal", url: d.url }, staff = { label: "Open project", url: d.url };
      switch (d.event) {
        case "status_changed": return { subject: "Your project moved to a new stage", heading: "Your project moved to a new stage", paragraphs: [P(d), `Status changed from ${stage(d.from)} to ${stage(d.to)}.`], cta: portal };
        case "paused": return { subject: "Your project has been paused", heading: "Your project has been paused", paragraphs: [P(d), `Your project is paused${d.note ? `: ${d.note}` : ""}. Reply in your portal any time to restart it.`], cta: portal };
        case "resumed": return { subject: "Your project has restarted", heading: "Your project has restarted", paragraphs: [P(d), `Work has resumed. Current stage: ${stage(d.stage)}.`], cta: portal };
        case "cancelled": return { subject: "Your project was cancelled", heading: "Your project was cancelled", paragraphs: [P(d), "Your project has been cancelled. Your project manager will contact you about next steps."], cta: portal };
        case "inactivity_reminder": return { subject: "Your project is waiting on you", heading: "Your project is waiting on you",
          paragraphs: [P(d), `We have not heard from you in ${d.days} days. Your project is waiting at "${stage(d.stage)}". Under our inactivity policy, projects are paused after ${d.pauseAfterDays} days without a response; they are never cancelled automatically.`], cta: portal };
        case "message_from_team": return { subject: "New message from your Crestmont team", heading: "New message from your Crestmont team", paragraphs: [P(d), d.preview], cta: portal };
        case "message_from_customer": return { subject: "New customer message", heading: "New customer message", paragraphs: [P(d), d.preview], cta: staff };
        case "inactivity_escalation": return { subject: "Inactive customer project needs follow-up", heading: "Inactive customer project needs follow-up",
          paragraphs: [P(d), `${d.projectName} has had no customer activity for ${d.days} days (status: ${stage(d.stage)}). Please contact the customer.`], cta: staff };
        case "inactivity_paused": return { subject: "Project paused for inactivity", heading: "Project paused for inactivity", paragraphs: [P(d), `${d.projectName} was paused after ${d.days} days without customer activity.`], cta: staff };
        case "preview_shared": return { subject: "A private preview of your website is ready", heading: "A private preview of your website is ready",
          paragraphs: [P(d), "The preview is private: open it from your portal while signed in. Tell us there whether it is ready or what should change.", "A private preview of your website is ready for your review in your portal."], cta: portal };
        case "preview_reviewed": return { subject: d.decision === "approved" ? "Customer approved the website preview" : "Customer requested changes to the website preview",
          heading: d.decision === "approved" ? "Customer approved the website preview" : "Customer requested changes to the website preview",
          paragraphs: [P(d), `${d.projectName}: the customer ${d.decision === "approved" ? "approved the preview" : "requested changes"}${d.note ? `: ${d.note}` : "."}`], cta: staff };
        case "site_released": return { subject: "Your website update is live", heading: "Your website update is live",
          paragraphs: [P(d), `Version ${d.version} of your website was published and verified${d.siteUrl && /^https:\/\/[A-Za-z0-9.-]+(?:\/[^\s<>"']*)?$/.test(d.siteUrl) ? ` at ${d.siteUrl}` : ""}.`], cta: portal };
        case "general_message_from_team": return { subject: "New message from Crestmont", heading: "New message from Crestmont", paragraphs: [d.preview], cta: portal };
        case "general_message_from_customer": return { subject: `New general message from ${d.organizationName}`, heading: `New general message from ${d.organizationName}`, paragraphs: [d.preview], cta: { label: "Open conversation", url: d.url } };
      }
    },
    samples: [
      { ...sampleProject, event: "status_changed", from: "design", to: "development" },
      { ...sampleProject, event: "paused", note: "Waiting on content" },
      { ...sampleProject, event: "resumed", stage: "development" },
      { ...sampleProject, event: "cancelled" },
      { ...sampleProject, event: "inactivity_reminder", days: 14, stage: "customer_review", pauseAfterDays: 30 },
      { ...sampleProject, event: "message_from_team", preview: "We will start design next week." },
      { ...sampleProject, event: "message_from_customer", preview: "Here are the photos for the About page." },
      { ...sampleProject, event: "inactivity_escalation", days: 21, stage: "customer_review" },
      { ...sampleProject, event: "inactivity_paused", days: 30 },
      { ...sampleProject, event: "preview_shared" },
      { ...sampleProject, event: "preview_reviewed", decision: "changes_requested", note: "Please use our new logo." },
      { ...sampleProject, event: "site_released", version: 2, siteUrl: "https://www.example.com" },
      { event: "general_message_from_team", preview: "Thanks for your question about hosting.", url: "https://example.com/portal/messages/general" },
      { event: "general_message_from_customer", organizationName: "Sample Bakery", preview: "Do you also build online stores?", url: "https://example.com/staff/conversations/org_sample" },
    ],
  },
  approval_request: {
    name: "approval_request", category: "transactional", audience: "any",
    description: "Asks the customer for an approval; tells the team about the customer's decision.",
    render: (d) => d.event === "overdue"
      ? { subject: `Reminder: your review is waiting — ${d.approval}`, heading: `Your review is still waiting: ${d.approval}`, paragraphs: [P(d), `The review period ended ${fmtDeadline(d.respondBy)}. Nothing has been approved on your behalf — we wait for your decision. Please approve or tell us what to change.`], cta: { label: "Open your portal", url: d.url } }
      : d.event === "requested"
      ? { subject: `Your approval is needed: ${d.approval}`, heading: `Your approval is needed: ${d.approval}`, paragraphs: [P(d), d.note ?? `Please review and record your decision for: ${d.approval}.`, ...(d.respondBy ? [`Please respond by ${fmtDeadline(d.respondBy)} (five business days). We never treat silence as approval.`] : [])], cta: { label: "Open your portal", url: d.url } }
      : { subject: `Customer ${d.decision}: ${d.approval}`, heading: `Customer ${d.decision}: ${d.approval}`, paragraphs: [P(d), d.notes ?? `${d.approval} was ${d.decision}.`], cta: { label: "Open project", url: d.url } },
    samples: [{ ...sampleProject, event: "requested", approval: "Design", note: null, respondBy: "2026-11-09T04:59:59.999Z" }, { ...sampleProject, event: "overdue", approval: "Design", respondBy: "2026-11-09T04:59:59.999Z" }, { ...sampleProject, event: "decided", approval: "Design", decision: "approved", notes: null }],
  },
  revision_update: {
    name: "revision_update", category: "transactional", audience: "any",
    description: "Revision requested (team); request accepted or declined by the owner, and revision ready for review (customer).",
    render: (d) => {
      switch (d.event) {
        case "requested": return { subject: `Revision round ${d.round} requested`, heading: `Revision round ${d.round} requested`, paragraphs: [P(d), `Included round ${d.round} of ${d.allowance}.`], cta: { label: "Open project", url: d.url } };
        case "beyond_allowance": return { subject: "Revision beyond allowance — change order needed", heading: "Revision beyond allowance — change order needed",
          paragraphs: [P(d), `The customer has used all ${d.allowance} included rounds. Propose a change order with scope and price.`], cta: { label: "Open project", url: d.url } };
        case "delivered": return { subject: `Revision round ${d.round} is ready for review`, heading: `Revision round ${d.round} is ready for review`,
          paragraphs: [P(d), d.notes ?? "Your requested changes are ready. Review them and approve or ask for adjustments."], cta: { label: "Open your portal", url: d.url } };
        case "accepted": return { subject: `Revision round ${d.round} accepted`, heading: `Revision round ${d.round} accepted`,
          paragraphs: [P(d), `Revision round ${d.round} was accepted and work on it has started. We will let you know when it is ready for your review.`], cta: { label: "Open your portal", url: d.url } };
        case "declined": return { subject: `Revision request ${d.round} was not accepted`, heading: `Revision request ${d.round} was not accepted`,
          paragraphs: [P(d), "Reply in your portal if you have questions or want to submit a revised request.", `Revision request ${d.round} was not accepted: ${d.reason} It does not use one of your included rounds.`], cta: { label: "Open your portal", url: d.url } };
      }
    },
    samples: [{ ...sampleProject, event: "requested", round: 1, allowance: 3 }, { ...sampleProject, event: "beyond_allowance", allowance: 3 }, { ...sampleProject, event: "delivered", round: 1, notes: null },
      { ...sampleProject, event: "accepted", round: 2 }, { ...sampleProject, event: "declined", round: 3, reason: "This change is outside the agreed scope." }],
  },
  change_order: {
    name: "change_order", category: "transactional", audience: "any",
    description: "Change order proposed to the customer; customer decision to the team.",
    render: (d) => d.event === "proposed"
      ? { subject: "A change order needs your approval", heading: "A change order needs your approval", paragraphs: [P(d), "Proposed additional work. Review the scope and price, then approve or decline."], cta: { label: "Open your portal", url: d.url } }
      : { subject: `Change order ${d.decision}`, heading: `Change order ${d.decision}`, paragraphs: [P(d), `${d.projectName}: change order ${d.decision}${d.invoiceIssued ? " — invoice issued to the customer" : ""}.`], cta: { label: "Open project", url: d.url } },
    samples: [{ ...sampleProject, event: "proposed" }, { ...sampleProject, event: "decided", decision: "approved", invoiceIssued: true }],
  },
  invoice: {
    name: "invoice", category: "transactional", audience: "customer",
    description: "A new invoice is ready to pay.",
    render: (d) => ({
      subject: "A new invoice is ready", heading: "A new invoice is ready",
      paragraphs: [P(d), d.milestone === "design_25" ? "Your 25% design milestone invoice is ready to pay." : d.milestone === "prelaunch_25" ? "Your 25% pre-launch invoice is ready to pay." : d.milestone === "deposit_50" ? "Your 50% deposit invoice is ready to pay." : "Your invoice is ready to pay.",
        ...(d.hostedInvoiceUrl ? ["Pay securely on Stripe's invoice page with the button below. The invoice is also listed under Billing in your portal."] : [])],
      cta: d.hostedInvoiceUrl ? { label: "Pay invoice", url: d.hostedInvoiceUrl } : { label: "Open your portal", url: d.url },
    }),
    samples: [{ ...sampleProject, milestone: "design_25" }, { ...sampleProject, milestone: "deposit_50", hostedInvoiceUrl: "https://invoice.stripe.com/i/preview" }],
  },
  failed_payment: {
    name: "failed_payment", category: "transactional", audience: "customer",
    description: "A maintenance plan payment failed (from the verified Stripe webhook).",
    render: (d) => ({
      subject: "Action needed: payment failed", heading: "Your payment did not go through",
      paragraphs: d.kind === "checkout"
        ? ["Your recent payment could not be completed by your bank, so nothing was charged and your invoice is still open.", "You can pay again from Billing in your portal, using another payment method if needed."]
        : ["Your most recent maintenance plan payment failed. Please update your payment method to keep your plan active.", "Stripe will retry the payment automatically."],
      cta: { label: d.kind === "checkout" ? "Pay from your portal" : "Update payment method", url: d.url },
    }),
    samples: [{ url: "https://example.com/portal/billing" }, { url: "https://example.com/portal/billing/invoices/inv_preview", kind: "checkout" }],
  },
  subscription_update: {
    name: "subscription_update", category: "transactional", audience: "customer",
    description: "Maintenance plan status changed (from the verified Stripe webhook).",
    render: (d) => ({
      subject: `Your ${d.planName} plan: ${stage(d.status).toLowerCase()}`, heading: "Your maintenance plan changed",
      paragraphs: [`Your ${d.planName} maintenance plan is now ${stage(d.status).toLowerCase()}.`, "Manage your plan and payment method from Billing in your portal."],
      cta: { label: "View billing", url: d.url },
    }),
    samples: [{ planName: "Essential", status: "active", url: "https://example.com/portal/billing" }, { planName: "Essential", status: "canceled", url: "https://example.com/portal/billing" }],
  },
  support_ticket: {
    name: "support_ticket", category: "transactional", audience: "any",
    description: "Ticket received (customer); escalated, assigned and overdue notices (staff).",
    render: (d) => {
      const open = { label: "Open ticket", url: d.url };
      switch (d.event) {
        case "received": return { subject: `We received your request — ${d.subject}`, heading: "Your support request is recorded",
          paragraphs: [`Hello ${d.name}, we have recorded your request “${d.subject}” (reference ${d.ticketRef}).`, d.hoursNotice], cta: { label: "View your ticket", url: d.url } };
        case "escalated": return { subject: `Escalated ticket — ${d.subject}`, heading: "A support ticket was escalated",
          paragraphs: [`Ticket ${d.ticketRef} (“${d.subject}”) was escalated. Open it in the staff queue for details.`], cta: open };
        case "assigned": return { subject: `Ticket assigned to you — ${d.subject}`, heading: "A support ticket was assigned to you",
          paragraphs: [`Ticket ${d.ticketRef} (“${d.subject}”, ${d.priority} priority) is now assigned to you.`], cta: open };
        case "sla_breached": return { subject: `Response overdue — ${d.subject}`, heading: "A ticket has passed its first-response target",
          paragraphs: [`Ticket ${d.ticketRef} (“${d.subject}”) has had no staff response within the ${d.targetHours}-hour target.`], cta: open };
      }
    },
    samples: [
      { event: "received", name: "Jordan Lee", subject: "Contact form not sending", ticketRef: "tkt_sample", hoursNotice: "You can submit a ticket at any time — intake is open 24/7. Our team responds during staffed hours: (staffed hours from Business settings).", url: "https://example.com/portal/support/tkt_sample" },
      { event: "escalated", subject: "Contact form not sending", ticketRef: "tkt_sample", url: "https://example.com/staff/support/tkt_sample" },
      { event: "assigned", subject: "Contact form not sending", ticketRef: "tkt_sample", priority: "high", url: "https://example.com/staff/support/tkt_sample" },
      { event: "sla_breached", subject: "Contact form not sending", ticketRef: "tkt_sample", targetHours: 8, url: "https://example.com/staff/support/tkt_sample" },
    ],
  },
  support_reply: {
    name: "support_reply", category: "transactional", audience: "any",
    description: "Staff replied (customer); customer replied or reopened (assigned staff).",
    render: (d) => {
      switch (d.event) {
        case "staff_replied": return { subject: `Update on your request — ${d.subject}`, heading: "There is an update on your support request",
          paragraphs: [`Hello ${d.name}, a member of the Crestmont team replied to “${d.subject}”. Sign in to read the reply and respond.`], cta: { label: "Read the reply", url: d.url } };
        case "customer_replied": return { subject: `Customer replied on “${d.subject}”`, heading: `Customer replied on “${d.subject}”`, paragraphs: ["Open the ticket in the staff support queue to respond."], cta: { label: "Open ticket", url: d.url } };
        case "customer_reopened": return { subject: `Customer reopened “${d.subject}”`, heading: `Customer reopened “${d.subject}”`, paragraphs: ["Open the ticket in the staff support queue to respond."], cta: { label: "Open ticket", url: d.url } };
      }
    },
    samples: [
      { event: "staff_replied", name: "Jordan Lee", subject: "Contact form not sending", url: "https://example.com/portal/support/tkt_sample" },
      { event: "customer_replied", subject: "Contact form not sending", url: "https://example.com/staff/support/tkt_sample" },
      { event: "customer_reopened", subject: "Contact form not sending", url: "https://example.com/staff/support/tkt_sample" },
    ],
  },
  refund_request: {
    name: "refund_request", category: "transactional", audience: "customer",
    description: "Refund request received.",
    render: (d) => ({
      subject: "We received your refund request", heading: "Your refund request was received",
      paragraphs: [`We received your request to refund ${money(d.amountCents)}.`, "Our support team reviews every request and records the outcome. Discretionary refunds are decided by the Founder. You will receive an email when a decision is made."],
      cta: { label: "View billing", url: d.url },
    }),
    samples: [{ amountCents: 50000, url: "https://example.com/portal/billing" }],
  },
  refund_decision: {
    name: "refund_decision", category: "transactional", audience: "customer",
    description: "Refund under review, not approved, approved, and issued.",
    render: (d) => {
      const cta = { label: "View billing", url: d.url };
      switch (d.event) {
        case "under_review": return { subject: "Your refund request is under review", heading: "Your refund request is under review", paragraphs: ["Our support team has started reviewing your refund request. We will email you when a decision is made."], cta };
        case "denied": return { subject: "Update on your refund request", heading: "Update on your refund request", paragraphs: ["After review, your refund request was not approved.", "If you have more information, reply through a support ticket."], cta };
        case "approved": return { subject: "Your refund was approved", heading: "Your refund was approved", paragraphs: [`Your refund of ${money(d.amountCents)} was approved. We will send it to your original payment method and email you when it has been issued.`], cta };
        case "issued": return { subject: "Your refund has been issued", heading: "Your refund has been issued",
          paragraphs: [`We issued a refund of ${money(d.amountCents)} to your original payment method. Depending on your bank it can take 5–10 business days to appear.`, `Reference: ${d.reference}`], cta };
      }
    },
    samples: [
      { event: "under_review", url: "https://example.com/portal/billing" }, { event: "denied", url: "https://example.com/portal/billing" },
      { event: "approved", amountCents: 50000, url: "https://example.com/portal/billing" }, { event: "issued", amountCents: 50000, reference: "re_test_sample", url: "https://example.com/portal/billing" },
    ],
  },
  project_completion: {
    name: "project_completion", category: "transactional", audience: "customer",
    description: "The project is completed after final acceptance and a recorded deployment.",
    render: (d) => ({
      subject: "Your project is complete", heading: "Your project is complete",
      paragraphs: [P(d), "Your final acceptance is recorded and the project is complete. Your handoff documents stay available in your portal."],
      cta: { label: "Open your portal", url: d.url },
    }),
    samples: [sampleProject],
  },
  handoff: {
    name: "handoff", category: "transactional", audience: "customer",
    description: "The website handoff package is published for the customer.",
    render: (d) => ({
      subject: "Your website handoff is ready", heading: "Your website handoff is ready",
      paragraphs: [P(d), "Your website URL, documentation, access instructions, ownership records and training notes are ready. Review them and record your final acceptance."],
      cta: { label: "Open your portal", url: d.url },
    }),
    samples: [sampleProject],
  },
  security_notification: {
    name: "security_notification", category: "transactional", audience: "any",
    description: "Account security events: two-factor enabled, reset or recovery code used, recovery codes regenerated, password changed, deletion requested.",
    render: (d) => {
      switch (d.event) {
        case "mfa_enabled": return { subject: "Two-factor authentication enabled", heading: "Two-factor authentication is on",
          paragraphs: ["Two-factor authentication was enabled on your Crestmont account. If this was not you, reset your password immediately and contact support."] };
        case "password_changed": return { subject: "Your password was changed", heading: "Password changed",
          paragraphs: ["The password for your Crestmont account was changed and other sessions were signed out. If this was not you, reset your password now."] };
        case "password_reset_completed": return { subject: "Your password was reset", heading: "Password reset completed",
          paragraphs: ["The password for your Crestmont account was just reset using an emailed reset link, and every signed-in session was signed out.", "If this was not you, reset your password again immediately and contact support."] };
        case "mfa_recovery_code_used": return { subject: "A recovery code was used on your account", heading: "Recovery code used",
          paragraphs: ["One of your two-factor recovery codes was just used to verify a sign-in on your Crestmont account. That code no longer works.", "If this was not you, reset your password immediately and contact support. Otherwise, generate a new set of recovery codes from your account page."] };
        case "mfa_recovery_codes_regenerated": return { subject: "New two-factor recovery codes", heading: "Recovery codes replaced",
          paragraphs: ["A new set of two-factor recovery codes was generated for your Crestmont account. Every earlier recovery code stopped working.", "If this was not you, reset your password immediately and contact support."] };
        case "mfa_reset": return { subject: "Two-factor authentication was reset", heading: "Two-factor authentication reset",
          paragraphs: ["An administrator reset two-factor authentication on your Crestmont account and signed you out everywhere. You will set up a new authenticator the next time you sign in.", "If you did not ask for this, contact the Crestmont Owner immediately."] };
        case "sign_in_attempts": return { subject: "Repeated failed sign-ins on your account", heading: "Failed sign-in attempts",
          paragraphs: ["Several sign-in attempts with a wrong password were made for your Crestmont account. Your account is not locked: browsers you have signed in with before keep working, and new browsers must now pass a security check.", "If these attempts were not you, no action is needed unless you think your password is known — then reset it from the sign-in page."] };
        case "email_change_requested": return { subject: "Email address change requested", heading: "Email change requested",
          paragraphs: ["Someone signed in to your Crestmont account asked to change its email address. Nothing changes until the new address is confirmed from the link we sent to it.", "If this was not you, change your password now and contact support. Your current address keeps working."] };
        case "email_changed": return { subject: "Your account email address was changed", heading: "Email address changed",
          paragraphs: ["The email address on your Crestmont account was changed after the new address was confirmed. Sign-in and notifications now use the new address.", "If you did not make this change, contact support immediately."] };
        case "deletion_requested": return { subject: "We received your deletion request", heading: "Deletion request received",
          paragraphs: ["We received a request to delete your Crestmont account. A staff member will review it and confirm when it is complete.", "If you did not make this request, sign in and change your password, then contact support."] };
      }
    },
    samples: [{ event: "mfa_enabled" }, { event: "password_changed" }, { event: "password_reset_completed" }, { event: "deletion_requested" }, { event: "mfa_recovery_code_used" }, { event: "mfa_recovery_codes_regenerated" }, { event: "mfa_reset" }, { event: "sign_in_attempts" }, { event: "email_change_requested" }, { event: "email_changed" }],
  },
  critical_incident: {
    name: "critical_incident", category: "transactional", audience: "staff",
    description: "Owner alert from the scheduled ops_alerts job: dead-lettered Stripe events, new reconciliation findings, a stuck email queue, failing evidence feeds, repeated security events. Each item is sent once.",
    render: (d) => ({
      subject: `Critical incident: ${d.summary}`, heading: "Critical incident",
      paragraphs: [d.summary, `Detected ${d.occurredAt}. Follow the incident runbook and record actions in the monitoring page.`],
      cta: { label: "Open monitoring", url: d.url },
    }),
    samples: [{ summary: "Error rate above threshold on the customer portal", occurredAt: "2026-01-01 12:00 UTC", url: "https://example.com/staff/monitoring" }],
  },
  sales_info: {
    name: "sales_info", category: "marketing", audience: "prospect",
    description: "Information a prospect asked for on an outbound AI sales call: package overview, secure purchase link, follow-up note or onboarding steps after a verified payment.",
    render: (d) => {
      const hello = d.name ? `Hello ${d.name}, thank you for speaking with Crestmont Website Development.` : "Hello, thank you for speaking with Crestmont Website Development.";
      const notMe = "You are receiving this because you asked for it on a call with Crestmont's AI assistant. If that was not you, you can ignore this email or unsubscribe below.";
      switch (d.event) {
        case "package_information": return { subject: "Crestmont website packages", heading: "Our website packages",
          paragraphs: [hello, ...d.packages.map((p) => `${p.name}: ${p.price}`), "Custom development is quoted separately after a scoping conversation.", d.maintenanceNote,
            "Prices are fixed and paid upfront for standard packages. We do not offer discounts by phone and never guarantee rankings or launch dates.", notMe],
          cta: { label: "Compare packages", url: d.pricingUrl } };
        case "checkout_link": return { subject: `Your secure link for the ${d.packageName} package`, heading: `${d.packageName} package — secure checkout`,
          paragraphs: [hello, `The ${d.packageName} package is ${d.price}, paid upfront.`, "The link takes you to Crestmont's checkout. You will sign in or create an account with this email address, review and accept the Development Agreement, and pay on Stripe's secure page. We never take card details by phone or email.",
            `This link expires on ${d.expires}. Nothing is charged until you complete payment on Stripe.`, notMe],
          cta: { label: "Continue to secure checkout", url: d.url } };
        case "follow_up": return { subject: "Following up from your Crestmont call", heading: "Thanks for your time",
          paragraphs: [hello, d.when ? `As agreed, we will follow up ${d.when}.` : "As agreed, a member of our team will follow up.", "You can reply to this email with any questions in the meantime.", notMe],
          cta: { label: "Visit Crestmont", url: d.url } };
        case "onboarding_instructions": return { subject: "Next steps for your Crestmont website", heading: "Your payment is confirmed",
          paragraphs: [hello, "Stripe has confirmed your payment. Sign in to your Crestmont account to complete the onboarding questionnaire so we can start your project.", notMe],
          cta: { label: "Start onboarding", url: d.url } };
      }
    },
    samples: [
      { event: "package_information", name: "Morgan", packages: [{ name: "Starter", price: "$999" }, { name: "Business", price: "$2,499" }, { name: "Premium", price: "$4,999+" }], maintenanceNote: "Maintenance plans ($99, $199 and $299 per month) are being finalised; a team member will confirm what each includes.", pricingUrl: "https://example.com/pricing" },
      { event: "checkout_link", name: "Morgan", packageName: "Business", price: "$2,499", url: "https://example.com/buy/preview", expires: "November 7, 2026" },
      { event: "follow_up", name: null, when: "on Tuesday afternoon", url: "https://example.com" },
      { event: "onboarding_instructions", name: "Morgan", url: "https://example.com/portal" },
    ],
  },
  email_change_confirm: {
    name: "email_change_confirm", category: "transactional", audience: "customer",
    description: "Confirmation link sent to the new address when a customer changes their account email (the change applies only after confirmation).",
    render: (d) => ({
      subject: "Confirm your new email address — Crestmont", heading: "Confirm your new email address",
      paragraphs: ["Someone asked to use this address for their Crestmont account. If that was you, confirm within 48 hours to finish the change.", "If you did not ask for this, ignore this email; nothing changes."],
      cta: { label: "Confirm new email", url: d.confirmUrl },
    }),
    samples: [{ confirmUrl: "https://example.com/account/email/confirm?token=preview" }],
  },
  password_reset: {
    name: "password_reset", category: "transactional", audience: "any",
    description: "Password reset link.",
    render: (d) => ({
      subject: "Reset your Crestmont password", heading: "Reset your password",
      paragraphs: ["Someone asked to reset the password for this account. If that was you, use the link below within one hour.", "If you did not ask for this, you can ignore this email."],
      cta: { label: "Choose a new password", url: d.resetUrl },
    }),
    samples: [{ resetUrl: "https://example.com/password/reset?token=preview" }],
  },
  staff_invitation: {
    name: "staff_invitation", category: "transactional", audience: "staff",
    description: "Invitation to join the Crestmont team.",
    render: (d) => ({
      subject: "You're invited to Crestmont Website Development", heading: "Join the Crestmont team",
      paragraphs: [`${d.inviterName} invited you to join Crestmont Website Development as ${d.roleLabel}.`, "Accept within 7 days to choose your password. Two-factor authentication is required for all staff accounts."],
      cta: { label: "Accept invitation", url: d.acceptUrl },
    }),
    samples: [{ inviterName: "Owner", roleLabel: "Project manager", acceptUrl: "https://example.com/invite?token=preview" }],
  },
  quote_sent: {
    name: "quote_sent", category: "transactional", audience: "prospect",
    description: "Proposal ready for the prospect to review and accept.",
    render: (d) => ({
      subject: "Your Crestmont proposal", heading: "Your website proposal is ready",
      paragraphs: [`Hello ${d.contactName}, thank you for considering Crestmont Website Development.`,
        `Your proposal totals ${money(d.totalCents)}${d.validUntil ? ` and is valid until ${d.validUntil}` : ""}. Review the scope, line items and payment schedule at the link below.`,
        "To accept, you will sign in (or create an account) with this email address."],
      cta: { label: "Review proposal", url: d.proposalUrl },
    }),
    samples: [{ contactName: "Morgan Hale", totalCents: 480000, validUntil: "2026-12-31", proposalUrl: "https://example.com/q/preview" }],
  },
  lead_received: {
    name: "lead_received", category: "transactional", audience: "prospect",
    description: "Acknowledges a contact or quote request from the public site.",
    render: (d) => ({
      subject: d.kind === "quote" ? "We received your quote request — Crestmont" : "We received your message — Crestmont",
      heading: d.kind === "quote" ? "Your quote request is in" : "Your message is in",
      paragraphs: [`Hello ${d.name}, thank you for contacting Crestmont Website Development.`,
        d.kind === "quote" ? "A member of our team will review your project details and reply by email. If the work is feasible within our services, we will follow up with questions or a written quote." : "A member of our team will read your message and reply by email.",
        "If you did not send this request, you can ignore this email."],
    }),
    samples: [{ name: "Morgan Hale", kind: "quote" }, { name: "Morgan Hale", kind: "contact" }],
  },
  lead_alert: {
    name: "lead_alert", category: "transactional", audience: "staff",
    description: "Staff alert: a new lead arrived from the public site or the lead API.",
    render: (d) => ({
      subject: d.kind === "quote" ? "New quote request" : d.kind === "contact" ? "New contact message" : "New lead",
      heading: d.kind === "quote" ? "A new quote request arrived" : d.kind === "contact" ? "A new contact message arrived" : "A new lead arrived",
      paragraphs: [`From: ${d.name}${d.company ? `, ${d.company}` : ""}.`, `Interest: ${d.interest ?? "not stated"}.`,
        d.assigned ? "It was assigned to the default lead owner." : "It is not assigned yet. Assign an owner and reply from the CRM."],
      cta: { label: "Open lead", url: d.url },
    }),
    samples: [{ kind: "quote", name: "Morgan Hale", company: "Sample Bakery", interest: "business", assigned: false, url: "https://example.com/staff/crm/leads/ld_preview" }],
  },
  proposal_accepted: {
    name: "proposal_accepted", category: "transactional", audience: "customer",
    description: "Confirms an accepted proposal and lists the exact agreement versions accepted.",
    render: (d) => ({
      subject: `Proposal accepted — version ${d.version}`, heading: "Your proposal is accepted",
      paragraphs: [`Hello ${d.contactName}, thank you. You accepted proposal version ${d.version} for ${money(d.totalCents)}.`,
        `Your first invoice is ${money(d.firstInvoiceCents)}. Your project starts once that payment is confirmed.`,
        "You accepted these documents (exact versions are kept with your account under Agreements):", ...d.agreements],
      cta: { label: "Pay the first invoice", url: d.url },
    }),
    samples: [{ contactName: "Morgan Hale", version: 2, totalCents: 800000, firstInvoiceCents: 400000, agreements: ["Custom development agreement (draft) — version 2026-10-draft-1", "Terms of service — version 2026-10-draft-1"], url: "https://example.com/portal/billing/invoices/inv_preview" }],
  },
  dispute_opened: {
    name: "dispute_opened", category: "transactional", audience: "staff",
    description: "Owner alert: a customer opened a payment dispute (from the verified Stripe webhook).",
    render: (d) => ({
      subject: `Payment dispute opened — ${money(d.amountCents)}`, heading: "A payment dispute was opened",
      paragraphs: [`A customer disputed a payment of ${money(d.amountCents)}.`, d.evidenceDueBy ? `Evidence is due by ${d.evidenceDueBy}. Respond in Stripe before then.` : "Check the evidence deadline in Stripe."],
      cta: { label: "Open disputes", url: d.url },
    }),
    samples: [{ amountCents: 99900, evidenceDueBy: "2026-12-01", url: "https://example.com/staff/disputes" }],
  },
  consultation: {
    name: "consultation", category: "transactional", audience: "prospect",
    description: "Consultation requested, confirmed, rescheduled or cancelled (booked by phone with the AI receptionist).",
    render: (d) => {
      const ref = `Your booking reference is ${d.code}. Quote it, with the phone number you gave us, if you call to change the booking.`;
      const notMe = "If you did not book this consultation, you can ignore this email.";
      switch (d.event) {
        case "requested": return { subject: "Consultation request received — Crestmont", heading: "We received your consultation request",
          paragraphs: [`Hello ${d.name}, thank you for calling Crestmont Website Development.`, `We are holding ${d.when} for you. A team member will confirm the time by email.`, ref, notMe] };
        case "confirmed": return { subject: "Consultation confirmed — Crestmont", heading: "Your consultation is confirmed",
          paragraphs: [`Hello ${d.name}, your consultation with Crestmont Website Development is confirmed for ${d.when}.`, ref, notMe] };
        case "rescheduled": return { subject: "Consultation rescheduled — Crestmont", heading: "Your consultation has moved",
          paragraphs: [`Hello ${d.name}, your consultation is now ${d.when}.`, ref, notMe] };
        case "cancelled": return { subject: "Consultation cancelled — Crestmont", heading: "Your consultation is cancelled",
          paragraphs: [`Hello ${d.name}, your consultation for ${d.when} has been cancelled.`, "Call us or use the contact form if you would like to book another time.", notMe] };
      }
    },
    samples: [
      { event: "requested", name: "Morgan Hale", when: "Tuesday, November 3 at 10:00 AM EST", code: "K7MP4Q" },
      { event: "confirmed", name: "Morgan Hale", when: "Tuesday, November 3 at 10:00 AM EST", code: "K7MP4Q" },
      { event: "rescheduled", name: "Morgan Hale", when: "Thursday, November 5 at 2:30 PM EST", code: "R2WX9T" },
      { event: "cancelled", name: "Morgan Hale", when: "Tuesday, November 3 at 10:00 AM EST", code: "K7MP4Q" },
    ],
  },
  voice_escalation: {
    name: "voice_escalation", category: "transactional", audience: "staff",
    description: "Owner alert: the AI receptionist escalated a call and no live transfer was possible, so a callback task was created.",
    render: (d) => {
      const why = d.why === "outside_hours" ? "It is outside staffed hours, so the call could not be transferred."
        : d.why === "no_transfer" ? "No live-transfer number is configured, so the call could not be transferred."
        : "A live transfer was not available for this call.";
      return {
        subject: `${d.test ? "[TEST] " : ""}AI receptionist escalation — call back needed`, heading: "A caller needs a person",
        paragraphs: [`Reason given: ${d.reason}`, `Caller: ${d.caller}`, why, "A CRM task due within 4 hours was created on the caller's lead. Do not discuss account details until you have verified the caller's identity."],
        cta: { label: "Open the call", url: d.url },
      };
    },
    samples: [
      { reason: "Wants to discuss changing their contract", caller: "Morgan Hale, +15550100123", why: "outside_hours", test: false, url: "https://example.com/staff/voice/calls/call_sample" },
      { reason: "Asked for a person", caller: "Unknown caller", why: "no_transfer", test: true, url: "https://example.com/staff/voice/calls/call_sample" },
    ],
  },
  voice_followup: {
    name: "voice_followup", category: "transactional", audience: "prospect",
    description: "Sent only when a caller asks the AI receptionist for it during a call: published package prices, or a secure link to buy a package online. Fixed wording; the AI cannot change the text.",
    render: (d) => {
      const notMe = "You are receiving this because someone asked Crestmont's AI phone assistant to send it to this address. If that wasn't you, you can ignore this email; nothing else will be sent.";
      if (d.kind === "package_information") return {
        subject: "Crestmont website packages and prices", heading: "Our website packages",
        paragraphs: [`Hello ${d.name}, thank you for calling Crestmont Website Development. Here are our published prices.`,
          ...d.packages.map((p) => `${p.name}: ${p.price}`),
          ...(d.maintenance.length ? ["Maintenance plans (plan details are being finalised; a team member will confirm what each includes):", ...d.maintenance.map((m) => `${m.name}: ${m.monthly}`)] : []),
          "Standard packages are paid 100% upfront. Custom development is quoted separately after a scoping conversation.", notMe],
        cta: { label: "Compare packages", url: d.url },
      };
      return {
        subject: `Your secure link to buy the ${d.packageName} package`, heading: `${d.packageName} website package`,
        paragraphs: [`Hello ${d.name}, here is the secure link you asked for on your call with Crestmont Website Development.`,
          `Package: ${d.packageName}, ${d.price}, paid 100% upfront. Any sales tax is shown before you pay.`,
          "The link opens our website. You will sign in or create an account, confirm your email address and review the agreements before paying through Stripe's secure checkout. We never take card details by phone or email.",
          `Your checkout reference is ${d.reference}. If you call us to check whether your payment went through, we will ask for this reference and this email address.`, notMe],
        cta: { label: "Continue to secure checkout", url: d.url },
      };
    },
    samples: [
      { kind: "package_information", name: "Morgan Hale", packages: [{ name: "Starter", price: "$999" }, { name: "Business", price: "$2,499" }, { name: "Premium", price: "$4,999+" }], maintenance: [{ name: "Essential", monthly: "$99/month" }], url: "https://example.com/pricing" },
      { kind: "checkout_link", name: "Morgan Hale", packageName: "Business", price: "$2,499", reference: "K7MP4Q", url: "https://example.com/checkout/business" },
    ],
  },
};

// ───────────── Layout ─────────────
export interface MailIdentity { legalName: string | null; address: string | null; contactEmail: string | null }
export const IDENTITY_KEYS = ["business.legal_name", "business.address", "contact.email"] as const;
export const PENDING = {
  legalName: "Legal business name pending (entity not yet established)",
  address: "Registered business address pending",
  contactEmail: "Contact email pending",
} as const;

export function identityFrom(settings: Record<string, string>): MailIdentity {
  const v = (k: string) => settings[k]?.trim() || null;
  return { legalName: v("business.legal_name"), address: v("business.address"), contactEmail: v("contact.email") };
}

const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 250);
const httpUrl = (u: string) => (/^https?:\/\//i.test(u.trim()) ? u.trim() : "#");

export interface RenderedMail { subject: string; html: string; text: string }

/** Wraps template content in the Crestmont layout. Exported for tests and the preview catalogue. */
export function renderLayout(c: MailContent, opts: { category: MailCategory; identity: MailIdentity; unsubscribeUrl?: string }): RenderedMail {
  const id = opts.identity;
  const marketing = opts.category === "marketing";
  if (marketing && !opts.unsubscribeUrl) throw new Error("Marketing email requires an unsubscribe link");
  const p = c.paragraphs.map((x) => `<p style="margin:0 0 16px;line-height:1.6;color:#e8e4d8">${escapeHtml(x)}</p>`).join("");
  const cta = c.cta
    ? `<p style="margin:24px 0"><a href="${escapeHtml(httpUrl(c.cta.url))}" style="display:inline-block;background:#c9a54c;color:#0b0b0c;text-decoration:none;padding:12px 22px;border-radius:4px;font-weight:600">${escapeHtml(c.cta.label)}</a></p>`
    : "";
  const identityLines = [id.legalName ?? PENDING.legalName, id.address ?? PENDING.address, id.contactEmail ?? PENDING.contactEmail];
  const purpose = marketing ? "You are receiving this because you opted in to Crestmont updates." : "This is a transactional message about your account or project.";
  const unsub = marketing ? `<br><a href="${escapeHtml(httpUrl(opts.unsubscribeUrl!))}" style="color:#c9a54c">Unsubscribe</a>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(oneLine(c.subject))}</title></head><body style="margin:0;background:#0b0b0c;font-family:Georgia,serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#141416;border:1px solid #3a3222">
<tr><td style="padding:28px 32px;border-bottom:1px solid #3a3222;color:#c9a54c;font-size:20px;letter-spacing:.08em">CRESTMONT<span style="display:block;font-size:11px;letter-spacing:.2em;color:#8d887c;margin-top:4px">WEBSITE DEVELOPMENT</span></td></tr>
<tr><td style="padding:32px;font-family:Helvetica,Arial,sans-serif;font-size:15px">
<h1 style="margin:0 0 20px;font-family:Georgia,serif;font-weight:normal;color:#fff;font-size:24px">${escapeHtml(c.heading)}</h1>${p}${cta}
</td></tr>
<tr><td data-footer style="padding:20px 32px;border-top:1px solid #3a3222;color:#8d887c;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6">Crestmont Website Development<br>${identityLines.map(escapeHtml).join("<br>")}<br>${escapeHtml(purpose)}${unsub}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [c.heading, "", ...c.paragraphs, ...(c.cta ? ["", `${c.cta.label}: ${httpUrl(c.cta.url)}`] : []), "", "—",
    "Crestmont Website Development", ...identityLines, purpose, ...(marketing ? [`Unsubscribe: ${httpUrl(opts.unsubscribeUrl!)}`] : [])].join("\n");
  return { subject: oneLine(c.subject), html, text };
}

export type MailSpec = { [K in EmailTemplate]: { template: K; data: TemplateData[K] } }[EmailTemplate];

/** The template's content (subject, heading, paragraphs, call to action) before layout. */
export function templateContent(spec: MailSpec): MailContent {
  return (TEMPLATES[spec.template] as TemplateDef<EmailTemplate>).render(spec.data as never);
}

export function renderTemplate<K extends EmailTemplate>(template: K, data: TemplateData[K], identity: MailIdentity, unsubscribeUrl?: string): RenderedMail {
  const def = TEMPLATES[template] as TemplateDef<K>;
  return renderLayout(def.render(data), { category: def.category, identity, unsubscribeUrl });
}

async function loadIdentity(ctx: { db?: Db; settings?: Record<string, string> }): Promise<MailIdentity> {
  if (ctx.settings && Object.keys(ctx.settings).length) return identityFrom(ctx.settings);
  if (!ctx.db) return identityFrom({});
  try {
    const rows = (await ctx.db.prepare(`SELECT key, value FROM business_settings WHERE key IN (?,?,?)`).bind(...IDENTITY_KEYS).all<{ key: string; value: string }>()).results;
    return identityFrom(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  } catch { return identityFrom({}); }
}

export type SendMail = MailSpec & { to: string; idempotencyKey: string; unsubscribeUrl?: string };
export type MailerCtx = Pick<AppContext, "email"> & { db?: Db; settings?: Record<string, string> };

export async function sendMail(ctx: MailerCtx, m: SendMail) {
  const r = renderTemplate(m.template, m.data as never, await loadIdentity(ctx), m.unsubscribeUrl);
  return ctx.email.send({ to: m.to, subject: r.subject, html: r.html, text: r.text, template: m.template, idempotencyKey: m.idempotencyKey });
}
