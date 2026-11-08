// Audit events in plain English (Founder directive 2026-11-08, Phase 2.3 / 2.4). READ-ONLY presentation.
//
// The audit log itself is untouched (append-only; the database refuses updates and deletes). This module only turns a
// recorded event into words a non-technical employee understands -- who did what, to which record, when, and whether
// it worked -- and keeps the original event available for anyone who needs it.
//
// Rules: never invent. A record's name is shown only when it can be read from the database; an action is described
// specifically only when it is in the vocabulary below; anything else gets a safe generic description ("Recorded
// activity on a support ticket") with the raw event kept in the expandable details.
import type { Db } from "../lib/db.ts";

/** What kind of record each event family is about. */
const NOUN: Record<string, string> = {
  session: "their account", user: "a user account", employee: "an employee record", invitation: "an invitation", offboarding: "an employee's departure",
  project: "a project", task: "a task", milestone: "a milestone", revision: "a revision request", approval: "an approval", change_order: "a change order", scope: "a project scope",
  ticket: "a support ticket", support: "support", conversation: "a customer conversation", lead: "a lead", crm: "the CRM", quote: "a quote", research: "lead research",
  customer: "a customer account", portal: "the customer portal", onboarding: "a customer's onboarding", agreements: "an agreement", legal_hold: "a legal hold",
  invoice: "an invoice", payment: "a payment", refund: "a refund", dispute: "a payment dispute", order: "an order", checkout: "a checkout", finance: "finance records",
  finance_work: "a financial issue", reconciliation: "a payment discrepancy", project_cost: "a project cost", tax: "tax settings", pricing: "pricing", stripe: "Stripe",
  maintenance: "a maintenance plan", hosting: "website hosting", website_delivery: "a website delivery", builds: "a website build", release: "a website release",
  deployment: "a deployment", frontend_artifact: "a website file package", design_gallery: "the design gallery", design_locked_contract: "a design contract",
  design_baseline: "a design baseline", share_link: "a share link", file: "a file", email: "email", privacy: "a privacy request", retention: "data retention",
  security: "security settings", security_finding: "a security finding", backup: "a backup", report: "a report", readiness: "launch readiness", blocker: "a launch blocker",
  ai: "an AI draft", voice: "the AI receptionist", call: "a phone call", consultation: "an appointment", calendar: "a calendar", sales_outbound: "outbound AI calling",
  salesopt: "the sales script", assignment: "an assignment", time: "time records", settings: "business settings", integration: "an integration", ops: "operations",
};

/** Past-tense verb phrase for an event's last part. "{v}" is replaced by the noun. */
const VERB: Record<string, string> = {
  created: "created {n}", updated: "updated {n}", deleted: "deleted {n}", removed: "removed {n}", archived: "archived {n}", restored: "restored {n}",
  status_changed: "changed the status of {n}", stage_changed: "moved {n} to a new stage", assigned: "assigned {n}", reassigned: "reassigned {n}",
  approved: "approved {n}", rejected: "rejected {n}", accepted: "accepted {n}", declined: "declined {n}", cancelled: "cancelled {n}", canceled: "cancelled {n}",
  requested: "requested {n}", resolved: "resolved {n}", reopened: "reopened {n}", opened: "opened {n}", closed: "closed {n}", completed: "completed {n}",
  sent: "sent {n}", received: "received {n}", recorded: "recorded {n}", exported: "exported {n}", viewed: "viewed {n}", downloaded: "downloaded {n}",
  revoked: "revoked {n}", granted: "granted {n}", started: "started {n}", ended: "ended {n}", paid: "recorded payment of {n}", refunded: "refunded {n}",
  escalated: "escalated {n}", merged: "merged {n}", confirmed: "confirmed {n}", rescheduled: "rescheduled {n}", booked: "booked {n}", verified: "verified {n}",
  retried: "retried {n}", released: "released {n}", suspended: "suspended {n}", resumed: "resumed {n}", provisioned: "set up {n}", registered: "registered {n}",
  settings_updated: "changed the settings of {n}", profile_updated: "updated the profile of {n}", version_created: "saved a new version of {n}",
  failed: "could not complete an action on {n}", refused: "was refused an action on {n}", access_denied: "was refused access to {n}",
  internal_note: "added an internal note to {n}", staff_reply: "replied to {n}", customer_reply: "received a customer reply on {n}", triaged: "triaged {n}",
  ai_draft_requested: "asked AI to draft a reply for {n}", sla_breached: "missed the first-response target on {n}",
};

/** Exact wording for the events people look for most. [title, sentence ({a} = actor, {n} = record)]. */
const EXACT: Record<string, [string, string]> = {
  "session.created": ["Signed in", "{a} signed in to Crestmont."],
  "session.revoked": ["Signed out", "{a} signed out, or a session was ended."],
  "session.revoked_all": ["Signed out everywhere", "{a} ended all their other sessions."],
  "user.password_changed": ["Password changed", "{a} changed their password."],
  "user.password_reset": ["Password reset", "{a} reset a password using an emailed link."],
  "user.mfa_enabled": ["Two-step sign-in turned on", "{a} turned on two-step sign-in."],
  "user.mfa_reset": ["Two-step sign-in reset", "{a} reset two-step sign-in for an account."],
  "user.email_verified": ["Email address confirmed", "{a} confirmed their email address."],
  "user.email_changed": ["Email address changed", "{a} changed their sign-in email address."],
  "employee.removed": ["Employee removed", "{a} removed an employee; their access was revoked and open work was unassigned."],
  "employee.role_changed": ["Employee role changed", "{a} changed an employee's role."],
  "invitation.created": ["Employee invited", "{a} invited someone to join."],
  "ticket.created": ["Support request opened", "{a} opened a support request."],
  "ticket.staff_reply": ["Replied to a support request", "{a} replied to a customer support request."],
  "ticket.status_changed": ["Support request status changed", "{a} changed the status of a support request."],
  "ticket.assigned": ["Support request assigned", "{a} assigned a support request."],
  "project.status_changed": ["Project status changed", "{a} changed a project's status."],
  "project.pm_assigned": ["Project manager assigned", "{a} assigned a project manager."],
  "website_delivery.status_changed": ["Website delivery updated", "{a} updated a customer's website delivery status."],
  "invoice.paid": ["Invoice paid", "{a} recorded that an invoice was paid."],
  "payment.received": ["Payment received", "A payment was received."],
  "refund.requested": ["Refund requested", "{a} asked for a refund."],
  "refund.issued": ["Refund issued", "{a} issued a refund."],
  "dispute.opened": ["Payment disputed", "A customer's bank disputed a payment."],
  "lead.created": ["Lead created", "{a} created a lead."],
  "lead.assigned": ["Lead assigned", "{a} assigned a lead to a salesperson."],
  "lead.stage_changed": ["Lead stage changed", "{a} moved a lead to a new stage."],
  "quote.sent": ["Quote sent", "{a} sent a quote to a customer."],
  "quote.accepted": ["Quote accepted", "The customer accepted a quote."],
  "reconciliation.finding_resolved": ["Payment discrepancy resolved", "{a} marked a payment discrepancy as resolved."],
  "reconciliation.finding_recurred": ["Payment discrepancy came back", "A payment discrepancy that had been fixed was found again and re-opened."],
  "finance_work.assigned": ["Financial issue assigned", "{a} assigned a financial issue."],
  "audit.exported": ["Audit log exported", "{a} downloaded a copy of the audit log."],
  "email.suppression_removed": ["Email address unblocked", "{a} allowed email to an address that had bounced or complained."],
  "voice.config_activated": ["Receptionist configuration activated", "{a} activated a new AI receptionist configuration."],
  "builds.site_release_authorized": ["Website release authorized", "{a} authorized a website to go live."],
  "builds.site_release_blocked_by_launch_gate": ["Website launch stopped", "A website release was stopped because the launch requirements were not met."],
};

const FAILURE = /(^|_)(failed|failure|denied|refused|blocked|rejected|error|mismatch|breach|wrong_workspace|rate_limited|invalid|missed|abandoned)(_|$)/;

export interface DescribedEvent { title: string; sentence: string; outcome: "succeeded" | "failed"; record: string | null; translated: boolean }
export interface AuditLike { action: string; actor_kind: string; actor_name?: string | null; subject_type: string; subject_id: string | null; organization_id?: string | null; details_json?: string | null }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Plain-English description of one audit event. `names` comes from resolveAuditNames. */
export function describeAudit(a: AuditLike, names: AuditNames = { subjects: new Map(), orgs: new Map() }): DescribedEvent {
  const [prefix, ...rest] = a.action.split(".");
  const suffix = rest.join(".");
  const actor = a.actor_name ?? (a.actor_kind === "system" ? "The platform" : a.actor_kind === "webhook" ? "An automated provider event" : a.actor_kind === "ai" ? "The AI assistant" : "Someone");
  const noun = NOUN[prefix];
  let failed = FAILURE.test(suffix);
  try { const d = JSON.parse(a.details_json ?? "null") as { ok?: unknown } | null; if (d && d.ok === false) failed = true; } catch { /* details are not JSON */ }
  const subjectName = a.subject_id ? names.subjects.get(`${a.subject_type}:${a.subject_id}`) ?? null : null;
  const orgName = a.organization_id ? names.orgs.get(a.organization_id) ?? null : null;
  const record = subjectName ?? orgName;
  const exact = EXACT[a.action];
  if (exact) return { title: exact[0], sentence: exact[1].replace("{a}", actor).replace("{n}", noun ?? "a record"), outcome: failed ? "failed" : "succeeded", record, translated: true };
  const verb = VERB[suffix] ?? VERB[suffix.split(".").pop() ?? ""];
  if (noun && verb) {
    const phrase = verb.replace("{n}", noun);
    return { title: cap(phrase.replace(/^(\w+) (a|an|the) /, "$1 ")), sentence: `${actor} ${phrase}.`, outcome: failed ? "failed" : "succeeded", record, translated: true };
  }
  // Not confidently translatable: a safe generic description; the raw event stays in the details.
  if (failed) return { title: noun ? `Problem with ${noun}` : "System problem", sentence: noun ? `${actor} reported a problem with ${noun}.` : `${actor} reported a technical problem.`, outcome: "failed", record, translated: false };
  return { title: noun ? `Activity on ${noun}` : "System activity", sentence: noun ? `${actor} recorded activity on ${noun}.` : `${actor} recorded a technical event.`, outcome: failed ? "failed" : "succeeded", record, translated: false };
}

export interface AuditNames { subjects: Map<string, string>; orgs: Map<string, string> }

/** Readable names for the records a page of audit events refers to (only what the database actually holds). */
export async function resolveAuditNames(db: Db, rows: AuditLike[]): Promise<AuditNames> {
  const subjects = new Map<string, string>(), orgs = new Map<string, string>();
  const ids = (type: string) => [...new Set(rows.filter((r) => r.subject_type === type && r.subject_id).map((r) => r.subject_id!))].slice(0, 200);
  const load = async (type: string, sql: string, label: (r: { id: string; name: string | null }) => string | null) => {
    const list = ids(type);
    if (!list.length) return;
    for (const r of (await db.prepare(sql.replace("(?)", `(${list.map(() => "?").join(",")})`)).bind(...list).all<{ id: string; name: string | null }>()).results) {
      const v = label(r); if (v) subjects.set(`${type}:${r.id}`, v);
    }
  };
  await load("project", `SELECT id, name FROM projects WHERE id IN (?)`, (r) => (r.name ? `Project: ${r.name}` : null));
  await load("organization", `SELECT id, name FROM organizations WHERE id IN (?)`, (r) => (r.name ? `Customer: ${r.name}` : null));
  await load("user", `SELECT id, display_name AS name FROM users WHERE id IN (?)`, (r) => (r.name ? `Person: ${r.name}` : null));
  await load("lead", `SELECT l.id, c.name FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.id IN (?)`, (r) => (r.name ? `Lead: ${r.name}` : null));
  await load("ticket", `SELECT id, subject AS name FROM tickets WHERE id IN (?)`, (r) => (r.name ? `Support request: ${r.name}` : null));
  await load("invoice", `SELECT i.id, o.name FROM invoices i JOIN organizations o ON o.id = i.organization_id WHERE i.id IN (?)`, (r) => (r.name ? `Invoice for ${r.name}` : null));
  const orgIds = [...new Set(rows.map((r) => r.organization_id).filter((x): x is string => !!x))].slice(0, 200);
  if (orgIds.length) for (const r of (await db.prepare(`SELECT id, name FROM organizations WHERE id IN (${orgIds.map(() => "?").join(",")})`).bind(...orgIds).all<{ id: string; name: string }>()).results) orgs.set(r.id, `Customer: ${r.name}`);
  return { subjects, orgs };
}

/** Event families for the "Action" filter, in plain words, with the prefixes they cover. */
export const ACTION_GROUPS: { value: string; label: string; prefixes: string[] }[] = [
  { value: "signin", label: "Sign-ins and account security", prefixes: ["session", "user"] },
  { value: "people", label: "Employees and invitations", prefixes: ["employee", "invitation", "offboarding", "assignment"] },
  { value: "projects", label: "Projects, tasks and approvals", prefixes: ["project", "task", "milestone", "revision", "approval", "change_order", "scope", "onboarding"] },
  { value: "support", label: "Support and conversations", prefixes: ["ticket", "support", "conversation"] },
  { value: "sales", label: "Leads, quotes and sales", prefixes: ["lead", "crm", "quote", "research", "sales_outbound", "salesopt"] },
  { value: "money", label: "Payments, invoices and refunds", prefixes: ["invoice", "payment", "refund", "dispute", "order", "checkout", "finance", "finance_work", "reconciliation", "project_cost", "tax", "pricing", "stripe", "maintenance", "hosting"] },
  { value: "websites", label: "Website builds and delivery", prefixes: ["website_delivery", "builds", "release", "deployment", "frontend_artifact", "design_gallery", "design_locked_contract", "design_baseline", "share_link"] },
  { value: "voice", label: "AI receptionist and calls", prefixes: ["voice", "call", "consultation", "calendar"] },
  { value: "privacy", label: "Privacy, security and data", prefixes: ["privacy", "retention", "security", "security_finding", "backup", "legal_hold", "audit", "file", "email"] },
];

/** SQL condition for "only failures" / "only successes", matching describeAudit's rule on the action name. */
export const FAILURE_SQL = `(a.action LIKE '%failed%' OR a.action LIKE '%denied%' OR a.action LIKE '%refused%' OR a.action LIKE '%blocked%' OR a.action LIKE '%rejected%' OR a.action LIKE '%error%'
  OR a.action LIKE '%mismatch%' OR a.action LIKE '%breach%' OR a.action LIKE '%wrong_workspace%' OR a.action LIKE '%rate_limited%' OR a.action LIKE '%invalid%' OR a.action LIKE '%missed%' OR a.action LIKE '%abandoned%')`;
