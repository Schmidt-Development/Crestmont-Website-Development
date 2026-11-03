// Automatic readiness derivation (READY-013).
//
// Status is DERIVED from evidence, never asserted. Every requirement declares what proves it
// (requirements/acceptance.ts); this module reads the evidence CI, the staging deploy and the production
// checks already post, and computes where each requirement actually stands.
//
// Three rules the derivation never breaks:
//   1. A passing test never implies a deployment. DEPLOYED_* needs a succeeded deployment row at the
//      same commit the tests passed at.
//   2. A deployment never implies functional certification. *_VERIFIED needs evidence from that
//      environment, at the deployed commit.
//   3. Evidence certifies the commit it ran at and nothing else. When the integration head moves past the
//      commit a requirement was last proven at, the requirement becomes EVIDENCE_STALE rather than keeping
//      a verdict earned by code that has since changed.

import type { Env } from "./engine.ts";
import { ACCEPTANCE, type Acceptance, type CompleteAt } from "../../requirements/acceptance.ts";

export type AutoState =
  | "NOT_IMPLEMENTED" | "IMPLEMENTED" | "MERGED" | "DEPLOYED_STAGING" | "STAGING_VERIFIED"
  | "DEPLOYED_PRODUCTION" | "PRODUCTION_VERIFIED" | "BLOCKED" | "REGRESSED" | "EVIDENCE_STALE";

/** Ordering of the progress ladder. States off the ladder (blocked, regressed, stale) rank 0 and are never complete. */
const RANK: Record<AutoState, number> = {
  NOT_IMPLEMENTED: 0, BLOCKED: 0, REGRESSED: 0, EVIDENCE_STALE: 0,
  IMPLEMENTED: 2, MERGED: 3, DEPLOYED_STAGING: 4, STAGING_VERIFIED: 5, DEPLOYED_PRODUCTION: 6, PRODUCTION_VERIFIED: 7,
};
const COMPLETE_RANK: Record<CompleteAt, number> = { IMPLEMENTED: 2, STAGING_VERIFIED: 5, PRODUCTION_VERIFIED: 7 };

export interface DeriveEvidenceRow {
  requirement_id: string; outcome: "passed" | "failed" | "skipped"; test_name: string; run_id: string;
  environment: Env; source: string; commit_sha: string; branch: string | null; finished_at: string;
}
export interface DeriveDeploymentRow { id: string; environment: Env; commit_sha: string; status: string; deployed_at: string }
export interface DeriveRequirementRow { id: string; category: string; subsystem: string; disposition: string }

export interface DeriveInput {
  requirements: DeriveRequirementRow[];
  evidence: DeriveEvidenceRow[];
  deployments: DeriveDeploymentRow[];
  openBlockerRequirementIds: Map<string, string[]>; // requirement id → open blocker ids (the discovery register)
  /** Every open blocker id. An acceptance entry naming one gates its requirement whether or not the
   *  legacy blocker_requirements table happens to link them. */
  openBlockerIds?: Set<string>;
  /** Open release-blocking security findings, so an acceptance gate can name one (e.g. F-02 malware scanning). */
  openFindingIds?: Set<string>;
  now: Date;
  freshnessHours?: number;
  defaultBranch?: string;
  acceptance?: Record<string, Acceptance>;
}

export interface DerivedRequirement {
  id: string;
  state: AutoState;
  /** The state the ladder reached ignoring blockers — so a blocked requirement still shows the work that is done. */
  progress: AutoState;
  complete: boolean;
  completeAt: CompleteAt;
  tracking: "platform" | "external_ai";
  /** One sentence saying why the requirement is where it is. Shown on the dashboard. */
  detail: string;
  /** The commit the requirement was last proven at, if any. */
  provenCommit: string | null;
  /** The integration head this derivation judged against. */
  headCommit: string | null;
  evidenceRunIds: string[];
  blockers: string[];
  lastEvidenceAt: string | null;
  /** True when the newest evidence is older than the freshness window, independent of the commit rule. */
  stale: boolean;
}

const HOUR = 3_600_000;
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "unknown");

/** The commit readiness is judged against: the newest CI evidence on the default branch. */
export function integrationHead(evidence: DeriveEvidenceRow[], defaultBranch = "main"): string | null {
  const ci = evidence.filter((e) => e.source === "ci");
  const onBranch = ci.filter((e) => e.branch === defaultBranch);
  const pool = onBranch.length ? onBranch : ci;
  if (!pool.length) return null;
  let newest = pool[0];
  for (const e of pool) if (e.finished_at > newest.finished_at) newest = e;
  return newest.commit_sha;
}

/** Latest succeeded deployment per environment. */
function latestDeployments(rows: DeriveDeploymentRow[]): Partial<Record<Env, DeriveDeploymentRow>> {
  const out: Partial<Record<Env, DeriveDeploymentRow>> = {};
  for (const d of rows) {
    if (d.status !== "succeeded") continue;
    const cur = out[d.environment];
    // Deterministic even when two deployments share a timestamp: the id breaks the tie, so the same rows
    // always give the same answer however the database returns them.
    if (!cur || d.deployed_at > cur.deployed_at || (d.deployed_at === cur.deployed_at && d.id > cur.id)) out[d.environment] = d;
  }
  return out;
}

interface Verdict { outcome: "passed" | "failed" | "none"; runIds: string[]; at: string | null }

/** The verdict a set of rows gives. Skipped rows never count as a pass and never as a failure. */
function verdictOf(rows: DeriveEvidenceRow[]): Verdict {
  const real = rows.filter((r) => r.outcome !== "skipped");
  if (!real.length) return { outcome: "none", runIds: [], at: null };
  const at = real.reduce((m, r) => (r.finished_at > m ? r.finished_at : m), "");
  return { outcome: real.some((r) => r.outcome === "failed") ? "failed" : "passed", runIds: [...new Set(real.map((r) => r.run_id))], at };
}

export function deriveRequirementStates(input: DeriveInput): DerivedRequirement[] {
  const acceptance = input.acceptance ?? ACCEPTANCE;
  const head = integrationHead(input.evidence, input.defaultBranch ?? "main");
  const deploys = latestDeployments(input.deployments);
  const fresh = (input.freshnessHours ?? 72) * HOUR;

  const byReq = new Map<string, DeriveEvidenceRow[]>();
  for (const e of input.evidence) {
    const list = byReq.get(e.requirement_id);
    if (list) list.push(e); else byReq.set(e.requirement_id, [e]);
  }

  return input.requirements.map((r) => {
    const a = acceptance[r.id] ?? { criteria: "", completeAt: "IMPLEMENTED" as CompleteAt, tracking: "platform" as const };
    const rows = byReq.get(r.id) ?? [];
    const openIds = input.openBlockerIds ?? new Set(([] as string[]).concat(...[...input.openBlockerRequirementIds.values()]));
    const openFindings = input.openFindingIds ?? new Set<string>();
    const gateRef = a.external?.blocker ?? a.external?.finding ?? null;
    const gateOpen = !!a.external && ((!!a.external.blocker && openIds.has(a.external.blocker)) || (!!a.external.finding && openFindings.has(a.external.finding)));
    const blockers = [...new Set([...(input.openBlockerRequirementIds.get(r.id) ?? []), ...(gateOpen && gateRef ? [gateRef] : [])])];
    const externalBlocker = gateOpen ? a.external : undefined;
    const runIds: string[] = [];
    const lastEvidenceAt = rows.length ? rows.reduce((m, x) => (x.finished_at > m ? x.finished_at : m), "") : null;
    const stale = lastEvidenceAt !== null && input.now.getTime() - Date.parse(lastEvidenceAt) > fresh;

    const ci = rows.filter((e) => e.source === "ci");
    const atHead = head ? verdictOf(ci.filter((e) => e.commit_sha === head)) : { outcome: "none" as const, runIds: [], at: null };
    const everPassed = ci.some((e) => e.outcome === "passed");
    const lastPassedCommit = ci.filter((e) => e.outcome === "passed").sort((x, y) => (x.finished_at < y.finished_at ? 1 : -1))[0]?.commit_sha ?? null;

    let progress: AutoState;
    let detail: string;
    let provenCommit: string | null = null;

    if (atHead.outcome === "failed") {
      progress = everPassed ? "REGRESSED" : "NOT_IMPLEMENTED";
      runIds.push(...atHead.runIds);
      detail = everPassed
        ? `A test tagged with this requirement is failing at ${short(head)}; it last passed at ${short(lastPassedCommit)}.`
        : `A test tagged with this requirement is failing at ${short(head)} and it has never passed.`;
    } else if (atHead.outcome === "none") {
      if (everPassed) {
        progress = "EVIDENCE_STALE";
        detail = `Last proven at ${short(lastPassedCommit)}; no CI evidence for this requirement at the current head ${short(head)}, so the earlier result no longer certifies it.`;
      } else {
        progress = "NOT_IMPLEMENTED";
        detail = rows.length
          ? `No passing CI evidence: every result so far is skipped or failing.`
          : `No test is tagged with this requirement, so nothing proves it.`;
      }
    } else {
      provenCommit = head;
      runIds.push(...atHead.runIds);
      const ciRun = ci.find((e) => e.commit_sha === head && e.outcome === "passed");
      progress = ciRun && ciRun.branch === (input.defaultBranch ?? "main") ? "MERGED" : "IMPLEMENTED";
      detail = progress === "MERGED"
        ? `Tagged tests pass in CI at ${short(head)} on the default branch.`
        : `Tagged tests pass in CI at ${short(head)}, which is not recorded as the default branch.`;

      // Rule 1: a deployment is needed before any DEPLOYED_* state, and it must carry the proven commit.
      for (const [env, deployed, verified] of [
        ["staging", "DEPLOYED_STAGING", "STAGING_VERIFIED"],
        ["production", "DEPLOYED_PRODUCTION", "PRODUCTION_VERIFIED"],
      ] as const) {
        const d = deploys[env];
        if (!d || d.commit_sha !== head) {
          if (d) detail += ` The latest ${env} deployment is at ${short(d.commit_sha)}, not ${short(head)}.`;
          continue;
        }
        progress = deployed;
        detail += ` Deployed to ${env} at ${short(head)}.`;
        // Rule 2: the deployment alone proves nothing about behaviour.
        const envVerdict = verdictOf(rows.filter((e) => e.environment === env && e.source !== "ci" && e.commit_sha === head));
        if (envVerdict.outcome === "passed") {
          progress = verified;
          runIds.push(...envVerdict.runIds);
          detail += ` Verified on ${env} by evidence from that same commit.`;
        } else if (envVerdict.outcome === "failed") {
          progress = "REGRESSED";
          runIds.push(...envVerdict.runIds);
          detail += ` ${env.charAt(0).toUpperCase()}${env.slice(1)} evidence at that commit FAILED.`;
          break;
        } else {
          detail += ` No ${env} evidence at that commit yet, so it is deployed but not certified.`;
        }
      }
    }

    // A requirement no test can prove (a legal entity, a vendor account, a captured screenshot) is established by
    // its external fact: the blocker that gates it being resolved IS the evidence. Code evidence, where it exists,
    // still lifts it further, and a failing test still outranks the attestation.
    if (a.external && !gateOpen && progress === "NOT_IMPLEMENTED" && atHead.outcome !== "failed") {
      progress = "IMPLEMENTED";
      detail = `Established by ${gateRef}, which is resolved: ${a.external.note}.`;
    }

    // Every source the acceptance registry demands must show a pass at the proven commit.
    const missingSources = (a.requires ?? []).filter(
      (src) => verdictOf(rows.filter((e) => e.source === src && (provenCommit ? e.commit_sha === provenCommit : true))).outcome !== "passed",
    );
    if (missingSources.length && RANK[progress] > 0) detail += ` Still needs passing ${missingSources.join(" and ")} evidence.`;

    // A regression is more urgent than a blocker, so it is never hidden behind one.
    let state: AutoState = progress;
    if (progress !== "REGRESSED" && blockers.length) {
      state = "BLOCKED";
      detail += externalBlocker
        ? ` Blocked by ${gateRef}: ${externalBlocker.note}.`
        : ` Blocked by ${blockers.join(", ")}.`;
    }

    const complete = state !== "BLOCKED" && state !== "REGRESSED" && RANK[progress] >= COMPLETE_RANK[a.completeAt] && missingSources.length === 0;

    return {
      id: r.id, state, progress, complete, completeAt: a.completeAt, tracking: a.tracking,
      detail: detail.trim(), provenCommit, headCommit: head,
      evidenceRunIds: [...new Set(runIds)], blockers, lastEvidenceAt, stale,
    };
  });
}

/** Legacy three-value implementation status, derived. Kept so the existing engine, CSV and gates keep working. */
export function implementationFrom(d: DerivedRequirement): "not_started" | "in_progress" | "implemented" {
  if (d.complete) return "implemented";
  if (d.progress === "NOT_IMPLEMENTED") return "not_started";
  return "in_progress";
}
