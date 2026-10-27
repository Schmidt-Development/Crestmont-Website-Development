// Central outbound-request allowlist (ASVS V12.6 / finding F-11). The deployed Worker wraps the global
// fetch once (src/worker.ts) so every provider adapter, probe and job can only reach the hosts below.
// Nothing in the platform fetches user-supplied URLs; the one dynamic case, the environment probe,
// validates the Owner-configured URL and registers that single host for the duration of the call.
export const EGRESS_HOSTS: readonly string[] = [
  "api.stripe.com",               // payments, reconciliation, invoices
  "api.resend.com",               // transactional email
  "api.anthropic.com",            // AI drafting
  "api.github.com",               // readiness GitHub sync
  "challenges.cloudflare.com",    // Turnstile siteverify
  "cloudflare-dns.com",           // DNS-over-HTTPS for the environment probe
  "api.pwnedpasswords.com",       // breached-password check (k-anonymity range API)
  "api.retellai.com",             // voice provider API
];

const dynamic = new Set<string>();

export class EgressBlockedError extends Error {
  constructor(host: string) { super(`Outbound request to ${host} blocked by the egress allowlist`); this.name = "EgressBlockedError"; }
}

export function egressAllowed(url: string | URL): boolean {
  let u: URL;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== "https:") return false;
  return EGRESS_HOSTS.includes(u.hostname) || dynamic.has(u.hostname);
}

/** Temporarily allow one validated host (environment probe). Returns a release function. */
export function allowEgressHost(host: string): () => void {
  const added = !dynamic.has(host);
  dynamic.add(host);
  return () => { if (added) dynamic.delete(host); };
}

export function guardFetch(inner: typeof fetch): typeof fetch {
  const guarded = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? input : input.url;
    if (!egressAllowed(url)) {
      let host = "invalid URL";
      try { host = new URL(String(url)).hostname; } catch { /* keep */ }
      return Promise.reject(new EgressBlockedError(host));
    }
    return inner(input, init);
  }) as typeof fetch;
  return guarded;
}

let installed = false;
/** Called once at Worker start-up. Idempotent. */
export function installEgressGuard(): void {
  if (installed) return;
  globalThis.fetch = guardFetch(globalThis.fetch.bind(globalThis));
  installed = true;
}
