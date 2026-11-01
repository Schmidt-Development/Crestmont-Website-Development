// Permanent quality scorecard (Founder directive "10/10 quality engine"). Every build is scored against its OWN
// approved scope with the same 20 criteria; nothing reaches internal approval below a verified 10/10.
//
// Rules:
//  - evidence-based: each criterion passes only from named evidence (runner checks, the starter's acceptance gates in
//    .crestmont/quality/gates.json, browser screenshots, the independent Model A review). No evidence ⇒ "unsupported",
//    which counts as NOT passed;
//  - applicability comes from the package capability matrix and the features the customer asked for (never from the
//    builder alone): a non-applicable criterion leaves the denominator, it never scores a free point;
//  - subjective criteria (visual design, brand, maintainability, customer experience) need the independent reviewer's
//    assessment; visual ones additionally need the reviewer to have SEEN desktop and mobile screenshots;
//  - score = 10 × passed / applicable, rounded DOWN to one decimal; 10/10 only when every applicable criterion passes;
//  - "pending_external" (a provider-side verification that needs the customer's account) blocks 10/10 like a failure
//    but is classified separately so the build waits instead of repairing.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CheckOutcome } from "./checks.ts";
import type { ReviewVerdict } from "./orchestrator/contracts.ts";

export const SCORECARD_SCHEMA = "crestmont.quality-scorecard/1";

export const CRITERIA = [
  ["visual_design", "Professional visual design"], ["brand_consistency", "Brand consistency"], ["desktop", "Desktop responsiveness"],
  ["mobile", "Mobile responsiveness"], ["frontend", "Frontend functionality"], ["backend", "Backend functionality"],
  ["database", "Database integrity"], ["workflows", "Booking and business workflows"], ["payments", "Payment processing"],
  ["integrations", "External integrations"], ["auth", "Authentication and authorization"], ["security", "Security"],
  ["accessibility", "Accessibility"], ["performance", "Performance"], ["seo", "SEO"], ["error_handling", "Error handling"],
  ["maintainability", "Maintainability"], ["requirements", "Requirements completeness"], ["customer_experience", "Customer experience"],
  ["deployment", "Deployment readiness"],
] as const;
export type CriterionId = (typeof CRITERIA)[number][0];

export type CriterionStatus = "pass" | "fail" | "pending_external" | "unsupported" | "not_applicable";
export interface Criterion { id: CriterionId; name: string; applicable: boolean; status: CriterionStatus; evidence: string[]; reason: string | null }

/** Where a defect has to be fixed (website first; reusable causes also become builder improvement proposals). */
export const DEFECT_CLASSES = ["website", "starter", "builder_prompt", "architecture", "integration", "test_coverage", "deployment", "security"] as const;
export type DefectClass = (typeof DEFECT_CLASSES)[number];

export interface Scorecard {
  schema: typeof SCORECARD_SCHEMA;
  packageId: string;
  iteration: number;
  criteria: Criterion[];
  applicable: number;
  passed: number;
  /** 10 × passed / applicable, rounded down to one decimal. */
  score: number;
  /** All applicable criteria pass: the only state that may enter internal approval. */
  eligible: boolean;
  /** Only provider-side verifications are missing (the build waits for the customer/Owner instead of repairing). */
  waitingExternal: boolean;
  defects: { criterion: CriterionId; class: DefectClass; detail: string }[];
  computedAt: string;
}

/** Subjective assessment from the independent reviewer (part of its JSON answer). */
export interface ReviewAssessment { visual_design?: Verdict; brand_consistency?: Verdict; maintainability?: Verdict; customer_experience?: Verdict }
interface Verdict { verdict: "pass" | "fail"; note?: string }

interface Gate { id: string; status: "pass" | "fail" | "pending_external" | "not_applicable"; findings: string[]; evidence: string[] }
export interface GatesFile {
  schema: "crestmont.quality-gates/1"; package: string; features: Record<string, boolean>; requested: string[]; scopeChanges: { feature: string; reason: string }[];
  missingInformation: string[]; gates: Record<string, Gate>; frontend?: { errors: { area: string; file: string; message: string }[] };
  tests?: { passed: number; failed: number; skipped: number };
}

/** The gates file plus the sha256 of its exact bytes (compared with the digest the gate command printed). */
export function readGates(repo: string): (GatesFile & { _sha256?: string }) | null {
  const f = path.join(repo, ".crestmont", "quality", "gates.json");
  if (!existsSync(f)) return null;
  try {
    const raw = readFileSync(f);
    const g = JSON.parse(raw.toString("utf8")) as GatesFile & { _sha256?: string };
    if (!(g && g.schema === "crestmont.quality-gates/1" && g.gates && typeof g.gates === "object")) return null;
    g._sha256 = createHash("sha256").update(raw).digest("hex");
    return g;
  } catch { return null; }
}

/**
 * A gates file is trusted only when (1) the runner's own quality-gates check ran in this acceptance pass, (2) the
 * file's bytes match the single digest that check printed, and (3) its exit status agrees with the file (exit 0
 * exactly when no required gate failed). Anything else — a file written by other code, a second digest, a forged
 * "pass" with a failing exit code — is treated as no gate evidence at all.
 */
export function trustedGates(g: (GatesFile & { _sha256?: string }) | null, gateCheck: CheckOutcome | undefined): GatesFile | null {
  if (!g || !gateCheck || gateCheck.timedOut) return null;
  if (!gateCheck.gatesDigest || gateCheck.gatesDigest !== g._sha256) return null;
  const blocking = Object.values(g.gates).some((x) => x && x.status === "fail");
  if (gateCheck.ok === blocking) return null;
  return g;
}

export interface ScoreInput {
  packageId: string;
  /** Package capabilities from the starter's matrix; null = no starter (custom build without the foundation). */
  capabilities: string[] | null;
  /** Features the customer asked for (from the brief), mapped to capability names. */
  requested: string[];
  checks: CheckOutcome[];
  /** The runner's OWN gate run: only trusted when the quality-gates acceptance check itself ran in this cycle. */
  gates: GatesFile | null;
  screenshots: { viewport: "desktop" | "mobile" }[];
  review: (ReviewVerdict & { assessment?: ReviewAssessment; imagesSeen?: number }) | null;
  /** Requirement items (platform seed + agent evidence rules). */
  requirements: { key: string; status: string }[];
  /** SPEC.json acceptance criteria status. */
  criteria: { id: string; status: string }[];
  securityFindings: string[];
  previewDeployed: boolean | null;
  iteration: number;
}

/** Map the brief's requested functionality to capabilities (same mapping as the starter's gate A). */
export function requestedCapabilities(features: { key: string }[] | string[], integrations: string[] = []): string[] {
  const out = new Set<string>(["contact"]);
  for (const f of features) {
    const k = typeof f === "string" ? f : f.key;
    if (k === "contact_form") out.add("contact");
    else if (k === "booking") out.add("booking");
    else if (k === "ecommerce") out.add("payments");
  }
  for (const i of integrations) if (/stripe|payment/i.test(i)) out.add("payments");
  return [...out];
}

export function score(i: ScoreInput): Scorecard {
  const g = i.gates;
  const gateCheck = i.checks.find((c) => c.id === "quality-gates");
  // A gates file is trusted only together with the runner's own run of the gate command in this acceptance pass.
  const gates = trustedGates(g, gateCheck);
  const gate = (id: string) => gates?.gates[id] ?? null;
  const check = (id: string) => i.checks.find((c) => c.id === id) ?? null;
  const enabled = (f: string) => !!gates?.features?.[f];
  const wanted = (f: string) => i.requested.includes(f) && (i.capabilities?.includes(f) ?? true);
  const feErrors = (area: string) => (gates?.frontend?.errors ?? []).filter((e) => e.area === area);
  const shots = { desktop: i.screenshots.some((s) => s.viewport === "desktop"), mobile: i.screenshots.some((s) => s.viewport === "mobile") };
  const browser = check("browser-check");
  const a = i.review?.assessment ?? {};
  const sawImages = (i.review?.imagesSeen ?? 0) > 0 && shots.desktop && shots.mobile;
  const out: Criterion[] = [];

  const put = (id: CriterionId, applicable: boolean, status: CriterionStatus, evidence: string[], reason: string | null = null) => {
    out.push({ id, name: CRITERIA.find((c) => c[0] === id)![1], applicable, status: applicable ? status : "not_applicable", evidence: applicable ? evidence : [], reason: applicable ? reason : "not in this website's approved scope" });
  };
  const fromGate = (id: CriterionId, gid: string, extra: () => string | null = () => null) => {
    const x = gate(gid);
    if (!x) return put(id, true, "unsupported", [], `no evidence: acceptance gate ${gid} did not run`);
    const why = extra();
    if (x.status === "fail" || why) return put(id, true, "fail", x.evidence, why ?? x.findings.slice(0, 5).join("; "));
    if (x.status === "pending_external") return put(id, true, "pending_external", x.evidence, x.findings.join("; "));
    if (x.status === "not_applicable") return put(id, false, "not_applicable", []);
    put(id, true, "pass", [`gate ${gid}: ${x.evidence.join("; ") || "pass"}`]);
  };
  const reviewed = (id: CriterionId, key: keyof ReviewAssessment, needsImages: boolean, also: () => string | null = () => null) => {
    const v = a[key];
    if (!i.review || !v) return put(id, true, "unsupported", [], "no independent reviewer assessment (the rule-based reviewer cannot judge this)");
    if (needsImages && !sawImages) return put(id, true, "unsupported", [], "the reviewer did not see desktop and mobile screenshots");
    const why = also();
    if (v.verdict !== "pass" || why) return put(id, true, "fail", [], why ?? v.note ?? "reviewer: not acceptable");
    put(id, true, "pass", [`independent review: ${String(v.note ?? "pass").slice(0, 200)}`]);
  };

  reviewed("visual_design", "visual_design", true);
  reviewed("brand_consistency", "brand_consistency", true, () => (gates && gate("B")?.status === "fail" ? "frontend gate failed (placeholders or tokens)" : null));
  for (const vp of ["desktop", "mobile"] as const) {
    if (!browser) put(vp, true, "unsupported", [], "no browser check ran");
    else if (!browser.ok) put(vp, true, "fail", [], `browser check failed: ${browser.outputTail.slice(-200)}`);
    else if (!shots[vp]) put(vp, true, "unsupported", [], `no ${vp} screenshots`);
    else if (feErrors("responsive").length) put(vp, true, "fail", [], feErrors("responsive").map((e) => e.message).join("; "));
    else put(vp, true, "pass", [`browser check passed with ${vp} screenshots`]);
  }
  fromGate("frontend", "B", () => (browser && !browser.ok ? "browser check failed" : null));
  fromGate("backend", "C");
  fromGate("database", "D");
  const workflows = wanted("booking") || enabled("booking") || enabled("quotes");
  if (!workflows) put("workflows", false, "not_applicable", []);
  else fromGate("workflows", "C", () => (wanted("booking") && !enabled("booking") ? "the customer asked for booking but it is not enabled" : null));
  const pays = wanted("payments") || enabled("payments");
  if (!pays) put("payments", false, "not_applicable", []);
  else fromGate("payments", "E", () => (wanted("payments") && !enabled("payments") ? "the customer asked for payments but they are not enabled" : null));
  const ints = enabled("payments") || enabled("notifications");
  if (!ints) put("integrations", false, "not_applicable", []);
  else fromGate("integrations", "E");
  const auth = enabled("admin") || enabled("customer_accounts");
  if (gates && !auth) put("auth", false, "not_applicable", []);
  else fromGate("auth", "F");
  fromGate("security", "F", () => {
    const scan = check("credential-scan");
    if (!scan) return "the credential scan did not run";
    if (!scan.ok) return `credentials in the source: ${scan.outputTail.slice(0, 200)}`;
    if (i.securityFindings.length) return `open security findings: ${i.securityFindings.slice(0, 3).join("; ")}`;
    return null;
  });
  if (!gates) put("accessibility", true, "unsupported", [], "no frontend gate evidence");
  else if (feErrors("accessibility").length) put("accessibility", true, "fail", [], feErrors("accessibility").slice(0, 5).map((e) => `${e.file}: ${e.message}`).join("; "));
  else put("accessibility", true, "pass", ["gate B accessibility rules (labels, alt text, landmarks, headings, contrast ≥ 4.5:1)"]);
  fromGate("performance", "G");
  if (!gates) put("seo", true, "unsupported", [], "no frontend gate evidence");
  else if (feErrors("seo").length) put("seo", true, "fail", [], feErrors("seo").slice(0, 5).map((e) => `${e.file}: ${e.message}`).join("; "));
  else put("seo", true, "pass", ["gate B SEO rules (titles, descriptions, canonical, Open Graph, structured data, sitemap)"]);
  fromGate("error_handling", "C");
  reviewed("maintainability", "maintainability", false);
  {
    const open = i.requirements.filter((r) => r.status !== "verified");
    const crit = i.criteria.filter((c) => c.status !== "passed");
    const gA = gate("A");
    if (!gA) put("requirements", true, "unsupported", [], "no requirements gate evidence");
    else if (gA.status === "fail") put("requirements", true, "fail", gA.evidence, gA.findings.slice(0, 5).join("; "));
    else if ((gates?.missingInformation ?? []).length) put("requirements", true, "fail", [], `missing customer information: ${gates!.missingInformation.join(", ")}`);
    else if (open.length) put("requirements", true, "fail", [], `requirements not verified: ${open.slice(0, 8).map((r) => r.key).join(", ")}`);
    else if (crit.length) put("requirements", true, "fail", [], `acceptance criteria not passed: ${crit.slice(0, 8).map((c) => c.id).join(", ")}`);
    else put("requirements", true, "pass", [`gate A; ${i.requirements.length} requirement(s) verified; ${i.criteria.length} acceptance criteria passed`]);
  }
  reviewed("customer_experience", "customer_experience", true, () => (browser && !browser.ok ? "browser check failed" : null));
  fromGate("deployment", "J", () => (i.previewDeployed === false ? "the private staging preview was not deployed" : null));

  const applicable = out.filter((c) => c.applicable);
  const passed = applicable.filter((c) => c.status === "pass").length;
  const raw = applicable.length ? (10 * passed) / applicable.length : 0;
  const scoreValue = Math.floor(raw * 10 + 1e-9) / 10;
  const notPassed = applicable.filter((c) => c.status !== "pass");
  const defects = notPassed.filter((c) => c.status !== "pending_external").map((c) => ({ criterion: c.id, class: classify(c), detail: `${c.name}: ${c.reason ?? c.status}`.slice(0, 400) }));
  return {
    schema: SCORECARD_SCHEMA, packageId: i.packageId, iteration: i.iteration, criteria: out, applicable: applicable.length, passed,
    score: passed === applicable.length && applicable.length > 0 ? 10 : Math.min(9.9, scoreValue),
    eligible: applicable.length > 0 && passed === applicable.length,
    waitingExternal: notPassed.length > 0 && notPassed.every((c) => c.status === "pending_external"),
    defects, computedAt: new Date().toISOString(),
  };
}

/** Where a failing criterion is most likely fixed. Website first; patterns that recur are flagged for the builder. */
export function classify(c: Criterion): DefectClass {
  const r = (c.reason ?? "").toLowerCase();
  if (c.status === "unsupported" && /did not run|no evidence|no browser|no independent/.test(r)) return "test_coverage";
  if (c.id === "security" || c.id === "auth") return "security";
  if (c.id === "integrations" || c.id === "payments") return "integration";
  if (c.id === "deployment") return "deployment";
  if (/protected|starter|foundation/.test(r)) return "starter";
  return "website";
}

/** Outstanding items for the review loop (the platform overrules READY while any exists). */
export function scorecardOutstanding(s: Scorecard): string[] {
  return s.criteria.filter((c) => c.applicable && c.status !== "pass" && c.status !== "pending_external").map((c) => `quality:${c.id}: ${(c.reason ?? c.status).slice(0, 160)}`);
}
