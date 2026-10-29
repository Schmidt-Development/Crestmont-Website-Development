// Pure rules for scripts/demo-isolation-audit.ts (Cloudflare Workers Builds / Pages build-trigger semantics).

/** The demo branches and exactly the files each one adds (one commit on top of an existing revision). */
export const DEMO_BRANCHES: { repo: string; branch: string; files: string[] }[] = [
  { repo: "lansing-car-rentals", branch: "crestmont/portfolio-demo-rentals", files: [".github/workflows/portfolio-demo-rentals.yml", "apps/rentals/portfolio-demo/demo-kit.mjs", "apps/rentals/portfolio-demo/demo.wrangler.jsonc", "apps/rentals/portfolio-demo/local-server.mjs", "apps/rentals/portfolio-demo/worker.mjs"] },
  { repo: "lansing-car-rentals", branch: "crestmont/portfolio-demo-mentorship", files: [".github/workflows/portfolio-demo-mentorship.yml", "portfolio-demo/demo-kit.mjs", "portfolio-demo/demo.wrangler.jsonc", "portfolio-demo/local-server.mjs", "portfolio-demo/worker.mjs"] },
  { repo: "glassly", branch: "crestmont/portfolio-demo", files: [".github/workflows/portfolio-demo.yml", "portfolio-demo/demo-kit.mjs", "portfolio-demo/local-server.mjs", "portfolio-demo/worker.mjs", "portfolio-demo/wrangler.jsonc"] },
  { repo: "better-lansing-mechanics", branch: "crestmont/portfolio-demo", files: [".github/workflows/portfolio-demo.yml", "portfolio-demo/build.mjs", "portfolio-demo/demo-kit.mjs", "portfolio-demo/local-server.mjs", "portfolio-demo/worker.mjs", "portfolio-demo/wrangler.jsonc"] },
];

/** Cloudflare pattern match: `*` alone, or at the start/end of a rule, matches zero or more characters. */
export function matches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(value);
}
/** Conservative: an empty include list is treated as "every branch", so any doubt is reported as a build. */
export const branchSelected = (b: string, inc: string[] | null | undefined, exc: string[] | null | undefined) =>
  !(exc ?? []).some((p) => matches(p, b)) && ((inc ?? []).length === 0 || (inc ?? []).some((p) => matches(p, b)));
/** Path rules: excludes are applied first, then includes ([*] by default). A push with no remaining match is skipped. */
export function pathsTrigger(files: string[], inc: string[] | null | undefined, exc: string[] | null | undefined): boolean {
  const includes = inc && inc.length ? inc : ["*"];
  if (files.length === 0 || files.length >= 3000) return true; // forced builds
  return files.filter((f) => !(exc ?? []).some((p) => matches(p, f))).some((f) => includes.some((p) => matches(p, f)));
}


/** Netlify sites connected to a project repository (seen deploying pull-request previews for lansing-car-rentals). */
export const NETLIFY_SITES: { site: string; repo: string }[] = [{ site: "astonishing-sawine-f80069", repo: "lansing-car-rentals" }];

export type FailKind = "invalid-request" | "authentication" | "permission" | "not-found" | "rate-limited" | "service" | "network";
/** An invalid request (HTTP 400) is a defect in the audit's own request — never evidence of a missing permission. */
export function classify(status: number): FailKind {
  return status === 0 ? "network" : status === 400 ? "invalid-request" : status === 401 ? "authentication" : status === 403 ? "permission" : status === 404 ? "not-found" : status === 429 ? "rate-limited" : "service";
}

/** Conservative Netlify rule for a push without a pull request: it deploys unless builds are stopped or branch deploys
 *  name exact branches (no wildcard; an empty list is treated as "all branches") that exclude this one. */
export function netlifyDeploys(branch: string, b: { stop_builds?: boolean; allowed_branches?: string[] }): boolean {
  if (b.stop_builds) return false;
  const allowed = b.allowed_branches ?? [];
  const exact = allowed.length > 0 && allowed.every((a) => !a.includes("*"));
  return !exact || allowed.includes(branch);
}
