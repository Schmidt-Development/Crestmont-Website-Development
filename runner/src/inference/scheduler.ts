// Founder V4 §4–6: one GPU shared by every website agent on this runner. All model requests (builder turns, architect
// and reviewer sessions) pass through this scheduler, which:
//  - limits concurrent GPU requests (maxConcurrent, measured on Node 1; matches OLLAMA_NUM_PARALLEL);
//  - keeps track of which models are in memory and never assumes Model A and Model B fit together: they share the
//    GPU only when both memory figures are known and fit under the GPU size minus the reserved headroom; otherwise
//    one model is resident at a time;
//  - batches by model: requests for the resident model run first, so switches are rare; a request for the other model
//    waits at most `maxWaitBeforeSwitchMs` (and the resident model keeps at least `minDwellMs`), then the scheduler
//    stops admitting new work, lets running requests finish, unloads, loads the other model and continues;
//  - switches with a timeout; a failed load is retried once, then that model is put on a cooldown and its waiting
//    requests fail with ModelUnavailableError (the build checkpoints and is retried later; nothing else is affected);
//  - is fair between websites: among requests for the same model, the website served least recently goes first;
//  - logs per-model performance (requests, tokens, generation time, queue wait) and every switch.
// It decides nothing about approvals or quality gates; it only orders GPU work.

import type { ModelProfile } from "../config.ts";
import type { Logger } from "../log.ts";
import { sameModel, type LoadedModel, type Residency } from "./ollama.ts";

export class ModelUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "ModelUnavailableError"; }
}

export interface SchedulerOptions {
  models: ModelProfile[];
  maxConcurrent: number;
  vramTotalMb: number;
  vramReserveMb: number;
  switchTimeoutMs: number;
  maxWaitBeforeSwitchMs: number;
  minDwellMs?: number;
  /** Idle time of the loaded model before switching to a waiting one (its agents may be between calls). */
  idleGraceMs?: number;
  /** Retry interval when the model server does not answer the residency check. */
  reconcileRetryMs?: number;
  keepAlive: string;
  residency: Residency;
  cooldownMs?: number;
  now?: () => number;
  log?: Logger;
}

export interface RequestMeta { model: string; projectId: string; task: string }
export interface Usage { promptTokens: number; completionTokens: number; wallMs: number }

interface Waiter { seq: number; meta: RequestMeta; enqueuedAt: number; grant: () => void; fail: (e: Error) => void }

export interface ModelStats { requests: number; failures: number; promptTokens: number; completionTokens: number; genMs: number; waitMs: number; tokensPerSecond: number | null; lastOkAt: string | null; lastError: string | null }
export interface SwitchRecord { from: string[]; to: string; ms: number; ok: boolean; at: string; error?: string }

export interface SchedulerStatus {
  state: string;
  resident: LoadedModel[];
  active: number;
  queued: number;
  maxConcurrent: number;
  perModel: Record<string, ModelStats>;
  switches: { count: number; failures: number; avgMs: number | null; recent: SwitchRecord[] };
}

const EWMA = 0.3;

export class InferenceScheduler {
  private readonly o: Required<Omit<SchedulerOptions, "log">> & { log?: Logger };
  private queue: Waiter[] = [];
  private inFlight = new Map<string, number>();
  private resident: LoadedModel[] = [];
  private residentSince = 0;
  private switching: string | null = null;
  private failedUntil = new Map<string, number>();
  private lastGrant = new Map<string, number>();
  private projectActivity = new Map<string, { state: "gpu_running" | "gpu_waiting" | "model_switching"; model: string; task: string }>();
  private seq = 0;
  private stats = new Map<string, ModelStats>();
  private switchLog: SwitchRecord[] = [];
  private switchCount = 0;
  private switchFailures = 0;
  private switchMsTotal = 0;
  private reconciled = false;

  constructor(o: SchedulerOptions) {
    this.o = { minDwellMs: 120_000, idleGraceMs: 20_000, reconcileRetryMs: 5_000, cooldownMs: 120_000, now: () => Date.now(), ...o } as Required<Omit<SchedulerOptions, "log">> & { log?: Logger };
  }

  private now(): number { return this.o.now(); }
  private profile(model: string): ModelProfile | undefined { return this.o.models.find((m) => sameModel(m.tag, model)); }
  private stat(model: string): ModelStats {
    let s = this.stats.get(model);
    if (!s) { s = { requests: 0, failures: 0, promptTokens: 0, completionTokens: 0, genMs: 0, waitMs: 0, tokensPerSecond: null, lastOkAt: null, lastError: null }; this.stats.set(model, s); }
    return s;
  }
  private totalInFlight(): number { let n = 0; for (const v of this.inFlight.values()) n += v; return n; }
  private isResident(model: string): boolean { return this.resident.some((r) => sameModel(r.model, model)); }

  /** Memory a model needs: measured while loaded, else the configured estimate; null = unknown. */
  private vram(model: string): number | null {
    const measured = this.resident.find((r) => sameModel(r.model, model))?.vramMb;
    if (measured) return measured;
    const p = this.profile(model);
    return p && p.vramMb > 0 ? p.vramMb : null;
  }

  /** Whether these models can be in GPU memory together (all sizes known and within the GPU minus the reserve). */
  canCoReside(models: string[]): boolean {
    const uniq = [...new Set(models)];
    if (uniq.length <= 1) return true;
    if (this.o.vramTotalMb <= 0) return false;
    let sum = 0;
    for (const m of uniq) { const v = this.vram(m); if (v === null) return false; sum += v; }
    return sum + this.o.vramReserveMb <= this.o.vramTotalMb;
  }

  /** A request may start now: its model is loaded, nothing is loaded yet, or it fits next to what is loaded. */
  private admissible(model: string): boolean {
    return this.isResident(model) || (this.reconciled && this.resident.length === 0) || this.canCoReside([...this.resident.map((r) => r.model), model]);
  }

  /** Run one model request through the GPU queue. `fn` performs the request; its usage is recorded when returned. */
  async run<T>(meta: RequestMeta, fn: () => Promise<T>, signal?: AbortSignal, usage?: (r: T) => Usage | null): Promise<T> {
    const until = this.failedUntil.get(meta.model);
    if (until && until > this.now()) throw new ModelUnavailableError(`model ${meta.model} could not be loaded recently; retried after ${new Date(until).toISOString()}`);
    const enqueuedAt = this.now();
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = { seq: ++this.seq, meta, enqueuedAt, grant: () => { cleanup(); resolve(); }, fail: (e) => { cleanup(); reject(e); } };
      const onAbort = () => { this.queue = this.queue.filter((x) => x !== w); this.projectActivity.delete(meta.projectId); w.fail(new DOMException("aborted", "AbortError")); this.pump(); };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(w);
      this.projectActivity.set(meta.projectId, { state: this.switching === meta.model ? "model_switching" : "gpu_waiting", model: meta.model, task: meta.task });
      this.pump();
    });
    const s = this.stat(meta.model);
    s.waitMs += this.now() - enqueuedAt;
    this.projectActivity.set(meta.projectId, { state: "gpu_running", model: meta.model, task: meta.task });
    try {
      const r = await fn();
      const u = usage?.(r) ?? null;
      s.requests++;
      s.lastOkAt = new Date(this.now()).toISOString();
      if (u) {
        s.promptTokens += u.promptTokens; s.completionTokens += u.completionTokens; s.genMs += u.wallMs;
        if (u.wallMs > 0 && u.completionTokens > 0) { const tps = u.completionTokens / (u.wallMs / 1000); s.tokensPerSecond = s.tokensPerSecond === null ? tps : s.tokensPerSecond * (1 - EWMA) + tps * EWMA; }
      }
      return r;
    } catch (err) {
      s.failures++;
      s.lastError = (err as Error)?.message?.slice(0, 200) ?? String(err);
      throw err;
    } finally {
      this.inFlight.set(meta.model, Math.max(0, (this.inFlight.get(meta.model) ?? 1) - 1));
      this.lastActivityAt = this.now();
      if (this.projectActivity.get(meta.projectId)?.state === "gpu_running") this.projectActivity.delete(meta.projectId);
      this.pump();
    }
  }

  /** What a website's agent is doing on the GPU right now (null = not using it). */
  activity(projectId: string): { state: "gpu_running" | "gpu_waiting" | "model_switching"; model: string; task: string } | null {
    return this.projectActivity.get(projectId) ?? null;
  }

  private grant(w: Waiter): void {
    this.queue = this.queue.filter((x) => x !== w);
    this.inFlight.set(w.meta.model, (this.inFlight.get(w.meta.model) ?? 0) + 1);
    this.lastGrant.set(w.meta.projectId, this.now());
    this.lastActivityAt = this.now();
    if (!this.isResident(w.meta.model)) {
      // Fits next to what is loaded: the model server loads it on this first request.
      this.resident = [...this.resident, { model: w.meta.model, vramMb: this.profile(w.meta.model)?.vramMb || null }];
      if (this.resident.length === 1) this.residentSince = this.now();
    }
    w.grant();
  }

  /** Fair choice among requests for loaded models: the website served least recently, then the oldest request. */
  private pick(cands: Waiter[]): Waiter | null {
    if (!cands.length) return null;
    return [...cands].sort((a, b) => (this.lastGrant.get(a.meta.projectId) ?? 0) - (this.lastGrant.get(b.meta.projectId) ?? 0) || a.seq - b.seq)[0];
  }

  private pump(): void {
    if (this.switching) return;
    if (!this.reconciled && this.queue.length) { this.startSwitch(this.queue[0].meta.model, true); return; }
    const blockedNow = () => this.queue.filter((w) => !this.admissible(w.meta.model)).sort((a, b) => a.seq - b.seq)[0] ?? null;
    // Starving = the oldest request of all is for a model that is not loaded and has waited past the limit (an older
    // request for the loaded model is served first, so a switch is never undone before the requests it was for ran).
    const starving = (b: Waiter | null) => !!b && b.seq === Math.min(...this.queue.map((w) => w.seq))
      && this.now() - b.enqueuedAt >= this.o.maxWaitBeforeSwitchMs && this.now() - this.residentSince >= this.o.minDwellMs;
    while (this.totalInFlight() < this.o.maxConcurrent && this.queue.length) {
      // Batching: keep serving the loaded model, unless a request for the other one has waited long enough (then drain).
      const next = starving(blockedNow()) ? null : this.pick(this.queue.filter((w) => this.admissible(w.meta.model)));
      if (!next) break;
      this.grant(next);
    }
    const blocked = blockedNow();
    if (!blocked) return;
    const idle = this.totalInFlight() === 0 && !this.queue.some((w) => this.admissible(w.meta.model));
    // Switch when nothing runs and either the waiting request starved, or the loaded model has been idle for the grace
    // period (its agents are between calls; a short grace avoids switching away from a model that is about to be used).
    if (this.totalInFlight() === 0 && (starving(blocked) || (idle && this.now() - this.lastActivityAt >= this.o.idleGraceMs))) {
      this.startSwitch(blocked.meta.model, false);
      return;
    }
    for (const w of this.queue) if (!this.admissible(w.meta.model)) this.projectActivity.set(w.meta.projectId, { state: "gpu_waiting", model: w.meta.model, task: w.meta.task });
    const due = Math.min(Math.max(blocked.enqueuedAt + this.o.maxWaitBeforeSwitchMs, this.residentSince + this.o.minDwellMs), idle ? this.lastActivityAt + this.o.idleGraceMs : Infinity) - this.now();
    // Running requests call pump when they finish; a timer is needed only for a deadline still ahead.
    if (this.totalInFlight() > 0 && !(due > 0)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, Math.max(20, Number.isFinite(due) ? due : this.o.maxWaitBeforeSwitchMs));
  }
  private timer: NodeJS.Timeout | null = null;
  private lastActivityAt = 0;

  /** Make `target` resident: unload what does not fit next to it, load it, verify. Retried once; then a cooldown. */
  private startSwitch(target: string, reconcileOnly: boolean): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.switching = target;
    for (const w of this.queue) if (w.meta.model === target) this.projectActivity.set(w.meta.projectId, { state: "model_switching", model: target, task: w.meta.task });
    const from = this.resident.map((r) => r.model);
    const started = this.now();
    /** Returns whether a model was actually unloaded or loaded. */
    const attempt = async (): Promise<boolean> => {
      const signal = AbortSignal.timeout(this.o.switchTimeoutMs);
      const loaded = await this.o.residency.loaded(signal);
      this.resident = loaded;
      this.reconciled = true;
      // Start-up / recovery: learn what is really loaded; the next pump decides whether a switch is needed.
      if (reconcileOnly) return false;
      if (loaded.some((m) => sameModel(m.model, target))) return false; // already in memory
      for (const m of loaded) if (!this.canCoReside([m.model, target])) await this.o.residency.unload(m.model, signal);
      await this.o.residency.load(target, this.o.keepAlive, signal);
      this.resident = await this.o.residency.loaded(signal);
      return true;
    };
    void (async () => {
      let error: Error | null = null;
      let switched = false;
      for (let i = 0; i < 2; i++) {
        try { switched = await attempt(); error = null; break; } catch (err) { error = err as Error; this.o.log?.warn("model switch failed", { target, attempt: i + 1, error: error.message?.slice(0, 200) }); }
      }
      const ms = this.now() - started;
      if (switched || (error && !reconcileOnly)) {
        const rec: SwitchRecord = { from, to: target, ms, ok: !error, at: new Date(this.now()).toISOString(), ...(error ? { error: error.message.slice(0, 200) } : {}) };
        this.switchLog = [...this.switchLog.slice(-19), rec];
        this.switchCount++;
        this.switchMsTotal += ms;
        if (error) this.switchFailures++;
        this.o.log?.info("model switch", { ...rec });
      }
      if (error && reconcileOnly) {
        // The model server did not answer the start-up check: nothing failed to load. Keep the requests queued and try
        // again shortly (their own stop/deadline signals still end them); no model goes on cooldown.
        this.reconciled = false;
        this.switching = null;
        this.o.log?.warn("model server not reachable for the residency check; retrying", { error: error.message.slice(0, 200) });
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; this.pump(); }, this.o.reconcileRetryMs);
        return;
      }
      if (error) {
        // Recovery: re-read what is really loaded, put the model on a cooldown, fail only the requests that need it.
        this.reconciled = false;
        try { this.resident = await this.o.residency.loaded(AbortSignal.timeout(15_000)); this.reconciled = true; } catch { this.resident = []; }
        this.failedUntil.set(target, this.now() + this.o.cooldownMs);
        const e = new ModelUnavailableError(`model ${target} could not be loaded (${error.message.slice(0, 200)}); builds that need it are checkpointed and retried`);
        for (const w of this.queue.filter((x) => x.meta.model === target)) { this.queue = this.queue.filter((x) => x !== w); this.projectActivity.delete(w.meta.projectId); w.fail(e); }
      }
      if (switched || this.resident.length) this.residentSince = this.now();
      this.lastActivityAt = this.now();
      this.switching = null;
      this.pump();
    })();
  }

  status(): SchedulerStatus {
    const perModel: Record<string, ModelStats> = {};
    for (const [k, v] of this.stats) perModel[k] = { ...v, tokensPerSecond: v.tokensPerSecond === null ? null : Math.round(v.tokensPerSecond * 10) / 10 };
    const state = this.switching ? `switching to ${this.switching}` : [...this.failedUntil].some(([, t]) => t > this.now()) ? `failed: ${[...this.failedUntil].filter(([, t]) => t > this.now()).map(([m]) => m).join(", ")} could not be loaded`
      : this.resident.length ? `ready: ${this.resident.map((r) => r.model).join(", ")}` : "idle (no model loaded)";
    return {
      state, resident: [...this.resident], active: this.totalInFlight(), queued: this.queue.length, maxConcurrent: this.o.maxConcurrent, perModel,
      switches: { count: this.switchCount, failures: this.switchFailures, avgMs: this.switchCount ? Math.round(this.switchMsTotal / this.switchCount) : null, recent: [...this.switchLog] },
    };
  }

  close(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
