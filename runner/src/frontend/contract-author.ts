// Drafting the integration contract from a measured frontend.
//
// WHY THIS EXISTS. A design-locked build is judged against an integration contract -- what each interactive
// element should do, how anyone will know it works, and where its data lives. Until now a person wrote that, and
// so nobody did: six Founder artifacts were scanned, imported, measured and approved, and every build stopped
// thirteen seconds later with "this project has no integration manifest". A pipeline whose first gate requires a
// document nobody writes is a pipeline that does not run.
//
// The Founder's decision of 2026-11-07 is that MODEL A drafts it, automatically, for every uploaded frontend, and
// MODEL B implements it. The separation is the point and it is worth stating plainly, because 0093's comment said
// the opposite and was right about the danger: a model that authors the contract its own work is judged against
// is marking its own exam. That danger is answered three ways, not waved away:
//
//   1. The author is not the implementer. Model A sees the frontend and writes the plan; Model B never touches
//      the contract and cannot propose, edit or relax one.
//   2. The draft is accepted only by the platform's deterministic validator (`validateContractDraft`), which runs
//      in the platform's own request, over the measurement the platform stored, and which this module cannot
//      skip, soften or re-run with friendlier numbers. It checks coverage against the measured interaction
//      inventory, so a draft that quietly omits the booking form is refused, not accepted with a smaller plan.
//   3. Everything the draft cannot establish is RECORDED as missing rather than invented. The Founder's
//      instruction is explicit: no fabricated credentials, financial behaviour, legal obligations or unsupported
//      integrations. A payment with no approved provider, a login with no auth contract and a write to a table
//      nobody modelled are feasibility blockers; a genuinely unknowable business rule is a flag for a person.
//
// WHAT THE MODEL IS GIVEN. The measurement, in full -- every page, every interactive element with the fields,
// method, action and href the import actually found -- and read-only tools over the unpacked artifact itself, so
// it reads the real markup rather than guessing from an identifier. No brief and no customer prose: the directive
// is to analyse the SUPPLIED FRONTEND, and the frontend is what is in front of it.
//
// WHAT IT IS NOT GIVEN. Anything that would let it widen the job. It cannot see the platform's secrets, cannot
// mark an external integration approved (only the Founder or the customer can), and cannot change the design: a
// contract that plans work on a page the measurement never found is refused.

import type { ImportInteraction, ImportRoute } from "./import.ts";
import type { IntegrationManifest, ManifestContract } from "./integration-manifest.ts";
import { OPERATION_KINDS } from "./integration-manifest.ts";

/** The measured design a draft is written against, as the authoring session is shown it. */
export interface ContractAuthoringInput {
  projectId: string;
  /** Stamped onto the draft; see `stamp` below. */
  artifactSha: string;
  designFingerprint: string;
  routes: readonly ImportRoute[];
  /** Every interactive element the import found, including the ones that already work without a backend. */
  interactions: readonly ImportInteraction[];
  /** The platform validator's objections to the previous draft. Corrections, never a self-review. */
  corrections?: readonly string[];
}

/** One authoring session: a prompt in, a JSON object out. Implemented by Model A; faked in tests. */
export type ContractAuthor = (input: ContractAuthoringInput) => Promise<unknown>;

/**
 * The shape asked for. Deliberately NOT the whole of `ManifestContract`.
 *
 * A local model asked for one enormous object truncates it, and a truncated contract is no contract at all --
 * the lesson the blueprint stage already paid for by splitting itself into sections. So this asks for the parts
 * that decide whether a build can be carried out and verified, and leaves out everything the platform can
 * establish for itself (`artifactSha`, `designFingerprint`, `schema`) or that only a person can grant (an
 * approved external integration, a provided secret).
 */
export const CONTRACT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["operations", "dataModels", "apis", "persistence"],
  properties: {
    operations: {
      type: "array", minItems: 1, maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "page", "element", "kind", "behaviour", "expectChange", "acceptance"],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9-]{2,47}$" },
          page: { type: "string" },
          element: { type: "string", description: "Copied EXACTLY from the measured interaction inventory." },
          kind: { type: "string", enum: [...OPERATION_KINDS] },
          behaviour: { type: "string", minLength: 20, maxLength: 600 },
          expectChange: { type: "string", enum: ["content", "none"] },
          acceptance: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", minLength: 10, maxLength: 300 } },
          dataModel: {
            type: "array",
            items: {
              type: "object", additionalProperties: false, required: ["table", "fields"],
              properties: { table: { type: "string" }, fields: { type: "array", items: { type: "string" } } },
            },
          },
          dependsOn: { type: "array", items: { type: "string" } },
          acceptanceProbes: {
            type: "array", maxItems: 6,
            items: {
              type: "object", additionalProperties: false, required: ["criterion", "as", "path", "expect"],
              properties: {
                criterion: { type: "integer", minimum: 0, description: "0-based index into this operation's acceptance array." },
                as: { type: "string", enum: ["anonymous", "customer", "other-customer"] },
                method: { type: "string" },
                path: { type: "string", description: "One of the paths declared in apis. A probe cannot invent a surface." },
                body: { type: "object" },
                expect: { type: "integer", minimum: 100, maximum: 599 },
                repeat: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    dataModels: {
      type: "array", maxItems: 30,
      items: {
        type: "object", additionalProperties: false, required: ["table", "fields"],
        properties: { table: { type: "string" }, fields: { type: "array", items: { type: "string" } }, purpose: { type: "string" } },
      },
    },
    apis: {
      type: "array", maxItems: 40,
      items: {
        type: "object", additionalProperties: false, required: ["method", "path"],
        properties: {
          method: { type: "string" }, path: { type: "string" },
          auth: { type: "string", enum: ["public", "customer", "staff", "admin"] },
          purpose: { type: "string" },
          success: { type: "integer" }, invalid: { type: "integer" }, unauthenticated: { type: "integer" },
          requestExample: { type: "object", description: "A well-formed body, so a valid request can actually be tried. {{email}} and {{password}} are substituted." },
        },
      },
    },
    auth: {
      type: "object", additionalProperties: false, required: ["required"],
      properties: { required: { type: "boolean" }, roles: { type: "array", items: { type: "string" } }, provider: { type: "string" } },
    },
    persistence: {
      type: "object", additionalProperties: false, required: ["enforcement", "technology"],
      properties: {
        enforcement: { type: "string", enum: ["required", "any"] },
        technology: { type: "string", enum: ["sqlite", "d1", "postgres", "mysql", "kv", "file"] },
        evidence: { type: "array", items: { type: "string" } },
        durable: { type: "boolean" },
      },
    },
    visualStates: {
      type: "array", maxItems: 12,
      items: {
        type: "object", additionalProperties: false, required: ["page", "session"],
        properties: { page: { type: "string" }, session: { type: "string", pattern: "^[a-z][a-z0-9_-]{1,23}$" }, mask: { type: "array", items: { type: "string" } } },
      },
    },
    outOfScope: { type: "array", maxItems: 20, items: { type: "string", minLength: 10, maxLength: 300 } },
    missing: {
      type: "array", maxItems: 20,
      items: {
        type: "object", additionalProperties: false, required: ["what", "why", "blocks"],
        properties: { what: { type: "string" }, why: { type: "string" }, blocks: { type: "array", items: { type: "string" } } },
      },
    },
  },
} as const;

/** One interactive element, as the authoring session is told about it. Measured facts only. */
function describeInteraction(i: ImportInteraction): string {
  const facts: string[] = [`role ${i.role}`];
  if (i.label) facts.push(`label ${JSON.stringify(i.label.slice(0, 80))}`);
  if (i.method) facts.push(`method ${i.method}`);
  if (i.action) facts.push(`action ${JSON.stringify(i.action.slice(0, 120))}`);
  if (i.href) facts.push(`href ${JSON.stringify(i.href.slice(0, 120))}`);
  if (i.fields !== undefined) facts.push(`${i.fields} field(s)`);
  if (i.fieldNames?.length) facts.push(`fields: ${i.fieldNames.slice(0, 12).join(", ")}`);
  if (i.submits) facts.push("submits");
  if (i.expandable) facts.push("expandable");
  const state = i.functional
    ? "ALREADY WORKS without a backend"
    : i.needsBackend
      ? "NEEDS A BACKEND"
      : i.undetermined
        ? "UNDETERMINED by the measurement -- decide, or record it as missing"
        : "needs no backend";
  return `- page "${i.page}" element "${i.element}" [${state}] ${facts.join("; ")}`;
}

/** The authoring prompt. Measured facts, the rules, and the schema. No prose about the customer, because none was given. */
export function contractPrompt(i: ContractAuthoringInput): string {
  const needing = i.interactions.filter((x) => x.needsBackend && !x.functional);
  const corrections = (i.corrections ?? []).filter((c) => c.trim());

  const lines = [
    "An approved frontend has been imported and measured. You are writing the INTEGRATION CONTRACT: the plan for",
    "the backend work that will make it function, and the thing that work will be judged against.",
    "",
    "You are not designing anything. The frontend is approved and frozen: its appearance, copy and structure are",
    "settled and must not change. You are deciding what each interactive element should DO, how anyone will know",
    "it works, and where its data lives.",
    "",
    "THE MEASURED PAGES. An operation may only name one of these:",
    ...i.routes.map((r) => `- "${r.page}"${r.title ? ` (title ${JSON.stringify(String(r.title).slice(0, 80))})` : ""}${r.file ? ` from ${r.file}` : ""}`),
    "",
    `THE MEASURED INTERACTION INVENTORY (${i.interactions.length} element(s), ${needing.length} needing a backend).`,
    "Copy the element identifiers EXACTLY as they appear here. An operation about an element that is not in this",
    "list is refused, because nobody could build or check it.",
    ...i.interactions.map(describeInteraction),
    "",
    "You also have read-only tools over the artifact's own source. Read the markup for anything the inventory",
    "leaves open -- what a form's fields are called, what a link points at, what a page is for.",
    "",
    "RULES. Every one of these is checked by a validator you do not control and cannot talk to:",
    "",
    "1. COVER THE WHOLE FRONTEND. Every element marked NEEDS A BACKEND must either have an operation, or be named",
    "   -- by its exact identifier -- in outOfScope with the reason it is being left. Where that identifier is a",
    "   bare tag name with no id or class, name its page in the same line, so the decision is about one element",
    "   and not about every form on the site. Silence is not a decision, and \"the AI made the site work\" must not",
    "   mean the contact form works and the booking flow is a dead button.",
    "2. SAY HOW ANYONE WILL KNOW. Each operation needs acceptance criteria written now, before the work. Each",
    "   criterion that can be settled by one HTTP request gets an acceptanceProbe naming a path you declared in",
    "   apis and the status that request must get. An operation served over HTTP with no probe is refused: a",
    "   criterion nothing can execute is reported UNDETERMINED, and UNDETERMINED fails the gate.",
    "3. DECLARE WHERE DATA LIVES. Anything that stores something names its table in dataModel AND that table in",
    "   dataModels, and the contract declares persistence. A build measured once stored its rows in a JSON file",
    "   while its contract named a table, and every behavioural check still passed.",
    "4. DO NOT INVENT. No credentials, no payment provider, no legal or financial behaviour, no third-party",
    "   service the customer has no account for. If a business requirement genuinely cannot be established from",
    "   this frontend -- a price, a provider, who may sign in, the recipient of something you are planning to",
    "   send -- put that ONE requirement in missing, with what it is, why it matters, and in `blocks` the",
    "   operations that CANNOT BE BUILT AT ALL without the answer. A recorded gap is correct work; a plausible",
    "   guess is a defect that reaches a customer.",
    "   `blocks` is not for preferences, policies or improvements. If the operation can be implemented correctly",
    "   and checked without the answer, it is not blocked: leave `blocks` empty and the question is simply passed",
    "   to a person. A retention rule, a notification you were not asked to send, a nicer error message -- none of",
    "   those stop a form from storing a row, and naming them as blockers stops work that was ready to be done.",
    "5. EXPECTCHANGE IS THE DESIGN LOCK'S PERMISSION. \"content\" means making this work changes what the page",
    "   renders (a confirmation replacing a form). \"none\" means the page looks exactly as approved. Getting this",
    "   wrong either blocks a correct build or hides real drift.",
    "6. PLAN WHAT THE FRONTEND ASKS FOR AND NOTHING MORE. No features added to look thorough.",
    "",
    "Answer with the JSON object only, matching this JSON Schema:",
    JSON.stringify(CONTRACT_JSON_SCHEMA),
  ];

  if (corrections.length) {
    lines.push(
      "",
      "YOUR PREVIOUS DRAFT WAS REFUSED by the platform's validator, and it is not in this conversation. These are",
      "its exact objections. Fix every one and answer again with the whole corrected object:",
      ...corrections.map((c) => `- ${c}`),
      "",
      "Do not argue with them and do not drop an operation to make an objection go away: removing work that the",
      "frontend needs is the one failure this validator exists to catch.",
    );
  }
  return lines.join("\n");
}

/**
 * The two values the platform will check, written onto the draft here rather than asked of the model.
 *
 * Asking a model to transcribe two 64-character hashes buys nothing: a mistyped character would refuse a
 * perfectly good contract, and a correct copy proves only that it can copy. They come from the claim the platform
 * itself issued for this artifact, and the platform re-checks them against its own approved baseline when the
 * draft arrives -- so the check still catches a contract reaching the wrong design, which is what it is for.
 */
export function stamp(draft: unknown, i: ContractAuthoringInput): IntegrationManifest & ManifestContract {
  const d = (draft && typeof draft === "object" ? draft : {}) as Record<string, unknown>;
  return {
    ...d,
    schema: "crestmont.integration-manifest/1",
    artifactSha: i.artifactSha,
    designFingerprint: i.designFingerprint,
    operations: Array.isArray(d.operations) ? d.operations : [],
  } as IntegrationManifest & ManifestContract;
}

export interface ContractSubmission {
  recorded: boolean;
  problems?: string[];
  version?: number;
  queued?: string | null;
  queueRefusal?: string | null;
  reviewFlags?: { what: string; why: string; blocks: string[] }[];
  warnings?: string[];
}

export interface DraftAndSubmitDeps {
  author: ContractAuthor;
  submit: (r: { manifest: unknown; attempt: number; attemptsAllowed: number }) => Promise<ContractSubmission>;
  input: ContractAuthoringInput;
  /** How many drafts may be submitted before the project is left for a person. Bounded, always. */
  attempts?: number;
  onAttempt?: (r: { attempt: number; problems: string[] }) => void;
}

export const CONTRACT_ATTEMPTS = 3;

/**
 * Draft, submit, and correct against the validator's objections -- at most `attempts` times.
 *
 * The bound is the whole design of this loop. An unbounded correction cycle against a local model is a runner
 * that spends a GPU for ever on one artifact and reports nothing, which is worse than a project that waits
 * visibly with its reasons recorded. Three drafts, then stop and leave it for a person.
 */
export async function draftAndSubmitContract(d: DraftAndSubmitDeps): Promise<{
  recorded: boolean; attempts: number; problems: string[]; submission: ContractSubmission | null;
}> {
  const allowed = Math.max(1, Math.min(5, d.attempts ?? CONTRACT_ATTEMPTS));
  let corrections: string[] = [];
  let last: ContractSubmission | null = null;
  let used = 0;

  for (let attempt = 1; attempt <= allowed; attempt++) {
    used = attempt;
    const draft = await d.author({ ...d.input, corrections });
    const submission = await d.submit({ manifest: stamp(draft, d.input), attempt, attemptsAllowed: allowed });
    last = submission;
    if (submission.recorded) return { recorded: true, attempts: attempt, problems: [], submission };
    corrections = (submission.problems ?? []).slice(0, 20);
    d.onAttempt?.({ attempt, problems: corrections });
    // A refusal with no reasons cannot be corrected: another identical draft would be refused identically.
    if (!corrections.length) break;
  }
  // The attempts actually spent, not the allowance. A log line saying three when one happened is the kind of
  // number that gets read as evidence later.
  return { recorded: false, attempts: used, problems: corrections, submission: last };
}
