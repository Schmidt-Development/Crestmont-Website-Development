// Repository defaults for the public service pages (WEB-002, WEB-007, CAT-001).
// Every service maps to an entry in APPROVED_SERVICES (§5). Copy is deliberately factual:
// no outcome promises, no advertising or social account work, no unlimited scope.
// The CMS may override `summary` and `intro` per service (key `service.<slug>`).
import { APPROVED_SERVICES } from "../domain/catalog.ts";

export type ApprovedService = (typeof APPROVED_SERVICES)[number];
export type ServiceGroup = "Websites" | "Applications & systems" | "Search & measurement" | "Ongoing care";

export interface ServiceDef {
  slug: string;
  name: string;
  /** The §5 catalogue entries this page describes. */
  approved: ApprovedService[];
  group: ServiceGroup;
  summary: string;
  intro: string;
  includes: string[];
  boundaries: string[];
  /** How this work is usually priced. */
  pricing: "packages" | "custom" | "packages_or_custom" | "maintenance";
  /** Canonical path when the service lives outside /services/:slug. */
  path?: string;
}

export const SERVICE_GROUPS: ServiceGroup[] = ["Websites", "Applications & systems", "Search & measurement", "Ongoing care"];

export const SERVICES: ServiceDef[] = [
  {
    slug: "website-design-development", name: "Website design & development", approved: ["Website design and development"], group: "Websites", pricing: "packages",
    summary: "A responsive, professionally built website delivered through a defined package with counted revisions.",
    intro: "We design and build websites that present your business clearly, load quickly and are straightforward to maintain. Each project follows a written scope, a counted number of revision rounds and a formal review and approval before launch.",
    includes: ["Page structure and navigation planned around your services", "Responsive layouts for phones, tablets and desktops", "Contact or enquiry forms within the package scope", "Technical SEO foundations (titles, descriptions, sitemap, indexing setup)", "Basic analytics configuration", "Deployment and documented handoff"],
    boundaries: ["Page counts and revision rounds follow the package you choose", "Copywriting is AI-assisted draft copy for you to review and approve; specialist copywriting is quoted separately", "Imagery is appropriately licensed or supplied by you"],
  },
  {
    slug: "website-redesign", name: "Website redesign", approved: ["Website redesign"], group: "Websites", pricing: "packages_or_custom",
    summary: "Rebuild an existing website on a modern, maintainable foundation while preserving what already works.",
    intro: "A redesign starts with a review of your current site: its pages, content, forms and search-engine signals. We then rebuild it with a refreshed design and plan redirects so existing links and indexed pages are carried across where possible.",
    includes: ["Review of existing pages, content and forms", "Content migration within the agreed page count", "Redirect plan for changed URLs", "Refreshed responsive design", "Pre-launch review and approval"],
    boundaries: ["Migration of very large sites, stores or databases is quoted as custom work", "Changes in search visibility after any redesign cannot be predicted with certainty"],
  },
  {
    slug: "e-commerce-development", name: "E-commerce development", approved: ["E-commerce development"], group: "Websites", pricing: "custom",
    summary: "Online stores with product catalogues, carts and secure checkout through an established payment provider.",
    intro: "We build online stores scoped to your catalogue and fulfilment process. Payment is handled by an established, PCI-compliant provider so card details never touch your website's servers.",
    includes: ["Product catalogue structure and product pages", "Cart and hosted checkout integration", "Order notification emails", "Tax and shipping configuration within the provider's capabilities", "Staff training on managing products and orders"],
    boundaries: ["Advanced e-commerce is quoted separately as custom development", "Payment-provider fees and third-party app subscriptions are billed by those providers"],
  },
  {
    slug: "custom-web-applications", name: "Custom web applications", approved: ["Custom web applications"], group: "Applications & systems", pricing: "custom",
    summary: "Purpose-built web software for workflows that off-the-shelf tools do not handle well.",
    intro: "When your process needs software of its own — scheduling, quoting, internal tools or customer-facing applications — we scope it in writing, review its technical feasibility, and deliver it in milestones you approve.",
    includes: ["Written scope and feasibility review before any commitment", "Data model and permissions designed around your roles", "Milestone-based delivery (50% deposit, 25% after design approval, 25% before launch)", "Automated tests for core workflows", "Documentation and handoff"],
    boundaries: ["We only take on work that passes a reasonable technical feasibility and delivery-capability review", "Scope changes require an approved change order"],
  },
  {
    slug: "custom-development", name: "Custom development", approved: ["Custom web applications", "E-commerce development", "API integrations", "AI chatbots and workflow automation"], group: "Applications & systems", pricing: "custom",
    summary: "Work beyond the standard packages, quoted separately against a written scope.",
    intro: "Custom development covers advanced e-commerce, custom SaaS platforms, complex web applications, specialised databases, extensive AI automation, advanced API integrations and anything beyond package limits. Every custom project is quoted individually after a scope and feasibility review.",
    includes: ["Advanced e-commerce", "Custom SaaS platforms", "Complex web applications", "Specialised databases", "Extensive AI automation", "Advanced API integrations", "Work beyond package limits"],
    boundaries: ["Payment schedule: 50% deposit, 25% after the approved design milestone, 25% before production launch", "Pricing is confirmed in a written quote before work begins"],
  },
  {
    slug: "portals", name: "Customer & administrative portals", approved: ["Customer and administrative portals"], group: "Applications & systems", pricing: "custom",
    summary: "Secure sign-in areas where customers or staff can view records, files, requests and status.",
    intro: "Portals give your customers or team a private, authenticated place to work. We design role-based access so each person sees only what they should, and we log sensitive actions.",
    includes: ["Secure sign-in with optional two-factor authentication", "Role-based permissions", "Document and file sharing", "Request or ticket submission", "Activity history"],
    boundaries: ["Portal scope is quoted as custom development", "Integration with existing systems depends on their available APIs"],
  },
  {
    slug: "booking-scheduling", name: "Booking & scheduling systems", approved: ["Booking and scheduling systems"], group: "Applications & systems", pricing: "packages_or_custom",
    summary: "Online booking that fits your availability rules, confirmations and reminders.",
    intro: "We set up or build booking flows that match how your business actually schedules — whether that is a configured third-party booking service embedded in your site or a custom scheduling system.",
    includes: ["Availability and booking rules", "Confirmation and reminder emails", "Calendar integration where the provider supports it", "Optional deposits or prepayment through a payment provider"],
    boundaries: ["Third-party booking subscriptions are billed by the provider", "Custom scheduling logic is quoted as custom development"],
  },
  {
    slug: "payments-subscriptions", name: "Payment & subscription integrations", approved: ["Payment and subscription integrations"], group: "Applications & systems", pricing: "custom",
    summary: "Accept one-time payments, deposits and recurring subscriptions through an established provider.",
    intro: "We integrate hosted checkout and subscription billing so payments are processed by a PCI-compliant provider. Payment confirmations are taken from the provider's signed notifications, never from a browser redirect alone.",
    includes: ["Hosted checkout for one-time payments or deposits", "Recurring subscription billing", "Customer self-service billing management where the provider offers it", "Signed webhook processing and reconciliation"],
    boundaries: ["You hold the merchant account; processing fees are charged by the provider", "We do not store full card numbers"],
  },
  {
    slug: "ai-automation", name: "AI chatbots & workflow automation", approved: ["AI chatbots and workflow automation"], group: "Applications & systems", pricing: "custom",
    summary: "Assistants and automations that draft, route and summarise — with people approving anything sensitive.",
    intro: "We build AI-assisted workflows such as website assistants, enquiry triage and document drafting. Sensitive decisions — refunds, contracts, pricing and releases — always stay with people.",
    includes: ["Website or internal assistants grounded in your approved content", "Enquiry triage and routing", "Draft generation with human review", "Usage logging and cost visibility"],
    boundaries: ["AI output can be wrong; workflows are designed with human review where it matters", "Model provider usage fees are passed through or billed by the provider"],
  },
  {
    slug: "api-integrations", name: "API integrations", approved: ["API integrations"], group: "Applications & systems", pricing: "custom",
    summary: "Connect your website or application to the services your business already uses.",
    intro: "We connect systems through their documented APIs — payment, scheduling, accounting, CRM, email and others — with retries, error logging and clear ownership of credentials.",
    includes: ["Review of each service's API and limits", "Secure credential handling", "Retry and error handling", "Integration health logging"],
    boundaries: ["Integrations depend on what each third-party API supports", "Third-party subscription costs are billed by those providers"],
  },
  {
    slug: "crm-integrations", name: "CRM integrations", approved: ["CRM integrations"], group: "Applications & systems", pricing: "custom",
    summary: "Send enquiries and customer activity from your website into your CRM automatically.",
    intro: "We connect website forms, bookings and purchases to your customer relationship management system so new enquiries are captured consistently and nothing is retyped by hand.",
    includes: ["Form-to-CRM lead capture", "Field mapping and de-duplication rules", "Activity and status sync where supported", "Error alerts for failed syncs"],
    boundaries: ["Available features depend on your CRM's API", "CRM licences are billed by the CRM provider"],
  },
  {
    slug: "email-automation", name: "Email automation infrastructure", approved: ["Email automation infrastructure"], group: "Applications & systems", pricing: "custom",
    summary: "Reliable transactional email and automated sequences with proper domain authentication.",
    intro: "We set up the infrastructure behind your automated email — sending domains, authentication records (SPF, DKIM, DMARC), templates and delivery logging — so important messages reach inboxes.",
    includes: ["Sending-domain authentication (SPF, DKIM, DMARC)", "Branded transactional templates", "Automated sequences triggered by website events", "Delivery and bounce logging"],
    boundaries: ["Email service provider fees are billed by the provider", "Bulk marketing must comply with applicable law and provider policies"],
  },
  {
    slug: "landing-pages", name: "Conversion-focused landing pages", approved: ["Conversion-focused landing pages"], group: "Websites", pricing: "packages_or_custom",
    summary: "Focused single-purpose pages with a clear call to action and measurable form submissions.",
    intro: "Landing pages concentrate on one offer and one action. We build them to load quickly, read clearly on phones and record conversions in your analytics so you can judge what works.",
    includes: ["Single-offer page structure", "Fast, responsive layout", "Form or booking call to action", "Conversion event tracking"],
    boundaries: ["We build the page; we do not run advertising campaigns that send traffic to it", "Results depend on your offer and traffic and are never promised"],
  },
  {
    slug: "technical-seo", name: "Technical SEO", approved: ["Technical SEO"], group: "Search & measurement", pricing: "packages_or_custom",
    summary: "The technical groundwork that lets search engines crawl, understand and index your site.",
    intro: "Technical SEO covers the parts of search visibility that live in the website itself: crawlability, indexing, page speed, structured data, metadata and redirects. Every package includes technical SEO at the level described on the pricing page.",
    includes: ["Crawl and indexing configuration (sitemap, robots, canonical URLs)", "Page titles and meta descriptions", "Structured data where appropriate", "Redirect management", "Core Web Vitals and page-speed improvements"],
    boundaries: ["Search rankings, traffic and leads depend on factors outside any developer's control and are never promised", "Content marketing and link-building campaigns are not part of this service"],
  },
  {
    slug: "analytics-search-console", name: "Search Console & analytics setup", approved: ["Search Console and analytics setup"], group: "Search & measurement", pricing: "packages_or_custom",
    summary: "Accounts you own, configured to measure visits, enquiries and search performance.",
    intro: "We configure Google Search Console and a web analytics property under your ownership, verify your domain and set up events for the actions that matter — form submissions, bookings or purchases.",
    includes: ["Search Console property and domain verification", "Analytics property owned by you", "Conversion events for key actions", "Privacy-conscious configuration and cookie notice where required"],
    boundaries: ["Accounts are created in your name; we request delegated access rather than ownership"],
  },
  {
    slug: "google-business-profile", name: "Google Business Profile setup assistance", approved: ["Google Business Profile setup assistance for eligible businesses"], group: "Search & measurement", pricing: "packages_or_custom",
    summary: "Help setting up and completing a Business Profile for businesses that are eligible under Google's rules.",
    intro: "For eligible businesses, we help you create or claim your Business Profile and complete its information accurately. Verification is completed by you through Google's own process.",
    includes: ["Eligibility check against Google's guidelines", "Profile information, categories and hours", "Website and booking links", "Guidance through Google's verification steps"],
    boundaries: ["Google decides eligibility, verification and how profiles are shown", "We do not post reviews or manage reviews on your behalf"],
  },
  {
    slug: "performance-optimization", name: "Website performance optimization", approved: ["Website performance optimization"], group: "Websites", pricing: "packages_or_custom",
    summary: "Measure and reduce load times, layout shifts and heavy scripts on an existing website.",
    intro: "We measure your site's real performance, identify what slows it down — oversized images, render-blocking scripts, slow hosting, excess third-party code — and fix what is within scope.",
    includes: ["Baseline performance measurement", "Image and asset optimisation", "Script and third-party tag review", "Caching and delivery configuration", "Before-and-after measurement report"],
    boundaries: ["Some platforms and third-party tools limit what can be optimised", "Improvements are measured and reported, not promised in advance"],
  },
  {
    slug: "hosting-maintenance", name: "Hosting & maintenance", approved: ["Hosting and maintenance"], group: "Ongoing care", pricing: "maintenance", path: "/hosting-maintenance",
    summary: "Optional monthly plans for hosting, updates, monitoring and backups after launch.",
    intro: "After launch you can keep your site with us on an optional monthly plan, or take it elsewhere — your domain always remains yours.",
    includes: [], boundaries: [],
  },
];

export const serviceBySlug = (slug: string): ServiceDef | undefined => SERVICES.find((s) => s.slug === slug);
export const servicePath = (s: ServiceDef): string => s.path ?? `/services/${s.slug}`;

export const PRICING_NOTE: Record<ServiceDef["pricing"], string> = {
  packages: "Delivered through the Starter, Business or Premium package.",
  custom: "Quoted separately as custom development after a scope and feasibility review.",
  packages_or_custom: "Included at package level where it fits the package scope; larger work is quoted separately.",
  maintenance: "Optional monthly plans.",
};
