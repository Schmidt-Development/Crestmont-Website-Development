// Production feature gate for autonomous AI website generation (phased launch, docs/PHASED-LAUNCH.md).
//
// The AI Website Builder is developed and certified separately from the non-AI offering. Until the Founder certifies
// it for customer fulfilment, production must not create, queue, dispatch or run AI website builds, and must not
// forward customer revisions to it. Paid projects are fulfilled by people (docs/FULFILLMENT-HUMAN-SUPERVISED.md).
//
//   production           : CLOSED unless AI_BUILD_AUTOMATION is exactly "on". The value is a [vars] entry in
//                          wrangler.toml, so opening it is a committed configuration change: it alters the release
//                          configuration digest, which voids any Founder launch approval and needs a new one.
//   staging / development: open unless AI_BUILD_AUTOMATION is "off" (the builder's staging certification runs there).
//
// This is a gate around the builder, not a change to it: when closed, the one settings read every automatic path
// already consults reports automation off and paused (src/services/builds.ts#getBuildSettings), the runner's claim
// endpoint hands out nothing, and the Owner actions that would queue AI work by hand are refused with the reason.
// The Owner's own database switch cannot reopen it.

export const AI_BUILD_AUTOMATION_ON = "on";

export interface AiBuildGateEnv { ENVIRONMENT?: string; AI_BUILD_AUTOMATION?: string }
export interface AiBuildGate { open: boolean; reason: string | null }

export const AI_BUILD_PRODUCTION_CLOSED =
  "AI website generation is disabled on production (phased launch). Paid projects are delivered by the Crestmont team; " +
  "the AI builder reopens only after the Founder certifies it and a release with AI_BUILD_AUTOMATION = \"on\" is approved.";
export const AI_BUILD_ENV_OFF = "AI website generation is switched off for this environment (AI_BUILD_AUTOMATION = \"off\").";

/** Pure decision from the environment. Fails closed on production for any value other than exactly "on". */
export function aiBuildGate(env: AiBuildGateEnv): AiBuildGate {
  const v = (env.AI_BUILD_AUTOMATION ?? "").trim();
  if (env.ENVIRONMENT === "production") return v === AI_BUILD_AUTOMATION_ON ? { open: true, reason: null } : { open: false, reason: AI_BUILD_PRODUCTION_CLOSED };
  if (v === "off") return { open: false, reason: AI_BUILD_ENV_OFF };
  return { open: true, reason: null };
}

// The Worker's environment is fixed for an isolate (one deployed version, one set of bindings), so the decision is
// configured once per request / scheduled run from that environment, exactly like the CRM erasure keys
// (src/services/contact-identity.ts). Service functions that only receive a database handle read it from here.
let current: AiBuildGate = { open: true, reason: null };

export function configureAiBuildGateFromEnv(env: AiBuildGateEnv): AiBuildGate {
  current = aiBuildGate(env);
  return current;
}
export const currentAiBuildGate = (): AiBuildGate => current;
