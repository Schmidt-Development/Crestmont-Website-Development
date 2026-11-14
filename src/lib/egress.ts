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

/**
 * Amazon SES (EMAIL_PROVIDER = "ses"): the SES v2 API is regional (email.<SES_REGION>.amazonaws.com), and SNS signing
 * certificates and SubscribeURLs come from sns.<region>.amazonaws.com (the shared SES event topic's region). Exact
 * service-host shapes only; any other amazonaws.com host stays blocked.
 */
export const EGRESS_HOST_PATTERNS: readonly RegExp[] = [
  /^email\.[a-z0-9-]+\.amazonaws\.com$/,
  /^sns\.[a-z0-9-]+\.amazonaws\.com$/,
];

/**
 * Hosts that a URL out of an UPLOADED FILE may never reach, whatever else it satisfies.
 *
 * The allowlist above answers "which services does the platform talk to". This answers a different question:
 * when the platform fetches a URL that came from a customer's artifact -- a web font, a photograph -- which hosts
 * must that never be able to touch? Two groups, for two reasons:
 *
 *   · the paid inference APIs, because "no paid AI service is called" is evidence this platform maintains, and a
 *     crafted artifact must not be able to make the platform call one;
 *   · the platform's own provider hosts, because those are where its money, its mail and its customer records
 *     are, and an uploaded file must not be able to aim a request at them even a GET.
 *
 * `.googleapis.com` is deliberately NOT here: Google Fonts is served from `fonts.googleapis.com`, it is a normal
 * dependency of a normal website, and refusing it is what made the Founder's law firm design measure in a
 * fallback face. The runner's own egress proxy denies that domain because the RUNNER has no business there; the
 * platform fetching a stylesheet on an owner's behalf is a different act with different rules.
 */
export const UNTRUSTED_DENY_HOSTS: readonly string[] = [
  "api.anthropic.com", "claude.ai", "claude.com", "api.openai.com", "openai.azure.com",
  "api.mistral.ai", "openrouter.ai", "api.groq.com", "api.together.xyz", "api.together.ai",
  "api.fireworks.ai", "api.cohere.ai", "api.cohere.com", "api.deepseek.com", "api.x.ai",
  "api.perplexity.ai", "api.replicate.com", "api-inference.huggingface.co", "router.huggingface.co",
  "generativelanguage.googleapis.com", "aiplatform.googleapis.com",
  ...EGRESS_HOSTS,
];

/** Is this a host an uploaded artifact may cause the platform to fetch from? */
export function untrustedHostAllowed(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (UNTRUSTED_DENY_HOSTS.includes(h)) return false;
  // A subdomain of a denied host is the same host for this purpose.
  if (UNTRUSTED_DENY_HOSTS.some((d) => h.endsWith(`.${d}`))) return false;
  if (EGRESS_HOST_PATTERNS.some((re) => re.test(h))) return false;
  if (/(^|\.)bedrock-runtime(-fips)?\./.test(h) && h.endsWith(".amazonaws.com")) return false;
  return true;
}

const dynamic = new Set<string>();

export class EgressBlockedError extends Error {
  constructor(host: string) { super(`Outbound request to ${host} blocked by the egress allowlist`); this.name = "EgressBlockedError"; }
}

export function egressAllowed(url: string | URL): boolean {
  let u: URL;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== "https:") return false;
  return EGRESS_HOSTS.includes(u.hostname) || EGRESS_HOST_PATTERNS.some((re) => re.test(u.hostname)) || dynamic.has(u.hostname);
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
