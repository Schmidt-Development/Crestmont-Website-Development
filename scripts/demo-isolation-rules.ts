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

