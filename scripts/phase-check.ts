// Phased release (docs/PHASED-LAUNCH.md): refuses a production deploy that would switch on an AI system whose
// requirements the Founder deferred. Reads the CHECKED-OUT wrangler.toml (the commit being released) and, when given,
// the production Worker's secret list (names only; `wrangler secret list --format json`). Exit 0 only when consistent.
//
//   DEFERRED_SUBSYSTEMS='["AI Builds (addendum)"]' node --no-warnings scripts/phase-check.ts wrangler.toml [secrets.json]
import { readFileSync } from "node:fs";
import { productionBlock, secretNames } from "./provision-production.ts";
import { phaseConfigProblems, productionVars } from "../src/readiness/phased-release.ts";

export function checkPhase(toml: string, deferredSubsystems: string[], secretsJson: string | null): string[] {
  return phaseConfigProblems(deferredSubsystems, productionVars(productionBlock(toml)), secretsJson === null ? null : secretNames(secretsJson));
}

if (process.argv[1]?.endsWith("scripts/phase-check.ts")) {
  const [tomlPath = "wrangler.toml", secretsPath] = process.argv.slice(2);
  let deferred: string[];
  try { deferred = JSON.parse(process.env.DEFERRED_SUBSYSTEMS || "[]"); if (!Array.isArray(deferred)) throw new Error("not an array"); }
  catch (e) { console.log(`::error::DEFERRED_SUBSYSTEMS is not a JSON array (${(e as Error).message}). Refusing.`); process.exit(1); }
  if (!deferred.length) { console.log("No requirement is deferred: the full scope is released; nothing to check."); process.exit(0); }
  const problems = checkPhase(readFileSync(tomlPath, "utf8"), deferred, secretsPath ? readFileSync(secretsPath, "utf8") : null);
  if (problems.length) { for (const p of problems) console.log(`::error title=Phased release::${p}`); process.exit(1); }
  console.log(`Phased release consistent: production keeps ${deferred.join(", ")} off${secretsPath ? " (configuration and Worker secrets)" : " (configuration)"}.`);
}
