// Junk in the Trunk — the Business-package ($2,499) certification customer (Founder directive 2026-11-01:
// "AI Website Builder End-to-End Certification"). Unlike the earlier $2,500 custom-quote fixture (junk-in-the-trunk.ts),
// this customer buys the catalog Business package through the real package checkout and pays in Stripe TEST mode.
//
// Every value is fictional staging data. The address uses the reserved .test domain (RFC 2606): staging records the
// email in its outbox and never sends it, and the phone is in the 555-01xx range reserved for fiction, like the
// other two Junk in the Trunk fixtures. No street address, license, testimonial or company history is
// given; the intake tells the builder to label any such placeholder as fictional.
//
// The phone is not decoration. Acceptance gate A requires a public contact phone ("missing customer information:
// public contact phone") because a junk-removal visitor has to be able to call someone, and the gate deliberately
// refuses to let the builder invent one -- "missing facts are never invented". An intake that withheld the phone AND
// forbade inventing it made the gate unsatisfiable: build bld_aeadb54ca53f57afcb9969bc survived three targeted
// repairs and then escalated for a person, which is correct behaviour on an impossible brief. A real customer buying
// the Business package fills this field in, so the certification customer fills it in too.
//
// The service area is the same story with a sharper edge: gate A requires one for a website that takes quote
// requests, and until this build the onboarding form had no field to put it in at all -- so the fix is a new
// question on the real form (src/services/onboarding.ts), not a special case for this fixture.
export const JITT_BUSINESS = {
  business: "Junk in the Trunk",
  contactName: "Casey Trunkwell (fictional test customer)",
  email: "casey@junkinthetrunk.test",
  packageId: "business",
  packageCents: 249_900,
  /** The Founder-mandated minimum plan for Business (FD-26): Professional, $199/month, billed only from approved launch. */
  maintenancePlanId: "professional",
  maintenanceMonthlyCents: 19_900,
  /** Field names are the real onboarding form's (src/services/onboarding.ts). */
  intake: {
    business_name: "Junk in the Trunk",
    contact_name: "Casey Trunkwell (fictional test customer)",
    contact_email: "casey@junkinthetrunk.test",
    contact_phone: "+1 517 555 0142",
    service_area: "Greater Lansing, Michigan: Lansing, East Lansing, Okemos, Holt, Delta Township, Grand Ledge and DeWitt.",
    industry: "Junk removal and hauling",
    goals: [
      "Primary goal: generate qualified junk removal quote requests.",
      "Secondary goal: encourage visitors to call or contact the company.",
      "Locally operated, American-themed junk removal company. Brand personality: dependable, hardworking, friendly, professional and straightforward.",
      "Services: residential junk removal, commercial junk removal, furniture removal, appliance removal, garage cleanouts, basement cleanouts, estate cleanouts, construction debris removal, property cleanouts.",
    ].join("\n"),
    target_audience: "Homeowners, landlords, property managers, contractors and small businesses.",
    has_branding: "no",
    brand_style: "Modern American-inspired branding: bold typography, professional layout, strong visual hierarchy and excellent mobile responsiveness. A legitimate professional business website, not a generic template.",
    colors: "Red (#B22234), white (#FFFFFF), blue (#0A3161)",
    pages: [
      "Home",
      "Services (overview, with a section for each of the nine services)",
      "About",
      "Contact",
      "Request a Quote (the quote request form)",
      "Privacy Policy (placeholder, clearly marked for legal review)",
    ].join("\n"),
    functionality: ["contact_form", "other"],
    functionality_other: "A request-a-quote form: name, email, phone (optional), residential or commercial, items to remove, preferred date and notes; client- and server-side validation; clear success and error states. Mobile navigation and a professional footer on every page.",
    content_source: "crestmont_draft",
    images_source: "licensed",
    domain_status: "need",
    domain_wishes: "junkinthetrunk.test (fictional; no domain is registered for this test)",
    hosting: "crestmont",
    special_instructions: "STAGING CERTIFICATION TEST — fictional business. Publish the contact phone given above; it is fictional and safe to show. Do not invent a street address, operating license, customer testimonial or company history. Where the layout needs such content, use an obviously fictional placeholder labelled \"Sample — fictional test business\". No real integrations, analytics or tracking.",
  },
  /** The mandatory Phase 6 revision request, verbatim. */
  revisionRequest: "Make the homepage more visually impressive. Strengthen the red, white, and blue American theme, improve the main call-to-action section, and make the quote request button more prominent on mobile.",
} as const;
