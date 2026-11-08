// The integration manifest: what the backend work will do, written down before it starts.
//
// WHY A MANIFEST AT ALL. Three things need one, and none of them can be had from "the AI made the site work":
//
//   1. The design lock needs to know which pages are SUPPOSED to change. Without a declaration, every successful
//      integration looks like drift (see `design-lock.ts`), and the lock gets switched off.
//   2. "Nothing was silently left non-functional" has to be checkable. The approved frontend contains a known set
//      of interactive elements; `coverage()` answers which of them no operation claims.
//   3. Verification needs acceptance criteria that existed BEFORE the work, not ones written afterwards to match
//      whatever happened.
//
// The manifest is produced by the planning model and then validated here. Validation is not a formality: a
// manifest that plans work on a page the Founder never approved, or that claims an operation with no way to tell
// whether it worked, is rejected rather than executed.

export const MANIFEST_SCHEMA = "crestmont.integration-manifest/1" as const;

/** What kinds of backend behaviour an operation can be. Open-ended enough to plan, closed enough to gate. */
export const OPERATION_KINDS = [
  "data-read", "data-write", "form-submit", "search", "auth", "payment", "upload", "email", "navigation", "admin",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * Operations that can spend money, move personal data or grant access. They are planned and built like any
 * other, but they never go live on the Founder's say-so alone — `requiresRelease()` is what the release gate
 * reads, and the directive is explicit that production is not enabled autonomously.
 */
export const RELEASE_GATED: readonly OperationKind[] = ["payment", "auth", "email", "upload", "admin"];

export interface IntegrationOperation {
  /** Stable across segments, so a long task can report progress against a plan rather than restating it. */
  id: string;
  /** A page of the APPROVED design. An operation cannot invent a page. */
  page: string;
  /** The interactive element this is about, as the interaction inventory names it. */
  element: string;
  kind: OperationKind;
  /** What it should do, in plain words. Goes in the build record and in the prompt. */
  behaviour: string;
  /** Whether making this work changes what the page renders. This is what authorises content drift. */
  expectChange: "content" | "none";
  /** How anyone will know it works. At least one, written before the work. */
  acceptance: string[];
  /** Tables and fields it reads or writes, where it has any. */
  dataModel?: { table: string; fields: string[] }[];
  /** Other operation ids that must work first. */
  dependsOn?: string[];
  /** Executable form of some of the criteria above, by index. See AcceptanceProbe. */
  acceptanceProbes?: AcceptanceProbe[];
}

/**
 * An acceptance criterion in executable form.
 *
 * The criteria are prose, written before the work, and that is what makes them worth anything. It also meant the
 * driver could not evaluate them: it proved the API CONTRACT -- every declared route served, every declared refusal
 * exactly as declared -- and then reported all 28 of Northgate's criteria as UNDETERMINED, including seven it had
 * just established. A criterion nothing can execute is honest; a criterion something DID establish and that is still
 * reported unverified is not.
 *
 * So a criterion may carry a probe: one request, by index, with the session to make it from and the status it must
 * get. The prose is unchanged and still authoritative -- the probe says how to check it, never what it means. A
 * criterion with no probe stays UNDETERMINED, which still fails the gate.
 */
export interface AcceptanceProbe {
  /** Which acceptance criterion this establishes: a 0-based index into the operation's `acceptance`. */
  criterion: number;
  /** Who makes the request. `other-customer` is a second account the driver registers, for ownership checks. */
  as: "anonymous" | "customer" | "other-customer";
  method?: string;
  /** Must be one of the declared `apis` paths: a probe cannot invent a surface. */
  path: string;
  /** `{{email}}` and `{{password}}` are substituted with credentials the driver generates, as in `requestExample`. */
  body?: Record<string, unknown>;
  /** The status this request must get. */
  expect: number;
  /**
   * Text that must appear in the response body, and text that must not.
   *
   * Status codes alone could not express most of what the criteria actually say. "After a successful submission
   * the page renders a confirmation message and the form is no longer present" is a statement about the response
   * BODY, so it carried no probe, stayed UNDETERMINED for ever, and -- since undetermined is never a pass -- the
   * functional gate could not close on a site whose every other check passed. These make such a criterion
   * executable without softening it: the prose still says what it means, this says how to check it.
   *
   * Matching is plain case-sensitive substring, against the response text. Nothing is interpreted as HTML: a
   * probe that wants an element names enough of its markup to be unambiguous.
   */
  expectBodyContains?: string[];
  expectBodyAbsent?: string[];
  /** Send it twice and judge the SECOND response: "an email that already exists", "already cancelled". */
  repeat?: boolean;
}

/**
 * A page whose approved rendering can only be reproduced with a session.
 *
 * The design lock compares the approved rendering with the one the finished build produces. For a page behind
 * authentication those are not the same view unless the comparison signs in: measured on Northgate, an anonymous
 * capture of a staff page lost the three approved summary cards and the only two accent colours on it, which reads
 * as drift and is not. Declaring the session makes the two captures equivalent.
 *
 * It does not relax anything. Palette, fonts, type scale, skeleton and frame are compared exactly as before, on
 * the page as a signed-in person sees it, and a signature change is still design-drift whatever is declared here.
 * `mask` is for text that genuinely varies -- today's date, a count that comes from real rows -- and normalises
 * only those elements' text before the screenshot is hashed. It never excludes an element from the signature.
 *
 * The contract names the ROLE, never a credential: the runner creates the account and holds the password.
 */
export interface VisualState {
  /** The page, as the import names it (the html file without its extension). */
  page: string;
  /** The role to be signed in as. The runner provisions it; `access-denied` is captured separately as its own state. */
  session: string;
  /** Selectors whose text varies run to run. Normalised before the screenshot hash; never removed from the signature. */
  mask?: string[];
}

export interface IntegrationManifest {
  schema: typeof MANIFEST_SCHEMA;
  /** The artifact this plan is for. */
  artifactSha: string;
  /** The exact approved design this plan was written against (`DesignBaseline.fingerprint`). */
  designFingerprint: string;
  operations: IntegrationOperation[];
  /** Pages whose approved rendering needs a session to be reproduced. See VisualState. */
  visualStates?: VisualState[];
  /** Anything the plan cannot do and why — stated, not discovered later. */
  outOfScope?: string[];
}

/** The declared visual states, in the order the contract lists them. */
export function declaredVisualStates(m: IntegrationManifest): readonly VisualState[] {
  return m.visualStates ?? [];
}

/** One interactive element found in the approved frontend. Produced by the import, consumed here. */
export interface InteractionItem {
  page: string;
  /** The same identifier the manifest's `element` uses. */
  element: string;
  /** What it looks like it does, from the markup: a form, a link, a button, a filter. */
  role: string;
  /** True when the element plainly needs a backend to mean anything (a form with inputs, a login, a cart). */
  needsBackend: boolean;
}

export interface ManifestProblem {
  severity: "reject" | "warn";
  code: string;
  detail: string;
  operationId?: string;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * Validate a manifest against the design it claims to be for.
 *
 * `approvedPages` comes from the baseline, so "plan work on a page nobody approved" is caught here rather than by
 * the design lock after the work is done.
 */
export function validateManifest(
  m: unknown,
  o: { approvedPages: readonly string[]; designFingerprint?: string; artifactSha?: string },
): { ok: boolean; problems: ManifestProblem[]; manifest: IntegrationManifest | null } {
  const problems: ManifestProblem[] = [];
  const reject = (code: string, detail: string, operationId?: string) => problems.push({ severity: "reject", code, detail, operationId });
  const warn = (code: string, detail: string, operationId?: string) => problems.push({ severity: "warn", code, detail, operationId });

  if (!m || typeof m !== "object") {
    reject("not-an-object", "the manifest is not an object");
    return { ok: false, problems, manifest: null };
  }
  const man = m as Partial<IntegrationManifest>;

  if (man.schema !== MANIFEST_SCHEMA) {
    reject("schema", `expected schema "${MANIFEST_SCHEMA}", got ${JSON.stringify(man.schema ?? null)}`);
  }
  if (!Array.isArray(man.operations)) {
    reject("no-operations", "the manifest has no operations array");
    return { ok: false, problems, manifest: null };
  }
  if (man.operations.length === 0) {
    // A frontend with nothing to make functional is not a project this pipeline should be running at all.
    reject("empty-plan", "the manifest plans no operations; nothing would be made functional");
  }

  // The plan must be for THIS design. A manifest written against an earlier baseline would authorise content
  // changes on pages that have since been re-approved differently.
  if (o.designFingerprint && man.designFingerprint !== o.designFingerprint) {
    reject("design-mismatch", `the plan was written against design ${String(man.designFingerprint).slice(0, 12)}… but the approved baseline is ${o.designFingerprint.slice(0, 12)}…`);
  }
  if (o.artifactSha && man.artifactSha !== o.artifactSha) {
    reject("artifact-mismatch", `the plan names artifact ${String(man.artifactSha).slice(0, 12)}… but the imported artifact is ${o.artifactSha.slice(0, 12)}…`);
  }

  const approved = new Set(o.approvedPages);
  const ids = new Set<string>();
  const ops: IntegrationOperation[] = [];

  for (const [i, raw] of man.operations.entries()) {
    const op = raw as Partial<IntegrationOperation>;
    const where = isStr(op.id) ? op.id : `operations[${i}]`;

    if (!isStr(op.id)) { reject("operation-id", `${where} has no id, so progress against it cannot be tracked`); continue; }
    if (ids.has(op.id)) { reject("duplicate-id", `two operations share the id "${op.id}"`, op.id); continue; }
    ids.add(op.id);

    if (!isStr(op.page)) reject("operation-page", `${where} names no page`, op.id);
    else if (approved.size && !approved.has(op.page)) {
      reject("unapproved-page", `${where} plans work on "${op.page}", which is not a page of the approved design`, op.id);
    }

    if (!isStr(op.element)) reject("operation-element", `${where} names no element`, op.id);
    if (!isStr(op.behaviour)) reject("operation-behaviour", `${where} does not say what it should do`, op.id);

    if (!op.kind || !OPERATION_KINDS.includes(op.kind as OperationKind)) {
      reject("operation-kind", `${where} has kind ${JSON.stringify(op.kind ?? null)}; expected one of ${OPERATION_KINDS.join(", ")}`, op.id);
    }

    if (op.expectChange !== "content" && op.expectChange !== "none") {
      reject("expect-change", `${where} must say whether making it work changes the page's content ("content") or not ("none")`, op.id);
    }

    // An operation with no acceptance criterion cannot be verified, so it can never honestly be reported done.
    if (!Array.isArray(op.acceptance) || op.acceptance.filter(isStr).length === 0) {
      reject("no-acceptance", `${where} has no acceptance criteria, so there would be no way to tell whether it works`, op.id);
    }

    // A probe must point at a criterion that exists and a surface that was declared. An out-of-range index would
    // silently establish nothing (or, worse, the wrong criterion), and a path nobody declared would let the contract
    // be verified against an endpoint the contract never agreed to.
    const probes = Array.isArray(op.acceptanceProbes) ? op.acceptanceProbes : [];
    const declaredPaths = new Set(((man as { apis?: { path?: unknown }[] }).apis ?? []).map((a) => String(a?.path ?? "")));
    const seenCriteria = new Set<number>();
    for (const [n, pr] of probes.entries()) {
      const at = `${where} probe ${n + 1}`;
      if (!Number.isInteger(pr?.criterion) || pr.criterion < 0 || pr.criterion >= (op.acceptance?.length ?? 0)) {
        reject("probe-criterion", `${at} points at acceptance criterion ${String(pr?.criterion)}, and this operation has ${op.acceptance?.length ?? 0}`, op.id);
        continue;
      }
      if (seenCriteria.has(pr.criterion)) {
        reject("probe-duplicate", `${at} is the second probe for criterion ${pr.criterion}; one criterion is established by one probe`, op.id);
      }
      seenCriteria.add(pr.criterion);
      if (pr.as !== "anonymous" && pr.as !== "customer" && pr.as !== "other-customer") {
        reject("probe-session", `${at} must say who makes the request: anonymous, customer or other-customer`, op.id);
      }
      if (!Number.isInteger(pr.expect) || pr.expect < 100 || pr.expect > 599) {
        reject("probe-status", `${at} must expect an HTTP status, not ${String(pr.expect)}`, op.id);
      }
      if (!isStr(pr.path) || !declaredPaths.has(pr.path)) {
        reject("probe-path", `${at} probes ${String(pr.path)}, which is not one of the declared apis`, op.id);
      }
    }

    if ((op.kind === "data-write" || op.kind === "form-submit" || op.kind === "payment") && !op.dataModel?.length) {
      warn("no-data-model", `${where} writes data but names no table or fields`, op.id);
    }

    ops.push(op as IntegrationOperation);
  }

  // A declared visual state must name an approved page and a role the runner can actually be signed in as. A page
  // nobody approved cannot be compared against anything, and a blank role would silently capture anonymously --
  // which is the very thing the declaration exists to stop.
  const seenStates = new Set<string>();
  for (const [n, vs] of ((man as { visualStates?: VisualState[] }).visualStates ?? []).entries()) {
    const at = `visual state ${n + 1}`;
    if (!isStr(vs?.page) || (o.approvedPages && !o.approvedPages.includes(vs.page))) {
      reject("visual-state-page", `${at} names the page "${String(vs?.page)}", which is not one of the approved pages`);
      continue;
    }
    if (seenStates.has(vs.page)) reject("visual-state-duplicate", `${at} is the second declaration for "${vs.page}"`);
    seenStates.add(vs.page);
    if (!isStr(vs.session) || !/^[a-z][a-z0-9_-]{1,23}$/.test(vs.session)) {
      reject("visual-state-session", `${at} must name the role to sign in as, in lower case (got ${JSON.stringify(vs.session)})`);
    }
    for (const sel of vs.mask ?? []) {
      if (!isStr(sel) || !sel.trim()) reject("visual-state-mask", `${at} has an empty selector in its mask`);
    }
  }

  // Dependencies must resolve, and must not form a cycle: a cycle means no operation can ever start.
  for (const op of ops) {
    for (const d of op.dependsOn ?? []) {
      if (!ids.has(d)) reject("unknown-dependency", `operation "${op.id}" depends on "${d}", which is not in the plan`, op.id);
    }
  }
  const cycle = findCycle(ops);
  if (cycle) reject("dependency-cycle", `these operations depend on each other in a loop, so none can start: ${cycle.join(" → ")}`);

  const ok = !problems.some((p) => p.severity === "reject");
  return { ok, problems, manifest: ok ? (man as IntegrationManifest) : null };
}

/** The first dependency cycle, as the chain of ids that closes it. */
function findCycle(ops: readonly IntegrationOperation[]): string[] | null {
  const byId = new Map(ops.map((o) => [o.id, o]));
  const state = new Map<string, 0 | 1 | 2>();   // 0 unseen, 1 on the stack, 2 done
  const stack: string[] = [];

  const walk = (id: string): string[] | null => {
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    if (state.get(id) === 2) return null;
    state.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(d)) continue;
      const c = walk(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const o of ops) {
    const c = walk(o.id);
    if (c) return c;
  }
  return null;
}

/**
 * What the design lock should accept as declared content change.
 *
 * One entry per page, not per operation: the lock compares pages. A page with any `content` operation is declared
 * as changing, and the reason names the operations so the drift report says why.
 */
export function declaredChanges(m: IntegrationManifest): { page: string; expect: "content" | "none"; reason?: string }[] {
  const byPage = new Map<string, IntegrationOperation[]>();
  for (const op of m.operations) {
    const list = byPage.get(op.page) ?? [];
    list.push(op);
    byPage.set(op.page, list);
  }
  return [...byPage.entries()].map(([page, ops]) => {
    const changing = ops.filter((o) => o.expectChange === "content");
    return changing.length
      ? { page, expect: "content" as const, reason: changing.map((o) => `${o.id} (${o.element})`).join(", ") }
      : { page, expect: "none" as const };
  });
}

export interface Coverage {
  /** Interactions that plainly need a backend and that no operation claims. */
  uncovered: InteractionItem[];
  /** Operations pointing at an element the inventory does not contain. */
  unmatched: IntegrationOperation[];
  /** Of the interactions needing a backend, how many are claimed. */
  covered: number;
  needingBackend: number;
}

/**
 * Which of the approved frontend's interactions the plan actually covers.
 *
 * This is the check that stops "the AI made the site work" from meaning "the AI wired up the contact form and
 * left the booking flow as a dead button". Elements that need no backend are not counted against the plan.
 */
export function coverage(m: IntegrationManifest, inventory: readonly InteractionItem[]): Coverage {
  const claimed = new Set(m.operations.map((o) => `${o.page}|${o.element}`));
  const known = new Set(inventory.map((i) => `${i.page}|${i.element}`));
  const needing = inventory.filter((i) => i.needsBackend);
  const uncovered = needing.filter((i) => !claimed.has(`${i.page}|${i.element}`));
  return {
    uncovered,
    unmatched: m.operations.filter((o) => known.size > 0 && !known.has(`${o.page}|${o.element}`)),
    covered: needing.length - uncovered.length,
    needingBackend: needing.length,
  };
}

/**
 * The contract minus the operations whose essential facts are not known.
 *
 * A recorded gap (`missing`) is correct work: the Founder's instruction is that a business requirement which
 * genuinely cannot be established from the frontend is FLAGGED, specifically, rather than invented. But flagging
 * it and then handing the operation to the builder anyway is the same as inventing it one step later -- the model
 * is asked to make a checkout work and told nothing about the provider or the price, and something plausible
 * comes out. That is the defect that reaches a customer.
 *
 * So an operation named in any `missing[].blocks` is removed from the manifest the BUILD uses -- WHEN the gap is
 * one that actually makes building it dishonest. It is then not implemented, not prompted for, not judged by the
 * three gates, and not counted as covered. It stays in the recorded contract, where the gap is also recorded, so
 * what was deferred and why is on the project's record rather than quietly absent.
 *
 * That qualification is the whole subtlety, and it was measured rather than guessed. Asked to draft a contract
 * for a three-page haul site, Model A produced a correct plan for its one quote form and recorded two open
 * questions against it: where email notifications should go, and how long a request should be kept. Both named
 * the operation in `blocks`. Neither prevents storing a quote request honestly -- the plan sends no email and the
 * contract's own data model says what is stored -- so deferring on the model's say-so would have turned a good
 * contract into a build with nothing to do.
 *
 * `completeness` already knows which gaps are fatal: run it with the recorded gaps REMOVED, and the operations it
 * objects to are exactly the ones whose essential facts are absent. An operation is deferred only if it is both
 * named in `blocks` and one of those. The rest of the plan is built, and the remaining questions stay as review
 * flags for a person. One open preference does not stop the work; one unknown price does.
 */
export function withoutBlocked(m: IntegrationManifest & ManifestContract): {
  manifest: IntegrationManifest & ManifestContract;
  deferred: { id: string; why: string }[];
  /** Recorded gaps that block nothing essential: still questions for a person, not reasons to stop. */
  openQuestions: MissingRequirement[];
} {
  const claimed = new Map<string, string>();
  for (const gap of m.missing ?? []) {
    for (const id of gap.blocks ?? []) {
      if (!claimed.has(id)) claimed.set(id, `${gap.what}: ${gap.why}`);
    }
  }
  // Which operations cannot be carried out honestly with what the contract declares, judged WITHOUT the recorded
  // gaps -- otherwise a gap would be its own justification for stopping.
  const essential = new Set(
    completeness({ ...m, missing: [] }).blockers
      .map((b) => b.operationId)
      .filter((x): x is string => !!x),
  );
  const blocked = new Map([...claimed].filter(([id]) => essential.has(id)));
  const openQuestions = (m.missing ?? []).filter((gap) => !(gap.blocks ?? []).some((id) => blocked.has(id)));
  if (!blocked.size) return { manifest: m, deferred: [], openQuestions };

  const kept = m.operations.filter((op) => !blocked.has(op.id));
  const deferred = m.operations.filter((op) => blocked.has(op.id)).map((op) => ({ id: op.id, why: blocked.get(op.id)! }));
  return {
    manifest: {
      ...m,
      operations: kept.map((op) => ({
        ...op,
        // A dependency on a deferred operation cannot be satisfied, and leaving it would make the execution order
        // depend on something that is not in the plan.
        dependsOn: (op.dependsOn ?? []).filter((d) => !blocked.has(d)),
      })),
      // Said in the manifest itself, so the implementation prompt carries the reason rather than a silence.
      outOfScope: [
        ...(m.outOfScope ?? []),
        ...deferred.map((x) => `${x.id} is deferred: ${x.why}. Do not implement it and do not invent what is missing.`),
      ],
    },
    deferred,
    openQuestions,
  };
}

/** Operations that must not go live without a person releasing them. */
export function requiresRelease(m: IntegrationManifest): IntegrationOperation[] {
  return m.operations.filter((o) => RELEASE_GATED.includes(o.kind));
}

/**
 * Execution order: dependencies first, and otherwise the manifest's own order.
 *
 * Returns null on a cycle rather than guessing, because a partial order built from a cyclic plan would quietly
 * drop operations.
 */
export function executionOrder(m: IntegrationManifest): IntegrationOperation[] | null {
  if (findCycle(m.operations)) return null;
  const byId = new Map(m.operations.map((o) => [o.id, o]));
  const done = new Set<string>();
  const out: IntegrationOperation[] = [];
  const visit = (op: IntegrationOperation) => {
    if (done.has(op.id)) return;
    done.add(op.id);
    for (const d of op.dependsOn ?? []) {
      const dep = byId.get(d);
      if (dep) visit(dep);
    }
    out.push(op);
  };
  for (const op of m.operations) visit(op);
  return out;
}

/** The manifest in words, for the build record. */
export function describeManifest(m: IntegrationManifest, c?: Coverage): string {
  const kinds = new Map<string, number>();
  for (const o of m.operations) kinds.set(o.kind, (kinds.get(o.kind) ?? 0) + 1);
  const parts = [
    `${m.operations.length} operation(s) across ${new Set(m.operations.map((o) => o.page)).size} page(s)`,
    [...kinds.entries()].map(([k, n]) => `${n} ${k}`).join(", "),
  ];
  const gated = requiresRelease(m);
  if (gated.length) parts.push(`${gated.length} need a person to release them (${[...new Set(gated.map((o) => o.kind))].join(", ")})`);
  if (c) parts.push(c.uncovered.length ? `${c.uncovered.length} interaction(s) needing a backend are NOT in the plan: ${c.uncovered.slice(0, 5).map((i) => `${i.page}/${i.element}`).join(", ")}` : `every interaction needing a backend is covered (${c.covered}/${c.needingBackend})`);
  if (m.outOfScope?.length) parts.push(`out of scope: ${m.outOfScope.join("; ")}`);
  return parts.filter(Boolean).join("; ");
}

/** Problems in words. */
export function describeManifestProblems(p: readonly ManifestProblem[]): string {
  return p.map((x) => `${x.severity.toUpperCase()} ${x.code}${x.operationId ? ` [${x.operationId}]` : ""}: ${x.detail}`).join("\n");
}

// ── §6: the rest of the contract ────────────────────────────────────────────────────────────────────────────
//
// These blocks are OPTIONAL on the manifest itself and REQUIRED by `completeness()` for the operations that
// need them. That split is deliberate. A plan can be written and validated before every credential is known —
// what it may not do is proceed while pretending it knows. An operation that takes a payment and names no
// provider, no secret and no `missing` entry is a plan that will produce a fake checkout, so it is a blocker.
//
// Nothing here invents a provider, a price or a contract. §5 and §8 are explicit: missing essential
// requirements are RECORDED, never guessed.

export const PACKAGES = ["starter", "business", "premium", "custom"] as const;
export type PackageId = (typeof PACKAGES)[number];

export interface DataModel { table: string; fields: string[]; purpose?: string }
export interface ApiRequirement { method: string; path: string; auth?: "public" | "customer" | "staff" | "admin"; purpose?: string }
export interface SecretRequirement {
  name: string;
  purpose: string;
  /** False when the value is not available yet. A false here is a blocker, not a detail. */
  provided: boolean;
}
export interface ExternalIntegration {
  name: string;
  origin?: string;
  /** Only the Founder or the customer can approve a third-party service. The AI never sets this to true. */
  approved: boolean;
  mode?: "test" | "live";
  note?: string;
}
/** Something essential that is not known. Recorded so it can be asked for, rather than invented. */
export interface MissingRequirement { what: string; why: string; blocks: string[] }

export interface ManifestContract {
  project?: { customerId?: string; projectId?: string; packageId?: PackageId; scope?: string };
  runtime?: { framework?: string; node?: string; deploy?: string };
  dataModels?: DataModel[];
  apis?: (ApiRequirement | ApiContract)[];
  auth?: { required: boolean; roles?: string[]; provider?: string };
  secrets?: SecretRequirement[];
  externalIntegrations?: ExternalIntegration[];
  security?: string[];
  /** Which approved baseline this plan is written against, by id as well as fingerprint. */
  baselineRef?: { baselineId?: string; version?: number; fingerprint?: string };
  missing?: MissingRequirement[];
  /** What the approved architecture requires, as opposed to describes. See the section at the end of this file. */
  persistence?: PersistenceContract;
  projectConfig?: ProjectConfigContract;
  securityControls?: SecurityControl[];
}

export interface Completeness {
  /** True when every operation that needs a credential, a provider or a data model has one, or says it does not. */
  ok: boolean;
  blockers: { code: string; detail: string; operationId?: string }[];
  /** Recorded gaps, which are not failures: they are the questions to ask. */
  missing: MissingRequirement[];
}

/**
 * Can this plan be executed honestly?
 *
 * Separate from `validateManifest`, which asks whether the plan is well-formed. This asks whether carrying it
 * out would produce real behaviour — the question that stops a payment flow reporting success without a
 * payment, and an integration quietly becoming a stub.
 */
export function completeness(m: IntegrationManifest & ManifestContract): Completeness {
  const blockers: { code: string; detail: string; operationId?: string }[] = [];
  const missing = m.missing ?? [];
  const named = (text: string) => missing.some((x) => `${x.what} ${x.why}`.toLowerCase().includes(text.toLowerCase()));

  const secrets = m.secrets ?? [];
  for (const s of secrets.filter((x) => !x.provided)) {
    blockers.push({ code: "secret-unavailable", detail: `${s.name} is required (${s.purpose}) and is not available; the work that needs it cannot be finished` });
  }

  const integrations = m.externalIntegrations ?? [];
  for (const i of integrations.filter((x) => !x.approved)) {
    blockers.push({ code: "integration-unapproved", detail: `${i.name}${i.origin ? ` (${i.origin})` : ""} has not been approved by the Founder or the customer; it is not wired up on the AI's say-so` });
  }

  for (const op of m.operations) {
    if (op.kind === "payment") {
      const provider = integrations.find((i) => i.approved && (i.mode === "test" || i.mode === "live"));
      if (!provider && !named("payment")) {
        blockers.push({
          code: "payment-without-provider", operationId: op.id,
          detail: `"${op.id}" takes a payment but the plan names no approved payment provider and no mode. A checkout that reports success without one is a fake checkout; name the provider, or record it as missing.`,
        });
      } else if (provider && provider.mode === "live") {
        blockers.push({
          code: "payment-live-mode", operationId: op.id,
          detail: `"${op.id}" is planned against ${provider.name} in LIVE mode. Autonomous work runs in test mode; a person enables live.`,
        });
      }
    }

    if (op.kind === "auth" && !m.auth?.required && !named("auth")) {
      blockers.push({
        code: "auth-without-contract", operationId: op.id,
        detail: `"${op.id}" signs a user in, but the plan declares no authentication requirements (roles, provider). Who may sign in, and as what, is not for the AI to decide.`,
      });
    }

    if (op.kind === "email" && !secrets.some((s) => /resend|smtp|mail|sendgrid|postmark/i.test(s.name)) && !named("email")) {
      blockers.push({
        code: "email-without-transport", operationId: op.id,
        detail: `"${op.id}" sends mail and the plan names no mail transport or its credential.`,
      });
    }

    // A write needs somewhere to write to. A table named nowhere in the data models is a table nobody designed.
    if ((op.kind === "data-write" || op.kind === "form-submit") && op.dataModel?.length) {
      for (const d of op.dataModel) {
        if (!(m.dataModels ?? []).some((x) => x.table === d.table)) {
          blockers.push({
            code: "table-not-modelled", operationId: op.id,
            detail: `"${op.id}" writes to "${d.table}", which is not in the plan's data models; the schema for it has not been designed`,
          });
        }
      }
    }
  }

  const pkg = m.project?.packageId;
  if (pkg && !PACKAGES.includes(pkg)) {
    blockers.push({ code: "unknown-package", detail: `"${pkg}" is not one of ${PACKAGES.join(", ")}; package scope cannot be invented` });
  }

  for (const x of missing) {
    if (!x.what?.trim() || !x.why?.trim()) blockers.push({ code: "vague-missing-entry", detail: "a recorded gap must say what is missing and why it matters" });
  }

  return { ok: blockers.length === 0, blockers, missing };
}

/** The contract in words, including what is NOT known. */
export function describeContract(m: IntegrationManifest & ManifestContract): string {
  const c = completeness(m);
  const lines: string[] = [];
  if (m.project) lines.push(`project ${m.project.projectId ?? "(unnamed)"}, package ${m.project.packageId ?? "(unstated)"}`);
  if (m.runtime?.framework) lines.push(`runtime: ${m.runtime.framework}${m.runtime.node ? ` on node ${m.runtime.node}` : ""}`);
  if (m.baselineRef?.fingerprint) lines.push(`against baseline ${m.baselineRef.version ? `v${m.baselineRef.version} ` : ""}${m.baselineRef.fingerprint.slice(0, 16)}…`);
  if (m.dataModels?.length) lines.push(`${m.dataModels.length} table(s): ${m.dataModels.map((d) => d.table).join(", ")}`);
  if (m.apis?.length) lines.push(`${m.apis.length} endpoint(s): ${m.apis.slice(0, 6).map((a) => `${a.method} ${a.path}`).join(", ")}`);
  if (m.auth?.required) lines.push(`authentication required${m.auth.roles?.length ? ` for ${m.auth.roles.join(", ")}` : ""}`);
  if (m.secrets?.length) lines.push(`${m.secrets.length} secret(s), ${m.secrets.filter((s) => !s.provided).length} not available`);
  if (m.externalIntegrations?.length) lines.push(`external: ${m.externalIntegrations.map((i) => `${i.name}${i.approved ? "" : " (NOT APPROVED)"}`).join(", ")}`);
  for (const x of c.missing) lines.push(`missing — ${x.what}: ${x.why} (blocks ${x.blocks.join(", ") || "nothing yet"})`);
  for (const b of c.blockers) lines.push(`BLOCKER ${b.code}${b.operationId ? ` [${b.operationId}]` : ""}: ${b.detail}`);
  lines.push(c.ok ? "the plan can be carried out honestly with what it declares" : `${c.blockers.length} blocker(s) must be resolved by a person before this plan is executable`);
  return lines.join("\n");
}

// ── what the contract REQUIRES, as opposed to what it merely describes ──────────────────────────────────────
//
// The distinction this adds is the one the first autonomous run exposed. Model B built a quote form that
// worked perfectly and stored its rows in a JSON file, while the manifest named a `quote_requests` table. Every
// behavioural check passed, because behaviour was all anything checked.
//
// So the contract now says, per area, whether a particular implementation is REQUIRED or whether any one that
// behaves correctly will do. "Required" is enforced; "any" is left alone. A contract that enforced everything
// would make the model's judgement worthless, and one that enforced nothing is what we already had.

export type Enforcement = "required" | "any";

export interface PersistenceContract {
  /** `required` means this exact technology; `any` means any mechanism that genuinely persists. */
  enforcement: Enforcement;
  /** The storage the approved architecture uses. */
  technology: "sqlite" | "d1" | "postgres" | "mysql" | "kv" | "file";
  /** How a reader can tell the technology is really in use: an import, a binding, a call. */
  evidence?: string[];
  /** Rows must survive a restart of the application. Almost always true; stated so it can be checked. */
  durable?: boolean;
}

export interface ProjectConfigContract {
  /**
   * Scripts the approved frontend already had and that must keep doing what they did.
   *
   * `"preserve"` means the command may not change at all. A string means it must end up exactly that. The
   * first autonomous run silently repointed `dev` from `vite` to `node server.js`: defensible, but it replaced
   * a working command in the Founder's project without anyone agreeing to it.
   */
  scripts?: Record<string, string | "preserve">;
  /** Dependencies the integration may add. Anything else is a deviation to be explained, not assumed. */
  allowedDependencies?: string[];
  /** Scripts the integration may add. */
  allowedNewScripts?: string[];
}

export interface SecurityControl {
  id: string;
  /** What must be true, in words, for the report. */
  requirement: string;
  /** A symbol, call or pattern whose presence in the source is evidence of it. */
  evidence?: string[];
}

export interface ApiContract extends ApiRequirement {
  /** The status a well-formed request must get. */
  success?: number;
  /** The status an invalid request must get. 422 by default for anything that validates. */
  invalid?: number;
  /** When set, an unauthenticated request must get this. */
  unauthenticated?: number;
  /**
   * A well-formed request body, so the independent acceptance driver can exercise this endpoint for real.
   *
   * Without it the driver can only check that an endpoint refuses what it should refuse; it cannot check that a
   * valid request succeeds, because it would have to invent a body and would then be testing its own guess. An
   * endpoint with no example is reported UNDETERMINED rather than skipped.
   *
   * `{{email}}` and `{{password}}` in a string are replaced with credentials the driver generates for itself, so
   * the contract never carries one.
   */
  requestExample?: Record<string, unknown>;
}
