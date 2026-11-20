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
import { allConns, anyConnection, connectionSummary, githubReady, ProviderError, type NativeConnections } from "./connections.ts";
import { applyCloudflareRule, discoverCloudflare, pagesDeployment, removeCloudflareRule, rewriteFrameAncestors, type CloudflareTarget } from "./cloudflare.ts";
import { discoverVercel, vercelDeployment, type VercelTarget } from "./vercel.ts";
import { advancePr, proposeChange, readFile, repoAccess, type ProposedChange } from "./github.ts";
import { editPagesHeaders, editVercelJson, EditError } from "./editors.ts";
import { frameAncestorDirectives, frameAncestorsValue, publicPaths, sensitiveLinks } from "./standard.ts";
import { VERIFIER_VERSION, verifyNative, type FixtureResponder, type OpenBrowser, type ShotSink, type VerifyResult } from "./verify.ts";
import type { StorageAdapter } from "../../adapters/storage.ts";
import { codesFor, diagnose, type DiagCode } from "./diagnostics.ts";

export interface NativeDeps {
  db: Db; siteOrigin: string; fetchSite: typeof fetch; fetchApi: typeof fetch; conn: NativeConnections;
  openBrowser: OpenBrowser | null; fixture?: FixtureResponder; verifyDailyCap: number; remoteEnabled: boolean; now?: () => number;
  /** An Owner-approved run (a release or the operations workflow) may use three times the automatic daily allowance,
   *  so a release that converts many entries finishes them instead of leaving some for tomorrow. */
  ownerApproved?: boolean;
  verify?: (pageUrl: string, liveOrigin: string) => Promise<VerifyResult>;
  /** First-time verifications (entries never verified: new onboarding) have their own daily allowance, so a batch of
   *  new websites is not starved by — and does not starve — the daily re-checks of verified ones. */
  onboardDailyCap?: number;
  /** Real-browser verifications run side by side within one round (each its own browser session). */
  concurrency?: number;
  /** Private storage for visual evidence (screenshots of the direct and embedded views); none → no screenshots. */
  storage?: StorageAdapter | null;
}
type Target = CloudflareTarget | VercelTarget;
type Change =
  | { kind: "cloudflare-rule"; zoneId: string; rulesetId: string; ruleId: string; ref: string; host: string; paths: number; appliedAt: string; action: string; rewrite?: boolean; regressionRepairAt?: string }
  | { kind: "github-pr"; provider: "vercel" | "cloudflare-pages"; pr: ProposedChange; deployDetail?: string; regressionRepairAt?: string }
  /** A change that did not work (a rule without effect, a PR closed unmerged). Never retried on its own: only an
   *  explicit staff re-check starts over, so Crestmont does not reapply rules or reopen PRs in a loop. */
  | { kind: "failed"; what: "cloudflare-rule" | "github-pr"; detail: string; at: string };
export interface Outcome { state: pf.NativeState; reason: string; verification?: VerifyResult }

const RULE_GRACE_MS = 10 * 60_000;
const VERIFIED_FRESH_MS = 7 * 86_400_000;
/** A regression (a verified site that later refuses framing) is repaired automatically at most once a day. */
const REPAIR_INTERVAL_MS = 86_400_000;
const parse = <T>(s: string | null | undefined): T | null => { try { return s ? (JSON.parse(s) as T) : null; } catch { return null; } };
// Multi-account: the connection that discovered a target (its `conn` index) is the one used for it afterwards.
const cfOf = (d: NativeDeps, t?: { conn?: number } | null) => allConns(d.conn, "cloudflare")[t?.conn ?? 0] ?? null;
const vcOf = (d: NativeDeps, t?: { conn?: number } | null) => allConns(d.conn, "vercel")[t?.conn ?? 0] ?? null;
const ghOf = (d: NativeDeps, c?: { conn?: number } | null) => allConns(d.conn, "github")[c?.conn ?? 0] ?? null;
/** Finds the site through every authorized account of a provider, in order; the first that serves it wins. */
async function discoverAll<T extends object>(conns: unknown[], label: string, find: (conn: never) => Promise<{ target: T | null; detail: string }>, notes: string[]): Promise<(T & { conn?: number }) | null> {
  for (let i = 0; i < conns.length; i++) {
    const r = await find(conns[i] as never);
    if (r.target) { notes.push(`${label}${conns.length > 1 ? ` (account ${i + 1})` : ""}: ${r.detail}`); return i ? { ...r.target, conn: i } : r.target; }
    if (i === conns.length - 1) notes.push(`${label}: ${conns.length > 1 ? `none of ${conns.length} accounts serves it — ` : ""}${r.detail}`);
  }
  return null;
}

/** The stored diagnosis of an outcome: codes from the exact reason, plus the verifier's findings (frame vs website). */
export function outcomeDiagnosis(o: { state: pf.NativeState; reason: string; verification?: VerifyResult | null }, at = nowIso()) {
  const codes: DiagCode[] = codesFor(o.state, o.reason);
  const fs = o.verification?.findings ?? [];
  for (const f of fs) if ((f.code as DiagCode) && !codes.includes(f.code as DiagCode) && ["iframe_render_failure", "site_render_defect", "js_module_error", "gpu_limited", "iframe_overhead", "site_slow", "interaction_blocked", "scroll_blocked", "mobile_overflow", "frame_not_loaded", "blank_in_frame", "hydration_failure", "protected_link_in_frame"].includes(f.code)) codes.push(f.code as DiagCode);
  const d = diagnose(codes, [o.reason, ...fs.map((f) => `${f.kind}/${f.code}${f.blocking ? " (blocking)" : ""}: ${f.detail}`)].join("\n"), at);
  // The frame itself fails only when a blocking finding is an embedding one (or the reason says the frame refuses).
  if (fs.length) d.embedFailure = fs.some((f) => f.blocking && f.kind === "embed") || (!o.verification?.ok && !fs.some((f) => f.blocking));
  if (o.state === "native_verified") d.embedFailure = false;
  return d;
}

async function save(db: Db, id: string, prev: pf.PortfolioProject, o: { state: pf.NativeState; reason: string; provider?: string | null; target?: unknown; change?: unknown; verification?: VerifyResult | null }, actorUserId: string | null) {
  const at = nowIso();
  const sets = ["native_state = ?", "native_reason = ?", "native_updated_at = ?", "native_diagnosis = ?"], vals: unknown[] = [o.state, o.reason.slice(0, 1000), at, JSON.stringify(outcomeDiagnosis(o, at)).slice(0, 4000)];
  if (o.verification?.perf) { sets.push("native_perf = ?"); vals.push(JSON.stringify({ at: o.verification.at, ...o.verification.perf }).slice(0, 4000)); }
  if (o.provider !== undefined) { sets.push("native_provider = ?"); vals.push(o.provider); }
  if (o.target !== undefined) { sets.push("native_target = ?"); vals.push(o.target === null ? null : JSON.stringify(o.target)); }
  if (o.change !== undefined) { sets.push("native_change = ?"); vals.push(o.change === null ? null : JSON.stringify(o.change)); }
  if (o.verification) { sets.push("native_verification = ?"); vals.push(JSON.stringify(o.verification).slice(0, 8000)); if (o.verification.ok) { sets.push("native_verified_at = ?"); vals.push(o.verification.at); } }
  const stmts = [db.prepare(`UPDATE portfolio_projects SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id)];
  if (prev.native_state !== o.state || o.verification) stmts.push(db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, ip, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(actorUserId, actorUserId ? "user" : "system", o.verification ? "portfolio.native_verification" : "portfolio.native_state", "portfolio_project", id, JSON.stringify({ from: prev.native_state, to: o.state, reason: o.reason.slice(0, 300), ...(o.verification ? { onboarding: !prev.native_verified_at, ok: o.verification.ok, checks: o.verification.checks.map((c) => `${c.name}:${c.ok ? "ok" : "fail"}`) } : {}) }), null, at));
  await db.batch(stmts);
}

async function verificationsToday(db: Db, now: number, onboarding: boolean): Promise<number> {
  const since = new Date(now - 86_400_000).toISOString();
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'portfolio.native_verification' AND created_at >= ? AND ${onboarding ? "" : "NOT "}COALESCE(details_json, '') LIKE '%"onboarding":true%'`).bind(since).first<{ n: number }>();
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
  const onboarding = !p.native_verified_at;
  const base = onboarding ? (d.onboardDailyCap ?? 120) : d.verifyDailyCap;
  const cap = d.ownerApproved ? base * 3 : base;
  if ((await verificationsToday(d.db, now, onboarding)) >= cap) return `Today's real-browser verifications (${cap}${onboarding ? " for new websites" : ""}) are used up; it runs again automatically within a day`;
  const token = await issuePreviewToken(d.db, p.id, 10, "native-verify", now);
  const pageUrl = `${d.siteOrigin}/portfolio/native-verify/${token}`;
  // Visual evidence: each screenshot is kept privately (staff-only), and only the latest verification's set.
  const store = d.storage ?? null;
  const shot: ShotSink | undefined = store ? async (label, jpeg) => { const key = `portfolio-native-evidence/${p.id}/${now}-${label}.jpg`; await store.put(key, jpeg, "image/jpeg"); return key; } : undefined;
  const res = d.verify ? await d.verify(pageUrl, check.origin!) : await verifyNative(d.openBrowser!, pageUrl, check.origin!, { fixture: d.fixture, liveUrl: check.url ?? undefined, shot });
  if (store && res.shots?.length) {
    let old: { key: string }[] = [];
    try { old = (JSON.parse(p.native_verification ?? "{}").shots ?? []) as { key: string }[]; } catch { old = []; }
    for (const o of old) if (o.key?.startsWith(`portfolio-native-evidence/${p.id}/`) && !res.shots.some((s) => s.key === o.key)) await store.delete(o.key).catch(() => undefined);
  }
  res.verifier = VERIFIER_VERSION;   // the verification this code made (a stale one is repeated: verifiedBy)
  const sens = await sensitiveStillProtected(d, check);
  res.checks.push({ name: "protected pages", ok: sens.ok, detail: sens.detail });
  if (!sens.ok) { res.ok = false; res.summary = `${res.summary.startsWith("Verified") ? "" : res.summary + " · "}protected pages: ${sens.detail}`; }
  return res;
}

/** Advances one project's native readiness by one step. */
const LEASE_MS = 10 * 60_000;
/** Which verifier made an entry's last verification (absent = before versioning). */
export function verifiedBy(p: Pick<pf.PortfolioProject, "native_verification">): string | null {
  try { return (JSON.parse(p.native_verification ?? "{}") as { verifier?: string }).verifier ?? null; } catch { return null; }
}
/** Transient failures (a provider outage or rate limit, the verification browser itself failing) are retried
 *  automatically on later ticks — bounded: after this many consecutive attempts the entry is reported as blocked. */
const TRANSIENT_ATTEMPTS = 8;
function transient(p: pf.PortfolioProject, what: string): Outcome {
  const prev = /\(attempt (\d+) of \d+\)/.exec(p.native_reason ?? "");
  const attempt = (prev && /^Temporarily/.test(p.native_reason ?? "") ? Number(prev[1]) : 0) + 1;
  if (attempt > TRANSIENT_ATTEMPTS) return { state: "unavailable", reason: `${what} — still failing after ${TRANSIENT_ATTEMPTS} automatic attempts; it is retried after a day, or use Check again` };
  return { state: p.native_state === "preparing" ? "preparing" : "checking", reason: `Temporarily unable to continue: ${what}. Retrying automatically (attempt ${attempt} of ${TRANSIENT_ATTEMPTS}).` };
}
const isTransient = (e: unknown) => e instanceof ProviderError && (e.status === 0 || e.status === 429 || e.status >= 500);
export async function advanceNative(d: NativeDeps, id: string, opts: { force?: boolean; actorUserId?: string | null } = {}): Promise<Outcome> {
  const now = d.now?.() ?? Date.now();
  // Claim the entry (atomic); another worker already on it → leave it alone and report where it is.
  const claim = await d.db.prepare(`UPDATE portfolio_projects SET native_lease_until = ? WHERE id = ? AND COALESCE(native_lease_until, '') < ?`).bind(new Date(now + LEASE_MS).toISOString(), id, new Date(now).toISOString()).run();
  if (claim.meta.changes !== 1) {
    const cur = await pf.getById(d.db, id);
    return { state: (cur?.native_state ?? "checking") as pf.NativeState, reason: "Another step for this website is already running; it continues there" };
  }
  try { return await advanceNativeStep(d, id, now, opts); }
  finally { await d.db.prepare(`UPDATE portfolio_projects SET native_lease_until = NULL WHERE id = ?`).bind(id).run().catch(() => undefined); }
}

async function advanceNativeStep(d: NativeDeps, id: string, now: number, opts: { force?: boolean; actorUserId?: string | null }): Promise<Outcome> {
  const p = await pf.getById(d.db, id);
  if (!p) return { state: "unavailable", reason: "Project not found" };
  if (!p.native_required) return { state: "legacy", reason: "Existing entry (shown as before)" };
  const actor = opts.actorUserId ?? null;
  const done = async (o: Outcome & { provider?: string | null; target?: unknown; change?: unknown }) => { await save(d.db, id, p, { ...o, verification: o.verification ?? null }, actor); return o; };

  // A GitHub App connection mints its short-lived installation token before any repository work.
  await githubReady(d.fetchApi, allConns(d.conn, "github")).catch(() => undefined);
  const check = await checkEmbed(p.live_url, d.siteOrigin, d.fetchSite);
  await pf.recordEmbedCheck(d.db, id, check, actor, d.remoteEnabled);
  if (!safePublicUrl(p.live_url)) return done({ state: "unavailable", reason: "The live link is not a public https:// address" });
  let change = parse<Change>(p.native_change);
  if (change?.kind === "failed" && opts.force) change = null;

  if (check.status === "allowed") {
    // Fresh only when made by THIS verifier: a verification by an older verifier is repeated (its checks were fewer).
    const fresh = p.native_state === "native_verified" && p.native_verified_at && now - Date.parse(p.native_verified_at) < VERIFIED_FRESH_MS && p.embed_url === check.url && verifiedBy(p) === VERIFIER_VERSION;
    if (fresh && !opts.force) {
      // Still verified and still permitted: record the daily re-check (native availability is monitored on its own).
      await d.db.prepare(`UPDATE portfolio_projects SET native_updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
      return { state: "native_verified", reason: p.native_reason ?? "Verified" };
    }
    const v = await runVerification(d, p, check, now);
    // The verification browser itself failed (not the website): retried automatically, never a verdict on the site.
    if (typeof v !== "string" && !v.ok && v.checks.every((c) => c.ok || c.name === "browser")) return done(transient(p, v.summary.slice(0, 300)));
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
  // Regression repair: a website verified earlier now refuses framing (a later deployment or policy change). Crestmont
  // prepares it again with the same narrowly scoped, idempotent change (its rule is updated in place by its ref; a
  // repository change is proposed again on the same branch) — at most once a day, and never for a change that failed.
  let regression = false;
  if (p.native_verified_at && change && change.kind !== "failed") {
    const last = Date.parse(change.regressionRepairAt ?? "") || 0;
    if (now - last >= REPAIR_INTERVAL_MS) { regression = true; change = null; }
  }
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
    cf = await discoverAll<CloudflareTarget>(allConns(d.conn, "cloudflare"), "Cloudflare", (c) => discoverCloudflare(d.fetchApi, c, host), notes);
    vc = await discoverAll<VercelTarget>(allConns(d.conn, "vercel"), "Vercel", (c) => discoverVercel(d.fetchApi, c, host), notes);
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
      const r = await applyCloudflareRule(d.fetchApi, cfOf(d, cf)!, cf, host, paths, frameAncestorsValue(d.siteOrigin), rewrite);
      const ch: Change = { kind: "cloudflare-rule", zoneId: cf.zoneId, rulesetId: r.rulesetId, ruleId: r.ruleId, ref: r.ref, host, paths: r.paths, appliedAt: nowIso(), action: r.action, ...(rewrite ? { rewrite: true } : {}), ...(regression ? { regressionRepairAt: nowIso() } : {}) };
      return done({ state: "preparing", reason: `${regression ? "Regression repair: the site stopped permitting framing after it was verified. " : ""}${describeChange(ch)} Waiting for the site's public pages to answer with the new header.`, provider: `cloudflare-zone (${cf.serving})`, target: cf, change: ch });
    }
    // 2. A Git-linked Vercel or Pages project: the change goes through that repository.
    const repoTarget = vc?.repo ? { provider: "vercel" as const, repo: vc.repo, branch: vc.branch } : cf?.pages?.repo ? { provider: "cloudflare-pages" as const, repo: cf.pages.repo, branch: cf.pages.branch ?? "main" } : null;
    if (conflict) return done({ state: "unavailable", reason: `${conflict}${rewriteWhy ? `, and Crestmont's Cloudflare rule cannot replace just that directive: ${rewriteWhy}` : ""}. That header comes from the site's own code, so it has to be changed there (only public pages may allow ${new URL(d.siteOrigin).host}); automatic preparation is not attempted. ${notes.join("; ")}.`, provider: vc ? "vercel" : "cloudflare", target: vc ?? cf });
    if (!repoTarget) return done({ state: "unavailable", reason: `${notes.join("; ")}. The project is not linked to a GitHub repository (and is not proxied by a connected Cloudflare zone), so Crestmont has no supported way to change its headers.`, provider: vc ? "vercel" : "cloudflare", target: vc ?? cf });
    // GitHub: the first authorized account that can push to the repository.
    let gi = 0, access = { ok: false, detail: "", protectedReviews: false } as Awaited<ReturnType<typeof repoAccess>>;
    const ghs = allConns(d.conn, "github");
    for (; gi < ghs.length; gi++) { access = await repoAccess(d.fetchApi, ghs[gi], repoTarget.repo, repoTarget.branch); if (access.ok) break; }
    if (gi === ghs.length) gi = 0;
    if (!ghs.length) return done({ state: "authorization_required", reason: `${notes.join("; ")}. Connect GitHub (PORTFOLIO_GITHUB_TOKEN) with access to ${repoTarget.repo} so Crestmont can propose the header change there.`, provider: repoTarget.provider, target: vc ?? cf });
    if (!access.ok) return done({ state: "authorization_required", reason: `${access.detail}.`, provider: repoTarget.provider, target: vc ?? cf });
    const file = await headerFile(d, repoTarget.provider, vc, cf, repoTarget.repo, repoTarget.branch, gi);
    if (typeof file === "string") return done({ state: "unavailable", reason: `${file}. ${notes.join("; ")}.`, provider: repoTarget.provider, target: vc ?? cf });
    const content = repoTarget.provider === "vercel" ? editVercelJson(file.text, paths, frameAncestorsValue(d.siteOrigin)) : editPagesHeaders(file.text, paths, frameAncestorsValue(d.siteOrigin));
    const title = "Allow Crestmont's portfolio to show the public pages natively";
    const body = `Crestmont Website Development shows this website in its portfolio as the real, live site in a native frame.\n\nThis change lets **only these public, read-only pages** be framed by ${frameAncestorsValue(d.siteOrigin).replace("frame-ancestors ", "")}:\n\n${paths.map((x) => `- \`${x}\``).join("\n")}\n\nIt adds \`Content-Security-Policy: ${frameAncestorsValue(d.siteOrigin)}\` on those paths only${repoTarget.provider === "cloudflare-pages" ? " and detaches `X-Frame-Options` there" : ""}. Sign-in, accounts, booking, checkout, payment, API and every other page are not listed and keep refusing framing. No other header, rule or file is changed.\n\nProposed automatically by Crestmont's portfolio onboarding for ${host}.`;
    const pr = { ...(await proposeChange(d.fetchApi, ghs[gi], repoTarget.repo, repoTarget.branch, file.path, content, title, body, !!access.protectedReviews)), ...(gi ? { conn: gi } : {}) };
    const ch: Change = { kind: "github-pr", provider: repoTarget.provider, pr, ...(regression ? { regressionRepairAt: nowIso() } : {}) };
    return followChange(d, { ...p, native_state: "preparing", native_target: JSON.stringify(vc ?? cf) }, check, ch, now, (o) => done({ ...o, provider: repoTarget.provider, target: vc ?? cf, change: ch }));
  } catch (e) {
    const msg = e instanceof ProviderError || e instanceof EditError ? e.message : `Unexpected error: ${(e as Error).message}`;
    if (isTransient(e)) return done(transient(p, msg));
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

async function headerFile(d: NativeDeps, provider: "vercel" | "cloudflare-pages", vc: VercelTarget | null, cf: CloudflareTarget | null, repo: string, branch: string, gi = 0): Promise<{ path: string; text: string | null } | string> {
  const gh = allConns(d.conn, "github")[gi]!;
  const join = (...xs: string[]) => xs.map((x) => x.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  if (provider === "vercel") { const path = join(vc?.rootDirectory ?? "", "vercel.json"); return { path, text: (await readFile(d.fetchApi, gh, repo, path, branch))?.text ?? null }; }
  const pg = cf!.pages!;
  if (!pg.buildCommand.trim()) { const path = join(pg.root, pg.destination, "_headers"); return { path, text: (await readFile(d.fetchApi, gh, repo, path, branch))?.text ?? null }; }
  // With a build step, _headers must come from the folder the build copies as-is; only an existing one is edited.
  for (const c of [join(pg.root, "public", "_headers"), join(pg.root, "static", "_headers"), join(pg.root, pg.destination, "_headers")]) {
    const f = await readFile(d.fetchApi, gh, repo, c, branch);
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
    const cc = cfOf(d, cf);
    if (cf && cc) await removeCloudflareRule(d.fetchApi, cc, cf, ch.host).catch(() => false);
    const why = `Crestmont's Cloudflare rule for ${ch.host} did not take effect within 10 minutes (the site still answers: ${check.detail}), so it was removed again. The header has to be set where the site's responses are produced.`;
    return done({ state: "unavailable", reason: why, change: { kind: "failed", what: "cloudflare-rule", detail: why, at: nowIso() } satisfies Change });
  }
  const gh = ghOf(d, ch.pr as { conn?: number });
  if (!gh) return done({ state: "authorization_required", reason: `GitHub is no longer connected; ${describeChange(ch)}` });
  const pr = await advancePr(d.fetchApi, gh, ch.pr);
  const next: Change = { ...ch, pr };
  if (pr.closed) return done({ state: "unavailable", reason: `${pr.detail}. Crestmont does not reopen it by itself.`, change: { kind: "failed", what: "github-pr", detail: `${pr.detail}.`, at: nowIso() } satisfies Change });
  if (!pr.merged) return done({ state: pr.needsApproval ? "authorization_required" : "preparing", reason: pr.detail, change: next });
  // Merged: the provider deploys it through its own Git integration.
  const t = parse<Target>(p.native_target);
  let dep: { state: string; detail: string } = { state: "building", detail: "waiting for the deployment" };
  if (ch.provider === "vercel" && t?.kind === "vercel" && vcOf(d, t)) dep = await vercelDeployment(d.fetchApi, vcOf(d, t)!, t, pr.mergeSha);
  else if (ch.provider === "cloudflare-pages" && t?.kind === "cloudflare" && cfOf(d, t)) { const r = await pagesDeployment(d.fetchApi, cfOf(d, t)!, t); dep = { state: r.commit && pr.mergeSha && r.commit !== pr.mergeSha ? "building" : r.state, detail: r.detail }; }
  next.deployDetail = dep.detail;
  if (dep.state === "failed") return done({ state: "unavailable", reason: `The deployment of ${pr.url} failed (${dep.detail}). Fix the deployment; Crestmont re-checks automatically.`, change: next });
  if (dep.state !== "ready") return done({ state: "preparing", reason: `Merged ${pr.url}; ${dep.detail}.`, change: next });
  return done({ state: "preparing", reason: `Deployed (${dep.detail}), but the site still answers: ${check.detail}. Re-checking; if it persists, another layer of the site sets this header.`, change: next });
}

/** The 15-minute job: entries in progress every time; settled ones (waiting for authorization, unavailable) at most
 *  every 6 hours, so a missing permission or a fixed deployment is noticed without re-verifying in a loop; verified
 *  ones once a day (regression monitoring). Bounded. */
export async function advanceAllNative(d: NativeDeps, limit = 10, opts: { budgetMs?: number; maxVerifications?: number; slugs?: string[]; concurrency?: number } = {}): Promise<{ slug: string; state: string; published: boolean }[]> {
  const now = () => d.now?.() ?? Date.now();
  const start = now();
  // Settled entries are retried with backoff: an authorization blocker after 6 hours (a cheap header check), a site
  // whose own defect or verification failed after a day (each retry costs a real-browser verification).
  const settledBefore = new Date(start - 6 * 3_600_000).toISOString();
  const failedBefore = new Date(start - 86_400_000).toISOString();
  // Verified entries are re-checked daily (cheap: their headers; a real-browser verification only once it is a week
  // old), so a later website update that breaks native embedding is noticed and repaired without anyone asking.
  const verifiedBefore = new Date(start - 86_400_000).toISOString();
  // Order: published entries first (visitors see them), then cheap preparation steps (a site that still refuses
  // framing: discovery and a rule) before real-browser verifications (a site that permits framing), verified re-checks last.
  // Named entries (an Owner-approved round) are taken whatever their last state — a settled entry is retried now, not
  // after six hours (a failed change still stays failed: only "Check again" starts it over).
  const named = opts.slugs?.length ? `slug IN (${opts.slugs.map(() => "?").join(", ")})` : "";
  const rows = (await d.db.prepare(`SELECT id, slug, published FROM portfolio_projects WHERE native_required = 1 AND archived_at IS NULL AND (${named ? `(${named} AND (native_state != 'native_verified' OR COALESCE(native_verification, '') NOT LIKE '%"verifier":"${VERIFIER_VERSION}"%')) OR ` : ""}native_state IN ('checking', 'preparing') OR (native_state = 'authorization_required' AND COALESCE(native_updated_at, '') < ?) OR (native_state = 'unavailable' AND COALESCE(native_updated_at, '') < ?) OR (native_state = 'native_verified' AND COALESCE(native_updated_at, '') < ?)
      OR (native_state = 'native_verified' AND COALESCE(native_verification, '') NOT LIKE ?))
    ORDER BY CASE WHEN native_state = 'native_verified' AND COALESCE(native_verification, '') NOT LIKE ? THEN 1 WHEN native_state = 'native_verified' THEN 2 ELSE 0 END, published DESC, CASE WHEN embed_status = 'allowed' THEN 1 ELSE 0 END, COALESCE(native_updated_at, ''), position LIMIT ?`).bind(...(opts.slugs ?? []), settledBefore, failedBefore, verifiedBefore, `%"verifier":"${VERIFIER_VERSION}"%`, `%"verifier":"${VERIFIER_VERSION}"%`, limit).all<{ id: string; slug: string; published: number }>()).results;
  const out: { slug: string; state: string; published: boolean }[] = [];
  // Bounded per run: a time budget and a number of real-browser verifications, so one tick never runs into the
  // platform's limits and the rest simply continues on the next tick (progress is stored per entry).
  const budget = opts.budgetMs ?? 6 * 60_000, maxV = opts.maxVerifications ?? 3;
  // Entries run side by side (each entry by one worker only, so no entry is ever advanced twice at once). The
  // verification budget is never exceeded: a worker only starts an entry while finished + in-flight verifications are
  // under it (an in-flight entry may turn out not to need a verification — the rest then waits for the next round).
  let verifications = 0, inflight = 0, next = 0;
  const results: ({ slug: string; state: string; published: boolean } | undefined)[] = new Array(rows.length);
  const worker = async () => {
    for (let k; (k = next++) < rows.length;) {
      const r = rows[k];
      if (now() - start > budget) { results[k] = { slug: r.slug, state: "deferred: time budget", published: !!r.published }; continue; }
      if (verifications + inflight >= maxV) { results[k] = { slug: r.slug, state: "deferred: verification budget", published: !!r.published }; continue; }
      inflight++;
      try {
        const before = await d.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'portfolio.native_verification' AND subject_id = ?`).bind(r.id).first<{ n: number }>();
        const st = (await advanceNative(d, r.id)).state;
        const after = await d.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'portfolio.native_verification' AND subject_id = ?`).bind(r.id).first<{ n: number }>();
        if ((after?.n ?? 0) > (before?.n ?? 0)) verifications++;
        results[k] = { slug: r.slug, state: st, published: !!r.published };
      } catch (e) { results[k] = { slug: r.slug, state: `error: ${(e as Error).message}`.slice(0, 120), published: !!r.published }; }
      finally { inflight--; }
    }
  };
  const n = Math.max(1, Math.min(8, opts.concurrency ?? d.concurrency ?? 1));
  await Promise.all(Array.from({ length: Math.min(n, rows.length || 1) }, worker));
  out.push(...results.filter((x): x is { slug: string; state: string; published: boolean } => !!x));
  return out;
}

/** Every published entry's native readiness, for a release or an operations run: settled when each is verified, or
 *  stopped on a genuine blocker (authorization, provider, the site's own policy or defect). */
export async function nativeReadiness(db: Db): Promise<{ slug: string; name: string; live: string; published: boolean; state: string; reason: string; codes: string[]; action: string | null; perf: unknown; verifier: string | null; stale: boolean }[]> {
  const rows = (await db.prepare(`SELECT slug, name, live_url, published, native_state, native_reason, native_diagnosis, native_perf, native_verification FROM portfolio_projects WHERE archived_at IS NULL ORDER BY position, name`).all<{ slug: string; name: string; live_url: string; published: number; native_state: string; native_reason: string | null; native_diagnosis: string | null; native_perf: string | null; native_verification: string | null }>()).results;
  return rows.map((r) => {
    const d = parse<{ codes?: string[]; action?: string | null }>(r.native_diagnosis), v = verifiedBy(r);
    // A verification by an older verifier does not count as verified until it is repeated.
    return { slug: r.slug, name: r.name, live: r.live_url, published: !!r.published, state: r.native_state, reason: (r.native_reason ?? "").slice(0, 400), codes: d?.codes ?? [], action: d?.action ?? null, perf: parse(r.native_perf), verifier: v, stale: r.native_state === "native_verified" && v !== VERIFIER_VERSION };
  });
}

/** Step 2 of the Add flow (read-only): which connected account serves the site, before anything is created. */
export async function discoverHosting(d: NativeDeps, host: string): Promise<{ found: boolean; detail: string }> {
  if (!anyConnection(d.conn)) return { found: false, detail: `${connectionSummary(d.conn)} — Crestmont cannot prepare this site until the account that hosts it is connected` };
  const notes: string[] = [];
  let found = false;
  try {
    found = !!(await discoverAll<CloudflareTarget>(allConns(d.conn, "cloudflare"), "Cloudflare", (c) => discoverCloudflare(d.fetchApi, c, host), notes));
    found = !!(await discoverAll<VercelTarget>(allConns(d.conn, "vercel"), "Vercel", (c) => discoverVercel(d.fetchApi, c, host), notes)) || found;
  } catch (e) { notes.push((e as Error).message); }
  if (!allConns(d.conn, "cloudflare").length && !allConns(d.conn, "vercel").length) notes.push("Only GitHub is connected; a hosting account (Cloudflare or Vercel) is needed to find the site");
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

export interface QueuedSite { url: string; result: "queued" | "duplicate" | "existing" | "invalid" | "unreachable"; slug: string | null; detail: string }
/** Bulk Add (Staff → Portfolio → Add several, and the operations workflow): each address is normalised (https, public
 *  host, redirects followed to its canonical address), de-duplicated (within the list and against every existing entry,
 *  www or not, before and after redirects) and queued as an unpublished, native-required entry. Nothing is verified
 *  here: the 15-minute job (or an Owner-approved prepare round) works through the queue, bounded and resumable, so
 *  100 addresses never run as one long request. Nothing is published; no consent or relationship is recorded. */
export async function enqueueOnboarding(d: NativeDeps, raws: string[], actor: Parameters<typeof pf.createProject>[1] = SYSTEM_OWNER): Promise<QueuedSite[]> {
  const list = raws.map((x) => x.trim()).filter(Boolean).slice(0, 100);
  const out: QueuedSite[] = new Array(list.length);
  const seen = new Map<string, string>();
  for (const p of await pf.listActive(d.db)) seen.set(siteKey(p.live_url), p.slug);
  const claimed = new Set<string>();
  // Inputs first (cheap): invalid and in-list duplicates are answered without any request.
  const todo: { k: number; u: URL }[] = [];
  list.forEach((raw, k) => {
    const u = safePublicUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!u) { out[k] = { url: raw.slice(0, 200), result: "invalid", slug: null, detail: "not a public https address" }; return; }
    const key = siteKey(u.toString());
    if (seen.has(key)) { out[k] = { url: u.toString(), result: "existing", slug: seen.get(key)!, detail: `already in the portfolio as ${seen.get(key)}` }; return; }
    if (claimed.has(key)) { out[k] = { url: u.toString(), result: "duplicate", slug: null, detail: "listed more than once" }; return; }
    claimed.add(key); todo.push({ k, u });
  });
  let next = 0;
  const worker = async () => {
    for (let i; (i = next++) < todo.length;) {
      const { k, u } = todo[i];
      const c = await checkEmbed(u.toString(), d.siteOrigin, d.fetchSite).catch(() => null);
      if (!c || c.status === "error") { out[k] = { url: u.toString(), result: "unreachable", slug: null, detail: c?.detail ?? "did not answer" }; continue; }
      const canonical = c.url ?? u.toString(), ck = siteKey(canonical);
      if (ck !== siteKey(u.toString()) && (seen.has(ck) || claimed.has(ck) || claimed.has(`canon:${ck}`))) { out[k] = { url: u.toString(), result: seen.has(ck) ? "existing" : "duplicate", slug: seen.get(ck) ?? null, detail: `redirects to ${canonical}, ${seen.has(ck) ? `already in the portfolio as ${seen.get(ck)}` : "listed more than once"}` }; continue; }
      claimed.add(`canon:${ck}`);
      const site = siteKey(canonical);
      const name = ((c.siteName ?? c.title?.split(/\s+[—–|·-]\s+/)[0] ?? "").trim() || site).slice(0, 120);
      const description = (c.description ?? "").trim().length >= 20 ? c.description!.trim().slice(0, 4000) : `${name} — the live website at ${site}. Added for native onboarding; details to be confirmed by staff before publishing.`;
      try {
        let slug = slugify(name) || slugify(site);
        for (let n = 2; await pf.getBySlug(d.db, slug); n++) slug = `${slugify(name) || slugify(site)}-${n}`;
        await pf.createProject(d.db, actor, { name, slug, industry: "To be confirmed by staff", live_url: canonical, description, features: "", technology_summary: "", relationship: "Relationship documentation pending" });
        seen.set(ck, slug);
        out[k] = { url: u.toString(), result: "queued", slug, detail: `${c.status === "allowed" ? "already permits Crestmont's frame" : "refuses framing today"}; queued for preparation and real-browser verification` };
      } catch (e) {
        // A concurrent Add of the same slug (UNIQUE): the other request created it — never a duplicate entry.
        out[k] = { url: u.toString(), result: "duplicate", slug: null, detail: (e as Error).message.slice(0, 160) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, todo.length || 1) }, worker));
  return out;
}

/** Queue progress for a set of entries (bulk Add results, the operations workflow). */
export async function queueProgress(db: Db, slugs: string[]): Promise<{ total: number; byState: Record<string, number> }> {
  if (!slugs.length) return { total: 0, byState: {} };
  const rows = (await db.prepare(`SELECT native_state FROM portfolio_projects WHERE slug IN (${slugs.map(() => "?").join(",")})`).bind(...slugs).all<{ native_state: string }>()).results;
  const byState: Record<string, number> = {};
  for (const r of rows) byState[r.native_state] = (byState[r.native_state] ?? 0) + 1;
  return { total: rows.length, byState };
}

/** One more step for an entry (the same step the 15-minute job runs). */
export async function advanceForOps(d: NativeDeps, slug: string): Promise<OpsProject | { error: string }> {
  const p = await pf.getBySlug(d.db, slug);
  if (!p || p.archived_at) return { error: "unknown project" };
  if (!p.native_required) return { error: `${slug} is an existing (legacy) entry` };
  await advanceNative(d, p.id);
  return summary(d, p.id);
}
