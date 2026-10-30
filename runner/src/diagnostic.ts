// Node 1 dispatch-to-GPU diagnostic, runner side (Founder P0 directive, 2026-10-30).
// Runs one platform-issued diagnostic job (workflow gpu_diagnostic) against the configured local model through
// Ollama's NATIVE API, because only it reports what the diagnostic must prove: the model actually resident in VRAM
// (/api/ps size_vram) and real timings and token counts (/api/chat total_duration, load_duration, eval_count, ...).
// Every step is reported to the platform as it happens (D07–D11, runner clock); nothing is estimated or back-filled.
// The result goes back through the normal draft completion (/ai/complete), where the platform records D12/D13.
// Read-only towards the machine: it loads the configured model (as any build would) and changes nothing else.
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import type { ControlPlaneClient } from "./control-plane.ts";
import { LeaseLostError } from "./control-plane.ts";
import type { AiDraftJob, DiagnosticCheckpoint } from "./protocol.ts";
import { RUNNER_VERSION } from "./protocol.ts";
import type { Logger } from "./log.ts";
import { errorMessage } from "./log.ts";

export interface DiagnosticDeps {
  client: ControlPlaneClient;
  /** OpenAI-compatible base from LOCAL_MODEL_BASE_URL (e.g. http://host.docker.internal:11434/v1). */
  baseUrl: string;
  modelName: string;
  log: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** http://host:11434/v1 → http://host:11434 (Ollama's native API lives at the server root). */
export function nativeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

const sameModel = (a: string, b: string) => a === b || a === `${b}:latest` || b === `${a}:latest`;
const ms = (ns: unknown) => typeof ns === "number" ? Math.round(ns / 1e6) : null;

interface PsModel { name?: string; model?: string; size?: number; size_vram?: number; expires_at?: string; details?: { parameter_size?: string; quantization_level?: string; family?: string } }

export async function runDiagnostic(d: DiagnosticDeps, job: AiDraftJob & { diagnostic: { correlationId: string } }): Promise<"completed" | "failed" | "lease_lost"> {
  const f = d.fetchImpl ?? fetch;
  const clock = d.now ?? Date.now;
  const iso = () => new Date(clock()).toISOString();
  const base = nativeBase(d.baseUrl);
  const corr = job.diagnostic.correlationId;
  const log = d.log.child({ aiJobId: job.id, correlationId: corr, diagnostic: true });
  const metrics: Record<string, unknown> = { runnerVersion: RUNNER_VERSION, configuredModel: d.modelName };
  // Every step must finish inside the lease (minus 30 s to deliver the result), whatever the platform granted.
  const leaseEnd = Date.parse(job.leaseExpiresAt);
  const left = (cap: number) => Math.max(5_000, Math.min(cap, (Number.isFinite(leaseEnd) ? leaseEnd : clock() + 300_000) - clock() - 30_000));

  const report = async (cp: Omit<DiagnosticCheckpoint, "at"> & { at?: string }) => {
    const full: DiagnosticCheckpoint = { at: iso(), ...cp };
    log.info(`diagnostic ${full.code} ${full.ok ? "PASS" : "FAIL"}`, { component: full.component, ...(full.error ? { error: full.error } : {}) });
    try { await d.client.aiCheckpoint(job, corr, full); } catch (err) {
      if (err instanceof LeaseLostError) throw err;
      log.warn("diagnostic checkpoint not delivered", { code: full.code, error: errorMessage(err) });
    }
  };
  const getJson = async (path: string, init: RequestInit, timeoutMs: number) => {
    const res = await f(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { raw: text.slice(0, 300) }; }
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${String(body.error ?? body.raw ?? "").slice(0, 300)}`);
    return body;
  };
  const ps = async () => {
    const body = await getJson("/api/ps", { method: "GET" }, 10_000);
    const models = (Array.isArray(body.models) ? body.models : []) as PsModel[];
    const m = models.find((x) => sameModel(String(x.name ?? x.model ?? ""), d.modelName));
    return { loaded: models.map((x) => String(x.name ?? x.model)), model: m ? {
      name: m.name ?? m.model, sizeBytes: m.size ?? null, sizeVramBytes: m.size_vram ?? null,
      gpuPercent: m.size && m.size_vram !== undefined ? Math.round((m.size_vram / m.size) * 100) : null,
      parameterSize: m.details?.parameter_size ?? null, quantization: m.details?.quantization_level ?? null, expiresAt: m.expires_at ?? null,
    } : null };
  };
  const finish = async (out: { text?: string; error?: string; inputTokens?: number; outputTokens?: number }) => {
    try {
      const r = await d.client.aiComplete(job, { ...out, model: d.modelName, inputTokens: out.inputTokens ?? 0, outputTokens: out.outputTokens ?? 0, correlationId: corr, diagnostic: metrics });
      log.info("diagnostic result delivered", { status: r.status });
      return out.error ? "failed" as const : "completed" as const;
    } catch (err) {
      if (err instanceof LeaseLostError) return "lease_lost" as const;
      log.warn("diagnostic result not delivered", { error: errorMessage(err) });
      return "failed" as const;
    }
  };

  try {
    // D07: this process received the job.
    await report({ code: "D07", ok: true, component: "runner", evidence: { host: hostname(), pid: process.pid, runnerVersion: RUNNER_VERSION, node: process.version, platform: process.platform, configuredModel: d.modelName } });

    // D08: the local model server answers.
    let version: string;
    try {
      version = String((await getJson("/api/version", { method: "GET" }, 10_000)).version ?? "unknown");
      metrics.ollamaVersion = version;
    } catch (err) {
      const msg = `Ollama did not answer at ${base}: ${errorMessage(err)}`;
      await report({ code: "D08", ok: false, component: "ollama", error: msg, evidence: { endpoint: `${base}/api/version` } });
      return await finish({ error: msg });
    }
    await report({ code: "D08", ok: true, component: "ollama", evidence: { endpoint: `${base}/api/version`, version } });

    // D09: the configured model is loaded, and how much of it is in GPU memory.
    const t9 = clock();
    try {
      await getJson("/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: d.modelName, prompt: "", stream: false, keep_alive: "10m" }) }, left(600_000));
    } catch (err) {
      const msg = `model ${d.modelName} did not load: ${errorMessage(err)}`;
      await report({ code: "D09", ok: false, component: "ollama", error: msg, evidence: { model: d.modelName, waitedMs: clock() - t9 } });
      return await finish({ error: msg });
    }
    const loaded = await ps();
    metrics.loadWaitMs = clock() - t9;
    metrics.residency = loaded.model;
    const onGpu = !!loaded.model && (loaded.model.sizeVramBytes ?? 0) > 0;
    await report({ code: "D09", ok: onGpu, component: "ollama", error: !loaded.model ? `model ${d.modelName} is not listed by /api/ps after loading (loaded: ${loaded.loaded.join(", ") || "none"})` : onGpu ? undefined : "the model is loaded but none of it is in GPU memory (size_vram = 0): CPU only",
      evidence: { model: loaded.model, loadWaitMs: metrics.loadWaitMs } });
    if (!onGpu) return await finish({ error: "model not resident on the GPU" });

    // D10: the inference request is sent.
    const promptSha = createHash("sha256").update(job.system + "\n" + job.prompt).digest("hex");
    await report({ code: "D10", ok: true, component: "ollama", evidence: { endpoint: `${base}/api/chat`, model: d.modelName, promptSha256: promptSha, temperature: 0, seed: 42, numPredict: job.maxOutputTokens, gpuPercent: loaded.model?.gpuPercent ?? null } });

    // D11: inference completes, with Ollama's own timings and token counts.
    let res: Record<string, unknown>;
    try {
      res = await getJson("/api/chat", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: d.modelName, stream: false, keep_alive: "10m", messages: [{ role: "system", content: job.system }, { role: "user", content: job.prompt }],
          options: { temperature: 0, seed: 42, num_predict: Math.max(64, Math.min(job.maxOutputTokens || 800, 2000)) } }) }, left(300_000));
    } catch (err) {
      const msg = `inference failed: ${errorMessage(err)}`;
      await report({ code: "D11", ok: false, component: "ollama", error: msg });
      return await finish({ error: msg });
    }
    const content = String((res.message as { content?: string } | undefined)?.content ?? "")
      .replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/, "").trim();
    const evalCount = typeof res.eval_count === "number" ? res.eval_count : 0;
    const evalMs = ms(res.eval_duration);
    const after = await ps().catch(() => null);
    Object.assign(metrics, {
      totalMs: ms(res.total_duration), loadMs: ms(res.load_duration), promptEvalCount: res.prompt_eval_count ?? null, promptEvalMs: ms(res.prompt_eval_duration),
      evalCount, evalMs, tokensPerSecond: evalMs ? Math.round((evalCount / (evalMs / 1000)) * 10) / 10 : null, doneReason: res.done_reason ?? null,
      reportedModel: res.model ?? null, residencyAfter: after?.model ?? null,
    });
    const looksHtml = /<html[\s>]/i.test(content) && /<h1[\s>]/i.test(content) && /<p[\s>]/i.test(content) && /<title[\s>]/i.test(content);
    await report({ code: "D11", ok: !!content, component: "ollama", error: content ? undefined : "the model returned no text",
      evidence: { totalMs: metrics.totalMs, loadMs: metrics.loadMs, evalCount, evalMs, tokensPerSecond: metrics.tokensPerSecond, doneReason: metrics.doneReason, outputChars: content.length, looksLikeRequestedHtml: looksHtml, gpuPercentAfter: after?.model?.gpuPercent ?? null } });
    if (!content) return await finish({ error: "the model returned no text", inputTokens: Number(res.prompt_eval_count) || 0, outputTokens: evalCount });
    return await finish({ text: content, inputTokens: Number(res.prompt_eval_count) || 0, outputTokens: evalCount });
  } catch (err) {
    if (err instanceof LeaseLostError) { log.warn("diagnostic lease lost"); return "lease_lost"; }
    return await finish({ error: `diagnostic runner error: ${errorMessage(err).slice(0, 300)}` });
  }
}
