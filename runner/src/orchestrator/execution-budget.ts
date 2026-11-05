// How much work one planning or review task is allowed, and how that work is divided into resumable segments.
//
// WHY. `ORCHESTRATOR_ADVISOR_MAX_TURNS` was one number -- 40 -- for every project, and reaching it destroyed the
// session: "the architect session did not return a valid JSON answer within 40 turns", everything read in those
// turns discarded. That is the wrong shape twice over. A seven-page Starter brochure and a twenty-five-page
// Premium site with authentication, payments and five user roles are not the same amount of thinking, and running
// out of turns while making progress is a reason to checkpoint and carry on, not a reason to fail.
//
// Two numbers, not one:
//   segmentTurns - how far the session runs before it preserves what it has and continues in a fresh segment.
//   totalTurns   - the ceiling across all segments. This is a real limit and it is enforced.
//
// Neither is unlimited. Local inference is free of API cost but not free: it occupies the GPU, and a session that
// inspects for ever while producing nothing is the failure this bounds, not a budget to be raised.

export type PackageId = "starter" | "business" | "premium" | "custom";

export interface ProjectComplexity {
  packageId: PackageId | string;
  /** Pages the brief actually asks for. */
  pages?: number;
  /** Distinct components or sections the design has to specify. */
  components?: number;
  /** Backend integrations in scope. */
  integrations?: number;
  /** Distinct user roles the site serves. */
  roles?: number;
  /** Does the site authenticate anyone? */
  auth?: boolean;
  /** Does it take payments? */
  payments?: boolean;
  /** Independent review tasks expected across the build. */
  reviewTasks?: number;
}

export interface Allowance {
  segmentTurns: number;
  totalTurns: number;
  /** Plain words for the build record: why this project gets this much. */
  reason: string;
}

/** The floor every project gets, whatever its package: below this nothing useful can be inspected and answered. */
export const MIN_SEGMENT_TURNS = 12;
/** A segment longer than this stops being a segment. Checkpoint and continue instead. */
export const MAX_SEGMENT_TURNS = 60;
/** The hard ceiling across all segments of one task, whatever the arithmetic below produces. */
export const MAX_TOTAL_TURNS = 400;

/** Base allowance per package, before the brief's own complexity is counted. */
const BASE: Record<PackageId, { segment: number; total: number }> = {
  starter: { segment: 20, total: 60 },
  business: { segment: 28, total: 120 },
  premium: { segment: 40, total: 240 },
  custom: { segment: 40, total: 300 },
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

/**
 * What this project is allowed, from what it actually asks for.
 *
 * The package sets the floor and the brief moves it: pages and components are what a design blueprint has to
 * describe, and integrations, roles, authentication and payments are what a functional plan has to reason about.
 */
export function allowanceFor(c: ProjectComplexity): Allowance {
  const pkg = (["starter", "business", "premium", "custom"] as const).includes(c.packageId as PackageId)
    ? (c.packageId as PackageId) : "business";
  const base = BASE[pkg];

  const pages = Math.max(0, c.pages ?? 0);
  const components = Math.max(0, c.components ?? 0);
  const integrations = Math.max(0, c.integrations ?? 0);
  const roles = Math.max(0, c.roles ?? 0);
  const reviewTasks = Math.max(0, c.reviewTasks ?? 0);

  // Each of these is work the session genuinely has to do, so each buys turns -- modestly, because inspection is
  // not the deliverable. A page is cheaper than an integration because a page is largely composition.
  const extra =
    pages * 1.5 +
    components * 0.75 +
    integrations * 3 +
    roles * 2 +
    (c.auth ? 4 : 0) +
    (c.payments ? 4 : 0) +
    reviewTasks * 1;

  const segment = clamp(base.segment + extra * 0.35, MIN_SEGMENT_TURNS, MAX_SEGMENT_TURNS);
  const total = clamp(base.total + extra * 2, segment, MAX_TOTAL_TURNS);

  const drivers = [
    pages ? `${pages} page(s)` : "",
    components ? `${components} component(s)` : "",
    integrations ? `${integrations} integration(s)` : "",
    roles ? `${roles} role(s)` : "",
    c.auth ? "authentication" : "",
    c.payments ? "payments" : "",
  ].filter(Boolean);

  return {
    segmentTurns: segment,
    totalTurns: total,
    reason: `${pkg} package: ${segment} turns per segment, ${total} across the task`
      + (drivers.length ? ` (${drivers.join(", ")})` : " (no complexity signals in the brief)"),
  };
}

/**
 * Pull the complexity signals out of a build brief without caring about its exact shape.
 *
 * Briefs differ between packages and have gained fields over time; a planner that throws because one is missing
 * would be worse than one that plans from what it can see. Everything here is optional and defaults to absent.
 */
export function complexityFromBrief(brief: unknown, packageId: string): ProjectComplexity {
  const b = (brief ?? {}) as Record<string, unknown>;
  const customer = (b.customerData ?? {}) as Record<string, unknown>;
  const pkg = (b.package ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const fn = arr(customer.functionality).map((x) => String(x).toLowerCase());

  return {
    packageId: String(pkg.id ?? packageId ?? "business"),
    pages: arr(customer.pages).length || undefined,
    components: arr(customer.components).length || undefined,
    integrations: arr(customer.integrations).length || undefined,
    roles: arr(customer.roles).length || undefined,
    auth: fn.some((f) => /auth|login|account|portal|member/.test(f)) || undefined,
    payments: fn.some((f) => /payment|checkout|ecommerce|store|subscription/.test(f)) || undefined,
  };
}
