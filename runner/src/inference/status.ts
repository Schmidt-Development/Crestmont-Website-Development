// The GPU worker status the runner reports to the platform (V4 §9: worker id, hardware, VRAM, loaded model,
// supported models, workload, queue depth, health, throughput, model-loading status). Built only from what was
// measured (scheduler counters, Ollama /api/ps and /api/show, the host's nvidia-smi sample); never estimated, except
// a model's configured memory figure, which is labelled "configured-estimate".

import type { RunnerConfig } from "../config.ts";
import type { WorkerStatus } from "../protocol.ts";
import type { InferenceScheduler } from "./scheduler.ts";
import { readGpuTelemetry } from "./gpu.ts";
import { sameModel, type ModelDetails, type Residency } from "./ollama.ts";

export class ModelDetailsCache {
  private readonly cache = new Map<string, ModelDetails>();
  private readonly residency: Residency;
  constructor(residency: Residency) { this.residency = residency; }
  async get(tag: string): Promise<ModelDetails | null> {
    if (this.cache.has(tag)) return this.cache.get(tag)!;
    if (!this.residency.details) return null;
    try { const d = await this.residency.details(tag); this.cache.set(tag, d); return d; } catch { return null; }
  }
}

export async function buildWorkerStatus(cfg: RunnerConfig, scheduler: InferenceScheduler | null, slots: { total: number; busy: number }, details: ModelDetailsCache | null, error: string | null = null): Promise<WorkerStatus> {
  const gpu = readGpuTelemetry(cfg.inference.telemetryFile);
  const st = scheduler?.status() ?? null;
  const profiles = cfg.models.mode === "dual" ? [cfg.models.a, cfg.models.b] : [cfg.models.b];
  const models: NonNullable<WorkerStatus["models"]> = [];
  for (const p of profiles) {
    const d = details ? await details.get(p.tag) : null;
    const loaded = st?.resident.find((r) => sameModel(r.model, p.tag));
    const stats = st ? Object.entries(st.perModel).find(([k]) => sameModel(k, p.tag))?.[1] : undefined;
    models.push({
      tag: p.tag, role: p.role, family: d?.family ?? null, parameterSize: d?.parameterSize ?? null, quantization: d?.quantization ?? p.quantization, contextTokens: p.contextTokens,
      vramMb: loaded?.vramMb ?? (p.vramMb || null), vramSource: loaded?.vramMb ? "measured" : p.vramMb ? "configured-estimate" : null,
      license: d?.license ?? p.license, tokensPerSecond: stats?.tokensPerSecond ?? null, requests: stats?.requests ?? 0, lastOkAt: stats?.lastOkAt ?? null, lastError: stats?.lastError ?? null,
    });
  }
  return {
    gpu: gpu ? { name: gpu.name, driver: gpu.driver, vramTotalMb: gpu.vramTotalMb, vramUsedMb: gpu.vramUsedMb, utilPercent: gpu.utilPercent, source: gpu.source } : null,
    ...(st ? { inference: {
      state: st.state, active: st.active, queued: st.queued, maxConcurrent: st.maxConcurrent, loaded: st.resident,
      throughput: Object.fromEntries(Object.entries(st.perModel).map(([k, v]) => [k, { tokensPerSecond: v.tokensPerSecond, requests: v.requests }])),
      switches: { count: st.switches.count, failures: st.switches.failures, avgMs: st.switches.avgMs },
    } } : {}),
    models, slotsTotal: slots.total, slotsBusy: slots.busy, error,
  };
}
