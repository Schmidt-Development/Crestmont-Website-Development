// Granular, server-enforced permissions (§29–§31, AUTH-007, AUTH-008, EMP-002).

export const STAFF_ROLES = ["owner", "administrator", "sales", "developer", "project_manager", "support"] as const;
export const CUSTOMER_ROLES = ["customer_admin", "customer_member"] as const;
export type Role = (typeof STAFF_ROLES)[number] | (typeof CUSTOMER_ROLES)[number];

export type Permission =
  | "lead.read_assigned" | "lead.read_all" | "lead.write_assigned" | "lead.write_all" | "lead.assign"
  | "quote.write" | "quote.send"
  | "project.read_assigned" | "project.read_all" | "project.coordinate" | "task.update_assigned" | "milestone.update"
  | "ticket.manage" | "ticket.internal_note" | "refund.review" | "refund.decide" | "refund.issue"
  | "settings.operational" | "pricing.change" | "release.approve_production" | "release.deploy_production"
  | "security.exception" | "cms.edit" | "cms.publish" | "portfolio.manage"
  | "finance.read" | "audit.read" | "readiness.read" | "readiness.ingest" | "employee.manage"
  | "customer.org.read" | "customer.org.write" | "customer.approve" | "customer.billing"
  // area access (navigation + list pages); record-level checks still apply inside each area
  | "crm.access" | "delivery.access" | "support.access" | "ai.manage" | "voice.manage" | "customers.read";

const OWNER_ONLY: Permission[] = ["refund.decide", "refund.issue", "pricing.change", "release.approve_production",
  "release.deploy_production", "security.exception"];

const ALL_STAFF: Permission[] = ["readiness.read"];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set<Permission>([
    "lead.read_all", "lead.write_all", "lead.assign", "quote.write", "quote.send", "project.read_all", "project.coordinate",
    "task.update_assigned", "milestone.update", "ticket.manage", "ticket.internal_note", "refund.review", "settings.operational",
    "cms.edit", "cms.publish", "portfolio.manage", "finance.read", "audit.read", "employee.manage",
    "crm.access", "delivery.access", "support.access", "ai.manage", "voice.manage", "customers.read", ...OWNER_ONLY, ...ALL_STAFF,
  ]),
  administrator: new Set<Permission>(["lead.read_all", "lead.assign", "project.read_all", "settings.operational", "cms.edit",
    "cms.publish", "portfolio.manage", "audit.read", "employee.manage", "crm.access", "delivery.access", "support.access",
    "ai.manage", "customers.read", ...ALL_STAFF]),
  sales: new Set<Permission>(["lead.read_assigned", "lead.write_assigned", "quote.write", "quote.send", "crm.access", "customers.read", ...ALL_STAFF]),
  developer: new Set<Permission>(["project.read_assigned", "task.update_assigned", "milestone.update", "delivery.access", ...ALL_STAFF]),
  project_manager: new Set<Permission>(["project.read_all", "project.coordinate", "milestone.update", "task.update_assigned",
    "ticket.internal_note", "delivery.access", "support.access", "customers.read", ...ALL_STAFF]),
  support: new Set<Permission>(["ticket.manage", "ticket.internal_note", "refund.review", "project.read_assigned", "support.access",
    "delivery.access", "customers.read", ...ALL_STAFF]),
  customer_admin: new Set<Permission>(["customer.org.read", "customer.org.write", "customer.approve", "customer.billing"]),
  customer_member: new Set<Permission>(["customer.org.read", "customer.org.write"]),
};

export interface Actor {
  kind: "user" | "ai" | "system" | "webhook";
  userId?: string;
  roles: { role: Role; organizationId: string }[];
  mfaVerified: boolean;
}

export class ForbiddenError extends Error {
  readonly status = 403;
}

const STAFF_MFA_REQUIRED = new Set<string>(STAFF_ROLES);

export function can(actor: Actor, perm: Permission, scope?: { organizationId?: string }): boolean {
  // AI agents and automation never hold Founder-protected permissions, whatever they claim (§8, §45, AIOPS-003).
  if (actor.kind !== "user" && OWNER_ONLY.includes(perm)) return false;
  for (const { role, organizationId } of actor.roles) {
    if (STAFF_MFA_REQUIRED.has(role) && !actor.mfaVerified) continue; // staff sessions without MFA get nothing
    if (!ROLE_PERMISSIONS[role].has(perm)) continue;
    const isCustomerRole = (CUSTOMER_ROLES as readonly string[]).includes(role);
    if (isCustomerRole && scope?.organizationId !== organizationId) continue; // tenant isolation
    return true;
  }
  return false;
}

export function require(actor: Actor, perm: Permission, scope?: { organizationId?: string }): void {
  if (!can(actor, perm, scope)) throw new ForbiddenError(`Missing permission ${perm}`);
}

export function isOwner(actor: Actor): boolean {
  return actor.kind === "user" && actor.mfaVerified && actor.roles.some((r) => r.role === "owner");
}
