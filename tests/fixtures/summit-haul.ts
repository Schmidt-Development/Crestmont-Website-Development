// Fictional internal test customer for the fresh Business-package builder capability test (Founder directive,
// 2026-11-05). Every address uses the reserved .test domain (RFC 2606): nothing here can reach a real person,
// and the domain also satisfies the fictional-organization rule in src/services/payment-simulation.ts.
//
// Deliberately NOT Junk in the Trunk. Same industry class, different city, palette, service mix and voice, so the
// run measures whether the builder generalizes rather than whether it reproduces one earlier result. If a build
// from this brief comes back navy-and-red with a vector truck, that is a finding, not a coincidence.
export const SUMMIT_HAUL = {
  business: "Summit Haul Co.",
  contactName: "Dana Whitfield (fictional test customer)",
  email: "owner@summithaul.test",
  /** Business package: $2,499.00, 100% upfront (src/domain/catalog.ts). No custom quote, no 50/25/25. */
  quote: {
    package: "business",
    lineDescription: "Business package — 7-page responsive website with booking and quote-request flows (SIMULATED PAYMENT TEST)",
    lineAmount: "2499",
    totalCents: 249_900,
    depositCents: 249_900,
    scope: [
      "INTERNAL TEST — fictional customer, simulated payment, never delivered to a real customer.",
      "Seven-page responsive marketing website for a junk removal and hauling company:",
      "Home, Services, Pricing, Service Area, Book a Pickup, FAQ, Contact / Request a Quote.",
      "A working booking flow and quote-request flow (validation, confirmation state) in the isolated test environment.",
      "Branding: deep forest green, warm sand and an amber accent; photographic, calm and uncluttered; generous spacing.",
    ].join("\n"),
  },
  lead: {
    name: "Dana Whitfield", phone: "+1 734 555 0188", interest: "business", budget: "$2,500 – $5,000", timeline: "As soon as practical",
    message: "Fictional internal test customer. We need a seven-page website for our junk removal business with booking and quote requests.",
  },
  /** Field names are the real onboarding form's (src/services/onboarding.ts). */
  intake: {
    intent: "submit",
    business_name: "Summit Haul Co.",
    contact_name: "Dana Whitfield (fictional test customer)",
    contact_email: "owner@summithaul.test",
    contact_phone: "+1 734 555 0188",
    industry: "Junk removal and hauling, residential and commercial",
    goals: [
      "Turn a visitor into a booked pickup or a quote request in under two minutes.",
      "Make the volume-based pricing understandable before anyone calls, with worked examples.",
      "Read as a professional, insured operator rather than a man with a van.",
      "Make the service area unmistakable so out-of-area enquiries self-select out.",
    ].join("\n"),
    target_audience: "Homeowners, landlords, property managers, realtors preparing listings, and contractors clearing post-renovation debris across Ann Arbor, Ypsilanti, Saline, Dexter, Chelsea, Pittsfield Township and Scio Township.",
    has_branding: "no",
    brand_style: [
      "Photographic, calm and uncluttered: real crews, real trucks, real cleared spaces. Generous whitespace and a",
      "strong type scale. A confident grotesque for headings and a highly legible humanist sans for body text. The",
      "amber accent is reserved for actions only. Mobile matters most — almost all enquiries arrive on a phone.",
      "No cartoon illustrations or generic vector placeholders where photography is the defining characteristic.",
    ].join(" "),
    colors: "Deep forest green (#1F3D2B), warm sand (#E8DCC8), amber accent (#D98324), charcoal text (#22262A)",
    pages: "Home\nServices\nPricing\nService Area\nBook a Pickup\nFAQ\nContact / Request a Quote",
    functionality: ["contact_form", "booking", "other"],
    booking_details: "A pickup booking: preferred date and a time window (morning 8-12, afternoon 12-4, evening 4-7), service address within the listed area, load size from the pricing tiers, access notes such as stairs, a lift or a gate code, and contact details. Future dates only. No calendar system is used today. In the isolated test environment submissions are stored or logged only — no email, SMS or third-party service.",
    functionality_other: "A quote-request flow: free-text description of the work, optional photographs for construction debris and light demolition, a rough timeframe and contact details. Both forms validate on the client and the server, show clear error states, and never discard what was typed when a submission fails.",
    competitors: "",
    content_source: "crestmont_draft",
    images_source: "licensed",
    domain_status: "need",
    domain_wishes: "summithaul.test (fictional — no domain is registered for this test)",
    hosting: "undecided",
    special_instructions: [
      "INTERNAL TEST: fictional business. Use clearly fictional phone numbers and addresses.",
      "Services to present: single-item pickup from $89, quarter truck from $199, half truck from $379, full truck",
      "from $649, construction debris quoted on site, light demolition quoted on site, and a donation and recycling",
      "run included. Prices are indicative and must be shown as \"from\" figures and ranges, never as guarantees.",
      "Do NOT include reviews, star ratings, testimonials, award badges, customer counts or \"trusted by\" logos:",
      "no claim may appear that cannot be evidenced. State insurance and licensing as plain sentences, not as",
      "certification badges. No real integrations, analytics or tracking.",
    ].join(" "),
  },
  requiredPages: ["Home", "Services", "Pricing", "Service Area", "Book a Pickup", "FAQ", "Contact / Request a Quote"],
} as const;
