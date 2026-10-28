// Hard zero-additional-spend policy for the Crestmont AI Orchestrator (Founder redirect §2, §9E).
//
// Claude Code signed in with a Claude plan switches to metered API billing when an API key (or a Bedrock/Vertex
// switch) is present in its environment, and an API key takes precedence over the subscription sign-in. So every
// Claude Code session is started with an environment built from an allow-list, and every variable that could select
// metered billing or another paid backend is removed and checked again before launch. There is no paid fallback.

/** Variables that make a CLI bill per token or route to a paid cloud backend. Never passed to a subscription CLI. */
export const METERED_ENV = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_PROJECT|CODEX_API_KEY|AZURE_OPENAI_.*|AWS_.*|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|VERTEX_.*|ANTHROPIC_VERTEX_.*|ANTHROPIC_BEDROCK_.*|.*_API_KEY|.*_TOKEN|.*_SECRET)$/i;

export type AdapterBilling = "subscription" | "zero-cost";

export class SpendPolicyError extends Error {
  constructor(message: string) { super(message); this.name = "SpendPolicyError"; }
}

/** Environment for a subscription CLI: only the allow-listed names, never a metered-billing variable. */
export function subscriptionCliEnv(base: Record<string, string>, allow: readonly string[] = ["PATH", "HOME", "LANG", "TZ", "TMPDIR", "CI", "NO_COLOR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "CLAUDE_CONFIG_DIR", "NODE_EXTRA_CA_CERTS", "DISABLE_AUTOUPDATER", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_DISABLE_AUTO_MEMORY"]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of allow) if (base[k] !== undefined && !METERED_ENV.test(k)) env[k] = base[k];
  assertNoMeteredEnv(env);
  return env;
}

export function assertNoMeteredEnv(env: Record<string, string | undefined>): void {
  const bad = Object.keys(env).filter((k) => env[k] !== undefined && METERED_ENV.test(k));
  if (bad.length) throw new SpendPolicyError(`Refusing to start a subscription CLI with metered-billing variables: ${bad.join(", ")}`);
}


/** Recognize "usage limit reached" style failures so the worker is reported as rate-limited (never retried on a paid API). */
export function limitReached(text: string): { limited: boolean; resetAt: string | null } {
  const limited = /(usage limit|rate limit|limit reached|too many requests|quota exceeded|429)/i.test(text);
  if (!limited) return { limited: false, resetAt: null };
  const iso = /\b(20\d\d-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))\b/.exec(text);
  return { limited: true, resetAt: iso && !Number.isNaN(Date.parse(iso[1])) ? new Date(iso[1]).toISOString() : null };
}
