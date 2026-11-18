// Authorized hosting and repository connections for the native-readiness automation. They are Worker secrets set once
// by the Owner (never stored in the database, never shown, never sent anywhere but their own provider's API):
//   PORTFOLIO_CLOUDFLARE_TOKEN   Cloudflare API token — Zone:Read, DNS:Read, Zone:Response Header Transform Rules
//                                (Transform Rules):Edit, Workers Scripts:Read, Cloudflare Pages:Read
//   PORTFOLIO_VERCEL_TOKEN       Vercel token (read projects, domains and deployments); PORTFOLIO_VERCEL_TEAM optional
//   PORTFOLIO_GITHUB_TOKEN       GitHub fine-grained token on the Owner's website repositories — Contents:RW,
//                                Pull requests:RW, Metadata:R (branch protection is read, never changed)
// Ownership is never inferred from a URL: a site counts as the Owner's only when one of these authenticated accounts
// serves it (a Cloudflare zone of the account, a verified Vercel project domain), and a repository only when that
// provider itself links it.
import { allowEgressHost } from "../../lib/egress.ts";

export interface NativeConnections {
  cloudflare: { token: string; accounts: string[] } | null;
  vercel: { token: string; team: string | null } | null;
  github: { token: string } | null;
}
export interface ConnectionEnv { PORTFOLIO_CLOUDFLARE_TOKEN?: string; PORTFOLIO_CLOUDFLARE_ACCOUNTS?: string; PORTFOLIO_VERCEL_TOKEN?: string; PORTFOLIO_VERCEL_TEAM?: string; PORTFOLIO_GITHUB_TOKEN?: string }

export function connectionsFrom(env: ConnectionEnv): NativeConnections {
  const t = (v?: string) => (v ?? "").trim();
  return {
    cloudflare: t(env.PORTFOLIO_CLOUDFLARE_TOKEN) ? { token: t(env.PORTFOLIO_CLOUDFLARE_TOKEN), accounts: t(env.PORTFOLIO_CLOUDFLARE_ACCOUNTS).split(/[\s,]+/).filter((x) => /^[a-f0-9]{32}$/.test(x)) } : null,
    vercel: t(env.PORTFOLIO_VERCEL_TOKEN) ? { token: t(env.PORTFOLIO_VERCEL_TOKEN), team: /^team_[A-Za-z0-9]+$/.test(t(env.PORTFOLIO_VERCEL_TEAM)) ? t(env.PORTFOLIO_VERCEL_TEAM) : null } : null,
    github: t(env.PORTFOLIO_GITHUB_TOKEN) ? { token: t(env.PORTFOLIO_GITHUB_TOKEN) } : null,
  };
}
export const anyConnection = (c: NativeConnections) => !!(c.cloudflare || c.vercel || c.github);
export function connectionSummary(c: NativeConnections): string {
  const on = [c.cloudflare && "Cloudflare", c.vercel && "Vercel", c.github && "GitHub"].filter(Boolean);
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
  let res: Response;
  try { res = await fetcher(u.toString(), { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(20_000) }); }
  catch (e) { throw new ProviderError(provider, 0, `${provider} did not answer (${(e as Error).message})`.slice(0, 200)); }
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
