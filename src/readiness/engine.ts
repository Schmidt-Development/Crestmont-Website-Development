// Launch Readiness engine (§36–§50). Pure functions over stored records so the
// dashboard, CSV export and PDF packet all derive from the same computation (§48).

export type Env = "development" | "staging" | "production";
export const ENVS: Env[] = ["development", "staging", "production"];

export interface RequirementRow {
  id: string; subsystem: string; section: string; title: string;
  priority: "P0" | "P1" | "P2";
  category: "engineering" | "integration" | "security" | "business" | "founder";
  implementation_status: "not_started" | "in_progress" | "implemented";
  disposition: "in_scope" | "deferred_by_founder" | "excluded_by_founder";
  blocked_reason: string | null;
  requires_founder_approval: number;
}

export interface EvidenceRow {
  requirement_id: string; outcome: "passed" | "failed" | "skipped"; test_name: string;
  run_id: string; environment: Env; source: string; commit_sha: string; finished_at: string;
}

export interface BlockerRow { id: string; category: string; status: "open" | "resolved"; severity: string; requirement_ids: string[] }
export interface FindingRow { id: string; severity: string; release_blocking: number; status: string }
export interface IngestionRow { source: string; last_success_at: string | null; last_attempt_at: string | null; last_error: string | null }
export interface ApprovalRow {
  id: string; kind: string; decision: "approved" | "rejected"; commit_sha: string | null; config_sha256: string | null;
  evidence_set_sha256: string | null; invalidated_at: string | null; created_at: string; approver_is_owner: boolean;
}
export interface IntegrationRow { integration: string; environment: Env; status: string; checked_at: string }

export type DerivedState =
  | "not_started" | "in_progress" | "implemented" | "test_pending" | "test_failed"
  | "verified_in_development" | "verified_in_staging" | "production_verified"
  | "blocked" | "requires_founder_approval";

export type EnvVerification = "passed" | "failed" | "none";

export interface RequirementStatus {
  id: string; subsystem: string; title: string; priority: string; category: string; disposition: string;
  implementation: "not_started" | "in_progress" | "implemented";
  verification: Record<Env, EnvVerification>;
  state: DerivedState;
  lastVerifiedAt: string | null;
  evidenceRunIds: string[];
  stale: boolean;
  blockers: string[];
}

export interface ReadinessInput {
  requirements: RequirementRow[];
  evidence: EvidenceRow[];
  blockers: BlockerRow[];
  findings: FindingRow[];
  ingestion: IngestionRow[];
  approvals: ApprovalRow[];
  integrations: IntegrationRow[];
  releaseCandidate: { commit_sha: string; config_sha256: string } | null;
  productionDeployment: { commit_sha: string } | null;
  now: Date;
  freshnessHours?: number;
}

const HOUR = 3_600_000;

/** Per environment, the latest run that tested a requirement decides its verification (a later failure overrides an earlier pass). */
function latestPerEnv(rows: EvidenceRow[]): Record<Env, { outcome: EnvVerification; at: string | null; runId: string | null }> {
  const out = {} as Record<Env, { outcome: EnvVerification; at: string | null; runId: string | null }>;
  for (const env of ENVS) {
    const inEnv = rows.filter((r) => r.environment === env && r.outcome !== "skipped");
    if (!inEnv.length) { out[env] = { outcome: "none", at: null, runId: null }; continue; }
    const latestAt = inEnv.reduce((m, r) => (r.finished_at > m ? r.finished_at : m), "");
    const latestRun = inEnv.filter((r) => r.finished_at === latestAt);
    const failed = latestRun.some((r) => r.outcome === "failed");
    out[env] = { outcome: failed ? "failed" : "passed", at: latestAt, runId: latestRun[0].run_id };
  }
  return out;
}

export function computeRequirementStatuses(input: ReadinessInput): RequirementStatus[] {
  const fresh = (input.freshnessHours ?? 72) * HOUR;
  const byReq = new Map<string, EvidenceRow[]>();
  for (const e of input.evidence) (byReq.get(e.requirement_id) ?? byReq.set(e.requirement_id, []).get(e.requirement_id)!).push(e);
  const openBlockers = input.blockers.filter((b) => b.status === "open");

  return input.requirements.map((r) => {
    const per = latestPerEnv(byReq.get(r.id) ?? []);
    const verification = { development: per.development.outcome, staging: per.staging.outcome, production: per.production.outcome };
    const blockers = openBlockers.filter((b) => b.requirement_ids.includes(r.id)).map((b) => b.id);
    const lastVerifiedAt = ENVS.map((e) => per[e].at).filter(Boolean).sort().at(-1) ?? null;
    // Passing tests never promote implementation status: a requirement is implemented only when
    // its explicit record says every applicable layer exists (requirements/status.ts).
    const implementation = r.implementation_status;

    let state: DerivedState;
    if (blockers.length || r.blocked_reason) state = "blocked";
    else if (ENVS.some((e) => verification[e] === "failed")) state = "test_failed";
    else if (implementation !== "implemented") state = r.requires_founder_approval ? "requires_founder_approval" : implementation;
    else if (verification.production === "passed") state = "production_verified";
    else if (verification.staging === "passed") state = "verified_in_staging";
    else if (verification.development === "passed") state = "verified_in_development";
    else if (r.requires_founder_approval) state = "requires_founder_approval";
    else if (implementation === "implemented") state = "test_pending";
    else state = implementation;

    const stale = lastVerifiedAt !== null && input.now.getTime() - Date.parse(lastVerifiedAt) > fresh;
    return {
      id: r.id, subsystem: r.subsystem, title: r.title, priority: r.priority, category: r.category, disposition: r.disposition,
      implementation, verification, state, lastVerifiedAt, stale, blockers,
      evidenceRunIds: ENVS.map((e) => per[e].runId).filter((x): x is string => !!x),
    };
  });
}

export interface Metric { count: number; total: number; percent: number }
const metric = (count: number, total: number): Metric => ({ count, total, percent: total ? Math.round((count / total) * 1000) / 10 : 0 });

export function computeScores(statuses: RequirementStatus[]) {
  // Denominator: the full approved inventory. Blocked, deferred and difficult items are never removed (§39).
  const total = statuses.length;
  const at = (env: Env) => statuses.filter((s) => s.verification[env] === "passed").length;
  const ofCategory = (c: string) => statuses.filter((s) => s.category === c);
  const staged = (xs: RequirementStatus[]) => xs.filter((s) => s.verification.staging === "passed" || s.verification.production === "passed").length;
  const business = [...ofCategory("business"), ...ofCategory("founder")];
  return {
    denominator: { total, definition: "All requirements in the approved inventory, including blocked and Founder-deferred items." },
    counts: {
      implemented: metric(statuses.filter((s) => s.implementation === "implemented").length, total),
      tested: metric(statuses.filter((s) => ENVS.some((e) => s.verification[e] !== "none")).length, total),
      passing: metric(statuses.filter((s) => ENVS.some((e) => s.verification[e] === "passed") && !ENVS.some((e) => s.verification[e] === "failed")).length, total),
      failing: metric(statuses.filter((s) => s.state === "test_failed").length, total),
      blocked: metric(statuses.filter((s) => s.state === "blocked").length, total),
      verifiedInStaging: metric(at("staging"), total),
      productionVerified: metric(at("production"), total),
    },
    dimensions: {
      engineeringCompletion: metric(statuses.filter((s) => s.category === "engineering" && s.implementation === "implemented").length, ofCategory("engineering").length),
      developmentVerification: metric(at("development"), total),
      stagingCertification: metric(at("staging"), total),
      productionVerification: metric(at("production"), total),
      integrationReadiness: metric(staged(ofCategory("integration")), ofCategory("integration").length),
      securityReadiness: metric(staged(ofCategory("security")), ofCategory("security").length),
      businessLegalReadiness: metric(business.filter((s) => s.implementation === "implemented" && s.state !== "blocked").length, business.length),
    },
    note: "Dimensions are reported separately by design; no combined percentage is computed.",
  };
}

export type GateStatus = "pass" | "fail" | "not_evaluable";
export interface Gate { id: string; name: string; status: GateStatus; requiredEvidence: string; currentEvidence: string; blockers: string[]; responsible: string }

export function ingestionHealth(rows: IngestionRow[], now: Date, maxAgeHours = 72) {
  const sources = ["ci"]; // required feeds; staging/production feeds become required once those environments exist
  return sources.map((source) => {
    const r = rows.find((x) => x.source === source);
    if (!r || !r.last_success_at) return { source, status: "unavailable" as const, detail: "No successful ingestion recorded" };
    if (r.last_error && r.last_attempt_at && r.last_attempt_at > r.last_success_at)
      return { source, status: "failing" as const, detail: `Last attempt failed: ${r.last_error}` };
    if (now.getTime() - Date.parse(r.last_success_at) > maxAgeHours * HOUR)
      return { source, status: "stale" as const, detail: `Last success ${r.last_success_at}` };
    return { source, status: "healthy" as const, detail: `Last success ${r.last_success_at}` };
  });
}

export function evidenceSetHash(statuses: RequirementStatus[]): string {
  // Deterministic identity of the evidence set used for approval binding (hashed by caller).
  return statuses.map((s) => `${s.id}:${s.evidenceRunIds.join("+")}:${s.state}`).sort().join("|");
}

export function approvalValidity(a: ApprovalRow | undefined, rc: ReadinessInput["releaseCandidate"], currentEvidenceSet: string | null): { valid: boolean; reason: string } {
  if (!a) return { valid: false, reason: "No Founder approval recorded" };
  if (!a.approver_is_owner) return { valid: false, reason: "Approval not recorded by the Owner" };
  if (a.decision !== "approved") return { valid: false, reason: "Founder rejected the release" };
  if (a.invalidated_at) return { valid: false, reason: "Approval was invalidated" };
  if (!rc) return { valid: false, reason: "No release candidate" };
  if (a.commit_sha !== rc.commit_sha) return { valid: false, reason: "Release candidate commit changed after approval" };
  if (a.config_sha256 !== rc.config_sha256) return { valid: false, reason: "Release configuration changed after approval" };
  if (currentEvidenceSet !== null && a.evidence_set_sha256 !== currentEvidenceSet) return { valid: false, reason: "Evidence set changed after approval" };
  return { valid: true, reason: "Approval matches release candidate and evidence set" };
}

export function computeGates(input: ReadinessInput, statuses: RequirementStatus[], currentEvidenceSetHash: string | null): Gate[] {
  const inScope = statuses.filter((s) => s.disposition === "in_scope");
  const feedsOk = ingestionHealth(input.ingestion, input.now).every((f) => f.status === "healthy");
  const blockersFor = (cat: string[]) => input.blockers.filter((b) => b.status === "open" && cat.includes(b.category)).map((b) => b.id);
  const g = (id: string, name: string, ok: boolean, evaluable: boolean, required: string, current: string, blockers: string[], responsible: string): Gate =>
    ({ id, name, status: !evaluable ? "not_evaluable" : ok ? "pass" : "fail", requiredEvidence: required, currentEvidence: current, blockers, responsible });

  const notImpl = inScope.filter((s) => s.implementation !== "implemented");
  const latestCi = input.evidence.filter((e) => e.source === "ci").sort((a, b) => (a.finished_at < b.finished_at ? 1 : -1))[0];
  // Gate B judges EVERY CI run for the latest commit (unit, integration, browser suites), not just the
  // most recent one, so a passing later suite can never mask an earlier failing one.
  const ciRun = latestCi ? input.evidence.filter((e) => e.source === "ci" && e.commit_sha === latestCi.commit_sha) : [];
  const ciFailed = ciRun.filter((e) => e.outcome === "failed").length;
  const ciRunIds = [...new Set(ciRun.map((e) => e.run_id))];
  const ciOrigin = ciRunIds.every((id) => id.startsWith("gh-")) ? "GitHub Actions" : ciRunIds.some((id) => id.startsWith("gh-")) ? "GitHub Actions + local" : "local runs only — not GitHub Actions";
  const openBlocking = input.findings.filter((f) => f.status === "open" && f.release_blocking);
  const secReqs = inScope.filter((s) => s.category === "security");
  const secUnverified = secReqs.filter((s) => s.verification.staging !== "passed");
  const integ = inScope.filter((s) => s.category === "integration");
  const integUnverified = integ.filter((s) => s.verification.staging !== "passed");
  const stagingUnverified = inScope.filter((s) => s.priority === "P0" && s.category !== "business" && s.category !== "founder" && s.verification.staging !== "passed");
  const biz = inScope.filter((s) => s.category === "business");
  const bizOpen = biz.filter((s) => s.implementation !== "implemented" || s.state === "blocked");
  const approval = input.approvals.filter((a) => a.kind === "production_launch").sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  const av = approvalValidity(approval, input.releaseCandidate, currentEvidenceSetHash);
  const prodEvidence = input.productionDeployment
    ? input.evidence.filter((e) => e.environment === "production" && e.source === "production_check" && e.commit_sha === input.productionDeployment!.commit_sha)
    : [];

  return [
    g("A", "Engineering completeness", notImpl.length === 0, true, "All in-scope requirements implemented or Founder-dispositioned",
      `${inScope.length - notImpl.length}/${inScope.length} implemented`, blockersFor(["engineering"]), "Engineering"),
    g("B", "Automated test certification", !!latestCi && ciFailed === 0, feedsOk, "All CI runs for the latest commit ingested, fresh, with zero failures",
      latestCi ? `${ciRunIds.length} run(s) @ ${latestCi.commit_sha.slice(0, 7)} (${ciOrigin}): ${ciRun.length - ciFailed} passed, ${ciFailed} failed` : "No CI evidence", [], "Engineering / QA"),
    g("C", "Security certification", openBlocking.length === 0 && secUnverified.length === 0, feedsOk, "No open release-blocking findings; security requirements verified in staging",
      `${openBlocking.length} blocking findings open; ${secReqs.length - secUnverified.length}/${secReqs.length} security reqs staging-verified`, blockersFor(["security"]), "Security"),
    g("D", "Integration certification", integUnverified.length === 0, feedsOk, "Integration requirements verified in staging or Founder-excluded",
      `${integ.length - integUnverified.length}/${integ.length} verified`, blockersFor(["external_account"]), "Engineering / Founder (accounts)"),
    g("E", "Staging certification", stagingUnverified.length === 0, feedsOk, "All P0 technical requirements pass in staging",
      `${stagingUnverified.length} P0 requirements not staging-verified`, [], "QA"),
    g("F", "Business readiness", bizOpen.length === 0, true, "Legal identity, agreements, payments config, support, disclosures complete",
      `${biz.length - bizOpen.length}/${biz.length} complete`, blockersFor(["legal"]), "Founder"),
    g("G", "Founder approval", av.valid, true, "Owner approval bound to the release candidate commit, config and evidence set", av.reason, blockersFor(["founder_approval"]), "Founder"),
    g("H", "Production verification", prodEvidence.length > 0 && prodEvidence.every((e) => e.outcome === "passed"), !!input.productionDeployment,
      "Post-deploy production checks pass for the deployed commit",
      input.productionDeployment ? `${prodEvidence.length} production checks for ${input.productionDeployment.commit_sha.slice(0, 7)}` : "No production deployment", blockersFor(["production_incident"]), "Engineering"),
  ];
}

export function launchDecision(gates: Gate[]): { readyForFounderApproval: boolean; launched: boolean; summary: string } {
  const preApproval = gates.filter((x) => ["A", "B", "C", "D", "E", "F"].includes(x.id));
  const ready = preApproval.every((x) => x.status === "pass");
  const launched = gates.every((x) => x.status === "pass");
  const failing = gates.filter((x) => x.status !== "pass").map((x) => `${x.id} (${x.status})`);
  return {
    readyForFounderApproval: ready,
    launched,
    summary: launched ? "All gates pass." : `Not production-ready. Gates not passing: ${failing.join(", ")}.`,
  };
}
