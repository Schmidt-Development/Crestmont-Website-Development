// A hermetic stand-in for the providers the native-readiness automation talks to (Cloudflare, Vercel, GitHub) and for
// the websites themselves — TEST DATA only, nothing external is contacted. The sites' response headers are derived
// from what the fake providers actually hold: a Cloudflare rule only changes them when it is in the zone (and
// `ruleTakesEffect`), a repository change only after it is merged AND the provider's deployment of that commit is
// READY. So a test can only reach "native verified" through the same steps a real website would.
export const CRESTMONT_ALLOW = "frame-ancestors http://crestmont.test";

export interface Site {
  host: string;
  pages: Record<string, string>;          // path → HTML
  baseXfo?: string | null;                 // default DENY
  baseCsp?: string | null;                 // the site's own CSP (e.g. "frame-ancestors 'none'" = a conflict)
  ruleTakesEffect?: boolean;               // a Cloudflare zone rule rewrites this site's responses (default true)
  redirectTo?: string;                     // "/" redirects to this absolute URL
}
interface Rule { id: string; ref?: string; expression: string; action: string; action_parameters: { headers: Record<string, { operation: string; value?: string }> }; enabled?: boolean; description?: string }
interface Zone { id: string; name: string; account: string; rulesets: { id: string; rules: Rule[] } | null; dns: { name: string; type: string; proxied: boolean }[]; workerDomains: { hostname: string; service: string }[] }
interface Repo { full: string; push: boolean; protectedReviews: boolean; branches: Record<string, { sha: string; files: Record<string, string> }>; pulls: { number: number; head: string; base: string; state: "open" | "closed"; merged: boolean; merge_commit_sha: string | null; title: string }[]; closeNextPr?: boolean }
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
  /** Requests that changed something at a provider (for idempotency assertions). */
  writes: string[] = [];

  site(s: Site) { this.sites.set(s.host, s); return this; }
  cloudflareZone(name: string, account: string, opts: { proxied?: string[]; workerDomain?: { hostname: string; service: string } } = {}) {
    this.zones.push({ id: `zone_${name.replace(/\W/g, "")}`.padEnd(32, "0").slice(0, 32), name, account, rulesets: null, dns: (opts.proxied ?? []).map((n) => ({ name: n, type: "A", proxied: true })), workerDomains: opts.workerDomain ? [opts.workerDomain] : [] });
    return this;
  }
  repo(full: string, opts: { push?: boolean; protectedReviews?: boolean; branch?: string; files?: Record<string, string> } = {}) {
    this.repos.set(full, { full, push: opts.push ?? true, protectedReviews: opts.protectedReviews ?? false, branches: { [opts.branch ?? "main"]: { sha: sha(), files: { ...(opts.files ?? {}) } } }, pulls: [] });
    return this;
  }
  vercel(p: Omit<VProject, "deployments">) { this.vprojects.push({ ...p, deployments: [] }); return this; }
  pages(p: Omit<PProject, "deployments">) { this.pprojects.push({ ...p, deployments: [] }); return this; }

  // ── The websites ──
  private effective(host: string, path: string): { allow: boolean; xfo: string | null; csp: string[] } {
    const s = this.sites.get(host)!;
    let xfo: string | null = s.baseXfo === undefined ? "DENY" : s.baseXfo;
    const csp = s.baseCsp ? [s.baseCsp] : [];
    const sensitive = /\/(login|admin|book|account|checkout)/.test(path);
    if (sensitive) return { allow: false, xfo: "DENY", csp: ["frame-ancestors 'none'"] };
    // Cloudflare zone rule (Crestmont's): applied to responses when the site is proxied by the zone.
    const zone = this.zones.find((z) => host === z.name || host.endsWith("." + z.name));
    for (const r of zone?.rulesets?.rules ?? []) {
      const m = /http\.host eq "([^"]+)" and http\.request\.uri\.path in \{([^}]*)\}/.exec(r.expression);
      if (!m || m[1] !== host || r.enabled === false || s.ruleTakesEffect === false) continue;
      const paths = [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
      if (!paths.includes(path)) continue;
      const h = r.action_parameters.headers;
      if (h["X-Frame-Options"]?.operation === "remove") xfo = null;
      if (h["Content-Security-Policy"]?.operation === "add") csp.push(h["Content-Security-Policy"].value!);
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
    const allow = fa.length ? fa.every((d) => d.split(/\s+/).slice(1).includes("http://crestmont.test")) : !xfo;
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
    if (!/^Bearer (cf|vc|gh)-test-token$/.test(auth)) return json({ errors: [{ message: "Invalid API token" }], message: "Bad credentials" }, 403);
    if (u.host === "api.cloudflare.com") return this.cloudflare(u, method, body);
    if (u.host === "api.vercel.com") return this.vercelApi(u);
    if (u.host === "api.github.com") return this.github(u, method, body);
    return json({}, 404);
  };

  private cloudflare(u: URL, method: string, body: { rules?: Rule[] } & Rule | null): Response {
    const p = u.pathname.replace("/client/v4", "");
    let m: RegExpExecArray | null;
    if (p === "/accounts") return json({ result: [...new Set([...this.zones.map((z) => z.account), ...this.pprojects.map((x) => x.account)])].map((id) => ({ id })) });
    if (p === "/zones") { const z = this.zones.filter((x) => x.name === u.searchParams.get("name")); return json({ success: true, result: z.map((x) => ({ id: x.id, name: x.name, status: "active", account: { id: x.account } })) }); }
    if ((m = /^\/zones\/([^/]+)\/dns_records$/.exec(p))) { const z = this.zones.find((x) => x.id === m![1]); return json({ result: (z?.dns ?? []).filter((r) => r.name === u.searchParams.get("name")) }); }
    if ((m = /^\/accounts\/([^/]+)\/workers\/domains$/.exec(p))) return json({ result: this.zones.filter((z) => z.account === m![1]).flatMap((z) => z.workerDomains).filter((d) => d.hostname === u.searchParams.get("hostname")) });
    if ((m = /^\/zones\/([^/]+)\/workers\/routes$/.exec(p))) return json({ result: [] });
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

  private github(u: URL, method: string, body: Record<string, unknown> | null): Response {
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(u.pathname);
    const r = m ? this.repos.get(m[1]) : undefined;
    if (!r) return json({ message: "Not Found" }, 404);
    const rest = m![2] ?? "";
    let x: RegExpExecArray | null;
    if (!rest) return json({ full_name: r.full, default_branch: "main", archived: false, permissions: { push: r.push, pull: true } });
    if ((x = /^\/branches\/([^/]+)$/.exec(rest))) return r.branches[decodeURIComponent(x[1])] ? json({ name: x[1], protected: r.protectedReviews }) : json({}, 404);
    if ((x = /^\/branches\/([^/]+)\/protection$/.exec(rest))) return r.protectedReviews ? json({ required_pull_request_reviews: { required_approving_review_count: 1 } }) : json({}, 404);
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
    if (rest === "/pulls" && method === "POST") { const n = r.pulls.length + 1; r.pulls.push({ number: n, head: String(body!.head), base: String(body!.base), state: "open", merged: false, merge_commit_sha: null, title: String(body!.title) }); return json({ number: n, html_url: `https://github.com/${r.full}/pull/${n}` }, 201); }
    if ((x = /^\/pulls\/(\d+)$/.exec(rest))) {
      const pr = r.pulls.find((p) => p.number === Number(x![1]));
      if (!pr) return json({}, 404);
      if (r.closeNextPr && pr.state === "open") { pr.state = "closed"; r.closeNextPr = false; }
      return json({ state: pr.state, merged: pr.merged, merge_commit_sha: pr.merge_commit_sha, mergeable: true, mergeable_state: r.protectedReviews ? "blocked" : "clean", html_url: `https://github.com/${r.full}/pull/${pr.number}` });
    }
    if ((x = /^\/pulls\/(\d+)\/merge$/.exec(rest)) && method === "PUT") {
      const pr = r.pulls.find((p) => p.number === Number(x![1]))!;
      if (r.protectedReviews) return json({ message: "At least 1 approving review is required" }, 405);
      this.merge(r, pr);
      return json({ merged: true, sha: pr.merge_commit_sha });
    }
    return json({ message: `unhandled ${rest}` }, 404);
  }
}

/** A website's homepage: content, links (public and sensitive), and optionally a WebGL scene or broken script. */
export function homepage(title: string, opts: { links?: string[]; webgl?: "ok" | "fail"; brokenJs?: boolean } = {}): string {
  const links = (opts.links ?? ["/services", "/about", "/login", "/book"]).map((h) => `<a href="${h}">${h.slice(1)}</a>`).join(" ");
  const gl = opts.webgl === "ok"
    ? `<canvas id="globe" width="480" height="480" style="width:min(480px,100%);aspect-ratio:1;display:block"></canvas><script>(function(){var c=document.getElementById("globe");var g=c.getContext("webgl");if(!g)return;var t=0;function f(){t+=0.03;g.clearColor(0.05,0.1+0.4*Math.abs(Math.sin(t)),0.6,1);g.clear(g.COLOR_BUFFER_BIT);g.enable(g.SCISSOR_TEST);g.scissor(120+60*Math.sin(t),120,240,240);g.clearColor(0.2,0.8,0.3,1);g.clear(g.COLOR_BUFFER_BIT);g.disable(g.SCISSOR_TEST);requestAnimationFrame(f);}requestAnimationFrame(f);})();</script>`
    : opts.webgl === "fail" ? `<canvas id="globe" width="480" height="480" style="width:min(480px,100%);aspect-ratio:1;display:block"></canvas><script>/* the scene fails to initialise: nothing is ever drawn */</script>` : "";
  const body = opts.brokenJs
    ? `<div id="app"></div><script>throw new Error("bundle failed to load")</script>`
    : `<header><nav>${links}</nav></header><main><h1>${title}</h1><p>${title} is a TEST DATA website used to verify Crestmont's native portfolio onboarding. It has real paragraphs of content.</p>${gl}${"<section><h2>Section</h2><p>More TEST DATA content so the page can be scrolled by a visitor.</p></section>".repeat(25)}</main>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="${title} is a TEST DATA website."></head><body style="margin:0;font:16px sans-serif">${body}</body></html>`;
}
export const page = (title: string) => `<!doctype html><title>${title}</title><h1>${title}</h1><p>TEST DATA.</p>`;
