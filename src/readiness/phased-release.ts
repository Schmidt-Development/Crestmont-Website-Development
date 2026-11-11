// Phased-release scope policy (docs/PHASED-LAUNCH.md). Pure: no database, no I/O.
//
// Phase 1 opens Crestmont's NON-AI offering: the public website, customer portal, staff and Owner dashboards, CRM,
// projects, contracts, approved maintenance plans, support and payments, with websites delivered by people. The
// separately-developed AI systems (the AI Website Builder, the AI Receptionist, AI Sales Optimization) are not part
// of it. Their requirements count toward every release gate today, so without a scope decision phase 1 could never
// pass the gates however complete the non-AI platform is — and the only honest way to change that is the mechanism
// the readiness schema already has: a Founder scope disposition ("deferred_by_founder"), recorded per requirement.
//
// What this policy allows, and nothing else:
//   • Only requirements the acceptance registry tracks as `external_ai` can be deferred. Every platform requirement —
//     authentication, security, payments, legal, identity, launch — stays in scope and must pass on its own.
//   • A subsystem is deferrable only while a PRODUCTION GATE keeps its capability off. Each gate is checked against the
//     committed production configuration and the production Worker's secret names by the release workflow
//     (scripts/release-authorization.ts, deploy-production.yml); a deferred subsystem whose gate is open blocks the deploy.
//   • A security requirement is deferrable only with a written reason why nothing reachable on production depends on it.
//   • NEVER_DEFERRABLE items protect the shipped product even with the AI system off, and stay in scope.
//   • Recording a deferral changes the evidence set, so any outstanding launch approval stops being valid.
// Deferring is a statement of scope, never of readiness: deferred requirements keep their real state and are shown
// separately; reinstating one puts it straight back into every gate.

export const PHASE_1 = {
  id: "phase-1-non-ai",
  title: "Phase 1 — non-AI offering (websites delivered by the Crestmont team)",
  /** Typed by the Founder to confirm, so a deferral is never one stray click. */
  confirmPhrase: "defer for phase 1",
} as const;

export interface ProductionGate {
  subsystem: string;
  capability: string;
  /** How production keeps it off, in words the Founder can check. */
  gate: string;
  /** Production [vars] that must hold these values (absent counts as the default stated). */
  vars: { name: string; mustBe: string; defaultWhenAbsent: string | null }[];
  /** Secrets that would switch the capability on (or bypass a committed var) and must not exist on the production Worker. */
  forbiddenSecrets: string[];
}

const BUILDER_GATE = (subsystem: string): ProductionGate => ({
  subsystem,
  capability: "Autonomous AI website generation for paid customer projects",
  gate: "AI_BUILD_AUTOMATION = \"off\" in wrangler.toml [env.production] (src/domain/ai-build-gate.ts fails closed for any value but \"on\"); no build runner secret on the production Worker, so the runner API answers 503.",
  vars: [{ name: "AI_BUILD_AUTOMATION", mustBe: "off", defaultWhenAbsent: null }],
  forbiddenSecrets: ["AI_BUILD_AUTOMATION", "BUILD_RUNNER_SECRET", "BUILD_ALLOW_PAID_PROVIDER", "BUILD_PREVIEW_GATE_SECRET"],
});

export const PRODUCTION_GATES: readonly ProductionGate[] = [
  BUILDER_GATE("AI Builds (addendum)"),
  BUILDER_GATE("AI Builds V4 (Founder architecture)"),
  {
    subsystem: "AI Receptionist",
    // Founder, 2026-11-11: Crestmont's OWN inbound line is answered by the receptionist in production (its webhooks reach
    // the production Worker, verified with RETELL_INBOUND_API_KEY). What stays deferred is the AI Receptionist sold to
    // clients and every outbound call, so the gate is the "Coming soon" offer plus no outbound key or switch.
    capability: "AI Receptionist as a client service, and outbound calling (Crestmont's own inbound line runs in production)",
    gate: "The client service is \"Coming soon\" and cannot be quoted or bought (FD-45); outbound calling is off (RETELL_OUTBOUND not on) and no outbound or legacy Retell key is on the production Worker, so no call is ever placed.",
    vars: [{ name: "RETELL_OUTBOUND", mustBe: "off", defaultWhenAbsent: "off" }],
    forbiddenSecrets: ["RETELL_API_KEY", "RETELL_OUTBOUND", "RETELL_OUTBOUND_API_KEY"],
  },
  {
    subsystem: "AI Sales Optimization (addendum)",
    capability: "AI sales calls and the Self-Improvement Engine",
    gate: "No outbound Retell key on the production Worker; RETELL_SALES_OUTBOUND and SALES_OPT_PRODUCTION off, so no sales call is placed and no production agent is changed.",
    vars: [{ name: "RETELL_SALES_OUTBOUND", mustBe: "off", defaultWhenAbsent: "off" }, { name: "SALES_OPT_PRODUCTION", mustBe: "off", defaultWhenAbsent: "off" }],
    forbiddenSecrets: ["RETELL_OUTBOUND_API_KEY", "RETELL_SALES_OUTBOUND", "SALES_OPT_PRODUCTION"],
  },
];

/** Security requirements of an AI system that may be deferred, each with why nothing reachable on production depends on it. */
export const SECURITY_DEFERRAL_RATIONALE: Readonly<Record<string, string>> = {
  "AIB-007": "Runner isolation protects builds that run. With no BUILD_RUNNER_SECRET on production every runner endpoint answers 503, and with the gate closed no build exists to isolate.",
  "AIB-017": "The private review gate hides finished AI builds from customers. With the gate closed production creates no AI build and no build preview.",
  "AIB-018": "The integration-execution layer serves build agents. No agent runs on production while the gate is closed.",
  "VOICE-006": "Consent handling applies to recorded calls. Production holds no Retell key, so no call is received, recorded or transcribed.",
  "SALESOPT-005": "The protected policy layer guards prompt optimisation of the production sales agent, which cannot happen without SALES_OPT_PRODUCTION and an outbound Retell key.",
  "SALESOPT-008": "Safe Retell deployment governs writes to the production sales agent; production holds no outbound Retell key and SALES_OPT_PRODUCTION is off.",
  "SALESOPT-011": "Post-deployment monitoring and transcript retention apply to live sales calls, which production cannot place.",
};

/** In scope whatever the phase: these protect the shipped product even while their AI system is off. */
export const NEVER_DEFERRABLE: Readonly<Record<string, string>> = {
  "AIB-019": "The test-only payment simulation must be refused on production. That refusal guards the live payment path every customer uses, so it stays in scope and must be verified like any payment control.",
};

export interface PolicyRequirement { id: string; subsystem: string; category: string; tracking: "platform" | "external_ai" }

/** Whether this requirement may be deferred under phase 1, and why not when it may not. */
export function deferral(r: PolicyRequirement): { ok: true; gate: ProductionGate } | { ok: false; reason: string } {
  if (NEVER_DEFERRABLE[r.id]) return { ok: false, reason: `${r.id} is never deferrable: ${NEVER_DEFERRABLE[r.id]}` };
  if (r.tracking !== "external_ai") return { ok: false, reason: `${r.id} is a platform requirement; phase 1 defers only the separately-developed AI systems.` };
  const gate = PRODUCTION_GATES.find((g) => g.subsystem === r.subsystem);
  if (!gate) return { ok: false, reason: `${r.id} (${r.subsystem}) has no production gate in this policy, so nothing would keep it off.` };
  if (r.category === "security" && !SECURITY_DEFERRAL_RATIONALE[r.id]) return { ok: false, reason: `${r.id} is a security requirement without a stated reason why production does not depend on it.` };
  return { ok: true, gate };
}

/** The production [vars] table of wrangler.toml as a name → value map (inline-table form, comments ignored). */
export function productionVars(productionBlock: string): Record<string, string> {
  const b = productionBlock.replace(/#.*$/gm, "");
  const m = /\nvars = \{([^}]*)\}/.exec(b);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const kv of m[1].matchAll(/([A-Z0-9_]+)\s*=\s*"([^"]*)"/g)) out[kv[1]] = kv[2];
  return out;
}

/**
 * Every way production would break the gates of the subsystems that have deferred requirements. Empty = consistent.
 * `secretNames` is the production Worker's secret list (names only); null when the caller cannot read it.
 */
export function phaseConfigProblems(deferredSubsystems: readonly string[], vars: Record<string, string>, secretNames: readonly string[] | null): string[] {
  const problems: string[] = [];
  const names = new Set(secretNames ?? []);
  for (const g of PRODUCTION_GATES.filter((x) => deferredSubsystems.includes(x.subsystem))) {
    for (const v of g.vars) {
      const actual = vars[v.name] ?? v.defaultWhenAbsent;
      if (actual !== v.mustBe) problems.push(`${g.subsystem} is deferred, but production ${v.name} is ${actual === null ? "not set" : `"${actual}"`} (must be "${v.mustBe}").`);
    }
    if (secretNames) for (const s of g.forbiddenSecrets) if (names.has(s)) problems.push(`${g.subsystem} is deferred, but the production Worker holds the secret ${s}, which would switch it on.`);
  }
  return [...new Set(problems)];
}
