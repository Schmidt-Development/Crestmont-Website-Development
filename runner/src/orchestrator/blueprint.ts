// The Design Blueprint: the approved design as DATA, not prose. (V5 §5, §6, §7.)
//
// WHY THIS EXISTS. `MasterSpec.designSpec` is one free-text string. The architect fills it with sentences like
// "a clean, modern layout with a warm, professional palette and generous whitespace", and that is genuinely all
// the builder is given. Prose of that kind cannot be executed, cannot be diffed against what was built, and cannot
// be failed: every rendered page is arguably "clean and modern". Measured on bld_10e2c6007686faee0ab64d45: the
// design was certified-blocked at 12/40 while the written specification read as though it had been satisfied,
// because nothing in the specification was checkable.
//
// A blueprint is checkable. Every colour is a hex value, every type step is a size and a weight, every page is an
// ORDERED list of named section layouts, every component declares its states, every visual asset declares what it
// is and where it may legally come from, and every decision names the gallery reference it was taken from. That
// turns three things that were impossible into ordinary engineering:
//
//   §6  the builder is handed tokens and a section order it must implement, not an adjective to interpret;
//   §7  "the brief wants photography" and "the builder drew an SVG" stop being the same fact;
//   §8  the reviewer can be asked a specific question -- "is section 2 of / a feature-alternating layout?" --
//       instead of being asked whether the website looks good.
//
// WHAT THIS MODULE DOES NOT DO. It does not judge taste, and it is not a second scorecard. It validates that the
// design was DECIDED, in enough detail to build and to check. A blueprint can be fully valid and describe an ugly
// website; that is the reviewer's job, and the reviewer now has something to hold the result against.

/** A colour role every blueprint must fill, because a page cannot be built without them. */
export const REQUIRED_COLOR_ROLES = ["background", "surface", "text", "brand"] as const;
/** Roles a blueprint may also declare. */
export const OPTIONAL_COLOR_ROLES = ["muted", "accent", "border", "textOnBrand", "success", "warning", "danger"] as const;
export type ColorRole = (typeof REQUIRED_COLOR_ROLES)[number] | (typeof OPTIONAL_COLOR_ROLES)[number];

/**
 * Named section layouts.
 *
 * A closed list on purpose. "Hero section" is not a decision -- a centred hero over a full-bleed photograph and a
 * two-column split with the form on the right are different websites. Naming the layout makes the builder's output
 * comparable with what was approved, and lets the reviewer be asked a question with a right answer.
 */
export const SECTION_LAYOUTS = [
  "hero-split", "hero-centered", "hero-full-bleed-image", "hero-with-form",
  "feature-grid", "feature-alternating", "feature-list-with-image", "stat-band",
  "steps-timeline", "process-numbered", "service-cards", "pricing-table", "comparison-table",
  "gallery-grid", "gallery-masonry", "before-after", "logo-strip",
  "testimonial-row", "testimonial-single", "faq-accordion", "team-grid",
  "cta-band", "cta-split", "contact-split", "contact-form-only", "map-with-details",
  "rich-text", "footer-columns", "footer-simple",
] as const;
export type SectionLayout = (typeof SECTION_LAYOUTS)[number];

/** What a visual asset IS. §7: an authored SVG is a visual asset; it is not a photograph. */
export const ASSET_KINDS = ["photograph", "illustration", "icon", "pattern", "logo", "map", "video-poster"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** Where a visual asset is allowed to come from. §7: provenance and rights are separate from appearance. */
export const ASSET_SOURCES = ["customer_upload", "licensed_stock", "authored_svg", "authored_css", "generated_placeholder"] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];

/**
 * Kinds that always carry meaning, so their alt text can never be empty. An illustration, icon or pattern may be
 * purely decorative, and the correct alt text for a decorative image is `alt=""` -- requiring words there would
 * push the build towards worse accessibility, not better. What is required of every asset is that the decision
 * was MADE, which is why the field must be present as a string either way.
 */
export const INFORMATIVE_KINDS: readonly AssetKind[] = ["photograph", "map", "logo", "video-poster"];

/** The sources that actually produce a photograph. Nothing else can satisfy a photography requirement. */
export const PHOTOGRAPHIC_SOURCES: readonly AssetSource[] = ["customer_upload", "licensed_stock"];

export interface BlueprintTypeStep {
  /** `h1`, `h2`, `body`, `small`, `eyebrow`, … — the role, not the element it happens to use. */
  role: string;
  /** Rendered size with a unit, e.g. "3.25rem". */
  size: string;
  weight: number;
  lineHeight: string;
  /** Optional letter-spacing, e.g. "-0.02em". */
  tracking?: string;
}

export interface BlueprintVisualIdentity {
  /** Role → hex. Every REQUIRED_COLOR_ROLES entry must be present and must be a hex value. */
  palette: Partial<Record<ColorRole, string>>;
  headingFont: string;
  bodyFont: string;
  /** Where the fonts come from, so the builder does not silently fall back to a system stack. */
  fontSource: string;
  typeScale: BlueprintTypeStep[];
  /** The spacing rhythm's base unit, e.g. "0.5rem". */
  spacingBase: string;
  /** The multiples actually used, e.g. [1, 2, 3, 5, 8, 13]. */
  spacingScale: number[];
  /** Corner radius for cards and controls, e.g. "0.75rem" or "0" for a hard-edged design. */
  radius: string;
  /** The elevation language, e.g. "single soft shadow 0 1px 3px rgb(0 0 0 / 0.08); no shadow on flat sections". */
  elevation: string;
  /** "generous" | "balanced" | "compact" — how much air the layout carries. */
  density: "generous" | "balanced" | "compact";
  /** The one sentence a visitor should feel. Prose, deliberately, and deliberately NOT the whole specification. */
  intent: string;
}

export interface BlueprintSection {
  /** Stable id, referenced by assets and by the reviewer, e.g. "home-hero". */
  id: string;
  layout: SectionLayout;
  /** What this section is FOR, in the visitor's terms. */
  intent: string;
  /** The actual content that goes in it: headline, supporting copy, what the controls say. */
  content: string;
  /** Asset ids from `visualAssets` that this section renders. */
  assets: string[];
}

export interface BlueprintPage {
  /** Served path, e.g. "/" or "/services.html". */
  route: string;
  title: string;
  purpose: string;
  /** In render order, top to bottom. The order is part of the approval. */
  sections: BlueprintSection[];
}

export interface BlueprintComponent {
  name: string;
  /** What it is: "button", "card", "nav", "form field", "accordion", … */
  element: string;
  /** Every state that must exist, e.g. ["rest", "hover", "focus-visible", "disabled"]. */
  states: string[];
  /** How it looks, in terms of the tokens above. */
  appearance: string;
}

export interface BlueprintAsset {
  id: string;
  /** What it depicts or conveys. */
  role: string;
  kind: AssetKind;
  source: AssetSource;
  /** The licence or ownership that makes this usable, in words. */
  rights: string;
  /** Intrinsic aspect ratio the layout is designed around, e.g. "16:9", "1:1". */
  aspect: string;
  /** The alt text, written now, because it is a design decision and not a chore for later. */
  alt: string;
}

export interface BlueprintReferenceUse {
  /** A gallery reference id that was actually sent to the architect. */
  referenceId: string;
  /**
   * When the reference image holds several complete designs side by side, which one was approved: 1-based
   * position and how many there are. Omitted when the image holds a single design.
   */
  conceptIndex?: number;
  conceptCount?: number;
  /** The specific quality taken from it: "the full-bleed photographic hero with the headline over the image". */
  borrowed: string;
  /** Where it is applied: a page route, a section id or a component name. */
  appliesTo: string;
}

export interface DesignBlueprint {
  schema: typeof BLUEPRINT_SCHEMA;
  visualIdentity: BlueprintVisualIdentity;
  pages: BlueprintPage[];
  components: BlueprintComponent[];
  visualAssets: BlueprintAsset[];
  referenceMapping: BlueprintReferenceUse[];
}

export const BLUEPRINT_SCHEMA = "crestmont.design-blueprint/1";

/** Minimums that separate a decided design from a gesture at one. */
export const BLUEPRINT_MIN = {
  pages: 1,
  sectionsPerPage: 3,
  typeSteps: 4,
  components: 3,
  spacingSteps: 4,
  referenceUses: 1,
  intentChars: 24,
  contentChars: 24,
} as const;

export const BLUEPRINT_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schema", "visualIdentity", "pages", "components", "visualAssets", "referenceMapping"],
  properties: {
    schema: { type: "string", enum: [BLUEPRINT_SCHEMA] },
    visualIdentity: {
      type: "object", additionalProperties: false,
      required: ["palette", "headingFont", "bodyFont", "fontSource", "typeScale", "spacingBase", "spacingScale", "radius", "elevation", "density", "intent"],
      properties: {
        palette: {
          type: "object", additionalProperties: false,
          required: [...REQUIRED_COLOR_ROLES],
          properties: Object.fromEntries([...REQUIRED_COLOR_ROLES, ...OPTIONAL_COLOR_ROLES].map((r) => [r, { type: "string", description: "a hex colour such as #0f172a" }])),
        },
        headingFont: { type: "string", description: "the actual family name, e.g. \"Fraunces\"; never \"a modern serif\"" },
        bodyFont: { type: "string", description: "the actual family name" },
        fontSource: { type: "string", description: "where the families load from, e.g. \"Google Fonts (Fraunces, Inter)\" or \"system stack\"" },
        typeScale: {
          type: "array", minItems: BLUEPRINT_MIN.typeSteps,
          items: { type: "object", additionalProperties: false, required: ["role", "size", "weight", "lineHeight"], properties: { role: { type: "string" }, size: { type: "string", description: "with a unit, e.g. \"3.25rem\"" }, weight: { type: "number" }, lineHeight: { type: "string" }, tracking: { type: "string" } } },
        },
        spacingBase: { type: "string", description: "with a unit, e.g. \"0.5rem\"" },
        spacingScale: { type: "array", minItems: BLUEPRINT_MIN.spacingSteps, items: { type: "number" } },
        radius: { type: "string" }, elevation: { type: "string" },
        density: { type: "string", enum: ["generous", "balanced", "compact"] },
        intent: { type: "string" },
      },
    },
    pages: {
      type: "array", minItems: BLUEPRINT_MIN.pages,
      items: {
        type: "object", additionalProperties: false, required: ["route", "title", "purpose", "sections"],
        properties: {
          route: { type: "string" }, title: { type: "string" }, purpose: { type: "string" },
          sections: {
            type: "array", minItems: BLUEPRINT_MIN.sectionsPerPage,
            items: { type: "object", additionalProperties: false, required: ["id", "layout", "intent", "content", "assets"], properties: { id: { type: "string" }, layout: { type: "string", enum: [...SECTION_LAYOUTS] }, intent: { type: "string" }, content: { type: "string" }, assets: { type: "array", items: { type: "string" } } } },
          },
        },
      },
    },
    components: {
      type: "array", minItems: BLUEPRINT_MIN.components,
      items: { type: "object", additionalProperties: false, required: ["name", "element", "states", "appearance"], properties: { name: { type: "string" }, element: { type: "string" }, states: { type: "array", minItems: 1, items: { type: "string" } }, appearance: { type: "string" } } },
    },
    visualAssets: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["id", "role", "kind", "source", "rights", "aspect", "alt"], properties: { id: { type: "string" }, role: { type: "string" }, kind: { type: "string", enum: [...ASSET_KINDS] }, source: { type: "string", enum: [...ASSET_SOURCES] }, rights: { type: "string" }, aspect: { type: "string" }, alt: { type: "string" } } },
    },
    referenceMapping: {
      type: "array", minItems: BLUEPRINT_MIN.referenceUses,
      items: { type: "object", additionalProperties: false, required: ["referenceId", "borrowed", "appliesTo"], properties: { referenceId: { type: "string" }, borrowed: { type: "string" }, appliesTo: { type: "string" }, conceptIndex: { type: "number", description: "when the reference image shows several complete designs side by side, which one (1-based, left to right)" }, conceptCount: { type: "number", description: "how many designs that reference image shows" } } },
    },
  },
} as const;

export interface BlueprintValidation {
  ok: boolean;
  blueprint: DesignBlueprint | null;
  problems: string[];
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const WITH_UNIT = /^-?\d*\.?\d+(?:rem|em|px|pt|%|vw|vh|ch)$/;
/** Words that describe nothing. A design specification made of these is what this module exists to replace. */
const VAGUE_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the",
  "nice", "clean", "modern", "professional", "warm", "cool", "minimal", "minimalist", "simple", "elegant",
  "sleek", "bold", "fresh", "premium", "good", "appropriate", "suitable", "standard", "default",
  "tbd", "todo", "n/a", "na", "various", "etc",
]);

/**
 * Is this value nothing but adjectives that describe nothing?
 *
 * Tokenised rather than matched with one regex, deliberately. The regex this replaces had a leading \s* and a
 * trailing [\s.,;-]* inside a repeated group, so each space between two words could be consumed by either --
 * ambiguity that makes backtracking exponential in the number of words (CodeQL: "exponential backtracking on
 * strings starting with 'tbd' and containing many repetitions of '\tna'"). The strings checked here come
 * straight from a model's reply, so that is a hang reachable from ordinary output, not only a crafted attack.
 * Splitting on separators is linear and says the same thing more plainly.
 */
export function isVague(s: string): boolean {
  const tokens = s.toLowerCase().split(/[^a-z/]+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => VAGUE_WORDS.has(t));
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A font family name, not a description of one. */
const namedFamily = (s: string): boolean => !!s && !isVague(s) && !/^(?:a|an|the)\s/i.test(s) && !/\b(?:serif|sans[- ]serif|monospace|display|script)\b$/i.test(s.replace(/,.*$/, "").trim());

/**
 * Validate a blueprint the architect returned.
 *
 * Strict by design, and strict about the RIGHT things: structure, units, enums, internal consistency, and the
 * provenance rules §7 turns on. It never rejects a design for being unusual. `sentReferenceIds` is the set of
 * gallery references the architect was actually shown -- a mapping that cites a reference nobody sent it is a
 * fabricated citation, which is the one kind of "reference mapping" worse than none.
 */
export function validateBlueprint(raw: unknown, ctx: { sentReferenceIds?: readonly string[]; requiresPhotography?: boolean; expectedRoutes?: readonly string[] } = {}): BlueprintValidation {
  const p: string[] = [];
  if (!isObj(raw)) return { ok: false, blueprint: null, problems: ["the reply is not a JSON object"] };
  if (str(raw.schema) !== BLUEPRINT_SCHEMA) p.push(`schema must be "${BLUEPRINT_SCHEMA}"`);

  // ── visual identity ───────────────────────────────────────────────────────────────────────────────────────────
  const vi = isObj(raw.visualIdentity) ? raw.visualIdentity : null;
  if (!vi) p.push("visualIdentity is required");
  const palette: Partial<Record<ColorRole, string>> = {};
  if (vi) {
    const pal = isObj(vi.palette) ? vi.palette : {};
    for (const role of REQUIRED_COLOR_ROLES) {
      const v = str(pal[role]);
      if (!v) p.push(`visualIdentity.palette.${role} is required`);
      else if (!HEX.test(v)) p.push(`visualIdentity.palette.${role} must be a hex colour, not "${v.slice(0, 40)}" — a named mood is not a colour a stylesheet can use`);
      else palette[role] = v.toLowerCase();
    }
    for (const role of OPTIONAL_COLOR_ROLES) {
      const v = str(pal[role]);
      if (!v) continue;
      if (!HEX.test(v)) p.push(`visualIdentity.palette.${role} must be a hex colour, not "${v.slice(0, 40)}"`);
      else palette[role] = v.toLowerCase();
    }
    if (!namedFamily(str(vi.headingFont))) p.push(`visualIdentity.headingFont must name a real family (e.g. "Fraunces"), not "${str(vi.headingFont).slice(0, 40) || "(empty)"}"`);
    if (!namedFamily(str(vi.bodyFont))) p.push(`visualIdentity.bodyFont must name a real family (e.g. "Inter"), not "${str(vi.bodyFont).slice(0, 40) || "(empty)"}"`);
    if (!str(vi.fontSource)) p.push("visualIdentity.fontSource is required: say where the families load from, so the build cannot silently fall back to a system stack");
    const steps = arr(vi.typeScale);
    if (steps.length < BLUEPRINT_MIN.typeSteps) p.push(`visualIdentity.typeScale needs at least ${BLUEPRINT_MIN.typeSteps} steps (it has ${steps.length})`);
    steps.forEach((s, i) => {
      if (!isObj(s)) { p.push(`visualIdentity.typeScale[${i}] is not an object`); return; }
      if (!str(s.role)) p.push(`visualIdentity.typeScale[${i}].role is required`);
      if (!WITH_UNIT.test(str(s.size))) p.push(`visualIdentity.typeScale[${i}].size must carry a unit (e.g. "3.25rem"), not "${str(s.size).slice(0, 24)}"`);
      const w = typeof s.weight === "number" ? s.weight : NaN;
      if (!(w >= 100 && w <= 1000)) p.push(`visualIdentity.typeScale[${i}].weight must be a numeric font weight between 100 and 1000`);
      if (!str(s.lineHeight)) p.push(`visualIdentity.typeScale[${i}].lineHeight is required`);
    });
    if (!WITH_UNIT.test(str(vi.spacingBase))) p.push(`visualIdentity.spacingBase must carry a unit (e.g. "0.5rem"), not "${str(vi.spacingBase).slice(0, 24)}"`);
    const scale = arr(vi.spacingScale).filter((n): n is number => typeof n === "number" && n > 0);
    if (scale.length < BLUEPRINT_MIN.spacingSteps) p.push(`visualIdentity.spacingScale needs at least ${BLUEPRINT_MIN.spacingSteps} positive multiples (it has ${scale.length})`);
    if (!str(vi.radius)) p.push('visualIdentity.radius is required (use "0" for a deliberately hard-edged design)');
    if (!str(vi.elevation)) p.push("visualIdentity.elevation is required");
    if (!["generous", "balanced", "compact"].includes(str(vi.density))) p.push('visualIdentity.density must be "generous", "balanced" or "compact"');
    if (str(vi.intent).length < BLUEPRINT_MIN.intentChars || isVague(str(vi.intent))) p.push(`visualIdentity.intent must say what a visitor should feel in a real sentence, not "${str(vi.intent).slice(0, 48)}"`);
  }

  // ── assets (validated before pages, because sections reference them) ──────────────────────────────────────────
  const assets: BlueprintAsset[] = [];
  arr(raw.visualAssets).forEach((a, i) => {
    if (!isObj(a)) { p.push(`visualAssets[${i}] is not an object`); return; }
    const id = str(a.id), kind = str(a.kind), source = str(a.source);
    if (!id) p.push(`visualAssets[${i}].id is required`);
    if (assets.some((x) => x.id === id)) p.push(`visualAssets[${i}].id "${id}" is used twice`);
    if (!ASSET_KINDS.includes(kind as AssetKind)) p.push(`visualAssets[${i}].kind must be one of ${ASSET_KINDS.join(", ")} (got "${kind.slice(0, 30)}")`);
    if (!ASSET_SOURCES.includes(source as AssetSource)) p.push(`visualAssets[${i}].source must be one of ${ASSET_SOURCES.join(", ")} (got "${source.slice(0, 30)}")`);
    if (!str(a.role)) p.push(`visualAssets[${i}].role is required: say what it depicts`);
    if (!str(a.rights)) p.push(`visualAssets[${i}].rights is required: name the licence or ownership that makes it usable`);
    if (!str(a.aspect)) p.push(`visualAssets[${i}].aspect is required so the layout reserves the right space`);
    if (typeof a.alt !== "string") p.push(`visualAssets[${i}].alt is required: write it now, as "" if the asset is purely decorative`);
    else if (!a.alt.trim() && INFORMATIVE_KINDS.includes(kind as AssetKind)) p.push(`visualAssets[${i}] ("${id}") is a ${kind} and carries meaning, so its alt text cannot be empty`);
    // §7: a photograph cannot be authored. Declaring one and then drawing it is the exact substitution that let a
    // build ship with zero photographs against a brief asking for licensed imagery.
    if (kind === "photograph" && !PHOTOGRAPHIC_SOURCES.includes(source as AssetSource)) {
      p.push(`visualAssets[${i}] ("${id}") is declared a photograph with source "${source}": a photograph comes from the customer's own files or a licensed library. An authored SVG is a legitimate visual asset — declare it as kind "illustration" and plan the photography separately.`);
    }
    if (!p.some((x) => x.startsWith(`visualAssets[${i}]`))) {
      assets.push({ id, role: str(a.role), kind: kind as AssetKind, source: source as AssetSource, rights: str(a.rights), aspect: str(a.aspect), alt: str(a.alt) });
    }
  });

  // ── pages and sections ────────────────────────────────────────────────────────────────────────────────────────
  const pages: BlueprintPage[] = [];
  const sectionIds = new Set<string>();
  const rawPages = arr(raw.pages);
  if (rawPages.length < BLUEPRINT_MIN.pages) p.push("pages must list at least one page");
  rawPages.forEach((pg, i) => {
    if (!isObj(pg)) { p.push(`pages[${i}] is not an object`); return; }
    const route = str(pg.route);
    if (!route.startsWith("/")) p.push(`pages[${i}].route must be a served path starting with "/" (got "${route.slice(0, 40)}")`);
    if (!str(pg.title)) p.push(`pages[${i}].title is required`);
    if (!str(pg.purpose)) p.push(`pages[${i}].purpose is required`);
    const secs = arr(pg.sections);
    if (secs.length < BLUEPRINT_MIN.sectionsPerPage) p.push(`pages[${i}] (${route || "?"}) has ${secs.length} section(s); a page a customer pays for needs at least ${BLUEPRINT_MIN.sectionsPerPage} composed sections`);
    const sections: BlueprintSection[] = [];
    secs.forEach((s, j) => {
      if (!isObj(s)) { p.push(`pages[${i}].sections[${j}] is not an object`); return; }
      const id = str(s.id), layout = str(s.layout);
      if (!id) p.push(`pages[${i}].sections[${j}].id is required`);
      else if (sectionIds.has(id)) p.push(`section id "${id}" is used twice; ids must be unique across the whole blueprint`);
      else sectionIds.add(id);
      if (!SECTION_LAYOUTS.includes(layout as SectionLayout)) p.push(`pages[${i}].sections[${j}] ("${id}") layout "${layout.slice(0, 30)}" is not a named layout. Pick one of: ${SECTION_LAYOUTS.join(", ")}`);
      if (str(s.intent).length < BLUEPRINT_MIN.intentChars || isVague(str(s.intent))) p.push(`pages[${i}].sections[${j}] ("${id}") needs a real intent, not "${str(s.intent).slice(0, 40)}"`);
      if (str(s.content).length < BLUEPRINT_MIN.contentChars || isVague(str(s.content))) p.push(`pages[${i}].sections[${j}] ("${id}") needs the actual content it carries (headline, supporting copy, what the controls say), not "${str(s.content).slice(0, 40)}"`);
      const used = arr(s.assets).map(str).filter(Boolean);
      for (const a of used) if (!assets.some((x) => x.id === a)) p.push(`pages[${i}].sections[${j}] ("${id}") renders asset "${a}", which is not declared in visualAssets`);
      sections.push({ id, layout: layout as SectionLayout, intent: str(s.intent), content: str(s.content), assets: used });
    });
    pages.push({ route, title: str(pg.title), purpose: str(pg.purpose), sections });
  });
  if (ctx.expectedRoutes?.length) {
    const have = new Set(pages.map((x) => x.route));
    const missing = ctx.expectedRoutes.filter((r) => !have.has(r));
    if (missing.length) p.push(`the approved sitemap includes ${missing.slice(0, 6).join(", ")}, which the blueprint does not compose`);
  }

  // ── components ────────────────────────────────────────────────────────────────────────────────────────────────
  const components: BlueprintComponent[] = [];
  const rawComps = arr(raw.components);
  if (rawComps.length < BLUEPRINT_MIN.components) p.push(`components must describe at least ${BLUEPRINT_MIN.components} components (it has ${rawComps.length})`);
  rawComps.forEach((c, i) => {
    if (!isObj(c)) { p.push(`components[${i}] is not an object`); return; }
    if (!str(c.name)) p.push(`components[${i}].name is required`);
    if (!str(c.element)) p.push(`components[${i}].element is required`);
    const states = arr(c.states).map(str).filter(Boolean);
    if (!states.length) p.push(`components[${i}] ("${str(c.name)}") must list the states that have to exist; a component with no declared states cannot be reviewed`);
    if (str(c.appearance).length < BLUEPRINT_MIN.intentChars || isVague(str(c.appearance))) p.push(`components[${i}] ("${str(c.name)}") needs its appearance in terms of the tokens, not "${str(c.appearance).slice(0, 40)}"`);
    components.push({ name: str(c.name), element: str(c.element), states, appearance: str(c.appearance) });
  });

  // ── reference mapping ─────────────────────────────────────────────────────────────────────────────────────────
  const referenceMapping: BlueprintReferenceUse[] = [];
  const rawRefs = arr(raw.referenceMapping);
  const sent = new Set(ctx.sentReferenceIds ?? []);
  // No reference was sent (a text-only model, or a build with no gallery selection): a mapping cannot be demanded,
  // and an empty one is the honest answer. Demanding one here would be asking the model to invent a citation.
  if (!sent.size && !rawRefs.length) {
    // nothing to validate
  } else if (rawRefs.length < BLUEPRINT_MIN.referenceUses) {
    p.push("referenceMapping must say what was taken from the gallery references that were provided, and where it is applied");
  }
  rawRefs.forEach((r, i) => {
    if (!isObj(r)) { p.push(`referenceMapping[${i}] is not an object`); return; }
    const id = str(r.referenceId);
    if (!id) p.push(`referenceMapping[${i}].referenceId is required`);
    else if (sent.size && !sent.has(id)) p.push(`referenceMapping[${i}] cites reference "${id}", which was not among the references provided (${[...sent].slice(0, 6).join(", ")}). Cite only what you were actually shown.`);
    if (str(r.borrowed).length < BLUEPRINT_MIN.intentChars || isVague(str(r.borrowed))) p.push(`referenceMapping[${i}] must name the specific quality taken ("the full-bleed photographic hero with the headline set over the image"), not "${str(r.borrowed).slice(0, 40)}"`);
    const to = str(r.appliesTo);
    if (!to) p.push(`referenceMapping[${i}].appliesTo is required`);
    else if (!sectionIds.has(to) && !pages.some((x) => x.route === to) && !components.some((x) => x.name === to)) {
      p.push(`referenceMapping[${i}].appliesTo "${to.slice(0, 40)}" is not a section id, a page route or a component name in this blueprint`);
    }
    const count = typeof r.conceptCount === "number" ? Math.floor(r.conceptCount) : undefined;
    const index = typeof r.conceptIndex === "number" ? Math.floor(r.conceptIndex) : undefined;
    if (count !== undefined && !(count >= 1 && count <= 8)) p.push(`referenceMapping[${i}].conceptCount must be between 1 and 8`);
    if (index !== undefined && count === undefined) p.push(`referenceMapping[${i}] names concept ${index} but does not say how many concepts the image shows; give conceptCount too`);
    if (index !== undefined && count !== undefined && !(index >= 1 && index <= count)) p.push(`referenceMapping[${i}].conceptIndex ${index} is outside 1..${count}`);
    referenceMapping.push({ referenceId: id, borrowed: str(r.borrowed), appliesTo: to, ...(index !== undefined ? { conceptIndex: index } : {}), ...(count !== undefined ? { conceptCount: count } : {}) });
  });

  // ── §7: the photography requirement, checked against what was actually planned ────────────────────────────────
  if (ctx.requiresPhotography) {
    const photos = assets.filter((a) => a.kind === "photograph" && PHOTOGRAPHIC_SOURCES.includes(a.source));
    if (!photos.length) {
      p.push("the brief calls for photography and the blueprint plans none. Declare at least one asset of kind \"photograph\" with source \"customer_upload\" or \"licensed_stock\", with the rights that make it usable. Authored artwork is a valid part of a design but does not satisfy a photography requirement.");
    } else {
      const placed = new Set(pages.flatMap((pg) => pg.sections.flatMap((s) => s.assets)));
      const unplaced = photos.filter((a) => !placed.has(a.id));
      if (unplaced.length === photos.length) p.push(`photography is planned (${photos.map((a) => a.id).join(", ")}) but no section renders it; place it in the sections that carry it`);
    }
  }

  if (p.length) return { ok: false, blueprint: null, problems: p.slice(0, 24) };
  return {
    ok: true,
    blueprint: { schema: BLUEPRINT_SCHEMA, visualIdentity: { ...(vi as unknown as BlueprintVisualIdentity), palette }, pages, components, visualAssets: assets, referenceMapping },
    problems: [],
  };
}

// ── §6: the blueprint as instructions a builder cannot paraphrase ────────────────────────────────────────────────

/** The design tokens as a CSS custom-property block, generated from the blueprint so the values cannot drift. */
export function blueprintTokensCss(b: DesignBlueprint): string {
  const vi = b.visualIdentity;
  const lines = [
    "/* GENERATED FROM THE APPROVED DESIGN BLUEPRINT. These values are the approval itself: change them only by",
    "   changing the blueprint. Every colour, size and space in this website must come from a token below. */",
    ":root {",
    ...Object.entries(vi.palette).map(([role, hex]) => `  --color-${role.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}: ${hex};`),
    `  --font-heading: ${JSON.stringify(vi.headingFont)}, serif;`,
    `  --font-body: ${JSON.stringify(vi.bodyFont)}, system-ui, sans-serif;`,
    `  --space: ${vi.spacingBase};`,
    ...vi.spacingScale.map((n) => `  --space-${n}: calc(var(--space) * ${n});`),
    `  --radius: ${vi.radius};`,
    ...vi.typeScale.flatMap((t) => [
      `  --type-${t.role}-size: ${t.size};`,
      `  --type-${t.role}-weight: ${t.weight};`,
      `  --type-${t.role}-leading: ${t.lineHeight};`,
      ...(t.tracking ? [`  --type-${t.role}-tracking: ${t.tracking};`] : []),
    ]),
    "}",
  ];
  return lines.join("\n");
}

/**
 * The blueprint written out as the design phase's build order.
 *
 * Deterministic text generated from the validated object -- not a second prompt a model writes. The builder is
 * told the section ORDER and the named layout of each one, because that is what was approved and what the reviewer
 * will be asked about.
 */
export function blueprintInstructions(b: DesignBlueprint): string {
  const vi = b.visualIdentity;
  const out: string[] = [
    "THE APPROVED DESIGN BLUEPRINT — BUILD EXACTLY THIS",
    "",
    "This is not a brief to interpret. It is the design that has been approved, and the visual review scores the",
    "website against it. Where the blueprint names a value, use that value; where it names a layout, build that",
    "layout; where it names an asset, render that asset. If something here cannot be built, say so in your report",
    "with the reason — do not substitute something easier and leave it unexplained.",
    "",
    `Design intent: ${vi.intent}`,
    `Density: ${vi.density}. Corner radius: ${vi.radius}. Elevation: ${vi.elevation}.`,
    `Typefaces: headings in ${vi.headingFont}, body in ${vi.bodyFont}, loaded from ${vi.fontSource}.`,
    "",
    "1. DESIGN TOKENS. Write exactly this into your stylesheet, before any rule, and build every rule from these",
    "   custom properties. Do not hard-code a colour, a font size or a margin anywhere else.",
    "",
    blueprintTokensCss(b),
    "",
    "2. TYPE SCALE. Each role has one size, weight and line height:",
    ...vi.typeScale.map((t) => `   - ${t.role}: ${t.size} / ${t.lineHeight}, weight ${t.weight}${t.tracking ? `, tracking ${t.tracking}` : ""}`),
    "",
    "3. PAGE COMPOSITION. Each page is built from these sections, IN THIS ORDER, each using the named layout:",
  ];
  for (const pg of b.pages) {
    out.push("", `   ${pg.route} — ${pg.title} (${pg.purpose})`);
    pg.sections.forEach((s, i) => {
      out.push(`     ${i + 1}. [${s.id}] layout: ${s.layout}`);
      out.push(`        purpose: ${s.intent}`);
      out.push(`        content: ${s.content}`);
      if (s.assets.length) out.push(`        renders: ${s.assets.join(", ")}`);
    });
  }
  out.push("", "4. COMPONENTS. Each must exist and must have every state listed:");
  for (const c of b.components) out.push(`   - ${c.name} (${c.element}) — states: ${c.states.join(", ")}. ${c.appearance}`);
  if (b.visualAssets.length) {
    out.push("", "5. VISUAL ASSETS. Each is listed with what it is and where it may come from. The kind is binding: an",
      "   illustration may be authored, a photograph may not.");
    for (const a of b.visualAssets) {
      out.push(`   - ${a.id}: ${a.kind} (${a.aspect}) — ${a.role}`);
      out.push(`     source: ${a.source}; rights: ${a.rights}`);
      out.push(`     alt: ${a.alt}`);
    }
    const photos = b.visualAssets.filter((a) => a.kind === "photograph");
    if (photos.length) {
      out.push("",
        `   ${photos.length} of these are PHOTOGRAPHS (${photos.map((a) => a.id).join(", ")}). Do not draw them. Use the`,
        "   customer's own file where one exists in customer-files/, otherwise render the reserved space at the stated",
        "   aspect ratio with the alt text in place and record the missing file in .crestmont/defects.json. An SVG you",
        "   author in place of a photograph is a different asset and will be scored as the absence of photography.");
    }
  }
  if (b.referenceMapping.length) {
    out.push("", "6. WHAT THESE DECISIONS COME FROM. Each entry is a quality taken from a reference the architect studied;",
      "   it is the standard the result is held to:");
    for (const r of b.referenceMapping) out.push(`   - ${r.appliesTo}: ${r.borrowed}${r.conceptCount && r.conceptCount > 1 ? ` (from concept ${r.conceptIndex ?? 1} of ${r.conceptCount} in that reference image — the other concepts in it are NOT this website's direction)` : ""}`);
  }
  return out.join("\n");
}

/**
 * The blueprint compressed to what MUST go in the builder's prompt (V5 §6).
 *
 * blueprintInstructions() is written to DESIGN-BLUEPRINT.md, which the builder is told to read first. This is the
 * part that cannot be left to a file read: the tokens and the section order are the approval itself, and a model
 * that skips the file must still be unable to claim it did not know them. Everything discursive -- each section's
 * intent and copy, each asset's rights, the reference mapping -- stays in the file, because Model B's window also
 * has to hold the repository it is editing.
 */
export function blueprintBrief(b: DesignBlueprint): string {
  const vi = b.visualIdentity;
  const out = [
    "THE APPROVED DESIGN BLUEPRINT is in DESIGN-BLUEPRINT.md. Read it before your first edit. It is not advice: the",
    "visual review scores this website against it, section by section. The binding essentials, repeated here so they",
    "cannot be missed:",
    "",
    "DESIGN TOKENS — write these verbatim into your stylesheet and build every rule from them. No colour, font size",
    "or spacing value may be hard-coded anywhere else:",
    blueprintTokensCss(b),
    "",
    `Typefaces: headings ${vi.headingFont}, body ${vi.bodyFont}, loaded from ${vi.fontSource}. Density: ${vi.density}. Radius: ${vi.radius}.`,
    `Design intent: ${vi.intent}`,
    "",
    "PAGE COMPOSITION — each page is these sections, in this order, each using the named layout (the content and",
    "purpose of each one is in DESIGN-BLUEPRINT.md):",
  ];
  for (const pg of b.pages) out.push(`  ${pg.route}: ${pg.sections.map((s, i) => `${i + 1}. ${s.id} (${s.layout})`).join("; ")}`);
  out.push("", `COMPONENTS — each must exist with every state: ${b.components.map((c) => `${c.name} [${c.states.join("/")}]`).join("; ")}`);
  const photos = b.visualAssets.filter((a) => a.kind === "photograph");
  const drawn = b.visualAssets.filter((a) => a.source === "authored_svg" || a.source === "authored_css");
  if (b.visualAssets.length) {
    out.push("", "VISUAL ASSETS — the kind is binding. An illustration may be authored; a photograph may not.");
    if (photos.length) {
      out.push(`  PHOTOGRAPHS (${photos.length}): ${photos.map((a) => `${a.id} (${a.aspect}) — ${a.role}`).join("; ")}`);
      out.push("  Use the customer's own file from customer-files/ where one exists. Where none does, render the reserved",
        "  space at the stated aspect ratio with the alt text in place and record the missing file in .crestmont/defects.json.",
        "  Do NOT draw an SVG in place of a photograph: that is scored as the absence of photography, not as imagery.",
        "  Never copy a Design Gallery reference screenshot into this website — it is another studio's work.");
    }
    if (drawn.length) out.push(`  AUTHORED ARTWORK (${drawn.length}): ${drawn.map((a) => `${a.id} — ${a.role}`).join("; ")}`);
  }
  return out.join("\n");
}

/** A one-line summary for the build log and the Founder's timeline. */
export function blueprintSummary(b: DesignBlueprint): string {
  const sections = b.pages.reduce((n, p) => n + p.sections.length, 0);
  const photos = b.visualAssets.filter((a) => a.kind === "photograph").length;
  return `${b.pages.length} page(s), ${sections} composed section(s), ${b.components.length} component(s), ${b.visualAssets.length} visual asset(s)${photos ? ` (${photos} photographic)` : ""}, ${b.referenceMapping.length} reference mapping(s); palette ${Object.keys(b.visualIdentity.palette).length} roles, ${b.visualIdentity.typeScale.length}-step type scale`;
}

/**
 * §8: the specific, answerable questions a reference-aware reviewer is asked, derived from the blueprint.
 *
 * "Does the website look good?" has no wrong answer. "Is the second section of / a feature-alternating layout?"
 * does, and a reviewer that gets it wrong can be caught.
 */
export function blueprintChecklist(b: DesignBlueprint): string[] {
  const q: string[] = [];
  for (const pg of b.pages) {
    q.push(`${pg.route}: are the sections, in order, ${pg.sections.map((s, i) => `(${i + 1}) ${s.layout}`).join(", ")}?`);
    for (const s of pg.sections) if (s.assets.length) q.push(`${pg.route} → ${s.id}: does it render ${s.assets.join(" and ")}?`);
  }
  const vi = b.visualIdentity;
  q.push(`Do the rendered pages use ${vi.headingFont} for headings and ${vi.bodyFont} for body text, or a visibly different typeface?`);
  q.push(`Is the brand colour ${vi.palette.brand} actually present on the pages, or is the result effectively unstyled?`);
  const photos = b.visualAssets.filter((a) => a.kind === "photograph");
  if (photos.length) q.push(`The blueprint plans ${photos.length} photograph(s). Are real photographs rendered, or has authored artwork been substituted for them?`);
  for (const c of b.components.slice(0, 8)) q.push(`Component "${c.name}": does it exist, and are its ${c.states.join(" / ")} states distinguishable?`);
  return q.slice(0, 40);
}
