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
export const REQUIRED_WORKFLOWS = [
  "registration", "verification", "purchase", "receipt", "onboarding", "project_update", "approval_request",
  "revision_update", "change_order", "invoice", "failed_payment", "subscription_update", "support_ticket",
  "support_reply", "refund_request", "refund_decision", "project_completion", "handoff", "security_notification",
  "critical_incident",
] as const;
export const EMAIL_TEMPLATES = [...REQUIRED_WORKFLOWS, "password_reset", "staff_invitation", "quote_sent", "lead_received"] as const;
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
    | ProjectBase & { event: "inactivity_paused"; days: number }
    | { event: "general_message_from_team"; preview: string; url: string }
    | { event: "general_message_from_customer"; organizationName: string; preview: string; url: string };
  approval_request:
    | ProjectBase & { event: "requested"; approval: string; note: string | null }
    | ProjectBase & { event: "decided"; approval: string; decision: string; notes: string | null };
  revision_update:
    | ProjectBase & { event: "requested"; round: number; allowance: number }
    | ProjectBase & { event: "beyond_allowance"; allowance: number }
    | ProjectBase & { event: "delivered"; round: number; notes: string | null };
  change_order:
    | ProjectBase & { event: "proposed" }
    | ProjectBase & { event: "decided"; decision: string; invoiceIssued: boolean };
  invoice: ProjectBase & { milestone: string };
  failed_payment: { url: string };
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
  security_notification: { event: "mfa_enabled" | "password_changed" | "deletion_requested" | "mfa_recovery_code_used" | "mfa_recovery_codes_regenerated" | "mfa_reset" };
  /** Staff alert for a critical production incident (no automated incident source exists yet). */
  critical_incident: { summary: string; occurredAt: string; url: string };
  password_reset: { resetUrl: string };
  staff_invitation: { inviterName: string; roleLabel: string; acceptUrl: string };
  quote_sent: { contactName: string; totalCents: number; validUntil: string | null; proposalUrl: string };
  lead_received: { name: string; kind: "quote" | "contact" };
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
      { event: "general_message_from_team", preview: "Thanks for your question about hosting.", url: "https://example.com/portal/messages/general" },
      { event: "general_message_from_customer", organizationName: "Sample Bakery", preview: "Do you also build online stores?", url: "https://example.com/staff/conversations/org_sample" },
    ],
  },
  approval_request: {
    name: "approval_request", category: "transactional", audience: "any",
    description: "Asks the customer for an approval; tells the team about the customer's decision.",
    render: (d) => d.event === "requested"
      ? { subject: `Your approval is needed: ${d.approval}`, heading: `Your approval is needed: ${d.approval}`, paragraphs: [P(d), d.note ?? `Please review and record your decision for: ${d.approval}.`], cta: { label: "Open your portal", url: d.url } }
      : { subject: `Customer ${d.decision}: ${d.approval}`, heading: `Customer ${d.decision}: ${d.approval}`, paragraphs: [P(d), d.notes ?? `${d.approval} was ${d.decision}.`], cta: { label: "Open project", url: d.url } },
    samples: [{ ...sampleProject, event: "requested", approval: "Design", note: null }, { ...sampleProject, event: "decided", approval: "Design", decision: "approved", notes: null }],
  },
  revision_update: {
    name: "revision_update", category: "transactional", audience: "any",
    description: "Revision requested (team) and revision ready for review (customer).",
    render: (d) => {
      switch (d.event) {
        case "requested": return { subject: `Revision round ${d.round} requested`, heading: `Revision round ${d.round} requested`, paragraphs: [P(d), `Included round ${d.round} of ${d.allowance}.`], cta: { label: "Open project", url: d.url } };
        case "beyond_allowance": return { subject: "Revision beyond allowance — change order needed", heading: "Revision beyond allowance — change order needed",
          paragraphs: [P(d), `The customer has used all ${d.allowance} included rounds. Propose a change order with scope and price.`], cta: { label: "Open project", url: d.url } };
        case "delivered": return { subject: `Revision round ${d.round} is ready for review`, heading: `Revision round ${d.round} is ready for review`,
          paragraphs: [P(d), d.notes ?? "Your requested changes are ready. Review them and approve or ask for adjustments."], cta: { label: "Open your portal", url: d.url } };
      }
    },
    samples: [{ ...sampleProject, event: "requested", round: 1, allowance: 3 }, { ...sampleProject, event: "beyond_allowance", allowance: 3 }, { ...sampleProject, event: "delivered", round: 1, notes: null }],
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
      paragraphs: [P(d), d.milestone === "design_25" ? "Your 25% design milestone invoice is ready to pay." : d.milestone === "prelaunch_25" ? "Your 25% pre-launch invoice is ready to pay." : "Your invoice is ready to pay."],
      cta: { label: "Open your portal", url: d.url },
    }),
    samples: [{ ...sampleProject, milestone: "design_25" }],
  },
  failed_payment: {
    name: "failed_payment", category: "transactional", audience: "customer",
    description: "A maintenance plan payment failed (from the verified Stripe webhook).",
    render: (d) => ({
      subject: "Action needed: payment failed", heading: "Your payment did not go through",
      paragraphs: ["Your most recent maintenance plan payment failed. Please update your payment method to keep your plan active.", "Stripe will retry the payment automatically."],
      cta: { label: "Update payment method", url: d.url },
    }),
    samples: [{ url: "https://example.com/portal/billing" }],
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
        case "mfa_recovery_code_used": return { subject: "A recovery code was used on your account", heading: "Recovery code used",
          paragraphs: ["One of your two-factor recovery codes was just used to verify a sign-in on your Crestmont account. That code no longer works.", "If this was not you, reset your password immediately and contact support. Otherwise, generate a new set of recovery codes from your account page."] };
        case "mfa_recovery_codes_regenerated": return { subject: "New two-factor recovery codes", heading: "Recovery codes replaced",
          paragraphs: ["A new set of two-factor recovery codes was generated for your Crestmont account. Every earlier recovery code stopped working.", "If this was not you, reset your password immediately and contact support."] };
        case "mfa_reset": return { subject: "Two-factor authentication was reset", heading: "Two-factor authentication reset",
          paragraphs: ["An administrator reset two-factor authentication on your Crestmont account and signed you out everywhere. You will set up a new authenticator the next time you sign in.", "If you did not ask for this, contact the Crestmont Owner immediately."] };
        case "deletion_requested": return { subject: "We received your deletion request", heading: "Deletion request received",
          paragraphs: ["We received a request to delete your Crestmont account. A staff member will review it and confirm when it is complete.", "If you did not make this request, sign in and change your password, then contact support."] };
      }
    },
    samples: [{ event: "mfa_enabled" }, { event: "password_changed" }, { event: "deletion_requested" }, { event: "mfa_recovery_code_used" }, { event: "mfa_recovery_codes_regenerated" }, { event: "mfa_reset" }],
  },
  critical_incident: {
    name: "critical_incident", category: "transactional", audience: "staff",
    description: "Staff alert for a critical incident. Not sent yet: no automated incident source exists.",
    render: (d) => ({
      subject: `Critical incident: ${d.summary}`, heading: "Critical incident",
      paragraphs: [d.summary, `Detected ${d.occurredAt}. Follow the incident runbook and record actions in the monitoring page.`],
      cta: { label: "Open monitoring", url: d.url },
    }),
    samples: [{ summary: "Error rate above threshold on the customer portal", occurredAt: "2026-01-01 12:00 UTC", url: "https://example.com/staff/monitoring" }],
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
