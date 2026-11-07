// Measuring a page as the person it was designed for sees it.
//
// The design lock compares the approved rendering with the one the finished build produces, and until now both
// captures were taken against a static copy of the built site. For a page behind authentication that is not a
// comparison: measured on Northgate, an anonymous capture of the staff page lost the three approved summary cards
// and the only two accent colours on it, and the gate reported drift for a page whose code had not been restyled.
//
// So a contract may declare, per page, the role to be signed in as (`visualStates`). For those builds the
// verification measurement runs against the APPLICATION rather than the static copy: the runner starts it, signs in
// over its own declared login endpoint, and captures. The baseline capture is unchanged -- there is no application
// at that point, and the approved frontend as shipped is exactly what the baseline should be.
//
// Nothing here relaxes a check. Palette, fonts, type scale, skeleton and frame are compared as before, on the page
// as it really rendered; a signature change is still design-drift whatever the contract declares. The anonymous
// rendering of the same page is captured separately, as an `access-denied` state, so access control is still seen.
//
// The credentials are generated here and never come from the contract. They are written into the workspace for the
// application to create, which is the only way a role nobody can self-register for can exist at all; the
// application must create them ONLY when CRESTMONT_SEED is set, which the brief requires and conformance checks.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { declaredVisualStates } from "./integration-manifest.ts";
import type { IntegrationManifest, ManifestContract, VisualState } from "./integration-manifest.ts";
import { startCommand } from "./acceptance.ts";

export const VISUAL_DIR = ".crestmont";
export const VISUAL_SPEC = `${VISUAL_DIR}/visual-app.json`;
export const VISUAL_SEED = `${VISUAL_DIR}/visual-seed.json`;

export interface VisualAppSpec {
  start: string[];
  port: number;
  login: { path: string };
  seedFile: string;
  states: readonly VisualState[];
  credentials: Record<string, { email: string; password: string }>;
}

export interface VisualSeed {
  /** Exactly the accounts the declared states need, and nothing else. Deterministic in shape, fresh in value. */
  accounts: { role: string; email: string; password: string }[];
}

/** Why a build that declared visual states still cannot be measured against the application. */
export type VisualRefusal = "no-states" | "no-start-command" | "no-login-endpoint";

export function visualAppSpec(
  repo: string,
  manifest: IntegrationManifest & ManifestContract,
  port = 8098,
): { spec: VisualAppSpec; seed: VisualSeed } | { refused: VisualRefusal } {
  const states = declaredVisualStates(manifest);
  if (!states.length) return { refused: "no-states" };

  // Both of these are already reported by the functional gate when they are missing, so there is nothing to add
  // here beyond declining to measure against an application that cannot be started or signed into.
  const start = startCommand(repo, manifest);
  if (!start) return { refused: "no-start-command" };
  const login = (manifest.apis ?? []).find(
    (a) => (a.method ?? "GET").toUpperCase() === "POST" && /login|session|signin/i.test(a.path),
  );
  if (!login) return { refused: "no-login-endpoint" };

  const credentials: VisualAppSpec["credentials"] = {};
  const accounts: VisualSeed["accounts"] = [];
  for (const role of [...new Set(states.map((s) => s.session))]) {
    const tag = `${role}-${randomBytes(4).toString("hex")}`;
    const cred = { email: `visual-${tag}@crestmont.test`, password: `Visual-${tag}-Aa1!` };
    credentials[role] = cred;
    accounts.push({ role, ...cred });
  }
  return { spec: { start, port, login: { path: login.path }, seedFile: VISUAL_SEED, states, credentials }, seed: { accounts } };
}

/** Writes the spec and the seed into the workspace. Returns the spec's path, or the reason there is none. */
export function writeVisualSpec(
  repo: string,
  manifest: IntegrationManifest & ManifestContract,
  port = 8098,
): { path: string } | { refused: VisualRefusal } {
  const built = visualAppSpec(repo, manifest, port);
  if ("refused" in built) return built;
  mkdirSync(path.join(repo, VISUAL_DIR), { recursive: true });
  writeFileSync(path.join(repo, VISUAL_SEED), JSON.stringify(built.seed, null, 2));
  writeFileSync(path.join(repo, VISUAL_SPEC), JSON.stringify(built.spec, null, 2));
  return { path: VISUAL_SPEC };
}
