// Quality engine, platform side (pure): the package capability matrix and the independent verification of a runner's
// scorecard. The runner computes the scorecard from its evidence; the platform never takes its word for it:
//  - all 20 criteria must be present, each with a valid status; every "pass" names evidence;
//  - applicability is recomputed HERE from the package and the customer's brief: a criterion the scope requires can
//    never be reported "not_applicable" to improve the score;
//  - the arithmetic is recomputed (score = 10 × passed / applicable, rounded down; 10 only when all pass).
// The matrix mirrors runner/starters/fullstack-v1/scripts/packages.json (a test keeps them identical).

export const QUALITY_CRITERIA = [
  "visual_design", "brand_consistency", "desktop", "mobile", "frontend", "backend", "database", "workflows", "payments",
  "integrations", "auth", "security", "accessibility", "performance", "seo", "error_handling", "maintainability",
  "requirements", "customer_experience", "deployment",
] as const;
export type QualityCriterion = (typeof QUALITY_CRITERIA)[number];

export const PACKAGE_CAPABILITIES: Readonly<Record<"starter" | "business" | "premium" | "custom", readonly string[]>> = Object.freeze({
  starter: ["contact", "admin", "notifications"],
  business: ["contact", "admin", "notifications", "quotes", "booking", "payments"],
  premium: ["contact", "admin", "notifications", "quotes", "booking", "payments", "customer_accounts"],
  custom: ["contact", "admin", "notifications", "quotes", "booking", "payments", "customer_accounts"],
});

/** Capabilities the customer asked for (intake functionality + integrations), limited to what the package includes. */
export function requiredCapabilities(packageId: string, features: { key: string }[], integrations: string[]): Set<string> {
  const caps = PACKAGE_CAPABILITIES[packageId as keyof typeof PACKAGE_CAPABILITIES] ?? PACKAGE_CAPABILITIES.custom;
  const want = new Set(["contact", "admin", "notifications"]);
  for (const f of features) {
    if (f.key === "booking") want.add("booking");
    if (f.key === "ecommerce") want.add("payments");
  }
  for (const i of integrations) if (/stripe|payment/i.test(i)) want.add("payments");
  return new Set([...want].filter((c) => caps.includes(c)));
}

/** Criteria that may be "not_applicable" for this scope (everything else must be scored). */
export function optionalCriteria(required: Set<string>): Set<QualityCriterion> {
  const out = new Set<QualityCriterion>();
  if (!required.has("booking")) out.add("workflows");
  if (!required.has("payments")) out.add("payments");
  return out;
}

const STATUSES = ["pass", "fail", "pending_external", "unsupported", "not_applicable"] as const;

export interface VerifiedScorecard {
  ok: boolean;
  problems: string[];
  iteration: number;
  packageId: string;
  score: number;
  applicable: number;
  passed: number;
  eligible: boolean;
  waitingExternal: boolean;
  criteria: { id: QualityCriterion; applicable: boolean; status: (typeof STATUSES)[number]; evidence: string[]; reason: string | null }[];
  defects: { criterion: string; class: string; detail: string }[];
}

/** Verify a scorecard reported by a runner. `ok` = structurally sound and consistent; eligibility is separate. */
export function verifyScorecard(raw: unknown, ctx: { packageId: string; required: Set<string> }): VerifiedScorecard {
  const problems: string[] = [];
  const q = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (q.schema !== "crestmont.quality-scorecard/1") problems.push("unknown scorecard schema");
  const list = Array.isArray(q.criteria) ? q.criteria as Record<string, unknown>[] : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const c of list) {
    const id = String(c?.id ?? "");
    if (!(QUALITY_CRITERIA as readonly string[]).includes(id)) { problems.push(`unknown criterion ${id.slice(0, 40)}`); continue; }
    if (byId.has(id)) problems.push(`duplicate criterion ${id}`);
    byId.set(id, c);
  }
  const optional = optionalCriteria(ctx.required);
  const criteria: VerifiedScorecard["criteria"] = [];
  for (const id of QUALITY_CRITERIA) {
    const c = byId.get(id);
    if (!c) { problems.push(`criterion ${id} is missing`); criteria.push({ id, applicable: true, status: "unsupported", evidence: [], reason: "missing from the scorecard" }); continue; }
    let status = (STATUSES as readonly string[]).includes(String(c.status)) ? String(c.status) as (typeof STATUSES)[number] : "unsupported";
    if (status !== c.status) problems.push(`criterion ${id}: invalid status`);
    let applicable = c.applicable === true;
    if (!applicable && !optional.has(id)) { problems.push(`criterion ${id} is required by this website's scope but was reported not applicable`); applicable = true; status = "unsupported"; }
    if (applicable && status === "not_applicable") { problems.push(`criterion ${id}: applicable but marked not_applicable`); status = "unsupported"; }
    const evidence = (Array.isArray(c.evidence) ? c.evidence : []).filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.slice(0, 300)).slice(0, 20);
    if (applicable && status === "pass" && !evidence.length) { problems.push(`criterion ${id}: "pass" without evidence`); status = "unsupported"; }
    criteria.push({ id, applicable, status: applicable ? status : "not_applicable", evidence, reason: typeof c.reason === "string" ? c.reason.slice(0, 400) : null });
  }
  const app = criteria.filter((c) => c.applicable);
  const passed = app.filter((c) => c.status === "pass").length;
  const eligible = app.length > 0 && passed === app.length && problems.length === 0;
  const score = eligible ? 10 : Math.min(9.9, Math.floor(((10 * passed) / Math.max(1, app.length)) * 10 + 1e-9) / 10);
  if (typeof q.score === "number" && Math.abs(q.score - score) > 0.05 && problems.length === 0) problems.push(`reported score ${q.score} does not match the criteria (${score})`);
  if (q.eligible === true && !eligible) problems.push("reported eligible, but the criteria do not support it");
  const notPassed = app.filter((c) => c.status !== "pass");
  const defects = (Array.isArray(q.defects) ? q.defects as Record<string, unknown>[] : []).slice(0, 40).map((d) => ({ criterion: String(d.criterion ?? "").slice(0, 40), class: String(d.class ?? "website").slice(0, 30), detail: String(d.detail ?? "").slice(0, 400) }));
  return {
    ok: problems.length === 0, problems, iteration: Number.isInteger(q.iteration) ? q.iteration as number : 0, packageId: ctx.packageId,
    score: problems.length ? Math.min(score, 9.9) : score, applicable: app.length, passed, eligible: eligible && problems.length === 0,
    waitingExternal: notPassed.length > 0 && notPassed.every((c) => c.status === "pending_external"), criteria, defects,
  };
}
