// Founder-owned portfolio projects (PORTFOLIO.md). Applied by scripts/portfolio-setup.ts — idempotently, so it
// survives every frontend-preview database rebuild — through the same validation as Staff → Portfolio.
// Copy is factual and verified against each site's source revision: no metrics, prices, rankings or outcomes.
// Owners can still edit, reorder, publish and unpublish every record in Staff → Portfolio afterwards.

export const FOUNDER_AUTHORIZATION = {
  relationship: "Founder-owned business — website designed and developed in-house by the Crestmont team",
  evidence:
    "Founder Noah Schmidt confirmed in writing on 2026-10-27 that he owns this business and website, authorized its name, logo, public website imagery and interactive demonstration to appear in Crestmont's portfolio, and confirmed that the Crestmont team may claim full development credit (instruction recorded in docs/frontend/PORTFOLIO.md).",
  documentedOn: "2026-10-27",
} as const;

export interface PortfolioSeed {
  id: string; slug: string; name: string; industry: string; liveUrl: string; position: number;
  description: string; features: string[]; technology: string;
  /** Isolated demo deployment (never production) and the source revision it is built from. */
  demoUrl: string; demoRevision: string; demoRepoBranch: string;
  posterDesktop: string; posterMobile: string;
  /** Date the live link was opened and confirmed to load the correct site. */
  linkVerifiedOn: string;
}

export const PORTFOLIO_PROJECTS: PortfolioSeed[] = [
  {
    id: "pf_lansing_car_rentals", slug: "lansing-car-rentals", name: "Lansing Car Rentals", industry: "Car rental", position: 1,
    liveUrl: "https://lansingcarrentals.com",
    description: "Website for a Lansing car, SUV and minivan rental operation that takes bookings through Turo, with a vehicle showcase, an owner introduction and a full partner programme section.\nProspective fleet partners complete an eligibility-first application, schedule a call and review and e-sign the partnership agreement online; the owner manages applications and contracts in a private portal.",
    features: ["Vehicle showcase with Turo booking links", "Partner application with call scheduling", "Agreement preparation and e-signing", "Branded transactional email with delivery tracking", "Private owner portal for applications and contracts"],
    technology: "Cloudflare Worker with D1, scheduled jobs, server-rendered pages and branded transactional email.",
    demoUrl: "https://lansing-car-rentals-portfolio-demo.partners-df4.workers.dev/", demoRevision: "lansing-car-rentals@e11bf33", demoRepoBranch: "Schmidt-Development/lansing-car-rentals:crestmont/portfolio-demo-rentals",
    posterDesktop: "/assets/portfolio/lansing-car-rentals-desktop.webp", posterMobile: "/assets/portfolio/lansing-car-rentals-mobile.webp", linkVerifiedOn: "2026-10-27",
  },
  {
    id: "pf_glassly_auto_glass", slug: "glassly-auto-glass", name: "Glassly Auto Glass", industry: "Auto glass", position: 2,
    liveUrl: "https://glasslyautoglass.com",
    description: "Single-page website for OEM auto glass replacement with a scroll-driven hero sequence and an instant-quote form.\nThe quote engine decodes the vehicle's VIN, checks configuration and pricing confidence, and either returns a locked price or routes the request to a specialist for a manual quote.",
    features: ["Scroll-driven hero sequence for desktop and mobile", "VIN decoding through NHTSA's public decoder", "Instant or manual quote outcome with confidence checks", "Server-side validation of every submitted field"],
    technology: "Static front end with a Node.js serverless quote API.",
    demoUrl: "https://glassly-portfolio-demo.partners-df4.workers.dev/", demoRevision: "glassly@dadad20", demoRepoBranch: "Schmidt-Development/glassly:crestmont/portfolio-demo",
    posterDesktop: "/assets/portfolio/glassly-auto-glass-desktop.webp", posterMobile: "/assets/portfolio/glassly-auto-glass-mobile.webp", linkVerifiedOn: "2026-10-27",
  },
  {
    id: "pf_lcr_mentorship", slug: "lansing-car-rentals-mentorship", name: "Lansing Car Rentals Mentorship", industry: "Business mentorship", position: 3,
    liveUrl: "https://mentorship.lansingcarrentals.com",
    description: "Booking website for a private 30-minute phone call with the owner of Lansing Car Rentals about starting a rental car business.\nVisitors choose a time in the owner's time zone, enter their details and pay through hosted checkout; the time is held during checkout and confirmed only after verified payment, followed by confirmation emails.",
    features: ["Time selection with lead-time and horizon rules", "Hosted checkout with verified-payment confirmation", "Double-booking protection with temporary holds", "Customer confirmation and internal notification emails", "Owner calendar, availability blocks and lead sheet"],
    technology: "Cloudflare Pages Functions with D1; Stripe and Resend through their REST APIs.",
    demoUrl: "https://lcr-mentorship-portfolio-demo.partners-df4.workers.dev/", demoRevision: "lansing-car-rentals@b3e0b17", demoRepoBranch: "Schmidt-Development/lansing-car-rentals:crestmont/portfolio-demo-mentorship",
    posterDesktop: "/assets/portfolio/lansing-car-rentals-mentorship-desktop.webp", posterMobile: "/assets/portfolio/lansing-car-rentals-mentorship-mobile.webp", linkVerifiedOn: "2026-10-27",
  },
  {
    id: "pf_better_lansing_mechanics", slug: "better-lansing-mechanics", name: "Better Lansing Mechanics", industry: "Auto repair", position: 4,
    liveUrl: "https://betterlansingmechanics.com",
    description: "Website, appointment requests and customer repair tracking for a single-bay auto repair shop on Lake Lansing Road in Lansing, Michigan.\nIncludes service pages for every repair category, English and Spanish pages, a multi-step appointment request with booking payment, callback and fleet enquiry forms, and a customer portal for estimates and repair status.",
    features: ["Service pages for each repair category", "English and Spanish pages", "Multi-step appointment request with booking payment", "Callback and fleet enquiry forms", "Customer portal for estimates and repair status"],
    technology: "Cloudflare Workers with D1 and R2; server-rendered pages with a React customer portal.",
    demoUrl: "https://better-lansing-mechanics-portfolio-demo.partners-df4.workers.dev/", demoRevision: "better-lansing-mechanics@59ccaf4", demoRepoBranch: "Schmidt-Development/better-lansing-mechanics:crestmont/portfolio-demo",
    posterDesktop: "/assets/portfolio/better-lansing-mechanics-desktop.webp", posterMobile: "/assets/portfolio/better-lansing-mechanics-mobile.webp", linkVerifiedOn: "2026-10-27",
  },
];
