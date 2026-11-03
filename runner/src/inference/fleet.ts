// Multi-GPU worker registration and dispatch (Founder directive, 2026-11-02, Phase 6).
//
// Node 1 has one GPU today, and this file does not pretend otherwise: with one device configured a GpuFleet is one
// InferenceScheduler behind a thin facade, and every single-GPU behaviour -- VRAM accounting, FIFO fairness,
// anti-starvation, model switching -- is that same scheduler doing the same work. What the fleet adds is the shape a
// second GPU slots into without rewriting the callers: a device list, a dispatch rule, and per-device reporting.
//
// Why a device LIST and not a device count: Ollama binds a server process to GPUs through CUDA_VISIBLE_DEVICES at
// start, not per request, so a request cannot pick a GPU on an endpoint that owns two. Dispatching to a device means
// addressing the model server that owns that device, so one endpoint per device is the registration unit. A second GPU
// is then configuration -- a second INFERENCE_DEVICES entry and a second model server -- not a code change. Nothing
// here provisions, starts, or requires a second anything, and with one device nothing new happens at runtime.
//
// Dispatch rule. A model switch costs 5.4-6.0 s on Node 1 (measured) while a request's own queue wait is usually
// shorter than that, so the rule spends queueing to avoid switching rather than the other way round. Devices that
// cannot hold the model at all are excluded first; among the rest, in order:
//   1. holds the requested model and has a free slot -- nothing to load;
//   2. free and would not have to evict anything (an empty GPU, or the model fits beside what is there) -- a load
//      but no unload;
//   3. shortest queue, then fewest active requests;
//   4. ties break on device index, so dispatch is deterministic and testable.
// If no device can hold the model, the least-loaded one is still chosen and ITS scheduler refuses the request with its
// own error: the fleet never invents a verdict about a GPU it does not measure.
//
// This is a dispatch rule, not a claim about throughput. Two GPUs give two model residencies and two concurrent
// requests; they do not make one request faster.

import { InferenceScheduler, type GpuEndpoint, type RequestMeta, type SchedulerStatus, type Usage } from "./scheduler.ts";
import type { GpuDevice } from "./devices.ts";
import type { GpuSample } from "./gpu.ts";
import type { Logger } from "../log.ts";
import { silentLogger } from "../log.ts";

/**
 * What a caller needs from the GPU, whether there is one of them or four. Both InferenceScheduler (one device) and
 * GpuFleet (any number) satisfy it, so job.ts, the provider and the advisors take this and never ask how many GPUs
 * exist. `fn` is handed the endpoint its request was dispatched to and must send the request there.
 */
export interface GpuGateway {
  run<T>(meta: RequestMeta, fn: (endpoint: GpuEndpoint) => Promise<T>, signal?: AbortSignal, usage?: (r: T) => Usage | null): Promise<T>;
  /** Fleet-wide summary, in the single-GPU shape the platform and the health endpoint already report. */
  status(): SchedulerStatus;
  /** What one project's agent is doing on the GPU right now (waiting, switching, running), or null. */
  activity(projectId: string): ProjectActivity | null;
  close(): void;
}

export type ProjectActivity = { state: "gpu_running" | "gpu_waiting" | "model_switching"; model: string; task: string };

export interface DeviceStatus { device: GpuDevice; inference: SchedulerStatus; gpu: GpuSample | null; dispatched: number }

export interface FleetOptions {
  devices: GpuDevice[];
  /** Builds the scheduler for one device. Injected so the fleet is testable without a model server. */
  makeScheduler: (device: GpuDevice) => InferenceScheduler;
  /** Per-device telemetry (host sampler). Returns null for a device that is not reported. */
  telemetry?: (device: GpuDevice) => GpuSample | null;
  log?: Logger;
}

export class GpuFleet implements GpuGateway {
  readonly devices: GpuDevice[];
  private readonly schedulers = new Map<number, InferenceScheduler>();
  private readonly dispatched = new Map<number, number>();
  private readonly o: FleetOptions;
  private readonly log: Logger;

  constructor(o: FleetOptions) {
    if (!o.devices.length) throw new Error("a GPU fleet needs at least one device");
    this.o = o;
    this.log = o.log ?? silentLogger;
    this.devices = [...o.devices].sort((a, b) => a.index - b.index);
    for (const d of this.devices) { this.schedulers.set(d.index, o.makeScheduler(d)); this.dispatched.set(d.index, 0); }
    if (this.devices.length > 1) this.log.info("GPU fleet", { devices: this.devices.map((d) => ({ index: d.index, baseUrl: d.baseUrl, vramTotalMb: d.vramTotalMb })) });
  }

  /** The scheduler for one device, for callers that legitimately address a single GPU (benchmarks, diagnostics). */
  scheduler(index: number): InferenceScheduler | null {
    return this.schedulers.get(index) ?? null;
  }

  /**
   * Choose a device for one request. Deterministic; the rule is documented at the top of this file.
   */
  pick(model: string): GpuDevice {
    if (this.devices.length === 1) return this.devices[0];
    const rows = this.devices.map((d) => {
      const s = this.schedulers.get(d.index)!;
      const st = s.status();
      const holds = s.holds(model);
      return {
        d, st, holds, free: st.active < st.maxConcurrent, canHold: s.canHold(model),
        // No eviction needed: nothing is loaded, it is already there, or it fits beside what is loaded.
        noEviction: holds || st.resident.length === 0 || s.canCoReside([...st.resident.map((r) => r.model), model]),
      };
    });
    const byLoad = (a: typeof rows[number], b: typeof rows[number]) => a.st.queued - b.st.queued || a.st.active - b.st.active || a.d.index - b.d.index;
    const pool = rows.some((r) => r.canHold) ? rows.filter((r) => r.canHold) : rows;
    for (const tier of [pool.filter((r) => r.holds && r.free), pool.filter((r) => r.free && r.noEviction)]) {
      if (tier.length) return [...tier].sort(byLoad)[0].d;
    }
    return [...pool].sort(byLoad)[0].d;
  }

  async run<T>(meta: RequestMeta, fn: (endpoint: GpuEndpoint) => Promise<T>, signal?: AbortSignal, usage?: (r: T) => Usage | null): Promise<T> {
    const device = this.pick(meta.model);
    const s = this.schedulers.get(device.index)!;
    this.dispatched.set(device.index, (this.dispatched.get(device.index) ?? 0) + 1);
    return s.run(meta, fn, signal, usage);
  }

  /**
   * What one project is doing on the GPU. A project's requests may be dispatched to different devices over time, but
   * only one is ever in flight, so the first device that knows about it is the answer.
   */
  activity(projectId: string): ProjectActivity | null {
    for (const d of this.devices) {
      const a = this.schedulers.get(d.index)!.activity(projectId);
      if (a) return a;
    }
    return null;
  }

  /** Per-device detail: what each GPU holds, is doing and has been sent. This is the multi-GPU view. */
  deviceStatus(): DeviceStatus[] {
    return this.devices.map((d) => ({
      device: d, inference: this.schedulers.get(d.index)!.status(),
      gpu: this.o.telemetry ? this.o.telemetry(d) : null,
      dispatched: this.dispatched.get(d.index) ?? 0,
    }));
  }

  /**
   * Fleet-wide summary in the single-GPU shape, so the health endpoint and the platform need no change to keep working
   * with one device and stay truthful with several: counts add up, capacity adds up, and `state` names every device's
   * state rather than claiming one of them stands for the fleet.
   */
  status(): SchedulerStatus {
    const rows = this.deviceStatus();
    if (rows.length === 1) return rows[0].inference;
    const perModel: SchedulerStatus["perModel"] = {};
    for (const r of rows) {
      for (const [model, s] of Object.entries(r.inference.perModel)) {
        const cur = perModel[model];
        if (!cur) { perModel[model] = { ...s }; continue; }
        // Summed where summing is meaningful; throughput is the better of the devices, never their sum, because no
        // single request ever ran that fast.
        perModel[model] = {
          requests: cur.requests + s.requests, failures: cur.failures + s.failures,
          promptTokens: cur.promptTokens + s.promptTokens, completionTokens: cur.completionTokens + s.completionTokens,
          genMs: cur.genMs + s.genMs, waitMs: cur.waitMs + s.waitMs,
          tokensPerSecond: cur.tokensPerSecond === null ? s.tokensPerSecond : s.tokensPerSecond === null ? cur.tokensPerSecond : Math.max(cur.tokensPerSecond, s.tokensPerSecond),
          lastOkAt: [cur.lastOkAt, s.lastOkAt].filter(Boolean).sort().pop() ?? null,
          lastError: s.lastError ?? cur.lastError,
        };
      }
    }
    const switches = rows.map((r) => r.inference.switches);
    const totalSwitches = switches.reduce((n, s) => n + s.count, 0);
    const weighted = switches.reduce((n, s) => n + (s.avgMs ?? 0) * s.count, 0);
    return {
      state: rows.map((r) => `${r.device.label}:${r.inference.state}`).join(" "),
      resident: rows.flatMap((r) => r.inference.resident),
      active: rows.reduce((n, r) => n + r.inference.active, 0),
      queued: rows.reduce((n, r) => n + r.inference.queued, 0),
      maxConcurrent: rows.reduce((n, r) => n + r.inference.maxConcurrent, 0),
      perModel,
      switches: {
        count: totalSwitches,
        failures: switches.reduce((n, s) => n + s.failures, 0),
        avgMs: totalSwitches ? Math.round(weighted / totalSwitches) : null,
        recent: switches.flatMap((s) => s.recent).sort((a, b) => a.at.localeCompare(b.at)).slice(-10),
      },
    };
  }

  close(): void {
    for (const s of this.schedulers.values()) s.close();
  }
}
