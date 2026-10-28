// Model residency on the shared model server (Ollama's native API, next to the OpenAI-compatible /v1 the agents use).
//   GET  /api/ps                                   models in memory with size_vram (bytes)
//   POST /api/generate {model, prompt:"", keep_alive}  load a model (an empty prompt only loads it)
//   POST /api/generate {model, keep_alive: 0}      unload it
//   POST /api/show {model}                         details: family, parameter_size, quantization_level, license
// (docs.ollama.com/api and the Ollama FAQ "How do I keep a model loaded in memory or make it unload immediately?")
// Every call is local (the runner reaches Ollama on Node 1 only through its egress gateway); nothing here is paid.

export interface LoadedModel { model: string; vramMb: number | null }
export interface ModelDetails { family: string | null; parameterSize: string | null; quantization: string | null; license: string | null }

export interface Residency {
  loaded(signal?: AbortSignal): Promise<LoadedModel[]>;
  load(model: string, keepAlive: string, signal?: AbortSignal): Promise<void>;
  unload(model: string, signal?: AbortSignal): Promise<void>;
  details?(model: string, signal?: AbortSignal): Promise<ModelDetails>;
}

/** Native Ollama base from the OpenAI-compatible base URL (".../v1" → "..."). */
export function ollamaNativeBase(openAiBase: string): string {
  return openAiBase.replace(/\/+$/, "").replace(/\/v1$/, "");
}

const sameModel = (a: string, b: string) => a === b || a === `${b}:latest` || `${a}:latest` === b;

export class OllamaResidency implements Residency {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  constructor(openAiBase: string, fetchImpl: typeof fetch = fetch) { this.base = ollamaNativeBase(openAiBase); this.fetchImpl = fetchImpl; }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`model server ${path} answered ${res.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
  }

  async loaded(signal?: AbortSignal): Promise<LoadedModel[]> {
    const res = await this.fetchImpl(`${this.base}/api/ps`, { signal: signal ?? AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`model server /api/ps answered ${res.status}`);
    const body = await res.json() as { models?: { name?: string; model?: string; size_vram?: number }[] };
    return (body.models ?? []).map((m) => ({ model: String(m.name ?? m.model ?? ""), vramMb: typeof m.size_vram === "number" ? Math.round(m.size_vram / 1048576) : null })).filter((m) => m.model);
  }

  async load(model: string, keepAlive: string, signal?: AbortSignal): Promise<void> {
    await this.post("/api/generate", { model, prompt: "", keep_alive: keepAlive, stream: false }, signal);
    const now = await this.loaded(signal);
    if (!now.some((m) => sameModel(m.model, model))) throw new Error(`${model} is not in memory after loading`);
  }

  async unload(model: string, signal?: AbortSignal): Promise<void> {
    await this.post("/api/generate", { model, keep_alive: 0, stream: false }, signal);
  }

  async details(model: string, signal?: AbortSignal): Promise<ModelDetails> {
    const b = await this.post("/api/show", { model }, signal ?? AbortSignal.timeout(15_000));
    const d = (b.details ?? {}) as Record<string, unknown>;
    const lic = typeof b.license === "string" ? b.license : "";
    const s = (v: unknown, max: number) => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
    return {
      family: s(d.family, 40), parameterSize: s(d.parameter_size, 20), quantization: s(d.quantization_level, 20),
      // First line of the license text names it (e.g. "Apache License"); the full text stays on the model server.
      license: lic ? (/apache license/i.test(lic) ? "Apache-2.0" : /mit license/i.test(lic) ? "MIT" : lic.split("\n").find((l) => l.trim())?.trim().slice(0, 40) ?? null) : null,
    };
  }
}

export { sameModel };
