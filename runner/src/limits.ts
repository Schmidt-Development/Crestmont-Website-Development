// Host resource lanes (Founder directive, 2026-11-02, Phase 4E).
//
// RUNNER_SLOTS alone used to decide both how many website projects were active AND how many of them could run
// dependency installs or browser suites at the same instant. Those are different resources: a project waiting on
// the GPU, or writing files, costs almost nothing, while four simultaneous `npm ci` runs or four Chromium suites
// will fight for CPU, RAM and disk. Separating them lets four projects progress while only as many CPU-heavy
// operations run as the host can actually take.
//
// Deliberately a plain in-process semaphore: one runner process owns these resources, so no broker, queue service
// or shared store is involved. GPU admission is NOT here — InferenceScheduler already owns that, with its own
// VRAM accounting and fairness, and two schedulers for one resource would be worse than none.

export interface LaneStatus {
  name: string;
  capacity: number;
  active: number;
  queued: number;
  /** Deepest the queue has been: shows whether a lane is a real bottleneck or just configured low. */
  peakQueued: number;
  /** Total time callers spent waiting for this lane, so waiting is never mistaken for working. */
  waitMs: number;
  admitted: number;
}

interface Waiter { seq: number; grant: () => void; fail: (e: Error) => void }

/** One named resource with a fixed number of permits, FIFO so no project can be starved by later arrivals. */
export class Lane {
  readonly name: string;
  private capacity: number;
  private active = 0;
  private queue: Waiter[] = [];
  private seq = 0;
  private peak = 0;
  private waited = 0;
  private admittedCount = 0;
  private readonly now: () => number;

  constructor(name: string, capacity: number, now: () => number = Date.now) {
    this.name = name;
    this.capacity = Math.max(1, Math.floor(capacity));
    this.now = now;
  }

  status(): LaneStatus {
    return { name: this.name, capacity: this.capacity, active: this.active, queued: this.queue.length, peakQueued: this.peak, waitMs: Math.round(this.waited), admitted: this.admittedCount };
  }

  /** Capacity can be retuned at runtime (a measurement, an operator command) without rebuilding the scheduler. */
  setCapacity(n: number): void {
    this.capacity = Math.max(1, Math.floor(n));
    this.pump();
  }

  /** Runs `fn` while holding one permit. The permit is always released, including on throw or abort. */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const start = this.now();
    await this.acquire(signal);
    this.waited += this.now() - start;
    this.admittedCount++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.pump();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    if (this.active < this.capacity) { this.active++; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = { seq: ++this.seq, grant: () => { cleanup(); resolve(); }, fail: (e) => { cleanup(); reject(e); } };
      const onAbort = () => { this.queue = this.queue.filter((x) => x !== w); w.fail(new DOMException("aborted", "AbortError")); };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(w);
      this.peak = Math.max(this.peak, this.queue.length);
    });
  }

  private pump(): void {
    while (this.active < this.capacity && this.queue.length) {
      const w = this.queue.shift()!;
      this.active++;
      w.grant();
    }
  }
}

export interface HostLimitsOptions {
  /** Concurrent dependency installations (network + disk + CPU). */
  install: number;
  /** Concurrent CPU/browser-heavy check suites (static checks, Chromium, screenshots). */
  checks: number;
}

/**
 * The host-side lanes a job passes through. Capacities are configuration, not constants: set them from what the
 * machine was measured to take, and raise them when a measurement says it can.
 */
export class HostLimits {
  readonly install: Lane;
  readonly checks: Lane;
  constructor(o: HostLimitsOptions, now?: () => number) {
    this.install = new Lane("install", o.install, now);
    this.checks = new Lane("checks", o.checks, now);
  }
  status(): LaneStatus[] {
    return [this.install.status(), this.checks.status()];
  }
}
