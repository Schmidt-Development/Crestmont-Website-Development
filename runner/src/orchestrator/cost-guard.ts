// $0 metered AI inference (Founder V4 §10). Builds run on the self-hosted model server only. There is no automatic
// Claude API, OpenAI API or other paid-inference fallback anywhere in the runner:
//  - the local provider refuses a hosted inference API as LOCAL_MODEL_BASE_URL and Ollama cloud models (local.ts);
//  - the egress proxy denies the paid AI hosts from every network (one shared list, providers/paid-hosts.ts);
//  - the platform refuses work to a runner that does not declare zero token cost, and to GPU workers that are not
//    owned hardware, unless the Founder separately enables a paid provider with a budget;
//  - the agent's environment is built from an allow-list, so a metered credential on the host never reaches it;
//  - preflight reports metered-billing variables present in the runner's own environment, so they can be removed.

/** Variables that select metered billing or a paid cloud inference backend. */
export const METERED_ENV = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_PROJECT|CODEX_API_KEY|AZURE_OPENAI_.*|GOOGLE_APPLICATION_CREDENTIALS|VERTEX_.*|ANTHROPIC_VERTEX_.*|ANTHROPIC_BEDROCK_.*|GROQ_API_KEY|TOGETHER_API_KEY|FIREWORKS_API_KEY|MISTRAL_API_KEY|OPENROUTER_API_KEY|HF_TOKEN|HUGGINGFACE_API_KEY|DEEPSEEK_API_KEY|XAI_API_KEY|GEMINI_API_KEY|COHERE_API_KEY|REPLICATE_API_TOKEN)$/i;

export type AdapterBilling = "zero-cost";

export class SpendPolicyError extends Error {
  constructor(message: string) { super(message); this.name = "SpendPolicyError"; }
}

/** Names of metered-billing variables set in `env` (values are never read or logged). */
export function meteredVariables(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((k) => env[k] !== undefined && env[k] !== "" && METERED_ENV.test(k)).sort();
}

/** Refuse an environment that could select metered inference (used for every environment built for a model call). */
export function assertNoMeteredEnv(env: Record<string, string | undefined>): void {
  const bad = meteredVariables(env);
  if (bad.length) throw new SpendPolicyError(`Refusing an environment with metered-billing variables: ${bad.join(", ")}`);
}
