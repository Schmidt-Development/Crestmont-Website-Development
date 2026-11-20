// Authorized hosting and repository connections for the native-readiness automation. They are Worker secrets set once
// by the Owner (never stored in the database, never shown, never sent anywhere but their own provider's API):
//   PORTFOLIO_CLOUDFLARE_TOKEN   Cloudflare API token — Zone:Read, DNS:Read, Zone:Response Header Transform Rules
//                                (Transform Rules):Edit, Workers Scripts:Read, Cloudflare Pages:Read
//   PORTFOLIO_VERCEL_TOKEN       Vercel token (read projects, domains and deployments); PORTFOLIO_VERCEL_TEAM optional
//   PORTFOLIO_GITHUB_TOKEN       GitHub fine-grained token on the Owner's website repositories — Contents:RW,
//                                Pull requests:RW, Metadata:R (branch protection is read, never changed)
// More accounts (multi-account hosting, 2026-11-19): PORTFOLIO_CLOUDFLARE_TOKEN_2 … _5 (with PORTFOLIO_CLOUDFLARE_ACCOUNTS_n),
// PORTFOLIO_VERCEL_TOKEN_2 … _5 (with PORTFOLIO_VERCEL_TEAM_n) and PORTFOLIO_GITHUB_TOKEN_2 … _5 — each one more authorized
// account searched in order; whichever serves a website is the one Crestmont uses for it (recorded on its target).
// Ownership is never inferred from a URL: a site counts as the Owner's only when one of these authenticated accounts
// serves it (a Cloudflare zone of the account, a verified Vercel project domain), and a repository only when that
// provider itself links it.
import { allowEgressHost } from "../../lib/egress.ts";

export type CloudflareConn = { token: string; accounts: string[] };
export type VercelConn = { token: string; team: string | null };
/** A GitHub connection: a token, or a GitHub App installation (optional one-time integration: an App can be granted
 *  Checks: read, which fine-grained personal tokens cannot — automatic merging then verifies check runs itself). */
export type GithubConn = { token: string; app?: { id: string; key: string; installation: string; expires?: number } };
export interface NativeConnections {
  cloudflare: CloudflareConn | null;
  vercel: VercelConn | null;
  github: GithubConn | null;
  /** Further authorized accounts of each provider (searched after the first). */
  more?: { cloudflare: CloudflareConn[]; vercel: VercelConn[]; github: GithubConn[] };
}
export type ConnectionEnv = Record<string, unknown> & { PORTFOLIO_CLOUDFLARE_TOKEN?: string; PORTFOLIO_CLOUDFLARE_ACCOUNTS?: string; PORTFOLIO_VERCEL_TOKEN?: string; PORTFOLIO_VERCEL_TEAM?: string; PORTFOLIO_GITHUB_TOKEN?: string };

export function connectionsFrom(env: ConnectionEnv): NativeConnections {
  const t = (v?: unknown) => (typeof v === "string" ? v : "").trim();
  const cf = (sfx: string): CloudflareConn | null => t(env[`PORTFOLIO_CLOUDFLARE_TOKEN${sfx}`]) ? { token: t(env[`PORTFOLIO_CLOUDFLARE_TOKEN${sfx}`]), accounts: t(env[`PORTFOLIO_CLOUDFLARE_ACCOUNTS${sfx}`]).split(/[\s,]+/).filter((x) => /^[a-f0-9]{32}$/.test(x)) } : null;
  const vc = (sfx: string): VercelConn | null => t(env[`PORTFOLIO_VERCEL_TOKEN${sfx}`]) ? { token: t(env[`PORTFOLIO_VERCEL_TOKEN${sfx}`]), team: /^team_[A-Za-z0-9]+$/.test(t(env[`PORTFOLIO_VERCEL_TEAM${sfx}`])) ? t(env[`PORTFOLIO_VERCEL_TEAM${sfx}`]) : null } : null;
  const gh = (sfx: string): GithubConn | null => t(env[`PORTFOLIO_GITHUB_TOKEN${sfx}`]) ? { token: t(env[`PORTFOLIO_GITHUB_TOKEN${sfx}`]) } : null;
  const extra = <T>(f: (s: string) => T | null) => ["_2", "_3", "_4", "_5"].map(f).filter((x): x is T => !!x);
  // The GitHub App (PORTFOLIO_GITHUB_APP_ID + _PRIVATE_KEY + _INSTALLATION_ID), when configured, is tried first.
  const appId = t(env.PORTFOLIO_GITHUB_APP_ID), appKey = t(env.PORTFOLIO_GITHUB_APP_PRIVATE_KEY), inst = t(env.PORTFOLIO_GITHUB_APP_INSTALLATION_ID);
  const app: GithubConn | null = /^\d{1,12}$/.test(appId) && /^\d{1,15}$/.test(inst) && /-----BEGIN (RSA )?PRIVATE KEY-----/.test(appKey) ? { token: "", app: { id: appId, key: appKey, installation: inst } } : null;
  const ghs = [app, gh(""), ...extra(gh)].filter((x): x is GithubConn => !!x);
  const more = { cloudflare: extra(cf), vercel: extra(vc), github: ghs.slice(1) };
  return { cloudflare: cf(""), vercel: vc(""), github: ghs[0] ?? null, ...(more.cloudflare.length || more.vercel.length || more.github.length ? { more } : {}) };
}
/** Every connection of a provider, the first one first (index = the `conn` recorded on a target). */
export const allConns = <K extends "cloudflare" | "vercel" | "github">(c: NativeConnections, k: K): NonNullable<NativeConnections[K]>[] =>
  [c[k], ...((c.more?.[k] ?? []) as NonNullable<NativeConnections[K]>[])].filter((x): x is NonNullable<NativeConnections[K]> => !!x);
export const anyConnection = (c: NativeConnections) => !!(allConns(c, "cloudflare").length || allConns(c, "vercel").length || allConns(c, "github").length);
export function connectionSummary(c: NativeConnections): string {
  const n = (k: "cloudflare" | "vercel" | "github", label: string) => { const x = allConns(c, k).length; return x ? (x > 1 ? `${label} (${x} accounts)` : label) : null; };
  const on = [n("cloudflare", "Cloudflare"), n("vercel", "Vercel"), n("github", "GitHub")].filter(Boolean);
  return on.length ? `Connected: ${on.join(", ")}` : "No hosting or repository connection is configured";
}

export class ProviderError extends Error {
  readonly status: number; readonly provider: string;
  constructor(provider: string, status: number, message: string) { super(message); this.provider = provider; this.status = status; }
}

export const API = { cloudflare: "https://api.cloudflare.com/client/v4", vercel: "https://api.vercel.com", github: "https://api.github.com" } as const;
type Provider = keyof typeof API;

/** One authenticated JSON call to a provider API. The provider's host is allowed through the egress guard for exactly
 *  this request. 404 resolves to null (absent); any other non-2xx throws ProviderError with the provider's message. */
export async function call<T>(fetcher: typeof fetch, provider: Provider, token: string, path: string, init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {}): Promise<T | null> {
  const u = new URL(API[provider] + path);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) u.searchParams.set(k, v);
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: provider === "github" ? "application/vnd.github+json" : "application/json", "user-agent": "crestmont-portfolio-native/1.0" };
  if (provider === "github") headers["x-github-api-version"] = "2022-11-28";
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const release = allowEgressHost(u.hostname);
  let res!: Response;
  // Brief, bounded retries for transient answers: a 429 (the request was refused, never applied — safe for any method)
  // and, for reads only, a 502/503/504 or no answer (a write that may have been applied is never repeated). Retry-After
  // is honoured up to 4 s; longer outages are left to the next scheduled round.
  const read = (init.method ?? "GET") === "GET";
  try { for (let attempt = 0; ; attempt++) {
    try { res = await fetcher(u.toString(), { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(20_000) }); }
    catch (e) {
      if (read && attempt < 2) { await new Promise((r) => setTimeout(r, 400 * 2 ** attempt)); continue; }
      throw new ProviderError(provider, 0, `${provider} did not answer (${(e as Error).message})`.slice(0, 200));
    }
    const again = attempt < 2 && (res.status === 429 || (read && [502, 503, 504].includes(res.status)));
    if (!again) break;
    const ra = Number(res.headers.get("retry-after"));
    await res.body?.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, Math.min(4000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 400 * 2 ** attempt)));
  } }
  finally { release(); }
  if (res.status === 404) { await res.body?.cancel().catch(() => undefined); return null; }
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (res.status < 200 || res.status > 299) {
    const j = json as { errors?: { message?: string }[]; error?: { message?: string }; message?: string } | null;
    const msg = j?.errors?.map((e) => e.message).filter(Boolean).join("; ") || j?.error?.message || j?.message || `HTTP ${res.status}`;
    throw new ProviderError(provider, res.status, `${provider} refused (${res.status}): ${msg}`.slice(0, 300));
  }
  return json as T;
}

// ── GitHub App installation tokens (RS256 app JWT → installation access token, cached until shortly before expiry) ──
const b64url = (b: Uint8Array | string) => btoa(typeof b === "string" ? b : String.fromCharCode(...b)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const der = (tag: number, body: Uint8Array) => { const n = body.length; const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]; return new Uint8Array([tag, ...len, ...body]); };
/** GitHub's downloaded App keys are PKCS#1 ("RSA PRIVATE KEY"); WebCrypto imports PKCS#8 — wrap it. */
export function pkcs8FromPem(pem: string): Uint8Array {
  const raw = Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  if (!/BEGIN RSA PRIVATE KEY/.test(pem)) return raw;
  const algo = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return der(0x30, new Uint8Array([0x02, 0x01, 0x00, ...algo, ...der(0x04, raw)]));
}
export async function appJwt(appId: string, pem: string, now = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pkcs8FromPem(pem) as Uint8Array<ArrayBuffer>, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const iat = Math.floor(now / 1000) - 60;
  const data = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat, exp: iat + 540, iss: appId }))}`;
  return `${data}.${b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data))))}`;
}
/** Makes every GitHub App connection usable: mints (or refreshes) its installation token. Token connections pass. */
export async function githubReady(f: typeof fetch, conns: GithubConn[], now = Date.now()): Promise<void> {
  for (const c of conns) {
    if (!c.app || (c.token && (c.app.expires ?? 0) - now > 120_000)) continue;
    const r = await call<{ token: string; expires_at: string }>(f, "github", await appJwt(c.app.id, c.app.key, now), `/app/installations/${c.app.installation}/access_tokens`, { method: "POST", body: {} });
    if (!r?.token) throw new ProviderError("github", 0, "the GitHub App installation token could not be created");
    c.token = r.token; c.app.expires = Date.parse(r.expires_at) || now + 3_000_000;
  }
}
