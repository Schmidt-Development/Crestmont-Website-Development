// Vercel adapter. Discovery: the host must be a VERIFIED domain of a project in the connected Vercel account/team. The
// repository is taken only from that project's own Git link (never guessed from the domain). Vercel has no API for
// response headers, so the change itself goes through that repository (github.ts + editors.ts: vercel.json `headers`),
// and Vercel's own Git integration deploys it; deployment completion is read back from Vercel.
import { call, type NativeConnections } from "./connections.ts";

export interface VercelTarget { kind: "vercel"; projectId: string; project: string; framework: string | null; repo: string | null; repoType: string | null; branch: string; rootDirectory: string }
interface Project { id: string; name: string; framework?: string | null; rootDirectory?: string | null; link?: { type?: string; org?: string; repo?: string; productionBranch?: string }; alias?: { domain: string }[]; targets?: { production?: { alias?: string[] } } }

export async function discoverVercel(f: typeof fetch, conn: NonNullable<NativeConnections["vercel"]>, host: string): Promise<{ target: VercelTarget | null; detail: string }> {
  const team = conn.team ?? undefined;
  let until: string | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await call<{ projects: Project[]; pagination?: { next?: number | null } }>(f, "vercel", conn.token, "/v9/projects", { query: { limit: "100", teamId: team, until } });
    for (const p of r?.projects ?? []) {
      const aliases = new Set([...(p.targets?.production?.alias ?? []), ...(p.alias ?? []).map((a) => a.domain)]);
      if (!aliases.has(host)) continue;
      // Confirm through the project's own domain record that the domain is verified for this project.
      const d = await call<{ name: string; verified?: boolean; redirect?: string | null }>(f, "vercel", conn.token, `/v9/projects/${p.id}/domains/${encodeURIComponent(host)}`, { query: { teamId: team } });
      if (!d || d.name !== host) continue;
      if (!d.verified) return { target: null, detail: `${host} is attached to the Vercel project ${p.name} but not verified there, so Crestmont does not treat it as yours` };
      if (d.redirect) return { target: null, detail: `${host} redirects to ${d.redirect} on Vercel; add the address the site is served at instead` };
      const repo = p.link?.type === "github" && p.link.org && p.link.repo ? `${p.link.org}/${p.link.repo}` : null;
      return {
        target: { kind: "vercel", projectId: p.id, project: p.name, framework: p.framework ?? null, repo, repoType: p.link?.type ?? null, branch: p.link?.productionBranch || "main", rootDirectory: (p.rootDirectory ?? "").replace(/^\/+|\/+$/g, "") },
        detail: `${host} is a verified domain of the Vercel project ${p.name}${repo ? ` (repository ${repo}, branch ${p.link?.productionBranch || "main"})` : " (no GitHub repository linked)"}`,
      };
    }
    if (!r?.pagination?.next) break;
    until = String(r.pagination.next);
  }
  return { target: null, detail: `${host} is not a domain of any project this Vercel connection can read` };
}

/** The production deployment of `commit` (or the latest one): ready, building, or failed. */
export async function vercelDeployment(f: typeof fetch, conn: NonNullable<NativeConnections["vercel"]>, t: VercelTarget, commit: string | null): Promise<{ state: "ready" | "building" | "failed" | "none"; detail: string }> {
  const r = await call<{ deployments: { uid: string; state?: string; readyState?: string; meta?: { githubCommitSha?: string }; url?: string }[] }>(f, "vercel", conn.token, "/v6/deployments", { query: { projectId: t.projectId, target: "production", limit: "10", teamId: conn.team ?? undefined } });
  const list = r?.deployments ?? [];
  const d = commit ? list.find((x) => x.meta?.githubCommitSha === commit) : list[0];
  if (!d) return { state: commit ? "building" : "none", detail: commit ? `no Vercel production deployment of ${commit.slice(0, 7)} yet` : "no production deployment" };
  const s = (d.readyState ?? d.state ?? "").toUpperCase();
  return { state: s === "READY" ? "ready" : s === "ERROR" || s === "CANCELED" ? "failed" : "building", detail: `Vercel deployment ${d.uid}: ${s || "?"}` };
}
