// Fictional internal test customer for the first customer-to-website E2E benchmark (Founder directive, 2026-10-30).
// Every address uses the reserved .test domain (RFC 2606): nothing here can reach a real person.
export const JUNK_IN_THE_TRUNK = {
  business: "Junk in the Trunk",
  contactName: "Casey Trunkwell (fictional test customer)",
  email: "owner@junkinthetrunk.test",
  /** Internal $2,500 website development test package: a custom quote (CAT-004: custom quotes are billed 50/25/25). */
  quote: {
    package: "custom",
    lineDescription: "Internal $2,500 website development test package — 7-page responsive website with a quote-request flow (SIMULATED PAYMENT TEST)",
    lineAmount: "2500",
    totalCents: 250_000,
    depositCents: 125_000,
    scope: [
      "INTERNAL TEST — fictional customer, simulated payment, never delivered to a real customer.",
      "Seven-page responsive marketing website for a residential and commercial junk removal company:",
      "Home, Services, How It Works, About, Service Areas, FAQ, Contact / Free Quote.",
      "A working quote-request flow (form with validation, confirmation state) in the isolated test environment.",
      "Branding: red, white and navy blue; premium American-themed appearance; patriotic visual details; bold professional typography.",
    ].join("\n"),
  },
  lead: {
    name: "Casey Trunkwell", phone: "+1 517 555 0142", interest: "custom", budget: "$2,500 – $5,000", timeline: "1 – 3 months",
    message: "Fictional internal test customer. We need a 7-page website for our junk removal business with a free quote request form.",
  },
  /** Field names are the real onboarding form's (src/services/onboarding.ts). */
  intake: {
    intent: "submit",
    business_name: "Junk in the Trunk",
    contact_name: "Casey Trunkwell (fictional test customer)",
    contact_email: "owner@junkinthetrunk.test",
    contact_phone: "+1 517 555 0142",
    industry: "Residential and commercial junk removal",
    goals: [
      "Turn visitors into free quote requests for junk removal jobs.",
      "Suggested headline: \"YOUR JUNK. OUR TRUNK. PROBLEM SOLVED.\"",
      "Explain services and the simple booking process; show the service areas; answer common questions.",
    ].join("\n"),
    target_audience: "Homeowners, landlords, property managers, contractors and small businesses who need furniture, appliances, yard waste, construction debris or office clean-outs hauled away.",
    has_branding: "no",
    brand_style: "Premium American-themed appearance with patriotic visual details (stars and stripes accents used tastefully), bold professional typography, clean and trustworthy. Fully responsive.",
    colors: "Red (#B22234), white (#FFFFFF), navy blue (#0A3161)",
    pages: "Home\nServices\nHow It Works\nAbout\nService Areas\nFAQ\nContact / Free Quote",
    functionality: ["contact_form", "other"],
    functionality_other: "Free quote request flow on the Contact / Free Quote page: name, phone, email, ZIP code, residential or commercial, items to remove, preferred date, optional notes; client- and server-side validation; a clear confirmation state. In the isolated test environment submissions are stored or logged only — no email, SMS or third-party service.",
    competitors: "",
    content_source: "crestmont_draft",
    images_source: "licensed",
    domain_status: "need",
    domain_wishes: "junkinthetrunk.test (fictional — no domain is registered for this test)",
    hosting: "undecided",
    special_instructions: "INTERNAL TEST: fictional business. Use clearly fictional phone numbers and addresses. Service areas may be placeholder towns marked for review. No real integrations, analytics or tracking.",
  },
  requiredPages: ["Home", "Services", "How It Works", "About", "Service Areas", "FAQ", "Contact / Free Quote"],
} as const;
