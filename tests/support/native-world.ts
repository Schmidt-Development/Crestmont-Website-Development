import { createVerify } from "node:crypto";
// A hermetic stand-in for the providers the native-readiness automation talks to (Cloudflare, Vercel, GitHub) and for
// the websites themselves — TEST DATA only, nothing external is contacted. The sites' response headers are derived
// from what the fake providers actually hold: a Cloudflare rule only changes them when it is in the zone (and
// `ruleTakesEffect`), a repository change only after it is merged AND the provider's deployment of that commit is
// READY. So a test can only reach "native verified" through the same steps a real website would.
export const CRESTMONT_ORIGIN = new URL("http://crestmont.test").origin;
export const CRESTMONT_ALLOW = `frame-ancestors ${CRESTMONT_ORIGIN}`;

export interface Site {
  host: string;
  pages: Record<string, string>;          // path → HTML
  baseXfo?: string | null;                 // default DENY
  baseCsp?: string | null;                 // the site's own CSP (e.g. "frame-ancestors 'none'" = a conflict)
  cspNonce?: boolean;                      // the site's CSP carries a new nonce on every response (not rule-matchable)
  ruleTakesEffect?: boolean;               // a Cloudflare zone rule rewrites this site's responses (default true)
  redirectTo?: string;                     // "/" redirects to this absolute URL
  sensitiveOpen?: boolean;                 // its sign-in/booking pages do NOT refuse framing (a security defect)
}
interface Rule { id: string; ref?: string; expression: string; action: string; action_parameters: { headers: Record<string, { operation: string; value?: string }> }; enabled?: boolean; description?: string }
interface Zone { id: string; name: string; account: string; /** The API token whose account holds this zone (multi-account). */ token: string; rulesets: { id: string; rules: Rule[] } | null; dns: { name: string; type: string; proxied: boolean }[]; workerDomains: { hostname: string; service: string }[] }
interface Repo { full: string; push: boolean; protectedReviews: boolean; branches: Record<string, { sha: string; files: Record<string, string> }>; pulls: { number: number; head: string; base: string; state: "open" | "closed"; merged: boolean; merge_commit_sha: string | null; title: string; created_at: string }[]; closeNextPr?: boolean;
  /** What CI reports on a PR's head commit (default: one passing check run "build"). */
  checks: { name: string; status: string; conclusion: string | null }[]; statuses: { context: string; state: string }[];
  /** Branch protection without reviews: required status checks; unreadable = the token cannot read protection. */
  requiredChecks: string[] | null; protectionUnreadable?: boolean; checksUnreadable?: boolean; changesRequested?: boolean }
interface Deploy { uid: string; commit: string; state: "BUILDING" | "READY" | "ERROR"; polls: number; files: Record<string, string> }
interface VProject { id: string; name: string; domain: string; verified: boolean; repo: string | null; branch: string; root: string; deployments: Deploy[]; failDeploy?: boolean }
interface PProject { name: string; account: string; domain: string; repo: string | null; branch: string; destination: string; buildCommand: string; deployments: { id: string; commit: string; stage: "success" | "failure" | "active"; polls: number; files: Record<string, string> }[]; failDeploy?: boolean }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
let seq = 0;
const sha = () => (++seq).toString(16).padStart(40, "a");

export class NativeWorld {
  sites = new Map<string, Site>();
  zones: Zone[] = [];
  vprojects: VProject[] = [];
  pprojects: PProject[] = [];
  repos = new Map<string, Repo>();
  calls: string[] = [];
  /** Every merge Crestmont asked for: repo#pr@head-sha. */
  mergeCalls: string[] = [];
  /** Requests that changed something at a provider (for idempotency assertions). */
  writes: string[] = [];

  site(s: Site) { this.sites.set(s.host, s); return this; }
  cloudflareZone(name: string, account: string, opts: { proxied?: string[]; workerDomain?: { hostname: string; service: string }; token?: string } = {}) {
    this.zones.push({ id: `zone_${name.replace(/\W/g, "")}`.padEnd(32, "0").slice(0, 32), name, account, token: opts.token ?? "cf-test-token", rulesets: null, dns: (opts.proxied ?? []).map((n) => ({ name: n, type: "A", proxied: true })), workerDomains: opts.workerDomain ? [opts.workerDomain] : [] });
    return this;
  }
  repo(full: string, opts: { push?: boolean; protectedReviews?: boolean; branch?: string; files?: Record<string, string>; checks?: Repo["checks"]; statuses?: Repo["statuses"]; requiredChecks?: string[] } = {}) {
    this.repos.set(full, { full, push: opts.push ?? true, protectedReviews: opts.protectedReviews ?? false, branches: { [opts.branch ?? "main"]: { sha: sha(), files: { ...(opts.files ?? {}) } } }, pulls: [],
      checks: opts.checks ?? [{ name: "build", status: "completed", conclusion: "success" }], statuses: opts.statuses ?? [], requiredChecks: opts.requiredChecks ?? null });
    return this;
  }
  vercel(p: Omit<VProject, "deployments">) { this.vprojects.push({ ...p, deployments: [] }); return this; }
  pages(p: Omit<PProject, "deployments">) { this.pprojects.push({ ...p, deployments: [] }); return this; }

  // ── The websites ──
  private effective(host: string, path: string): { allow: boolean; xfo: string | null; csp: string[] } {
    const s = this.sites.get(host)!;
    let xfo: string | null = s.baseXfo === undefined ? "DENY" : s.baseXfo;
    const csp = s.baseCsp ? [s.cspNonce ? `${s.baseCsp}; script-src 'nonce-${++seq}'` : s.baseCsp] : [];
    const sensitive = /\/(login|admin|book|account|checkout)/.test(path);
    if (sensitive && !s.sensitiveOpen) return { allow: false, xfo: "DENY", csp: ["frame-ancestors 'none'"] };
    // Cloudflare zone rule (Crestmont's): applied to responses when the site is proxied by the zone.
    const zone = this.zones.find((z) => host === z.name || host.endsWith("." + z.name));
    for (const r of zone?.rulesets?.rules ?? []) {
      // Cloudflare's rule language as Crestmont writes it: host, exact paths and, optionally, the response's exact
      // Content-Security-Policy (string literals with \" and \\ escapes, as Cloudflare reads them).
      const m = /^\(http\.host eq ("(?:[^"\\]|\\.)*") and http\.request\.uri\.path in \{([^}]*)\}(?: and http\.response\.headers\["content-security-policy"\]\[0\] eq ("(?:[^"\\]|\\.)*"))?\)$/.exec(r.expression);
      if (!m || JSON.parse(m[1]) !== host || r.enabled === false || s.ruleTakesEffect === false) continue;
      const paths = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`) as string);
      if (!paths.includes(path)) continue;
      if (m[3] !== undefined && (csp.length !== 1 || csp[0] !== JSON.parse(m[3]))) continue;
      const h = r.action_parameters.headers;
      if (h["X-Frame-Options"]?.operation === "remove") xfo = null;
      if (h["Content-Security-Policy"]?.operation === "add") csp.push(h["Content-Security-Policy"].value!);
      if (h["Content-Security-Policy"]?.operation === "set") csp.splice(0, csp.length, h["Content-Security-Policy"].value!);
    }
    // Deployed repository configuration (Vercel vercel.json / Pages _headers) of the READY production deployment.
    const vp = this.vprojects.find((p) => p.domain === host);
    const vdep = vp?.deployments.filter((d) => d.state === "READY").at(-1);
    const vjson = vdep?.files[[vp!.root, "vercel.json"].filter(Boolean).join("/")];
    if (vjson) for (const e of (JSON.parse(vjson).headers ?? []) as { source: string; headers: { key: string; value: string }[] }[]) if (e.source === path) for (const h of e.headers) if (/^content-security-policy$/i.test(h.key)) csp.push(h.value);
    const pp = this.pprojects.find((p) => p.domain === host);
    const pdep = pp?.deployments.filter((d) => d.stage === "success").at(-1);
    const hdr = pdep?.files[[pp!.destination, "_headers"].filter(Boolean).join("/")];
    if (hdr) {
      let rule = "";
      for (const line of hdr.split("\n")) {
        if (!line.trim() || line.startsWith("#")) continue;
        if (!/^\s/.test(line)) { rule = line.trim(); continue; }
        if (rule !== path && !(rule.endsWith("*") && path.startsWith(rule.slice(0, -1)))) continue;
        const t = line.trim();
        if (t === "! X-Frame-Options") xfo = null;
        else if (/^Content-Security-Policy:/i.test(t)) csp.push(t.replace(/^Content-Security-Policy:\s*/i, ""));
        else if (/^X-Frame-Options:/i.test(t)) xfo = t.split(":")[1].trim();
      }
    }
    const fa = csp.flatMap((c) => c.split(";").map((d) => d.trim()).filter((d) => d.startsWith("frame-ancestors")));
    // Exact source tokens, as a browser compares them (never a substring of the directive).
    const isCrestmont = (tok: string) => { try { return new URL(tok).origin === CRESTMONT_ORIGIN; } catch { return false; } };
    const allow = fa.length ? fa.every((d) => d.split(/\s+/).slice(1).some(isCrestmont)) : !xfo;
    return { allow, xfo, csp };
  }
  /** The site's response for a URL (headers derived from the providers' state). */
  respond(url: string): { status: number; headers: Record<string, string>; body: string } | null {
    const u = new URL(url);
    const s = this.sites.get(u.hostname);
    if (!s) return null;
    if (s.redirectTo && u.pathname === "/") return { status: 301, headers: { location: s.redirectTo }, body: "" };
    const body = s.pages[u.pathname];
    if (body === undefined) return { status: 404, headers: { "content-type": "text/html" }, body: "<h1>Not found</h1>" };
    const e = this.effective(u.hostname, u.pathname);
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
    if (e.xfo) headers["x-frame-options"] = e.xfo;
    if (e.csp.length) headers["content-security-policy"] = e.csp.join(", ");
    return { status: 200, headers, body };
  }
  fetchSite: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    this.calls.push(`site ${url}`);
    const r = this.respond(url);
    if (!r) throw new TypeError("fetch failed");
    return new Response(r.status === 301 ? null : r.body, { status: r.status, headers: r.headers });
  };

  // ── Provider APIs ──
  fetchApi: typeof fetch = async (input, init) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    this.calls.push(`${method} ${u.host}${u.pathname}${u.search}`);
    if (method !== "GET") this.writes.push(`${method} ${u.host}${u.pathname}`);
    // GitHub App: an RS256 app JWT is exchanged for an installation token (the signature is checked with the App's key).
    if (u.host === "api.github.com" && /^\/app\/installations\/\d+\/access_tokens$/.test(u.pathname) && method === "POST") {
      const jwt = auth.replace(/^Bearer /, ""), parts = jwt.split(".");
      const ok = parts.length === 3 && !!this.appPublicKey && createVerify("RSA-SHA256").update(`${parts[0]}.${parts[1]}`).verify(this.appPublicKey, Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64"));
      if (!ok) return json({ message: "A JSON web token could not be decoded" }, 401);
      this.appTokensMinted++;
      return json({ token: "gh-test-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    if (!/^Bearer (cf|vc|gh)\d?-test-token$/.test(auth)) return json({ errors: [{ message: "Invalid API token" }], message: "Bad credentials" }, 403);
    this.token = auth.slice(7);
    if (u.host === "api.cloudflare.com") return this.cloudflare(u, method, body);
    if (u.host === "api.vercel.com") return this.vercelApi(u);
    if (u.host === "api.github.com") return this.github(u, method, body);
    return json({}, 404);
  };

  private token = "";
  /** Zones the calling token's account can see (each token is its own Cloudflare account). */
  private get myZones() { return this.zones.filter((z) => z.token === this.token); }
  private cloudflare(u: URL, method: string, body: { rules?: Rule[] } & Rule | null): Response {
    const p = u.pathname.replace("/client/v4", "");
    let m: RegExpExecArray | null;
    if (p === "/accounts") return json({ result: [...new Set([...this.myZones.map((z) => z.account), ...(this.token === "cf-test-token" ? this.pprojects.map((x) => x.account) : [])])].map((id) => ({ id, name: `Account ${id.slice(0, 4)}` })) });
    if (p === "/user/tokens/verify") return json({ result: { status: "active" } });
    if (p === "/zones") { const z = this.myZones.filter((x) => !u.searchParams.get("name") || x.name === u.searchParams.get("name")); return json({ success: true, result: z.map((x) => ({ id: x.id, name: x.name, status: "active", account: { id: x.account } })) }); }
    if ((m = /^\/zones\/([^/]+)\/dns_records$/.exec(p))) { const z = this.zones.find((x) => x.id === m![1]); return json({ result: (z?.dns ?? []).filter((r) => r.name === u.searchParams.get("name")) }); }
    if ((m = /^\/accounts\/([^/]+)\/workers\/domains$/.exec(p))) return json({ result: this.myZones.filter((z) => z.account === m![1]).flatMap((z) => z.workerDomains).filter((d) => !u.searchParams.get("hostname") || d.hostname === u.searchParams.get("hostname")) });
    if ((m = /^\/zones\/([^/]+)\/workers\/routes$/.exec(p))) return json({ result: [] });
    // Like Cloudflare in production: the Pages list refuses a per_page it does not accept (HTTP 400).
    if (/^\/accounts\/[^/]+\/pages\/projects$/.test(p) && u.searchParams.has("per_page")) return json({ success: false, errors: [{ code: 8000024, message: "Invalid list options provided. Review the `page` or `per_page` parameter." }] }, 400);
    if ((m = /^\/accounts\/([^/]+)\/pages\/projects$/.exec(p))) return json({ result: this.pprojects.filter((x) => x.account === m![1]).map((x) => ({ name: x.name, domains: [x.domain], source: x.repo ? { type: "github", config: { owner: x.repo.split("/")[0], repo_name: x.repo.split("/")[1], production_branch: x.branch } } : undefined, build_config: { destination_dir: x.destination, root_dir: "", build_command: x.buildCommand } })), result_info: { total_pages: 1 } });
    if ((m = /^\/accounts\/([^/]+)\/pages\/projects\/([^/]+)\/deployments$/.exec(p))) {
      const pp = this.pprojects.find((x) => x.name === decodeURIComponent(m![2]))!;
      for (const d of pp.deployments) if (d.stage === "active" && ++d.polls >= 2) d.stage = pp.failDeploy ? "failure" : "success";
      return json({ result: [...pp.deployments].reverse().map((d) => ({ id: d.id, latest_stage: { name: "deploy", status: d.stage }, deployment_trigger: { metadata: { commit_hash: d.commit } } })) });
    }
    if ((m = /^\/zones\/([^/]+)\/rulesets\/phases\/http_response_headers_transform\/entrypoint$/.exec(p))) {
      const z = this.zones.find((x) => x.id === m![1])!;
      if (method === "GET") return z.rulesets ? json({ result: z.rulesets }) : json({ errors: [{ message: "not found" }] }, 404);
      z.rulesets = { id: "rs_1", rules: (body!.rules ?? []).map((r, i) => ({ ...r, id: `rule_${i + 1}` })) };
      return json({ result: z.rulesets });
    }
    if ((m = /^\/zones\/([^/]+)\/rulesets\/([^/]+)\/rules(?:\/([^/]+))?$/.exec(p))) {
      const z = this.zones.find((x) => x.id === m![1])!;
      const rs = z.rulesets!;
      if (method === "POST") rs.rules.push({ ...(body as Rule), id: `rule_${rs.rules.length + 1}` });
      if (method === "PATCH") rs.rules = rs.rules.map((r) => (r.id === m![3] ? { ...(body as Rule), id: r.id } : r));
      if (method === "DELETE") rs.rules = rs.rules.filter((r) => r.id !== m![3]);
      return json({ result: rs });
    }
    return json({ errors: [{ message: `unhandled ${p}` }] }, 404);
  }

  private vercelApi(u: URL): Response {
    let m: RegExpExecArray | null;
    if (u.pathname === "/v2/user") return json({ user: { username: "test-owner" } });
    if (u.pathname === "/v2/teams") return json({ teams: [] });
    if (u.pathname === "/v9/projects") return json({ projects: this.vprojects.map((p) => ({ id: p.id, name: p.name, framework: "nextjs", rootDirectory: p.root || null, link: p.repo ? { type: "github", org: p.repo.split("/")[0], repo: p.repo.split("/")[1], productionBranch: p.branch } : undefined, targets: { production: { alias: [p.domain] } } })), pagination: { next: null } });
    if ((m = /^\/v9\/projects\/([^/]+)\/domains\/([^/]+)$/.exec(u.pathname))) { const p = this.vprojects.find((x) => x.id === m![1]); return p && p.domain === m[2] ? json({ name: p.domain, verified: p.verified, redirect: null }) : json({}, 404); }
    if (u.pathname === "/v6/deployments") {
      const p = this.vprojects.find((x) => x.id === u.searchParams.get("projectId"))!;
      for (const d of p.deployments) if (d.state === "BUILDING" && ++d.polls >= 2) d.state = p.failDeploy ? "ERROR" : "READY";
      return json({ deployments: [...p.deployments].reverse().map((d) => ({ uid: d.uid, readyState: d.state, meta: { githubCommitSha: d.commit } })) });
    }
    return json({}, 404);
  }

  /** What a merge to a production branch triggers at the provider linked to that repository. */
  private deploy(repo: string, branch: string, commit: string, files: Record<string, string>) {
    for (const p of this.vprojects) if (p.repo === repo && p.branch === branch) p.deployments.push({ uid: `dpl_${commit.slice(0, 8)}`, commit, state: "BUILDING", polls: 0, files: { ...files } });
    for (const p of this.pprojects) if (p.repo === repo && p.branch === branch) p.deployments.push({ id: `pg_${commit.slice(0, 8)}`, commit, stage: "active", polls: 0, files: { ...files } });
  }
  /** The Owner merges Crestmont's PR by hand (a protected branch). */
  ownerMerges(repo: string, n: number) { const r = this.repos.get(repo)!; const pr = r.pulls.find((x) => x.number === n)!; this.merge(r, pr); }
  private merge(r: Repo, pr: Repo["pulls"][number]) {
    const head = r.branches[pr.head], base = r.branches[pr.base];
    base.files = { ...base.files, ...head.files }; base.sha = sha();
    pr.state = "closed"; pr.merged = true; pr.merge_commit_sha = base.sha;
    this.deploy(r.full, pr.base, base.sha, base.files);
  }

  /** The GitHub App's public key (PEM) — set by a test that configures PORTFOLIO_GITHUB_APP_*. */
  appPublicKey: string | null = null; appTokensMinted = 0;
  private github(u: URL, method: string, body: Record<string, unknown> | null): Response {
    if (u.pathname === "/installation/repositories") return json({ repositories: [...this.repos.values()].map((r) => ({ full_name: r.full, archived: false, default_branch: Object.keys(r.branches)[0] })) });
    if (u.pathname === "/user") return json({ login: "test-owner" });
    if (u.pathname === "/user/repos") return json([...this.repos.values()].map((r) => ({ full_name: r.full, archived: false, default_branch: Object.keys(r.branches)[0], permissions: { push: r.push, admin: false } })));
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(u.pathname);
    const r = m ? this.repos.get(m[1]) : undefined;
    if (!r) return json({ message: "Not Found" }, 404);
    const rest = m![2] ?? "";
    let x: RegExpExecArray | null;
    if (!rest) return json({ full_name: r.full, default_branch: "main", archived: false, permissions: { push: r.push, pull: true } });
    if ((x = /^\/branches\/([^/]+)$/.exec(rest))) return r.branches[decodeURIComponent(x[1])] ? json({ name: x[1], protected: r.protectedReviews || !!r.requiredChecks || !!r.protectionUnreadable }) : json({}, 404);
    if ((x = /^\/branches\/([^/]+)\/protection$/.exec(rest))) {
      if (r.protectionUnreadable) return json({ message: "Resource not accessible by integration" }, 403);
      if (r.protectedReviews) return json({ required_pull_request_reviews: { required_approving_review_count: 1 } });
      return r.requiredChecks ? json({ required_status_checks: { contexts: r.requiredChecks, checks: r.requiredChecks.map((c) => ({ context: c })) } }) : json({}, 404);
    }
    if ((x = /^\/commits\/([^/]+)\/check-runs$/.exec(rest))) return r.checksUnreadable ? json({ message: "Resource not accessible by integration" }, 403) : json({ total_count: r.checks.length, check_runs: r.checks });
    if ((x = /^\/commits\/([^/]+)\/status$/.exec(rest))) return json({ state: "success", statuses: r.statuses, total_count: r.statuses.length });
    if ((x = /^\/pulls\/(\d+)\/reviews$/.exec(rest))) return json(r.changesRequested ? [{ user: { login: "reviewer" }, state: "CHANGES_REQUESTED" }] : []);
    if ((x = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) { const b = r.branches[decodeURIComponent(x[1])]; return b ? json({ object: { sha: b.sha } }) : json({}, 404); }
    if (rest === "/git/refs" && method === "POST") { const name = String(body!.ref).replace("refs/heads/", ""); const from = Object.values(r.branches).find((b) => b.sha === body!.sha)!; r.branches[name] = { sha: sha(), files: { ...from.files } }; return json({ ref: body!.ref }, 201); }
    if ((x = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === "PATCH") { const from = Object.values(r.branches).find((b) => b.sha === body!.sha)!; r.branches[decodeURIComponent(x[1])] = { sha: sha(), files: { ...from.files } }; return json({}); }
    if ((x = /^\/contents\/(.+)$/.exec(rest))) {
      const path = decodeURIComponent(x[1]);
      if (method === "GET") { const b = r.branches[u.searchParams.get("ref") ?? "main"]; const f = b?.files[path]; return f === undefined ? json({}, 404) : json({ type: "file", encoding: "base64", content: b64(f), sha: `blob_${path}` }); }
      if (!r.push) return json({ message: "Resource not accessible by integration" }, 403);
      const b = r.branches[String(body!.branch)]; b.files[path] = Buffer.from(String(body!.content), "base64").toString("utf8"); b.sha = sha();
      return json({ commit: { sha: b.sha } });
    }
    if (rest === "/pulls" && method === "GET") { const head = (u.searchParams.get("head") ?? "").split(":")[1]; return json(r.pulls.filter((p) => p.state === "open" && p.head === head).map((p) => ({ number: p.number, html_url: `https://github.com/${r.full}/pull/${p.number}`, head: { ref: p.head } }))); }
    if (rest === "/pulls" && method === "POST") { const n = r.pulls.length + 1; r.pulls.push({ number: n, head: String(body!.head), base: String(body!.base), state: "open", merged: false, merge_commit_sha: null, title: String(body!.title), created_at: new Date().toISOString() }); return json({ number: n, html_url: `https://github.com/${r.full}/pull/${n}` }, 201); }
    if ((x = /^\/pulls\/(\d+)$/.exec(rest))) {
      const pr = r.pulls.find((p) => p.number === Number(x![1]));
      if (!pr) return json({}, 404);
      if (r.closeNextPr && pr.state === "open") { pr.state = "closed"; r.closeNextPr = false; }
      const failing = r.checks.some((c) => c.status === "completed" && !["success", "neutral", "skipped"].includes(c.conclusion ?? ""));
      const running = r.checks.some((c) => c.status !== "completed");
      const state = r.protectedReviews ? "blocked" : running ? "unstable" : failing ? "unstable" : "clean";
      return json({ number: pr.number, state: pr.state, draft: false, merged: pr.merged, merge_commit_sha: pr.merge_commit_sha, mergeable: true, mergeable_state: state, head: { sha: r.branches[pr.head]?.sha ?? "0".repeat(40) }, base: { ref: pr.base }, created_at: pr.created_at, html_url: `https://github.com/${r.full}/pull/${pr.number}` });
    }
    if ((x = /^\/pulls\/(\d+)\/merge$/.exec(rest)) && method === "PUT") {
      const pr = r.pulls.find((p) => p.number === Number(x![1]))!;
      if (r.protectedReviews) return json({ message: "At least 1 approving review is required" }, 405);
      this.mergeCalls.push(`${r.full}#${pr.number}@${String(body?.sha ?? "")}`);
      this.merge(r, pr);
      return json({ merged: true, sha: pr.merge_commit_sha });
    }
    return json({ message: `unhandled ${rest}` }, 404);
  }
}

/** A website's homepage: content, links (public and sensitive), and optionally a WebGL scene or broken script. */
export function homepage(title: string, opts: { links?: string[]; webgl?: "ok" | "fail" | "deferred" | "decorative" | "broken-draws" | "module-error" | "top-only"; brokenJs?: boolean; divOnly?: boolean; heavy?: boolean } = {}): string {
  const links = (opts.links ?? ["/services", "/about", "/login", "/book"]).map((h) => `<a href="${h}">${h.slice(1)}</a>`).join(" ");
  const gl = opts.webgl === "ok"
    ? `<canvas id="globe" width="480" height="480" style="width:min(480px,100%);aspect-ratio:1;display:block"></canvas><script>(function(){var c=document.getElementById("globe");var g=c.getContext("webgl");if(!g)return;var t=0;function f(){t+=0.03;g.clearColor(0.05,0.1+0.4*Math.abs(Math.sin(t)),0.6,1);g.clear(g.COLOR_BUFFER_BIT);g.enable(g.SCISSOR_TEST);g.scissor(120+60*Math.sin(t),120,240,240);g.clearColor(0.2,0.8,0.3,1);g.clear(g.COLOR_BUFFER_BIT);g.disable(g.SCISSOR_TEST);requestAnimationFrame(f);}requestAnimationFrame(f);})();</script>`
    : opts.webgl === "fail" ? `<canvas id="globe" width="480" height="480" style="width:min(480px,100%);aspect-ratio:1;display:block"></canvas><script>/* the scene fails to initialise: nothing is ever drawn */</script>`
    // A scene that starts 2.5 s after load (lazy 3D, as many sites do): judged once it has had time to initialise.
    : opts.webgl === "deferred" ? `<canvas id="globe" width="480" height="480" style="width:min(480px,100%);aspect-ratio:1;display:block"></canvas><script>setTimeout(function(){var c=document.getElementById("globe");var g=c.getContext("webgl");if(!g)return;var t=0;function f(){t+=0.03;g.clearColor(0.6,0.2+0.3*Math.abs(Math.sin(t)),0.1,1);g.clear(g.COLOR_BUFFER_BIT);requestAnimationFrame(f);}requestAnimationFrame(f);},2500);</script>`
    // A decorative full-screen background canvas that never draws (aria-hidden, behind the content, pointer-events
    // none) — harmless, and must not block an otherwise working website.
    : opts.webgl === "decorative" ? `<canvas aria-hidden="true" width="1440" height="900" style="position:fixed;inset:0;width:100vw;height:100vh;z-index:-1;pointer-events:none"></canvas>`
    // A visible scene that creates its context and issues draw calls that never produce a pixel (a broken shader
    // pipeline): genuinely broken, on the website itself.
    // The scene's module fails to resolve and the renderer never starts (the canvas is never created) — what a page
    // whose import map arrives after the module preloads does with cached files.
    : opts.webgl === "module-error" ? `<script>setTimeout(function(){throw new TypeError('Failed to resolve module specifier "three". Relative references must start with either "/", "./", or "../".')},0)</script>`
    // A scene that only starts when the page is the top-level document (refuses to run inside any frame).
    : opts.webgl === "top-only" ? `<canvas id="globe" width="480" height="480" style="width:min(480px,100%);aspect-ratio:1;display:block"></canvas><script>(function(){if(window.top!==window)return;var c=document.getElementById("globe");var g=c.getContext("webgl");if(!g)return;var t=0;function f(){t+=0.03;g.clearColor(0.1,0.3+0.4*Math.abs(Math.sin(t)),0.5,1);g.clear(g.COLOR_BUFFER_BIT);requestAnimationFrame(f);}requestAnimationFrame(f);})();</script>`
    : opts.webgl === "broken-draws" ? `<canvas id="globe" width="480" height="480" style="width:min(480px,100%);aspect-ratio:1;display:block"></canvas><script>(function(){var c=document.getElementById("globe");var g=c.getContext("webgl",{premultipliedAlpha:false});if(!g)return;function f(){g.clearColor(0,0,0,0);g.clear(g.COLOR_BUFFER_BIT);g.drawArrays(g.TRIANGLES,0,3);requestAnimationFrame(f);}requestAnimationFrame(f);})();</script>` : "";
  // A main thread kept busy ~280 ms per frame (a heavy site, or a slow machine): slow, but alive.
  const heavy = opts.heavy ? `<script>(function(){function f(){var t=performance.now();while(performance.now()-t<280){}requestAnimationFrame(f);}requestAnimationFrame(f);})();</script>` : "";
  const body = opts.brokenJs
    ? `<div id="app"></div><script>throw new Error("bundle failed to load")</script>`
    // Only <div>/<span> text, inside a focus-target container (tabindex="-1", as many app shells and skip-link targets do).
    : opts.divOnly ? `<div id="root" tabindex="-1" style="outline:none"><div class="nav"><a href="/services">services</a></div><div class="hero"><span class="title">${title}</span><div class="lead">${title} is a TEST DATA website built only from div and span elements, as many component frameworks render.</div></div>${gl}${'<div class="row"><div class="cell">More TEST DATA content so the page can be scrolled by a visitor.</div></div>'.repeat(30)}</div>${heavy}`
    : `<header><nav>${links}</nav></header><main><h1>${title}</h1><p>${title} is a TEST DATA website used to verify Crestmont's native portfolio onboarding. It has real paragraphs of content.</p>${gl}${"<section><h2>Section</h2><p>More TEST DATA content so the page can be scrolled by a visitor.</p></section>".repeat(25)}</main>${heavy}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="${title} is a TEST DATA website."></head><body style="margin:0;font:16px sans-serif">${body}</body></html>`;
}
export const page = (title: string) => `<!doctype html><title>${title}</title><h1>${title}</h1><p>TEST DATA.</p>`;
