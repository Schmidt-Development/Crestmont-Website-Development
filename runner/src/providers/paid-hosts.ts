// Hosted (paid / remote) inference APIs. One list for: the local provider's refusal of such a LOCAL_MODEL_BASE_URL,
// the Windows egress proxy's always-deny ACL (runner/windows/proxy/squid.conf.template, kept equal by a test) and
// the validation evidence collector (Collect-Evidence.ps1).

/** dstdomain form: a leading dot covers the domain itself and every subdomain. */
export const PAID_AI_DOMAINS = [
  ".anthropic.com", ".claude.ai", ".claude.com", ".openai.com", ".openai.azure.com", ".mistral.ai", ".googleapis.com",
  ".openrouter.ai", ".groq.com", ".together.xyz", ".together.ai", ".fireworks.ai", ".cohere.ai", ".cohere.com",
  ".deepseek.com", ".x.ai", ".perplexity.ai", ".replicate.com", "api-inference.huggingface.co", "router.huggingface.co",
];

/** Squid-style dstdomain match. */
export function domainMatches(entry: string, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const e = entry.toLowerCase();
  return e.startsWith(".") ? h === e.slice(1) || h.endsWith(e) : h === e;
}

export const BEDROCK_RUNTIME = /^bedrock-runtime(-fips)?\.[a-z0-9-]+\.amazonaws\.com$/i;

export function isPaidAiHost(host: string): boolean {
  return PAID_AI_DOMAINS.some((d) => domainMatches(d, host)) || BEDROCK_RUNTIME.test(host);
}
