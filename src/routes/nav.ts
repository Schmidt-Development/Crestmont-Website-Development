// Navigation for the customer portal and the staff/owner command center (OWN-001).
// All 32 Owner modules from §34 are reachable, grouped so the sidebar stays usable.
// Visibility is a convenience only; every route enforces its own permission server-side.
import type { AppContext } from "../app/context.ts";
import type { NavGroup } from "../ui/layout.ts";

export function portalNav(_ctx: AppContext): NavGroup[] {
  return [
    { label: "Overview", items: [{ href: "/portal", label: "Dashboard" }, { href: "/portal/projects", label: "Projects" }] },
    { label: "Collaborate", items: [{ href: "/portal/messages", label: "Messages" }, { href: "/portal/files", label: "Files" }, { href: "/portal/approvals", label: "Approvals" }] },
    { label: "Account", items: [{ href: "/portal/billing", label: "Billing" }, { href: "/portal/agreements", label: "Agreements" }, { href: "/portal/support", label: "Support" }, { href: "/portal/team", label: "Team" }] },
  ];
}

export function staffNav(_ctx: AppContext): NavGroup[] {
  return [
    { label: "Work", items: [
      { href: "/staff", label: "My work" },
      { href: "/staff/owner", label: "Executive overview", perm: "finance.read" },
    ] },
    { label: "Launch readiness", items: [
      { href: "/staff/readiness", label: "Launch readiness", perm: "readiness.read" },
      { href: "/staff/readiness/engineering", label: "Engineering", perm: "readiness.read" },
      { href: "/staff/readiness/env/development", label: "Development", perm: "readiness.read" },
      { href: "/staff/readiness/env/staging", label: "Staging", perm: "readiness.read" },
      { href: "/staff/readiness/env/production", label: "Production", perm: "readiness.read" },
    ] },
    { label: "Sales", items: [
      { href: "/staff/crm", label: "CRM", perm: "crm.access" },
      { href: "/staff/sales", label: "Sales", perm: "crm.access" },
      { href: "/staff/quotes", label: "Quotes", perm: "quote.write" },
      { href: "/staff/pricing", label: "Pricing approvals", perm: "quote.write" },
      { href: "/staff/customers", label: "Customers", perm: "customers.read" },
      { href: "/staff/legal", label: "Agreements", perm: "customers.read" },
      { href: "/staff/conversations", label: "Conversations", perm: "customers.read" },
    ] },
    { label: "Delivery", items: [
      { href: "/staff/projects", label: "Projects", perm: "delivery.access" },
      { href: "/staff/tasks", label: "Tasks", perm: "delivery.access" },
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
      { href: "/staff/finance/profitability", label: "Profitability", perm: "finance.read" },
      { href: "/staff/finance/reconciliation", label: "Reconciliation", perm: "finance.read" },
      { href: "/staff/reports", label: "Reports", perm: "finance.read" },
    ] },
    { label: "AI", items: [
      { href: "/staff/ai", label: "AI operations", perm: "ai.manage" },
      { href: "/staff/voice", label: "AI receptionist", perm: "voice.manage" },
    ] },
    { label: "Content", items: [
      { href: "/staff/cms", label: "Website CMS", perm: "cms.edit" },
      { href: "/staff/portfolio", label: "Portfolio", perm: "portfolio.manage" },
    ] },
    { label: "Platform", items: [
      { href: "/staff/email", label: "Email operations", perm: "settings.operational" },
      { href: "/staff/email-suppressions", label: "Email suppressions", perm: "settings.operational" },
      { href: "/staff/integrations", label: "Integrations", perm: "settings.operational" },
      { href: "/staff/monitoring", label: "Monitoring", perm: "settings.operational" },
      { href: "/staff/security", label: "Security", perm: "audit.read" },
      { href: "/staff/audit", label: "Audit logs", perm: "audit.read" },
      { href: "/staff/backups", label: "Backups", perm: "settings.operational" },
      { href: "/staff/settings", label: "Business settings", perm: "settings.operational" },
    ] },
  ];
}
