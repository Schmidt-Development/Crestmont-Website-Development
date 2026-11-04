// Crestmont AI Orchestrator: communication contracts (Founder V4: local dual-model).
//
// The orchestrator is a controller: it moves structured documents between the Model A architect session, the Model B
// builder and the separate Model A review session, and reports each one to the platform (the durable record). Every
// document that comes back from a model is untrusted input and is validated before use; the platform validates it again.

export const SPEC_SCHEMA = "crestmont.master-spec/1";

/** What the Architect receives: the immutable build brief (normalized intake) plus reference images on disk. */
export interface ArchitectInput {
  brief: unknown;
  /** Absolute paths of reference images the customer uploaded (passed to the model as images where supported). */
  referenceImages: { fileId: string; path: string; folder: string | null; name: string }[];
  referenceUrls: string[];
  /** Hardware/provider bound on parallel sessions for this website. */
  maxSessions: number;
  /**
   * Owner-approved Design Gallery references for this customer's industry, already downloaded. `path` is a real
   * file in the workspace; a reference whose image could not be fetched has `path: null` and is described in
   * words only, so a specification can never imply a picture the model never saw.
   */
  galleryReferences?: GalleryReferenceInput[];
  /**
   * Design skills provisioned into this workspace (.claude/skills/<name>/SKILL.md). The architect has
   * read_file, so naming them is how a local model reaches guidance the Agent SDK would otherwise inject:
   * the SDK's own skills option is never sent to the local provider.
   */
  skillNames?: string[];
}

export interface GalleryReferenceInput {
  id: string;
  title: string;
  industry: string;
  /** 1 = the customer's own trade, 0 = unrelated. */
  relevance: number;
  why: string;
  tags: string[];
  notes: { typography: string | null; layout: string | null; color: string | null; animation: string | null; responsive: string | null; quality: string | null };
  /** Absolute path of the downloaded image, or null when it could not be fetched. */
  path: string | null;
  variant: "desktop" | "tablet" | "mobile" | null;
}

/**
 * The architect's work, split the way the build will actually be done.
 *
 * Without this the specification was one undifferentiated demand, and the builder had no way to tell which of its
 * contents belonged to the phase it was in. A booking API and a hero layout read identically in a single document,
 * which is how GPU time went into debugging a backend behind an unfinished-looking homepage.
 *
 * Optional for compatibility: a specification written before this field existed still parses, and the phase prompts
 * fall back to the undifferentiated designSpec/technicalArchitecture.
 */
export interface PhasePlan {
  /** Phase 1: what the design must deliver — pages, layout, type, colour, imagery, component appearance. */
  designDeliverables: string[];
  /**
   * Phase 1: interactions the DESIGN depends on, and the mock or fixture that shows each state during the design
   * phase. A component that cannot be seen in its loading, error, empty and success states cannot be scored.
   */
  designDependentInteractions: { component: string; states: string[]; mock: string }[];
  /** Phase 3: backend work deliberately DEFERRED until the design is certified, and what it will be built against. */
  deferredBackend: { capability: string; dependsOnDesign: string; realImplementation: string }[];
  /** Phase 4: the remaining quality requirements — security, accessibility, performance, SEO, reliability, deployment. */
  finalQuality: string[];
}

export interface MasterSpec {
  schema: typeof SPEC_SCHEMA;
  projectSpec: string;
  designSpec: string;
  technicalArchitecture: string;
  /** The four-way phase split (optional: older specifications have none). */
  phasePlan?: PhasePlan;
  tasks: { id: string; title: string; workstream: string; paths: string[]; dependsOn: string[] }[];
  acceptanceCriteria: { id: string; text: string; verification: "automated" | "screenshot" | "manual" }[];
  integrations: { key: string; name: string; purpose: string }[];
  securityRequirements: string[];
  testingRequirements: string[];
  assumptions: string[];
  referenceImages: { fileId: string; classification: "customer_asset" | "reference_only" | "needs_license" }[];
  masterPrompt: string;
}

/** JSON Schema of MasterSpec, given to the architect session with the prompt. */
export const MASTER_SPEC_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schema", "projectSpec", "designSpec", "technicalArchitecture", "phasePlan", "tasks", "acceptanceCriteria", "integrations", "securityRequirements", "testingRequirements", "assumptions", "referenceImages", "masterPrompt"],
  properties: {
    schema: { type: "string", enum: [SPEC_SCHEMA] },
    projectSpec: { type: "string" }, designSpec: { type: "string" }, technicalArchitecture: { type: "string" },
    // Required of a NEW specification (so the architect produces the split) while the TypeScript field stays
    // optional, so a specification stored before this existed still parses and the phase prompts fall back.
    phasePlan: {
      type: "object", additionalProperties: false,
      required: ["designDeliverables", "designDependentInteractions", "deferredBackend", "finalQuality"],
      properties: {
        designDeliverables: { type: "array", items: { type: "string" } },
        designDependentInteractions: { type: "array", items: { type: "object", additionalProperties: false, required: ["component", "states", "mock"], properties: { component: { type: "string" }, states: { type: "array", items: { type: "string" } }, mock: { type: "string" } } } },
        deferredBackend: { type: "array", items: { type: "object", additionalProperties: false, required: ["capability", "dependsOnDesign", "realImplementation"], properties: { capability: { type: "string" }, dependsOnDesign: { type: "string" }, realImplementation: { type: "string" } } } },
        finalQuality: { type: "array", items: { type: "string" } },
      },
    },
    tasks: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "title", "workstream", "paths", "dependsOn"], properties: { id: { type: "string" }, title: { type: "string" }, workstream: { type: "string" }, paths: { type: "array", items: { type: "string" } }, dependsOn: { type: "array", items: { type: "string" } } } } },
    acceptanceCriteria: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "text", "verification"], properties: { id: { type: "string" }, text: { type: "string" }, verification: { type: "string", enum: ["automated", "screenshot", "manual"] } } } },
    integrations: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "name", "purpose"], properties: { key: { type: "string" }, name: { type: "string" }, purpose: { type: "string" } } } },
    securityRequirements: { type: "array", items: { type: "string" } }, testingRequirements: { type: "array", items: { type: "string" } }, assumptions: { type: "array", items: { type: "string" } },
    referenceImages: { type: "array", items: { type: "object", additionalProperties: false, required: ["fileId", "classification"], properties: { fileId: { type: "string" }, classification: { type: "string", enum: ["customer_asset", "reference_only", "needs_license"] } } } },
    masterPrompt: { type: "string" },
  },
} as const;

/**
 * STAGE 1 of planning: the minimum valid DESIGN specification.
 *
 * Why this exists. MASTER_SPEC_JSON_SCHEMA requires thirteen top-level fields in one JSON object, including
 * `masterPrompt` ("the complete implementation prompt ... concrete, step by step, file by file") and a full task
 * list. Model A is a reasoning model whose thinking tokens share one 8,192-token output budget with that object.
 * On bld_e65768e6b0853a425095a1f6 the reply truncated every time; extractJson then sliced to the last "}" -- an
 * inner brace -- JSON.parse threw, the throw became a note nobody could read, and the build carried on with no
 * specification at all, re-running the architect once per segment and burning Model A's turns each time.
 *
 * So planning is staged. Stage 1 asks only for what the DESIGN phase actually needs and nothing the design phase
 * cannot use: the sitemap and page structure, the brand and design system, the imagery plan, the visual
 * components, responsive expectations, frontend interaction states, the deliberately deferred backend, and
 * measurable design acceptance criteria. That fits the output budget. The implementation-only fields are filled
 * with deterministic defaults by validateDesignSpec and may be enriched later, so there is exactly ONE spec type
 * downstream and nothing else in the pipeline has to change.
 */
export const DESIGN_SPEC_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schema", "projectSpec", "designSpec", "phasePlan", "acceptanceCriteria", "assumptions"],
  properties: {
    schema: { type: "string", enum: [SPEC_SCHEMA] },
    projectSpec: { type: "string", description: "What this website is, for whom, and the primary conversion goal." },
    designSpec: { type: "string", description: "The sitemap and page structure, the brand and design system (type scale, colour roles, spacing rhythm), the imagery plan naming where each image comes from, and responsive expectations at desktop, tablet and mobile." },
    phasePlan: MASTER_SPEC_JSON_SCHEMA.properties.phasePlan,
    acceptanceCriteria: MASTER_SPEC_JSON_SCHEMA.properties.acceptanceCriteria,
    assumptions: { type: "array", items: { type: "string" } },
    referenceImages: MASTER_SPEC_JSON_SCHEMA.properties.referenceImages,
  },
} as const;

/** What validateDesignSpec concluded: a usable spec, or the specific reasons it is not usable. */
export interface SpecValidation {
  ok: boolean;
  spec: MasterSpec | null;
  problems: string[];
}

const strArray = (v: unknown, max = 60): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, max) : [];

/**
 * Validate a stage-1 architect reply and complete it into a MasterSpec.
 *
 * This is the validator the runner never had: `spec = raw as MasterSpec` was a blind cast, so an object that was
 * merely JSON -- or `null` -- passed straight through and the build proceeded as though architecture had
 * succeeded. Every required design field is checked here, and `problems` is fed back to the model on the
 * corrective retry and recorded on the build when planning finally fails.
 */
export function validateDesignSpec(raw: unknown): SpecValidation {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, spec: null, problems: ["the reply was not a JSON object"] };
  const o = raw as Record<string, unknown>;
  if (typeof o.schema === "string" && o.schema !== SPEC_SCHEMA) problems.push(`"schema" must be "${SPEC_SCHEMA}"`);
  const text = (k: string, min: number): string => {
    const v = o[k];
    if (typeof v !== "string" || v.trim().length < min) { problems.push(`"${k}" must be a string of at least ${min} characters describing the real plan`); return ""; }
    return v.trim();
  };
  const projectSpec = text("projectSpec", 40);
  const designSpec = text("designSpec", 120);

  const pp = (o.phasePlan ?? {}) as Record<string, unknown>;
  const designDeliverables = strArray(pp.designDeliverables);
  if (designDeliverables.length < 3) problems.push(`"phasePlan.designDeliverables" must list at least 3 things the design phase must deliver (got ${designDeliverables.length})`);
  const interactions = (Array.isArray(pp.designDependentInteractions) ? pp.designDependentInteractions : [])
    .filter((x): x is { component: string; states: string[]; mock: string } =>
      !!x && typeof x === "object" && typeof (x as { component?: unknown }).component === "string" && typeof (x as { mock?: unknown }).mock === "string")
    .map((x) => ({ component: x.component, states: strArray(x.states, 12), mock: x.mock })).slice(0, 40);
  const deferredBackend = (Array.isArray(pp.deferredBackend) ? pp.deferredBackend : [])
    .filter((x): x is { capability: string; dependsOnDesign: string; realImplementation: string } =>
      !!x && typeof x === "object" && typeof (x as { capability?: unknown }).capability === "string")
    .map((x) => ({ capability: x.capability, dependsOnDesign: String(x.dependsOnDesign ?? ""), realImplementation: String(x.realImplementation ?? "") })).slice(0, 40);
  const finalQuality = strArray(pp.finalQuality);

  const acceptanceCriteria = (Array.isArray(o.acceptanceCriteria) ? o.acceptanceCriteria : [])
    .filter((x): x is { id: string; text: string; verification: string } => !!x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string")
    .map((x, i) => ({
      id: typeof x.id === "string" && x.id.trim() ? x.id.trim().slice(0, 60) : `ac-${i + 1}`,
      text: x.text.trim().slice(0, 600),
      verification: (["automated", "screenshot", "manual"].includes(x.verification) ? x.verification : "manual") as "automated" | "screenshot" | "manual",
    })).slice(0, 80);
  if (acceptanceCriteria.length < 3) problems.push(`"acceptanceCriteria" must list at least 3 measurable criteria (got ${acceptanceCriteria.length})`);
  // A design is certified from screenshots, so the plan has to contain criteria that screenshots can settle.
  if (acceptanceCriteria.length >= 3 && !acceptanceCriteria.some((a) => a.verification === "screenshot")) {
    problems.push('at least one acceptance criterion must have verification "screenshot": the design is scored from browser screenshots');
  }

  const referenceImages = (Array.isArray(o.referenceImages) ? o.referenceImages : [])
    .filter((x): x is { fileId: string; classification: MasterSpec["referenceImages"][number]["classification"] } =>
      !!x && typeof x === "object" && typeof (x as { fileId?: unknown }).fileId === "string"
      && ["customer_asset", "reference_only", "needs_license"].includes(String((x as { classification?: unknown }).classification)))
    .slice(0, 40);

  if (problems.length) return { ok: false, spec: null, problems };

  // Implementation-only fields get deterministic, honest defaults. masterPrompt is derived from the architect's own
  // design plan rather than invented: the builder's phase prompt carries the design-first objective, and stage 2
  // may enrich this later. Empty arrays are truthful ("not planned yet"), never fabricated content.
  const spec: MasterSpec = {
    schema: SPEC_SCHEMA,
    projectSpec,
    designSpec,
    technicalArchitecture: typeof o.technicalArchitecture === "string" ? o.technicalArchitecture.trim() : "",
    phasePlan: { designDeliverables, designDependentInteractions: interactions, deferredBackend, finalQuality },
    tasks: [],
    acceptanceCriteria,
    integrations: [],
    securityRequirements: [],
    testingRequirements: [],
    assumptions: strArray(o.assumptions),
    referenceImages,
    masterPrompt: [
      "Build the approved visual design first, exactly as specified below. Do not build customer-specific backend functionality yet.",
      "",
      "Design specification:",
      designSpec,
      "",
      designDeliverables.length ? `The design phase must deliver:\n${designDeliverables.map((d) => `- ${d}`).join("\n")}` : "",
      interactions.length ? `\nComponents whose states must be visible with mock data:\n${interactions.map((i) => `- ${i.component}: ${i.states.join(", ")} (mock: ${i.mock})`).join("\n")}` : "",
      deferredBackend.length ? `\nDEFERRED until the design is certified — do not implement in the design phase:\n${deferredBackend.map((d) => `- ${d.capability}`).join("\n")}` : "",
    ].filter((s) => s !== "").join("\n"),
  };
  return { ok: true, spec, problems: [] };
}

/** The structured implementation report a cycle produces (collected by the orchestrator, not self-reported only). */
export interface CycleEvidence {
  summary: string;
  changedFiles: string[];
  commits: string[];
  checks: { id: string; ok: boolean; detail?: string }[];
  screenshots: { path: string; viewport: "desktop" | "mobile"; page: string }[];
  criteria: { id: string; status: "passed" | "failed" | "not_verified" }[];
  defects: string[];
  integrationBlockers: string[];
  securityFindings: string[];
  recommendedNext: string[];
}

export const REVIEW_DECISIONS = ["CONTINUE_BUILDING", "FIX_DEFECTS", "RUN_MORE_TESTS", "WAIT_FOR_EXTERNAL_SETUP", "NEEDS_HUMAN_AUTHORIZATION", "READY_FOR_FINAL_QA", "READY_FOR_INTERNAL_APPROVAL"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export interface ReviewVerdict {
  decision: ReviewDecision;
  /** Outstanding items (check:<id>, criterion:<id>, defect text) the next prompt addresses. */
  addresses: string[];
  findings: string[];
  /** Corrective prompt for the same project worker (required for continuation decisions). */
  nextPrompt: string | null;
  /**
   * The reviewer's own judgement of the subjective quality criteria (quality scorecard /1). Optional for
   * compatibility; without it those criteria stay "unsupported".
   */
  assessment?: Partial<Record<"visual_design" | "brand_consistency" | "maintainability" | "customer_experience", { verdict: "pass" | "fail"; note?: string }>>;
  /**
   * The NUMERIC visual rubric: the whole of Category A (40 points), item by item.
   *
   * This replaces `assessment.visual_design` as the design signal, and the reason is arithmetic rather than taste.
   * A binary visual_design PASS could move the old twenty-criterion score by at most 1/19 ≈ 0.5, so a website with
   * a vertically stacked desktop navigation and no images at all certified at 9.4/10
   * (bld_50e28bbd1cd033ad9ddfad02 revision 1-3). Forty points, scored per item with named deficiencies, is what
   * makes a bad-looking website score badly.
   *
   * Absent ⇒ the design category is `insufficient_evidence`, worth 0, and cannot be certified. That is deliberate:
   * a reviewer that did not score the rubric has not reviewed the design.
   */
  visualRubric?: VisualRubricItem[];
  /** Screenshots the reviewer actually received as images (set by the runner, never by the model). */
  imagesSeen?: number;
  /**
   * Whether the reviewing model can see images at all (set by the runner from the model's own capability, never by
   * the model). A text-only reviewer must never be able to claim it visually inspected the finished design, so this
   * is read from configuration rather than from an answer.
   */
  vision?: boolean;
  /** The reviewer's name, for the record ("local:<model>", "deterministic"); set by the runner. */
  reviewer?: string;
}

/** One visual rubric item as the reviewer scored it. `max` is fixed by the rubric and is not the model's to choose. */
export interface VisualRubricItem {
  id: "layout" | "typography" | "imagery" | "components" | "responsive" | "industry";
  points: number;
  note?: string;
  /** The specific visual deficiencies behind a score below the maximum. A score without these is not evidence. */
  deficiencies?: string[];
}

export const VISUAL_RUBRIC_ITEMS = Object.freeze([
  { id: "layout", max: 8 }, { id: "typography", max: 6 }, { id: "imagery", max: 6 },
  { id: "components", max: 7 }, { id: "responsive", max: 6 }, { id: "industry", max: 7 },
] as const);

export const REVIEW_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["decision", "addresses", "findings", "nextPrompt"],
  properties: {
    decision: { type: "string", enum: [...REVIEW_DECISIONS] },
    addresses: { type: "array", items: { type: "string" } }, findings: { type: "array", items: { type: "string" } },
    nextPrompt: { type: ["string", "null"] },
    assessment: {
      type: "object", additionalProperties: false,
      properties: Object.fromEntries(["visual_design", "brand_consistency", "maintainability", "customer_experience"].map((k) => [k, { type: "object", additionalProperties: false, required: ["verdict", "note"], properties: { verdict: { type: "string", enum: ["pass", "fail"] }, note: { type: "string" } } }])),
    },
    visualRubric: {
      type: "array", minItems: 6, maxItems: 6,
      items: {
        type: "object", additionalProperties: false, required: ["id", "points", "note", "deficiencies"],
        properties: {
          id: { type: "string", enum: VISUAL_RUBRIC_ITEMS.map((i) => i.id) },
          points: { type: "number" },
          note: { type: "string" },
          deficiencies: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export function parseVerdict(raw: unknown): ReviewVerdict | null {
  const o = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : null;
  if (o && o.decision === "READY_FOR_FOUNDER_APPROVAL") o.decision = "READY_FOR_INTERNAL_APPROVAL"; // older wording
  if (!o || !(REVIEW_DECISIONS as readonly string[]).includes(o.decision as string)) return null;
  const strs = (v: unknown) => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 1000)).slice(0, 100);
  const assessment: NonNullable<ReviewVerdict["assessment"]> = {};
  const a = o.assessment && typeof o.assessment === "object" ? o.assessment as Record<string, unknown> : {};
  for (const k of ["visual_design", "brand_consistency", "maintainability", "customer_experience"] as const) {
    const v = a[k] as { verdict?: unknown; note?: unknown } | undefined;
    if (v && (v.verdict === "pass" || v.verdict === "fail")) assessment[k] = { verdict: v.verdict, note: typeof v.note === "string" ? v.note.slice(0, 500) : undefined };
  }
  return {
    decision: o.decision as ReviewDecision, addresses: strs(o.addresses), findings: strs(o.findings),
    nextPrompt: typeof o.nextPrompt === "string" && o.nextPrompt.trim() ? o.nextPrompt.slice(0, 60000) : null,
    ...(Object.keys(assessment).length ? { assessment } : {}),
    ...(() => { const r = parseVisualRubric(o.visualRubric); return r ? { visualRubric: r } : {}; })(),
  };
}

/**
 * Parse the numeric visual rubric, clamping every score to the item's own maximum.
 *
 * A model cannot award itself more than the rubric allows, cannot invent an item, and cannot score an item without
 * naming its deficiencies when it is below the maximum: a bare "7/8" with no stated reason tells the builder
 * nothing it can act on, so the point is withheld rather than taken on trust. Returns null when nothing usable came
 * back, which leaves the design category at `insufficient_evidence` instead of 0-with-a-shrug.
 */
export function parseVisualRubric(raw: unknown): VisualRubricItem[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Map<string, VisualRubricItem>();
  for (const x of raw.slice(0, 12)) {
    const o = x && typeof x === "object" ? x as Record<string, unknown> : null;
    const item = VISUAL_RUBRIC_ITEMS.find((i) => i.id === String(o?.id));
    if (!o || !item || seen.has(item.id)) continue;
    const n = typeof o.points === "number" && Number.isFinite(o.points) ? Math.max(0, Math.min(item.max, o.points)) : 0;
    const deficiencies = (Array.isArray(o.deficiencies) ? o.deficiencies : []).filter((d): d is string => typeof d === "string" && d.trim().length > 2).map((d) => d.slice(0, 400)).slice(0, 10);
    const note = typeof o.note === "string" ? o.note.slice(0, 600) : undefined;
    // Full marks need no deficiencies. A score below the maximum with no named deficiency and no note is a number
    // with nothing behind it, so it scores 0 for that item and says why.
    const unexplained = n < item.max && !deficiencies.length && !note;
    seen.set(item.id, {
      id: item.id, points: unexplained ? 0 : Math.round(n * 2) / 2,
      note: unexplained ? "scored below the maximum with no stated deficiency, so the item has no evidence" : note,
      deficiencies,
    });
  }
  return seen.size ? [...seen.values()] : null;
}

/** Outstanding work the evidence shows (same rule as the platform's referee). */
export function outstanding(e: CycleEvidence): string[] {
  return [
    ...e.checks.filter((c) => !c.ok).map((c) => `check:${c.id}`),
    ...e.criteria.filter((c) => c.status !== "passed").map((c) => `criterion:${c.id}`),
    ...e.defects.map((d) => `defect:${d.slice(0, 80)}`),
    ...e.securityFindings.map((d) => `security:${d.slice(0, 80)}`),
  ];
}

/** Extract the first JSON object from model output (fenced or bare). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the model output");
  return JSON.parse(body.slice(start, end + 1));
}
