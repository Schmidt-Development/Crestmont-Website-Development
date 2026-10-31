// Minimal client for an OpenAI-compatible /chat/completions endpoint on a SELF-HOSTED model server (Ollama by
// default). Non-streaming requests; bounded retries on connection errors, 5xx and 429; abortable.
//
// Ollama documents (https://docs.ollama.com/api/openai-compatibility): /v1/chat/completions with `tools` is supported,
// `tool_choice` is not; the API key is required by clients but ignored; the OpenAI API has no context-size parameter
// (set OLLAMA_CONTEXT_LENGTH or a Modelfile num_ctx instead).

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Content parts (OpenAI format) for a user message with images; Ollama accepts base64 data URLs for vision models. */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; name?: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  max_tokens?: number;
  /** Qwen thinking models: how much to think (Ollama's OpenAI compatibility accepts reasoning_effort). */
  reasoning_effort?: "high" | "medium" | "low";
}

/** Plain text of a message's content (images count as a marker). */
export function contentText(c: string | ContentPart[] | null): string {
  if (c === null) return "";
  if (typeof c === "string") return c;
  return c.map((p) => p.type === "text" ? p.text : "[image]").join("\n");
}

export interface ChatResponse {
  content: string | null;
  /** Raw tool calls; `arguments` may be a JSON string (OpenAI) or, from some servers, an object. */
  toolCalls: { id?: string; name?: string; arguments?: unknown }[];
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
  wallMs: number;
}

export class ModelServerError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "ModelServerError";
    this.status = status;
    this.retryable = retryable;
  }
}

export interface OpenAICompatOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A backoff wait that ends early (with an AbortError) when the caller's signal fires, so a stop is never delayed. */
async function abortableSleep(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { await Promise.race([sleep(ms), aborted]); } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

/**
 * True when the server rejected the request because the prompt does not fit the model's context window. Ollama
 * usually truncates silently instead; llama.cpp server, vLLM and LM Studio answer 400 with messages like these.
 */
export function isContextOverflow(err: unknown): boolean {
  if (!(err instanceof ModelServerError)) return false;
  if (![400, 413, 422, 500].includes(err.status)) return false;
  return /context (length|window|size)|maximum context|exceeds? the (available )?context|too many tokens|prompt is too long|input (is )?too long|n_ctx|num_ctx/i.test(err.message);
}

/** Error from a model request that timed out (per-request timeout), as opposed to a stop requested by the caller. */
export function isTimeout(err: unknown): boolean {
  return err instanceof DOMException && err.name === "TimeoutError";
}

export class OpenAICompatClient {
  private readonly o: OpenAICompatOptions;

  constructor(o: OpenAICompatOptions) {
    this.o = o;
    if (!/^https?:\/\//.test(o.baseUrl)) throw new Error("LOCAL_MODEL_BASE_URL must be an http(s) URL");
  }

  get baseUrl(): string { return this.o.baseUrl.replace(/\/+$/, ""); }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const fetchImpl = this.o.fetchImpl ?? fetch;
    const attempts = 1 + (this.o.retries ?? 3);
    let last: unknown;
    let timeouts = 0;
    for (let i = 1; i <= attempts; i++) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const started = Date.now();
      try {
        const timeout = AbortSignal.timeout(this.o.timeoutMs);
        const res = await fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` },
          body: JSON.stringify({ ...req, stream: false }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        const text = await res.text();
        if (!res.ok) {
          const retryable = res.status === 429 || res.status >= 500;
          throw new ModelServerError(`model server answered ${res.status}: ${text.slice(0, 300)}`, res.status, retryable);
        }
        return parseChatResponse(text, Date.now() - started);
      } catch (err) {
        if (signal?.aborted) throw err;
        last = err;
        // Retry: connection errors, 5xx/429 and the first per-request timeout. Not retried: other 4xx (including a
        // context overflow, which the agent loop handles by compacting), unparseable bodies, a second timeout (a
        // generation that already took the full timeout twice will not get faster).
        const timedOut = isTimeout(err);
        if (timedOut) timeouts++;
        const retryable = err instanceof ModelServerError ? err.retryable : timedOut ? timeouts < 2 : !(err instanceof SyntaxError);
        if (!retryable || i === attempts) break;
        await abortableSleep(this.o.sleep ?? defaultSleep, Math.min(30_000, 1000 * 2 ** (i - 1)), signal);
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  /** GET /models: ids the server can serve (Ollama lists pulled models). */
  async models(signal?: AbortSignal): Promise<string[]> {
    const res = await (this.o.fetchImpl ?? fetch)(`${this.baseUrl}/models`, {
      headers: { authorization: `Bearer ${this.o.apiKey}` },
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new ModelServerError(`model server /models answered ${res.status}`, res.status, false);
    const body = await res.json() as { data?: { id?: string }[] };
    return (body.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
  }
}

export function parseChatResponse(text: string, wallMs: number): ChatResponse {
  const body = JSON.parse(text) as {
    choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] }; finish_reason?: string | null }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = body.choices?.[0];
  if (!choice || !choice.message) throw new ModelServerError("model server returned no choices", 502, true);
  const msg = choice.message;
  return {
    content: typeof msg.content === "string" ? msg.content : null,
    toolCalls: (msg.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function?.name, arguments: t.function?.arguments })),
    finishReason: choice.finish_reason ?? null,
    promptTokens: Number(body.usage?.prompt_tokens) || 0,
    completionTokens: Number(body.usage?.completion_tokens) || 0,
    wallMs,
  };
}
