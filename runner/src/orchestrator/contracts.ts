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
}

export interface MasterSpec {
  schema: typeof SPEC_SCHEMA;
  projectSpec: string;
  designSpec: string;
  technicalArchitecture: string;
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
  required: ["schema", "projectSpec", "designSpec", "technicalArchitecture", "tasks", "acceptanceCriteria", "integrations", "securityRequirements", "testingRequirements", "assumptions", "referenceImages", "masterPrompt"],
  properties: {
    schema: { type: "string", enum: [SPEC_SCHEMA] },
    projectSpec: { type: "string" }, designSpec: { type: "string" }, technicalArchitecture: { type: "string" },
    tasks: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "title", "workstream", "paths", "dependsOn"], properties: { id: { type: "string" }, title: { type: "string" }, workstream: { type: "string" }, paths: { type: "array", items: { type: "string" } }, dependsOn: { type: "array", items: { type: "string" } } } } },
    acceptanceCriteria: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "text", "verification"], properties: { id: { type: "string" }, text: { type: "string" }, verification: { type: "string", enum: ["automated", "screenshot", "manual"] } } } },
    integrations: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "name", "purpose"], properties: { key: { type: "string" }, name: { type: "string" }, purpose: { type: "string" } } } },
    securityRequirements: { type: "array", items: { type: "string" } }, testingRequirements: { type: "array", items: { type: "string" } }, assumptions: { type: "array", items: { type: "string" } },
    referenceImages: { type: "array", items: { type: "object", additionalProperties: false, required: ["fileId", "classification"], properties: { fileId: { type: "string" }, classification: { type: "string", enum: ["customer_asset", "reference_only", "needs_license"] } } } },
    masterPrompt: { type: "string" },
  },
} as const;

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
}

export const REVIEW_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["decision", "addresses", "findings", "nextPrompt"],
  properties: {
    decision: { type: "string", enum: [...REVIEW_DECISIONS] },
    addresses: { type: "array", items: { type: "string" } }, findings: { type: "array", items: { type: "string" } },
    nextPrompt: { type: ["string", "null"] },
  },
} as const;

export function parseVerdict(raw: unknown): ReviewVerdict | null {
  const o = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : null;
  if (o && o.decision === "READY_FOR_FOUNDER_APPROVAL") o.decision = "READY_FOR_INTERNAL_APPROVAL"; // older wording
  if (!o || !(REVIEW_DECISIONS as readonly string[]).includes(o.decision as string)) return null;
  const strs = (v: unknown) => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 1000)).slice(0, 100);
  return { decision: o.decision as ReviewDecision, addresses: strs(o.addresses), findings: strs(o.findings), nextPrompt: typeof o.nextPrompt === "string" && o.nextPrompt.trim() ? o.nextPrompt.slice(0, 60000) : null };
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
