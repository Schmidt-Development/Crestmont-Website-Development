// Read-only verification of the native-readiness connections (Owner, 2026-11-19: "Check that the production Worker can
// authenticate successfully with Cloudflare, Vercel and GitHub. Use safe, read-only provider API calls … Never print,
// expose, log or commit token values. Confirm which accounts, projects, domains and repositories the connections
// actually authorize."). Every call here is a GET. The report names accounts, zones, projects, domains and repositories
// and the permissions that are missing — never a token, never a secret, never response bodies beyond those names.
import { call, ProviderError, type NativeConnections } from "./connections.ts";

type Env<T> = { result: T; result_info?: { total_pages?: number; total_count?: number } };
export interface ProviderReport { connected: boolean; authenticated: boolean; identity: string | null; scope: Record<string, unknown>; missing: string[]; errors: string[] }
export interface ConnectionsReport { at: string; cloudflare: ProviderReport; vercel: ProviderReport; github: ProviderReport }

const empty = (): ProviderReport => ({ connected: false, authenticated: false, identity: null, scope: {}, missing: [], errors: [] });
const msg = (e: unknown) => (e instanceof ProviderError ? `${e.status || "network"}: ${e.message}` : (e as Error).message).slice(0, 200);
/** A read that records a missing permission (403) or error instead of throwing. */
async function tryRead<T>(rep: ProviderReport, what: string, permission: string, fn: () => Promise<T | null>): Promise<T | null> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof ProviderError && (e.status === 403 || e.status === 401)) rep.missing.push(`${permission} (needed to ${what})`);
    else rep.errors.push(`${what}: ${msg(e)}`);
    return null;
  }
}

export async function verifyCloudflare(f: typeof fetch, conn: NativeConnections["cloudflare"]): Promise<ProviderReport> {
  const rep = empty();
  if (!conn) return rep;
  rep.connected = true;
  const t = conn.token;
  // User tokens verify at /user/tokens/verify; account-owned tokens are verified by reading their accounts.
  const v = await call<Env<{ status: string }>>(f, "cloudflare", t, "/user/tokens/verify").catch(() => null);
  const accounts = await tryRead(rep, "list accounts", "Account: Read (Account Settings)", () => call<Env<{ id: string; name: string }[]>>(f, "cloudflare", t, "/accounts", { query: { per_page: "50" } }));
  const zones = await tryRead(rep, "list zones", "Zone: Read", () => call<Env<{ id: string; name: string; status: string; account: { id: string; name: string } }[]>>(f, "cloudflare", t, "/zones", { query: { per_page: "50" } }));
  rep.authenticated = v?.result?.status === "active" || !!accounts?.result?.length || !!zones?.result?.length;
  if (!rep.authenticated) { rep.errors.push("the token did not authenticate (or can read nothing)"); return rep; }
  rep.identity = v?.result?.status ? `token ${v.result.status}` : "account token";
  const acctList = (accounts?.result ?? []).filter((a) => !conn.accounts.length || conn.accounts.includes(a.id));
  const zoneList = (zones?.result ?? []).filter((z) => !conn.accounts.length || conn.accounts.includes(z.account.id));
  const perAccount: Record<string, unknown>[] = [];
  for (const a of acctList.slice(0, 5)) {
    const domains = await tryRead(rep, `list Workers custom domains of ${a.name}`, "Workers Scripts: Read", () => call<Env<{ hostname: string; service: string }[]>>(f, "cloudflare", t, `/accounts/${a.id}/workers/domains`));
    const pages = await tryRead(rep, `list Pages projects of ${a.name}`, "Cloudflare Pages: Read", () => call<Env<{ name: string; domains?: string[]; source?: { type?: string; config?: { owner?: string; repo_name?: string } } }[]>>(f, "cloudflare", t, `/accounts/${a.id}/pages/projects`));
    perAccount.push({
      account: a.name, id: a.id,
      workersCustomDomains: (domains?.result ?? []).map((d) => `${d.hostname} → ${d.service}`),
      pagesProjects: (pages?.result ?? []).map((p) => `${p.name} [${(p.domains ?? []).join(", ")}]${p.source?.type === "github" ? ` ← ${p.source.config?.owner}/${p.source.config?.repo_name}` : ""}`),
    });
  }
  // Transform Rules: reading a zone's response-header phase proves the permission Crestmont needs to prepare a site.
  let rulesRead = "no zone to test";
  if (zoneList[0]) {
    const r = await call(f, "cloudflare", t, `/zones/${zoneList[0].id}/rulesets/phases/http_response_headers_transform/entrypoint`).then(() => "readable", (e: unknown) => (e instanceof ProviderError && (e.status === 403 || e.status === 401) ? "DENIED" : `error ${msg(e)}`));
    rulesRead = `${zoneList[0].name}: ${r}`;
    if (r === "DENIED") rep.missing.push("Zone: Transform Rules (Response Header Modification) — Edit (needed to prepare a Cloudflare-hosted site)");
  }
  rep.scope = { accounts: acctList.map((a) => `${a.name} (${a.id})`), zones: zoneList.map((z) => `${z.name}${z.status !== "active" ? ` [${z.status}]` : ""}`), perAccount, responseHeaderRules: rulesRead };
  return rep;
}

export async function verifyVercel(f: typeof fetch, conn: NativeConnections["vercel"]): Promise<ProviderReport> {
  const rep = empty();
  if (!conn) return rep;
  rep.connected = true;
  const user = await tryRead(rep, "read the user", "a valid Vercel token", () => call<{ user: { username: string } }>(f, "vercel", conn.token, "/v2/user"));
  if (!user?.user) { rep.errors.push("the token did not authenticate"); return rep; }
  rep.authenticated = true;
  rep.identity = user.user.username;
  const teams = await tryRead(rep, "list teams", "Vercel team access", () => call<{ teams: { id: string; slug: string }[] }>(f, "vercel", conn.token, "/v2/teams"));
  const scopes: { label: string; team?: string }[] = conn.team ? [{ label: `team ${conn.team}`, team: conn.team }] : [{ label: "personal" }, ...(teams?.teams ?? []).slice(0, 5).map((x) => ({ label: `team ${x.slug}`, team: x.id }))];
  const projects: string[] = [];
  for (const sc of scopes) {
    const r = await tryRead(rep, `list projects (${sc.label})`, "Vercel projects: read", () => call<{ projects: { name: string; link?: { type?: string; org?: string; repo?: string; productionBranch?: string }; targets?: { production?: { alias?: string[] } } }[] }>(f, "vercel", conn.token, "/v9/projects", { query: { limit: "100", teamId: sc.team } }));
    for (const p of r?.projects ?? []) projects.push(`${sc.label}: ${p.name} [${(p.targets?.production?.alias ?? []).filter((a) => !a.endsWith(".vercel.app")).join(", ") || "no custom domain"}]${p.link?.type === "github" ? ` ← ${p.link.org}/${p.link.repo} (${p.link.productionBranch ?? "main"})` : ""}`);
  }
  rep.scope = { teams: (teams?.teams ?? []).map((x) => x.slug), projects };
  return rep;
}

export async function verifyGithub(f: typeof fetch, conn: NativeConnections["github"]): Promise<ProviderReport> {
  const rep = empty();
  if (!conn) return rep;
  rep.connected = true;
  const me = await tryRead(rep, "read the token's user", "a valid GitHub token", () => call<{ login: string }>(f, "github", conn.token, "/user"));
  const repos = await tryRead(rep, "list repositories", "Metadata: Read", () => call<{ full_name: string; archived?: boolean; default_branch: string; permissions?: { push?: boolean; admin?: boolean } }[]>(f, "github", conn.token, "/user/repos", { query: { per_page: "100", sort: "pushed" } }));
  rep.authenticated = !!me?.login || !!repos;
  if (!rep.authenticated) { rep.errors.push("the token did not authenticate"); return rep; }
  rep.identity = me?.login ?? "fine-grained token";
  const list = (repos ?? []).filter((r) => !r.archived);
  // The merge gate needs to read checks, statuses and protection: test them on one writable repository (read-only).
  const probe = list.find((r) => r.permissions?.push);
  const perms: Record<string, string> = {};
  if (probe) {
    const t = async (label: string, path: string, permission: string) => { perms[label] = await call(f, "github", conn.token, path).then(() => "readable", (e: unknown) => { if (e instanceof ProviderError && (e.status === 403 || e.status === 401)) { (label === "checks" ? [] : rep.missing).push(`${permission} on ${probe.full_name} (needed for safe automatic merging)`); return "DENIED"; } return `error ${msg(e)}`; }); };
    const head = await call<{ object: { sha: string } }>(f, "github", conn.token, `/repos/${probe.full_name}/git/ref/heads/${encodeURIComponent(probe.default_branch)}`).catch(() => null);
    if (head) { await t("checks", `/repos/${probe.full_name}/commits/${head.object.sha}/check-runs`, "Checks: Read"); await t("statuses", `/repos/${probe.full_name}/commits/${head.object.sha}/status`, "Commit statuses: Read"); }
    await t("branchProtection", `/repos/${probe.full_name}/branches/${encodeURIComponent(probe.default_branch)}`, "Metadata: Read");
    perms.probedOn = probe.full_name;
  }
  // Without the Checks API Crestmont cannot verify a PR's checks, so it never merges on its own: it opens the PR and the
  // Owner merges it (manual approval). That is a supported mode, not a missing permission.
  const automaticMerging = !probe ? "not tested (no writable repository)" : Object.entries(perms).some(([k, v]) => k !== "probedOn" && v !== "readable")
    ? `off — this connection cannot read ${Object.entries(perms).filter(([k, v]) => k !== "probedOn" && v !== "readable").map(([k]) => k).join(", ")}, so Crestmont opens each header pull request and waits for you to review and merge it (manual approval)`
    : "on — Crestmont merges its own header pull request only after every check passed and the branch requires no review (fail closed)";
  rep.scope = { repositories: list.map((r) => `${r.full_name}${r.permissions?.push ? " (write)" : " (read only)"}`), mergeGateReads: perms, automaticMerging };
  if (!list.some((r) => r.permissions?.push)) rep.missing.push("Contents and Pull requests: Read and write on the website repositories (the token can push to none)");
  return rep;
}

export async function verifyConnections(f: typeof fetch, conn: NativeConnections): Promise<ConnectionsReport> {
  const [cloudflare, vercel, github] = await Promise.all([verifyCloudflare(f, conn.cloudflare), verifyVercel(f, conn.vercel), verifyGithub(f, conn.github)]);
  return { at: new Date().toISOString(), cloudflare, vercel, github };
}
