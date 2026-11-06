// What a staging deploy actually achieved, from the outcomes of its own steps (deploy-staging.yml).
//
// The deployment record used to say `--status succeeded` whenever the Worker upload worked, with verification
// "passed" when the SMOKE check passed — so a run whose browser journeys, CRM E2E or access verification failed
// still produced a succeeded, verified deployment, and readiness judged that commit as a good deploy while the
// GitHub run itself was red. This computes the record from the same steps that fail the job:
//   · succeeded/passed — every mandatory check ran and passed;
//   · failed/failed    — any mandatory check failed, was cancelled, or was SKIPPED (a check that did not run did
//                        not pass);
// A conditional check (the rotation revocation proof) is mandatory only when its condition held.
//
//   STEPS='${{ toJSON(steps) }}' node --no-warnings scripts/deploy-outcome.ts [--rotation-pending true|false]
//   → prints JSON {status, verification, failed: [...], notes} and writes status=/verification=/notes= to GITHUB_OUTPUT
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Every verification step that fails the job when it fails (directly, or through a "Fail the deploy when" gate). */
export const MANDATORY = [
  "verify", "tls", "smoke", "frontend", "e2e", "crm_e2e", "clamd", "scan_e2e",
  "research_candidates", "research_e2e", "outbound_e2e", "frontend_browser", "preview_render",
] as const;
/** Mandatory only when its condition held: the old access is proven revoked only after a rotation. */
export const CONDITIONAL = { revoked: "rotation-pending" } as const;

export interface Outcome { status: "succeeded" | "failed"; verification: "passed" | "failed"; failed: string[]; notes: string }

export function deployOutcome(steps: Record<string, { outcome?: string; conclusion?: string } | undefined>, o: { rotationPending: boolean }): Outcome {
  const required: string[] = [...MANDATORY, ...(o.rotationPending ? ["revoked"] : [])];
  // `outcome` is the result before continue-on-error; that is the one that says whether the check passed.
  const failed = required.filter((id) => steps[id]?.outcome !== "success").map((id) => `${id}=${steps[id]?.outcome ?? "not run"}`);
  const ok = failed.length === 0;
  return {
    status: ok ? "succeeded" : "failed", verification: ok ? "passed" : "failed", failed,
    notes: ok ? `all ${required.length} mandatory checks passed`
      : `code is deployed, but ${failed.length} of ${required.length} mandatory checks did not pass: ${failed.join(", ")}`.slice(0, 500),
  };
}

const entry = (() => { try { return realpathSync(process.argv[1] ?? ""); } catch { return ""; } })();
if (entry === realpathSync(fileURLToPath(import.meta.url))) {
  const i = process.argv.indexOf("--rotation-pending");
  let steps: Record<string, { outcome?: string }>;
  try { steps = JSON.parse(process.env.STEPS ?? ""); } catch { console.error("STEPS must be the JSON of the workflow's steps context"); process.exit(2); }
  const r = deployOutcome(steps, { rotationPending: i > 0 && process.argv[i + 1] === "true" });
  console.log(JSON.stringify(r));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${r.status}\nverification=${r.verification}\nnotes=${r.notes.replace(/\n/g, " ")}\n`);
}
