// Industry matching for the Design Gallery: turn a customer's own words for their trade ("Junk removal and
// hauling") into the gallery's categories, ranked, so the references a build is given are the ones a designer
// would actually reach for.
//
// Founder directive 2026-11-03: INDUSTRY RELEVANCE OUTRANKS VISUAL VARIETY. The gallery previously handed every
// build one reference per industry, which is how a junk-removal website ended up being shown luxury fashion and
// restaurants. Relevance comes first here; unrelated sectors are the last resort, never a quota to fill.
//
// Deterministic and explainable on purpose: every match carries the phrase that produced it, so a selection can be
// defended afterwards. No model is consulted -- a classification that cannot be reproduced cannot be audited.

/** The gallery's categories. The owner's upload form offers exactly these (src/routes/design-gallery.ts). */
export const GALLERY_INDUSTRIES = [
  "luxury", "automotive", "construction", "home-services", "technology", "saas", "professional",
  "hospitality", "restaurants", "healthcare", "ecommerce", "editorial", "minimalist", "cinematic",
  "bold-contemporary", "interactive",
] as const;
export type GalleryIndustry = (typeof GALLERY_INDUSTRIES)[number];

/**
 * Categories that describe a way of designing rather than a trade. When a customer's own sector runs out of
 * references these are the honest filler: "a bold contemporary layout" is a design pattern any business can borrow,
 * whereas a restaurant template on a junk-removal site is just a mismatch. `luxury` is deliberately NOT here -- it
 * reads as a sector of its own, and the Founder named it among the categories not to reach for by default.
 */
export const DESIGN_PATTERN_CATEGORIES: readonly GalleryIndustry[] = ["minimalist", "bold-contemporary", "editorial", "cinematic", "interactive"];

/** Weight bands. Primary is the trade itself; related is a trade that shares its design problems. */
export const WEIGHT = { primary: 1, related: 0.7, adjacent: 0.4, pattern: 0.15, unrelated: 0 } as const;

interface Rule { phrases: string[]; categories: Partial<Record<GalleryIndustry, number>> }

/**
 * Phrase -> ranked categories. Longest phrase wins, so "auto glass" is automotive before "glass" could mean
 * anything else. This is a starting vocabulary, not a closed list: an unknown trade simply matches nothing and the
 * selection falls back to design patterns, which is the correct behaviour for a business the gallery has no
 * sector for.
 */
const RULES: Rule[] = [
  // ── construction and the trades that work on a building's fabric ──
  { phrases: ["junk removal", "junk hauling", "junk", "hauling", "dumpster", "cleanout", "clean out", "debris removal", "demolition", "waste removal", "rubbish"],
    categories: { construction: WEIGHT.primary, "home-services": 0.85 } },
  { phrases: ["construction", "contractor", "general contractor", "builder", "home builder", "remodel", "remodeling", "renovation", "excavation", "concrete", "masonry", "framing", "drywall", "foundation"],
    categories: { construction: WEIGHT.primary, "home-services": WEIGHT.related } },
  { phrases: ["roofing", "roofer", "siding", "gutters", "windows and doors", "insulation", "paving", "asphalt", "fencing", "decking"],
    categories: { construction: WEIGHT.primary, "home-services": WEIGHT.related } },

  // ── services performed at a customer's home ──
  { phrases: ["plumbing", "plumber", "hvac", "heating and cooling", "air conditioning", "electrician", "electrical", "handyman", "appliance repair"],
    categories: { "home-services": WEIGHT.primary, construction: WEIGHT.related } },
  { phrases: ["landscaping", "lawn care", "lawn", "tree service", "arborist", "snow removal", "irrigation", "hardscaping"],
    categories: { "home-services": WEIGHT.primary, construction: 0.6 } },
  { phrases: ["cleaning", "house cleaning", "janitorial", "maid service", "carpet cleaning", "pressure washing", "window cleaning", "pest control", "moving", "movers", "storage"],
    categories: { "home-services": WEIGHT.primary, construction: WEIGHT.adjacent } },

  // ── vehicles ──
  { phrases: ["automotive", "auto repair", "auto body", "body shop", "mechanic", "car repair", "auto glass", "windshield", "tire", "tires", "oil change", "car wash", "detailing", "dealership", "towing"],
    categories: { automotive: WEIGHT.primary } },

  // ── food and lodging ──
  { phrases: ["restaurant", "cafe", "coffee shop", "bakery", "bar", "pub", "brewery", "pizzeria", "food truck", "catering", "deli", "diner"],
    categories: { restaurants: WEIGHT.primary, hospitality: WEIGHT.related } },
  { phrases: ["hotel", "motel", "inn", "resort", "bed and breakfast", "venue", "event venue", "wedding venue", "hospitality", "tourism", "travel"],
    categories: { hospitality: WEIGHT.primary, restaurants: WEIGHT.adjacent } },

  // ── software and technology ──
  { phrases: ["saas", "software as a service", "software company", "software", "web app", "mobile app", "app", "platform", "api", "developer tools", "startup"],
    categories: { saas: WEIGHT.primary, technology: 0.85, interactive: WEIGHT.adjacent } },
  { phrases: ["technology", "it services", "managed services", "msp", "cybersecurity", "security company", "data", "analytics", "cloud", "hosting", "telecom"],
    categories: { technology: WEIGHT.primary, saas: WEIGHT.related } },

  // ── professional services ──
  { phrases: ["law firm", "lawyer", "attorney", "legal", "accountant", "accounting", "cpa", "bookkeeping", "tax", "consulting", "consultant", "insurance", "financial", "finance", "wealth", "real estate", "realtor", "property management", "agency", "marketing agency", "architect", "engineering", "surveyor", "staffing", "recruiting"],
    categories: { professional: WEIGHT.primary } },

  // ── health and wellbeing ──
  { phrases: ["healthcare", "health care", "clinic", "medical", "doctor", "physician", "dentist", "dental", "orthodontic", "chiropractic", "physical therapy", "therapy", "counseling", "mental health", "veterinary", "vet", "pharmacy", "optometry", "wellness", "home care", "senior care"],
    categories: { healthcare: WEIGHT.primary } },
  { phrases: ["salon", "hair salon", "barber", "spa", "massage", "nail salon", "esthetician", "gym", "fitness", "personal training", "yoga", "pilates", "studio"],
    categories: { healthcare: WEIGHT.related, hospitality: WEIGHT.adjacent, "bold-contemporary": WEIGHT.pattern } },

  // ── selling things ──
  { phrases: ["ecommerce", "e-commerce", "online store", "online shop", "retail", "shop", "store", "boutique", "clothing", "apparel", "jewelry", "furniture store", "marketplace"],
    categories: { ecommerce: WEIGHT.primary } },
  { phrases: ["luxury", "high end", "premium brand", "designer", "couture", "fine jewelry", "yacht", "private aviation"],
    categories: { luxury: WEIGHT.primary, editorial: WEIGHT.adjacent } },

  // ── publishing and media ──
  { phrases: ["publisher", "publishing", "magazine", "news", "blog", "media", "photography", "photographer", "film", "video production", "portfolio", "gallery", "museum", "nonprofit", "charity", "church", "school", "education", "university", "training"],
    categories: { editorial: WEIGHT.primary, professional: WEIGHT.adjacent } },
];

export interface IndustryMatch {
  category: GalleryIndustry;
  /** 1 = the customer's own trade; lower = a related trade, a design pattern, or nothing in particular. */
  weight: number;
  /** The customer's own words that produced this category, so the selection can be explained. */
  matched: string;
}

export interface IndustryClassification {
  /** The customer's industry text, lowercased and squeezed; "" when they gave none. */
  normalized: string;
  /** Categories best first. Empty when nothing in the vocabulary matched. */
  ranked: IndustryMatch[];
  /** True when at least one real trade matched, so the ranking means something. */
  confident: boolean;
  /** One sentence for the audit record. */
  reason: string;
}

/** Lowercase, drop punctuation, squeeze whitespace: "Junk Removal & Hauling" -> "junk removal hauling". */
export function normalize(raw: string | null | undefined): string {
  return String(raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Whole-word phrase test, so "app" does not match "appliance" and "vet" does not match "veteran". */
function contains(haystack: string, phrase: string): boolean {
  const p = normalize(phrase);
  if (!p) return false;
  return new RegExp(`(?:^| )${p.replace(/ /g, " ")}(?:$| )`).test(haystack);
}

/**
 * Classify a customer's industry, optionally reinforced by their own style words (brand style, colour notes), which
 * can lift a design-pattern category into contention -- the "specific useful design pattern" that justifies showing
 * a reference from outside the trade.
 */
export function classifyIndustry(industry: string | null | undefined, styleHints: string[] = []): IndustryClassification {
  const text = normalize(industry);
  const hintText = normalize(styleHints.join(" "));
  const best = new Map<GalleryIndustry, IndustryMatch>();
  const keep = (category: GalleryIndustry, weight: number, matched: string) => {
    const prev = best.get(category);
    if (!prev || weight > prev.weight) best.set(category, { category, weight, matched });
  };

  if (text) {
    // Longest phrase first so the most specific reading of the trade wins.
    const hits = RULES.flatMap((r) => r.phrases.map((p) => ({ p, r }))).sort((a, b) => b.p.length - a.p.length);
    const claimed: string[] = [];
    for (const { p, r } of hits) {
      if (!contains(text, p)) continue;
      // A longer phrase already covering these words settles it; "junk removal" beats a later "removal".
      if (claimed.some((c) => c.includes(normalize(p)))) continue;
      claimed.push(normalize(p));
      for (const [cat, w] of Object.entries(r.categories)) keep(cat as GalleryIndustry, w as number, p);
    }
  }

  // The customer's industry text may simply BE a gallery category ("construction"), which needs no vocabulary.
  for (const c of GALLERY_INDUSTRIES) if (text && contains(text, c.replace(/-/g, " "))) keep(c, WEIGHT.primary, c);

  const confident = [...best.values()].some((m) => m.weight >= WEIGHT.related);

  // Design patterns are always available as a tail, but only above unrelated sectors -- and a style word the
  // customer actually used lifts the matching pattern above the rest of the tail.
  for (const c of DESIGN_PATTERN_CATEGORIES) {
    const named = hintText && contains(hintText, c.replace(/-/g, " "));
    keep(c, named ? WEIGHT.adjacent : WEIGHT.pattern, named ? `style hint "${c}"` : "design pattern");
  }

  const ranked = [...best.values()].sort((a, b) => b.weight - a.weight || a.category.localeCompare(b.category));
  const lead = ranked.filter((r) => r.weight >= WEIGHT.related).map((r) => r.category);
  return {
    normalized: text, ranked, confident,
    reason: confident
      ? `"${text}" matched ${lead.join(" then ")} (via ${ranked[0].matched})`
      : text ? `"${text}" matched no trade in the vocabulary; design-pattern references only` : "no industry given; design-pattern references only",
  };
}

/** The weight a reference's own category earns for this customer. Unknown categories score nothing. */
export function weightFor(c: IndustryClassification, referenceIndustry: string): number {
  const want = normalize(referenceIndustry).replace(/\s+/g, "-");
  return c.ranked.find((r) => r.category === want)?.weight ?? WEIGHT.unrelated;
}
