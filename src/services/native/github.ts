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

export interface ProposedChange { repo: string; base: string; path: string; pr: number; url: string; committed: boolean; merged: boolean; mergeSha: string | null; needsApproval: boolean }
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

/** Current state of Crestmont's PR; merges it when the branch needs no review and GitHub reports it mergeable. */
export async function advancePr(f: typeof fetch, gh: Gh, c: ProposedChange): Promise<ProposedChange & { closed: boolean; detail: string }> {
  const pr = await call<{ state: string; merged: boolean; merge_commit_sha: string | null; mergeable: boolean | null; mergeable_state?: string; html_url: string }>(f, "github", gh.token, `/repos/${c.repo}/pulls/${c.pr}`);
  if (!pr) return { ...c, closed: true, detail: `Pull request ${c.url} no longer exists` };
  if (pr.merged) return { ...c, merged: true, mergeSha: pr.merge_commit_sha, closed: false, detail: `Merged: ${c.url}` };
  if (pr.state === "closed") return { ...c, closed: true, detail: `Pull request ${c.url} was closed without merging` };
  if (c.needsApproval) return { ...c, closed: false, detail: `Waiting for your approval: review and merge ${c.url}` };
  if (pr.mergeable !== true || (pr.mergeable_state && !["clean", "unstable", "has_hooks"].includes(pr.mergeable_state))) return { ...c, closed: false, detail: `Waiting for GitHub to report ${c.url} mergeable (${pr.mergeable_state ?? "checking"})` };
  const m = await call<{ merged: boolean; sha: string }>(f, "github", gh.token, `/repos/${c.repo}/pulls/${c.pr}/merge`, { method: "PUT", body: { merge_method: "squash" } }).catch((e: ProviderError) => ({ merged: false, sha: "", error: e.message }));
  if (!m?.merged) return { ...c, closed: false, detail: `GitHub did not merge ${c.url} yet${(m as { error?: string })?.error ? ` (${(m as { error?: string }).error})` : ""}` };
  return { ...c, merged: true, mergeSha: m.sha, closed: false, detail: `Merged ${c.url}; waiting for the deployment` };
}
