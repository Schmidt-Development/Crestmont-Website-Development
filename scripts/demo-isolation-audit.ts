// Read-only audit (docs/frontend/PORTFOLIO.md): would pushing the portfolio-demo branches start any Cloudflare Git build
// of the project repositories' own Workers or Pages projects (production or shared staging)?
//
// It reads, never writes: Workers Builds triggers (GET …/builds/workers/{tag}/triggers) and Pages projects
// (GET …/pages/projects, every page) and, with NETLIFY_AUTH_TOKEN, Netlify branch-deploy settings. For every trigger/project connected to one of the three repositories it evaluates each demo
// branch against Cloudflare's documented rules — branch include/exclude patterns, path excludes then includes, and the
// forced-build cases (a push with zero changed files, 3,000+ files or 20+ commits) — using exactly the files each demo
// branch changes. It prints settings and verdicts only: no tokens, no build variables, no secrets.
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node --no-warnings scripts/demo-isolation-audit.ts
// Exit code: 0 = every demo branch is isolated, 2 = a build would start (or a setting could not be read).

const token = process.env.CLOUDFLARE_API_TOKEN ?? "", account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
if (!token || !account) { console.log("::error::CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required (read-only use)."); process.exit(2); }

import { DEMO_BRANCHES, NETLIFY_SITES, matches, branchSelected, pathsTrigger, classify, netlifyDeploys, type FailKind } from "./demo-isolation-rules.ts";
const REPOS = new Set(DEMO_BRANCHES.map((d) => d.repo));

type CfFail = { ok: false; status: number; kind: FailKind; error: string };
const KIND_TEXT: Record<FailKind, string> = {
  "invalid-request": "the request was rejected as invalid (a defect in this audit, not a permission problem)",
  authentication: "the token was not accepted (invalid, expired or revoked)",
  permission: "the token lacks the permission for this setting",
  "not-found": "not found",
  "rate-limited": "rate limited — re-run later",
  service: "the API returned a server error — re-run later",
  network: "the API could not be reached",
};
async function cf<T>(path: string): Promise<{ ok: true; result: T; info?: { page?: number; per_page?: number; total_pages?: number; total_count?: number; count?: number } } | CfFail> {
  let res: Response;
  try { res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, { headers: { authorization: `Bearer ${token}` } }); }
  catch (e) { return { ok: false, status: 0, kind: "network", error: (e as Error).message }; }
  const body = await res.json().catch(() => ({})) as { success?: boolean; result?: T; result_info?: Record<string, number>; errors?: { code?: number; message: string }[] };
  if (!res.ok || !body.success) {
    // Cloudflare reports some permission failures as 403 with code 10000 ("Authentication error"): that is a scope problem.
    return { ok: false, status: res.status, kind: classify(res.status), error: (body.errors ?? []).map((e) => `${e.code ? `${e.code} ` : ""}${e.message}`).join("; ") || res.statusText };
  }
  return { ok: true, result: body.result as T, info: body.result_info };
}
/** Every page of a paginated list (page/per_page, stopping on result_info.total_pages or a short page). */
async function cfAll<T>(path: string, perPage: number): Promise<{ ok: true; result: T[]; pages: number } | CfFail> {
  const all: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const r = await cf<T[]>(`${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=${perPage}`);
    if (!r.ok) return r;
    all.push(...r.result);
    const total = r.info?.total_pages;
    if (total ? page >= total : r.result.length < perPage) return { ok: true, result: all, pages: page };
  }
  return { ok: false, status: 0, kind: "service", error: "more than 100 pages" };
}
const why = (f: CfFail, need: string) => `HTTP ${f.status || "—"}: ${f.error} — ${KIND_TEXT[f.kind]}${f.kind === "permission" ? `. The token needs ${need}` : ""}.`;

let unsafe = false, unknown = false;
const ALL = [...REPOS];
const unsafeRepos = new Set<string>(), unknownRepos = new Set<string>();
const markUnsafe = (repo: string) => { unsafe = true; unsafeRepos.add(repo); };
const markUnknown = (repos: string[] = ALL) => { unknown = true; for (const r of repos) unknownRepos.add(r); };
const out: string[] = [];
const log = (s: string) => { console.log(s); out.push(s); };
/** Findings are also emitted as annotations so they are readable without downloading the job log (settings only). */
const note = (title: string, lines: string[]) => console.log(`::notice title=${title.replace(/[,:\n]/g, " ")}::${lines.join(" | ").replace(/\n/g, " ").slice(0, 3800)}`);

// ── Workers Builds ──────────────────────────────────────────────────────────────────────────────────────────────────
interface Script { id: string; tag?: string }
interface Trigger { trigger_name: string; branch_includes: string[]; branch_excludes: string[]; path_includes: string[]; path_excludes: string[]; build_command: string | null; deploy_command: string | null; root_directory: string | null; repo_connection?: { repo_name: string; provider_account_name: string } | null; deleted_on?: string | null }
const scripts = await cf<Script[]>("/workers/scripts");
if (!scripts.ok) { markUnknown(); log(`UNKNOWN  Workers scripts could not be listed (${why(scripts, "Workers Scripts: Read")})`); }
else {
  let connected = 0, readFail = 0; const failKinds = new Set<string>();
  for (const s of scripts.result) {
    if (!s.tag) continue;
    const t = await cf<Trigger[]>(`/builds/workers/${s.tag}/triggers`);
    if (!t.ok) { if (t.kind !== "not-found") { readFail++; failKinds.add(why(t, "Workers CI: Read (Account › Workers CI › Read)")); } continue; }
    for (const tr of t.result) {
      const repo = tr.repo_connection?.repo_name ?? "";
      if (tr.deleted_on || !REPOS.has(repo)) continue;
      connected++;
      log(`Worker ${s.id} · trigger "${tr.trigger_name}" ← ${tr.repo_connection?.provider_account_name}/${repo}`);
      log(`    branches include ${JSON.stringify(tr.branch_includes)} exclude ${JSON.stringify(tr.branch_excludes)} · paths include ${JSON.stringify(tr.path_includes)} exclude ${JSON.stringify(tr.path_excludes)} · root ${tr.root_directory ?? "/"} · deploy: ${tr.deploy_command ?? "(default)"}`);
      const verdicts: string[] = [];
      for (const d of DEMO_BRANCHES.filter((x) => x.repo === repo)) {
        const b = branchSelected(d.branch, tr.branch_includes, tr.branch_excludes), p = b && pathsTrigger(d.files, tr.path_includes, tr.path_excludes);
        if (p) markUnsafe(repo);
        const v = `${p ? "BUILD" : "skip"} ${d.branch}: ${!b ? "branch not selected" : p ? "branch selected and changed paths match — a push WOULD start this build" : "branch selected but every changed path is excluded"}`;
        verdicts.push(v); log(`    ${v}`);
      }
      note(`Worker ${s.id} trigger ${tr.trigger_name}`, [`repo ${repo}`, `branches +${JSON.stringify(tr.branch_includes)} -${JSON.stringify(tr.branch_excludes)}`, `paths +${JSON.stringify(tr.path_includes)} -${JSON.stringify(tr.path_excludes)}`, `deploy ${tr.deploy_command ?? "(default)"}`, ...verdicts]);
    }
  }
  if (readFail) { markUnknown(); log(`UNKNOWN  ${readFail} Worker build configuration(s) could not be read (${[...failKinds].join(" / ")})`); }
  log(`Workers Builds: ${connected} trigger(s) connected to the project repositories.`);
}

// ── Pages ───────────────────────────────────────────────────────────────────────────────────────────────────────────
interface PagesProject { name: string; source?: { type: string; config?: { owner?: string; repo_name?: string; production_branch?: string; deployments_enabled?: boolean; preview_deployment_setting?: "all" | "none" | "custom"; preview_branch_includes?: string[]; preview_branch_excludes?: string[]; path_includes?: string[]; path_excludes?: string[] } } }
// The Pages list is paginated (page, per_page; result_info.total_pages). per_page is kept small: the endpoint rejects
// larger values with HTTP 400 "Invalid list options provided".
const pages = await cfAll<PagesProject>("/pages/projects", 10);
if (!pages.ok) { markUnknown(); log(`UNKNOWN  Pages projects could not be listed (${why(pages, "Cloudflare Pages: Read")})`); }
else {
  log(`Pages: ${pages.result.length} project(s) on the account, read across ${pages.pages} page(s).`);
  const linked = pages.result.filter((p) => REPOS.has(p.source?.config?.repo_name ?? ""));
  for (const p of linked) {
    const c = p.source!.config!;
    log(`Pages ${p.name} ← ${c.owner}/${c.repo_name} · production ${c.production_branch} · builds ${c.deployments_enabled === false ? "DISABLED" : "enabled"} · previews ${c.preview_deployment_setting} include ${JSON.stringify(c.preview_branch_includes ?? [])} exclude ${JSON.stringify(c.preview_branch_excludes ?? [])} · paths include ${JSON.stringify(c.path_includes ?? [])} exclude ${JSON.stringify(c.path_excludes ?? [])}`);
    const verdicts: string[] = [];
    for (const d of DEMO_BRANCHES.filter((x) => x.repo === c.repo_name)) {
      const previewOn = c.deployments_enabled !== false && c.preview_deployment_setting !== "none";
      const b = previewOn && (c.preview_deployment_setting === "all" ? !(c.preview_branch_excludes ?? []).some((x) => matches(x, d.branch)) : branchSelected(d.branch, c.preview_branch_includes, c.preview_branch_excludes));
      const pth = b && pathsTrigger(d.files, c.path_includes, c.path_excludes);
      if (pth) markUnsafe(c.repo_name!);
      const v = `${pth ? "BUILD" : "skip"} ${d.branch}: ${!previewOn ? "preview builds are off" : !b ? "branch excluded from previews" : pth ? "a push WOULD create a Pages preview deployment" : "every changed path is excluded"}`;
      verdicts.push(v); log(`    ${v}`);
    }
    note(`Pages ${p.name}`, [`repo ${c.repo_name}`, `production ${c.production_branch}`, `builds ${c.deployments_enabled === false ? "disabled" : "enabled"}`, `previews ${c.preview_deployment_setting} +${JSON.stringify(c.preview_branch_includes ?? [])} -${JSON.stringify(c.preview_branch_excludes ?? [])}`, `paths +${JSON.stringify(c.path_includes ?? [])} -${JSON.stringify(c.path_excludes ?? [])}`, ...verdicts]);
  }
  log(`Pages: ${linked.length} project(s) connected to the project repositories.`);
}

// ── Netlify ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Netlify sites connected to a project repository (lansing-car-rentals → astonishing-sawine-f80069). A push without a
// pull request deploys only if branch deploys select the branch, so the site's branch-deploy settings are read.
// Without NETLIFY_AUTH_TOKEN the settings cannot be inspected and the verdict stays UNVERIFIED for that repository.
const netlifyToken = process.env.NETLIFY_AUTH_TOKEN ?? "";
for (const n of NETLIFY_SITES) {
  if (!netlifyToken) { markUnknown([n.repo]); log(`UNKNOWN  Netlify site ${n.site} (${n.repo}): branch-deploy settings not inspected — NETLIFY_AUTH_TOKEN is not set.`); continue; }
  let res: Response | null = null;
  try { res = await fetch(`https://api.netlify.com/api/v1/sites/${n.site}.netlify.app`, { headers: { authorization: `Bearer ${netlifyToken}` } }); } catch { /* network */ }
  if (!res || !res.ok) { markUnknown([n.repo]); log(`UNKNOWN  Netlify site ${n.site}: settings could not be read (HTTP ${res?.status ?? "—"}: ${KIND_TEXT[classify(res?.status ?? 0)]}).`); continue; }
  const site = await res.json() as { build_settings?: { repo_url?: string; repo_branch?: string; allowed_branches?: string[]; stop_builds?: boolean; skip_prs?: boolean } };
  const b = site.build_settings ?? {};
  const allowed = b.allowed_branches ?? [];
  const settings = `repo ${b.repo_url ?? "(none)"} · production ${b.repo_branch ?? "?"} · builds ${b.stop_builds ? "STOPPED" : "active"} · branch deploys ${JSON.stringify(allowed)} · PR previews ${b.skip_prs ? "off" : "on"}`;
  log(`Netlify ${n.site} · ${settings}`);
  const verdicts: string[] = [];
  for (const d of DEMO_BRANCHES.filter((x) => x.repo === n.repo)) {
    // Conservative: builds are skipped only when they are stopped or branch deploys name exact branches (no wildcard,
    // no empty "all branches" list) that do not include the demo branch.
    const exact = allowed.length > 0 && allowed.every((a) => !a.includes("*"));
    const deploys = netlifyDeploys(d.branch, b);
    if (deploys) markUnsafe(n.repo);
    const v = `${deploys ? "BUILD" : "skip"} ${d.branch}: ${b.stop_builds ? "builds are stopped" : exact && !allowed.includes(d.branch) ? "not a branch-deploy branch" : "branch deploys may select this branch"}`;
    verdicts.push(v); log(`    ${v}`);
  }
  note(`Netlify ${n.site}`, [settings, ...verdicts]);
}

const verdict = unsafe ? "NOT ISOLATED — do not push the demo branches" : unknown ? "UNVERIFIED — some settings could not be read" : "ISOLATED — no Cloudflare Git build would start for any demo branch";
log(`\nVerdict: ${verdict}`);
const perRepo = ALL.map((r) => `${r}: ${unsafeRepos.has(r) ? "NOT ISOLATED" : unknownRepos.has(r) ? "UNVERIFIED" : "ISOLATED"}`);
for (const l of perRepo) log(`  ${l}`);
note("Per repository", perRepo);
note("Verdict", [verdict, ...out.filter((l) => l.startsWith("UNKNOWN") || /connected to the project repositories|on the account/.test(l))]);
if (process.env.GITHUB_STEP_SUMMARY) await import("node:fs").then((fs) => fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY!, `## Portfolio demo isolation audit (read-only)\n\n\`\`\`\n${out.join("\n")}\n\`\`\`\n`));
process.exit(unsafe || unknown ? 2 : 0);
