// Navigation for the customer portal and the staff/owner command center (OWN-001).
// Simplified by the Founder's directive of 2026-11-08: fewer tabs, the same infrastructure. Pages taken out of the
// sidebar are listed in RETIRED_STAFF_PAGES with where their purpose now lives; their routes still answer.
// Visibility is a convenience only; every route enforces its own permission server-side.
import type { AppContext } from "../app/context.ts";
import type { NavGroup } from "../ui/layout.ts";

/**
 * The Owner command-center modules shown in the sidebar (OWN-001), after the Founder's simplification of 2026-11-08:
 * fewer tabs, the same infrastructure. Every module listed here must appear in the Owner's navigation.
 */
export const OWNER_MODULE_LABELS = ["CRM", "Sales", "Quotes", "Customers", "Projects", "Employees", "Support", "Refunds", "Disputes",
  "Revenue", "Subscriptions", "Invoices", "AI receptionist", "Email operations", "Portfolio", "Website CMS", "Integrations",
  "Audit logs", "Reports", "Business settings"] as const;

/**
 * Pages taken OUT of the sidebar by the Founder's directive of 2026-11-08, and where their everyday purpose now lives.
 * Removing a navigation entry never removes the service behind it: every route below still answers for the staff who
 * may use it (tests/navigation.test.ts proves it), its data and automation are untouched, and the technical ones are
 * listed under "Technical administration" on Business settings for the people who look after the platform.
 */
export const RETIRED_STAFF_PAGES: readonly { label: string; href: string; nowAt: string; technical: boolean }[] = [
  { label: "Executive overview", href: "/staff/owner", nowAt: "Actionable items appear in My Work; the figures stay in Revenue, Reports and each section", technical: true },
  { label: "Launch readiness", href: "/staff/readiness", nowAt: "Release safeguards run in GitHub workflows; the page stays available to administrators", technical: true },
  { label: "Engineering", href: "/staff/readiness/engineering", nowAt: "Technical administration", technical: true },
  { label: "Development", href: "/staff/readiness/env/development", nowAt: "Technical administration", technical: true },
  { label: "Staging", href: "/staff/readiness/env/staging", nowAt: "Technical administration", technical: true },
  { label: "Production", href: "/staff/readiness/env/production", nowAt: "Technical administration", technical: true },
  { label: "Tasks", href: "/staff/tasks", nowAt: "My Work (the All tasks tab); old links redirect there", technical: false },
  { label: "Profitability", href: "/staff/finance/profitability", nowAt: "Reports (costs are still recorded on each project and from Reports)", technical: false },
  { label: "Reconciliation & cost import", href: "/staff/finance/reconciliation", nowAt: "My Work (payment discrepancies to review)", technical: false },
  { label: "AI operations", href: "/staff/ai", nowAt: "AI sales optimization (monthly AI budget) and My Work (AI drafts to review)", technical: true },
  { label: "Artifact Builder", href: "/staff/builds/frontends", nowAt: "Technical administration (website delivery is under Website Delivery)", technical: true },
  { label: "Email suppressions", href: "/staff/email-suppressions", nowAt: "Email operations (suppressed addresses)", technical: false },
  { label: "Monitoring", href: "/staff/monitoring", nowAt: "Technical administration; alerts still notify the Owner", technical: true },
  { label: "Deployments", href: "/staff/ops", nowAt: "Technical administration; deployment workflows are unchanged", technical: true },
  { label: "Security", href: "/staff/security", nowAt: "Technical administration; data-deletion requests appear in My Work", technical: true },
  { label: "Backups", href: "/staff/backups", nowAt: "Technical administration; scheduled backups and checks keep running", technical: true },
];

export function portalNav(_ctx: AppContext): NavGroup[] {
  return [
    { label: "Overview", items: [{ href: "/portal", label: "Dashboard" }, { href: "/portal/projects", label: "Projects" }, { href: "/portal/notifications", label: "Notifications" }] },
    { label: "Collaborate", items: [{ href: "/portal/messages", label: "Messages" }, { href: "/portal/files", label: "Files" }, { href: "/portal/approvals", label: "Approvals" }] },
    { label: "Account", items: [{ href: "/portal/billing", label: "Billing" }, { href: "/portal/maintenance", label: "Maintenance" }, { href: "/portal/agreements", label: "Agreements" }, { href: "/portal/support", label: "Support" }, { href: "/portal/team", label: "Team" }, { href: "/account", label: "Profile & security" }, { href: "/account/privacy", label: "Privacy & your data" }] },
  ];
}

export function staffNav(_ctx: AppContext): NavGroup[] {
  return [
    { label: "Work", items: [
      { href: "/staff", label: "My work" },
      { href: "/staff/notifications", label: "Notifications" },
      { href: "/staff/reports/operations", label: "Operational reports" },
    ] },
    { label: "Sales", items: [
      { href: "/staff/crm", label: "CRM", perm: "crm.access" },
      { href: "/staff/research", label: "Lead research", perm: "lead.read_all" },
      { href: "/staff/sales", label: "Sales", perm: "crm.access" },
      { href: "/staff/quotes", label: "Quotes", perm: "quote.write" },
      { href: "/staff/pricing", label: "Pricing approvals", perm: "quote.write" },
      { href: "/staff/customers", label: "Customers", perm: "customers.read" },
      { href: "/staff/legal", label: "Agreements", perm: "customers.read" },
      { href: "/staff/conversations", label: "Conversations", perm: "customers.read" },
    ] },
    { label: "Delivery", items: [
      { href: "/staff/projects", label: "Projects", perm: "delivery.access" },
      // Hosted websites handed to existing customer projects. Its own tab, independent of the AI builders.
      { href: "/staff/website-delivery", label: "Website Delivery", perm: "website_delivery.manage" },
      { href: "/staff/employees", label: "Employees", perm: "employee.manage" },
    ] },
    { label: "Support", items: [
      { href: "/staff/support", label: "Support", perm: "support.access" },
      { href: "/staff/refunds", label: "Refunds", perm: "refund.review" },
      { href: "/staff/disputes", label: "Disputes", perm: "finance.read" },
    ] },
    { label: "Finance", items: [
      { href: "/staff/finance", label: "Revenue", perm: "finance.read" },
      { href: "/staff/finance/subscriptions", label: "Subscriptions", perm: "finance.read" },
      { href: "/staff/finance/invoices", label: "Invoices", perm: "finance.read" },
      { href: "/staff/reports", label: "Reports", perm: "finance.read" },
    ] },
    { label: "AI", items: [
      // AI operations and the Artifact Builder are retired from the navigation (RETIRED_STAFF_PAGES): the monthly AI
      // budget now lives in AI sales optimization, drafts to review appear in My Work, and every builder route, job and
      // record is untouched. The retired frontend-generation pipeline stays out of the navigation as before.
      { href: "/staff/voice", label: "AI receptionist", perm: "voice.manage" },
      { href: "/staff/calendars/ai-follow-up", label: "AI Follow-Up calendar", perm: "lead.read_all" },
      { href: "/staff/calendars/founder-callback", label: "Founder Callback calendar", perm: "voice.manage" },
      { href: "/staff/sales-optimization", label: "AI sales optimization", perm: "salesopt.read" },
    ] },
    { label: "Content", items: [
      { href: "/staff/cms", label: "Website CMS", perm: "cms.edit" },
      { href: "/staff/portfolio", label: "Portfolio", perm: "portfolio.manage" },
    ] },
    { label: "Platform", items: [
      { href: "/staff/email", label: "Email operations", perm: "settings.operational" },
      { href: "/staff/integrations", label: "Integrations", perm: "settings.operational" },
      { href: "/staff/audit", label: "Audit logs", perm: "audit.read" },
      { href: "/staff/settings", label: "Business settings", perm: "settings.operational" },
    ] },
  ];
}
