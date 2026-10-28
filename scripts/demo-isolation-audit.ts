// Read-only audit (docs/frontend/PORTFOLIO.md): would pushing the portfolio-demo branches start any Cloudflare Git build
// of the project repositories' own Workers or Pages projects (production or shared staging)?
//
// It reads, never writes: Workers Builds triggers (GET …/builds/workers/{tag}/triggers) and Pages projects
// (GET …/pages/projects). For every trigger/project connected to one of the three repositories it evaluates each demo
// branch against Cloudflare's documented rules — branch include/exclude patterns, path excludes then includes, and the
// forced-build cases (a push with zero changed files, 3,000+ files or 20+ commits) — using exactly the files each demo
// branch changes. It prints settings and verdicts only: no tokens, no build variables, no secrets.
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node --no-warnings scripts/demo-isolation-audit.ts
// Exit code: 0 = every demo branch is isolated, 2 = a build would start (or a setting could not be read).

const token = process.env.CLOUDFLARE_API_TOKEN ?? "", account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
if (!token || !account) { console.log("::error::CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required (read-only use)."); process.exit(2); }

import { DEMO_BRANCHES, matches, branchSelected, pathsTrigger } from "./demo-isolation-rules.ts";
const REPOS = new Set(DEMO_BRANCHES.map((d) => d.repo));

async function cf<T>(path: string): Promise<{ ok: true; result: T } | { ok: false; status: number; error: string }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({})) as { success?: boolean; result?: T; errors?: { message: string }[] };
  if (!res.ok || !body.success) return { ok: false, status: res.status, error: (body.errors ?? []).map((e) => e.message).join("; ") || res.statusText };
  return { ok: true, result: body.result as T };
}

let unsafe = false, unknown = false;
const out: string[] = [];
const log = (s: string) => { console.log(s); out.push(s); };

// ── Workers Builds ──────────────────────────────────────────────────────────────────────────────────────────────────
interface Script { id: string; tag?: string }
interface Trigger { trigger_name: string; branch_includes: string[]; branch_excludes: string[]; path_includes: string[]; path_excludes: string[]; build_command: string | null; deploy_command: string | null; root_directory: string | null; repo_connection?: { repo_name: string; provider_account_name: string } | null; deleted_on?: string | null }
const scripts = await cf<Script[]>("/workers/scripts");
if (!scripts.ok) { unknown = true; log(`UNKNOWN  Workers scripts could not be listed (HTTP ${scripts.status}: ${scripts.error}). The token needs Workers Scripts: Read.`); }
else {
  let connected = 0, readFail = 0;
  for (const s of scripts.result) {
    if (!s.tag) continue;
    const t = await cf<Trigger[]>(`/builds/workers/${s.tag}/triggers`);
    if (!t.ok) { if (t.status !== 404) readFail++; continue; }
    for (const tr of t.result) {
      const repo = tr.repo_connection?.repo_name ?? "";
      if (tr.deleted_on || !REPOS.has(repo)) continue;
      connected++;
      log(`Worker ${s.id} · trigger "${tr.trigger_name}" ← ${tr.repo_connection?.provider_account_name}/${repo}`);
      log(`    branches include ${JSON.stringify(tr.branch_includes)} exclude ${JSON.stringify(tr.branch_excludes)} · paths include ${JSON.stringify(tr.path_includes)} exclude ${JSON.stringify(tr.path_excludes)} · root ${tr.root_directory ?? "/"} · deploy: ${tr.deploy_command ?? "(default)"}`);
      for (const d of DEMO_BRANCHES.filter((x) => x.repo === repo)) {
        const b = branchSelected(d.branch, tr.branch_includes, tr.branch_excludes), p = b && pathsTrigger(d.files, tr.path_includes, tr.path_excludes);
        if (p) unsafe = true;
        log(`    ${p ? "BUILD  " : "skip   "} ${d.branch}: ${!b ? "branch not selected" : p ? "branch selected and changed paths match — a push WOULD start this build" : "branch selected but every changed path is excluded"}`);
      }
    }
  }
  if (readFail) { unknown = true; log(`UNKNOWN  ${readFail} Worker build configuration(s) could not be read. The token needs Workers CI: Read (Account › Workers CI › Read).`); }
  log(`Workers Builds: ${connected} trigger(s) connected to the project repositories.`);
}

// ── Pages ───────────────────────────────────────────────────────────────────────────────────────────────────────────
interface PagesProject { name: string; source?: { type: string; config?: { owner?: string; repo_name?: string; production_branch?: string; deployments_enabled?: boolean; preview_deployment_setting?: "all" | "none" | "custom"; preview_branch_includes?: string[]; preview_branch_excludes?: string[]; path_includes?: string[]; path_excludes?: string[] } } }
const pages = await cf<PagesProject[]>("/pages/projects?per_page=100");
if (!pages.ok) { unknown = true; log(`UNKNOWN  Pages projects could not be listed (HTTP ${pages.status}: ${pages.error}). The token needs Cloudflare Pages: Read.`); }
else {
  const linked = pages.result.filter((p) => REPOS.has(p.source?.config?.repo_name ?? ""));
  for (const p of linked) {
    const c = p.source!.config!;
    log(`Pages ${p.name} ← ${c.owner}/${c.repo_name} · production ${c.production_branch} · builds ${c.deployments_enabled === false ? "DISABLED" : "enabled"} · previews ${c.preview_deployment_setting} include ${JSON.stringify(c.preview_branch_includes ?? [])} exclude ${JSON.stringify(c.preview_branch_excludes ?? [])} · paths include ${JSON.stringify(c.path_includes ?? [])} exclude ${JSON.stringify(c.path_excludes ?? [])}`);
    for (const d of DEMO_BRANCHES.filter((x) => x.repo === c.repo_name)) {
      const previewOn = c.deployments_enabled !== false && c.preview_deployment_setting !== "none";
      const b = previewOn && (c.preview_deployment_setting === "all" ? !(c.preview_branch_excludes ?? []).some((x) => matches(x, d.branch)) : branchSelected(d.branch, c.preview_branch_includes, c.preview_branch_excludes));
      const pth = b && pathsTrigger(d.files, c.path_includes, c.path_excludes);
      if (pth) unsafe = true;
      log(`    ${pth ? "BUILD  " : "skip   "} ${d.branch}: ${!previewOn ? "preview builds are off" : !b ? "branch excluded from previews" : pth ? "a push WOULD create a Pages preview deployment" : "every changed path is excluded"}`);
    }
  }
  log(`Pages: ${linked.length} project(s) connected to the project repositories.`);
}

const verdict = unsafe ? "NOT ISOLATED — do not push the demo branches" : unknown ? "UNVERIFIED — some settings could not be read" : "ISOLATED — no Cloudflare Git build would start for any demo branch";
log(`\nVerdict: ${verdict}`);
log("Not covered by this audit: Netlify (no Netlify token here) — Netlify builds deploy previews for pull requests; the demo branches never open one.");
if (process.env.GITHUB_STEP_SUMMARY) await import("node:fs").then((fs) => fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY!, `## Portfolio demo isolation audit (read-only)\n\n\`\`\`\n${out.join("\n")}\n\`\`\`\n`));
process.exit(unsafe || unknown ? 2 : 0);
