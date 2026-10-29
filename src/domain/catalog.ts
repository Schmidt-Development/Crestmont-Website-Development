// Server-side source of truth for approved packages and pricing (§5–§7, CAT-*, SALES-001).
// The CMS may change how pricing is *presented*; it can never change these values.
// Changing a price here requires a Founder-approved change (CAT-007).

export type PackageId = "starter" | "business" | "premium";
export type MaintenanceId = "essential" | "professional" | "executive";
export type PaymentSchedule = "upfront" | "milestone_50_25_25";

export interface PackageDef {
  id: PackageId;
  name: string;
  basePriceCents: number;
  priceIsFloor: boolean;     // Premium is "$4,999+"
  pageLimit: number;
  revisionRounds: number;
  /** Every deliverable, in the package's own words — derived from PACKAGE_FEATURES (cumulative: Starter ⊆ Business ⊆ Premium).
   *  Used verbatim for contract scope text, proposals, build briefs and package cards. */
  includes: string[];
}

/** One capability and what each package includes of it. A string is the package's scope wording; `null` means not included.
 *  Packages are cumulative (Founder directive 2026-10-28): anything a lower tier includes, every higher tier includes too —
 *  at the same or a larger scope. tests/pricing-inheritance.test.ts enforces this. */
export interface PackageFeature {
  id: string;
  label: string;
  /** Plain-language explanation shown with the comparison row. */
  note: string;
  levels: Record<PackageId, string | null>;
}

const PKG_IDS: PackageId[] = ["starter", "business", "premium"];
const PAGE_LIMIT = { starter: 5, business: 12, premium: 25 } as const;
const REVISIONS = { starter: 2, business: 3, premium: 4 } as const;
const same = (s: string): Record<PackageId, string> => ({ starter: s, business: s, premium: s });

export const PACKAGE_FEATURES: readonly PackageFeature[] = Object.freeze([
  { id: "pages", label: "Pages", note: "The number of distinct pages designed and built. Larger Premium projects are scoped in writing.",
    levels: { starter: "Up to 5 pages", business: "Up to 12 pages", premium: "Up to 25 pages within approved scope" } },
  { id: "responsive", label: "Responsive website", note: "Layouts built and checked for phones, tablets and desktops.", levels: same("Responsive website") },
  { id: "design", label: "Design customization", note: "How far the design is tailored to your brand: expanded customization, or a bespoke premium design.",
    levels: { starter: null, business: "Expanded design customization", premium: "Bespoke premium design" } },
  { id: "layouts", label: "Advanced layouts and interactions", note: "Richer page compositions and interactive elements within the approved scope.",
    levels: { starter: null, business: null, premium: "Advanced layouts and interactions" } },
  { id: "content", label: "Content structure", note: "Planning of page hierarchy and content sections beyond a small brochure site.",
    levels: { starter: null, business: "More extensive content structure", premium: "More extensive content structure" } },
  { id: "copy", label: "AI-assisted draft copy", note: "Draft copy prepared with AI assistance for you to review and approve. Specialist copywriting is not included.", levels: same("AI-assisted draft copy") },
  { id: "imagery", label: "Licensed imagery", note: "Imagery that is appropriately licensed, or supplied by you.", levels: same("Appropriately licensed imagery") },
  { id: "forms", label: "Forms", note: "A contact form on every package; Business and Premium add advanced forms within the documented scope.",
    levels: { starter: "Contact form", business: "Contact form and advanced forms within documented scope", premium: "Contact form and advanced forms within documented scope" } },
  { id: "integrations", label: "Integrations", note: "Connections to third-party services named in your written scope; the third party's own fees are separate.",
    levels: { starter: null, business: "Defined integrations", premium: "Defined integrations" } },
  { id: "seo", label: "Technical SEO", note: "Titles, descriptions, sitemap and crawlability (Basic), with broader page-level work at Expanded and Enhanced. Rankings are never guaranteed.",
    levels: { starter: "Basic technical SEO", business: "Expanded technical SEO", premium: "Enhanced technical SEO" } },
  { id: "analytics", label: "Analytics", note: "Basic analytics configuration in an account owned by you.", levels: same("Basic analytics configuration") },
  { id: "performance", label: "Performance optimization", note: "Dedicated optimization of load speed and layout stability.",
    levels: { starter: null, business: null, premium: "Performance optimization" } },
  { id: "revisions", label: "Revision rounds", note: "Counted rounds of changes during the project; every round is recorded.",
    levels: { starter: `${REVISIONS.starter} revision rounds`, business: `${REVISIONS.business} revision rounds`, premium: `${REVISIONS.premium} revision rounds` } },
  { id: "approval", label: "Customer review and approval", note: "You review and approve milestones before work moves on.", levels: same("Customer review and approval") },
  { id: "launch", label: "Launch and handoff", note: "Deployment and handoff on every package, with enhanced onboarding (Business and Premium) and expanded project management and launch support (Premium).",
    levels: { starter: "Deployment and handoff", business: "Deployment, enhanced onboarding and handoff", premium: "Deployment, enhanced onboarding and handoff, with expanded project management and launch support" } },
] satisfies PackageFeature[]);

const includesFor = (id: PackageId) => PACKAGE_FEATURES.flatMap((f) => (f.levels[id] ? [f.levels[id]!] : []));

export const PACKAGES: Readonly<Record<PackageId, PackageDef>> = Object.freeze({
  starter: { id: "starter", name: "Starter", basePriceCents: 99_900, priceIsFloor: false, pageLimit: PAGE_LIMIT.starter, revisionRounds: REVISIONS.starter, includes: includesFor("starter") },
  business: { id: "business", name: "Business", basePriceCents: 249_900, priceIsFloor: false, pageLimit: PAGE_LIMIT.business, revisionRounds: REVISIONS.business, includes: includesFor("business") },
  premium: { id: "premium", name: "Premium", basePriceCents: 499_900, priceIsFloor: true, pageLimit: PAGE_LIMIT.premium, revisionRounds: REVISIONS.premium, includes: includesFor("premium") },
});

/** Items a package adds or upgrades compared with the tier below it (for "Everything in Business, plus" summaries). */
export function packageAdditions(id: PackageId): string[] {
  const i = PKG_IDS.indexOf(id);
  if (i <= 0) return [...PACKAGES[id].includes];
  const below = PKG_IDS[i - 1];
  return PACKAGE_FEATURES.flatMap((f) => (f.levels[id] && f.levels[id] !== f.levels[below] ? [f.levels[id]!] : []));
}

export interface MaintenanceDef {
  id: MaintenanceId;
  name: string;
  monthlyCents: number;
  /** Entitlements are PROPOSED and must not be published until Founder approval (CAT-006). */
  entitlementsStatus: "proposed_pending_founder_approval" | "approved";
  proposedEntitlements: Record<string, string>;
}

export const MAINTENANCE_PLANS: Readonly<Record<MaintenanceId, MaintenanceDef>> = Object.freeze({
  essential: {
    id: "essential", name: "Essential", monthlyCents: 9_900, entitlementsStatus: "proposed_pending_founder_approval",
    proposedEntitlements: {
      hosting: "Managed hosting for 1 site, up to 10 GB storage / 100 GB monthly transfer",
      labor: "Up to 1 hour/month maintenance labor (non-rolling)",
      contentUpdates: "Up to 2 small content updates/month (text or image swaps)",
      securityUpdates: "Monthly dependency and platform security updates",
      monitoring: "Uptime monitoring, 5-minute interval, email alerts",
      backups: "Weekly backups, 30-day retention",
      supportResponse: "Initial response within 2 business days during staffed hours",
      excluded: "New pages, new features, redesigns, third-party license fees",
      overage: "$95/hour billed in 30-minute increments with prior approval",
    },
  },
  professional: {
    id: "professional", name: "Professional", monthlyCents: 19_900, entitlementsStatus: "proposed_pending_founder_approval",
    proposedEntitlements: {
      hosting: "Managed hosting for 1 site, up to 25 GB storage / 250 GB monthly transfer",
      labor: "Up to 2.5 hours/month maintenance labor (non-rolling)",
      contentUpdates: "Up to 6 content updates/month",
      securityUpdates: "Bi-weekly dependency and platform security updates",
      monitoring: "Uptime + performance monitoring, 1-minute interval",
      backups: "Daily backups, 30-day retention",
      supportResponse: "Initial response within 1 business day during staffed hours",
      excluded: "New features beyond 2.5 hours, redesigns, third-party license fees",
      overage: "$90/hour billed in 30-minute increments with prior approval",
    },
  },
  executive: {
    id: "executive", name: "Executive", monthlyCents: 29_900, entitlementsStatus: "proposed_pending_founder_approval",
    proposedEntitlements: {
      hosting: "Managed hosting for up to 2 sites, up to 50 GB storage / 500 GB monthly transfer",
      labor: "Up to 4 hours/month maintenance labor (non-rolling)",
      contentUpdates: "Content updates within the 4-hour labor allowance",
      securityUpdates: "Weekly dependency and platform security updates",
      monitoring: "Uptime, performance and error monitoring, 1-minute interval",
      backups: "Daily backups, 90-day retention, quarterly restore test",
      supportResponse: "Initial response within 4 staffed hours",
      excluded: "Work beyond the labor allowance, redesigns, third-party license fees",
      overage: "$85/hour billed in 30-minute increments with prior approval",
    },
  },
});

export interface QuoteLine { description: string; amountCents: number }

export interface PriceBreakdown {
  packageId: PackageId | "custom";
  lines: QuoteLine[];
  totalCents: number;
  schedule: PaymentSchedule;
  installments: { kind: "full" | "deposit_50" | "design_25" | "prelaunch_25"; amountCents: number }[];
}

export class PricingError extends Error {}

/**
 * Compute an authoritative price. Standard packages are fixed-price and 100% upfront.
 * Premium may be quoted above its $4,999 floor (never below). Custom work uses
 * staff-authored quote lines and the 50/25/25 milestone schedule.
 */
export function priceQuote(input: { packageId: PackageId | "custom"; customLines?: QuoteLine[] }): PriceBreakdown {
  const custom = input.customLines ?? [];
  for (const l of custom) {
    if (!Number.isInteger(l.amountCents) || l.amountCents < 0) throw new PricingError("Line amounts must be non-negative integer cents");
    if (!l.description?.trim()) throw new PricingError("Every line needs a description");
  }

  if (input.packageId === "custom") {
    if (custom.length === 0) throw new PricingError("Custom quotes require at least one line item");
    const total = custom.reduce((s, l) => s + l.amountCents, 0);
    if (total <= 0) throw new PricingError("Custom quote total must be positive");
    return { packageId: "custom", lines: custom, totalCents: total, schedule: "milestone_50_25_25", installments: milestoneSplit(total) };
  }

  const pkg = PACKAGES[input.packageId];
  if (!pkg) throw new PricingError(`Unknown package ${String(input.packageId)}`);
  if (custom.length > 0 && !pkg.priceIsFloor) {
    throw new PricingError(`${pkg.name} is fixed-price; additional work requires a custom quote or change order`);
  }
  const lines: QuoteLine[] = [{ description: `${pkg.name} package`, amountCents: pkg.basePriceCents }, ...custom];
  const total = lines.reduce((s, l) => s + l.amountCents, 0);
  return { packageId: pkg.id, lines, totalCents: total, schedule: "upfront", installments: [{ kind: "full", amountCents: total }] };
}

/** 50/25/25 split; rounding remainder goes to the final installment so the sum is exact. */
export function milestoneSplit(totalCents: number): PriceBreakdown["installments"] {
  const deposit = Math.floor(totalCents * 0.5);
  const design = Math.floor(totalCents * 0.25);
  return [
    { kind: "deposit_50", amountCents: deposit },
    { kind: "design_25", amountCents: design },
    { kind: "prelaunch_25", amountCents: totalCents - deposit - design },
  ];
}

export const APPROVED_SERVICES = [
  "Website design and development", "Website redesign", "E-commerce development", "Custom web applications",
  "Customer and administrative portals", "Booking and scheduling systems", "Payment and subscription integrations",
  "AI chatbots and workflow automation", "AI receptionist voice agents (inbound and outbound calls)", "Hosting and maintenance", "API integrations", "Technical SEO",
  "Search Console and analytics setup", "Google Business Profile setup assistance for eligible businesses",
  "Conversion-focused landing pages", "Email automation infrastructure", "CRM integrations", "Website performance optimization",
] as const;

/** Phrases that must never appear in published marketing copy (§5, §12). */
export const PROHIBITED_CLAIMS = [
  /guarantee(d)?\s+(rank|ranking|leads|traffic|sales|results)/i,
  /#1\s+on\s+google/i,
  /social media management/i,
  /managed (ad|advertising) campaigns?/i,
  /24\/7\s+(human|live)\s+support/i,
  /only \d+ spots? left/i,
];

export function findProhibitedClaims(text: string): string[] {
  return PROHIBITED_CLAIMS.filter((re) => re.test(text)).map((re) => re.source);
}
