// Phased release (docs/PHASED-LAUNCH.md): refuses a production deploy that would switch on an AI system whose
// requirements the Founder deferred. Reads the CHECKED-OUT wrangler.toml (the commit being released) and, when given,
// the production Worker's secret list (names only; `wrangler secret list --format json`). Exit 0 only when consistent.
//
//   DEFERRED_SUBSYSTEMS='["AI Builds (addendum)"]' node --no-warnings scripts/phase-check.ts wrangler.toml [secrets.json]
//   REQUIRED_SECRETS='["MFA_ENCRYPTION_KEY"]' ... also refuses when a named production secret is missing.
//
// `live` mode compares what the RUNNING production Worker reports on /api/health with the committed configuration.
// A Worker secret overrides a [vars] value without any deploy, so this is how an out-of-band switch is noticed:
//   node --no-warnings scripts/phase-check.ts live wrangler.toml health.json [--exact]
// Without --exact (the scheduled monitor) only a Worker MORE open than committed fails, so a reviewed change that
// reopens the builder does not raise an alarm between merge and deploy. --exact is for the post-deploy checks.
import { readFileSync } from "node:fs";
import { productionBlock, secretNames } from "./provision-production.ts";
import { phaseConfigProblems, productionVars } from "../src/readiness/phased-release.ts";
import { aiBuildGate } from "../src/domain/ai-build-gate.ts";

/** The AI-generation state the committed production configuration produces. */
export function committedAiBuildState(toml: string): "on" | "off" {
  return aiBuildGate({ ENVIRONMENT: "production", AI_BUILD_AUTOMATION: productionVars(productionBlock(toml)).AI_BUILD_AUTOMATION }).open ? "on" : "off";
}

/** Null when the running Worker matches the committed gate; otherwise why not. */
export function liveAiGateProblem(toml: string, health: unknown, exact: boolean): string | null {
  const live = health && typeof health === "object" ? (health as { aiBuildAutomation?: unknown }).aiBuildAutomation : undefined;
  const committed = committedAiBuildState(toml);
  if (live !== "on" && live !== "off") return `/api/health does not report aiBuildAutomation (got ${JSON.stringify(live)}); the running Worker predates the gate or is not Crestmont.`;
  if (live === committed) return null;
  if (live === "on") return `AI website generation is ON in the running production Worker but the committed configuration says "off". A Worker secret (AI_BUILD_AUTOMATION) is overriding it: remove it in Cloudflare → Workers & Pages → crestmont-platform-production → Settings → Variables and Secrets.`;
  return exact ? `AI website generation is off in the running Worker but the committed configuration says "on".` : null;
}

/** Required production secrets that are missing. */
export function missingSecrets(required: string[], secretsJson: string): string[] {
  const have = new Set(secretNames(secretsJson));
  return required.filter((n) => !have.has(n));
}

export function checkPhase(toml: string, deferredSubsystems: string[], secretsJson: string | null): string[] {
  return phaseConfigProblems(deferredSubsystems, productionVars(productionBlock(toml)), secretsJson === null ? null : secretNames(secretsJson));
}

if (process.argv[1]?.endsWith("scripts/phase-check.ts") && process.argv[2] === "live") {
  const [, , , tomlPath = "wrangler.toml", healthPath] = process.argv;
  let health: unknown = null;
  try { health = JSON.parse(readFileSync(healthPath, "utf8")); } catch { /* reported below as missing */ }
  const problem = liveAiGateProblem(readFileSync(tomlPath, "utf8"), health, process.argv.includes("--exact"));
  if (problem) { console.log(`::error title=AI website generation gate::${problem}`); process.exit(1); }
  console.log(`Production AI website generation is ${committedAiBuildState(readFileSync(tomlPath, "utf8"))}, as committed.`);
} else if (process.argv[1]?.endsWith("scripts/phase-check.ts")) {
  const [tomlPath = "wrangler.toml", secretsPath] = process.argv.slice(2);
  let required: string[];
  try { required = JSON.parse(process.env.REQUIRED_SECRETS || "[]"); if (!Array.isArray(required)) throw new Error("not an array"); }
  catch (e) { console.log(`::error::REQUIRED_SECRETS is not a JSON array (${(e as Error).message}). Refusing.`); process.exit(1); }
  if (required.length) {
    if (!secretsPath) { console.log("::error::REQUIRED_SECRETS needs the secret list file. Refusing."); process.exit(1); }
    const missing = missingSecrets(required, readFileSync(secretsPath, "utf8"));
    if (missing.length) { for (const m of missing) console.log(`::error title=Production secret missing::${m} is not set on the production Worker (docs/PRODUCTION-PROVISIONING.md). Nothing was deployed.`); process.exit(1); }
    console.log(`Required production secrets present: ${required.join(", ")} (names only).`);
  }
  let deferred: string[];
  try { deferred = JSON.parse(process.env.DEFERRED_SUBSYSTEMS || "[]"); if (!Array.isArray(deferred)) throw new Error("not an array"); }
  catch (e) { console.log(`::error::DEFERRED_SUBSYSTEMS is not a JSON array (${(e as Error).message}). Refusing.`); process.exit(1); }
  if (!deferred.length) { console.log("No requirement is deferred: the full scope is released; nothing to check."); process.exit(0); }
  const problems = checkPhase(readFileSync(tomlPath, "utf8"), deferred, secretsPath ? readFileSync(secretsPath, "utf8") : null);
  if (problems.length) { for (const p of problems) console.log(`::error title=Phased release::${p}`); process.exit(1); }
  console.log(`Phased release consistent: production keeps ${deferred.join(", ")} off${secretsPath ? " (configuration and Worker secrets)" : " (configuration)"}.`);
}
