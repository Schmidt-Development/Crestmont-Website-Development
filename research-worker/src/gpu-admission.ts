// Cooperative GPU admission for the research worker's OPTIONAL drafts.
//
// Node 1 runs one RTX 5090 and one Ollama (127.0.0.1:11434) shared by several applications. The AI Website Builder
// schedules its own GPU work in-process (runner/src/inference/scheduler.ts), but that scheduler lives inside the
// runner container and is not reachable from this native Windows process, so the two cannot share a queue. What they
// do share is Ollama itself, and Ollama reports which models are resident. That report is the admission signal.
//
// The rule is deliberately one-sided: website generation always wins. A research draft is a nice-to-have piece of
// wording — qualification, scoring and packages are computed in code (src/domain/research.ts) — so it is never worth
// delaying a customer's website for. Admission is therefore refused whenever anything suggests another application
// wants the GPU, and "unknown" always counts as refused.
//
// Refused means deferred, never blocking: the prospect is delivered on its evidence alone and the draft is retried
// later (orchestrator.ts). Nothing here ever unloads another application's model — the builder's scheduler makes the
// same promise about ours (see its `foreign` handling).
import { gpu } from "./resources.ts";
import { assertLoopback } from "./config.ts";

export interface AdmissionDecision { allowed: boolean; reason: string }

/** One entry of Ollama's GET /api/ps. */
interface PsModel { name?: string; model?: string; size?: number; size_vram?: number }

/** Ollama tags differ only by an implicit `:latest`, so compare on the base name. */
export function sameModelTag(a: string, b: string): boolean {
  const norm = (s: string) => (s.includes(":") ? s : `${s}:latest`).toLowerCase();
  return norm(a) === norm(b);
}

export interface GpuAdmissionOptions {
  /** Ollama base URL (loopback only, enforced). */
  baseUrl: string;
  /** The research model tag; a resident model with any other tag belongs to another application. */
  modelTag: string;
  /** Refuse while the GPU is busier than this (percent). */
  maxUtilPct: number;
  /** Refuse unless at least this much GPU memory is free, so loading our model cannot squeeze the builder's. */
  minFreeMb: number;
  /** How long Ollama keeps the research model resident after a draft. Short on purpose: it must not squat VRAM. */
  keepAlive: string;
  /** After a refusal, do not ask again for this long (cheap, and avoids hammering /api/ps). */
  backoffMs?: number;
  timeoutMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the nvidia-smi reader in resources.ts. */
  gpuImpl?: typeof gpu;
}

export class GpuAdmission {
  private readonly o: Required<Omit<GpuAdmissionOptions, "fetchImpl" | "gpuImpl">> & { fetchImpl: typeof fetch; gpuImpl: typeof gpu };
  private quietUntil = 0;
  private lastDecision: AdmissionDecision = { allowed: false, reason: "not checked yet" };
  /** Counters for the heartbeat, so the dashboard can show why drafts are not being produced. */
  readonly stats = { checks: 0, allowed: 0, refusedForeignModel: 0, refusedBusy: 0, refusedNoVram: 0, refusedUnknown: 0 };

  constructor(o: GpuAdmissionOptions) {
    assertLoopback(o.baseUrl);
    this.o = { backoffMs: 60_000, timeoutMs: 5_000, now: () => Date.now(), fetchImpl: fetch, gpuImpl: gpu, ...o } as Required<Omit<GpuAdmissionOptions, "fetchImpl">> & { fetchImpl: typeof fetch };
  }

  get keepAlive(): string { return this.o.keepAlive; }
  status() { return { ...this.stats, last: this.lastDecision }; }

  /** Models Ollama currently holds in memory; null when Ollama did not answer (treated as "unknown"). */
  private async resident(): Promise<PsModel[] | null> {
    try {
      const r = await this.o.fetchImpl(`${this.o.baseUrl}/api/ps`, { signal: AbortSignal.timeout(this.o.timeoutMs) });
      if (!r.ok) return null;
      const j = await r.json() as { models?: PsModel[] };
      return Array.isArray(j.models) ? j.models : [];
    } catch { return null; }
  }

  /**
   * Whether a draft may use the GPU right now. Refusals are sticky for `backoffMs` so a busy builder is not polled
   * on every prospect.
   */
  async check(): Promise<AdmissionDecision> {
    if (this.o.now() < this.quietUntil) return this.lastDecision;
    this.stats.checks++;
    const decide = (allowed: boolean, reason: string, counter?: keyof typeof this.stats): AdmissionDecision => {
      if (allowed) this.stats.allowed++;
      else {
        if (counter) (this.stats[counter] as number)++;
        this.quietUntil = this.o.now() + this.o.backoffMs;
      }
      this.lastDecision = { allowed, reason };
      return this.lastDecision;
    };

    const models = await this.resident();
    if (models === null) return decide(false, "Ollama did not answer /api/ps: GPU state unknown, so drafting stands down", "refusedUnknown");

    // Someone else's model is in GPU memory. On Node 1 that is the Website Builder's Model A/B, or another
    // application (HQ/JARVIS). We never evict it and we never compete with it.
    const foreign = models.filter((m) => !sameModelTag(m.model ?? m.name ?? "", this.o.modelTag));
    if (foreign.length) {
      const names = foreign.map((m) => m.model ?? m.name ?? "?").slice(0, 3).join(", ");
      return decide(false, `another application's model is resident (${names}): website generation keeps the GPU`, "refusedForeignModel");
    }

    // nvidia-smi is free with the driver. No reading at all counts as unknown only when a GPU is expected; when
    // there is no NVIDIA GPU (CPU-only host) there is nothing to contend for, so drafting is allowed.
    const g = await this.o.gpuImpl();
    if (g) {
      if (g.utilPct > this.o.maxUtilPct) return decide(false, `GPU is ${g.utilPct}% busy (limit ${this.o.maxUtilPct}%)`, "refusedBusy");
      const freeMb = g.memTotalMb - g.memUsedMb;
      const ourResident = models.some((m) => sameModelTag(m.model ?? m.name ?? "", this.o.modelTag));
      // Our model is already loaded: no new memory is needed, so the headroom rule does not apply.
      if (!ourResident && freeMb < this.o.minFreeMb) return decide(false, `only ${freeMb} MB of GPU memory free (need ${this.o.minFreeMb} MB of headroom before loading a second model)`, "refusedNoVram");
    }
    return decide(true, g ? `GPU idle (${g.utilPct}% busy)` : "no NVIDIA GPU reported: nothing to contend for");
  }
}
