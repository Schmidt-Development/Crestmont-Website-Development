// Cloudflare adapter. Discovery uses only the authenticated account: the host must belong to an active zone that the
// token can read, and it must be proxied by Cloudflare (a proxied DNS record, a Workers custom domain or route, or a
// Pages custom domain) — only then do zone rules apply to its responses.
// Configuration is Cloudflare's own supported mechanism for response headers: ONE Response Header Transform Rule in
// the zone's http_response_headers_transform phase, owned by Crestmont (stable `ref`), that on exactly the host's
// public paths ADDS `Content-Security-Policy: frame-ancestors <Crestmont origins>` (a second policy — the site's own
// CSP is left untouched) and removes X-Frame-Options.
// When the site's OWN policy already sets frame-ancestors (a second policy cannot loosen it), the rule instead replaces
// that one directive and nothing else: it matches only when the response's Content-Security-Policy is byte-for-byte the
// policy Crestmont read (stable across requests), and sets the same policy with only frame-ancestors changed. Every other
// directive (script-src, connect-src, …) is kept exactly; if the site ever sends a different policy, the rule simply
// stops matching and the page refuses framing again (fail closed). Other rules in the phase are never sent or changed: Crestmont's
// rule is added, updated or deleted through the per-rule endpoints. Re-running it changes nothing when the rule is
// already exactly right.
import { call, type NativeConnections } from "./connections.ts";

export interface CloudflareTarget { kind: "cloudflare"; accountId: string; zoneId: string; zone: string; serving: string; /** Which authorized Cloudflare account serves it (multi-account; 0 = the first). */ conn?: number;
  /** A zone rule can set this host's headers (it is in a connected zone and proxied by Cloudflare). */
  ruleCapable: boolean; pages?: { project: string; repo: string | null; branch: string | null; destination: string; root: string; buildCommand: string } }
interface Zone { id: string; name: string; status: string; account: { id: string } }
interface Rule { id?: string; ref?: string; expression: string; action: string; action_parameters?: unknown; description?: string; enabled?: boolean }
interface Ruleset { id: string; rules?: Rule[] }
type Env<T> = { success?: boolean; result: T; result_info?: { total_pages?: number } };

const zoneCandidates = (host: string) => { const l = host.split("."); const out: string[] = []; for (let i = 0; i <= l.length - 2; i++) out.push(l.slice(i).join(".")); return out; };

type PagesInfo = NonNullable<CloudflareTarget["pages"]>;
async function findPages(f: typeof fetch, token: string, account: string, host: string): Promise<PagesInfo | null> {
  for (let page = 1; page <= 10; page++) {
    // The Pages list endpoint rejects per_page values other than its own (HTTP 400 "Invalid list options"): use its
    // default page size and follow result_info.total_pages.
    const r = await call<Env<{ name: string; domains?: string[]; source?: { type?: string; config?: { owner?: string; repo_name?: string; production_branch?: string } }; build_config?: { destination_dir?: string; root_dir?: string; build_command?: string } }[]>>(f, "cloudflare", token, `/accounts/${account}/pages/projects`, page > 1 ? { query: { page: String(page) } } : {}).catch(() => null);
    const hit = r?.result?.find((p) => (p.domains ?? []).includes(host));
    if (hit) {
      const gh = hit.source?.type === "github" && hit.source.config?.owner && hit.source.config.repo_name ? `${hit.source.config.owner}/${hit.source.config.repo_name}` : null;
      return { project: hit.name, repo: gh, branch: hit.source?.config?.production_branch ?? null, destination: hit.build_config?.destination_dir ?? "", root: hit.build_config?.root_dir ?? "", buildCommand: hit.build_config?.build_command ?? "" };
    }
    if (!r?.result?.length || page >= (r.result_info?.total_pages ?? 1)) break;
  }
  return null;
}

export async function discoverCloudflare(f: typeof fetch, conn: NonNullable<NativeConnections["cloudflare"]>, host: string): Promise<{ target: CloudflareTarget | null; detail: string }> {
  let zone: Zone | null = null;
  for (const name of zoneCandidates(host)) {
    const r = await call<Env<Zone[]>>(f, "cloudflare", conn.token, "/zones", { query: { name, status: "active" } });
    const z = r?.result?.find((x) => x.name === name && x.status === "active" && (!conn.accounts.length || conn.accounts.includes(x.account.id)));
    if (z) { zone = z; break; }
  }
  if (!zone) {
    // A Pages project belongs to the account, wherever its domain's DNS is: look there before giving up.
    const accounts = conn.accounts.length ? conn.accounts : ((await call<Env<{ id: string }[]>>(f, "cloudflare", conn.token, "/accounts").catch(() => null))?.result ?? []).map((a) => a.id).slice(0, 10);
    for (const acct of accounts) {
      const pages = await findPages(f, conn.token, acct, host);
      if (pages) return { target: { kind: "cloudflare", accountId: acct, zoneId: "", zone: "", serving: `Pages project ${pages.project} (its domain is not in a connected zone)`, ruleCapable: false, pages }, detail: `${host} is a custom domain of the Cloudflare Pages project ${pages.project}${pages.repo ? ` (repository ${pages.repo}, branch ${pages.branch ?? "?"})` : " (not linked to GitHub)"}` };
    }
    return { target: null, detail: `${host} is not in any Cloudflare zone or Pages project this connection can read` };
  }
  const acct = zone.account.id;
  const serving: string[] = [];
  const dns = await call<Env<{ name: string; type: string; proxied?: boolean }[]>>(f, "cloudflare", conn.token, `/zones/${zone.id}/dns_records`, { query: { name: host } });
  if (dns?.result?.some((r) => r.name === host && r.proxied)) serving.push("proxied DNS record");
  const wd = await call<Env<{ hostname: string; service: string }[]>>(f, "cloudflare", conn.token, `/accounts/${acct}/workers/domains`, { query: { hostname: host } }).catch(() => null);
  const worker = wd?.result?.find((d) => d.hostname === host);
  if (worker) serving.push(`Workers custom domain (${worker.service})`);
  const routes = await call<Env<{ pattern: string; script?: string }[]>>(f, "cloudflare", conn.token, `/zones/${zone.id}/workers/routes`).catch(() => null);
  const route = routes?.result?.find((r) => r.pattern.split("/")[0] === host || (r.pattern.startsWith("*.") && host.endsWith(r.pattern.split("/")[0].slice(1))));
  if (route) serving.push(`Workers route ${route.pattern}${route.script ? ` (${route.script})` : ""}`);
  const pages = await findPages(f, conn.token, acct, host);
  if (pages) serving.push(`Pages project ${pages.project}`);
  if (!serving.length) return { target: null, detail: `${host} is in the Cloudflare zone ${zone.name}, but it is not proxied by Cloudflare (DNS only), so zone rules cannot set its headers` };
  return { target: { kind: "cloudflare", accountId: acct, zoneId: zone.id, zone: zone.name, serving: serving.join(", "), ruleCapable: true, pages: pages ?? undefined }, detail: `${host} is served through Cloudflare zone ${zone.name} (${serving.join(", ")})` };
}

const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const ruleRef = async (host: string) => `crestmont_native_${(await hex(host)).slice(0, 16)}`;
const PHASE = "http_response_headers_transform";

/** A site policy whose frame-ancestors directive Crestmont may replace: one policy, printable ASCII, bounded, exactly
 *  one frame-ancestors directive. Returns the same policy with only that directive changed, or why it cannot. */
export const MAX_REWRITE_CSP = 1500;
export function rewriteFrameAncestors(csp: string, frameAncestors: string): { ok: true; observed: string; value: string } | { ok: false; why: string } {
  const observed = csp;
  if (!observed.trim()) return { ok: false, why: "the site sends an empty Content-Security-Policy" };
  if (observed.includes(",")) return { ok: false, why: "the site sends more than one Content-Security-Policy, which a single rule cannot rewrite safely" };
  if (!/^[\x20-\x7e]+$/.test(observed)) return { ok: false, why: "the site's Content-Security-Policy contains characters a rule cannot match exactly" };
  if (observed.length > MAX_REWRITE_CSP) return { ok: false, why: `the site's Content-Security-Policy is longer than ${MAX_REWRITE_CSP} characters` };
  const parts = observed.split(";").map((d) => d.trim()).filter(Boolean);
  const fa = parts.filter((d) => /^frame-ancestors(\s|$)/i.test(d));
  if (fa.length !== 1) return { ok: false, why: `the site's Content-Security-Policy has ${fa.length} frame-ancestors directives` };
  return { ok: true, observed, value: parts.map((d) => (/^frame-ancestors(\s|$)/i.test(d) ? frameAncestors : d)).join("; ") };
}

/** The exact rule Crestmont wants for this host (deterministic for the same input, so re-running is a no-op). With
 *  `siteCsp` (the site's own policy sets frame-ancestors), the rule replaces only that directive — see the header. */
export async function desiredRule(host: string, paths: string[], frameAncestors: string, siteCsp?: string | null): Promise<Rule> {
  const set = [...new Set(paths)].sort().map((p) => JSON.stringify(p)).join(" ");
  let expression = `(http.host eq ${JSON.stringify(host)} and http.request.uri.path in {${set}})`;
  let csp: { operation: string; value: string } = { operation: "add", value: frameAncestors };
  if (siteCsp) {
    const rw = rewriteFrameAncestors(siteCsp, frameAncestors);
    if (!rw.ok) throw new Error(`Crestmont cannot rewrite this site's policy: ${rw.why}`);
    expression = `(http.host eq ${JSON.stringify(host)} and http.request.uri.path in {${set}} and http.response.headers["content-security-policy"][0] eq ${JSON.stringify(rw.observed)})`;
    csp = { operation: "set", value: rw.value };
  }
  if (expression.length > 4000) throw new Error("Crestmont cannot express this site's rule within Cloudflare's 4,000-character limit (too many public paths or too long a policy)");
  return {
    ref: await ruleRef(host),
    description: `Crestmont portfolio: allow native embedding of ${host} public pages (managed by Crestmont; sensitive pages unchanged)`.slice(0, 500),
    expression,
    action: "rewrite",
    action_parameters: { headers: { "Content-Security-Policy": csp, "X-Frame-Options": { operation: "remove" } } },
    enabled: true,
  };
}
const same = (a: Rule, b: Rule) => a.expression === b.expression && a.action === b.action && JSON.stringify(a.action_parameters) === JSON.stringify(b.action_parameters) && (a.enabled ?? true) === (b.enabled ?? true);

/** Adds or updates Crestmont's rule. Returns what happened and the rule's identifiers (for audit and rollback). */
export async function applyCloudflareRule(f: typeof fetch, conn: NonNullable<NativeConnections["cloudflare"]>, t: CloudflareTarget, host: string, paths: string[], frameAncestors: string, siteCsp?: string | null): Promise<{ action: "created" | "updated" | "unchanged"; rulesetId: string; ruleId: string; ref: string; paths: number }> {
  const want = await desiredRule(host, paths, frameAncestors, siteCsp);
  const entry = await call<Env<Ruleset>>(f, "cloudflare", conn.token, `/zones/${t.zoneId}/rulesets/phases/${PHASE}/entrypoint`);
  if (!entry?.result) {
    const made = await call<Env<Ruleset>>(f, "cloudflare", conn.token, `/zones/${t.zoneId}/rulesets/phases/${PHASE}/entrypoint`, { method: "PUT", body: { rules: [want] } });
    const r = made!.result;
    return { action: "created", rulesetId: r.id, ruleId: r.rules?.find((x) => x.ref === want.ref)?.id ?? "", ref: want.ref!, paths: paths.length };
  }
  const rs = entry.result, mine = rs.rules?.find((x) => x.ref === want.ref);
  if (mine && same(mine, want)) return { action: "unchanged", rulesetId: rs.id, ruleId: mine.id ?? "", ref: want.ref!, paths: paths.length };
  if (mine?.id) {
    await call(f, "cloudflare", conn.token, `/zones/${t.zoneId}/rulesets/${rs.id}/rules/${mine.id}`, { method: "PATCH", body: want });
    return { action: "updated", rulesetId: rs.id, ruleId: mine.id, ref: want.ref!, paths: paths.length };
  }
  const added = await call<Env<Ruleset>>(f, "cloudflare", conn.token, `/zones/${t.zoneId}/rulesets/${rs.id}/rules`, { method: "POST", body: want });
  return { action: "created", rulesetId: rs.id, ruleId: added?.result.rules?.find((x) => x.ref === want.ref)?.id ?? "", ref: want.ref!, paths: paths.length };
}

/** Removes Crestmont's rule (rollback when it did not take effect, or when the project is removed). Idempotent. */
export async function removeCloudflareRule(f: typeof fetch, conn: NonNullable<NativeConnections["cloudflare"]>, t: CloudflareTarget, host: string): Promise<boolean> {
  const ref = await ruleRef(host);
  const entry = await call<Env<Ruleset>>(f, "cloudflare", conn.token, `/zones/${t.zoneId}/rulesets/phases/${PHASE}/entrypoint`);
  const mine = entry?.result.rules?.find((x) => x.ref === ref);
  if (!entry || !mine?.id) return false;
  await call(f, "cloudflare", conn.token, `/zones/${t.zoneId}/rulesets/${entry.result.id}/rules/${mine.id}`, { method: "DELETE" });
  return true;
}

/** Latest production deployment of a Pages project: done (with its commit), building, or failed. */
export async function pagesDeployment(f: typeof fetch, conn: NonNullable<NativeConnections["cloudflare"]>, t: CloudflareTarget): Promise<{ state: "ready" | "building" | "failed" | "none"; commit: string | null; detail: string }> {
  if (!t.pages) return { state: "none", commit: null, detail: "not a Pages project" };
  const r = await call<Env<{ id: string; latest_stage?: { name?: string; status?: string }; deployment_trigger?: { metadata?: { commit_hash?: string } } }[]>>(f, "cloudflare", conn.token, `/accounts/${t.accountId}/pages/projects/${encodeURIComponent(t.pages.project)}/deployments`, { query: { env: "production" } });
  const d = r?.result?.[0];
  if (!d) return { state: "none", commit: null, detail: "no production deployment yet" };
  const st = d.latest_stage?.status ?? "", commit = d.deployment_trigger?.metadata?.commit_hash ?? null;
  const state = st === "success" && d.latest_stage?.name === "deploy" ? "ready" : st === "failure" || st === "canceled" ? "failed" : "building";
  return { state, commit, detail: `Pages deployment ${d.id}: ${d.latest_stage?.name ?? "?"} ${st || "?"}` };
}
