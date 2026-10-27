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
  includes: string[];
}

export const PACKAGES: Readonly<Record<PackageId, PackageDef>> = Object.freeze({
  starter: {
    id: "starter", name: "Starter", basePriceCents: 99_900, priceIsFloor: false, pageLimit: 5, revisionRounds: 2,
    includes: ["Up to 5 pages", "Responsive website", "Basic technical SEO", "Contact form", "Basic analytics configuration",
      "AI-assisted draft copy", "Appropriately licensed imagery", "2 revision rounds", "Customer review and approval", "Deployment and handoff"],
  },
  business: {
    id: "business", name: "Business", basePriceCents: 249_900, priceIsFloor: false, pageLimit: 12, revisionRounds: 3,
    includes: ["Up to 12 pages", "Expanded design customization", "More extensive content structure", "Advanced forms within documented scope",
      "Defined integrations", "Expanded technical SEO", "3 revision rounds", "Enhanced onboarding and handoff"],
  },
  premium: {
    id: "premium", name: "Premium", basePriceCents: 499_900, priceIsFloor: true, pageLimit: 25, revisionRounds: 4,
    includes: ["Up to 25 pages within approved scope", "Bespoke premium design", "Advanced layouts and interactions", "Defined integrations",
      "Enhanced technical SEO", "Performance optimization", "4 revision rounds", "Expanded project management and launch support"],
  },
});

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
  "AI chatbots and workflow automation", "Hosting and maintenance", "API integrations", "Technical SEO",
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
