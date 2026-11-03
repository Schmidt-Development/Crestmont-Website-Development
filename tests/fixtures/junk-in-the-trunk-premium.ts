// Junk in the Trunk, second run: the SAME fictional customer, the SAME $2,499 Business package and the SAME seven
// pages as tests/fixtures/junk-in-the-trunk.ts, with the Founder's premium design direction added to the intake
// (Founder directive, 2026-11-02).
//
// Scope is deliberately identical to the first run so the comparison against the 8.16/10 baseline is attributable to
// the brief's design direction and the builder's own improvement, not to a different page count or package.
//
// Every address uses the reserved .test domain (RFC 2606): nothing here can reach a real person. This is customer
// INPUT to the builder -- a client telling an agency what they want -- and contains no instruction to any reviewer
// about what score to award.
export const JUNK_IN_THE_TRUNK_PREMIUM = {
  business: "Junk in the Trunk",
  contactName: "Casey Trunkwell (fictional test customer)",
  email: "owner@junkinthetrunk.test",
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
      "The site has to look like a high-end agency built it. We are competing against national franchises with real marketing budgets, and a template-looking website loses us the job before anyone reads a word.",
    ].join("\n"),
    target_audience: "Homeowners, landlords, property managers, contractors and small businesses who need furniture, appliances, yard waste, construction debris or office clean-outs hauled away.",
    has_branding: "no",
    brand_style: [
      "American-inspired, premium, trustworthy and modern. Red, white and navy blue, used with restraint: navy and white carry the page, red is the accent that marks the action we want.",
      "Confident typography. A real type hierarchy with a clear scale, generous line height on body copy, and headings that are allowed to be large. Not every heading the same size.",
      "A distinctive visual identity, not a theme: one or two ideas carried consistently (for example a stencil/shipping-crate motif, or a route-and-pin idea from the hauling work) rather than decoration sprinkled on top.",
      "A consistent spacing scale, with real breathing room between sections. Sections should differ in layout and rhythm so pages do not read as a stack of identical cards.",
      "Excellent on a phone first: tap targets large enough to hit, no horizontal scrolling, text readable without zooming, and a mobile menu that works.",
      "Avoid: generic template layouts, excessive gradients, random glowing or neon elements, cramped or inconsistent spacing, repeated identical cards, cheap-looking imagery, and the obvious AI-generated design clichés.",
    ].join("\n"),
    colors: "Red (#B22234), white (#FFFFFF), navy blue (#0A3161)",
    pages: "Home\nServices\nHow It Works\nAbout\nService Areas\nFAQ\nContact / Free Quote",
    functionality: ["contact_form", "other"],
    functionality_other: [
      "Free quote request flow on the Contact / Free Quote page: name, phone, email, ZIP code, residential or commercial, items to remove, preferred date, optional notes.",
      "Validation on the client AND on the server, a clear confirmation state, and clear error states that say what to fix.",
      "The submission must actually be stored by the backend. Do not show a success message for something that was not saved.",
      "In the isolated test environment submissions are stored or logged only -- no email, SMS or third-party service.",
    ].join("\n"),
    competitors: "",
    content_source: "crestmont_draft",
    images_source: "licensed",
    domain_status: "need",
    domain_wishes: "junkinthetrunk.test (fictional -- no domain is registered for this test)",
    hosting: "undecided",
    special_instructions: [
      "INTERNAL TEST: fictional business. Use clearly fictional phone numbers and addresses. Service areas may be placeholder towns marked for review. No real integrations, analytics or tracking.",
      "Write the copy like a person who runs this business: plain, specific and confident. No filler, no superlatives we cannot stand behind.",
      "Do NOT invent testimonials, customer names, review counts, star ratings, awards, certifications, insurance numbers, years in business or job statistics. If a credibility element needs a real fact we do not have, leave a clearly labelled placeholder for us to fill in rather than making something up.",
      "NO PHOTOGRAPHS ARE AVAILABLE in this test environment and the build has no network access, so do not reference remote image URLs -- they would be broken images. Use original artwork you create yourself (SVG illustration, CSS, type and pattern) as the real visual craft of the site. Where a photograph genuinely belongs later, leave a correctly proportioned, clearly labelled placeholder with proper alt text instead of a broken or stand-in image.",
      "Stay inside the Business package: seven pages, no e-commerce, no booking payments, no customer logins, no maintenance commitments.",
    ].join("\n"),
  },
  requiredPages: ["Home", "Services", "How It Works", "About", "Service Areas", "FAQ", "Contact / Free Quote"],
} as const;
