// Repository adapter: proposes the header change through the website's own repository and its established process.
//   • The repository comes only from the hosting provider's own link (Vercel project / Pages project), never a guess.
//   • The connection must be able to push to it; otherwise the Owner is told exactly which access is missing.
//   • One branch (crestmont/native-embedding) and one pull request per repository, updated in place — re-running never
//     opens a second PR or commits an unchanged file.
//   • A production branch that requires reviews is never merged by Crestmont: the PR waits for the Owner's approval.
//     An unprotected branch is merged once GitHub reports the PR mergeable, and the provider then deploys it as usual.
import { call, ProviderError, type NativeConnections } from "./connections.ts";

export const BRANCH = "crestmont/native-embedding";
type Gh = NonNullable<NativeConnections["github"]>;
const b64 = (s: string) => { const bytes = new TextEncoder().encode(s); let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); };
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0)));
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export interface RepoAccess { ok: boolean; detail: string; defaultBranch?: string; protectedReviews?: boolean }
/** Push access to the repository, and whether `branch` requires a reviewed pull request. */
export async function repoAccess(f: typeof fetch, gh: Gh, repo: string, branch: string): Promise<RepoAccess> {
  if (!REPO_RE.test(repo)) return { ok: false, detail: `"${repo}" is not a GitHub repository name` };
  const r = await call<{ full_name: string; archived?: boolean; default_branch: string; permissions?: { push?: boolean } }>(f, "github", gh.token, `/repos/${repo}`);
  if (!r) return { ok: false, detail: `The GitHub connection cannot see ${repo}. Grant the Crestmont GitHub token access to that repository.` };
  if (r.archived) return { ok: false, detail: `${repo} is archived on GitHub` };
  if (!r.permissions?.push) return { ok: false, detail: `The GitHub connection can read ${repo} but cannot push to it. Grant it Contents and Pull requests (read and write) on ${repo}.` };
  const b = await call<{ protected?: boolean }>(f, "github", gh.token, `/repos/${repo}/branches/${encodeURIComponent(branch)}`);
  if (!b) return { ok: false, detail: `${repo} has no branch "${branch}" (the provider's production branch)` };
  let reviews = false;
  if (b.protected) {
    // Protection details need admin read; if they cannot be read, a protected branch is treated as needing approval.
    const p = await call<{ required_pull_request_reviews?: unknown }>(f, "github", gh.token, `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection`).catch(() => ({ required_pull_request_reviews: true }));
    reviews = !p || !!p.required_pull_request_reviews;
  }
  return { ok: true, detail: `${repo}: push access; ${branch} ${b.protected ? (reviews ? "requires a reviewed pull request" : "is protected without required reviews") : "is not protected"}`, defaultBranch: r.default_branch, protectedReviews: reviews };
}

export async function readFile(f: typeof fetch, gh: Gh, repo: string, path: string, ref: string): Promise<{ text: string; sha: string } | null> {
  const r = await call<{ type?: string; content?: string; sha: string; encoding?: string }>(f, "github", gh.token, `/repos/${repo}/contents/${enc(path)}`, { query: { ref } });
  if (!r || r.type !== "file" || r.encoding !== "base64") return null;
  return { text: unb64(r.content ?? ""), sha: r.sha };
}

export interface ProposedChange { /** Which authorized GitHub account proposed it (0 = the first). */ conn?: number; repo: string; base: string; path: string; pr: number; url: string; committed: boolean; merged: boolean; mergeSha: string | null; needsApproval: boolean }
/** Writes `content` to `path` on Crestmont's branch and makes sure one open PR exists. Idempotent. */
export async function proposeChange(f: typeof fetch, gh: Gh, repo: string, base: string, path: string, content: string, title: string, body: string, needsApproval: boolean): Promise<ProposedChange> {
  const existing = (await call<{ number: number; html_url: string; head: { ref: string } }[]>(f, "github", gh.token, `/repos/${repo}/pulls`, { query: { state: "open", head: `${repo.split("/")[0]}:${BRANCH}`, base } })) ?? [];
  let pr = existing[0] ?? null;
  const branchRef = await call<{ object: { sha: string } }>(f, "github", gh.token, `/repos/${repo}/git/ref/heads/${BRANCH}`);
  if (!branchRef || !pr) {
    // (Re)start the branch from the production branch so the PR contains only this change.
    const baseRef = await call<{ object: { sha: string } }>(f, "github", gh.token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
    if (!baseRef) throw new ProviderError("github", 404, `${repo} has no branch ${base}`);
    if (branchRef) await call(f, "github", gh.token, `/repos/${repo}/git/refs/heads/${BRANCH}`, { method: "PATCH", body: { sha: baseRef.object.sha, force: true } });
    else await call(f, "github", gh.token, `/repos/${repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${BRANCH}`, sha: baseRef.object.sha } });
  }
  const onBranch = await readFile(f, gh, repo, path, BRANCH);
  let committed = false;
  if (onBranch?.text !== content) {
    await call(f, "github", gh.token, `/repos/${repo}/contents/${enc(path)}`, { method: "PUT", body: { message: title, content: b64(content), branch: BRANCH, ...(onBranch ? { sha: onBranch.sha } : {}) } });
    committed = true;
  }
  if (!pr) {
    const made = await call<{ number: number; html_url: string }>(f, "github", gh.token, `/repos/${repo}/pulls`, { method: "POST", body: { title, head: BRANCH, base, body, maintainer_can_modify: true } });
    pr = { number: made!.number, html_url: made!.html_url, head: { ref: BRANCH } };
  }
  return { repo, base, path, pr: pr.number, url: pr.html_url, committed, merged: false, mergeSha: null, needsApproval };
}

// ── Automatic merging: fail closed ──
// Crestmont merges its own header PR only when it can VERIFY, independently of GitHub's summary, that:
//   • the PR is open, not a draft, and GitHub reports it cleanly mergeable ("clean" or "has_hooks" — never "unstable",
//     which means a check failed, nor "blocked"/"behind"/"dirty"/"unknown");
//   • the base branch's protection could be read (or the branch is unprotected), requires no review, and every
//     required status check is present on the PR's head commit and passed;
//   • every check run and commit status on that head commit has completed successfully (success, neutral or skipped);
//   • no reviewer has requested changes.
// Anything that cannot be read (missing token permission, API error, more results than one page) blocks the merge.
// A repository with no CI at all is merged only once the PR has been open 10 minutes with still no check reported,
// and only when its branch requires none. The merge itself names the verified head commit, so a newer push is not
// merged unseen.
export interface GateInput {
  pr: { state: string; draft?: boolean; mergeable: boolean | null; mergeable_state?: string; head: { sha: string }; created_at?: string };
  protection: { readable: boolean; protected: boolean; requiredContexts: string[]; requiresReviews: boolean };
  checkRuns: { readable: boolean; complete: boolean; runs: { name: string; status: string; conclusion: string | null }[] };
  statuses: { readable: boolean; items: { context: string; state: string }[] };
  reviews: { readable: boolean; changesRequested: boolean };
  now: number;
}
export type GateResult = { merge: true; detail: string } | { merge: false; wait: boolean; detail: string };
const OK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
export const NO_CI_GRACE_MS = 10 * 60_000;

export function mergeGate(g: GateInput): GateResult {
  const stop = (detail: string): GateResult => ({ merge: false, wait: false, detail });
  const wait = (detail: string): GateResult => ({ merge: false, wait: true, detail });
  if (g.pr.state !== "open") return stop(`the pull request is ${g.pr.state}`);
  if (g.pr.draft) return wait("the pull request is a draft");
  if (!g.protection.readable) return stop("the base branch's protection rules could not be read (grant the token Administration: read on the repository), so Crestmont will not merge on its own");
  if (g.protection.requiresReviews) return stop("the base branch requires a reviewed pull request — it waits for your approval");
  if (!g.checkRuns.readable || !g.checkRuns.complete) return stop("this connection cannot read the pull request's check runs (GitHub's Checks API), so Crestmont cannot verify that every check passed — it hands the pull request to you: review its checks and merge it, and Crestmont continues after your merge");
  if (!g.statuses.readable) return stop("the pull request's commit statuses could not be read (grant the token Commit statuses: read), so Crestmont will not merge on its own");
  if (!g.reviews.readable) return stop("the pull request's reviews could not be read, so Crestmont will not merge on its own");
  if (g.reviews.changesRequested) return stop("a reviewer requested changes");
  const failed = g.checkRuns.runs.filter((r) => r.status === "completed" && !OK_CONCLUSIONS.has(r.conclusion ?? ""));
  const latest = new Map<string, string>();
  for (const s of g.statuses.items) if (!latest.has(s.context)) latest.set(s.context, s.state); // newest first
  const badStatus = [...latest].filter(([, st]) => st === "failure" || st === "error");
  if (failed.length || badStatus.length) return stop(`checks failed: ${[...failed.map((r) => `${r.name} (${r.conclusion})`), ...badStatus.map(([c, st]) => `${c} (${st})`)].join(", ")}`);
  const pending = [...g.checkRuns.runs.filter((r) => r.status !== "completed").map((r) => r.name), ...[...latest].filter(([, st]) => st === "pending").map(([c]) => c)];
  if (pending.length) return wait(`checks still running: ${pending.join(", ")}`);
  const passed = new Set([...g.checkRuns.runs.filter((r) => OK_CONCLUSIONS.has(r.conclusion ?? "")).map((r) => r.name), ...[...latest].filter(([, st]) => st === "success").map(([c]) => c)]);
  const missing = g.protection.requiredContexts.filter((c) => !passed.has(c));
  if (missing.length) return wait(`required checks have not reported yet: ${missing.join(", ")}`);
  const none = g.checkRuns.runs.length === 0 && latest.size === 0;
  if (none) {
    const age = g.pr.created_at ? g.now - Date.parse(g.pr.created_at) : 0;
    if (!(age >= NO_CI_GRACE_MS)) return wait("no checks have reported yet (waiting 10 minutes for CI to start)");
  }
  if (g.pr.mergeable !== true || !["clean", "has_hooks"].includes(g.pr.mergeable_state ?? "")) return g.pr.mergeable_state === "unstable" || g.pr.mergeable_state === "dirty" ? stop(`GitHub reports the pull request "${g.pr.mergeable_state}"`) : wait(`waiting for GitHub to report it cleanly mergeable (${g.pr.mergeable_state ?? "checking"})`);
  return { merge: true, detail: none ? "no CI is configured on this repository and none is required; branch unprotected" : `all ${passed.size} check(s) passed${g.protection.requiredContexts.length ? `, including the required ${g.protection.requiredContexts.join(", ")}` : ""}` };
}

/** Reads everything mergeGate needs. Any read that fails is reported as unreadable (the gate then fails closed). */
async function gateInput(f: typeof fetch, gh: Gh, repo: string, pr: GateInput["pr"] & { base: { ref: string }; number: number }, now: number): Promise<GateInput> {
  const read = async <T>(path: string, query?: Record<string, string>) => { try { return { ok: true as const, v: await call<T>(f, "github", gh.token, path, { query }) }; } catch { return { ok: false as const, v: null }; } };
  const branch = await read<{ protected?: boolean }>(`/repos/${repo}/branches/${encodeURIComponent(pr.base.ref)}`);
  let protection: GateInput["protection"] = { readable: false, protected: true, requiredContexts: [], requiresReviews: true };
  if (branch.ok && branch.v) {
    if (!branch.v.protected) protection = { readable: true, protected: false, requiredContexts: [], requiresReviews: false };
    else {
      const p = await read<{ required_status_checks?: { contexts?: string[]; checks?: { context: string }[] } | null; required_pull_request_reviews?: unknown }>(`/repos/${repo}/branches/${encodeURIComponent(pr.base.ref)}/protection`);
      if (p.ok && p.v) protection = { readable: true, protected: true, requiresReviews: !!p.v.required_pull_request_reviews, requiredContexts: [...new Set([...(p.v.required_status_checks?.contexts ?? []), ...(p.v.required_status_checks?.checks ?? []).map((c) => c.context)])] };
    }
  }
  const cr = await read<{ total_count: number; check_runs: { name: string; status: string; conclusion: string | null }[] }>(`/repos/${repo}/commits/${pr.head.sha}/check-runs`, { per_page: "100" });
  const st = await read<{ statuses: { context: string; state: string }[] }>(`/repos/${repo}/commits/${pr.head.sha}/status`, { per_page: "100" });
  const rv = await read<{ user?: { login?: string }; state: string }[]>(`/repos/${repo}/pulls/${pr.number}/reviews`, { per_page: "100" });
  const lastByUser = new Map<string, string>();
  for (const r of rv.v ?? []) if (r.state !== "COMMENTED") lastByUser.set(r.user?.login ?? "?", r.state);
  return {
    pr, protection, now,
    checkRuns: { readable: cr.ok && !!cr.v, complete: !!cr.v && cr.v.total_count <= (cr.v.check_runs?.length ?? 0), runs: cr.v?.check_runs ?? [] },
    statuses: { readable: st.ok && !!st.v, items: st.v?.statuses ?? [] },
    reviews: { readable: rv.ok && !!rv.v, changesRequested: [...lastByUser.values()].includes("CHANGES_REQUESTED") },
  };
}

/** Current state of Crestmont's PR; merges it only when mergeGate verifies every condition (fail closed). */
export async function advancePr(f: typeof fetch, gh: Gh, c: ProposedChange, now = Date.now()): Promise<ProposedChange & { closed: boolean; detail: string }> {
  const pr = await call<GateInput["pr"] & { number: number; base: { ref: string }; merged: boolean; merge_commit_sha: string | null; html_url: string }>(f, "github", gh.token, `/repos/${c.repo}/pulls/${c.pr}`);
  if (!pr) return { ...c, closed: true, detail: `Pull request ${c.url} no longer exists` };
  if (pr.merged) return { ...c, merged: true, mergeSha: pr.merge_commit_sha, closed: false, detail: `Merged: ${c.url}` };
  if (pr.state === "closed") return { ...c, closed: true, detail: `Pull request ${c.url} was closed without merging` };
  if (c.needsApproval) return { ...c, closed: false, detail: `Waiting for your approval: review and merge ${c.url}` };
  const gate = mergeGate(await gateInput(f, gh, c.repo, { ...pr, number: c.pr }, now));
  if (!gate.merge) return { ...c, needsApproval: !gate.wait, closed: false, detail: gate.wait ? `Not merged yet — ${gate.detail}: ${c.url}` : `Waiting for your approval: Crestmont will not merge ${c.url} automatically because ${gate.detail}` };
  const m = await call<{ merged: boolean; sha: string }>(f, "github", gh.token, `/repos/${c.repo}/pulls/${c.pr}/merge`, { method: "PUT", body: { merge_method: "squash", sha: pr.head.sha } }).catch((e: ProviderError) => ({ merged: false, sha: "", error: e.message }));
  if (!m?.merged) return { ...c, closed: false, detail: `GitHub did not merge ${c.url} yet${(m as { error?: string })?.error ? ` (${(m as { error?: string }).error})` : ""}` };
  return { ...c, merged: true, mergeSha: m.sha, closed: false, detail: `Merged ${c.url} (${gate.detail}); waiting for the deployment` };
}
