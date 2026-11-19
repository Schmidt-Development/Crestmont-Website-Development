// Native readiness automation (Owner, 2026-11-18: "When I add a website I own … Crestmont should automatically use its
// authorized hosting and repository integrations to make that website native-compatible, verify it, and display the
// actual live production website."). One step of the state machine per call — on creation, on "Check again", and every
// 15 minutes for entries still in progress — so it never blocks a request for long and always resumes where it was:
//
//   checking ─┬─ site already permits Crestmont ───────────────────────────────► verify ─► native_verified
//             │                                                                      └──► unavailable (exact reason)
//             └─ site refuses ─► discover through the authorized connections
//                    ├─ no connection / not served by a connected account ─────► authorization_required
//                    ├─ Cloudflare zone, proxied ─► one Crestmont transform rule ─► preparing ─► (headers allow) ─► verify
//                    │                                       └ no effect in time ─► rule removed ─► unavailable
//                    ├─ Vercel / Pages linked to GitHub ─► PR in that repository ─► preparing
//                    │        ├─ branch needs review ─► authorization_required (merge the PR) ─► merged ─► deploy
//                    │        └─ unprotected ─► merged by Crestmont ─► provider deploys ─► (headers allow) ─► verify
//                    │        (the site's own CSP sets frame-ancestors: the rule replaces only that directive,
//                    │         and only while the site sends exactly the policy Crestmont read)
//                    └─ the site's own CSP sets frame-ancestors elsewhere, or an unsupported setup ─► unavailable (why)
//
// Nothing here publishes: publishing keeps every existing requirement (relationship, link, the owner's consent) and only
// additionally needs native_verified. Sensitive pages are never opened: only public paths are ever changed, and the
// verification confirms the sensitive pages the homepage links to still refuse framing.
import type { Db } from "../../lib/db.ts";
import { nowIso } from "../../lib/db.ts";
import { checkEmbed, evaluateFraming, safePublicUrl, type EmbedCheck } from "../embed-check.ts";
import { allowEgressHost, untrustedHostAllowed } from "../../lib/egress.ts";
import * as pf from "../portfolio.ts";
import { issuePreviewToken } from "../remote-browser/connect.ts";
import { anyConnection, connectionSummary, ProviderError, type NativeConnections } from "./connections.ts";
import { applyCloudflareRule, discoverCloudflare, pagesDeployment, removeCloudflareRule, rewriteFrameAncestors, type CloudflareTarget } from "./cloudflare.ts";
import { discoverVercel, vercelDeployment, type VercelTarget } from "./vercel.ts";
import { advancePr, proposeChange, readFile, repoAccess, type ProposedChange } from "./github.ts";
import { editPagesHeaders, editVercelJson, EditError } from "./editors.ts";
import { frameAncestorDirectives, frameAncestorsValue, publicPaths, sensitiveLinks } from "./standard.ts";
import { verifyNative, type FixtureResponder, type OpenBrowser, type VerifyResult } from "./verify.ts";

export interface NativeDeps {
  db: Db; siteOrigin: string; fetchSite: typeof fetch; fetchApi: typeof fetch; conn: NativeConnections;
  openBrowser: OpenBrowser | null; fixture?: FixtureResponder; verifyDailyCap: number; remoteEnabled: boolean; now?: () => number;
  verify?: (pageUrl: string, liveOrigin: string) => Promise<VerifyResult>;
}
type Target = CloudflareTarget | VercelTarget;
type Change =
  | { kind: "cloudflare-rule"; zoneId: string; rulesetId: string; ruleId: string; ref: string; host: string; paths: number; appliedAt: string; action: string; rewrite?: boolean }
  | { kind: "github-pr"; provider: "vercel" | "cloudflare-pages"; pr: ProposedChange; deployDetail?: string }
  /** A change that did not work (a rule without effect, a PR closed unmerged). Never retried on its own: only an
   *  explicit staff re-check starts over, so Crestmont does not reapply rules or reopen PRs in a loop. */
  | { kind: "failed"; what: "cloudflare-rule" | "github-pr"; detail: string; at: string };
export interface Outcome { state: pf.NativeState; reason: string; verification?: VerifyResult }

const RULE_GRACE_MS = 10 * 60_000;
const VERIFIED_FRESH_MS = 7 * 86_400_000;
const parse = <T>(s: string | null | undefined): T | null => { try { return s ? (JSON.parse(s) as T) : null; } catch { return null; } };

async function save(db: Db, id: string, prev: pf.PortfolioProject, o: { state: pf.NativeState; reason: string; provider?: string | null; target?: unknown; change?: unknown; verification?: VerifyResult | null }, actorUserId: string | null) {
  const at = nowIso();
  const sets = ["native_state = ?", "native_reason = ?", "native_updated_at = ?"], vals: unknown[] = [o.state, o.reason.slice(0, 1000), at];
  if (o.provider !== undefined) { sets.push("native_provider = ?"); vals.push(o.provider); }
  if (o.target !== undefined) { sets.push("native_target = ?"); vals.push(o.target === null ? null : JSON.stringify(o.target)); }
  if (o.change !== undefined) { sets.push("native_change = ?"); vals.push(o.change === null ? null : JSON.stringify(o.change)); }
  if (o.verification) { sets.push("native_verification = ?"); vals.push(JSON.stringify(o.verification).slice(0, 8000)); if (o.verification.ok) { sets.push("native_verified_at = ?"); vals.push(o.verification.at); } }
  const stmts = [db.prepare(`UPDATE portfolio_projects SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id)];
  if (prev.native_state !== o.state || o.verification) stmts.push(db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, ip, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(actorUserId, actorUserId ? "user" : "system", o.verification ? "portfolio.native_verification" : "portfolio.native_state", "portfolio_project", id, JSON.stringify({ from: prev.native_state, to: o.state, reason: o.reason.slice(0, 300), ...(o.verification ? { ok: o.verification.ok, checks: o.verification.checks.map((c) => `${c.name}:${c.ok ? "ok" : "fail"}`) } : {}) }), null, at));
  await db.batch(stmts);
}

async function verificationsToday(db: Db, now: number): Promise<number> {
  const since = new Date(now - 86_400_000).toISOString();
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'portfolio.native_verification' AND created_at >= ?`).bind(since).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Sensitive pages the homepage links to must still refuse framing (read from their own headers, like a visitor). */
async function sensitiveStillProtected(d: NativeDeps, check: EmbedCheck): Promise<{ ok: boolean; detail: string }> {
  if (!check.url || !check.html) return { ok: true, detail: "no sensitive links to check" };
  const paths = sensitiveLinks(check.url, check.html);
  if (!paths.length) return { ok: true, detail: "The homepage links to no sensitive pages" };
  const bad: string[] = [], good: string[] = [];
  for (const path of paths.slice(0, 8)) {
    const u = new URL(path, check.url);
    if (!untrustedHostAllowed(u.hostname)) continue;
    const release = allowEgressHost(u.hostname);
    try {
      const r = await d.fetchSite(u.toString(), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { accept: "text/html" } });
      await r.body?.cancel().catch(() => undefined);
      if (r.status >= 300 && r.status < 400) { good.push(`${path} (redirects)`); continue; }
      if (evaluateFraming(r.headers, u, d.siteOrigin).allowed && r.status < 400) bad.push(path); else good.push(path);
    } catch { good.push(`${path} (no answer)`); } finally { release(); }
  }
  return bad.length ? { ok: false, detail: `Sensitive page(s) ${bad.join(", ")} permit framing by Crestmont — they must refuse it (frame-ancestors 'none', X-Frame-Options: DENY) before this site is shown` } : { ok: true, detail: `Sensitive pages still refuse framing: ${good.join(", ")}` };
}

async function runVerification(d: NativeDeps, p: pf.PortfolioProject, check: EmbedCheck, now: number): Promise<VerifyResult | string> {
  if (!d.openBrowser && !d.verify) return "No verification browser is available in this environment (Browser Run binding missing)";
  if ((await verificationsToday(d.db, now)) >= d.verifyDailyCap) return `Today's real-browser verifications (${d.verifyDailyCap}) are used up; it runs again automatically within a day`;
  const token = await issuePreviewToken(d.db, p.id, 10, "native-verify", now);
  const pageUrl = `${d.siteOrigin}/portfolio/native-verify/${token}`;
  const res = d.verify ? await d.verify(pageUrl, check.origin!) : await verifyNative(d.openBrowser!, pageUrl, check.origin!, { fixture: d.fixture });
  const sens = await sensitiveStillProtected(d, check);
  res.checks.push({ name: "protected pages", ok: sens.ok, detail: sens.detail });
  if (!sens.ok) { res.ok = false; res.summary = `${res.summary.startsWith("Verified") ? "" : res.summary + " · "}protected pages: ${sens.detail}`; }
  return res;
}

/** Advances one project's native readiness by one step. */
export async function advanceNative(d: NativeDeps, id: string, opts: { force?: boolean; actorUserId?: string | null } = {}): Promise<Outcome> {
  const now = d.now?.() ?? Date.now();
  const p = await pf.getById(d.db, id);
  if (!p) return { state: "unavailable", reason: "Project not found" };
  if (!p.native_required) return { state: "legacy", reason: "Existing entry (shown as before)" };
  const actor = opts.actorUserId ?? null;
  const done = async (o: Outcome & { provider?: string | null; target?: unknown; change?: unknown }) => { await save(d.db, id, p, { ...o, verification: o.verification ?? null }, actor); return o; };

  const check = await checkEmbed(p.live_url, d.siteOrigin, d.fetchSite);
  await pf.recordEmbedCheck(d.db, id, check, actor, d.remoteEnabled);
  if (!safePublicUrl(p.live_url)) return done({ state: "unavailable", reason: "The live link is not a public https:// address" });
  let change = parse<Change>(p.native_change);
  if (change?.kind === "failed" && opts.force) change = null;

  if (check.status === "allowed") {
    const fresh = p.native_state === "native_verified" && p.native_verified_at && now - Date.parse(p.native_verified_at) < VERIFIED_FRESH_MS && p.embed_url === check.url;
    if (fresh && !opts.force) return { state: "native_verified", reason: p.native_reason ?? "Verified" };
    const v = await runVerification(d, p, check, now);
    if (typeof v === "string") return done({ state: p.native_state === "native_verified" ? "native_verified" : "checking", reason: `The site permits Crestmont's frame (${check.detail}); ${v}.` });
    return done(v.ok
      ? { state: "native_verified", reason: `${v.summary}. ${change ? describeChange(change) : "The site already permitted Crestmont's frame."}`, verification: v }
      : { state: "unavailable", reason: `The site permits Crestmont's frame, but the real-browser check failed — ${v.summary}`, verification: v });
  }
  if (check.status === "error") {
    // A site that does not answer while its own deployment runs stays in preparation; otherwise say exactly why.
    if (p.native_state === "preparing" && change) return done({ state: "preparing", reason: `${describeChange(change)} The site did not answer the last check (${check.detail}); trying again.` });
    return done({ state: "unavailable", reason: `The live site could not be checked: ${check.detail}.` });
  }

  // ── The site refuses framing ──
  if (change?.kind === "failed") return done({ state: "unavailable", reason: `${change.detail} Use "Check again" to start over.` });
  if (change) return followChange(d, p, check, change, now, done);
  if (!anyConnection(d.conn)) return done({ state: "authorization_required", reason: `${check.detail}. ${connectionSummary(d.conn)}: connect the Cloudflare, Vercel and/or GitHub account that hosts this website (Worker secrets PORTFOLIO_CLOUDFLARE_TOKEN, PORTFOLIO_VERCEL_TOKEN, PORTFOLIO_GITHUB_TOKEN) so Crestmont can prepare it. Crestmont never changes a site it cannot prove you control.` });
  const host = new URL(check.url!).hostname;
  const ownCsp = frameAncestorDirectives(check.csp ?? null);
  const conflict = ownCsp.length ? `The site's own Content-Security-Policy sets "${ownCsp.join("; ")}" on its public pages, which a second policy cannot override` : null;
  const paths = publicPaths(check.url!, check.html ?? "");
  const notes: string[] = [];
  try {
    let cf: CloudflareTarget | null = null, vc: VercelTarget | null = null;
    if (d.conn.cloudflare) { const r = await discoverCloudflare(d.fetchApi, d.conn.cloudflare, host); cf = r.target; notes.push(`Cloudflare: ${r.detail}`); }
    if (d.conn.vercel) { const r = await discoverVercel(d.fetchApi, d.conn.vercel, host); vc = r.target; notes.push(`Vercel: ${r.detail}`); }
    if (!cf && !vc) return done({ state: "authorization_required", reason: `${check.detail}. ${host} is not served by any connected account (${notes.join("; ")}). If you own it, connect the account that hosts it; Crestmont does not change websites it cannot prove you control.`, provider: null, target: null });

    // 1. A proxied Cloudflare zone: Cloudflare's own header rule, no code change, instant, reversible. When the site's
    //    own policy sets frame-ancestors, the rule replaces only that directive — if the policy is one stable header.
    let rewrite: string | null = null, rewriteWhy: string | null = null;
    if (cf?.ruleCapable && conflict) {
      const rw = rewriteFrameAncestors(check.csp ?? "", frameAncestorsValue(d.siteOrigin));
      if (!rw.ok) rewriteWhy = rw.why;
      else {
        const again = await siteCsp(d, check.url!);
        if (again !== rw.observed) rewriteWhy = "the site's Content-Security-Policy changes between requests (for example a per-request nonce), so a rule cannot match it exactly";
        else rewrite = rw.observed;
      }
    }
    if (cf?.ruleCapable && (!conflict || rewrite)) {
      const r = await applyCloudflareRule(d.fetchApi, d.conn.cloudflare!, cf, host, paths, frameAncestorsValue(d.siteOrigin), rewrite);
      const ch: Change = { kind: "cloudflare-rule", zoneId: cf.zoneId, rulesetId: r.rulesetId, ruleId: r.ruleId, ref: r.ref, host, paths: r.paths, appliedAt: nowIso(), action: r.action, ...(rewrite ? { rewrite: true } : {}) };
      return done({ state: "preparing", reason: `${describeChange(ch)} Waiting for the site's public pages to answer with the new header.`, provider: `cloudflare-zone (${cf.serving})`, target: cf, change: ch });
    }
    // 2. A Git-linked Vercel or Pages project: the change goes through that repository.
    const repoTarget = vc?.repo ? { provider: "vercel" as const, repo: vc.repo, branch: vc.branch } : cf?.pages?.repo ? { provider: "cloudflare-pages" as const, repo: cf.pages.repo, branch: cf.pages.branch ?? "main" } : null;
    if (conflict) return done({ state: "unavailable", reason: `${conflict}${rewriteWhy ? `, and Crestmont's Cloudflare rule cannot replace just that directive: ${rewriteWhy}` : ""}. That header comes from the site's own code, so it has to be changed there (only public pages may allow ${new URL(d.siteOrigin).host}); automatic preparation is not attempted. ${notes.join("; ")}.`, provider: vc ? "vercel" : "cloudflare", target: vc ?? cf });
    if (!repoTarget) return done({ state: "unavailable", reason: `${notes.join("; ")}. The project is not linked to a GitHub repository (and is not proxied by a connected Cloudflare zone), so Crestmont has no supported way to change its headers.`, provider: vc ? "vercel" : "cloudflare", target: vc ?? cf });
    if (!d.conn.github) return done({ state: "authorization_required", reason: `${notes.join("; ")}. Connect GitHub (PORTFOLIO_GITHUB_TOKEN) with access to ${repoTarget.repo} so Crestmont can propose the header change there.`, provider: repoTarget.provider, target: vc ?? cf });
    const access = await repoAccess(d.fetchApi, d.conn.github, repoTarget.repo, repoTarget.branch);
    if (!access.ok) return done({ state: "authorization_required", reason: `${access.detail}.`, provider: repoTarget.provider, target: vc ?? cf });
    const file = await headerFile(d, repoTarget.provider, vc, cf, repoTarget.repo, repoTarget.branch);
    if (typeof file === "string") return done({ state: "unavailable", reason: `${file}. ${notes.join("; ")}.`, provider: repoTarget.provider, target: vc ?? cf });
    const content = repoTarget.provider === "vercel" ? editVercelJson(file.text, paths, frameAncestorsValue(d.siteOrigin)) : editPagesHeaders(file.text, paths, frameAncestorsValue(d.siteOrigin));
    const title = "Allow Crestmont's portfolio to show the public pages natively";
    const body = `Crestmont Website Development shows this website in its portfolio as the real, live site in a native frame.\n\nThis change lets **only these public, read-only pages** be framed by ${frameAncestorsValue(d.siteOrigin).replace("frame-ancestors ", "")}:\n\n${paths.map((x) => `- \`${x}\``).join("\n")}\n\nIt adds \`Content-Security-Policy: ${frameAncestorsValue(d.siteOrigin)}\` on those paths only${repoTarget.provider === "cloudflare-pages" ? " and detaches `X-Frame-Options` there" : ""}. Sign-in, accounts, booking, checkout, payment, API and every other page are not listed and keep refusing framing. No other header, rule or file is changed.\n\nProposed automatically by Crestmont's portfolio onboarding for ${host}.`;
    const pr = await proposeChange(d.fetchApi, d.conn.github, repoTarget.repo, repoTarget.branch, file.path, content, title, body, !!access.protectedReviews);
    const ch: Change = { kind: "github-pr", provider: repoTarget.provider, pr };
    return followChange(d, { ...p, native_state: "preparing", native_target: JSON.stringify(vc ?? cf) }, check, ch, now, (o) => done({ ...o, provider: repoTarget.provider, target: vc ?? cf, change: ch }));
  } catch (e) {
    const msg = e instanceof ProviderError || e instanceof EditError ? e.message : `Unexpected error: ${(e as Error).message}`;
    const auth = e instanceof ProviderError && (e.status === 401 || e.status === 403);
    return done({ state: auth ? "authorization_required" : "unavailable", reason: `${auth ? "A connected account refused this action — its token lacks a permission: " : ""}${msg}`.slice(0, 900) });
  }
}

/** The homepage's Content-Security-Policy read once more (to tell a fixed policy from a per-request one). */
async function siteCsp(d: NativeDeps, url: string): Promise<string | null> {
  const u = new URL(url);
  if (!untrustedHostAllowed(u.hostname)) return null;
  const release = allowEgressHost(u.hostname);
  try {
    const r = await d.fetchSite(u.toString(), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { accept: "text/html" } });
    await r.body?.cancel().catch(() => undefined);
    return r.headers.get("content-security-policy");
  } catch { return null; } finally { release(); }
}

async function headerFile(d: NativeDeps, provider: "vercel" | "cloudflare-pages", vc: VercelTarget | null, cf: CloudflareTarget | null, repo: string, branch: string): Promise<{ path: string; text: string | null } | string> {
  const join = (...xs: string[]) => xs.map((x) => x.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  if (provider === "vercel") { const path = join(vc?.rootDirectory ?? "", "vercel.json"); return { path, text: (await readFile(d.fetchApi, d.conn.github!, repo, path, branch))?.text ?? null }; }
  const pg = cf!.pages!;
  if (!pg.buildCommand.trim()) { const path = join(pg.root, pg.destination, "_headers"); return { path, text: (await readFile(d.fetchApi, d.conn.github!, repo, path, branch))?.text ?? null }; }
  // With a build step, _headers must come from the folder the build copies as-is; only an existing one is edited.
  for (const c of [join(pg.root, "public", "_headers"), join(pg.root, "static", "_headers"), join(pg.root, pg.destination, "_headers")]) {
    const f = await readFile(d.fetchApi, d.conn.github!, repo, c, branch);
    if (f) return { path: c, text: f.text };
  }
  return `The Pages project builds with "${pg.buildCommand}" and has no existing _headers file, so Crestmont cannot tell which folder its build publishes unchanged`;
}

function describeChange(c: Change): string {
  if (c.kind === "failed") return c.detail;
  if (c.kind === "cloudflare-rule") return `Crestmont ${c.action === "unchanged" ? "confirmed" : c.action} its Cloudflare response-header rule for ${c.host} (${c.paths} public paths${c.rewrite ? "; only the frame-ancestors directive of the site's own policy is replaced, every other directive is kept" : ""}; sensitive pages untouched).`;
  return `Header change proposed in ${c.pr.repo} (${c.pr.path}): ${c.pr.url}.`;
}

async function followChange(d: NativeDeps, p: pf.PortfolioProject, check: EmbedCheck, ch: Exclude<Change, { kind: "failed" }>, now: number, done: (o: Outcome & { change?: unknown }) => Promise<Outcome>): Promise<Outcome> {
  if (ch.kind === "cloudflare-rule") {
    if (now - Date.parse(ch.appliedAt) < RULE_GRACE_MS) return done({ state: "preparing", reason: `${describeChange(ch)} Waiting for the site's public pages to answer with the new header (${check.detail}).` });
    // The rule did not take effect (e.g. the origin's response is served in a way zone rules do not rewrite): remove it.
    const cf = parse<CloudflareTarget>(p.native_target);
    if (cf && d.conn.cloudflare) await removeCloudflareRule(d.fetchApi, d.conn.cloudflare, cf, ch.host).catch(() => false);
    const why = `Crestmont's Cloudflare rule for ${ch.host} did not take effect within 10 minutes (the site still answers: ${check.detail}), so it was removed again. The header has to be set where the site's responses are produced.`;
    return done({ state: "unavailable", reason: why, change: { kind: "failed", what: "cloudflare-rule", detail: why, at: nowIso() } satisfies Change });
  }
  if (!d.conn.github) return done({ state: "authorization_required", reason: `GitHub is no longer connected; ${describeChange(ch)}` });
  const pr = await advancePr(d.fetchApi, d.conn.github, ch.pr);
  const next: Change = { ...ch, pr };
  if (pr.closed) return done({ state: "unavailable", reason: `${pr.detail}. Crestmont does not reopen it by itself.`, change: { kind: "failed", what: "github-pr", detail: `${pr.detail}.`, at: nowIso() } satisfies Change });
  if (!pr.merged) return done({ state: pr.needsApproval ? "authorization_required" : "preparing", reason: pr.detail, change: next });
  // Merged: the provider deploys it through its own Git integration.
  const t = parse<Target>(p.native_target);
  let dep: { state: string; detail: string } = { state: "building", detail: "waiting for the deployment" };
  if (ch.provider === "vercel" && t?.kind === "vercel" && d.conn.vercel) dep = await vercelDeployment(d.fetchApi, d.conn.vercel, t, pr.mergeSha);
  else if (ch.provider === "cloudflare-pages" && t?.kind === "cloudflare" && d.conn.cloudflare) { const r = await pagesDeployment(d.fetchApi, d.conn.cloudflare, t); dep = { state: r.commit && pr.mergeSha && r.commit !== pr.mergeSha ? "building" : r.state, detail: r.detail }; }
  next.deployDetail = dep.detail;
  if (dep.state === "failed") return done({ state: "unavailable", reason: `The deployment of ${pr.url} failed (${dep.detail}). Fix the deployment; Crestmont re-checks automatically.`, change: next });
  if (dep.state !== "ready") return done({ state: "preparing", reason: `Merged ${pr.url}; ${dep.detail}.`, change: next });
  return done({ state: "preparing", reason: `Deployed (${dep.detail}), but the site still answers: ${check.detail}. Re-checking; if it persists, another layer of the site sets this header.`, change: next });
}

/** The 15-minute job: entries in progress every time; settled ones (waiting for authorization, unavailable) at most
 *  every 6 hours, so a missing permission or a fixed deployment is noticed without re-verifying in a loop. Bounded. */
export async function advanceAllNative(d: NativeDeps, limit = 10): Promise<{ slug: string; state: string }[]> {
  const settledBefore = new Date((d.now?.() ?? Date.now()) - 6 * 3_600_000).toISOString();
  const rows = (await d.db.prepare(`SELECT id, slug FROM portfolio_projects WHERE native_required = 1 AND archived_at IS NULL AND (native_state IN ('checking', 'preparing') OR (native_state IN ('authorization_required', 'unavailable') AND COALESCE(native_updated_at, '') < ?)) ORDER BY COALESCE(native_updated_at, '') LIMIT ?`).bind(settledBefore, limit).all<{ id: string; slug: string }>()).results;
  const out: { slug: string; state: string }[] = [];
  for (const r of rows) { try { out.push({ slug: r.slug, state: (await advanceNative(d, r.id)).state }); } catch (e) { out.push({ slug: r.slug, state: `error: ${(e as Error).message}`.slice(0, 80) }); } }
  return out;
}

/** Step 2 of the Add flow (read-only): which connected account serves the site, before anything is created. */
export async function discoverHosting(d: NativeDeps, host: string): Promise<{ found: boolean; detail: string }> {
  if (!anyConnection(d.conn)) return { found: false, detail: `${connectionSummary(d.conn)} — Crestmont cannot prepare this site until the account that hosts it is connected` };
  const notes: string[] = [];
  let found = false;
  try {
    if (d.conn.cloudflare) { const r = await discoverCloudflare(d.fetchApi, d.conn.cloudflare, host); found ||= !!r.target; notes.push(`Cloudflare: ${r.detail}`); }
    if (d.conn.vercel) { const r = await discoverVercel(d.fetchApi, d.conn.vercel, host); found ||= !!r.target; notes.push(`Vercel: ${r.detail}`); }
  } catch (e) { notes.push((e as Error).message); }
  if (!d.conn.cloudflare && !d.conn.vercel) notes.push("Only GitHub is connected; a hosting account (Cloudflare or Vercel) is needed to find the site");
  return { found, detail: notes.join("; ") };
}

// ── Operations (src/routes/ops.ts /api/ops/portfolio-native; .github/workflows/portfolio-native-ops.yml) ──
const SYSTEM_OWNER = { kind: "system" as const, roles: [{ role: "owner" as const, organizationId: "org_crestmont" }], mfaVerified: true };
const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
const siteKey = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

/** Read-only: what each address answers and which connected account serves it. Nothing is created or changed. */
export async function discoverForOps(d: NativeDeps, urls: string[]): Promise<{ url: string; status: string; detail: string; finalUrl: string | null; hosting: { found: boolean; detail: string } | null }[]> {
  const out = [];
  for (const raw of urls.slice(0, 12)) {
    const u = safePublicUrl(raw);
    if (!u) { out.push({ url: raw.slice(0, 200), status: "invalid", detail: "not a public https address", finalUrl: null, hosting: null }); continue; }
    const c = await checkEmbed(u.toString(), d.siteOrigin, d.fetchSite);
    const host = c.url ? new URL(c.url).hostname : u.hostname;
    out.push({ url: u.toString(), status: c.status, detail: c.detail, finalUrl: c.url, hosting: await discoverHosting(d, host) });
  }
  return out;
}

export interface OpsProject { slug: string; id: string; state: string; reason: string; provider: string | null; change: unknown; verification: unknown; embed: string | null; published: boolean; created: boolean; converted: boolean }
async function summary(d: NativeDeps, id: string, created = false, converted = false): Promise<OpsProject> {
  const p = (await pf.getById(d.db, id))!;
  return { slug: p.slug, id, state: p.native_state ?? "checking", reason: p.native_reason ?? "", provider: p.native_provider ?? null, change: parse(p.native_change), verification: parse(p.native_verification), embed: p.embed_status ?? null, published: !!p.published, created, converted };
}

/** The controlled onboarding of one owned website, exactly as Staff → Portfolio → Add (unpublished; nothing is
 *  published or recorded as consent). An existing unpublished acceptance entry for the same site (never published,
 *  relationship pending) is converted to a native-required entry instead of being duplicated. */
export async function onboardForOps(d: NativeDeps, raw: string): Promise<OpsProject | { error: string }> {
  const u = safePublicUrl(raw);
  if (!u) return { error: "url: a public https address" };
  const site = siteKey(u.toString());
  const existing = (await pf.listActive(d.db)).find((p) => siteKey(p.live_url) === site);
  if (existing?.published && !existing.native_required) return { error: `${site} is a published existing entry (${existing.slug}); it is not converted by an operations request` };
  let id: string, created = false, converted = false;
  if (existing) {
    id = existing.id;
    if (!existing.native_required) {
      if (!/pending/i.test(existing.relationship)) return { error: `${site} has an existing entry (${existing.slug}) with documented details; convert it from Staff → Portfolio instead` };
      await d.db.batch([
        d.db.prepare(`UPDATE portfolio_projects SET native_required = 1, native_state = 'checking', native_reason = NULL, native_change = NULL, updated_at = ? WHERE id = ?`).bind(nowIso(), id),
        d.db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, ip, created_at) VALUES (NULL,'system','portfolio.native_onboarding','portfolio_project',?,?,NULL,?)`).bind(id, JSON.stringify({ converted: true, from: "acceptance entry" }), nowIso()),
      ]);
      converted = true;
    }
  } else {
    const c = await checkEmbed(u.toString(), d.siteOrigin, d.fetchSite);
    const name = ((c.siteName ?? c.title?.split(/\s+[—–|·-]\s+/)[0] ?? "").trim() || site).slice(0, 120);
    let slug = slugify(name) || slugify(site);
    for (let n = 2; await pf.getBySlug(d.db, slug); n++) slug = `${slugify(name) || slugify(site)}-${n}`;
    const description = (c.description ?? "").trim().length >= 20 ? c.description!.trim().slice(0, 4000) : `${name} — the live website at ${site}. Added for native onboarding; details to be confirmed by staff before publishing.`;
    ({ id } = await pf.createProject(d.db, SYSTEM_OWNER, { name, slug, industry: "To be confirmed by staff", live_url: c.url ?? u.toString(), description, features: "", technology_summary: "", relationship: "Relationship documentation pending" }));
    created = true;
  }
  await advanceNative(d, id, { force: true });
  return summary(d, id, created, converted);
}

/** One more step for an entry (the same step the 15-minute job runs). */
export async function advanceForOps(d: NativeDeps, slug: string): Promise<OpsProject | { error: string }> {
  const p = await pf.getBySlug(d.db, slug);
  if (!p || p.archived_at) return { error: "unknown project" };
  if (!p.native_required) return { error: `${slug} is an existing (legacy) entry` };
  await advanceNative(d, p.id);
  return summary(d, p.id);
}
